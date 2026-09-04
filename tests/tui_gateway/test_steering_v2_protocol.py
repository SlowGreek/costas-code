"""Protocol boundaries of Steering v2 (real registered gateway methods)."""
from types import SimpleNamespace
import threading
import pytest
from agent.pending_user_input import UserInputInbox


@pytest.fixture
def live():
    from tui_gateway import server
    sid = 'steering-v2-protocol'
    inbox = UserInputInbox()
    session = {'session_key': sid, 'agent': SimpleNamespace(api_mode='chat_completions'), 'running': True, 'history': [], 'history_lock': threading.RLock(), 'attached_images': [], 'user_input_inbox': inbox}
    server._sessions[sid] = session
    server._start_inflight_turn(session, 'original')
    def call(**kwargs):
        return server._methods['session.input'](1, {'session_id': sid, 'message_id': 'm', 'turn_id': inbox.turn_id, 'text': 'correction', **kwargs})
    try:
        yield server, sid, session, inbox, call
    finally:
        server._sessions.pop(sid, None)


def test_duplicate_id_with_changed_payload_is_conflict(live):
    _, _, _, inbox, call = live
    assert call()['result']['status'] == 'pending'
    assert call(text='different correction')['result']['status'] == 'conflict'
    assert len(inbox.snapshot()) == 1


def test_native_codex_uses_native_protocol_once(live):
    _, _, session, inbox, call = live
    sent = []
    session['agent'] = SimpleNamespace(api_mode='codex_app_server', redirect=lambda content: sent.append(content) or True)
    assert call()['result']['status'] == 'accepted'
    assert call()['result']['status'] == 'accepted'
    assert sent == ['correction']
    assert inbox.snapshot()[0]['status'] == 'accepted'


def test_cli_steer_uses_native_codex_protocol(live):
    from run_agent import AIAgent
    _, _, _, inbox, _ = live
    agent = object.__new__(AIAgent)
    calls = []
    agent.api_mode = 'codex_app_server'
    agent._interrupt_requested = False
    agent._user_input_inbox = inbox
    agent._codex_session = SimpleNamespace(request_steer=lambda text: calls.append(text) or True)
    assert agent.steer('native correction') is True
    assert calls == ['native correction']
    assert not any(item['status'] == 'pending' for item in inbox.snapshot())


def test_stop_during_build_cancels_pending_and_never_reopens(live):
    server, sid, session, inbox, call = live
    session['agent'] = None
    assert call()['result']['status'] == 'pending'
    server._interrupt_session_turn(sid, session)
    assert inbox.status('m')['status'] == 'cancelled'
    assert call()['result']['status'] == 'cancelled'
    assert call(message_id='later')['result']['status'] == 'stale'


def test_stale_turn_does_not_drain_images(live):
    _, _, session, _, call = live
    session['attached_images'] = ['staged.png']
    assert call(turn_id='old')['result']['status'] == 'stale'
    assert session['attached_images'] == ['staged.png']


def test_unreadable_image_is_rejected_without_losing_staging(live):
    _, _, session, _, call = live
    session['attached_images'] = ['missing-steering-v2-image.png']
    result = call()
    assert result.get('error'), 'Unreadable attachments must not silently become text-only input'
    assert session['attached_images'] == ['missing-steering-v2-image.png']


def test_image_staging_does_not_block_stop_or_cross_turn(live, monkeypatch, tmp_path):
    server, sid, session, _, call = live
    session['agent'].hard_interrupt = lambda *a, **k: None
    image = tmp_path / 'image.png'
    image.write_bytes(b'image fixture handled by the staging seam')
    entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
    outcomes = []
    def stage(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return 'resolved image'
    monkeypatch.setattr(server, '_redirect_payload_with_images', stage)
    submitter = threading.Thread(target=lambda: outcomes.append(call(images=[str(image)])))
    stopper = threading.Thread(target=lambda: (server._interrupt_session_turn(sid, session), stopped.set()))
    submitter.start()
    try:
        assert entered.wait(2)
        stopper.start()
        assert stopped.wait(2), 'Image enrichment held the session lock and blocked Stop'
    finally:
        release.set()
        submitter.join(5)
        if stopper.ident: stopper.join(5)
    assert outcomes[0]['result']['status'] == 'stale'


def test_compute_host_receipts_follow_the_child_turn(live, monkeypatch):
    from tui_gateway.compute_host import ComputeHost
    from tui_gateway.host_supervisor import HostSupervisor
    import io
    server, sid, parent, parent_inbox, _ = live
    child_inbox = UserInputInbox()
    child_inbox.begin('child-turn')
    child = {**parent, 'user_input_inbox': child_inbox, 'history_lock': threading.RLock()}
    host = ComputeHost(stdout=io.StringIO(), heartbeat_secs=0, max_workers=1)
    supervisor = object.__new__(HostSupervisor)
    supervisor._lock = threading.RLock()
    supervisor._pending_controls = {}
    supervisor.start = lambda: None
    host.emit = lambda frame: supervisor._pending_controls[frame['request_id']].put(frame)
    def send_frame(frame):
        server._sessions[sid] = child
        try:
            host.handle_frame(frame)
        finally:
            server._sessions[sid] = parent
    supervisor._send_frame = send_frame
    monkeypatch.setattr(server, '_session_uses_compute_host', lambda session, *a, **k: session is parent)
    monkeypatch.setattr(server, '_get_compute_host_supervisor', lambda *a, **k: supervisor)
    try:
        status = server._methods['session.input.status'](1, {'session_id': sid})['result']
        assert status['turn_id'] == 'child-turn'
        receipt = server._methods['session.input'](2, {'session_id': sid, 'turn_id': status['turn_id'], 'message_id': 'host-input', 'text': 'child correction'})['result']
        assert receipt['status'] == 'pending'
        assert child_inbox.snapshot()[0]['content'] == 'child correction'
        assert parent_inbox.snapshot() == []
    finally:
        host.close()


def test_legacy_rpc_does_not_duplicate_identified_input_on_resume(live):
    from run_agent import AIAgent
    server, sid, session, inbox, _ = live
    agent = object.__new__(AIAgent)
    agent._interrupt_requested = False
    agent.api_mode = 'chat_completions'
    agent._user_input_inbox = inbox
    session['agent'] = agent
    result = server._methods['session.steer'](1, {'session_id': sid, 'text': 'correction'})
    assert result['result']['status'] == 'queued'
    snapshot = server._inflight_snapshot(session)
    assert len(snapshot['user_inputs']) == 1
    assert not snapshot.get('corrections'), 'The legacy mirror must not paint the same steer twice'


def test_control_prompts_are_not_answered_by_steering(live):
    server, sid, session, _, call = live
    before = dict(server._answers)
    event = threading.Event()
    session['approval_event'] = event
    session['clarify_event'] = event
    assert call(text='approve')['result']['status'] == 'pending'
    assert not event.is_set()
    assert server._answers == before


@pytest.mark.parametrize('mid', [[], {}, '', 42])
def test_status_rejects_malformed_id(live, mid):
    server, sid, _, _, _ = live
    response = server._methods['session.input.status'](1, {'session_id': sid, 'message_id': mid})
    assert response.get('error')
