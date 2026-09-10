"""An explicitly bound bot route uses the title registry, not peer-recency recovery."""
from dataclasses import replace
from pathlib import Path

import pytest

from gateway.config import GatewayConfig, Platform
from gateway.session import SessionSource, SessionStore
from hermes_state import SessionDB


@pytest.fixture
def bot_route(tmp_path, monkeypatch):
    import hermes_state

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    root = tmp_path / ".hermes"
    home = root / "profiles" / "worker"
    home.mkdir(parents=True)
    (home / "profile.yaml").write_text("name: worker\nui_meta:\n  hermes-bots: {}\n")
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", hermes_state._IMPORT_DEFAULT_DB_PATH)
    config = GatewayConfig.from_dict({
        "multiplex_profiles": True,
        "profile_routes": [{"name": "worker-signal", "platform": "signal",
                            "profile": "worker", "chat_id": "group:work",
                            "bot_chat": True}],
    })
    db = SessionDB(db_path=home / "state.db")
    db.create_session("canonical", "cli")
    db.set_session_title("canonical", "Bot Chat")
    db.append_message("canonical", "user", "Keep the original desktop context.")
    db.append_message("canonical", "assistant", "Original context retained.")
    source = SessionSource(platform=Platform.SIGNAL, chat_id="group:work",
                           chat_type="group", user_id="owner-phone", profile="worker")
    store = SessionStore(root / "sessions", config)
    yield root, config, store, db, source
    for handle in store._db_handles.values():
        handle.close()
    db.close()


def test_bot_binding_survives_sender_alias_and_closed_owner(bot_route):
    root, config, store, db, source = bot_route
    # Reproduce the original one-off /resume setup: each sender representation
    # mints a temporary row before switching, leaving explicit boundary records.
    config.profile_routes = []
    for peer in (replace(source, user_id_alt="owner-uuid"), source):
        entry = store.get_or_create_session(peer)
        store.switch_session(entry.session_key, "canonical")
    db.end_session("canonical", "agent_close")
    config.profile_routes = GatewayConfig.from_dict({
        "profile_routes": [{"name": "worker-signal", "platform": "signal",
                            "profile": "worker", "chat_id": "group:work",
                            "bot_chat": True}],
    }).profile_routes
    # A restart must not let the last-recorded phone peer plus old switch
    # boundaries strand the UUID lane in a fresh, unrelated conversation.
    restarted = SessionStore(root / "sessions", config)
    try:
        routed = restarted.get_or_create_session(replace(source, user_id_alt="owner-uuid"))
        assert routed.session_id == "canonical"
        assert restarted.get_or_create_session(source).session_id == "canonical"
        assert db.get_session_by_title("Bot Chat")["id"] == "canonical"
        assert db.get_session("canonical")["end_reason"] is None
    finally:
        for handle in restarted._db_handles.values():
            handle.close()


def test_unbound_channel_keeps_ordinary_session_boundaries(bot_route):
    _root, _config, store, db, source = bot_route
    ordinary = replace(source, chat_id="group:ordinary")
    entry = store.get_or_create_session(ordinary)
    assert entry.session_id != "canonical"
    successor = store.reset_session(entry.session_key)
    assert successor.session_id not in {entry.session_id, "canonical"}
    assert db.get_session_by_title("Bot Chat")["id"] == "canonical"


def test_bot_reset_keeps_identity_and_compression_follows_only_real_lineage(bot_route):
    _root, _config, store, db, source = bot_route
    routed = store.get_or_create_session(source)
    assert store.reset_session(routed.session_key).session_id == "canonical"
    assert db.get_session("canonical")["end_reason"] is None
    db.create_session("side-chat", "cli", parent_session_id="canonical")
    assert store.get_or_create_session(source, force_new=True).session_id == "canonical"
    db.end_session("canonical", "compression")
    db.create_session("compressed-tip", "cli", parent_session_id="canonical")
    assert store.get_or_create_session(source).session_id == "compressed-tip"


def test_bound_route_refuses_missing_registry_and_profile_mismatch(bot_route):
    from gateway.session_bot_chat import BotChatRoutingError

    _root, _config, store, db, source = bot_route
    with pytest.raises(BotChatRoutingError, match="authorized profile"):
        store.get_or_create_session(replace(source, profile="other"))
    db.set_session_title("canonical", "Archived relationship")
    with pytest.raises(BotChatRoutingError, match="No canonical"):
        store.get_or_create_session(source)


@pytest.mark.parametrize("command", ["/new", "/reset"])
def test_bot_reset_dispatch_compacts_idle_and_preserves_busy_work(bot_route, command):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from gateway.platforms.event import MessageEvent
    from gateway.run_busy import GatewayBusySessionMixin
    from gateway.slash_commands_session import GatewaySessionCommandsMixin

    _root, config, store, _db, source = bot_route
    event = MessageEvent(text=command, source=source)
    runner = SimpleNamespace(config=config, _handle_compress_command=AsyncMock(return_value="compacted"),
                             _interrupt_and_clear_session=AsyncMock())
    result = asyncio.run(GatewaySessionCommandsMixin._handle_reset_command(runner, event))
    assert result == "compacted"
    runner._handle_compress_command.assert_awaited_once_with(event)
    result = asyncio.run(GatewayBusySessionMixin._busy_new_command(
        runner, event, store._generate_session_key(source), source))
    assert "queued messages were left untouched" in str(result)
    runner._interrupt_and_clear_session.assert_not_awaited()
