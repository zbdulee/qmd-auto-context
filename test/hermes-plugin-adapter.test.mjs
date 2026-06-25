import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runPython(source, env = {}) {
  return execFileSync('python3', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: process.cwd(), ...env },
  }).trim();
}

function makeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

function makeFakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'qmd-hermes-root-'));
  const core = join(root, 'core');
  mkdirSync(core, { recursive: true });
  const managerLog = join(root, 'manager.log');
  makeExecutable(join(core, 'backend_manager.sh'), `#!/usr/bin/env bash\necho "$@" >> "${managerLog}"\n`);
  return { root, core, managerLog };
}

test('Hermes plugin manifest declares qmd hook adapter only, leaving Claude/Codex manifests separate', () => {
  assert.equal(existsSync('plugin.yaml'), true, 'Hermes plugin.yaml should exist at repo root');
  const manifest = readFileSync('plugin.yaml', 'utf8');
  assert.match(manifest, /name:\s*qmd-auto-context/);
  for (const hook of ['pre_llm_call', 'on_session_start', 'pre_tool_call', 'post_tool_call']) {
    assert.match(manifest, new RegExp(hook), `missing ${hook}`);
  }
  assert.equal(existsSync('hooks/hooks.json'), true, 'Claude hook manifest remains in hooks/');
  assert.equal(existsSync('hooks/hooks-codex.json'), true, 'Codex hook manifest remains in hooks/');
});

test('Hermes root plugin shim registers lifecycle hooks through hermes_adapter.plugin', () => {
  assert.equal(existsSync('__init__.py'), true, 'Hermes directory plugin entrypoint should exist');
  const rootInit = readFileSync('__init__.py', 'utf8');
  assert.match(rootInit, /hermes_adapter\.plugin/);
  const plugin = readFileSync('hermes_adapter/plugin.py', 'utf8');
  for (const hook of ['pre_llm_call', 'on_session_start', 'pre_tool_call', 'post_tool_call']) {
    assert.match(plugin, new RegExp(`register_hook\\(["']${hook}["']`), `missing register_hook(${hook})`);
  }
});

test('Hermes recall bridge delegates to core/recall.py and returns pre_llm_call context', () => {
  const { root, core, managerLog } = makeFakeRoot();
  const stdinLog = join(root, 'recall.stdin.json');
  makeExecutable(join(core, 'recall.py'), `#!/usr/bin/env python3\nimport json, os, sys\nopen("${stdinLog}", "w").write(sys.stdin.read())\nprint(json.dumps({"hookSpecificOutput":{"additionalContext":"관련 문서:\\n- [sample] docs/a.md"}}))\n`);
  try {
    const out = runPython(`
import json
from hermes_adapter.core_bridge import recall_context
print(json.dumps(recall_context(user_message='검색 결과 정렬?', cwd='/tmp/project')))
`, { QMD_HERMES_PLUGIN_ROOT_FOR_TEST: root, QMD_QUERY_FIXTURE: 'fixture.json' });
    assert.deepEqual(JSON.parse(out), { context: '관련 문서:\n- [sample] docs/a.md' });
    const payload = JSON.parse(readFileSync(stdinLog, 'utf8'));
    assert.equal(payload.hook_event_name, 'UserPromptSubmit');
    assert.equal(payload.prompt, '검색 결과 정렬?');
    assert.equal(payload.cwd, '/tmp/project');
    assert.equal(existsSync(managerLog), false, 'fixture mode should skip backend ensure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes session update bridge mirrors run-hook backend lifecycle order', () => {
  const { root, core, managerLog } = makeFakeRoot();
  const stdinLog = join(root, 'update.stdin.json');
  makeExecutable(join(core, 'update.sh'), `#!/usr/bin/env bash\ncat > "${stdinLog}"\n`);
  try {
    runPython(`
from hermes_adapter.core_bridge import session_update
session_update(cwd='/tmp/project')
`, { QMD_HERMES_PLUGIN_ROOT_FOR_TEST: root });
    assert.equal(readFileSync(managerLog, 'utf8'), 'ensure --wait\nwarm\nrotate\n');
    const payload = JSON.parse(readFileSync(stdinLog, 'utf8'));
    assert.equal(payload.hook_event_name, 'SessionStart');
    assert.equal(payload.cwd, '/tmp/project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes pre_tool_call gate maps write_file to core Write deny block', () => {
  const { root, core } = makeFakeRoot();
  const stdinLog = join(root, 'gate.stdin.json');
  makeExecutable(join(core, 'preflight_gate.py'), `#!/usr/bin/env python3\nimport json, sys\nopen("${stdinLog}", "w").write(sys.stdin.read())\nprint(json.dumps({"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"pending project"}}))\n`);
  try {
    const out = runPython(`
import json
from hermes_adapter.core_bridge import pre_edit_gate
print(json.dumps(pre_edit_gate(tool_name='write_file', args={'path':'docs/a.md','content':'x'}, cwd='/tmp/project')))
`, { QMD_HERMES_PLUGIN_ROOT_FOR_TEST: root });
    assert.deepEqual(JSON.parse(out), { action: 'block', message: 'pending project' });
    const payload = JSON.parse(readFileSync(stdinLog, 'utf8'));
    assert.equal(payload.hook_event_name, 'PreToolUse');
    assert.equal(payload.tool_name, 'Write');
    assert.equal(payload.tool_input.file_path, 'docs/a.md');
    assert.equal(payload.cwd, '/tmp/project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes post_tool_call index maps patch mode=patch and kicks worker after enqueue', () => {
  const { root, core, managerLog } = makeFakeRoot();
  const stdinLog = join(root, 'index.stdin.json');
  makeExecutable(join(core, 'index_enqueue.py'), `#!/usr/bin/env python3\nimport sys\nopen("${stdinLog}", "w").write(sys.stdin.read())\n`);
  makeExecutable(join(core, 'posttool.py'), '#!/usr/bin/env python3\nimport sys\nsys.stdin.read()\n');
  try {
    runPython(`
from hermes_adapter.core_bridge import post_edit_sync
post_edit_sync(tool_name='patch', args={'mode':'patch','patch':'*** Begin Patch'}, result='{}', status='ok', cwd='/tmp/project')
`, { QMD_HERMES_PLUGIN_ROOT_FOR_TEST: root });
    assert.equal(readFileSync(managerLog, 'utf8'), 'ensure --wait\nkick-index\n');
    const payload = JSON.parse(readFileSync(stdinLog, 'utf8'));
    assert.equal(payload.hook_event_name, 'PostToolUse');
    assert.equal(payload.tool_name, 'apply_patch');
    assert.equal(payload.tool_input.patch, '*** Begin Patch');
    assert.equal(payload.cwd, '/tmp/project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes bridge does not reimplement qmd daemon/query logic', () => {
  const bridge = readFileSync('hermes_adapter/core_bridge.py', 'utf8');
  assert.doesNotMatch(bridge, /\/query/);
  assert.doesNotMatch(bridge, /urlopen|requests\./);
  for (const script of ['core/recall.py', 'core/update.sh', 'core/index_enqueue.py', 'core/preflight_gate.py']) {
    assert.match(bridge, new RegExp(script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
