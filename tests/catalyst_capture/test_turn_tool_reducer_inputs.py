"""Source-observed reducer inputs for the Catalyst turn/tool cases.

The capture uses deterministic local fakes around existing Costas owner seams.
Expected/corpus data and the earlier future-only capture are not inputs. No
provider, network, subprocess, or production tool is reachable.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
import unicodedata
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from agent.transports.codex_app_server_session import CodexAppServerSession
from agent.transports.codex_event_projector import CodexEventProjector
from run_agent import AIAgent
from tools.registry import ToolRegistry


ORACLE_DIR = Path(__file__).parents[1] / "fixtures" / "catalyst_oracle"
CORPUS_PATH = ORACLE_DIR / "corpus.json"
FUTURE_CAPTURE_PATH = ORACLE_DIR / "captured" / "turn_tool.json"
CAPTURE_PATH = ORACLE_DIR / "captured" / "reducer-inputs" / "turn_tool.json"
CASE_IDS = (
    "turn-stream-final",
    "tool-snapshot-request",
    "tool-approval-refusal",
    "tool-execute-result",
)
PRIOR_KEYS = (
    "sessions",
    "turns",
    "snapshots",
    "tool_calls",
    "controls",
    "runtimes",
    "compactions",
)
BOUNDS = {
    "max_cases": 4,
    "max_entities_per_partition": 8,
    "max_events_per_case": 8,
    "max_text_bytes": 256,
}


def _canonical_bytes(value: Any) -> bytes:
    text = json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return (unicodedata.normalize("NFC", text) + "\n").encode("utf-8")


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _empty_prior() -> dict[str, list[dict[str, Any]]]:
    return {key: [] for key in PRIOR_KEYS}


def _event(
    kind: str,
    partition: str,
    subject: str,
    **fields: Any,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "partition": partition,
        "subject": subject,
        **{key: value for key, value in fields.items() if value is not None},
    }


class _CaseRecorder:
    """Freeze prior bytes before accepting any replay event."""

    def __init__(self, case_id: str) -> None:
        self.case_id = case_id
        self._prior_bytes: bytes | None = None
        self._events: list[dict[str, Any]] = []

    def serialize_prior(self, prior: dict[str, list[dict[str, Any]]]) -> None:
        assert self._prior_bytes is None
        assert not self._events
        assert tuple(prior) == PRIOR_KEYS
        self._prior_bytes = _canonical_bytes(prior)

    def record_event(self, event: dict[str, Any]) -> None:
        assert self._prior_bytes is not None, "prior must be serialized first"
        frozen = copy.deepcopy(event)
        frozen["seq"] = len(self._events)
        self._events.append(frozen)

    def finish(self) -> dict[str, Any]:
        assert self._prior_bytes is not None
        prior = json.loads(self._prior_bytes)
        events = copy.deepcopy(self._events)
        payload = {"events": events, "prior": prior}
        return {
            "disposition": "reduced",
            "events": events,
            "id": self.case_id,
            "prior": prior,
            "privacy": "synthetic-bounded",
            "source_receipt": {
                "fixture_hash": _digest(payload),
                "owner": "Costas turn/tool owner seam",
                "prior_serialized_before_events": True,
            },
        }


def _make_agent(session_id: str) -> AIAgent:
    with (
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        agent = AIAgent(
            api_key="capture-only-key",
            base_url="https://invalid.example/v1",
            provider="custom",
            model="capture-model",
            quiet_mode=True,
            session_id=session_id,
            skip_context_files=True,
            skip_memory=True,
        )
    agent.client = object()
    agent._cached_system_prompt = "deterministic capture system prompt"
    agent._use_prompt_caching = False
    agent.compression_enabled = False
    agent.save_trajectories = False
    agent.tool_delay = 0
    return agent


def _model_response(
    content: str,
    *,
    tool_calls: list[Any] | None = None,
    finish_reason: str = "stop",
) -> SimpleNamespace:
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    choice = SimpleNamespace(message=message, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice], model="capture-model", usage=None)


def _build_fake_registry(execution_log: list[dict[str, Any]]) -> ToolRegistry:
    registry = ToolRegistry()

    def capture_echo(args: dict[str, Any], **_kwargs: Any) -> str:
        execution_log.append({"args": dict(args), "phase": "running"})
        return json.dumps(
            {"object_ref": "object-result-1", "value": args.get("value")},
            ensure_ascii=False,
            sort_keys=True,
        )

    registry.register(
        name="capture_echo",
        toolset="capture",
        schema={
            "description": "Return a deterministic synthetic object reference.",
            "parameters": {
                "additionalProperties": False,
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "type": "object",
            },
        },
        handler=capture_echo,
    )
    return registry


class _FakeCodexClient:
    """Bounded in-memory protocol peer with no process or network surface."""

    def __init__(
        self,
        *,
        call_id: str,
        command: str,
        turn_id: str,
    ) -> None:
        self.call_id = call_id
        self.command = command
        self.turn_id = turn_id
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.responses: list[tuple[str, dict[str, Any]]] = []
        self.server_requests = [
            {
                "id": call_id,
                "method": "item/commandExecution/requestApproval",
                "params": {"command": command, "cwd": "/synthetic"},
            }
        ]
        self.notifications: list[dict[str, Any]] = []
        self.closed = False

    def initialize(self, **_kwargs: Any) -> dict[str, str]:
        return {"codexHome": "/synthetic", "userAgent": "capture/1"}

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        del timeout
        body = params or {}
        self.requests.append((method, body))
        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}
        if method == "turn/start":
            return {"turn": {"id": self.turn_id}}
        return {}

    def notify(self, _method: str, params: Any = None) -> None:
        del params

    def respond(self, request_id: str, result: dict[str, Any]) -> None:
        self.responses.append((request_id, result))
        self.notifications.append(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": {
                        "error": None,
                        "id": self.turn_id,
                        "status": "completed",
                    },
                },
            }
        )

    def respond_error(
        self,
        _request_id: str,
        _code: int,
        _message: str,
        data: Any = None,
    ) -> None:
        del data
        raise AssertionError("capture emitted an unexpected protocol error")

    def take_notification(self, timeout: float = 0.0) -> dict[str, Any] | None:
        del timeout
        return self.notifications.pop(0) if self.notifications else None

    def take_server_request(self, timeout: float = 0.0) -> dict[str, Any] | None:
        del timeout
        return self.server_requests.pop(0) if self.server_requests else None

    def close(self) -> None:
        self.closed = True

    def is_alive(self) -> bool:
        return not self.closed

    def stderr_tail(self, n: int = 20) -> list[str]:
        del n
        return []


def _definition_observation(
    registry: ToolRegistry,
) -> tuple[dict[str, Any], str]:
    definitions = registry.get_definitions({"capture_echo"}, quiet=True)
    assert len(definitions) == 1
    definition = definitions[0]
    return definition, _digest(definition)


def _capture_turn_stream_final() -> dict[str, Any]:
    agent = _make_agent("session-turn-1")
    recorder = _CaseRecorder("turn-stream-final")
    streamed: list[str] = []
    task_id = "turn-1"

    # The owner call boundary supplies the active task identity independently of
    # any event that the conversation later emits. Freeze it before invocation.
    prior = _empty_prior()
    prior["sessions"].append(
        {"id": agent.session_id, "partition": "control", "state": "active"}
    )
    prior["turns"].append(
        {
            "id": task_id,
            "partition": "control",
            "session_id": agent.session_id,
            "state": "active",
        }
    )
    recorder.serialize_prior(prior)

    def fake_model_call(
        api_kwargs: dict[str, Any],
        *,
        on_first_delta: Any = None,
    ) -> SimpleNamespace:
        messages = api_kwargs["messages"]
        assert messages[-1]["role"] == "user"
        assert messages[-1]["content"] == "synthetic user request"
        if on_first_delta is not None:
            on_first_delta()
        agent._fire_stream_delta("synthetic partial")
        return _model_response("synthetic final")

    with (
        patch.object(
            agent,
            "_interruptible_streaming_api_call",
            side_effect=fake_model_call,
        ),
        patch.object(
            agent,
            "_interruptible_api_call",
            side_effect=AssertionError("capture attempted a non-streaming model call"),
        ),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
    ):
        result = agent.run_conversation(
            "synthetic user request",
            stream_callback=streamed.append,
            task_id=task_id,
        )

    user_messages = [m for m in result["messages"] if m.get("role") == "user"]
    final_messages = [
        m
        for m in result["messages"]
        if m.get("role") == "assistant" and m.get("content") == result["final_response"]
    ]
    assert len(user_messages) == len(final_messages) == 1
    assert streamed == ["synthetic partial"]
    assert result["completed"] is True

    recorder.record_event(
        _event(
            "turn.user.accepted",
            "private",
            "turn-1",
            text=user_messages[0]["content"],
        )
    )
    recorder.record_event(
        _event(
            "turn.assistant.provisional",
            "private",
            "turn-1",
            text="".join(streamed),
        )
    )
    recorder.record_event(
        _event(
            "turn.assistant.final",
            "private",
            "turn-1",
            state="promoted",
            text=final_messages[0]["content"],
        )
    )
    recorder.record_event(
        _event(
            "turn.runtime.terminal",
            "control",
            "turn-1",
            acceptance="candidate-only",
            state="completed",
        )
    )
    return recorder.finish()


def _capture_tool_snapshot_request(
    registry: ToolRegistry,
    execution_log: list[dict[str, Any]],
) -> dict[str, Any]:
    recorder = _CaseRecorder("tool-snapshot-request")
    definition, definition_hash = _definition_observation(registry)
    agent = _make_agent("session-tool-1")
    prior = _empty_prior()
    prior["sessions"].append(
        {"id": agent.session_id, "partition": "control", "state": "active"}
    )
    prior["snapshots"].append(
        {
            "definition": definition,
            "definition_hash": definition_hash,
            "id": "snapshot-1",
            "partition": "control",
            "state": "available",
        }
    )
    recorder.serialize_prior(prior)

    tool_call = SimpleNamespace(
        id="call-1",
        type="function",
        function=SimpleNamespace(
            arguments=json.dumps({"value": "pending"}, sort_keys=True),
            name="capture_echo",
        ),
    )
    response = _model_response("", tool_calls=[tool_call], finish_reason="tool_calls")
    assistant = agent._build_assistant_message(response.choices[0].message, "tool_calls")
    observed_call = assistant["tool_calls"][0]
    assert execution_log == []

    recorder.record_event(
        _event(
            "tool.snapshot.frozen",
            "control",
            "snapshot-1",
            definition_hash=definition_hash,
            state="available",
        )
    )
    recorder.record_event(
        _event(
            "tool.requested",
            "private",
            observed_call["id"],
            arguments=json.loads(observed_call["function"]["arguments"]),
            name=observed_call["function"]["name"],
            ref="snapshot-1",
            state="pending",
        )
    )
    return recorder.finish()


def _capture_tool_approval_refusal(
    execution_log: list[dict[str, Any]],
) -> dict[str, Any]:
    recorder = _CaseRecorder("tool-approval-refusal")
    client = _FakeCodexClient(
        call_id="call-1",
        command="capture_echo --value denied",
        turn_id="turn-refusal",
    )
    choices: list[str] = []

    def refuse(_command: str, _description: str, *, allow_permanent: bool = True) -> str:
        assert allow_permanent is False
        choices.append("deny")
        return "deny"

    session = CodexAppServerSession(
        approval_callback=refuse,
        client_factory=lambda **_kwargs: client,
        cwd="/synthetic",
    )
    thread_id = session.ensure_started()
    pending = copy.deepcopy(client.server_requests[0])
    prior = _empty_prior()
    prior["sessions"].append(
        {"id": thread_id, "partition": "control", "state": "active"}
    )
    prior["tool_calls"].append(
        {
            "command": pending["params"]["command"],
            "id": pending["id"],
            "partition": "private",
            "request_method": pending["method"],
            "state": "pending-consent",
        }
    )
    recorder.serialize_prior(prior)

    before = len(execution_log)
    result = session.run_turn(
        "synthetic refusal request",
        notification_poll_timeout=0.0,
        turn_timeout=1.0,
    )
    assert result.error is None
    assert choices == ["deny"]
    assert client.responses == [("call-1", {"decision": "decline"})]
    assert len(execution_log) == before

    recorder.record_event(
        _event(
            "tool.consent.receipt",
            "control",
            "call-1",
            code="user-refused",
            decision=client.responses[0][1]["decision"],
            state="refused",
        )
    )
    return recorder.finish()


def _capture_tool_execute_result(
    registry: ToolRegistry,
    execution_log: list[dict[str, Any]],
) -> dict[str, Any]:
    recorder = _CaseRecorder("tool-execute-result")
    definition, definition_hash = _definition_observation(registry)
    client = _FakeCodexClient(
        call_id="call-2",
        command="capture_echo --value executed",
        turn_id="turn-admission",
    )
    choices: list[str] = []

    def admit(_command: str, _description: str, *, allow_permanent: bool = True) -> str:
        assert allow_permanent is False
        choices.append("once")
        return "once"

    session = CodexAppServerSession(
        approval_callback=admit,
        client_factory=lambda **_kwargs: client,
        cwd="/synthetic",
    )
    admission = session.run_turn(
        "synthetic admission observation",
        notification_poll_timeout=0.0,
        turn_timeout=1.0,
    )
    assert admission.error is None
    assert choices == ["once"]
    assert client.responses == [("call-2", {"decision": "accept"})]

    prior = _empty_prior()
    prior["sessions"].append(
        {"id": admission.thread_id, "partition": "control", "state": "active"}
    )
    prior["snapshots"].append(
        {
            "definition": definition,
            "definition_hash": definition_hash,
            "id": "snapshot-1",
            "partition": "control",
            "state": "available",
        }
    )
    prior["tool_calls"].append(
        {
            "admission": {
                "decision": client.responses[0][1]["decision"],
                "externally_observed": True,
                "source": "app-server-approval-response",
            },
            "arguments": {"value": "executed"},
            "id": "call-2",
            "name": "capture_echo",
            "partition": "private",
            "snapshot_id": "snapshot-1",
            "state": "admitted",
        }
    )
    recorder.serialize_prior(prior)

    before = len(execution_log)
    raw_result = registry.dispatch("capture_echo", {"value": "executed"})
    parsed_result = json.loads(raw_result)
    projected = CodexEventProjector().project(
        {
            "method": "item/completed",
            "params": {
                "item": {
                    "arguments": {"value": "executed"},
                    "contentItems": [parsed_result],
                    "id": "call-2",
                    "status": "completed",
                    "success": True,
                    "tool": "capture_echo",
                    "type": "dynamicToolCall",
                }
            },
        }
    )
    assert len(execution_log) - before == 1
    assert [message["role"] for message in projected.messages] == ["assistant", "tool"]
    projected_call = projected.messages[0]["tool_calls"][0]
    projected_result = projected.messages[1]
    assert projected_result["tool_call_id"] == projected_call["id"]
    result_items = json.loads(projected_result["content"])

    recorder.record_event(
        _event(
            "tool.running",
            "control",
            "call-2",
            state=execution_log[-1]["phase"],
        )
    )
    recorder.record_event(
        _event(
            "tool.result.reference",
            "private",
            "call-2",
            projected_call_id=projected_result["tool_call_id"],
            ref=result_items[0]["object_ref"],
            state="completed",
        )
    )
    return recorder.finish()


def capture_turn_tool_reducer_inputs() -> dict[str, Any]:
    """Capture four owner observations without consulting expected data."""
    execution_log: list[dict[str, Any]] = []
    registry = _build_fake_registry(execution_log)
    cases = [
        _capture_turn_stream_final(),
        _capture_tool_snapshot_request(registry, execution_log),
        _capture_tool_approval_refusal(execution_log),
        _capture_tool_execute_result(registry, execution_log),
    ]
    assert len(execution_log) == 1
    return {
        "bounds": BOUNDS,
        "cases": cases,
        "schema": "costas-catalyst-reducer-inputs/1",
    }


class _ExpectedDataMustNotBeRead:
    def read_bytes(self, *_args: Any, **_kwargs: Any) -> bytes:
        raise AssertionError("capture attempted to read expected/future data")

    def read_text(self, *_args: Any, **_kwargs: Any) -> str:
        raise AssertionError("capture attempted to read expected/future data")


_ID_KEYS = {"id", "ref", "session_id", "snapshot_id", "subject", "tool_call_id"}


def _validate_case_receipt(case: dict[str, Any]) -> None:
    assert case["source_receipt"]["prior_serialized_before_events"] is True
    assert case["source_receipt"]["fixture_hash"] == _digest(
        {"events": case["events"], "prior": case["prior"]}
    )


def _assert_no_forbidden_expected_fields(value: Any) -> None:
    if isinstance(value, dict):
        assert "expected" not in value
        assert "final_state" not in value
        for nested in value.values():
            _assert_no_forbidden_expected_fields(nested)
    elif isinstance(value, list):
        for nested in value:
            _assert_no_forbidden_expected_fields(nested)


def _assert_no_control_text(value: Any) -> None:
    if isinstance(value, dict):
        if value.get("partition") == "control":
            assert "text" not in value
        for nested in value.values():
            _assert_no_control_text(nested)
    elif isinstance(value, list):
        for nested in value:
            _assert_no_control_text(nested)


def _rewrite_identifiers(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {
            key: replacements.get(nested, nested)
            if key in _ID_KEYS and isinstance(nested, str)
            else _rewrite_identifiers(nested, replacements)
            for key, nested in value.items()
        }
    if isinstance(value, list):
        return [_rewrite_identifiers(nested, replacements) for nested in value]
    return value


def _pseudonym_normal_form(case: dict[str, Any]) -> Any:
    mapping: dict[str, str] = {}

    def normalize(value: Any) -> Any:
        if isinstance(value, dict):
            normalized = {}
            for key, nested in value.items():
                if key in _ID_KEYS and isinstance(nested, str):
                    mapping.setdefault(nested, f"pseudonym-{len(mapping)}")
                    normalized[key] = mapping[nested]
                else:
                    normalized[key] = normalize(nested)
            return normalized
        if isinstance(value, list):
            return [normalize(nested) for nested in value]
        return value

    return normalize({"events": case["events"], "prior": case["prior"]})


def test_turn_tool_reducer_inputs_are_canonical_and_expected_blind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    poison = _ExpectedDataMustNotBeRead()
    module = sys.modules[__name__]
    with monkeypatch.context() as context:
        context.setattr(module, "CORPUS_PATH", poison)
        context.setattr(module, "FUTURE_CAPTURE_PATH", poison)
        context.setattr(module, "CAPTURE_PATH", poison)
        observed = capture_turn_tool_reducer_inputs()

    fixture_bytes = CAPTURE_PATH.read_bytes()
    assert fixture_bytes == _canonical_bytes(observed)
    assert fixture_bytes.endswith(b"\n")
    assert not fixture_bytes.endswith(b"\n\n")


def test_turn_tool_reducer_inputs_bind_source_prior_and_replay_events() -> None:
    captured = json.loads(CAPTURE_PATH.read_text(encoding="utf-8"))
    cases = {case["id"]: case for case in captured["cases"]}
    assert captured["schema"] == "costas-catalyst-reducer-inputs/1"
    assert tuple(cases) == CASE_IDS
    assert len(cases) == BOUNDS["max_cases"]

    for case in cases.values():
        assert set(case["prior"]) == set(PRIOR_KEYS)
        assert case["privacy"] == "synthetic-bounded"
        assert [event["seq"] for event in case["events"]] == list(
            range(len(case["events"]))
        )
        assert len(case["events"]) <= BOUNDS["max_events_per_case"]
        _validate_case_receipt(case)
        _assert_no_forbidden_expected_fields(case)
        _assert_no_control_text(case)

    turn = cases["turn-stream-final"]
    assert turn["prior"]["sessions"][0]["state"] == "active"
    assert turn["prior"]["turns"][0]["state"] == "active"
    assert [event["kind"] for event in turn["events"]] == [
        "turn.user.accepted",
        "turn.assistant.provisional",
        "turn.assistant.final",
        "turn.runtime.terminal",
    ]
    assert turn["events"][-1]["acceptance"] == "candidate-only"

    snapshot = cases["tool-snapshot-request"]
    frozen = snapshot["prior"]["snapshots"][0]
    assert frozen["definition_hash"] == _digest(frozen["definition"])
    assert snapshot["prior"]["tool_calls"] == []
    assert [event["kind"] for event in snapshot["events"]] == [
        "tool.snapshot.frozen",
        "tool.requested",
    ]
    assert snapshot["events"][1]["ref"] == frozen["id"]

    refusal = cases["tool-approval-refusal"]
    assert refusal["prior"]["tool_calls"][0]["state"] == "pending-consent"
    assert [event["kind"] for event in refusal["events"]] == [
        "tool.consent.receipt"
    ]
    assert refusal["events"][0]["state"] == "refused"
    assert not any(
        event["kind"] in {"tool.running", "tool.result.reference"}
        for event in refusal["events"]
    )

    execution = cases["tool-execute-result"]
    admitted = execution["prior"]["tool_calls"][0]
    assert admitted["state"] == "admitted"
    assert admitted["admission"]["externally_observed"] is True
    assert admitted["admission"]["decision"] == "accept"
    assert [event["kind"] for event in execution["events"]] == [
        "tool.running",
        "tool.result.reference",
    ]
    assert "approved" not in json.dumps(execution).lower()


def test_turn_tool_reducer_inputs_detect_mutation_and_preserve_renaming() -> None:
    captured = capture_turn_tool_reducer_inputs()
    for original in captured["cases"]:
        prior_mutation = copy.deepcopy(original)
        populated_partition = next(
            key for key in PRIOR_KEYS if prior_mutation["prior"][key]
        )
        prior_mutation["prior"][populated_partition][0]["state"] = "mutated"
        with pytest.raises(AssertionError):
            _validate_case_receipt(prior_mutation)

        event_mutation = copy.deepcopy(original)
        event_mutation["events"][0]["kind"] = "mutated.event"
        with pytest.raises(AssertionError):
            _validate_case_receipt(event_mutation)

        renamed = copy.deepcopy(original)
        replacements = {
            "call-1": "call-a",
            "call-2": "call-b",
            "object-result-1": "object-a",
            "session-tool-1": "session-a",
            "session-turn-1": "session-b",
            "snapshot-1": "snapshot-a",
            "thread-1": "thread-a",
            "turn-1": "turn-a",
        }
        renamed["prior"] = _rewrite_identifiers(renamed["prior"], replacements)
        renamed["events"] = _rewrite_identifiers(renamed["events"], replacements)
        renamed["source_receipt"]["fixture_hash"] = _digest(
            {"events": renamed["events"], "prior": renamed["prior"]}
        )
        _validate_case_receipt(renamed)
        assert _pseudonym_normal_form(renamed) == _pseudonym_normal_form(original)


if __name__ == "__main__":
    CAPTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAPTURE_PATH.write_bytes(_canonical_bytes(capture_turn_tool_reducer_inputs()))
