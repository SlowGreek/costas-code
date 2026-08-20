"""Closed-session guard for a watcher generation already in flight."""

from contextlib import contextmanager
from types import SimpleNamespace

import pytest

import workbench_watch_runtime as runtime
from tui_gateway.methods_realtime import _visualize_from_watcher
from workbench_visualizer import VisualResult
from workbench_watcher import TranscriptWatcher, WatcherConfig


def test_direct_result_is_discarded_if_session_closed_during_generation():
    """Timer cancellation cannot stop a model request already running.

    Direct generation finishes before this persistence callback. Session pop
    stamps `_closing=True`, so the callback must check that lease and discard
    the result rather than mutate a chat after the user has left.
    """
    opened = []
    emitted = []

    @contextmanager
    def open_db(_session):
        opened.append(True)
        yield object()

    decision = SimpleNamespace(
        direction="",
        expected_rev=1,
        visual=VisualResult(
            kind="map",
            payload={"nodes": [{"id": "a", "label": "A"}], "edges": []},
            trimmed=None,
            incremental=False,
        ),
    )

    _visualize_from_watcher(
        {"session_key": "stored", "_closing": True},
        "stored",
        "runtime",
        decision,
        open_db=open_db,
        emit=lambda *args: emitted.append(args),
    )

    assert opened == []
    assert emitted == []


def test_direct_result_is_discarded_if_connection_closed_during_generation():
    opened = []

    @contextmanager
    def open_db(_session):
        opened.append(True)
        yield object()

    decision = SimpleNamespace(
        direction="",
        expected_rev=1,
        visual=VisualResult(
            kind="map",
            payload={"nodes": [{"id": "a", "label": "A"}], "edges": []},
            trimmed=None,
            incremental=False,
        ),
    )

    _visualize_from_watcher(
        {"session_key": "stored", "_workbench_closed_connections": {"connection-a"}},
        "stored",
        "runtime",
        decision,
        watcher_key="connection-a",
        open_db=open_db,
        emit=lambda *_args: None,
    )

    assert opened == []


def test_persistence_conflict_refreshes_retry_base_before_propagating(monkeypatch):
    import workbench_visualizer

    watcher_key = "connection-conflict"
    watcher = TranscriptWatcher(
        config=WatcherConfig(enabled=True, mode="active", pipeline="direct")
    )
    watcher.set_canvas(
        artifact={
            "kind": "map",
            "semantic_rev": 1,
            "payload": {"nodes": [{"id": "old", "label": "Old"}], "edges": []},
        }
    )
    monkeypatch.setitem(runtime._watchers, watcher_key, watcher)

    current = {
        "kind": "map",
        "semantic_rev": 2,
        "payload": {"nodes": [{"id": "new", "label": "New"}], "edges": []},
    }

    class DB:
        def get_session_artifact(self, _session_id, _artifact_id):
            return current

    @contextmanager
    def open_db(_session):
        yield DB()

    monkeypatch.setattr(
        workbench_visualizer,
        "persist_visual_result",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("revision conflict")),
    )
    decision = SimpleNamespace(
        direction="",
        expected_rev=1,
        visual=VisualResult(
            kind="map",
            payload={"nodes": [{"id": "stale", "label": "Stale"}], "edges": []},
            trimmed=None,
            incremental=False,
        ),
    )

    with pytest.raises(RuntimeError, match="revision conflict"):
        _visualize_from_watcher(
            {"session_key": "stored"},
            "stored",
            "runtime",
            decision,
            watcher_key=watcher_key,
            open_db=open_db,
            emit=lambda *_args: None,
        )

    assert watcher.current_rev == 2
    assert watcher.current_payload["nodes"][0]["id"] == "new"
