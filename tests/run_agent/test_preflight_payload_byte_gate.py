"""Preflight byte gate: shed image payloads BEFORE the provider 413s.

Fix #1 recovers a turn after the provider rejects it.  This pins the
proactive half: when the assembled request body is already over the
configured byte ceiling, shed older user-pasted images up front so the
oversized request is never sent at all.

The gate is byte-based on purpose.  Token accounting charges a flat
per-image estimate (what providers bill), so four 1.2 MB screenshots score
~6.4K tokens — 12% of a 936K window — while the wire payload is ~6.5 MB.
No token threshold can see that, which is why the meter reads nearly empty
right up until the turn dies.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from run_agent import AIAgent
import run_agent


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    import time as _time

    monkeypatch.setattr(_time, "sleep", lambda *_a, **_k: None)
    monkeypatch.setattr(run_agent, "jittered_backoff", lambda *a, **k: 0.0)


def _mock_response(content="ok"):
    msg = SimpleNamespace(
        content=content, tool_calls=None, reasoning_content=None, reasoning=None
    )
    resp = SimpleNamespace(
        choices=[SimpleNamespace(message=msg, finish_reason="stop")], model="m"
    )
    resp.usage = None
    return resp


@pytest.fixture()
def agent():
    with (
        patch("run_agent.get_tool_definitions", return_value=[]),
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


def _img(kb: int, tag: str = "A") -> dict:
    return {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64," + tag * (kb * 1024)},
    }


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


def _heavy_history() -> list:
    """Two image turns totalling well over 4 MB of base64."""
    return [
        {"role": "user", "content": [{"type": "text", "text": "older"}, _img(2048, "A")]},
        {"role": "assistant", "content": "noted"},
        {"role": "user", "content": [{"type": "text", "text": "newest"}, _img(2048, "B")]},
        {"role": "assistant", "content": "noted again"},
    ]


class TestPreflightPayloadByteGate:
    def test_oversized_payload_sheds_older_images_before_sending(self, agent):
        """No 413 from the provider — the gate must act first."""
        agent.max_request_payload_bytes = 1_000_000
        agent.client.chat.completions.create.return_value = _mock_response()

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(
                "what do you see?", conversation_history=_heavy_history()
            )

        # Older image shed proactively; newest anchor preserved.
        assert _count_images(result["messages"]) == 1
        assert result.get("final_response") == "ok"

    def test_payload_within_limit_is_untouched(self, agent):
        """Control: a payload under the ceiling keeps every image."""
        agent.max_request_payload_bytes = 50_000_000
        agent.client.chat.completions.create.return_value = _mock_response()

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(
                "what do you see?", conversation_history=_heavy_history()
            )

        assert _count_images(result["messages"]) == 2

    def test_gate_disabled_by_zero_limit(self, agent):
        """0 means 'no byte ceiling' — opt-out must fully bypass the gate."""
        agent.max_request_payload_bytes = 0
        agent.client.chat.completions.create.return_value = _mock_response()

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(
                "what do you see?", conversation_history=_heavy_history()
            )

        assert _count_images(result["messages"]) == 2

    def test_imageless_oversized_payload_still_proceeds(self, agent):
        """A giant text history has no images to shed — the gate must not
        block or crash the turn, just let the normal paths handle it."""
        agent.max_request_payload_bytes = 1000
        agent.client.chat.completions.create.return_value = _mock_response()

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(
                "hi",
                conversation_history=[
                    {"role": "user", "content": "x" * 20_000},
                    {"role": "assistant", "content": "y" * 20_000},
                ],
            )

        assert result.get("final_response") == "ok"


class TestPayloadLimitConfig:
    def test_default_limit_is_a_sane_positive_ceiling(self, agent):
        """A fresh agent must carry a usable default, not None/0."""
        limit = getattr(agent, "max_request_payload_bytes", None)

        assert isinstance(limit, int)
        assert 1_000_000 <= limit <= 100_000_000

    def test_config_key_exists_with_matching_default(self):
        from hermes_cli.config import DEFAULT_CONFIG

        assert "max_request_payload_bytes" in DEFAULT_CONFIG["compression"]
