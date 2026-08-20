"""Watcher lifecycle at the real TUI gateway teardown seam."""

from tui_gateway import server
from workbench_watch_runtime import _watchers, get_watcher
from workbench_watcher import WatcherConfig


def test_teardown_forgets_the_session_watcher(monkeypatch):
    """A closed chat must not draw later from a pending timer.

    `forget_session()` existed but had no caller. Without this wiring, a user
    could leave a chat, then its old debounce timer would still spend a model
    call and mutate that chat's stored canvas behind their back.
    """
    stored_id = "stored-watcher-cleanup"
    runtime_id = "runtime-watcher-cleanup"
    config = WatcherConfig(enabled=True, mode="active", pipeline="direct")
    get_watcher(stored_id, config)

    assert stored_id in _watchers

    # Keep this test at the teardown seam without exercising unrelated agent,
    # memory, plugin and DB finalization.
    monkeypatch.setattr(server, "_teardown_session", lambda *_args, **_kwargs: None)
    server._sessions[runtime_id] = {"session_key": stored_id}

    popped = server._pop_session_by_id(runtime_id)
    assert server._teardown_popped_session(popped, end_reason="test_cleanup") is True

    assert stored_id not in _watchers
