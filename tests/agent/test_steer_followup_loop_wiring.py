"""The turn-end steer drain is wired into the real conversation loop.

Unit coverage for the helpers lives in ``test_steer_followup_turn.py``.
This module pins the integration contract: the no-tool-call branch of
``agent/conversation_loop.py`` must consult the pending-steer slot before
it breaks out of the loop, so a steer that arrives while the model is
composing a plain text answer reopens the turn instead of being deferred.
"""
from __future__ import annotations

import threading

import pytest

from agent.agent_runtime_helpers import apply_steer_followup, take_steer_followup
from run_agent import AIAgent


class TestSteerReopensTheTurn:
    """A steer pending at turn end must not be silently deferred."""

    def _agent(self) -> AIAgent:
        agent = object.__new__(AIAgent)
        agent._pending_steer = None
        agent._pending_steer_lock = threading.Lock()
        agent.quiet_mode = True
        return agent

    def test_no_pending_steer_leaves_the_turn_ending_normally(self):
        agent = self._agent()
        assert take_steer_followup(agent) is None

    def test_pending_steer_produces_a_followup_user_message(self):
        agent = self._agent()
        agent.steer("wait, use the staging config")

        messages = [{"role": "user", "content": "deploy it"}]
        final_msg = {"role": "assistant", "content": "Deployed to prod."}

        followup = take_steer_followup(agent)
        assert followup is not None
        apply_steer_followup(messages, final_msg, followup)

        assert messages[-1] == {
            "role": "user",
            "content": "wait, use the staging config",
        }
        assert agent._pending_steer is None

    def test_the_answer_the_user_already_saw_is_retained_as_context(self):
        agent = self._agent()
        agent.steer("also update the changelog")

        messages = [{"role": "user", "content": "bump the version"}]
        final_msg = {"role": "assistant", "content": "Bumped to 1.2.0."}

        apply_steer_followup(messages, final_msg, take_steer_followup(agent))

        assistant_contents = [
            m["content"] for m in messages if m["role"] == "assistant"
        ]
        assert "Bumped to 1.2.0." in assistant_contents
