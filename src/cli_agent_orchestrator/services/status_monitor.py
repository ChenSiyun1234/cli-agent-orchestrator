"""Monitors terminal status by accumulating output and detecting changes.

Consumer: terminal.{id}.output
Publisher: terminal.{id}.status
"""

import asyncio
import logging
import threading
from typing import Any, Dict, List, Optional, Tuple, cast

from cli_agent_orchestrator.constants import (
    CAO_PYTE_STATUS,
    PYTE_QUIESCENCE_DELAY_S,
    PYTE_SCREEN_COLS,
    PYTE_SCREEN_ROWS,
)
from cli_agent_orchestrator.models.terminal import TerminalStatus
from cli_agent_orchestrator.providers.manager import provider_manager
from cli_agent_orchestrator.services.event_bus import bus
from cli_agent_orchestrator.services.settings_service import get_server_settings
from cli_agent_orchestrator.utils.event import terminal_id_from_topic

logger = logging.getLogger(__name__)

# Statuses that represent a stable "ready" state — the agent has finished
# producing output and is waiting for further input. Once latched, the
# StatusMonitor will not regress to PROCESSING until ``notify_input_sent``
# is called (signalling that a new processing cycle is starting).
#
# Why: the event-driven pipeline derives status from a rolling state buffer,
# and TUI redraws (cursor positioning, status-bar refreshes) routinely
# evict the idle/response markers that the per-provider get_status() relies
# on. That makes status flap rapidly between IDLE/COMPLETED and PROCESSING
# in the seconds following completion. Without stickiness, both
# wait_until_status (server-side) and the e2e tests' HTTP polling miss the
# brief "ready" windows and time out (PR #273 codex 60s init timeouts,
# completion-timeout failures).
_STICKY_READY_STATUSES = frozenset(
    {
        TerminalStatus.IDLE,
        TerminalStatus.COMPLETED,
        TerminalStatus.WAITING_USER_ANSWER,
        TerminalStatus.ERROR,
    }
)


class StatusMonitor:
    """Accumulates terminal output into rolling buffers and detects status changes."""

    def __init__(self):
        # Guards _buffers/_last_status/_allow_processing_revert. State is
        # touched from the asyncio consumer (_process_chunk), FastAPI's
        # threadpool (send_input → notify_input_sent, get_status), inbox
        # delivery worker threads, and cleanup_old_data's thread. Individual
        # dict ops are GIL-atomic, but the latch logic is a read-modify-write
        # sequence (read armed → decide transition → consume arm) that must
        # not interleave with notify_input_sent, or a freshly-armed gate can
        # be consumed by a decision taken against stale state.
        self._lock = threading.RLock()
        self._buffers: Dict[str, str] = {}
        self._last_status: Dict[str, TerminalStatus] = {}
        # Per-terminal flag: when True, the next provider-detected PROCESSING
        # is honored and stickiness reset. Set by notify_input_sent() whenever
        # external input is sent to the terminal (paste-bombed by send_input
        # or backend.send_keys via provider init). Without this, latched
        # IDLE/COMPLETED would freeze the terminal forever even when the
        # agent is genuinely processing new work.
        self._allow_processing_revert: Dict[str, bool] = {}
        # Monotonic dispatch generation.  Async quiescence detection captures
        # this before leaving the lock and may apply its result only if no newer
        # input was armed in the meantime.
        self._input_generation: Dict[str, int] = {}
        # --- pyte rendered-screen detection state (only used when CAO_PYTE_STATUS
        # is on AND the provider opts in via supports_screen_detection) ---
        # Per-terminal pyte Screen+Stream that composites the raw byte stream
        # into a rendered viewport. Detection runs against the composited screen
        # on two edges only — rising (output resumed) and quiescence (output
        # stopped for PYTE_QUIESCENCE_DELAY_S) — never mid-burst, which is what
        # keeps status flap-free.
        self._screens: Dict[str, Tuple[Any, Any]] = {}
        # One candidate streak per ready-latched terminal.  Claude's TUI can
        # repaint live tool chrome after briefly drawing a ready composer, but
        # the same rows can also appear as quoted response text.  A later screen
        # sample must keep the candidate identity and fixed dynamic-key schema.
        # Three observations with two consecutive changes, including a spinner
        # glyph change, are required before the ready latch may reopen.
        self._ready_processing_samples: Dict[
            str,
            Tuple[int, str, Tuple[str, ...], Tuple[str, ...], int, bool],
        ] = {}
        self._bursting: Dict[str, bool] = {}
        # Pending quiescence-detect timer handle per terminal (loop.call_later).
        self._quiesce_handle: Dict[str, asyncio.TimerHandle] = {}
        # The event loop that owns the quiescence timers. Captured when the
        # first timer is scheduled (on the loop thread). clear_terminal /
        # reset_buffer can run OFF that thread (cleanup_old_data is dispatched
        # via asyncio.to_thread), and TimerHandle.cancel() is not thread-safe,
        # so the cancel is marshaled back onto this loop. See
        # _cancel_quiesce_handle.
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        # Strong references to in-flight quiescence-detection tasks. asyncio only
        # keeps a WEAK reference to tasks created via loop.create_task, so without
        # this a detection task can be garbage-collected mid-run and silently drop
        # a status transition. Tasks remove themselves on completion.
        self._detect_tasks: set = set()

    async def run(self) -> None:
        """Subscribe to output events and detect status changes.

        ``_process_chunk`` runs provider status detection which, for tmux-backed
        providers, shells out to the ``tmux`` binary via libtmux (a blocking
        ``subprocess`` fork/exec — e.g. kiro's ``get_pane_current_command`` in
        Check 3). Running that inline on the event loop meant every output chunk
        from every worker forked tmux ON the loop; with a few concurrent workers
        streaming, that fork storm froze the whole server (no /health, assign
        POSTs stranded until the MCP client's ~120s timeout). Offload
        ``_process_chunk`` to a worker thread so the loop stays free.

        Chunks are processed one at a time (each ``to_thread`` is awaited before
        the next ``queue.get()``), so per-terminal ordering and the latch's
        read-modify-write sequence are preserved exactly as before.
        """
        # Capture the loop up front, on the loop thread, so the debounce timers
        # scheduled from the worker thread can be marshaled back onto it.
        self._loop = asyncio.get_running_loop()
        queue = bus.subscribe("terminal.*.output")
        logger.info("StatusMonitor started")

        while True:
            try:
                event = await queue.get()
                terminal_id = terminal_id_from_topic(event["topic"])
                await asyncio.to_thread(self._process_chunk, terminal_id, event["data"]["data"])
            except Exception as e:
                logger.exception(f"Error in StatusMonitor: {e}")

    def _process_chunk(self, terminal_id: str, chunk: str) -> None:
        """Append chunk to the rolling buffer and (re)detect status.

        Two detection paths share one latch/publish backend (_apply_detection):
        - RAW (default, every provider): regex over the rolling state buffer
          (``state_buffer_max`` bytes, server setting), run on every chunk.
          Unchanged legacy behavior.
        - SCREEN (pyte): when CAO_PYTE_STATUS is on AND the provider opts in
          via supports_screen_detection, the chunk is fed to a per-terminal
          pyte screen and detection runs only on the rising edge (output
          resumed) and at quiescence (output stopped) — see
          _schedule_screen_detection.
        """
        provider = provider_manager.get_provider(terminal_id)
        use_screen = (
            CAO_PYTE_STATUS
            and provider is not None
            and getattr(provider, "supports_screen_detection", False)
        )
        state_buffer_max = get_server_settings()["state_buffer_max"]

        with self._lock:
            buffer = self._buffers.get(terminal_id, "") + chunk
            if len(buffer) > state_buffer_max:
                buffer = buffer[-state_buffer_max:]
            self._buffers[terminal_id] = buffer
            if use_screen:
                self._feed_screen_locked(terminal_id, chunk)

        if not use_screen:
            # Debounced raw detection: same rising-edge + quiescence pattern as
            # the pyte path.  Detects immediately on the first chunk after quiet
            # (catches PROCESSING transition), then waits for output to settle
            # before re-detecting (catches IDLE/COMPLETED without running costly
            # regex on every single chunk during bursts).
            self._schedule_raw_detection(terminal_id, buffer)
            return

        self._schedule_screen_detection(terminal_id, provider)

    def _apply_detection(
        self,
        terminal_id: str,
        detected: TerminalStatus,
        generation: Optional[int] = None,
        confirmed_processing: bool = False,
    ) -> None:
        """Apply the sticky-latch rules to a freshly detected status and publish
        on change. Shared by the raw and pyte detection paths.

        Stickiness: once a ready status is latched, refuse downgrades unless
        notify_input_sent() armed a revert. Two kinds of downgrade are blocked:
        1. ready → PROCESSING/UNKNOWN — buffer-eviction / mid-redraw flap.
        2. COMPLETED → IDLE — the response marker evicts before the user marker.
        The arm is consumed only by a genuine PROCESSING transition or an
        init-style non-ready → ready upgrade, never by a ready → ready flap
        (which would block the input's real PROCESSING and let InboxService
        paste into a busy agent).
        """
        with self._lock:
            if generation is not None and generation != self._input_generation.get(terminal_id, 0):
                logger.debug(
                    "Ignoring stale status detection for %s (generation %s, current %s)",
                    terminal_id,
                    generation,
                    self._input_generation.get(terminal_id, 0),
                )
                return
            last = self._last_status.get(terminal_id)
            if detected in _STICKY_READY_STATUSES:
                self._ready_processing_samples.pop(terminal_id, None)

            # UNKNOWN is "no signal", not a state: never let it overwrite a known
            # status. Mid-turn the screen can momentarily show neither a spinner
            # nor the prompt (e.g. while a tool runs), which the detector reports
            # as UNKNOWN; downgrading a known PROCESSING to UNKNOWN there is a
            # spurious transition (observed live as processing->unknown->completed).
            #
            # Do NOT narrow this to "suppress only when not armed" (to let an
            # armed new turn clear a stale ready status). It does not actually
            # close that window — the rising-edge frame right after a paste still
            # composites the PREVIOUS turn's COMPLETED box, so get_status() reports
            # ready whether or not UNKNOWN is let through — and it opens a worse
            # one: an armed ready->UNKNOWN->ready re-render (torn paste frame, then
            # the prior turn repainted before the new spinner draws) makes the
            # bounce back to COMPLETED a non-ready->ready upgrade that CONSUMES the
            # revert arm. The genuine PROCESSING that follows is then latch-blocked
            # and the terminal reads ready for the entire busy turn — exactly what
            # InboxService must never paste into. See
            # test_armed_unknown_then_ready_rerender_keeps_processing. The initial
            # UNKNOWN (last is None, nothing detected yet) is still allowed through.
            if detected == TerminalStatus.UNKNOWN and last is not None:
                return

            armed = self._allow_processing_revert.get(terminal_id, False)
            if not armed:
                confirmed_ready_processing = (
                    detected == TerminalStatus.PROCESSING
                    and confirmed_processing
                    and last in (TerminalStatus.IDLE, TerminalStatus.COMPLETED)
                )
                if (
                    last in _STICKY_READY_STATUSES
                    and detected
                    in (
                        TerminalStatus.PROCESSING,
                        TerminalStatus.UNKNOWN,
                    )
                    and not confirmed_ready_processing
                ):
                    return
                if last == TerminalStatus.COMPLETED and detected == TerminalStatus.IDLE:
                    return

            if detected == last:
                return

            self._last_status[terminal_id] = detected
            if detected == TerminalStatus.PROCESSING:
                self._allow_processing_revert[terminal_id] = False
                self._ready_processing_samples.pop(terminal_id, None)
            elif detected in _STICKY_READY_STATUSES:
                if last not in _STICKY_READY_STATUSES:
                    self._allow_processing_revert[terminal_id] = False
                self._ready_processing_samples.pop(terminal_id, None)

        # Publish outside the lock — subscribers must never be able to
        # re-enter StatusMonitor while the latch state is mid-update.
        bus.publish(f"terminal.{terminal_id}.status", {"status": detected.value})
        logger.info(f"Terminal {terminal_id} status changed: {detected.value}")

    # ----- pyte rendered-screen detection (edge-debounced) -------------------

    def _feed_screen_locked(self, terminal_id: str, chunk: str) -> None:
        """Feed a chunk into the terminal's pyte screen. Caller holds the lock.

        Lazily creates the Screen+Stream so pyte is only imported/used when the
        screen path is active for this terminal.
        """
        scr = self._screens.get(terminal_id)
        if scr is None:
            import pyte

            screen = pyte.Screen(PYTE_SCREEN_COLS, PYTE_SCREEN_ROWS)
            stream = pyte.Stream(screen)
            scr = (screen, stream)
            self._screens[terminal_id] = scr
        scr[1].feed(chunk)

    def _capture_screen_snapshot(self, terminal_id: str) -> Tuple[List[str], Optional[str]]:
        """Capture one immutable viewport, or the raw fallback after a render error."""
        fallback_buffer: Optional[str] = None
        with self._lock:
            scr = self._screens.get(terminal_id)
            buffer = self._buffers.get(terminal_id, "")
            try:
                lines: List[str] = list(scr[0].display) if scr is not None else []
            except Exception:
                # pyte can transiently hold zero-length cell data while rendering
                # complex TUI redraws. Fall back to raw-buffer detection instead of
                # letting the quiescence callback tear down status monitoring.
                logger.exception(
                    "Error rendering screen status for %s; falling back to raw buffer",
                    terminal_id,
                )
                fallback_buffer = buffer
                lines = []
        return lines, fallback_buffer

    def _detect_screen(
        self,
        terminal_id: str,
        provider,
        snapshot: Optional[Tuple[List[str], Optional[str]]] = None,
    ) -> TerminalStatus:
        """Detect status from one composited pyte-screen snapshot."""
        lines, fallback_buffer = snapshot or self._capture_screen_snapshot(terminal_id)
        if fallback_buffer is not None:
            if provider is None:
                return TerminalStatus.UNKNOWN
            try:
                return cast(TerminalStatus, provider.get_status(fallback_buffer))
            except Exception:
                logger.exception("Error detecting fallback status for %s", terminal_id)
                return TerminalStatus.UNKNOWN
        if not lines or provider is None:
            return TerminalStatus.UNKNOWN
        try:
            return cast(TerminalStatus, provider.get_status_from_screen(lines))
        except Exception:
            # Full traceback: screen detectors are new and can trip on
            # unexpected TUI frames; the stack makes such regressions debuggable.
            logger.exception(f"Error detecting screen status for {terminal_id}")
            return TerminalStatus.UNKNOWN

    def _screen_confirms_processing(
        self,
        terminal_id: str,
        provider,
        detected: TerminalStatus,
        generation: Optional[int],
        lines: List[str],
    ) -> bool:
        """Require a complete fixed schema and two successive live changes."""
        with self._lock:
            current_generation = self._input_generation.get(terminal_id, 0)
            if generation is not None and generation != current_generation:
                return False
            last = self._last_status.get(terminal_id)
            armed = self._allow_processing_revert.get(terminal_id, False)
            if (
                detected != TerminalStatus.PROCESSING
                or last not in (TerminalStatus.IDLE, TerminalStatus.COMPLETED)
                or armed
            ):
                self._ready_processing_samples.pop(terminal_id, None)
                return False
        if not lines or provider is None:
            with self._lock:
                self._ready_processing_samples.pop(terminal_id, None)
            return False
        try:
            sample = provider.current_turn_processing_sample("\n".join(lines))
        except Exception:
            logger.exception("Error sampling live processing for %s", terminal_id)
            with self._lock:
                self._ready_processing_samples.pop(terminal_id, None)
            return False
        if not isinstance(sample, tuple) or len(sample) != 2:
            with self._lock:
                self._ready_processing_samples.pop(terminal_id, None)
            return False

        identity, keyed_values = sample
        valid_keyed_values = (
            isinstance(identity, str)
            and bool(identity)
            and isinstance(keyed_values, tuple)
            and bool(keyed_values)
            and all(
                isinstance(pair, tuple)
                and len(pair) == 2
                and all(isinstance(part, str) and part for part in pair)
                for pair in keyed_values
            )
        )
        if not valid_keyed_values:
            with self._lock:
                self._ready_processing_samples.pop(terminal_id, None)
            return False

        keys = tuple(pair[0] for pair in keyed_values)
        values = tuple(pair[1] for pair in keyed_values)
        if len(set(keys)) != len(keys) or "spinner_glyph" not in keys:
            with self._lock:
                self._ready_processing_samples.pop(terminal_id, None)
            return False

        with self._lock:
            current_generation = self._input_generation.get(terminal_id, 0)
            if generation is not None and generation != current_generation:
                return False
            if self._last_status.get(terminal_id) not in (
                TerminalStatus.IDLE,
                TerminalStatus.COMPLETED,
            ) or self._allow_processing_revert.get(terminal_id, False):
                self._ready_processing_samples.pop(terminal_id, None)
                return False
            previous = self._ready_processing_samples.get(terminal_id)
            if (
                previous is None
                or previous[0] != current_generation
                or previous[1] != identity
                or previous[2] != keys
            ):
                self._ready_processing_samples[terminal_id] = (
                    current_generation,
                    identity,
                    keys,
                    values,
                    0,
                    False,
                )
                return False

            if previous[3] == values:
                self._ready_processing_samples[terminal_id] = (
                    current_generation,
                    identity,
                    keys,
                    values,
                    0,
                    False,
                )
                return False

            spinner_index = keys.index("spinner_glyph")
            change_streak = previous[4] + 1
            spinner_changed = previous[5] or previous[3][spinner_index] != values[spinner_index]
            self._ready_processing_samples[terminal_id] = (
                current_generation,
                identity,
                keys,
                values,
                change_streak,
                spinner_changed,
            )
            return change_streak >= 2 and spinner_changed

    def _detect_and_apply_screen(
        self,
        terminal_id: str,
        provider,
        generation: Optional[int] = None,
    ) -> TerminalStatus:
        """Detect a rendered status and apply provider-confirmed live work."""
        if generation is None:
            with self._lock:
                generation = self._input_generation.get(terminal_id, 0)
        snapshot = self._capture_screen_snapshot(terminal_id)
        detected = self._detect_screen(terminal_id, provider, snapshot)
        confirmed = self._screen_confirms_processing(
            terminal_id,
            provider,
            detected,
            generation,
            snapshot[0],
        )
        self._apply_detection(
            terminal_id,
            detected,
            generation,
            confirmed_processing=confirmed,
        )
        return detected

    def _schedule_screen_detection(self, terminal_id: str, provider) -> None:
        """Edge-debounce detection on the pyte screen.

        Rising edge (first chunk after quiet) → detect immediately (catches the
        PROCESSING transition the instant work resumes). Quiescence (no new
        chunk for PYTE_QUIESCENCE_DELAY_S) → detect again (the TUI repaint has
        settled, so the screen shows the true end state). Detection NEVER runs
        mid-burst, which is what eliminates the flaps naive per-chunk rendered
        detection produces.
        """
        loop = self._loop or self._running_loop()
        if loop is None:
            # No event loop (unit tests / offline replay): detect immediately
            # on the current screen — deterministic, no timing.
            self._detect_and_apply_screen(terminal_id, provider)
            return

        with self._lock:
            was_bursting = self._bursting.get(terminal_id, False)
            self._bursting[terminal_id] = True
            handle = self._quiesce_handle.pop(terminal_id, None)
            last_status = self._last_status.get(terminal_id)
            generation = self._input_generation.get(terminal_id, 0)
        self._cancel_quiesce_handle(handle)

        # The first frame after input can still be the echoed idle composer.
        # Keep sampling while a ready state is latched: normally the dispatch
        # arm admits the next PROCESSING edge, while a provider-confirmed live
        # marker admits same-turn tool work that starts after an interim ready
        # repaint.  Unconfirmed redraws remain blocked by _apply_detection.
        if not was_bursting or last_status is None or last_status in _STICKY_READY_STATUSES:
            self._detect_and_apply_screen(terminal_id, provider, generation)

        self._arm_quiesce_timer(
            loop,
            terminal_id,
            self._on_screen_quiescent,
            provider,
            generation,
        )

    def _on_screen_quiescent(
        self,
        terminal_id: str,
        provider,
        generation: Optional[int] = None,
    ) -> None:
        """Quiescence timer fired: output stopped, so the screen has settled.

        Fires on the loop; offload the (potentially blocking) screen detection
        to a worker thread so the loop stays free.
        """
        with self._lock:
            self._bursting[terminal_id] = False
            self._quiesce_handle.pop(terminal_id, None)

        async def _detect_and_apply() -> None:
            await asyncio.to_thread(
                self._detect_and_apply_screen,
                terminal_id,
                provider,
                generation,
            )

        loop = self._loop or self._running_loop()
        if loop is None:
            self._detect_and_apply_screen(terminal_id, provider, generation)
        else:
            self._spawn_tracked(loop, _detect_and_apply())

    def _schedule_raw_detection(self, terminal_id: str, buffer: str) -> None:
        """Edge-debounce detection on the raw rolling buffer.

        Detects on every chunk while the terminal is in a ready/armed state
        (to catch the IDLE→PROCESSING transition immediately). Once PROCESSING
        is observed, switches to quiescence-only detection (the busy→ready
        transition only matters after output settles). This prevents queue
        overflow during sustained output while ensuring InboxService never
        pastes into a busy terminal.

        Runs on a StatusMonitor worker thread (``run`` dispatches
        ``_process_chunk`` via ``asyncio.to_thread``), so the blocking
        ``_detect_status`` (which shells out to tmux) executes off the event
        loop. The quiescence timer is loop-affine, so it is armed on the
        captured loop via ``call_soon_threadsafe`` rather than the current
        thread's (nonexistent) loop.
        """
        loop = self._loop or self._running_loop()
        if loop is None:
            # No loop ever captured (unit tests / offline replay): detect
            # inline and skip the debounce timer.
            self._apply_detection(terminal_id, self._detect_status(terminal_id, buffer))
            return

        with self._lock:
            was_bursting = self._bursting.get(terminal_id, False)
            self._bursting[terminal_id] = True
            handle = self._quiesce_handle.pop(terminal_id, None)
            last_status = self._last_status.get(terminal_id)
            generation = self._input_generation.get(terminal_id, 0)
        self._cancel_quiesce_handle(handle)

        # While terminal is ready/armed, detect on every chunk so the
        # IDLE→PROCESSING transition is never missed (prevents stale-IDLE
        # delivery by InboxService). Once PROCESSING is observed, debounce.
        if not was_bursting or last_status in _STICKY_READY_STATUSES or last_status is None:
            detected = self._detect_status(terminal_id, buffer)
            self._apply_detection(terminal_id, detected, generation)

        self._arm_quiesce_timer(loop, terminal_id, self._on_raw_quiescent, generation)

    def _arm_quiesce_timer(self, loop, terminal_id: str, callback, *cb_args) -> None:
        """Schedule the quiescence timer on ``loop`` from any thread.

        ``loop.call_later`` is not thread-safe and this may run on a worker
        thread, so marshal the scheduling onto the loop with
        ``call_soon_threadsafe``. The resulting TimerHandle is stored from
        inside the marshaled closure (still on the loop thread) so cancel
        marshaling in ``_cancel_quiesce_handle`` stays correct. ``cb_args``
        are extra positional args passed to ``callback`` after ``terminal_id``.
        """

        def _arm() -> None:
            # Runs on the loop thread (via call_soon_threadsafe), so it is safe
            # to cancel a prior TimerHandle directly here. Cancel any existing
            # timer for this terminal BEFORE arming the new one: if several
            # chunks arrive in quick succession their _arm closures are queued
            # together, and without this the later closure would overwrite
            # _quiesce_handle while leaving the earlier timer live — two timers
            # then fire, and a stale one firing mid-burst causes early/duplicate
            # quiescence detections and status flaps. One outstanding timer per
            # terminal, always the latest.
            with self._lock:
                prior = self._quiesce_handle.get(terminal_id)
                if prior is not None:
                    prior.cancel()
                handle = loop.call_later(PYTE_QUIESCENCE_DELAY_S, callback, terminal_id, *cb_args)
                self._quiesce_handle[terminal_id] = handle

        try:
            loop.call_soon_threadsafe(_arm)
        except RuntimeError:
            # Loop closed during shutdown — quiescence re-detect is moot.
            pass

    def _on_raw_quiescent(
        self,
        terminal_id: str,
        generation: Optional[int] = None,
    ) -> None:
        """Quiescence timer fired for raw path: re-detect from current buffer.

        Fires on the event loop (via call_later), so the blocking
        ``_detect_status`` is offloaded to a worker thread to keep the loop
        free — a tmux ``get_pane_current_command`` here would otherwise fork
        on the loop.
        """
        with self._lock:
            self._bursting[terminal_id] = False
            self._quiesce_handle.pop(terminal_id, None)
            buffer = self._buffers.get(terminal_id, "")

        async def _detect_and_apply() -> None:
            detected = await asyncio.to_thread(self._detect_status, terminal_id, buffer)
            self._apply_detection(terminal_id, detected, generation)

        loop = self._loop or self._running_loop()
        if loop is None:
            self._apply_detection(
                terminal_id,
                self._detect_status(terminal_id, buffer),
                generation,
            )
        else:
            self._spawn_tracked(loop, _detect_and_apply())

    def _spawn_tracked(self, loop, coro) -> None:
        """Create a task on ``loop`` and hold a strong reference until it
        finishes, so asyncio's weak task references can't GC it mid-run."""
        task = loop.create_task(coro)
        self._detect_tasks.add(task)
        task.add_done_callback(self._detect_tasks.discard)

    @staticmethod
    def _running_loop() -> Optional[asyncio.AbstractEventLoop]:
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            return None

    def _cancel_quiesce_handle(self, handle: Optional[asyncio.TimerHandle]) -> None:
        """Cancel a quiescence timer safely from any thread.

        The timer is an asyncio.TimerHandle owned by ``self._loop``.
        TimerHandle.cancel() mutates loop-internal scheduling state and is NOT
        thread-safe, yet clear_terminal/reset_buffer can run off the loop thread
        (cleanup_old_data is dispatched via asyncio.to_thread). Marshal the
        cancel onto the owning loop with call_soon_threadsafe unless we are
        already on it.
        """
        if handle is None:
            return
        loop = self._loop
        if loop is None:
            handle.cancel()  # no loop ever captured (unit/offline path) — safe
            return
        try:
            on_loop = asyncio.get_running_loop() is loop
        except RuntimeError:
            on_loop = False
        if on_loop:
            handle.cancel()
        else:
            try:
                loop.call_soon_threadsafe(handle.cancel)
            except RuntimeError:
                pass  # loop already closed during shutdown — the timer is moot

    def notify_input_sent(self, terminal_id: str) -> None:
        """Arm the next PROCESSING transition.

        Call before any send_keys / paste that initiates a new processing
        cycle (terminal_service.send_input, provider.initialize warm-up
        and CLI-launch keystrokes). Without this, a previously-latched
        IDLE/COMPLETED would block the genuine PROCESSING transition.
        """
        with self._lock:
            self._input_generation[terminal_id] = self._input_generation.get(terminal_id, 0) + 1
            self._allow_processing_revert[terminal_id] = True
            self._ready_processing_samples.pop(terminal_id, None)

    def is_input_armed(self, terminal_id: str) -> bool:
        """Return whether a newly-sent input still awaits observed processing.

        A terminal may retain the previous turn's ``COMPLETED`` status for a
        short time after new input is sent. Completion waiters use this latch
        to distinguish that stale marker from completion of the new turn.
        """
        with self._lock:
            return self._allow_processing_revert.get(terminal_id, False)

    def clear_rolling_buffer(self, terminal_id: str) -> None:
        """Clear ONLY the rolling byte buffer for a terminal — preserves
        ``_last_status`` and ``_allow_processing_revert``.

        Used by send_input to drop stale pre-task content (e.g. kiro-cli 2.11's
        "ask a question" idle placeholder) so it can't combine with the
        input_received flag to trigger a false COMPLETED before the agent has
        rendered its processing indicator. Unlike ``reset_buffer``, this does
        NOT wipe the sticky-latch state, so the arm set by ``notify_input_sent``
        survives and the subsequent IDLE→PROCESSING transition is honored.
        """
        with self._lock:
            self._buffers[terminal_id] = ""

    def seed_terminal_history(self, terminal_id: str, history: str) -> None:
        """Prime status state from a live pane after a server restart.

        This bypasses the output event bus so historical scrollback is not
        duplicated in the append-only terminal log.  Future bytes still arrive
        through the reattached FIFO reader.

        ``tmux capture-pane`` returns display rows separated by bare LF.  pyte
        models a terminal with line-feed/new-line mode disabled, so feeding
        that text verbatim advances rows without returning to column zero and
        staircases the restored screen.  Subsequent cursor-addressed TUI
        redraws can then leave stale processing chrome in the wrong rows even
        after the real pane is idle.  Convert captured rows to terminal-style
        CRLF before seeding, matching the stalled-pipe replay path.
        """

        self.reset_buffer(terminal_id)
        if history:
            normalized_history = history.replace("\r\n", "\n").replace("\r", "\n")
            normalized_history = normalized_history.replace("\n", "\r\n")
            self._process_chunk(terminal_id, normalized_history)

    def _detect_status(self, terminal_id: str, buffer: str) -> TerminalStatus:
        """Detect status: provider-specific patterns or UNKNOWN if no provider."""
        provider = provider_manager.get_provider(terminal_id)
        if provider is None:
            return TerminalStatus.UNKNOWN

        try:
            return provider.get_status(buffer)
        except Exception as e:
            logger.error(f"Error detecting status for {terminal_id}: {e}")
            return TerminalStatus.UNKNOWN

    def clear_terminal(self, terminal_id: str) -> None:
        """Free buffer and status for a deleted terminal."""
        with self._lock:
            self._buffers.pop(terminal_id, None)
            self._last_status.pop(terminal_id, None)
            self._allow_processing_revert.pop(terminal_id, None)
            self._input_generation.pop(terminal_id, None)
            self._screens.pop(terminal_id, None)
            self._ready_processing_samples.pop(terminal_id, None)
            self._bursting.pop(terminal_id, None)
            handle = self._quiesce_handle.pop(terminal_id, None)
        self._cancel_quiesce_handle(handle)

    def reset_buffer(self, terminal_id: str) -> None:
        """Clear the rolling buffer + last-known status WITHOUT forgetting the
        terminal.

        Used when a provider relaunches a different CLI mode on the SAME
        ``terminal_id`` (e.g. Kiro's TUI -> ``--legacy-ui`` fallback). Without
        this, the retry re-derives status from a buffer still full of stale bytes
        from the failed first attempt and can spuriously time out.
        """
        with self._lock:
            self._buffers[terminal_id] = ""
            self._last_status.pop(terminal_id, None)
            self._allow_processing_revert.pop(terminal_id, None)
            self._input_generation[terminal_id] = self._input_generation.get(terminal_id, 0) + 1
            # Drop the rendered screen too so the relaunched CLI mode is
            # detected against a fresh viewport, not the failed attempt's.
            self._screens.pop(terminal_id, None)
            self._ready_processing_samples.pop(terminal_id, None)
            self._bursting.pop(terminal_id, None)
            handle = self._quiesce_handle.pop(terminal_id, None)
        self._cancel_quiesce_handle(handle)

    def get_status(self, terminal_id: str) -> TerminalStatus:
        """Get current terminal status — the single source of truth for both backends.

        Pipe-pane backends (tmux) return the last status pushed by the FIFO →
        EventBus → _process_chunk pipeline. Event-inbox backends (herdr) don't
        feed that pipeline (no FIFO reader is started for them), so _last_status
        would stay UNKNOWN forever; for those we derive status on demand from the
        provider, whose get_status() consults backend.get_native_status(). Doing
        it here means every caller (API status, init waits, busy checks, curator
        liveness) works on herdr without each having to special-case the backend.
        """
        from cli_agent_orchestrator.backends.registry import get_backend

        if get_backend().supports_event_inbox():
            try:
                provider = provider_manager.get_provider(terminal_id)
            except Exception:
                provider = None
            if provider is not None:
                with self._lock:
                    buffer = self._buffers.get(terminal_id, "")
                try:
                    # The native (herdr) path ignores the buffer arg; pass the
                    # rolling buffer (empty for herdr) so the rare
                    # get_native_status()==None fallback still gets what we have.
                    # provider.get_status may shell out to the herdr CLI — call
                    # it outside the lock.
                    fresh = provider.get_status(buffer)
                    if fresh in {
                        TerminalStatus.PROCESSING,
                        TerminalStatus.WAITING_USER_ANSWER,
                    }:
                        # Native/event-inbox state is authoritative evidence
                        # that the just-sent turn was accepted.  This branch does
                        # not pass through _apply_detection, so consume the arm
                        # explicitly before completion can arrive.
                        with self._lock:
                            self._allow_processing_revert[terminal_id] = False
                    self._apply_detection(terminal_id, fresh)
                    return fresh
                except Exception as e:
                    logger.error(f"Error deriving native status for {terminal_id}: {e}")
                    return TerminalStatus.UNKNOWN

        with self._lock:
            cached = self._last_status.get(terminal_id, TerminalStatus.UNKNOWN)
            armed_ready = cached in _STICKY_READY_STATUSES and self._allow_processing_revert.get(
                terminal_id, False
            )
            generation = self._input_generation.get(terminal_id, 0)
            # When cached status is PROCESSING, the debounced detection may be
            # stuck: TUI providers (kiro-cli) can send escape sequences
            # continuously after becoming idle, preventing the 200ms quiescence
            # timer from ever firing. Do a fresh detection from the current
            # buffer so poll-based callers (wait_until_status) catch the
            # PROCESSING→ready transition without waiting for stream silence.
            if cached == TerminalStatus.PROCESSING or armed_ready:
                buffer = self._buffers.get(terminal_id, "")
            else:
                buffer = ""

        if (cached == TerminalStatus.PROCESSING and buffer) or armed_ready:
            # Keep the poll-time refresh on the SAME detection path that
            # produced the cached status.  In rendered-screen mode the raw
            # pipe-pane stream still contains stale completion markers and
            # cursor-redraw fragments; asking the raw detector to overrule a
            # live composited spinner can therefore turn PROCESSING into
            # COMPLETED mid-turn.  run_step then tears the worker down while it
            # is still working.  Screen-enabled providers must refresh from
            # their composited viewport instead.
            try:
                provider = provider_manager.get_provider(terminal_id)
            except Exception:
                provider = None
            use_screen = (
                CAO_PYTE_STATUS
                and provider is not None
                and getattr(provider, "supports_screen_detection", False)
            )
            if not use_screen and not buffer:
                return cached
            fresh = (
                self._detect_screen(terminal_id, provider)
                if use_screen
                else self._detect_status(terminal_id, buffer)
            )
            logger.debug(
                f"get_status [{terminal_id}]: cached={cached.value}, "
                f"fresh={fresh.value}, detector={'screen' if use_screen else 'raw'}, "
                f"buffer_len={len(buffer)}"
            )
            if armed_ready and fresh == TerminalStatus.PROCESSING:
                self._apply_detection(terminal_id, fresh, generation)
                return fresh
            if (
                armed_ready
                and fresh in _STICKY_READY_STATUSES
                and buffer
                and provider is not None
                and provider.confirms_current_turn_completion(buffer) is True
            ):
                # A provider-authenticated response delta proves a very fast
                # turn completed before PROCESSING was sampled.  Emit the
                # missing edge, consuming the arm, then settle to the detected
                # ready state in the same poll.
                self._apply_detection(terminal_id, TerminalStatus.PROCESSING, generation)
                self._apply_detection(terminal_id, fresh, generation)
                return fresh
            if (
                cached == TerminalStatus.PROCESSING
                and fresh != TerminalStatus.PROCESSING
                and fresh != TerminalStatus.UNKNOWN
            ):
                # A screen provider's composited viewport sampled at an arbitrary
                # poll instant can be a torn / spinner-erased mid-burst redraw
                # even though the agent is still streaming its answer. Codex in
                # particular shows the idle composer + earlier response bullets
                # while the work spinner is momentarily absent between chunks, so
                # get_status_from_screen classifies that interim frame COMPLETED
                # (or IDLE) — base.get_status_from_screen is only contracted on
                # the rising/quiescence edges, "never mid-burst". Honoring that
                # single interim frame let run_step extract a partial answer
                # (e.g. only 6 of 20 requested lines) and tear the worker down.
                #
                # Accept a "looks-done" downgrade (COMPLETED/IDLE) only once the
                # byte stream has actually gone quiet; while output is still
                # bursting keep PROCESSING and let the quiescence-edge detection
                # make the authoritative transition off a settled frame. This
                # distinguishes live output from quiescence via real stream
                # activity, not a wall-clock guess. ERROR / WAITING_USER_ANSWER
                # are genuine interrupts (crash, approval prompt) and still
                # surface immediately even mid-burst.
                if (
                    use_screen
                    and fresh in (TerminalStatus.COMPLETED, TerminalStatus.IDLE)
                    and self._is_bursting(terminal_id)
                ):
                    return cached
                self._apply_detection(terminal_id, fresh, generation)
                return fresh
        return cached

    def _is_bursting(self, terminal_id: str) -> bool:
        """Return whether output is still actively streaming for a terminal.

        True between the first chunk of a burst and the quiescence timer firing
        ``PYTE_QUIESCENCE_DELAY_S`` after the last chunk. Used by the poll-time
        refresh to distinguish a torn mid-burst composited frame from a settled
        end-of-turn frame.
        """
        with self._lock:
            return self._bursting.get(terminal_id, False)

    def get_buffer(self, terminal_id: str) -> str:
        """Get accumulated output buffer for a terminal."""
        with self._lock:
            return self._buffers.get(terminal_id, "")


# Module-level singleton
status_monitor = StatusMonitor()
