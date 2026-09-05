"""Turn-scoped user input. Acceptance is not provider consumption or obedience.

The same lock orders submission, stop, and the idle transition. Only the
conversation thread commits content, at a complete model-request boundary.
"""
from __future__ import annotations

from copy import deepcopy
from contextvars import ContextVar
from dataclasses import dataclass
import threading
from typing import Any, Literal

InputStatus = Literal['pending', 'committed', 'cancelled', 'recoverable', 'accepted', 'stale', 'unknown']
current_inbox: ContextVar["UserInputInbox | None"] = ContextVar("pending_user_input_inbox", default=None)


def has_pending_user_input() -> bool:
    inbox = current_inbox.get()
    if inbox is None:
        return False
    with inbox.lock:
        return inbox.accepting and inbox.wakeup.is_set()



@dataclass
class PendingUserInput:
    message_id: str
    turn_id: str
    content: str | list[dict[str, Any]]
    status: InputStatus = 'pending'
    request_key: str | None = None

    def receipt(self) -> dict:
        return {'message_id': self.message_id, 'turn_id': self.turn_id, 'status': self.status}


class UserInputInbox:
    """Bounded, process-local receipts; committed IDs also live in history."""

    def __init__(self, *, journal_path=None, history=()):
        self.lock = threading.RLock()
        self.wakeup = threading.Event()
        self.turn_id: str | None = None
        self.accepting = False
        self.items: dict[str, PendingUserInput] = {}
        self.journal_path = journal_path
        if journal_path is not None:
            from pathlib import Path
            import json
            self.journal_path = Path(journal_path)
            if self.journal_path.is_symlink() or self.journal_path.parent.is_symlink():
                raise ValueError('Unsafe user input journal path')
            if self.journal_path.exists():
                if self.journal_path.stat().st_size > 32 * 1024 * 1024:
                    raise ValueError('User input journal exceeds budget')
                data = json.loads(self.journal_path.read_text(encoding='utf-8'))
                if not isinstance(data, list) or len(data) > 512:
                    raise ValueError('Invalid user input journal')
                committed = {
                    (m.get('display_metadata') or {}).get('steering', {}).get('message_id')
                    for m in history if isinstance(m, dict) and isinstance(m.get('display_metadata', {}), dict)
                }
                for row in data:
                    item = PendingUserInput(**row)
                    if item.status != 'cancelled':
                        item.status = 'committed' if item.message_id in committed else 'recoverable'
                    self.items[item.message_id] = item

    def _save(self) -> None:
        if self.journal_path is None:
            return
        import json
        import os
        import tempfile
        from dataclasses import asdict
        payload = json.dumps([asdict(i) for i in self.items.values()], ensure_ascii=True).encode('utf-8')
        if len(payload) > 32 * 1024 * 1024:
            raise ValueError('User input journal exceeds budget')
        path = self.journal_path
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError('Unsafe user input journal path')
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix='.input-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def recovered_inputs(self) -> list[dict]:
        with self.lock:
            return [dict(i.receipt(), content=deepcopy(i.content)) for i in self.items.values()
                    if i.status == 'recoverable']

    def begin(self, turn_id: str) -> None:
        with self.lock:
            if self.turn_id == turn_id:
                return  # Never resurrect a stopped/closed generation.
            self.close()
            retained = [(k, v) for k, v in self.items.items() if v.status in ('recoverable', 'pending', 'unknown', 'accepted')]
            terminal = [(k, v) for k, v in self.items.items() if v.status in ('committed', 'cancelled')][-128:]
            self.items = dict(terminal + retained)
            self.turn_id = turn_id
            self.accepting = True
            self.wakeup.clear()

    def submit(self, content, *, message_id: str, turn_id: str, request_key: str | None = None, native=None) -> dict:
        with self.lock:
            receipt = {'message_id': message_id, 'turn_id': turn_id}
            prior = self.items.get(message_id)
            if prior:
                if prior.turn_id != turn_id or prior.content != content:
                    return dict(receipt, status='conflict')
                return prior.receipt()
            if not self.accepting or turn_id != self.turn_id:
                return dict(receipt, status='stale')
            if len(self.items) >= 512:
                return dict(receipt, status='full')
            item = PendingUserInput(message_id, turn_id, deepcopy(content), request_key=request_key)
            self.items[message_id] = item
            try:
                self._save()
            except Exception:
                del self.items[message_id]
                raise
            if native is not None:
                try:
                    item.status = 'accepted' if native(content) else 'unknown'
                except Exception:
                    item.status = 'unknown'  # Never resend an uncertain native write.
                self._save()
                return item.receipt()
            self.wakeup.set()
            return item.receipt()

    def retry_receipt(self, message_id: str, turn_id: str, request_key: str) -> dict | None:
        with self.lock:
            item = self.items.get(message_id)
            if item is None:
                return None
            if item.turn_id != turn_id or item.request_key != request_key:
                return {'message_id': message_id, 'turn_id': turn_id, 'status': 'conflict'}
            return item.receipt()

    def status(self, message_id: str) -> dict:
        with self.lock:
            item = self.items.get(message_id)
            return item.receipt() if item else {'message_id': message_id, 'status': 'unknown'}

    def snapshot(self) -> list[dict]:
        with self.lock:
            return [dict(i.receipt(), content=deepcopy(i.content)) for i in self.items.values() if i.turn_id == self.turn_id]

    def commit(self, messages: list) -> list[dict]:
        with self.lock:
            committed = []
            if not self.accepting:
                return committed
            additions = []
            for item in self.items.values():
                if item.turn_id == self.turn_id and item.status == 'pending':
                    item.status = 'committed'
                    receipt = item.receipt()
                    additions.append({'role': 'user', 'content': deepcopy(item.content),
                                      'display_metadata': {'steering': receipt}})
                    committed.append(receipt)
            try:
                if committed:
                    self._save()
            except Exception:
                for receipt in committed:
                    self.items[receipt['message_id']].status = 'pending'
                raise
            messages.extend(additions)
            self.wakeup.clear()
            return committed

    def finish_if_empty(self) -> bool:
        with self.lock:
            if any(i.status == 'pending' and i.turn_id == self.turn_id for i in self.items.values()):
                return False
            self.accepting = False
            return True

    def close(self, *, cancelled: bool = False) -> None:
        with self.lock:
            self.accepting = False
            for item in self.items.values():
                if item.status == 'pending' or (cancelled and item.status in ('accepted', 'unknown')):
                    item.status = 'cancelled' if cancelled else 'recoverable'
            self.wakeup.set()
            self._save()
