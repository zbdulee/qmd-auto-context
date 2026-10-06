"""Synthetic cross-process compile/verify wiki writer lock contract."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path.cwd() / 'core'))
import wiki_compile as wc
import wiki_mutation_lock as wl

with tempfile.TemporaryDirectory(prefix='qmd-wiki-mutation-lock-') as temporary:
    root = Path(temporary)
    wiki = root / '.auto-context/wiki'
    wiki.mkdir(parents=True)
    index = wiki / 'index.md'
    index.write_text('before\n')
    card = wiki / 'card.md'
    card.write_text('---\ntitle: Synthetic\nstatus: generated\n---\nSynthetic body.\n')
    child = '''import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import wiki_compile as wc
Path(sys.argv[3]).write_text('started')
path=Path(sys.argv[2])
if sys.argv[4]=='compile':
 assert wc.write_text_atomic(path,'after\\n')
else:
 assert wc.stamp_verification(path,'verified','synthetic','self',None)
'''
    for action, path, before in (
        ('compile', index, 'before\n'),
        ('verify', card, card.read_text()),
    ):
        marker = root / (action + '.started')
        with wl.lock(root):
            proc = subprocess.Popen([sys.executable, '-c', child,
                str(Path.cwd() / 'core'), str(path), str(marker), action],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            assert marker.exists()
            time.sleep(.1)
            assert proc.poll() is None and path.read_text() == before
        out, err = proc.communicate(timeout=5)
        assert proc.returncode == 0, (out, err)
        if action == 'compile': assert path.read_text() == 'after\n'
        else: assert 'status: verified' in path.read_text()
    # A high-level writer may call the atomic helper while already holding the
    # same project lock; this must reuse the local fd rather than self-deadlock.
    with wl.lock(root):
        assert wc.write_text_atomic(path=index, text='nested\n')
        assert wc.stamp_verification(path=card, status='contested', engine='synthetic', mode='self', body_hash=None)
    assert index.read_text() == 'nested\n'
    assert 'status: contested' in card.read_text()
    init_root = root / 'init-project'
    init_root.mkdir()
    init_env = {**os.environ, 'HOME': str(root / 'isolated-home'),
                'QMD_BACKEND_STATE_DIR': str(root / 'backend-state'),
                'QMD_DAEMON_PID': str(root / 'backend-state/daemon.pid'),
                'QMD_BACKEND_LOG': str(root / 'backend-manager.log')}
    Path(init_env['HOME']).mkdir()
    with wl.lock(init_root):
        init = subprocess.Popen(['bash', 'core/update.sh', '--init-wiki', str(init_root)],
            cwd=Path.cwd(), env=init_env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        time.sleep(.35)
        assert init.poll() is None
        assert not (init_root / '.auto-context/wiki/SCHEMA.md').exists()
        assert not (init_root / '.auto-context/settings.json').exists()
    out, err = init.communicate(timeout=10)
    assert init.returncode == 0, (out, err)
    assert (init_root / '.auto-context/wiki/SCHEMA.md').is_file()
    assert (init_root / '.auto-context/settings.json').is_file()
    opt_root = root / 'optin-project'
    opt_root.mkdir()
    with wl.lock(opt_root):
        opt = subprocess.Popen(['bash', 'core/update.sh', '--optin', str(opt_root)],
            cwd=Path.cwd(), env=init_env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        time.sleep(.25)
        assert opt.poll() is None
        assert not (opt_root / '.auto-context/settings.json').exists()
    out, err = opt.communicate(timeout=10)
    assert opt.returncode == 0, (out, err)
    assert (opt_root / '.auto-context/settings.json').is_file()
    with wl.lock(init_root):
        enable = subprocess.Popen(['bash', 'core/update.sh', '--enable-compile', str(init_root)],
            cwd=Path.cwd(), env=init_env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        time.sleep(.25)
        assert enable.poll() is None
        assert 'compile' not in json.loads((init_root / '.auto-context/settings.json').read_text())
    out, err = enable.communicate(timeout=10)
    assert enable.returncode == 0, (out, err)
    assert 'compile' in json.loads((init_root / '.auto-context/settings.json').read_text())
    print(json.dumps({'compileBlocked': True, 'verifyBlocked': True,
                      'initWikiBlocked': True, 'optinBlocked': True,
                      'enableCompileBlocked': True, 'nestedLockReentrant': True}))
