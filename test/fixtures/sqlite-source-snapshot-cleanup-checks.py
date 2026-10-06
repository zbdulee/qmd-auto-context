"""Crash/retry proof for private SQLite fingerprint backup staging."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path.cwd() / 'core'))
import sqlite_read


if len(sys.argv) > 1:
    source_path = Path(sys.argv[2])
    if sys.argv[1] == 'hold':
        original_connect = sqlite_read.connect

        @contextmanager
        def held_connect(path):
            with original_connect(path) as source:
                class HeldBackup:
                    def backup(self, destination):
                        source.backup(destination)
                        print('READY', flush=True)
                        signal.pause()
                yield HeldBackup()

        sqlite_read.connect = held_connect
        sqlite_read.snapshot_fingerprint(source_path)
    elif sys.argv[1] == 'fingerprint':
        print(json.dumps(sqlite_read.snapshot_fingerprint(source_path)))
    else:
        raise AssertionError('invalid fixture mode')
    sys.exit(0)


with tempfile.TemporaryDirectory(prefix='qmd-snapshot-recovery-') as temporary:
    base = Path(temporary)
    staging = base / 'staging'
    staging.mkdir()
    source = base / 'source.sqlite'
    with sqlite3.connect(source) as database:
        database.execute('CREATE TABLE documents(path TEXT, body BLOB)')
        database.execute('INSERT INTO documents VALUES (?, ?)', ('private.md', os.urandom(1024 * 1024)))
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    environment = {**os.environ, 'TMPDIR': str(staging), 'PYTHONDONTWRITEBYTECODE': '1',
                   'QMD_RECALL_LOG': ''}
    script = str(Path(__file__).resolve())
    root = staging / f'qmd-source-snapshots-v1-{os.geteuid()}'

    def run_probe():
        result = subprocess.run([sys.executable, script, 'fingerprint', str(source)],
                                env=environment, cwd=Path.cwd(), check=True,
                                capture_output=True, text=True, timeout=15)
        return json.loads(result.stdout)

    def start_holder():
        process = subprocess.Popen([sys.executable, '-u', script, 'hold', str(source)],
                                   env=environment, cwd=Path.cwd(), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([process.stdout], [], [], 10)
        if not ready or process.stdout.readline().strip() != 'READY':
            process.kill()
            _, error = process.communicate(timeout=5)
            raise AssertionError(f'backup did not reach the crash point: {error}')
        return process

    def jobs():
        return {entry.name for entry in root.iterdir() if entry.name.startswith('job-')
                and (entry / '.owner').exists()}

    first = None
    second = None
    try:
        baseline = run_probe()
        first = start_holder()
        first_jobs = jobs()
        assert len(first_jobs) == 1
        first_job = root / next(iter(first_jobs))
        assert stat.S_IMODE(first_job.stat().st_mode) == 0o700
        assert stat.S_IMODE((first_job / 'snapshot.sqlite').stat().st_mode) == 0o600
        assert (first_job / 'snapshot.sqlite').stat().st_size > 1024 * 1024

        # These entries resemble a job namespace but do not bear our stamp.
        unrelated = root / 'user-notes.txt'
        unrelated.write_text('leave this file alone')
        unstamped = root / ('job-' + 'a' * 32)
        unstamped.mkdir(mode=0o700)
        (unstamped / 'user-data').write_text('leave this directory alone')
        second = start_holder()
        second_jobs = jobs() - first_jobs
        assert len(second_jobs) == 1 and first_jobs <= jobs()

        first.kill()
        first.wait(timeout=5)
        assert run_probe() == baseline
        assert not first_job.exists(), 'retry must remove only the killed job backup'
        assert second_jobs <= jobs(), 'retry removed a live concurrent backup'
        assert unrelated.read_text() == 'leave this file alone'
        assert (unstamped / 'user-data').read_text() == 'leave this directory alone'

        second.kill()
        second.wait(timeout=5)
        assert run_probe() == baseline
        assert jobs() == set(), 'retry left a stamped dead job behind'
        assert unrelated.read_text() == 'leave this file alone'
        assert (unstamped / 'user-data').read_text() == 'leave this directory alone'
        assert hashlib.sha256(source.read_bytes()).hexdigest() == source_sha
    finally:
        for process in (first, second):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    print(json.dumps({'sigkillRetryReapedOwnBackup': True,
                      'liveConcurrentBackupRetained': True,
                      'unrelatedFilesRetained': True, 'sourceUnchanged': True}))
