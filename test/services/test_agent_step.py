"""Tests for the shared agent-step substrate (issue #312, unit N0).

Mocks the terminal layer (create/send/wait/extract/delete) and asserts the
canonical sequence + the reliability contract: run_agent_step returns ONLY on
success and RAISES on every failure mode (RD-2.1) — it never returns a falsy
success.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from cli_agent_orchestrator.models.kiro_engine import KiroEngine
from cli_agent_orchestrator.models.terminal import AgentStepResult, TerminalStatus
from cli_agent_orchestrator.providers.kiro_capabilities import KiroPhase0KASError
from cli_agent_orchestrator.services.agent_step import StepExecutionError, run_agent_step
from cli_agent_orchestrator.services.terminal_service import OutputMode

_MODULE = "cli_agent_orchestrator.services.agent_step"


def _fake_terminal(terminal_id="abc12345"):
    t = MagicMock()
    t.id = terminal_id
    return t


def _patch_terminal_layer(
    *,
    created_id="abc12345",
    ready=True,
    status_sequence=None,
    final_status=TerminalStatus.COMPLETED,
    output="the answer",
    get_wd_return=None,
    get_wd_side_effect=None,
):
    """Context-manager bundle patching the terminal layer for run_agent_step.

    ``ready`` is the bool the readiness ``wait_until_status`` returns (only
    consulted on the created-here path). The post-input completion wait polls
    ``status_monitor.get_status`` directly (issue #409): pass ``status_sequence``
    (a side_effect list of TerminalStatus values, one per poll) to script the
    completion loop, or rely on ``final_status`` as a constant return.
    """
    create = patch(
        f"{_MODULE}.terminal_service.create_terminal",
        new=AsyncMock(return_value=_fake_terminal(created_id)),
    )
    send = patch(f"{_MODULE}.terminal_service.send_input", return_value=True)
    delete = patch(f"{_MODULE}.terminal_service.delete_terminal", return_value=True)
    get_output = patch(f"{_MODULE}.terminal_service.get_output", return_value=output)
    exit_cli = patch(f"{_MODULE}.terminal_service.exit_terminal_cli", return_value=None)
    wait = patch(f"{_MODULE}.wait_until_status", new=AsyncMock(return_value=ready))
    if status_sequence is not None:
        status = patch(f"{_MODULE}.status_monitor.get_status", side_effect=list(status_sequence))
    else:
        status = patch(f"{_MODULE}.status_monitor.get_status", return_value=final_status)
    get_wd = patch(
        f"{_MODULE}.terminal_service.get_working_directory",
        return_value=get_wd_return,
        side_effect=get_wd_side_effect,
    )
    return create, send, delete, get_output, exit_cli, get_wd, wait, status


class TestHappyPath:
    def test_default_completion_wait_has_no_deadline(self):
        from cli_agent_orchestrator.services.agent_step import _wait_for_completion

        with (
            patch(f"{_MODULE}.time.monotonic", side_effect=AssertionError("no deadline")),
            patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.COMPLETED,
            ),
        ):
            coroutine = _wait_for_completion("abc12345", timeout=None)
            with pytest.raises(StopIteration):
                coroutine.send(None)

    def test_create_per_call_runs_full_sequence_and_tears_down(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create as m_create,
            send as m_send,
            delete as m_delete,
            get_output as m_out,
            exit_cli as m_exit,
            wait,
            status,
        ):
            result = asyncio.run(run_agent_step("kiro_cli", "developer", "do the task"))

        assert isinstance(result, AgentStepResult)
        assert result.terminal_id == "abc12345"
        assert result.last_message == "the answer"
        assert result.status == TerminalStatus.COMPLETED
        # Canonical sequence: created, prompt sent, output extracted in LAST mode.
        m_create.assert_awaited_once()
        m_send.assert_called_once_with("abc12345", "do the task")
        m_out.assert_called_once_with("abc12345", OutputMode.LAST)
        # Created-here + teardown default -> graceful exit THEN delete.
        m_exit.assert_called_once_with("abc12345")
        m_delete.assert_called_once_with("abc12345", registry=None)

    def test_workflow_envelope_drains_until_end_marker_before_teardown(self):
        """A stale COMPLETED viewport must not let teardown truncate a CAO envelope."""

        partial = "CAO_PLAN_BEGIN\n1. still streaming"
        complete = partial + "\n2. finished\nCAO_PLAN_END"
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            output=partial
        )
        with (
            create,
            send,
            delete as m_delete,
            get_output as m_out,
            exit_cli as m_exit,
            wait,
            status,
            patch(f"{_MODULE}.asyncio.sleep", new=AsyncMock()),
        ):
            m_out.side_effect = [partial, partial, complete]
            result = asyncio.run(
                run_agent_step(
                    "kiro_cli",
                    "developer",
                    ("Return only between literal lines CAO_PLAN_BEGIN and " "CAO_PLAN_END."),
                    env_vars={
                        "CAO_WORKFLOW_RUN_ID": "run-1",
                        "CAO_WORKFLOW_STEP_ID": "plan-1",
                    },
                )
            )

        assert result.last_message == complete
        assert m_out.call_count == 3
        m_exit.assert_called_once_with("abc12345")
        m_delete.assert_called_once_with("abc12345", registry=None)

    def test_teardown_false_skips_delete(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with create, send, delete as m_delete, get_output, exit_cli as m_exit, wait, status:
            asyncio.run(run_agent_step("kiro_cli", "dev", "x", teardown=False))
        m_delete.assert_not_called()
        m_exit.assert_not_called()

    def test_reuse_terminal_skips_create_and_delete(self):
        # Reuse: no readiness wait, no create/delete; completion polls COMPLETED.
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create as m_create,
            send as m_send,
            delete as m_delete,
            get_output,
            exit_cli as m_exit,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={"id": "reuse99", "provider": "kiro_cli", "engine": "v2"},
            ),
        ):
            result = asyncio.run(
                run_agent_step("kiro_cli", "dev", "x", reuse_terminal_id="reuse99")
            )
        assert result.terminal_id == "reuse99"
        m_create.assert_not_awaited()
        m_delete.assert_not_called()
        # A reused terminal is owned by the caller — no graceful exit either.
        m_exit.assert_not_called()
        m_send.assert_called_once_with("reuse99", "x")

    @pytest.mark.parametrize("engine", [KiroEngine.V2, "v2"])
    def test_reuse_matching_explicit_v2(self, engine):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create as m_create,
            send as m_send,
            delete,
            get_output,
            exit_cli,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={"id": "reuse99", "provider": "kiro_cli", "engine": "v2"},
            ),
        ):
            result = asyncio.run(
                run_agent_step(
                    "kiro_cli",
                    "dev",
                    "x",
                    reuse_terminal_id="reuse99",
                    engine=engine,
                )
            )

        assert result.terminal_id == "reuse99"
        m_create.assert_not_awaited()
        m_send.assert_called_once_with("reuse99", "x")

    def test_reuse_conflicting_kas_uses_phase0_guard_before_send(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create as m_create,
            send as m_send,
            delete,
            get_output,
            exit_cli,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={"id": "reuse99", "provider": "kiro_cli", "engine": "v2"},
            ),
            pytest.raises(KiroPhase0KASError, match="Phase 0"),
        ):
            asyncio.run(
                run_agent_step(
                    "kiro_cli",
                    "dev",
                    "x",
                    reuse_terminal_id="reuse99",
                    engine=KiroEngine.KAS,
                )
            )

        m_create.assert_not_awaited()
        m_send.assert_not_called()

    def test_reuse_rejects_engine_for_non_kiro_terminal_before_send(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create,
            send as m_send,
            delete,
            get_output,
            exit_cli,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={"id": "reuse99", "provider": "codex", "engine": None},
            ),
            pytest.raises(ValueError, match="only valid for provider 'kiro_cli'"),
        ):
            asyncio.run(
                run_agent_step(
                    "codex",
                    "dev",
                    "x",
                    reuse_terminal_id="reuse99",
                    engine=KiroEngine.V2,
                )
            )

        m_send.assert_not_called()

    def test_reuse_rejects_provider_mismatch_before_send(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create,
            send as m_send,
            delete,
            get_output,
            exit_cli,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={"id": "reuse99", "provider": "codex", "engine": None},
            ),
            pytest.raises(ValueError, match="Provider mismatch"),
        ):
            asyncio.run(run_agent_step("kiro_cli", "dev", "x", reuse_terminal_id="reuse99"))

        m_send.assert_not_called()

    def test_working_directory_forwarded_to_create(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with create as m_create, send, delete, get_output, exit_cli, wait, status:
            asyncio.run(run_agent_step("kiro_cli", "dev", "x", working_directory="/tmp/wd"))
        assert m_create.await_args.kwargs["working_directory"] == "/tmp/wd"

    def test_model_forwarded_to_create(self):
        """handoff's own `model` parameter reaches terminal_service.create_terminal
        for a freshly created terminal."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with create as m_create, send, delete, get_output, exit_cli, wait, status:
            asyncio.run(run_agent_step("kiro_cli", "dev", "x", model="fable-5"))
        assert m_create.await_args.kwargs["model"] == "fable-5"

    def test_omitted_model_forwards_none_to_create(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with create as m_create, send, delete, get_output, exit_cli, wait, status:
            asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        assert m_create.await_args.kwargs["model"] is None

    def test_reused_terminal_matching_model_skips_create(self):
        """Reuse accepts an explicit model only when it matches launch evidence."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create as m_create,
            send,
            delete,
            get_output,
            exit_cli,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={
                    "id": "reuse99",
                    "provider": "kiro_cli",
                    "engine": "v2",
                    "metadata": {"launch_model": "fable-5"},
                },
            ),
        ):
            asyncio.run(
                run_agent_step("kiro_cli", "dev", "x", reuse_terminal_id="reuse99", model="fable-5")
            )
        m_create.assert_not_awaited()

    def test_reused_terminal_rejects_model_mismatch(self):
        from cli_agent_orchestrator.services.agent_step import _validate_reused_terminal

        with patch(
            f"{_MODULE}.terminal_service.get_terminal_metadata",
            return_value={
                "provider": "codex",
                "metadata": {"launch_model": "gpt-5.6-sol"},
            },
        ):
            with pytest.raises(ValueError, match="Model mismatch"):
                asyncio.run(
                    _validate_reused_terminal(
                        "reuse99",
                        "codex",
                        None,
                        "gpt-5.5",
                        None,
                    )
                )

    def test_reused_terminal_rejects_reasoning_effort_mismatch(self):
        from cli_agent_orchestrator.services.agent_step import _validate_reused_terminal

        with patch(
            f"{_MODULE}.terminal_service.get_terminal_metadata",
            return_value={
                "provider": "codex",
                "metadata": {
                    "launch_model": "gpt-5.6-sol",
                    "launch_reasoning_effort": "high",
                },
            },
        ):
            with pytest.raises(ValueError, match="Reasoning effort mismatch"):
                asyncio.run(
                    _validate_reused_terminal(
                        "reuse99",
                        "codex",
                        None,
                        "gpt-5.6-sol",
                        "xhigh",
                    )
                )

    def test_reused_terminal_rejects_agent_profile_mismatch(self):
        from cli_agent_orchestrator.services.agent_step import _validate_reused_terminal

        with patch(
            f"{_MODULE}.terminal_service.get_terminal_metadata",
            return_value={
                "provider": "codex",
                "agent_profile": "research_reviewer",
                "metadata": {},
            },
        ):
            with pytest.raises(ValueError, match="Agent profile mismatch"):
                asyncio.run(
                    _validate_reused_terminal(
                        "reuse99",
                        "codex",
                        None,
                        None,
                        None,
                        requested_agent="implementer",
                    )
                )

    def test_reused_terminal_rejects_busy_status_before_send(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.PROCESSING
        )
        with (
            create,
            send as m_send,
            delete,
            get_output,
            exit_cli,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={
                    "id": "reuse99",
                    "provider": "kiro_cli",
                    "agent_profile": "dev",
                    "engine": "v2",
                },
            ),
        ):
            with pytest.raises(ValueError, match="is not ready"):
                asyncio.run(run_agent_step("kiro_cli", "dev", "x", reuse_terminal_id="reuse99"))
        m_send.assert_not_called()

    def test_reused_terminal_rejects_concurrent_claim(self):
        from cli_agent_orchestrator.services.agent_step import _REUSED_TERMINAL_LOCKS

        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()

        async def scenario():
            lock = asyncio.Lock()
            await lock.acquire()
            _REUSED_TERMINAL_LOCKS["reuse99"] = lock
            try:
                with pytest.raises(ValueError, match="already claimed"):
                    await run_agent_step("kiro_cli", "dev", "x", reuse_terminal_id="reuse99")
            finally:
                lock.release()
                _REUSED_TERMINAL_LOCKS.pop("reuse99", None)

        with create, send as m_send, delete, get_output, exit_cli, wait, status:
            asyncio.run(scenario())
        m_send.assert_not_called()

    def test_no_session_name_creates_new_session(self):
        """Regression: session_name=None must create a NEW tmux session
        (new_session=True). Otherwise create_terminal auto-generates a name and
        then fails with 'Session not found' because it tries to add a window to
        a session that does not exist yet."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with create as m_create, send, delete, get_output, exit_cli, wait, status:
            asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        assert m_create.await_args.kwargs["new_session"] is True
        assert m_create.await_args.kwargs["session_name"] is None

    def test_session_name_adds_to_existing_session(self):
        """A supplied session_name adds a window to that EXISTING session
        (new_session=False) — the handoff same-session path."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with create as m_create, send, delete, get_output, exit_cli, wait, status:
            asyncio.run(run_agent_step("kiro_cli", "dev", "x", session_name="cao-sup"))
        assert m_create.await_args.kwargs["new_session"] is False
        assert m_create.await_args.kwargs["session_name"] == "cao-sup"

    def test_caller_id_and_allowed_tools_forwarded_to_create(self):
        """caller_id (#284 callback routing) and inherited allowed_tools must
        reach create_terminal for handoff workers."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with create as m_create, send, delete, get_output, exit_cli, get_wd, wait, status:
            asyncio.run(
                run_agent_step(
                    "kiro_cli",
                    "dev",
                    "x",
                    session_name="cao-sup",
                    caller_id="sup-123",
                    allowed_tools=["fs_read", "fs_write"],
                )
            )
        assert m_create.await_args.kwargs["caller_id"] == "sup-123"
        assert m_create.await_args.kwargs["allowed_tools"] == ["fs_read", "fs_write"]

    def test_registry_threaded_to_delete_on_teardown(self):
        """The plugin registry passed to run_agent_step must reach delete_terminal
        so post_kill_terminal hooks dispatch (parity with the DELETE endpoint)."""
        from cli_agent_orchestrator.plugins import PluginRegistry

        sentinel = PluginRegistry()
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with create, send, delete as m_delete, get_output, exit_cli, wait, status:
            asyncio.run(run_agent_step("kiro_cli", "dev", "x", registry=sentinel))
        m_delete.assert_called_once_with("abc12345", registry=sentinel)

    def test_explicit_wd_wins_over_caller_inheritance(self):
        """An explicit working_directory takes precedence even when caller_id
        is present — the inheritance path must not overwrite it."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create as m_create,
            send,
            delete,
            get_output,
            exit_cli,
            get_wd as m_get_wd,
            wait,
            status,
        ):
            asyncio.run(
                run_agent_step(
                    "kiro_cli",
                    "dev",
                    "x",
                    working_directory="/explicit/wd",
                    caller_id="sup-123",
                )
            )
        assert m_create.await_args.kwargs["working_directory"] == "/explicit/wd"
        m_get_wd.assert_not_called()

    def test_no_caller_id_skips_wd_inheritance(self):
        """Without caller_id the inheritance path is skipped entirely — no
        get_working_directory call, no mutation of working_directory."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        with (
            create as m_create,
            send,
            delete,
            get_output,
            exit_cli,
            get_wd as m_get_wd,
            wait,
            status,
        ):
            asyncio.run(run_agent_step("kiro_cli", "dev", "x", working_directory=None))
        assert m_create.await_args.kwargs["working_directory"] is None
        m_get_wd.assert_not_called()

    def test_wd_inherited_from_caller(self):
        """When working_directory is None and caller_id is set, run_agent_step
        resolves CWD from the caller's terminal and forwards it to create_terminal."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            get_wd_return="/projects/my-app"
        )
        with (
            create as m_create,
            send,
            delete,
            get_output,
            exit_cli,
            get_wd,
            wait,
            status,
        ):
            asyncio.run(
                run_agent_step(
                    "kiro_cli",
                    "dev",
                    "x",
                    working_directory=None,
                    caller_id="sup-123",
                )
            )
        assert m_create.await_args.kwargs["working_directory"] == "/projects/my-app"

    def test_wd_inheritance_failure_falls_back(self):
        """A failure resolving the caller CWD is best-effort — the step must
        still succeed with working_directory=None (server default)."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            get_wd_side_effect=ValueError("pane not found")
        )
        with (
            create as m_create,
            send,
            delete,
            get_output,
            exit_cli,
            get_wd,
            wait,
            status,
        ):
            result = asyncio.run(
                run_agent_step(
                    "kiro_cli",
                    "dev",
                    "x",
                    working_directory=None,
                    caller_id="sup-123",
                )
            )
        assert m_create.await_args.kwargs["working_directory"] is None
        assert result.status == TerminalStatus.COMPLETED


class TestFailureRaises:
    def test_completion_timeout_raises(self):
        """A terminal that never settles (stays PROCESSING) must RAISE a timeout,
        never return a falsy success (the key reliability contract, RD-2.1)."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.PROCESSING,  # never reaches a done signal
        )
        with create, send, delete, get_output, exit_cli, wait, status:
            with pytest.raises(StepExecutionError, match="did not complete") as exc_info:
                # timeout=0 so the poll loop hits its deadline on the first pass.
                asyncio.run(run_agent_step("kiro_cli", "dev", "x", timeout=0))
        # Timeout (ran long), with the live terminal carried structurally.
        assert exc_info.value.kind == "timeout"
        assert exc_info.value.terminal_id == "abc12345"

    def test_readiness_timeout_raises(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            ready=False,  # readiness times out before any input
        )
        with create, send as m_send, delete, get_output, exit_cli, wait, status:
            with pytest.raises(StepExecutionError, match="ready status") as exc_info:
                asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        # Fail-fast: no prompt sent if the terminal never became ready.
        m_send.assert_not_called()
        assert exc_info.value.kind == "timeout"
        assert exc_info.value.terminal_id == "abc12345"

    def test_error_end_state_raises_with_error_kind(self):
        """A terminal at ERROR during the completion poll -> kind='error' (worker
        CRASHED), distinct from a plain timeout, with terminal_id."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.ERROR,
        )
        with create, send, delete, get_output, exit_cli, wait, status:
            with pytest.raises(StepExecutionError, match="ERROR status") as exc_info:
                asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        assert exc_info.value.kind == "error"
        assert exc_info.value.terminal_id == "abc12345"

    def test_quota_latch_raises_with_quota_kind(self):
        """A provider-authenticated quota latch survives the ERROR status seam."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.ERROR
        )
        provider = MagicMock()
        provider.step_error_kind = "quota"
        with (
            create,
            send,
            delete,
            get_output,
            exit_cli,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.provider_manager.get_provider",
                return_value=provider,
            ),
        ):
            with pytest.raises(StepExecutionError, match="ERROR status") as exc_info:
                asyncio.run(run_agent_step("claude_code", "dev", "x"))

        assert exc_info.value.kind == "quota"
        assert exc_info.value.terminal_id == "abc12345"

    def test_error_mid_poll_stops_before_output(self):
        """An ERROR observed during the completion poll must raise (kind='error')
        and must NOT extract output — a crashed step is never a success."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.ERROR,
        )
        with create, send, delete, get_output as m_out, exit_cli, wait, status:
            with pytest.raises(StepExecutionError, match="ERROR status") as exc_info:
                asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        # No output extraction once ERROR is detected.
        m_out.assert_not_called()
        assert exc_info.value.kind == "error"

    def test_create_failure_propagates(self):
        """A terminal-create failure is surfaced (ValueError), never swallowed."""
        create = patch(
            f"{_MODULE}.terminal_service.create_terminal",
            new=AsyncMock(side_effect=ValueError("session not found")),
        )
        with create:
            with pytest.raises(ValueError, match="session not found"):
                asyncio.run(run_agent_step("kiro_cli", "dev", "x"))


class TestTeardownIsBestEffort:
    def test_teardown_failure_does_not_fail_successful_step(self):
        """A delete failure after a successful step is logged, not raised — the
        work is done and captured."""
        create, send, _delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()
        delete = patch(
            f"{_MODULE}.terminal_service.delete_terminal",
            side_effect=Exception("kill failed"),
        )
        with create, send, delete, get_output, exit_cli, wait, status:
            result = asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        assert result.status == TerminalStatus.COMPLETED
        assert result.last_message == "the answer"

    def test_graceful_exit_failure_does_not_fail_step_and_still_deletes(self):
        """A failure sending the graceful exit must be logged, not raised, and
        must NOT prevent the subsequent delete (best-effort exit-then-delete)."""
        create, send, delete, get_output, _exit, get_wd, wait, status = _patch_terminal_layer()
        exit_cli = patch(
            f"{_MODULE}.terminal_service.exit_terminal_cli",
            side_effect=Exception("exit boom"),
        )
        with create, send, delete as m_delete, get_output, exit_cli, wait, status:
            result = asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        assert result.status == TerminalStatus.COMPLETED
        # Exit failed but delete still ran.
        m_delete.assert_called_once_with("abc12345", registry=None)

    def test_on_terminal_created_callback_failure_does_not_fail_step(self):
        """F9(b): a raising ``on_terminal_created`` callback (BR-31 sweep
        bookkeeping) must never propagate into ``run_agent_step`` — it is
        best-effort, logged and swallowed, and the step still completes."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer()

        def _boom_callback(terminal_id):
            raise RuntimeError("sweep bookkeeping boom")

        with create, send, delete, get_output, exit_cli, wait, status:
            result = asyncio.run(
                run_agent_step("kiro_cli", "dev", "x", on_terminal_created=_boom_callback)
            )
        assert result.status == TerminalStatus.COMPLETED
        assert result.last_message == "the answer"


class TestIdleCompletionSignal:
    """#409a: a post-input IDLE (after the agent worked) resolves as done, so a
    provider that settles IDLE instead of emitting COMPLETED no longer hangs."""

    def test_idle_after_working_resolves_as_completed(self):
        """codex-style: PROCESSING (working) then stable IDLE -> COMPLETED,
        not a hang. The step must extract output and succeed."""
        # readiness IDLE is NOT part of this sequence — the readiness wait is the
        # patched wait_until_status(True); get_status is only the completion poll.
        seq = [
            TerminalStatus.PROCESSING,  # observed working
            TerminalStatus.IDLE,  # 1st idle
            TerminalStatus.IDLE,  # 2nd idle
            TerminalStatus.IDLE,  # 3rd idle -> stable -> done
        ]
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            status_sequence=seq,
        )
        with create, send, delete, get_output as m_out, exit_cli, wait, status:
            result = asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        assert result.status == TerminalStatus.COMPLETED
        assert result.last_message == "the answer"
        m_out.assert_called_once_with("abc12345", OutputMode.LAST)

    def test_completed_marker_still_resolves_immediately(self):
        """A COMPLETED marker resolves on the first poll (no observed-working
        gate needed) — the original completion signal is preserved."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.COMPLETED,
        )
        with create, send, delete, get_output, exit_cli, wait, status:
            result = asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        assert result.status == TerminalStatus.COMPLETED

    def test_interim_processing_then_completed_waits_for_real_completion(self):
        """A still-streaming step must resolve only on the settled completion.

        StatusMonitor now holds PROCESSING while a screen provider is still
        bursting (see status_monitor's burst-gate), so a mid-stream interim frame
        surfaces to the completion wait as PROCESSING, not COMPLETED. The step
        must poll through those interim reads and extract output only once the
        real COMPLETED arrives — not truncate the answer on an early poll.
        """
        seq = [
            TerminalStatus.PROCESSING,  # observed working
            TerminalStatus.PROCESSING,  # interim frame held as PROCESSING (bursting)
            TerminalStatus.PROCESSING,  # still streaming
            TerminalStatus.COMPLETED,  # settled -> done
        ]
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            status_sequence=seq,
        )
        with (
            create,
            send,
            delete,
            get_output as m_out,
            exit_cli,
            wait,
            status as m_status,
            patch(f"{_MODULE}.asyncio.sleep", new=AsyncMock()),
        ):
            result = asyncio.run(run_agent_step("codex", "dev", "x"))
        assert result.status == TerminalStatus.COMPLETED
        assert result.last_message == "the answer"
        assert m_status.call_count == 4
        m_out.assert_called_once_with("abc12345", OutputMode.LAST)

    def test_stale_completed_marker_waits_for_new_turn(self):
        """An armed previous-turn COMPLETED cannot finish newly-sent work."""
        from cli_agent_orchestrator.services.agent_step import _wait_for_completion

        with (
            patch(
                f"{_MODULE}.status_monitor.get_status",
                side_effect=[
                    TerminalStatus.COMPLETED,
                    TerminalStatus.PROCESSING,
                    TerminalStatus.COMPLETED,
                ],
            ) as get_status,
            patch(
                f"{_MODULE}.status_monitor.is_input_armed",
                side_effect=[True, False],
            ) as is_armed,
            patch(f"{_MODULE}.asyncio.sleep", new=AsyncMock()),
        ):
            asyncio.run(_wait_for_completion("reuse99", timeout=None))

        assert get_status.call_count == 3
        assert is_armed.call_count == 2

    def test_idle_before_any_work_does_not_resolve_early(self):
        """A bare IDLE with NO prior working state is the pre-pickup window, not
        done: it must NOT resolve. Here IDLE persists but the agent was never
        observed working, so the wait times out rather than returning empty."""
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.IDLE,  # idle forever, never worked
        )
        with create, send, delete, get_output, exit_cli, wait, status:
            with pytest.raises(StepExecutionError, match="did not complete") as exc_info:
                asyncio.run(run_agent_step("kiro_cli", "dev", "x", timeout=0))
        assert exc_info.value.kind == "timeout"

    def test_error_still_raises_even_after_working(self):
        """ERROR during the poll still raises kind='error' (not masked by the new
        IDLE path) even once the agent had been observed working."""
        seq = [TerminalStatus.PROCESSING, TerminalStatus.ERROR]
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            status_sequence=seq,
        )
        with create, send, delete, get_output, exit_cli, wait, status:
            with pytest.raises(StepExecutionError, match="ERROR status") as exc_info:
                asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        assert exc_info.value.kind == "error"


class TestInterruptibleCancel:
    """#409b: an in-flight completion wait is interruptible via cancel_event, so a
    hung step (never settling) becomes cancellable rather than boundary-only."""

    def test_wait_interrupted_when_event_already_set(self):
        """_wait_for_completion raises StepCancelledError promptly if the event is
        already set — the interrupt is checked at the top of the poll loop."""
        from cli_agent_orchestrator.services.agent_step import (
            StepCancelledError,
            _wait_for_completion,
        )

        async def _run():
            ev = asyncio.Event()
            ev.set()
            with patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.PROCESSING,
            ):
                await _wait_for_completion("term-hung", timeout=600, cancel_event=ev)

        with pytest.raises(StepCancelledError) as exc_info:
            asyncio.run(_run())
        assert exc_info.value.terminal_id == "term-hung"

    def test_wait_interrupted_mid_poll_by_event(self):
        """A hung terminal (always PROCESSING) whose cancel_event is set after the
        wait starts is interrupted promptly, not left to run out the timeout."""
        from cli_agent_orchestrator.services.agent_step import (
            StepCancelledError,
            _wait_for_completion,
        )

        async def _run():
            ev = asyncio.Event()

            async def _cancel_soon():
                # Fire the event while the wait is parked on its poll interval.
                await asyncio.sleep(0.05)
                ev.set()

            with patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.PROCESSING,  # never settles
            ):
                waiter = asyncio.ensure_future(
                    _wait_for_completion("term-hung", timeout=600, cancel_event=ev)
                )
                await _cancel_soon()
                await waiter

        with pytest.raises(StepCancelledError):
            asyncio.run(_run())

    def test_run_agent_step_cancel_tears_down_created_terminal(self):
        """When the wait is cancelled, run_agent_step raises StepCancelledError and
        tears down the terminal it created (exit-then-delete), never masking it."""
        from cli_agent_orchestrator.services.agent_step import StepCancelledError

        cancel_event = asyncio.Event()
        cancel_event.set()  # cancel before the completion poll even begins
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.PROCESSING,
        )
        with (
            create,
            send,
            delete as m_delete,
            get_output as m_out,
            exit_cli as m_exit,
            wait,
            status,
        ):
            with pytest.raises(StepCancelledError) as exc_info:
                asyncio.run(
                    run_agent_step("kiro_cli", "dev", "x", cancel_event=cancel_event, timeout=600)
                )
        assert exc_info.value.terminal_id == "abc12345"
        # Cancelled step is not a success: no output extraction.
        m_out.assert_not_called()
        # A terminal this call created is reclaimed exactly like the success path.
        m_exit.assert_called_once_with("abc12345")
        m_delete.assert_called_once_with("abc12345", registry=None)

    def test_reused_terminal_not_torn_down_on_cancel(self):
        """A cancelled step must NOT delete a terminal it did not create — the
        caller owns a reused terminal's lifecycle."""
        from cli_agent_orchestrator.services.agent_step import StepCancelledError

        cancel_event = asyncio.Event()
        cancel_event.set()
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.PROCESSING,
        )
        with (
            create,
            send,
            delete as m_delete,
            get_output,
            exit_cli as m_exit,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={"id": "reuse99", "provider": "kiro_cli", "engine": "v2"},
            ),
        ):
            with pytest.raises(StepCancelledError):
                asyncio.run(
                    run_agent_step(
                        "kiro_cli",
                        "dev",
                        "x",
                        reuse_terminal_id="reuse99",
                        cancel_event=cancel_event,
                        timeout=600,
                    )
                )
        m_delete.assert_not_called()
        m_exit.assert_not_called()


class TestOutputExtractionTeardown:
    def test_extraction_failure_tears_down_created_terminal(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.COMPLETED,
        )
        with (
            create,
            send,
            delete as m_delete,
            patch(
                f"{_MODULE}.terminal_service.get_output",
                side_effect=ValueError("No completion marker found after last user message"),
            ) as m_out,
            exit_cli as m_exit,
            wait,
            status,
        ):
            with pytest.raises(ValueError, match="No completion marker found"):
                asyncio.run(run_agent_step("kiro_cli", "dev", "x"))
        m_out.assert_called_once_with("abc12345", OutputMode.LAST)
        # A terminal this call created is reclaimed exactly like the success path.
        m_exit.assert_called_once_with("abc12345")
        m_delete.assert_called_once_with("abc12345", registry=None)

    def test_extraction_failure_does_not_tear_down_reused_terminal(self):
        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.COMPLETED,
        )
        with (
            create,
            send,
            delete as m_delete,
            patch(
                f"{_MODULE}.terminal_service.get_output",
                side_effect=ValueError("No completion marker found after last user message"),
            ) as m_out,
            exit_cli as m_exit,
            wait,
            status,
            patch(
                f"{_MODULE}.terminal_service.get_terminal_metadata",
                return_value={"id": "reuse99", "provider": "kiro_cli", "engine": "v2"},
            ),
        ):
            with pytest.raises(ValueError, match="No completion marker found"):
                asyncio.run(run_agent_step("kiro_cli", "dev", "x", reuse_terminal_id="reuse99"))
        m_out.assert_called_once_with("reuse99", OutputMode.LAST)
        m_delete.assert_not_called()
        m_exit.assert_not_called()


class TestWorkflowStructuredReturnSettles:
    """A workflow-owned step settles from its own fresh structured ``workflow_return``
    even while the provider viewport is still PROCESSING (the retained root cause of
    the stuck run), while a stale/replayed pre-existing record cannot complete a new
    attempt and cancellation/terminal-error stay fail-closed and win the race.
    """

    @staticmethod
    def _record(run_id="r1", step_id="s1", *, validated=True):
        from cli_agent_orchestrator.models.workflow import StepOutputRecord, StepState

        return StepOutputRecord(
            run_id=run_id,
            step_id=step_id,
            output={"answer": 42},
            validated=validated,
            errors=[] if validated else ["output failed schema validation"],
            state=StepState.COMPLETED if validated else StepState.COMPLETED_UNVALIDATED,
        )

    def _fresh_store(self, seed=None):
        from cli_agent_orchestrator.services.step_output_store import StepOutputStore

        store = StepOutputStore()
        if seed is not None:
            store.put(seed.run_id, seed.step_id, seed)
        return store

    def test_processing_plus_fresh_validated_return_settles(self):
        """PROCESSING viewport + a freshly posted validated record -> wait returns
        (no COMPLETED marker, no IDLE, no timeout needed)."""
        from cli_agent_orchestrator.services.agent_step import _wait_for_completion

        rec = self._record(validated=True)
        store = self._fresh_store(seed=rec)  # posted by this attempt's worker
        with (
            patch(f"{_MODULE}.step_output_store", store),
            patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.PROCESSING,  # never flips
            ),
        ):
            # settle_baseline=None: the record is FRESH relative to send time.
            asyncio.run(
                _wait_for_completion(
                    "term-wf",
                    timeout=None,
                    settle_run_id="r1",
                    settle_step_id="s1",
                    settle_baseline=None,
                )
            )  # returns without raising -> settled

    def test_processing_plus_fresh_invalid_return_settles(self):
        """A schema-INVALID structured return also ends the wait (downstream maps it
        to COMPLETED_UNVALIDATED); it must not hang waiting for a viewport signal."""
        from cli_agent_orchestrator.services.agent_step import _wait_for_completion

        rec = self._record(validated=False)
        store = self._fresh_store(seed=rec)
        with (
            patch(f"{_MODULE}.step_output_store", store),
            patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.PROCESSING,
            ),
        ):
            asyncio.run(
                _wait_for_completion(
                    "term-wf",
                    timeout=None,
                    settle_run_id="r1",
                    settle_step_id="s1",
                    settle_baseline=None,
                )
            )  # invalid record still settles the wait

    def test_no_return_retains_ordinary_status_waiting(self):
        """With no structured return posted, a PROCESSING terminal still times out
        on the ordinary status loop — the settlement path adds no early return."""
        from cli_agent_orchestrator.services.agent_step import (
            StepExecutionError,
            _wait_for_completion,
        )

        store = self._fresh_store()  # empty
        with (
            patch(f"{_MODULE}.step_output_store", store),
            patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.PROCESSING,
            ),
        ):
            with pytest.raises(StepExecutionError, match="did not complete") as exc:
                asyncio.run(
                    _wait_for_completion(
                        "term-wf",
                        timeout=0,  # deadline on the first pass
                        settle_run_id="r1",
                        settle_step_id="s1",
                        settle_baseline=None,
                    )
                )
        assert exc.value.kind == "timeout"

    def test_stale_pre_existing_return_does_not_settle(self):
        """A record already present at send time (the baseline) is NOT fresh: it
        must not complete the new attempt before that attempt's worker posts."""
        from cli_agent_orchestrator.services.agent_step import (
            StepExecutionError,
            _wait_for_completion,
        )

        stale = self._record(validated=True)
        store = self._fresh_store(seed=stale)  # pre-existing from a prior attempt
        with (
            patch(f"{_MODULE}.step_output_store", store),
            patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.PROCESSING,
            ),
        ):
            with pytest.raises(StepExecutionError, match="did not complete") as exc:
                asyncio.run(
                    _wait_for_completion(
                        "term-wf",
                        timeout=0,
                        settle_run_id="r1",
                        settle_step_id="s1",
                        settle_baseline=stale,  # baseline IS the stale record
                    )
                )
        assert exc.value.kind == "timeout"

    def test_cancellation_wins_race_against_fresh_return(self):
        """A set cancel_event is checked at the loop top, before the store: an
        in-flight cancel wins even when a fresh return is already posted."""
        from cli_agent_orchestrator.services.agent_step import (
            StepCancelledError,
            _wait_for_completion,
        )

        rec = self._record(validated=True)
        store = self._fresh_store(seed=rec)

        async def _run():
            ev = asyncio.Event()
            ev.set()
            with (
                patch(f"{_MODULE}.step_output_store", store),
                patch(
                    f"{_MODULE}.status_monitor.get_status",
                    return_value=TerminalStatus.PROCESSING,
                ),
            ):
                await _wait_for_completion(
                    "term-wf",
                    timeout=None,
                    cancel_event=ev,
                    settle_run_id="r1",
                    settle_step_id="s1",
                    settle_baseline=None,
                )

        with pytest.raises(StepCancelledError) as exc:
            asyncio.run(_run())
        assert exc.value.terminal_id == "term-wf"

    def test_terminal_error_wins_race_against_fresh_return(self):
        """An ERROR viewport is checked before the store: a crashed worker stays
        fail-closed (kind='error') even when a fresh return is present."""
        from cli_agent_orchestrator.services.agent_step import (
            StepExecutionError,
            _wait_for_completion,
        )

        rec = self._record(validated=True)
        store = self._fresh_store(seed=rec)
        with (
            patch(f"{_MODULE}.step_output_store", store),
            patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.ERROR,
            ),
        ):
            with pytest.raises(StepExecutionError, match="ERROR status") as exc:
                asyncio.run(
                    _wait_for_completion(
                        "term-wf",
                        timeout=None,
                        settle_run_id="r1",
                        settle_step_id="s1",
                        settle_baseline=None,
                    )
                )
        assert exc.value.kind == "error"

    def test_ordinary_non_workflow_step_never_consults_store(self):
        """A step with no workflow identity pair (settle_step_id=None) must not read
        the store at all — its completion stays purely status-based."""
        from cli_agent_orchestrator.services.agent_step import (
            StepExecutionError,
            _wait_for_completion,
        )

        store = MagicMock()  # any store access would be a regression
        with (
            patch(f"{_MODULE}.step_output_store", store),
            patch(
                f"{_MODULE}.status_monitor.get_status",
                return_value=TerminalStatus.PROCESSING,
            ),
        ):
            with pytest.raises(StepExecutionError, match="did not complete"):
                asyncio.run(_wait_for_completion("term-plain", timeout=0))
        store.get.assert_not_called()

    def test_run_agent_step_threads_workflow_env_to_settlement(self):
        """End-to-end wiring: env_vars carrying both identity keys let run_agent_step
        settle from a return posted after send, while the viewport stays PROCESSING."""
        rec = self._record(validated=True)
        store = self._fresh_store()  # empty at send time -> baseline is None

        def _send(_terminal_id, _prompt):
            # The worker posts its structured return during the step (after send).
            store.put(rec.run_id, rec.step_id, rec)
            return True

        create, send, delete, get_output, exit_cli, get_wd, wait, status = _patch_terminal_layer(
            final_status=TerminalStatus.PROCESSING,  # viewport never flips
        )
        with (
            create,
            send,  # replaced below by the posting side_effect
            delete,
            get_output as m_out,
            exit_cli,
            wait,
            status,
            patch(f"{_MODULE}.step_output_store", store),
            patch(f"{_MODULE}.terminal_service.send_input", side_effect=_send),
        ):
            result = asyncio.run(
                run_agent_step(
                    "kiro_cli",
                    "dev",
                    "do the task",
                    env_vars={
                        "CAO_WORKFLOW_RUN_ID": "r1",
                        "CAO_WORKFLOW_STEP_ID": "s1",
                    },
                )
            )
        assert result.status == TerminalStatus.COMPLETED
        assert result.last_message == "the answer"
        m_out.assert_called_once_with("abc12345", OutputMode.LAST)
