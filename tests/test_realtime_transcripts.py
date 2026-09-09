from hermes_state import SessionDB
from hermes_state_common import SCHEMA_VERSION


def test_realtime_transcript_schema_version_is_current(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        assert db._conn.execute("SELECT version FROM schema_version").fetchone()[0] == SCHEMA_VERSION
        indexes = db._conn.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='messages'").fetchall()
        assert any("realtime" in (row[0] or "") and "UNIQUE" in (row[0] or "").upper() for row in indexes)
    finally:
        db.close()


def test_realtime_transcript_is_persisted_once_by_item_id(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")

        first = db.append_realtime_transcript(
            "voice-session",
            item_id="item-user-1",
            role="user",
            text="The renderer should own geometry.",
        )
        duplicate = db.append_realtime_transcript(
            "voice-session",
            item_id="item-user-1",
            role="user",
            text="The renderer should own geometry.",
        )

        assert first == {"inserted": True, "message_id": first["message_id"]}
        assert duplicate == {"inserted": False, "message_id": first["message_id"]}
        messages = db.get_messages("voice-session")
        assert [(message["role"], message["content"]) for message in messages] == [
            ("user", "The renderer should own geometry.")
        ]
    finally:
        db.close()


def test_realtime_transcript_persists_semantic_turn_identity(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")

        db.append_realtime_transcript(
            "voice-session",
            item_id="item-assistant-1",
            role="assistant",
            text="First segment.",
            semantic_turn_id="voice-turn-7",
        )

        message = db.get_messages("voice-session")[0]
        assert message["display_metadata"] == {"semantic_turn_id": "voice-turn-7"}
    finally:
        db.close()
