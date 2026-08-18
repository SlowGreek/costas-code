"""Fixtures shared across hermes_cli kanban tests."""

from __future__ import annotations

import pytest


@pytest.fixture
def all_assignees_spawnable(monkeypatch):
    """Pretend every assignee maps to a real Hermes profile.

    Most dispatcher tests use synthetic assignees ("alice", "bob") that
    don't correspond to actual profile directories on disk. Without this
    patch, the dispatcher's profile-exists guard (PR #20105) routes
    those tasks into ``skipped_nonspawnable`` instead of spawning, which
    would break tests that assert spawn behavior.
    """
    from hermes_cli import profiles
    monkeypatch.setattr(profiles, "profile_exists", lambda name: True)


@pytest.fixture(autouse=True)
def _suppress_concurrent_hermes_gate(request, monkeypatch):
    """Default ``_detect_concurrent_hermes_instances`` to ``[]`` for every test.

    The Windows update path now refuses to proceed when another
    ``hermes.exe`` is detected (issue #26670). On a developer's Windows
    machine running the test suite via ``hermes`` itself, this would
    flag the running agent as a concurrent instance and abort every
    ``cmd_update`` test. Tests that want to exercise the gate explicitly
    re-patch ``_detect_concurrent_hermes_instances`` with their own
    return value — autouse here gives a clean default without touching
    the rest of the suite.

    Tests that need to call the REAL function (e.g. unit tests for the
    helper itself) opt out with ``@pytest.mark.real_concurrent_gate``.
    """
    if request.node.get_closest_marker("real_concurrent_gate"):
        return
    try:
        from hermes_cli import main as _cli_main
    except Exception:
        return
    # raising=False: under pytest's per-test spawn isolation, a concurrent
    # xdist worker importing a module that transitively touches hermes_cli.main
    # can briefly expose a partially-initialized module object here — one where
    # _detect_concurrent_hermes_instances isn't defined yet. A bare setattr
    # would raise AttributeError and error the (unrelated) test. The attribute
    # always exists once main.py finishes importing, so a no-op when it's
    # transiently absent is the correct, race-free default.
    monkeypatch.setattr(
        _cli_main,
        "_detect_concurrent_hermes_instances",
        lambda *_a, **_k: [],
        raising=False,
    )


@pytest.fixture(autouse=True)
def _isolate_plugin_entry_points(request, monkeypatch):
    """Hide pip-installed Hermes plugins from plugin-discovery tests.

    ``PluginManager`` discovers plugins from three sources: ``HERMES_HOME``,
    the project directory, and ``importlib.metadata`` entry points in the
    ``hermes_agent.plugins`` group. The hermetic-environment fixture redirects
    the first two to a tempdir, but entry points come from the *interpreter's
    own site-packages* and no amount of ``HERMES_HOME`` juggling hides them.

    So any developer with a real Hermes plugin pip-installed into their venv
    (e.g. ``hermes-ultracode``) sees it counted alongside the fixture plugins,
    and every count assertion in the discovery tests fails with an off-by-N
    (``assert 2 == 1``). CI never caught this because CI installs no plugins.

    Tests that specifically exercise entry-point discovery opt out with
    ``@pytest.mark.real_entry_points`` and patch the scan themselves.
    """
    if request.node.get_closest_marker("real_entry_points"):
        return
    try:
        from hermes_cli import plugins as _plugins
    except Exception:
        return
    # raising=False for the same partially-initialized-module race documented
    # on the concurrent-gate fixture above.
    monkeypatch.setattr(
        _plugins.PluginManager,
        "_scan_entry_points",
        lambda self: [],
        raising=False,
    )

    # `hermes plugins list` walks its own entry-point scanner rather than
    # PluginManager's, so stubbing only the method above still leaked
    # site-packages plugins into the CLI-listing tests.
    try:
        from hermes_cli import plugins_cmd as _plugins_cmd
    except Exception:
        return
    monkeypatch.setattr(
        _plugins_cmd,
        "_discover_entrypoint_plugins",
        lambda: [],
        raising=False,
    )
