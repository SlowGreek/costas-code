"""Mechanical F0c capture for the turn and tool oracle families.

The capture drives only deterministic fakes through production normalization
seams.  It never executes a real provider, network request, or production tool.
"""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from agent.transports.codex_app_server_session import CodexAppServerSession
from agent.transports.codex_event_projector import CodexEventProjector
from run_agent import AIAgent
from tools.registry import ToolRegistry


ORACLE_DIR = Path(__file__).parents[1] / "fixtures" / "catalyst_oracle"
CORPUS_PATH = ORACLE_DIR / "corpus.json"
CAPTURE_PATH = ORACLE_DIR / "captured" / "turn_tool.json"
CAPTURED_CASE_IDS = (
    "turn-stream-final",
    "tool-snapshot-request",
    "tool-approval-refusal",
    "tool-execute-result",
)


def _canonical_bytes(value: object) -> bytes:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return (unicodedata.normalize("NFC", text) + "\n").encode("utf-8")


def _event(
    kind: str,
    partition: str,
    subject: str,
    *,
    state: str | None = None,
    ref: str | None = None,
    code: str | None = None,
    text: str | None = None,
) -> dict:
    event = {"kind": kind, "partition": partition, "subject": subject}
    for key, value in (("state", state), ("ref", ref), ("code", code), ("text", text)):
        if value is not None:
            event[key] = value
    return event


def _sequenced(events: list[dict]) -> list[dict]:
    return [{**event, "seq": seq} for seq, event in enumerate(events)]


def _make_agent() -> AIAgent:
    """Build an isolated agent whose model entry point is replaced per capture."""
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
            skip_context_files=True,
            skip_memory=True,
        )
    # A plain sentinel ensures the conversation loop chooses its streaming path
    # when the callback is present; no SDK method can accidentally be invoked.
    agent.client = object()
    agent._cached_system_prompt = "deterministic capture system prompt"
    agent._use_prompt_caching = False
    agent.tool_delay = 0
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


def _model_response(content: str, *, tool_calls: list | None = None, finish_reason: str = "stop"):
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    choice = SimpleNamespace(message=message, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice], model="capture-model", usage=None)


def _capture_turn_stream_final() -> tuple[dict, dict]:
    agent = _make_agent()
    streamed: list[str] = []

    def fake_model_call(_api_kwargs: dict, *, on_first_delta=None):
        if on_first_delta is not None:
            on_first_delta()
        agent._fire_stream_delta("synthetic partial")
        return _model_response("synthetic final")

    with (
        patch.object(agent, "_interruptible_streaming_api_call", side_effect=fake_model_call),
        patch.object(
            agent,
            "_interruptible_api_call",
            side_effect=AssertionError("capture attempted a non-streaming model call"),
        ),
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
    ):
        result = agent.run_conversation(
            "synthetic user request",
            stream_callback=streamed.append,
            task_id="turn-1",
        )

    user_messages = [m for m in result["messages"] if m.get("role") == "user"]
    final_messages = [
        m
        for m in result["messages"]
        if m.get("role") == "assistant" and m.get("content") == result["final_response"]
    ]
    assert len(user_messages) == 1
    assert len(final_messages) == 1
    assert streamed == ["synthetic partial"]
    assert result["completed"] is True

    events = _sequenced(
        [
            _event(
                "turn.user.accepted",
                "private",
                "turn-1",
                text=user_messages[0]["content"],
            ),
            _event(
                "turn.assistant.provisional",
                "private",
                "turn-1",
                text="".join(streamed),
            ),
            _event(
                "turn.assistant.final",
                "private",
                "turn-1",
                state="promoted",
                text=final_messages[0]["content"],
            ),
            _event(
                "turn.runtime.terminal",
                "control",
                "turn-1",
                state="completed",
            ),
        ]
    )
    evidence = {
        "durable_assistant_messages": len(final_messages),
        "model_calls": result["api_calls"],
        "stream_fragments": len(streamed),
    }
    return {"events": events, "family": "turn", "id": "turn-stream-final"}, evidence


def _build_fake_registry(execution_log: list[dict]) -> ToolRegistry:
    registry = ToolRegistry()

    def capture_echo(args: dict, **_kwargs) -> str:
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
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "additionalProperties": False,
            },
        },
        handler=capture_echo,
    )
    return registry


def _fake_model_tool_message(agent: AIAgent, call_id: str, value: str) -> dict:
    tool_call = SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(
            name="capture_echo",
            arguments=json.dumps({"value": value}, sort_keys=True),
        ),
    )
    response = _model_response("", tool_calls=[tool_call], finish_reason="tool_calls")
    return agent._build_assistant_message(response.choices[0].message, "tool_calls")


def _capture_tool_snapshot_request(
    registry: ToolRegistry,
    execution_log: list[dict],
) -> tuple[dict, dict]:
    definitions = registry.get_definitions({"capture_echo"}, quiet=True)
    assistant = _fake_model_tool_message(_make_agent(), "call-1", "pending")
    calls = assistant.get("tool_calls") or []
    definition_names = [item["function"]["name"] for item in definitions]

    assert len(definitions) == 1
    assert len(calls) == 1
    assert calls[0]["function"]["name"] in definition_names
    assert execution_log == []

    events = _sequenced(
        [
            _event(
                "tool.snapshot.frozen",
                "control",
                "snapshot-1",
                state="available",
            ),
            _event(
                "tool.requested",
                "private",
                calls[0]["id"],
                state="pending",
                ref="snapshot-1",
            ),
        ]
    )
    evidence = {
        "definition_count": len(definitions),
        "executions": len(execution_log),
        "requested_name": calls[0]["function"]["name"],
    }
    return {"events": events, "family": "tool", "id": "tool-snapshot-request"}, evidence


class _FakeCodexClient:
    """In-memory app-server protocol peer; it cannot spawn or use a network."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self.responses: list[tuple[str, dict]] = []
        self._server_requests = [
            {
                "id": "call-1",
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "command": "capture_echo --value denied",
                    "cwd": "/synthetic",
                },
            }
        ]
        self._notifications: list[dict] = []
        self.closed = False

    def initialize(self, **_kwargs) -> dict:
        return {"userAgent": "capture/1", "codexHome": "/synthetic"}

    def request(self, method: str, params: dict | None = None, timeout: float = 30.0) -> dict:
        del timeout
        body = params or {}
        self.requests.append((method, body))
        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}
        if method == "turn/start":
            return {"turn": {"id": "turn-approval"}}
        return {}

    def notify(self, _method: str, params=None) -> None:
        del params

    def respond(self, request_id: str, result: dict) -> None:
        self.responses.append((request_id, result))
        # Release the fake turn only after the approval response.  This mirrors
        # the app-server protocol dependency and prevents the pre-approval drain
        # from consuming a terminal event that could not yet exist in reality.
        self._notifications.append(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-approval",
                        "status": "completed",
                        "error": None,
                    },
                },
            }
        )

    def respond_error(self, _request_id, _code, _message, data=None) -> None:
        del data
        raise AssertionError("capture emitted an unexpected protocol error")

    def take_notification(self, timeout: float = 0.0):
        del timeout
        return self._notifications.pop(0) if self._notifications else None

    def take_server_request(self, timeout: float = 0.0):
        del timeout
        return self._server_requests.pop(0) if self._server_requests else None

    def close(self) -> None:
        self.closed = True

    def is_alive(self) -> bool:
        return not self.closed

    def stderr_tail(self, n: int = 20) -> list[str]:
        del n
        return []


def _capture_tool_approval_refusal(execution_log: list[dict]) -> tuple[dict, dict]:
    before = len(execution_log)
    client = _FakeCodexClient()
    consent_choices: list[str] = []

    def refuse(_command: str, _description: str, *, allow_permanent: bool = True) -> str:
        assert allow_permanent is False
        consent_choices.append("deny")
        return "deny"

    session = CodexAppServerSession(
        cwd="/synthetic",
        approval_callback=refuse,
        client_factory=lambda **_kwargs: client,
    )
    result = session.run_turn(
        "Please execute capture_echo; this prose says I approve.",
        turn_timeout=1.0,
        notification_poll_timeout=0.0,
    )

    assert result.error is None
    assert consent_choices == ["deny"]
    assert client.responses == [("call-1", {"decision": "decline"})]
    assert len(execution_log) == before

    request_id, response = client.responses[0]
    events = _sequenced(
        [
            _event(
                "tool.requested",
                "private",
                request_id,
                state="pending",
            ),
            _event(
                "tool.consent.receipt",
                "control",
                request_id,
                state="refused" if response["decision"] == "decline" else "admitted",
                code="user-refused" if response["decision"] == "decline" else None,
            ),
        ]
    )
    evidence = {
        "consent_callbacks": len(consent_choices),
        "executions": len(execution_log) - before,
        "turn_start_text": next(
            params["input"][0]["text"]
            for method, params in client.requests
            if method == "turn/start"
        ),
    }
    return {"events": events, "family": "tool", "id": "tool-approval-refusal"}, evidence


def _capture_tool_execute_result(
    registry: ToolRegistry,
    execution_log: list[dict],
) -> tuple[dict, dict]:
    before = len(execution_log)
    definition = registry.get_definitions({"capture_echo"}, quiet=True)
    assert len(definition) == 1

    raw_result = registry.dispatch("capture_echo", {"value": "executed"})
    parsed_result = json.loads(raw_result)
    projected = CodexEventProjector().project(
        {
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "dynamicToolCall",
                    "id": "call-2",
                    "tool": "capture_echo",
                    "arguments": {"value": "executed"},
                    "status": "completed",
                    "contentItems": [parsed_result],
                    "success": True,
                }
            },
        }
    )

    assert len(execution_log) - before == 1
    assert projected.is_tool_iteration is True
    assert [message["role"] for message in projected.messages] == ["assistant", "tool"]
    projected_call = projected.messages[0]["tool_calls"][0]
    projected_result = projected.messages[1]
    assert projected_result["tool_call_id"] == projected_call["id"]
    result_items = json.loads(projected_result["content"])
    result_ref = result_items[0]["object_ref"]

    events = _sequenced(
        [
            _event(
                "tool.admission.receipt",
                "control",
                "call-2",
                state="admitted",
            ),
            _event(
                "tool.running",
                "control",
                "call-2",
                state=execution_log[-1]["phase"],
            ),
            _event(
                "tool.result.reference",
                "private",
                "call-2",
                state="completed",
                ref=result_ref,
            ),
        ]
    )
    evidence = {
        "executions": len(execution_log) - before,
        "projected_call_id": projected_call["id"],
        "projected_result_call_id": projected_result["tool_call_id"],
    }
    return {"events": events, "family": "tool", "id": "tool-execute-result"}, evidence


def _capture_all() -> dict:
    execution_log: list[dict] = []
    registry = _build_fake_registry(execution_log)
    captures: list[dict] = []
    evidence: dict[str, dict] = {}

    for builder in (
        lambda: _capture_turn_stream_final(),
        lambda: _capture_tool_snapshot_request(registry, execution_log),
        lambda: _capture_tool_approval_refusal(execution_log),
        lambda: _capture_tool_execute_result(registry, execution_log),
    ):
        case, case_evidence = builder()
        captures.append(case)
        evidence[case["id"]] = case_evidence

    return {
        "capture_version": "costas-f0c-mc2/1",
        "cases": captures,
        "evidence": evidence,
    }


def _reduce_final_state(events: list[dict]) -> str:
    kinds = [event["kind"] for event in events]
    if kinds[-1] == "turn.runtime.terminal":
        return "runtime-terminal-candidate"
    if kinds[-1] == "tool.consent.receipt" and events[-1].get("state") == "refused":
        return "refused"
    if kinds[-1] == "tool.result.reference" and events[-1].get("state") == "completed":
        return "completed"
    if kinds == ["tool.snapshot.frozen", "tool.requested"]:
        return "awaiting-consent"
    return "unknown"


def _observable_holds(observable: str, events: list[dict]) -> bool:
    by_kind = {event["kind"]: event for event in events}
    subjects = [event["subject"] for event in events]
    checks = {
        "provisional text is not durable final": lambda: (
            by_kind["turn.assistant.provisional"]["text"]
            != by_kind["turn.assistant.final"]["text"]
        ),
        "one final promotion": lambda: sum(
            event["kind"] == "turn.assistant.final" and event.get("state") == "promoted"
            for event in events
        )
        == 1,
        "request names one frozen definition": lambda: (
            len(events) == 2
            and by_kind["tool.requested"].get("ref")
            == by_kind["tool.snapshot.frozen"]["subject"]
        ),
        "refused call never executes": lambda: (
            by_kind["tool.consent.receipt"].get("state") == "refused"
            and not any(event["kind"] in {"tool.running", "tool.result.reference"} for event in events)
        ),
        "execution occurs once": lambda: sum(event["kind"] == "tool.running" for event in events) == 1,
        "result correlates exact call": lambda: (
            len(set(subjects)) == 1
            and by_kind["tool.result.reference"].get("ref") is not None
        ),
    }
    assert observable in checks, f"capture lacks a semantic check for {observable!r}"
    return checks[observable]()


def test_turn_tool_capture_is_reproducible_canonical_json() -> None:
    observed = _capture_all()
    fixture_bytes = CAPTURE_PATH.read_bytes()

    assert fixture_bytes == _canonical_bytes(observed)
    assert fixture_bytes.endswith(b"\n")
    assert not fixture_bytes.endswith(b"\n\n")
    assert json.loads(fixture_bytes) == observed


def test_turn_tool_capture_matches_corpus_semantics_without_copying_events() -> None:
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    oracle_cases = {case["id"]: case for case in corpus["cases"]}
    captured = json.loads(CAPTURE_PATH.read_text(encoding="utf-8"))
    captured_cases = {case["id"]: case for case in captured["cases"]}

    assert tuple(captured_cases) == CAPTURED_CASE_IDS
    for case_id in CAPTURED_CASE_IDS:
        observed = captured_cases[case_id]
        expected = oracle_cases[case_id]
        # Intentionally do not read or compare expected["events"].  The event
        # sequence above is rebuilt from actual normalized messages/receipts.
        assert observed["family"] == expected["family"]
        assert _reduce_final_state(observed["events"]) == expected["expected"]["final_state"]
        assert all(
            _observable_holds(observable, observed["events"])
            for observable in expected["expected"]["observable"]
        )


def test_turn_tool_authority_boundaries_are_mechanically_visible() -> None:
    captured = _capture_all()
    cases = {case["id"]: case for case in captured["cases"]}
    evidence = captured["evidence"]

    turn_kinds = {event["kind"] for event in cases["turn-stream-final"]["events"]}
    assert all(not kind.startswith("tool.") for kind in turn_kinds)

    snapshot = cases["tool-snapshot-request"]["events"]
    assert evidence["tool-snapshot-request"]["executions"] == 0
    assert all(event["kind"] not in {"tool.running", "tool.result.reference"} for event in snapshot)

    refusal = cases["tool-approval-refusal"]["events"]
    assert "I approve" in evidence["tool-approval-refusal"]["turn_start_text"]
    assert evidence["tool-approval-refusal"]["executions"] == 0
    assert refusal[-1]["state"] == "refused"

    execution = cases["tool-execute-result"]["events"]
    assert evidence["tool-execute-result"]["executions"] == 1
    assert (
        evidence["tool-execute-result"]["projected_call_id"]
        == evidence["tool-execute-result"]["projected_result_call_id"]
    )
    assert {event["subject"] for event in execution} == {"call-2"}
