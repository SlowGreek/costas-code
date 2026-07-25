"""``hermes config set`` must write list-typed keys as YAML lists.

The bug this pins: list-typed settings fell through every coercion branch and
were written as a *string*. The runtime then rejected them —
``_get_allowed_models()`` logs "is not a list" and returns ``[]`` — so
``delegation.allowed_models`` silently did nothing while ``config set``
reported success. A silent no-op is worse than an error, because the user
spends the debugging time instead.

These assert the round trip through a real config file rather than mocking the
writer, so a regression in either the coercion or the YAML dump is caught.
"""

import pytest
import yaml

from hermes_cli.config import _coerce_list_value


class TestCoerceListValue:
    def test_comma_separated_is_the_common_shape(self):
        assert _coerce_list_value("copilot:gpt-5.3-codex,copilot:claude-opus-5") == [
            "copilot:gpt-5.3-codex",
            "copilot:claude-opus-5",
        ]

    def test_json_array_survives_intact(self):
        assert _coerce_list_value('["copilot:a","copilot:b"]') == ["copilot:a", "copilot:b"]

    def test_single_value_becomes_a_one_item_list(self):
        assert _coerce_list_value("copilot:gpt-5.3-codex") == ["copilot:gpt-5.3-codex"]

    def test_model_ids_keep_their_colons_and_slashes(self):
        # Splitting on anything but a comma would corrupt provider:model ids.
        assert _coerce_list_value("openrouter:anthropic/claude-opus-4") == [
            "openrouter:anthropic/claude-opus-4"
        ]

    def test_whitespace_around_entries_is_trimmed(self):
        assert _coerce_list_value(" a , b ,c ") == ["a", "b", "c"]

    def test_empty_string_clears_the_list(self):
        assert _coerce_list_value("") == []
        assert _coerce_list_value("   ") == []

    def test_trailing_comma_does_not_produce_an_empty_entry(self):
        assert _coerce_list_value("a,b,") == ["a", "b"]

    def test_malformed_json_falls_back_to_comma_splitting(self):
        # Better a usable list than an exception or a silent string.
        assert _coerce_list_value("[unclosed") == ["[unclosed"]

    def test_json_non_array_falls_back(self):
        assert _coerce_list_value('{"a": 1}') == ['{"a": 1}']


class TestSetConfigValueWritesRealYamlLists:
    """End-to-end through the actual writer and file."""

    @pytest.fixture
    def cfg(self, tmp_path, monkeypatch):
        from hermes_cli import config as cfgmod

        home = tmp_path / ".hermes"
        home.mkdir()
        path = home / "config.yaml"
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setattr(cfgmod, "get_config_path", lambda: path)
        monkeypatch.setattr(cfgmod, "ensure_hermes_home", lambda: None)
        monkeypatch.setattr(cfgmod, "is_managed", lambda: False)
        return path

    def _written(self, path):
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    def test_allowed_models_lands_as_a_list_not_a_string(self, cfg):
        from hermes_cli.config import set_config_value

        set_config_value(
            "delegation.allowed_models", "copilot:gpt-5.3-codex,copilot:claude-opus-5"
        )
        got = self._written(cfg)["delegation"]["allowed_models"]

        assert isinstance(got, list), f"expected a list, got {type(got).__name__}: {got!r}"
        assert got == ["copilot:gpt-5.3-codex", "copilot:claude-opus-5"]

    def test_json_array_input_also_lands_as_a_list(self, cfg):
        from hermes_cli.config import set_config_value

        set_config_value("delegation.allowed_models", '["copilot:a","copilot:b"]')
        assert self._written(cfg)["delegation"]["allowed_models"] == ["copilot:a", "copilot:b"]

    def test_the_runtime_accepts_what_config_set_wrote(self, cfg, monkeypatch):
        """The real contract: the delegation reader must see a usable allowlist."""
        from hermes_cli.config import set_config_value

        set_config_value("delegation.allowed_models", "copilot:gpt-5.3-codex")

        import tools.delegate_tool as dt

        monkeypatch.setattr(
            dt, "_load_config", lambda: self._written(cfg).get("delegation") or {}
        )
        assert dt._get_allowed_models() == ["copilot:gpt-5.3-codex"]

    def test_empty_value_clears_the_list(self, cfg):
        from hermes_cli.config import set_config_value

        set_config_value("delegation.allowed_models", "a,b")
        set_config_value("delegation.allowed_models", "")
        assert self._written(cfg)["delegation"]["allowed_models"] == []

    def test_scalar_keys_are_unaffected(self, cfg):
        """The list branch is schema-driven; it must not touch other types."""
        from hermes_cli.config import set_config_value

        set_config_value("workflows.max_agents", "40")
        set_config_value("workflows.enabled", "false")
        set_config_value("approvals.mode", "off")

        written = self._written(cfg)
        assert written["workflows"]["max_agents"] == 40
        assert written["workflows"]["enabled"] is False
        # Enum member, not a YAML boolean.
        assert written["approvals"]["mode"] == "off"

    def test_a_comma_in_a_string_key_is_not_split(self, cfg):
        from hermes_cli.config import set_config_value

        set_config_value("approvals.mode", "a,b")
        assert self._written(cfg)["approvals"]["mode"] == "a,b"
