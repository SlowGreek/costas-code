"""Regression: the repository stage must work on a managed corporate Windows box.

Two defects, both in the clone cascade, both hit by the same field report
(a Microsoft-issued laptop behind enterprise TLS inspection, installing a
PRIVATE distribution fork).

1. **Git ignores the Windows certificate store.** The dependency stage opts uv
   into the native store via ``UV_SYSTEM_CERTS``, but that environment variable
   has no effect on git. Git for Windows / PortableGit validate TLS with their
   bundled OpenSSL CA bundle unless told to use Schannel, so the clone fails
   behind exactly the same corporate MITM certificate that the uv fix was
   written for -- one stage earlier, with a different and unrelated-looking
   error.

2. **The private-repo clone has no authenticated transport.** The cascade is
   SSH -> HTTPS -> anonymous ZIP. On a corporate network port 22 is usually
   blocked, plain HTTPS relies on a credential helper that may never have been
   configured, and the ZIP fallback is unauthenticated -- which for a private
   repository is a guaranteed 404/403. Meanwhile the desktop app has already
   proven the user has working ``gh`` credentials (it used them to fetch
   install.ps1 itself). The installer must reuse that same authenticated
   transport instead of failing with a generic "tried SSH, HTTPS, and ZIP".

These tests pin the contract at the source level; ``install.ps1`` is
Windows-only so there is no runner to execute it on Linux/macOS CI.
"""

import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_INSTALL_PS1 = _ROOT / "scripts" / "install.ps1"


@pytest.fixture(scope="module")
def source() -> str:
    return _INSTALL_PS1.read_text(encoding="utf-8")


def _clone_invocations(source: str) -> list[str]:
    """Every `git ... clone ...` command line in the script."""
    return [m.group(0) for m in re.finditer(r"git [^\n]*clone[^\n]*", source)]


def _uses_schannel(command: str, source: str) -> bool:
    """True when a git command opts into the Windows certificate store.

    Accepts the literal `-c http.sslBackend=schannel` or a splatted variable
    (`git @GitTls ...`) whose definition supplies it. The splat is the shipping
    form and is deliberately platform-aware: install.ps1 also runs under
    PowerShell Core on macOS/Linux, where git has no schannel backend and the
    flag is a hard error ("fatal: Unsupported SSL backend 'schannel'") that
    kills every git operation in the stage. So the contract is "Schannel is in
    effect on Windows", not "this literal string appears".
    """
    if "http.sslBackend=schannel" in command:
        return True

    for splat in re.findall(r"@(\w+)", command):
        # The splat may be assigned conditionally, so scan the whole statement.
        definition = re.search(rf"\${splat}\s*=\s*(?:if\b[^\n]*|@\([^)]*\))", source)
        if definition and "http.sslBackend=schannel" in definition.group(0):
            return True

    return False


def test_git_tls_splat_is_windows_gated(source):
    """The schannel opt-in must not fire off-Windows.

    install.ps1 runs under PowerShell Core on macOS/Linux too (CI exercises its
    repository stage there). Git on those platforms is built without the
    schannel backend, so an unconditional flag aborts every clone/fetch with
    "fatal: Unsupported SSL backend 'schannel'".
    """
    definition = re.search(r"\$GitTls\s*=\s*[^\n]+", source)

    assert definition, "expected a $GitTls definition supplying the TLS backend args"

    line = definition.group(0)

    assert "if" in line and "@()" in line, (
        "$GitTls must be conditional with an empty non-Windows branch, or "
        f"git fails outright on macOS/Linux. Got: {line}"
    )

    guard = re.search(r"\$IsWindowsHost\s*=\s*[^\n]+", source)

    assert guard, "expected an $IsWindowsHost guard driving $GitTls"
    assert "IsWindows" in guard.group(0), (
        "the guard should consult $IsWindows (PowerShell Core) so the flag is "
        f"Windows-only. Got: {guard.group(0)}"
    )


def test_https_clone_uses_the_windows_certificate_store(source):
    """git must validate TLS via Schannel, not its bundled OpenSSL CA bundle.

    Without this, corporate TLS inspection breaks the clone even though the
    machine trusts the corporate root and even though uv was already fixed.
    """
    https_clones = [c for c in _clone_invocations(source) if "RepoUrlHttps" in c]

    assert https_clones, "expected an HTTPS clone in the repository stage"

    for clone in https_clones:
        assert _uses_schannel(clone, source), (
            "the HTTPS clone does not opt into the Windows certificate store; "
            "it will fail behind enterprise TLS inspection. Got: " + clone
        )


def test_git_fetch_operations_also_use_schannel(source):
    """Update/fetch paths need the same treatment as the initial clone."""
    remote_fetches = [
        m.group(0)
        for m in re.finditer(r"git [^\n]*(?:fetch|pull)[^\n]*", source)
        if not _uses_schannel(m.group(0), source)
        and ("origin" in m.group(0) or "http" in m.group(0).lower())
    ]

    assert not remote_fetches, (
        "these remote git operations don't opt into the Windows certificate "
        f"store and will fail behind TLS inspection: {remote_fetches[:3]}"
    )


def test_clone_cascade_has_an_authenticated_transport(source):
    """A private repo needs credentials, not three anonymous attempts.

    The desktop app already proves `gh` works by using it to fetch install.ps1.
    The clone must be able to reuse it.
    """
    assert "gh repo clone" in source or "gh auth setup-git" in source, (
        "the clone cascade has no authenticated transport for a PRIVATE "
        "distribution repo: SSH (port 22 usually blocked), plain HTTPS (needs "
        "a configured credential helper), and an anonymous ZIP (404 on a "
        "private repo) can all fail on a corporate machine with working `gh` "
        "credentials sitting right there"
    )


def test_noninteractive_clone_does_not_block_on_a_credential_prompt(source):
    """An HTTPS clone must not open a credential dialog in a GUI-driven stage.

    The desktop bootstrap runs install.ps1 non-interactively; a git credential
    prompt there hangs the installer with no visible cause.
    """
    assert "GIT_TERMINAL_PROMPT" in source, (
        "GIT_TERMINAL_PROMPT is never set, so an HTTPS clone against a private "
        "repo can block forever waiting for input that the desktop bootstrap "
        "can never deliver"
    )


def test_private_repo_clone_failure_is_distinguishable_from_a_network_failure(source):
    """'Tried SSH, HTTPS, and ZIP' does not tell the user what to fix."""
    assert re.search(r"gh auth login|authentication required|not authenticated", source, re.I), (
        "a private-repo clone failure must name the credential problem so the "
        "user knows to run `gh auth login`, rather than reporting a generic "
        "transport failure"
    )
