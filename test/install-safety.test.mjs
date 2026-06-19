// Regression coverage for removing product install/uninstall scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLEANUP = 'scripts/cleanup-legacy.sh';

test('Critical: product install/uninstall shell entrypoints are absent', () => {
  assert.equal(existsSync('install.sh'), false);
  assert.equal(existsSync('uninstall.sh'), false);
});

test('High: cleanup-legacy hook config writes are atomic', () => {
  const src = readFileSync(CLEANUP, 'utf8');
  assert.match(src, /os\.replace/, 'legacy hook cleanup must use tmp + os.replace');
});

test('Critical: cleanup dry-run does not touch backend files', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-backend-safe-'));
  try {
    mkdirSync(join(home, '.config', 'qmd'), { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(home, '.config', 'qmd', 'daemon.sh'), '#!/usr/bin/env sh\necho user daemon\n');
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), '<plist><dict><key>User</key></dict></plist>\n');

    const out = execFileSync('bash', [CLEANUP, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'none' },
    });

    assert.match(out, /legacy backend cleanup plan/);
    assert.equal(readFileSync(join(home, '.config', 'qmd', 'daemon.sh'), 'utf8'), '#!/usr/bin/env sh\necho user daemon\n');
    assert.equal(readFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), 'utf8'), '<plist><dict><key>User</key></dict></plist>\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Critical: cleanup removes only managed daemon assets', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-backend-cleanup-'));
  const bin = join(home, 'bin');
  try {
    mkdirSync(join(home, '.config', 'qmd'), { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(home, '.config', 'qmd', 'daemon.sh'), '#!/usr/bin/env sh\necho user daemon\n');
    writeFileSync(join(home, '.config', 'qmd', 'keepalive.sh'), '# managed-by: qmd-auto-context\necho managed\n');
    writeFileSync(join(home, '.config', 'qmd', 'index_worker.sh'), '# managed-by: qmd-auto-context\necho managed\n');
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), '<plist><dict><key>User</key></dict></plist>\n');
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-keepalive.plist'), '<!-- managed-by: qmd-auto-context -->\n<plist/>\n');
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-index-worker.plist'), '<!-- managed-by: qmd-auto-context -->\n<plist/>\n');

    execFileSync('bash', [CLEANUP], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QMD_FAKE_PLATFORMS: 'none' },
    });

    assert.equal(readFileSync(join(home, '.config', 'qmd', 'daemon.sh'), 'utf8'), '#!/usr/bin/env sh\necho user daemon\n');
    assert.equal(readFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), 'utf8'), '<plist><dict><key>User</key></dict></plist>\n');
    assert.equal(existsSync(join(home, '.config', 'qmd', 'keepalive.sh')), false);
    assert.equal(existsSync(join(home, '.config', 'qmd', 'index_worker.sh')), false);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-keepalive.plist')), false);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-index-worker.plist')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
