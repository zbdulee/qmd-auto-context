"""Synthetic-only CLI transport for the real v2 backend entrypoint tests."""
import json
import os
from pathlib import Path
import sys
import time

root = Path.cwd()
if not (root / '.qmd-topical-fake-only').is_file():
    raise SystemExit(2)
payload = json.load(sys.stdin)
with (root / 'fake-teacher-calls.jsonl').open('a') as output:
    output.write(json.dumps({'task': payload['task']}) + '\n')
if payload['task'] == 'generate_topical_candidates_sandbox_only':
    source = payload['sources'][0]
    path = source['path']
    first = next(line for line in (root / path).read_text().splitlines() if line.strip())
    stem = Path(path).stem
    result = {'schema': payload['outputSchema'], 'cards': [{
        'cardId': 'synthetic-' + stem, 'title': 'Synthetic ' + stem,
        'category': 'world-rule', 'details': '',
        'claims': [{'claimId': 'fact', 'statement': first, 'state': 'rule',
                    'timeScope': 'synthetic-current', 'condition': '',
                    'evidence': [{'sourcePath': path, 'startLine': 1,
                                  'endLine': 1, 'quoteAnchor': first}]}]}]}
elif payload['task'] == 'verify_topical_claims_sandbox_only':
    checks = [{'claimId': claim['claimId'], 'sourcePath': span['sourcePath'],
               'quoteSha256': span['quoteSha256'], 'quoteAnchor': span['quoteAnchor'],
               'supported': True} for claim in payload['card']['claims']
              for span in claim['evidence']]
    result = {'verdict': 'pass', 'checks': checks, 'reasons': []}
else:
    raise SystemExit(2)
if os.environ.get('QMD_SYNTHETIC_TEACHER_FAIL_ONCE') == '1':
    marker = root / '.fake-teacher-failed-once'
    if not marker.exists():
        marker.write_text('synthetic failure')
        raise SystemExit(7)
if payload['task'] == 'generate_topical_candidates_sandbox_only':
    action = os.environ.get('QMD_SYNTHETIC_TEACHER_CHANGE_SOURCE')
    marker = root / '.fake-source-changed-once'
    if action in ('modify', 'delete') and not marker.exists():
        marker.write_text(action)
        source_file = root / payload['sources'][0]['path']
        if action == 'modify': source_file.write_text('Revised synthetic rule.\n')
        else: source_file.unlink()
    if os.environ.get('QMD_SYNTHETIC_TEACHER_WAIT') == '1':
        (root / '.fake-teacher-pids').write_text(json.dumps({
            'worker': os.getppid(), 'child': os.getpid()}))
        time.sleep(15)
print(json.dumps(result))
