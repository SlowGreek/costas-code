"""Copilot client identity and provider-alias regression coverage.

Hermes' Copilot integration is meant to mirror the official runtime
(copilot-agent-runtime). Two divergences caused real failures:

* the request headers impersonated VS Code (``vscode-chat`` +
  ``Editor-Version: vscode/1.104.1``) instead of identifying honestly as
  ``copilot-developer-cli`` — the shape of request a managed/enterprise
  account rejects with a Terms-of-Service 403 that names no real cause;
* Copilot-specific auth branches keyed off a bare ``provider == "copilot"``
  check, so the ``github-copilot`` alias skipped enterprise endpoint
  resolution entirely and silently fell back to the generic host.

Reference: ``src/runtime/src/model/capi_client.rs`` (``push_static_headers``)
and ``src/helpers/packageVersion.ts``.
"""

from __future__ import annotations

import re

import pytest


# ── client identity matches the reference ────────────────────────────────────


def test_integration_id_is_the_official_cli_not_vscode():
    from hermes_cli.copilot_auth import copilot_request_headers

    headers = copilot_request_headers()
    assert headers["Copilot-Integration-Id"] == "copilot-developer-cli"


def test_does_not_impersonate_vscode_anywhere_in_headers():
    """No header may claim this client is VS Code."""
    from hermes_cli.copilot_auth import copilot_request_headers

    blob = " ".join(f"{k}:{v}" for k, v in copilot_request_headers().items()).lower()
    assert "vscode" not in blob
    assert "vscode-chat" not in blob


def test_editor_version_is_product_slash_version():
    from hermes_cli.copilot_auth import copilot_request_headers

    editor = copilot_request_headers()["Editor-Version"]
    assert editor.startswith("copilot-developer-cli/")
    assert re.match(r"^copilot-developer-cli/\d+\.\d+", editor), editor


def test_user_agent_is_product_version_and_platform():
    from hermes_cli.copilot_auth import copilot_request_headers

    ua = copilot_request_headers()["User-Agent"]
    assert ua.startswith("copilot-developer-cli/")
    assert "HermesAgent" not in ua
    assert "(" in ua and ")" in ua


def test_github_api_version_is_pinned():
    """capi_client.rs pins GITHUB_API_VERSION_VALUE; we must send it too."""
    from hermes_cli.copilot_auth import copilot_request_headers

    assert copilot_request_headers()["X-GitHub-Api-Version"] == "2026-07-01"


def test_openai_intent_matches_reference():
    from hermes_cli.copilot_auth import copilot_request_headers

    assert copilot_request_headers()["Openai-Intent"] == "conversation-agent"


def test_interaction_id_is_present_and_unique_per_request():
    from hermes_cli.copilot_auth import copilot_request_headers

    first = copilot_request_headers()["X-Interaction-Id"]
    second = copilot_request_headers()["X-Interaction-Id"]
    assert first and second
    assert first != second


def test_initiator_still_distinguishes_agent_and_user_turns():
    """The reference bakes ``user`` and overrides per request; keep both."""
    from hermes_cli.copilot_auth import copilot_request_headers

    assert copilot_request_headers(is_agent_turn=True)["x-initiator"] == "agent"
    assert copilot_request_headers(is_agent_turn=False)["x-initiator"] == "user"


def test_initiator_key_casing_is_stable():
    """Call sites merge an ``x-initiator`` override into these headers.

    Emitting a different case here would put both keys in the dict and send
    the header twice.
    """
    from hermes_cli.copilot_auth import copilot_request_headers

    headers = copilot_request_headers()
    assert "x-initiator" in headers
    assert "X-Initiator" not in headers


def test_vision_header_still_supported():
    from hermes_cli.copilot_auth import copilot_request_headers

    assert copilot_request_headers(is_vision=True)["Copilot-Vision-Request"] == "true"
    assert "Copilot-Vision-Request" not in copilot_request_headers()


def test_models_helper_returns_the_same_identity():
    """``copilot_default_headers`` must not drift from ``copilot_auth``."""
    from hermes_cli.copilot_auth import copilot_request_headers
    from hermes_cli.models import copilot_default_headers

    a = copilot_default_headers()
    b = copilot_request_headers()
    ignore = {"X-Interaction-Id"}
    assert {k: v for k, v in a.items() if k not in ignore} == {
        k: v for k, v in b.items() if k not in ignore
    }


def test_models_editor_version_constant_is_not_the_vscode_lie():
    from hermes_cli.models import COPILOT_EDITOR_VERSION

    assert "vscode" not in COPILOT_EDITOR_VERSION.lower()
    assert COPILOT_EDITOR_VERSION.startswith("copilot-developer-cli/")


# ── provider aliases ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "provider",
    ["copilot", "github-copilot", "github", "github-models", "github-model"],
)
def test_copilot_aliases_are_recognized(provider):
    """Every alias that normalizes to ``copilot`` must be treated as Copilot.

    The failing session recorded ``provider: "github-copilot"``, which the
    bare equality checks skipped.
    """
    from hermes_cli.copilot_auth import is_copilot_provider

    assert is_copilot_provider(provider) is True


@pytest.mark.parametrize("provider", ["copilot-acp", "github-copilot-acp"])
def test_acp_provider_is_not_treated_as_copilot(provider):
    """``copilot-acp`` is a separate provider with its own transport."""
    from hermes_cli.copilot_auth import is_copilot_provider

    assert is_copilot_provider(provider) is False


@pytest.mark.parametrize("provider", ["anthropic", "openrouter", "", None, "gpt"])
def test_unrelated_providers_are_not_copilot(provider):
    from hermes_cli.copilot_auth import is_copilot_provider

    assert is_copilot_provider(provider) is False


def test_alias_matching_is_case_and_whitespace_insensitive():
    from hermes_cli.copilot_auth import is_copilot_provider

    assert is_copilot_provider("  GitHub-Copilot  ") is True


def test_alias_set_covers_every_copilot_target_in_the_auth_alias_table():
    """Guard against the two lists drifting apart.

    ``hermes_cli.auth`` normalizes several spellings to ``copilot``; every one
    of them must also be recognized here, or that alias silently loses
    Copilot-specific auth handling again.
    """
    import inspect

    from hermes_cli import auth as auth_mod
    from hermes_cli.copilot_auth import COPILOT_PROVIDER_ALIASES

    source = inspect.getsource(auth_mod)
    # Entries look like:  "github-copilot": "copilot",
    aliases = set(re.findall(r'"([a-z0-9\-_.]+)":\s*"copilot"', source))
    assert aliases, "alias table not found — update this test"
    missing = aliases - set(COPILOT_PROVIDER_ALIASES)
    assert not missing, f"aliases missing from COPILOT_PROVIDER_ALIASES: {missing}"


def test_enterprise_endpoint_resolution_runs_for_the_github_copilot_alias(
    tmp_path, monkeypatch
):
    """The alias must reach the token exchange and get the enterprise host.

    Before the fix this branch was gated on ``provider == "copilot"``, so the
    alias fell through to the hardcoded generic host.
    """
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))

    import agent.credential_pool as pool_mod
    import hermes_cli.auth as auth_mod
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setattr(
        copilot_auth, "resolve_copilot_token",
        lambda *a, **k: ("ghu_fake", "COPILOT_GITHUB_TOKEN"),
    )
    monkeypatch.setattr(
        copilot_auth, "get_copilot_api_token",
        lambda token: ("exchanged", "https://api.enterprise.githubcopilot.com"),
    )
    monkeypatch.setattr(auth_mod, "is_source_suppressed", lambda *a, **k: False)

    seeded: list[dict] = []

    def _capture(entries, provider, source, payload):
        seeded.append(payload)
        return True

    monkeypatch.setattr(pool_mod, "_upsert_entry", _capture)

    pool_mod._seed_from_singletons("github-copilot", [])

    assert seeded, "github-copilot alias seeded no credential"
    assert seeded[0]["base_url"] == "https://api.enterprise.githubcopilot.com"


def test_generic_host_is_not_hardcoded_when_exchange_gives_enterprise(
    tmp_path, monkeypatch
):
    """The exchange result wins over the registry default."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))

    import agent.credential_pool as pool_mod
    import hermes_cli.auth as auth_mod
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setattr(
        copilot_auth, "resolve_copilot_token",
        lambda *a, **k: ("ghu_fake", "COPILOT_GITHUB_TOKEN"),
    )
    monkeypatch.setattr(
        copilot_auth, "get_copilot_api_token",
        lambda token: ("exchanged", "https://api.enterprise.githubcopilot.com"),
    )
    monkeypatch.setattr(auth_mod, "is_source_suppressed", lambda *a, **k: False)

    seeded: list[dict] = []
    monkeypatch.setattr(
        pool_mod, "_upsert_entry",
        lambda entries, provider, source, payload: seeded.append(payload) or True,
    )

    pool_mod._seed_from_singletons("copilot", [])

    assert seeded
    assert "api.githubcopilot.com" not in seeded[0]["base_url"]

