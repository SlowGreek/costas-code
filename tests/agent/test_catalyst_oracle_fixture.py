"""Contract tests for the content-addressed Costas-owned Catalyst F0 oracle."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "catalyst_oracle"
CASE_KEYS = {
    "authority_exclusions",
    "availability",
    "events",
    "expected",
    "family",
    "id",
    "source_anchors",
}
EVENT_KEYS = {"code", "kind", "partition", "ref", "seq", "state", "subject", "text"}
EXPECTED_KEYS = {"final_state", "observable", "refusal"}
FAMILIES = {"control", "fault", "runtime", "session", "tool", "turn", "ui"}
FORBIDDEN_KEYS = {
    "authorization",
    "capability_token",
    "chain_of_thought",
    "credentials",
    "environment",
    "provider_id",
    "reasoning",
}
MANIFEST_KEYS = {
    "aggregate_sha256",
    "artifacts",
    "authority",
    "canonicalization",
    "coverage",
    "feedforward_sha256",
    "f0c1_feedforward_sha256",
    "generation",
    "mechanical_capture",
    "oracle_schema",
    "reducer_inputs",
    "schema",
    "source_revision",
    "sources",
    "unavailable_cells",
}
MECHANICAL_KEYS = {"artifacts", "cases", "schema", "sources"}
MECHANICAL_CASE_KEYS = {"artifact", "family", "residual", "status"}
REDUCER_KEYS = {
    "artifact",
    "artifact_sha256",
    "cases",
    "family_artifacts",
    "f0c_aggregate_sha256",
    "mutation_receipt",
    "schema",
    "sources",
}
REDUCER_CASE_KEYS = {
    "disposition",
    "family",
    "family_artifact",
    "input_artifact",
    "residual",
}
REDUCER_FAMILY_ARTIFACTS = {
    "captured/reducer-inputs/control.json",
    "captured/reducer-inputs/fault.json",
    "captured/reducer-inputs/runtime.json",
    "captured/reducer-inputs/turn_tool.json",
}
REDUCER_SOURCES = {
    "tests/catalyst_capture/test_control_reducer_inputs.py",
    "tests/catalyst_capture/test_fault_reducer_inputs.py",
    "tests/catalyst_capture/test_reducer_inputs_aggregate.py",
    "tests/catalyst_capture/test_runtime_reducer_inputs.py",
    "tests/catalyst_capture/test_turn_tool_reducer_inputs.py",
}
REDUCED_CASES = {
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
EXTERNAL_CASES = {
    "session-compression-lineage",
    "session-create",
    "session-visible-branch",
    "ui-background-invariants",
    "ui-cancel-pane-invariants",
}
MECHANICAL_ARTIFACTS = {
    "captured/control_runtime.json",
    "captured/session.json",
    "captured/turn_tool.json",
    "captured/ui.json",
}
MECHANICAL_SOURCES = {
    "apps/desktop/src/catalyst/__tests__/mechanical-capture.test.ts",
    "tests/catalyst_capture/test_control_runtime_capture.py",
    "tests/catalyst_capture/test_mechanical_oracle.py",
    "tests/catalyst_capture/test_session_lineage_capture.py",
    "tests/catalyst_capture/test_turn_tool_capture.py",
}
FAMILY_ARTIFACTS = {
    "control": "captured/control_runtime.json",
    "fault": "tests/catalyst_capture/test_mechanical_oracle.py",
    "runtime": "captured/control_runtime.json",
    "session": "captured/session.json",
    "tool": "captured/turn_tool.json",
    "turn": "captured/turn_tool.json",
    "ui": "captured/ui.json",
}
ANCHOR_RE = re.compile(r"^([^:]+):(\d+)-(\d+)$")


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        assert key not in out, f"duplicate JSON key: {key}"
        out[key] = value
    return out


def _forbid_float(_value: str) -> float:
    raise AssertionError("floats forbidden")


def _forbid_constant(_value: str) -> float:
    raise AssertionError("constants forbidden")


def _load(name: str) -> dict[str, Any]:
    return json.loads(
        (FIXTURES / name).read_text(encoding="utf-8"),
        object_pairs_hook=_pairs,
        parse_constant=_forbid_constant,
        parse_float=_forbid_float,
    )


def _canonical(value: Any) -> bytes:
    serialized = json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return (unicodedata.normalize("NFC", serialized) + "\n").encode("utf-8")


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _walk(value: Any):
    if isinstance(value, dict):
        for key, item in value.items():
            assert key not in FORBIDDEN_KEYS
            assert unicodedata.normalize("NFC", key) == key
            yield key
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)
    elif isinstance(value, str):
        assert unicodedata.normalize("NFC", value) == value
        yield value
    else:
        assert value is None or isinstance(value, (bool, int))


def test_oracle_files_are_canonical_and_bounded() -> None:
    manifest = _load("manifest.json")
    reducer = manifest["reducer_inputs"]
    names = (
        "schema.json",
        "corpus.json",
        "manifest.json",
        *manifest["mechanical_capture"]["artifacts"],
        *reducer["family_artifacts"],
        reducer["artifact"],
    )
    for name in names:
        raw = (FIXTURES / name).read_bytes()
        parsed = _load(name)
        assert raw == _canonical(parsed)
        assert len(raw) <= 262144
    assert manifest["canonicalization"] == "utf8-nfc-sort-keys-compact-lf/1"


def test_manifest_binds_artifacts_sources_revision_and_feedforward() -> None:
    manifest = _load("manifest.json")
    mechanical = manifest["mechanical_capture"]
    reducer = manifest["reducer_inputs"]

    assert set(manifest) == MANIFEST_KEYS
    assert set(mechanical) == MECHANICAL_KEYS
    assert set(reducer) == REDUCER_KEYS
    assert set(mechanical["artifacts"]) == MECHANICAL_ARTIFACTS
    assert set(mechanical["sources"]) == MECHANICAL_SOURCES
    assert reducer["artifact"] == "captured/reducer_inputs.json"
    assert reducer["f0c_aggregate_sha256"] == (
        "e0b029e833d5543877bc10625d3556d8b1b9ef402ae2a31502842cd50d7e5f72"
    )
    assert set(reducer["family_artifacts"]) == REDUCER_FAMILY_ARTIFACTS
    assert set(reducer["sources"]) == REDUCER_SOURCES
    assert re.fullmatch(r"[0-9a-f]{40}", manifest["source_revision"])
    assert manifest["feedforward_sha256"] == (
        "8e4597936d007943363fc59c10e2815172dcf54d5eaf7c60b5c63298cea0bc78"
    )
    assert manifest["f0c1_feedforward_sha256"] == (
        "caa550fbe02e795a6c6bc2c3604bc6f2e73217a14be9d0f10cd136c20aa04183"
    )

    for path, digest in manifest["artifacts"].items():
        assert _digest(FIXTURES / path) == digest
    for path, digest in manifest["sources"].items():
        assert _digest(ROOT / path) == digest
    for path, digest in mechanical["artifacts"].items():
        assert _digest(FIXTURES / path) == digest
    for path, digest in mechanical["sources"].items():
        assert _digest(ROOT / path) == digest
    assert _digest(FIXTURES / reducer["artifact"]) == reducer["artifact_sha256"]
    for path, digest in reducer["family_artifacts"].items():
        assert _digest(FIXTURES / path) == digest
    for path, digest in reducer["sources"].items():
        assert _digest(ROOT / path) == digest

    aggregate = _canonical(
        {
            "artifacts": manifest["artifacts"],
            "mechanical_capture": mechanical,
            "reducer_inputs": reducer,
            "sources": manifest["sources"],
        }
    )
    assert hashlib.sha256(aggregate).hexdigest() == manifest["aggregate_sha256"]


def test_corpus_is_closed_ordered_privacy_partitioned_and_covered() -> None:
    corpus = _load("corpus.json")
    manifest = _load("manifest.json")
    mechanical_cases = manifest["mechanical_capture"]["cases"]

    assert set(corpus) == {
        "bounds",
        "cases",
        "privacy_model",
        "schema",
        "source_revision",
    }
    assert set(corpus["privacy_model"]) == {
        "content-free-control",
        "contract",
        "forbidden",
        "local-pseudonym",
        "private-fixture",
    }

    ids: set[str] = set()
    by_family = {family: [] for family in FAMILIES}
    for case in corpus["cases"]:
        assert set(case) == CASE_KEYS
        assert case["id"] not in ids
        ids.add(case["id"])
        by_family[case["family"]].append(case["id"])
        assert case["family"] in FAMILIES
        assert case["availability"] in {"unavailable", "wired"}
        assert case["authority_exclusions"]
        assert set(case["expected"]) == EXPECTED_KEYS
        assert case["expected"]["observable"]
        if case["availability"] == "unavailable":
            assert not case["events"]
            assert case["expected"]["refusal"]

        for seq, event in enumerate(case["events"]):
            assert set(event) <= EVENT_KEYS
            assert {"kind", "partition", "seq"} <= set(event)
            assert event["seq"] == seq
            assert event["partition"] in {"control", "private"}
            if event["partition"] == "control":
                assert "text" not in event

        for anchor in case["source_anchors"]:
            match = ANCHOR_RE.fullmatch(anchor)
            assert match, anchor
            path = match.group(1)
            lo, hi = int(match.group(2)), int(match.group(3))
            lines = (ROOT / path).read_text(
                encoding="utf-8", errors="replace"
            ).splitlines()
            assert 1 <= lo <= hi <= len(lines)

    assert len(ids) == 19
    assert set(mechanical_cases) == ids
    for case in corpus["cases"]:
        receipt = mechanical_cases[case["id"]]
        assert set(receipt) == MECHANICAL_CASE_KEYS
        assert receipt == {
            "artifact": FAMILY_ARTIFACTS[case["family"]],
            "family": case["family"],
            "residual": case["expected"]["refusal"],
            "status": case["availability"],
        }

    assert {key: sorted(value) for key, value in by_family.items()} == manifest[
        "coverage"
    ]
    unavailable = sorted(
        case["id"]
        for case in corpus["cases"]
        if case["availability"] == "unavailable"
    )
    assert unavailable == manifest["unavailable_cells"]
    assert unavailable == [
        "runtime-close-proof-unavailable",
        "runtime-replay-unavailable",
        "session-resume-unavailable",
    ]
    reducer_cases = manifest["reducer_inputs"]["cases"]
    assert set(reducer_cases) == ids
    for case in corpus["cases"]:
        receipt = reducer_cases[case["id"]]
        assert set(receipt) == REDUCER_CASE_KEYS
        assert receipt["family"] == case["family"]
        assert receipt["residual"] == case["expected"]["refusal"]
        if case["id"] in REDUCED_CASES:
            assert receipt["disposition"] == "reduced"
            assert receipt["family_artifact"] in REDUCER_FAMILY_ARTIFACTS
            assert receipt["input_artifact"] == "captured/reducer_inputs.json"
        elif case["id"] in EXTERNAL_CASES:
            assert receipt["disposition"] == "external"
            assert receipt["family_artifact"] is None
            assert receipt["input_artifact"] is None
        else:
            assert case["id"] in set(unavailable)
            assert receipt["disposition"] == "unavailable"
            assert receipt["family_artifact"] is None
            assert receipt["input_artifact"] is None
    list(_walk(corpus))
    list(_walk(manifest))


def test_oracle_explicitly_excludes_authority_and_private_runtime_material() -> None:
    corpus = _load("corpus.json")
    events = [event for case in corpus["cases"] for event in case["events"]]
    event_blob = json.dumps(events, sort_keys=True).lower()
    for forbidden in (
        "api_key",
        "bearer ",
        "capability_token",
        "chain_of_thought",
        "raw provider id",
    ):
        assert forbidden not in event_blob
    assert "raw provider ids" in corpus["privacy_model"]["forbidden"].lower()
    exclusions = " ".join(
        exclusion
        for case in corpus["cases"]
        for exclusion in case["authority_exclusions"]
    ).lower()
    assert "not product acceptance" in exclusions
    assert "cannot approve" in exclusions or "not consent" in exclusions
