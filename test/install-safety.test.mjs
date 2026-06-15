// agy install 안전 리뷰 FIX-REQUIRED 회귀 방지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function dryRun(home, env = {}) {
  return execFileSync('bash', ['install.sh', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude,codex,gemini', ...env },
  });
}

test('High: novel 마이그레이션 원자적 쓰기 (tmp + os.replace)', () => {
  const src = readFileSync('install.sh', 'utf8');
  assert.ok(/os\.replace|\.tmp/.test(src), 'qmd-recall.json 마이그레이션이 비원자적 쓰기(직접 "w") — tmp+os.replace 필요');
});

test('High: 최초 설치 시 qmd 없는 기존 설정도 오리지널 백업 (롤백 보장)', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-safe-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    // qmd 와 무관한 기존 사용자 설정
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }));
    const out = dryRun(home);
    assert.match(out, /original|오리지널|backup/i);
    // qmd 없으니 'no .bak needed' 로 끝나면 안 됨 (오리지널 백업 계획이 있어야)
    assert.ok(!/no .bak needed[\s\S]*settings\.json/i.test(out) || /original/i.test(out),
      '기존 설정이 있는데 백업 없이 진행하려 함');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
