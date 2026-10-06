"""Synthetic source mutation/deletion and uncertain CLI attempt via the real hook."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

QMD = Path(os.environ.get('QMD_PUBLISH_E2E_QMD_BIN',
    shutil.which('qmd') or '/Users/dulee/work/.qmd-tools/bin/qmd'))
if not QMD.is_file():
    print(json.dumps({'skipped': 'QMD CLI unavailable'})); raise SystemExit(0)
teacher = Path.cwd() / 'test/fixtures/wiki-topical-approved-fake-teacher.py'

def setup(root):
    (root / '.qmd-topical-sandbox').write_text('synthetic\n')
    (root / '.qmd-topical-fake-only').write_text('synthetic\n')
    (root / 'sources').mkdir()
    (root / '.auto-context/wiki').mkdir(parents=True)
    (root / '.auto-context/settings.json').write_text(json.dumps({
        'indexing': True, 'collections': ['synthetic-create'],
        'collectionPaths': {'synthetic-create': '.auto-context/wiki'},
        'collectionRoles': {'synthetic-create': 'wiki'}, 'recallStrategy': 'wikiOnly'}))
    (root / 'cards.json').write_text('[]\n')
    (root / '.topical-reconcile-hook.json').write_text(json.dumps({
        'sourceRoots': ['sources'], 'cardsFile': 'cards.json',
        'trustedCardIds': [], 'skipPaths': []}))
    cfg = {'extractor': {'backends': {'codex': [sys.executable, str(teacher)]}},
           'verify': {'backends': {'codex': [sys.executable, str(teacher)]},
                      'crossEngine': 'off'}}
    auto = root / '.topical-auto-refresh.json'
    auto.write_text(json.dumps({'schema':'qmd-topical-auto-refresh-v1','enabled':True,
        'sourceRoots':['sources'],'engine':'codex','compileCfg':cfg,'maxEstimatedCents':30}))
    auto.chmod(0o600)
    (root / 'qmd-config').mkdir(); (root / 'qmd-db').mkdir(); (root / 'qmd-cache').mkdir()
    return {**os.environ, 'QMD_TOPICAL_PROJECT_ROOT': str(root),
        'QMD_TOPICAL_SYNTHETIC_RUNTIME': '1', 'QMD_BIN': str(QMD),
        'INDEX_PATH': str(root / 'qmd-db/index.sqlite'),
        'QMD_CONFIG_DIR': str(root / 'qmd-config'),
        'XDG_CACHE_HOME': str(root / 'qmd-cache')}

def hook(env):
    subprocess.run(['bash','hooks/run-hook','topical-reconcile','codex'],
        input='',text=True,capture_output=True,env=env,timeout=3,check=True)

def wait_jobs(root, limit=20):
    queue = root / '.topical-hook-jobs'
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        if queue.is_dir() and not list(queue.glob('*.json')):
            return json.loads((root / 'topical-hook-status.json').read_text())
        time.sleep(.03)
    raise AssertionError('hook job did not finish')

with tempfile.TemporaryDirectory(prefix='qmd-create-races-') as base:
    for action in ('modify', 'delete'):
        root = Path(base, action).resolve(); root.mkdir()
        env = setup(root)
        source = root / 'sources/new.md'
        source.write_text('Initial synthetic rule.\n')
        env['QMD_SYNTHETIC_TEACHER_CHANGE_SOURCE'] = action
        # Opt-in starts with a source already present: bootstrap must not
        # silently mark it settled before any card is created.
        hook(env); result = wait_jobs(root)
        assert result['result']['status'] == 'pending_review', result
        assert not list((root / '.auto-context/wiki').glob('topical-v2/*/*.md'))
        hook(env); result = wait_jobs(root)
        assert result['result']['status'] == 'superseded_source_changed', result
        state = json.loads((root / 'topical-reconcile-state.json').read_text())
        assert state['inFlight'] is None and not (root / 'topical-create-state.json').exists()
        if action == 'modify':
            assert state['queue']['sources/new.md']['currentSha256']
        else:
            assert not source.exists() and not state['queue']
        calls = (root / 'fake-teacher-calls.jsonl').read_text().splitlines()
        assert len(calls) == 1
    root = Path(base, 'uncertain').resolve(); root.mkdir()
    env = setup(root)
    hook(env); wait_jobs(root)
    (root / 'sources/new.md').write_text('Initial synthetic rule.\n')
    env['QMD_SYNTHETIC_TEACHER_WAIT'] = '1'
    hook(env)
    deadline = time.monotonic()+10
    marker = root / '.fake-teacher-pids'
    while time.monotonic()<deadline and not marker.exists(): time.sleep(.03)
    assert marker.exists()
    pids = json.loads(marker.read_text())
    os.kill(pids['worker'], signal.SIGKILL)
    os.kill(pids['child'], signal.SIGKILL)
    env.pop('QMD_SYNTHETIC_TEACHER_WAIT')
    hook(env); result = wait_jobs(root)
    assert result['result'] == {'status':'pending_review',
                                'reason':'generation_attempt_reserved'}, result
    calls = (root / 'fake-teacher-calls.jsonl').read_text().splitlines()
    assert len(calls) == 1
    assert not list((root / '.auto-context/wiki').glob('topical-v2/*/*.md'))
    print(json.dumps({'modifiedSuperseded':True,'deletedSuperseded':True,
        'uncertainNotRetried':True,'externalTeacherCalls':0}))
