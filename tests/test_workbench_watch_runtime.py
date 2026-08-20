"""Gateway runtime timing around direct watcher generation."""

import workbench_watch_runtime as runtime
from workbench_watcher import TranscriptWatcher, WatcherConfig


def test_direct_generation_reports_busy_for_the_actual_model_call(monkeypatch):
    """Drawing state must cover generation, not just the final DB write.

    The direct worker performs its model call inside ``watcher.poll``. Before
    this test, ``artifact.visualizing`` was emitted only later in the decision
    callback, after the model had already finished, so the UI/voice saw no
    drawing state during the actual multi-second wait.
    """
    events = []

    def model(**_kwargs):
        events.append("model")
        assert events[-2] == "busy:true"
        return '{"draw":false,"reason":"no visible change"}'

    watcher = TranscriptWatcher(
        config=WatcherConfig(enabled=True, mode="active", debounce_seconds=0.1, pipeline="direct"),
        run_oneshot_fn=model,
    )
    watcher.observe("okay", now=0.0)
    monkeypatch.setattr(runtime.time, "monotonic", lambda: 0.1)
    monkeypatch.setitem(runtime._watchers, "stored-session", watcher)

    runtime._fire(
        "stored-session",
        watcher,
        lambda _decision: events.append("decision"),
        lambda active: events.append(f"busy:{str(active).lower()}"),
    )

    assert events == ["busy:true", "model", "busy:false"]
    assert watcher.in_flight is False


def test_busy_notification_failure_does_not_drop_the_utterance(monkeypatch):
    events = []
    watcher = TranscriptWatcher(
        config=WatcherConfig(enabled=True, mode="active", debounce_seconds=0.1, pipeline="direct"),
        run_oneshot_fn=lambda **_kwargs: events.append("model")
        or '{"draw":false,"reason":"no visible change"}',
    )
    watcher.observe("okay", now=0.0)
    monkeypatch.setattr(runtime.time, "monotonic", lambda: 0.1)
    monkeypatch.setitem(runtime._watchers, "stored-session", watcher)

    def broken_busy(active):
        events.append(f"busy:{active}")
        raise RuntimeError("renderer event unavailable")

    # Busy reporting is observational; it must not own whether the model call
    # happens or whether pending speech is consumed/retried.
    runtime._fire("stored-session", watcher, lambda _decision: None, broken_busy)

    assert "model" in events
    assert watcher.has_pending is False
    assert watcher.in_flight is False


def test_action_failure_requeues_once_then_succeeds(monkeypatch):
    calls = []
    retries = []
    watcher = TranscriptWatcher(
        config=WatcherConfig(enabled=True, mode="active", debounce_seconds=0.1, pipeline="direct"),
        run_oneshot_fn=lambda **_kwargs: calls.append("model")
        or '{"draw":true,"reason":"draw","visual":{"kind":"map","nodes":[{"id":"a","label":"A"}],"edges":[]}}',
    )
    watcher.observe("draw A", now=0.0)
    monkeypatch.setattr(runtime.time, "monotonic", lambda: 0.1)
    monkeypatch.setitem(runtime._watchers, "stored-session", watcher)
    monkeypatch.setattr(runtime, "_retry_later", lambda *args: retries.append(args))

    def fail(_decision):
        raise RuntimeError("revision conflict")

    runtime._fire("stored-session", watcher, fail)

    assert len(calls) == 1
    assert watcher.has_pending is True
    assert watcher.last_skip == "action_failed"
    assert len(retries) == 1

    runtime._fire("stored-session", watcher, lambda _decision: None)

    assert len(calls) == 2
    assert watcher.has_pending is False


def test_close_after_registry_check_blocks_model_entry_and_busy(monkeypatch):
    key = "close-entry-race"
    events = []
    watcher = TranscriptWatcher(
        config=WatcherConfig(enabled=True, mode="active", debounce_seconds=0.1, pipeline="direct"),
        run_oneshot_fn=lambda **_kwargs: events.append("model")
        or '{"draw":false,"reason":"no"}',
    )
    watcher.observe("draw", now=0.0)
    monkeypatch.setattr(runtime.time, "monotonic", lambda: 0.1)
    monkeypatch.setitem(runtime._watchers, key, watcher)
    is_current = runtime._is_current

    def close_after_check(session_key, candidate):
        current = is_current(session_key, candidate)
        if current:
            events.append("close")
            runtime.forget_session(session_key)
        return current

    monkeypatch.setattr(runtime, "_is_current", close_after_check)

    runtime._fire(
        key,
        watcher,
        lambda _decision: events.append("decision"),
        lambda active: events.append(f"busy:{active}"),
    )

    assert events == ["close"]
    assert key not in runtime._watchers
    assert watcher.last_skip == "cancelled"


def test_teardown_during_failed_model_call_cannot_resurrect_retry(monkeypatch):
    key = "closing-runtime"
    calls = []

    def model(**_kwargs):
        calls.append("model")
        runtime.forget_session(key)
        return "not json"

    watcher = TranscriptWatcher(
        config=WatcherConfig(enabled=True, mode="active", debounce_seconds=0.1, pipeline="direct"),
        run_oneshot_fn=model,
    )
    watcher.observe("draw", now=0.0)
    monkeypatch.setattr(runtime.time, "monotonic", lambda: 0.1)
    monkeypatch.setitem(runtime._watchers, key, watcher)

    runtime._fire(key, watcher, lambda _decision: None)

    assert calls == ["model"]
    assert key not in runtime._watchers
    assert key not in runtime._timers


def test_two_stage_decision_does_not_claim_the_diagrammer_is_already_drawing(monkeypatch):
    """Two-stage mode's first call only DECIDES; its callback owns draw state."""
    events = []
    watcher = TranscriptWatcher(
        config=WatcherConfig(
            enabled=True, mode="active", debounce_seconds=0.1, pipeline="two_stage"
        ),
        run_oneshot_fn=lambda **_kwargs: '{"draw":false,"reason":"no"}',
    )
    watcher.observe("okay", now=0.0)
    monkeypatch.setattr(runtime.time, "monotonic", lambda: 0.1)
    monkeypatch.setitem(runtime._watchers, "stored-session", watcher)

    runtime._fire(
        "stored-session",
        watcher,
        lambda _decision: None,
        lambda active: events.append(active),
    )

    assert events == []
