"""Durable Stop reservations, sharded by turn instead of one growing ledger."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

LEDGER = '.topical-stop-budget.json'  # v1/v2 input, archived after migration.
ARCHIVE = '.topical-stop-budget.legacy.json'
SHARDS = '.topical-stop-budgets'
ACTIVE = '.topical-stop-budget-active.json'
LOCK = '.topical-stop-budget.lock'
SCHEMA = 'qmd-topical-stop-budget-v3'
LEGACY_SCHEMA = 'qmd-topical-stop-budget-v1'
PREVIOUS_SCHEMA = 'qmd-topical-stop-budget-v2'
TURN_SCHEMA = 'qmd-topical-stop-turn-v1'
ACTIVE_SCHEMA = 'qmd-topical-stop-active-v1'
MAX_STEPS = 12
MAX_CENTS = 640
MAX_LEGACY_BYTES = 64 * 1024 * 1024
MAX_TURN_BYTES = 65536


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False).encode('utf8')).hexdigest()


def _private_file(path, limit):
    if not path.exists() and not path.is_symlink():
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > limit):
            raise ValueError('unsafe_stop_budget_file')
        return os.read(fd, info.st_size + 1)
    finally:
        os.close(fd)


def _shards(root, *, create=False):
    path = root / SHARDS
    if path.is_symlink():
        raise ValueError('unsafe_stop_budget_directory')
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    if path.exists():
        info = path.stat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or path.resolve() != path):
            raise ValueError('unsafe_stop_budget_directory')
    return path


def _atomic(path, value):
    path.parent.mkdir(mode=0o700, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.stop-budget-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf8') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        if path.is_symlink():
            raise ValueError('unsafe_stop_budget_file')
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def _turn_path(root, turn_key):
    return _shards(root) / (_digest(turn_key) + '.json')


def _valid_scope(key, row, turn_key):
    return (isinstance(key, str) and len(key) == 64 and isinstance(row, dict)
            and set(row) == {'turnKey', 'snapshotSha256', 'policySha256',
                             'reservedCents', 'reservedSteps', 'activeBeforeSha256'}
            and row['turnKey'] == turn_key
            and isinstance(row['snapshotSha256'], str)
            and len(row['snapshotSha256']) == 64
            and isinstance(row['policySha256'], str)
            and _digest({'turnKey': turn_key, 'snapshotSha256': row['snapshotSha256']}) == key
            and type(row['reservedCents']) is int and 0 <= row['reservedCents'] <= MAX_CENTS
            and type(row['reservedSteps']) is int and 0 <= row['reservedSteps'] <= MAX_STEPS
            and (row['activeBeforeSha256'] is None or
                 isinstance(row['activeBeforeSha256'], str)))


def _totals(scopes):
    turns = {}
    for key, row in scopes.items():
        turn_key = row.get('turnKey') if isinstance(row, dict) else None
        if not isinstance(turn_key, str) or not _valid_scope(key, row, turn_key):
            raise ValueError('invalid_stop_budget_ledger')
        turn = turns.setdefault(turn_key, {'policySha256': row['policySha256'],
                                         'reservedCents': 0, 'reservedSteps': 0})
        if turn['policySha256'] != row['policySha256']:
            turn['policySha256'] = 'mixed_legacy_policy'
        turn['reservedCents'] += row['reservedCents']
        turn['reservedSteps'] += row['reservedSteps']
    return turns


def _legacy(root):
    data = _private_file(root / LEDGER, MAX_LEGACY_BYTES)
    if data is None:
        return None
    try: value = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError('invalid_stop_budget_ledger') from exc
    if (not isinstance(value, dict) or value.get('schema') not in
            (LEGACY_SCHEMA, PREVIOUS_SCHEMA) or not isinstance(value.get('scopes'), dict)
            or (value['schema'] == LEGACY_SCHEMA and
                set(value) != {'schema', 'activeKey', 'scopes'})
            or (value['schema'] == PREVIOUS_SCHEMA and
                set(value) != {'schema', 'activeKey', 'scopes', 'turns'})
            or (value.get('activeKey') is not None and
                value['activeKey'] not in value['scopes'])):
        raise ValueError('invalid_stop_budget_ledger')
    totals = _totals(value['scopes'])
    if value['schema'] == PREVIOUS_SCHEMA and value['turns'] != totals:
        raise ValueError('invalid_stop_budget_turn_totals')
    return value, totals, data


def _read_turn(root, turn_key):
    path = _turn_path(root, turn_key)
    data = _private_file(path, MAX_TURN_BYTES)
    if data is None:
        return None
    try: value = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError('invalid_stop_budget_turn') from exc
    if (not isinstance(value, dict) or set(value) !=
            {'schema', 'turnKey', 'policySha256', 'reservedCents', 'reservedSteps', 'scopes'}
            or value['schema'] != TURN_SCHEMA or value['turnKey'] != turn_key
            or not isinstance(value['policySha256'], str)
            or type(value['reservedCents']) is not int or value['reservedCents'] < 0
            or type(value['reservedSteps']) is not int or value['reservedSteps'] < 0
            or not isinstance(value['scopes'], dict)):
        raise ValueError('invalid_stop_budget_turn')
    totals = _totals(value['scopes'])
    if (totals.get(turn_key) != {name: value[name] for name in
            ('policySha256', 'reservedCents', 'reservedSteps')} or
            len(totals) != 1):
        raise ValueError('invalid_stop_budget_turn_totals')
    return value


def _save_turn(root, value):
    path = _shards(root, create=True) / (_digest(value['turnKey']) + '.json')
    if len(json.dumps(value, sort_keys=True).encode('utf8')) > MAX_TURN_BYTES:
        raise ValueError('stop_budget_turn_too_large')
    _atomic(path, value)


def _read_active(root):
    data = _private_file(root / ACTIVE, 8192)
    if data is None:
        return None
    try: value = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError('invalid_stop_budget_active') from exc
    if (not isinstance(value, dict) or set(value) !=
            {'schema', 'turnKey', 'snapshotSha256'} or
            value['schema'] != ACTIVE_SCHEMA or
            not isinstance(value['turnKey'], str) or
            not isinstance(value['snapshotSha256'], str)):
        raise ValueError('invalid_stop_budget_active')
    return value


def _save_active(root, turn_key, snapshot_sha):
    _atomic(root / ACTIVE, {'schema': ACTIVE_SCHEMA,
                            'turnKey': turn_key, 'snapshotSha256': snapshot_sha})


def _migrate(root):
    old = _legacy(root)
    if old is None:
        return
    value, totals, data = old
    paid_turns = {turn_key for turn_key, total in totals.items()
                  if total['reservedCents'] or total['reservedSteps']}
    grouped = {}
    uncompact = {}
    for key, row in value['scopes'].items():
        if row['turnKey'] in paid_turns or row['activeBeforeSha256']:
            turn_key = row['turnKey']
            uncompact.setdefault(turn_key, {})[key] = row
            if (row['reservedCents'] or row['reservedSteps'] or
                    row['activeBeforeSha256']):
                grouped.setdefault(turn_key, {})[key] = row
    for turn_key, scopes in grouped.items():
        # Old v1/v2 created a scope on entry, even if no operation was
        # reserved. Such scopes carry no allowance or unfinished-operation
        # identity. Keep only one dissenting zero-cost scope when it is
        # needed to preserve the legacy mixed-policy prohibition.
        total = _totals(scopes)[turn_key]
        old_total = totals[turn_key]
        if total['policySha256'] != old_total['policySha256']:
            for key, row in uncompact[turn_key].items():
                if key not in scopes and row['policySha256'] != total['policySha256']:
                    scopes[key] = row
                    break
            total = _totals(scopes)[turn_key]
        if total != old_total:
            raise ValueError('stop_budget_migration_conflict')
        expected = {'schema': TURN_SCHEMA, 'turnKey': turn_key, **total,
                    'scopes': scopes}
        current = _read_turn(root, turn_key)
        if current is None:
            _save_turn(root, expected)
        elif current != expected:
            # A prior v3 attempt may have written the uncompressed form and
            # stopped before unlinking the monolith. Rewrite that verified
            # shard atomically; never accept a partial or conflicting spend.
            before = uncompact[turn_key]
            old_expected = {'schema': TURN_SCHEMA, 'turnKey': turn_key,
                            **_totals(before)[turn_key], 'scopes': before}
            if current != old_expected:
                raise ValueError('stop_budget_migration_conflict')
            _save_turn(root, expected)
    active_key = value['activeKey']
    if active_key is not None:
        row = value['scopes'][active_key]
        expected_active = {'schema': ACTIVE_SCHEMA, 'turnKey': row['turnKey'],
                           'snapshotSha256': row['snapshotSha256']}
        current_active = _read_active(root)
        if current_active is None:
            _save_active(root, row['turnKey'], row['snapshotSha256'])
        elif current_active != expected_active:
            raise ValueError('stop_budget_migration_conflict')
    archive = root / ARCHIVE
    if archive.is_symlink():
        raise ValueError('unsafe_stop_budget_archive')
    if not archive.exists():
        os.link(root / LEDGER, archive, follow_symlinks=False)
        directory = os.open(root, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    elif _private_file(archive, MAX_LEGACY_BYTES) != data:
        raise ValueError('stop_budget_migration_conflict')
    (root / LEDGER).unlink()
    directory = os.open(root, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)


def _read(root):
    """Small test/diagnostic view; runtime opens only one turn shard."""
    root = Path(root).resolve()
    _migrate(root)
    scopes = {}; turns = {}
    folder = _shards(root)
    if folder.exists():
        for path in folder.glob('*.json'):
            if path.is_symlink() or len(path.stem) != 64:
                raise ValueError('unsafe_stop_budget_turn')
            data = _private_file(path, MAX_TURN_BYTES)
            row = json.loads(data)
            turn = _read_turn(root, row['turnKey'])
            if path != _turn_path(root, row['turnKey']) or turn != row:
                raise ValueError('invalid_stop_budget_turn')
            turns[row['turnKey']] = {name: row[name] for name in
                                     ('policySha256', 'reservedCents', 'reservedSteps')}
            scopes.update(row['scopes'])
    active = _read_active(root)
    active_key = (_digest({'turnKey': active['turnKey'],
                           'snapshotSha256': active['snapshotSha256']})
                  if active else None)
    return {'schema': SCHEMA, 'activeKey': active_key,
            'scopes': scopes, 'turns': turns}


class Budget:
    """Hold one project lock across a single turn's reservations and work."""
    def __init__(self, root, policy, sources, turn_key):
        self.root = Path(root).resolve()
        self.policy_sha = _digest(policy)
        self.snapshot_sha = _digest(sources)
        self.cents = policy['maxEstimatedCents']
        self.turn_key = turn_key
        self.fd = None

    def __enter__(self):
        path = self.root / LOCK
        self.fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(self.fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077):
                raise ValueError('unsafe_stop_budget_lock')
            fcntl.flock(self.fd, fcntl.LOCK_EX)
            _migrate(self.root)
            active = _read_active(self.root)
            if self.turn_key is None:
                self.turn_key = active['turnKey'] if active else 'recovery'
            self.key = _digest({'turnKey': self.turn_key,
                                'snapshotSha256': self.snapshot_sha})
            self.record = _read_turn(self.root, self.turn_key)
            new_turn = self.record is None
            if new_turn:
                self.record = {'schema': TURN_SCHEMA, 'turnKey': self.turn_key,
                    'policySha256': self.policy_sha, 'reservedCents': 0,
                    'reservedSteps': 0, 'scopes': {}}
            if new_turn or active is None or active['turnKey'] == self.turn_key:
                if (active is None or active['turnKey'] != self.turn_key or
                        active['snapshotSha256'] != self.snapshot_sha):
                    _save_active(self.root, self.turn_key, self.snapshot_sha)
            self.scope = self.record['scopes'].get(self.key)
            self.turn = self.record
            return self
        except BaseException:
            os.close(self.fd); self.fd = None
            raise

    def __exit__(self, *_args):
        os.close(self.fd); self.fd = None

    @staticmethod
    def progress_sha(state):
        return _digest({'queue': state['queue'],
                        'settledSources': state.get('settledSources', {})})

    def reserve(self, state):
        if _digest(state.get('sources', {})) != self.snapshot_sha:
            return 'stop_batch_source_snapshot_changed'
        if self.turn['policySha256'] != self.policy_sha:
            return 'stop_batch_policy_changed'
        before = self.progress_sha(state)
        if self.scope is not None and self.scope['activeBeforeSha256'] is not None:
            if self.scope['activeBeforeSha256'] == before:
                return None  # Reuse the durable allowance for unfinished work.
            self.scope['activeBeforeSha256'] = None
            _save_turn(self.root, self.record)
        if (self.turn['reservedSteps'] >= MAX_STEPS or
                self.turn['reservedCents'] + self.cents > MAX_CENTS):
            return 'stop_batch_budget_exhausted'
        if self.scope is None:
            self.scope = {'turnKey': self.turn_key,
                'snapshotSha256': self.snapshot_sha,
                'policySha256': self.policy_sha, 'reservedCents': 0,
                'reservedSteps': 0, 'activeBeforeSha256': None}
            self.record['scopes'][self.key] = self.scope
        self.scope['reservedSteps'] += 1
        self.scope['reservedCents'] += self.cents
        self.turn['reservedSteps'] += 1
        self.turn['reservedCents'] += self.cents
        self.scope['activeBeforeSha256'] = before
        _save_turn(self.root, self.record)  # Durable before model execution.
        return None

    def finish(self, before, after):
        if (self.scope is not None and
                (self.progress_sha(before) != self.progress_sha(after) or
                 not after['queue'] and not after.get('inFlight'))):
            self.scope['activeBeforeSha256'] = None
            _save_turn(self.root, self.record)
