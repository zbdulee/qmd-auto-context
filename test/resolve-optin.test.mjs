import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

function homeTemp(prefix) {
  const base = join(homedir(), '.tmp-qmd-test');
  mkdirSync(base, { recursive: true });
  return realpathSync(mkdtempSync(join(base, `${prefix}-`)));
}
function resolveWith(cwd, configJson) {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson });
  return JSON.parse(out.toString());
}
function findConfig(cwd) {
  const script = [
    'import json, sys',
    'sys.path.insert(0, "core")',
    'import config',
    'print(json.dumps(config.find_project_config(sys.argv[1])))',
  ].join('; ');
  const out = execFileSync('python3', ['-c', script, cwd], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('파일 없음(빈 config) → pending + prompt', () => {
  const dir = homeTemp('pending');
  try {
    const r = resolveWith(dir, '');
    assert.equal(r.reason, 'pending');
    assert.equal(r.refused, true);
    assert.deepEqual(r.entries, []);
    assert.equal(r.prompt.suggestedRoot, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('indexing:false → optout (prompt 없음)', () => {
  const dir = homeTemp('out');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: false }));
    assert.equal(r.reason, 'optout');
    assert.equal(r.refused, true);
    assert.equal(r.prompt, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('indexing:true + collections → 인덱싱', () => {
  const dir = homeTemp('in');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: true, collections: ['x'] }));
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'x', path: '.' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('레거시(collections만, indexing 키 없음) → 동의', () => {
  const dir = homeTemp('legacy');
  try {
    const r = resolveWith(dir, JSON.stringify({ collections: ['x'] }));
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'x', path: '.' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('HOME → risky', () => {
  const r = resolveWith(homedir(), '');
  assert.equal(r.reason, 'risky');
});

test('indexing:true 인데 collections 없으면 pending (3경로 일관)', () => {
  const dir = homeTemp('innocoll');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: true }));
    assert.equal(r.reason, 'pending');
    assert.equal(r.refused, true);
    assert.deepEqual(r.entries, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optin: 레거시 .agents/qmd-recall.json 승계 후 제거(.bak-migrated)', () => {
  const dir = homeTemp('legmig');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['old'], skipPaths: ['s'] }));
  try {
    execFileSync('bash', ['core/update.sh', '--optin', dir]);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.deepEqual(cfg.collections, ['old']);   // 레거시 collections 승계
    assert.deepEqual(cfg.skipPaths, ['s']);
    assert.equal(existsSync(join(dir, '.agents', 'qmd-recall.json')), false);          // 레거시 제거
    assert.ok(existsSync(join(dir, '.agents', 'qmd-recall.json.bak-migrated')));        // 백업됨
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optin → .auto-context/settings.json indexing:true + collections', () => {
  const dir = homeTemp('cmdin');
  try {
    execFileSync('bash', ['core/update.sh', '--optin', dir]);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.ok(cfg.collections.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optin refuses symlinked .auto-context directory', () => {
  const dir = homeTemp('cmdin-symlink');
  const outside = homeTemp('cmdin-outside');
  try {
    symlinkSync(outside, join(dir, '.auto-context'), 'dir');
    assert.throws(() => execFileSync('bash', ['core/update.sh', '--optin', dir]));
    assert.equal(existsSync(join(outside, 'settings.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test('--optout → local decision store only (프로젝트 config 없음)', () => {
  const dir = homeTemp('cmdout-local');
  try {
    execFileSync('bash', ['core/update.sh', '--optout', dir]);
    assert.equal(existsSync(join(dir, '.auto-context')), false);
    assert.equal(existsSync(join(dir, '.auto-context.json')), false);
    const found = findConfig(dir);
    assert.equal(found.configFormat, 'local-optout');
    assert.equal(found.config.indexing, false);
    assert.deepEqual(found.config.collections, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optout local decision applies from child dirs in non-git projects', () => {
  const dir = homeTemp('cmdout-local-child');
  const child = join(dir, 'src', 'feature');
  try {
    mkdirSync(child, { recursive: true });
    execFileSync('bash', ['core/update.sh', '--optout', dir]);
    const found = findConfig(child);
    assert.equal(found.configFormat, 'local-optout');
    assert.equal(found.projectRoot, dir);
    assert.equal(found.config.indexing, false);
    assert.deepEqual(found.config.collections, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optout → local decision overrides existing project settings without editing them', () => {
  const dir = homeTemp('cmdout');
  try {
    mkdirSync(join(dir, '.auto-context'), { recursive: true });
    writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({ indexing: true, collections: ['keep'], skipPaths: ['x'] }));
    execFileSync('bash', ['core/update.sh', '--optout', dir]);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.deepEqual(cfg.collections, ['keep']);
    assert.deepEqual(cfg.skipPaths, ['x']);
    const found = findConfig(dir);
    assert.equal(found.configFormat, 'local-optout');
    assert.equal(found.config.indexing, false);
    assert.deepEqual(found.config.collections, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optin clears local optout marker and restores project config', () => {
  const dir = homeTemp('cmdout-clear');
  try {
    mkdirSync(join(dir, '.auto-context'), { recursive: true });
    writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({ indexing: true, collections: ['keep'] }));
    execFileSync('bash', ['core/update.sh', '--optout', dir]);
    assert.equal(findConfig(dir).configFormat, 'local-optout');
    execFileSync('bash', ['core/update.sh', '--optin', dir]);
    const found = findConfig(dir);
    assert.equal(found.configFormat, 'auto-context-dir');
    assert.equal(found.config.indexing, true);
    assert.deepEqual(found.config.collections, ['keep']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('--optin 따옴표 폴더명도 유효 JSON', () => {
  const dir = homeTemp('q'); const weird = join(dir, 'a"b'); mkdirSync(weird);
  try {
    execFileSync('bash', ['core/update.sh', '--optin', weird]);
    JSON.parse(readFileSync(join(weird, '.auto-context', 'settings.json'), 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optin --recommended: 추천 config 기록', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recin-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  try {
    execFileSync('bash', ['core/update.sh', '--optin', '--recommended', dir]);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.ok(cfg.collections.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optin --recommended: 기존 config 미덮음', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recex-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({ indexing: true, collections: ['keep'] }));
  try {
    assert.throws(() => execFileSync('bash', ['core/update.sh', '--optin', '--recommended', dir]));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8')).collections, ['keep']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
