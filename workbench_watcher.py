"""Background transcript watcher for the ideation workbench.

Why this exists: today the realtime VOICE model decides when to draw, by
calling a ``visualize`` tool. A function call terminates a Realtime response,
so every drawing decision forces the voice to stop mid-thought, call the tool,
and open a new spoken turn — the user hears a stop-start seam. Moving the
decision to a cheap out-of-band model removes the seam at its source: the voice
model is never asked, so it never has to interrupt itself.

Everything here is deliberately pure and synchronous. The watcher owns no
threads, no timers and no I/O: callers feed it transcript fragments and a
monotonic clock, and it answers "draw now / not yet / no". That is what makes
the debounce, the coalescing and the in-flight guard testable without a live
model and without sleeping in tests.
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# The watcher must be able to say "nothing to draw" in a handful of tokens; it
# runs once per settled utterance and its cost is paid on every turn.
MAX_WATCHER_OUTPUT_TOKENS = 120
MAX_DIRECT_OUTPUT_TOKENS = 6_000

# Routed through the auxiliary fast-model path (see `_FAST_MODEL_TASKS`).
WATCHER_TASK = "ideation_workbench_watcher"

DEFAULT_DEBOUNCE_SECONDS = 2.5
DEFAULT_MODE = "shadow"
SUPPORTED_MODES = ("shadow", "active")
DEFAULT_PIPELINE = "direct"
SUPPORTED_PIPELINES = ("direct", "two_stage")

_MAX_UTTERANCE_CHARS = 4_000
_MAX_REASON_CHARS = 240

WATCHER_INSTRUCTIONS = """You watch a live voice ideation conversation and decide ONE thing: should the shared canvas change right now?

You are not the artist and you never speak. Another model does the drawing; you only decide whether to wake it.

You are given JSON with:
`utterance` — what the user just said (possibly several fragments joined).
`recent` — a little earlier context, oldest first.
`current_kind` and `current_summary` — what is already on the canvas.

Say yes ONLY when the canvas would visibly and usefully differ afterwards: a new idea, a new relationship, a correction, an explicit request to draw or change the picture, or a shift in what the conversation is about.
Say no for pleasantries, acknowledgements, thinking aloud, questions about what is already drawn, meta-talk about the tool, and anything already represented on the canvas.
Drawing costs the user about nine seconds of stale canvas, so when it is a close call, say no.

Return ONLY this JSON object and nothing else:
{"draw": true, "reason": "one short clause", "direction": "what should change"}
`direction` is an instruction to the artist. Leave it "" when `draw` is false.
"""

DIRECT_WATCHER_INSTRUCTIONS = """You are the single mute canvas worker for a live voice ideation conversation.
In this ONE response, decide whether the canvas should change and, when it should, emit the visual update yourself. There is no second diagrammer call.

Input JSON contains `utterance`, `recent`, `current_kind`, `current_payload`, and `current_summary`.
Return ONLY one JSON envelope:
{"draw":false,"reason":"one short clause"}
or
{"draw":true,"reason":"one short clause","visual":<visualizer JSON object>}

The nested `visual` object uses the existing visualizer contract below. On the first draw it MUST be a full payload. `ops` are allowed only when the current payload is an existing non-empty map.

"""


@dataclass(frozen=True)
class WatcherConfig:
    """Resolved `workbench.watcher` settings. See DEFAULT_CONFIG."""

    enabled: bool = False
    mode: str = DEFAULT_MODE
    debounce_seconds: float = DEFAULT_DEBOUNCE_SECONDS
    pipeline: str = DEFAULT_PIPELINE

    @property
    def active(self) -> bool:
        return self.enabled and self.mode == "active"


def watcher_config_from(cfg: Any) -> WatcherConfig:
    """Read `workbench.watcher` out of a loaded config, failing safe.

    Every malformed value degrades to the safe end (off, shadow, longer
    debounce) rather than raising: a typo in config.yaml must not be able to
    start an unattended redraw loop.
    """
    root = cfg if isinstance(cfg, dict) else {}
    workbench = root.get("workbench")
    workbench = workbench if isinstance(workbench, dict) else {}
    watcher = workbench.get("watcher")
    watcher = watcher if isinstance(watcher, dict) else {}

    mode = str(watcher.get("mode") or DEFAULT_MODE).strip().lower()
    if mode not in SUPPORTED_MODES:
        mode = DEFAULT_MODE

    pipeline = str(watcher.get("pipeline") or DEFAULT_PIPELINE).strip().lower()
    if pipeline not in SUPPORTED_PIPELINES:
        pipeline = DEFAULT_PIPELINE

    try:
        debounce = float(watcher.get("debounce_seconds", DEFAULT_DEBOUNCE_SECONDS))
    except (TypeError, ValueError):
        debounce = DEFAULT_DEBOUNCE_SECONDS
    if debounce <= 0:
        debounce = DEFAULT_DEBOUNCE_SECONDS

    return WatcherConfig(
        enabled=watcher.get("enabled") is True,
        mode=mode,
        debounce_seconds=debounce,
        pipeline=pipeline,
    )


@dataclass(frozen=True)
class WatchDecision:
    """One settled judgement about the canvas."""

    draw: bool
    reason: str = ""
    direction: str = ""
    utterance: str = ""
    # True when the watcher decided to draw but config left it in shadow mode,
    # so the caller must NOT redraw. Kept distinct from `draw` so shadow logs
    # record what the watcher actually thought.
    suppressed: bool = False
    visual: Any = None
    expected_rev: Optional[int] = None

    @property
    def should_draw(self) -> bool:
        return self.draw and not self.suppressed


class SkipReason:
    """Why a poll produced no decision. Values are log/metric labels."""

    NOT_DUE = "not_due"
    NOTHING_PENDING = "nothing_pending"
    IN_FLIGHT = "in_flight"
    MODEL_FAILED = "model_failed"
    DISABLED = "disabled"


@dataclass
class TranscriptWatcher:
    """Debounces transcript fragments into at most one decision per burst.

    The caller drives it: :meth:`observe` on every transcript fragment,
    :meth:`poll` on a timer or on the next event. No background thread, so
    tests control time exactly.
    """

    config: WatcherConfig = field(default_factory=WatcherConfig)
    run_oneshot_fn: Optional[Callable[..., str]] = None
    _pending: List[str] = field(default_factory=list, init=False)
    _recent: List[str] = field(default_factory=list, init=False)
    _last_fragment_at: Optional[float] = field(default=None, init=False)
    _in_flight: bool = field(default=False, init=False)
    _direct_retry_count: int = field(default=0, init=False)
    current_kind: str = field(default="map", init=False)
    current_summary: str = field(default="", init=False)
    current_payload: Dict[str, Any] = field(
        default_factory=lambda: {"nodes": [], "edges": []}, init=False
    )
    current_rev: Optional[int] = field(default=None, init=False)
    # Why the most recent poll produced nothing. Log/metric label, not control
    # flow: callers that only care about decisions can ignore it entirely.
    last_skip: Optional[str] = field(default=None, init=False)

    # -- inputs ---------------------------------------------------------

    def observe(self, text: str, *, now: float, role: str = "user") -> None:
        """Buffer one transcript fragment.

        Only user speech resets the debounce. The assistant's own words are
        kept as context but must not re-arm the timer: she talks for many
        seconds at a stretch, and letting that push the deadline out means the
        canvas never updates while she is answering.
        """
        cleaned = str(text or "").strip()
        if not cleaned:
            return
        if role == "user":
            self._pending.append(cleaned)
            self._last_fragment_at = now
        else:
            self._recent.append(cleaned)
            del self._recent[:-6]

    def set_in_flight(self, active: bool) -> None:
        """Mirror the gateway's `artifact.visualizing` signal."""
        self._in_flight = bool(active)

    @property
    def in_flight(self) -> bool:
        return self._in_flight

    @property
    def has_pending(self) -> bool:
        return bool(self._pending)

    def due_at(self) -> Optional[float]:
        if not self._pending or self._last_fragment_at is None:
            return None
        return self._last_fragment_at + self.config.debounce_seconds

    # -- decision -------------------------------------------------------

    def poll(self, *, now: float) -> WatchDecision | None:
        """Decide, if a settled utterance is waiting and nothing is in flight.

        Returns ``None`` when there is nothing to decide yet. The skip reason
        is available via :attr:`last_skip` for logging.
        """
        self.last_skip = None

        if not self.config.enabled:
            self.last_skip = SkipReason.DISABLED
            return None
        if not self._pending:
            self.last_skip = SkipReason.NOTHING_PENDING
            return None

        due = self.due_at()
        if due is None or now < due:
            self.last_skip = SkipReason.NOT_DUE
            return None

        # A redraw takes ~9s and the artifact write is optimistic-concurrency
        # guarded: a second redraw started while one is in flight loses the
        # revision race and dies silently, having burnt a full model call. So
        # the guard is checked BEFORE spending anything, and the utterance is
        # deliberately left pending so it is reconsidered once the canvas
        # settles rather than being dropped on the floor.
        if self._in_flight:
            self.last_skip = SkipReason.IN_FLIGHT
            return None

        # Coalesce: one burst of fragments becomes one utterance, and the
        # buffer is cleared before the model call so a slow call cannot cause
        # the same speech to be judged twice.
        utterance = " ".join(self._pending).strip()[:_MAX_UTTERANCE_CHARS]
        recent = list(self._recent)
        self._pending.clear()
        self._last_fragment_at = None
        self._recent.append(utterance)
        del self._recent[:-6]

        direct = self.config.pipeline == "direct"
        # One immutable base for the entire direct transaction. Transcript and
        # artifact callbacks can refresh watcher state while the model is
        # running; using those later values would bless a result generated from
        # a different canvas and defeat the expected-revision guard.
        base_rev = self.current_rev
        base_kind = self.current_kind
        base_summary = self.current_summary
        base_payload = copy.deepcopy(self.current_payload)
        if direct:
            # The direct call is the redraw, not merely a cheap preflight. Hold
            # the same guard across generation so a second settled utterance
            # cannot start another full artifact response concurrently.
            self._in_flight = True
        verdict = self._ask(
            utterance,
            recent,
            current_kind=base_kind,
            current_summary=base_summary,
            current_payload=base_payload,
        )
        if verdict is None:
            if direct:
                self._in_flight = False
                if self._direct_retry_count < 1:
                    # Sole-owner mode has no voice fallback. Put the exact
                    # settled utterance back once and make it immediately due;
                    # runtime schedules the retry after a short delay. A second
                    # failure is terminal so a broken provider cannot loop.
                    self._direct_retry_count += 1
                    self._pending.insert(0, utterance)
                    self._last_fragment_at = now - self.config.debounce_seconds
                    self.last_skip = SkipReason.MODEL_FAILED
                else:
                    self._direct_retry_count = 0
            return None

        self._direct_retry_count = 0

        draw, reason, direction, visual = verdict
        decision = WatchDecision(
            draw=draw,
            reason=reason,
            direction=direction,
            utterance=utterance,
            suppressed=draw and not self.config.active,
            visual=visual,
            expected_rev=base_rev,
        )
        if direct and not decision.should_draw:
            self._in_flight = False
        self._log(decision)
        return decision

    # -- model call -----------------------------------------------------

    def _ask(
        self,
        utterance: str,
        recent: List[str],
        *,
        current_kind: str,
        current_summary: str,
        current_payload: Dict[str, Any],
    ) -> tuple[bool, str, str, Any] | None:
        run = self.run_oneshot_fn
        if run is None:
            from agent.oneshot import run_oneshot

            run = run_oneshot

        request = {
            "utterance": utterance,
            "recent": recent,
            "current_kind": current_kind,
            "current_summary": current_summary,
        }
        direct = self.config.pipeline == "direct"
        instructions = WATCHER_INSTRUCTIONS
        max_tokens = MAX_WATCHER_OUTPUT_TOKENS
        timeout = 15
        if direct:
            from workbench_visualizer import _VISUALIZER_INSTRUCTIONS

            request["current_payload"] = current_payload
            visualizer_instructions = _VISUALIZER_INSTRUCTIONS.replace(
                "current_graph", "current_payload"
            )
            instructions = (
                DIRECT_WATCHER_INSTRUCTIONS
                + visualizer_instructions
                + "\n\nFINAL OUTPUT RULE: the visualizer JSON described above MUST be nested under "
                + "the outer `visual` key. Return the direct watcher envelope, never a bare visual."
            )
            max_tokens = MAX_DIRECT_OUTPUT_TOKENS
            timeout = 45
        try:
            generated = run(
                instructions=instructions,
                user_input=json.dumps(request, ensure_ascii=False),
                task=WATCHER_TASK,
                max_tokens=max_tokens,
                temperature=0.0,
                timeout=timeout,
                # Keep the watcher off the expensive conversation model.
                main_runtime=None,
            )
        except Exception as exc:
            # The watcher is an optimisation. A failed decision must degrade to
            # "don't draw", never to a broken conversation.
            logger.debug("workbench watcher call failed: %s", exc)
            return None
        if direct:
            return parse_direct_reply(generated, current_payload)
        parsed = parse_watch_reply(generated)
        if parsed is None:
            return None
        return parsed[0], parsed[1], parsed[2], None

    # -- canvas context --------------------------------------------------

    def set_canvas(
        self,
        *,
        artifact: Dict[str, Any] | None = None,
        kind: str = "map",
        summary: str = "",
    ) -> None:
        if isinstance(artifact, dict):
            payload = artifact.get("payload")
            self.current_kind = str(artifact.get("kind") or kind or "map")
            self.current_payload = (
                dict(payload) if isinstance(payload, dict) else {"nodes": [], "edges": []}
            )
            rev = artifact.get("semantic_rev")
            self.current_rev = int(rev) if isinstance(rev, int) else None
            self.current_summary = summarize_canvas(artifact)[:600]
            return
        self.current_kind = str(kind or "map")
        self.current_payload = {"nodes": [], "edges": []}
        self.current_rev = None
        self.current_summary = str(summary or "")[:600]

    # -- logging ---------------------------------------------------------

    def _log(self, decision: WatchDecision) -> None:
        """Shadow mode's entire product is this log line.

        It carries the utterance, the verdict and the reason, because the point
        of shadow mode is to judge the watcher against the voice model before
        handing it the canvas — and that comparison is impossible without the
        input that produced each call.
        """
        logger.info(
            "workbench watcher [%s] draw=%s reason=%r direction=%r utterance=%r",
            self.config.mode,
            decision.draw,
            decision.reason,
            decision.direction,
            decision.utterance,
        )


def parse_direct_reply(
    text: str, current_payload: Dict[str, Any] | None = None
) -> tuple[bool, str, str, Any] | None:
    """Parse and validate the one-call decision + visual envelope."""
    stripped = str(text or "").strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 2 and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1]).strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        parsed = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("draw"), bool):
        return None

    draw = parsed["draw"]
    reason = str(parsed.get("reason") or "").strip()[:_MAX_REASON_CHARS]
    if not draw:
        return False, reason, "", None
    visual = parsed.get("visual")
    if not isinstance(visual, dict):
        return None
    try:
        from workbench_visualizer import apply_visual_payload

        result = apply_visual_payload(visual, current_payload)
    except Exception as exc:
        logger.debug("workbench direct watcher visual rejected: %s", exc)
        return None
    return True, reason, "", result


def parse_watch_reply(text: str) -> tuple[bool, str, str] | None:
    """Parse the watcher model's reply into (draw, reason, direction).

    Returns ``None`` when the reply is unusable. Unparseable is treated as
    "no decision" rather than "draw": a malformed reply must never be able to
    trigger a nine-second redraw.
    """
    stripped = str(text or "").strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 2 and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1]).strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        parsed = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None

    raw = parsed.get("draw")
    if isinstance(raw, bool):
        draw = raw
    elif isinstance(raw, str):
        draw = raw.strip().lower() in {"true", "yes"}
    else:
        return None

    reason = str(parsed.get("reason") or "").strip()[:_MAX_REASON_CHARS]
    direction = str(parsed.get("direction") or "").strip()[:_MAX_REASON_CHARS]
    if not draw:
        direction = ""
    return draw, reason, direction


def summarize_canvas(artifact: Dict[str, Any] | None) -> str:
    """One short line describing what is on the canvas.

    The watcher decides whether the picture would CHANGE, so it needs to know
    roughly what is already drawn — but shipping the whole payload to a small
    model every utterance is both slow and a distraction from the utterance
    itself, which is the thing it is actually judging.
    """
    if not isinstance(artifact, dict):
        return ""
    payload = artifact.get("payload")
    if not isinstance(payload, dict):
        return ""
    labels: List[str] = []
    for key in ("nodes", "items"):
        entries = payload.get(key)
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    label = str(entry.get("label") or "").strip()
                    if label:
                        labels.append(label)
    if not labels:
        return "sketch" if payload.get("html") else ""
    return ", ".join(labels[:40])
