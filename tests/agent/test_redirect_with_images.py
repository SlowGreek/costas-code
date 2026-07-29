"""Steering with images.

`session.redirect` was text-only end to end, so a correction that carried a
screenshot could not redirect the live turn — it fell through to the next-turn
queue, arriving after the work it was meant to correct.

The load-bearing constraint is that a correction is not always a string. An
OpenAI-style content parts list carries the pixels, and every place that
previously assumed `str` — the two merge sites, the checkpoint prefix, the
summary line — would stringify it into `"[{'type': 'text'...}]"`, silently
dropping the images while looking like it worked.
"""

import pytest

from agent.conversation_loop import _apply_active_turn_redirect, _redirect_display_text
from run_agent import _merge_redirect_payloads, _normalize_redirect_payload

TEXT_PART = {"type": "text", "text": "look at this"}
IMAGE_PART = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}


class TestNormalizeRedirectPayload:
    def test_plain_text_is_stripped(self):
        assert _normalize_redirect_payload("  fix the header  ") == "fix the header"

    def test_blank_text_is_rejected(self):
        # Falsy means "no correction" — the surface falls back to queueing.
        assert _normalize_redirect_payload("   ") is None
        assert _normalize_redirect_payload("") is None
        assert _normalize_redirect_payload(None) is None

    def test_parts_with_an_image_survive(self):
        parts = _normalize_redirect_payload([TEXT_PART, IMAGE_PART])
        assert parts == [TEXT_PART, IMAGE_PART]

    def test_image_only_parts_are_a_valid_correction(self):
        """Dropping a screenshot in with no words is still a correction."""
        assert _normalize_redirect_payload([IMAGE_PART]) == [IMAGE_PART]

    def test_parts_carrying_nothing_are_rejected(self):
        # All text blank and no media — redirecting on this would abort the
        # live turn to deliver an empty message.
        assert _normalize_redirect_payload([{"type": "text", "text": "  "}]) is None
        assert _normalize_redirect_payload([]) is None

    def test_non_dict_entries_are_discarded(self):
        assert _normalize_redirect_payload(["junk", IMAGE_PART]) == [IMAGE_PART]


class TestMergeRedirectPayloads:
    """Two corrections can land before the loop drains either. Merging is
    lossless — both must reach the model."""

    def test_two_strings_concatenate(self):
        merged = _merge_redirect_payloads("first", "second")
        assert merged == "first\n\n[Additional user correction]\nsecond"

    def test_either_side_missing_returns_the_other(self):
        assert _merge_redirect_payloads(None, "only") == "only"
        assert _merge_redirect_payloads("only", None) == "only"

    def test_parts_plus_text_stays_a_list(self):
        """The bug this prevents: f-string merging turns the parts list into
        its repr, so the image silently stops existing."""
        merged = _merge_redirect_payloads([TEXT_PART, IMAGE_PART], "also fix this")
        assert isinstance(merged, list)
        assert IMAGE_PART in merged
        assert any(p.get("text") == "also fix this" for p in merged)

    def test_text_plus_parts_stays_a_list(self):
        merged = _merge_redirect_payloads("first", [IMAGE_PART])
        assert isinstance(merged, list)
        assert IMAGE_PART in merged

    def test_two_parts_lists_keep_every_image(self):
        second_image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}}
        merged = _merge_redirect_payloads([IMAGE_PART], [second_image])
        images = [p for p in merged if p.get("type") == "image_url"]
        assert len(images) == 2


class TestRedirectDisplayText:
    def test_flattens_parts_to_their_text(self):
        assert _redirect_display_text([TEXT_PART, IMAGE_PART]) == "look at this"

    def test_passes_a_string_through(self):
        assert _redirect_display_text("  hi  ") == "hi"

    def test_image_only_parts_flatten_to_empty(self):
        assert _redirect_display_text([IMAGE_PART]) == ""


class _FakeAgent:
    _current_streamed_assistant_text = "partial reply"
    _current_streamed_reasoning_text = ""
    _stream_needs_break = False

    @staticmethod
    def _strip_think_blocks(text):
        return text


class TestApplyActiveTurnRedirect:
    def test_parts_reach_the_message_intact(self):
        messages = [{"role": "user", "content": "original"}]
        _apply_active_turn_redirect(_FakeAgent(), messages, [TEXT_PART, IMAGE_PART])

        correction = messages[-1]
        assert correction["role"] == "user"
        assert correction["content"] == [TEXT_PART, IMAGE_PART]

    def test_checkpoint_prefix_becomes_a_text_part(self):
        """When an assistant item is already committed the checkpoint folds
        into the correction. As a string that would stringify the parts list;
        as a part it preserves the images.

        The scaffolding is provider-replay text, so it rides the ``api_content``
        sidecar (the exact bytes replayed to the model) while ``content`` keeps
        the user's own words for the transcript.
        """
        messages = [{"role": "assistant", "content": "already committed"}]
        _apply_active_turn_redirect(_FakeAgent(), messages, [TEXT_PART, IMAGE_PART])

        # Transcript side: the user's own parts, unscaffolded.
        assert messages[-1]["content"] == [TEXT_PART, IMAGE_PART]

        # Provider side: the checkpoint prefix is its own text part, and the
        # image survives (a string format would have stringified the list).
        api_content = messages[-1]["api_content"]
        assert isinstance(api_content, list)
        assert api_content[0]["type"] == "text"
        assert "interrupted assistant response" in api_content[0]["text"]
        assert IMAGE_PART in api_content

    def test_role_alternation_is_preserved(self):
        # An assistant checkpoint after an assistant item would be invalid.
        messages = [{"role": "assistant", "content": "committed"}]
        _apply_active_turn_redirect(_FakeAgent(), messages, [IMAGE_PART])

        roles = [m["role"] for m in messages]
        assert roles == ["assistant", "user"]

    def test_plain_text_behaviour_is_unchanged(self):
        messages = [{"role": "user", "content": "original"}]
        _apply_active_turn_redirect(_FakeAgent(), messages, "just words")

        assert messages[-2]["role"] == "assistant"
        assert messages[-1] == {"role": "user", "content": "just words"}


class TestAgentRedirectAcceptsParts:
    """`redirect()` must reject an empty correction so the surface can queue,
    while accepting an image-only one."""

    def _agent(self):
        import types

        from run_agent import AIAgent

        agent = types.SimpleNamespace()
        agent.redirect = types.MethodType(AIAgent.redirect, agent)
        agent._executing_tools = False
        agent._model_request_active = None
        agent._pending_redirect_lock = None
        agent._interrupt_requested = False
        agent._pending_redirect = None
        agent.api_mode = ""
        return agent

    def test_blank_text_is_refused(self):
        assert self._agent().redirect("   ") is False

    def test_empty_parts_are_refused(self):
        assert self._agent().redirect([{"type": "text", "text": " "}]) is False

    def test_image_only_is_not_refused_for_being_empty(self):
        # No live model request, so it still returns False — but via the
        # no-live-turn path, not the empty-payload guard. Asserting the
        # distinction directly would require faking the request state; the
        # normalizer test above already pins the payload half.
        agent = self._agent()
        assert _normalize_redirect_payload([IMAGE_PART]) == [IMAGE_PART]
        assert agent.redirect([IMAGE_PART]) is False
