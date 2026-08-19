"""Layout intent: HOW a map is arranged, not just what is in it.

Reported: "I asked to have it redrawn linearly and she said she did it, but it
didn't change, it just recentered itself."

The data confirmed it. Revisions 1 and 2 of that session held the SAME five
nodes and the SAME five edges — only the array order differed. The diagrammer
had no way to express "linear", because the prompt had no vocabulary for
arrangement at all: `linear`, `left-to-right`, `flow` and `chain` appear
nowhere in it. So a request about SHAPE regenerated identical CONTENT, the
renderer re-ran force layout, and the user watched it recenter.

This is also why everything is a map. A loop, a pipeline and a hierarchy are
all `kind: map`; there is no other kind to switch to. The missing axis is not
kind, it is arrangement.

Layout is deliberately SEMANTIC, not positional. "This is a sequence" is an
idea about the diagram; "this node is at x=412" is the renderer's business and
stays banned.
"""

import pytest

from hermes_state_artifacts import ArtifactValidationError, validate_semantic_payload


def graph(**extra):
    return {
        "nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
        "edges": [{"id": "a-b", "from": "a", "to": "b"}],
        **extra,
    }


def test_a_map_may_declare_how_it_should_be_arranged():
    """Without this the model cannot answer "show me this linearly" at all."""
    validate_semantic_payload(graph(layout="linear"), "map")


@pytest.mark.parametrize("layout", ["linear", "layered", "radial", "cluster"])
def test_every_supported_arrangement_validates(layout):
    validate_semantic_payload(graph(layout=layout), "map")


def test_layout_is_optional():
    """Existing artifacts predate the field and must keep working."""
    validate_semantic_payload(graph(), "map")


def test_an_unknown_arrangement_is_rejected():
    """A typo must fail loudly rather than silently rendering as a blob."""
    with pytest.raises(ArtifactValidationError, match="layout"):
        validate_semantic_payload(graph(layout="spiral"), "map")


def test_layout_must_be_a_string():
    with pytest.raises(ArtifactValidationError, match="layout"):
        validate_semantic_payload(graph(layout=["linear"]), "map")


def test_coordinates_are_still_banned():
    """Layout is a semantic hint, NOT a licence to position nodes.

    The renderer owns pixels. Letting the model place things would put layout
    quality in the hands of a model that cannot see the canvas.
    """
    with pytest.raises(ArtifactValidationError):
        validate_semantic_payload(
            {
                "nodes": [{"id": "a", "label": "A", "x": 10, "y": 20}],
                "edges": [],
                "layout": "linear",
            },
            "map",
        )
