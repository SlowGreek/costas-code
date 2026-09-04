from hermes_cli.config_defaults import DEFAULT_CONFIG
from hermes_state import SessionDB
from tui_gateway import realtime_voice, server
from tools import tool_backend_helpers, web_tools

import threading
import copy
import base64
import hashlib
from pathlib import Path


class _BoundTransport:
    def __init__(self):
        self.frames = []
        self.ready = threading.Event()

    def write(self, frame):
        self.frames.append(frame)
        self.ready.set()
        return True


def _dispatch_and_wait(method, params, transport):
    result = server.dispatch({"jsonrpc": "2.0", "id": method, "method": method, "params": params}, transport)
    if result is not None:
        return result
    assert transport.ready.wait(3)
    return transport.frames[-1]


def test_peeps_public_start_is_removed_and_generation_is_transport_session_bound(monkeypatch):
    from agent.command_token_source import CommandTokenError
    from tui_gateway.peeps_voice_auth import PeepsVoiceAuthSessionStore

    runtime_id = "runtime-peeps-bound"
    transport = _BoundTransport()
    session = {"session_key": "stored", "profile_home": None, "transport": transport}
    server._sessions[runtime_id] = session
    server._realtime_peeps_auth = {"sessions": PeepsVoiceAuthSessionStore()}
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["voice"]["realtime"].update({
        "base_url": "https://res.openai.azure.com/openai/v1",
        "key_cmd": "false",
    })
    cfg["voice"]["realtime"]["peeps_fallback"]["enabled"] = True
    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)
    monkeypatch.setattr(
        "agent.command_token_source.build_command_token_provider",
        lambda *_: lambda: (_ for _ in ()).throw(CommandTokenError("no")),
    )
    try:
        secret = b"m" * 32
        proof = base64.urlsafe_b64encode(secret).rstrip(b"=").decode()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(secret).digest()).rstrip(b"=").decode()
        handle = base64.urlsafe_b64encode(b"h" * 32).rstrip(b"=").decode()
        started = _dispatch_and_wait(
            "voice.realtime.token",
            {"session_id": runtime_id, "peeps_main_handle": handle, "peeps_main_challenge": challenge},
            transport,
        )["result"]
        assert "voice.realtime.peeps.start" not in server._methods
        assert "voice.realtime.peeps.start" not in server._LONG_HANDLERS
        assert set(started) == {"auth_session_id", "provider", "status", "timeout_seconds"}

        attacker = _BoundTransport()
        for unproved_transport in (attacker, transport):
            missing_proof = _dispatch_and_wait(
                "voice.realtime.peeps.claim",
                {"session_id": runtime_id, "auth_session_id": started["auth_session_id"]},
                unproved_transport,
            )
            assert missing_proof["error"]["code"] == 4613

        claimed = _dispatch_and_wait(
            "voice.realtime.peeps.claim",
            {
                "session_id": runtime_id,
                "auth_session_id": started["auth_session_id"],
                "peeps_main_handle": handle,
                "native_main_proof": proof,
            },
            attacker,
        )
        assert "result" in claimed, claimed
        assert set(claimed["result"]) == {"auth_session_id", "state", "public_key", "timeout_seconds"}

        replay = _dispatch_and_wait(
            "voice.realtime.peeps.claim",
            {
                "session_id": runtime_id,
                "auth_session_id": started["auth_session_id"],
                "peeps_main_handle": handle,
                "native_main_proof": proof,
            },
            transport,
        )
        assert replay["error"]["code"] == 4613

        bystander = _BoundTransport()
        unproved_cancel = _dispatch_and_wait(
            "voice.realtime.peeps.cancel",
            {"session_id": runtime_id, "auth_session_id": started["auth_session_id"]},
            bystander,
        )
        assert unproved_cancel["result"] == {"ok": False}

        companion_cancel = _dispatch_and_wait(
            "voice.realtime.peeps.cancel",
            {"session_id": runtime_id, "auth_session_id": started["auth_session_id"]},
            attacker,
        )
        assert companion_cancel["result"] == {"ok": True}

        rebound = {**session, "transport": transport}
        server._sessions[runtime_id] = rebound
        rebound_result = _dispatch_and_wait(
            "voice.realtime.peeps.cancel",
            {"session_id": runtime_id, "auth_session_id": started["auth_session_id"]},
            transport,
        )
        assert rebound_result["result"] == {"ok": False}
    finally:
        server._sessions.pop(runtime_id, None)


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
