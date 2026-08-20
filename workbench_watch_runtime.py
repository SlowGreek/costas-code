"""Gateway-side plumbing that drives :mod:`workbench_watcher` for live sessions.

The decision logic lives in ``workbench_watcher`` and is pure. Everything
impure — the per-session registry, the timer that fires when a burst of speech
goes quiet, and the call back into the visualizer — lives here, so the logic
stays testable without threads or a clock.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Optional

from workbench_watcher import (
    TranscriptWatcher,
    WatchDecision,
    WatcherConfig,
    watcher_config_from,
)

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_watchers: Dict[str, TranscriptWatcher] = {}
_timers: Dict[str, threading.Timer] = {}


def get_watcher(session_key: str, config: WatcherConfig) -> TranscriptWatcher:
    """Return this session's watcher, rebuilding it when config changed.

    Config is re-read per event rather than captured once at session start so
    flipping ``mode`` in config.yaml takes effect on the next utterance instead
    of requiring the user to restart a live voice conversation.
    """
    with _lock:
        watcher = _watchers.get(session_key)
        if watcher is None or watcher.config != config:
            watcher = TranscriptWatcher(config=config)
            _watchers[session_key] = watcher
        return watcher


def forget_session(session_key: str) -> None:
    with _lock:
        _watchers.pop(session_key, None)
        timer = _timers.pop(session_key, None)
    if timer is not None:
        timer.cancel()


def set_in_flight(session_key: str, active: bool, cfg: Any = None) -> None:
    """Mirror ``artifact.visualizing`` into the watcher's concurrency guard."""
    with _lock:
        watcher = _watchers.get(session_key)
    if watcher is not None:
        watcher.set_in_flight(active)


def observe_transcript(
    session_key: str,
    *,
    role: str,
    text: str,
    cfg: Any,
    on_decision: Callable[[WatchDecision], None],
    on_busy: Optional[Callable[[bool], None]] = None,
    canvas: Optional[Dict[str, Any]] = None,
) -> Optional[TranscriptWatcher]:
    """Feed one transcript fragment in and arm the debounce timer.

    Returns the watcher, or ``None`` when the feature is off — in which case
    nothing is allocated and no timer is scheduled, so a disabled watcher costs
    a dict lookup per utterance and nothing else.
    """
    config = watcher_config_from(cfg)
    if not config.enabled:
        return None

    watcher = get_watcher(session_key, config)
    if canvas is not None:
        watcher.set_canvas(artifact=canvas)
    watcher.observe(text, now=time.monotonic(), role=role)
    _arm(session_key, watcher, on_decision, on_busy)
    return watcher


def _arm(
    session_key: str,
    watcher: TranscriptWatcher,
    on_decision: Callable[[WatchDecision], None],
    on_busy: Optional[Callable[[bool], None]] = None,
) -> None:
    """(Re)schedule the settle check. A later fragment always wins.

    Cancelling the previous timer is what makes a burst of fragments cost one
    decision instead of one per fragment.
    """
    due = watcher.due_at()
    if due is None:
        return
    delay = max(0.0, due - time.monotonic())

    with _lock:
        existing = _timers.pop(session_key, None)
    if existing is not None:
        existing.cancel()

    timer = threading.Timer(delay, _fire, args=(session_key, watcher, on_decision, on_busy))
    timer.daemon = True
    with _lock:
        _timers[session_key] = timer
    timer.start()


def _fire(
    session_key: str,
    watcher: TranscriptWatcher,
    on_decision: Callable[[WatchDecision], None],
    on_busy: Optional[Callable[[bool], None]] = None,
) -> None:
    with _lock:
        _timers.pop(session_key, None)

    # In direct mode watcher.poll() IS the visual generation. Surface busy
    # before entering the model call and keep it true through persistence. The
    # two-stage preflight is only a decision and its callback owns draw state.
    due = watcher.due_at()
    direct_busy = (
        watcher.config.active
        and watcher.config.pipeline == "direct"
        and watcher.has_pending
        and not watcher.in_flight
        and due is not None
        and time.monotonic() >= due
    )
    if direct_busy and on_busy is not None:
        on_busy(True)

    try:
        try:
            decision = watcher.poll(now=time.monotonic())
        except Exception as exc:
            logger.debug("workbench watcher poll failed: %s", exc)
            return
        if decision is None:
            # A skip for IN_FLIGHT leaves the utterance pending on purpose: retry
            # once the current redraw finishes rather than dropping what was said.
            if watcher.last_skip == "in_flight" and watcher.has_pending:
                _retry_later(session_key, watcher, on_decision, on_busy)
            return
        if not decision.should_draw:
            return
        try:
            on_decision(decision)
        except Exception as exc:
            logger.debug("workbench watcher action failed: %s", exc)
        finally:
            # Direct generation holds this guard from before its model call through
            # persistence. Also makes callback failures unable to wedge the session.
            watcher.set_in_flight(False)
    finally:
        if direct_busy and on_busy is not None:
            on_busy(False)


_RETRY_SECONDS = 2.0


def _retry_later(
    session_key: str,
    watcher: TranscriptWatcher,
    on_decision: Callable[[WatchDecision], None],
    on_busy: Optional[Callable[[bool], None]] = None,
) -> None:
    timer = threading.Timer(
        _RETRY_SECONDS, _fire, args=(session_key, watcher, on_decision, on_busy)
    )
    timer.daemon = True
    with _lock:
        old = _timers.pop(session_key, None)
        _timers[session_key] = timer
    if old is not None:
        old.cancel()
    timer.start()
