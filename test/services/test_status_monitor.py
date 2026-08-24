"""Tests for StatusMonitor — focus on backend-aware get_status().

get_status() is the single source of truth for terminal status. For pipe-pane
backends (tmux) it returns the pushed pipeline status; for event-inbox backends
(herdr), which never feed the pipeline, it derives status on demand from the
provider's native status. These tests pin both paths.
"""

import threading
from unittest.mock import MagicMock, patch

from cli_agent_orchestrator.models.terminal import TerminalStatus
from cli_agent_orchestrator.providers.claude_code import ClaudeCodeProvider
from cli_agent_orchestrator.services.status_monitor import StatusMonitor


def _backend(event_inbox):
    backend = MagicMock()
    backend.supports_event_inbox.return_value = event_inbox
    return backend


class TestGetStatusTmux:
    """Pipe-pane backend: get_status returns the pushed _last_status, unchanged."""

    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_returns_pushed_status(self, mock_get_backend):
        mock_get_backend.return_value = _backend(event_inbox=False)
        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.PROCESSING

        assert sm.get_status("t1") == TerminalStatus.PROCESSING

    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_unknown_when_never_seen(self, mock_get_backend):
        mock_get_backend.return_value = _backend(event_inbox=False)
        sm = StatusMonitor()

        assert sm.get_status("missing") == TerminalStatus.UNKNOWN


class TestGetStatusEventInbox:
    """Event-inbox backend (herdr): derive status on demand from the provider."""

    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_derives_from_provider_native_status(self, mock_get_backend, mock_pm):
        mock_get_backend.return_value = _backend(event_inbox=True)
        provider = MagicMock()
        provider.get_status.return_value = TerminalStatus.IDLE
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        # _last_status is empty (herdr never feeds the pipeline) — the old code
        # would return UNKNOWN here.
        assert sm.get_status("t1") == TerminalStatus.IDLE
        provider.get_status.assert_called_once()

    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_unknown_when_no_provider(self, mock_get_backend, mock_pm):
        mock_get_backend.return_value = _backend(event_inbox=True)
        mock_pm.get_provider.return_value = None

        sm = StatusMonitor()
        assert sm.get_status("t1") == TerminalStatus.UNKNOWN

    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_unknown_when_provider_lookup_raises(self, mock_get_backend, mock_pm):
        mock_get_backend.return_value = _backend(event_inbox=True)
        mock_pm.get_provider.side_effect = ValueError("terminal not in db")

        sm = StatusMonitor()
        assert sm.get_status("t1") == TerminalStatus.UNKNOWN

    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_unknown_when_provider_get_status_raises(self, mock_get_backend, mock_pm):
        mock_get_backend.return_value = _backend(event_inbox=True)
        provider = MagicMock()
        provider.get_status.side_effect = RuntimeError("herdr cli failed")
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        assert sm.get_status("t1") == TerminalStatus.UNKNOWN

    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_native_processing_consumes_arm_before_completion(self, mock_get_backend, mock_pm):
        """Herdr's authoritative working edge must release the new-turn latch."""

        mock_get_backend.return_value = _backend(event_inbox=True)
        provider = MagicMock()
        provider.get_status.side_effect = [TerminalStatus.PROCESSING, TerminalStatus.COMPLETED]
        mock_pm.get_provider.return_value = provider
        sm = StatusMonitor()
        sm.notify_input_sent("t1")

        assert sm.get_status("t1") == TerminalStatus.PROCESSING
        assert sm.is_input_armed("t1") is False
        assert sm.get_status("t1") == TerminalStatus.COMPLETED


class TestScreenDetection:
    """Rendered-screen detection should fail soft and keep monitoring alive."""

    @patch("cli_agent_orchestrator.services.status_monitor.CAO_PYTE_STATUS", True)
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_processing_poll_refresh_stays_on_screen_path(self, mock_get_backend, mock_pm):
        """A raw redraw stream must not overrule a live rendered spinner.

        This is the exact run_step failure mode observed with Claude Code: the
        screen detector had correctly latched PROCESSING for ``· Kneading…``,
        while the raw buffer still contained an earlier completion marker and
        returned COMPLETED.  A poll-time refresh used to trust that raw result
        and tear down the worker mid-turn.
        """
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = True
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.PROCESSING
        sm._buffers["t1"] = "raw redraw with stale completion marker"
        sm._detect_screen = MagicMock(return_value=TerminalStatus.PROCESSING)
        sm._detect_status = MagicMock(return_value=TerminalStatus.COMPLETED)

        assert sm.get_status("t1") == TerminalStatus.PROCESSING
        sm._detect_screen.assert_called_once_with("t1", provider)
        sm._detect_status.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.CAO_PYTE_STATUS", True)
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_armed_idle_poll_refresh_detects_processing_on_screen(self, mock_get_backend, mock_pm):
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = True
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.IDLE
        sm._allow_processing_revert["t1"] = True
        sm._buffers["t1"] = "raw redraw with stale idle composer"
        sm._detect_screen = MagicMock(return_value=TerminalStatus.PROCESSING)
        sm._detect_status = MagicMock(return_value=TerminalStatus.IDLE)

        assert sm.get_status("t1") == TerminalStatus.PROCESSING
        assert sm._allow_processing_revert["t1"] is False
        sm._detect_screen.assert_called_once_with("t1", provider)
        sm._detect_status.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.CAO_PYTE_STATUS", True)
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_authenticated_fast_completion_synthesizes_processing_edge(
        self, mock_get_backend, mock_pm
    ):
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = True
        provider.confirms_current_turn_completion.return_value = True
        mock_pm.get_provider.return_value = provider
        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.COMPLETED
        sm._buffers["t1"] = "new response and ready composer"
        sm.notify_input_sent("t1")
        sm._detect_screen = MagicMock(return_value=TerminalStatus.COMPLETED)

        assert sm.get_status("t1") == TerminalStatus.COMPLETED
        assert sm.is_input_armed("t1") is False
        provider.confirms_current_turn_completion.assert_called_once_with(
            "new response and ready composer"
        )

    @patch("cli_agent_orchestrator.services.status_monitor.CAO_PYTE_STATUS", True)
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_processing_poll_refresh_defers_completed_while_bursting(
        self, mock_get_backend, mock_pm
    ):
        """A completed-looking interim frame must not end the step mid-stream.

        The observed run_step failure: Codex is still streaming its answer (only
        6 of 20 requested lines emitted) but a poll-time screen sample caught a
        torn / spinner-erased redraw and returned COMPLETED, so run_step
        extracted a partial answer and tore the worker down. While output is
        still bursting, keep PROCESSING and leave the latch untouched.
        """
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = True
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.PROCESSING
        sm._buffers["t1"] = "partial streamed answer, still writing"
        sm._bursting["t1"] = True
        sm._detect_screen = MagicMock(return_value=TerminalStatus.COMPLETED)

        assert sm.get_status("t1") == TerminalStatus.PROCESSING
        # The interim frame must not be latched as a real completion.
        assert sm._last_status["t1"] == TerminalStatus.PROCESSING

    @patch("cli_agent_orchestrator.services.status_monitor.CAO_PYTE_STATUS", True)
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_processing_poll_refresh_defers_idle_while_bursting(self, mock_get_backend, mock_pm):
        """An idle-looking interim frame is deferred the same way as completed."""
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = True
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.PROCESSING
        sm._buffers["t1"] = "partial streamed answer, still writing"
        sm._bursting["t1"] = True
        sm._detect_screen = MagicMock(return_value=TerminalStatus.IDLE)

        assert sm.get_status("t1") == TerminalStatus.PROCESSING
        assert sm._last_status["t1"] == TerminalStatus.PROCESSING

    @patch("cli_agent_orchestrator.services.status_monitor.CAO_PYTE_STATUS", True)
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_processing_poll_refresh_accepts_completed_when_quiescent(
        self, mock_get_backend, mock_pm
    ):
        """Once output has settled (not bursting), a genuine completion still flips."""
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = True
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.PROCESSING
        sm._buffers["t1"] = "final answer and ready composer"
        sm._bursting["t1"] = False
        sm._detect_screen = MagicMock(return_value=TerminalStatus.COMPLETED)

        assert sm.get_status("t1") == TerminalStatus.COMPLETED
        assert sm._last_status["t1"] == TerminalStatus.COMPLETED

    @patch("cli_agent_orchestrator.services.status_monitor.CAO_PYTE_STATUS", True)
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_processing_poll_refresh_surfaces_error_even_while_bursting(
        self, mock_get_backend, mock_pm
    ):
        """A crash mid-burst is a genuine interrupt and must surface immediately."""
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = True
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.PROCESSING
        sm._buffers["t1"] = "traceback while streaming"
        sm._bursting["t1"] = True
        sm._detect_screen = MagicMock(return_value=TerminalStatus.ERROR)

        assert sm.get_status("t1") == TerminalStatus.ERROR

    @patch("cli_agent_orchestrator.services.status_monitor.CAO_PYTE_STATUS", True)
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_processing_poll_refresh_surfaces_waiting_even_while_bursting(
        self, mock_get_backend, mock_pm
    ):
        """An approval prompt mid-burst is a genuine interrupt and surfaces immediately."""
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = True
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.PROCESSING
        sm._buffers["t1"] = "approve? y/n"
        sm._bursting["t1"] = True
        sm._detect_screen = MagicMock(return_value=TerminalStatus.WAITING_USER_ANSWER)

        assert sm.get_status("t1") == TerminalStatus.WAITING_USER_ANSWER

    def test_stale_async_detection_cannot_consume_new_generation(self):
        sm = StatusMonitor()
        sm._last_status["t1"] = TerminalStatus.COMPLETED
        sm.notify_input_sent("t1")
        stale_generation = sm._input_generation["t1"]
        sm.notify_input_sent("t1")

        sm._apply_detection("t1", TerminalStatus.PROCESSING, stale_generation)

        assert sm.get_status("t1") == TerminalStatus.COMPLETED
        assert sm.is_input_armed("t1") is True

    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    def test_render_error_falls_back_to_raw_buffer_detection(self, mock_pm):
        class BrokenScreen:
            @property
            def display(self):
                raise RuntimeError("torn pyte frame")

        provider = MagicMock()
        provider.get_status.return_value = TerminalStatus.IDLE
        mock_pm.get_provider.side_effect = AssertionError("provider should not be refetched")

        sm = StatusMonitor()
        sm._screens["t1"] = (BrokenScreen(), MagicMock())
        sm._buffers["t1"] = "raw buffer with idle footer"

        assert sm._detect_screen("t1", provider) == TerminalStatus.IDLE
        provider.get_status.assert_called_once_with("raw buffer with idle footer")
        mock_pm.get_provider.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_three_in_place_live_repaints_reopen_idle_and_completed(self, mock_bus):
        """A live foreground tool may start after an interim ready repaint.

        Three complete screens with the same identity, two successive dynamic
        changes, and a spinner-glyph cycle may override the ready latch.
        """

        first_frame = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
            "─" * 60,
            "❯",
            "─" * 60,
        ]
        second_frame = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 6s · timeout 10m)",
            "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
            "─" * 60,
            "❯",
            "─" * 60,
        ]
        third_frame = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 7s · timeout 10m)",
            "✻ Forging… (4m 25s · ↓ 6.4k tokens)",
            "─" * 60,
            "❯",
            "─" * 60,
        ]
        screen = MagicMock()
        provider = ClaudeCodeProvider("t1", "session", "window")
        for ready_status in (TerminalStatus.IDLE, TerminalStatus.COMPLETED):
            mock_bus.reset_mock()
            sm = StatusMonitor()
            sm._screens["t1"] = (screen, MagicMock())
            sm._last_status["t1"] = ready_status

            screen.display = first_frame
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
            assert sm._last_status["t1"] == ready_status
            mock_bus.publish.assert_not_called()

            screen.display = second_frame
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
            assert sm._last_status["t1"] == ready_status
            mock_bus.publish.assert_not_called()

            screen.display = third_frame
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
            assert sm._last_status["t1"] == TerminalStatus.PROCESSING
            mock_bus.publish.assert_called_once_with(
                "terminal.t1.status", {"status": TerminalStatus.PROCESSING.value}
            )

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_static_fenced_and_unfenced_transcripts_remain_latched(self, mock_bus):
        """Two quoted timestamps in one frame never count as two observations."""
        transcript = [
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
            "  ⎿ Running… (1m 6s · timeout 10m)",
            "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
        ]
        frames = [
            ["● Captured terminal transcript:", *transcript, "─" * 60, "❯", "─" * 60],
            [
                "● Captured terminal transcript:",
                "```text",
                *transcript,
                "```",
                "─" * 60,
                "❯",
                "─" * 60,
            ],
        ]
        provider = ClaudeCodeProvider("t1", "session", "window")

        for frame in frames:
            mock_bus.reset_mock()
            screen = MagicMock()
            screen.display = frame
            sm = StatusMonitor()
            sm._screens["t1"] = (screen, MagicMock())
            sm._last_status["t1"] = TerminalStatus.COMPLETED

            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
            assert sm._last_status["t1"] == TerminalStatus.COMPLETED
            mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_progressively_appended_unfenced_transcript_remains_latched(self, mock_bus):
        """A later quoted timestamp is a new row, not an in-place repaint."""
        first_quote = [
            "● Captured terminal transcript:",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
            "─" * 60,
            "❯",
            "─" * 60,
        ]
        appended_quote = [
            "● Captured terminal transcript:",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
            "  ⎿ Running… (1m 6s · timeout 10m)",
            "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
            "─" * 60,
            "❯",
            "─" * 60,
        ]
        provider = ClaudeCodeProvider("t1", "session", "window")
        screen = MagicMock()
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        screen.display = first_quote
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        screen.display = appended_quote
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING

        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_bare_spinner_then_completed_fields_does_not_advance_streak(self, mock_bus):
        """Field appearance is eligibility, not a temporal value change."""
        bare_spinner = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging…",
        ]
        completed_fields = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 6s · timeout 10m)",
            "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
        ]
        provider = ClaudeCodeProvider("t1", "session", "window")
        screen = MagicMock()
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        screen.display = bare_spinner
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        screen.display = completed_fields
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING

        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_fixed_viewport_scrolling_quote_rows_remain_latched(self, mock_bus):
        """Quoted history sliding through the same bottom rows changes viewport identity."""
        stable_footers = [f"stable-footer-{index}" for index in range(6)]
        frames = [
            [
                "● Captured terminal transcript:",
                "  Bash(same-command)",
                "  ⎿ Running… (1m 5s · timeout 10m)",
                "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
                *stable_footers,
            ],
            [
                "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
                "  Bash(same-command)",
                "  ⎿ Running… (1m 6s · timeout 10m)",
                "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
                *stable_footers,
            ],
            [
                "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
                "  Bash(same-command)",
                "  ⎿ Running… (1m 7s · timeout 10m)",
                "✻ Forging… (4m 25s · ↓ 6.4k tokens)",
                *stable_footers,
            ],
        ]
        provider = ClaudeCodeProvider("t1", "session", "window")
        screen = MagicMock()
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        for frame in frames:
            screen.display = frame
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING

        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_same_row_prose_growth_is_not_dynamic_liveness(self, mock_bus):
        """Only parsed spinner/elapsed/token fields may change the fingerprint."""
        first_frame = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
        ]
        prose_growth = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens) all checks passed",
        ]
        provider = ClaudeCodeProvider("t1", "session", "window")
        screen = MagicMock()
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        screen.display = first_frame
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        screen.display = prose_growth
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING

        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_different_tool_context_on_same_row_remains_latched(self, mock_bus):
        """Two commands sharing a row and timeout are different candidates."""
        first_command = [
            "● Running the final gate now.",
            "  Bash(first-command)",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
        ]
        second_command = [
            "● Running the final gate now.",
            "  Bash(second-command)",
            "  ⎿ Running… (1m 6s · timeout 10m)",
            "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
        ]
        provider = ClaudeCodeProvider("t1", "session", "window")
        screen = MagicMock()
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        screen.display = first_command
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        screen.display = second_command
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING

        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_long_common_prefix_tool_suffixes_remain_distinct(self, mock_bus):
        """The complete nearest Bash row participates in candidate identity."""
        common_prefix = "Bash(python -m pytest " + "shared_long_command_prefix_" * 4
        assert len(common_prefix) > 80
        frames = [
            [
                "● Running the final gate now.",
                f"  {common_prefix}alpha_test.py)",
                "  ⎿ Running… (1m 5s · timeout 10m)",
                "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
            ],
            [
                "● Running the final gate now.",
                f"  {common_prefix}beta_test.py)",
                "  ⎿ Running… (1m 6s · timeout 10m)",
                "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
            ],
            [
                "● Running the final gate now.",
                f"  {common_prefix}gamma_test.py)",
                "  ⎿ Running… (1m 7s · timeout 10m)",
                "✻ Forging… (4m 25s · ↓ 6.4k tokens)",
            ],
        ]
        provider = ClaudeCodeProvider("t1", "session", "window")
        screen = MagicMock()
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        for frame in frames:
            screen.display = frame
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING

        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_status_and_temporal_sample_share_one_screen_snapshot(self, mock_bus):
        first_frame = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
        ]
        second_frame = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 6s · timeout 10m)",
            "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
        ]
        third_frame = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 7s · timeout 10m)",
            "✻ Forging… (4m 25s · ↓ 6.4k tokens)",
        ]

        class AdvancingScreen:
            def __init__(self):
                self.reads = 0

            @property
            def display(self):
                frame = (first_frame, second_frame, third_frame)[min(self.reads, 2)]
                self.reads += 1
                return frame

        screen = AdvancingScreen()
        provider = ClaudeCodeProvider("t1", "session", "window")
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        assert screen.reads == 1
        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        assert screen.reads == 2
        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        assert screen.reads == 3
        assert sm._last_status["t1"] == TerminalStatus.PROCESSING
        mock_bus.publish.assert_called_once()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_changing_processing_samples_never_reopen_protected_states(self, mock_bus):
        """Reviewer HIGH-3: prompts and errors require explicit resolution."""
        screen = MagicMock()
        provider = ClaudeCodeProvider("t1", "session", "window")

        for protected_status in (
            TerminalStatus.WAITING_USER_ANSWER,
            TerminalStatus.ERROR,
        ):
            mock_bus.reset_mock()
            sm = StatusMonitor()
            sm._screens["t1"] = (screen, MagicMock())
            sm._last_status["t1"] = protected_status

            screen.display = [
                "● Running the final gate now.",
                "  ⎿ Running… (1m 5s · timeout 10m)",
                "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
            ]
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
            screen.display = [
                "● Running the final gate now.",
                "  ⎿ Running… (1m 6s · timeout 10m)",
                "✶ Forging… (4m 24s · ↓ 6.3k tokens)",
            ]
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
            screen.display = [
                "● Running the final gate now.",
                "  ⎿ Running… (1m 7s · timeout 10m)",
                "✻ Forging… (4m 25s · ↓ 6.4k tokens)",
            ]
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
            assert sm._last_status["t1"] == protected_status
            mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_single_processing_candidate_remains_latched(self, mock_bus):
        screen = MagicMock()
        screen.display = [
            "● Running the final gate now.",
            "  ⎿ Running… (1m 5s · timeout 10m)",
            "✢ Forging… (4m 23s · ↓ 6.2k tokens)",
        ]
        provider = MagicMock()
        provider.get_status_from_screen.return_value = TerminalStatus.PROCESSING
        provider.current_turn_processing_sample.return_value = (
            "running-tool:timeout 10m:row=1",
            (
                ("running_elapsed", "1m 5s"),
                ("spinner_glyph", "✢"),
                ("spinner_elapsed", "4m 23s"),
                ("token_count", "↓6.2k"),
            ),
        )
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING
        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_dynamic_key_addition_resets_change_streak(self, mock_bus):
        screen = MagicMock()
        screen.display = ["  ⎿ Running…", "✢ Forging…"]
        provider = MagicMock()
        provider.get_status_from_screen.return_value = TerminalStatus.PROCESSING
        provider.current_turn_processing_sample.side_effect = [
            (
                "same-candidate",
                (
                    ("running_elapsed", "1m 5s"),
                    ("spinner_glyph", "✢"),
                    ("spinner_elapsed", "4m 23s"),
                ),
            ),
            (
                "same-candidate",
                (
                    ("running_elapsed", "1m 6s"),
                    ("spinner_glyph", "✶"),
                    ("spinner_elapsed", "4m 24s"),
                    ("token_count", "↓6.3k"),
                ),
            ),
            (
                "same-candidate",
                (
                    ("running_elapsed", "1m 7s"),
                    ("spinner_glyph", "✻"),
                    ("spinner_elapsed", "4m 25s"),
                    ("token_count", "↓6.4k"),
                ),
            ),
        ]
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        for _ in range(3):
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING

        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_elapsed_changes_without_spinner_cycle_remain_latched(self, mock_bus):
        provider = ClaudeCodeProvider("t1", "session", "window")
        screen = MagicMock()
        sm = StatusMonitor()
        sm._screens["t1"] = (screen, MagicMock())
        sm._last_status["t1"] = TerminalStatus.COMPLETED

        for running_elapsed, spinner_elapsed, tokens in (
            ("1m 5s", "4m 23s", "6.2k"),
            ("1m 6s", "4m 24s", "6.3k"),
            ("1m 7s", "4m 25s", "6.4k"),
        ):
            screen.display = [
                "● Running the final gate now.",
                f"  ⎿ Running… ({running_elapsed} · timeout 10m)",
                f"✢ Forging… ({spinner_elapsed} · ↓ {tokens} tokens)",
            ]
            assert sm._detect_and_apply_screen("t1", provider) == TerminalStatus.PROCESSING

        assert sm._last_status["t1"] == TerminalStatus.COMPLETED
        mock_bus.publish.assert_not_called()

    @patch("cli_agent_orchestrator.services.status_monitor.bus")
    def test_temporal_candidate_resets_on_state_generation_and_cleanup_edges(self, mock_bus):
        sample = (
            0,
            "running-tool:timeout 10m:row=1",
            ("running_elapsed", "spinner_glyph", "spinner_elapsed", "token_count"),
            ("1m 5s", "✢", "4m 23s", "↓6.2k"),
            1,
            True,
        )
        sm = StatusMonitor()

        sm._ready_processing_samples["t1"] = sample
        sm._last_status["t1"] = TerminalStatus.PROCESSING
        sm._apply_detection("t1", TerminalStatus.COMPLETED)
        assert "t1" not in sm._ready_processing_samples

        sm._ready_processing_samples["t1"] = sample
        sm._last_status["t1"] = TerminalStatus.IDLE
        sm._apply_detection("t1", TerminalStatus.WAITING_USER_ANSWER)
        assert "t1" not in sm._ready_processing_samples

        sm._ready_processing_samples["t1"] = sample
        sm.notify_input_sent("t1")
        assert "t1" not in sm._ready_processing_samples

        sm._ready_processing_samples["t1"] = sample
        sm.clear_terminal("t1")
        assert "t1" not in sm._ready_processing_samples

        sm._ready_processing_samples["t1"] = sample
        sm.reset_buffer("t1")
        assert "t1" not in sm._ready_processing_samples


class _SequencedMonitor:
    """Drive _process_chunk with a scripted sequence of detected statuses.

    Patches provider get_status to pop from the script and the event bus to
    record published status events, so each test reads as: feed detections,
    assert latched status + published transitions.
    """

    def __init__(self):
        self.sm = StatusMonitor()
        self.published = []

    def feed(self, status):
        provider = MagicMock()
        provider.get_status.return_value = status
        # These tests exercise the RAW detection path's latch logic. Pin
        # supports_screen_detection False so they are independent of the
        # CAO_PYTE_STATUS default (a bare MagicMock would be truthy and route
        # through the pyte screen path).
        provider.supports_screen_detection = False
        bus = MagicMock()
        bus.publish.side_effect = lambda topic, data: self.published.append(data["status"])
        with (
            patch("cli_agent_orchestrator.services.status_monitor.provider_manager") as mock_pm,
            patch("cli_agent_orchestrator.services.status_monitor.bus", bus),
        ):
            mock_pm.get_provider.return_value = provider
            self.sm._process_chunk("t1", "x")

    def status(self):
        return self.sm._last_status.get("t1")


class TestStickyLatching:
    """Pin the sticky ready-status latch + notify_input_sent state machine."""

    def test_idle_to_processing_blocked_without_arm(self):
        m = _SequencedMonitor()
        m.feed(TerminalStatus.IDLE)
        m.feed(TerminalStatus.PROCESSING)  # eviction flap
        assert m.status() == TerminalStatus.IDLE
        assert m.published == ["idle"]

    def test_ready_to_unknown_blocked_without_arm(self):
        m = _SequencedMonitor()
        m.feed(TerminalStatus.COMPLETED)
        m.feed(TerminalStatus.UNKNOWN)
        assert m.status() == TerminalStatus.COMPLETED

    def test_completed_to_idle_blocked_without_arm(self):
        """Codex-style: user marker evicts before assistant bullet."""
        m = _SequencedMonitor()
        m.feed(TerminalStatus.COMPLETED)
        m.feed(TerminalStatus.IDLE)
        assert m.status() == TerminalStatus.COMPLETED

    def test_idle_to_completed_always_allowed(self):
        m = _SequencedMonitor()
        m.feed(TerminalStatus.IDLE)
        m.feed(TerminalStatus.COMPLETED)
        assert m.status() == TerminalStatus.COMPLETED

    def test_arm_allows_processing_then_reblocks(self):
        """The normal cycle: input → PROCESSING accepted → COMPLETED → flap blocked."""
        m = _SequencedMonitor()
        m.feed(TerminalStatus.IDLE)
        m.sm.notify_input_sent("t1")
        assert m.sm.is_input_armed("t1") is True
        m.feed(TerminalStatus.PROCESSING)
        assert m.sm.is_input_armed("t1") is False
        assert m.status() == TerminalStatus.PROCESSING
        m.feed(TerminalStatus.COMPLETED)
        m.feed(TerminalStatus.PROCESSING)  # post-completion eviction flap
        assert m.status() == TerminalStatus.COMPLETED

    def test_arm_survives_ready_to_ready_flap(self):
        """A large paste can evict the response markers BEFORE the agent
        starts working, flapping COMPLETED → IDLE. That flap must not consume
        the arm — otherwise the genuine PROCESSING that follows is blocked,
        the terminal reads IDLE while the agent is busy, and InboxService
        (which delivers on IDLE/COMPLETED) can paste a queued message into
        the middle of an active response."""
        m = _SequencedMonitor()
        m.feed(TerminalStatus.COMPLETED)
        m.sm.notify_input_sent("t1")
        m.feed(TerminalStatus.IDLE)  # paste evicted markers — flap
        assert m.status() == TerminalStatus.IDLE
        m.feed(TerminalStatus.PROCESSING)  # genuine cycle start
        assert m.status() == TerminalStatus.PROCESSING
        m.feed(TerminalStatus.COMPLETED)
        m.feed(TerminalStatus.PROCESSING)  # post-completion flap re-blocked
        assert m.status() == TerminalStatus.COMPLETED

    def test_arm_survives_waiting_user_answer_to_idle(self):
        """Answering a permission prompt (send_special_key arms the gate)
        can flap WAITING_USER_ANSWER → IDLE before the agent resumes."""
        m = _SequencedMonitor()
        m.feed(TerminalStatus.WAITING_USER_ANSWER)
        m.sm.notify_input_sent("t1")
        m.feed(TerminalStatus.IDLE)  # prompt cleared, redraw flap
        m.feed(TerminalStatus.PROCESSING)  # agent resumes the task
        assert m.status() == TerminalStatus.PROCESSING

    def test_arm_consumed_by_init_style_upgrade(self):
        """non-ready → ready latch consumes the arm (CLI launch reaching its
        first idle prompt without a visible PROCESSING window)."""
        m = _SequencedMonitor()
        m.sm.notify_input_sent("t1")  # launch keystroke
        m.feed(TerminalStatus.IDLE)  # TUI ready
        m.feed(TerminalStatus.PROCESSING)  # redraw flap — must be blocked
        assert m.status() == TerminalStatus.IDLE

    def test_processing_consumes_arm_once(self):
        m = _SequencedMonitor()
        m.feed(TerminalStatus.IDLE)
        m.sm.notify_input_sent("t1")
        m.feed(TerminalStatus.PROCESSING)
        m.feed(TerminalStatus.IDLE)
        m.feed(TerminalStatus.PROCESSING)  # no new input — blocked
        assert m.status() == TerminalStatus.IDLE

    def test_reset_buffer_clears_arm(self):
        m = _SequencedMonitor()
        m.feed(TerminalStatus.IDLE)
        m.sm.notify_input_sent("t1")
        m.sm.reset_buffer("t1")
        m.feed(TerminalStatus.IDLE)
        m.feed(TerminalStatus.PROCESSING)  # arm gone — blocked
        assert m.status() == TerminalStatus.IDLE

    def test_clear_rolling_buffer_preserves_arm(self):
        """clear_rolling_buffer is byte-only — arm survives so the next
        IDLE→PROCESSING transition (after send_input) is honored.

        Regression guard for test_supervisor_assign_and_handoff: send_input
        must clear the rolling buffer to drop stale idle placeholders, but
        the arm must survive so the agent's PROCESSING signal isn't blocked
        by stickiness.
        """
        m = _SequencedMonitor()
        m.feed(TerminalStatus.IDLE)
        m.sm.notify_input_sent("t1")
        m.sm.clear_rolling_buffer("t1")
        # Arm and last-status preserved
        assert m.sm._allow_processing_revert.get("t1") is True
        assert m.sm._last_status.get("t1") == TerminalStatus.IDLE
        # PROCESSING transition honored (arm consumed on genuine PROCESSING)
        m.feed(TerminalStatus.PROCESSING)
        assert m.status() == TerminalStatus.PROCESSING

    def test_clear_terminal_clears_arm(self):
        m = _SequencedMonitor()
        m.feed(TerminalStatus.IDLE)
        m.sm.notify_input_sent("t1")
        m.sm.clear_terminal("t1")
        assert "t1" not in m.sm._allow_processing_revert

    def test_no_event_published_for_blocked_downgrade(self):
        """Blocked flaps must not publish status events — InboxService
        subscribes to them and a spurious ready event could double-deliver."""
        m = _SequencedMonitor()
        m.feed(TerminalStatus.COMPLETED)
        m.feed(TerminalStatus.PROCESSING)
        m.feed(TerminalStatus.UNKNOWN)
        m.feed(TerminalStatus.IDLE)
        assert m.published == ["completed"]

    def test_unknown_does_not_overwrite_known_processing(self):
        """UNKNOWN is 'no signal', not a state: a mid-turn UNKNOWN (e.g. the
        screen momentarily shows neither spinner nor prompt while a tool runs)
        must not downgrade a known PROCESSING. Observed live as a spurious
        processing→unknown→completed blip."""
        m = _SequencedMonitor()
        m.feed(TerminalStatus.IDLE)
        m.sm.notify_input_sent("t1")
        m.feed(TerminalStatus.PROCESSING)
        m.feed(TerminalStatus.UNKNOWN)
        assert m.status() == TerminalStatus.PROCESSING

    def test_armed_unknown_then_ready_rerender_keeps_processing(self):
        """Guards against a tempting-but-wrong "suppress UNKNOWN only when not
        armed" change (so an armed new turn could clear a stale ready status).

        If an armed terminal's rising-edge frame reads UNKNOWN (a torn paste
        frame) and then re-renders the PRIOR turn's COMPLETED before the new
        spinner draws, letting that UNKNOWN through would make the
        UNKNOWN->COMPLETED bounce a non-ready->ready upgrade that CONSUMES the
        revert arm. The genuine PROCESSING that follows would then be latch-
        blocked, stranding the terminal at COMPLETED for the whole busy turn —
        and InboxService (delivers on IDLE/COMPLETED) would paste into a working
        agent. Suppressing UNKNOWN unconditionally keeps the arm intact so the
        real PROCESSING wins."""
        m = _SequencedMonitor()
        m.feed(TerminalStatus.COMPLETED)
        m.sm.notify_input_sent("t1")
        m.feed(TerminalStatus.UNKNOWN)  # torn rising-edge frame after the paste
        m.feed(TerminalStatus.COMPLETED)  # prior turn re-rendered at quiescence
        m.feed(TerminalStatus.PROCESSING)  # genuine new-turn processing
        assert m.status() == TerminalStatus.PROCESSING
        assert m.published == ["completed", "processing"]

    def test_initial_unknown_is_published(self):
        """The first detection (last is None) may legitimately be UNKNOWN —
        e.g. a freshly created terminal before any marker renders."""
        m = _SequencedMonitor()
        m.feed(TerminalStatus.UNKNOWN)
        assert m.status() == TerminalStatus.UNKNOWN
        assert m.published == ["unknown"]


class TestQuiescenceTimerCancel:
    """The pyte quiescence timer is an asyncio.TimerHandle owned by the
    StatusMonitor's loop. clear_terminal/reset_buffer can run off that loop
    thread (cleanup_old_data is dispatched via asyncio.to_thread), and
    TimerHandle.cancel() is not thread-safe, so the cancel must be marshaled
    onto the owning loop, never called directly cross-thread."""

    def test_cancel_marshaled_when_off_loop_thread(self):
        sm = StatusMonitor()
        loop = MagicMock()
        sm._loop = loop
        handle = MagicMock()
        sm._quiesce_handle["t1"] = handle

        # clear_terminal from a worker thread (which has no running loop).
        t = threading.Thread(target=sm.clear_terminal, args=("t1",))
        t.start()
        t.join()

        handle.cancel.assert_not_called()
        loop.call_soon_threadsafe.assert_called_once_with(handle.cancel)

    def test_reset_buffer_cancel_marshaled_when_off_loop_thread(self):
        sm = StatusMonitor()
        loop = MagicMock()
        sm._loop = loop
        handle = MagicMock()
        sm._quiesce_handle["t1"] = handle

        t = threading.Thread(target=sm.reset_buffer, args=("t1",))
        t.start()
        t.join()

        handle.cancel.assert_not_called()
        loop.call_soon_threadsafe.assert_called_once_with(handle.cancel)

    def test_cancel_direct_when_no_loop_captured(self):
        """Offline/unit path (no loop ever scheduled a timer): a direct cancel
        is correct because there is no foreign loop to race."""
        sm = StatusMonitor()
        handle = MagicMock()
        sm._quiesce_handle["t1"] = handle
        sm.clear_terminal("t1")  # sm._loop is None
        handle.cancel.assert_called_once()

    def test_no_handle_is_a_noop(self):
        sm = StatusMonitor()
        sm._loop = MagicMock()
        # No timer scheduled for this terminal — must not blow up.
        sm.clear_terminal("missing")
        sm._loop.call_soon_threadsafe.assert_not_called()


class TestRawDebounceArmedDetection:
    """Regression: raw debounce must detect PROCESSING on later chunks while armed."""

    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_armed_ready_detects_processing_on_second_chunk(self, mock_get_backend, mock_pm):
        """When terminal is IDLE (armed), chunk 1 is UNKNOWN, chunk 2 has PROCESSING
        marker — PROCESSING must be detected immediately, not deferred to quiescence."""
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = False
        mock_pm.get_provider.return_value = provider

        sm = StatusMonitor()
        # Simulate terminal already at IDLE (armed state)
        sm._last_status["t1"] = TerminalStatus.IDLE
        sm._allow_processing_revert["t1"] = True

        # Mock _detect_status: first call returns UNKNOWN, second returns PROCESSING
        detect_results = iter([TerminalStatus.UNKNOWN, TerminalStatus.PROCESSING])
        sm._detect_status = lambda tid, buf: next(detect_results)

        # Chunk 1: UNKNOWN — should still attempt detection (terminal is ready)
        sm._process_chunk("t1", "neutral output")
        # Chunk 2: PROCESSING — must detect immediately, not wait for quiescence
        sm._process_chunk("t1", "● Working on task...")

        assert sm._last_status["t1"] == TerminalStatus.PROCESSING


class TestProcessChunkBufferTruncation:
    """_process_chunk truncates the rolling buffer to the live
    state_buffer_max server setting, not a fixed constant."""

    @patch("cli_agent_orchestrator.services.status_monitor.get_server_settings")
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_truncates_to_configured_state_buffer_max(
        self, mock_get_backend, mock_pm, mock_get_settings
    ):
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = False
        mock_pm.get_provider.return_value = provider
        mock_get_settings.return_value = {"state_buffer_max": 10}

        sm = StatusMonitor()
        sm._detect_status = lambda tid, buf: TerminalStatus.UNKNOWN

        sm._process_chunk("t1", "0123456789ABCDEF")  # 16 bytes, cap is 10

        assert sm.get_buffer("t1") == "6789ABCDEF"

    @patch("cli_agent_orchestrator.services.status_monitor.get_server_settings")
    @patch("cli_agent_orchestrator.services.status_monitor.provider_manager")
    @patch("cli_agent_orchestrator.backends.registry.get_backend")
    def test_marker_evicted_at_small_cap_survives_at_larger_cap(
        self, mock_get_backend, mock_pm, mock_get_settings
    ):
        """Same real mechanism the live rig test proved end-to-end: a marker
        near the start of a chunk is evicted once enough trailing bytes
        follow it past the configured cap, and survives when the cap is
        raised — driven here purely by the configured setting, not a
        hardcoded 8192."""
        mock_get_backend.return_value = _backend(event_inbox=False)
        provider = MagicMock()
        provider.supports_screen_detection = False
        mock_pm.get_provider.return_value = provider

        payload = "MARKER" + "x" * 20  # 26 bytes total, marker is the first 6

        mock_get_settings.return_value = {"state_buffer_max": 10}
        sm_small = StatusMonitor()
        sm_small._detect_status = lambda tid, buf: TerminalStatus.UNKNOWN
        sm_small._process_chunk("t1", payload)
        assert "MARKER" not in sm_small.get_buffer("t1")

        mock_get_settings.return_value = {"state_buffer_max": 32768}
        sm_large = StatusMonitor()
        sm_large._detect_status = lambda tid, buf: TerminalStatus.UNKNOWN
        sm_large._process_chunk("t1", payload)
        assert "MARKER" in sm_large.get_buffer("t1")
