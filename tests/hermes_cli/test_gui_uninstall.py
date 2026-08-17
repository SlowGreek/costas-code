"""Tests for hermes_cli.gui_uninstall — GUI-only uninstall + install discovery.

Covers the cross-platform artifact discovery, the agent/GUI detection the
desktop UI gates options on, and that ``uninstall_gui`` removes only GUI
artifacts (built renderer/release/node_modules, packaged bundle, Electron
userData) while leaving the Python agent + config/sessions/.env intact.
"""

import sys
from pathlib import Path

import pytest

import hermes_cli.gui_uninstall as gu


def _make_agent(hermes_home: Path) -> Path:
    """Create a fake agent install: source package + venv."""
    agent_root = hermes_home / "hermes-agent"
    (agent_root / "hermes_cli").mkdir(parents=True)
    (agent_root / "hermes_cli" / "__init__.py").write_text("")
    (agent_root / "venv" / "bin").mkdir(parents=True)
    return agent_root


def _make_gui_build(hermes_home: Path) -> None:
    """Create the source-built GUI artifacts a `hermes desktop` run produces."""
    desktop = hermes_home / "hermes-agent" / "apps" / "desktop"
    (desktop / "dist").mkdir(parents=True)
    (desktop / "dist" / "index.html").write_text("<html>")
    (desktop / "release" / "linux-unpacked").mkdir(parents=True)
    (desktop / "node_modules").mkdir(parents=True)
    (hermes_home / "hermes-agent" / "node_modules").mkdir(parents=True)
    (hermes_home / "desktop-build-stamp.json").write_text("{}")


def _make_user_data(hermes_home: Path) -> None:
    (hermes_home / "config.yaml").write_text("x: 1\n")
    (hermes_home / ".env").write_text("KEY=secret\n")
    (hermes_home / "sessions").mkdir()








def test_gui_is_installed_true_when_built(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    _make_gui_build(hermes_home)
    # Make sure packaged-app + userdata probes don't false-positive on the box
    # running the test.
    monkeypatch.setattr(gu, "packaged_gui_app_paths", lambda: [])
    monkeypatch.setattr(gu, "desktop_userdata_dirs", lambda: [tmp_path / "nope"])
    assert gu.gui_is_installed(hermes_home) is True


def test_gui_is_installed_false_when_nothing(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    monkeypatch.setattr(gu, "packaged_gui_app_paths", lambda: [])
    monkeypatch.setattr(gu, "desktop_userdata_dirs", lambda: [tmp_path / "nope"])
    assert gu.gui_is_installed(hermes_home) is False


def test_uninstall_gui_removes_only_gui_artifacts(tmp_path, monkeypatch):
    """The core invariant: GUI gone, agent + user data untouched."""
    hermes_home = tmp_path / ".hermes"
    agent_root = _make_agent(hermes_home)
    _make_gui_build(hermes_home)
    _make_user_data(hermes_home)

    # Isolate the packaged-app + userdata probes from the test machine.
    monkeypatch.setattr(gu, "packaged_gui_app_paths", lambda: [])
    monkeypatch.setattr(gu, "desktop_userdata_dirs", lambda: [tmp_path / "userdata-none"])

    removed = gu.uninstall_gui(hermes_home)
    removed_names = {p.name for p in removed}

    # GUI artifacts removed.
    desktop = agent_root / "apps" / "desktop"
    assert not (desktop / "dist").exists()
    assert not (desktop / "release").exists()
    assert not (desktop / "node_modules").exists()
    assert not (agent_root / "node_modules").exists()
    assert not (hermes_home / "desktop-build-stamp.json").exists()
    assert "dist" in removed_names

    # Agent + user data preserved.
    assert (agent_root / "hermes_cli" / "__init__.py").exists()
    assert (agent_root / "venv").exists()
    assert (hermes_home / "config.yaml").exists()
    assert (hermes_home / ".env").exists()
    assert (hermes_home / "sessions").exists()
    # The desktop source dir itself survives (only its build output is gone).
    assert desktop.exists()


def test_uninstall_gui_removes_userdata(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    _make_agent(hermes_home)
    userdata = tmp_path / "Hermes-userdata"
    userdata.mkdir()
    (userdata / "connection.json").write_text("{}")

    monkeypatch.setattr(gu, "packaged_gui_app_paths", lambda: [])
    monkeypatch.setattr(gu, "desktop_userdata_dirs", lambda: [userdata])

    gu.uninstall_gui(hermes_home)
    assert not userdata.exists()


def test_uninstall_gui_keeps_userdata_when_requested(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    _make_agent(hermes_home)
    userdata = tmp_path / "Hermes-userdata"
    userdata.mkdir()

    monkeypatch.setattr(gu, "packaged_gui_app_paths", lambda: [])
    monkeypatch.setattr(gu, "desktop_userdata_dirs", lambda: [userdata])

    gu.uninstall_gui(hermes_home, remove_userdata=False)
    assert userdata.exists()


def test_uninstall_gui_removes_packaged_bundle(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    _make_agent(hermes_home)
    bundle = tmp_path / "Hermes.app"
    (bundle / "Contents").mkdir(parents=True)

    monkeypatch.setattr(gu, "packaged_gui_app_paths", lambda: [bundle])
    monkeypatch.setattr(gu, "desktop_userdata_dirs", lambda: [tmp_path / "none"])

    removed = gu.uninstall_gui(hermes_home)
    assert not bundle.exists()
    assert bundle in removed


def test_gui_install_summary_shape(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    _make_agent(hermes_home)
    _make_gui_build(hermes_home)
    monkeypatch.setattr(gu, "packaged_gui_app_paths", lambda: [])
    monkeypatch.setattr(gu, "desktop_userdata_dirs", lambda: [tmp_path / "none"])

    summary = gu.gui_install_summary(hermes_home)
    # JSON-serializable primitives the desktop UI gates on.
    assert summary["agent_installed"] is True
    assert summary["gui_installed"] is True
    assert isinstance(summary["source_built_artifacts"], list)
    assert all(isinstance(p, str) for p in summary["source_built_artifacts"])
    assert summary["hermes_home"] == str(hermes_home)
    assert summary["platform"] == sys.platform


def test_userdata_dir_per_platform(monkeypatch):
    """userData path matches Electron's app.getPath('userData').

    The desktop app pins userData to the legacy "Costas Code" directory even
    under the Catalyst product name, so that is the primary path.
    """
    home = Path("/home/tester")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))

    monkeypatch.setattr(gu.sys, "platform", "darwin")
    support = home / "Library" / "Application Support"
    assert gu.desktop_userdata_dir() == support / "Costas Code"



def test_linux_discovery_includes_launcher_entry(tmp_path, monkeypatch):
    """The launcher entry that `hermes desktop` installs is removable."""
    monkeypatch.setattr(gu.sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))

    from hermes_cli import linux_desktop_entry as lde

    assert lde.desktop_entry_path() in gu.packaged_gui_app_paths()


def test_userdata_dirs_cover_every_shipped_product_name(monkeypatch):
    """Uninstall must not strand state written under a previous product name."""
    home = Path("/home/tester")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(gu.sys, "platform", "darwin")

    support = home / "Library" / "Application Support"
    dirs = gu.desktop_userdata_dirs()

    assert dirs[0] == support / "Costas Code"
    assert set(dirs) == {support / name for name in gu.DESKTOP_USER_DATA_NAMES}
    assert support / "Catalyst" in dirs
    assert support / "Hermes" in dirs


def test_packaged_app_paths_cover_every_shipped_product_name(monkeypatch):
    """A Catalyst-era uninstall must still find old Costas Code/Hermes bundles."""
    home = Path("/home/tester")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(gu.sys, "platform", "darwin")

    paths = gu.packaged_gui_app_paths()

    for name in gu.DESKTOP_APP_NAMES:
        assert Path("/Applications") / f"{name}.app" in paths
        assert home / "Applications" / f"{name}.app" in paths
    assert len(paths) == len(set(paths)), "candidates must be de-duplicated"


def test_uninstall_gui_removes_every_legacy_userdata_dir(tmp_path, monkeypatch):
    """Both the pinned and legacy userData dirs are cleaned in one pass."""
    hermes_home = tmp_path / ".hermes"
    _make_agent(hermes_home)
    current = tmp_path / "Costas Code"
    legacy = tmp_path / "Hermes"
    for d in (current, legacy):
        d.mkdir()
        (d / "connection.json").write_text("{}")

    monkeypatch.setattr(gu, "packaged_gui_app_paths", lambda: [])
    monkeypatch.setattr(gu, "desktop_userdata_dirs", lambda: [current, legacy])

    removed = gu.uninstall_gui(hermes_home)

    assert not current.exists()
    assert not legacy.exists()
    assert current in removed and legacy in removed


def test_userdata_dir_windows(monkeypatch):
    home = Path("/home/tester")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(gu.sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", r"C:\Users\tester\AppData\Roaming")
    roaming = Path(r"C:\Users\tester\AppData\Roaming")
    assert gu.desktop_userdata_dir() == roaming / "Costas Code"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlink semantics")
def test_remove_path_handles_symlink(tmp_path):
    target = tmp_path / "real"
    target.mkdir()
    link = tmp_path / "link"
    link.symlink_to(target)
    assert gu._remove_path(link) is True
    assert not link.exists()
    # The symlink is gone but its target is untouched.
    assert target.exists()


class _Args:
    """Minimal argparse-Namespace stand-in for run_uninstall."""

    def __init__(self, *, yes=False, full=False, gui=False, gui_summary=False):
        self.yes = yes
        self.full = full
        self.gui = gui
        self.gui_summary = gui_summary








def test_uninstall_args_namespace_mode_mapping():
    """_UninstallArgs maps mode → the gui/full flags run_uninstall reads."""
    import hermes_cli.uninstall as uninstall

    gui = uninstall._UninstallArgs(mode="gui")
    assert gui.gui is True and gui.full is False and gui.yes is True

    lite = uninstall._UninstallArgs(mode="lite")
    assert lite.gui is False and lite.full is False and lite.yes is True

    full = uninstall._UninstallArgs(mode="full")
    assert full.gui is False and full.full is True and full.yes is True

