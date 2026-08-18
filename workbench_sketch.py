"""Validation for the ``sketch`` workbench artifact kind.

The ``sketch`` kind is the deliberate escape hatch of the ideation workbench:
the model authors arbitrary HTML/CSS/JS (canvas, WebGL, SVG, whatever fits the
idea) and the desktop renders it verbatim. It trades away everything the graph
kinds give -- stable ids, incremental updates, deixis ("that box on the left")
-- for total expressive freedom. A sketch is regenerated whole; it is never
patched and never referenced by id.

SECURITY MODEL (read this before relaxing anything here)
--------------------------------------------------------
This module is NOT the security boundary and must not pretend to be one.
Sanitising attacker-shaped HTML with a parser is a losing game, and a
half-trusted parser is worse than an honest sandbox because it invites callers
to believe the output is safe. The actual boundary is the renderer:

* The HTML is rendered ONLY via ``<iframe srcdoc={...}>``. It is never inserted
  into the application DOM (no ``dangerouslySetInnerHTML``), so it can never
  execute in the privileged Electron renderer's realm.
* The iframe carries ``sandbox="allow-scripts"`` and deliberately NOT
  ``allow-same-origin``. That gives the document an opaque origin: no access to
  the app's localStorage/IndexedDB/cookies, no ``parent.document``, no reach
  into the preload bridge or the local gateway JSON-RPC surface.
* A restrictive CSP meta is injected into the srcdoc document by the renderer's
  document builder: ``default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; connect-src 'none'``.
  ``'unsafe-inline'`` for script/style is required -- an inline-script sandbox
  is the entire feature -- and is acceptable precisely because the origin is
  opaque and ``connect-src 'none'`` plus ``default-src 'none'`` mean the code
  can compute and paint but cannot fetch, exfiltrate, or load anything remote.
* ``allow-same-origin``, ``allow-top-navigation``, ``allow-popups``,
  ``allow-modals`` and ``allow-forms`` are all withheld.

So this module's job is narrow and honest: make sure the payload is
structurally what the renderer expects and is not large enough to wedge the UI
or the database row. It intentionally does NOT try to filter script content.
"""

from __future__ import annotations

from typing import Any, Dict

# Roughly one screenful of generated markup plus a shader/geometry blob. Large
# enough for real Three.js-style sketches, small enough that a runaway
# generation cannot blow up the artifact row or the IPC payload.
MAX_SKETCH_HTML_BYTES = 128 * 1024


class SketchValidationError(ValueError):
    """The sketch payload is not a shape the sandboxed renderer can accept."""


def validate_sketch_payload(payload: Any) -> Dict[str, str]:
    """Return a normalised ``{"html": ...}`` payload or raise.

    Unlike the graph kinds -- which trim rather than fail because a partial map
    is still useful -- a sketch is atomic. Truncating model-authored HTML at a
    byte offset yields a broken document, so an over-cap sketch is rejected and
    the caller regenerates something smaller.
    """
    if not isinstance(payload, dict):
        raise SketchValidationError("sketch payload must be an object")

    if "html" not in payload:
        raise SketchValidationError("sketch payload requires an html field")

    html = payload["html"]
    if not isinstance(html, str):
        raise SketchValidationError("sketch html must be a string")
    if not html.strip():
        raise SketchValidationError("sketch html is required")

    size = len(html.encode("utf-8"))
    if size > MAX_SKETCH_HTML_BYTES:
        raise SketchValidationError(
            f"sketch html exceeds {MAX_SKETCH_HTML_BYTES} bytes (got {size})"
        )

    # Deliberately no structural filtering beyond this: the sandbox is the
    # boundary. Unknown sibling keys are dropped rather than rejected so the
    # payload stays exactly what the renderer contracts for.
    return {"html": html}


def is_sketch_kind(kind: Any) -> bool:
    """True when an artifact row should be routed to the sketch renderer."""
    return isinstance(kind, str) and kind.strip().lower() == "sketch"
