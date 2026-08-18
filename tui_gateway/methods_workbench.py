"""Voice-triggered workbench visualization RPC."""

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped


@method("workbench.visualize")
@_profile_scoped
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    if not stored_session_id:
        return _err(rid, 4620, "session has no durable identity")

    prompt = str(params.get("prompt") or "").strip()[:1_000]
    _ensure_session_db_row(session)
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            from workbench_visualizer import visualize_session

            artifact = visualize_session(
                db,
                stored_session_id,
                prompt=prompt,
            )
            sid = str(params.get("session_id") or "")
            _emit("artifact.updated", sid, {"artifact": artifact})
            return _ok(rid, {"artifact": artifact})
        except Exception as exc:
            return _err(rid, 4621, f"workbench visualization failed: {exc}")


def register(server) -> None:
    _registry.install(server)
