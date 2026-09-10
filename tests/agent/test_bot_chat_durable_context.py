"""Bot Chat context is read after admission, including uncontended surface switches."""
import threading
from types import SimpleNamespace

import pytest

from agent.turn_facade_lease import admit_durable_turn_lease
from hermes_state import SessionDB


@pytest.mark.parametrize("canonical", [True, False])
def test_uncontended_bot_turn_sees_external_history_without_rewriting_other_seeds(tmp_path, canonical):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    other = SessionDB(db_path=path)
    db.create_session("conversation", "desktop")
    db.set_session_title("conversation", "Bot Chat" if canonical else "Ordinary conversation")
    db.append_message("conversation", "user", "desktop-marker")
    db.append_message("conversation", "assistant", "desktop-answer")
    stale = db.get_messages_as_conversation("conversation", include_row_ids=True)
    other.append_message("conversation", "user", "signal-marker")
    other.append_message("conversation", "assistant", "signal-answer")
    agent = SimpleNamespace(
        _session_db=db, session_id="conversation", _persist_disabled=False,
        _interrupt_requested=False, _emit_status=lambda *args: None,
        _liveness_activity_lock=threading.Lock,
    )
    admission = None
    try:
        admission = admit_durable_turn_lease(
            agent, session_id="conversation", relay_turn_id="desktop-followup",
            task_context={"session_id": "conversation", "platform": "desktop"},
            conversation_history=stale,
        )
        assert admission.lease is not None
        texts = [m["content"] for m in admission.conversation_history]
        assert ("signal-marker" in texts) is canonical
        assert texts[:2] == ["desktop-marker", "desktop-answer"]
        if not canonical:
            assert admission.conversation_history is stale
    finally:
        if admission and admission.lease:
            admission.lease.release()
        other.close()
        db.close()
