import json
import re

import pytest

from hermes_state import SessionDB
from hermes_state_artifacts import MAX_GRAPH_EDGES, MAX_GRAPH_NODES
from workbench_sketch import MAX_SKETCH_HTML_BYTES, SKETCH_MODEL_GUIDANCE
from workbench_visualizer import (
    MAX_VISUALIZER_OUTPUT_TOKENS,
    _VISUALIZER_INSTRUCTIONS,
    visualize_session,
)


def test_the_fast_path_is_visible_in_stored_data(tmp_path):
    """`updated_by` must distinguish a diff from a full regenerate.

    Without this, "it still feels slow" is unfalsifiable: a redraw that
    silently stayed on the slow path looks identical in the database to one
    that used the fast path.
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript("voice-session", item_id="u1", role="user", text="x")

        full = json.dumps(
            {"kind": "map", "nodes": [{"id": "a", "label": "A"}], "edges": []}
        )
        first = visualize_session(db, "voice-session", run_oneshot_fn=lambda **_: full)
        assert first["updated_by"] == "ambient"

        # A full payload on a later turn is still the slow path.
        again = json.dumps(
            {"kind": "map", "nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}], "edges": []}
        )
        slow = visualize_session(db, "voice-session", run_oneshot_fn=lambda **_: again)
        assert slow["updated_by"] == "ambient"

        # An ops diff is the fast path and must be labelled as such.
        diff = json.dumps({"ops": [{"op": "add_node", "id": "c", "label": "C"}]})
        fast = visualize_session(db, "voice-session", run_oneshot_fn=lambda **_: diff)
        assert fast["updated_by"] == "ambient-diff"
    finally:
        db.close()


def test_an_ops_diff_patches_the_current_drawing(tmp_path):
    """The incremental path: a few ops instead of a whole regenerated graph.

    On the user's real 12-node artifact this is ~36 tokens of output instead of
    ~531 — and model latency scales with tokens emitted, which is where the
    measured ~9s redraw came from.
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript(
            "voice-session", item_id="u1", role="user", text="Add a memory layer."
        )

        full = json.dumps(
            {
                "kind": "map",
                "nodes": [{"id": "voice", "label": "Voice"}, {"id": "canvas", "label": "Canvas"}],
                "edges": [{"id": "e1", "from": "voice", "to": "canvas"}],
            }
        )
        visualize_session(db, "voice-session", run_oneshot_fn=lambda **_: full)

        diff = json.dumps(
            {
                "ops": [
                    {"op": "add_node", "id": "memory", "label": "Memory", "kind": "store"},
                    {"op": "connect", "from_id": "canvas", "to_id": "memory"},
                ]
            }
        )
        artifact = visualize_session(db, "voice-session", run_oneshot_fn=lambda **_: diff)

        assert [n["id"] for n in artifact["payload"]["nodes"]] == ["voice", "canvas", "memory"]
        # Existing ids survive — deixis depends on it.
        assert artifact["payload"]["nodes"][0]["label"] == "Voice"
        assert any(e["to"] == "memory" for e in artifact["payload"]["edges"])
    finally:
        db.close()


def test_a_rejected_diff_leaves_the_canvas_untouched(tmp_path):
    """A diff against a stale base must not half-apply.

    Silently corrupting a drawing is worse than failing to update it: the user
    cannot tell the difference between a diagram that is wrong and one that is
    merely stale.
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript("voice-session", item_id="u1", role="user", text="x")
        visualize_session(
            db,
            "voice-session",
            run_oneshot_fn=lambda **_: json.dumps(
                {"kind": "map", "nodes": [{"id": "a", "label": "A"}], "edges": []}
            ),
        )
        before = db.get_session_artifact("voice-session", "map.main")

        with pytest.raises(Exception, match="unknown node"):
            visualize_session(
                db,
                "voice-session",
                run_oneshot_fn=lambda **_: json.dumps(
                    {"ops": [{"op": "rename", "node_id": "ghost", "label": "Nope"}]}
                ),
            )

        after = db.get_session_artifact("voice-session", "map.main")
        assert after["payload"] == before["payload"]
        assert after["semantic_rev"] == before["semantic_rev"]
    finally:
        db.close()


def test_ops_on_a_first_draw_are_rejected(tmp_path):
    """There is nothing to diff against before the first drawing exists."""
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript("voice-session", item_id="u1", role="user", text="x")

        with pytest.raises(ValueError, match="no graph to apply"):
            visualize_session(
                db,
                "voice-session",
                run_oneshot_fn=lambda **_: json.dumps(
                    {"ops": [{"op": "add_node", "id": "a", "label": "A"}]}
                ),
            )
    finally:
        db.close()


def test_every_turn_gets_room_to_emit_a_real_sketch(tmp_path):
    """One ceiling for every turn, including a first draw with NO direction.

    The old budget keyed off `direction` and only went large when the text
    looked visual ("render", "draw", "3d"). The voice agent now draws the FIRST
    diagram proactively, with an empty direction — so the starved case was
    exactly the happy path. A truncated sketch is not an error either: the
    byte-cap validator accepts HTML cut mid-tag, so it fails silently.
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        budgets = []

        def spy(**kwargs):
            budgets.append(kwargs["max_tokens"])

            return json.dumps({"kind": "map", "nodes": [{"id": "a", "label": "A"}], "edges": []})

        # The proactive first draw: no prompt at all.
        visualize_session(db, "voice-session", run_oneshot_fn=spy)
        assert budgets[-1] == MAX_VISUALIZER_OUTPUT_TOKENS

        # An explicit visual request.
        visualize_session(db, "voice-session", prompt="render a rotating cube", run_oneshot_fn=spy)
        assert budgets[-1] == MAX_VISUALIZER_OUTPUT_TOKENS

        # Revising an existing sketch.
        def to_sketch(**_kwargs):
            return json.dumps({"kind": "sketch", "html": "<canvas id='c'></canvas>"})

        visualize_session(db, "voice-session", prompt="draw it", run_oneshot_fn=to_sketch)
        visualize_session(db, "voice-session", run_oneshot_fn=spy)
        assert budgets[-1] == MAX_VISUALIZER_OUTPUT_TOKENS

        # Enough headroom for a real canvas/WebGL document, not just JSON.
        assert MAX_VISUALIZER_OUTPUT_TOKENS >= 4_000
    finally:
        db.close()


def test_the_sketch_runtime_guidance_actually_reaches_the_model(tmp_path):
    """The canonical guidance must be spliced into the real instructions.

    It was previously orphaned: `test_workbench_sketch_guidance.py` asserted
    hard on its content while NOTHING imported it, so every one of those tests
    passed against text the diagrammer never saw — the same bug class as the
    `sketch` kind the model was never told existed.
    """
    assert SKETCH_MODEL_GUIDANCE in _VISUALIZER_INSTRUCTIONS
    # And it must survive f-string interpolation intact.
    assert "Sketch.scene3d" in _VISUALIZER_INSTRUCTIONS
    assert not re.search(r"\{[A-Z_]+\}", _VISUALIZER_INSTRUCTIONS)


def test_the_prompt_names_its_own_inputs_and_vocabulary():
    """Contract guards, not prose snapshots.

    Each assertion below is a defect found by reading the assembled prompt:
    `direction` was never named at all, and node `kind` was documented as
    "optional" with no vocabulary, so the model invented kinds the renderer
    cannot colour.
    """
    text = _VISUALIZER_INSTRUCTIONS

    for key in ("direction", "current_kind", "current_graph", "transcript"):
        assert f"`{key}`" in text, f"prompt never names its {key} input"

    # The renderer's KIND_ACCENTS vocabulary must be spelled out.
    for kind in ("actor", "agent", "concept", "decision", "risk", "system", "task"):
        assert kind in text, f"node kind {kind} missing from prompt"

    # Every JSON example must be valid JSON after interpolation. Five now: the
    # four artifact kinds plus the incremental `ops` diff.
    examples = re.findall(r"^\{.*\}$", text, re.M)
    assert len(examples) == 5
    for example in examples:
        json.loads(example)

    # The incremental path must be advertised, or the model never uses it and
    # every redraw stays a full regenerate.
    assert '"ops"' in text
    assert "add_node" in text

    # Language that previously suppressed drawing must stay gone.
    assert "LAST RESORT" not in text
    assert "return it unchanged" not in text


def test_visualize_session_routes_a_sketch_through_sandboxed_validation(tmp_path):
    """The diagrammer can reach for `sketch` when no typed kind fits.

    Without this the sketch renderer is unreachable dead code: the model is
    never told the kind exists, so it can never emit one.
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript(
            "voice-session", item_id="u1", role="user", text="Show me a spinning cube."
        )

        html = "<canvas id='c'></canvas><script>/* three.js */</script>"

        def run_oneshot(**_kwargs):
            return json.dumps({"kind": "sketch", "html": html})

        artifact = visualize_session(db, "voice-session", run_oneshot_fn=run_oneshot)

        assert artifact["kind"] == "sketch"
        assert artifact["payload"] == {"html": html}
    finally:
        db.close()


def test_visualize_session_rejects_an_oversized_sketch(tmp_path):
    """A sketch is atomic: truncating HTML yields a broken document, so an
    over-cap sketch must fail rather than silently render garbage."""
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")

        def run_oneshot(**_kwargs):
            return json.dumps({"kind": "sketch", "html": "x" * (MAX_SKETCH_HTML_BYTES + 1)})

        with pytest.raises(Exception, match="exceeds"):
            visualize_session(db, "voice-session", run_oneshot_fn=run_oneshot)
    finally:
        db.close()


def test_visualize_session_trims_an_oversized_graph_instead_of_failing(tmp_path):
    """A too-large diagram degrades to the most connected core, never errors.

    The model routinely wants more nodes than the canvas should show. Hard
    failure surfaces to the user mid-conversation as "couldn't update the
    workbench", which reads as a broken feature rather than a bounded canvas.
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript(
            "voice-session", item_id="user-1", role="user", text="Map the whole system."
        )

        # Comfortably over the cap; every node has at least one edge.
        oversized = MAX_GRAPH_NODES + 18
        nodes = [{"id": f"n{i}", "label": f"Node {i}"} for i in range(oversized)]
        edges = [
            {"id": f"e{i}", "from": f"n{i}", "to": f"n{i + 1}"}
            for i in range(oversized - 1)
        ]

        def run_oneshot(**_kwargs):
            return json.dumps({"nodes": nodes, "edges": edges})

        artifact = visualize_session(db, "voice-session", run_oneshot_fn=run_oneshot)

        payload = artifact["payload"]
        assert len(payload["nodes"]) == MAX_GRAPH_NODES
        assert len(payload["edges"]) <= MAX_GRAPH_EDGES
        kept = {node["id"] for node in payload["nodes"]}
        # Trimming must not leave edges pointing at dropped nodes.
        for edge in payload["edges"]:
            assert edge["from"] in kept and edge["to"] in kept
    finally:
        db.close()


def test_visualize_session_delegates_full_transcript_and_updates_artifact(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    captured = {}
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript(
            "voice-session", item_id="user-1", role="user", text="Voice should read shared state."
        )
        db.append_realtime_transcript(
            "voice-session", item_id="assistant-1", role="assistant", text="And the canvas renders it."
        )

        def run_oneshot(**kwargs):
            captured.update(kwargs)
            return json.dumps(
                {
                    "nodes": [
                        {"id": "voice", "label": "Voice", "kind": "agent"},
                        {"id": "state", "label": "Shared state", "kind": "state"},
                        {"id": "canvas", "label": "Canvas", "kind": "surface"},
                    ],
                    "edges": [
                        {"id": "voice-state", "from": "voice", "to": "state", "label": "reads"},
                        {"id": "state-canvas", "from": "state", "to": "canvas", "label": "renders"},
                    ],
                }
            )

        artifact = visualize_session(
            db,
            "voice-session",
            prompt="Emphasize that voice and canvas are consumers.",
            run_oneshot_fn=run_oneshot,
        )

        assert artifact["semantic_rev"] == 1
        assert captured["task"] == "ideation_workbench"
        assert captured["main_runtime"] is None
        request = json.loads(captured["user_input"])
        assert request["direction"] == "Emphasize that voice and canvas are consumers."
        assert [item["text"] for item in request["transcript"]] == [
            "Voice should read shared state.",
            "And the canvas renders it.",
        ]
        assert db.get_session_artifact("voice-session", "map.main") == artifact
    finally:
        db.close()
