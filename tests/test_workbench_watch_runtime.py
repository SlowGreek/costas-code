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

    runtime._fire(
        "stored-session",
        watcher,
        lambda _decision: events.append("decision"),
        lambda active: events.append(f"busy:{str(active).lower()}"),
    )

    assert events == ["busy:true", "model", "busy:false"]
    assert watcher.in_flight is False


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

    runtime._fire(
        "stored-session",
        watcher,
        lambda _decision: None,
        lambda active: events.append(active),
    )

    assert events == []
