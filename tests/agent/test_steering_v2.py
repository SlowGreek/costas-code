"""Steering contract through the real loop and OpenAI HTTP adapter (no live API)."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

import pytest


@pytest.fixture
def runtime(monkeypatch):
    import os
    from pathlib import Path
    Path(os.environ['HERMES_HOME'], 'config.yaml').write_text('model:\n  supports_vision: true\n')
    from run_agent import AIAgent
    # Auxiliary discovery must not probe a configured account.
    monkeypatch.setattr('agent.auxiliary_client.get_text_auxiliary_client', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('offline test')))
    requests, responses, hooks = [], [], []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if 'messages' not in req:
                self.send_response(404)
                self.end_headers()
                return
            requests.append(req)
            if hooks:
                hooks.pop(0)()
            msg = responses.pop(0) if responses else {'role': 'assistant', 'content': 'DONE'}
            if isinstance(msg, tuple):
                status, error = msg
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': {'message': error, 'type': 'invalid_request_error'}}).encode())
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream' if req.get('stream') else 'application/json')
            self.end_headers()
            if req.get('stream'):
                delta = dict(msg)
                if delta.get('tool_calls'):
                    delta['tool_calls'] = [dict(t, index=i) for i, t in enumerate(delta['tool_calls'])]
                for chunk in [dict(delta=delta, finish_reason=None), dict(delta={}, finish_reason='tool_calls' if msg.get('tool_calls') else 'stop')]:
                    self.wfile.write(('data: ' + json.dumps({'id': 'test', 'choices': [dict(chunk, index=0)]}) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.wfile.write(json.dumps({'id': 'test', 'choices': [{'index': 0, 'message': msg, 'finish_reason': 'tool_calls' if msg.get('tool_calls') else 'stop'}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 3, 'total_tokens': 13}}).encode())
            self.wfile.flush()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    agent = AIAgent(api_key='test-only', base_url=f'http://127.0.0.1:{server.server_port}/v1', provider='openai-compat', model='gpt-4o', max_iterations=8, enabled_toolsets=[], quiet_mode=True, skip_context_files=True, skip_memory=True, save_trajectories=False, platform='cli')
    try:
        yield agent, requests, responses, hooks
    finally:
        server.shutdown()
        server.server_close()
        worker.join(3)


def test_streaming_steer_does_not_abort_and_appends_user(runtime):
    agent, requests, responses, hooks = runtime
    aborts, accepted = [], []
    responses.extend([{'role': 'assistant', 'content': 'Completed original answer.'}, {'role': 'assistant', 'content': 'Correction received.'}])

    def steer():
        agent._active_request_abort = lambda reason: aborts.append(reason)
        accepted.append(agent.redirect('Use staging instead.'))

    hooks.append(steer)
    result = agent.run_conversation('Inspect deployment', conversation_history=[], task_id='test')
    assert accepted == [True]
    assert aborts == [], 'Steer is not Stop'
    assert len(requests) == 2
    first, second = [r['messages'] for r in requests]
    assert second[:len(first)] == first
    assert second[-2]['role'] == 'assistant'
    assert second[-2]['content'] == 'Completed original answer.'
    assert second[-1] == {'role': 'user', 'content': 'Use staging instead.'}
    assert result['final_response'] == 'Correction received.'


@pytest.mark.parametrize('mode', ['sequential', 'concurrent', 'segmented'])
def test_image_steer_after_whole_tool_batch(runtime, monkeypatch, mode):
    agent, requests, responses, hooks = runtime
    from tools.registry import registry
    from agent import tool_executor
    effects = []
    payload = [{'type': 'text', 'text': 'Use this reference.'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,aGVsbG8='}}]

    def effect(args, **kwargs):
        effects.append(args['value'])
        if args['value'] == 1:
            assert agent.redirect(deepcopy(payload)) is True
        return json.dumps({'effect': args['value']})

    registry.register(name='steering_test_effect', toolset='steering_test', schema={'name': 'steering_test_effect', 'description': 'Record an effect', 'parameters': {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}}, handler=effect)
    agent.valid_tool_names = {'steering_test_effect'}
    agent.tools = registry.get_definitions(agent.valid_tool_names, quiet=True)
    # Select real executor variants, not a mock of their outcomes.
    monkeypatch.setattr('agent.tool_dispatch_helpers._plan_tool_batch_segments', lambda calls, **kw: [('sequential', calls[:1]), ('parallel', calls[1:])] if mode == 'segmented' else [('parallel' if mode == 'concurrent' else 'sequential', calls)])
    responses.append({'role': 'assistant', 'content': None, 'tool_calls': [{'id': f'call-{i}', 'type': 'function', 'function': {'name': 'steering_test_effect', 'arguments': json.dumps({'value': i})}} for i in [1, 2]]})
    result = agent.run_conversation('Run both effects.', conversation_history=[], task_id='test')
    assert sorted(effects) == [1, 2]
    assert len(requests) == 2
    rows = requests[1]['messages']
    assert rows[:len(requests[0]['messages'])] == requests[0]['messages']
    tools = [r for r in rows if r['role'] == 'tool']
    assert {r['tool_call_id'] for r in tools} == {'call-1', 'call-2'}
    assert [json.loads(r['content']) for r in tools] == [{'effect': 1}, {'effect': 2}]
    assert rows[-1] == {'role': 'user', 'content': payload}
    from agent.transports.anthropic import AnthropicTransport
    from agent.transports.codex import ResponsesApiTransport
    _, anthropic = AnthropicTransport().convert_messages(rows)
    assert anthropic[-1]['role'] == 'user'
    assert any(b.get('type') == 'text' and b.get('text') == 'Use this reference.' for b in anthropic[-1]['content'])
    assert any(b.get('type') == 'image' for b in anthropic[-1]['content'])
    assert all('Use this reference.' not in str(b) for b in anthropic[-1]['content'] if b.get('type') == 'tool_result')
    response_rows = ResponsesApiTransport().convert_messages(rows)
    assert response_rows[-1]['role'] == 'user'
    assert any(b.get('type') == 'input_text' and b.get('text') == 'Use this reference.' for b in response_rows[-1]['content'])
    assert any(b.get('type') == 'input_image' for b in response_rows[-1]['content'])
    assert result['final_response'] == 'DONE'


def test_identified_input_is_idempotent_and_bound_to_active_turn(runtime):
    agent, requests, responses, hooks = runtime
    submit = getattr(agent, 'submit_user_input', None)
    assert callable(submit), 'Runtime needs typed identified pending user input'
    receipts = []
    responses.extend([{'role': 'assistant', 'content': 'Original'}, {'role': 'assistant', 'content': 'Corrected'}])

    def submit_twice():
        tid = agent._current_turn_id
        receipts.append(submit('Correction', message_id='input-1', turn_id=tid))
        receipts.append(submit('Correction', message_id='input-1', turn_id=tid))
        receipts.append(submit('Wrong turn', message_id='input-2', turn_id='stale'))

    hooks.append(submit_twice)
    result = agent.run_conversation('Start', conversation_history=[], task_id='test')
    assert [r['status'] for r in receipts] == ['pending', 'pending', 'stale']
    assert sum(m.get('content') == 'Correction' for m in requests[-1]['messages']) == 1
    row = next(m for m in result['messages'] if m.get('content') == 'Correction')
    assert row['display_metadata']['steering']['message_id'] == 'input-1'
    assert agent.user_input_status('input-1')['status'] == 'committed'
    assert submit('Late', message_id='input-3', turn_id=agent._current_turn_id)['status'] == 'stale'


def test_stop_cancels_pending_input_without_resurrection(runtime):
    agent, requests, responses, hooks = runtime
    events = []
    agent.user_input_callback = events.append
    submit = getattr(agent, 'submit_user_input', None)
    assert callable(submit)

    def stop():
        assert submit('Must not run', message_id='stopped', turn_id=agent._current_turn_id)['status'] == 'pending'
        agent.interrupt()

    hooks.append(stop)
    result = agent.run_conversation('Start', conversation_history=[], task_id='test')
    assert result['interrupted']
    assert agent.user_input_status('stopped')['status'] == 'cancelled'
    assert any(e['message_id'] == 'stopped' and e['status'] == 'cancelled' for e in events)
    agent.run_conversation('New task', conversation_history=result['messages'], task_id='test-2')
    assert 'Must not run' not in json.dumps(requests[-1]['messages'])


@pytest.mark.parametrize('failure', [(402, 'Your credit balance is too low'), (400, "This model's maximum context length is 8192 tokens.")])
def test_failure_preserves_history_and_accepted_input(runtime, monkeypatch, failure):
    agent, requests, responses, hooks = runtime
    responses.extend([{'role': 'assistant', 'content': 'Completed work.'}] + [failure] * 16)
    hooks.append(lambda: agent.submit_user_input('Correction', message_id='failure-1', turn_id=agent._current_turn_id))
    # Explicitly prevent auxiliary compression from contacting any service.
    monkeypatch.setattr(agent.context_compressor, 'compress', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('offline compression unavailable')))
    result = agent.run_conversation('Start', conversation_history=[], task_id='test')
    assert len(requests) >= 2
    assert any(m.get('role') == 'assistant' and m.get('content') == 'Completed work.' for m in result['messages'])
    assert sum(m.get('role') == 'user' and m.get('content') == 'Correction' for m in result['messages']) == 1
    assert result.get('pending_steer') is None
    assert result['user_inputs'][0]['status'] == 'committed'
    assert result.get('failed') or result.get('partial')


def test_budget_exit_keeps_unconsumed_input_recoverable(runtime):
    agent, requests, responses, hooks = runtime
    agent.max_iterations = 1
    interim = []
    agent.interim_assistant_callback = lambda text, **kwargs: interim.append(text)
    hooks.append(lambda: agent.submit_user_input('Beyond budget', message_id='budget-1', turn_id=agent._current_turn_id))
    result = agent.run_conversation('Start', conversation_history=[], task_id='test')
    assert len(requests) == 1
    assert result['user_inputs'][0]['status'] == 'recoverable'
    assert result['user_inputs'][0]['content'] == 'Beyond budget'
    assert interim == [], 'A budget-limited final answer must not also be delivered as interim'
    assert any(m.get('content') == 'DONE' for m in result['messages'])


def test_process_wait_wakes_without_killing_child(runtime):
    import sys
    from tools.process_registry import ProcessRegistry
    from tools.registry import registry
    agent, requests, responses, hooks = runtime
    processes = ProcessRegistry()
    process = processes.spawn_local(f'"{sys.executable}" -c "import time; time.sleep(30)"', task_id='steer-wait')
    observed = []
    timer = None

    def wait_handler(args, **kwargs):
        nonlocal timer
        timer = threading.Timer(0.05, lambda: agent.redirect('Stop waiting; inspect progress.'))
        timer.start()
        observed.append(processes.wait(process.id, timeout=3))
        return json.dumps(observed[-1])

    registry.register(name='steering_wait', toolset='steering_test', schema={'name': 'steering_wait', 'description': 'Wait for test process', 'parameters': {'type': 'object', 'properties': {}}}, handler=wait_handler)
    agent.valid_tool_names = {'steering_wait'}
    agent.tools = registry.get_definitions(agent.valid_tool_names, quiet=True)
    responses.append({'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'wait', 'type': 'function', 'function': {'name': 'steering_wait', 'arguments': '{}'}}]})
    try:
        agent.run_conversation('Wait for the process', conversation_history=[], task_id='test')
        assert observed[0]['status'] == 'steering_pending'
        assert observed[0]['process_running'] is True
        assert not processes.get(process.id).exited
        assert requests[1]['messages'][-1]['content'] == 'Stop waiting; inspect progress.'
    finally:
        if timer: timer.join(3)
        processes.kill_process(process.id)


def test_gateway_identified_steer_roundtrip_and_reconnect(runtime):
    from tui_gateway import server
    agent, requests, responses, hooks = runtime
    assert 'session.input' in server._methods, 'Gateway needs identified input protocol'
    sid = 'steering-v2-test'
    session = {'session_key': sid, 'agent': agent, 'running': True, 'history': [], 'history_lock': threading.RLock(), 'attached_images': []}
    server._sessions[sid] = session
    server._start_inflight_turn(session, 'Start')
    turn_id = session['inflight_turn']['turn_id']
    agent._user_input_inbox = session['user_input_inbox']
    agent._relay_pending_turn_id = turn_id
    params = {'session_id': sid, 'text': 'Gateway correction', 'turn_id': turn_id, 'message_id': 'rpc-1'}
    receipts = []

    def rpc():
        receipts.append(server._methods['session.input'](1, params)['result'])
        receipts.append(server._methods['session.input'](2, params)['result'])
        snapshot = server._inflight_snapshot(session)
        assert snapshot['user_inputs'][0]['message_id'] == 'rpc-1'
        assert snapshot['user_inputs'][0]['status'] == 'pending'

    hooks.append(rpc)
    try:
        result = agent.run_conversation('Start', conversation_history=[], task_id='test')
        assert [r['status'] for r in receipts] == ['pending', 'pending']
        assert requests[-1]['messages'][-1] == {'role': 'user', 'content': 'Gateway correction'}
        assert server._methods['session.input.status'](3, params)['result']['status'] == 'committed'
        assert server._methods['session.input'](4, dict(params, message_id='late'))['result']['status'] == 'stale'
        assert result['user_inputs'][0]['message_id'] == 'rpc-1'
    finally:
        server._sessions.pop(sid, None)


def test_gateway_image_only_steer_reaches_provider_once(runtime, tmp_path):
    from PIL import Image
    from tui_gateway import server
    agent, requests, responses, hooks = runtime
    image = tmp_path / 'reference.png'
    Image.new('RGB', (1, 1), 'blue').save(image)
    sid = 'steering-v2-images'
    session = {'session_key': sid, 'agent': agent, 'running': True, 'history': [], 'history_lock': threading.RLock(), 'attached_images': [str(image)]}
    server._sessions[sid] = session
    server._start_inflight_turn(session, 'Start')
    server._bind_turn_user_input(sid, session, agent)
    params = {'session_id': sid, 'message_id': 'image-only', 'turn_id': session['inflight_turn']['turn_id'], 'text': '', 'images': [str(image)]}
    receipts = []
    def submit():
        receipts.append(server._methods['session.input'](1, params))
        receipts.append(server._methods['session.input'](2, params))
    hooks.append(submit)
    try:
        result = agent.run_conversation('Start', conversation_history=[], task_id='test')
        assert [r['result']['status'] for r in receipts] == ['pending', 'pending']
        assert len(requests) == 2
        correction = requests[1]['messages'][-1]
        assert correction['role'] == 'user'
        assert sum(p.get('type') == 'image_url' for p in correction['content']) == 1
        assert correction['content'][-1]['image_url']['url'].startswith('data:image/png;base64,')
        assert session['attached_images'] == []
        assert result['user_inputs'][0]['status'] == 'committed'
    finally:
        server._sessions.pop(sid, None)


def test_gateway_build_window_and_stop_do_not_lose_input(runtime):
    from tui_gateway import server
    agent, requests, responses, hooks = runtime
    assert 'session.input' in server._methods
    sid = 'steering-v2-build'
    session = {'session_key': sid, 'agent': None, 'running': True, 'history': [], 'history_lock': threading.RLock(), 'attached_images': []}
    server._sessions[sid] = session
    server._start_inflight_turn(session, 'Start')
    tid = session['inflight_turn']['turn_id']
    params = {'session_id': sid, 'text': 'Build correction', 'turn_id': tid, 'message_id': 'build-1'}
    try:
        assert server._methods['session.input'](1, params)['result']['status'] == 'pending'
        # The real prompt driver adopts the same inbox before starting the loop.
        server._bind_turn_user_input(sid, session, agent)
        agent.run_conversation('Start', conversation_history=[], task_id='test')
        assert 'Build correction' in json.dumps(requests[0]['messages'])
        assert not session.get('queued_prompts')
    finally:
        server._sessions.pop(sid, None)
