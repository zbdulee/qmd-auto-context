// agy 최종 리뷰 FIX-REQUIRED 회귀 방지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJ = resolve('test/fixtures/story-proj');

test('CRITICAL: Gemini AfterTool 이벤트도 posttool 동작', () => {
  const out = execFileSync('python3', ['core/posttool.py'], {
    input: JSON.stringify({
      hook_event_name: 'AfterTool',
      tool_name: 'Write',
      tool_input: { file_path: `${PROJ}/04_Manuscript/ep004-상가-음식.md`, content: '4화 집필. 도준이 죽었다는 문장 확인.' },
      cwd: PROJ,
    }),
    encoding: 'utf8',
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-ep.json' },
  });
  const r = out.trim() ? JSON.parse(out) : null;
  assert.ok(r, 'AfterTool 이벤트가 무시됨 (Gemini posttool 무동작)');
});

test('MAJOR: cleanup-legacy 모든 config 쓰기가 원자적 (직접 open w 금지)', () => {
  const src = readFileSync('scripts/cleanup-legacy.sh', 'utf8');
  // encoding 등 추가 인자가 있어도 매치 (닫는 괄호 전까지)
  assert.ok(!/open\(\s*config_path\s*,\s*["']w["']/.test(src),
    'register_hooks 가 config_path 를 직접 "w" 로 덮어씀 — tmp+os.replace 필요');
});

test('MAJOR: cleanup-legacy 깨진 settings.json → 기존 데이터 보존(빈 {}로 덮지 않음)', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-broken-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const broken = '{ "hooks": broken not valid json';
    writeFileSync(join(home, '.claude', 'settings.json'), broken);
    let threw = false;
    try {
      execFileSync('bash', ['scripts/cleanup-legacy.sh'], {
        env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude' },
      });
    } catch { threw = true; }
    const after = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    // 깨진 설정은 함부로 덮으면 안 됨: install 이 abort(threw) 했거나, 깨진 원본을 어딘가 보존해야 함.
    // data={} 로 진행해 어댑터만 든 새 파일로 덮으면 원본 유실 → 실패.
    const brokenPreserved = after.includes('broken not valid');
    assert.ok(threw || brokenPreserved,
      '깨진 설정 파싱 실패 시 abort 하지 않고 진행 → 원본 데이터 유실');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('MAJOR: cleanup-legacy backend 제거 계획 포함', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-unb-'));
  try {
    const out = execFileSync('bash', ['scripts/cleanup-legacy.sh', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude,codex,gemini' },
    });
    assert.match(out, /backend|\.config\/qmd/i, 'backend 제거 계획 없음');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
