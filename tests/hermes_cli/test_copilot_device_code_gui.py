"""Copilot device-code login must be drivable from a GUI, not just a TTY.

``copilot_device_code_login()`` blocks and prints to stdout, so the desktop
Accounts tab could never drive it — the Copilot card was ``flow: external``,
telling users to go run ``hermes model`` in a terminal. These tests pin the
headless primitives the GUI flow is built on, and the contract that the
terminal wrapper still behaves identically on top of them.
"""

import pytest

import hermes_cli.copilot_auth as copilot_auth


class _FakeResp:
    def __init__(self, payload):
        import json as _json

        self._body = _json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _patch_urlopen(monkeypatch, payload_or_exc):
    """Patch urllib.request.urlopen as used inside copilot_auth."""
    import urllib.request

    def fake(req, timeout=None):
        if isinstance(payload_or_exc, Exception):
            raise payload_or_exc
        return _FakeResp(payload_or_exc)

    monkeypatch.setattr(urllib.request, "urlopen", fake)


class TestRequestDeviceCode:
    """copilot_request_device_code returns display fields or raises."""

    def test_returns_display_fields(self, monkeypatch):
        _patch_urlopen(monkeypatch, {
            "device_code": "dc-1",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
        })
        data = copilot_auth.copilot_request_device_code()
        assert data["device_code"] == "dc-1"
        assert data["user_code"] == "ABCD-1234"
        assert data["verification_uri"] == "https://github.com/login/device"
        assert data["interval"] == 5

    def test_interval_floor_is_one(self, monkeypatch):
        """A zero/missing interval must not produce a hot polling loop."""
        _patch_urlopen(monkeypatch, {
            "device_code": "dc", "user_code": "U", "interval": 0,
        })
        assert copilot_auth.copilot_request_device_code()["interval"] >= 1

    def test_verification_uri_defaulted(self, monkeypatch):
        _patch_urlopen(monkeypatch, {"device_code": "dc", "user_code": "U"})
        data = copilot_auth.copilot_request_device_code()
        assert data["verification_uri"].startswith("https://")

    def test_missing_device_code_raises(self, monkeypatch):
        _patch_urlopen(monkeypatch, {"user_code": "U"})
        with pytest.raises(ValueError):
            copilot_auth.copilot_request_device_code()

    def test_network_failure_raises_without_leaking_detail(self, monkeypatch):
        """GitHub error bodies can echo request material — keep them out."""
        _patch_urlopen(monkeypatch, RuntimeError("token=gho_supersecret"))
        with pytest.raises(ValueError) as exc:
            copilot_auth.copilot_request_device_code()
        assert "gho_supersecret" not in str(exc.value)


class TestPollDeviceCode:
    """copilot_poll_device_code maps GitHub replies to (token, error)."""

    def test_success_returns_token(self, monkeypatch):
        _patch_urlopen(monkeypatch, {"access_token": "ghu_abc"})
        assert copilot_auth.copilot_poll_device_code("dc") == ("ghu_abc", None)

    def test_pending_is_not_an_error(self, monkeypatch):
        _patch_urlopen(monkeypatch, {"error": "authorization_pending"})
        assert copilot_auth.copilot_poll_device_code("dc") == (None, None)

    def test_transient_network_failure_is_not_an_error(self, monkeypatch):
        """A dropped poll must be retryable, not fatal."""
        _patch_urlopen(monkeypatch, RuntimeError("connection reset"))
        assert copilot_auth.copilot_poll_device_code("dc") == (None, None)

    @pytest.mark.parametrize(
        "code", ["access_denied", "expired_token", "slow_down", "unusual_thing"]
    )
    def test_terminal_codes_surface(self, monkeypatch, code):
        _patch_urlopen(monkeypatch, {"error": code})
        token, error = copilot_auth.copilot_poll_device_code("dc")
        assert token is None
        assert error == code


class TestTerminalWrapperUsesPrimitives:
    """The CLI flow is a wrapper, not a second implementation."""

    def test_login_returns_token_from_primitives(self, monkeypatch, capsys):
        monkeypatch.setattr(
            copilot_auth, "copilot_request_device_code",
            lambda **kw: {
                "device_code": "dc", "user_code": "UC-1",
                "verification_uri": "https://gh/device", "interval": 1,
            },
        )
        monkeypatch.setattr(
            copilot_auth, "copilot_poll_device_code",
            lambda dc, **kw: ("ghu_tok", None),
        )
        monkeypatch.setattr(copilot_auth.time, "sleep", lambda s: None)

        assert copilot_auth.copilot_device_code_login() == "ghu_tok"
        # The user code must actually reach the terminal.
        assert "UC-1" in capsys.readouterr().out

    def test_login_returns_none_on_denial(self, monkeypatch):
        monkeypatch.setattr(
            copilot_auth, "copilot_request_device_code",
            lambda **kw: {
                "device_code": "dc", "user_code": "U",
                "verification_uri": "https://gh", "interval": 1,
            },
        )
        monkeypatch.setattr(
            copilot_auth, "copilot_poll_device_code",
            lambda dc, **kw: (None, "access_denied"),
        )
        monkeypatch.setattr(copilot_auth.time, "sleep", lambda s: None)
        assert copilot_auth.copilot_device_code_login() is None

    def test_login_returns_none_when_start_fails(self, monkeypatch):
        def boom(**kw):
            raise ValueError("Failed to start device authorization")

        monkeypatch.setattr(copilot_auth, "copilot_request_device_code", boom)
        assert copilot_auth.copilot_device_code_login() is None

    def test_slow_down_widens_interval_and_continues(self, monkeypatch):
        """slow_down must back off, not abort the login."""
        monkeypatch.setattr(
            copilot_auth, "copilot_request_device_code",
            lambda **kw: {
                "device_code": "dc", "user_code": "U",
                "verification_uri": "https://gh", "interval": 1,
            },
        )
        replies = [(None, "slow_down"), ("ghu_ok", None)]
        monkeypatch.setattr(
            copilot_auth, "copilot_poll_device_code",
            lambda dc, **kw: replies.pop(0),
        )
        slept = []
        monkeypatch.setattr(copilot_auth.time, "sleep", lambda s: slept.append(s))

        assert copilot_auth.copilot_device_code_login() == "ghu_ok"
        assert slept[1] > slept[0], "interval must widen after slow_down"


class TestCatalogWiring:
    """The Accounts card must offer an in-app flow, not a terminal errand."""

    def test_copilot_card_is_device_code(self):
        from hermes_cli.web_server import _OAUTH_PROVIDER_CATALOG

        entry = next(p for p in _OAUTH_PROVIDER_CATALOG if p["id"] == "copilot")
        # `external` means read-only in the UI — the whole bug being fixed.
        assert entry["flow"] == "device_code"

    def test_copilot_acp_remains_external(self):
        """The ACP card delegates to the Copilot CLI and must stay read-only."""
        from hermes_cli.web_server import _OAUTH_PROVIDER_CATALOG

        entry = next(
            p for p in _OAUTH_PROVIDER_CATALOG if p["id"] == "copilot-acp"
        )
        assert entry["flow"] == "external"
