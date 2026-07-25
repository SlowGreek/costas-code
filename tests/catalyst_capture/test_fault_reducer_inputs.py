"""Mechanical F0c.1 reducer inputs for the Catalyst fault family.

These captures use the production Codex JSONL parser, notification scope filter,
event projector, and turn terminal loop.  Corpus expectations are read only
after the independently observed prior/input/runtime-residual object has been
serialized.
"""

from __future__ import annotations

import copy
import io
import json
import queue
import sys
import threading
import unicodedata
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from agent.transports.codex_app_server import CodexAppServerClient
from agent.transports.codex_app_server_session import (
    CodexAppServerSession,
    _notification_belongs_to_turn,
)
from agent.transports.codex_event_projector import CodexEventProjector

ROOT = Path(__file__).resolve().parents[2]
ORACLE_DIR = ROOT / "tests" / "fixtures" / "catalyst_oracle"
CORPUS_PATH = ORACLE_DIR / "corpus.json"
CAPTURE_PATH = ORACLE_DIR / "captured" / "reducer-inputs" / "fault.json"
MAX_EVENTS = 64
MAX_TEXT_BYTES = 4096
ORDER_BOUND_REFUSAL = "invalid-event-order-or-bound"
CONTRADICTORY_TERMINAL_REFUSAL = "contradictory-terminal"

PSEUDONYM_RENAMING = {
    "runtime-1": "runtime-9",
    "session-1": "session-9",
    "thread-1": "thread-9",
    "turn-1": "turn-9",
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


class _PriorWireClient:
    """Minimal owner-wire fake with no event stream until the caller injects it."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.notifications: list[dict[str, Any]] = []
        self.closed = False

    def initialize(self, **_kwargs: Any) -> dict[str, str]:
        return {"userAgent": "fault-capture/1"}

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
            return {"turn": {"id": "turn-1"}}
        return {}

    def take_notification(self, timeout: float = 0.0) -> dict[str, Any] | None:
        del timeout
        return self.notifications.pop(0) if self.notifications else None

    def take_server_request(self, timeout: float = 0.0) -> None:
        del timeout
        return None

    def stderr_tail(self, n: int = 20) -> list[str]:
        del n
        return []

    def is_alive(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True


def _new_session(client: _PriorWireClient) -> CodexAppServerSession:
    return CodexAppServerSession(
        cwd="/synthetic",
        client_factory=cast(Any, lambda **_kwargs: client),
    )


def _capture_prior() -> dict[str, Any]:
    """Observe the live session state before any fault stream is supplied."""
    client = _PriorWireClient()
    session = _new_session(client)
    thread_id = session.ensure_started()
    with session._active_turn_lock:
        session._active_turn_id = "turn-1"
        active_turn_id = session._active_turn_id

    assert client.notifications == []
    assert client.requests == [("thread/start", {"cwd": "/synthetic"})]
    return {
        "capture_epoch": "before-injected-stream",
        "compactions": [],
        "controls": [],
        "next_seq": 0,
        "runtimes": [
            {
                "active_turn": active_turn_id,
                "id": "runtime-1",
                "state": "active",
                "thread": thread_id,
            }
        ],
        "sessions": [{"id": "session-1", "state": "active"}],
        "snapshots": [],
        "tool_calls": [],
        "turns": [
            {
                "id": active_turn_id,
                "session": "session-1",
                "state": "active",
            }
        ],
    }


def _json_line(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _parse_jsonl(lines: list[bytes]) -> tuple[list[dict[str, Any]], list[str]]:
    """Drive the production stdout parser without spawning a process."""
    client = CodexAppServerClient.__new__(CodexAppServerClient)
    cast(Any, client)._proc = SimpleNamespace(stdout=io.BytesIO(b"".join(lines)))
    client._notifications = queue.Queue()
    client._server_requests = queue.Queue()
    client._pending = {}
    client._pending_lock = threading.Lock()
    client._stderr_lines = []
    client._stderr_lock = threading.Lock()
    client._read_stdout()

    notifications: list[dict[str, Any]] = []
    while True:
        note = client.take_notification(timeout=0.0)
        if note is None:
            break
        notifications.append(note)
    return notifications, list(client._stderr_lines)


def _wire_notifications(text: str = "synthetic final") -> list[dict[str, Any]]:
    return [
        {
            "method": "turn/started",
            "params": {
                "threadId": "thread-1",
                "turn": {"id": "turn-1"},
            },
        },
        {
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "message-1",
                    "text": text,
                    "type": "agentMessage",
                },
                "threadId": "thread-1",
                "turnId": "turn-1",
            },
        },
        {
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "status": "completed"},
            },
        },
    ]


def _normalize_notifications(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize only facts observed through Costas filters/projectors."""
    projector = CodexEventProjector()
    events: list[dict[str, Any]] = []
    for note in notes:
        if not _notification_belongs_to_turn(
            note,
            thread_id="thread-1",
            turn_id="turn-1",
        ):
            continue
        method = note.get("method")
        if method == "turn/started":
            events.append(
                {
                    "kind": "turn.runtime.started",
                    "partition": "control",
                    "state": "active",
                    "subject": "turn-1",
                }
            )
            continue

        projection = projector.project(note)
        if projection.final_text is not None:
            events.append(
                {
                    "kind": "turn.assistant.final",
                    "partition": "private",
                    "state": "promoted",
                    "subject": "turn-1",
                    "text": projection.final_text,
                }
            )
        if method == "turn/completed":
            turn = (note.get("params") or {}).get("turn") or {}
            events.append(
                {
                    "kind": "turn.runtime.terminal",
                    "partition": "control",
                    "state": str(turn.get("status") or "unknown"),
                    "subject": "turn-1",
                }
            )
    return [{**event, "seq": seq} for seq, event in enumerate(events)]


def _runtime_residual(lines: list[bytes]) -> dict[str, Any]:
    parsed, diagnostics = _parse_jsonl(lines)
    normalized = _normalize_notifications(parsed)
    return {
        "accepted_notification_count": len(parsed),
        "diagnostic_classes": [
            "non-json-stdout" if line.startswith("<non-json on stdout>") else "reader-error"
            for line in diagnostics
        ],
        "normalized_event_count": len(normalized),
        "normalized_kinds": [event["kind"] for event in normalized],
        "runtime_sequence_field_available": any("seq" in note for note in parsed),
    }


def _injected(events: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "capture_epoch": "after-prior-capture",
        "events": events,
        "format": "normalized-events",
    }


def _capture_prior_after_prefix(
    prior: dict[str, Any],
    prefix_lines: list[bytes],
) -> dict[str, Any]:
    """Advance only the sequence cursor from an earlier owner-observed prefix."""
    parsed, diagnostics = _parse_jsonl(prefix_lines)
    assert diagnostics == []
    prefix = _normalize_notifications(parsed)
    assert [event["seq"] for event in prefix] == list(range(len(prefix)))

    captured = copy.deepcopy(prior)
    captured["captured_prefix_event_count"] = len(prefix)
    captured["next_seq"] = len(prefix)
    return captured


def _order_bound_mutations(prior: dict[str, Any]) -> list[dict[str, Any]]:
    raw = [_json_line(note) for note in _wire_notifications()]
    parsed, diagnostics = _parse_jsonl(raw)
    assert diagnostics == []
    base = _normalize_notifications(parsed)
    assert [event["seq"] for event in base] == [0, 1, 2]

    malformed_event = copy.deepcopy(base[0])
    del malformed_event["kind"]
    malformed_raw = [b'{"method":"turn/started"\n']

    reordered_raw = [raw[1], raw[0], raw[2]]
    duplicate_raw = [raw[0], raw[0], raw[1], raw[2]]
    oversized_raw = [_json_line(note) for note in _wire_notifications("x" * (MAX_TEXT_BYTES + 1))]
    oversized_parsed, oversized_diagnostics = _parse_jsonl(oversized_raw)
    assert oversized_diagnostics == []
    oversized_events = _normalize_notifications(oversized_parsed)

    stale_prior = _capture_prior_after_prefix(prior, [raw[0]])

    mutations = [
        {
            "expected_fold_refusal_ref": "fault-order-bounds",
            "id": "malformed",
            "injected_input": _injected([malformed_event]),
            "observed_runtime_residual": _runtime_residual(malformed_raw),
            "prior": copy.deepcopy(prior),
        },
        {
            "expected_fold_refusal_ref": "fault-order-bounds",
            "id": "reordered",
            "injected_input": _injected([base[1], base[0], base[2]]),
            "observed_runtime_residual": _runtime_residual(reordered_raw),
            "prior": copy.deepcopy(prior),
        },
        {
            "expected_fold_refusal_ref": "fault-order-bounds",
            "id": "duplicate",
            "injected_input": _injected([base[0], base[0], base[1], base[2]]),
            "observed_runtime_residual": _runtime_residual(duplicate_raw),
            "prior": copy.deepcopy(prior),
        },
        {
            "expected_fold_refusal_ref": "fault-order-bounds",
            "id": "stale",
            "injected_input": _injected([base[0]]),
            "observed_runtime_residual": _runtime_residual([raw[0]]),
            "prior": stale_prior,
        },
        {
            "expected_fold_refusal_ref": "fault-order-bounds",
            "id": "gap",
            "injected_input": _injected([base[0], base[2]]),
            "observed_runtime_residual": _runtime_residual([raw[0], raw[2]]),
            "prior": copy.deepcopy(prior),
        },
        {
            "expected_fold_refusal_ref": "fault-order-bounds",
            "id": "oversized",
            "injected_input": _injected(oversized_events),
            "observed_runtime_residual": _runtime_residual(oversized_raw),
            "prior": copy.deepcopy(prior),
        },
    ]
    return mutations


def _contradictory_terminal_mutation(prior: dict[str, Any]) -> dict[str, Any]:
    first = {
        "method": "turn/completed",
        "params": {
            "threadId": "thread-1",
            "turn": {"id": "turn-1", "status": "completed"},
        },
    }
    second = {
        "method": "turn/completed",
        "params": {
            "threadId": "thread-1",
            "turn": {"id": "turn-1", "status": "failed"},
        },
    }

    client = _PriorWireClient()
    session = _new_session(client)
    session.ensure_started()
    with session._active_turn_lock:
        session._active_turn_id = "turn-1"
    assert client.notifications == []
    captured_prior = _capture_session_state(session, prior)
    client.notifications.extend([first, second])
    result = session.run_turn(
        "synthetic request",
        turn_timeout=0.1,
        notification_poll_timeout=0.0,
    )

    stream = _normalize_notifications([first, second])
    return {
        "expected_fold_refusal_ref": "fault-contradictory-terminal",
        "id": "contradictory-terminal",
        "injected_input": _injected(stream),
        "observed_runtime_residual": {
            "first_terminal_state": "completed",
            "result_error": result.error,
            "runtime_stopped_after_first_terminal": len(client.notifications) == 1,
            "unconsumed_notification_methods": [
                str(note.get("method")) for note in client.notifications
            ],
        },
        "prior": captured_prior,
    }


def _capture_session_state(
    session: CodexAppServerSession,
    prior_template: dict[str, Any],
) -> dict[str, Any]:
    """Capture the same prior shape from the exact session used by the stream."""
    prior = copy.deepcopy(prior_template)
    prior["runtimes"][0]["thread"] = session._thread_id
    prior["runtimes"][0]["active_turn"] = session._active_turn_id
    prior["turns"][0]["id"] = session._active_turn_id
    return prior


def capture_fault_observations() -> dict[str, Any]:
    """Capture prior/input/residual facts without opening expected corpus data."""
    prior = _capture_prior()
    observed = {
        "bounds": {
            "max_events_per_case": MAX_EVENTS,
            "max_text_bytes": MAX_TEXT_BYTES,
        },
        "cases": [
            {
                "id": "fault-order-bounds",
                "mutations": _order_bound_mutations(prior),
            },
            {
                "id": "fault-contradictory-terminal",
                "mutations": [_contradictory_terminal_mutation(prior)],
            },
        ],
        "generation": {
            "expected_data_access": "forbidden-during-observation",
            "network": False,
            "provider": False,
            "real_tool_execution": False,
        },
        "schema": "costas-catalyst-fault-reducer-inputs/1",
    }
    # The serialized observation boundary exists before expected refusal data is
    # permitted to enter the artifact-building path.
    _canonical_bytes(observed)
    return observed


def _expected_fold_refusals() -> dict[str, str]:
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    return {
        case["id"]: case["expected"]["refusal"]
        for case in corpus["cases"]
        if case["id"] in {"fault-order-bounds", "fault-contradictory-terminal"}
    }


def build_fault_artifact() -> dict[str, Any]:
    observed = capture_fault_observations()
    expected = _expected_fold_refusals()
    assert expected == {
        "fault-contradictory-terminal": CONTRADICTORY_TERMINAL_REFUSAL,
        "fault-order-bounds": ORDER_BOUND_REFUSAL,
    }
    return {
        **observed,
        "expected_fold_refusals": expected,
        "generation": {
            **observed["generation"],
            "expected_data_access": "after-observation-serialization-only",
        },
        "pseudonym_renaming": {
            "mapping": PSEUDONYM_RENAMING,
            "semantics_preserved": True,
        },
    }


def _classify_mutation(mutation: dict[str, Any]) -> str:
    events = mutation["injected_input"]["events"]
    if any(not {"kind", "partition", "seq"} <= set(event) for event in events):
        return "malformed"
    if any(len(event.get("text", "").encode("utf-8")) > MAX_TEXT_BYTES for event in events):
        return "oversized"

    seqs = [event["seq"] for event in events]
    cursor = mutation["prior"]["next_seq"]
    if len(seqs) != len(set(seqs)):
        return "duplicate"
    if seqs and sorted(seqs) == list(range(cursor, cursor + len(seqs))) and seqs != sorted(seqs):
        return "reordered"
    if seqs and max(seqs) < cursor:
        return "stale"
    if seqs != list(range(cursor, cursor + len(seqs))):
        return "gap"
    raise AssertionError("mutation did not violate an order/bound condition")


def _rename_pseudonyms(value: Any, mapping: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: _rename_pseudonyms(item, mapping) for key, item in value.items()}
    if isinstance(value, list):
        return [_rename_pseudonyms(item, mapping) for item in value]
    if isinstance(value, str):
        return mapping.get(value, value)
    return value


def _semantic_signature(value: Any, pseudonyms: dict[str, str]) -> bytes:
    roles = {
        pseudonym: f"<{pseudonym.split('-', 1)[0]}>"
        for pseudonym in pseudonyms
    }
    return _canonical_bytes(_rename_pseudonyms(value, roles))


class _ExpectedDataMustNotBeRead:
    def read_text(self, *_args: Any, **_kwargs: Any) -> str:
        raise AssertionError("expected corpus accessed during fault generation")


def test_fault_reducer_inputs_are_mechanical_canonical_and_expected_hidden(
    monkeypatch: Any,
) -> None:
    monkeypatch.setattr(sys.modules[__name__], "CORPUS_PATH", _ExpectedDataMustNotBeRead())
    observed = capture_fault_observations()
    assert "expected_fold_refusals" not in observed
    assert _canonical_bytes(observed)

    monkeypatch.undo()
    actual = build_fault_artifact()
    raw = CAPTURE_PATH.read_bytes()
    assert raw == _canonical_bytes(actual)
    assert json.loads(raw) == actual


def test_each_injected_fault_is_distinct_and_separate_from_expected_and_residual() -> None:
    artifact = build_fault_artifact()
    cases = {case["id"]: case for case in artifact["cases"]}
    order_mutations = cases["fault-order-bounds"]["mutations"]

    assert [_classify_mutation(mutation) for mutation in order_mutations] == [
        "malformed",
        "reordered",
        "duplicate",
        "stale",
        "gap",
        "oversized",
    ]
    mutation_inputs = {
        _canonical_bytes({"prior": mutation["prior"], "input": mutation["injected_input"]})
        for mutation in order_mutations
    }
    assert len(mutation_inputs) == len(order_mutations)

    for case in artifact["cases"]:
        for mutation in case["mutations"]:
            assert mutation["prior"]["capture_epoch"] == "before-injected-stream"
            assert mutation["injected_input"]["capture_epoch"] == "after-prior-capture"
            assert set(mutation) == {
                "expected_fold_refusal_ref",
                "id",
                "injected_input",
                "observed_runtime_residual",
                "prior",
            }
            assert mutation["expected_fold_refusal_ref"] == case["id"]
            assert all(
                not str(event.get("kind", "")).startswith("fault.")
                for event in mutation["injected_input"]["events"]
            )
            assert "expected_fold_refusal" not in mutation["injected_input"]
            assert "expected_fold_refusal" not in mutation["observed_runtime_residual"]

    assert order_mutations[0]["observed_runtime_residual"] == {
        "accepted_notification_count": 0,
        "diagnostic_classes": ["non-json-stdout"],
        "normalized_event_count": 0,
        "normalized_kinds": [],
        "runtime_sequence_field_available": False,
    }
    contradictory = cases["fault-contradictory-terminal"]["mutations"][0]
    assert [event["state"] for event in contradictory["injected_input"]["events"]] == [
        "completed",
        "failed",
    ]
    assert contradictory["observed_runtime_residual"] == {
        "first_terminal_state": "completed",
        "result_error": None,
        "runtime_stopped_after_first_terminal": True,
        "unconsumed_notification_methods": ["turn/completed"],
    }


def test_valid_pseudonym_renaming_preserves_fault_stream_semantics() -> None:
    artifact = build_fault_artifact()
    semantic_input = {
        "bounds": artifact["bounds"],
        "cases": artifact["cases"],
        "expected_fold_refusals": artifact["expected_fold_refusals"],
    }
    renamed = _rename_pseudonyms(semantic_input, PSEUDONYM_RENAMING)

    all_original = set(PSEUDONYM_RENAMING)
    assert not all_original.intersection(json.dumps(renamed, sort_keys=True).split('"'))
    assert _semantic_signature(semantic_input, PSEUDONYM_RENAMING) == _semantic_signature(
        renamed,
        {renamed_id: renamed_id for renamed_id in PSEUDONYM_RENAMING.values()},
    )

    renamed_cases = {case["id"]: case for case in renamed["cases"]}
    assert [
        _classify_mutation(mutation)
        for mutation in renamed_cases["fault-order-bounds"]["mutations"]
    ] == ["malformed", "reordered", "duplicate", "stale", "gap", "oversized"]
