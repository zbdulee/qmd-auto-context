// install 이 기존 qmd user 훅을 제거하고 어댑터(표준구조)로 교체하는지 (SSOT 대체) 격리 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('install.sh: codex 글로벌 adapters hook 제거, 비-qmd 보존', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-home-'));
  try {
    const codexDir = join(home, '.codex');
    execFileSync('mkdir', ['-p', codexDir]);
    writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/keep.py' }] },
          { hooks: [{ type: 'command', command: `python3 ${process.cwd()}/adapters/codex/wrapper.py update` }] },
        ],
      },
    }));
    execFileSync('bash', ['install.sh', '--migrate-only'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'codex',
             QMD_INSTALL_SKIP_BACKEND: '1', QMD_INSTALL_SKIP_SELFTEST: '1', QMD_CLEANUP_ONLY: '1' },
    });
    const after = JSON.parse(readFileSync(join(codexDir, 'hooks.json'), 'utf8'));
    const cmds = JSON.stringify(after);
    assert.ok(cmds.includes('keep.py'), '비-qmd hook 보존');
    assert.ok(!cmds.includes('adapters/codex/wrapper.py'), 'adapters hook 제거됨');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install.sh: codex hooks.json이 깨진 JSON이면 덮지 않고 abort/skip', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-home-'));
  try {
    const codexDir = join(home, '.codex');
    execFileSync('mkdir', ['-p', codexDir]);
    const broken = '{ "hooks": { invalid';
    writeFileSync(join(codexDir, 'hooks.json'), broken);
    try {
      execFileSync('bash', ['install.sh', '--migrate-only'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'codex',
               QMD_INSTALL_SKIP_BACKEND: '1', QMD_INSTALL_SKIP_SELFTEST: '1', QMD_CLEANUP_ONLY: '1' },
      });
    } catch { /* abort 종료여도 OK */ }
    assert.equal(readFileSync(join(codexDir, 'hooks.json'), 'utf8'), broken, '깨진 파일 원본 보존(덮지 않음)');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install: 레거시 qmd 훅 제거 + 비-qmd 훅 보존 (Plan B: 등록 없음)', () => {
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
      encoding: 'utf8',
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

    // 1) 기존 qmd 훅 제거 (레거시 cleanup)
    assert.ok(!cmds.some(c => c.includes('qmd-recall-on-prompt')), '기존 qmd 훅이 제거되지 않음');
    // 2) Plan B: install.sh는 더 이상 어댑터를 등록하지 않음 (plugins/ 경로가 담당)
    assert.ok(!cmds.some(c => c.includes('auto-context')), 'Plan B: install.sh가 어댑터를 등록하면 안 됨');
    // 3) 비-qmd 훅 보존
    assert.ok(cmds.some(c => c.includes('keep-me')), '무관한 기존 훅이 보존되지 않음');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall.sh: 글로벌 adapters hook 제거', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-home-'));
  const codexDir = join(home, '.codex');
  execFileSync('mkdir', ['-p', codexDir]);
  writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command',
      command: `python3 ${process.cwd()}/adapters/codex/wrapper.py update` }] }] },
  }));
  execFileSync('bash', ['uninstall.sh'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'codex' },
  });
  const after = readFileSync(join(codexDir, 'hooks.json'), 'utf8');
  assert.ok(!after.includes('adapters/codex/wrapper.py'), 'adapters hook 제거됨');
  rmSync(home, { recursive: true, force: true });
});

test('uninstall.sh: legacy qmd hook 제거 + 비-qmd 보존', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-uninstall-legacy-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'bash -c "cat | python3 ~/.claude/scripts/qmd-recall-on-prompt.py"' }] },
        { hooks: [{ type: 'command', command: 'echo keep-me' }] },
      ],
    },
  }));
  execFileSync('bash', ['uninstall.sh'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QMD_FAKE_PLATFORMS: 'claude' },
  });
  const after = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  const cmds = (after.hooks?.UserPromptSubmit ?? []).flatMap(e => (e.hooks || []).map(h => h.command));
  assert.ok(!cmds.some(c => c.includes('qmd-recall-on-prompt')), 'legacy qmd hook 제거됨');
  assert.ok(cmds.some(c => c.includes('keep-me')), '비-qmd hook 보존됨');
  rmSync(home, { recursive: true, force: true });
});

test('uninstall: nested hooks[].command 에 등록된 어댑터도 제거하고 원자적으로 쓴다', () => {
  const src = readFileSync('uninstall.sh', 'utf8');
  assert.match(src, /os\.replace/, 'uninstall config write must use tmp + os.replace');

  const home = mkdtempSync(join(tmpdir(), 'qmd-uninstall-nested-'));
  const bin = join(home, 'bin');
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `python3 ${process.cwd()}/adapters/claude/wrapper.py recall` }] },
          { hooks: [{ type: 'command', command: 'echo keep-me' }] },
        ],
      },
    }));

    execFileSync('bash', ['uninstall.sh'], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QMD_FAKE_PLATFORMS: 'claude' },
    });

    const d = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const cmds = d.hooks.UserPromptSubmit.flatMap(e => (e.hooks || []).map(h => h.command));
    assert.deepEqual(cmds, ['echo keep-me']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
