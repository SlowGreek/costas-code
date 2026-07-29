"""Regression: the Windows cert-store opt-in must cover EVERY uv download.

Field report (Fernando, Microsoft-issued corporate Windows laptop)::

    Hermes bootstrap failed at stage 'dependencies': Failed to install
    hermes-agent package even with no extras.

``UV_SYSTEM_CERTS=true`` was added to fix exactly this: uv ships its own
bundled Mozilla root store and ignores the Windows certificate store, so
every uv download fails behind enterprise TLS inspection even when Windows
itself trusts the corporate root.

The fix was landed *inside* ``Install-Dependencies``, which is the stage that
happened to be reported.  But the FIRST uv download in a run is
``uv python install`` in ``Test-Python`` -- roughly 1400 lines earlier.  On a
machine with no compatible interpreter already present, TLS inspection kills
the managed-CPython download long before the dependencies stage is reached,
and the opt-in never applies.

That is the bug class: the mitigation was scoped to the reported symptom
instead of to every call site that downloads.  These tests pin the class --
the opt-in must be in effect before *any* uv invocation, not merely before
``uv sync`` / ``uv pip install``.
"""

import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_INSTALL_PS1 = _ROOT / "scripts" / "install.ps1"

_ASSIGNMENT = '$env:UV_SYSTEM_CERTS = "true"'


@pytest.fixture(scope="module")
def source() -> str:
    return _INSTALL_PS1.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def lines(source: str) -> list[str]:
    return source.splitlines()


def _assignment_line(lines: list[str]) -> int:
    """1-indexed line of the UV_SYSTEM_CERTS assignment."""
    hits = [i + 1 for i, line in enumerate(lines) if _ASSIGNMENT in line]
    assert hits, f"expected an {_ASSIGNMENT} assignment in install.ps1"
    assert len(hits) == 1, (
        f"expected exactly one {_ASSIGNMENT} assignment so there is a single "
        f"place that governs uv TLS behavior; found {len(hits)} at {hits}"
    )
    return hits[0]


def _uv_invocation_lines(lines: list[str]) -> list[int]:
    """1-indexed lines that actually invoke the uv binary via the call operator."""
    return [i + 1 for i, line in enumerate(lines) if re.search(r"&\s*\$UvCmd\s", line)]


def _enclosing_function(lines: list[str], target: int) -> str | None:
    """Name of the function whose body contains ``target`` (1-indexed), by brace depth.

    PowerShell functions are declared before the driver code that calls them,
    so a textually-early assignment that sits inside a function body is NOT
    guaranteed to run early.  Only top-level statements are.
    """
    depth = 0
    current: str | None = None
    opened_at = 0

    for idx, line in enumerate(lines[:target], start=1):
        decl = re.match(r"^function\s+([\w-]+)", line)
        if decl and depth == 0:
            current = decl.group(1)
            opened_at = depth

        depth += line.count("{") - line.count("}")

        if current is not None and depth <= opened_at and not decl:
            current = None

    return current


def test_system_certs_precedes_every_uv_invocation(lines):
    """The opt-in must be set before the first uv call of ANY kind.

    This is the specific defect behind the field report: the assignment sat at
    line ~2020 inside Install-Dependencies while `uv python install` runs at
    line ~636 inside Test-Python.
    """
    assignment = _assignment_line(lines)
    invocations = _uv_invocation_lines(lines)

    assert invocations, "expected install.ps1 to invoke uv via `& $UvCmd`"

    too_early = [ln for ln in invocations if ln < assignment]

    assert not too_early, (
        f"UV_SYSTEM_CERTS is assigned at line {assignment}, but uv is invoked "
        f"earlier at lines {too_early}. Those downloads run with uv's bundled "
        "Mozilla roots and fail behind corporate TLS inspection. Hoist the "
        "assignment above every `& $UvCmd` call site."
    )


def test_system_certs_is_set_at_top_level_scope(lines):
    """The assignment must not be trapped inside a function body.

    A function-scoped assignment only takes effect if that function happens to
    run first. Test-Python, Install-Git, Install-Node and Install-Dependencies
    all invoke uv or download over TLS, so the opt-in belongs at script scope
    where it is guaranteed to precede all of them.
    """
    assignment = _assignment_line(lines)
    enclosing = _enclosing_function(lines, assignment)

    assert enclosing is None, (
        f"UV_SYSTEM_CERTS is assigned inside function '{enclosing}'. It only "
        "applies when that function runs, so any earlier uv download still "
        "uses the bundled root store. Move it to top-level script scope."
    )


def test_python_install_is_covered_by_the_opt_in(lines):
    """`uv python install` specifically must be protected.

    Named explicitly because it is the first uv download in a fresh run and
    the one that was unprotected in the field report.
    """
    assignment = _assignment_line(lines)
    python_installs = [
        i + 1 for i, line in enumerate(lines) if re.search(r"&\s*\$UvCmd\s+python\s+install", line)
    ]

    assert python_installs, "expected install.ps1 to run `uv python install`"
    assert all(ln > assignment for ln in python_installs), (
        f"`uv python install` at {python_installs} runs before the cert opt-in "
        f"at line {assignment}; the managed-CPython download will fail behind "
        "enterprise TLS inspection and the installer will report an opaque "
        "'Failed to install Python' error."
    )


def test_explicit_user_override_is_still_respected(source):
    """A user who set UV_SYSTEM_CERTS=false must keep control after the hoist."""
    guard = "if (-not $env:UV_SYSTEM_CERTS) {"

    assert guard in source, (
        "the opt-in must stay guarded so an explicit user/IT setting wins"
    )
    assert source.index(guard) < source.index(_ASSIGNMENT), (
        "the guard must precede the assignment"
    )
