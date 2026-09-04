"""GPT Realtime JSON-RPC handlers."""

from __future__ import annotations

from pathlib import Path

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped


def _realtime_cfg(cfg: dict | None) -> dict:
    voice_cfg = cfg.get("voice") if isinstance(cfg, dict) else {}
    voice_cfg = voice_cfg if isinstance(voice_cfg, dict) else {}
    realtime_cfg = voice_cfg.get("realtime")
    return realtime_cfg if isinstance(realtime_cfg, dict) else {}


def _peeps_interaction_payload(config, started: dict) -> dict:
    return {
        "auth_session_id": started["auth_session_id"],
        "provider": "peeps",
        "status": "interaction_required",
        "timeout_seconds": config.timeout_seconds,
    }


def _peeps_profile_key(session: dict | None = None) -> str:
    profile_home = ""
    if isinstance(session, dict):
        profile_home = str(session.get("profile_home") or "").strip()
    if profile_home:
        return f"home:{Path(profile_home).expanduser().resolve()}"
    from hermes_constants import get_hermes_home

    return f"home:{get_hermes_home().resolve()}"


def _peeps_binding(params: dict, session: dict):
    from tui_gateway import server as gateway_server

    runtime_session_id = str(params.get("session_id") or "")
    transport, authoritative_session = gateway_server._current_session_steer_authority(runtime_session_id)
    if transport is None or authoritative_session is not session:
        return None
    from tui_gateway.peeps_voice_auth import PeepsAuthBinding

    return PeepsAuthBinding.create(
        _peeps_profile_key(session).removeprefix("home:"),
        session,
        runtime_session_id,
        transport,
    )


def _peeps_companion_binding(params: dict, session: dict):
    from tui_gateway import server as gateway_server

    runtime_session_id = str(params.get("session_id") or "")
    transport = gateway_server.current_transport()
    with gateway_server._sessions_lock:
        authoritative_session = gateway_server._sessions.get(runtime_session_id)
    if transport is None or authoritative_session is not session:
        return None
    from tui_gateway.peeps_voice_auth import PeepsAuthBinding

    return PeepsAuthBinding.create(
        _peeps_profile_key(session).removeprefix("home:"),
        session,
        runtime_session_id,
        transport,
    )


def _with_session_profile(session: dict | None, fn):
    from pathlib import Path
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    profile_home = str(session.get("profile_home") or "").strip() if isinstance(session, dict) else ""
    if not profile_home:
        return fn()
    token = set_hermes_home_override(Path(profile_home).expanduser().resolve())
    try:
        return fn()
    finally:
        reset_hermes_home_override(token)


def _coarse_realtime_failure(exc: Exception) -> str:
    from agent.command_token_source import CommandTokenError
    from tui_gateway.peeps_voice_auth import PeepsAuthError
    from tui_gateway.realtime_voice import RealtimeCredentialError

    if isinstance(exc, CommandTokenError):
        return "azure_cli_unavailable"
    if isinstance(exc, PeepsAuthError):
        return exc.code
    if isinstance(exc, RealtimeCredentialError):
        if exc.kind == "auth_rejected":
            return f"azure_realtime_auth_{exc.status or 'rejected'}"
        if exc.kind == "connectivity":
            return "azure_realtime_unreachable"
        if exc.kind == "http":
            return f"azure_realtime_http_{exc.status or 'error'}"
        return "azure_realtime_invalid_response"
    return "realtime_unknown_error"



def _decorate_realtime_token(session: dict, token: dict) -> dict:
    from tools.web_tools import check_web_api_key
    import uuid

    token = {**token, "status": "ready"}
    token["voice_capabilities"] = {"web_search": bool(check_web_api_key())}
    connection_id = uuid.uuid4().hex
    connections = session.setdefault("_realtime_connections", set())
    if not isinstance(connections, set):
        connections = set()
        session["_realtime_connections"] = connections
    connections.add(connection_id)
    token["connection_id"] = connection_id
    return token


def _mint_realtime_secret(*, api_key: str, model: str, voice: str, transcription_model: str, base_url: str) -> dict:
    from tui_gateway.realtime_voice import create_realtime_client_secret

    return create_realtime_client_secret(
        api_key=api_key,
        model=model,
        voice=voice,
        transcription_model=transcription_model,
        base_url=base_url,
    )


def _primary_realtime_api_key(key_cmd: str) -> str:
    if key_cmd:
        from agent.command_token_source import build_command_token_provider

        token_provider = build_command_token_provider(key_cmd, "voice.realtime")
        return token_provider() if token_provider else ""
    from tools.tool_backend_helpers import resolve_openai_audio_api_key

    return resolve_openai_audio_api_key()


@method("voice.realtime.peeps.claim")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    try:
        config = _with_session_profile(
            session,
            lambda: _peeps_config(_realtime_cfg(_load_cfg())),
        )
        binding = _peeps_companion_binding(params, session)
        if config is None or binding is None:
            return _err(rid, 4613, "Peeps voice authorization failed")
        claimed = _peeps_state()["sessions"].claim(
            binding,
            str(params.get("auth_session_id") or ""),
            main_handle=str(params.get("peeps_main_handle") or ""),
            native_main_proof=str(params.get("native_main_proof") or ""),
        )
        return _ok(rid, {**claimed, "timeout_seconds": config.timeout_seconds})
    except Exception:
        return _err(rid, 4613, "Peeps voice authorization failed")


@method("voice.realtime.peeps.complete")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    try:
        config = _with_session_profile(
            session,
            lambda: _peeps_config(_realtime_cfg(_load_cfg())),
        )
        if config is None:
            return _err(rid, 4612, "Peeps voice fallback is disabled")
        binding = _peeps_companion_binding(params, session)
        envelope = params.get("envelope")
        if binding is None or not isinstance(envelope, dict):
            return _err(rid, 4613, "Peeps voice authorization failed")
        _peeps_state()["sessions"].complete(
            binding,
            str(params.get("auth_session_id") or ""),
            str(params.get("state") or ""),
            envelope,
            config,
        )
        return _ok(rid, {"ok": True})
    except Exception:
        return _err(rid, 4613, "Peeps voice authorization failed")


@method("voice.realtime.peeps.cancel")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    binding = _peeps_binding(params, session) or _peeps_companion_binding(params, session)
    if binding is None:
        return _err(rid, 4613, "Peeps voice authorization failed")
    cancelled = _peeps_state()["sessions"].cancel(
        binding, str(params.get("auth_session_id") or "")
    )
    return _ok(rid, {"ok": cancelled})


@method("voice.realtime.token")
@_profile_scoped
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err

    cfg = _with_session_profile(session, _load_cfg)
    realtime_cfg = _realtime_cfg(cfg)
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
    peeps_config = _peeps_config(realtime_cfg)
    binding = _peeps_binding(params, session) if peeps_config else None

    try:
        primary_key = _primary_realtime_api_key(key_cmd)
        token = _mint_realtime_secret(
            api_key=primary_key,
            model=model,
            voice=voice,
            transcription_model=transcription_model,
            base_url=base_url,
        )
        return _ok(rid, _decorate_realtime_token(session, token))
    except Exception as primary_exc:
        from agent.command_token_source import CommandTokenError
        from tui_gateway.peeps_voice_auth import PeepsAuthError
        from tui_gateway.realtime_voice import RealtimeCredentialError

        peeps_enabled = bool(peeps_config is not None and base_url and key_cmd)
        primary_code = _coarse_realtime_failure(primary_exc)
        fallback_eligible = isinstance(primary_exc, CommandTokenError) or (
            isinstance(primary_exc, RealtimeCredentialError)
            and primary_exc.kind == "auth_rejected"
            and primary_exc.status in {401, 403}
        )

        if not peeps_enabled or not fallback_eligible or binding is None:
            return _err(rid, 4611, f"Could not obtain a Realtime voice credential ({primary_code})")

        auth_session_id = str(params.get("peeps_auth_session_id") or "")
        if not auth_session_id:
            started = _peeps_state()["sessions"].start(
                binding,
                peeps_config,
                main_handle=str(params.get("peeps_main_handle") or ""),
                main_challenge=str(params.get("peeps_main_challenge") or ""),
            )
            return _ok(rid, _peeps_interaction_payload(peeps_config, started))

        provider = _peeps_state()["sessions"].consume_ready(binding, auth_session_id)
        if provider is None:
            return _err(rid, 4613, "Peeps voice authorization is invalid or expired")

        try:
            cognitive_token = provider.token()
            token = _mint_realtime_secret(
                api_key=cognitive_token,
                model=model,
                voice=voice,
                transcription_model=transcription_model,
                base_url=base_url,
            )
            return _ok(rid, _decorate_realtime_token(session, token))
        except RealtimeCredentialError as fallback_exc:
            return _err(
                rid,
                4611,
                f"Realtime voice authentication failed ({primary_code}; {_coarse_realtime_failure(fallback_exc)})",
            )
        except PeepsAuthError as fallback_exc:
            return _err(
                rid,
                4611,
                f"Realtime voice authentication failed ({primary_code}; {_coarse_realtime_failure(fallback_exc)})",
            )
        except Exception:
            return _err(
                rid,
                4611,
                f"Realtime voice authentication failed ({primary_code}; peeps_fallback_failed)",
            )


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
    server._realtime_cfg = _realtime_cfg
    server._peeps_interaction_payload = _peeps_interaction_payload
    server._peeps_profile_key = _peeps_profile_key
    server._peeps_binding = _peeps_binding
    server._peeps_companion_binding = _peeps_companion_binding
    server._with_session_profile = _with_session_profile
    server._coarse_realtime_failure = _coarse_realtime_failure

    server._decorate_realtime_token = _decorate_realtime_token
    server._mint_realtime_secret = _mint_realtime_secret
    server._primary_realtime_api_key = _primary_realtime_api_key
    _registry.install(server)
