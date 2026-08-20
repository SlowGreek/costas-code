"""Closed-session guard for a watcher generation already in flight."""

from contextlib import contextmanager
from types import SimpleNamespace

from tui_gateway.methods_realtime import _visualize_from_watcher
from workbench_visualizer import VisualResult


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
