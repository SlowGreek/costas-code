"""Durable gateway receipts survive a new runtime and remain nonexecuting."""
import threading


def test_journal_follows_only_compaction_lineage_not_explicit_branches(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from tui_gateway import server
    (tmp_path / 'state.db').touch()
    rows = {
        'root': {'source':'desktop', 'end_reason':'compression'},
        'tip': {'source':'desktop', 'parent_session_id':'root'},
        'branch': {'source':'desktop', 'parent_session_id':'root', 'model_config':{'_branched_from':'root'}},
    }
    @contextmanager
    def db(_session):
        yield SimpleNamespace(get_session=lambda key: rows.get(key))
    monkeypatch.setattr(server, '_session_db', db)
    monkeypatch.setattr(server, '_session_uses_compute_host', lambda s: False)
    def session(key):
        return {'session_key':key,'profile_home':str(tmp_path),'history':[]}
    root = session('root')
    server._start_inflight_turn(root, 'Original')
    inbox = root['user_input_inbox']
    inbox.submit('Correction', message_id='m', turn_id=inbox.turn_id)
    assert server._session_user_input_inbox(session('tip')).status('m')['status'] == 'recoverable'
    assert server._session_user_input_inbox(session('branch')).status('m')['status'] == 'unknown'


def test_compute_parent_cold_resume_reads_child_receipts_without_writing(tmp_path, monkeypatch):
    from tui_gateway import server
    child = {'session_key':'same', 'profile_home':str(tmp_path), 'history':[]}
    parent = dict(child)
    monkeypatch.setattr(server, '_session_uses_compute_host', lambda s: s is parent)
    server._start_inflight_turn(child, 'Original')
    inbox = child['user_input_inbox']
    inbox.submit('Keep correction', message_id='m', turn_id=inbox.turn_id)
    before = inbox.journal_path.read_bytes()
    projected = server._attach_todo_state({}, parent)
    assert projected['inflight']['user_inputs'][0]['content'] == 'Keep correction'
    server._start_inflight_turn(parent, 'Another')
    assert inbox.journal_path.read_bytes() == before


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
