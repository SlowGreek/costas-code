"""Parity checks for upstream's text-only ``session.redirect`` RPC."""

import importlib
import threading
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    with patch.dict(
        "sys.modules",
        {
            "hermes_cli.env_loader": MagicMock(),
            "hermes_cli.banner": MagicMock(),
        },
    ):
        mod = importlib.import_module("tui_gateway.server")
        yield mod
        mod._sessions.clear()
        mod._pending.clear()
        mod._answers.clear()


class _Agent:
    _supports_active_turn_redirect = True

    def __init__(self):
        self.received = None

    def redirect(self, payload):
        self.received = payload
        return True


@pytest.fixture()
def live_session(server):
    sid = "sid-redirect"
    agent = _Agent()
    server._sessions[sid] = {
        "session_key": "tui-redirect-1",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": True,
        "attached_images": [],
        "agent": agent,
        "cols": 120,
    }
    return sid, server._sessions[sid], agent


def _redirect(server, sid, **params):
    return server._methods["session.redirect"](1, {"session_id": sid, **params})


def test_redirect_ignores_image_params_and_passes_text_only(server, live_session):
    sid, _, agent = live_session

    result = _redirect(server, sid, text="look at this", images=["/tmp/a.png"])

    assert "error" not in result
    assert agent.received == "look at this"


def test_image_only_redirect_is_rejected_as_empty(server, live_session):
    sid, _, agent = live_session

    result = _redirect(server, sid, text="", images=["/tmp/a.png"])

    assert "error" in result
    assert agent.received is None


def test_redirect_does_not_consume_staged_images(server, live_session):
    sid, session, agent = live_session
    session["attached_images"] = ["/tmp/a.png"]

    result = _redirect(server, sid, text="just words")

    assert "error" not in result
    assert agent.received == "just words"
    assert session["attached_images"] == ["/tmp/a.png"]
