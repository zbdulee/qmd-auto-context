import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// macOS /tmp → /private/tmp is a risky path in resolve_paths.
// Use HOME/.cache as base to get non-risky tmpdir.
function makeTmpDir() {
  const base = join(homedir(), '.cache');
  try { mkdirSync(base, { recursive: true }); } catch {}
  return mkdtempSync(join(base, 'qmd-gate-'));
}

function gate(payload, env = {}) {
  return execFileSync('python3', ['core/preflight_gate.py'], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  });
}

test('pending(config 없음) + Edit → deny', () => {
  const dir = makeTmpDir();
  try {
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: 's1' });
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('동의(indexing:true+collections) → allow(무출력)', () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['x'] }));
  try {
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: 's1' });
    assert.equal(out.trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('거절(indexing:false) → allow', () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: false }));
  try {
    assert.equal(gate({ tool_name: 'Edit', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('로컬 optout marker → allow', () => {
  const dir = makeTmpDir();
  try {
    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--optout', dir], { encoding: 'utf8' });
    assert.equal(gate({ tool_name: 'Edit', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox → allow', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(gate({ tool_name: 'Edit', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }, { QMD_SANDBOX: '1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('잘못된 tool_name(Read) → allow', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(gate({ tool_name: 'Read', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex apply_patch(patch, file_path 없음) + pending → deny (경로 무관)', () => {
  const dir = makeTmpDir();
  try {
    const out = gate({ tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\n*** End Patch' }, cwd: dir, session_id: 's1' });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Task 7: --skip 마커 테스트 ---

// skip 마커 파일 경로를 JS에서 계산 (core/preflight_gate.py와 동일 알고리즘: sha256(realpath(cwd)))
function skipMarkerPath(cwd) {
  // realpath on macOS: /Users/... (no /private prefix for ~/.cache paths)
  const realcwd = execFileSync('python3', ['-c', `import os; print(os.path.realpath(${JSON.stringify(cwd)}))`], { encoding: 'utf8' }).trim();
  const hash = createHash('sha256').update(realcwd).digest('hex');
  return join(homedir(), '.config', 'qmd', 'skip', hash);
}

test('--skip <dir> 실행 후 gate(cwd=dir) → allow(무출력)', () => {
  const dir = makeTmpDir();
  try {
    // Step 1: --skip 실행
    const skipOut = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--skip', dir], {
      encoding: 'utf8',
    });
    // 안내 메시지가 있어야 함
    assert.ok(skipOut.length > 0, `--skip should print a message, got: ${JSON.stringify(skipOut)}`);

    // Step 2: gate 호출 → allow (무출력)
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: 's1' });
    assert.equal(out.trim(), '', `skip 마커 후 gate가 allow(무출력)이어야 함, got: ${out}`);
  } finally {
    // 마커 정리
    try { rmSync(skipMarkerPath(dir), { force: true }); } catch (_) {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip 안 한 다른 pending dir → deny', () => {
  const dir1 = makeTmpDir();
  const dir2 = makeTmpDir();
  try {
    // dir1만 skip
    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--skip', dir1], { encoding: 'utf8' });

    // dir2는 skip 안 했으므로 deny
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir2, 'a.md') }, cwd: dir2, session_id: 's1' });
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny', `skip 안 한 dir2는 deny여야 함`);
  } finally {
    try { rmSync(skipMarkerPath(dir1), { force: true }); } catch (_) {}
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('TTL 만료된 마커 → deny + 마커 unlink', () => {
  const dir = makeTmpDir();
  const markerPath = skipMarkerPath(dir);
  try {
    // --skip으로 마커 생성
    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--skip', dir], { encoding: 'utf8' });

    // 마커가 생성됐는지 확인
    assert.ok(existsSync(markerPath), `마커 파일이 생성돼야 함: ${markerPath}`);

    // mtime을 3시간 전으로 조작 (TTL 2시간 초과)
    const pastTime = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(markerPath, pastTime, pastTime);

    // gate 호출 → TTL 만료로 deny
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: 's1' });
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny', `TTL 만료 마커는 deny여야 함`);

    // lazy expire: 마커가 unlink 됐어야 함
    assert.ok(!existsSync(markerPath), `TTL 만료 마커는 unlink 돼야 함: ${markerPath}`);
  } finally {
    try { rmSync(markerPath, { force: true }); } catch (_) {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config/resolve_paths 조회 중 예상 못한 예외가 나도 gate는 fail-open(exit 0, 무출력)한다', () => {
  // gate는 soft protection이라, 샌드박스/권한 등 환경 차이로 config 조회 자체가
  // 죽더라도(예: PermissionError) hook 프로세스가 non-zero exit로 죽어 편집을
  // 막는 사고를 방지해야 한다. load_project_config를 강제로 raise시켜 검증한다.
  const script = `
import sys, json
sys.path.insert(0, 'core')
import config as qmd_config
import preflight_gate as pg

def boom(cwd):
    raise PermissionError("simulated sandboxed fs error")
qmd_config.load_project_config = boom

import io
sys.stdin = io.StringIO(json.dumps({"tool_name": "Edit", "tool_input": {"file_path": "/tmp/a.md"}, "cwd": "/tmp/does-not-matter"}))
rc = pg.main()
assert rc == 0, rc
print("OK")
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8', cwd: process.cwd() }).trim();
  assert.equal(out, 'OK');
});
