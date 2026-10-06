"""QMD WAL read-only probes must work after its CLI removes sidecars."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path.cwd() / 'core'))
import sqlite_read

with tempfile.TemporaryDirectory(prefix='qmd-sqlite-wal-') as temporary:
    path = Path(temporary) / 'index.sqlite'
    db = sqlite3.connect(path)
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE documents(path TEXT)')
        db.execute('INSERT INTO documents VALUES (?)', ('first.md',))
        db.commit()
    finally:
        db.close()
    for suffix in ('-wal', '-shm'):
        Path(str(path) + suffix).unlink(missing_ok=True)
    ro = None
    try:
        ro = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
        ro.execute('SELECT path FROM documents').fetchall()
    except sqlite3.OperationalError:
        pass
    finally:
        if ro is not None:
            ro.close()
    # Different SQLite builds either fail or create transient empty sidecars.
    # Both are legal; our reader must return the checkpointed main-file row.
    before = path.read_bytes()
    with sqlite_read.connect(path) as db:
        assert db.execute('SELECT path FROM documents').fetchall() == [('first.md',)]
    assert path.read_bytes() == before
    # A live WAL writer must be read through ordinary mode=ro, including
    # committed rows still in the sidecar. immutable=1 would miss them.
    writer = sqlite3.connect(path)
    writer.execute('INSERT INTO documents VALUES (?)', ('second.md',))
    writer.commit()
    assert Path(str(path) + '-wal').exists()
    with sqlite_read.connect(path) as db:
        found = [row[0] for row in db.execute('SELECT path FROM documents ORDER BY path')]
    writer.close()
    assert found == ['first.md', 'second.md']
    print(json.dumps({'offlineWalReadable': True, 'noDbMutation': True,
                      'liveWalReadFresh': True}))
