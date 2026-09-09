"""Interrupt / steer / redirect control surface for ``AIAgent``.

Soft/hard interrupt requests, tool-thread interrupt propagation, pending steer/redirect queues.
Extracted from ``run_agent.py``; every method resolves through ``AIAgent``'s MRO unchanged.
"""
import contextlib
import logging
import threading
from typing import Any, Dict, List, Optional
import uuid

from agent.interrupt_compat import request_hard_interrupt
from tools.interrupt import request_yield as _request_yield
from tools.interrupt import set_interrupt as _set_interrupt

# Same logger name as the origin module so log records / caplog filters are unchanged.
logger = logging.getLogger("run_agent")


def _fence_cancel_before_commit(fence, *, when_in_flight: bool, failure_log: str) -> None:
    """Call ``type(fence).cancel_before_commit(fence)`` when ``commit_in_flight`` matches.

    Hard-cancel admission has two halves (#99758 P1). BEFORE the generation claim is
    consumed only a commit already in flight is waited out (the call blocks on the fence
    lock and returns False WITHOUT setting ``_cancelled``) — cancelling a still-pending
    fence there would be irreversible for an abort that may yet be declined. AFTER the
    claim survived, only a still-pending commit is cancelled; one that started meanwhile
    owns the fence and completes on its own."""
    if fence is None or bool(getattr(fence, "commit_in_flight", False)) is not when_in_flight:
        return
    cancel_before_commit = getattr(type(fence), "cancel_before_commit", None)
    if callable(cancel_before_commit):
        try:
            cancel_before_commit(fence)
        except Exception:
            logger.debug(failure_log, exc_info=True)


def _ic_lock(agent, attr: str):
    """``with`` the lock stored at ``attr`` when present; __init__-less test stubs run unlocked."""
    lock = getattr(agent, attr, None)
    return contextlib.nullcontext() if lock is None else lock


def _ic_slot(agent, lock_attr: str, slot: str):
    """Read the pending-text ``slot`` guarded by ``lock_attr``. An initialized agent always has both
    attributes, so under the lock the slot is read directly and a missing one fails loud (a real bug);
    only ``__init__``-less test stubs (no lock) get the ``getattr`` fallback."""
    if getattr(agent, lock_attr, None) is None:
        return getattr(agent, slot, None)
    return getattr(agent, slot)


def _ic_codex_method(agent, name: str):
    """Codex app-server owns its model/tool loop; return its ``name`` hook or None."""
    if getattr(agent, "api_mode", None) != "codex_app_server":
        return None
    method = getattr(getattr(agent, "_codex_session", None), name, None)
    return method if callable(method) else None


def _ic_abort_active_request(agent, reason: str, failure_log: str) -> None:
    """Shut the registered in-flight request's sockets (cron turns register their client here)."""
    abort = getattr(agent, "_active_request_abort", None)
    if callable(abort):
        try:
            abort(reason)
        except Exception:
            logger.debug(failure_log, exc_info=True)


def _ic_signal_tool_workers(agent, active: bool, **kw) -> None:
    """Fan the tool interrupt bit out to concurrent-tool worker tids.

    ``is_interrupted()`` inside a tool only sees its own tid, so without this a hung
    concurrent tool runs to its own timeout (and a stale bit could survive a turn
    boundary onto a recycled tid). getattr covers __init__-less stubs."""
    tracker = getattr(agent, "_tool_worker_threads", None)
    tracker_lock = getattr(agent, "_tool_worker_threads_lock", None)
    if tracker is None or tracker_lock is None:
        return
    with tracker_lock:
        worker_tids = list(tracker)
    for tid in worker_tids:
        try:
            _set_interrupt(active, tid, **kw)
        except Exception:
            pass


class InterruptControlMixin:
    """interrupt()/hard_interrupt()/clear_interrupt()/steer()/redirect() (see module docstring)."""

    def interrupt(
        self, message: Optional[str] = None, *, hard_cancel: bool = False,
        tool_reason: Optional[str] = None, require_generation: Optional[int] = None,
    ) -> bool:
        """Request the agent to interrupt its current tool-calling loop (call from another thread).

        ``hard_cancel``: explicit stop; compression may honor it even while ordinary interrupts are masked.
        ``tool_reason``: trusted fixed category safe for tool output. ``require_generation``: activity-
        generation claim — published only if the turn's generation still matches at the final mutation edge;
        returns False if the turn resumed meanwhile.
        """
        if require_generation is not None:
            # RESERVE the claim under the SAME lock `_touch_activity` stamps with; real progress invalidates
            # it and it is CONSUMED at the final mutation edge, so a resumed turn abandons the abort.
            with self._liveness_activity_lock():
                if getattr(self, "_turn_liveness_activity_generation", 0) != require_generation:
                    return False
                self._turn_liveness_abort_claim = require_generation

        # Tool cancellation attribution stays separate from _interrupt_message, which may carry the user's
        # full next message.
        tool_interrupt_reason = (
            (tool_reason or "explicit stop requested") if hard_cancel
            else ("user sent a new message" if message else "user interrupt")
        )

        def _publish_interrupt_state() -> None:
            self._interrupt_requested = True
            self._interrupt_message = message
            self._tool_interrupt_reason = tool_interrupt_reason
            _hard_event = getattr(self, "_hard_interrupt_requested", None) if hard_cancel else None
            if _hard_event is not None:
                _hard_event.set()

        def _fence():  # re-read each time: a finished commit may replace or clear the slot
            return vars(self).get("_active_compression_commit_fence") if hard_cancel else None

        # A hard stop and redirect share one lock so /stop cannot race with an accepted correction and
        # accidentally turn itself into a retry. The blocking in-flight-commit wait runs BEFORE the atomic
        # claim edge (redirect lock still held); the destructive pending-commit cancel runs AFTER the claim
        # survives (#99758 P1).
        with _ic_lock(self, "_pending_redirect_lock"):
            _fence_cancel_before_commit(
                _fence(), when_in_flight=True, failure_log="Compression hard-cancel fence wait failed"
            )
            if require_generation is None:
                # No claim to race: publish WITHOUT the liveness lock (bare AIAgent stand-ins in other
                # suites lack the liveness seam and would AttributeError).
                _publish_interrupt_state()
            else:
                # Final mutation edge: claim consumption and the FIRST observable publication are ONE
                # activity-lock critical section, so either the claim survives and commits before any later
                # activity stamp, or the stamp landed first and the abort declines without publishing.
                with self._liveness_activity_lock():
                    if getattr(self, "_turn_liveness_abort_claim", None) != require_generation:
                        return False
                    self._turn_liveness_abort_claim = None
                    _publish_interrupt_state()
            _fence_cancel_before_commit(
                _fence(), when_in_flight=False, failure_log="Compression hard-cancel fence admission failed"
            )
            self._pending_redirect = None

        inbox = getattr(self, "_user_input_inbox", None)
        if inbox is not None:
            inbox.close(cancelled=True)

        # Codex watches a private interrupt event rather than Hermes' per-thread flag.
        _request_interrupt = _ic_codex_method(self, "request_interrupt")
        if _request_interrupt is not None:
            try:
                _request_interrupt()
            except Exception:
                logger.debug("Failed to interrupt Codex app-server turn", exc_info=True)

        # Cron turns request on the conversation thread (no nested interrupt-worker deadlock); their client
        # is registered here so this cross-thread interrupt can still shut the sockets.
        _ic_abort_active_request(self, "interrupt_abort", "Failed to abort active inline request")
        # Scope the tool interrupt to this agent's execution thread so other in-process agents are unaffected.
        if self._execution_thread_id is not None:
            _set_interrupt(True, self._execution_thread_id, reason=tool_interrupt_reason)
            self._interrupt_thread_signal_pending = False
        else:
            # Interrupt arrived before run_conversation bound the execution thread: defer the tool-level
            # signal instead of targeting the caller thread.
            self._interrupt_thread_signal_pending = True
        _ic_signal_tool_workers(self, True, reason=tool_interrupt_reason)
        # Propagate interrupt to any running child agents (subagent delegation)
        with self._active_children_lock:
            children_copy = list(self._active_children)
        for child in children_copy:
            try:
                if hard_cancel:
                    request_hard_interrupt(child, message, tool_reason=tool_interrupt_reason)
                else:
                    child.interrupt(message)
            except Exception as e:
                logger.debug("Failed to propagate interrupt to child agent: %s", e)
        if not self.quiet_mode:
            print("\n⚡ Interrupt requested" + (f": '{message[:40]}...'" if message and len(message) > 40 else f": '{message}'" if message else ""))
        return True

    def hard_interrupt(self, message: Optional[str] = None, *, tool_reason: Optional[str] = None) -> None:
        """Explicit stop preserving the ``interrupt()`` ABI (frontends feature-detect this and fall back to
        legacy ``interrupt()`` for third-party agents). Bypasses dynamic dispatch: legacy subclasses may
        override interrupt(message=None) without hard_cancel."""
        InterruptControlMixin.interrupt(self, message, hard_cancel=True, tool_reason=tool_reason)

    def clear_interrupt(self, *, preserve_redirect: bool = False) -> bool:
        """Clear the interrupt request and per-thread tool signal. ``preserve_redirect`` is only for the
        conversation loop rebuilding the same logical turn after cancelling a model request."""
        with _ic_lock(self, "_pending_redirect_lock"):
            if preserve_redirect and not _ic_slot(self, "_pending_redirect_lock", "_pending_redirect"):
                return False
            self._interrupt_requested = False
            self._interrupt_message = self._tool_interrupt_reason = None
            getattr(self, "_hard_interrupt_requested", threading.Event()).clear()
            if not preserve_redirect:
                self._pending_redirect = None
        self._interrupt_thread_signal_pending = False
        if self._execution_thread_id is not None:
            _set_interrupt(False, self._execution_thread_id)
        _ic_signal_tool_workers(self, False)
        # A hard interrupt supersedes any pending /steer — its target iteration will no longer happen.
        with _ic_lock(self, "_pending_steer_lock"):
            self._pending_steer = None
        return True

    def submit_user_input(self, content: Any, *, message_id: str, turn_id: str) -> dict:
        """Accept identified user input for exactly one active generation."""
        cleaned = _normalize_redirect_payload(content)
        if not cleaned or not isinstance(message_id, str) or not message_id or len(message_id) > 128 or not isinstance(turn_id, str) or not turn_id or len(turn_id) > 256:
            return {"message_id": message_id, "turn_id": turn_id, "status": "invalid"}
        inbox = self._user_input_inbox
        with inbox.lock:
            if self._interrupt_requested:
                inbox.close(cancelled=True)
            native = self.redirect if getattr(self, "api_mode", None) == "codex_app_server" else None
            return inbox.submit(cleaned, message_id=message_id, turn_id=turn_id, native=native)


    def user_input_status(self, message_id: str) -> dict:
        return self._user_input_inbox.status(message_id)


    def _commit_pending_user_input(self, messages: list) -> list:
        inbox = getattr(self, "_user_input_inbox", None)
        receipts = inbox.commit(messages) if inbox else []
        callback = getattr(self, "user_input_callback", None)
        if receipts and callable(callback):
            for receipt in receipts:
                try:
                    callback(receipt)
                except Exception:
                    logger.debug("User input receipt callback failed", exc_info=True)
        return receipts


    def steer(self, text: Any) -> bool:
        """Add pending user input without cancelling the active response/tools.

        Real turns use identified, turn-scoped input. Legacy bare-agent callers
        retain the payload drain ABI. New UI clients use submit_user_input so
        they can distinguish acceptance from commitment to model context.
        """
        cleaned = _normalize_redirect_payload(text)
        if not cleaned or getattr(self, "_interrupt_requested", False):
            return False
        if getattr(self, "api_mode", None) == "codex_app_server":
            return self.redirect(cleaned)
        inbox = getattr(self, "_user_input_inbox", None)
        if inbox is not None and inbox.turn_id:
            return self.submit_user_input(cleaned, message_id=uuid.uuid4().hex, turn_id=inbox.turn_id)["status"] == "pending"
        _lock = getattr(self, "_pending_steer_lock", None)
        if _lock is None:
            # Test stubs that built AIAgent via object.__new__ skip __init__.
            # Fall back to direct attribute set; no concurrent callers expected
            # in those stubs.
            existing = getattr(self, "_pending_steer", None)
            self._pending_steer = (existing + "\n" + cleaned) if isinstance(existing, str) and isinstance(cleaned, str) else _merge_redirect_payloads(existing, cleaned)
            return True
        with _lock:
            if self._pending_steer:
                self._pending_steer = (self._pending_steer + "\n" + cleaned) if isinstance(self._pending_steer, str) and isinstance(cleaned, str) else _merge_redirect_payloads(self._pending_steer, cleaned)
            else:
                self._pending_steer = cleaned
        return True
    def redirect(self, text: Any) -> bool:
        """Accept input for the active turn, preserving ongoing work.

        Strings and OpenAI-style image content parts remain user content at
        the next request boundary. Native Codex uses its own turn/steer
        protocol. False means there is no accepting turn; it is not a Stop.
        """
        cleaned = _normalize_redirect_payload(text)
        if not cleaned:
            return False

        # Codex owns its internal reasoning/tool loop, so use its first-class
        # active-turn steering protocol rather than interrupting the subprocess.
        if getattr(self, "api_mode", None) == "codex_app_server":
            _codex_session = getattr(self, "_codex_session", None)
            _native_steer = getattr(_codex_session, "request_steer", None)
            if callable(_native_steer):
                _redirect_lock = getattr(self, "_pending_redirect_lock", None)
                if _redirect_lock is not None:
                    with _redirect_lock:
                        if self._interrupt_requested:
                            return False
                elif self._interrupt_requested:
                    return False
                try:
                    return bool(_native_steer(cleaned))
                except Exception:
                    logger.debug("Codex app-server turn/steer failed", exc_info=True)
                    return False
            return False

        if getattr(self, "_executing_tools", False):
            accepted = self.steer(cleaned)
            if accepted:
                tracker = getattr(self, "_tool_worker_threads", None)
                lock = getattr(self, "_tool_worker_threads_lock", None)
                if tracker is not None and lock is not None:
                    with lock:
                        tids = list(tracker)
                    for tid in tids:
                        _request_yield(tid)
            return accepted

        # Steer is pending input, not cancellation. The active response and
        # every running tool finish normally before the next request boundary.
        inbox = getattr(self, "_user_input_inbox", None)
        if inbox is not None and inbox.turn_id:
            return self.steer(cleaned)
        active = getattr(self, "_model_request_active", None)
        if self._interrupt_requested or not (
            getattr(self, "_executing_tools", False)
            or (active is not None and active.is_set())
        ):
            return False
        return self.steer(cleaned)

    def _has_pending_redirect(self) -> bool:
        """Return whether an active-turn redirect is waiting to be applied."""
        with _ic_lock(self, "_pending_redirect_lock"):
            return bool(_ic_slot(self, "_pending_redirect_lock", "_pending_redirect"))

    def _drain_pending_redirect(self) -> Optional[str]:
        """Return and clear pending active-turn correction text."""
        with _ic_lock(self, "_pending_redirect_lock"):
            text = _ic_slot(self, "_pending_redirect_lock", "_pending_redirect")
            self._pending_redirect = None
        return text

    def _drain_pending_steer(self) -> Optional[str]:
        """Return the pending steer text (if any) and clear the slot; None when nothing is pending."""
        with _ic_lock(self, "_pending_steer_lock"):
            text = _ic_slot(self, "_pending_steer_lock", "_pending_steer")
            self._pending_steer = None
        return text


def _normalize_redirect_payload(value: Any) -> Any:
    """Normalize a redirect correction to text, a parts list, or falsy.

    A correction is normally a string. It may also be an OpenAI-style content
    parts list so the correction can carry images. A parts list is only
    meaningful if it actually holds something — a list whose text parts are all
    blank and which has no image parts is treated as empty, so the surface
    falls back to queueing rather than redirecting into a no-op.
    """
    if isinstance(value, str):
        stripped = value.strip()
        return stripped if stripped else None
    if isinstance(value, list):
        parts = [p for p in value if isinstance(p, dict)]
        has_media = any(p.get("type") not in (None, "text") for p in parts)
        has_text = any(str(p.get("text") or "").strip() for p in parts)
        return parts if (parts and (has_media or has_text)) else None
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None



def _merge_redirect_payloads(existing: Any, incoming: Any) -> Any:
    """Combine a queued correction with a newer one.

    Two corrections can land before the loop drains either. Merging is lossless
    (both reach the model) and must survive images: string concatenation would
    stringify a parts list into ``"[{'type': 'text'...}]"``, so a list on either
    side merges structurally instead.
    """
    if not existing:
        return incoming
    if not incoming:
        return existing

    if isinstance(existing, str) and isinstance(incoming, str):
        return f"{existing}\n\n{_ADDITIONAL_CORRECTION_MARKER}\n{incoming}"

    def _as_parts(value: Any) -> List[Dict[str, Any]]:
        if isinstance(value, list):
            return [p for p in value if isinstance(p, dict)]
        return [{"type": "text", "text": str(value)}]

    merged = _as_parts(existing)
    merged.append({"type": "text", "text": _ADDITIONAL_CORRECTION_MARKER})
    merged.extend(_as_parts(incoming))
    return merged


_ADDITIONAL_CORRECTION_MARKER = "[Additional user correction]"
