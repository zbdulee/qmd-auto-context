"""Durable SessionStart update handoff; only the project path is persisted."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time


def _private_queue():
    root = Path(os.environ.get('QMD_UPDATE_HOOK_QUEUE_DIR',
        str(Path.home()/'.cache/qmd/update-hook-jobs')))
    if not root.is_absolute() or root.is_symlink(): raise ValueError('unsafe_update_queue')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('unsafe_update_queue')
    return root


def _write(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.update-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf8') as out:
            json.dump(value, out, sort_keys=True)
            out.write('\n'); out.flush(); os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def enqueue(raw):
    if len(raw) > 65536: raise ValueError('oversized_session_start')
    payload = json.loads(raw) if raw.strip() else {}
    if not isinstance(payload, dict): raise ValueError('invalid_session_start')
    cwd = payload.get('cwd') or os.getcwd()
    path = Path(cwd)
    if not isinstance(cwd, str) or not path.is_absolute() or not path.is_dir():
        raise ValueError('invalid_session_start_cwd')
    cwd = str(path.resolve())
    queue = _private_queue()
    key = hashlib.sha256(cwd.encode()).hexdigest()[:32]
    job = queue/(key+'.job.json')
    # One pending job per project. Never replace a running worker's input.
    fd = None
    try:
        fd = os.open(job, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w', encoding='utf8') as out:
            fd = None
            json.dump({'schema': 'qmd-update-hook-job-v1', 'cwd': cwd}, out)
            out.write('\n'); out.flush(); os.fsync(out.fileno())
    except FileExistsError:
        if job.is_symlink() or job.stat().st_uid != os.getuid() or job.stat().st_mode & 0o077:
            raise ValueError('unsafe_update_job')
    finally:
        if fd is not None: os.close(fd)
    # The first opt-in decision must reach the current host turn. Resolve is a
    # bounded, read-only path; all scans/index/embed remain in the worker.
    if not os.environ.get('QMD_SUPPRESS_NOTICE'):
        try:
            update_script = os.environ.get('QMD_CORE_UPDATE_SCRIPT') or str(Path(__file__).with_name('update.sh'))
            result = subprocess.run(['bash', update_script, '--resolve-only', '--cwd', cwd],
                cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                timeout=1.0, check=False)
            resolved = json.loads(result.stdout)
            if result.returncode == 0 and isinstance(resolved, dict) and resolved.get('reason') == 'pending':
                print('[qmd] 이 폴더의 검색 등록 여부가 아직 결정되지 않았습니다. 등록 범위를 확인한 뒤 opt-in 또는 opt-out을 선택해 주세요.')
        except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
            pass
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'worker', key],
        cwd=queue, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)


def worker(key):
    if len(key) != 32 or any(c not in '0123456789abcdef' for c in key):
        raise ValueError('invalid_update_job_key')
    queue = _private_queue()
    lock = queue/(key+'.lock')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(fd).st_uid != os.getuid() or os.fstat(fd).st_mode & 0o077:
            raise ValueError('unsafe_update_lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        job = queue/(key+'.job.json')
        if not job.is_file() or job.is_symlink(): return
        row = json.loads(job.read_text())
        cwd = row.get('cwd') if isinstance(row, dict) else None
        if (not isinstance(row, dict) or row.get('schema') != 'qmd-update-hook-job-v1' or not isinstance(cwd, str)
                or hashlib.sha256(cwd.encode()).hexdigest()[:32] != key):
            raise ValueError('invalid_update_job')
        log = queue/(key+'.log')
        if log.is_symlink(): raise ValueError('unsafe_update_log')
        if log.is_file() and log.stat().st_size > 1024*1024:
            os.replace(log, queue/(key+'.log.1'))
        with log.open('a', encoding='utf8') as output:
            os.chmod(log, 0o600)
            output.write(f'{time.time():.3f} update started\n'); output.flush()
            try:
                import qmd_route
                selected = qmd_route.project_paths(cwd)
                if not selected['selected']:
                    manager = os.environ.get('QMD_BACKEND_MANAGER') or str(Path(__file__).with_name('backend_manager.sh'))
                    for action in ('ensure', 'warm', 'rotate'):
                        subprocess.run(['bash', manager, action], cwd=cwd, stdin=subprocess.DEVNULL,
                            stdout=output, stderr=output, timeout=30, check=False)
                update_script = os.environ.get('QMD_CORE_UPDATE_SCRIPT') or str(Path(__file__).with_name('update.sh'))
                result = subprocess.run(['bash', update_script],
                    cwd=cwd, input=json.dumps({'cwd': cwd}), text=True,
                    capture_output=True, timeout=120, check=False)
                status = 'completed' if result.returncode == 0 else 'failed'
                # The SessionStart output is a notice, not source content.
                output.write((result.stdout or '')[:2048] + '\n')
                output.write((result.stderr or '')[:2048] + '\n')
                output.write(f'{time.time():.3f} update {status}\n'); output.flush()
                _write(queue/(key+'.status.json'), {'schema': 'qmd-update-hook-status-v1',
                    'cwdHash': key, 'status': status, 'at': time.time()})
                if status == 'completed': job.unlink()
            except (OSError, subprocess.TimeoutExpired) as exc:
                output.write(f'{time.time():.3f} update failed:{type(exc).__name__}\n')
                _write(queue/(key+'.status.json'), {'schema': 'qmd-update-hook-status-v1',
                    'cwdHash': key, 'status': 'failed', 'at': time.time()})
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == 'enqueue':
            enqueue(sys.stdin.read(65537))
        elif len(sys.argv) == 3 and sys.argv[1] == 'worker':
            worker(sys.argv[2])
        else:
            raise SystemExit(2)
    except BaseException as exc:
        if (len(sys.argv) == 2 and sys.argv[1] == 'enqueue') or (len(sys.argv) == 3 and sys.argv[1] == 'worker'):
            try:
                queue = _private_queue()
                phase = sys.argv[1]
                key = sys.argv[2] if phase == 'worker' else None
                if key is None or (len(key) == 32 and all(c in '0123456789abcdef' for c in key)):
                    log = queue/((key+'.log') if key else 'enqueue.log')
                    if log.is_symlink(): raise ValueError('unsafe_update_log')
                    if log.is_file() and log.stat().st_size > 1024*1024:
                        os.replace(log, queue/(log.name+'.1'))
                    with log.open('a', encoding='utf8') as output:
                        os.chmod(log, 0o600)
                        output.write(f'{time.time():.3f} {phase} failed:{type(exc).__name__}\n')
                    _write(queue/((key+'.status.json') if key else 'enqueue.status.json'),
                        {'schema': 'qmd-update-hook-status-v1', 'cwdHash': key,
                         'status': phase + '_failed', 'at': time.time()})
            except BaseException:
                pass
        raise SystemExit(1)
