// WAL 누적 버그 수정 회귀 방지 (codex+agy 교차검토 반영)
// 원인: embed/logrotate 후 `launchctl kickstart -k`(SIGKILL)가 데몬 clean shutdown을
// 막아 SQLite WAL checkpoint가 생략 → 팽창한 WAL이 잔존·누적 → vec query 20초.
// 수정: SIGTERM(`launchctl kill TERM`)으로 graceful shutdown 유도(데몬이 checkpoint),
// KeepAlive=true plist 가 자동 respawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const update = readFileSync('core/update.sh', 'utf8');
const logrotate = readFileSync('backend/logrotate.sh', 'utf8');
const plist = readFileSync('backend/launchd/com.qmd-mcp-daemon.plist', 'utf8');
const keepalivePlist = readFileSync('backend/launchd/com.qmd-keepalive.plist', 'utf8');
const logrotatePlist = readFileSync('backend/launchd/com.qmd-logrotate.plist', 'utf8');

test('CRITICAL: update.sh embed 후 데몬 재시작에 kickstart -k(SIGKILL) 금지', () => {
  assert.ok(!/kickstart\s+-k/.test(update),
    'update.sh 가 kickstart -k(SIGKILL) 사용 — clean shutdown 차단 → WAL checkpoint 누락');
});

test('CRITICAL: update.sh 가 graceful SIGTERM(launchctl kill TERM) 으로 데몬 재시작', () => {
  assert.match(update, /launchctl\s+kill\s+TERM\s+"?gui\/\$\(id\s+-u\)\/com\.qmd-mcp-daemon/,
    'update.sh 에 graceful TERM 재시작이 없음');
});

test('MAJOR: update.sh embed 재시작 후 bounded health-wait 루프 (respawn 공백 빈 출력 방지)', () => {
  // curl .../health 를 제한된 루프(for/while + seq 또는 카운터)로 폴링하는지
  assert.match(update, /health/, 'health 폴링 없음');
  assert.ok(/for\s+\w*\s+in\s+\$\(seq|while\s+\[/.test(update),
    'health-wait 가 bounded loop 형태가 아님 (무한 대기 위험)');
});

test('CRITICAL: logrotate.sh 도 kickstart -k(SIGKILL) 금지 — 같은 WAL 누락 재발 방지', () => {
  assert.ok(!/kickstart\s+-k/.test(logrotate),
    'logrotate.sh 가 kickstart -k 사용 — 로그 회전 시 WAL checkpoint 누락 재도입');
});

test('CRITICAL: logrotate.sh 도 graceful SIGTERM 으로 데몬 재시작', () => {
  assert.match(logrotate, /launchctl\s+kill\s+TERM\s+"?gui\/\$\(\/usr\/bin\/id\s+-u\)\/com\.qmd-mcp-daemon/,
    'logrotate.sh 에 graceful TERM 재시작이 없음');
});

test('plist 가 graceful respawn 전제(KeepAlive)를 유지', () => {
  // SIGTERM 종료 후 launchd 자동 respawn 의 전제. 제거되면 데몬이 안 뜸.
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/, 'KeepAlive=true 가 빠지면 TERM 후 데몬이 죽은 채 안 뜸');
});

test('plist가 graceful shutdown 대기 시간(ExitTimeOut)을 30초 이상으로 충분히 확보했는지 검증', () => {
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/, 'ExitTimeOut 설정이 누락됨');
  const match = plist.match(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/);
  const timeout = parseInt(match[1], 10);
  assert.ok(timeout >= 30, `ExitTimeOut(${timeout}s)이 너무 짧음 (최소 30초 필요 — 대용량 WAL checkpoint 확보용)`);
});

test('plist 내부의 스크립트 파일명이 daemon.sh와 일치하는지 검증 (qmd-daemon.sh 오타 방지)', () => {
  assert.match(plist, /<string>@@HOME@@\/\.config\/qmd\/daemon\.sh<\/string>/, 'plist가 존재하지 않는 qmd-daemon.sh를 가리킴');
});

// install.sh 는 daemon.sh / keepalive.sh / logrotate.sh 로 배치한다. plist 가 구 이름(qmd-*.sh)을
// 가리키면 배치본과 불일치 → 서비스가 옛 파일로 동작(예: 구 logrotate.sh 의 kickstart -k = WAL 버그 재발).
test('CRITICAL: keepalive plist 도 배치명(keepalive.sh)과 정합 (qmd-keepalive.sh 불일치 금지)', () => {
  assert.match(keepalivePlist, /<string>@@HOME@@\/\.config\/qmd\/keepalive\.sh<\/string>/,
    'keepalive plist 가 구 qmd-keepalive.sh 를 가리킴 → install 배치명(keepalive.sh)과 불일치');
});

test('CRITICAL: logrotate plist 도 배치명(logrotate.sh)과 정합 (qmd-logrotate.sh 불일치 금지)', () => {
  assert.match(logrotatePlist, /<string>@@HOME@@\/\.config\/qmd\/logrotate\.sh<\/string>/,
    'logrotate plist 가 구 qmd-logrotate.sh 를 가리킴 → 구버전(kickstart -k) WAL 버그 재발');
});

// codex 최종리뷰 권장: 배치 결과물(installed artifacts)이 graceful 설정을 반영하는지 install-level 검증.
// source-grep 만으로는 install 이 plist 가 가리키는 스크립트명과 실제 배치명을 정합하게 깔았는지 못 잡는다.
test('install-level: 배치된 plist/스크립트가 graceful WAL 설정을 정합하게 반영', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-walinstall-'));
  const bin = join(home, 'bin');
  try {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    execFileSync('bash', ['install.sh'], {
      env: {
        ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
        QMD_FAKE_PLATFORMS: 'none', QMD_INSTALL_SKIP_SELFTEST: '1',
        QMD_MIGRATE_SCAN: join(home, 'no-such-dir'),
      },
    });

    const deployedPlist = readFileSync(join(home, 'Library', 'LaunchAgents', 'com.qmd-mcp-daemon.plist'), 'utf8');
    // plist 가 가리키는 스크립트가 실제 배치명과 일치 + 그 파일이 실제로 배치됨 (파일명 불일치 = 데몬 안 뜸)
    assert.match(deployedPlist, new RegExp(`<string>${home}/\\.config/qmd/daemon\\.sh</string>`),
      'plist 가 배치된 daemon.sh 와 다른 경로를 가리킴');
    assert.ok(existsSync(join(home, '.config', 'qmd', 'daemon.sh')), 'plist 가 가리키는 daemon.sh 가 배치되지 않음');
    // graceful shutdown 설정
    const exitMatch = deployedPlist.match(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/);
    assert.ok(exitMatch && parseInt(exitMatch[1], 10) >= 30, '배치된 plist 에 ExitTimeOut>=30 누락');
    assert.match(deployedPlist, /<key>KeepAlive<\/key>\s*<true\/>/, '배치된 plist 에 KeepAlive 누락');
    // 배치된 logrotate.sh 에 SIGKILL 잔존 없음
    const deployedLogrotate = readFileSync(join(home, '.config', 'qmd', 'logrotate.sh'), 'utf8');
    assert.ok(!/kickstart\s+-k/.test(deployedLogrotate), '배치된 logrotate.sh 가 kickstart -k 사용');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
