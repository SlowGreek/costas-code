"""Plain-answer follow-up contract through the real loop and HTTP transport."""
from tests.agent.test_steering_v2 import runtime  # shared hermetic HTTP fixture


def _run_with_correction(runtime):
    agent, requests, responses, hooks = runtime
    responses.extend([
        {'role': 'assistant', 'content': 'Original completed answer.'},
        {'role': 'assistant', 'content': 'Corrected answer.'},
    ])
    hooks.append(lambda: agent.steer('Use staging, not production.'))
    result = agent.run_conversation('Inspect deployment', conversation_history=[], task_id='test')
    return requests, result


def test_steer_during_plain_answer_triggers_a_followup_request(runtime):
    requests, _ = _run_with_correction(runtime)
    assert len(requests) == 2


def test_followup_request_carries_the_steer_as_a_user_message(runtime):
    requests, _ = _run_with_correction(runtime)
    assert requests[1]['messages'][-1] == {'role': 'user', 'content': 'Use staging, not production.'}


def test_followup_request_retains_the_answer_the_user_already_saw(runtime):
    requests, _ = _run_with_correction(runtime)
    assert requests[1]['messages'][-2] == {'role': 'assistant', 'content': 'Original completed answer.'}


def test_followup_request_is_a_pure_append_of_the_first(runtime):
    requests, _ = _run_with_correction(runtime)
    first, second = [r['messages'] for r in requests]
    assert second[:len(first)] == first
    assert len(second) > len(first)


def test_no_steer_leaves_the_turn_ending_after_one_request(runtime):
    agent, requests, responses, _ = runtime
    responses.append({'role': 'assistant', 'content': 'All done.'})
    result = agent.run_conversation('Inspect deployment', conversation_history=[], task_id='test')
    assert len(requests) == 1
    assert result['final_response'] == 'All done.'


def test_steer_is_delivered_only_once(runtime):
    requests, result = _run_with_correction(runtime)
    assert len(requests) == 2
    assert sum(m.get('content') == 'Use staging, not production.' for m in requests[1]['messages']) == 1
    assert result['final_response'] == 'Corrected answer.'
    assert not result.get('pending_steer')
