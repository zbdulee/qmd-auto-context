#!/usr/bin/env python3
"""Durable dirty queue claim and success acknowledgement.

The queue stays intact during QMD work. A complete claim is published before
processing; ACK is an atomic queue replacement under the stable sidecar lock.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def _paths(queue):
    q = Path(queue)
    if not q.is_absolute() or q.is_symlink(): raise ValueError('unsafe_dirty_queue')
    return q, Path(str(q) + '.lock'), Path(str(q) + '.claim.json')


def _private_regular(path):
    if path.is_symlink(): raise ValueError('unsafe_dirty_queue_state')
    st = path.stat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_nlink != 1 or st.st_mode & 0o077:
        raise ValueError('unsafe_dirty_queue_state')


@contextmanager
def queue_lock(queue):
    q, lock, _ = _paths(queue)
    if not q.parent.is_dir() or q.parent.is_symlink(): raise ValueError('unsafe_dirty_queue_parent')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        _private_regular(lock)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield q
    finally:
        os.close(fd)


def _atomic(path, value):
    fd, name = tempfile.mkstemp(prefix='.dirty-queue-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(value); output.flush(); os.fsync(output.fileno())
        os.replace(name, path)
        _fsync_dir(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def _read_claim(path):
    if not path.exists(): return None
    _private_regular(path)
    value = json.loads(path.read_text())
    if (not isinstance(value, dict) or value.get('schema') != 'qmd-dirty-claim-v1'
            or value.get('phase') not in ('processing', 'done')
            or type(value.get('reloadRequired', False)) is not bool
            or type(value.get('inode')) is not int or value['inode'] < 1
            or type(value.get('size')) is not int or value['size'] < 1):
        raise ValueError('invalid_dirty_queue_claim')
    data = base64.b64decode(value['data'], validate=True)
    if len(data) != value['size'] or hashlib.sha256(data).hexdigest() != value['sha256']:
        raise ValueError('invalid_dirty_queue_claim')
    return value, data


def _ack_locked(q, claim_path, value, data):
    if value['phase'] != 'done': raise ValueError('dirty_queue_claim_not_done')
    if not q.is_file() or q.is_symlink(): raise ValueError('dirty_queue_changed')
    with q.open('rb') as source:
        inode = os.fstat(source.fileno()).st_ino
        if inode != value['inode']:
            # Atomic replacement already committed before a process death.
            claim_path.unlink(); _fsync_dir(q.parent)
            return
        current = source.read()
    if not current.startswith(data): raise ValueError('dirty_queue_prefix_changed')
    _atomic(q, current[len(data):])
    claim_path.unlink(); _fsync_dir(q.parent)


def claim(queue, output):
    q, _, claim_path = _paths(queue)
    if not q.exists() and not claim_path.exists() and not claim_path.is_symlink(): return False
    with queue_lock(q):
        existing = _read_claim(claim_path)
        if existing and existing[0]['phase'] == 'done':
            _ack_locked(q, claim_path, *existing)
            existing = None
        if existing:
            value, data = existing
            if not q.is_file() or q.is_symlink() or q.stat().st_ino != value['inode']:
                raise ValueError('dirty_queue_changed_during_claim')
            if not q.read_bytes().startswith(data): raise ValueError('dirty_queue_prefix_changed')
        else:
            if not q.is_file() or q.is_symlink(): return False
            with q.open('rb') as source:
                inode = os.fstat(source.fileno()).st_ino
                data = source.read()
            if not data: return False
            value = {'schema': 'qmd-dirty-claim-v1', 'phase': 'processing',
                     'inode': inode, 'size': len(data),
                     'sha256': hashlib.sha256(data).hexdigest(),
                     'data': base64.b64encode(data).decode('ascii')}
            if claim_path.exists() or claim_path.is_symlink(): raise ValueError('dirty_queue_claim_exists')
            encoded = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
            fd, name = tempfile.mkstemp(prefix='.dirty-claim-', dir=q.parent)
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, 'wb') as target:
                    target.write(encoded); target.flush(); os.fsync(target.fileno())
                os.link(name, claim_path, follow_symlinks=False)
                _fsync_dir(q.parent)
            finally: Path(name).unlink(missing_ok=True)
        Path(output).write_bytes(data)
        return True


def ack(queue):
    q, _, claim_path = _paths(queue)
    with queue_lock(q):
        existing = _read_claim(claim_path)
        if not existing: raise ValueError('dirty_queue_claim_missing')
        value, data = existing
        if value.get('reloadRequired', False): raise ValueError('dirty_queue_reload_required')
        if value['phase'] == 'processing':
            if not q.is_file() or q.is_symlink() or q.stat().st_ino != value['inode']:
                raise ValueError('dirty_queue_changed_during_claim')
            if not q.read_bytes().startswith(data): raise ValueError('dirty_queue_prefix_changed')
            value = {**value, 'phase': 'done'}
            _atomic(claim_path, (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode())
        _ack_locked(q, claim_path, value, data)


def reload_state(queue, required=None):
    q, _, claim_path = _paths(queue)
    with queue_lock(q):
        existing = _read_claim(claim_path)
        if not existing: raise ValueError('dirty_queue_claim_missing')
        value, data = existing
        if value['phase'] != 'processing' or not q.is_file() or q.is_symlink() or q.stat().st_ino != value['inode']:
            raise ValueError('dirty_queue_changed_during_claim')
        if not q.read_bytes().startswith(data): raise ValueError('dirty_queue_prefix_changed')
        if required is None: return value.get('reloadRequired', False)
        if value.get('reloadRequired', False) != required:
            value = {**value, 'reloadRequired': required}
            _atomic(claim_path, (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode())
        return required

def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) == 3 and args[0] == 'claim':
        try: return 0 if claim(args[1], args[2]) else 3
        except Exception as exc:
            print(str(exc), file=sys.stderr); return 1
    if len(args) == 2 and args[0] in ('reload-required', 'reload-done', 'needs-reload'):
        try:
            result = reload_state(args[1], None if args[0] == 'needs-reload' else args[0] == 'reload-required')
            return 0 if result else 3
        except Exception as exc:
            print(str(exc), file=sys.stderr); return 1
    if len(args) == 2 and args[0] == 'ack':
        try: ack(args[1]); return 0
        except Exception as exc:
            print(str(exc), file=sys.stderr); return 1
    return 2


if __name__ == '__main__': raise SystemExit(main())
