"""Tests for Copilot model API-mode routing."""

from __future__ import annotations


def test_copilot_claude_stays_on_chat_completions_even_if_catalog_lists_messages():
    from hermes_cli.models import copilot_model_api_mode

    catalog = [
        {
            "id": "claude-opus-4.8",
            "supported_endpoints": ["/v1/messages"],
        }
    ]

    assert copilot_model_api_mode("claude-opus-4.8", catalog=catalog) == "chat_completions"


def test_copilot_gpt5_still_uses_responses_api():
    from hermes_cli.models import copilot_model_api_mode

    assert copilot_model_api_mode("gpt-5.5", catalog=[]) == "codex_responses"
    assert copilot_model_api_mode("gpt-5-mini", catalog=[]) == "chat_completions"


def test_responses_only_non_gpt_model_routes_to_codex_responses():
    """Copilot ships Responses-only non-GPT models (grok-4.6); chat 400s there."""
    from hermes_cli.models import copilot_model_api_mode

    catalog = [{"id": "grok-4.6", "supported_endpoints": ["/responses"]}]

    assert copilot_model_api_mode("grok-4.6", catalog=catalog) == "codex_responses"


def test_model_offering_chat_completions_stays_on_chat_even_with_responses():
    from hermes_cli.models import copilot_model_api_mode

    catalog = [
        {"id": "some-model", "supported_endpoints": ["/chat/completions", "/responses"]}
    ]

    assert copilot_model_api_mode("some-model", catalog=catalog) == "chat_completions"


def test_missing_endpoint_metadata_falls_back_to_chat_completions():
    from hermes_cli.models import copilot_model_api_mode

    catalog = [{"id": "mystery-model"}]

    assert copilot_model_api_mode("mystery-model", catalog=catalog) == "chat_completions"
