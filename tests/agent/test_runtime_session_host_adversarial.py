from __future__ import annotations

import ast
import inspect
import threading
from dataclasses import asdict, fields
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import pytest

import agent.runtime_sessions as runtime_sessions
from agent.codex_runtime import (
    _close_runtime_session_host,
    run_codex_app_server_turn,
)
from agent.runtime_sessions import (
    RuntimeSessionClosedError,
    RuntimeSessionHost,
    RuntimeTurnResult,
)
from agent.transports.codex_app_server_session import (
    CodexAppServerSession,
    CodexRuntimeSessionHost,
    TurnResult,
)
from run_agent import AIAgent


_PRIVATE_THREAD = "provider-thread-private-7f9a"
_PRIVATE_TURN = "provider-turn-private-4c2d"


class RecordingBackend:
    def __init__(self, result: TurnResult | None = None) -> None:
        self.result = result or TurnResult(
            final_text="done",
            projected_messages=[{"role": "assistant", "content": "done"}],
            thread_id=_PRIVATE_THREAD,
            turn_id=_PRIVATE_TURN,
        )
        self.run_calls: list[Any] = []
        self.steer_calls: list[str] = []
        self.interrupt_calls = 0
        self.compact_calls = 0
        self.close_calls = 0

    def run_turn(self, user_input: Any, **kwargs: Any) -> TurnResult:
        self.run_calls.append(user_input)
        return self.result

    def request_steer(self, text: str) -> bool:
        self.steer_calls.append(text)
        return True

    def request_interrupt(self) -> None:
        self.interrupt_calls += 1

    def compact_thread(self, **kwargs: Any) -> TurnResult:
        self.compact_calls += 1
        return self.result

    def close(self) -> None:
        self.close_calls += 1


class FakeAppServerClient:
    """Small fake wire that exercises the real lazy Codex session."""

    def __init__(self) -> None:
        self.initialize_calls = 0
        self.close_calls = 0
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.notifications: list[dict[str, Any]] = []

    def initialize(self, **kwargs: Any) -> None:
        self.initialize_calls += 1

    def request(
        self,
        method: str,
        params: dict[str, Any],
        timeout: float | None = None,
    ) -> dict[str, Any]:
        self.requests.append((method, params))
        if method == "thread/start":
            return {"thread": {"id": _PRIVATE_THREAD}}
        if method == "turn/start":
            self.notifications.append(
                {
                    "method": "turn/completed",
                    "params": {
                        "threadId": _PRIVATE_THREAD,
                        "turn": {"id": _PRIVATE_TURN, "status": "completed"},
                    },
                }
            )
            return {"turn": {"id": _PRIVATE_TURN}}
        raise AssertionError(f"unexpected request: {method}")

    def take_server_request(self, timeout: float = 0) -> None:
        return None

    def take_notification(self, timeout: float = 0) -> dict[str, Any] | None:
        if self.notifications:
            return self.notifications.pop(0)
        return None

    def is_alive(self) -> bool:
        return True

    def stderr_tail(self, line_count: int = 20) -> list[str]:
        return []

    def close(self) -> None:
        self.close_calls += 1


def _lazy_host() -> tuple[
    CodexRuntimeSessionHost,
    list[FakeAppServerClient],
]:
    created: list[FakeAppServerClient] = []

    def factory(**kwargs: Any) -> FakeAppServerClient:
        client = FakeAppServerClient()
        created.append(client)
        return client

    session = CodexAppServerSession(cwd="/tmp", client_factory=factory)
    return CodexRuntimeSessionHost(session), created


def _lifecycle_agent(
    host: CodexRuntimeSessionHost,
    backend: RecordingBackend,
) -> SimpleNamespace:
    return SimpleNamespace(
        _runtime_session_host=host,
        _codex_session=backend,
        _active_children_lock=threading.Lock(),
        _active_children=[],
        client=None,
        session_id="",
        _session_messages=[{"role": "user", "content": "private"}],
        _end_session_on_close=False,
    )


def _retire(agent: Any) -> None:
    _close_runtime_session_host(agent)


def _release(agent: Any) -> None:
    AIAgent.release_clients(agent)


def _close(agent: Any) -> None:
    AIAgent.close(agent)


def test_generic_contract_and_result_do_not_leak_provider_identity() -> None:
    backend = RecordingBackend()
    host = CodexRuntimeSessionHost(backend)

    result = host.send("hello")
    serialized = repr(asdict(result))
    generic_result_fields = {field.name for field in fields(RuntimeTurnResult)}
    generic_capability_fields = {
        field.name for field in fields(runtime_sessions.RuntimeSessionCapabilities)
    }
    generic_methods = {
        name
        for name, value in RuntimeSessionHost.__dict__.items()
        if not name.startswith("_") and callable(value)
    }

    forbidden_identity_names = {
        "provider",
        "provider_id",
        "session_id",
        "thread_id",
        "turn_id",
        "process_id",
        "pid",
        "binding",
        "capability_token",
        "endpoint",
    }
    assert generic_result_fields.isdisjoint(forbidden_identity_names)
    assert generic_capability_fields.isdisjoint(forbidden_identity_names)
    assert generic_methods == {
        "send",
        "steer_active_turn",
        "interrupt",
        "compact",
        "close",
    }
    assert _PRIVATE_THREAD not in serialized
    assert _PRIVATE_TURN not in serialized
    assert not hasattr(result, "thread_id")
    assert not hasattr(result, "turn_id")
    assert isinstance(host, RuntimeSessionHost)


def test_construction_and_capability_read_are_lazy_until_first_send() -> None:
    host, created = _lazy_host()

    assert created == []
    assert host.capabilities.send is True
    assert created == []

    result = host.send("start now")

    assert result.error is None
    assert len(created) == 1
    assert created[0].initialize_calls == 1
    assert [method for method, _ in created[0].requests] == [
        "thread/start",
        "turn/start",
    ]


def test_post_close_operations_refuse_without_spawning_or_respawning() -> None:
    host, created = _lazy_host()

    host.close()
    host.close()

    operations: tuple[Callable[[], object], ...] = (
        lambda: host.send("must not spawn"),
        lambda: host.steer_active_turn("must not steer"),
        host.interrupt,
        host.compact,
    )
    for operation in operations:
        with pytest.raises(
            RuntimeSessionClosedError,
            match="^runtime session host is closed$",
        ):
            operation()

    assert created == []


def test_started_host_never_respawns_after_close() -> None:
    host, created = _lazy_host()
    host.send("first")
    first_client = created[0]

    host.close()
    with pytest.raises(RuntimeSessionClosedError):
        host.send("late")

    assert created == [first_client]
    assert first_client.close_calls == 1


@pytest.mark.parametrize(
    "actions",
    [
        (_retire, _release, _close),
        (_release, _close, _retire),
        (_close, _release, _retire),
    ],
    ids=("retirement-release-close", "release-close-retirement", "close-release-retirement"),
)
def test_release_close_and_retirement_close_underlying_session_exactly_once(
    actions: tuple[Callable[[Any], None], ...],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = RecordingBackend()
    host = CodexRuntimeSessionHost(backend)
    agent = _lifecycle_agent(host, backend)

    monkeypatch.setattr("run_agent.cleanup_vm", lambda task_id: None)
    monkeypatch.setattr("run_agent.cleanup_browser", lambda task_id: None)
    monkeypatch.setattr(
        "tools.process_registry.process_registry.kill_all",
        lambda task_id: None,
    )

    for action in actions:
        action(agent)

    assert backend.close_calls == 1
    assert agent._runtime_session_host is None
    assert agent._codex_session is None


def test_close_helper_clears_private_compatibility_alias_before_close() -> None:
    observations: list[tuple[Any, Any]] = []
    agent = SimpleNamespace()

    class ObservingHost:
        def close(self) -> None:
            observations.append(
                (agent._runtime_session_host, agent._codex_session)
            )

    host = ObservingHost()
    agent._runtime_session_host = host
    agent._codex_session = object()

    _close_runtime_session_host(agent)

    assert observations == [(None, None)]
    assert agent._runtime_session_host is None
    assert agent._codex_session is None


def test_legacy_result_is_consumed_before_retirement_clears_private_state() -> None:
    backend = RecordingBackend(
        TurnResult(
            error="runtime wedged",
            should_retire=True,
            thread_id=_PRIVATE_THREAD,
            turn_id=_PRIVATE_TURN,
        )
    )
    host = CodexRuntimeSessionHost(backend)
    agent = SimpleNamespace(
        _runtime_session_host=host,
        _codex_session=backend,
        _interrupt_requested=False,
        _interrupt_message=None,
        _iters_since_skill=0,
        _skill_nudge_interval=0,
        valid_tool_names=[],
        _session_db=None,
        session_id=None,
        session_api_calls=0,
        context_compressor=None,
        model="test-model",
        provider="test-provider",
        base_url="https://invalid.example",
    )

    result = run_codex_app_server_turn(
        agent,
        user_message="hello",
        original_user_message="hello",
        messages=[],
        effective_task_id="task",
    )

    assert result["codex_thread_id"] == _PRIVATE_THREAD
    assert result["codex_turn_id"] == _PRIVATE_TURN
    assert result["error"] == "runtime wedged"
    assert backend.close_calls == 1
    assert agent._runtime_session_host is None
    assert agent._codex_session is None
    assert host.take_legacy_result(RuntimeTurnResult()) is None


def test_stale_controls_do_not_invent_a_target_or_start_a_process() -> None:
    host, created = _lazy_host()

    assert host.steer_active_turn("late guidance") is False
    host.interrupt()
    host.interrupt()

    assert created == []

    interrupted = host.send("first consumed operation")
    assert interrupted.interrupted is True
    assert len(created) == 1
    assert [method for method, _ in created[0].requests] == ["thread/start"]

    completed = host.send("next turn")
    assert completed.interrupted is False
    assert [method for method, _ in created[0].requests] == [
        "thread/start",
        "turn/start",
    ]


def test_unsupported_capabilities_are_false_and_have_no_emulation_methods() -> None:
    host = CodexRuntimeSessionHost(RecordingBackend())
    capabilities = host.capabilities

    assert capabilities.resume_after_restart is False
    assert capabilities.durable_replay is False
    assert capabilities.external_control is False
    assert capabilities.durable_close_proof is False
    for unsupported_method in (
        "resume",
        "replay",
        "attach",
        "connect_external",
        "close_receipt",
    ):
        assert not hasattr(host, unsupported_method)

    with pytest.raises(Exception):
        capabilities.resume_after_restart = True  # type: ignore[misc]


def test_generic_module_has_no_registry_persistence_or_endpoint_surface() -> None:
    source_path = Path(inspect.getsourcefile(runtime_sessions) or "")
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    imported_roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_roots.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported_roots.add(node.module.split(".", 1)[0])

    assert imported_roots <= {"__future__", "dataclasses", "typing"}
    assert not any(
        hasattr(runtime_sessions, name)
        for name in (
            "RuntimeSessionRegistry",
            "RuntimeSessionBinding",
            "RuntimeControlReceipt",
            "ActiveTurnTarget",
            "router",
            "app",
            "database",
            "store",
        )
    )
    assert {
        name
        for name in RuntimeSessionHost.__dict__
        if not name.startswith("_")
    } == {
        "capabilities",
        "send",
        "steer_active_turn",
        "interrupt",
        "compact",
        "close",
    }
