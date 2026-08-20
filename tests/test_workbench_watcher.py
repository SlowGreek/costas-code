"""Behaviour contracts for the background workbench transcript watcher.

Every test drives the watcher with an injected model function and an explicit
clock, so debounce/coalesce/in-flight/shadow are exercised without a live model
and without sleeping.
"""

import json

import pytest

from workbench_watcher import (
    SkipReason,
    TranscriptWatcher,
    WatcherConfig,
    parse_watch_reply,
    summarize_canvas,
    watcher_config_from,
)
from workbench_visualizer import persist_visual_result


def _reply(draw, reason="because", direction="add a node"):
    return json.dumps({"draw": draw, "reason": reason, "direction": direction})


class _Model:
    """Records every call so tests can assert on COUNT, not just outcome."""

    def __init__(self, *replies):
        self.replies = list(replies) or [_reply(True)]
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if len(self.replies) > 1:
            return self.replies.pop(0)
        return self.replies[0]


def _watcher(model, *, enabled=True, mode="active", debounce=2.0, pipeline="two_stage"):
    return TranscriptWatcher(
        config=WatcherConfig(
            enabled=enabled,
            mode=mode,
            debounce_seconds=debounce,
            pipeline=pipeline,
        ),
        run_oneshot_fn=model,
    )


# ── debounce ────────────────────────────────────────────────────────────────


def test_does_not_decide_before_the_utterance_settles():
    model = _Model(_reply(True))
    w = _watcher(model, debounce=2.0)

    w.observe("so what if we", now=0.0)
    assert w.poll(now=1.9) is None
    assert w.last_skip == SkipReason.NOT_DUE
    assert model.calls == []


def test_each_new_fragment_pushes_the_deadline_out():
    model = _Model(_reply(True))
    w = _watcher(model, debounce=2.0)

    w.observe("so what if we", now=0.0)
    w.observe("added a memory layer", now=1.5)
    # 2.5s after the FIRST fragment is past the naive deadline but only 1.0s
    # after the last one: still mid-sentence.
    assert w.poll(now=2.5) is None
    assert w.last_skip == SkipReason.NOT_DUE
    assert w.poll(now=3.5) is not None


def test_a_burst_of_fragments_produces_exactly_one_decision():
    model = _Model(_reply(True))
    w = _watcher(model, debounce=2.0)

    for i, fragment in enumerate(["so", "what if we", "added memory"]):
        w.observe(fragment, now=float(i) * 0.4)

    decision = w.poll(now=10.0)
    assert decision is not None
    assert len(model.calls) == 1, "a burst must cost one model call, not one per fragment"
    assert w.poll(now=11.0) is None
    assert w.last_skip == SkipReason.NOTHING_PENDING


def test_the_coalesced_utterance_contains_every_fragment():
    model = _Model(_reply(True))
    w = _watcher(model, debounce=2.0)
    for i, fragment in enumerate(["so what if", "we added", "a memory layer"]):
        w.observe(fragment, now=float(i) * 0.3)

    decision = w.poll(now=10.0)
    for fragment in ("so what if", "we added", "a memory layer"):
        assert fragment in decision.utterance


def test_assistant_speech_does_not_rearm_the_debounce():
    """She talks for many seconds; letting that reset the timer starves the canvas."""
    model = _Model(_reply(True))
    w = _watcher(model, debounce=2.0)

    w.observe("add a memory layer", now=0.0, role="user")
    w.observe("Sure — memory sits between the voice and the store.", now=1.0, role="assistant")

    assert w.poll(now=2.5) is not None


# ── in-flight guard ─────────────────────────────────────────────────────────


def test_refuses_to_decide_while_a_redraw_is_in_flight():
    model = _Model(_reply(True))
    w = _watcher(model, debounce=2.0)
    w.set_in_flight(True)
    w.observe("and connect it to the planner", now=0.0)

    assert w.poll(now=5.0) is None
    assert w.last_skip == SkipReason.IN_FLIGHT
    assert model.calls == [], "the guard must run BEFORE the model call, not after"


def test_speech_heard_during_a_redraw_is_reconsidered_afterwards():
    model = _Model(_reply(True))
    w = _watcher(model, debounce=2.0)
    w.set_in_flight(True)
    w.observe("and connect it to the planner", now=0.0)
    assert w.poll(now=5.0) is None

    w.set_in_flight(False)
    decision = w.poll(now=6.0)
    assert decision is not None
    assert "planner" in decision.utterance


def test_the_guard_is_re_checked_on_every_poll_not_once():
    model = _Model(_reply(True))
    w = _watcher(model, debounce=2.0)
    w.observe("first idea", now=0.0)
    assert w.poll(now=5.0) is not None

    w.set_in_flight(True)
    w.observe("second idea", now=6.0)
    assert w.poll(now=10.0) is None
    assert len(model.calls) == 1


# ── shadow vs active ────────────────────────────────────────────────────────


def test_shadow_mode_decides_but_must_not_draw():
    model = _Model(_reply(True))
    w = _watcher(model, mode="shadow", debounce=1.0)
    w.observe("add a memory layer", now=0.0)

    decision = w.poll(now=5.0)
    assert decision.draw is True, "shadow must still record what it WOULD have done"
    assert decision.suppressed is True
    assert decision.should_draw is False
    assert len(model.calls) == 1


def test_active_mode_lets_the_decision_through():
    w = _watcher(_Model(_reply(True)), mode="active", debounce=1.0)
    w.observe("add a memory layer", now=0.0)

    decision = w.poll(now=5.0)
    assert decision.should_draw is True
    assert decision.suppressed is False


def test_a_no_decision_never_draws_in_either_mode():
    for mode in ("shadow", "active"):
        w = _watcher(_Model(_reply(False)), mode=mode, debounce=1.0)
        w.observe("mm, right, yeah", now=0.0)
        decision = w.poll(now=5.0)
        assert decision.draw is False
        assert decision.should_draw is False


def test_a_shadow_decision_carries_what_is_needed_to_evaluate_it():
    """Shadow mode's whole product is the record: input, verdict, reason."""
    w = _watcher(_Model(_reply(True, reason="new concept", direction="add Memory")), mode="shadow")
    w.observe("what if we added memory", now=0.0)
    decision = w.poll(now=5.0)

    assert "memory" in decision.utterance.lower()
    assert decision.reason == "new concept"
    assert decision.direction == "add Memory"


# ── disabled ────────────────────────────────────────────────────────────────


def test_a_disabled_watcher_never_calls_the_model():
    model = _Model(_reply(True))
    w = _watcher(model, enabled=False)
    w.observe("add a memory layer", now=0.0)

    assert w.poll(now=100.0) is None
    assert w.last_skip == SkipReason.DISABLED
    assert model.calls == []


# ── model call shape ────────────────────────────────────────────────────────


def test_direct_call_holds_the_in_flight_guard_while_the_model_emits_the_visual():
    seen = []
    holder = {}

    def model(**_kwargs):
        seen.append(holder["watcher"].in_flight)
        return '{"draw": false, "reason": "no change"}'

    w = _watcher(model, debounce=1.0, pipeline="direct")
    holder["watcher"] = w
    w.observe("consider this", now=0.0)
    w.poll(now=2.0)

    assert seen == [True]
    assert w.in_flight is False


def test_direct_model_call_has_room_to_emit_the_visual_and_is_the_only_call():
    model = _Model('{"draw": false, "reason": "nothing new"}')
    w = _watcher(model, debounce=1.0, pipeline="direct")
    w.observe("hello", now=0.0)
    w.poll(now=5.0)

    call = model.calls[0]
    assert call["task"] == "ideation_workbench_watcher"
    assert call["main_runtime"] is None
    assert call["max_tokens"] >= 4_000
    assert len(model.calls) == 1


def test_two_stage_keeps_the_small_decision_only_call():
    model = _Model(_reply(False))
    w = _watcher(model, debounce=1.0, pipeline="two_stage")
    w.observe("hello", now=0.0)
    w.poll(now=5.0)

    assert model.calls[0]["max_tokens"] <= 200


def test_the_watcher_task_routes_through_the_fast_model_path():
    from agent.auxiliary_client import _FAST_MODEL_TASKS

    assert "ideation_workbench_watcher" in _FAST_MODEL_TASKS


def test_a_failing_model_call_degrades_to_no_decision():
    def explode(**kwargs):
        raise RuntimeError("aux provider down")

    w = TranscriptWatcher(
        config=WatcherConfig(enabled=True, mode="active", debounce_seconds=1.0),
        run_oneshot_fn=explode,
    )
    w.observe("add memory", now=0.0)
    assert w.poll(now=5.0) is None


# ── reply parsing ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    ["", "not json", "{", "[]", '{"reason": "no draw key"}', '{"draw": 7}'],
)
def test_an_unusable_reply_is_not_a_draw(text):
    assert parse_watch_reply(text) is None


def test_a_fenced_reply_still_parses():
    fenced = '```json\n{"draw": true, "reason": "r", "direction": "d"}\n```'
    assert parse_watch_reply(fenced) == (True, "r", "d")


def test_a_no_reply_carries_no_direction():
    draw, _, direction = parse_watch_reply('{"draw": false, "direction": "add a node"}')
    assert draw is False
    assert direction == ""


# ── config ──────────────────────────────────────────────────────────────────


def test_the_watcher_is_off_and_shadowed_by_default():
    from hermes_cli.config_defaults import DEFAULT_CONFIG

    cfg = watcher_config_from(DEFAULT_CONFIG)
    assert cfg.enabled is False
    assert cfg.mode == "shadow"
    assert cfg.active is False


@pytest.mark.parametrize(
    "raw",
    [
        {},
        {"workbench": None},
        {"workbench": {"watcher": "yes"}},
        {"workbench": {"watcher": {"enabled": "sure"}}},
    ],
)
def test_malformed_config_fails_safe_to_off(raw):
    assert watcher_config_from(raw).enabled is False


def test_an_unknown_mode_falls_back_to_shadow():
    cfg = watcher_config_from({"workbench": {"watcher": {"enabled": True, "mode": "yolo"}}})
    assert cfg.enabled is True
    assert cfg.mode == "shadow"
    assert cfg.active is False


@pytest.mark.parametrize("bad", ["", 0, -1, "abc", None])
def test_a_nonsense_debounce_never_becomes_zero(bad):
    cfg = watcher_config_from({"workbench": {"watcher": {"debounce_seconds": bad}}})
    assert cfg.debounce_seconds > 0


def test_active_requires_both_enabled_and_active_mode():
    assert watcher_config_from(
        {"workbench": {"watcher": {"enabled": False, "mode": "active"}}}
    ).active is False
    assert watcher_config_from(
        {"workbench": {"watcher": {"enabled": True, "mode": "active"}}}
    ).active is True


# ── canvas summary ──────────────────────────────────────────────────────────


def test_the_canvas_summary_names_what_is_drawn():
    summary = summarize_canvas(
        {"kind": "map", "payload": {"nodes": [{"label": "Voice"}, {"label": "Memory"}]}}
    )
    assert "Voice" in summary and "Memory" in summary


@pytest.mark.parametrize("artifact", [None, {}, {"payload": None}, {"payload": {}}])
def test_an_empty_canvas_summarizes_to_nothing(artifact):
    assert summarize_canvas(artifact) == ""


# ── direct one-call artifact path ───────────────────────────────────────────


def _direct_reply(visual, *, reason="useful change"):
    return json.dumps({"draw": True, "reason": reason, "visual": visual})


def test_direct_is_the_default_pipeline_and_two_stage_remains_selectable():
    assert watcher_config_from({}).pipeline == "direct"
    cfg = watcher_config_from(
        {"workbench": {"watcher": {"enabled": True, "mode": "active", "pipeline": "two_stage"}}}
    )
    assert cfg.pipeline == "two_stage"
    assert watcher_config_from(
        {"workbench": {"watcher": {"pipeline": "invented"}}}
    ).pipeline == "direct"


def test_direct_first_draw_emits_a_validated_full_payload():
    model = _Model(
        _direct_reply({"kind": "map", "nodes": [{"id": "a", "label": "A"}], "edges": []})
    )
    w = _watcher(model, debounce=1.0, pipeline="direct")
    w.set_canvas(artifact=None)
    w.observe("draw A", now=0.0)

    decision = w.poll(now=2.0)

    assert decision.visual.kind == "map"
    assert decision.visual.payload["nodes"][0]["id"] == "a"
    request = json.loads(model.calls[0]["user_input"])
    assert request["utterance"] == "draw A"
    assert request["current_payload"] == {"nodes": [], "edges": []}


def test_direct_ops_update_applies_to_the_current_graph():
    model = _Model(_direct_reply({"ops": [{"op": "add_node", "id": "b", "label": "B"}]}))
    w = _watcher(model, debounce=1.0, pipeline="direct")
    w.set_canvas(
        artifact={
            "artifact_id": "map.main",
            "kind": "map",
            "semantic_rev": 3,
            "payload": {"nodes": [{"id": "a", "label": "A"}], "edges": []},
        }
    )
    w.observe("add B", now=0.0)

    decision = w.poll(now=2.0)

    assert [node["id"] for node in decision.visual.payload["nodes"]] == ["a", "b"]
    assert decision.expected_rev == 3


def test_direct_expected_revision_is_the_snapshot_used_for_generation():
    """A mid-generation edit must make the worker stale, not bless its output.

    The watcher state is mutable from transcript callbacks. Reading current_rev
    after the model returns lets a canvas refresh move it from rev 3 to rev 4,
    then applies a visual generated from rev 3 with expected_rev=4 — silently
    overwriting the edit the revision guard was meant to protect.
    """
    watcher = _watcher(_Model(""), debounce=1.0, pipeline="direct")
    watcher.set_canvas(
        artifact={
            "artifact_id": "map.main",
            "kind": "map",
            "semantic_rev": 3,
            "payload": {"nodes": [{"id": "a", "label": "A"}], "edges": []},
        }
    )

    def model(**_kwargs):
        # Simulate a surgical edit/current-canvas refresh while MAI is running.
        watcher.set_canvas(
            artifact={
                "artifact_id": "map.main",
                "kind": "map",
                "semantic_rev": 4,
                "payload": {"nodes": [{"id": "a", "label": "Renamed"}], "edges": []},
            }
        )
        return _direct_reply({"ops": [{"op": "add_node", "id": "b", "label": "B"}]})

    watcher.run_oneshot_fn = model
    watcher.observe("add B", now=0.0)
    decision = watcher.poll(now=2.0)

    assert decision.expected_rev == 3


def test_direct_sketch_uses_the_existing_sketch_validator():
    model = _Model(_direct_reply({"kind": "sketch", "html": "<canvas></canvas>"}))
    w = _watcher(model, debounce=1.0, pipeline="direct")
    w.observe("show it", now=0.0)
    assert w.poll(now=2.0).visual.kind == "sketch"


@pytest.mark.parametrize(
    "reply",
    [
        '{"draw": true, "reason": "missing visual"}',
        _direct_reply({"ops": [{"op": "add_node", "id": "a", "label": "A"}]}),
        _direct_reply({"kind": "map", "nodes": [{"id": "a"}], "edges": []}),
    ],
)
def test_malformed_direct_output_never_produces_a_draw_decision(reply):
    w = _watcher(_Model(reply), debounce=1.0, pipeline="direct")
    w.observe("draw", now=0.0)
    assert w.poll(now=2.0) is None


def test_direct_shadow_validates_but_never_exposes_a_writeable_decision():
    model = _Model(
        _direct_reply({"kind": "map", "nodes": [{"id": "a", "label": "A"}], "edges": []})
    )
    w = _watcher(model, mode="shadow", debounce=1.0, pipeline="direct")
    w.observe("draw", now=0.0)
    decision = w.poll(now=2.0)
    assert decision.visual is not None
    assert decision.should_draw is False


def test_direct_one_call_integration_persists_the_artifact(tmp_path):
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "state.db")
    model = _Model(
        _direct_reply({"kind": "map", "nodes": [{"id": "a", "label": "A"}], "edges": []})
    )
    try:
        db.create_session("voice-session", "desktop", model="test")
        w = _watcher(model, debounce=1.0, pipeline="direct")
        w.set_canvas(artifact=db.get_session_artifact("voice-session", "map.main"))
        w.observe("draw A", now=0.0)
        decision = w.poll(now=2.0)

        artifact = persist_visual_result(
            db, "voice-session", decision.visual, expected_rev=decision.expected_rev
        )

        assert len(model.calls) == 1
        assert artifact["payload"]["nodes"][0]["label"] == "A"
    finally:
        db.close()


def test_direct_stale_revision_cannot_overwrite_the_canvas(tmp_path):
    from hermes_state import SessionDB
    from hermes_state_artifacts import ArtifactRevisionConflict
    from workbench_visualizer import apply_visual_payload

    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        initial = apply_visual_payload(
            {"kind": "map", "nodes": [{"id": "a", "label": "A"}], "edges": []}
        )
        artifact = persist_visual_result(db, "voice-session", initial, expected_rev=None)
        stale = apply_visual_payload(
            {"ops": [{"op": "add_node", "id": "b", "label": "B"}]}, artifact["payload"]
        )
        newer = apply_visual_payload(
            {"ops": [{"op": "add_node", "id": "c", "label": "C"}]}, artifact["payload"]
        )
        persist_visual_result(db, "voice-session", newer, expected_rev=artifact["semantic_rev"])

        with pytest.raises(ArtifactRevisionConflict):
            persist_visual_result(db, "voice-session", stale, expected_rev=artifact["semantic_rev"])

        current = db.get_session_artifact("voice-session", "map.main")
        assert [node["id"] for node in current["payload"]["nodes"]] == ["a", "c"]
    finally:
        db.close()
