"""Copilot rotates opaque item IDs between events; call_id/index stay stable.

Reduced from a live gpt-6-astra Copilot stream captured 2026-09-08.
One announced call plus one done item must dispatch exactly once.
"""
from types import SimpleNamespace as NS

from agent.codex_runtime import _consume_codex_event_stream
from agent.transports.codex import ResponsesApiTransport


def stream(*, done=True):
    events = [
        NS(type='response.output_item.added', output_index=0,
           item=NS(type='function_call', id='opaque-added', call_id='call_1',
                   name='inspect', arguments='', status='in_progress')),
        NS(type='response.function_call_arguments.delta', item_id='opaque-delta',
           output_index=0, delta='{"label":"CHECK"}'),
        NS(type='response.function_call_arguments.done', item_id='opaque-args-done',
           output_index=0, arguments='{"label":"CHECK"}'),
    ]
    if done:
        events.append(NS(type='response.output_item.done', output_index=0,
                         item=NS(type='function_call', id='opaque-done',
                                 call_id='call_1', name='inspect',
                                 arguments='{"label":"CHECK"}', status='completed')))
    events.append(NS(type='response.completed', response=NS(id='resp_1', status='completed')))
    return events


def test_rotating_item_ids_dispatch_completed_call_once():
    final = _consume_codex_event_stream(stream(), model='gpt-6-astra')
    calls = ResponsesApiTransport().normalize_response(final).tool_calls
    assert calls is not None
    assert [(c.id, c.name, c.arguments) for c in calls] == [
        ('call_1', 'inspect', '{"label":"CHECK"}')
    ]
    assert final.output[0].id == 'opaque-done'


def test_rotating_argument_ids_without_item_done_keep_arguments():
    final = _consume_codex_event_stream(stream(done=False), model='gpt-6-astra')
    assert len(final.output) == 1
    assert final.output[0].arguments == '{"label":"CHECK"}'


def test_rotating_done_without_index_keeps_announced_order():
    events = stream()
    del events[-2].output_index
    events.insert(-2, NS(type='response.output_item.added',
                        item=NS(type='function_call', id='second', call_id='call_2',
                                name='inspect', arguments='{"label":"SECOND"}')))
    final = _consume_codex_event_stream(events, model='gpt-6-astra')
    assert [c.call_id for c in final.output] == ['call_1', 'call_2']


def test_distinct_calls_with_identical_arguments_survive():
    events = stream()
    second = stream()
    for event in second[:-1]:
        event.output_index = 1
        if hasattr(event, 'item'):
            event.item.id += '-second'
            event.item.call_id = 'call_2'
    final = _consume_codex_event_stream(events[:-1] + second, model='gpt-6-astra')
    assert [c.call_id for c in final.output] == ['call_1', 'call_2']


def test_ambiguous_output_index_does_not_attach_arguments_to_wrong_call():
    events = stream(done=False)
    events.insert(1, NS(type='response.output_item.added', output_index=0,
                        item=NS(type='function_call', id='second', call_id='call_2',
                                name='inspect', arguments='')))
    final = _consume_codex_event_stream(events, model='gpt-6-astra')
    assert [c.arguments for c in final.output] == ['{}', '{}']


def test_normalized_call_id_collision_guard_updates_canonical_metadata():
    from agent.transports.types import ToolCall
    from agent.message_sanitization import uniquify_tool_call_ids

    calls = [ToolCall(id='call_same', name='inspect', arguments=args,
                      provider_data={'call_id': 'call_same', 'response_item_id': item})
             for args, item in [('{"label":"A"}', 'fc_A'), ('{"label":"B"}', 'fc_B')]]
    uniquify_tool_call_ids(calls)
    assert [c.id for c in calls] == ['call_same', 'call_same_d2']
    assert [c.call_id for c in calls] == ['call_same', 'call_same_d2']
    assert [c.response_item_id for c in calls] == ['fc_A', 'fc_B']
