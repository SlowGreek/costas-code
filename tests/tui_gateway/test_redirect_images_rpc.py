"""`session.redirect` must accept images passed as RPC params.

The desktop stages a correction's images itself and passes their paths on the
`session.redirect` call. That params path is the one the UI actually uses, and
it was the missing link: the gateway drained `session["attached_images"]` (what
`image.attach` stages) but ignored `params["images"]`, so a screenshot attached
in the composer never reached the model even though every layer below was
already parts-aware.

These tests pin the RPC contract itself -- that params images are read, that
they merge with staged ones without duplicating, and that an image-only
correction is not rejected as empty.
"""

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
    """Minimal stand-in for a live, redirect-capable agent."""

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


def _paths_seen(monkeypatch, server) -> list[list[str]]:
    """Capture the image paths handed to the payload builder."""
    seen: list[list[str]] = []

    def _fake(agent, text, images):
        seen.append(list(images))
        return text

    monkeypatch.setattr(server, "_redirect_payload_with_images", _fake)
    return seen


def test_images_from_params_reach_the_payload_builder(server, live_session, monkeypatch):
    """The desktop passes staged paths as params -- they must be honored.

    This is the exact wiring that was missing: without it the composer's
    screenshot is silently dropped and the correction arrives as text only.
    """
    sid, _, _ = live_session
    seen = _paths_seen(monkeypatch, server)

    _redirect(server, sid, text="look at this", images=["/tmp/a.png"])

    assert seen == [["/tmp/a.png"]], (
        "params['images'] must be forwarded to the redirect payload builder"
    )


def test_params_and_staged_images_merge_without_duplicates(
    server, live_session, monkeypatch
):
    """A path can arrive twice (params + image.attach); send it once.

    Duplicating burns tokens and reads to the model as two distinct images.
    """
    sid, session, _ = live_session
    session["attached_images"] = ["/tmp/a.png", "/tmp/b.png"]
    seen = _paths_seen(monkeypatch, server)

    _redirect(server, sid, text="check these", images=["/tmp/a.png"])

    assert seen == [["/tmp/a.png", "/tmp/b.png"]], (
        "params images come first, staged images follow, duplicates collapse"
    )


def test_staged_images_are_drained(server, live_session, monkeypatch):
    """Staged images belong to THIS correction, not the next turn."""
    sid, session, _ = live_session
    session["attached_images"] = ["/tmp/a.png"]
    _paths_seen(monkeypatch, server)

    _redirect(server, sid, text="now")

    assert session["attached_images"] == [], (
        "images left in the queue would silently ride the next turn"
    )


def test_image_only_correction_is_not_rejected_as_empty(
    server, live_session, monkeypatch
):
    """Pointing at a screenshot with no words is a real correction."""
    sid, _, _ = live_session
    _paths_seen(monkeypatch, server)

    result = _redirect(server, sid, text="", images=["/tmp/a.png"])

    assert "error" not in result, f"image-only correction was rejected: {result}"


def test_no_text_and_no_images_is_still_an_error(server, live_session):
    """An empty correction must remain an error, not a no-op redirect."""
    sid, _, _ = live_session

    result = _redirect(server, sid, text="   ")

    assert "error" in result, "a wholly empty correction must be refused"


def test_text_only_redirect_passes_the_string_through(server, live_session):
    """No images means no parts list -- the plain-text path is unchanged."""
    sid, _, agent = live_session

    _redirect(server, sid, text="just words")

    assert agent.received == "just words", (
        "a text-only correction must not be wrapped in a parts list"
    )
