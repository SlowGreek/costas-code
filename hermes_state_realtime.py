"""Realtime voice transcript persistence for ``SessionDB``."""

from __future__ import annotations

import sqlite3
from typing import Any, Dict


class SessionRealtimeMixin:
    """Persist completed Realtime transcript items exactly once."""

    def append_realtime_transcript(
        self,
        session_id: str,
        *,
        item_id: str,
        role: str,
        semantic_turn_id: str = "",
        text: str,
    ) -> Dict[str, Any]:
        item_id = str(item_id or "").strip()
        semantic_turn_id = str(semantic_turn_id or "").strip()
        text = str(text or "").strip()
        if not item_id or len(item_id) > 256:
            raise ValueError("Realtime transcript item_id is required and must be at most 256 characters")
        if role not in {"user", "assistant"}:
            raise ValueError("Realtime transcript role must be user or assistant")
        if not text:
            raise ValueError("Realtime transcript text is required")
        if len(semantic_turn_id) > 128:
            raise ValueError("Realtime transcript semantic_turn_id must be at most 128 characters")

        platform_message_id = f"realtime:{item_id}"
        try:
            message_id = self.append_message(
                session_id,
                role=role,
                content=text,
                platform_message_id=platform_message_id,
                observed=True,
                display_kind="realtime_transcript",
                display_metadata=(
                    {"semantic_turn_id": semantic_turn_id} if semantic_turn_id else None
                ),
            )
            return {"inserted": True, "message_id": message_id}
        except sqlite3.IntegrityError as exc:
            # The partial unique index is the authority. A duplicate event may
            # race across renderer reconnects; return the already-persisted row
            # rather than incrementing session counters twice.
            with self._read_ctx() as conn:
                row = conn.execute(
                    """SELECT id FROM messages
                       WHERE session_id = ? AND platform_message_id = ?""",
                    (session_id, platform_message_id),
                ).fetchone()
            if row is None:
                raise
            return {"inserted": False, "message_id": row["id"]}
