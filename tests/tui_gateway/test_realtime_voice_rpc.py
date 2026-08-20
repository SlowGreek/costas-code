from hermes_cli.config_defaults import DEFAULT_CONFIG
from hermes_state import SessionDB
from tui_gateway import realtime_voice, server
from tools import tool_backend_helpers

import threading


def test_realtime_token_rpc_is_profile_scoped_and_uses_voice_config(monkeypatch):
    runtime_id = "runtime-session"
    server._sessions[runtime_id] = {"session_key": "stored-session", "profile_home": None}
    captured = {}

    monkeypatch.setattr(server, "_load_cfg", lambda: DEFAULT_CONFIG)
    monkeypatch.setattr(tool_backend_helpers, "resolve_openai_audio_api_key", lambda: "sk-test")

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
    assert envelope["result"] == {
        "client_secret": "ek_short",
        "expires_at": 1234,
        "model": "gpt-realtime-2.1",
        "voice": "marin",
        "workbench_watcher": {
            "active": False,
            "pipeline": "direct",
            "owns_redraws": False,
        },
    }
    assert captured == {
        "api_key": "sk-test",
        "model": "gpt-realtime-2.1",
        "voice": "marin",
        "transcription_model": "gpt-live-transcribe",
        "base_url": "",
    }
    assert "voice.realtime.token" in server._LONG_HANDLERS


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


def test_realtime_token_exposes_when_the_active_watcher_owns_redraws(monkeypatch):
    import copy

    runtime_id = "runtime-session"
    server._sessions[runtime_id] = {"session_key": "stored-session", "profile_home": None}
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["workbench"]["watcher"].update(
        {"enabled": True, "mode": "active", "pipeline": "direct"}
    )
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
    finally:
        server._sessions.pop(runtime_id, None)

    assert result["workbench_watcher"] == {
        "active": True,
        "pipeline": "direct",
        "owns_redraws": True,
    }


def test_realtime_token_freezes_watcher_ownership_for_the_voice_connection(monkeypatch):
    """Mid-session config flips must not create zero or two redraw owners.

    The voice tool list is fixed when the Realtime session opens. The watcher
    used to re-read config on every utterance, so active→shadow left NO redraw
    owner and shadow→active created TWO. Token mint must freeze the watcher
    config onto the live session, and transcript handling must use that copy.
    """
    import copy
    from tui_gateway import methods_realtime

    runtime_id = "runtime-frozen-watcher"
    live_session = {"session_key": "stored-frozen", "profile_home": None, "history": []}
    server._sessions[runtime_id] = live_session
    active_cfg = copy.deepcopy(DEFAULT_CONFIG)
    active_cfg["workbench"]["watcher"].update(
        {"enabled": True, "mode": "active", "pipeline": "direct"}
    )
    shadow_cfg = copy.deepcopy(active_cfg)
    shadow_cfg["workbench"]["watcher"]["mode"] = "shadow"

    monkeypatch.setattr(server, "_load_cfg", lambda: active_cfg)
    monkeypatch.setattr(tool_backend_helpers, "resolve_openai_audio_api_key", lambda: "sk-test")
    monkeypatch.setattr(
        realtime_voice,
        "create_realtime_client_secret",
        lambda **_: {"client_secret": "ek_short"},
    )

    captured = {}
    monkeypatch.setattr(
        methods_realtime,
        "_watch_transcript",
        lambda *_args, **kwargs: captured.update(cfg=kwargs["cfg"]),
    )

    try:
        server._methods["voice.realtime.token"]("token", {"session_id": runtime_id})
        # User edits config while this voice connection remains open.
        monkeypatch.setattr(server, "_load_cfg", lambda: shadow_cfg)
        server._methods["voice.realtime.transcript"](
            "transcript",
            {
                "session_id": runtime_id,
                "item_id": "u1",
                "role": "user",
                "text": "show me this",
            },
        )
    finally:
        server._sessions.pop(runtime_id, None)

    watcher = captured["cfg"]["workbench"]["watcher"]
    assert watcher["enabled"] is True
    assert watcher["mode"] == "active"
    assert watcher["pipeline"] == "direct"


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
                "text": "Draw the canvas as we talk.",
            },
        )["result"]
        duplicate = server._methods["voice.realtime.transcript"](
            "request-2",
            {
                "session_id": runtime_id,
                "item_id": "item-user-1",
                "role": "user",
                "text": "Draw the canvas as we talk.",
            },
        )["result"]
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()

    assert first["inserted"] is True
    assert duplicate == {"inserted": False, "message_id": first["message_id"]}
    assert live_session["history"] == [
        {
            "role": "user",
            "content": "Draw the canvas as we talk.",
            "display_kind": "realtime_transcript",
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
                "text": "Draw the canvas as we talk.",
            },
        )
    ]
