"""Mechanical Catalyst capture for SessionDB session-lineage semantics."""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from typing import Any, Callable

from hermes_state import SessionDB


TESTS_DIR = Path(__file__).resolve().parents[1]
CORPUS_PATH = TESTS_DIR / "fixtures" / "catalyst_oracle" / "corpus.json"
CAPTURE_PATH = (
    TESTS_DIR / "fixtures" / "catalyst_oracle" / "captured" / "session.json"
)
SESSION_CASE_IDS = {
    "session-create",
    "session-resume-unavailable",
    "session-visible-branch",
    "session-compression-lineage",
}


def _canonical_bytes(value: Any) -> bytes:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return (unicodedata.normalize("NFC", serialized) + "\n").encode("utf-8")


def _listed_session_ids(db: SessionDB) -> list[str]:
    rows = db.list_sessions_rich(
        limit=20,
        project_compression_tips=False,
        compact_rows=True,
    )
    return sorted(row["id"] for row in rows)


def _capture_session_create(db_path: Path) -> dict[str, Any]:
    db = SessionDB(db_path=db_path)
    try:
        created_id = db.create_session(
            "session-1",
            source="cli",
            cwd="/work/catalyst",
            git_repo_root="/work/catalyst",
        )
        row = db.get_session(created_id)
        assert row is not None
        active = row["ended_at"] is None
        return {
            "availability": "wired",
            "case_id": "session-create",
            "final_state": "active" if active else "ended",
            "observation": {
                "created_id": created_id,
                "lineage_root_id": db.get_conversation_root(created_id),
                "listable_session_ids": _listed_session_ids(db),
                "parent_session_id": row["parent_session_id"],
                "source": row["source"],
            },
            "residual": None,
        }
    finally:
        db.close()


def _capture_visible_branch(db_path: Path) -> dict[str, Any]:
    db = SessionDB(db_path=db_path)
    try:
        db.create_session("session-1", source="cli")
        db.end_session("session-1", "branched")
        db.create_session(
            "session-2",
            source="cli",
            parent_session_id="session-1",
            model_config={"_branched_from": "session-1"},
        )

        parent = db.get_session("session-1")
        child = db.get_session("session-2")
        assert parent is not None and child is not None
        active_child = child["ended_at"] is None
        return {
            "availability": "wired",
            "case_id": "session-visible-branch",
            "final_state": "active-child" if active_child else "ended-child",
            "observation": {
                "child_id": child["id"],
                "child_parent_session_id": child["parent_session_id"],
                "lineage_root_id": db.get_conversation_root(child["id"]),
                "listable_session_ids": _listed_session_ids(db),
                "parent_end_reason": parent["end_reason"],
                "parent_present": db.get_session(parent["id"]) is not None,
            },
            "residual": None,
        }
    finally:
        db.close()


def _capture_compression_lineage(db_path: Path) -> dict[str, Any]:
    db = SessionDB(db_path=db_path)
    try:
        db.create_session(
            "session-1",
            source="cli",
            cwd="/work/catalyst",
            git_repo_root="/work/catalyst",
        )
        db.update_session_cwd(
            "session-1",
            "/work/catalyst",
            git_branch="users/example/catalyst",
            git_repo_root="/work/catalyst",
        )
        db.end_session("session-1", "compression")
        db.create_session(
            "session-3",
            source="cli",
            parent_session_id="session-1",
        )

        parent = db.get_session("session-1")
        successor = db.get_session("session-3")
        assert parent is not None and successor is not None
        active_successor = successor["ended_at"] is None
        return {
            "availability": "wired",
            "case_id": "session-compression-lineage",
            "final_state": (
                "active-successor" if active_successor else "ended-successor"
            ),
            "observation": {
                "lineage_session_ids": db.get_compression_lineage("session-3"),
                "parent_end_reason": parent["end_reason"],
                "successor_id": successor["id"],
                "successor_parent_session_id": successor["parent_session_id"],
                "successor_source": successor["source"],
                "workspace_origin": {
                    "cwd": successor["cwd"],
                    "git_branch": successor["git_branch"],
                    "git_repo_root": successor["git_repo_root"],
                },
            },
            "residual": None,
        }
    finally:
        db.close()


def _capture_resume_unavailable(db_path: Path) -> dict[str, Any]:
    """Capture only what SessionDB can prove; do not synthesize runtime resume."""
    db = SessionDB(db_path=db_path)
    try:
        claimed_id = "provider-session-missing"
        before_ids = _listed_session_ids(db)
        claimed_row = db.get_session(claimed_id)
        after_ids = _listed_session_ids(db)
        return {
            "availability": "unavailable",
            "case_id": "session-resume-unavailable",
            "final_state": "unavailable",
            "observation": {
                "claimed_session_found": claimed_row is not None,
                "claimed_session_id": claimed_id,
                "replacement_session_ids": sorted(set(after_ids) - set(before_ids)),
                "session_ids_after_probe": after_ids,
            },
            "residual": {
                "code": "resume-unavailable",
                "reason": (
                    "SessionDB can prove that the claimed id is absent but cannot "
                    "mechanically resume an exact provider thread."
                ),
            },
        }
    finally:
        db.close()


def capture_session_lineage(tmp_path: Path) -> dict[str, Any]:
    """Drive independent temporary SessionDBs and normalize their observations."""
    cases = [
        _capture_session_create(tmp_path / "create.db"),
        _capture_resume_unavailable(tmp_path / "resume.db"),
        _capture_visible_branch(tmp_path / "branch.db"),
        _capture_compression_lineage(tmp_path / "compression.db"),
    ]
    return {
        "cases": sorted(cases, key=lambda case: case["case_id"]),
        "format": "catalyst-session-capture/1",
    }


def _oracle_session_cases() -> dict[str, dict[str, Any]]:
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    return {
        case["id"]: case
        for case in corpus["cases"]
        if case["id"] in SESSION_CASE_IDS
    }


def test_session_lineage_capture_matches_canonical_fixture(tmp_path: Path) -> None:
    actual = capture_session_lineage(tmp_path)
    fixture_bytes = CAPTURE_PATH.read_bytes()

    assert fixture_bytes == _canonical_bytes(json.loads(fixture_bytes))
    assert _canonical_bytes(actual) == fixture_bytes


def test_session_lineage_capture_matches_oracle_semantics(tmp_path: Path) -> None:
    capture = capture_session_lineage(tmp_path)
    actual = {case["case_id"]: case for case in capture["cases"]}
    oracle = _oracle_session_cases()

    assert set(actual) == SESSION_CASE_IDS
    assert set(oracle) == SESSION_CASE_IDS
    for case_id in sorted(SESSION_CASE_IDS):
        observed_case = actual[case_id]
        oracle_case = oracle[case_id]
        assert observed_case["availability"] == oracle_case["availability"]
        assert observed_case["final_state"] == oracle_case["expected"]["final_state"]
        residual = observed_case["residual"]
        observed_refusal = residual["code"] if residual is not None else None
        assert observed_refusal == oracle_case["expected"]["refusal"]

    semantic_checks: dict[str, Callable[[dict[str, Any]], bool]] = {
        "one root session": lambda case: case["observation"][
            "listable_session_ids"
        ]
        == ["session-1"],
        "source and lineage retained": lambda case: (
            case["observation"]["source"] == "cli"
            and case["observation"]["parent_session_id"] is None
            and case["observation"]["lineage_root_id"] == "session-1"
        ),
        "no replacement thread is synthesized": lambda case: (
            not case["observation"]["claimed_session_found"]
            and case["observation"]["replacement_session_ids"] == []
            and case["observation"]["session_ids_after_probe"] == []
        ),
        "branch child remains listable": lambda case: (
            "session-2" in case["observation"]["listable_session_ids"]
        ),
        "parent retained": lambda case: (
            case["observation"]["parent_present"]
            and case["observation"]["child_parent_session_id"] == "session-1"
            and case["observation"]["lineage_root_id"] == "session-1"
        ),
        "compression child preserves lineage and inherited workspace origin": (
            lambda case: (
                case["observation"]["lineage_session_ids"]
                == ["session-1", "session-3"]
                and case["observation"]["successor_parent_session_id"]
                == "session-1"
                and case["observation"]["successor_source"] == "cli"
                and case["observation"]["workspace_origin"]
                == {
                    "cwd": "/work/catalyst",
                    "git_branch": "users/example/catalyst",
                    "git_repo_root": "/work/catalyst",
                }
            )
        ),
    }

    for case_id, oracle_case in oracle.items():
        for semantic in oracle_case["expected"]["observable"]:
            assert semantic_checks[semantic](actual[case_id]), semantic
