import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers/temp.mjs';

const ROOT = process.cwd();

function runEnable(project, args = []) {
  return execFileSync('bash', [join(ROOT, 'core/update.sh'), '--enable-compile', project, ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT } });
}

// 생성기가 delta-only라(기본값과 같은 키는 안 쓴다) "무엇이 적용됐나"는 emit이 아니라
// normalize_config 통과 결과로 봐야 한다.
function effectiveCompile(project) {
  const py = `import json, sys
sys.path.insert(0, "core")
import config as qmd_config
with open(sys.argv[1], encoding="utf-8") as fh:
    print(json.dumps(qmd_config.normalize_config(json.load(fh))["compile"], ensure_ascii=False))`;
  return JSON.parse(execFileSync('python3',
    ['-c', py, join(project, '.auto-context', 'settings.json')], { cwd: ROOT, encoding: 'utf8' }));
}

function optedInProject() {
  const d = mkdtempSync(join(tmpdir(), 'enable-compile-'));
  mkdirSync(join(d, '.auto-context'), { recursive: true });
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['proj-docs'], collectionPaths: { 'proj-docs': 'docs' },
  }));
  return d;
}

test('--enable-compile wires compile block with portable built-in engines', () => {
  const project = optedInProject();
  try {
    const out = runEnable(project);
    const cfg = JSON.parse(readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.compile.enabled, true);
    assert.equal(cfg.compile.extractor.dispatch, 'by-engine');
    assert.deepEqual(cfg.compile.extractor.backends, {});
    assert.deepEqual(cfg.compile.extractor.builtins, ['claude', 'codex', 'hermes']);
    // delta-only: reasoningEffort는 전 항목이 기본값과 같아 emit되지 않는다.
    // 실제 적용값은 effective config로 확인한다(emit 축소 ≠ 동작 변경).
    assert.equal(cfg.compile.reasoningEffort, undefined);
    assert.deepEqual(effectiveCompile(project).reasoningEffort, {
      generation: 'low', verify: 'medium', semanticDedup: 'medium', engines: {},
    });
    assert.doesNotMatch(JSON.stringify(cfg.compile), new RegExp(`${ROOT}|core/extractors|_adapter\\\\.py`));
    assert.ok(cfg.compile.triggers.includes('post_tool_source'));
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'SCHEMA.md')), true); // scaffolded
    assert.match(out, /auto-compile/i); // disclosure printed
  } finally { removeTemp(project); }
});

test('--enable-compile --engines limits built-in engines', () => {
  const project = optedInProject();
  try {
    runEnable(project, ['--engines', 'codex']);
    const cfg = JSON.parse(readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(cfg.compile.extractor.builtins, ['codex']);
    assert.deepEqual(cfg.compile.extractor.backends, {});
  } finally { removeTemp(project); }
});

// 생성기가 delta-only가 되기 전, --enable-compile은 **전체 블록으로 기존 compile을
// 덮어써서** 기본값과 다른 기존 값을 기본값으로 리셋했다. delta로 바꾸면서 "안 쓰기"만
// 하면 그 값들이 살아남아 effective가 달라진다 — 그래서 병합 쪽이 생략된 키를 지운다.
// effective 동결 fixture는 **신규 프로젝트**만 덮으므로 이 경로는 여기서만 잡힌다.
test('--enable-compile: 생략된 키는 기존 비기본값을 남기지 않는다 (덮어쓰기 의미 보존)', () => {
  const project = optedInProject();
  try {
    const settings = join(project, '.auto-context', 'settings.json');
    const cfg = JSON.parse(readFileSync(settings, 'utf8'));
    cfg.compile = { verify: { maxPerRun: 15 }, maxAutoPageLines: 200 };
    writeFileSync(settings, JSON.stringify(cfg));

    runEnable(project);
    const updated = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(updated.compile.verify, undefined, 'delta-only: verify는 emit되지 않는다');
    assert.equal(updated.compile.maxAutoPageLines, undefined);
    // 예전 동작(블록이 덮어써서 기본값)과 동일한 effective여야 한다.
    const eff = effectiveCompile(project);
    assert.equal(eff.verify.maxPerRun, 3);
    assert.equal(eff.maxAutoPageLines, 120);
  } finally { removeTemp(project); }
});

test('--enable-compile preserves existing explicit extractor configuration', () => {
  const project = optedInProject();
  try {
    const settings = join(project, '.auto-context', 'settings.json');
    const cfg = JSON.parse(readFileSync(settings, 'utf8'));
    cfg.compile = {
      enabled: false,
      extractor: {
        argv: ['python3', 'custom-extractor.py'],
        dispatch: 'by-engine',
        backends: { claude: ['python3', 'claude-extractor.py'] },
        default: ['python3', 'fallback-extractor.py'],
        timeout: 9,
      },
      triggers: ['manual'],
    };
    writeFileSync(settings, JSON.stringify(cfg));

    runEnable(project);
    const updated = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(updated.compile.enabled, true);
    assert.deepEqual(updated.compile.extractor.argv, ['python3', 'custom-extractor.py']);
    assert.deepEqual(updated.compile.extractor.backends, { claude: ['python3', 'claude-extractor.py'] });
    assert.deepEqual(updated.compile.extractor.default, ['python3', 'fallback-extractor.py']);
    assert.equal(updated.compile.extractor.timeout, 9);
    assert.ok(updated.compile.triggers.includes('manual'));
    assert.ok(updated.compile.triggers.includes('post_tool_source'));
  } finally { removeTemp(project); }
});

test('--enable-compile is idempotent', () => {
  const project = optedInProject();
  try {
    runEnable(project);
    const first = readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8');
    runEnable(project);
    const second = readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8');
    assert.equal(JSON.parse(first).compile.triggers.filter((t) => t === 'post_tool_source').length, 1);
    assert.deepEqual(JSON.parse(first).compile, JSON.parse(second).compile);
  } finally { removeTemp(project); }
});

test('--enable-compile refuses a non-opted-in project', () => {
  const d = mkdtempSync(join(tmpdir(), 'enable-compile-bare-'));
  try {
    const out = runEnable(d);
    assert.match(out, /--optin/);
    assert.equal(existsSync(join(d, '.auto-context', 'settings.json')), false);
  } finally { removeTemp(d); }
});

test('--enable-compile refuses a subdir under an opted-in parent (target has no own settings.json)', () => {
  // Parent is opted in; subdir has NO own settings.json.
  // The guard must reject (output matches /--optin/) and must NOT crash.
  const parent = mkdtempSync(join(tmpdir(), 'enable-compile-parent-'));
  const subdir = join(parent, 'subproject');
  try {
    mkdirSync(join(parent, '.auto-context'), { recursive: true });
    mkdirSync(join(parent, 'docs'), { recursive: true });
    writeFileSync(join(parent, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['parent-docs'], collectionPaths: { 'parent-docs': 'docs' },
    }));
    mkdirSync(subdir, { recursive: true });
    // subdir intentionally has no settings.json of its own
    let out;
    assert.doesNotThrow(() => {
      out = execFileSync('bash', [join(ROOT, 'core/update.sh'), '--enable-compile', subdir],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT } });
    });
    assert.match(out, /--optin/);
    assert.equal(existsSync(join(subdir, '.auto-context', 'settings.json')), false);
  } finally { removeTemp(parent); }
});

test('--enable-compile refuses project opted-in via legacy .auto-context.json (no settings.json)', () => {
  // A project opted in only via the legacy .auto-context.json must be refused.
  // The output must mention --migrate-config and no .auto-context/settings.json must be created.
  const d = mkdtempSync(join(tmpdir(), 'enable-compile-legacy-'));
  try {
    writeFileSync(join(d, '.auto-context.json'), JSON.stringify({
      indexing: true, collections: ['legacy-col'], collectionPaths: { 'legacy-col': '.' },
    }));
    const out = runEnable(d);
    assert.match(out, /--migrate-config/, 'output must mention --migrate-config');
    assert.equal(existsSync(join(d, '.auto-context', 'settings.json')), false,
      '.auto-context/settings.json must NOT be created for legacy-only opted-in project');
  } finally { removeTemp(d); }
});

test('--enable-compile --engines codex <project> (engines BEFORE path) sets builtins to exactly [codex]', () => {
  const project = optedInProject();
  try {
    // Pass --engines BEFORE the project path to verify both arg orderings work
    const out = execFileSync('bash', [join(ROOT, 'core/update.sh'), '--enable-compile', '--engines', 'codex', project],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT } });
    const cfg = JSON.parse(readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(cfg.compile.extractor.builtins, ['codex']);
    assert.deepEqual(cfg.compile.extractor.backends, {});
  } finally { removeTemp(project); }
});
