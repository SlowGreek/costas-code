"""Durable gateway receipts survive a new runtime and remain nonexecuting."""
import threading


def test_resume_projects_recoverable_input_without_replaying_it(tmp_path):
    from tui_gateway import server
    session = {'session_key': 'durable', 'profile_home': str(tmp_path), 'history': [],
               'history_lock': threading.RLock(), 'running': True, 'agent': None}
    server._start_inflight_turn(session, 'Original')
    inbox = session['user_input_inbox']
    inbox.submit('Use staging', message_id='m', turn_id=inbox.turn_id, request_key='k')
    restored = {**session, 'running': False, 'inflight_turn': None}
    restored.pop('user_input_inbox')
    payload = server._attach_todo_state({'inflight': None}, restored)
    assert payload['inflight']['user_inputs'][0]['content'] == 'Use staging'
    assert payload['inflight']['user_inputs'][0]['status'] == 'recoverable'
    server._start_inflight_turn(restored, 'New request')
    messages = []
    restored['user_input_inbox'].commit(messages)
    assert messages == []
