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


def _watcher(model, *, enabled=True, mode="active", debounce=2.0):
    return TranscriptWatcher(
        config=WatcherConfig(enabled=enabled, mode=mode, debounce_seconds=debounce),
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


def test_the_model_call_is_cheap_and_off_the_conversation_model():
    model = _Model(_reply(False))
    w = _watcher(model, debounce=1.0)
    w.observe("hello", now=0.0)
    w.poll(now=5.0)

    call = model.calls[0]
    assert call["task"] == "ideation_workbench_watcher"
    assert call["main_runtime"] is None
    assert call["max_tokens"] <= 200


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
