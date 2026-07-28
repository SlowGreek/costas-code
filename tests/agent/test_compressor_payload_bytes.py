"""Byte-aware request payload accounting for multimodal messages.

Token accounting (``_content_length_for_budget``) intentionally charges a
flat per-image estimate because that is what providers *bill* — a 1 MB
base64 blob and a 20 KB thumbnail cost the same context tokens.

But providers also enforce a *byte* limit on the request body, and that
limit is what a batch of pasted full-resolution screenshots actually
trips (Copilot: ``HTTP 413 Request Entity Too Large``).  Because the two
limits are measured in different currencies, the token meter can honestly
read 12% while the wire payload is already oversized — so compaction never
fires proactively and the turn only dies after the provider rejects it.

These tests pin a payload-byte estimator that measures the real thing.
"""

from __future__ import annotations

import pytest

from agent.context_compressor import (
    estimate_content_payload_bytes,
    estimate_messages_payload_bytes,
)


def _data_url(kb: int) -> str:
    return "data:image/png;base64," + ("A" * (kb * 1024))


class TestEstimateContentPayloadBytes:
    def test_plain_string_is_its_own_length(self):
        assert estimate_content_payload_bytes("hello") == 5

    def test_none_is_zero(self):
        assert estimate_content_payload_bytes(None) == 0

    def test_text_parts_sum(self):
        content = [
            {"type": "text", "text": "abcd"},
            {"type": "text", "text": "ef"},
        ]
        assert estimate_content_payload_bytes(content) == 6

    def test_data_url_image_counts_its_real_base64_size(self):
        """The whole point: a 1 MB image must read as ~1 MB, not a flat constant."""
        content = [{"type": "image_url", "image_url": {"url": _data_url(1024)}}]

        size = estimate_content_payload_bytes(content)

        assert size >= 1024 * 1024

    def test_bigger_image_estimates_bigger(self):
        small = estimate_content_payload_bytes(
            [{"type": "image_url", "image_url": {"url": _data_url(10)}}]
        )
        large = estimate_content_payload_bytes(
            [{"type": "image_url", "image_url": {"url": _data_url(1000)}}]
        )

        assert large > small * 50

    def test_remote_url_image_is_not_charged_payload_bytes(self):
        """An https:// image is a short reference — the bytes never ride the wire."""
        content = [
            {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}
        ]

        assert estimate_content_payload_bytes(content) < 200

    def test_responses_api_input_image_shape(self):
        content = [{"type": "input_image", "image_url": _data_url(512)}]

        assert estimate_content_payload_bytes(content) >= 512 * 1024

    def test_anthropic_native_image_shape(self):
        content = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "A" * (256 * 1024),
                },
            }
        ]

        assert estimate_content_payload_bytes(content) >= 256 * 1024


class TestEstimateMessagesPayloadBytes:
    def test_sums_across_messages(self):
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "world!"},
        ]

        assert estimate_messages_payload_bytes(messages) >= 11

    def test_four_pasted_screenshots_exceed_a_typical_limit(self):
        """The reported symptom, as a number.

        Four ~1.2 MB PNGs base64-encode to roughly 6.5 MB of request body —
        far past any provider's few-MB ceiling, while the flat per-image
        token estimate would score them at only ~6.4K tokens.
        """
        messages = [
            {
                "role": "user",
                "content": [{"type": "text", "text": "what do you see?"}]
                + [
                    {"type": "image_url", "image_url": {"url": _data_url(1600)}}
                    for _ in range(4)
                ],
            }
        ]

        assert estimate_messages_payload_bytes(messages) > 6 * 1024 * 1024

    def test_non_list_input_is_zero(self):
        assert estimate_messages_payload_bytes(None) == 0
        assert estimate_messages_payload_bytes([]) == 0

    @pytest.mark.parametrize("bogus", [123, {"a": 1}, object()])
    def test_malformed_entries_do_not_raise(self, bogus):
        assert estimate_messages_payload_bytes([bogus]) >= 0
