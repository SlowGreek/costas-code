"""Tests for agent.structured_output.

These assert the contract the workflow runtime depends on: a subagent's prose
final message becomes schema-valid JSON, or fails in a way callers can act on.
Cases are drawn from how tool-using agents actually respond (narration around
the answer, fenced blocks, code quoted inside string values), not from the
happy path a compliant model would produce.
"""

import json

import pytest

from agent.structured_output import (
    DEFAULT_MAX_ATTEMPTS,
    StructuredResult,
    coerce_structured_result,
    extract_json_candidates,
    resolve_max_attempts,
    retry_instruction,
    schema_instruction,
    validate_against_schema,
)


FINDING_SCHEMA = {
    "type": "object",
    "required": ["file", "severity"],
    "properties": {
        "file": {"type": "string"},
        "severity": {"type": "string", "enum": ["low", "medium", "high"]},
        "findings": {"type": "array", "items": {"type": "string"}},
    },
}


class TestExtractJsonCandidates:
    def test_bare_json_is_offered_first(self):
        candidates = extract_json_candidates('{"a": 1}')
        assert candidates[0] == '{"a": 1}'

    def test_recovers_json_wrapped_in_narration(self):
        text = 'I read the file and found one issue.\n{"file": "a.py", "severity": "high"}\nLet me know if you want a fix.'
        parsed = [json.loads(c) for c in extract_json_candidates(text) if _loadable(c)]
        assert {"file": "a.py", "severity": "high"} in parsed

    def test_prefers_the_last_fenced_block(self):
        # A model that shows a schema/example first and answers last: the
        # answer is the final block, not the illustration.
        text = (
            "Here is the shape I will use:\n"
            '```json\n{"file": "EXAMPLE", "severity": "low"}\n```\n'
            "And here is the actual result:\n"
            '```json\n{"file": "real.py", "severity": "high"}\n```\n'
        )
        candidates = extract_json_candidates(text)
        fenced = [c for c in candidates if c.startswith("{") and "EXAMPLE" not in c]
        assert json.loads(fenced[0])["file"] == "real.py"

    def test_braces_inside_strings_do_not_truncate_the_span(self):
        # Audit agents quote code, and code contains braces. A naive
        # find/rfind scan cuts the JSON in half here.
        text = 'Result:\n{"file": "a.py", "severity": "low", "findings": ["if (x) { return; }"]}'
        recovered = [json.loads(c) for c in extract_json_candidates(text) if _loadable(c)]
        assert any(r.get("findings") == ["if (x) { return; }"] for r in recovered)

    def test_empty_text_yields_nothing(self):
        assert extract_json_candidates("") == []


class TestValidateAgainstSchema:
    def test_valid_object_passes(self):
        assert validate_against_schema({"file": "a.py", "severity": "high"}, FINDING_SCHEMA) == []

    def test_missing_required_property_is_reported_with_path(self):
        violations = validate_against_schema({"file": "a.py"}, FINDING_SCHEMA)
        assert any(v.path == "severity" for v in violations)

    def test_enum_violation_is_reported(self):
        violations = validate_against_schema({"file": "a.py", "severity": "critical"}, FINDING_SCHEMA)
        assert any("not one of" in v.message for v in violations)

    def test_nested_array_item_paths_are_indexed(self):
        schema = {"type": "array", "items": FINDING_SCHEMA}
        violations = validate_against_schema(
            [{"file": "a.py", "severity": "high"}, {"file": "b.py"}], schema
        )
        assert any(v.path == "[1].severity" for v in violations)

    def test_bool_is_not_an_integer(self):
        # json.loads gives Python bools; without this guard True passes as 1.
        assert validate_against_schema(True, {"type": "integer"})

    def test_integer_satisfies_number(self):
        assert validate_against_schema(3, {"type": "number"}) == []

    def test_unknown_keywords_are_ignored_not_failed(self):
        # A richer schema should still validate on the parts we understand.
        schema = {"type": "object", "patternProperties": {"^x": {}}, "required": ["a"]}
        assert validate_against_schema({"a": 1}, schema) == []

    def test_no_schema_means_no_violations(self):
        assert validate_against_schema({"anything": True}, None) == []

    def test_additional_properties_false_is_enforced(self):
        schema = {
            "type": "object",
            "properties": {"a": {"type": "string"}},
            "additionalProperties": False,
        }
        assert validate_against_schema({"a": "x", "b": "y"}, schema)


class TestCoerceStructuredResult:
    def test_clean_json_succeeds(self):
        result = coerce_structured_result('{"file": "a.py", "severity": "high"}', FINDING_SCHEMA)
        assert result.ok
        assert result.value["file"] == "a.py"

    def test_narrated_json_succeeds(self):
        text = 'Done.\n\n```json\n{"file": "a.py", "severity": "low"}\n```\n\nWant a patch?'
        result = coerce_structured_result(text, FINDING_SCHEMA)
        assert result.ok
        assert result.value["severity"] == "low"

    def test_prose_only_fails_without_raising(self):
        result = coerce_structured_result("I could not find anything.", FINDING_SCHEMA)
        assert not result.ok
        assert "not valid JSON" in result.error
        assert result.value is None

    def test_valid_json_wrong_shape_reports_schema_error(self):
        result = coerce_structured_result('{"file": "a.py"}', FINDING_SCHEMA)
        assert not result.ok
        assert "did not match schema" in result.error
        assert "severity" in result.error

    def test_empty_output_is_a_failure_not_a_crash(self):
        assert not coerce_structured_result("", FINDING_SCHEMA).ok
        assert not coerce_structured_result("   \n ", FINDING_SCHEMA).ok

    def test_schema_valid_candidate_wins_over_earlier_invalid_one(self):
        # The model shows a malformed sketch, then the real answer.
        text = (
            'First attempt: {"file": "a.py"}\n'
            'Corrected: {"file": "a.py", "severity": "medium"}\n'
        )
        result = coerce_structured_result(text, FINDING_SCHEMA)
        assert result.ok
        assert result.value["severity"] == "medium"

    def test_no_schema_accepts_any_json(self):
        result = coerce_structured_result('[1, 2, 3]', None)
        assert result.ok
        assert result.value == [1, 2, 3]

    def test_raw_is_preserved_for_debugging(self):
        result = coerce_structured_result("nope", FINDING_SCHEMA)
        assert result.raw == "nope"

    def test_to_dict_omits_value_on_failure_and_truncates_raw(self):
        failed = coerce_structured_result("x" * 5000, FINDING_SCHEMA).to_dict()
        assert "value" not in failed
        assert len(failed["raw"]) <= 2000

        ok = coerce_structured_result('{"file": "a.py", "severity": "low"}', FINDING_SCHEMA).to_dict()
        assert ok["ok"] is True
        assert "error" not in ok


class TestInstructions:
    def test_schema_instruction_embeds_the_schema(self):
        text = schema_instruction(FINDING_SCHEMA)
        assert "severity" in text
        assert "single JSON value" in text

    def test_retry_instruction_names_the_actual_problem(self):
        previous = coerce_structured_result('{"file": "a.py"}', FINDING_SCHEMA)
        text = retry_instruction(previous, FINDING_SCHEMA)
        assert "severity" in text
        assert "could not be parsed" in text

    def test_retry_instruction_truncates_a_huge_previous_answer(self):
        previous = StructuredResult(ok=False, error="boom", raw="y" * 9000)
        assert len(retry_instruction(previous, FINDING_SCHEMA)) < 4000


class TestResolveMaxAttempts:
    def test_default_when_unset_or_garbage(self):
        assert resolve_max_attempts(None) == DEFAULT_MAX_ATTEMPTS
        assert resolve_max_attempts("many") == DEFAULT_MAX_ATTEMPTS

    def test_floor_is_one_attempt(self):
        assert resolve_max_attempts(0) == 1
        assert resolve_max_attempts(-5) == 1

    def test_ceiling_bounds_cost(self):
        # Each attempt is a full subagent run; at fan-out scale this multiplies.
        assert resolve_max_attempts(99) == 5


def _loadable(candidate: str) -> bool:
    try:
        json.loads(candidate)
    except (ValueError, TypeError):
        return False
    return True
