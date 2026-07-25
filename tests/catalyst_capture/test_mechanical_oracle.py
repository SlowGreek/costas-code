"""Aggregate contract for the Costas F0c mechanical Catalyst oracle."""

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
FIXTURES = ROOT / "tests" / "fixtures" / "catalyst_oracle"
AGGREGATE_TEST = "tests/catalyst_capture/test_mechanical_oracle.py"
FAMILY_ARTIFACTS = {
    "control": "captured/control_runtime.json",
    "fault": AGGREGATE_TEST,
    "runtime": "captured/control_runtime.json",
    "session": "captured/session.json",
    "tool": "captured/turn_tool.json",
    "turn": "captured/turn_tool.json",
    "ui": "captured/ui.json",
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


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_capture_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _ExpectedDataMustNotBeRead:
    def read_text(self, *_args: Any, **_kwargs: Any) -> str:
        raise AssertionError("capture attempted to read corpus expectations")

    def read_bytes(self, *_args: Any, **_kwargs: Any) -> bytes:
        raise AssertionError("capture attempted to read corpus expectations")


def _fresh_python_captures_without_expected_data(tmp_path: Path) -> dict[str, Any]:
    modules = {
        "session": _load_capture_module(
            "_catalyst_session_capture",
            ROOT / "tests/catalyst_capture/test_session_lineage_capture.py",
        ),
        "turn_tool": _load_capture_module(
            "_catalyst_turn_tool_capture",
            ROOT / "tests/catalyst_capture/test_turn_tool_capture.py",
        ),
        "control_runtime": _load_capture_module(
            "_catalyst_control_runtime_capture",
            ROOT / "tests/catalyst_capture/test_control_runtime_capture.py",
        ),
    }
    poison = _ExpectedDataMustNotBeRead()
    setattr(modules["session"], "CORPUS_PATH", poison)
    setattr(modules["turn_tool"], "CORPUS_PATH", poison)
    setattr(modules["control_runtime"], "ORACLE_PATH", poison)

    return {
        "captured/control_runtime.json": modules[
            "control_runtime"
        ].capture_control_runtime(),
        "captured/session.json": modules["session"].capture_session_lineage(
            tmp_path / "session"
        ),
        "captured/turn_tool.json": modules["turn_tool"]._capture_all(),
    }


def _turn_tool_final_state(events: list[dict[str, Any]]) -> str:
    kinds = [event["kind"] for event in events]
    last = events[-1]
    if last["kind"] == "turn.runtime.terminal":
        return "runtime-terminal-candidate"
    if last["kind"] == "tool.consent.receipt" and last.get("state") == "refused":
        return "refused"
    if last["kind"] == "tool.result.reference" and last.get("state") == "completed":
        return "completed"
    if kinds == ["tool.snapshot.frozen", "tool.requested"]:
        return "awaiting-consent"
    raise AssertionError(f"unrecognized turn/tool observation: {kinds}")


def _observations(captures: dict[str, Any]) -> dict[str, dict[str, Any]]:
    observed: dict[str, dict[str, Any]] = {}

    for case in captures["captured/session.json"]["cases"]:
        observed[case["case_id"]] = {
            "artifact": "captured/session.json",
            "availability": case["availability"],
            "final_state": case["final_state"],
            "refusal": case["residual"]["code"] if case["residual"] else None,
        }

    for case in captures["captured/turn_tool.json"]["cases"]:
        observed[case["id"]] = {
            "artifact": "captured/turn_tool.json",
            "availability": "wired",
            "final_state": _turn_tool_final_state(case["events"]),
            "refusal": None,
        }

    for case in captures["captured/control_runtime.json"]["cases"]:
        if case["id"] == "session-resume-unavailable":
            continue
        observed[case["id"]] = {
            "artifact": "captured/control_runtime.json",
            "availability": case["availability"],
            "final_state": case["final_state"],
            "refusal": case["refusal"],
        }

    for case_id, case in captures["captured/ui.json"]["cases"].items():
        observed[case_id] = {
            "artifact": "captured/ui.json",
            "availability": case["availability"],
            "final_state": case["finalState"],
            "refusal": None,
        }

    return observed


def _assert_no_control_text(value: Any) -> None:
    if isinstance(value, dict):
        if value.get("partition") == "control":
            assert "text" not in value
        for item in value.values():
            _assert_no_control_text(item)
    elif isinstance(value, list):
        for item in value:
            _assert_no_control_text(item)


def _validate_case_contract(
    corpus: dict[str, Any],
    manifest: dict[str, Any],
    captures: dict[str, Any],
) -> None:
    corpus_cases = {case["id"]: case for case in corpus["cases"]}
    case_receipts = manifest["mechanical_capture"]["cases"]
    observed = _observations(captures)

    assert set(case_receipts) == set(corpus_cases)
    assert set(observed) == {
        case_id
        for case_id, case in corpus_cases.items()
        if case["family"] != "fault"
    }

    for case_id, expected in corpus_cases.items():
        receipt = case_receipts[case_id]
        assert set(receipt) == {"artifact", "family", "residual", "status"}
        assert receipt["artifact"] == FAMILY_ARTIFACTS[expected["family"]]
        assert receipt["family"] == expected["family"]
        assert receipt["status"] == expected["availability"]
        assert receipt["residual"] == expected["expected"]["refusal"]

        if expected["family"] == "fault":
            continue
        actual = observed[case_id]
        assert actual["artifact"] == receipt["artifact"]
        assert actual["availability"] == expected["availability"]
        assert actual["final_state"] == expected["expected"]["final_state"]
        assert actual["refusal"] == expected["expected"]["refusal"]


def test_aggregate_mechanical_oracle_is_closed_and_mutation_resistant(
    tmp_path: Path,
) -> None:
    # Run every Python family capture with an object that fails if expected corpus
    # data is read. The UI family intentionally stays in Vitest and is admitted
    # here only through its exact artifact/source receipt.
    fresh_python = _fresh_python_captures_without_expected_data(tmp_path)
    captures = {
        path: _load_json(FIXTURES / path)
        for path in (
            "captured/control_runtime.json",
            "captured/session.json",
            "captured/turn_tool.json",
            "captured/ui.json",
        )
    }
    for path, fresh in fresh_python.items():
        assert _canonical_bytes(fresh) == (FIXTURES / path).read_bytes()

    # Expectations are loaded only after independent capture has completed.
    corpus = _load_json(FIXTURES / "corpus.json")
    manifest = _load_json(FIXTURES / "manifest.json")
    mechanical = manifest["mechanical_capture"]

    assert set(mechanical) == {"artifacts", "cases", "schema", "sources"}
    assert mechanical["schema"] == "costas-catalyst-mechanical-capture/1"
    assert len(mechanical["cases"]) == len(corpus["cases"]) == 19

    for path, digest in mechanical["artifacts"].items():
        artifact = FIXTURES / path
        assert _sha256(artifact) == digest
        assert artifact.read_bytes() == _canonical_bytes(_load_json(artifact))
    for path, digest in mechanical["sources"].items():
        assert _sha256(ROOT / path) == digest

    _validate_case_contract(corpus, manifest, captures)
    _assert_no_control_text(corpus)
    for capture in captures.values():
        _assert_no_control_text(capture)

    expected_mutation = copy.deepcopy(corpus)
    expected_mutation["cases"][0]["expected"]["final_state"] = "mutated-state"
    with pytest.raises(AssertionError):
        _validate_case_contract(expected_mutation, manifest, captures)

    observed_mutation = copy.deepcopy(captures)
    observed_mutation["captured/session.json"]["cases"][1][
        "final_state"
    ] = "mutated-state"
    with pytest.raises(AssertionError):
        _validate_case_contract(corpus, manifest, observed_mutation)
