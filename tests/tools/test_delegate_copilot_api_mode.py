"""Copilot routes per MODEL, not per provider.

GitHub Copilot serves GPT-5+/Codex slots only from ``/responses``
(``codex_responses``) and Claude/Gemini slots only from ``/chat/completions``.
Every other provider in Hermes picks one wire protocol for the whole provider,
so ``_build_child_agent``'s "did the provider change?" check is the wrong
question here: a child that keeps ``provider=copilot`` but switches model
*family* inherits the parent's mode and GitHub rejects the call with

    model "<id>" is not accessible via the /chat/completions endpoint

These tests pin the re-derivation that fixes it. They call the real
``_build_child_agent`` resolution rather than asserting on source text, so a
refactor that preserves behaviour keeps them green.
"""

import sys
import types
from unittest.mock import patch

import pytest


@pytest.fixture
def parent_on_claude():
    """A Copilot parent on a Claude slot — i.e. chat_completions."""
    parent = types.SimpleNamespace(
        model="claude-opus-5",
        provider="copilot",
        api_mode="chat_completions",
        base_url="https://api.githubcopilot.com",
        api_key="tok",
        session_id="s1",
        _delegate_depth=0,
    )
    return parent


def _resolve_api_mode(parent, child_model, **kwargs):
    """Run the child's credential resolution and report the api_mode it picked.

    ``_build_child_agent`` constructs a whole AIAgent, which we neither need nor
    want here, so we stop at the point the mode is decided by capturing the
    kwargs handed to the agent constructor.
    """
    import tools.delegate_tool as dt

    import run_agent

    captured = {}

    class _FakeAgent:
        def __init__(self, *args, **kw):
            captured.update(kw)
            self.model = kw.get("model")
            self.api_mode = kw.get("api_mode")
            self.provider = kw.get("provider")
            self._delegate_depth = 0

        def __getattr__(self, name):
            return None

    # _build_child_agent does `from run_agent import AIAgent` at call time, so
    # the patch has to land on the source module, not on delegate_tool.
    with patch.object(run_agent, "AIAgent", _FakeAgent):
        try:
            dt._build_child_agent(
                task_index=0,
                goal="noop",
                context="",
                toolsets=None,
                max_iterations=5,
                task_count=1,
                parent_agent=parent,
                model=child_model,
                **kwargs,
            )
        except Exception:
            # Construction may still fail downstream on the fake; the mode has
            # already been resolved by then.
            pass

    return captured.get("api_mode", "<unset>")


class TestCopilotPerModelApiMode:
    def test_gpt_child_of_claude_parent_switches_to_responses(self, parent_on_claude):
        """The bug: a Codex child inheriting chat_completions is rejected."""
        mode = _resolve_api_mode(parent_on_claude, "gpt-5.3-codex")
        assert mode == "codex_responses"

    def test_claude_child_of_claude_parent_stays_on_chat_completions(self, parent_on_claude):
        mode = _resolve_api_mode(parent_on_claude, "claude-sonnet-5")
        assert mode == "chat_completions"

    def test_gemini_child_uses_chat_completions(self, parent_on_claude):
        mode = _resolve_api_mode(parent_on_claude, "gemini-3.6-flash")
        assert mode == "chat_completions"

    def test_same_model_keeps_the_parent_mode_untouched(self, parent_on_claude):
        """No model change means no re-derivation — don't pay for a lookup."""
        mode = _resolve_api_mode(parent_on_claude, "claude-opus-5")
        assert mode == "chat_completions"

    def test_explicit_override_still_wins(self, parent_on_claude):
        """An explicit api_mode is a deliberate instruction; never second-guess it."""
        mode = _resolve_api_mode(
            parent_on_claude, "gpt-5.3-codex", override_api_mode="chat_completions"
        )
        assert mode == "chat_completions"

    def test_non_copilot_provider_is_unaffected(self):
        """The re-derivation is Copilot-specific and must not touch others."""
        parent = types.SimpleNamespace(
            model="anthropic/claude-opus-4",
            provider="openrouter",
            api_mode="chat_completions",
            base_url="https://openrouter.ai/api/v1",
            api_key="tok",
            session_id="s1",
            _delegate_depth=0,
        )
        mode = _resolve_api_mode(parent, "openai/gpt-5.1")
        assert mode == "chat_completions"

    def test_lookup_failure_leaves_the_inherited_mode(self, parent_on_claude):
        """A catalog/network failure must not break delegation entirely."""
        import tools.delegate_tool as dt

        broken = types.ModuleType("hermes_cli.models")

        def _raise(*a, **k):
            raise RuntimeError("catalog unreachable")

        broken.copilot_model_api_mode = _raise
        with patch.dict(sys.modules, {"hermes_cli.models": broken}):
            mode = _resolve_api_mode(parent_on_claude, "gpt-5.3-codex")

        # Degrades to the inherited value rather than raising.
        assert mode == "chat_completions"


class TestCopilotModeHelperContract:
    """The mapping the fix depends on. If these flip, the fix silently inverts."""

    def test_gpt_and_codex_slots_need_responses(self):
        from hermes_cli.models import copilot_model_api_mode

        for model in ("gpt-5.3-codex", "gpt-5.4", "gpt-5.6-sol"):
            assert copilot_model_api_mode(model) == "codex_responses", model

    def test_claude_and_gemini_slots_need_chat_completions(self):
        from hermes_cli.models import copilot_model_api_mode

        for model in ("claude-opus-5", "claude-sonnet-5", "gemini-3.6-flash"):
            assert copilot_model_api_mode(model) == "chat_completions", model
