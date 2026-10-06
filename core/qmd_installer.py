"""Pinned QMD npm generation installer. Never activates a generation itself.

The lock is resolved from the official npm registry and checked before any
execution. Installation requires two explicit gates because native lifecycle
scripts may fetch or build platform binaries. No QMD model cache is touched.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import uuid

import qmd_runtime

LOCK_SHA256 = 'a31cc40f0cbaa413d0b9988c6d7617daa60bb902379fac7f432e77b5b3f7cf3e'
LOCK_DIR = Path(__file__).resolve().parent.parent / 'locks/qmd-2.5.3'


def inspect_lock(lock_dir=LOCK_DIR, expected_sha256=LOCK_SHA256):
    lock_dir = Path(lock_dir)
    package = lock_dir / 'package.json'
    lock_file = lock_dir / 'package-lock.json'
    if any(path.is_symlink() or not path.is_file() for path in (package, lock_file)):
        raise ValueError('qmd_install_lock_missing')
    if qmd_runtime._sha(lock_file) != expected_sha256:
        raise ValueError('qmd_install_lock_changed')
    manifest = json.loads(package.read_text())
    locked = json.loads(lock_file.read_text())
    entries = locked.get('packages')
    if (manifest.get('private') is not True or
            manifest.get('dependencies') != {'@tobilu/qmd': qmd_runtime.VERSION} or
            locked.get('lockfileVersion') != 3 or not isinstance(entries, dict) or
            entries.get('', {}).get('dependencies') != manifest['dependencies'] or
            entries.get('node_modules/@tobilu/qmd', {}).get('version') != qmd_runtime.VERSION or
            len(entries) < 100):
        raise ValueError('invalid_qmd_install_lock')
    for name, row in entries.items():
        if not name: continue
        if (not name.startswith('node_modules/') or not isinstance(row, dict) or
                not isinstance(row.get('integrity'), str) or
                not row['integrity'].startswith('sha512-') or
                not isinstance(row.get('resolved'), str) or
                not row['resolved'].startswith('https://registry.npmjs.org/')):
            raise ValueError('unsafe_qmd_install_source')
    return {'packageCount': len(entries) - 1, 'lockSha256': expected_sha256,
            'packageIntegrity': entries['node_modules/@tobilu/qmd']['integrity']}


def _node(node):
    node = Path(node).resolve()
    if not node.is_file() or not os.access(node, os.X_OK):
        raise ValueError('qmd_node_missing')
    info = node.stat()
    if info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
        raise ValueError('unsafe_qmd_node')
    version = subprocess.run([str(node), '--version'], capture_output=True,
        text=True, timeout=10, check=False)
    if version.returncode or not re.fullmatch(r'v\d+\.\d+\.\d+', version.stdout.strip()) or int(version.stdout.strip().split('.')[0][1:]) < 22:
        raise ValueError('qmd_node_unsupported')
    return node


def _npm(npm):
    npm = Path(npm).resolve()
    if not npm.is_file() or not os.access(npm, os.X_OK):
        raise ValueError('qmd_npm_missing')
    info = npm.stat()
    if info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
        raise ValueError('unsafe_qmd_npm')
    return npm


def _native_probe(node, qmd):
    code = ('const {createRequire}=require("node:module");'
            'const use=createRequire(process.argv[1]);'
            'const Sqlite=use("better-sqlite3");'
            'const db=new Sqlite(":memory:");db.close();')
    result = subprocess.run([str(node), '-e', code, str(qmd)],
        capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        raise ValueError('qmd_native_probe_failed')


def install_new(root, *, node, npm, allow_execution=False,
                allow_lifecycle_scripts=False, lock_dir=LOCK_DIR,
                expected_lock_sha256=LOCK_SHA256, runner=subprocess.run,
                native_probe=_native_probe):
    """Install only in a new owner-private inactive generation.

    An explicit caller may enable lifecycle scripts only after reviewing the
    locked native package postinstall/build behavior. The selected pointer and
    all existing QMD databases, cache, PATH, and project settings are untouched.
    """
    locked = inspect_lock(lock_dir, expected_lock_sha256)
    if not allow_execution:
        raise ValueError('qmd_install_execution_not_enabled')
    if not allow_lifecycle_scripts:
        raise ValueError('qmd_native_lifecycle_approval_required')
    node = _node(node); npm = _npm(npm)
    root = qmd_runtime._private(root, create=True)
    generations = qmd_runtime._private(root / 'generations', create=True)
    if shutil.disk_usage(root).free < 512 * 1024 * 1024:
        raise ValueError('insufficient_qmd_install_disk')
    generation = generations / ('g-' + uuid.uuid4().hex)
    generation.mkdir(mode=0o700)
    package_dir = generation / 'package'; package_dir.mkdir(mode=0o700)
    for filename in ('package.json', 'package-lock.json'):
        target = package_dir / filename
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write((Path(lock_dir) / filename).read_bytes())
            output.flush(); os.fsync(output.fileno())
    (generation / '.npmrc').write_text('', encoding='utf8')
    (generation / '.npmrc').chmod(0o600)
    cache = generation / 'npm-cache'; cache.mkdir(mode=0o700)
    env = {**os.environ, 'PATH': str(node.parent) + os.pathsep + os.environ.get('PATH', ''),
           'NPM_CONFIG_CACHE': str(cache),
           'NPM_CONFIG_USERCONFIG': str(generation / '.npmrc'),
           'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org/',
           'NPM_CONFIG_AUDIT': 'false', 'NPM_CONFIG_FUND': 'false'}
    result = runner([str(npm), 'ci', '--include=optional', '--no-audit', '--no-fund'],
        cwd=package_dir, env=env, capture_output=True, text=True,
        timeout=1800, check=False)
    log = generation / 'install.log'
    log.write_text(((result.stdout or '')[-8192:] + '\n' +
                    (result.stderr or '')[-8192:] + '\n'), encoding='utf8')
    log.chmod(0o600)
    if result.returncode:
        raise ValueError('qmd_npm_install_failed')
    if qmd_runtime._sha(package_dir / 'package-lock.json') != locked['lockSha256']:
        raise ValueError('qmd_lock_changed_during_install')
    qmd = package_dir / 'node_modules/@tobilu/qmd/bin/qmd'
    proof = qmd_runtime._probe(qmd, node)
    native_probe(node, qmd)
    wrapper = generation / 'qmd'
    import shlex
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(str(node)) + ' ' +
                       shlex.quote(str(qmd)) + ' "$@"\n')
    wrapper.chmod(0o700)
    qmd_runtime._write(generation / 'prepared.json', {'schema': qmd_runtime.SCHEMA,
        'proof': proof, 'wrapper': str(wrapper), 'wrapperSha256': qmd_runtime._sha(wrapper),
        'installLockSha256': locked['lockSha256']})
    return {'status': 'prepared_inactive', 'generation': str(generation),
            'wrapper': str(wrapper), 'packageCount': locked['packageCount']}
