"""Tests for the sketch artifact payload validation."""

from __future__ import annotations

import pytest

from workbench_sketch import (
    MAX_SKETCH_HTML_BYTES,
    SketchValidationError,
    is_sketch_kind,
    validate_sketch_payload,
)


def test_accepts_minimal_html():
    assert validate_sketch_payload({"html": "<h1>hi</h1>"}) == {"html": "<h1>hi</h1>"}


def test_preserves_script_content_verbatim():
    """The sandbox is the boundary; validation must not mangle model code."""
    html = "<canvas id=c></canvas><script>const x=1;alert(x)</script>"
    assert validate_sketch_payload({"html": html})["html"] == html


def test_drops_unknown_sibling_keys():
    assert validate_sketch_payload({"html": "<p>x</p>", "js": "evil"}) == {"html": "<p>x</p>"}


@pytest.mark.parametrize("payload", [None, [], "html", 3])
def test_rejects_non_object_payload(payload):
    with pytest.raises(SketchValidationError):
        validate_sketch_payload(payload)


def test_rejects_missing_html():
    with pytest.raises(SketchValidationError):
        validate_sketch_payload({"nodes": []})


@pytest.mark.parametrize("html", [None, 123, {"a": 1}, ["<p>"]])
def test_rejects_non_string_html(html):
    with pytest.raises(SketchValidationError):
        validate_sketch_payload({"html": html})


@pytest.mark.parametrize("html", ["", "   ", "\n\t"])
def test_rejects_blank_html(html):
    with pytest.raises(SketchValidationError):
        validate_sketch_payload({"html": html})


def test_accepts_html_at_the_byte_cap():
    html = "a" * MAX_SKETCH_HTML_BYTES
    assert validate_sketch_payload({"html": html})["html"] == html


def test_rejects_html_over_the_byte_cap():
    with pytest.raises(SketchValidationError) as excinfo:
        validate_sketch_payload({"html": "a" * (MAX_SKETCH_HTML_BYTES + 1)})
    assert str(MAX_SKETCH_HTML_BYTES) in str(excinfo.value)


def test_cap_is_measured_in_bytes_not_characters():
    """Multi-byte content must not sneak past a character-counted cap."""
    html = "\u00e9" * (MAX_SKETCH_HTML_BYTES // 2 + 1)  # 2 bytes each
    assert len(html) < MAX_SKETCH_HTML_BYTES
    with pytest.raises(SketchValidationError):
        validate_sketch_payload({"html": html})


@pytest.mark.parametrize("kind", ["sketch", "Sketch", " SKETCH "])
def test_is_sketch_kind_matches(kind):
    assert is_sketch_kind(kind)


@pytest.mark.parametrize("kind", ["map", "timeline", None, 1, "sketches"])
def test_is_sketch_kind_rejects_others(kind):
    assert not is_sketch_kind(kind)
