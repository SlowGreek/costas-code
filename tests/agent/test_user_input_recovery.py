"""Durable acceptance must survive a backend restart without replaying work."""
from agent.pending_user_input import UserInputInbox


def test_pending_input_recovers_as_reviewable_not_automatically_replayed(tmp_path):
    journal = tmp_path / 'input.json'
    inbox = UserInputInbox(journal_path=journal)
    inbox.begin('old-turn')
    inbox.submit('Use staging', message_id='m', turn_id='old-turn', request_key='request')
    restored = UserInputInbox(journal_path=journal)
    assert restored.status('m')['status'] == 'recoverable'
    assert restored.recovered_inputs()[0]['content'] == 'Use staging'
    restored.begin('new-turn')
    messages = []
    restored.commit(messages)
    assert messages == []
    assert restored.retry_receipt('m', 'old-turn', 'request')['status'] == 'recoverable'


def test_commit_interrupted_before_history_flush_remains_recoverable(tmp_path):
    journal = tmp_path / 'input.json'
    inbox = UserInputInbox(journal_path=journal)
    inbox.begin('turn')
    inbox.submit('Keep it', message_id='m', turn_id='turn')
    messages = []
    inbox.commit(messages)
    assert UserInputInbox(journal_path=journal).status('m')['status'] == 'recoverable'
    reconciled = UserInputInbox(journal_path=journal, history=messages)
    assert reconciled.status('m')['status'] == 'committed'
    assert reconciled.recovered_inputs() == []


def test_stop_and_journal_failure_never_acknowledge_pending_input(tmp_path):
    journal = tmp_path / 'input.json'
    inbox = UserInputInbox(journal_path=journal)
    inbox.begin('turn')
    inbox.submit('Cancel it', message_id='m', turn_id='turn')
    inbox.close(cancelled=True)
    assert UserInputInbox(journal_path=journal).status('m')['status'] == 'cancelled'


def test_identified_inputs_survive_live_history_normalization(tmp_path):
    from types import SimpleNamespace
    from agent.agent_runtime_helpers import repair_message_sequence
    journal = tmp_path / 'input.json'
    inbox = UserInputInbox(journal_path=journal)
    inbox.begin('turn')
    inbox.submit('First', message_id='a', turn_id='turn')
    inbox.submit('Second', message_id='b', turn_id='turn')
    messages = []
    inbox.commit(messages)
    repair_message_sequence(SimpleNamespace(), messages)
    restored = UserInputInbox(journal_path=journal, history=messages)
    assert restored.status('a')['status'] == 'committed'
    assert restored.status('b')['status'] == 'committed'
    assert [m['content'] for m in messages] == ['First', 'Second']


def test_journal_symlink_is_rejected(tmp_path):
    import pytest
    target = tmp_path / 'other'
    target.write_text('{}')
    link = tmp_path / 'input.json'
    link.symlink_to(target)
    with pytest.raises(ValueError):
        UserInputInbox(journal_path=link)
