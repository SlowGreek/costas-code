from __future__ import annotations

from dataclasses import fields

import pytest

from agent.runtime_sessions import (
    RuntimeSessionClosedError,
    RuntimeSessionHost,
    RuntimeTurnResult,
)
from agent.transports.codex_app_server_session import (
    CodexRuntimeSessionHost,
    TurnResult,
)


class FakeCodexSession:
    def __init__(self) -> None:
        self.run_calls: list[object] = []
        self.steer_calls: list[str] = []
        self.interrupt_calls = 0
        self.compact_calls = 0
        self.close_calls = 0

    def run_turn(self, *, user_input):
        self.run_calls.append(user_input)
        return TurnResult(
            final_text="done",
            projected_messages=[{"role": "assistant", "content": "done"}],
            tool_iterations=2,
            turn_id="private-turn",
            thread_id="private-thread",
            token_usage_last={"totalTokens": 3},
        )

    def request_steer(self, text: str) -> bool:
        self.steer_calls.append(text)
        return True

    def request_interrupt(self) -> None:
        self.interrupt_calls += 1

    def compact_thread(self):
        self.compact_calls += 1
        return TurnResult(
            compacted=True,
            turn_id="private-compact-turn",
            thread_id="private-thread",
        )

    def close(self) -> None:
        self.close_calls += 1


def test_codex_host_is_structural_contract_with_truthful_capabilities():
    host = CodexRuntimeSessionHost(FakeCodexSession())

    assert isinstance(host, RuntimeSessionHost)
    assert host.capabilities.send is True
    assert host.capabilities.steer_active_turn is True
    assert host.capabilities.interrupt is True
    assert host.capabilities.compact is True
    assert host.capabilities.close is True
    assert host.capabilities.resume_after_restart is False
    assert host.capabilities.durable_replay is False
    assert host.capabilities.external_control is False
    assert host.capabilities.durable_close_proof is False
    assert not hasattr(host, "resume")
    assert not hasattr(host, "replay")


def test_generic_result_excludes_provider_and_process_identity():
    generic_fields = {field.name for field in fields(RuntimeTurnResult)}

    assert "provider" not in generic_fields
    assert "thread_id" not in generic_fields
    assert "turn_id" not in generic_fields
    assert "pid" not in generic_fields


def test_send_preserves_observables_and_codex_adapter_keeps_legacy_ids():
    session = FakeCodexSession()
    host = CodexRuntimeSessionHost(session)

    result = host.send("hello")
    legacy = host.take_legacy_result(result)

    assert session.run_calls == ["hello"]
    assert result == RuntimeTurnResult(
        final_text="done",
        projected_messages=[{"role": "assistant", "content": "done"}],
        tool_iterations=2,
        token_usage_last={"totalTokens": 3},
    )
    assert host.legacy_result_fields(legacy) == {
        "codex_thread_id": "private-thread",
        "codex_turn_id": "private-turn",
    }


def test_controls_and_compaction_delegate_without_exposing_targets():
    session = FakeCodexSession()
    host = CodexRuntimeSessionHost(session)

    assert host.steer_active_turn("go left") is True
    host.interrupt()
    result = host.compact()

    assert session.steer_calls == ["go left"]
    assert session.interrupt_calls == 1
    assert session.compact_calls == 1
    assert result.compacted is True


def test_close_is_idempotent_and_all_post_close_operations_refuse_identically():
    session = FakeCodexSession()
    host = CodexRuntimeSessionHost(session)

    host.close()
    host.close()

    assert session.close_calls == 1
    operations = (
        lambda: host.send("late"),
        lambda: host.steer_active_turn("late"),
        host.interrupt,
        host.compact,
    )
    for operation in operations:
        with pytest.raises(
            RuntimeSessionClosedError,
            match="^runtime session host is closed$",
        ):
            operation()
