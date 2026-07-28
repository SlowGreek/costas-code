"""413 payload recovery must be able to shed USER-message image payloads.

``_try_strip_image_parts_from_tool_messages`` only walks ``role: "tool"``
messages, so a turn where the user pasted several full-resolution
screenshots is structurally incompressible: the compressor's
``_strip_historical_media`` deliberately preserves the newest
image-bearing user message (it is the anchor), and the 413 fallback skips
user messages entirely.  The result is an endless
``413 -> compress -> no smaller -> "Cannot compress further"`` loop that
bricks the thread on every subsequent send.

These tests pin the behavior of the user-image shedding helper used by the
413 branch in ``agent/conversation_loop.py``.
"""

from __future__ import annotations


def _make_agent(provider: str = "copilot", model: str = "claude-opus-5"):
    from run_agent import AIAgent

    agent = object.__new__(AIAgent)
    agent.provider = provider
    agent.model = model
    return agent


def _img(url: str = "data:image/png;base64,AAAA") -> dict:
    return {"type": "image_url", "image_url": {"url": url}}


def _text(text: str = "look at this") -> dict:
    return {"type": "text", "text": text}


def _image_part_count(messages: list) -> int:
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


class TestStripUserImageParts:
    def test_returns_false_for_empty_or_none(self):
        agent = _make_agent()
        assert agent._try_strip_user_image_parts([]) is False
        assert agent._try_strip_user_image_parts(None) is False

    def test_returns_false_when_no_user_images(self):
        agent = _make_agent()
        msgs = [
            {"role": "user", "content": "plain text"},
            {"role": "assistant", "content": "reply"},
        ]
        assert agent._try_strip_user_image_parts(msgs) is False

    def test_keeps_newest_image_user_message_by_default(self):
        agent = _make_agent()
        msgs = [
            {"role": "user", "content": [_text("old"), _img("A")]},
            {"role": "assistant", "content": "ok"},
            {"role": "user", "content": [_text("new"), _img("B"), _img("C")]},
        ]

        assert agent._try_strip_user_image_parts(msgs) is True
        assert _image_part_count(msgs) == 2
        assert _image_part_count([msgs[-1]]) == 2
        assert _image_part_count([msgs[0]]) == 0

    def test_keep_newest_false_sheds_every_user_image(self):
        agent = _make_agent()
        msgs = [
            {"role": "user", "content": [_text("old"), _img("A")]},
            {"role": "user", "content": [_text("new"), _img("B"), _img("C")]},
        ]

        assert agent._try_strip_user_image_parts(msgs, keep_newest=False) is True
        assert _image_part_count(msgs) == 0

    def test_single_image_user_message_is_kept_by_default(self):
        """The only image-bearing turn is the newest one — nothing to shed."""
        agent = _make_agent()
        msgs = [{"role": "user", "content": [_text(), _img("A")]}]

        assert agent._try_strip_user_image_parts(msgs) is False
        assert _image_part_count(msgs) == 1

    def test_preserves_surrounding_text_parts(self):
        agent = _make_agent()
        msgs = [
            {"role": "user", "content": [_text("keep me"), _img("A")]},
            {"role": "user", "content": [_img("B")]},
        ]

        agent._try_strip_user_image_parts(msgs, keep_newest=False)

        texts = [p["text"] for p in msgs[0]["content"] if p.get("type") == "text"]
        assert "keep me" in texts

    def test_stripped_image_leaves_a_placeholder(self):
        agent = _make_agent()
        msgs = [
            {"role": "user", "content": [_img("A")]},
            {"role": "user", "content": [_img("B")]},
        ]

        agent._try_strip_user_image_parts(msgs, keep_newest=False)

        for msg in msgs:
            assert isinstance(msg["content"], list)
            assert all(p.get("type") == "text" for p in msg["content"])
            assert any("image" in p["text"].lower() for p in msg["content"])

    def test_does_not_touch_tool_or_assistant_messages(self):
        agent = _make_agent()
        tool_msg = {"role": "tool", "tool_call_id": "t1", "content": [_text("out"), _img("T")]}
        msgs = [
            {"role": "user", "content": [_img("A")]},
            tool_msg,
            {"role": "user", "content": [_img("B")]},
        ]

        agent._try_strip_user_image_parts(msgs, keep_newest=False)

        assert _image_part_count([tool_msg]) == 1

    def test_second_call_is_idempotent(self):
        agent = _make_agent()
        msgs = [
            {"role": "user", "content": [_img("A")]},
            {"role": "user", "content": [_img("B")]},
        ]

        assert agent._try_strip_user_image_parts(msgs) is True
        assert agent._try_strip_user_image_parts(msgs) is False
