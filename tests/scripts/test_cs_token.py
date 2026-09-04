"""Behavior contracts for ``scripts/cs_token.py``.

Exercises the real module against a temp ``HERMES_HOME`` — no network, no
Azure CLI. What matters is the resolution order (cache → Peeps → az CLI),
that expired tokens are never emitted, and that a bearer is never written
into a world-readable file.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

_MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "cs_token.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("cs_token_under_test", _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def cs_token(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("PEEPS_TOKEN_FILE", raising=False)
    return _load_module()


def _jwt(exp: float) -> str:
    def seg(payload: dict) -> str:
        raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
        return raw.rstrip("=")

    return f"{seg({'alg': 'none'})}.{seg({'exp': int(exp)})}.sig"


def test_fresh_cached_token_is_reused_without_minting(cs_token, tmp_path, capsys):
    token = _jwt(time.time() + 3600)
    (tmp_path / ".cs-token.json").write_text(json.dumps({"token": token}))

    def fail(*_args, **_kwargs):  # pragma: no cover - must not run
        raise AssertionError("a fresh cache must not trigger a mint")

    cs_token.from_peeps = fail
    cs_token.from_azure_cli = fail

    assert cs_token.main() == 0
    assert capsys.readouterr().out.strip() == token


def test_expired_cache_falls_through_to_peeps(cs_token, tmp_path, capsys):
    (tmp_path / ".cs-token.json").write_text(
        json.dumps({"token": _jwt(time.time() - 60)})
    )
    minted = _jwt(time.time() + 3600)
    cs_token.from_peeps = lambda: minted
    cs_token.from_azure_cli = lambda: pytest.fail("Peeps should win before az CLI")

    assert cs_token.main() == 0
    assert capsys.readouterr().out.strip() == minted


def test_peeps_failure_falls_through_to_azure_cli(cs_token, capsys):
    minted = _jwt(time.time() + 3600)
    cs_token.from_peeps = lambda: ""
    cs_token.from_azure_cli = lambda: minted

    assert cs_token.main() == 0
    assert capsys.readouterr().out.strip() == minted


def test_no_source_fails_loudly_without_emitting_a_token(cs_token, capsys):
    cs_token.from_peeps = lambda: ""
    cs_token.from_azure_cli = lambda: ""

    assert cs_token.main() == 1
    captured = capsys.readouterr()
    assert captured.out.strip() == ""
    assert "no Cognitive Services token" in captured.err


def test_expired_minted_token_is_never_emitted(cs_token, capsys):
    cs_token.from_peeps = lambda: _jwt(time.time() - 1)
    cs_token.from_azure_cli = lambda: _jwt(time.time() - 1)

    assert cs_token.main() == 1
    assert capsys.readouterr().out.strip() == ""


def test_cache_file_is_owner_only(cs_token, tmp_path):
    token = _jwt(time.time() + 3600)
    cs_token.from_peeps = lambda: token
    cs_token.from_azure_cli = lambda: ""

    assert cs_token.main() == 0
    cache = tmp_path / ".cs-token.json"
    assert json.loads(cache.read_text())["token"] == token
    if os.name != "nt":
        assert cache.stat().st_mode & 0o077 == 0


@pytest.mark.parametrize(
    "raw, expected",
    [
        (b'{"token": "abc"}', "abc"),
        (b'{"accessToken": "abc"}', "abc"),
        (b'{"access_token": "abc"}', "abc"),
        (b'"abc"', "abc"),
        (b"abc", "abc"),
        (b"{}", ""),
        (b"[1, 2]", ""),
    ],
)
def test_exchange_response_shapes(cs_token, raw, expected):
    assert cs_token.parse_exchange_response(raw) == expected


def test_malformed_jwt_is_not_fresh(cs_token):
    assert cs_token.token_expiry("not-a-jwt") == 0
    assert not cs_token.is_fresh("not-a-jwt")
    assert not cs_token.is_fresh("")
