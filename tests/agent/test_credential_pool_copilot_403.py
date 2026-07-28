"""Copilot 403 handling and endpoint persistence in the credential pool.

Regression coverage for the crash/auth loop where a single Copilot 403 took the
only credential out of rotation for an hour, and where an endpoint captured
under one account survived a switch to another.

The reference behaviour is the official runtime
(copilot-agent-runtime): a 403 is surfaced as a plain error and never disables
a credential (``core/helpers/httpApiUtils.ts``), and the Copilot API URL is
always re-derived from the live auth info rather than stored
(``runtime/src/auth/core.rs::get_copilot_api_url``).
"""

from __future__ import annotations

import json

import pytest


@pytest.fixture(autouse=True)
def _no_ambient_copilot_credentials(monkeypatch):
    """Keep the developer's real Copilot token out of these pools.

    ``load_pool`` seeds Copilot entries from the environment and from
    ``gh auth token``. Without this, a machine that is signed in to Copilot
    contributes an extra credential and the assertions below describe the
    developer's account rather than the fixture.
    """
    for var in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setattr(copilot_auth, "resolve_copilot_token", lambda *a, **k: ("", ""))
    monkeypatch.setattr(
        copilot_auth, "get_copilot_api_token", lambda token: (token, None)
    )


def _write_auth_store(tmp_path, payload: dict) -> None:
    hermes_home = tmp_path / "hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    (hermes_home / "auth.json").write_text(json.dumps(payload, indent=2))


def _copilot_store(*, base_url: str | None = None, entries: int = 1) -> dict:
    pool = []
    for idx in range(entries):
        entry = {
            "id": f"cred-{idx + 1}",
            "label": f"key-{idx + 1}",
            "auth_type": "api_key",
            "priority": idx,
            "source": "manual" if idx == 0 else f"manual:{idx}",
            "access_token": f"ghu_token_{idx + 1}",
            "last_status": "ok",
        }
        if base_url:
            entry["base_url"] = base_url
        pool.append(entry)
    return {"version": 1, "credential_pool": {"copilot": pool}}


# ── 403 must not exhaust a Copilot credential ────────────────────────────────


def test_copilot_403_does_not_exhaust_the_only_credential(tmp_path, monkeypatch):
    """A single-entry Copilot pool stays usable after a 403.

    This is the exact shape that produced the auth loop: one credential, one
    403, and every later model call failing with "no available entries".
    """
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    _write_auth_store(tmp_path, _copilot_store())

    from agent.credential_pool import load_pool

    pool = load_pool("copilot")
    assert pool.select().id == "cred-1"

    next_entry = pool.mark_exhausted_and_rotate(status_code=403)

    # The credential is handed back, not locked out.
    assert next_entry is not None
    assert next_entry.id == "cred-1"
    assert pool.has_available() is True

    entry = next(e for e in pool._entries if e.id == "cred-1")
    assert entry.last_status != "exhausted"
    assert entry.last_error_code != 403


def test_copilot_403_is_not_persisted_as_exhausted(tmp_path, monkeypatch):
    """The lockout must not survive a restart.

    The original failure persisted ``last_status: exhausted`` to auth.json, so
    restarting the app did not clear it.
    """
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    _write_auth_store(tmp_path, _copilot_store())

    from agent.credential_pool import load_pool

    pool = load_pool("copilot")
    pool.select()
    pool.mark_exhausted_and_rotate(status_code=403)

    reloaded = load_pool("copilot")
    assert reloaded.has_available() is True
    assert reloaded.select() is not None


def test_copilot_403_still_rotates_when_another_credential_exists(tmp_path, monkeypatch):
    """Multi-credential setups still fail over on 403."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    _write_auth_store(tmp_path, _copilot_store(entries=2))

    from agent.credential_pool import load_pool

    pool = load_pool("copilot")
    assert pool.select().id == "cred-1"

    next_entry = pool.mark_exhausted_and_rotate(status_code=403)

    assert next_entry is not None
    assert next_entry.id == "cred-2"
    # ...and the rotated-away credential was still not disabled.
    first = next(e for e in pool._entries if e.id == "cred-1")
    assert first.last_status != "exhausted"


def test_copilot_402_still_exhausts(tmp_path, monkeypatch):
    """Only 403 is special-cased; real quota failures still take a key out."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    _write_auth_store(tmp_path, _copilot_store(entries=2))

    from agent.credential_pool import load_pool

    pool = load_pool("copilot")
    pool.select()
    pool.mark_exhausted_and_rotate(status_code=402)

    persisted = json.loads((tmp_path / "hermes" / "auth.json").read_text())
    entry = persisted["credential_pool"]["copilot"][0]
    assert entry["last_status"] == "exhausted"
    assert entry["last_error_code"] == 402


def test_non_copilot_403_still_exhausts(tmp_path, monkeypatch):
    """The 403 carve-out is scoped to Copilot and must not leak to others."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    _write_auth_store(
        tmp_path,
        {
            "version": 1,
            "credential_pool": {
                "anthropic": [
                    {
                        "id": "cred-1",
                        "label": "primary",
                        "auth_type": "api_key",
                        "priority": 0,
                        "source": "manual",
                        "access_token": "sk-ant-1",
                        "last_status": "ok",
                    },
                ]
            },
        },
    )

    from agent.credential_pool import load_pool

    pool = load_pool("anthropic")
    pool.select()
    pool.mark_exhausted_and_rotate(status_code=403)

    persisted = json.loads((tmp_path / "hermes" / "auth.json").read_text())
    assert persisted["credential_pool"]["anthropic"][0]["last_status"] == "exhausted"


# ── 403 cooldown is short, not an hour ───────────────────────────────────────


def test_403_cooldown_is_not_the_hour_long_default():
    """403 is an authorization answer, never a quota signal."""
    from agent.credential_pool import (
        EXHAUSTED_TTL_DEFAULT_SECONDS,
        _exhausted_ttl,
    )

    ttl = _exhausted_ttl(403)
    assert ttl < EXHAUSTED_TTL_DEFAULT_SECONDS
    assert ttl == 5 * 60


def test_429_cooldown_is_unchanged():
    from agent.credential_pool import EXHAUSTED_TTL_429_SECONDS, _exhausted_ttl

    assert _exhausted_ttl(429) == EXHAUSTED_TTL_429_SECONDS


# ── the Copilot endpoint is never persisted ──────────────────────────────────


@pytest.mark.parametrize("provider", ["copilot", "github-copilot"])
def test_copilot_endpoint_is_never_written_to_disk(provider):
    """``base_url`` must not round-trip for Copilot or any of its aliases.

    Persisting it let an endpoint resolved under one account outlive a switch
    to another and silently override the correct one.
    """
    from agent.credential_pool import PooledCredential

    entry = PooledCredential.from_dict(
        provider,
        {
            "id": "cred-1",
            "label": "primary",
            "auth_type": "api_key",
            "source": "env:COPILOT_GITHUB_TOKEN",
            "access_token": "ghu_token",
            "base_url": "https://api.githubcopilot.com",
        },
    )

    assert entry.base_url == "https://api.githubcopilot.com"  # usable in-memory
    assert "base_url" not in entry.to_dict()  # but never persisted


def test_non_copilot_endpoint_is_still_persisted():
    """Only Copilot endpoints are account-derived; others still round-trip."""
    from agent.credential_pool import PooledCredential

    entry = PooledCredential.from_dict(
        "openrouter",
        {
            "id": "cred-1",
            "label": "primary",
            "auth_type": "api_key",
            "source": "manual",
            "access_token": "sk-or-1",
            "base_url": "https://openrouter.ai/api/v1",
        },
    )

    assert entry.to_dict()["base_url"] == "https://openrouter.ai/api/v1"


def test_stale_persisted_copilot_endpoint_is_dropped_on_reload(tmp_path, monkeypatch):
    """A pre-existing stale endpoint in auth.json does not survive a rewrite."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    _write_auth_store(tmp_path, _copilot_store(base_url="https://api.githubcopilot.com"))

    from agent.credential_pool import load_pool

    pool = load_pool("copilot")
    pool.select()
    # Any status write rewrites the store.
    pool.mark_exhausted_and_rotate(status_code=402)

    persisted = json.loads((tmp_path / "hermes" / "auth.json").read_text())
    assert "base_url" not in persisted["credential_pool"]["copilot"][0]
