"""First-update recovery from a pre-fix macOS desktop handoff."""

from __future__ import annotations

import importlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
POSIX_HANDOFF = REPO_ROOT / "scripts" / "desktop-update" / "posix.sh"
cli_main = importlib.import_module("hermes_cli.main")


def _git_root(root: Path) -> str:
    root.mkdir(parents=True)
    subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Hermes Test"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "user.email", "hermes@example.invalid"], cwd=root, check=True
    )
    subprocess.run(["git", "commit", "--allow-empty", "-m", "updated checkout"], cwd=root, check=True)
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()


def _bundle(path: Path, marker: str, commit: str) -> Path:
    resources = path / "Contents" / "Resources"
    resources.mkdir(parents=True)
    (resources / "marker.txt").write_text(marker)
    (resources / "install-stamp.json").write_text(
        json.dumps({"schemaVersion": 1, "commit": commit}) + "\n"
    )
    return path


@pytest.mark.macos_only
def test_fresh_build_process_finalizes_an_old_desktop_handoff(tmp_path: Path) -> None:
    install_root = tmp_path / "hermes-agent"
    expected_commit = _git_root(install_root)
    handoff = install_root / "scripts" / "desktop-update" / "posix.sh"
    handoff.parent.mkdir(parents=True)
    shutil.copy2(POSIX_HANDOFF, handoff)
    rebuilt = _bundle(
        install_root
        / "apps"
        / "desktop"
        / "release"
        / "mac-arm64"
        / "Catalyst.app",
        "new",
        expected_commit,
    )
    installed = _bundle(tmp_path / "Applications" / "Catalyst.app", "old", "1" * 40)
    old_parent = [
        "/bin/bash",
        str(handoff),
        "--daemonized",
        "--install-root",
        str(install_root),
        "--relaunch-target",
        str(installed),
    ]

    finalized = cli_main._finalize_old_macos_desktop_handoff(
        install_root / "apps" / "desktop",
        ancestor_cmdlines=[["python", "-m", "hermes_cli.main"], old_parent],
    )

    assert finalized is True
    assert (installed / "Contents" / "Resources" / "marker.txt").read_text() == "new"
    assert rebuilt.exists()
