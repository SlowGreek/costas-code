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
    get_watcher(runtime_id, config)

    assert runtime_id in _watchers

    # Keep this test at the teardown seam without exercising unrelated agent,
    # memory, plugin and DB finalization.
    monkeypatch.setattr(server, "_teardown_session", lambda *_args, **_kwargs: None)
    server._sessions[runtime_id] = {"session_key": stored_id}

    popped = server._pop_session_by_id(runtime_id)
    assert server._teardown_popped_session(popped, end_reason="test_cleanup") is True

    assert runtime_id not in _watchers


def test_closing_old_runtime_does_not_cancel_new_runtime_for_same_chat(monkeypatch):
    """Watcher ownership is per voice connection, not per durable chat."""
    stored_id = "stored-shared"
    old_runtime = "runtime-old"
    new_runtime = "runtime-new"
    config = WatcherConfig(enabled=True, mode="active", pipeline="direct")
    get_watcher(old_runtime, config)
    get_watcher(new_runtime, config)

    monkeypatch.setattr(server, "_teardown_session", lambda *_args, **_kwargs: None)
    server._sessions[old_runtime] = {"session_key": stored_id}
    server._sessions[new_runtime] = {"session_key": stored_id}

    popped = server._pop_session_by_id(old_runtime)
    assert server._teardown_popped_session(popped, end_reason="test_cleanup") is True

    assert old_runtime not in _watchers
    assert new_runtime in _watchers

    # Cleanup the survivor created by this test.
    server._sessions.pop(new_runtime, None)
    from workbench_watch_runtime import forget_session

    forget_session(new_runtime)
