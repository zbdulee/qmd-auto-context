import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function dryRun(home, env = {}) {
  return execFileSync('bash', ['install.sh', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude,codex,gemini', ...env },
  });
}

test('dry-run: 3플랫폼 등록 계획 + 기존 백업 계획 출력', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-inst-'));
  try {
    const out = dryRun(home);
    assert.match(out, /claude/);
    assert.match(out, /codex/);
    assert.match(out, /gemini/);
    assert.match(out, /backup|\.bak/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dry-run은 실제 파일을 생성하지 않음', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-inst-'));
  try {
    dryRun(home);
    assert.ok(!existsSync(join(home, '.claude', 'settings.json')), 'dry-run이 settings.json 생성함');
    assert.ok(!existsSync(join(home, 'Library', 'LaunchAgents')), 'dry-run이 launchd 설치함');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall.sh dry-run 실행 가능', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-inst-'));
  try {
    const out = execFileSync('bash', ['uninstall.sh', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude,codex,gemini' },
    });
    assert.match(out, /restore|복원|\.bak|remove|제거/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
