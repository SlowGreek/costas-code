"""Closed F0c.1 aggregate for source-observed Catalyst reducer inputs."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
import unicodedata
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests/fixtures/catalyst_oracle"
AGGREGATE_PATH = FIXTURES / "captured/reducer_inputs.json"
FAMILY_PATHS = {
    "control": "captured/reducer-inputs/control.json",
    "fault": "captured/reducer-inputs/fault.json",
    "runtime": "captured/reducer-inputs/runtime.json",
    "turn_tool": "captured/reducer-inputs/turn_tool.json",
}
FAMILY_SOURCES = {
    "control": "tests/catalyst_capture/test_control_reducer_inputs.py",
    "fault": "tests/catalyst_capture/test_fault_reducer_inputs.py",
    "runtime": "tests/catalyst_capture/test_runtime_reducer_inputs.py",
    "turn_tool": "tests/catalyst_capture/test_turn_tool_reducer_inputs.py",
}
REDUCED_IDS = {
    "control-interrupt-exact",
    "control-stale-foreign-refusal",
    "control-steer-exact",
    "fault-contradictory-terminal",
    "fault-order-bounds",
    "runtime-compaction",
    "runtime-provider-unavailable",
    "tool-approval-refusal",
    "tool-execute-result",
    "tool-snapshot-request",
    "turn-stream-final",
}
EXTERNAL_IDS = {
    "session-compression-lineage",
    "session-create",
    "session-visible-branch",
    "ui-background-invariants",
    "ui-cancel-pane-invariants",
}
UNAVAILABLE_IDS = {
    "runtime-close-proof-unavailable",
    "runtime-replay-unavailable",
    "session-resume-unavailable",
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


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _ExpectedAndFutureDataMustNotBeRead:
    def read_bytes(self, *_args: Any, **_kwargs: Any) -> bytes:
        raise AssertionError("family generation read expected or future fixture data")

    def read_text(self, *_args: Any, **_kwargs: Any) -> str:
        raise AssertionError("family generation read expected or future fixture data")

    def open(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("family generation opened expected or future fixture data")

    def resolve(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("family generation resolved expected or future fixture data")

    def __fspath__(self) -> str:
        raise AssertionError("family generation coerced expected or future fixture data")


def _load_family_modules() -> dict[str, ModuleType]:
    return {
        family: _load_module(f"_catalyst_f0c1_{family}", ROOT / source)
        for family, source in FAMILY_SOURCES.items()
    }


def _fresh_family_observations_expected_blind(
    modules: dict[str, ModuleType],
) -> tuple[dict[str, Any], dict[str, Any]]:
    poison = _ExpectedAndFutureDataMustNotBeRead()
    turn_tool = modules["turn_tool"]
    control = modules["control"]
    runtime = modules["runtime"]
    fault = modules["fault"]

    turn_tool.CORPUS_PATH = poison
    turn_tool.FUTURE_CAPTURE_PATH = poison
    turn_tool.CAPTURE_PATH = poison
    control.CORPUS_PATH = poison
    control.CAPTURE_PATH = poison
    runtime.CORPUS_PATH = poison
    runtime.CAPTURE_PATH = poison
    fault.CORPUS_PATH = poison
    fault.CAPTURE_PATH = poison

    runtime_audit = runtime._CaptureAudit()
    control_capture, control_audits = control.capture_control_reducer_inputs()
    observations = {
        "turn_tool": turn_tool.capture_turn_tool_reducer_inputs(),
        "control": control_capture,
        "runtime": runtime.capture_runtime_reducer_inputs(audit=runtime_audit),
        "fault": fault.capture_fault_observations(),
    }
    audits = {"control": control_audits, "runtime": runtime_audit}
    return observations, audits


def _family_for(case_id: str, family_group: str) -> str:
    if family_group == "turn_tool":
        return "turn" if case_id.startswith("turn-") else "tool"
    return family_group


def _case_receipt_payload(case: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in case.items() if key != "input_sha256"}


def _case_receipt(case: dict[str, Any]) -> str:
    return "sha256:" + _sha256_bytes(_canonical_bytes(_case_receipt_payload(case)))


def _build_aggregate(observations: dict[str, Any]) -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    for family_group in ("turn_tool", "control", "runtime", "fault"):
        for source_case in observations[family_group]["cases"]:
            case = copy.deepcopy(source_case)
            case.setdefault("disposition", "reduced")
            case.setdefault("privacy", "synthetic-bounded")
            case["family"] = _family_for(case["id"], family_group)
            case["source_artifact"] = FAMILY_PATHS[family_group]
            case["input_sha256"] = _case_receipt(case)
            cases.append(case)
    return {
        "bounds": {
            "max_cases": 11,
            "max_events_per_case": 64,
            "max_text_bytes": 4096,
        },
        "canonicalization": "utf8-nfc-sort-keys-compact-lf/1",
        "cases": cases,
        "schema": "costas-catalyst-reducer-inputs/1",
    }


def _assert_receipts(aggregate: dict[str, Any]) -> None:
    for case in aggregate["cases"]:
        assert case["input_sha256"] == _case_receipt(case)


def _assert_no_key(value: Any, forbidden: set[str]) -> None:
    if isinstance(value, dict):
        assert forbidden.isdisjoint(value)
        for nested in value.values():
            _assert_no_key(nested, forbidden)
    elif isinstance(value, list):
        for nested in value:
            _assert_no_key(nested, forbidden)


def _assert_no_control_text(value: Any) -> None:
    if isinstance(value, dict):
        if value.get("partition") == "control":
            assert "text" not in value
        for nested in value.values():
            _assert_no_control_text(nested)
    elif isinstance(value, list):
        for nested in value:
            _assert_no_control_text(nested)


def _turn_tool_projection(case: dict[str, Any]) -> tuple[str, str | None]:
    kinds = [event["kind"] for event in case["events"]]
    prior = case["prior"]
    assert case["disposition"] == "reduced"
    if case["id"] == "turn-stream-final":
        assert prior["sessions"][0]["state"] == "active"
        assert prior["turns"][0]["state"] == "active"
        assert prior["turns"][0]["session_id"] == prior["sessions"][0]["id"]
        assert kinds == [
            "turn.user.accepted",
            "turn.assistant.provisional",
            "turn.assistant.final",
            "turn.runtime.terminal",
        ]
        assert case["events"][-1]["acceptance"] == "candidate-only"
        return "runtime-terminal-candidate", None
    if case["id"] == "tool-snapshot-request":
        snapshot = prior["snapshots"][0]
        assert prior["sessions"][0]["state"] == "active"
        assert prior["tool_calls"] == []
        assert snapshot["definition_hash"] == case["events"][0]["definition_hash"]
        assert snapshot["id"] == case["events"][1]["ref"]
        assert kinds == ["tool.snapshot.frozen", "tool.requested"]
        return "awaiting-consent", None
    if case["id"] == "tool-approval-refusal":
        assert prior["tool_calls"][0]["state"] == "pending-consent"
        assert kinds == ["tool.consent.receipt"]
        assert case["events"][0]["state"] == "refused"
        return "refused", None
    assert case["id"] == "tool-execute-result"
    call = prior["tool_calls"][0]
    assert call["state"] == "admitted"
    assert call["admission"]["externally_observed"] is True
    assert kinds == ["tool.running", "tool.result.reference"]
    assert case["events"][1]["subject"] == call["id"]
    return "completed", None


def _fault_projection(
    case: dict[str, Any],
    fault_module: ModuleType,
) -> tuple[str, str | None]:
    if case["id"] == "fault-order-bounds":
        assert [fault_module._classify_mutation(item) for item in case["mutations"]] == [
            "malformed",
            "reordered",
            "duplicate",
            "stale",
            "gap",
            "oversized",
        ]
        return "unchanged", "invalid-event-order-or-bound"
    assert case["id"] == "fault-contradictory-terminal"
    mutation = case["mutations"][0]
    assert [
        event["state"] for event in mutation["injected_input"]["events"]
    ] == ["completed", "failed"]
    residual = mutation["observed_runtime_residual"]
    assert residual["runtime_stopped_after_first_terminal"] is True
    assert residual["unconsumed_notification_methods"] == ["turn/completed"]
    return "runtime-terminal-candidate", "contradictory-terminal"


def _semantic_projection(
    aggregate: dict[str, Any],
    modules: dict[str, ModuleType],
) -> dict[str, tuple[str, str | None]]:
    projected: dict[str, tuple[str, str | None]] = {}
    for case in aggregate["cases"]:
        if case["family"] in {"turn", "tool"}:
            result = _turn_tool_projection(case)
        elif case["family"] == "control":
            folded = modules["control"]._fold(case)
            result = folded["final_state"], folded["refusal"]
        elif case["family"] == "runtime":
            result = modules["runtime"]._project(case)
        else:
            assert case["family"] == "fault"
            result = _fault_projection(case, modules["fault"])
        assert case["id"] not in projected
        projected[case["id"]] = result
    return projected


def _validate_parity(
    aggregate: dict[str, Any],
    corpus: dict[str, Any],
    modules: dict[str, ModuleType],
) -> None:
    _assert_receipts(aggregate)
    projected = _semantic_projection(aggregate, modules)
    expected = {
        case["id"]: (
            case["expected"]["final_state"],
            case["expected"]["refusal"],
        )
        for case in corpus["cases"]
        if case["id"] in REDUCED_IDS
    }
    assert projected == expected


def _rename(value: Any, mapping: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: _rename(nested, mapping) for key, nested in value.items()}
    if isinstance(value, list):
        return [_rename(nested, mapping) for nested in value]
    if isinstance(value, str):
        return mapping.get(value, value)
    return value


def _refresh_receipts(aggregate: dict[str, Any]) -> None:
    for case in aggregate["cases"]:
        case["input_sha256"] = _case_receipt(case)


def test_reducer_input_aggregate_is_canonical_total_and_expected_blind() -> None:
    modules = _load_family_modules()
    observations, _audits = _fresh_family_observations_expected_blind(modules)
    aggregate = _build_aggregate(observations)
    raw = AGGREGATE_PATH.read_bytes()

    assert raw == _canonical_bytes(aggregate)
    assert raw == _canonical_bytes(_load_json(AGGREGATE_PATH))
    assert aggregate["schema"] == "costas-catalyst-reducer-inputs/1"
    assert aggregate["bounds"]["max_cases"] == len(aggregate["cases"]) == 11
    ids = [case["id"] for case in aggregate["cases"]]
    assert len(ids) == len(set(ids))
    assert set(ids) == REDUCED_IDS
    assert not set(ids).intersection(EXTERNAL_IDS | UNAVAILABLE_IDS)
    assert all(case["disposition"] == "reduced" for case in aggregate["cases"])
    assert all(case["source_artifact"] in FAMILY_PATHS.values() for case in aggregate["cases"])
    _assert_receipts(aggregate)


def test_priors_precede_events_and_are_not_reconstructed_from_later_events() -> None:
    modules = _load_family_modules()
    observations, audits = _fresh_family_observations_expected_blind(modules)

    assert all(
        case["source_receipt"]["prior_serialized_before_events"] is True
        for case in observations["turn_tool"]["cases"]
    )
    assert all(
        order == ["prior", "request", "receipt"]
        for order in audits["control"].values()
    )
    runtime_audit = audits["runtime"]
    for case_id in ("runtime-compaction", "runtime-provider-unavailable"):
        order = [entry for entry in runtime_audit.order if f":{case_id}" in entry]
        assert order[0] == f"prior:{case_id}"
        assert all(entry.startswith("event:") for entry in order[1:])
    for fault_case in observations["fault"]["cases"]:
        for mutation in fault_case["mutations"]:
            assert mutation["prior"]["capture_epoch"] == "before-injected-stream"
            assert mutation["injected_input"]["capture_epoch"] == "after-prior-capture"

    accepted, _ = modules["control"]._capture_steer(
        case_id="control-steer-exact",
        request_id="same-request",
        response_turn_id="turn-1",
        text="synthetic correction",
    )
    rejected, _ = modules["control"]._capture_steer(
        case_id="control-stale-foreign-refusal",
        request_id="same-request",
        response_turn_id="turn-foreign",
        text="synthetic correction",
    )
    assert accepted["prior"] == rejected["prior"]
    assert accepted["events"][1] != rejected["events"][1]
    frozen_prior = copy.deepcopy(accepted["prior"])
    accepted["events"][1]["result"]["turnId"] = "later-mutated"
    assert accepted["prior"] == frozen_prior


def test_prior_event_expected_and_independent_result_mutations_fail() -> None:
    modules = _load_family_modules()
    aggregate = _load_json(AGGREGATE_PATH)
    corpus = _load_json(FIXTURES / "corpus.json")
    _validate_parity(aggregate, corpus, modules)

    prior_mutation = copy.deepcopy(aggregate)
    next(case for case in prior_mutation["cases"] if case["id"] == "turn-stream-final")[
        "prior"
    ]["turns"][0]["state"] = "mutated"
    with pytest.raises(AssertionError):
        _validate_parity(prior_mutation, corpus, modules)

    event_mutation = copy.deepcopy(aggregate)
    next(case for case in event_mutation["cases"] if case["id"] == "tool-execute-result")[
        "events"
    ][0]["kind"] = "tool.invented"
    with pytest.raises(AssertionError):
        _validate_parity(event_mutation, corpus, modules)

    expected_mutation = copy.deepcopy(corpus)
    next(case for case in expected_mutation["cases"] if case["id"] == "runtime-compaction")[
        "expected"
    ]["final_state"] = "mutated"
    with pytest.raises(AssertionError):
        _validate_parity(aggregate, expected_mutation, modules)

    result_mutation = copy.deepcopy(aggregate)
    next(
        case
        for case in result_mutation["cases"]
        if case["id"] == "runtime-provider-unavailable"
    )["observation"]["final_text_empty"] = False
    with pytest.raises(AssertionError):
        _validate_parity(result_mutation, corpus, modules)


def test_pseudonym_renaming_preserves_semantics_and_privacy_boundaries() -> None:
    modules = _load_family_modules()
    aggregate = _load_json(AGGREGATE_PATH)
    original_projection = _semantic_projection(aggregate, modules)
    mapping = {
        "call-1": "call-9",
        "call-2": "call-8",
        "compact-item-1": "compact-item-9",
        "compact-turn-1": "compact-turn-9",
        "compaction-request-1": "compaction-request-9",
        "object-result-1": "object-result-9",
        "runtime-1": "runtime-9",
        "runtime-binding-1": "runtime-binding-9",
        "runtime-start-request-1": "runtime-start-request-9",
        "session-1": "session-9",
        "session-tool-1": "session-tool-9",
        "session-turn-1": "session-turn-9",
        "snapshot-1": "snapshot-9",
        "thread-1": "thread-9",
        "thread-start-request-1": "thread-start-request-9",
        "turn-1": "turn-9",
    }
    renamed = _rename(aggregate, mapping)
    _refresh_receipts(renamed)

    assert renamed != aggregate
    assert _semantic_projection(renamed, modules) == original_projection
    _assert_receipts(renamed)
    _assert_no_control_text(aggregate)
    _assert_no_key(
        aggregate,
        {
            "authorization",
            "capability",
            "capability_token",
            "credentials",
            "expected",
            "final_state",
            "provider_id",
            "raw_provider_id",
        },
    )
    blob = json.dumps(aggregate, ensure_ascii=False, sort_keys=True).lower()
    assert "raw provider" not in blob
    assert "bearer " not in blob
    assert "api_key" not in blob


def test_manifest_binds_family_inputs_sources_mutations_and_new_aggregate() -> None:
    manifest = _load_json(FIXTURES / "manifest.json")
    receipt = manifest["reducer_inputs"]

    assert receipt["schema"] == "costas-catalyst-reducer-input-receipt/1"
    assert receipt["f0c_aggregate_sha256"] == (
        "e0b029e833d5543877bc10625d3556d8b1b9ef402ae2a31502842cd50d7e5f72"
    )
    assert _sha256(AGGREGATE_PATH) == receipt["artifact_sha256"]
    assert receipt["artifact"] == "captured/reducer_inputs.json"
    assert set(receipt["family_artifacts"]) == set(FAMILY_PATHS.values())
    assert set(receipt["sources"]) == {
        *FAMILY_SOURCES.values(),
        "tests/catalyst_capture/test_reducer_inputs_aggregate.py",
    }
    for path, digest in receipt["family_artifacts"].items():
        assert _sha256(FIXTURES / path) == digest
    for path, digest in receipt["sources"].items():
        assert _sha256(ROOT / path) == digest

    dispositions = {
        case_id: case["disposition"] for case_id, case in receipt["cases"].items()
    }
    assert {case_id for case_id, value in dispositions.items() if value == "reduced"} == REDUCED_IDS
    assert {case_id for case_id, value in dispositions.items() if value == "external"} == EXTERNAL_IDS
    assert {
        case_id for case_id, value in dispositions.items() if value == "unavailable"
    } == UNAVAILABLE_IDS
    assert receipt["mutation_receipt"] == {
        "assertions": [
            "prior-mutation-fails",
            "event-mutation-fails",
            "expected-mutation-fails",
            "independent-result-mutation-fails",
            "pseudonym-renaming-preserves-semantics",
            "prior-precedes-events",
            "prior-not-reconstructed-from-later-events",
        ],
        "source": "tests/catalyst_capture/test_reducer_inputs_aggregate.py",
        "status": "wired",
    }

    aggregate_input = _canonical_bytes(
        {
            "artifacts": manifest["artifacts"],
            "mechanical_capture": manifest["mechanical_capture"],
            "reducer_inputs": receipt,
            "sources": manifest["sources"],
        }
    )
    assert _sha256_bytes(aggregate_input) == manifest["aggregate_sha256"]
