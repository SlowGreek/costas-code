"""Real SQLite contracts for structured steering through upstream state mixins."""
import pytest

from hermes_state import SessionDB


@pytest.mark.parametrize("writer", ["append", "batch", "replace", "compact", "backfill"])
@pytest.mark.parametrize("wire", [
    "  exact wire text\n",
    '[{"type": "text", "text": "JSON-looking string"}]',
    [{"type": "text", "text": "steer"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,cGl4ZWxz"}}],
    [],
])
def test_structured_sidecar_survives_every_storage_path(tmp_path, writer, wire):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    try:
        db.create_session("sidecar", source="test")
        msg = {"role": "user", "content": "clean", "api_content": wire,
               "display_metadata": {"steering": {"id": "authority"}}, "effect_disposition": "observed"}
        if writer == "append":
            db.append_message("sidecar", **msg)
        elif writer == "batch":
            db.append_messages_batch("sidecar", [msg])
        elif writer == "replace":
            db.replace_messages("sidecar", [msg])
        elif writer == "compact":
            db.append_message("sidecar", "user", content="history")
            db.archive_and_compact("sidecar", [msg])
        else:
            db.append_message("sidecar", **{k: v for k, v in msg.items() if k != "api_content"})
            assert db.set_latest_user_api_content("sidecar", "clean", wire) == 1
    finally:
        db.close()
    reopened = SessionDB(db_path=path)
    try:
        for messages in [reopened.get_messages("sidecar"), reopened.get_messages_as_conversation("sidecar")]:
            assert len(messages) == 1
            assert messages[0]["api_content"] == wire
            assert messages[0]["display_metadata"] == msg["display_metadata"]
            assert messages[0]["effect_disposition"] == "observed"
    finally:
        reopened.close()


def test_rewind_restore_does_not_revive_compaction_archives(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("sidecar", source="test")
        first = db.append_message("sidecar", "user", content="archived history")
        db.archive_and_compact("sidecar", [{"role": "user", "content": "summary"}])
        assert db.restore_rewound("sidecar", first) == 0
        assert [row["content"] for row in db.get_messages("sidecar")] == ["summary"]
    finally:
        db.close()
