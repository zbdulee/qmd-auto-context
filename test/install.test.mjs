import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('plugin package no longer exposes install.sh or uninstall.sh', () => {
  assert.equal(existsSync('install.sh'), false);
  assert.equal(existsSync('uninstall.sh'), false);
});

test('cleanup-legacy dry-run is explicit and creates no files', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cleanup-dry-'));
  try {
    const out = execFileSync('bash', ['scripts/cleanup-legacy.sh', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude,codex,gemini' },
    });
    assert.match(out, /legacy backend cleanup plan/);
    assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('agy local hook registration has a dedicated script', () => {
  const project = mkdtempSync(join(tmpdir(), 'qmd-agy-local-'));
  try {
    mkdirSync(project, { recursive: true });
    execFileSync('bash', ['scripts/agy-local-hook-install.sh', project], { encoding: 'utf8' });
    const hooks = JSON.parse(readFileSync(join(project, '.agents', 'hooks.json'), 'utf8'));
    const commands = hooks.hooks.PostToolUse.flatMap(entry => entry.hooks.map(hook => hook.command));
    assert.ok(commands.some(command => command.includes('run-hook') && command.includes('posttool gemini')));
    assert.ok(commands.some(command => command.includes('run-hook') && command.includes('index gemini')));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
