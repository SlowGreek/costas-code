"""413 retry progress must be measured in BYTES, not tokens.

HTTP 413 is a wire-size error.  Token accounting bills a flat per-image
estimate regardless of an image's actual payload size, so compressing an
image-heavy history can drop thousands of "tokens" (by shedding text
messages) while the assembled body stays multi-megabyte.

The old gate treated that token drop as progress and retried, burning all
three compression attempts re-sending a body the provider had already
rejected — and never reaching the image-shedding fallback that would
actually have fixed it.  Symptom: "Request payload too large: max
compression attempts (3) reached" on a session full of screenshots.
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


class _PayloadTooLarge(Exception):
    """Shaped like a provider 413 so the error classifier routes it."""

    def __init__(self):
        super().__init__("Error code: 413 - request entity too large")
        self.status_code = 413


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
        # Disable the proactive preflight gate so these tests exercise the
        # reactive 413 handler specifically.
        a.max_request_payload_bytes = 0
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
            if isinstance(p, dict)
            and p.get("type") in {"image_url", "input_image", "image"}
        )
    return total


def _image_heavy_history() -> list:
    """Several megabytes of base64 plus filler text the compressor can chew on.

    The filler is what makes this a regression test: a token-denominated
    progress check sees the filler disappear and calls it progress, even
    though the images (the actual bulk) are untouched.
    """
    history = []
    for i in range(6):
        history.append({"role": "user", "content": f"chatter {i} " + ("z" * 4000)})
        history.append({"role": "assistant", "content": f"reply {i} " + ("q" * 4000)})
    history.append(
        {"role": "user", "content": [{"type": "text", "text": "older shot"}, _img(1500, "A")]}
    )
    history.append({"role": "assistant", "content": "noted"})
    history.append(
        {"role": "user", "content": [{"type": "text", "text": "newer shot"}, _img(1500, "B")]}
    )
    history.append({"role": "assistant", "content": "noted again"})
    return history


class TestByteDenominatedProgressGate:
    def test_token_only_progress_does_not_count_as_413_progress(self, agent):
        """Compression that sheds text but no image bytes must NOT be
        treated as progress — the handler has to fall through to image
        shedding instead of retrying the same oversized body."""
        agent.client.chat.completions.create.side_effect = [
            _PayloadTooLarge(),
            _mock_response(),
            _mock_response(),
            _mock_response(),
        ]

        def _text_only_compression(messages, system_message, **_kw):
            """Drop half the text turns; leave every image byte in place."""
            kept = [m for m in messages if isinstance(m.get("content"), list)]
            head = [m for m in messages if not isinstance(m.get("content"), list)][:2]
            return head + kept, system_message

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
            patch.object(agent, "_compress_context", side_effect=_text_only_compression),
        ):
            result = agent.run_conversation(
                "what do you see?", conversation_history=_image_heavy_history()
            )

        # The turn recovered instead of dying on "max compression attempts".
        assert not result.get("compression_exhausted"), result.get("error")
        assert result.get("final_response") == "ok"
        # Image bytes were actually shed — that is the only thing that could
        # have shrunk the wire body.
        assert _count_images(result["messages"]) < 2

    def test_real_byte_reduction_still_counts_as_progress(self, agent):
        """Control: when compression genuinely shrinks the body, the plain
        retry path must still fire (no unnecessary image shedding)."""
        agent.client.chat.completions.create.side_effect = [
            _PayloadTooLarge(),
            _mock_response(),
        ]

        def _drop_the_bulk(messages, system_message, **_kw):
            # Shed the older image turn: a real, byte-level reduction.
            out, seen_image = [], False
            for m in messages:
                if isinstance(m.get("content"), list) and not seen_image:
                    seen_image = True
                    continue
                out.append(m)
            return out, system_message

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
            patch.object(agent, "_compress_context", side_effect=_drop_the_bulk),
        ):
            result = agent.run_conversation(
                "what do you see?", conversation_history=_image_heavy_history()
            )

        assert not result.get("compression_exhausted")
        assert result.get("final_response") == "ok"
        # The surviving anchor image was preserved — byte progress was real,
        # so the extra shedding fallback was never needed.
        assert _count_images(result["messages"]) == 1

    def test_imageless_history_progress_still_works(self, agent):
        """A text-only 413 has no image bytes at all; token progress and byte
        progress agree, and the retry must still happen."""
        agent.client.chat.completions.create.side_effect = [
            _PayloadTooLarge(),
            _mock_response(),
        ]

        def _halve(messages, system_message, **_kw):
            return messages[: max(1, len(messages) // 2)], system_message

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
            patch.object(agent, "_compress_context", side_effect=_halve),
        ):
            result = agent.run_conversation(
                "hi",
                conversation_history=[
                    {"role": "user", "content": "x" * 20_000},
                    {"role": "assistant", "content": "y" * 20_000},
                    {"role": "user", "content": "x" * 20_000},
                    {"role": "assistant", "content": "y" * 20_000},
                ],
            )

        assert not result.get("compression_exhausted")
        assert result.get("final_response") == "ok"


class TestPersistedHistoryIsStripped:
    def test_tool_media_stripped_from_persisted_messages_not_just_api_copy(self, agent):
        """The vision-payload stripper must mutate the persisted history too,
        or the full-size body is rebuilt on the very next turn."""
        agent.client.chat.completions.create.side_effect = [
            _PayloadTooLarge(),
            _mock_response(),
            _mock_response(),
        ]

        history = [
            {"role": "user", "content": "look at this"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "browser_vision", "arguments": "{}"},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": [
                    {"type": "text", "text": "screenshot"},
                    _img(1500, "C"),
                ],
            },
        ]

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
            patch.object(
                agent, "_compress_context", side_effect=lambda m, s, **k: (m, s)
            ),
        ):
            result = agent.run_conversation("and?", conversation_history=history)

        assert _count_images(result["messages"]) == 0
