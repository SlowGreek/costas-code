"""Failed follow-ups preserve completed work as history, never as false success.

Steering v2 has no withheld-answer rescue. Exercise actual HTTP failures through
run_conversation, including auxiliary compression failure, without reloading
modules or destroying directories while logging threads still reference them.
"""
import json
import pytest

from tests.agent.test_steering_v2 import runtime  # shared hermetic HTTP fixture


FAILURES = [
    (400, 'Invalid request payload.'),
    (402, 'Your credit balance is too low to access the API.'),
    (500, 'Internal server error'),
    (400, "This model's maximum context length is 8192 tokens."),
]


@pytest.mark.parametrize('failure', FAILURES)
def test_completed_answer_and_steer_survive_failed_followup(runtime, monkeypatch, failure):
    agent, requests, responses, hooks = runtime
    emitted = []
    agent.interim_assistant_callback = lambda text, **kwargs: emitted.append(text)
    responses.extend([{'role': 'assistant', 'content': 'ANSWER ONE'}] + [failure] * 20)
    hooks.append(lambda: agent.steer('and also check staging'))
    monkeypatch.setattr(agent.context_compressor, 'compress', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('offline compression')))
    result = agent.run_conversation('do the thing', conversation_history=[], task_id='t')
    assert len(requests) >= 2
    assert result.get('failed') or result.get('partial')
    assert sum(m.get('role') == 'assistant' and m.get('content') == 'ANSWER ONE' for m in result['messages']) == 1
    assert sum(m.get('role') == 'user' and m.get('content') == 'and also check staging' for m in result['messages']) == 1
    assert result.get('pending_steer') is None
    assert result['final_response'] != 'ANSWER ONE', 'Failure is not success or duplicate delivery'
    assert emitted.count('ANSWER ONE') <= 1
    assert result['user_inputs'][0]['status'] == 'committed'


def test_stop_during_followup_does_not_resurrect_input(runtime):
    agent, requests, responses, hooks = runtime
    responses.append({'role': 'assistant', 'content': 'ANSWER ONE'})
    hooks.extend([lambda: agent.steer('correction'), lambda: agent.interrupt()])
    result = agent.run_conversation('start', conversation_history=[], task_id='t')
    assert result['interrupted']
    assert not result.get('pending_steer')
    assert 'ANSWER ONE' in json.dumps(result['messages'])
    assert len(requests) == 2


def test_failed_initial_request_keeps_pending_input_recoverable(runtime):
    agent, requests, responses, hooks = runtime
    responses.extend([(402, 'Your credit balance is too low')] * 10)
    hooks.append(lambda: agent.steer('correction during failed request'))
    result = agent.run_conversation('start', conversation_history=[], task_id='t')
    assert result['failed']
    assert result['user_inputs'][0]['status'] == 'recoverable'
    assert result['user_inputs'][0]['content'] == 'correction during failed request'
