"""Synthetic CLI argument contract, including rejection of unknown options."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path

CLI = Path(__file__).resolve().parents[2] / 'test_support/topical-fake-qmd-cli.mjs'


def call(root, env, *args):
    return subprocess.run(['node', str(CLI), *args], cwd=root, env=env,
                          capture_output=True, text=True, timeout=15)


with tempfile.TemporaryDirectory(prefix='topical-fake-qmd-contract-') as name:
    root = Path(name)
    (root / '.qmd-topical-sandbox').write_text('synthetic\n')
    projection = root / 'qmd-projection-generations/g-synthetic'
    projection.mkdir(parents=True)
    (projection / 'card.md').write_text('# Synthetic card\n\nBlue beacon.\n')
    env = {**os.environ, 'INDEX_PATH': str(root / 'qmd-db/index.sqlite'),
           'QMD_CONFIG_DIR': str(root / 'qmd-config'),
           'XDG_CACHE_HOME': str(root / 'qmd-cache'),
           'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
           'QMD_RECALL_LOG': ''}
    bad_before = [
        ('collection', 'add', str(projection), '--name', 'synthetic', '--mask', '*.md', '--bogus-flag'),
        ('collection', 'add', str(projection), '--name', 'synthetic'),
        ('update', '--bogus-flag'),
        ('embed', '-c', 'synthetic', '--max-docs-per-batch', '1', '--max-batch-mb', '1', '--bogus-flag'),
        ('embed', '-c', 'synthetic', '--max-docs-per-batch', '0', '--max-batch-mb', '1'),
        ('search', 'blue', '-c', 'synthetic', '--format', 'json', '--bogus-flag'),
        ('vsearch', 'blue', '-c', 'synthetic', '--format', 'csv'),
        ('unknown',),
    ]
    for args in bad_before:
        result = call(root, env, *args)
        assert result.returncode == 2 and 'unsupported_synthetic_qmd_arguments' in result.stderr, (args, result)
    assert not Path(env['INDEX_PATH']).exists()

    valid = [
        ('collection', 'add', str(projection), '--name', 'synthetic', '--mask', '*.md'),
        ('update',),
        ('embed', '-c', 'synthetic', '--max-docs-per-batch', '1', '--max-batch-mb', '1'),
    ]
    for args in valid:
        result = call(root, env, *args)
        assert result.returncode == 0, (args, result)
    for kind in ('search', 'vsearch'):
        result = call(root, env, kind, 'blue', '-c', 'synthetic', '--format', 'json')
        assert result.returncode == 0 and len(json.loads(result.stdout)) == 1, result
    with sqlite3.connect(env['INDEX_PATH']) as db:
        before = db.execute('SELECT count(*) FROM documents').fetchone()[0], \
                 db.execute('SELECT count(*) FROM content_vectors').fetchone()[0]
    assert before == (1, 1), before
    for args in bad_before:
        result = call(root, env, *args)
        assert result.returncode == 2, (args, result)
    with sqlite3.connect(env['INDEX_PATH']) as db:
        after = db.execute('SELECT count(*) FROM documents').fetchone()[0], \
                db.execute('SELECT count(*) FROM content_vectors').fetchone()[0]
    assert after == before
    print(json.dumps({'accepted': len(valid) + 2, 'rejected': 2 * len(bad_before),
                      'rejectedWithoutDbMutation': True, 'backend': 'synthetic_cli_only'}))
