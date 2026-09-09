"""Hermes Desktop (Chat GUI) uninstaller: removes only GUI state — built Electron artifacts, the packaged
app, and the desktop's own ``userData`` — never agent source, venv, config, sessions or .env."""

import os
import shutil
import sys
from pathlib import Path

from hermes_constants import get_hermes_home

from hermes_cli.colors import Colors, color


def _logger(mark: str, col: str):
    return lambda msg: print(f"{color(mark, col)} {msg}")


log_info, log_success = _logger("→", Colors.CYAN), _logger("✓", Colors.GREEN)
log_warn = _logger("⚠", Colors.YELLOW)


def _env_dir(var: str, fallback: Path) -> Path:
    """``Path($var)`` when the env var is set, else *fallback*."""
    return Path(value) if (value := os.environ.get(var)) else fallback


DESKTOP_USER_DATA_NAMES = ("Costas Code", "Catalyst", "Hermes")
DESKTOP_APP_NAMES = ("Catalyst", "Costas Code", "Hermes")

def desktop_userdata_dir() -> Path:
    """Return the primary Electron ``userData`` directory for the desktop app.

    The desktop app pins ``userData`` to the historical "Costas Code"
    directory even now that the product is presented as Catalyst (see
    ``apps/desktop/electron/desktop-user-data.ts``), so that is the primary
    location. ``desktop_userdata_dirs()`` returns every legacy name too.

    This is GUI-only state (connection.json, updates.json, Chromium cache) and
    never holds agent config or sessions.
    """
    return desktop_userdata_dirs()[0]

def source_built_gui_artifacts(hermes_home: Path) -> "list[Path]":
    """GUI build artifacts produced by ``hermes desktop`` inside the checkout (same ``hermes-agent/`` layout
    install.sh uses). The Python agent runs from source + venv and never needs the Electron build output or
    node_modules (the workspace-root node_modules only carries Electron, ~200MB)."""
    agent_root = hermes_home / "hermes-agent"
    desktop_dir = agent_root / "apps" / "desktop"
    return [desktop_dir / "dist", desktop_dir / "release", desktop_dir / "node_modules",
            agent_root / "node_modules", hermes_home / "desktop-build-stamp.json"]


def packaged_gui_app_paths() -> "list[Path]":
    """Standard install locations of the packaged desktop distributable.

    Returns every candidate for the current OS, for every product name this
    app has shipped under (Catalyst today, "Costas Code" and "Hermes"
    historically); the caller filters to those that actually exist. We never
    glob system-wide — only well-known electron-builder output locations.
    """
    home = Path.home()
    paths: list[Path] = []
    if sys.platform == "darwin":
        for name in DESKTOP_APP_NAMES:
            paths.append(Path("/Applications") / f"{name}.app")
            paths.append(home / "Applications" / f"{name}.app")
    elif sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        local_base = Path(local) if local else (home / "AppData" / "Local")
        program_files = os.environ.get("ProgramFiles")
        for name in DESKTOP_APP_NAMES:
            # NSIS per-user install (perMachine=false → Programs\<Name>).
            paths.append(local_base / "Programs" / name)
            if program_files:
                # NSIS per-machine fallback (needs admin to remove).
                paths.append(Path(program_files) / name)
        # Older / alternate layout some builds used.
        paths.append(local_base / "hermes-desktop")
    else:
        # Linux: AppImage is a single file the user placed somewhere; we can
        # only reliably clean the desktop entry + icon we know the name of.
        # The AppImage itself lives wherever the user put it, so we surface a
        # hint rather than guessing. deb/rpm installs are owned by the system
        # package manager and must be removed via apt/dnf — see the message in
        # ``uninstall_gui``.
        from hermes_cli.linux_desktop_entry import desktop_entry_path

        data = os.environ.get("XDG_DATA_HOME")
        data_base = Path(data) if data else (home / ".local" / "share")
        apps = data_base / "applications"
        for name in DESKTOP_APP_NAMES:
            paths.append(apps / f"{name}.desktop")
            paths.append(apps / f"{name.lower().replace(' ', '-')}.desktop")
        paths += [
            # The launcher entry `hermes desktop` installs. Its icon is
            # also copied into the hicolor tree (see
            # linux_desktop_entry._install_icon_to_hicolor) — remove
            # every size dir the installer could have written.
            desktop_entry_path(),
            # Some packaged builds emit this casing.
            data_base / "applications" / "Hermes.desktop",
            data_base / "icons" / "hicolor" / "scalable" / "apps" / "hermes.png",
        ]
        # Fixed-size hicolor dirs: the icon is copied at its native size
        # (read from the PNG header), so sweep the standard ones plus the
        # 1024x1024 dir the shipped asset lands in.
        for size in ("256x256", "512x512", "1024x1024"):
            paths.append(data_base / "icons" / "hicolor" / size / "apps" / "hermes.png")
    # Preserve order while dropping duplicates (e.g. lowercase collisions).
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in paths:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique

def agent_is_installed(hermes_home: Path) -> bool:
    """True when a usable Python agent install exists under HERMES_HOME (gates the desktop UI's options).
    Package source or a venv alone is enough — a source checkout without a venv is still "the agent is here"."""
    return any((hermes_home / "hermes-agent" / sub).is_dir() for sub in ("hermes_cli", "venv", ".venv"))


def gui_is_installed(hermes_home: Path) -> bool:
    """Return True when any desktop GUI artifact exists (built or packaged)."""
    return any(p.exists() for p in (*source_built_gui_artifacts(hermes_home), *packaged_gui_app_paths(), *desktop_userdata_dirs()))


def gui_install_summary(hermes_home: "Path | None" = None) -> dict:
    """Structured snapshot of what's installed, for the desktop UI to render.

    Returns JSON-serializable primitives so the Electron main process can
    forward it to the renderer via IPC (paths as strings, booleans for the
    high-level questions the UI gates options on).
    """
    home: Path = hermes_home if hermes_home is not None else get_hermes_home()

    source_artifacts = [p for p in source_built_gui_artifacts(home) if p.exists()]
    packaged = [p for p in packaged_gui_app_paths() if p.exists()]
    userdata = desktop_userdata_dir()
    userdata_all = desktop_userdata_dirs()
    userdata_existing = [p for p in userdata_all if p.exists()]

    return {
        "hermes_home": str(home),
        "agent_installed": agent_is_installed(home),
        "gui_installed": gui_is_installed(home),
        "source_built_artifacts": [str(p) for p in source_artifacts],
        "packaged_app_paths": [str(p) for p in packaged],
        "userdata_dir": str(userdata),
        "userdata_exists": bool(userdata_existing),
        "userdata_dirs": [str(p) for p in userdata_all],
        "userdata_existing_dirs": [str(p) for p in userdata_existing],
        "platform": sys.platform,
    }

def _remove_path(path: Path) -> bool:
    """Remove a file or directory tree. Returns True when something was removed."""
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        else:
            return False
        return True
    except Exception as e:
        log_warn(f"Could not remove {path}: {e}")
        return False


def uninstall_gui(hermes_home: "Path | None" = None, *, remove_userdata: bool = True) -> "list[Path]":
    """Remove the desktop GUI's artifacts, leaving the agent + user data intact."""
    home: Path = hermes_home if hermes_home is not None else get_hermes_home()
    removed: list[Path] = []

    def _remove_existing(paths) -> bool:
        """Remove every existing path; True when at least one existed."""
        found = False
        for path in (p for p in paths if p.exists()):
            found = True
            if _remove_path(path):
                log_success(f"Removed {path}")
                removed.append(path)
        return found
    log_info("Removing built GUI artifacts (renderer, release, node_modules)...")
    _remove_existing(source_built_gui_artifacts(home))
    log_info("Removing installed desktop app...")
    if not _remove_existing(packaged_gui_app_paths()):
        log_info("No packaged desktop app found in standard locations")
    if remove_userdata:
        log_info("Removing desktop app data (Electron userData)...")
        _remove_existing(desktop_userdata_dirs())
    if not removed:
        log_info("No desktop GUI artifacts found to remove")
    if sys.platform.startswith("linux"):
        # The desktop entry was removed above but the menu caches still list it; reindex so Hermes
        # disappears from the launcher.
        try:
            from hermes_cli.linux_desktop_entry import desktop_entry_path, refresh_desktop_databases
            entry = desktop_entry_path()
            if entry in removed:
                for tool in refresh_desktop_databases(entry.parent):
                    log_success(f"Refreshed the application menu cache ({tool})")
        except Exception as e:
            log_warn(f"Could not refresh the application menu cache: {e}")
        log_info("If you installed the desktop via a .deb / .rpm package, remove it with your package manager "
                 "(e.g. 'sudo apt remove hermes' or 'sudo dnf remove hermes'). AppImage builds are a single "
                 "file you can delete from wherever you saved it.")
    return removed


def desktop_userdata_dirs() -> "list[Path]":
    """Every Electron ``userData`` directory this product has ever used.

    Ordered most-current first. Catalyst deliberately keeps reading the
    "Costas Code" directory, and older installs used "Hermes" — an uninstall
    that only knew one name silently stranded desktop credentials/settings.
    """
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support"
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        base = Path(appdata) if appdata else (home / "AppData" / "Roaming")
    else:
        # Linux / other POSIX — XDG config home.
        xdg = os.environ.get("XDG_CONFIG_HOME")
        base = Path(xdg) if xdg else (home / ".config")
    return [base / name for name in DESKTOP_USER_DATA_NAMES]
