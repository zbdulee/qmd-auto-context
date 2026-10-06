"""Pinned npm installer staging with a synthetic runner; no npm ci is run."""
import json
import os
from pathlib import Path
import shutil
from types import SimpleNamespace
import sys
import tempfile

sys.path.insert(0, 'core')
import qmd_installer as installer
import qmd_runtime

node = shutil.which('node')
if not node:
    print(json.dumps({'skipped': 'Node unavailable'})); raise SystemExit(0)
locked = installer.inspect_lock()
assert locked['packageCount'] > 100
assert locked['packageIntegrity'] == ('sha512-wUKc4pSPDbgs7mV7JYE8/Qj1pNXXatJFV8byTT/'
    'T3yLaoAXheFtWu0BgSWwoWGhRkMmxl5Qyitt66NHgbMyeBA==')
with tempfile.TemporaryDirectory(prefix='qmd-install-fake-') as name:
    base = Path(name).resolve(); root = base / 'managed'
    npm = base / 'fake-npm'; npm.write_text('#!/bin/sh\nexit 99\n'); npm.chmod(0o700)
    calls = []
    def fake_runner(command, *, cwd, env, **kwargs):
        calls.append(command)
        assert command[1:] == ['ci', '--include=optional', '--no-audit', '--no-fund']
        assert env['NPM_CONFIG_CACHE'].startswith(str(root))
        assert env['NPM_CONFIG_USERCONFIG'].startswith(str(root))
        assert env['NPM_CONFIG_REGISTRY'] == 'https://registry.npmjs.org/'
        package = cwd / 'node_modules/@tobilu/qmd'
        (package / 'bin').mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'version': '2.5.3'}))
        qmd = package / 'bin/qmd'
        qmd.write_text('const args=process.argv.slice(2);\n'
            'if(args.includes("--version")) console.log("qmd 2.5.3");\n'
            'else if(args.includes("--help")) console.log('+json.dumps(' '.join(qmd_runtime.CAPABILITIES))+');\n')
        qmd.chmod(0o700)
        return SimpleNamespace(returncode=0,stdout='synthetic npm ci',stderr='')
    for kwargs, reason in [({}, 'qmd_install_execution_not_enabled'),
                           ({'allow_execution': True}, 'qmd_native_lifecycle_approval_required')]:
        try: installer.install_new(root,node=node,npm=npm,runner=fake_runner,**kwargs)
        except ValueError as exc: assert str(exc) == reason
        else: raise AssertionError('install gate missing')
    assert calls == [] and not root.exists()
    staged = installer.install_new(root,node=node,npm=npm,allow_execution=True,
        allow_lifecycle_scripts=True,runner=fake_runner,native_probe=lambda *_: None)
    assert staged['status'] == 'prepared_inactive' and not (root/'active.json').exists()
    assert len(calls) == 1
    qmd_runtime.activate(root, staged['generation'])
    assert qmd_runtime.select(root)['wrapper'] == staged['wrapper']
    print(json.dumps({'lockedPackages': locked['packageCount'],
        'noActualNpmExecution': True, 'inactiveStage': True,
        'explicitLifecycleGate': True, 'isolatedActivationTest': True}))
