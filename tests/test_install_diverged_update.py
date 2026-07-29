"""Regression: installer/bootstrap must recover from diverged managed clones.

When ``~/.hermes/hermes-agent`` has local-only commits (or diverged history),
``git pull --ff-only`` fails and bootstrap aborts at the repository stage.
``hermes update`` already resets to ``origin/$BRANCH`` in that case; both
installer scripts must do the same.

Fixes the bootstrap failure seen in #53257 and desktop update paths that run
``install.ps1`` / ``install.sh`` non-interactively.

These tests EXECUTE the repository stage against a real diverged checkout
rather than regex-scanning the scripts. The previous source-scanning version
broke the moment an unrelated flag was added to the git invocations (a
``-c http.sslBackend=schannel`` for corporate TLS), even though the recovery
behavior it claimed to protect was completely intact — the failure mode
AGENTS.md's "never read source code in tests" rule exists to prevent.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"
POWERSHELL = next(
    (candidate for candidate in ("pwsh", "powershell") if shutil.which(candidate)),
    None,
)


def _installer_default_branch() -> str:
    """The branch the installer tracks, read from the script.

    Hardcoding it couples the fixture to a distribution-branch rename: every
    git operation in the repository stage targets ``$BRANCH``, so a mismatched
    fixture branch makes them all fail with ``couldn't find remote ref`` while
    the stage still reports success.
    """
    match = re.search(r'^BRANCH="([^"]+)"', INSTALL_SH.read_text(encoding="utf-8"), re.MULTILINE)
    assert match, "install.sh must declare a default BRANCH"

    return match.group(1)


BRANCH = _installer_default_branch()


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
    )


def _make_diverged_checkout(tmp_path: Path) -> Path:
    """A managed clone carrying a local-only commit that blocks an ff-only pull.

    Both sides advance from the same base, so ``git pull --ff-only`` cannot
    fast-forward and the installer must fall back to a hard reset.
    """
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init")
    (seed / "tracked.txt").write_text("base\n", encoding="utf-8")
    _git(seed, "add", "tracked.txt")
    _git(seed, "commit", "-m", "base")
    _git(seed, "branch", "-M", BRANCH)

    remote = tmp_path / "origin.git"
    _git(tmp_path, "init", "--bare", str(remote))
    _git(seed, "remote", "add", "origin", str(remote))
    _git(seed, "push", "-u", "origin", BRANCH)

    managed = tmp_path / "hermes-agent"
    _git(tmp_path, "clone", "--branch", BRANCH, str(remote), str(managed))

    # Upstream moves forward.
    upstream = tmp_path / "upstream"
    _git(tmp_path, "clone", "--branch", BRANCH, str(remote), str(upstream))
    (upstream / "tracked.txt").write_text("upstream edit\n", encoding="utf-8")
    _git(upstream, "commit", "-am", "upstream")
    _git(upstream, "push", "origin", BRANCH)

    # The managed clone commits its OWN change on the old base -> diverged.
    (managed / "tracked.txt").write_text("local commit\n", encoding="utf-8")
    _git(managed, "commit", "-am", "local-only commit")

    return managed


def _assert_recovered_to_upstream(managed: Path, result: subprocess.CompletedProcess) -> None:
    assert result.returncode == 0, f"repository stage failed:\n{result.stdout}\n{result.stderr}"
    assert (managed / "tracked.txt").read_text(encoding="utf-8") == "upstream edit\n", (
        "a diverged managed clone must be reset onto origin/$BRANCH; the "
        "checkout still holds its local-only commit, so bootstrap would keep "
        f"running stale code.\n{result.stdout}"
    )
    # The local-only commit must be gone from the branch tip.
    log = _git(managed, "log", "--oneline", "-1").stdout
    assert "local-only commit" not in log, f"reset did not drop the diverged commit: {log}"


def test_install_sh_resets_when_ff_only_pull_fails(tmp_path: Path) -> None:
    managed = _make_diverged_checkout(tmp_path)

    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--stage", "repository", "--non-interactive"],
        cwd=tmp_path,
        env=os.environ
        | {
            "HERMES_HOME": str(tmp_path / "hermes-home"),
            "HERMES_INSTALL_DIR": str(managed),
        },
        capture_output=True,
        text=True,
    )

    _assert_recovered_to_upstream(managed, result)


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell not available")
def test_install_ps1_resets_when_ff_only_pull_fails(tmp_path: Path) -> None:
    managed = _make_diverged_checkout(tmp_path)

    result = subprocess.run(
        [
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(INSTALL_PS1),
            "-Stage",
            "repository",
            "-NonInteractive",
            # install.ps1 takes the target as a parameter; unlike install.sh it
            # does not read HERMES_INSTALL_DIR.
            "-InstallDir",
            str(managed),
        ],
        cwd=tmp_path,
        env=os.environ
        | {
            "HERMES_HOME": str(tmp_path / "hermes-home"),
        },
        capture_output=True,
        text=True,
    )

    _assert_recovered_to_upstream(managed, result)
