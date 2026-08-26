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
    sid = str(params.get("session_id") or "")
    import threading

    # Multiple Realtime responses may intentionally call visualize during one
    # semantic turn. Run every request, but serialize model generation per
    # session and keep one continuous busy window across the queue.
    state = session.setdefault("_workbench_visualize_state", {})
    if not isinstance(state, dict):
        state = {}
        session["_workbench_visualize_state"] = state
    coordinate = state.setdefault("coordinate", threading.Lock())
    serialize = state.setdefault("serialize", threading.Lock())
    with coordinate:
        active = int(session.get("_workbench_visualize_active", 0)) + 1
        session["_workbench_visualize_active"] = active
        first_active = active == 1

    if first_active:
        _emit("artifact.visualizing", sid, {"artifact_id": "map.main", "active": True})

    try:
        with serialize:
            _ensure_session_db_row(session)
            with _session_db(session) as db:
                if db is None:
                    return _db_unavailable_error(rid, code=5007)
                try:
                    from hermes_state_artifacts import ArtifactRevisionConflict
                    from workbench_visualizer import visualize_session

                    try:
                        artifact = visualize_session(
                            db,
                            stored_session_id,
                            prompt=prompt,
                        )
                    except ArtifactRevisionConflict:
                        # The voice keeps talking while the mute diagrammer works, so
                        # an instant rename/connect/remove can legitimately win the
                        # revision race. Regenerate once from that accepted latest
                        # artifact so neither the edit nor the requested redraw is lost.
                        artifact = visualize_session(
                            db,
                            stored_session_id,
                            prompt=prompt,
                        )
                    _emit("artifact.updated", sid, {"artifact": artifact})
                    return _ok(rid, {"artifact": artifact})
                except Exception as exc:
                    return _err(rid, 4621, f"workbench visualization failed: {exc}")
    finally:
        with coordinate:
            active = max(0, int(session.get("_workbench_visualize_active", 1)) - 1)
            session["_workbench_visualize_active"] = active
            last_active = active == 0
        if last_active:
            # Clears only after the final queued request succeeds or fails.
            _emit("artifact.visualizing", sid, {"artifact_id": "map.main", "active": False})


@method("workbench.edit")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Apply ONE surgical edit to the stored graph, with no model call.

    This is the low-latency write path: rename/connect/disconnect/remove touch
    a single element, bump ``semantic_rev`` through the same
    ``update_artifact_semantics`` used by the diagrammer (so revision-conflict
    handling is unchanged), and emit ``artifact.updated``. ``focus`` is a pure
    view concern and never reaches here.
    """
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    if not stored_session_id:
        return _err(rid, 4620, "session has no durable identity")

    artifact_id = str(params.get("artifact_id") or "map.main").strip() or "map.main"
    edit = params.get("edit")
    if not isinstance(edit, dict):
        return _err(rid, 4622, "edit must be an object")

    # Imported inside the handler: handler bodies execute in the gateway's
    # injected namespace, so module-level imports are not visible here.
    from hermes_state_artifacts import SurgicalEditError, apply_surgical_edit

    sid = str(params.get("session_id") or "")
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            artifact = db.get_session_artifact(stored_session_id, artifact_id)
            if artifact is None:
                if edit.get("op") != "add_node":
                    return _err(rid, 4623, f"no artifact {artifact_id} in this session")

                payload = apply_surgical_edit({"nodes": [], "edges": []}, edit)
                created = db.create_session_artifact(
                    stored_session_id,
                    artifact_id,
                    kind="map",
                    payload=payload,
                    view_state={"positions": {}, "pinned": []},
                    updated_by="voice-edit",
                )
                _emit("artifact.updated", sid, {"artifact": created})
                return _ok(rid, {"artifact": created})
            if str(artifact.get("kind") or "map") != "map":
                return _err(rid, 4624, "surgical edits apply to map artifacts only")

            payload = apply_surgical_edit(artifact["payload"], edit)
            updated = db.update_artifact_semantics(
                stored_session_id,
                artifact_id,
                payload=payload,
                expected_rev=int(artifact["semantic_rev"]),
                updated_by="voice-edit",
            )
            _emit("artifact.updated", sid, {"artifact": updated})
            return _ok(rid, {"artifact": updated})
        except SurgicalEditError as exc:
            return _err(rid, 4622, f"surgical edit rejected: {exc}")
        except Exception as exc:
            return _err(rid, 4625, f"surgical edit failed: {exc}")


@method("workbench.focus")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Centre/highlight ONE node. Pure view state: no payload, no model call.

    Focus lives in ``view_state.focus`` (a renderer concern) and therefore
    bumps ``view_rev``, never ``semantic_rev``: pointing at an idea does not
    change the idea. It deliberately does not touch ``positions``,
    ``user_pins`` or ``hidden``.
    """
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    if not stored_session_id:
        return _err(rid, 4620, "session has no durable identity")

    artifact_id = str(params.get("artifact_id") or "map.main").strip() or "map.main"
    node_id = str(params.get("node_id") or "").strip()
    if not node_id:
        return _err(rid, 4622, "node_id is required")

    sid = str(params.get("session_id") or "")
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            artifact = db.get_session_artifact(stored_session_id, artifact_id)
            if artifact is None:
                return _err(rid, 4623, f"no artifact {artifact_id} in this session")
            payload = artifact.get("payload") or {}
            nodes = payload.get("nodes") if isinstance(payload, dict) else None
            known = {
                n.get("id") for n in nodes if isinstance(n, dict)
            } if isinstance(nodes, list) else set()
            if node_id not in known:
                return _err(rid, 4622, f"unknown node: {node_id}")

            view_state = dict(artifact.get("view_state") or {})
            view_state["focus"] = node_id
            updated = db.update_artifact_view_state(
                stored_session_id,
                artifact_id,
                view_state=view_state,
                expected_rev=int(artifact["view_rev"]),
                updated_by="voice-focus",
            )
            _emit("artifact.updated", sid, {"artifact": updated})
            return _ok(rid, {"artifact": updated})
        except Exception as exc:
            return _err(rid, 4626, f"focus failed: {exc}")


@method("workbench.back")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Go back to the previous drawing. No model call, so it is instant.

    Restoring writes the old payload forward as a new revision rather than
    rewinding the counter, so it plays by the same optimistic-concurrency rules
    as every other writer and is itself undoable.
    """
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    if not stored_session_id:
        return _err(rid, 4620, "session has no durable identity")

    artifact_id = str(params.get("artifact_id") or "map.main").strip() or "map.main"
    sid = str(params.get("session_id") or "")

    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            artifact = db.get_session_artifact(stored_session_id, artifact_id)
            if artifact is None:
                return _err(rid, 4623, f"no artifact {artifact_id} in this session")

            restored = db.restore_artifact_version(
                stored_session_id,
                artifact_id,
                expected_rev=int(artifact["semantic_rev"]),
            )
            _emit("artifact.updated", sid, {"artifact": restored})
            return _ok(rid, {"artifact": restored})
        except Exception as exc:
            return _err(rid, 4627, f"go back failed: {exc}")


def register(server) -> None:
    _registry.install(server)
