"""Durable, session-scoped research artifacts for GPT Realtime."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from hermes_constants import get_hermes_home

_ARTIFACT_ID_RE = re.compile(r"^research_[0-9a-f]{12}$")
_MAX_RESEARCH_BYTES = 2 * 1024 * 1024
_MAX_READ_LINES = 100
_MAX_READ_CHARS = 8_000
_MAX_SEARCH_MATCHES = 20


class RealtimeResearchError(ValueError):
    """A research artifact is invalid, unavailable, or not ready."""


@dataclass(frozen=True)
class ResearchArtifactPaths:
    directory: Path
    metadata: Path
    research: Path


def _safe_session_key(session: dict[str, Any]) -> str:
    raw = str(session.get("session_key") or "").strip()
    if not raw:
        raise RealtimeResearchError("session has no durable identity")
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", raw).strip("_")
    if not safe:
        raise RealtimeResearchError("session identity cannot be represented safely")
    return safe[:160]


def _profile_root(session: dict[str, Any]) -> Path:
    profile_home = str(session.get("profile_home") or "").strip()
    return Path(profile_home).expanduser() if profile_home else get_hermes_home()


def research_artifact_paths(
    session: dict[str, Any], artifact_id: str
) -> ResearchArtifactPaths:
    artifact_id = str(artifact_id or "").strip()
    if not _ARTIFACT_ID_RE.fullmatch(artifact_id):
        raise RealtimeResearchError("unknown research artifact")
    directory = _profile_root(session) / "research" / _safe_session_key(session) / artifact_id
    return ResearchArtifactPaths(
        directory=directory,
        metadata=directory / "request.json",
        research=directory / "research.md",
    )


def latest_research_artifact_id(session: dict[str, Any]) -> str:
    root = _profile_root(session) / "research" / _safe_session_key(session)
    if not root.is_dir():
        return ""
    latest: tuple[float, str] | None = None
    for directory in root.iterdir():
        if not directory.is_dir() or directory.is_symlink():
            continue
        artifact_id = directory.name
        if not _ARTIFACT_ID_RE.fullmatch(artifact_id):
            continue
        try:
            metadata = json.loads(
                (directory / "request.json").read_text(encoding="utf-8")
            )
            if metadata.get("session_key") != str(session.get("session_key") or ""):
                continue
            created_at = float(metadata.get("created_at") or 0)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
        candidate = (created_at, artifact_id)
        if latest is None or candidate > latest:
            latest = candidate
    return latest[1] if latest else ""


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def prepare_research_artifact(
    session: dict[str, Any], query: str
) -> tuple[str, ResearchArtifactPaths]:
    artifact_id = f"research_{uuid.uuid4().hex[:12]}"
    paths = research_artifact_paths(session, artifact_id)
    paths.directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    _atomic_json_write(
        paths.metadata,
        {
            "version": 1,
            "artifact_id": artifact_id,
            "session_key": str(session.get("session_key") or ""),
            "query": query,
            "delegation_id": "",
            "created_at": time.time(),
        },
    )
    return artifact_id, paths


def bind_research_delegation(paths: ResearchArtifactPaths, delegation_id: str) -> None:
    metadata = json.loads(paths.metadata.read_text(encoding="utf-8"))
    metadata["delegation_id"] = str(delegation_id or "").strip()
    _atomic_json_write(paths.metadata, metadata)


def discard_research_artifact(paths: ResearchArtifactPaths) -> None:
    for path in (paths.research, paths.metadata):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    try:
        paths.directory.rmdir()
    except OSError:
        pass


def _load_metadata(session: dict[str, Any], artifact_id: str) -> tuple[ResearchArtifactPaths, dict[str, Any]]:
    paths = research_artifact_paths(session, artifact_id)
    try:
        metadata = json.loads(paths.metadata.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        raise RealtimeResearchError("unknown research artifact") from exc
    if metadata.get("artifact_id") != artifact_id:
        raise RealtimeResearchError("research artifact identity mismatch")
    if metadata.get("session_key") != str(session.get("session_key") or ""):
        raise RealtimeResearchError("research artifact belongs to another session")
    return paths, metadata


def _read_research_text(path: Path) -> str:
    if path.is_symlink():
        raise RealtimeResearchError("research artifact cannot be a symbolic link")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise RealtimeResearchError("research artifact is missing") from exc
    if size <= 0:
        raise RealtimeResearchError("research artifact is empty")
    if size > _MAX_RESEARCH_BYTES:
        raise RealtimeResearchError("research artifact exceeds the size limit")
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        raise RealtimeResearchError("research artifact is empty")
    return text


def research_status(
    session: dict[str, Any],
    artifact_id: str,
    get_delegation: Callable[[str], dict[str, Any] | None],
) -> dict[str, Any]:
    paths, metadata = _load_metadata(session, artifact_id)
    delegation_id = str(metadata.get("delegation_id") or "")
    durable = get_delegation(delegation_id) if delegation_id else None
    if not durable:
        return {
            "artifact_id": artifact_id,
            "delegation_id": delegation_id,
            "status": "failed",
            "error": "research delegation record is unavailable",
        }
    if durable.get("origin_session") != str(session.get("session_key") or ""):
        raise RealtimeResearchError("research delegation belongs to another session")

    state = str(durable.get("state") or "unknown").lower()
    if state in {"running", "stalling", "finalizing"}:
        return {
            "artifact_id": artifact_id,
            "delegation_id": delegation_id,
            "status": "running",
            "query": metadata.get("query", ""),
        }
    if state not in {"completed", "success"}:
        raw_result = durable.get("result")
        result = raw_result if isinstance(raw_result, dict) else {}
        return {
            "artifact_id": artifact_id,
            "delegation_id": delegation_id,
            "status": "failed",
            "error": str(result.get("error") or f"research delegation ended with {state}"),
        }

    try:
        text = _read_research_text(paths.research)
    except RealtimeResearchError as exc:
        return {
            "artifact_id": artifact_id,
            "delegation_id": delegation_id,
            "status": "failed",
            "error": str(exc),
        }
    return {
        "artifact_id": artifact_id,
        "delegation_id": delegation_id,
        "status": "ready",
        "query": metadata.get("query", ""),
        "line_count": len(text.splitlines()),
        "character_count": len(text),
    }


def _ready_text(
    session: dict[str, Any],
    artifact_id: str,
    get_delegation: Callable[[str], dict[str, Any] | None],
) -> tuple[str, dict[str, Any]]:
    status = research_status(session, artifact_id, get_delegation)
    if status.get("status") != "ready":
        raise RealtimeResearchError(
            str(status.get("error") or f"research is {status.get('status', 'unavailable')}")
        )
    paths = research_artifact_paths(session, artifact_id)
    return _read_research_text(paths.research), status


def read_research(
    session: dict[str, Any],
    artifact_id: str,
    get_delegation: Callable[[str], dict[str, Any] | None],
    *,
    start_line: int = 1,
    line_count: int = 40,
) -> dict[str, Any]:
    text, status = _ready_text(session, artifact_id, get_delegation)
    lines = text.splitlines()
    start = max(1, int(start_line))
    count = min(max(1, int(line_count)), _MAX_READ_LINES)
    selected = lines[start - 1 : start - 1 + count]
    rendered = "\n".join(selected)
    if len(rendered) > _MAX_READ_CHARS:
        rendered = rendered[:_MAX_READ_CHARS]
    consumed_end = min(start - 1 + len(selected), len(lines))
    return {
        **status,
        "start_line": start,
        "next_line": consumed_end + 1 if consumed_end < len(lines) else None,
        "text": rendered,
    }


def search_research(
    session: dict[str, Any],
    artifact_id: str,
    get_delegation: Callable[[str], dict[str, Any] | None],
    *,
    query: str,
) -> dict[str, Any]:
    needle = str(query or "").strip().lower()
    if not needle:
        raise RealtimeResearchError("search query is required")
    text, status = _ready_text(session, artifact_id, get_delegation)
    matches = []
    for number, line in enumerate(text.splitlines(), start=1):
        if needle in line.lower():
            matches.append({"line": number, "text": line[:500]})
            if len(matches) >= _MAX_SEARCH_MATCHES:
                break
    return {**status, "query": query, "matches": matches}
