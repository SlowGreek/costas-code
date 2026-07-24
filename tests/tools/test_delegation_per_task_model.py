"""E2E tests for per-task subagent model selection (delegation.allowed_models).

Exercises the real resolution chain with real imports against a temp
HERMES_HOME — no mocking of the config loader or the credential resolver —
per AGENTS.md ("E2E validation, not just green unit mocks", and specifically
"anything touching resolution chains, config propagation, security
boundaries").

The invariants under test:

  1. OPT-IN: with no delegation.allowed_models, the `model` schema field is
     absent entirely (zero token cost) and a task naming a model is rejected.
  2. ALLOWLIST IS A SECURITY BOUNDARY: a model not on the list is refused, and
     refusal is an ERROR, not a silent fallback.
  3. ATOMICITY: one bad model in a batch aborts the WHOLE batch before any
     child agent is constructed.
  4. Spec parsing round-trips provider:model forms, including the ones that
     look ambiguous (slashes, ':free' suffixes, custom:<name> providers).
"""

import json
import os
import textwrap

import pytest


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    """A real, isolated HERMES_HOME with a real config.yaml on disk."""
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    # HERMES_IGNORE_USER_CONFIG would route _load_config to the legacy
    # cli.CLI_CONFIG loader and bypass the file we write here.
    monkeypatch.delenv("HERMES_IGNORE_USER_CONFIG", raising=False)
    return home


def _write_config(home, allowed_models=None):
    """Write a real config.yaml and drop cached config/tool-def state."""
    body = "delegation:\n"
    if allowed_models is None:
        body += "  allowed_models: []\n"
    else:
        body += "  allowed_models:\n"
        for m in allowed_models:
            body += f"    - {m}\n"
    (home / "config.yaml").write_text(textwrap.dedent(body))

    # Force the shared loader to re-read from disk.
    import hermes_cli.config as hc

    for attr in ("_CONFIG_CACHE", "_config_cache", "_READONLY_CACHE"):
        if hasattr(hc, attr):
            try:
                getattr(hc, attr).clear()
            except AttributeError:
                setattr(hc, attr, None)


# ---------------------------------------------------------------------------
# 4. Spec parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spec,expected",
    [
        ("openrouter:anthropic/claude-opus-4", ("openrouter", "anthropic/claude-opus-4")),
        # Bare model -> provider inferred later; only the model is overridden.
        ("anthropic/claude-opus-4", (None, "anthropic/claude-opus-4")),
        # Only the FIRST colon splits: ':free' suffixes must survive.
        ("openrouter:openai/gpt-4o:free", ("openrouter", "openai/gpt-4o:free")),
        # 'custom:<name>' is a provider identifier, not a provider/model split.
        ("custom:mylab:some/model", ("custom:mylab", "some/model")),
        ("custom:mylab", ("custom:mylab", None)),
        ("", (None, None)),
        ("  openrouter:x/y  ", ("openrouter", "x/y")),
    ],
)
def test_parse_model_spec(spec, expected):
    from tools.delegate_tool import _parse_model_spec

    assert _parse_model_spec(spec) == expected


# ---------------------------------------------------------------------------
# 1. Opt-in: schema field absent unless allowlisted
# ---------------------------------------------------------------------------


def test_model_field_absent_when_allowlist_empty(hermes_home):
    """Zero token cost for users who have not opted in."""
    _write_config(hermes_home, allowed_models=None)
    from tools.delegate_tool import _build_dynamic_schema_overrides

    props = _build_dynamic_schema_overrides()["parameters"]["properties"]
    assert "model" not in props, "top-level 'model' must not be advertised"
    assert "model" not in props["tasks"]["items"]["properties"], (
        "per-task 'model' must not be advertised"
    )


def test_model_field_present_and_enumerated_when_allowlisted(hermes_home):
    """Opting in advertises the field, constrained to exactly the allowlist."""
    _write_config(
        hermes_home,
        allowed_models=["openrouter:openai/gpt-5.1", "openrouter:anthropic/claude-opus-4"],
    )
    from tools.delegate_tool import _build_dynamic_schema_overrides

    props = _build_dynamic_schema_overrides()["parameters"]["properties"]
    expected = ["openrouter:openai/gpt-5.1", "openrouter:anthropic/claude-opus-4"]

    assert props["model"]["enum"] == expected
    assert props["tasks"]["items"]["properties"]["model"]["enum"] == expected


def test_schema_build_does_not_mutate_static_schema(hermes_home):
    """The module-level schema dict must survive repeated dynamic rebuilds.

    _build_dynamic_schema_overrides runs on EVERY get_definitions() pass; if it
    mutated the static dict, the 'model' field would leak into the opted-out
    case after a single opted-in build.
    """
    from tools.delegate_tool import DELEGATE_TASK_SCHEMA, _build_dynamic_schema_overrides

    _write_config(hermes_home, allowed_models=["openrouter:openai/gpt-5.1"])
    _build_dynamic_schema_overrides()

    static_task_props = DELEGATE_TASK_SCHEMA["parameters"]["properties"]["tasks"]["items"][
        "properties"
    ]
    assert "model" not in static_task_props
    assert "model" not in DELEGATE_TASK_SCHEMA["parameters"]["properties"]

    # And after opting back out, the field is gone again.
    _write_config(hermes_home, allowed_models=None)
    props = _build_dynamic_schema_overrides()["parameters"]["properties"]
    assert "model" not in props


def test_allowed_models_ignores_malformed_entries(hermes_home):
    """Non-string / blank entries are dropped, not crashed on."""
    from tools.delegate_tool import _get_allowed_models

    (hermes_home / "config.yaml").write_text(
        "delegation:\n"
        "  allowed_models:\n"
        "    - openrouter:openai/gpt-5.1\n"
        "    - ''\n"
        "    - 123\n"
    )
    import hermes_cli.config as hc

    for attr in ("_CONFIG_CACHE", "_config_cache", "_READONLY_CACHE"):
        if hasattr(hc, attr):
            try:
                getattr(hc, attr).clear()
            except AttributeError:
                setattr(hc, attr, None)

    assert _get_allowed_models() == ["openrouter:openai/gpt-5.1"]


# ---------------------------------------------------------------------------
# 2 + 3. Allowlist enforcement and batch atomicity
# ---------------------------------------------------------------------------


def test_model_rejected_when_not_opted_in(hermes_home):
    """Naming a model without an allowlist is an error, not a silent inherit."""
    _write_config(hermes_home, allowed_models=None)
    from tools.delegate_tool import _resolve_task_model_overrides

    creds, err = _resolve_task_model_overrides(
        [{"goal": "g", "model": "openrouter:openai/gpt-5.1"}], {}, object()
    )
    assert creds is None
    assert err is not None
    assert "allowed_models" in err


def test_model_not_on_allowlist_is_refused(hermes_home):
    """The allowlist is a boundary: an unlisted model must NOT fall back."""
    _write_config(hermes_home, allowed_models=["openrouter:openai/gpt-5.1"])
    from tools.delegate_tool import _resolve_task_model_overrides

    creds, err = _resolve_task_model_overrides(
        [{"goal": "g", "model": "openrouter:expensive/model-o1-pro"}], {}, object()
    )
    assert creds is None, "unlisted model must not resolve"
    assert "not in delegation.allowed_models" in err
    # The error names the permitted values so the caller can self-correct.
    assert "openrouter:openai/gpt-5.1" in err


def test_no_override_requested_is_a_noop(hermes_home):
    """Tasks with no 'model' field preserve the previous behaviour exactly."""
    _write_config(hermes_home, allowed_models=["openrouter:openai/gpt-5.1"])
    from tools.delegate_tool import _resolve_task_model_overrides

    creds, err = _resolve_task_model_overrides(
        [{"goal": "a"}, {"goal": "b", "model": ""}, {"goal": "c", "model": None}],
        {},
        object(),
    )
    assert err is None
    assert creds == {}, "empty dict signals 'use the global bundle for every child'"


def test_one_bad_model_aborts_the_whole_batch(hermes_home):
    """ATOMICITY: a later task's bad model must abort before ANY child is built.

    _resolve_task_model_overrides is called before the child-construction loop,
    so returning an error here is what guarantees tasks 0..N-1 are never
    launched when task N is invalid.
    """
    _write_config(hermes_home, allowed_models=["openrouter:openai/gpt-5.1"])
    from tools.delegate_tool import _resolve_task_model_overrides

    creds, err = _resolve_task_model_overrides(
        [
            {"goal": "ok-0", "model": "openrouter:openai/gpt-5.1"},
            {"goal": "ok-1", "model": "openrouter:openai/gpt-5.1"},
            {"goal": "bad-2", "model": "openrouter:not/allowed"},
        ],
        {},
        object(),
    )
    assert creds is None, "the whole batch must be rejected, not partially resolved"
    assert "Task 2" in err


def test_bad_model_is_rejected_by_delegate_task_before_any_child(hermes_home, monkeypatch):
    """Full-path guard: delegate_task returns an error and builds no children."""
    _write_config(hermes_home, allowed_models=["openrouter:openai/gpt-5.1"])
    import tools.delegate_tool as dt

    built = []

    def _explode(*args, **kwargs):
        built.append(kwargs.get("task_index"))
        raise AssertionError("no child agent may be constructed on a rejected batch")

    monkeypatch.setattr(dt, "_build_child_agent", _explode)

    parent = type("P", (), {"session_id": "s1", "provider": "openrouter"})()
    out = dt.delegate_task(
        tasks=[
            {"goal": "first", "model": "openrouter:openai/gpt-5.1"},
            {"goal": "second", "model": "openrouter:nope/nope"},
        ],
        parent_agent=parent,
    )
    assert built == [], "batch must abort before child construction"
    payload = json.loads(out) if out.strip().startswith("{") else {"error": out}
    assert "nope/nope" in json.dumps(payload)


# ---------------------------------------------------------------------------
# Heterogeneous-batch display metadata
# ---------------------------------------------------------------------------


def test_describe_batch_models_single_vs_mixed():
    """Homogeneous batches report one model; mixed batches report the set."""
    from tools.delegate_tool import _describe_batch_models

    base = {"model": "parent/model"}
    tasks = [{"goal": "a"}, {"goal": "b"}]

    # No overrides -> unchanged from previous behaviour.
    assert _describe_batch_models(tasks, {}, base) == "parent/model"

    # Mixed -> both reported, deduped, order preserved.
    mixed = {0: {"model": "openai/gpt-5.1"}, 1: {"model": "anthropic/claude-opus-4"}}
    got = _describe_batch_models(tasks, mixed, base)
    assert "openai/gpt-5.1" in got and "anthropic/claude-opus-4" in got

    # All overridden to the SAME model -> collapses to one.
    same = {0: {"model": "openai/gpt-5.1"}, 1: {"model": "openai/gpt-5.1"}}
    assert _describe_batch_models(tasks, same, base) == "openai/gpt-5.1"


def test_tool_description_reflects_optin_state(hermes_home):
    """The model is never told it can pick a model when it cannot."""
    from tools.delegate_tool import _build_model_selection_note

    _write_config(hermes_home, allowed_models=None)
    assert "NOT selectable" in _build_model_selection_note()

    _write_config(hermes_home, allowed_models=["openrouter:openai/gpt-5.1"])
    note = _build_model_selection_note()
    assert "IS selectable" in note
    assert "openrouter:openai/gpt-5.1" in note
