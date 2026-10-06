"""Durable, owner-private Stop/SessionStart handoff for full topical scans.

The hook only records an action and starts an independent one-shot process.
Jobs contain no source or conversation body. An interrupted worker leaves the
job for a later SessionStart; each model attempt has its own audit ledger.
"""
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import uuid

import wiki_topical as topical
import wiki_topical_reconcile as reconcile
import wiki_topical_refresh as refresh

QUEUE = '.topical-hook-jobs'
LOG = 'topical-hook-worker.log'
MAX_JOBS_PER_WAKE = 64


def _spawn_worker(root):
    return subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'worker', str(root)],
        cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)


def _close_worker_lock(fd):
    os.close(fd)


def _atomic(path, value):
    fd, name = tempfile.mkstemp(prefix='.hook-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf8') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _root(value):
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or not topical.opted_in(path):
        raise ValueError('topical_project_not_opted_in')
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('unsafe_topical_project')
    return path.resolve()


def enqueue(root, action, payload=None):
    root = _root(root)
    if action not in ('boundary', 'reconcile'):
        raise ValueError('invalid_topical_hook_action')
    queue = root / QUEUE
    if queue.is_symlink(): raise ValueError('unsafe_topical_queue')
    queue.mkdir(mode=0o700, exist_ok=True)
    if queue.stat().st_uid != os.getuid() or queue.stat().st_mode & 0o077:
        raise ValueError('unsafe_topical_queue')
    job = {'schema': 'topical-hook-job-v1', 'action': action,
           'turnKey': reconcile.turn_key(payload) if action == 'boundary' else 'recovery'}
    _atomic(queue / (uuid.uuid4().hex + '.json'), job)
    # The child owns no hook pipe or terminal. The job is durable even when
    # process creation fails; a later SessionStart enqueues another wake-up.
    _spawn_worker(root)
    return {'status': 'queued'}


def _settings(root):
    path = root / '.topical-reconcile-hook.json'
    if path.is_symlink() or not path.is_file():
        raise ValueError('topical_settings_missing')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) != {'sourceRoots', 'cardsFile', 'trustedCardIds', 'skipPaths'}:
        raise ValueError('invalid_topical_settings')
    card_path = (root / value['cardsFile']).resolve()
    if root not in card_path.parents or (root / value['cardsFile']).is_symlink():
        raise ValueError('topical_cards_outside_project')
    return value, json.loads(card_path.read_text())


def _run(root, job):
    result = None
    settings_path = root / '.topical-reconcile-hook.json'
    if settings_path.is_file():
        settings, cards = _settings(root)
        trusted = settings['trustedCardIds']
        if ((root / '.topical-auto-refresh.json').is_file() or
                any((root / '.auto-context/wiki/topical-v2').glob('*/*.md'))):
            # In the auto path the immutable published sidecars are the card
            # baseline. The opt-in settings file may be intentionally empty or
            # older than a completed create/refresh turn.
            refs, cards = refresh._baseline_cards(root)
            import wiki_topical_publish as publisher
            trusted = []
            for ref in refs:
                try:
                    publisher._attested(root, ref['generationId'], ref['cardId'])
                    trusted.append(ref['cardId'])
                except (OSError, topical.TopicalError):
                    # A stale page stays in the projection but is never trusted.
                    pass
        args = (root, settings['sourceRoots'], cards)
        kw = {'trusted_card_ids': trusted, 'skip_paths': settings['skipPaths'],
              'bootstrap_unclaimed': (root / '.topical-auto-refresh.json').is_file() and not cards}
        if job['action'] == 'boundary':
            reconcile.start_batch(*args, turn_key_value=job['turnKey'], **kw)
        else:
            reconcile.reconcile(*args, **kw)
    elif job['action'] == 'boundary':
        raise ValueError('topical_settings_missing')
    if job['action'] == 'reconcile':
        if (root / '.topical-auto-refresh.json').is_file():
            result = refresh.auto_refresh_pending(root,
                skip_paths=settings['skipPaths'] if settings_path.is_file() else ())
        elif (root / 'topical-refresh-state.json').is_file():
            result = refresh.recover_pending(root)
        elif (root / 'topical-create-state.json').is_file():
            result = {'status': 'pending_review', 'reason': 'auto_teacher_policy_required'}
        else:
            state = reconcile._read(root)
            if state and state['queue'] and not (os.environ.get('QMD_TOPICAL_FAKE_AUTODRAIN') == '1'
                                              and (root / '.qmd-topical-fake-only').is_file()):
                result = {'status': 'pending_review', 'reason': 'auto_teacher_policy_required'}
    if (os.environ.get('QMD_TOPICAL_FAKE_AUTODRAIN') == '1'
            and (root / '.qmd-topical-fake-only').is_file()):
        fake_log = root / 'topical-fake-worker.log'
        with fake_log.open('a') as out:
            subprocess.Popen([sys.executable,
                str(Path(__file__).with_name('wiki_topical_fake_turn_worker.py')),
                '--root', str(root)], cwd=root, stdin=subprocess.DEVNULL,
                stdout=out, stderr=subprocess.STDOUT, close_fds=True,
                start_new_session=True)
    return result


def worker(root):
    root = _root(root)
    queue = root / QUEUE
    lock = queue / '.worker.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    acquired = False
    attempted = set()
    try:
        if os.fstat(fd).st_uid != os.getuid() or os.fstat(fd).st_mode & 0o077:
            raise ValueError('unsafe_topical_worker_lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            return
        log = root / LOG
        if log.is_symlink(): raise ValueError('unsafe_topical_worker_log')
        if log.is_file() and log.stat().st_size > 1024 * 1024:
            os.replace(log, root / (LOG + '.1'))
        with log.open('a', encoding='utf8') as output:
            os.chmod(log, 0o600)
            # Rescan while holding the lock. Children launched during _run may
            # lose LOCK_NB; their jobs still belong to this worker's wake.
            while len(attempted) < MAX_JOBS_PER_WAKE:
                batch = [path for path in sorted(queue.glob('*.json'))
                         if path.name not in attempted]
                if not batch:
                    break
                for path in batch[:MAX_JOBS_PER_WAKE-len(attempted)]:
                    attempted.add(path.name)
                    result = None
                    try:
                        if path.is_symlink() or path.stat().st_size > 4096: raise ValueError('unsafe_topical_job')
                        job = json.loads(path.read_text())
                        if (not isinstance(job, dict) or set(job) != {'schema', 'action', 'turnKey'}
                                or job['schema'] != 'topical-hook-job-v1'
                                or job['action'] not in ('boundary', 'reconcile')):
                            raise ValueError('invalid_topical_job')
                        result = _run(root, job)
                        path.unlink()
                        outcome = 'completed'
                    except Exception as exc:
                        outcome = 'failed:' + type(exc).__name__ + ':' + str(exc)[:120]
                    _atomic(root / 'topical-hook-status.json', {'schema': 'topical-hook-status-v1',
                        'job': path.name, 'status': outcome, 'result': result if outcome == 'completed' else None,
                        'at': time.time()})
                    output.write(f'{time.time():.3f} {path.name} {outcome}\n'); output.flush()
    finally:
        _close_worker_lock(fd)
    if acquired:
        # Close-before-check closes the final-scan race: an enqueue between
        # that scan and unlock can launch a child that loses LOCK_NB. A new
        # unattempted job gets one successor wake; failed old jobs do not loop.
        remaining = [path for path in queue.glob('*.json') if path.name not in attempted]
        if remaining:
            _atomic(root / 'topical-hook-status.json', {'schema': 'topical-hook-status-v1',
                'job': None, 'status': 'queued', 'pending': len(remaining), 'at': time.time()})
            _spawn_worker(root)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == 'worker':
            worker(sys.argv[2])
        elif len(sys.argv) == 3 and sys.argv[1] in ('boundary', 'reconcile'):
            payload = json.load(sys.stdin) if sys.argv[1] == 'boundary' else None
            enqueue(sys.argv[2], sys.argv[1], payload)
        else:
            raise SystemExit(2)
    except BaseException as exc:
        # A worker or enqueue can fail before entering its per-job handler.
        # Preserve a visible failure in the opted-in, owner-private project.
        if len(sys.argv) == 3 and sys.argv[1] in ('worker', 'boundary', 'reconcile'):
            try:
                root = _root(sys.argv[2])
                log = root / LOG
                if log.is_symlink(): raise ValueError('unsafe_topical_worker_log')
                if log.is_file() and log.stat().st_size > 1024 * 1024:
                    os.replace(log, root / (LOG + '.1'))
                phase = 'worker' if sys.argv[1] == 'worker' else 'enqueue'
                with log.open('a', encoding='utf8') as output:
                    os.chmod(log, 0o600)
                    output.write(f'{time.time():.3f} {phase} failed:{type(exc).__name__}\n')
                _atomic(root / 'topical-hook-status.json', {'schema': 'topical-hook-status-v1',
                    'job': None, 'status': phase + '_failed', 'at': time.time()})
            except BaseException:
                pass
        raise SystemExit(1)
