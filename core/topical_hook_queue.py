"""Durable, owner-private Stop processing with SessionStart recovery.

The hook records an action and starts an independent one-shot process. Stop
workers scan, refresh, and publish when an approved auto policy is present.
Jobs contain no source or conversation body. An interrupted worker leaves a
job for later recovery; each model attempt has its own audit ledger.
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
import topical_stop_budget as stop_budget
import wiki_topical_refresh as refresh

QUEUE = '.topical-hook-jobs'
LOG = 'topical-hook-worker.log'
MAX_JOBS_PER_WAKE = 64
MAX_AUTO_STEPS_PER_JOB = 12
MAX_AUTO_ESTIMATED_CENTS_PER_JOB = 640


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


def _auto_policy(root):
    try:
        return refresh.read_auto_policy(root), None
    except (OSError, ValueError) as exc:
        return None, {'status': 'pending_review',
                      'reason': getattr(exc, 'code', 'invalid_auto_refresh_config')}


def _drain_auto(root, policy, skip_paths, *, turn_key=None):
    """Reserve each operation against one durable turn+source snapshot budget."""
    completed = 0
    initial = reconcile._read(root)
    if initial is None:
        return {'status': 'pending_review', 'reason': 'reconcile_state_missing',
                'completedInHandoff': 0, 'pending': 0}
    if not initial['queue'] and not initial.get('inFlight'):
        import wiki_topical_create as creator
        if refresh._read(root) is None and creator._read(root) is None:
            # A no-work Stop needs no budget identity, lock, or disk record.
            return {'status': 'no_net_changes'}
    with stop_budget.Budget(root, policy, initial.get('sources', {}), turn_key) as budget:
        # A completed journal can need one cleanup pass without settling a new
        # source. Still bound such passes so a malformed journal cannot loop.
        for _step in range(2 * MAX_AUTO_STEPS_PER_JOB + 4):
            before = reconcile._read(root)
            pending = len(before['queue']) if before else 0
            if before is None:
                return {'status': 'pending_review', 'reason': 'reconcile_state_missing',
                        'completedInHandoff': completed, 'pending': 0}
            if not pending and not before.get('inFlight'):
                import wiki_topical_create as creator
                journals = [row for row in (refresh._read(root), creator._read(root))
                            if row is not None]
                if journals:
                    if (len(journals) != 1 or
                            journals[0]['batchId'] != before.get('lastCompletedBatchId')):
                        return {'status': 'pending_review',
                                'reason': 'stop_batch_completed_journal_mismatch',
                                'completedInHandoff': completed, 'pending': 0}
                    # Only a proved completed batch can clean its journal
                    # without a new model reservation at the budget ceiling.
                    return refresh.auto_refresh_pending(root, skip_paths=skip_paths,
                        expected_policy_sha256=budget.policy_sha)
                return {'status': 'no_net_changes'} if completed == 0 else {
                    'status': 'backend_batch_synced', 'completedInHandoff': completed,
                    'pending': 0}
            reason = budget.reserve(before)
            if reason is not None:
                return {'status': 'pending_review', 'reason': reason,
                        'completedInHandoff': completed, 'pending': pending,
                        'maxEstimatedCents': MAX_AUTO_ESTIMATED_CENTS_PER_JOB}
            result = refresh.auto_refresh_pending(root, skip_paths=skip_paths,
                expected_policy_sha256=budget.policy_sha)
            after = reconcile._read(root)
            pending = len(after['queue']) if after else 0
            status = result.get('status')
            if after is None:
                return {'status': 'pending_review', 'reason': 'reconcile_state_missing',
                        'completedInHandoff': completed, 'pending': pending}
            budget.finish(before, after)
            if status in ('backend_created_synced', 'backend_verified_synced',
                          'already_completed'):
                if status != 'already_completed' and before == after and pending:
                    return {'status': 'pending_review', 'reason': 'stop_batch_no_progress',
                            'completedInHandoff': completed, 'pending': pending}
                if status != 'already_completed':
                    completed += 1
                if not pending and not after.get('inFlight'):
                    return result if completed == 1 else {
                        'status': 'backend_batch_synced', 'completedInHandoff': completed,
                        'pending': 0, 'lastResult': result}
                continue
            if status == 'no_net_changes' and not pending and not after.get('inFlight'):
                return result if completed == 0 else {
                    'status': 'backend_batch_synced', 'completedInHandoff': completed,
                    'pending': 0, 'lastResult': result}
            if status in ('pending_review', 'superseded_source_changed'):
                return result if completed == 0 else {
                    **result, 'completedInHandoff': completed, 'pending': pending}
            return {'status': 'pending_review', 'reason': status or 'stop_batch_no_progress',
                    'completedInHandoff': completed, 'pending': pending}
        state = reconcile._read(root)
        pending = len(state['queue']) if state else 0
        return {'status': 'pending_review', 'reason': 'stop_batch_no_progress',
                'completedInHandoff': completed, 'pending': pending}


def enqueue(root, action, payload=None):
    root = _root(root)
    import setup_guard
    if setup_guard.status(root)['status'] != 'ready':
        return {'status': 'setup_required'}
    if action not in ('boundary', 'reconcile'):
        raise ValueError('invalid_topical_hook_action')
    policy, _policy_problem = _auto_policy(root)
    if policy is not None and not policy['enabled']:
        # A disabled policy must not create even a queue directory or status.
        return {'status': 'disabled'}
    # Invalid policy is queued so the worker records a visible pending_review
    # result, then removes the job without touching source/batch state.
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


def _settings(root, policy=None):
    path = root / '.topical-reconcile-hook.json'
    if path.is_symlink(): raise ValueError('topical_settings_missing')
    if not path.is_file():
        # The reviewed automatic policy already names the allowed source
        # roots. A normal setup need not carry the older sandbox cards.json.
        if policy is None: raise ValueError('topical_settings_missing')
        return {'sourceRoots': policy['sourceRoots'], 'cardsFile': None,
                'trustedCardIds': [], 'skipPaths': []}, []
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
    policy, policy_problem = _auto_policy(root)
    if policy_problem is not None:
        return policy_problem
    if policy is not None and not policy['enabled']:
        return {'status': 'disabled'}
    if settings_path.is_file() or policy is not None:
        settings, cards = _settings(root, policy)
        if (policy is not None and
                sorted(set(settings['sourceRoots'])) != sorted(set(policy['sourceRoots']))):
            return {'status': 'pending_review', 'reason': 'auto_policy_source_roots_mismatch'}
        trusted = settings['trustedCardIds']
        if (policy is not None or
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
              'bootstrap_unclaimed': policy is not None and not cards}
        if job['action'] == 'boundary':
            reconcile.start_batch(*args, turn_key_value=job['turnKey'], **kw)
            if policy is not None:
                result = _drain_auto(root, policy, settings['skipPaths'],
                    turn_key=job['turnKey'])
        else:
            reconcile.reconcile(*args, **kw)
    elif job['action'] == 'boundary':
        return {'status': 'pending_review', 'reason': 'auto_teacher_policy_required'}
    if job['action'] == 'reconcile':
        if policy is not None:
            result = _drain_auto(root, policy,
                settings['skipPaths'] if settings_path.is_file() else ())
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
                        import setup_guard
                        if setup_guard.status(root)['status'] != 'ready':
                            _atomic(root / 'topical-hook-status.json', {
                                'schema': 'topical-hook-status-v1', 'job': path.name,
                                'status': 'setup_required', 'at': time.time()})
                            output.write(f'{time.time():.3f} {path.name} setup_required\n'); output.flush()
                            return
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
