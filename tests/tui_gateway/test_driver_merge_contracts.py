"""Behavior at extraction seams carrying fork driver features."""
from __future__ import annotations

import asyncio
import threading
import time
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock


def test_anonymous_rpc_helpers_do_not_collide_in_split_namespace():
    from tui_gateway.method_ctx import HandlerRegistry, bind_module

    server = ModuleType("fake_server")
    server._methods = {}
    for module_name, route in (("split_a", "one"), ("split_b", "two")):
        module = ModuleType(module_name)
        module.HandlerRegistry = HandlerRegistry
        exec("_registry = HandlerRegistry()\n@_registry.method(%r)\ndef _(rid, params): return %r" % (route, route), module.__dict__)
        bind_module(module.__dict__, server)
    assert server._methods["one"](1, {}) == "one"
    assert server._methods["two"](2, {}) == "two"


def test_copilot_start_routes_to_headless_primitives(monkeypatch):
    from hermes_cli import copilot_auth, web_server_oauth
    from hermes_cli.web_routers import oauth

    device = {"device_code": "test-device", "user_code": "TEST-CODE", "interval": 2,
              "expires_in": 120, "verification_uri": "https://github.com/login/device"}
    monkeypatch.setattr(copilot_auth, "copilot_request_device_code", lambda: device)
    calls = []
    monkeypatch.setattr(oauth, "_device_session_started", lambda *args: calls.append(args) or {"started": True})
    assert asyncio.run(oauth._start_device_code_flow("copilot")) == {"started": True}
    args = calls[0]
    assert args[0] == "copilot"
    assert args[2] is web_server_oauth._copilot_poller
    assert args[3]["device_code"] == device["device_code"]
    assert args[4:] == ("TEST-CODE", device["verification_uri"], 120, 2)
    assert next(row for row in web_server_oauth._OAUTH_PROVIDER_CATALOG if row["id"] == "copilot")["flow"] == "device_code"
    assert next(row for row in web_server_oauth._OAUTH_PROVIDER_CATALOG if row["id"] == "copilot-acp")["flow"] == "external"


def test_copilot_poller_persists_device_token_and_account_probe_distinguishes_gh(monkeypatch):
    from hermes_cli import config, copilot_auth, web_server_oauth as oauth
    from hermes_cli import web_server_profiles
    from contextlib import nullcontext

    sess = {"device_code": "test-device", "interval": 1, "expires_at": time.time() + 120}
    monkeypatch.setattr(oauth, "_oauth_sessions", {"test-flow": sess})
    monkeypatch.setattr(oauth, "_oauth_sessions_lock", threading.Lock())
    monkeypatch.setattr(oauth, "_oauth_session_profile", lambda sid: None)
    monkeypatch.setattr(web_server_profiles, "_profile_scope", lambda profile: nullcontext())
    monkeypatch.setattr(oauth.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(copilot_auth, "copilot_poll_device_code", lambda code: ("ghu_test_only", None))
    saved = []
    monkeypatch.setattr(config, "save_env_value", lambda name, value: saved.append((name, value)))
    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "before-test")
    oauth._copilot_poller("test-flow")
    assert sess["status"] == "approved"
    assert saved == [("COPILOT_GITHUB_TOKEN", "ghu_test_only")]
    monkeypatch.setattr(copilot_auth, "resolve_copilot_token", lambda: ("gho_test_only", "gh auth token"))
    assert oauth._copilot_status()["logged_in"] is False
    monkeypatch.setattr(copilot_auth, "resolve_copilot_token", lambda: ("ghu_test_only", "COPILOT_GITHUB_TOKEN"))
    assert oauth._copilot_status()["logged_in"] is True


def test_copilot_disconnect_clears_credential_and_process_copy(monkeypatch):
    import os
    from hermes_cli import auth, config
    from hermes_cli.web_routers import oauth

    monkeypatch.setattr(oauth, "_require_token", lambda request: None)
    monkeypatch.setattr(oauth, "_build_oauth_catalog", lambda: [{"id": "copilot", "flow": "device_code"}])
    monkeypatch.setattr(oauth, "_resolve_provider_status", lambda *args: {"logged_in": True})
    async def scoped(profile, fn):
        return fn()
    monkeypatch.setattr(oauth, "scoped_to_thread", scoped)
    removed, cleared = Mock(return_value=True), Mock(return_value=False)
    monkeypatch.setattr(config, "remove_env_value", removed)
    monkeypatch.setattr(auth, "clear_provider_auth", cleared)
    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "test-only")
    assert asyncio.run(oauth.disconnect_oauth_provider("copilot", SimpleNamespace())) == {"ok": True, "provider": "copilot"}
    removed.assert_called_once_with("COPILOT_GITHUB_TOKEN")
    cleared.assert_called_once_with("copilot")
    assert "COPILOT_GITHUB_TOKEN" not in os.environ
