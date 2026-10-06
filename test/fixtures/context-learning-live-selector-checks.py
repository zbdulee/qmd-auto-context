"""Synthetic selector protocol: full body, active pointer, 0-card and failure fallback."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, 'core')
from context_learning import live_select
from context_learning.contracts import digest

with tempfile.TemporaryDirectory(prefix='qmd-live-selector-') as temporary:
    state = Path(temporary).resolve()
    state.chmod(0o700)
    artifact = state / 'head.artifact'
    artifact.write_text('synthetic local head')
    artifact.chmod(0o600)
    def private(path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)
    private(state / 'active-checkpoint.json', {
        'schema_version': 1, 'artifact_path': str(artifact),
        'artifact_sha256': hashlib.sha256(artifact.read_bytes()).hexdigest()})
    adapter = Path('core/context_learning/laya_adapter.py').resolve()
    private(state / 'live-selector.json', {
        'schema': 'qmd-live-selector-v1',
        'trainerArgv': [sys.executable, str(adapter), str(state)],
        'timeoutSeconds': 5, 'maxRssMib': 512})
    source = '---\ntitle: Synthetic\nstatus: verified\n---\nFull synthetic body line.\n'
    rows = [{'id': 'wiki/card.md', 'revision_sha256': digest(source),
             'source_text': source}]
    observed = []
    class StubTrainer:
        def __init__(self, argv, **kwargs):
            assert argv[1] == str(adapter)
        def call(self, mode, request, output, *, cwd):
            assert mode == 'predict'
            case = request['cases'][0]
            observed.append(case['candidates'][0]['input_text'])
            if behavior == 'timeout': raise ValueError('trainer_timeout')
            selected = ['wiki/card.md'] if behavior == 'select' else [] if behavior == 'zero' else ['unknown']
            return {'schema_version': 1, 'predictions': [{
                'request_id': case['request_id'], 'input_sha256': case['input_sha256'],
                'selected_ids': selected}]}, {'elapsed_seconds': .1}
    live_select.VerifiedLayaTrainer = StubTrainer
    for behavior, expected, reason in (
            ('select', ['wiki/card.md'], 'selected'),
            ('zero', [], 'selected'),
            ('invalid', None, 'invalid_prediction'),
            ('timeout', None, 'timeout')):
        ids, actual, _ = live_select.choose(state, 'Synthetic user request', rows,
                                           corpus_fingerprint='a' * 64)
        assert ids == expected and actual == reason, (ids, actual)
    assert observed and all(body == 'Full synthetic body line.\n' for body in observed)
    artifact.write_text('changed artifact')
    assert live_select.choose(state, 'Synthetic user request', rows,
                              corpus_fingerprint='a' * 64)[1] == 'checkpoint_changed'
    assert live_select.choose(state, 'Synthetic user request', rows,
                              corpus_fingerprint=None)[1] == 'corpus_unavailable'
    print(json.dumps({'fullBodyInput': True, 'rankedSelection': True,
                      'semanticZero': True, 'invalidOutputFallback': True,
                      'timeoutFallback': True, 'checkpointPin': True,
                      'corpusGate': True, 'externalCalls': 0}))
