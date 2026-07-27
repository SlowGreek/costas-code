"""Regression: the Windows installer must only accept supported interpreters.

A user on Windows reported the desktop app failing to bootstrap with::

    Hermes bootstrap failed at stage 'dependencies': Failed to install
    hermes-agent package even with no extras.

Every install tier failing -- including the last-resort "core only (no
extras)" tier -- is the signature of a venv built on an interpreter that
``pyproject.toml``'s ``requires-python`` excludes.  The tiers differ only in
which *extras* they request; none of them can satisfy the package's own
Python-version gate, so they all fail identically and the real cause is never
named.

Two source-level defects allowed that state:

1. ``$PythonFallbackVersions`` listed ``3.10``, which is outside
   ``requires-python = ">=3.11,<3.14"``.  ``uv venv --python 3.10`` succeeds,
   so the venv stage reported success and the failure surfaced one stage
   later as an unexplained dependency error.
2. The system-Python fallback matched ``Python 3\\.(1[0-9]|[1-9][0-9])``,
   accepting both 3.10 (excluded) and 3.14+ (excluded, and with no wheels for
   the Rust transitives).

These tests pin the installer's accepted range to ``requires-python`` so the
two can't drift apart again.  ``install.ps1`` only runs on Windows, so there's
no runner to execute it on Linux CI -- the contract is asserted against the
declared constants instead.
"""

import re
import tomllib
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_INSTALL_PS1 = _ROOT / "scripts" / "install.ps1"
_PYPROJECT = _ROOT / "pyproject.toml"


@pytest.fixture(scope="module")
def source() -> str:
    return _INSTALL_PS1.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def supported_minors() -> set[int]:
    """The 3.x minors permitted by pyproject's requires-python."""
    requires = tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))["project"][
        "requires-python"
    ]
    lower = re.search(r">=\s*3\.(\d+)", requires)
    upper = re.search(r"<\s*3\.(\d+)", requires)
    assert lower, f"could not parse a lower bound from requires-python={requires!r}"
    assert upper, f"could not parse an upper bound from requires-python={requires!r}"
    return set(range(int(lower.group(1)), int(upper.group(1))))


def _declared_fallback_minors(source: str) -> list[int]:
    match = re.search(r"\$PythonFallbackVersions\s*=\s*@\(([^)]*)\)", source)
    assert match, "expected a $PythonFallbackVersions constant in install.ps1"
    return [int(m) for m in re.findall(r"3\.(\d+)", match.group(1))]


def _declared_primary_minor(source: str) -> int:
    match = re.search(r"^\$PythonVersion\s*=\s*\"3\.(\d+)\"", source, re.MULTILINE)
    assert match, "expected a $PythonVersion constant in install.ps1"
    return int(match.group(1))


def test_primary_python_version_is_supported(source, supported_minors):
    """The requested interpreter must satisfy requires-python."""
    assert _declared_primary_minor(source) in supported_minors, (
        "$PythonVersion is outside pyproject's requires-python; the venv would "
        "be built on an interpreter the package itself rejects"
    )


def test_every_fallback_version_is_supported(source, supported_minors):
    """No fallback may name an interpreter requires-python excludes.

    This is the specific defect that produced the field report: 3.10 was
    listed, `uv venv --python 3.10` succeeded, and then EVERY install tier
    failed on the package's own metadata gate.
    """
    unsupported = [
        f"3.{m}" for m in _declared_fallback_minors(source) if m not in supported_minors
    ]
    assert not unsupported, (
        f"$PythonFallbackVersions offers {unsupported}, outside pyproject's "
        "requires-python. `uv venv` accepts it, so the venv stage reports "
        "success and the install fails one stage later with the opaque "
        "'even with no extras' error."
    )


def test_fallback_list_is_non_empty_and_ordered(source, supported_minors):
    """Fallbacks must exist and be ordered nearest-first from $PythonVersion.

    An empty list would make a machine without the primary version fail
    outright even though a supported alternative was installable.
    """
    minors = _declared_fallback_minors(source)
    assert minors, "expected at least one fallback interpreter"
    primary = _declared_primary_minor(source)
    assert primary not in minors, (
        "the primary $PythonVersion must not repeat in the fallback list -- "
        "Resolve-AvailablePythonVersion already probes it first"
    )
    assert minors == sorted(minors, key=lambda m: abs(m - primary)), (
        f"fallbacks {minors} should be ordered by distance from the primary "
        f"3.{primary} so the closest supported interpreter wins"
    )


def test_system_python_probe_rejects_unsupported_versions(source, supported_minors):
    """The bare `python` fallback must range-check, not just match 3.1x.

    The original pattern accepted 3.10 and 3.14+; both produce a venv that
    every install tier then fails against.
    """
    assert not re.search(r'"Python 3\\\.\(1\[0-9\]\|\[1-9\]\[0-9\]\)"', source), (
        "the system-Python probe still uses the unbounded `3.(1[0-9]|[1-9][0-9])` "
        "pattern, which accepts interpreters outside requires-python"
    )
    bounds = re.search(
        r"\$sysMinor\s*-ge\s*(\d+)\s*-and\s*\$sysMinor\s*-le\s*(\d+)", source
    )
    assert bounds, (
        "expected the system-Python probe to range-check the parsed minor "
        "version against the supported window"
    )
    low, high = int(bounds.group(1)), int(bounds.group(2))
    assert set(range(low, high + 1)) == supported_minors, (
        f"system-Python probe accepts 3.{low}-3.{high}, but requires-python "
        f"permits minors {sorted(supported_minors)}"
    )


def test_dependency_failure_names_the_interpreter(source):
    """The 'even with no extras' throw must report the venv's Python.

    Without it the user sees a dependency error with no hint that the real
    problem is an unsupported interpreter -- exactly the field report this
    module exists for.
    """
    throw_at = source.index(
        'throw "Failed to install hermes-agent package even with no extras'
    )
    window = source[max(0, throw_at - 1200) : throw_at + 400]
    assert "--version" in window, (
        "the failure path should probe the venv interpreter's version so the "
        "error can name it"
    )
    assert "3.11" in window and "3.13" in window, (
        "the error should state the supported Python range so the user knows "
        "what to install"
    )
