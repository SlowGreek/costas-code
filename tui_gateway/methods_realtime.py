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
        from workbench_watcher import watcher_config_from

        watcher = watcher_config_from(cfg)
        token["workbench_watcher"] = {
            "active": watcher.active,
            "pipeline": watcher.pipeline,
            "owns_redraws": watcher.active,
        }
        return _ok(rid, token)
    except Exception as exc:
        return _err(rid, 4611, str(exc))


@method("voice.realtime.transcript")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    stored_session_id = str(session.get("session_key") or "").strip()
    item_id = str(params.get("item_id") or "").strip()
    role = str(params.get("role") or "").strip()
    text = str(params.get("text") or "").strip()
    if not stored_session_id or not item_id or not text or role not in {"user", "assistant"}:
        return _err(rid, 4612, "session, item_id, user/assistant role, and text are required")

    _ensure_session_db_row(session)
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            result = db.append_realtime_transcript(
                stored_session_id,
                item_id=item_id,
                role=role,
                text=text,
            )
            if result["inserted"]:
                history_entry = {
                    "role": role,
                    "content": text,
                    "display_kind": "realtime_transcript",
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
                        "text": text,
                    },
                )
                # Handler bodies execute in the gateway's injected namespace,
                # so this module's own globals are NOT visible here — import
                # the helper, and hand it the server helpers explicitly.
                from tui_gateway.methods_realtime import _watch_transcript

                _watch_transcript(
                    session,
                    stored_session_id,
                    role,
                    text,
                    str(params.get("session_id") or ""),
                    cfg=_load_cfg(),
                    open_db=_session_db,
                    emit=_emit,
                )
            return _ok(rid, result)
        except Exception as exc:
            return _err(rid, 4613, f"could not persist Realtime transcript: {exc}")


def _watch_transcript(
    session: dict,
    stored_session_id: str,
    role: str,
    text: str,
    sid: str,
    *,
    cfg,
    open_db,
    emit,
):
    """Hand one settled transcript line to the background watcher.

    Best-effort by construction: when active, the watcher is the sole owner of
    full redraws and the voice model does not receive `visualize`; when shadow
    or disabled, the watcher cannot write and voice retains the tool. A watcher
    failure must never turn into a failed transcript write and a hole in the
    conversation record.
    """
    try:
        from workbench_watch_runtime import observe_transcript

        canvas = None
        with open_db(session) as db:
            if db is not None:
                canvas = db.get_session_artifact(stored_session_id, "map.main")

        def _draw(decision) -> None:
            _visualize_from_watcher(
                session,
                stored_session_id,
                sid,
                decision,
                open_db=open_db,
                emit=emit,
            )

        observe_transcript(
            stored_session_id,
            role=role,
            text=text,
            cfg=cfg,
            on_decision=_draw,
            canvas=canvas,
        )
    except Exception:
        pass


def _visualize_from_watcher(
    session: dict, stored_session_id: str, sid: str, decision, *, open_db, emit
):
    """Persist a direct result, or run the preserved two-stage diagrammer."""
    from workbench_watch_runtime import set_in_flight

    with open_db(session) as db:
        if db is None:
            return
        set_in_flight(stored_session_id, True)
        emit("artifact.visualizing", sid, {"artifact_id": "map.main", "active": True})
        try:
            if decision.visual is not None:
                from workbench_visualizer import persist_visual_result

                artifact = persist_visual_result(
                    db,
                    stored_session_id,
                    decision.visual,
                    expected_rev=decision.expected_rev,
                )
            else:
                from workbench_visualizer import visualize_session

                artifact = visualize_session(db, stored_session_id, prompt=decision.direction)
            emit("artifact.updated", sid, {"artifact": artifact})
        except Exception:
            pass
        finally:
            set_in_flight(stored_session_id, False)
            emit("artifact.visualizing", sid, {"artifact_id": "map.main", "active": False})


def register(server) -> None:
    _registry.install(server)
