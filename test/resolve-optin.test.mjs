import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedHomeProject, removeTemp } from './helpers/temp.mjs';

// 이 파일의 --optin/--optout 은 core/config.py 의 로컬 decision store(`$HOME/.config/qmd/optout`)를
// 실제로 쓴다. 예전엔 프로젝트 cwd 만 임시로 만들고 HOME 은 실제 값을 그대로 써서, 실행마다
// 사용자 홈에 지워지지 않는 마커 3개를 남겼다(실측 누적 1,972개/7.7MB). 그래서 모든 케이스가
// 가짜 HOME 하위에서 돌고 자식 프로세스 env 에 그 HOME 을 넘긴다 — 격리를 지우지 말 것.
function homeProject(prefix) {
  return isolatedHomeProject(prefix);
}
function resolveWith(cwd, configJson, env = process.env) {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson, env });
  return JSON.parse(out.toString());
}
function findConfig(cwd, env = process.env) {
  const script = [
    'import json, sys',
    'sys.path.insert(0, "core")',
    'import config',
    'print(json.dumps(config.find_project_config(sys.argv[1])))',
  ].join('; ');
  const out = execFileSync('python3', ['-c', script, cwd], { encoding: 'utf8', env });
  return JSON.parse(out);
}

test('파일 없음(빈 config) → pending + prompt', () => {
  const { home, dir, env } = homeProject('pending');
  try {
    const r = resolveWith(dir, '', env());
    assert.equal(r.reason, 'pending');
    assert.equal(r.refused, true);
    assert.deepEqual(r.entries, []);
    assert.equal(r.prompt.suggestedRoot, dir);
  } finally { removeTemp(home); }
});
test('indexing:false → optout (prompt 없음)', () => {
  const { home, dir, env } = homeProject('out');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: false }), env());
    assert.equal(r.reason, 'optout');
    assert.equal(r.refused, true);
    assert.equal(r.prompt, undefined);
  } finally { removeTemp(home); }
});
test('indexing:true + collections → 인덱싱', () => {
  const { home, dir, env } = homeProject('in');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: true, collections: ['x'] }), env());
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'x', path: '.' }]);
  } finally { removeTemp(home); }
});
test('레거시(collections만, indexing 키 없음) → 동의', () => {
  const { home, dir, env } = homeProject('legacy');
  try {
    const r = resolveWith(dir, JSON.stringify({ collections: ['x'] }), env());
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'x', path: '.' }]);
  } finally { removeTemp(home); }
});
test('HOME → risky', () => {
  // 사용자 실제 홈이 아니라 가짜 HOME 자체를 cwd 로 준다 — is_risky_path 는 `Path.home()`
  // 과 비교하므로 판정 대상은 동일하다.
  const { home, env } = homeProject('riskyhome');
  try {
    const r = resolveWith(home, '', env());
    assert.equal(r.reason, 'risky');
  } finally { removeTemp(home); }
});

test('indexing:true 인데 collections 없으면 pending (3경로 일관)', () => {
  const { home, dir, env } = homeProject('innocoll');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: true }), env());
    assert.equal(r.reason, 'pending');
    assert.equal(r.refused, true);
    assert.deepEqual(r.entries, []);
  } finally { removeTemp(home); }
});

test('--optin: 레거시 .agents/qmd-recall.json 승계 후 제거(.bak-migrated)', () => {
  const { home, dir, env } = homeProject('legmig');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['old'], skipPaths: ['s'] }));
  try {
    execFileSync('bash', ['core/update.sh', '--optin', dir], { env: env() });
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.deepEqual(cfg.collections, ['old']);   // 레거시 collections 승계
    assert.deepEqual(cfg.skipPaths, ['s']);
    assert.equal(existsSync(join(dir, '.agents', 'qmd-recall.json')), false);          // 레거시 제거
    assert.ok(existsSync(join(dir, '.agents', 'qmd-recall.json.bak-migrated')));        // 백업됨
  } finally { removeTemp(home); }
});

test('--optin → .auto-context/settings.json indexing:true + collections', () => {
  const { home, dir, env } = homeProject('cmdin');
  try {
    execFileSync('bash', ['core/update.sh', '--optin', dir], { env: env() });
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.ok(cfg.collections.length >= 1);
  } finally { removeTemp(home); }
});

test('--optin refuses symlinked .auto-context directory', () => {
  const { home, dir, env } = homeProject('cmdin-symlink');
  const outside = join(home, 'outside');
  try {
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(dir, '.auto-context'), 'dir');
    assert.throws(() => execFileSync('bash', ['core/update.sh', '--optin', dir], { env: env() }));
    assert.equal(existsSync(join(outside, 'settings.json')), false);
  } finally { removeTemp(home); }
});
test('--optout → local decision store only (프로젝트 config 없음)', () => {
  const { home, dir, env } = homeProject('cmdout-local');
  try {
    execFileSync('bash', ['core/update.sh', '--optout', dir], { env: env() });
    assert.equal(existsSync(join(dir, '.auto-context')), false);
    assert.equal(existsSync(join(dir, '.auto-context.json')), false);
    const found = findConfig(dir, env());
    assert.equal(found.configFormat, 'local-optout');
    assert.equal(found.config.indexing, false);
    assert.deepEqual(found.config.collections, []);
  } finally { removeTemp(home); }
});

test('--optout local decision applies from child dirs in non-git projects', () => {
  const { home, dir, env } = homeProject('cmdout-local-child');
  const child = join(dir, 'src', 'feature');
  try {
    mkdirSync(child, { recursive: true });
    execFileSync('bash', ['core/update.sh', '--optout', dir], { env: env() });
    const found = findConfig(child, env());
    assert.equal(found.configFormat, 'local-optout');
    assert.equal(found.projectRoot, dir);
    assert.equal(found.config.indexing, false);
    assert.deepEqual(found.config.collections, []);
  } finally { removeTemp(home); }
});

test('--optout → local decision overrides existing project settings without editing them', () => {
  const { home, dir, env } = homeProject('cmdout');
  try {
    mkdirSync(join(dir, '.auto-context'), { recursive: true });
    writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({ indexing: true, collections: ['keep'], skipPaths: ['x'] }));
    execFileSync('bash', ['core/update.sh', '--optout', dir], { env: env() });
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.deepEqual(cfg.collections, ['keep']);
    assert.deepEqual(cfg.skipPaths, ['x']);
    const found = findConfig(dir, env());
    assert.equal(found.configFormat, 'local-optout');
    assert.equal(found.config.indexing, false);
    assert.deepEqual(found.config.collections, []);
  } finally { removeTemp(home); }
});

test('--optin clears local optout marker and restores project config', () => {
  const { home, dir, env } = homeProject('cmdout-clear');
  try {
    mkdirSync(join(dir, '.auto-context'), { recursive: true });
    writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({ indexing: true, collections: ['keep'] }));
    execFileSync('bash', ['core/update.sh', '--optout', dir], { env: env() });
    assert.equal(findConfig(dir, env()).configFormat, 'local-optout');
    execFileSync('bash', ['core/update.sh', '--optin', dir], { env: env() });
    const found = findConfig(dir, env());
    assert.equal(found.configFormat, 'auto-context-dir');
    assert.equal(found.config.indexing, true);
    assert.deepEqual(found.config.collections, ['keep']);
  } finally { removeTemp(home); }
});
test('--optin 따옴표 폴더명도 유효 JSON', () => {
  const { home, dir, env } = homeProject('q');
  const weird = join(dir, 'a"b');
  mkdirSync(weird);
  try {
    execFileSync('bash', ['core/update.sh', '--optin', weird], { env: env() });
    JSON.parse(readFileSync(join(weird, '.auto-context', 'settings.json'), 'utf8'));
  } finally { removeTemp(home); }
});

test('--recommend --json: 미기록, 추천 출력', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rec-cli-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  try {
    const out = execFileSync('bash', ['core/update.sh', '--recommend', '--json', dir], { encoding: 'utf8' });
    const r = JSON.parse(out);
    assert.equal(r.available, true);
    assert.equal(existsSync(join(dir, '.auto-context.json')), false);
    assert.equal(existsSync(join(dir, '.auto-context', 'settings.json')), false);
  } finally { removeTemp(dir); }
});

test('--optin --recommended: 추천 config 기록', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recin-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  try {
    execFileSync('bash', ['core/update.sh', '--optin', '--recommended', dir]);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.ok(cfg.collections.length >= 1);
    // 활성화는 mode 하나. delta-only라 기본값과 같은 backends는 emit되지 않고,
    // 실제 적용값은 normalize_config 통과 결과로 확인한다.
    assert.equal(cfg.compile.mode, 'auto-wiki');
    assert.deepEqual(cfg.compile.extractor.builtins, ['claude', 'codex', 'hermes']);
    assert.equal(cfg.compile.extractor.backends, undefined);
    assert.doesNotMatch(JSON.stringify(cfg.compile), /core\/extractors|_adapter\.py/);
    const eff = JSON.parse(execFileSync('python3', ['-c', `import json, sys
sys.path.insert(0, "core")
import config as qmd_config
with open(sys.argv[1], encoding="utf-8") as fh:
    print(json.dumps(qmd_config.normalize_config(json.load(fh))["compile"], ensure_ascii=False))`,
    join(dir, '.auto-context', 'settings.json')], { cwd: process.cwd(), encoding: 'utf8' }));
    assert.equal(eff.mode, 'auto-wiki');
    assert.deepEqual(eff.extractor.backends, {});
  } finally { removeTemp(dir); }
});

test('--optin --recommended: wiki scaffold created (.auto-context/wiki/SCHEMA.md exists)', () => {
  // After --optin --recommended on a project with docs/, the recommended config includes a
  // wiki collection. The optin path must scaffold .auto-context/wiki/ so qmd update does not
  // fail when it tries to add a nonexistent wiki directory as a collection.
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recin-wiki-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  try {
    execFileSync('bash', ['core/update.sh', '--optin', '--recommended', dir], { encoding: 'utf8' });
    assert.equal(existsSync(join(dir, '.auto-context', 'wiki', 'SCHEMA.md')), true,
      '.auto-context/wiki/SCHEMA.md must be scaffolded by --optin --recommended');
  } finally { removeTemp(dir); }
});

test('--optin --recommended: 기존 config 미덮음', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recex-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({ indexing: true, collections: ['keep'] }));
  try {
    assert.throws(() => execFileSync('bash', ['core/update.sh', '--optin', '--recommended', dir]));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8')).collections, ['keep']);
  } finally { removeTemp(dir); }
});
