from copy import deepcopy
from agent.context_compressor import ContextCompressor, SUMMARY_PREFIX, _SUMMARY_END_MARKER


def test_merged_inflight_image_and_identity_survive_repeated_compaction():
    compressor = object.__new__(ContextCompressor)
    compressor.quiet_mode = True
    image = {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,aGVsbG8='}}
    metadata = {'steering': {'message_id': 'image-steer', 'turn_id': 'turn', 'status': 'committed'}}
    inflight = {'role': 'user', 'content': [{'type': 'text', 'text': 'Use this image'}, image], 'display_metadata': metadata}
    original = deepcopy(inflight)
    for _ in range(2):
        carrier = {'role': 'user', 'content': SUMMARY_PREFIX + '\nSummary\n' + _SUMMARY_END_MARKER, '_compressed_summary': True}
        compressed = [carrier, {'role': 'assistant', 'tool_calls': [{'id': 'a', 'function': {'name': 'terminal', 'arguments': '{}'}}]}, {'role': 'tool', 'tool_call_id': 'a', 'content': 'done'}]
        result = compressor._reappend_inflight_user_task(compressed, inflight)
        blocks = result[0]['content']
        assert isinstance(blocks, list), 'Merging onto a summary must not discard image parts'
        assert sum(p == image for p in blocks) == 1
        assert result[0]['display_metadata']['steering'] == metadata['steering']
        inflight = ContextCompressor._find_inflight_user_task(result)
        assert inflight is not None
    assert original['content'][1] == image
