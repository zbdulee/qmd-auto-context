"""Single QMD executable and project-index routing contract.

Every caller selects the same managed executable and the same project DB,
config and cache tuple. An active project pointer always wins over inherited
global paths; a writer may require conflicting inherited paths to be rejected.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys

import qmd_runtime
import runtime_update

PATH_KEYS = ('INDEX_PATH', 'QMD_CONFIG_DIR', 'XDG_CACHE_HOME')


def _absolute_executable(value):
    path = Path(value)
    if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError('qmd_binary_missing')
    return path


def binary_info(environ=None):
    """Resolve the command and the actual Node entry from one runtime proof."""
    env = environ if environ is not None else os.environ
    explicit = env.get('QMD_BIN')
    active = qmd_runtime.managed_root(env.get('HOME')) / 'active.json'
    managed = None
    if active.is_file() or active.is_symlink():
        managed = qmd_runtime.select(qmd_runtime.managed_root(env.get('HOME')))
    if managed and (not explicit or Path(explicit) == Path(managed['wrapper'])):
        proof = managed['proof']
        binary = _absolute_executable(managed['wrapper'])
        package_bin = _absolute_executable(proof['qmd'])
        node = _absolute_executable(proof['node'])
        override = env.get('QMD_NODE_BIN')
        if override and Path(override).resolve() != node.resolve():
            raise ValueError('managed_qmd_node_conflict')
        entry = package_bin.parent.parent / 'dist/cli/qmd.js'
        if not entry.is_file() or entry.is_symlink():
            # bin/qmd is a JavaScript entry in the pinned package too.
            entry = package_bin
        return {'QMD_BIN': str(binary), 'QMD_ENTRY': str(entry),
                'QMD_NODE_BIN': str(node), 'QMD_PACKAGE_BIN': str(package_bin),
                'managed': True}
    if explicit:
        binary = _absolute_executable(explicit)
    else:
        found = shutil.which('qmd', path=env.get('PATH'))
        if not found: raise ValueError('qmd_binary_missing')
        binary = _absolute_executable(Path(found).resolve())
    real = binary.resolve()
    entry = real.parent.parent / 'dist/cli/qmd.js'
    if not entry.is_file(): entry = real
    return {'QMD_BIN': str(binary), 'QMD_ENTRY': str(entry),
            'QMD_NODE_BIN': env.get('QMD_NODE_BIN') or '',
            'QMD_PACKAGE_BIN': str(real), 'managed': False}


def project_paths(project_root, *, environ=None, isolated=False,
                  reject_conflicts=False, fixture_env=False):
    """Resolve an atomic DB/config/cache tuple; never mix pointer and env."""
    env = environ if environ is not None else os.environ
    root = Path(project_root).resolve()
    selected = runtime_update.select_runtime(root)
    if selected:
        if reject_conflicts:
            for key in PATH_KEYS:
                inherited = env.get(key)
                if inherited and Path(inherited).resolve() != Path(selected[key]).resolve():
                    raise ValueError('project_index_env_conflict')
        return {**{key: str(selected[key]) for key in PATH_KEYS},
                'selected': True, 'generation': selected['generation']}
    if isolated and not fixture_env:
        raise ValueError('isolated_qmd_runtime_required')
    if isolated:
        paths = {}
        for key in PATH_KEYS:
            value = env.get(key)
            if not value or not Path(value).is_absolute():
                raise ValueError('isolated_qmd_runtime_required')
            path = Path(value)
            if path.is_symlink() or root not in path.resolve().parents:
                raise ValueError('qmd_runtime_outside_project')
            paths[key] = str(path)
    else:
        cache = Path(env.get('XDG_CACHE_HOME') or Path.home() / '.cache')
        index = Path(env.get('INDEX_PATH') or cache / 'qmd/index.sqlite')
        config = Path(env.get('QMD_CONFIG_DIR') or
            Path(env.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'qmd')
        if any(not path.is_absolute() for path in (cache,index,config)):
            raise ValueError('invalid_qmd_runtime_path')
        paths = {'INDEX_PATH': str(index), 'QMD_CONFIG_DIR': str(config),
                 'XDG_CACHE_HOME': str(cache)}
    return {**paths, 'selected': False, 'generation': None}


if __name__ == '__main__':
    try:
        command = sys.argv[1]
        if command == 'resolve-bin' and len(sys.argv) == 2:
            print(binary_info()['QMD_BIN'])
        elif command == 'daemon-spec' and len(sys.argv) == 2:
            info = binary_info()
            values = (info['QMD_ENTRY'], info['QMD_NODE_BIN'], info['QMD_PACKAGE_BIN'])
            if any(any(c in value for c in ('\x1f','\t','\n','\r')) for value in values):
                raise ValueError('unsafe_qmd_runtime_path')
            print('\x1f'.join(values))
        elif command == 'resolve-env' and len(sys.argv) == 3:
            selected = runtime_update.select_runtime(sys.argv[2])
            if selected:
                values = [selected[key] for key in PATH_KEYS]
                if any(any(c in value for c in ('\t','\n','\r')) for value in values):
                    raise ValueError('unsafe_qmd_runtime_path')
                print('\t'.join(values))
        else:
            raise SystemExit(2)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        raise SystemExit(1)
