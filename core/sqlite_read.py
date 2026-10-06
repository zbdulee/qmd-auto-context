"""Read a QMD SQLite index without writing it, including offline WAL snapshots.

QMD can close a WAL database without leaving -wal/-shm sidecars. SQLite then
refuses `mode=ro` because it cannot create the missing shared-memory file.
Only in that checkpointed state may an immutable read be used; it must not
silently ignore a live WAL writer.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import tempfile
from urllib.parse import quote


_SNAPSHOT_FILES = frozenset({'.owner', '.lock', 'snapshot.sqlite',
                             'snapshot.sqlite-journal', 'snapshot.sqlite-wal',
                             'snapshot.sqlite-shm'})
_SNAPSHOT_JOB = re.compile(r'job-([0-9a-f]{32})\Z')


def _private_directory(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return (stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_mode & 0o777 == 0o700)


def _owned_regular_file(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return (stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_nlink == 1)


def _snapshot_root():
    root = Path(tempfile.gettempdir()) / f'qmd-source-snapshots-v1-{os.geteuid()}'
    try:
        root.mkdir(mode=0o700)
    except FileExistsError:
        pass
    if not _private_directory(root):
        raise ValueError('unsafe_source_snapshot_staging')
    return root


def _remove_snapshot_job(job, token):
    """Remove only a complete job stamped with its own random identifier."""
    if not _private_directory(job):
        return False
    files = set(os.listdir(job))
    if not {'.owner', '.lock'} <= files or not files <= _SNAPSHOT_FILES:
        return False
    if any(not _owned_regular_file(job / name) for name in files):
        return False
    if (job / '.owner').read_bytes() != f'qmd-source-snapshot-v1:{token}\n'.encode():
        return False
    if any((job / name).stat().st_mode & 0o077
           for name in files - {'snapshot.sqlite-shm', 'snapshot.sqlite-wal',
                                'snapshot.sqlite-journal'}):
        return False
    for name in files - {'.owner', '.lock'}:
        (job / name).unlink()
    (job / '.owner').unlink()
    (job / '.lock').unlink()
    job.rmdir()
    return True


def _reap_source_snapshots(root):
    """A held advisory lock protects every live job, including another PID."""
    for job in root.iterdir():
        match = _SNAPSHOT_JOB.fullmatch(job.name)
        if not match or not _private_directory(job):
            continue
        lock = job / '.lock'
        if not _owned_regular_file(lock):
            continue
        try:
            fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                _remove_snapshot_job(job, match.group(1))
            finally:
                os.close(fd)
        except (FileNotFoundError, BlockingIOError):
            continue


@contextmanager
def _snapshot_destination():
    root = _snapshot_root()
    _reap_source_snapshots(root)
    token = secrets.token_hex(16)
    job = root / f'job-{token}'
    job.mkdir(mode=0o700)
    lock_fd = None
    try:
        lock_fd = os.open(job / '.lock', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        owner_fd = os.open(job / '.owner', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            stamp = f'qmd-source-snapshot-v1:{token}\n'.encode()
            if os.write(owner_fd, stamp) != len(stamp):
                raise OSError('incomplete_source_snapshot_owner_stamp')
            os.fsync(owner_fd)
        finally:
            os.close(owner_fd)
        destination = job / 'snapshot.sqlite'
        data_fd = os.open(destination, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(data_fd)
        yield destination
    finally:
        if lock_fd is not None:
            try:
                if not _remove_snapshot_job(job, token):
                    raise ValueError('source_snapshot_cleanup_requires_attention')
            finally:
                os.close(lock_fd)
        else:
            # No database file exists until after the lock and owner stamp.
            (job / '.lock').unlink(missing_ok=True)
            job.rmdir()


def _state(path):
    info = path.stat()
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _wal_exists(path):
    return Path(str(path) + '-wal').exists()


def _wal_format(path):
    with path.open('rb') as stream:
        header = stream.read(20)
    return (len(header) == 20 and header.startswith(b'SQLite format 3\x00')
            and header[18:20] == b'\x02\x02')


@contextmanager
def connect(path, *, timeout=5.0):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('unsafe_qmd_index')
    path = path.resolve()
    base = 'file:' + quote(str(path), safe='/')
    immutable = False
    before = None
    def open_probed(uri):
        db = sqlite3.connect(uri, uri=True, timeout=timeout)
        try:
            db.execute('PRAGMA query_only=ON')
            # On macOS SQLite can defer opening a WAL database until its first
            # schema read, so connection creation alone is not a valid probe.
            db.execute('SELECT 1 FROM sqlite_master LIMIT 1').fetchone()
            return db
        except BaseException:
            db.close()
            raise

    # A closed QMD WAL index can have no sidecars. Probing it with mode=ro
    # may itself create a stale -shm before failing (Python 3.12/macOS).
    # Read its stable main-file snapshot directly in that exact state.
    if _wal_format(path) and not _wal_exists(path):
        before = _state(path)
        db = open_probed(base + '?mode=ro&immutable=1')
        immutable = True
    else:
        try:
            db = open_probed(base + '?mode=ro')
        except sqlite3.OperationalError:
            if _wal_exists(path):
                raise
            before = _state(path)
            db = open_probed(base + '?mode=ro&immutable=1')
            immutable = True
    try:
        yield db
    finally:
        db.close()
        if immutable and (_wal_exists(path) or _state(path) != before):
            raise ValueError('qmd_index_changed_during_read')


def snapshot_fingerprint(path):
    """Hash one SQLite backup snapshot, including committed live WAL pages.

    The backup lives in an owner-only, per-job temporary directory. A live
    process holds its lock; a later entry removes only stamped, unlocked jobs
    left by a crash. No checkpoint or write is requested from the source.
    Inode identity detects path replacement even when rows are unchanged.
    """
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('unsafe_qmd_index')
    identity = list(_state(path)[:2])
    with _snapshot_destination() as name:
        with connect(path) as source:
            destination = sqlite3.connect(name)
            try:
                source.backup(destination)
            finally:
                destination.close()
        if path.is_symlink() or list(_state(path)[:2]) != identity:
            raise ValueError('qmd_index_changed_during_read')
        digest = hashlib.sha256()
        with open(name, 'rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        return {'schema': 'qmd-source-snapshot-v1', 'identity': identity,
                'snapshotSha256': digest.hexdigest()}


@contextmanager
def cutover_guard(path, expected, *, timeout=5.0):
    """Hold SQLite's writer reservation during source proof and pointer cutover.

    A read transaction alone cannot stop a WAL commit after its snapshot.
    BEGIN IMMEDIATE blocks competing SQLite writers until the pointer is
    published. We never issue DML or a checkpoint, and always ROLLBACK.
    """
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('unsafe_qmd_index')
    uri = 'file:' + quote(str(path.resolve()), safe='/') + '?mode=rw'
    db = sqlite3.connect(uri, uri=True, timeout=timeout)
    try:
        try:
            db.execute('BEGIN IMMEDIATE')
        except sqlite3.OperationalError as exc:
            raise ValueError('source_index_cutover_lock_unavailable') from exc
        if snapshot_fingerprint(path) != expected:
            raise ValueError('source_index_changed_during_migration')
        yield
        if snapshot_fingerprint(path) != expected:
            raise ValueError('source_index_changed_during_migration')
    finally:
        if db.in_transaction:
            db.rollback()
        db.close()
