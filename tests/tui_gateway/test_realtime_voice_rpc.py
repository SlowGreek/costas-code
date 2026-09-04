from hermes_cli.config_defaults import DEFAULT_CONFIG
from hermes_state import SessionDB
from tui_gateway import realtime_voice, server
from tools import tool_backend_helpers, web_tools

import threading
import copy


def test_realtime_token_requests_peeps_only_after_key_cmd_auth_failure(monkeypatch):
    from agent.command_token_source import CommandTokenError

    runtime_id = "runtime-peeps"
    server._sessions[runtime_id] = {"session_key": "stored-session", "profile_home": None}
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["voice"]["realtime"]["base_url"] = "https://res.openai.azure.com/openai/v1"
    cfg["voice"]["realtime"]["key_cmd"] = "false"
    cfg["voice"]["realtime"]["peeps_fallback"]["enabled"] = True
    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)
    monkeypatch.setattr("agent.command_token_source.build_command_token_provider", lambda *_: lambda: (_ for _ in ()).throw(CommandTokenError("no")))
    try:
        result = server._methods["voice.realtime.token"]("token", {"session_id": runtime_id})["result"]
    finally:
        server._sessions.pop(runtime_id, None)

    assert result["status"] == "interaction_required"
    assert result["provider"] == "peeps"
    assert "peeps_token" not in result
    assert "voice.realtime.peeps.start" in server._LONG_HANDLERS


def test_peeps_rpc_completes_without_echoing_bearer(monkeypatch):
    runtime_id = "runtime-peeps-rpc"
    server._sessions[runtime_id] = {"session_key": "stored-session", "profile_home": None}
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["voice"]["realtime"]["peeps_fallback"]["enabled"] = True
    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)
    start = server._methods["voice.realtime.peeps.start"]("start", {"session_id": runtime_id})["result"]
    from tests.tui_gateway.test_peeps_voice_auth import _jwt
    bearer = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": 4_000_000_000})
    try:
        result = server._methods["voice.realtime.peeps.complete"]("complete", {
            "session_id": runtime_id, "auth_session_id": start["auth_session_id"],
            "state": start["state"], "peeps_token": bearer,
        })["result"]
    finally:
        server._sessions.pop(runtime_id, None)
    assert result == {"ok": True}


def test_realtime_token_rpc_is_profile_scoped_and_uses_voice_config(monkeypatch):
    runtime_id = "runtime-session"
    server._sessions[runtime_id] = {"session_key": "stored-session", "profile_home": None}
    captured = {}

    monkeypatch.setattr(server, "_load_cfg", lambda: DEFAULT_CONFIG)
    monkeypatch.setattr(tool_backend_helpers, "resolve_openai_audio_api_key", lambda: "sk-test")
    monkeypatch.setattr(web_tools, "check_web_api_key", lambda: True)

    def mint(**kwargs):
        captured.update(kwargs)
        return {
            "client_secret": "ek_short",
            "expires_at": 1234,
            "model": kwargs["model"],
            "voice": kwargs["voice"],
        }

    monkeypatch.setattr(realtime_voice, "create_realtime_client_secret", mint)
    try:
        envelope = server._methods["voice.realtime.token"](
            "request-1", {"session_id": runtime_id}
        )
    finally:
        server._sessions.pop(runtime_id, None)

    assert "error" not in envelope
    connection_id = envelope["result"].pop("connection_id")
    assert isinstance(connection_id, str) and connection_id
    assert envelope["result"] == {
        "client_secret": "ek_short",
        "expires_at": 1234,
        "model": "gpt-realtime-2.1",
        "status": "ready",
        "voice": "marin",
        "voice_capabilities": {"web_search": True},
    }
    assert captured == {
        "api_key": "sk-test",
        "model": "gpt-realtime-2.1",
        "voice": "marin",
        "transcription_model": "gpt-live-transcribe",
        "base_url": "",
    }
    assert "voice.realtime.token" in server._LONG_HANDLERS


def test_realtime_web_search_rpc_uses_existing_provider(monkeypatch):
    runtime_id = "runtime-search"
    server._sessions[runtime_id] = {"session_key": "stored-search", "profile_home": None}
    captured = {}

    def search(query, limit=5):
        captured.update(query=query, limit=limit)
        return '{"success":true,"data":{"web":[{"title":"Current","url":"https://example.com","description":"Live result"}]}}'

    monkeypatch.setattr(web_tools, "web_search_tool", search)
    try:
        envelope = server._methods["voice.realtime.web_search"](
            "search-request",
            {"session_id": runtime_id, "query": "latest realtime api", "limit": 99},
        )
    finally:
        server._sessions.pop(runtime_id, None)

    assert "error" not in envelope
    assert captured == {"query": "latest realtime api", "limit": 5}
    assert envelope["result"]["data"]["web"][0]["title"] == "Current"
    assert "voice.realtime.web_search" in server._LONG_HANDLERS


def test_realtime_token_rpc_mints_an_entra_token_for_azure(monkeypatch):
    """Azure resources use key_cmd (Entra) instead of a static OpenAI key."""
    import copy

    runtime_id = "runtime-session"
    server._sessions[runtime_id] = {"session_key": "stored-session", "profile_home": None}
    captured = {}
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["voice"]["realtime"]["base_url"] = "https://res.openai.azure.com/openai/v1"
    cfg["voice"]["realtime"]["key_cmd"] = "printf entra-token"

    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)

    def _unexpected():
        raise AssertionError("static OpenAI key must not be consulted when key_cmd is set")

    monkeypatch.setattr(tool_backend_helpers, "resolve_openai_audio_api_key", _unexpected)

    def mint(**kwargs):
        captured.update(kwargs)
        return {"client_secret": "ek_azure", "webrtc_url": "https://res/openai/v1/realtime/calls"}

    monkeypatch.setattr(realtime_voice, "create_realtime_client_secret", mint)
    try:
        envelope = server._methods["voice.realtime.token"]("request-1", {"session_id": runtime_id})
    finally:
        server._sessions.pop(runtime_id, None)

    assert "error" not in envelope
    assert captured["api_key"] == "entra-token"
    assert captured["base_url"] == "https://res.openai.azure.com/openai/v1"
    assert envelope["result"]["webrtc_url"] == "https://res/openai/v1/realtime/calls"


def test_realtime_token_never_grants_watcher_redraw_ownership(monkeypatch):
    import copy

    runtime_id = "runtime-session"
    server._sessions[runtime_id] = {"session_key": "stored-session", "profile_home": None}
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["workbench"] = {
        "watcher": {"enabled": True, "mode": "active", "pipeline": "direct"}
    }
    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)
    monkeypatch.setattr(tool_backend_helpers, "resolve_openai_audio_api_key", lambda: "sk-test")
    monkeypatch.setattr(
        realtime_voice,
        "create_realtime_client_secret",
        lambda **_: {"client_secret": "ek_short"},
    )
    try:
        result = server._methods["voice.realtime.token"](
            "request-1", {"session_id": runtime_id}
        )["result"]
        connection_id = result["connection_id"]
        live_session = server._sessions[runtime_id]
    finally:
        server._sessions.pop(runtime_id, None)

    assert "workbench_watcher" not in result
    assert connection_id in live_session["_realtime_connections"]


def test_realtime_transcript_ignores_legacy_active_watcher_config(tmp_path, monkeypatch):
    """Old active-watcher config cannot create a second redraw decision owner."""
    import copy
    runtime_id = "runtime-frozen-watcher"
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="stored-frozen", source="desktop", model="test")
    live_session = {"session_key": "stored-frozen", "profile_home": None, "history": []}
    server._sessions[runtime_id] = live_session
    active_cfg = copy.deepcopy(DEFAULT_CONFIG)
    active_cfg["workbench"] = {
        "watcher": {"enabled": True, "mode": "active", "pipeline": "direct"}
    }
    monkeypatch.setattr(server, "_load_cfg", lambda: active_cfg)
    monkeypatch.setattr(server, "_db", db)
    monkeypatch.setattr(tool_backend_helpers, "resolve_openai_audio_api_key", lambda: "sk-test")
    monkeypatch.setattr(
        realtime_voice,
        "create_realtime_client_secret",
        lambda **_: {"client_secret": "ek_short"},
    )

    try:
        token = server._methods["voice.realtime.token"](
            "token", {"session_id": runtime_id}
        )["result"]
        connection_id = token["connection_id"]
        result = server._methods["voice.realtime.transcript"](
            "transcript",
            {
                "session_id": runtime_id,
                "connection_id": connection_id,
                "item_id": "u1",
                "role": "user",
                "text": "show me this",
            },
        )
        artifact = db.get_session_artifact("stored-frozen", "map.main")
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()

    assert "error" not in result
    assert artifact is None


def test_reconnect_keeps_each_voice_connection_lease_valid(monkeypatch):
    runtime_id = "runtime-reconnect-owner"
    live_session = {"session_key": "stored-reconnect", "profile_home": None, "history": []}
    server._sessions[runtime_id] = live_session
    monkeypatch.setattr(server, "_load_cfg", lambda: DEFAULT_CONFIG)
    monkeypatch.setattr(tool_backend_helpers, "resolve_openai_audio_api_key", lambda: "sk-test")
    monkeypatch.setattr(
        realtime_voice,
        "create_realtime_client_secret",
        lambda **_: {"client_secret": "ek_short"},
    )
    try:
        first = server._methods["voice.realtime.token"](
            "token-a", {"session_id": runtime_id}
        )["result"]
        second = server._methods["voice.realtime.token"](
            "token-b", {"session_id": runtime_id}
        )["result"]

        for item_id, token in (("old-event", first), ("new-event", second)):
            result = server._methods["voice.realtime.transcript"](
                item_id,
                {
                    "session_id": runtime_id,
                    "connection_id": token["connection_id"],
                    "item_id": item_id,
                    "role": "user",
                    "text": "show me this",
                },
            )
            assert "error" not in result
    finally:
        server._sessions.pop(runtime_id, None)

    assert first["connection_id"] != second["connection_id"]
    assert live_session["_realtime_connections"] == {
        first["connection_id"],
        second["connection_id"],
    }


def test_realtime_close_accepts_late_transcript(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    runtime_id = "runtime-close-race"
    db.create_session(session_id="stored-close-race", source="desktop", model="test")
    live_session = {
        "session_key": "stored-close-race",
        "profile_home": None,
        "history": [],
        "_realtime_connections": {"connection-a"},
    }
    server._sessions[runtime_id] = live_session
    monkeypatch.setattr(server, "_db", db)

    try:
        closed = server._methods["voice.realtime.close"](
            "close", {"session_id": runtime_id, "connection_id": "connection-a"}
        )
        transcript = server._methods["voice.realtime.transcript"](
            "late",
            {
                "session_id": runtime_id,
                "connection_id": "connection-a",
                "item_id": "late-user",
                "role": "user",
                "text": "Store this but do not redraw.",
            },
        )
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()

    assert closed["result"] == {"closed": True}
    assert transcript["result"]["inserted"] is True


def test_realtime_transcript_rpc_persists_and_emits_once(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    runtime_id = "runtime-session"
    db.create_session(session_id="stored-session", source="desktop", model="test")
    live_session = {
        "session_key": "stored-session",
        "profile_home": None,
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
    }
    server._sessions[runtime_id] = live_session
    monkeypatch.setattr(server, "_db", db)
    emitted = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload)))

    try:
        first = server._methods["voice.realtime.transcript"](
            "request-1",
            {
                "session_id": runtime_id,
                "item_id": "item-user-1",
                "role": "user",
                "semantic_turn_id": "voice-turn-7",
                "text": "Draw the canvas as we talk.",
            },
        )["result"]
        duplicate = server._methods["voice.realtime.transcript"](
            "request-2",
            {
                "session_id": runtime_id,
                "item_id": "item-user-1",
                "role": "user",
                "semantic_turn_id": "voice-turn-7",
                "text": "Draw the canvas as we talk.",
            },
        )["result"]

        from run_agent import AIAgent

        agent = object.__new__(AIAgent)
        agent.__dict__.update(
            {
                "_session_db": db,
                "_session_db_created": True,
                "session_id": "stored-session",
                "platform": "desktop",
                "model": "test-model",
                "_last_flushed_db_idx": 0,
                "_flushed_db_message_ids": set(),
                "_flushed_db_message_session_id": None,
                "_persist_disabled": False,
                "_cached_system_prompt": None,
                "_session_init_model_config": None,
                "_parent_session_id": None,
                "_session_json_enabled": False,
                "quiet_mode": True,
            }
        )

        # Session finalization flushes this aliased history without a separate
        # conversation_history seed. The already-durable Realtime row must not
        # be appended again through the generic persistence path.
        agent._persist_session(live_session["history"])
        persisted_messages = db.get_messages("stored-session")
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()

    assert first["inserted"] is True
    assert duplicate == {"inserted": False, "message_id": first["message_id"]}
    assert [(message["role"], message["content"]) for message in persisted_messages] == [
        ("user", "Draw the canvas as we talk.")
    ]
    assert live_session["history"] == [
        {
            "role": "user",
            "content": "Draw the canvas as we talk.",
            "display_kind": "realtime_transcript",
            "_db_persisted": True,
            "display_metadata": {"semantic_turn_id": "voice-turn-7"},
        }
    ]
    assert live_session["history_version"] == 1
    assert emitted == [
        (
            "voice.realtime.transcript",
            runtime_id,
            {
                "item_id": "item-user-1",
                "message_id": first["message_id"],
                "role": "user",
                "semantic_turn_id": "voice-turn-7",
                "text": "Draw the canvas as we talk.",
            },
        )
    ]
