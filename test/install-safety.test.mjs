// agy install 안전 리뷰 FIX-REQUIRED 회귀 방지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
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

test('Critical: backend install backs up unmanaged daemon assets and writes managed markers', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-backend-safe-'));
  const bin = join(home, 'bin');
  try {
    mkdirSync(join(home, '.config', 'qmd'), { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(home, '.config', 'qmd', 'daemon.sh'), '#!/usr/bin/env sh\necho user daemon\n');
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), '<plist><dict><key>User</key></dict></plist>\n');

    execFileSync('bash', ['install.sh'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        QMD_FAKE_PLATFORMS: 'none',
        QMD_INSTALL_SKIP_SELFTEST: '1',
        QMD_MIGRATE_SCAN: join(home, 'no-such-dir'),
      },
    });

    const qmdFiles = readdirSync(join(home, '.config', 'qmd'));
    const launchFiles = readdirSync(join(home, 'Library', 'LaunchAgents'));
    assert.ok(qmdFiles.some(name => name.startsWith('daemon.sh.bak-')), 'unmanaged daemon.sh backup missing');
    assert.ok(launchFiles.some(name => name.startsWith('com.qmd-mcp-daemon.plist.bak-')), 'unmanaged plist backup missing');
    assert.match(readFileSync(join(home, '.config', 'qmd', 'daemon.sh'), 'utf8'), /managed-by: qmd-auto-context/);
    assert.match(readFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), 'utf8'), /managed-by: qmd-auto-context/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Critical: backend uninstall removes only managed daemon assets', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-backend-uninstall-'));
  const bin = join(home, 'bin');
  try {
    mkdirSync(join(home, '.config', 'qmd'), { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(home, '.config', 'qmd', 'daemon.sh'), '#!/usr/bin/env sh\necho user daemon\n');
    writeFileSync(join(home, '.config', 'qmd', 'keepalive.sh'), '# managed-by: qmd-auto-context\necho managed\n');
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), '<plist><dict><key>User</key></dict></plist>\n');
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-keepalive.plist'), '<!-- managed-by: qmd-auto-context -->\n<plist/>\n');

    execFileSync('bash', ['uninstall.sh'], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, QMD_FAKE_PLATFORMS: 'none' },
    });

    assert.equal(readFileSync(join(home, '.config', 'qmd', 'daemon.sh'), 'utf8'), '#!/usr/bin/env sh\necho user daemon\n');
    assert.equal(readFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), 'utf8'), '<plist><dict><key>User</key></dict></plist>\n');
    assert.throws(() => readFileSync(join(home, '.config', 'qmd', 'keepalive.sh'), 'utf8'));
    assert.throws(() => readFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-keepalive.plist'), 'utf8'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

test('High: collectionPaths 마이그레이션은 파일별 timestamp 백업을 남긴다', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-migrate-bak-'));
  try {
    const agents = join(home, 'novel', 'book', '.agents');
    mkdirSync(agents, { recursive: true });
    const configPath = join(agents, 'qmd-recall.json');
    const original = JSON.stringify({ name: 'n', collections: ['x-manuscript'], minScore: 0.8 });
    writeFileSync(configPath, original);

    execFileSync('bash', ['install.sh'], {
      env: {
        ...process.env,
        HOME: home,
        QMD_FAKE_PLATFORMS: 'none',
        QMD_INSTALL_SKIP_BACKEND: '1',
        QMD_INSTALL_SKIP_SELFTEST: '1',
        QMD_MIGRATE_SCAN: join(home, 'novel'),
      },
    });

    // collectionPaths 마이그레이션은 원본 timestamp 백업을 남긴다(안전 속성 유지).
    const backups = readdirSync(agents).filter(name => name.startsWith('qmd-recall.json.bak-'));
    assert.equal(backups.length, 1, 'timestamp backup missing (중복 백업 없이 원본 1개)');
    assert.equal(readFileSync(join(agents, backups[0]), 'utf8'), original);
    // 이후 .auto-context.json 으로 승격된다: collectionPaths 정규화 보존 + indexing:true, 레거시는 제거.
    const promoted = JSON.parse(readFileSync(join(home, 'novel', 'book', '.auto-context.json'), 'utf8'));
    assert.deepEqual(promoted.collectionPaths, { 'x-manuscript': '04_Manuscript' });
    assert.equal(promoted.indexing, true);
    assert.equal(existsSync(configPath), false, '승격 후 레거시 qmd-recall.json 제거');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
