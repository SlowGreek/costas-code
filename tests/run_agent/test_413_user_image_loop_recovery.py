"""413 recovery must shed user-pasted image payloads before giving up.

Reproduces the "bricked thread" symptom: a user pastes several
full-resolution screenshots, the request body exceeds the provider's byte
limit, and every recovery path refuses to touch the images —
``_strip_historical_media`` preserves the newest image-bearing user
message by design, and ``_try_strip_image_parts_from_tool_messages`` only
walks ``role: "tool"``.  Compression reports "no progress", the turn
returns ``compression_exhausted``, and because the images stay in history
every subsequent send hits the same wall.

Companion unit tests for the helper itself live in
``test_413_user_image_payload_recovery.py``; these pin the loop wiring.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from run_agent import AIAgent
import run_agent


@pytest.fixture(autouse=True)
def _no_compression_sleep(monkeypatch):
    import time as _time

    monkeypatch.setattr(_time, "sleep", lambda *_a, **_k: None)
    monkeypatch.setattr(run_agent, "jittered_backoff", lambda *a, **k: 0.0)


def _make_tool_defs(*names: str) -> list:
    return [
        {
            "type": "function",
            "function": {
                "name": n,
                "description": f"{n} tool",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for n in names
    ]


def _mock_response(content="Hello", finish_reason="stop"):
    msg = SimpleNamespace(
        content=content,
        tool_calls=None,
        reasoning_content=None,
        reasoning=None,
    )
    choice = SimpleNamespace(message=msg, finish_reason=finish_reason)
    resp = SimpleNamespace(choices=[choice], model="test/model")
    resp.usage = None
    return resp


def _make_413_error(message="Request entity too large"):
    err = Exception(message)
    err.status_code = 413
    return err


@pytest.fixture()
def agent():
    with (
        patch("run_agent.get_tool_definitions", return_value=_make_tool_defs("web_search")),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        a = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
        a.client = MagicMock()
        a._cached_system_prompt = "You are helpful."
        a._use_prompt_caching = False
        a.tool_delay = 0
        a.compression_enabled = True
        a.save_trajectories = False
        return a


def _img(tag: str) -> dict:
    return {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{tag * 64}"}}


# Two image-bearing user turns: an older one that recovery may shed and a
# newest one (the anchor) that must survive the first recovery pass.
# Built fresh per call — recovery mutates message dicts in place, so a
# shared module-level list would leak stripped content between tests.
def _image_prefill() -> list:
    return [
        {"role": "user", "content": [{"type": "text", "text": "older"}, _img("A")]},
        {"role": "assistant", "content": "noted"},
        {"role": "user", "content": [{"type": "text", "text": "newest"}, _img("B"), _img("C")]},
        {"role": "assistant", "content": "noted again"},
    ]


def _noop_compress(agent):
    """Compression that makes no progress — the real behavior when the only
    bulk left is the protected image anchor."""

    def _compress(messages, _system_message, **_kwargs):
        agent._compression_skipped_due_to_lock = None
        return messages, "You are helpful."

    return _compress


def _count_images(messages) -> int:
    total = 0
    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        total += sum(
            1
            for p in content
            if isinstance(p, dict) and p.get("type") in {"image_url", "input_image", "image"}
        )
    return total


class TestUserImage413Recovery:
    def test_413_sheds_older_user_images_and_succeeds(self, agent):
        """One 413, then success — the turn must recover instead of dying."""
        agent.client.chat.completions.create.side_effect = [
            _make_413_error(),
            _mock_response("recovered"),
        ]

        with (
            patch.object(agent, "_compress_context", side_effect=_noop_compress(agent)),
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(
                "what do you see?", conversation_history=_image_prefill()
            )

        assert not result.get("compression_exhausted")
        assert result.get("final_response") == "recovered"

    def test_shed_images_do_not_return_on_the_next_send(self, agent):
        """The stripped payload must persist in history, otherwise the next
        user message rebuilds the same oversized body and re-bricks."""
        agent.client.chat.completions.create.side_effect = [
            _make_413_error(),
            _mock_response("recovered"),
        ]

        with (
            patch.object(agent, "_compress_context", side_effect=_noop_compress(agent)),
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(
                "what do you see?", conversation_history=_image_prefill()
            )

        # Older turn's image is gone; the newest anchor's two survive.
        assert _count_images(result["messages"]) == 2

    def test_exhausts_only_after_all_user_images_are_shed(self, agent):
        """Persistent 413 still terminates — but not before trying to shed
        every user image, including the newest anchor."""
        agent.client.chat.completions.create.side_effect = _make_413_error()

        with (
            patch.object(agent, "_compress_context", side_effect=_noop_compress(agent)),
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(
                "what do you see?", conversation_history=_image_prefill()
            )

        assert result.get("compression_exhausted") is True
        assert _count_images(result["messages"]) == 0

    def test_imageless_413_behaviour_is_unchanged(self, agent):
        """Control: no user images → the pre-existing terminal path stands."""
        agent.client.chat.completions.create.side_effect = _make_413_error()

        with (
            patch.object(agent, "_compress_context", side_effect=_noop_compress(agent)),
            patch.object(
                agent, "_try_strip_image_parts_from_tool_messages", return_value=False
            ),
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(
                "hello",
                conversation_history=[
                    {"role": "user", "content": "previous question"},
                    {"role": "assistant", "content": "previous answer"},
                ],
            )

        assert result.get("compression_exhausted") is True
        assert result.get("failed") is True
