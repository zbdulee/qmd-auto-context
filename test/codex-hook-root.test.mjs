// 회귀: Codex UserPromptSubmit hook의 plugin-root 주입 계약.
//
// 배경(root cause): hooks-codex.json이 과거 plugin-root를 `${PLUGIN_ROOT}`로만 참조했는데,
// Codex가 신뢰성 있게 주입하는 표준 변수는 `${CLAUDE_PLUGIN_ROOT}`다(로컬 캐시의 OpenAI
// codex·zax·superpowers 등 모든 codex 플러그인이 codex hooks에서 이 변수를 사용). PLUGIN_ROOT는
// codex 바이너리가 인식하는 alias지만 간헐적으로만 주입돼, 비어 있으면 command가
// `/hooks/run-hook`으로 확장/해석되어 exit 127(command not found)이 났다. 실패 지점이
// run-hook 도달 이전(command 확장 단계)이라 run-hook 내부 dirname fallback은 무력했다.
//
// fix: manifest command를 모든 codex 플러그인이 쓰는 검증된 관례 형태
// `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook" <action> codex`로 통일한다. 이 형태는 Codex가
// 커맨드를 shell로 확장하든 텍스트 템플릿으로 치환하든(양쪽 메커니즘 모두) CLAUDE_PLUGIN_ROOT만
// 주입되면 동작하는 유일하게 입증된 형태다. novel한 `${VAR:-fallback}` 파라미터 확장이나
// `;`/`&&` 제어 연산자는 쓰지 않는다(템플릿 치환 메커니즘에서 매칭/해석 실패 위험).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const FIXTURE = 'test/fixtures/daemon-response.json';

function recallCommand() {
  const h = JSON.parse(readFileSync('hooks/hooks-codex.json', 'utf8')).hooks;
  return h.UserPromptSubmit[0].hooks[0].command;
}

// manifest command 문자열을 Codex처럼 shell(-c)로 확장 실행한다. 특정 env만 주입/제거한다.
function runCommand(command, payload, { env = {}, unset = [], shell = 'bash' } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const k of unset) delete childEnv[k];
  try {
    const stdout = execFileSync(shell, ['-c', command], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: childEnv,
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ? e.stdout.toString() : '' };
  }
}

function optinProject(base = tmpdir()) {
  const dir = mkdtempSync(join(base, 'qmd-codex-root-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
  return dir;
}

const PROMPT = '검색 결과 정렬은 어떻게 동작해?';

test('CLAUDE_PLUGIN_ROOT 주입 + PLUGIN_ROOT 누락 → recall codex 도달해 additionalContext 생성 (127 아님)', () => {
  // 회귀 핵심: 과거 `${PLUGIN_ROOT}` 단독 형태는 이 조건(PLUGIN_ROOT 누락)에서 `/hooks/run-hook`
  // → exit 127. 이제 신뢰성 있는 CLAUDE_PLUGIN_ROOT가 plugin-root를 제공한다.
  const dir = optinProject();
  try {
    const res = runCommand(recallCommand(), { prompt: PROMPT, cwd: dir }, {
      env: { CLAUDE_PLUGIN_ROOT: REPO, QMD_QUERY_FIXTURE: FIXTURE },
      unset: ['PLUGIN_ROOT'],
    });
    assert.notEqual(res.code, 127, 'PLUGIN_ROOT 누락이 command-not-found(127)로 이어지면 안 됨');
    assert.equal(res.code, 0);
    assert.match(JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('빈 문자열 PLUGIN_ROOT가 새어들어와도 CLAUDE_PLUGIN_ROOT로 recall 동작 (127 아님)', () => {
  const dir = optinProject();
  try {
    const res = runCommand(recallCommand(), { prompt: PROMPT, cwd: dir }, {
      env: { CLAUDE_PLUGIN_ROOT: REPO, PLUGIN_ROOT: '', QMD_QUERY_FIXTURE: FIXTURE },
    });
    assert.notEqual(res.code, 127);
    assert.equal(res.code, 0);
    assert.match(JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('실제 Codex payload(stdin JSON)가 recall codex까지 전달되어 정상 종료', () => {
  const dir = optinProject();
  try {
    const payload = { hook_event_name: 'UserPromptSubmit', prompt: PROMPT, cwd: dir };
    const res = runCommand(recallCommand(), payload, {
      env: { CLAUDE_PLUGIN_ROOT: REPO, QMD_QUERY_FIXTURE: FIXTURE },
    });
    assert.equal(res.code, 0);
    const out = JSON.parse(res.stdout.trim());
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('공백/유니코드가 포함된 plugin-root 경로에서도 quoting이 안전 (127/word-split 아님)', () => {
  // 실제 영향받은 프로젝트류 경로 케이스(예: "귀신은 약효가 돌 때 보인다").
  // 공백·한글 경로가 CLAUDE_PLUGIN_ROOT로 들어와도 command의 이중따옴표 덕에 word-split 없이
  // run-hook에 정확히 도달해야 한다. 실제 plugin 트리를 그대로 쓰도록 REPO를 심볼릭 링크한다.
  const linkDir = mkdtempSync(join(tmpdir(), 'qmd link space-'));
  const spaceRoot = join(linkDir, '플러그인 루트');
  symlinkSync(REPO, spaceRoot);
  const dir = optinProject();
  try {
    const res = runCommand(recallCommand(), { prompt: PROMPT, cwd: dir }, {
      env: { CLAUDE_PLUGIN_ROOT: spaceRoot, QMD_QUERY_FIXTURE: FIXTURE },
      unset: ['PLUGIN_ROOT'],
    });
    assert.notEqual(res.code, 127, '공백/유니코드 경로가 127로 깨지면 안 됨');
    assert.equal(res.code, 0);
    assert.match(JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(linkDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('POSIX sh(-c)에서도 command가 동작 (이식성)', () => {
  const dir = optinProject();
  try {
    const res = runCommand(recallCommand(), { prompt: PROMPT, cwd: dir }, {
      env: { CLAUDE_PLUGIN_ROOT: REPO, QMD_QUERY_FIXTURE: FIXTURE },
      shell: 'sh',
    });
    assert.equal(res.code, 0);
    assert.match(JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('모든 codex hook command가 검증된 관례 형태(${CLAUDE_PLUGIN_ROOT})를 갖고, novel 문법/제어 연산자를 쓰지 않는다', () => {
  const h = JSON.parse(readFileSync('hooks/hooks-codex.json', 'utf8')).hooks;
  const commands = [];
  for (const entries of Object.values(h)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) commands.push(hook.command);
    }
  }
  assert.ok(commands.length >= 6, 'codex hook command 개수 부족');
  for (const cmd of commands) {
    // 모든 codex 플러그인이 쓰는 관례: "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook" <action> codex
    assert.match(cmd, /"\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run-hook" \w+ codex/, `관례 형태 누락: ${cmd}`);
    // 템플릿 치환 메커니즘에서 깨질 수 있는 novel 파라미터 확장 금지.
    assert.ok(!/:-/.test(cmd), `novel 파라미터 확장(:-) 사용 금지: ${cmd}`);
    // 미검증 가정(codex hook의 shell 연산자 해석)을 피하기 위해 제어 연산자 금지.
    assert.ok(!/;|&&|\|\|/.test(cmd), `제어 연산자 사용 금지: ${cmd}`);
  }
});
