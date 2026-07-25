"""Mechanical F0c.1 reducer inputs for the two Catalyst runtime cases.

The owner fake records prior state at the Codex app-server request seam before
it releases any normalized reducer event. Expected corpus data is deliberately
absent from capture and enters only the post-serialization parity assertions.
"""
from __future__ import annotations

import copy
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional, cast

import pytest

from agent.transports.codex_app_server import CodexAppServerError
from agent.transports.codex_app_server_session import CodexAppServerSession

ROOT = Path(__file__).resolve().parents[2]
CORPUS_PATH = ROOT / "tests/fixtures/catalyst_oracle/corpus.json"
CAPTURE_PATH = (
    ROOT
    / "tests/fixtures/catalyst_oracle/captured/reducer-inputs/runtime.json"
)
CASE_IDS = ("runtime-compaction", "runtime-provider-unavailable")
_EMPTY_PRIOR = {
    "sessions": [],
    "turns": [],
    "snapshots": [],
    "tool_calls": [],
    "controls": [],
}


def _canonical(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


@dataclass
class _CaptureAudit:
    """Fail closed if an event is emitted before its immutable prior bytes."""

    order: list[str] = field(default_factory=list)
    prior_bytes: dict[str, bytes] = field(default_factory=dict)
    events: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    raw_notifications: list[dict[str, Any]] = field(default_factory=list)
    accepted_notification_ids: set[int] = field(default_factory=set)

    def serialize_prior(self, case_id: str, prior: dict[str, Any]) -> None:
        assert case_id not in self.prior_bytes
        self.prior_bytes[case_id] = _canonical(prior)
        self.order.append(f"prior:{case_id}")

    def emit(self, case_id: str, event: dict[str, Any]) -> None:
        assert case_id in self.prior_bytes, "prior must be serialized before events"
        self.events.setdefault(case_id, []).append(copy.deepcopy(event))
        self.order.append(f"event:{case_id}:{event['kind']}")

    def prior(self, case_id: str) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(self.prior_bytes[case_id]))


class _OwnerFakeClient:
    """Codex client owner seam with deterministic pseudonymous observations."""

    def __init__(
        self,
        audit: _CaptureAudit,
        case_id: str,
        *,
        startup_error: bool = False,
    ) -> None:
        self.audit = audit
        self.case_id = case_id
        self.startup_error = startup_error
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.notifications: list[dict[str, Any]] = []
        self.initialized = False
        self.closed = False

    def initialize(self, **_kwargs: Any) -> dict[str, Any]:
        self.initialized = True
        return {"userAgent": "runtime-reducer-owner-fake/1"}

    def request(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        del timeout
        body = copy.deepcopy(params or {})
        self.requests.append((method, body))

        if method == "thread/start" and self.startup_error:
            prior = {
                **copy.deepcopy(_EMPTY_PRIOR),
                "runtimes": [
                    {
                        "adapter": "codex-app-server",
                        "binding_id": "runtime-binding-1",
                        "id": "runtime-1",
                        "start_request_id": "runtime-start-request-1",
                        "state": "start-request-observed",
                    }
                ],
                "compactions": [],
            }
            self.audit.serialize_prior(self.case_id, prior)
            self.audit.emit(
                self.case_id,
                {
                    "binding": "runtime-binding-1",
                    "kind": "runtime.start.request",
                    "partition": "control",
                    "request": "runtime-start-request-1",
                    "seq": 0,
                    "subject": "runtime-1",
                },
            )
            raise CodexAppServerError(
                code=-32603,
                message="model_provider 'synthetic-offline' not configured",
            )

        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}

        if method == "thread/compact/start":
            assert body == {"threadId": "thread-1"}
            prior = {
                **copy.deepcopy(_EMPTY_PRIOR),
                "runtimes": [
                    {
                        "adapter": "codex-app-server",
                        "id": "runtime-1",
                        "state": "active",
                        "thread_id": "thread-1",
                        "thread_start_request_id": "thread-start-request-1",
                    }
                ],
                "compactions": [
                    {
                        "id": "compaction-request-1",
                        "runtime_id": "runtime-1",
                        "state": "request-observed",
                        "thread_id": "thread-1",
                    }
                ],
            }
            self.audit.serialize_prior(self.case_id, prior)
            self.audit.emit(
                self.case_id,
                {
                    "kind": "runtime.compaction.request",
                    "partition": "control",
                    "request": "compaction-request-1",
                    "seq": 0,
                    "subject": "thread-1",
                },
            )
        return {}

    def take_notification(self, timeout: float = 0.0) -> Optional[dict[str, Any]]:
        del timeout
        if not self.notifications:
            return None
        note = self.notifications.pop(0)
        self.audit.raw_notifications.append(note)
        return note

    def take_server_request(self, timeout: float = 0.0) -> None:
        del timeout
        return None

    def respond(self, _request_id: Any, _result: dict[str, Any]) -> None:
        return None

    def respond_error(
        self,
        _request_id: Any,
        _code: int,
        _message: str,
        data: Any = None,
    ) -> None:
        del data
        return None

    def stderr_tail(self, n: int = 20) -> list[str]:
        del n
        return []

    def is_alive(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True

    def queue_notification(self, method: str, **params: Any) -> None:
        self.notifications.append({"method": method, "params": params})


def _session(
    client: _OwnerFakeClient,
    on_event: Optional[Callable[[dict[str, Any]], None]] = None,
) -> CodexAppServerSession:
    return CodexAppServerSession(
        cwd="/workspace",
        client_factory=cast(Any, lambda **_kwargs: client),
        on_event=on_event,
    )


def _source_receipt() -> dict[str, str]:
    return {
        "capture_source": "tests/catalyst_capture/test_runtime_reducer_inputs.py",
        "owner": "CodexAppServerSession fake request seam",
        "owner_fake_source": "tests/agent/transports/test_codex_app_server_session.py",
    }


def _capture_compaction(audit: _CaptureAudit) -> dict[str, Any]:
    case_id = "runtime-compaction"
    client = _OwnerFakeClient(audit, case_id)

    def accepted(note: dict[str, Any]) -> None:
        audit.accepted_notification_ids.add(id(note))
        method = note["method"]
        params = note.get("params") or {}
        if method == "turn/started":
            audit.emit(
                case_id,
                {
                    "kind": "runtime.compaction.started",
                    "partition": "control",
                    "request": "compaction-request-1",
                    "seq": 1,
                    "state": "running",
                    "subject": params["turn"]["id"],
                    "thread": params["threadId"],
                },
            )
        elif method == "item/completed" and params["item"]["type"] == "contextCompaction":
            audit.emit(
                case_id,
                {
                    "item": params["item"]["id"],
                    "kind": "runtime.compaction.completed",
                    "partition": "control",
                    "request": "compaction-request-1",
                    "seq": 2,
                    "state": "completed",
                    "subject": params["turnId"],
                    "thread": params["threadId"],
                },
            )
        elif method == "turn/completed":
            audit.emit(
                case_id,
                {
                    "kind": "runtime.compaction.terminal-candidate",
                    "partition": "control",
                    "request": "compaction-request-1",
                    "seq": 3,
                    "state": params["turn"]["status"],
                    "subject": params["turn"]["id"],
                    "thread": params["threadId"],
                },
            )

    client.queue_notification(
        "turn/started",
        threadId="thread-foreign",
        turn={"id": "compact-turn-foreign"},
    )
    client.queue_notification(
        "turn/completed",
        threadId="thread-1",
        turn={"id": "compact-turn-stale", "status": "completed"},
    )
    client.queue_notification(
        "turn/started",
        threadId="thread-1",
        turn={"id": "compact-turn-1"},
    )
    client.queue_notification(
        "item/completed",
        threadId="thread-1",
        turnId="compact-turn-1",
        item={"type": "contextCompaction", "id": "compact-item-1"},
    )
    client.queue_notification(
        "turn/completed",
        threadId="thread-1",
        turn={"id": "compact-turn-1", "status": "completed"},
    )

    result = _session(client, accepted).compact_thread(
        turn_timeout=0.1,
        notification_poll_timeout=0.0,
    )
    ignored = [
        note
        for note in audit.raw_notifications
        if id(note) not in audit.accepted_notification_ids
    ]
    ignored_evidence = [
        {
            "method": note["method"],
            "reason": (
                "foreign-thread"
                if note["params"].get("threadId") != "thread-1"
                else "pre-start"
            ),
            "thread": note["params"].get("threadId"),
            "turn": (note["params"].get("turn") or {}).get("id"),
        }
        for note in ignored
    ]

    return {
        "disposition": "reduced",
        "events": audit.events[case_id],
        "evidence": {"ignored_observations": ignored_evidence},
        "id": case_id,
        "observation": {
            "compacted": result.compacted,
            "error": result.error,
            "thread": result.thread_id,
            "turn": result.turn_id,
        },
        "prior": audit.prior(case_id),
        "privacy": "synthetic-bounded",
        "source_receipt": _source_receipt(),
    }


def _capture_provider_unavailable(audit: _CaptureAudit) -> dict[str, Any]:
    case_id = "runtime-provider-unavailable"
    client = _OwnerFakeClient(audit, case_id, startup_error=True)
    result = _session(client).run_turn("synthetic request", turn_timeout=0.1)
    error = result.error or ""
    audit.emit(
        case_id,
        {
            "binding": "runtime-binding-1",
            "code": "provider-unavailable",
            "kind": "runtime.unavailable",
            "partition": "control",
            "request": "runtime-start-request-1",
            "seq": 1,
            "state": "failed",
            "subject": "runtime-1",
        },
    )
    return {
        "disposition": "reduced",
        "events": audit.events[case_id],
        "evidence": {"thread_start_request_count": len(client.requests)},
        "id": case_id,
        "observation": {
            "error_rendered": bool(error),
            "final_text_empty": result.final_text == "",
            "provider_not_configured": "not configured" in error,
            "session_retirement_requested": result.should_retire,
        },
        "prior": audit.prior(case_id),
        "privacy": "synthetic-bounded",
        "source_receipt": _source_receipt(),
    }


def capture_runtime_reducer_inputs(
    *,
    audit: Optional[_CaptureAudit] = None,
) -> dict[str, Any]:
    """Capture source observations without opening ``CORPUS_PATH``."""
    recorder = audit or _CaptureAudit()
    return {
        "canonicalization": "utf8-nfc-sort-keys-compact-lf/1",
        "cases": [
            _capture_compaction(recorder),
            _capture_provider_unavailable(recorder),
        ],
        "schema": "costas-catalyst-reducer-inputs/1",
    }


def _contains_key(value: Any, forbidden: str) -> bool:
    if isinstance(value, dict):
        return forbidden in value or any(
            _contains_key(child, forbidden) for child in value.values()
        )
    if isinstance(value, list):
        return any(_contains_key(child, forbidden) for child in value)
    return False


def _project(case: dict[str, Any]) -> tuple[str, Optional[str]]:
    assert case["disposition"] == "reduced"
    assert case["privacy"] == "synthetic-bounded"
    prior = case["prior"]
    assert set(prior) == {
        "sessions",
        "turns",
        "snapshots",
        "tool_calls",
        "controls",
        "runtimes",
        "compactions",
    }
    assert all(prior[name] == [] for name in _EMPTY_PRIOR)
    assert len(prior["runtimes"]) == 1
    runtime = prior["runtimes"][0]
    events = case["events"]
    assert [event["seq"] for event in events] == list(range(len(events)))
    assert all(event["partition"] == "control" for event in events)

    if case["id"] == "runtime-compaction":
        assert runtime["state"] == "active"
        assert runtime["thread_id"]
        assert runtime["thread_start_request_id"]
        assert len(prior["compactions"]) == 1
        request = prior["compactions"][0]
        assert request["state"] == "request-observed"
        assert request["runtime_id"] == runtime["id"]
        assert request["thread_id"] == runtime["thread_id"]
        assert [event["kind"] for event in events] == [
            "runtime.compaction.request",
            "runtime.compaction.started",
            "runtime.compaction.completed",
            "runtime.compaction.terminal-candidate",
        ]
        assert all(event["request"] == request["id"] for event in events)
        assert events[0]["subject"] == runtime["thread_id"]
        turn = events[1]["subject"]
        assert all(event["thread"] == runtime["thread_id"] for event in events[1:])
        assert all(event["subject"] == turn for event in events[1:])
        assert events[1]["state"] == "running"
        assert events[2]["state"] == events[3]["state"] == "completed"
        assert events[2]["item"]
        assert case["evidence"]["ignored_observations"] == [
            {
                "method": "turn/started",
                "reason": "foreign-thread",
                "thread": "thread-foreign",
                "turn": "compact-turn-foreign",
            },
            {
                "method": "turn/completed",
                "reason": "pre-start",
                "thread": runtime["thread_id"],
                "turn": "compact-turn-stale",
            },
        ]
        observation = case["observation"]
        assert observation == {
            "compacted": True,
            "error": None,
            "thread": runtime["thread_id"],
            "turn": turn,
        }
        return "compacted", None

    assert case["id"] == "runtime-provider-unavailable"
    assert prior["compactions"] == []
    assert runtime["state"] == "start-request-observed"
    assert not _contains_key(case, "generation")
    assert [event["kind"] for event in events] == [
        "runtime.start.request",
        "runtime.unavailable",
    ]
    assert all(event["subject"] == runtime["id"] for event in events)
    assert all(event["request"] == runtime["start_request_id"] for event in events)
    assert all(event["binding"] == runtime["binding_id"] for event in events)
    assert events[1]["code"] == "provider-unavailable"
    assert events[1]["state"] == "failed"
    assert case["evidence"] == {"thread_start_request_count": 1}
    assert case["observation"] == {
        "error_rendered": True,
        "final_text_empty": True,
        "provider_not_configured": True,
        "session_retirement_requested": True,
    }
    return "unavailable", "provider-unavailable"


def _validate(captured: dict[str, Any], expected: dict[str, Any]) -> None:
    assert tuple(case["id"] for case in captured["cases"]) == CASE_IDS
    expected_by_id = {case["id"]: case for case in expected["cases"]}
    for case in captured["cases"]:
        final_state, refusal = _project(case)
        oracle = expected_by_id[case["id"]]["expected"]
        assert final_state == oracle["final_state"]
        assert refusal == oracle["refusal"]


class _ExpectedPoison:
    def read_bytes(self, *_args: Any, **_kwargs: Any) -> bytes:
        raise AssertionError("expected data accessed during runtime capture")

    def read_text(self, *_args: Any, **_kwargs: Any) -> str:
        raise AssertionError("expected data accessed during runtime capture")

    def __fspath__(self) -> str:
        raise AssertionError("expected path resolved during runtime capture")


def _rename_pseudonyms(value: Any, renames: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: _rename_pseudonyms(child, renames) for key, child in value.items()}
    if isinstance(value, list):
        return [_rename_pseudonyms(child, renames) for child in value]
    if isinstance(value, str):
        return renames.get(value, value)
    return value


def test_runtime_reducer_inputs_are_canonical_owner_observations() -> None:
    actual = capture_runtime_reducer_inputs()
    raw = CAPTURE_PATH.read_bytes()
    captured = json.loads(raw)

    assert raw == _canonical(captured)
    assert captured == actual
    assert tuple(case["id"] for case in actual["cases"]) == CASE_IDS


def test_prior_is_serialized_before_events_and_expected_is_poisoned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audit = _CaptureAudit()
    monkeypatch.setattr(
        sys.modules[__name__],
        "CORPUS_PATH",
        _ExpectedPoison(),
    )
    actual = capture_runtime_reducer_inputs(audit=audit)
    serialized = _canonical(actual)

    assert serialized
    cases_by_id = {case["id"]: case for case in actual["cases"]}
    for case_id in CASE_IDS:
        case_order = [entry for entry in audit.order if f":{case_id}" in entry]
        assert case_order[0] == f"prior:{case_id}"
        assert case_order[1].endswith("request")
        assert json.loads(audit.prior_bytes[case_id]) == cases_by_id[case_id]["prior"]


def test_runtime_parity_and_independent_mutations_fail() -> None:
    actual = capture_runtime_reducer_inputs()
    expected = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    _validate(actual, expected)

    prior_mutation = copy.deepcopy(actual)
    prior_mutation["cases"][0]["prior"]["runtimes"][0]["state"] = "invented"
    with pytest.raises(AssertionError):
        _validate(prior_mutation, expected)

    event_mutation = copy.deepcopy(actual)
    event_mutation["cases"][0]["events"][2]["kind"] = "runtime.compaction.invented"
    with pytest.raises(AssertionError):
        _validate(event_mutation, expected)

    expected_mutation = copy.deepcopy(expected)
    next(
        case
        for case in expected_mutation["cases"]
        if case["id"] == "runtime-provider-unavailable"
    )["expected"]["final_state"] = "active"
    with pytest.raises(AssertionError):
        _validate(actual, expected_mutation)

    result_mutation = copy.deepcopy(actual)
    result_mutation["cases"][1]["observation"]["final_text_empty"] = False
    with pytest.raises(AssertionError):
        _validate(result_mutation, expected)


def test_runtime_pseudonym_renaming_preserves_semantics_without_generation() -> None:
    actual = capture_runtime_reducer_inputs()
    renamed = _rename_pseudonyms(
        actual,
        {
            "runtime-1": "runtime-9",
            "runtime-binding-1": "runtime-binding-9",
            "runtime-start-request-1": "runtime-start-request-9",
            "thread-start-request-1": "thread-start-request-9",
            "thread-1": "thread-9",
            "compaction-request-1": "compaction-request-9",
            "compact-turn-1": "compact-turn-9",
            "compact-item-1": "compact-item-9",
        },
    )

    assert [_project(case) for case in renamed["cases"]] == [
        ("compacted", None),
        ("unavailable", "provider-unavailable"),
    ]
    assert not _contains_key(renamed, "generation")
