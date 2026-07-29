"""Codex-style pending-input follow-up: a steer must never be stranded.

Hermes historically delivered /steer by appending the text to the last
``role:"tool"`` message. When a turn ends with a plain text answer and no
tool calls, there is no tool result to append to, so the steer was pushed
back into the pending slot and silently deferred to a later turn.

Codex's turn loop instead treats pending input as "the turn needs a
follow-up": the queued text is recorded as a real user message and the
loop issues one more sampling request. These tests pin that contract.
"""
from __future__ import annotations

import threading

import pytest

from agent.agent_runtime_helpers import apply_steer_followup, take_steer_followup
from run_agent import AIAgent


def _bare_agent() -> AIAgent:
    agent = object.__new__(AIAgent)
    agent._pending_steer = None
    agent._pending_steer_lock = threading.Lock()
    agent.quiet_mode = True
    return agent


class TestTakeSteerFollowup:
    def test_returns_none_when_no_steer_pending(self):
        agent = _bare_agent()
        assert take_steer_followup(agent) is None

    def test_returns_the_pending_steer_text(self):
        agent = _bare_agent()
        agent.steer("actually check the staging logs instead")
        assert take_steer_followup(agent) == "actually check the staging logs instead"

    def test_drains_the_slot_so_the_steer_is_delivered_once(self):
        agent = _bare_agent()
        agent.steer("only once")
        take_steer_followup(agent)
        assert agent._pending_steer is None
        assert take_steer_followup(agent) is None

    def test_preserves_submission_order_of_multiple_steers(self):
        agent = _bare_agent()
        agent.steer("first")
        agent.steer("second")
        assert take_steer_followup(agent) == "first\nsecond"


class TestApplySteerFollowup:
    """The steer is committed as a real user message at the turn boundary."""

    def test_appends_the_answer_then_the_steer_as_a_user_message(self):
        messages = [{"role": "user", "content": "summarize the repo"}]
        final_msg = {"role": "assistant", "content": "Here is the summary."}

        apply_steer_followup(messages, final_msg, "now check the tests too")

        assert [m["role"] for m in messages] == ["user", "assistant", "user"]
        assert messages[-1]["content"] == "now check the tests too"

    def test_commits_the_models_answer_so_it_is_kept_as_context(self):
        messages = [{"role": "user", "content": "q"}]
        final_msg = {"role": "assistant", "content": "the answer the user saw"}

        apply_steer_followup(messages, final_msg, "follow-up")

        assert messages[1] is final_msg
        assert messages[1]["content"] == "the answer the user saw"

    def test_never_produces_two_assistant_messages_in_a_row(self):
        messages = [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "already committed"},
        ]
        final_msg = {"role": "assistant", "content": "second answer"}

        apply_steer_followup(messages, final_msg, "steer text")

        roles = [m["role"] for m in messages]
        assert all(
            not (a == "assistant" and b == "assistant")
            for a, b in zip(roles, roles[1:])
        ), roles

    def test_folds_the_answer_into_the_correction_when_tail_is_assistant(self):
        messages = [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "already committed"},
        ]
        final_msg = {"role": "assistant", "content": "second answer"}

        apply_steer_followup(messages, final_msg, "steer text")

        assert messages[-1]["role"] == "user"
        assert "second answer" in messages[-1]["content"]
        assert "steer text" in messages[-1]["content"]

    def test_leaves_previously_cached_messages_byte_identical(self):
        cached = {"role": "user", "content": "original prompt"}
        messages = [cached]
        before = dict(cached)
        final_msg = {"role": "assistant", "content": "answer"}

        apply_steer_followup(messages, final_msg, "more")

        assert messages[0] is cached
        assert messages[0] == before
