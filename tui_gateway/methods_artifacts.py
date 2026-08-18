"""Session-scoped ideation artifact JSON-RPC handlers."""

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method


@method("artifact.list")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    if not stored_session_id:
        return _err(rid, 4600, "session has no durable identity")
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            return _ok(
                rid,
                {
                    "artifacts": db.list_session_artifacts(stored_session_id),
                    "stored_session_id": stored_session_id,
                },
            )
        except Exception as exc:
            return _err(rid, 4601, f"could not list artifacts: {exc}")


@method("artifact.create")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    if not stored_session_id:
        return _err(rid, 4600, "session has no durable identity")
    artifact_id = str(params.get("artifact_id") or "").strip()
    kind = str(params.get("kind") or "").strip()
    updated_by = str(params.get("updated_by") or "").strip()
    payload = params.get("payload")
    view_state = params.get("view_state", {})
    if not artifact_id or not kind or not updated_by:
        return _err(rid, 4602, "artifact_id, kind, and updated_by are required")
    if not isinstance(payload, dict) or not isinstance(view_state, dict):
        return _err(rid, 4602, "payload and view_state must be objects")

    # A Realtime conversation can create its first map before a normal prompt
    # has ever been submitted. That map is real activity, so persist the lazy
    # session row before the artifact's foreign key is evaluated.
    _ensure_session_db_row(session)
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            artifact = db.create_session_artifact(
                stored_session_id,
                artifact_id,
                kind=kind,
                payload=payload,
                view_state=view_state,
                updated_by=updated_by,
            )
            _emit("artifact.updated", str(params.get("session_id") or ""), {"artifact": artifact})
            return _ok(rid, {"artifact": artifact})
        except Exception as exc:
            return _err(rid, 4603, f"could not create artifact: {exc}")


@method("artifact.update_semantics")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    artifact_id = str(params.get("artifact_id") or "").strip()
    updated_by = str(params.get("updated_by") or "").strip()
    payload = params.get("payload")
    expected_rev = params.get("expected_rev")
    if not stored_session_id or not artifact_id or not updated_by:
        return _err(rid, 4602, "session, artifact_id, and updated_by are required")
    if not isinstance(payload, dict):
        return _err(rid, 4602, "payload must be an object")
    if isinstance(expected_rev, bool) or not isinstance(expected_rev, int) or expected_rev < 1:
        return _err(rid, 4602, "expected_rev must be a positive integer")
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            artifact = db.update_artifact_semantics(
                stored_session_id,
                artifact_id,
                payload=payload,
                expected_rev=expected_rev,
                updated_by=updated_by,
            )
            _emit("artifact.updated", str(params.get("session_id") or ""), {"artifact": artifact})
            return _ok(rid, {"artifact": artifact})
        except Exception as exc:
            return _err(rid, 4604, f"could not update artifact semantics: {exc}")


@method("artifact.update_view")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    artifact_id = str(params.get("artifact_id") or "").strip()
    updated_by = str(params.get("updated_by") or "").strip()
    view_state = params.get("view_state")
    expected_rev = params.get("expected_rev")
    if not stored_session_id or not artifact_id or not updated_by:
        return _err(rid, 4602, "session, artifact_id, and updated_by are required")
    if not isinstance(view_state, dict):
        return _err(rid, 4602, "view_state must be an object")
    if isinstance(expected_rev, bool) or not isinstance(expected_rev, int) or expected_rev < 1:
        return _err(rid, 4602, "expected_rev must be a positive integer")
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            artifact = db.update_artifact_view_state(
                stored_session_id,
                artifact_id,
                view_state=view_state,
                expected_rev=expected_rev,
                updated_by=updated_by,
            )
            _emit("artifact.updated", str(params.get("session_id") or ""), {"artifact": artifact})
            return _ok(rid, {"artifact": artifact})
        except Exception as exc:
            return _err(rid, 4605, f"could not update artifact view: {exc}")


def register(server) -> None:
    _registry.install(server)
