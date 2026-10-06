"""Adopt a dedicated existing QMD 2.5.3 without copying its package or models."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0,'core')
import qmd_runtime

qmd=Path('/Users/dulee/work/.qmd-tools/bin/qmd')
node=Path(shutil.which('node') or '')
if not qmd.is_file() or not node.is_file():
    print(json.dumps({'skipped':'existing dedicated QMD/Node unavailable'}))
    raise SystemExit(0)
with tempfile.TemporaryDirectory(prefix='qmd-runtime-managed-') as name:
    root=Path(name).resolve();root.chmod(0o700)
    assert qmd_runtime._probe(qmd,node)['version']=='2.5.3'
    stage=qmd_runtime.prepare_existing(root,qmd,node)
    assert stage['status']=='prepared_inactive' and not (root/'active.json').exists()
    assert Path(stage['wrapper']).stat().st_size<512
    qmd_runtime.activate(root,stage['generation'])
    selected=qmd_runtime.select(root)
    assert selected['proof']['qmdSha256']==stage['proof']['qmdSha256']
    version=subprocess.run([selected['wrapper'],'--version'],capture_output=True,
        text=True,check=True,timeout=10)
    assert version.stdout.strip()=='qmd 2.5.3'
    wrapper=Path(stage['wrapper'])
    wrapper.write_text('#!/bin/sh\nexit 0\n')
    try:
        qmd_runtime.select(root)
    except ValueError as error:
        assert str(error)=='qmd_runtime_changed'
    else:
        raise AssertionError('wrapper_tamper_not_detected')
    print(json.dumps({'adoptedWithoutCopy':True,'versionAndCommandsChecked':True,
        'wrapperTamperFailsClosed':True,'externalCalls':0}))
