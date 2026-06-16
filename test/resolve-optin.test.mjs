import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

function repoTemp(prefix) {
  return realpathSync(mkdtempSync(join(process.cwd(), `.tmp-${prefix}-`)));
}

// resolve 테스트용 임시 폴더: HOME 직하(repo .git 영향권 밖)
function homeTemp(prefix) {
  const base = join(homedir(), '.tmp-qmd-test');
  mkdirSync(base, { recursive: true });
  return realpathSync(mkdtempSync(join(base, `${prefix}-`)));
}

function resolveWith(cwd, configJson, optinFile) {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], {
    input: configJson,
    env: { ...process.env, QMD_OPTIN_FILE: optinFile },
  });
  return JSON.parse(out.toString());
}

test('optin.py optout 기록 후 get=out, 미기록은 pending', () => {
  const dir = repoTemp('optin');
  const optinFile = join(dir, 'optin.json');
  const env = { ...process.env, QMD_OPTIN_FILE: optinFile };
  try {
    assert.equal(
      execFileSync('python3', ['core/optin.py', 'get', dir], { env }).toString().trim(),
      'pending',
    );
    execFileSync('python3', ['core/optin.py', 'optout', dir], { env });
    assert.equal(
      execFileSync('python3', ['core/optin.py', 'get', dir], { env }).toString().trim(),
      'out',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('미설정 폴더(.git 없음) → pending, 제안=cwd', () => {
  const dir = homeTemp('pending');
  try {
    const r = resolveWith(dir, '', join(dir, 'optin.json'));
    assert.equal(r.refused, true);
    assert.equal(r.reason, 'pending');
    assert.deepEqual(r.entries, []);
    assert.equal(r.prompt.suggestedRoot, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('.git 있으면 제안=git 루트 (모노레포 하위)', () => {
  const root = homeTemp('git');
  mkdirSync(join(root, '.git'));
  const sub = join(root, 'pkg', 'a');
  mkdirSync(sub, { recursive: true });
  try {
    const r = resolveWith(sub, '', join(root, 'optin.json'));
    assert.equal(r.reason, 'pending');
    assert.equal(r.prompt.suggestedRoot, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('optout 폴더 → refused, prompt 없음', () => {
  const dir = homeTemp('out');
  const optinFile = join(dir, 'optin.json');
  writeFileSync(optinFile, JSON.stringify({ [dir]: { state: 'out' } }));
  try {
    const r = resolveWith(dir, '', optinFile);
    assert.equal(r.refused, true);
    assert.equal(r.reason, 'optout');
    assert.equal(r.prompt, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOME → risky', () => {
  const r = resolveWith(homedir(), '', join(tmpdir(), 'no-such-optin.json'));
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'risky');
});

test('명시 설정 있으면 인덱싱(회귀 방지)', () => {
  const dir = homeTemp('cfg');
  try {
    const r = resolveWith(dir, JSON.stringify({ collections: ['mycol'] }), join(dir, 'optin.json'));
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'mycol', path: '.' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
