from __future__ import annotations

import pytest


def test_github_copilot_allowlist_accepts_copilot_aliases_only():
    from hermes_cli.provider_policy import provider_is_allowed

    config = {"model_catalog": {"allowed_providers": ["github-copilot"]}}

    assert provider_is_allowed("github-copilot", config)
    assert provider_is_allowed("copilot", config)
    assert not provider_is_allowed("copilot-acp", config)
    assert not provider_is_allowed("openrouter", config)
    assert not provider_is_allowed("custom:local", config)


def test_missing_allowlist_preserves_upstream_provider_universe():
    from hermes_cli.provider_policy import provider_is_allowed

    assert provider_is_allowed("openrouter", {})
    assert provider_is_allowed("custom:local", {"model_catalog": {}})


def test_profile_without_local_policy_inherits_default_profile_allowlist(
    tmp_path, monkeypatch
):
    import yaml

    import hermes_constants
    from hermes_cli.provider_policy import configured_allowed_providers

    root = tmp_path / "hermes"
    profile = root / "profiles" / "new-profile"
    profile.mkdir(parents=True)
    (root / "config.yaml").write_text(
        yaml.safe_dump({"model_catalog": {"allowed_providers": ["copilot"]}})
    )
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: profile)

    assert configured_allowed_providers({}) == ("copilot",)


def test_runtime_rejects_provider_outside_configured_allowlist(monkeypatch):
    from hermes_cli import runtime_provider as rp

    config = {
        "model": {"provider": "github-copilot", "default": "gpt-5.6-sol"},
        "model_catalog": {"allowed_providers": ["github-copilot"]},
    }
    monkeypatch.setattr(rp, "load_config", lambda: config)
    monkeypatch.setattr(rp, "_get_model_config", lambda: config["model"])

    with pytest.raises(rp.AuthError, match="not allowed.*GitHub Copilot"):
        rp.resolve_runtime_provider(requested="openrouter")


def test_auxiliary_clients_reject_provider_outside_configured_allowlist(monkeypatch):
    from agent import auxiliary_client
    from hermes_cli import config as config_mod
    from hermes_cli.auth import AuthError

    monkeypatch.setattr(
        config_mod,
        "load_config",
        lambda: {"model_catalog": {"allowed_providers": ["github-copilot"]}},
    )

    with pytest.raises(AuthError, match="not allowed.*GitHub Copilot"):
        auxiliary_client.resolve_provider_client("openrouter", model="openai/gpt-5.6-sol")


def test_vision_auto_does_not_fall_back_outside_allowlist(monkeypatch):
    from agent import auxiliary_client
    from hermes_cli import config as config_mod

    monkeypatch.setattr(
        config_mod,
        "load_config",
        lambda: {"model_catalog": {"allowed_providers": ["github-copilot"]}},
    )
    monkeypatch.setattr(
        auxiliary_client,
        "_resolve_task_provider_model",
        lambda *_args, **_kwargs: ("auto", None, None, None, None),
    )
    monkeypatch.setattr(auxiliary_client, "_normalize_main_runtime", lambda _runtime: {})
    monkeypatch.setattr(auxiliary_client, "_get_cached_client", lambda *_args, **_kwargs: (None, None))
    attempted: list[str] = []

    def _strict(provider, _model=None):
        attempted.append(provider)
        return object(), "fallback-model"

    monkeypatch.setattr(auxiliary_client, "_resolve_strict_vision_backend", _strict)

    provider, client, model = auxiliary_client.resolve_vision_provider_client()

    assert provider == "copilot"
    assert client is None
    assert model is None
    assert attempted == []


def test_model_inventory_exposes_only_allowlisted_provider(monkeypatch):
    from hermes_cli import inventory

    rows = [
        {"slug": "copilot", "models": ["gpt-5.6-sol"]},
        {"slug": "openrouter", "models": ["openai/gpt-5.6-sol"]},
        {"slug": "custom:local", "models": ["local-model"], "is_user_defined": True},
    ]
    monkeypatch.setattr(
        "hermes_cli.model_switch.list_authenticated_providers",
        lambda **_kwargs: [dict(row) for row in rows],
    )

    ctx = inventory.ConfigContext(
        current_provider="copilot",
        current_model="gpt-5.6-sol",
        current_base_url="https://api.githubcopilot.com",
        user_providers={},
        custom_providers=[],
        allowed_providers=["github-copilot"],
    )

    payload = inventory.build_models_payload(ctx)

    assert [row["slug"] for row in payload["providers"]] == ["copilot"]


def test_provider_account_catalog_exposes_only_allowlisted_provider(monkeypatch):
    from hermes_cli import config as config_mod
    from hermes_cli.provider_catalog import provider_catalog

    monkeypatch.setattr(
        config_mod,
        "load_config",
        lambda: {"model_catalog": {"allowed_providers": ["github-copilot"]}},
    )

    assert [provider.slug for provider in provider_catalog()] == ["copilot"]


def test_cli_provider_flag_choices_follow_allowlist(monkeypatch):
    from hermes_cli import config as config_mod
    from hermes_cli.main import _build_provider_choices

    monkeypatch.setattr(
        config_mod,
        "load_config",
        lambda: {"model_catalog": {"allowed_providers": ["github-copilot"]}},
    )

    assert _build_provider_choices() == ["auto", "copilot"]


def test_desktop_env_catalog_hides_non_allowlisted_provider_keys(monkeypatch):
    from hermes_cli import web_server

    provider_info = {
        "category": "provider",
        "description": "provider key",
        "password": True,
    }
    monkeypatch.setattr(
        web_server,
        "OPTIONAL_ENV_VARS",
        {
            "COPILOT_GITHUB_TOKEN": dict(provider_info),
            "OPENROUTER_API_KEY": dict(provider_info),
            "GITHUB_TOKEN": {"category": "tools", "description": "shared GitHub token"},
        },
    )
    monkeypatch.setattr(web_server, "load_env", lambda: {})
    monkeypatch.setattr(
        web_server,
        "load_config",
        lambda: {"model_catalog": {"allowed_providers": ["github-copilot"]}},
    )
    monkeypatch.setattr(web_server, "_channel_managed_env_keys", lambda: set())
    monkeypatch.setattr(
        web_server,
        "_catalog_provider_env_metadata",
        lambda: {
            "COPILOT_GITHUB_TOKEN": {
                "provider": "copilot",
                "provider_label": "GitHub Copilot",
                "category": "provider",
                "is_password": True,
            }
        },
    )

    result = web_server._get_env_vars_sync()

    assert "COPILOT_GITHUB_TOKEN" in result
    assert "GITHUB_TOKEN" in result
    assert "OPENROUTER_API_KEY" not in result


def test_profile_model_writes_reject_provider_outside_allowlist(tmp_path):
    import yaml

    from hermes_cli.auth import AuthError
    from hermes_cli.web_server import _write_profile_model

    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "model": {"provider": "copilot", "default": "gpt-5.6-sol"},
                "model_catalog": {"allowed_providers": ["copilot"]},
            }
        )
    )

    with pytest.raises(AuthError, match="not allowed.*GitHub Copilot"):
        _write_profile_model(tmp_path, "openrouter", "openai/gpt-5.6-sol")

    assert yaml.safe_load(config_path.read_text())["model"]["provider"] == "copilot"


@pytest.mark.parametrize(
    ("scope", "task"),
    [("main", ""), ("auxiliary", "compression")],
)
def test_model_assignment_api_rejects_provider_outside_allowlist(
    tmp_path, monkeypatch, scope, task
):
    import yaml

    from hermes_cli.auth import AuthError
    from hermes_cli.web_server import _apply_model_assignment_sync

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "model": {"provider": "copilot", "default": "gpt-5.6-sol"},
                "model_catalog": {"allowed_providers": ["copilot"]},
            }
        )
    )

    with pytest.raises(AuthError, match="not allowed.*GitHub Copilot"):
        _apply_model_assignment_sync(
            scope,
            "openrouter",
            "openai/gpt-5.6-sol",
            task,
            "",
        )


def test_catalyst_install_template_is_copilot_only():
    from pathlib import Path

    import yaml

    root = Path(__file__).resolve().parents[2]
    config = yaml.safe_load((root / "cli-config.yaml.example").read_text())

    assert config["model"]["provider"] == "copilot"
    assert config["model_catalog"]["allowed_providers"] == ["copilot"]
