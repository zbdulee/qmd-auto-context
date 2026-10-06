#!/usr/bin/env python3
"""Deterministic, synthetic-only QMD CLI stand-in for the fake wiki integration."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path


def guarded_root():
    root = Path.cwd().resolve()
    if not (root / '.qmd-topical-sandbox').is_file():
        raise ValueError('synthetic_sandbox_marker_required')
    db_path = Path(os.environ['INDEX_PATH']).resolve()
    config_dir = Path(os.environ['QMD_CONFIG_DIR']).resolve()
    if not db_path.is_relative_to(root) or not config_dir.is_relative_to(root):
        raise ValueError('synthetic_paths_must_stay_in_sandbox')
    return root, db_path, config_dir


def connect(path):
    db = sqlite3.connect(path, timeout=10)
    db.execute('PRAGMA busy_timeout=10000')
    db.execute('CREATE TABLE IF NOT EXISTS documents '
               '(collection TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, '
               'active INTEGER NOT NULL, PRIMARY KEY(collection, path))')
    db.execute('CREATE TABLE IF NOT EXISTS content_vectors '
               '(hash TEXT PRIMARY KEY, embedded_at INTEGER NOT NULL)')
    db.commit()
    return db


def collections_file(config_dir):
    return config_dir / 'synthetic-collections.json'


def read_collections(config_dir):
    path = collections_file(config_dir)
    return json.loads(path.read_text()) if path.exists() else {}


def index_collection(db, collection, folder):
    if not folder.is_dir():
        raise ValueError('missing_synthetic_projection')
    docs = [(collection, p.name, hashlib.sha256(p.read_bytes()).hexdigest(), 1)
            for p in sorted(folder.glob('*.md')) if p.is_file()]
    with db:
        db.execute('DELETE FROM documents WHERE collection=?', (collection,))
        db.executemany('INSERT INTO documents(collection,path,hash,active) VALUES(?,?,?,?)', docs)


def parse_command(args):
    """Accept only the argument shapes emitted by wiki_topical_fake_qmd.py.

    QMD 2.5.3 recognizes these flags, but its parser uses strict:false and
    silently accepts unknown options. This synthetic contract is deliberately
    narrower so a changed product call cannot pass this test unnoticed.
    """
    if args == ['update']:
        return 'update',
    if (len(args) == 7 and args[:2] == ['collection', 'add'] and
            args[3] == '--name' and args[5:] == ['--mask', '*.md'] and
            args[2] and args[4] and not args[4].startswith('-')):
        return 'collection_add', args[2], args[4]
    if (len(args) == 7 and args[0] == 'embed' and args[1] == '-c' and
            args[3] == '--max-docs-per-batch' and args[5] == '--max-batch-mb' and
            args[2] and not args[2].startswith('-') and
            all(value.isdecimal() and int(value) > 0 for value in (args[4], args[6]))):
        return 'embed', args[2]
    if (len(args) == 6 and args[0] in ('search', 'vsearch') and args[2] == '-c' and
            args[4:] == ['--format', 'json'] and args[1].strip() and
            args[3] and not args[3].startswith('-')):
        return args[0], args[1], args[3]
    raise ValueError('unsupported_synthetic_qmd_arguments')


def run(args):
    parsed = parse_command(args)
    root, db_path, config_dir = guarded_root()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    config_dir.mkdir(parents=True, exist_ok=True)
    db = connect(db_path)
    try:
        if parsed[0] == 'collection_add':
            folder = Path(parsed[1]).resolve()
            collection = parsed[2]
            if not folder.is_relative_to(root / 'qmd-projection-generations'):
                raise ValueError('projection_must_stay_in_sandbox')
            mapping = read_collections(config_dir)
            mapping[collection] = str(folder)
            collections_file(config_dir).write_text(json.dumps(mapping, sort_keys=True))
            with (config_dir / 'index.yml').open('a') as stream:
                stream.write(f'\n# synthetic collection: {collection}\n')
            index_collection(db, collection, folder)
            return
        if parsed[0] == 'update':
            for collection, folder in read_collections(config_dir).items():
                index_collection(db, collection, Path(folder))
            return
        if parsed[0] == 'embed':
            collection = parsed[1]
            hashes = [row[0] for row in db.execute(
                'SELECT hash FROM documents WHERE collection=? AND active=1 ORDER BY path',
                (collection,))]
            with db:
                for digest in hashes:
                    db.execute('INSERT OR IGNORE INTO content_vectors(hash,embedded_at) '
                               'VALUES(?,(SELECT COALESCE(MAX(embedded_at),0)+1 FROM content_vectors))',
                               (digest,))
            return
        if parsed[0] in ('search', 'vsearch'):
            kind, prompt, collection = parsed
            folder = Path(read_collections(config_dir)[collection])
            hits = []
            for name, digest in db.execute(
                    'SELECT path,hash FROM documents WHERE collection=? AND active=1 ORDER BY path',
                    (collection,)):
                if kind == 'vsearch' and not db.execute(
                        'SELECT 1 FROM content_vectors WHERE hash=?', (digest,)).fetchone():
                    continue
                if prompt.casefold() in (folder / name).read_text().casefold():
                    hits.append({'file': f'qmd://{collection}/{name}', 'score': 1.0})
            print(json.dumps(hits))
            return
        raise ValueError('unsupported_synthetic_qmd_command')
    finally:
        db.close()


if __name__ == '__main__':
    try:
        run(sys.argv[1:])
    except (IndexError, KeyError, OSError, ValueError, sqlite3.Error) as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(2)
