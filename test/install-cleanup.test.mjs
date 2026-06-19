// Explicit legacy cleanup keeps marketplace/plugin install separate from old global hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLEANUP = 'scripts/cleanup-legacy.sh';

test('cleanup-legacy: codex 글로벌 adapters hook 제거, 비-qmd 보존', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-home-'));
  try {
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/keep.py' }] },
          { hooks: [{ type: 'command', command: `python3 ${process.cwd()}/adapters/codex/wrapper.py update` }] },
        ],
      },
    }));

    execFileSync('bash', [CLEANUP], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'codex' },
    });

    const after = JSON.parse(readFileSync(join(codexDir, 'hooks.json'), 'utf8'));
    const cmds = JSON.stringify(after);
    assert.ok(cmds.includes('keep.py'), '비-qmd hook 보존');
    assert.ok(!cmds.includes('adapters/codex/wrapper.py'), 'adapters hook 제거됨');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cleanup-legacy: codex hooks.json이 깨진 JSON이면 덮지 않고 abort', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-home-'));
  try {
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const broken = '{ "hooks": { invalid';
    writeFileSync(join(codexDir, 'hooks.json'), broken);
    assert.throws(() => {
      execFileSync('bash', [CLEANUP], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'codex' },
      });
    });
    assert.equal(readFileSync(join(codexDir, 'hooks.json'), 'utf8'), broken, '깨진 파일 원본 보존');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cleanup-legacy: 레거시 qmd 훅 제거 + 비-qmd 훅 보존', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cleanup-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'bash -c "cat | python3 ~/.claude/scripts/qmd-recall-on-prompt.py"' }] },
          { hooks: [{ type: 'command', command: 'echo keep-me' }] },
        ],
      },
    }));

    execFileSync('bash', [CLEANUP], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude' },
    });

    const d = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const cmds = d.hooks.UserPromptSubmit.flatMap(e => (e.hooks || []).map(h => h.command));
    assert.ok(!cmds.some(c => c.includes('qmd-recall-on-prompt')), '기존 qmd 훅이 제거되지 않음');
    assert.ok(cmds.some(c => c.includes('keep-me')), '무관한 기존 훅이 보존되지 않음');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cleanup-legacy: nested hooks[].command 에 등록된 어댑터도 제거하고 원자적으로 쓴다', () => {
  const src = readFileSync(CLEANUP, 'utf8');
  assert.match(src, /os\.replace/, 'cleanup config write must use tmp + os.replace');

  const home = mkdtempSync(join(tmpdir(), 'qmd-cleanup-nested-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `python3 ${process.cwd()}/adapters/claude/wrapper.py recall` }] },
          { hooks: [{ type: 'command', command: 'echo keep-me' }] },
        ],
      },
    }));

    execFileSync('bash', [CLEANUP], {
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude' },
    });

    const d = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const cmds = d.hooks.UserPromptSubmit.flatMap(e => (e.hooks || []).map(h => h.command));
    assert.deepEqual(cmds, ['echo keep-me']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
