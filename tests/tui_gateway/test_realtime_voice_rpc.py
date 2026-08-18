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
    }
    assert captured == {
        "api_key": "sk-test",
        "model": "gpt-realtime-2.1",
        "voice": "marin",
        "transcription_model": "gpt-live-transcribe",
    }
    assert "voice.realtime.token" in server._LONG_HANDLERS


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
