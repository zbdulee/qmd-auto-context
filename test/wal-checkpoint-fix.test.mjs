// WAL 누적 버그 수정 회귀 방지 (codex+agy 교차검토 반영).
// plugin-managed backend 전환 후에도 SIGKILL 없이 daemon manager가 graceful TERM,
// bounded shutdown wait, bounded health wait를 담당해야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const update = readFileSync('core/update.sh', 'utf8');
const logrotate = readFileSync('backend/logrotate.sh', 'utf8');
const indexWorker = readFileSync('backend/index_worker.sh', 'utf8');
const manager = readFileSync('core/backend_manager.sh', 'utf8');

test('CRITICAL: backend scripts never use SIGKILL/kickstart -k', () => {
  assert.ok(!/kickstart\s+-k/.test(update),
    'update.sh 가 kickstart -k(SIGKILL) 사용 — clean shutdown 차단 → WAL checkpoint 누락');
  assert.ok(!/kickstart\s+-k/.test(logrotate),
    'logrotate.sh 가 kickstart -k 사용 — 로그 회전 시 WAL checkpoint 누락 재도입');
  assert.ok(!/SIGKILL|kill\s+-9|kickstart\s+-k/.test(manager),
    'backend manager must not use SIGKILL restart');
});

test('CRITICAL: backend manager reload uses graceful TERM with bounded shutdown and health wait', () => {
  assert.match(manager, /kill -TERM "\$pid"|kill -TERM \$pid/,
    'manager reload must gracefully TERM daemon pid');
  assert.match(manager, /wait_pid_exit "\$pid"/,
    'manager reload must wait for old daemon process to exit');
  assert.match(manager, /wait_health/,
    'manager reload must wait for restarted daemon health');
  assert.match(manager, /QMD_DAEMON_SHUTDOWN_ATTEMPTS/,
    'manager shutdown wait must be bounded');
});

test('CRITICAL: update.sh delegates embed reload to backend manager when present', () => {
  assert.match(update, /QMD_BACKEND_MANAGER/,
    'update.sh embed reload should prefer QMD_BACKEND_MANAGER');
  assert.match(update, /\$QMD_BACKEND_MANAGER"?\s+reload/,
    'update.sh must call backend manager reload after embed');
});

test('CRITICAL: index worker delegates reload to backend manager when present', () => {
  assert.match(indexWorker, /QMD_BACKEND_MANAGER/,
    'index worker should prefer QMD_BACKEND_MANAGER for reload');
  assert.match(indexWorker, /\$QMD_BACKEND_MANAGER"?\s+reload/,
    'index worker must call backend manager reload when embeddings changed');
});

test('CRITICAL: logrotate uses daemon log override and manager/pid based reload', () => {
  assert.match(logrotate, /QMD_DAEMON_LOG/,
    'logrotate.sh must rotate the plugin-managed daemon log path');
  assert.match(logrotate, /QMD_BACKEND_MANAGER/,
    'logrotate.sh should prefer QMD_BACKEND_MANAGER reload');
  assert.match(logrotate, /QMD_DAEMON_PID/,
    'logrotate.sh should support pid-file fallback without launchd');
});
