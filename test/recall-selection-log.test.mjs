import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// recall.py 를 fixture 모드로 실행하고 stdout(훅 출력)을 그대로 돌려준다.
function run(payload, env = {}) {
  return execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
  }).trim();
}

// QMD_RECALL_LOG 파일에서 selection 사유 이벤트만 파싱.
function selectionEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.event === 'qmd_recall_selection');
}

function withProject(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-sel-log-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify(config));
  const logPath = join(dir, 'recall.log');
  try {
    return fn(dir, logPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROMPT = '검색 결과 정렬은 어떻게 동작해?';

test('결과 선택 시 reason="selected" 기록', () => {
  withProject({ collections: ['sample'] }, (dir, logPath) => {
    const out = run({ prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath });
    assert.ok(out, 'stdout 훅 출력이 있어야 함');
    const ev = selectionEvents(logPath);
    assert.equal(ev.length, 1, 'selection 이벤트 한 줄');
    assert.equal(ev[0].reason, 'selected');
    assert.ok(ev[0].selected > 0, 'selected > 0');
    assert.ok(ev[0].candidates > 0, 'candidates > 0');
  });
});

test('minScore가 모든 후보를 컷하면 결과를 완전히 차단한다 (순위 폴백도 안 살림)', () => {
  // 임계 이상 후보가 애초에 0건이면 사용자가 명시적으로 차단한 것이다 → 0건이 정답.
  // 순위 폴백은 "컷을 통과한 후보가 hard filter로 전멸한" 경우만 구제한다.
  withProject({ collections: ['sample'], minScore: 999 }, (dir, logPath) => {
    const out = run({ prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath });
    assert.equal(out, '', 'minScore 전탈락이면 빈 출력');
    const ev = selectionEvents(logPath);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].reason, 'no_results_after_filter');
    assert.ok(ev[0].dropped_min_score > 0, 'minScore 탈락 수가 잡혀야 함');
    assert.equal(ev[0].selected, 0);
    assert.equal(ev[0].rank_fallback_used, false, '컷 자체를 무효화하면 안 된다');
  });
});

test('컷 통과 후보가 hard filter로 전멸하면 컷 밖 eligible 1건을 rescue', () => {
  // (b) 케이스: 1위는 컷을 통과했지만 skipPaths로 제거 → 2위를 구제한다.
  // dropped_* 는 최초 cutoff/drop 수를 그대로 유지한다(집계 호환).
  const fixtureBody = JSON.stringify({ results: [
    { file: 'sample/docs/skipme.md', title: 'Skip me', score: 1 },
    { file: 'sample/docs/keep.md', title: 'Keep me', score: 0.5 },
  ] });
  withProject({ collections: ['sample'], minScore: 0.8, skipPaths: ['skipme'] }, (dir, logPath) => {
    const fixture = join(dir, 'fixture.json');
    writeFileSync(fixture, fixtureBody);
    const out = run({ prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath, QMD_QUERY_FIXTURE: fixture });
    assert.match(out, /keep\.md/, '컷 밖 eligible 1건이 구제되어야 함');
    assert.doesNotMatch(out, /skipme/, 'skip 대상은 어떤 경로로도 surface 금지');
    const ev = selectionEvents(logPath);
    assert.equal(ev[0].reason, 'selected');
    assert.equal(ev[0].selected, 1, '정확히 1건만 rescue');
    assert.equal(ev[0].dropped_skip, 1);
    assert.equal(ev[0].dropped_min_score, 1, '최초 순위 컷 탈락 수는 그대로 기록');
    assert.equal(ev[0].rank_fallback_used, true);
    assert.equal(ev[0].rescued_original_rank, 2);
    assert.equal(ev[0].fallback_phase, 'primary', 'flat 전략의 primary phase rescue');
  });
});

test('skipPaths로 전부 탈락하면 rescue 없이 0건 (skip은 절대 살리지 않는다)', () => {
  withProject({ collections: ['sample'], skipPaths: ['docs/guide.md'] }, (dir, logPath) => {
    const out = run({ prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath });
    assert.equal(out, '', 'skip 대상은 rescue 대상이 아니므로 빈 출력');
    const ev = selectionEvents(logPath);
    assert.equal(ev[0].reason, 'no_results_after_filter');
    assert.equal(ev[0].dropped_skip, 1);
    assert.equal(ev[0].rank_fallback_used, false);
    assert.equal('rescued_original_rank' in ev[0], false, 'rescue 없으면 필드도 없다');
  });
});

test('cutoff 안에 eligible이 있으면 rescue가 일어나지 않는다 (회귀 방지)', () => {
  withProject({ collections: ['sample'], minScore: 0.5 }, (dir, logPath) => {
    const out = run({ prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath });
    assert.ok(out);
    const ev = selectionEvents(logPath);
    assert.equal(ev[0].reason, 'selected');
    assert.equal(ev[0].rank_fallback_used, false, '정상 경로는 폴백을 쓰지 않아야 함');
  });
});

test('selection 로그를 켜도 stdout은 순수 훅 JSON만 (로그는 파일로만)', () => {
  withProject({ collections: ['sample'] }, (dir, logPath) => {
    const out = run({ prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath });
    const parsed = JSON.parse(out); // 한 줄 JSON 파싱 성공 = stdout 오염 없음
    assert.ok(parsed.hookSpecificOutput.additionalContext);
    assert.ok(!out.includes('qmd_recall_selection'), '로그가 stdout(모델 컨텍스트)에 새어나오면 안 됨');
    assert.ok(existsSync(logPath), '로그는 파일에 기록되어야 함');
  });
});

test('이벤트 비활성 시 reason="event_disabled" 기록', () => {
  withProject({ collections: ['sample'], events: ['sessionStart', 'postToolUse'] }, (dir, logPath) => {
    const out = run(
      { hook_event_name: 'UserPromptSubmit', prompt: PROMPT, cwd: dir },
      { QMD_RECALL_LOG: logPath },
    );
    assert.equal(out, '', '비활성 이벤트면 빈 출력');
    const ev = selectionEvents(logPath);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].reason, 'event_disabled');
  });
});

test('wikiOnly + wiki role 없음 → fixture 경로에서도 reason="no_wiki_collections" + 빈 출력', () => {
  // fixture 경로에서도 live와 동일하게 조기 종료해야 한다(수정 전엔 no_results_after_filter로 오탐).
  withProject(
    { collections: ['sample'], collectionRoles: { sample: 'raw' }, recallStrategy: 'wikiOnly' },
    (dir, logPath) => {
      const out = run({ prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath });
      assert.equal(out, '', 'wiki role 없으면 wikiOnly는 무출력(raw 누출 금지)');
      const ev = selectionEvents(logPath);
      assert.equal(ev.length, 1);
      assert.equal(ev[0].reason, 'no_wiki_collections');
    },
  );
});

test('QMD_RECALL_LOG 미설정이면 부작용 없이 정상 동작 (no-op)', () => {
  withProject({ collections: ['sample'] }, (dir) => {
    const out = run({ prompt: PROMPT, cwd: dir }); // QMD_RECALL_LOG 없음
    const parsed = JSON.parse(out);
    assert.ok(parsed.hookSpecificOutput.additionalContext);
  });
});
