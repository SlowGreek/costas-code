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


# ── Upstream: structured list/mapping literal parsing ──────────────
import pytest


@pytest.fixture
def user_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_MANAGED_DIR", raising=False)
    import hermes_cli.config as cfg
    from hermes_cli import managed_scope

    cfg._LOAD_CONFIG_CACHE.clear()
    cfg._RAW_CONFIG_CACHE.clear()
    managed_scope.invalidate_managed_cache()
    return home


def test_list_literal_is_parsed_to_list(user_home):
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value("platform_toolsets.line", '["clarify", "file", "web"]')
    raw = read_raw_config()
    assert raw["platform_toolsets"]["line"] == ["clarify", "file", "web"]


def test_mapping_literal_is_parsed_to_dict(user_home):
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value("display.tool_progress_overrides", '{"terminal": "off"}')
    raw = read_raw_config()
    assert raw["display"]["tool_progress_overrides"] == {"terminal": "off"}


def test_yaml_flow_list_is_parsed(user_home):
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value("plugins.enabled", "[model-providers/gemini]")
    raw = read_raw_config()
    assert raw["plugins"]["enabled"] == ["model-providers/gemini"]


def test_invalid_list_literal_warns_and_stores_string(user_home, capsys):
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value("platform_toolsets.line", '["unclosed')
    captured = capsys.readouterr()
    assert "not valid" in captured.err.lower() or "warning" in captured.err.lower()
    raw = read_raw_config()
    assert raw["platform_toolsets"]["line"] == '["unclosed'


def test_scalar_values_unaffected(user_home):
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value("agent.max_turns", "300")
    set_config_value("display.compact", "true")
    set_config_value("tts.provider", "edge")
    raw = read_raw_config()
    assert raw["agent"]["max_turns"] == 300
    assert raw["display"]["compact"] is True
    assert raw["tts"]["provider"] == "edge"


# ---------------------------------------------------------------------------
# Consolidated-cluster additions: multi-line YAML blocks, string-typed-key
# guard, conservative trigger, and load_config round-trip.
# ---------------------------------------------------------------------------


def test_multiline_yaml_list_is_parsed(user_home):
    """A multi-line YAML block list must be stored as a real list."""
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value(
        "custom_providers",
        "- name: foo\n  base_url: https://foo.example/v1\n"
        "- name: bar\n  base_url: https://bar.example/v1",
    )
    raw = read_raw_config()
    assert raw["custom_providers"] == [
        {"name": "foo", "base_url": "https://foo.example/v1"},
        {"name": "bar", "base_url": "https://bar.example/v1"},
    ]


def test_multiline_yaml_mapping_is_parsed(user_home):
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value(
        "display.tool_progress_overrides",
        "terminal: off\nbrowser: on",
    )
    raw = read_raw_config()
    assert raw["display"]["tool_progress_overrides"] == {
        "terminal": False,
        "browser": True,
    }


def test_string_typed_key_bracket_value_stays_string(user_home):
    """Keys whose DEFAULT_CONFIG type is str must never be coerced —
    even when the value looks like a list literal."""
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value("approvals.mode", "[off]")
    raw = read_raw_config()
    assert raw["approvals"]["mode"] == "[off]"
    assert isinstance(raw["approvals"]["mode"], str)


def test_string_typed_key_negative_number_stays_string(user_home):
    """'-5' for a string-typed key must remain the string '-5'."""
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value("approvals.mode", "-5")
    raw = read_raw_config()
    assert raw["approvals"]["mode"] == "-5"


def test_dash_prefixed_scalar_not_treated_as_list(user_home):
    """Single-line dash-prefixed scalars ('-5', '--flag') must stay strings
    for non-string-typed keys too — the over-broad leading '-' trigger from
    #88066 is deliberately avoided."""
    from hermes_cli.config import set_config_value, read_raw_config

    set_config_value("weird.flag", "--verbose")
    raw = read_raw_config()
    assert raw["weird"]["flag"] == "--verbose"


def test_plain_scalar_that_parses_to_scalar_kept_as_string(user_home):
    """If yaml.safe_load of a structured-looking value yields a plain scalar,
    keep the original string."""
    from hermes_cli.config import set_config_value, read_raw_config

    # '{}' parses to an empty dict — that IS structured, so check a value
    # that starts with '[' but parses to a scalar is impossible in YAML;
    # instead use a multi-line value whose lines don't match list/dict shape.
    set_config_value("some.note", "line one\nline two without yaml shape")
    raw = read_raw_config()
    assert raw["some"]["note"] == "line one\nline two without yaml shape"


def test_round_trip_through_load_config(user_home):
    """Structured values written by set_config_value must survive
    load_config as real lists/dicts."""
    from hermes_cli.config import set_config_value, load_config

    set_config_value("platform_toolsets.line", '["clarify", "file", "web"]')
    cfg = load_config()
    assert cfg["platform_toolsets"]["line"] == ["clarify", "file", "web"]
