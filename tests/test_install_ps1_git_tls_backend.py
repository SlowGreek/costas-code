"""Regression: the git TLS backend install.ps1 selects must be usable here.

``install.ps1`` pins ``http.sslBackend=schannel`` so git validates certificates
against the Windows certificate store — without it, corporate TLS inspection
breaks every clone/fetch even on a machine that trusts the corporate root.

But ``install.ps1`` also runs under PowerShell Core on macOS and Linux (CI
exercises its repository stage there), and git on those platforms is built
without the schannel backend. An unconditional flag is a hard error:

    fatal: Unsupported SSL backend 'schannel'. Supported SSL backends:
        secure-transport
        openssl

which kills every git operation in the repository stage — the stage then falls
through its whole clone cascade and fails. That bug shipped once already.

WHY THIS FILE EXISTS SEPARATELY: the existing coverage does not catch it.

  - ``test_install_diverged_update`` executes the repository stage for real,
    but its fixtures use LOCAL-PATH remotes (``/tmp/...``). ``http.sslBackend``
    only applies to HTTP(S) transports, so git never enters the TLS layer and
    silently ignores an invalid backend. Verified: re-injecting the bug leaves
    those tests green.
  - ``test_git_tls_splat_is_windows_gated`` asserts the shape of the guard,
    which is a source-level check — it catches the exact regression we already
    hit, but not a differently-spelled equivalent.

So this exercises the real thing: hand git the backend install.ps1 would
select on THIS platform and confirm git accepts it. Git validates the backend
name before opening a connection, so pointing at a closed localhost port keeps
the test hermetic — no network, no fixture server.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"

# Any HTTP(S) URL routes through the TLS backend selection. A closed port on
# loopback fails fast with a connection error *after* the backend is validated,
# which is exactly the discrimination we want and needs no network.
_UNREACHABLE = "http://127.0.0.1:1/unreachable.git"
_UNSUPPORTED = "Unsupported SSL backend"


@pytest.fixture(scope="module")
def source() -> str:
    return INSTALL_PS1.read_text(encoding="utf-8")


POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


def _git_tls_args_from_powershell() -> list[str]:
    """Ask PowerShell what ``$GitTls`` actually evaluates to on this host.

    Executing the definition beats parsing it. A static read of the else-branch
    cannot see a guard that computes the wrong answer -- e.g.
    ``$IsWindowsHost = $true`` keeps the ``else { @() }`` shape intact while
    sending the Windows-only backend to every platform.
    """
    src = INSTALL_PS1.read_text(encoding="utf-8")
    guard = re.search(r"^\$IsWindowsHost\s*=.*$", src, re.MULTILINE)
    tls = re.search(r"^\$GitTls\s*=.*$", src, re.MULTILINE)

    assert guard, "expected an $IsWindowsHost definition in install.ps1"
    assert tls, "expected a $GitTls definition in install.ps1"

    # Evaluate the two real lines, then print the resulting args one per line.
    script = f"{guard.group(0)}\n{tls.group(0)}\n$GitTls | ForEach-Object {{ $_ }}"
    result = subprocess.run(
        [str(POWERSHELL), "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, f"evaluating $GitTls failed:\n{result.stderr}"

    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell not available")
def test_git_tls_args_are_accepted_by_the_local_git(tmp_path):
    """Whatever $GitTls evaluates to HERE, the local git must accept.

    This is the real check, end to end: PowerShell evaluates the actual guard,
    and the resulting args go to the actual git binary. On macOS/Linux the
    correct answer is no TLS args at all; if the Windows-only backend reaches
    them -- by a leaked else-branch OR a miscomputed guard -- git rejects it
    and every git operation in the repository stage dies.
    """
    args = _git_tls_args_from_powershell()

    result = subprocess.run(
        ["git", *args, "ls-remote", _UNREACHABLE],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )

    assert _UNSUPPORTED not in result.stderr, (
        f"$GitTls evaluates to {args} on this platform, and git rejects it:\n"
        f"{result.stderr.strip()}\n"
        "Every git operation in the repository stage would fail. The TLS "
        "backend pin must be Windows-only."
    )


def test_the_windows_backend_is_still_actually_requested(source):
    """The Windows branch must really select schannel.

    Guards the opposite regression: quietly dropping the pin would leave
    corporate TLS inspection broken again, and every test above would still
    pass because they only assert the non-Windows path.
    """
    match = re.search(r"\$GitTls\s*=\s*if\s*\([^)]*\)\s*\{([^}]*)\}", source)

    assert match, "expected a $GitTls conditional definition"
    assert "http.sslBackend=schannel" in match.group(1), (
        "the Windows branch of $GitTls no longer selects the schannel backend, "
        "so git would fall back to its bundled CA bundle and fail behind "
        "corporate TLS inspection"
    )


def test_schannel_would_be_rejected_here(tmp_path):
    """Sanity-check the probe itself.

    If this ever stops failing, the discriminator is broken and the test above
    would pass vacuously — e.g. a future git that accepts unknown backends, or
    a platform that genuinely supports schannel.
    """
    result = subprocess.run(
        ["git", "-c", "http.sslBackend=schannel", "ls-remote", _UNREACHABLE],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )

    if _UNSUPPORTED not in result.stderr:
        pytest.skip("this platform's git accepts the schannel backend; probe not meaningful here")
