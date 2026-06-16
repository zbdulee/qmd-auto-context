// install 이 기존 qmd user 훅을 제거하고 어댑터(표준구조)로 교체하는지 (SSOT 대체) 격리 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('install: 기존 qmd 훅 제거 + 어댑터 표준 등록 + 비-qmd 훅 보존', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cleanup-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    // 기존: qmd recall 훅 + 무관한 keep-me 훅
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'bash -c "cat | python3 ~/.claude/scripts/qmd-recall-on-prompt.py"' }] },
          { hooks: [{ type: 'command', command: 'echo keep-me' }] },
        ],
      },
    }));

    execFileSync('bash', ['install.sh'], {
      env: {
        ...process.env, HOME: home,
        QMD_FAKE_PLATFORMS: 'claude',
        QMD_INSTALL_SKIP_BACKEND: '1',
        QMD_INSTALL_SKIP_SELFTEST: '1',
        QMD_MIGRATE_SCAN: join(home, 'no-such-dir'),
      },
    });

    const d = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const ups = d.hooks.UserPromptSubmit;
    const cmds = ups.flatMap(e => (e.hooks || []).map(h => h.command));

    // 1) 기존 qmd 훅 제거 (SSOT 대체)
    assert.ok(!cmds.some(c => c.includes('qmd-recall-on-prompt')), '기존 qmd 훅이 제거되지 않음');
    // 2) 어댑터 등록 + 표준 구조(hooks 배열)
    const autoEntry = ups.find(e => (e.hooks || []).some(h => (h.command || '').includes('auto-context')));
    assert.ok(autoEntry, '어댑터가 표준 hooks 배열 구조로 등록되지 않음');
    assert.ok(cmds.some(c => c.includes('auto-context') && c.includes('recall')), 'recall 어댑터 미등록');
    // 3) 비-qmd 훅 보존
    assert.ok(cmds.some(c => c.includes('keep-me')), '무관한 기존 훅이 보존되지 않음');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
