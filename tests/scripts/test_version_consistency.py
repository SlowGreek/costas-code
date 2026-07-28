"""Version-source consistency: the four places Hermes records its own version
must agree, and uv.lock must be re-locked whenever pyproject.toml moves.

This is the invariant that broke CI on the v0.20.0 bump: `update_version_files`
wrote pyproject.toml / __init__.py / desktop package.json but never re-locked,
leaving uv.lock pinning the previous version. CI installs with
`uv sync --locked`, which refuses a stale lockfile, so dependency install
failed on every test slice before a single test ran.

Asserted as a relationship between files (do they agree?), never as a snapshot
of the current version number — the version is expected to change every
release, and pinning it here would just break CI on each bump.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

PYPROJECT = REPO_ROOT / "pyproject.toml"
INIT_PY = REPO_ROOT / "hermes_cli" / "__init__.py"
DESKTOP_PKG = REPO_ROOT / "apps" / "desktop" / "package.json"
UV_LOCK = REPO_ROOT / "uv.lock"


def _search(path: Path, pattern: str) -> str | None:
    if not path.exists():
        return None
    match = re.search(pattern, path.read_text(encoding="utf-8"), re.MULTILINE)
    return match.group(1) if match else None


def _pyproject_version() -> str | None:
    return _search(PYPROJECT, r'^version\s*=\s*"([^"]+)"')


def _init_version() -> str | None:
    return _search(INIT_PY, r'^__version__\s*=\s*"([^"]+)"')


def _desktop_version() -> str | None:
    if not DESKTOP_PKG.exists():
        return None
    return json.loads(DESKTOP_PKG.read_text(encoding="utf-8")).get("version")


def _uv_lock_version() -> str | None:
    # The project's own entry pins its version; a bump that skips `uv lock`
    # leaves this behind and `uv sync --locked` then refuses to install.
    return _search(UV_LOCK, r'^name = "hermes-agent"\nversion = "([^"]+)"')


def test_python_version_sources_agree():
    """pyproject.toml and hermes_cli.__version__ are the same release."""
    pyproject, init = _pyproject_version(), _init_version()

    assert pyproject, "no version found in pyproject.toml"
    assert init, "no __version__ found in hermes_cli/__init__.py"
    assert pyproject == init, (
        f"version drift: pyproject.toml={pyproject} but "
        f"hermes_cli.__version__={init}. Bump both (scripts/release.py does)."
    )


def test_uv_lock_is_relocked_after_a_version_bump():
    """uv.lock pins the project's own version and must track pyproject.toml.

    CI runs `uv sync --locked`; a stale lockfile fails dependency install on
    every test slice before any test executes, which reads as a sweeping
    regression rather than a one-line staleness. Regenerate with `uv lock`.
    """
    pyproject, locked = _pyproject_version(), _uv_lock_version()

    if locked is None:
        pytest.skip("uv.lock has no hermes-agent entry")

    assert pyproject == locked, (
        f"uv.lock is stale: pyproject.toml={pyproject} but uv.lock pins "
        f"{locked}. Run `uv lock` and commit the result."
    )


def test_desktop_package_version_tracks_python():
    """The Electron app's package.json version follows the Python package.

    `update_version_files` has always written this file, but until the v0.20.0
    bump it was never staged in the release commit — so the desktop version
    could silently drift from the release it shipped in.
    """
    pyproject, desktop = _pyproject_version(), _desktop_version()

    if desktop is None:
        pytest.skip("apps/desktop/package.json not present")

    assert pyproject == desktop, (
        f"desktop version drift: pyproject.toml={pyproject} but "
        f"apps/desktop/package.json={desktop}"
    )
