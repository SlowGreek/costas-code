from concurrent.futures import ThreadPoolExecutor
import threading
from agent.pending_user_input import UserInputInbox


def test_concurrent_duplicate_ids_commit_once():
    inbox = UserInputInbox()
    inbox.begin('turn')
    with ThreadPoolExecutor(max_workers=8) as pool:
        receipts = list(pool.map(lambda _: inbox.submit('Correction', message_id='same', turn_id='turn'), range(64)))
    assert all(r['status'] == 'pending' for r in receipts)
    messages = []
    inbox.commit(messages)
    inbox.commit(messages)
    assert len(messages) == 1
    assert inbox.status('same')['status'] == 'committed'


def test_stop_submission_race_has_no_pending_or_resurrection():
    for _ in range(32):
        inbox = UserInputInbox()
        inbox.begin('old')
        barrier = threading.Barrier(2)
        def stop():
            barrier.wait()
            inbox.close(cancelled=True)
        thread = threading.Thread(target=stop)
        thread.start()
        barrier.wait()
        inbox.submit('Old work', message_id='m', turn_id='old')
        thread.join(2)
        assert not thread.is_alive()
        assert all(i['status'] == 'cancelled' for i in inbox.snapshot())
        inbox.begin('new')
        assert inbox.submit('Late', message_id='late', turn_id='old')['status'] == 'stale'
        messages = []
        inbox.commit(messages)
        assert messages == []


def test_acceptance_copies_multimodal_payload_and_preserves_fifo():
    inbox = UserInputInbox()
    inbox.begin('turn')
    payload = [{'type': 'text', 'text': 'Original'}, {'type': 'image_url', 'image_url': {'url': 'image'}}]
    inbox.submit(payload, message_id='a', turn_id='turn')
    payload[1]['image_url']['url'] = 'mutated'
    inbox.submit('Second', message_id='b', turn_id='turn')
    messages = []
    inbox.commit(messages)
    assert [m['display_metadata']['steering']['message_id'] for m in messages] == ['a', 'b']
    assert messages[0]['content'][1]['image_url']['url'] == 'image'


def test_workflow_wait_wakes_without_stopping_workflow():
    from agent.workflow_manager import WorkflowRun
    from agent.pending_user_input import current_inbox
    run = object.__new__(WorkflowRun)
    run._done = threading.Event()
    inbox = UserInputInbox()
    inbox.begin('turn')
    entered, returned = threading.Event(), threading.Event()
    result = []
    def wait():
        token = current_inbox.set(inbox)
        entered.set()
        try:
            result.append(run.wait(5))
            returned.set()
        finally:
            current_inbox.reset(token)
    worker = threading.Thread(target=wait)
    worker.start()
    try:
        assert entered.wait(2)
        inbox.submit('Correction', message_id='m', turn_id='turn')
        assert returned.wait(2), 'Workflow wait did not yield to pending input'
        assert result == [False]
        assert not run.finished
    finally:
        run._done.set()
        worker.join(6)


def test_idle_transition_is_atomic_with_submission():
    inbox = UserInputInbox()
    inbox.begin('turn')
    inbox.submit('Correction', message_id='m', turn_id='turn')
    assert not inbox.finish_if_empty()
    inbox.commit([])
    assert inbox.finish_if_empty()
    assert inbox.submit('Too late', message_id='late', turn_id='turn')['status'] == 'stale'
