from __future__ import annotations

import asyncio
from uuid import UUID

from gateway.session_context import (
    clear_session_vars,
    get_lucid_conversation_id,
    reset_session_vars,
    set_current_session_id,
    set_session_vars,
    stable_lucid_conversation_id,
)


def test_durable_conversation_projects_to_one_stable_bounded_uuid():
    first = stable_lucid_conversation_id("20260727_120000_abcdef")
    second = stable_lucid_conversation_id("20260727_120000_abcdef")

    assert first == second
    assert str(UUID(first)) == first
    assert len(first.encode("ascii")) == 36


def test_two_durable_conversations_never_share_host_identity():
    assert stable_lucid_conversation_id("conversation-a") != stable_lucid_conversation_id(
        "conversation-b"
    )


def test_session_context_binds_and_clears_host_identity():
    tokens = set_session_vars(session_id="durable-a")
    try:
        assert get_lucid_conversation_id() == stable_lucid_conversation_id("durable-a")
    finally:
        clear_session_vars(tokens)
    assert get_lucid_conversation_id() == ""


def test_rotation_explicitly_preserves_or_invalidates_binding():
    set_current_session_id("root-segment")
    original = get_lucid_conversation_id()

    set_current_session_id("compression-child", conversation_continuity=True)
    assert get_lucid_conversation_id() == original

    set_current_session_id("new-conversation")
    assert get_lucid_conversation_id() != original
    assert get_lucid_conversation_id() == stable_lucid_conversation_id(
        "new-conversation"
    )


def test_concurrent_sessions_keep_separate_contextvar_bindings():
    async def observe(session_id: str) -> tuple[str, str]:
        tokens = set_session_vars(session_id=session_id)
        try:
            before = get_lucid_conversation_id()
            await asyncio.sleep(0)
            return before, get_lucid_conversation_id()
        finally:
            clear_session_vars(tokens)

    async def run() -> list[tuple[str, str]]:
        return list(await asyncio.gather(observe("conversation-a"), observe("conversation-b")))

    first, second = asyncio.run(run())
    assert first[0] == first[1]
    assert second[0] == second[1]
    assert first[0] != second[0]


def test_reset_removes_inherited_host_binding():
    set_session_vars(session_id="parent-conversation")
    assert get_lucid_conversation_id()
    reset_session_vars()
    assert get_lucid_conversation_id() == ""
