"""GPT Realtime JSON-RPC handlers."""

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped


@method("voice.realtime.token")
@_profile_scoped
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err

    cfg = _load_cfg()
    voice_cfg = cfg.get("voice") if isinstance(cfg, dict) else {}
    voice_cfg = voice_cfg if isinstance(voice_cfg, dict) else {}
    realtime_cfg = voice_cfg.get("realtime")
    realtime_cfg = realtime_cfg if isinstance(realtime_cfg, dict) else {}
    if realtime_cfg.get("enabled") is False:
        return _err(rid, 4610, "GPT Realtime voice is disabled in config.yaml")

    model = str(realtime_cfg.get("model") or "gpt-realtime-2.1").strip()
    voice = str(realtime_cfg.get("voice") or "marin").strip()
    transcription_model = str(
        realtime_cfg.get("transcription_model") or "gpt-live-transcribe"
    ).strip()
    # Azure OpenAI / AI Foundry: same realtime surface, different host, and an
    # Entra bearer instead of a static key. key_cmd reuses Hermes's existing
    # short-lived-credential machinery (e.g. `az account get-access-token`),
    # so the token is minted fresh and cached until just before expiry.
    base_url = str(realtime_cfg.get("base_url") or "").strip()
    key_cmd = str(realtime_cfg.get("key_cmd") or "").strip()

    try:
        from tui_gateway.realtime_voice import create_realtime_client_secret

        if key_cmd:
            from agent.command_token_source import build_command_token_provider

            token_provider = build_command_token_provider(key_cmd, "voice.realtime")
            api_key = token_provider() if token_provider else ""
        else:
            from tools.tool_backend_helpers import resolve_openai_audio_api_key

            api_key = resolve_openai_audio_api_key()

        token = create_realtime_client_secret(
            api_key=api_key,
            model=model,
            voice=voice,
            transcription_model=transcription_model,
            base_url=base_url,
        )
        from tools.web_tools import check_web_api_key

        token["voice_capabilities"] = {"web_search": bool(check_web_api_key())}
        # Connection identity protects transcript/close RPCs from delayed events
        # after reconnect. It conveys no redraw authority: the Realtime voice
        # model is always the sole component that decides when to visualize.
        import uuid

        connection_id = uuid.uuid4().hex
        connections = session.setdefault("_realtime_connections", set())
        if not isinstance(connections, set):
            connections = set()
            session["_realtime_connections"] = connections
        connections.add(connection_id)
        token["connection_id"] = connection_id
        return _ok(rid, token)
    except Exception as exc:
        return _err(rid, 4611, str(exc))


@method("voice.realtime.web_search")
@_profile_scoped
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err

    query = str(params.get("query") or "").strip()[:500]
    if not query:
        return _err(rid, 4616, "query is required")
    try:
        limit = min(max(int(params.get("limit", 5)), 1), 5)
    except (TypeError, ValueError):
        limit = 5

    try:
        import json

        from tools.web_tools import web_search_tool

        return _ok(rid, json.loads(web_search_tool(query, limit=limit)))
    except Exception as exc:
        return _err(rid, 4617, f"Realtime web search failed: {exc}")


@method("voice.realtime.delegate_research")
@_profile_scoped
def _(rid, params: dict) -> dict:
    session, err = _sess(params, rid)
    if err:
        return err
    query = str(params.get("query") or "").strip()[:1_000]
    if not query:
        return _err(rid, 4618, "research query is required")
    mission_id = str(params.get("mission_id") or "").strip()
    if (
        not mission_id
        or len(mission_id) > 256
        or any(ord(character) < 32 for character in mission_id)
    ):
        return _err(rid, 4618, "a valid mission_id is required")

    from tui_gateway.realtime_research import (
        bind_research_delegation,
        discard_research_artifact,
        prepare_research_artifact,
    )

    artifact_id, paths = prepare_research_artifact(session, query, mission_id)
    runtime_session_id = str(params.get("session_id") or "")

    def _on_research_terminal(event: dict) -> None:
        from tools.async_delegation import get_durable_delegation
        from tui_gateway.realtime_research import research_status

        delegation_id = str(event.get("delegation_id") or "")
        # A very fast worker may finish before delegate_task returns to bind the
        # durable id. Bind here too; both writers store the same identity.
        bind_research_delegation(paths, delegation_id)
        status = research_status(session, artifact_id, get_durable_delegation)
        payload = {
            "mission_id": mission_id,
            "artifact_id": artifact_id,
            "delegation_id": delegation_id,
        }
        if status.get("status") == "ready":
            _emit("voice.realtime.research.ready", runtime_session_id, payload)
            return
        payload["error"] = str(
            status.get("error") or "research delegation failed"
        )[:500]
        _emit("voice.realtime.research.failed", runtime_session_id, payload)

    goal = (
        f"Research the following request using substantial, relevant sources: {query}\n\n"
        f"Write the complete cited research report to this exact path: {paths.research}\n"
        "Use the write_file tool to create or overwrite that file. Include source URLs "
        "beside the claims they support and clearly separate evidence from inference. "
        "Do not modify any other file. Before finishing, use read_file on the exact "
        "research path and verify the report is non-empty. Your final response should "
        "only state that the artifact was verified."
    )
    try:
        import json

        from tools.delegate_tool import delegate_task

        raw = delegate_task(
            goal=goal,
            context=(
                "You are a subordinate research worker. The GPT Realtime voice agent "
                "remains the sole conversational and decision authority. Produce evidence "
                "for it to inspect; do not attempt to continue the user's conversation."
            ),
            role="leaf",
            background=True,
            parent_agent=session.get("agent"),
            suppress_completion_delivery=True,
            reject_if_async_capacity=True,
            completion_callback=_on_research_terminal,
        )
        dispatch = json.loads(raw)
        if dispatch.get("status") != "dispatched" or not dispatch.get("delegation_id"):
            discard_research_artifact(paths)
            return _err(
                rid,
                4618,
                str(dispatch.get("error") or "research delegation was not dispatched"),
            )
        delegation_id = str(dispatch["delegation_id"])
        bind_research_delegation(paths, delegation_id)
        return _ok(
            rid,
            {
                "status": "dispatched",
                "mission_id": mission_id,
                "artifact_id": artifact_id,
                "delegation_id": delegation_id,
            },
        )
    except Exception as exc:
        discard_research_artifact(paths)
        return _err(rid, 4618, f"Realtime research dispatch failed: {exc}")


@method("voice.realtime.research_status")
@_profile_scoped
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    try:
        from tools.async_delegation import get_durable_delegation
        from tui_gateway.realtime_research import (
            latest_research_artifact_id,
            research_status,
        )

        artifact_id = str(params.get("artifact_id") or "")
        if not artifact_id:
            artifact_id = latest_research_artifact_id(session)
        if not artifact_id:
            return _err(rid, 4618, "no research artifact exists for this session")

        return _ok(
            rid,
            research_status(
                session,
                artifact_id,
                get_durable_delegation,
            ),
        )
    except Exception as exc:
        return _err(rid, 4618, str(exc))


@method("voice.realtime.research_read")
@_profile_scoped
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    try:
        from tools.async_delegation import get_durable_delegation
        from tui_gateway.realtime_research import read_research

        return _ok(
            rid,
            read_research(
                session,
                str(params.get("artifact_id") or ""),
                get_durable_delegation,
                start_line=int(params.get("start_line") or 1),
                line_count=int(params.get("line_count") or 40),
            ),
        )
    except Exception as exc:
        return _err(rid, 4618, str(exc))


@method("voice.realtime.research_search")
@_profile_scoped
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    try:
        from tools.async_delegation import get_durable_delegation
        from tui_gateway.realtime_research import search_research

        return _ok(
            rid,
            search_research(
                session,
                str(params.get("artifact_id") or ""),
                get_durable_delegation,
                query=str(params.get("query") or "")[:500],
            ),
        )
    except Exception as exc:
        return _err(rid, 4618, str(exc))


@method("voice.realtime.close")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    connection_id = str(params.get("connection_id") or "").strip()
    if not connection_id:
        return _err(rid, 4615, "connection_id is required")

    connections = session.get("_realtime_connections")
    if isinstance(connections, set):
        connections.discard(connection_id)
    closed_connections = session.setdefault("_realtime_closed_connections", set())
    if not isinstance(closed_connections, set):
        closed_connections = set()
        session["_realtime_closed_connections"] = closed_connections
    closed_connections.add(connection_id)
    _emit(
        "artifact.visualizing",
        str(params.get("session_id") or ""),
        {"artifact_id": "map.main", "active": False},
    )
    return _ok(rid, {"closed": True})


@method("voice.realtime.transcript")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    connection_id = str(params.get("connection_id") or "").strip()
    stored_session_id = str(session.get("session_key") or "").strip()
    item_id = str(params.get("item_id") or "").strip()
    role = str(params.get("role") or "").strip()
    semantic_turn_id = str(params.get("semantic_turn_id") or "").strip()
    text = str(params.get("text") or "").strip()
    if not stored_session_id or not item_id or not text or role not in {"user", "assistant"}:
        return _err(rid, 4612, "session, item_id, user/assistant role, and text are required")
    if connection_id:
        connections = session.get("_realtime_connections")
        closed_connections = session.get("_realtime_closed_connections")
        is_live = isinstance(connections, set) and connection_id in connections
        is_closing = (
            isinstance(closed_connections, set) and connection_id in closed_connections
        )
        if not is_live and not is_closing:
            return _err(rid, 4614, "Realtime connection is stale or unknown")

    _ensure_session_db_row(session)
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            result = db.append_realtime_transcript(
                stored_session_id,
                item_id=item_id,
                role=role,
                semantic_turn_id=semantic_turn_id,
                text=text,
            )
            if result["inserted"]:
                history_entry = {
                    "role": role,
                    "content": text,
                    "display_kind": "realtime_transcript",
                    # This row was just committed through the dedicated
                    # idempotent Realtime path. The live history may alias
                    # agent._session_messages; without the intrinsic marker,
                    # generic session finalization appends it again.
                    "_db_persisted": True,
                    **(
                        {"display_metadata": {"semantic_turn_id": semantic_turn_id}}
                        if semantic_turn_id
                        else {}
                    ),
                }
                history_lock = session.get("history_lock")
                if history_lock is not None:
                    with history_lock:
                        session.setdefault("history", []).append(history_entry)
                        session["history_version"] = int(session.get("history_version", 0)) + 1
                else:
                    session.setdefault("history", []).append(history_entry)
                    session["history_version"] = int(session.get("history_version", 0)) + 1
                _emit(
                    "voice.realtime.transcript",
                    str(params.get("session_id") or ""),
                    {
                        "item_id": item_id,
                        "message_id": result["message_id"],
                        "role": role,
                        "semantic_turn_id": semantic_turn_id,
                        "text": text,
                    },
                )
            return _ok(rid, result)
        except Exception as exc:
            return _err(rid, 4613, f"could not persist Realtime transcript: {exc}")


def register(server) -> None:
    _registry.install(server)
