"""The diagrammer guidance for `sketch` must stay honest about the sandbox."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from workbench_sketch import MAX_SKETCH_HTML_BYTES, SKETCH_MODEL_GUIDANCE

RUNTIME = (
    Path(__file__).resolve().parents[2]
    / "apps/desktop/src/app/workbench/sketch/sketch-runtime.ts"
)


def test_guidance_states_the_offline_constraint() -> None:
    text = SKETCH_MODEL_GUIDANCE.lower()
    assert "offline" in text
    assert "self-contained" in text
    for banned in ("fetch", "cdn", "websocket"):
        assert banned in text, f"guidance must warn about {banned}"


def test_guidance_does_not_promise_three_js() -> None:
    """The original overpromise. If someone re-adds it, this fails."""
    assert re.search(r"\bno three\.js\b", SKETCH_MODEL_GUIDANCE, re.I)
    # ...and never as an available capability.
    assert not re.search(r"(use|with|via|import)\s+three\.js", SKETCH_MODEL_GUIDANCE, re.I)


def test_guidance_states_the_real_byte_budget() -> None:
    assert str(MAX_SKETCH_HTML_BYTES // 1024) + " KiB" in SKETCH_MODEL_GUIDANCE
    assert "do NOT count against your budget" in SKETCH_MODEL_GUIDANCE


@pytest.mark.skipif(not RUNTIME.exists(), reason="desktop sources not present")
@pytest.mark.parametrize(
    "name",
    [
        "scene3d",
        "canvas2d",
        "orbitControls",
        "loop",
        "box",
        "sphere",
        "plane",
        "mat4",
        "vec3",
        "program",
        "shader",
        "buffer",
    ],
)
def test_every_advertised_api_exists_in_the_runtime(name: str) -> None:
    """Guidance that names a helper the runtime lacks is a lie to the model."""
    assert name in SKETCH_MODEL_GUIDANCE, f"{name} missing from guidance"
    assert name in RUNTIME.read_text(encoding="utf-8"), f"{name} missing from runtime"


@pytest.mark.skipif(not RUNTIME.exists(), reason="desktop sources not present")
def test_runtime_source_makes_no_network_calls() -> None:
    source = RUNTIME.read_text(encoding="utf-8")
    body = source.split("SKETCH_RUNTIME_JS")[1]
    for banned in ("fetch(", "XMLHttpRequest", "WebSocket", "importScripts", "sendBeacon"):
        assert banned not in body, f"runtime must not use {banned}"
