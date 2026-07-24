"""Structured output for subagent results.

A subagent's result is whatever prose the model emitted when it stopped calling
tools (``run_conversation()``'s ``final_response``). That is fine for a human
reading a summary and useless for a *program* deciding what to do next: you
cannot write ``[a for a in audits if a["severity"] == "high"]`` against prose.

This module turns a child's free-text final message into validated JSON so
orchestration code can branch on it. It exists for the workflow runtime's
``agent(prompt, schema=...)`` primitive, and is deliberately usable on its own
from ``delegate_task``.

Why prompt-and-parse rather than provider-native structured output
------------------------------------------------------------------
There is no ``response_format`` plumbing anywhere in the agent core — not in
``run_agent.py``, ``agent/``, or any provider adapter. Adding it would mean
touching every adapter and every ``api_mode`` variant, and it would still not
work on providers/models that lack the feature. Prompt-and-parse works on every
route Hermes can talk to today, degrades predictably, and keeps this change off
the provider hot path entirely.

The cost is that it is probabilistic: a tool-using agent likes to narrate
("I read the file and found...") and may wrap, prefix, or fence its JSON. So
this module is built around *recovering* JSON from realistic model output and
around an explicit, bounded retry contract — not around assuming compliance.

Failure contract (the part callers must not have to guess)
----------------------------------------------------------
Every parse attempt yields a :class:`StructuredResult`. It is either:

* ``ok=True``  — ``value`` holds JSON that validated against the schema; or
* ``ok=False`` — ``value`` is ``None`` and ``error``/``raw`` explain why.

It never raises on bad model output, and it never returns partially-validated
data. Callers decide policy: ``pipeline()`` drops failures (matching the
``audits.filter(Boolean)`` shape workflows expect), while a bare ``agent()``
call surfaces the error to the script.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# A fenced block is the single most common wrapper a chat model puts around
# JSON, with or without a language tag.
_FENCE_RE = re.compile(
    r"```(?:json|JSON)?\s*\n(?P<body>.*?)\n?```",
    re.DOTALL,
)

# Bounded by default: each retry is a full subagent re-run, i.e. real money.
DEFAULT_MAX_ATTEMPTS = 2


@dataclass
class StructuredResult:
    """Outcome of coercing one child's final message into schema-valid JSON."""

    ok: bool
    value: Any = None
    error: Optional[str] = None
    raw: Optional[str] = None
    attempts: int = 1

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"ok": self.ok, "attempts": self.attempts}
        if self.ok:
            payload["value"] = self.value
        else:
            payload["error"] = self.error
            # Truncated: a failed child's prose can be arbitrarily long and this
            # rides back into an orchestration log, not a human's screen.
            if self.raw is not None:
                payload["raw"] = self.raw[:2000]
        return payload


@dataclass
class SchemaViolation:
    path: str
    message: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.path}: {self.message}" if self.path else self.message


def extract_json_candidates(text: str) -> List[str]:
    """Yield plausible JSON payloads inside a model's final message.

    Ordered most-likely-first:

    1. the whole message (a compliant model returns bare JSON);
    2. fenced code blocks, last first — when a model explains and *then*
       answers, the answer is the final block;
    3. the outermost balanced ``{...}`` / ``[...]`` span, which recovers the
       common "Here is the result: {...}. Let me know if..." shape.

    Returns candidates in the order they should be tried. Never raises.
    """
    if not text:
        return []

    candidates: List[str] = []

    stripped = text.strip()
    if stripped:
        candidates.append(stripped)

    fenced = [m.group("body").strip() for m in _FENCE_RE.finditer(text)]
    candidates.extend(reversed([f for f in fenced if f]))

    for opener, closer in (("{", "}"), ("[", "]")):
        # Every balanced span, not just the first: a model that sketches a
        # wrong answer and then corrects it puts the real result LAST, so
        # stopping at the first span would lock in the mistake.
        spans = _balanced_spans(text, opener, closer)
        candidates.extend(reversed(spans))

    # Preserve order, drop duplicates.
    seen: set[str] = set()
    unique: List[str] = []
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return unique


def _balanced_spans(text: str, opener: str, closer: str) -> List[str]:
    """All top-level balanced ``opener``/``closer`` spans, in order.

    A naive ``find``/``rfind`` breaks on braces inside string values, which is
    exactly what code-auditing agents return (their findings quote code). So we
    track string state and escapes.

    Returns every top-level span rather than the first, because a model that
    sketches an answer and then corrects it puts the real result last.
    """
    spans: List[str] = []
    depth = 0
    start = -1
    in_string = False
    escaped = False

    for index, char in enumerate(text):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue

        if char == opener:
            if depth == 0:
                start = index
            depth += 1
        elif char == closer and depth > 0:
            depth -= 1
            if depth == 0 and start != -1:
                spans.append(text[start : index + 1])
                start = -1

    return spans


def validate_against_schema(value: Any, schema: Optional[Dict[str, Any]]) -> List[SchemaViolation]:
    """Validate ``value`` against a practical subset of JSON Schema.

    Supported: ``type`` (incl. lists of types), ``required``, ``properties``,
    ``items``, ``enum``, ``minimum``/``maximum``, ``minItems``/``maxItems``,
    plus ``additionalProperties: False``.

    This is deliberately dependency-free and deliberately partial. It covers the
    shapes orchestration scripts actually use (objects of typed fields, arrays
    of such objects, enums for verdicts) without pulling ``jsonschema`` into the
    core for a feature most users will not enable. Unknown keywords are ignored
    rather than treated as failures, so a richer schema still validates on the
    parts we understand instead of hard-failing.

    Returns a list of violations; empty means valid.
    """
    if not schema:
        return []
    return _validate(value, schema, path="")


_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    # JSON has one number type; accept int where a number is asked for.
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _validate(value: Any, schema: Dict[str, Any], path: str) -> List[SchemaViolation]:
    violations: List[SchemaViolation] = []

    if not isinstance(schema, dict):
        return violations

    expected = schema.get("type")
    if expected:
        expected_types = expected if isinstance(expected, list) else [expected]
        if not any(_TYPE_CHECKS.get(t, lambda _v: True)(value) for t in expected_types):
            violations.append(
                SchemaViolation(path, f"expected type {'/'.join(expected_types)}, got {_type_name(value)}")
            )
            # A wrong type makes every nested check noise; stop here.
            return violations

    if "enum" in schema and isinstance(schema["enum"], list):
        if value not in schema["enum"]:
            violations.append(SchemaViolation(path, f"value {value!r} is not one of {schema['enum']!r}"))

    if isinstance(value, dict):
        violations.extend(_validate_object(value, schema, path))
    elif isinstance(value, list):
        violations.extend(_validate_array(value, schema, path))
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        if isinstance(minimum, (int, float)) and value < minimum:
            violations.append(SchemaViolation(path, f"{value} is below minimum {minimum}"))
        if isinstance(maximum, (int, float)) and value > maximum:
            violations.append(SchemaViolation(path, f"{value} is above maximum {maximum}"))

    return violations


def _validate_object(value: Dict[str, Any], schema: Dict[str, Any], path: str) -> List[SchemaViolation]:
    violations: List[SchemaViolation] = []

    required = schema.get("required")
    if isinstance(required, list):
        for key in required:
            if key not in value:
                violations.append(SchemaViolation(_join(path, key), "required property is missing"))

    properties = schema.get("properties")
    if isinstance(properties, dict):
        for key, subschema in properties.items():
            if key in value:
                violations.extend(_validate(value[key], subschema, _join(path, key)))

        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    violations.append(SchemaViolation(_join(path, key), "unexpected property"))

    return violations


def _validate_array(value: List[Any], schema: Dict[str, Any], path: str) -> List[SchemaViolation]:
    violations: List[SchemaViolation] = []

    min_items = schema.get("minItems")
    max_items = schema.get("maxItems")
    if isinstance(min_items, int) and len(value) < min_items:
        violations.append(SchemaViolation(path, f"expected at least {min_items} items, got {len(value)}"))
    if isinstance(max_items, int) and len(value) > max_items:
        violations.append(SchemaViolation(path, f"expected at most {max_items} items, got {len(value)}"))

    item_schema = schema.get("items")
    if isinstance(item_schema, dict):
        for index, item in enumerate(value):
            violations.extend(_validate(item, item_schema, f"{path}[{index}]"))

    return violations


def _join(path: str, key: str) -> str:
    return f"{path}.{key}" if path else str(key)


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def coerce_structured_result(
    text: str,
    schema: Optional[Dict[str, Any]] = None,
    *,
    attempts: int = 1,
) -> StructuredResult:
    """Recover schema-valid JSON from a subagent's final message.

    Tries each candidate from :func:`extract_json_candidates` and returns the
    first that both parses and validates. When several parse but none validate,
    the reported error describes the *first* parsed candidate — that is almost
    always the model's real answer, so its violations are the actionable ones
    (rather than complaints about some incidental brace-y prose later in the
    message).
    """
    if not text or not text.strip():
        return StructuredResult(ok=False, error="subagent returned no output", raw=text, attempts=attempts)

    first_parsed: Any = None
    first_violations: Optional[List[SchemaViolation]] = None
    parsed_any = False

    for candidate in extract_json_candidates(text):
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue

        violations = validate_against_schema(parsed, schema)
        if not violations:
            return StructuredResult(ok=True, value=parsed, raw=text, attempts=attempts)

        if not parsed_any:
            parsed_any = True
            first_parsed = parsed
            first_violations = violations

    if parsed_any and first_violations is not None:
        detail = "; ".join(str(v) for v in first_violations[:5])
        return StructuredResult(
            ok=False,
            error=f"output did not match schema ({detail})",
            raw=text,
            attempts=attempts,
        )

    return StructuredResult(
        ok=False,
        error="output was not valid JSON",
        raw=text,
        attempts=attempts,
    )


def schema_instruction(schema: Dict[str, Any]) -> str:
    """Instruction appended to a child's goal so it returns parseable JSON.

    Kept blunt and short on purpose. Long formatting sermons crowd out the
    actual task and, in practice, do not improve compliance as much as one
    unambiguous rule does.
    """
    rendered = json.dumps(schema, indent=2, sort_keys=True)
    return (
        "\n\n---\n"
        "REQUIRED OUTPUT FORMAT\n"
        "Your final message must be a single JSON value matching this schema "
        "and nothing else — no prose before or after it, no code fence, no "
        "explanation. Do all your reasoning and tool use first; the final "
        "message is the machine-readable result.\n\n"
        f"{rendered}\n"
    )


def retry_instruction(previous: StructuredResult, schema: Dict[str, Any]) -> str:
    """Follow-up goal telling a child exactly how its last answer was wrong."""
    rendered = json.dumps(schema, indent=2, sort_keys=True)
    previous_output = (previous.raw or "").strip()
    if len(previous_output) > 1200:
        previous_output = previous_output[:1200] + "\n…[truncated]"

    return (
        "Your previous response could not be parsed as the required JSON "
        f"output. Problem: {previous.error}.\n\n"
        "Previous response:\n"
        f"{previous_output}\n\n"
        "Return the SAME result again, corrected, as a single JSON value "
        "matching this schema and nothing else:\n\n"
        f"{rendered}\n"
    )


def resolve_max_attempts(configured: Any) -> int:
    """Clamp a configured attempt count into a sane, affordable range.

    Each attempt is a full subagent run, so the ceiling is low by design: a
    model that fails twice on an explicit schema is not usually one retry away
    from success, and at fan-out scale the cost multiplies by agent count.
    """
    try:
        value = int(configured)
    except (TypeError, ValueError):
        return DEFAULT_MAX_ATTEMPTS
    return max(1, min(value, 5))
