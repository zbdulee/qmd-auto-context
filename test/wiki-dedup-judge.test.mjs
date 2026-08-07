import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { removeTemp } from './helpers/temp.mjs';

// LLM dedup judge (core/wiki_dedup_judge.py) wired into both dedup paths.
//
// No test here may invoke a real host CLI: every judge is a bash/python stub
// handed to compile.extractor.backends, exactly like test/wiki-verify-worker.test.mjs
// stubs the verifier.

function repoTemp(prefix) {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `qmd-test-${prefix}-`));
}

// 임시 디렉터리 정리 재시도(update.test.mjs의 removeTemp와 같은 이유·같은 형태):
// 병렬 실행에서 ENOTEMPTY/EBUSY가 flaky 실패를 만든다.

/** Per-engine judge stub. `label` lands in the shared call log so a test can prove
 *  WHICH adapter argv ran, not merely which engine label the plan passed down. */
function engineJudgeStub(label, verdict, tracker, { exitCode = 0, sleep = 0 } = {}) {
  const script = join(mkdtempSync(join(tmpdir(), `dedup-${label}-`)), `${label}.py`);
  writeFileSync(script, `#!/usr/bin/env python3
import json, sys, time
payload = json.loads(sys.stdin.read())
assert payload.get('task') == 'dedup', 'dedup payload expected, got %r' % payload.get('task')
with open(${JSON.stringify(tracker)}, 'a', encoding='utf-8') as fh:
    fh.write(json.dumps({'who': ${JSON.stringify(label)}, 'engine': payload.get('engine', '')}) + '\\n')
time.sleep(${sleep})
if ${exitCode} != 0:
    sys.exit(${exitCode})
print(json.dumps({'verdict': ${JSON.stringify(verdict)}, 'reason': 'judged by ${label}'}))
`);
  return ['python3', script];
}

function trackerFile(label) {
  return join(mkdtempSync(join(tmpdir(), `dedup-tracker-${label}-`)), 'calls');
}

/** Engine labels of every adapter that actually executed, in order. */
function judgedByEngines(tracker) {
  return jsonl(tracker).map((row) => row.who);
}

/** A fake host CLI adapter: reads the dedup payload, asserts its shape, emits a verdict. */
function judgeStub(verdict, { reason = 'stub reason', callLog = null, exitCode = 0, sleep = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dedup-judge-'));
  const script = join(dir, 'judge.py');
  writeFileSync(script, `#!/usr/bin/env python3
import json, sys, time
payload = json.loads(sys.stdin.read())
assert payload.get('task') == 'dedup', 'dedup payload expected, got %r' % payload.get('task')
assert payload['pageA']['content'], 'pageA content required'
assert payload['pageB']['content'], 'pageB content required'
${callLog ? `open(${JSON.stringify(callLog)}, 'a', encoding='utf-8').write(json.dumps({'a': payload['pageA']['path'], 'b': payload['pageB']['path']}) + '\\n')` : 'pass'}
time.sleep(${sleep})
if ${exitCode} != 0:
    sys.exit(${exitCode})
print(json.dumps({
    'verdict': ${JSON.stringify(verdict)},
    'reason': ${JSON.stringify(reason)},
    'sharedFacts': ['shared'],
    'uniqueToA': ['only in A'],
    'uniqueToB': ['only in B'],
}))
`);
  return ['python3', script];
}

// 레거시(무료) score 게이트의 임계는 더 이상 설정이 아니라 core/config.py의 상수다.
// 리터럴을 테스트에 복제하면 상수를 옮기는 순간 이 파일이 조용히 다른 세계를 검증하므로
// 실제 값을 읽어 픽스처 score가 그 위/아래임을 명시적으로 단정한다.
const [DEDUP_SCORE_THRESHOLD, DEDUP_AUTO_MERGE_THRESHOLD] = execFileSync('python3', ['-c',
  "import sys; sys.path.insert(0, 'core'); import config;"
  + " print(config.DEDUP_SCORE_THRESHOLD); print(config.DEDUP_AUTO_MERGE_THRESHOLD)",
], { cwd: process.cwd(), encoding: 'utf8' }).trim().split('\n').map(Number);

function callCount(logPath) {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
}

function jsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- adapter layer

function runLib(py) {
  return execFileSync('python3', ['-c', py], { cwd: process.cwd(), encoding: 'utf8' });
}

test('build_dedup_prompt embeds both card bodies and demands a reason, not a bare yes/no', () => {
  const py = `import sys,json; sys.path.insert(0,'core/extractors'); import lib
p=lib.build_dedup_prompt({'task':'dedup','pageA':{'path':'entities/a.md','content':'BODY_A'},'pageB':{'path':'entities/b.md','content':'BODY_B'}})
print(json.dumps({
 'has_a':'BODY_A' in p,'has_b':'BODY_B' in p,
 'has_verdict':'"duplicate"|"distinct"|"unclear"' in p,
 'has_reason':'"reason"' in p,
 'has_unique':'uniqueToA' in p,
 'topical_guard':'Being topically related is NOT being duplicate' in p,
 'no_tools':'Do NOT use any tools' in p}))`;
  const out = JSON.parse(runLib(py));
  for (const [k, v] of Object.entries(out)) assert.equal(v, true, `${k} missing from dedup prompt`);
});

test('extract_dedup_verdict takes the last valid verdict and rejects verify-only values', () => {
  const py = `import sys,json; sys.path.insert(0,'core/extractors'); import lib
text = 'noise {"verdict":"pass"} more ' + json.dumps({'verdict':'distinct','reason':'different events'})
print(json.dumps({'picked': lib.extract_dedup_verdict(text), 'verify_scanner': lib.extract_verdict('{"verdict":"duplicate"}')}))`;
  const out = JSON.parse(runLib(py));
  assert.equal(out.picked.verdict, 'distinct');
  assert.equal(out.picked.reason, 'different events');
  // The two verdict vocabularies must stay disjoint: a dedup verdict is not a verify verdict.
  assert.deepEqual(out.verify_scanner, {});
});

test('claude adapter: task=dedup uses the dedup prompt and emits a dedup verdict', () => {
  const d = mkdtempSync(join(tmpdir(), 'claude-dedup-'));
  const promptLog = join(d, 'prompt.txt');
  const fakeCli = join(d, 'fake-claude');
  writeFileSync(fakeCli, `#!/usr/bin/env bash\nprintf '%s' "$@" > "${promptLog}"\necho '{"verdict":"duplicate","reason":"same rule","sharedFacts":["r"],"uniqueToA":[],"uniqueToB":["extra"]}'\n`, { mode: 0o755 });
  const out = execFileSync('python3', ['core/extractors/claude_adapter.py'], {
    cwd: process.cwd(),
    input: JSON.stringify({
      task: 'dedup',
      pageA: { path: 'entities/a.md', content: 'BODY_A' },
      pageB: { path: 'entities/b.md', content: 'BODY_B' },
    }),
    encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_CLAUDE_BIN: fakeCli },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.verdict, 'duplicate');
  assert.equal(parsed.reason, 'same rule');
  assert.deepEqual(parsed.uniqueToB, ['extra']);
  const prompt = readFileSync(promptLog, 'utf8');
  assert.match(prompt, /BODY_A/);
  assert.match(prompt, /BODY_B/);
  assert.doesNotMatch(prompt, /REFUTE/, 'verify 프롬프트가 아님');
  assert.doesNotMatch(prompt, /wiki candidates/, 'extraction 프롬프트가 아님');
  removeTemp(d);
});

test('judge_engine_pool: backends-only config resolves without a producer (retroactive scan has none)', () => {
  // Regression: the scan calls is_available()/judge_pair() with no engine, so a
  // config using extractor.backends WITHOUT builtins resolved to "" -> backends[""]
  // missed -> judge permanently "unavailable" -> every scan silently degraded to the
  // legacy score gate. Both dogfood projects use exactly that shape.
  const py = `import json,os,sys; sys.path.insert(0,'core'); import wiki_dedup_judge as j
cfg_backends = {'extractor': {'backends': {'codex': ['/x/codex'], 'claude': ['/x/claude']}}}
cfg_builtins = {'extractor': {'builtins': ['codex'], 'backends': {'claude': ['/x/claude']}}}
out = {}
out['pool_no_producer'] = j.judge_engine_pool(cfg_backends)
out['pool_builtins_first'] = j.judge_engine_pool(cfg_builtins)
os.environ['QMD_ENGINE'] = 'codex'
out['env_configured'] = j.judge_engine_pool(cfg_backends)
os.environ['QMD_ENGINE'] = 'gemini'
out['env_unconfigured'] = j.judge_engine_pool(cfg_backends)
del os.environ['QMD_ENGINE']
out['available_no_producer'] = j.is_available(cfg_backends)
# 생산자를 아는 경우(write-time): 그 엔진이 **마지막**으로 밀린다.
attempts, mode, reason = j.plan_judge_attempts(cfg_backends, 'claude')
out['order_with_producer'] = [a['engine'] for a in attempts]
out['modes'] = [a['mode'] for a in attempts]
out['mode'] = mode
# 생산자를 모르는 경우(scan): 예전 순서 그대로이고 어떤 시도도 교차를 주장하지 않는다.
scan_attempts, _, _ = j.plan_judge_attempts(cfg_backends)
out['order_scan'] = [a['engine'] for a in scan_attempts]
out['modes_scan'] = [a['mode'] for a in scan_attempts]
print(json.dumps(out))`;
  const out = JSON.parse(runLib(py));
  // Deterministic pick (sorted) so two hosts scanning the same project agree.
  assert.deepEqual(out.pool_no_producer, ['claude', 'codex']);
  assert.deepEqual(out.pool_builtins_first, ['codex', 'claude'], 'builtins가 backends 키보다 우선');
  assert.equal(out.env_configured[0], 'codex', '설정된 host engine이면 QMD_ENGINE 우선');
  assert.equal(out.env_unconfigured[0], 'claude', '미설정 engine 라벨로는 죽지 않음');
  assert.equal(out.available_no_producer, true, '생산자 없이도 judge 가용');
  assert.deepEqual(out.order_with_producer, ['codex', 'claude'], '생산 엔진(claude)이 마지막');
  assert.deepEqual(out.modes, ['cross-engine', 'self']);
  assert.equal(out.mode, 'prefer');
  assert.deepEqual(out.order_scan, ['claude', 'codex'], 'scan 순서는 예전 그대로');
  assert.deepEqual(out.modes_scan, ['unknown', 'unknown'], '생산자 불명이면 교차를 주장하지 않는다');
});

// ------------------------------------------------- write-time gate (wiki_compile)

function writeCompileSettings(work, compile = {}) {
  mkdirSync(join(work, '.auto-context'), { recursive: true });
  writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: {
      mode: 'auto-wiki',
      defaultStatus: 'generated',
      verify: { enabled: false },
      ...compile,
    },
  }));
}

function writeExistingCard(work, rel, body = 'The stalker asked for CCTV footage at the front desk.') {
  const full = join(work, '.auto-context', 'wiki', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, [
    '---',
    'title: "Existing"',
    'type: entity',
    'status: generated',
    'createdBy: qmd-auto-context',
    'reviewed: false',
    '---',
    '',
    '> Auto-generated by qmd-auto-context from conversation/work context. Review, edit, or delete if wrong.',
    '',
    '<!-- qmd:auto:start id="main" sourceHash="abc123" -->',
    '## Summary',
    body,
    '<!-- qmd:auto:end -->',
    '',
  ].join('\n'));
  return full;
}

function runCompile(work, payload, env = {}) {
  return JSON.parse(execFileSync('python3', ['core/wiki_compile.py', '--cwd', work], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    // QMD_DIRTY_QUEUE를 임시 경로로 격리하지 않으면 dirty queue 유출 시 사용자 실제 qmd 인덱스에 고아 컬렉션이 등록되며(복구 불가 고아 등록), 자동으로 정리할 수 있는 경로가 없다.
    env: { ...process.env, QMD_DIRTY_QUEUE: join(work, 'dirty-queue'), ...env },
  }));
}

function fixtureFor(work, hits) {
  const fixture = join(work, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ results: hits }));
  return fixture;
}

// This is the regression test for the leak that produced the surviving
// near-duplicates: the write-time gate used to run only for `slug`-resolved
// targets, so an extractor-supplied explicit targetPath skipped dedup entirely.
test('write-time gate: an explicit targetPath is judged too (legacy slug-only gate skipped these)', () => {
  const work = repoTemp('judge-explicit-target');
  try {
    const log = join(work, 'calls.jsonl');
    writeCompileSettings(work, { extractor: { backends: { claude: judgeStub('duplicate', { callLog: log }) }, timeout: 30 } });
    writeExistingCard(work, 'entities/existing.md');
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    const out = runCompile(work, {
      title: 'Restated version of the same event',
      summary: 'A near-duplicate of the existing card, written under its own path.',
      suggestedType: 'entity',
      confidence: 'high',
      targetPath: '.auto-context/wiki/entities/restated.md',
    }, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(out.action, 'merge-needed');
    assert.equal(out.judgeVerdict, 'duplicate');
    assert.equal(callCount(log), 1, 'judge must be consulted exactly once');
    assert.equal(existsSync(join(work, '.auto-context/wiki/entities/restated.md')), false,
      'a queued duplicate must never be written to disk');

    const queued = jsonl(join(work, '.auto-context/compile/merge-needed.jsonl'));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].judgeVerdict, 'duplicate');
    assert.equal(queued[0].matchedPath, '.auto-context/wiki/entities/existing.md');
    assert.ok(queued[0].judgeReason, 'the judge reason is what makes a wrong verdict auditable');
    // Existing queue contract must survive.
    assert.ok(queued[0].candidate && 'matchedScore' in queued[0]);
    assert.equal('suggestedAction' in queued[0], false, 'collision record has no human resolution action');
  } finally {
    removeTemp(work);
  }
});

test('write-time gate: a "distinct" verdict lets the page be created (score alone would have blocked it)', () => {
  const work = repoTemp('judge-distinct-creates');
  try {
    const log = join(work, 'calls.jsonl');
    writeCompileSettings(work, { extractor: { backends: { claude: judgeStub('distinct', { callLog: log }) }, timeout: 30 } });
    writeExistingCard(work, 'entities/existing.md');
    // Far above the legacy write-time threshold: the judge, not the score, decides.
    const score = DEDUP_SCORE_THRESHOLD + 0.1;
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score }]);

    const out = runCompile(work, {
      title: 'A genuinely different event',
      summary: 'Shares vocabulary with the existing card but records another fact.',
      suggestedType: 'entity',
      confidence: 'high',
    }, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(out.action, 'created');
    assert.equal(callCount(log), 1);
    assert.deepEqual(jsonl(join(work, '.auto-context/compile/merge-needed.jsonl')), []);
  } finally {
    removeTemp(work);
  }
});

test('write-time gate: budget.dedupPairsPerCompile caps how many LLM calls one compile can bill', () => {
  const work = repoTemp('judge-compile-budget');
  try {
    const log = join(work, 'calls.jsonl');
    writeCompileSettings(work, {
      extractor: { backends: { claude: judgeStub('distinct', { callLog: log }) }, timeout: 30 },
      budget: { dedupPairsPerCompile: 2 },
    });
    writeExistingCard(work, 'entities/one.md');
    writeExistingCard(work, 'entities/two.md');
    writeExistingCard(work, 'entities/three.md');
    const fixture = fixtureFor(work, [
      { file: 'proj-wiki/entities/one.md', score: 0.9 },
      { file: 'proj-wiki/entities/two.md', score: 0.8 },
      { file: 'proj-wiki/entities/three.md', score: 0.7 },
    ]);

    const out = runCompile(work, {
      title: 'Candidate with three retrieval hits',
      summary: 'Only the configured number of pairs may reach the judge.',
      suggestedType: 'entity',
      confidence: 'high',
    }, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(out.action, 'created');
    assert.equal(callCount(log), 2, 'budget.dedupPairsPerCompile=2 must cap judge calls at 2, not 3');
  } finally {
    removeTemp(work);
  }
});

test('write-time gate: with no extractor configured nothing is judged and the daemon is not even queried', () => {
  const work = repoTemp('judge-unavailable-legacy');
  try {
    writeCompileSettings(work); // no extractor at all
    writeExistingCard(work, 'entities/existing.md');
    // An explicit targetPath took the legacy no-gate path before this change, and
    // must keep taking it when no judge exists — including making no /query call.
    const out = runCompile(work, {
      title: 'Explicit target, no judge available',
      summary: 'Machines without a host CLI must behave exactly as before.',
      suggestedType: 'entity',
      confidence: 'high',
      targetPath: '.auto-context/wiki/entities/no-judge.md',
    }, { QMD_DAEMON_URL: 'http://127.0.0.1:9' });

    assert.equal(out.action, 'created');
    assert.equal(existsSync(join(work, '.auto-context/wiki/entities/no-judge.md')), true);
  } finally {
    removeTemp(work);
  }
});

test('write-time gate: judge on cooldown falls back to the legacy threshold for slug targets', () => {
  const work = repoTemp('judge-cooldown-fallback');
  try {
    writeCompileSettings(work, { extractor: { backends: { claude: judgeStub('duplicate') }, timeout: 30 } });
    writeExistingCard(work, 'entities/existing.md');
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'compile', 'dedup-judge-cooldown'),
      `${Date.now() / 1000 + 3600}\n`);
    const fixture = fixtureFor(work, [
      { file: 'proj-wiki/entities/existing.md', score: DEDUP_SCORE_THRESHOLD + 0.1 },
    ]);

    const out = runCompile(work, {
      title: 'Slug target while the judge is cooling down',
      summary: 'Must still be gated by the legacy score threshold rather than silently written.',
      suggestedType: 'entity',
      confidence: 'high',
    }, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(out.action, 'merge-needed');
    assert.equal(out.judgeVerdict, undefined, 'no verdict exists — this is the score fallback');
  } finally {
    removeTemp(work);
  }
});

test('write-time gate: a foreign target is still only queued, never overwritten or deleted', () => {
  const work = repoTemp('judge-foreign-target');
  try {
    writeCompileSettings(work, { extractor: { backends: { claude: judgeStub('duplicate') }, timeout: 30 } });
    const card = join(work, '.auto-context', 'wiki', 'entities', 'foreign.md');
    mkdirSync(join(card, '..'), { recursive: true });
    const original = [
      '---',
      'title: "Foreign card"',
      'type: entity',
      'status: verified',
      'createdBy: another-tool',
      '---',
      '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->',
      '## Summary',
      'A fact owned by another tool.',
      '<!-- qmd:auto:end -->',
      '',
    ].join('\n');
    writeFileSync(card, original);
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/foreign.md', score: 0.9 }]);

    const out = runCompile(work, {
      title: 'Restatement of a foreign fact',
      summary: 'The judge calls this a duplicate; the foreign card must survive untouched.',
      suggestedType: 'entity',
      confidence: 'high',
    }, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(out.action, 'merge-needed');
    assert.equal(readFileSync(card, 'utf8'), original, 'foreign card must be byte-identical');
  } finally {
    removeTemp(work);
  }
});

// ------------------------------------- 교차 엔진 (write-time gate 한정)
//
// 4단계가 verify 에서 실측한 노출: verified 688장 중 655장(95%)이 자기검증이었다. dedup judge 도
// 같은 구조였다 — 카드를 만든 엔진을 hint 로 받아 **그 엔진으로** 판정했다.
//
// verify 의 처방(`plan_verify_attempts`)을 그대로 쓸 수는 없다: dedup 은 카드 **두 장**을
// 비교하고 기존 카드의 생산자는 기록되지 않으므로(라이브 실측 0/12쌍) 무엇이 자기검증인지
// 확정되지 않는다. 그래서 생산자가 사실로 확정된 write-time gate 만 확장하고, 공용화한 것은
// **순서 규칙**(`wiki_compile_worker.plan_engine_order`) 하나다.

function crossEngineSettings(work, backends, judge = {}, extra = {}) {
  writeCompileSettings(work, {
    extractor: { backends, timeout: 30 },
    semanticDedup: { judge, ...extra },
  });
}

function runCrossCompile(work, fixture, title, engine = 'claude') {
  return runCompile(work, {
    title,
    summary: 'A near-duplicate of the existing card, restated in other words.',
    suggestedType: 'entity',
    confidence: 'high',
    // 생성 엔진은 **큐 잡이 정하는 사실**이다(worker 가 candidate.engine 을 대입한다).
    engine,
  }, { QMD_QUERY_FIXTURE: fixture });
}

const mergeNeeded = (work) => jsonl(join(work, '.auto-context/compile/merge-needed.jsonl'));
const globalCooldown = (work) => join(work, '.auto-context/compile/dedup-judge-cooldown');
const engineCooldown = (work) => join(work, '.auto-context/compile/dedup-judge-engine-cooldown.json');

test('write-time: 후보를 만든 엔진(claude)이 아닌 codex 가 판정하고 유료 호출은 그대로 1회', () => {
  const work = repoTemp('judge-cross-engine');
  const tracker = trackerFile('cross');
  try {
    crossEngineSettings(work, {
      claude: engineJudgeStub('claude', 'duplicate', tracker),
      codex: engineJudgeStub('codex', 'duplicate', tracker),
    });
    writeExistingCard(work, 'entities/existing.md');
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    const out = runCrossCompile(work, fixture, 'Restated version of the same event');

    assert.equal(out.action, 'merge-needed');
    assert.deepEqual(judgedByEngines(tracker), ['codex'],
      'codex 만 실행된다 — 엔진만 바뀌고 호출 수는 카드당 1회로 불변');
    const queued = mergeNeeded(work);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].judgedBy, 'codex');
    assert.equal(queued[0].judgedMode, 'cross-engine');
    assert.equal(queued[0].producedBy, 'claude', '노출을 사후에 세려면 생산 엔진도 남아야 한다');
  } finally { removeTemp(work); }
});

test('write-time: 엔진이 하나뿐이면 그 엔진이 판정하고 self 로 기록된다(단일 CLI 머신 동작 불변)', () => {
  const work = repoTemp('judge-single-engine');
  const tracker = trackerFile('single');
  try {
    crossEngineSettings(work, { claude: engineJudgeStub('claude', 'duplicate', tracker) });
    writeExistingCard(work, 'entities/existing.md');
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    const out = runCrossCompile(work, fixture, 'Restated with only one CLI installed');

    assert.equal(out.action, 'merge-needed');
    assert.deepEqual(judgedByEngines(tracker), ['claude']);
    assert.equal(mergeNeeded(work)[0].judgedMode, 'self', '약한 근거지만 라벨이 붙는다');
  } finally { removeTemp(work); }
});

test('write-time degrade: 다른 엔진 CLI 가 없으면(127) 생산 엔진으로 폴백하고 self 로 기록한다', () => {
  const work = repoTemp('judge-cross-absent');
  const tracker = trackerFile('absent');
  try {
    // 127 은 CLI 를 실행하지도 못한 상태라 토큰이 0 이므로 다음 후보 시도가 공짜다.
    crossEngineSettings(work, {
      claude: engineJudgeStub('claude', 'duplicate', tracker),
      codex: ['/nonexistent/dedup-judge-codex'],
    });
    writeExistingCard(work, 'entities/existing.md');
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    const out = runCrossCompile(work, fixture, 'Restated while the second CLI is missing');

    assert.equal(out.action, 'merge-needed');
    assert.deepEqual(judgedByEngines(tracker), ['claude'], '유료 호출은 여전히 1회');
    assert.equal(mergeNeeded(work)[0].judgedBy, 'claude');
    assert.equal(mergeNeeded(work)[0].judgedMode, 'self');
    assert.equal(existsSync(globalCooldown(work)), false, '127 은 실패가 아니라 부재다');
  } finally { removeTemp(work); }
});

test('write-time degrade: crossEngine:require + 다른 엔진 없음 → judge 호출 0회, 레거시 score 게이트', () => {
  const work = repoTemp('judge-cross-require');
  const tracker = trackerFile('require');
  try {
    crossEngineSettings(work, { claude: engineJudgeStub('claude', 'distinct', tracker) }, { crossEngine: 'require' });
    writeExistingCard(work, 'entities/existing.md');
    // 레거시 임계(0.82) 위 → judge 가 없어도 score 게이트가 큐한다. 종점은 "유료 호출 0회".
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.95 }]);

    const out = runCrossCompile(work, fixture, 'Slug target under crossEngine require');

    assert.deepEqual(judgedByEngines(tracker), [], '자기판정을 금지했으므로 아무 CLI도 부르지 않는다');
    assert.equal(out.action, 'merge-needed');
    assert.equal(out.judgeVerdict, undefined, '판정이 없었으므로 verdict 를 주장하지 않는다');
    assert.equal(mergeNeeded(work)[0].judgedMode, undefined, '판정 없는 행에 mode 를 쓰지 않는다');
  } finally { removeTemp(work); }
});

test('write-time: crossEngine:off 는 0.x 동작(생산 엔진이 판정)', () => {
  const work = repoTemp('judge-cross-off');
  const tracker = trackerFile('off');
  try {
    crossEngineSettings(work, {
      claude: engineJudgeStub('claude', 'duplicate', tracker),
      codex: engineJudgeStub('codex', 'duplicate', tracker),
    }, { crossEngine: 'off' });
    writeExistingCard(work, 'entities/existing.md');
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    runCrossCompile(work, fixture, 'Restated with cross engine turned off');

    assert.deepEqual(judgedByEngines(tracker), ['claude']);
    assert.equal(mergeNeeded(work)[0].judgedMode, 'self');
  } finally { removeTemp(work); }
});

// degrade 의 **종점**: 선호 후보가 유료로 실패하면(비127) 같은 run 에서 다음 엔진을 부르지
// 않는다(이중 과금). 그 후보만 엔진 단위로 식혀 **다음 run 이 생산 엔진으로 degrade** 하게
// 한다 — 전역 식힘만 있으면 만료마다 같은 후보를 다시 불러 판정이 영구 정지한다(verify 가
// 0.x 전역 식힘에서 겪은 것과 같은 클래스).
test('write-time degrade: 선호 엔진의 유료 실패는 그 엔진만 식히고 다음 run 이 생산 엔진으로 내려온다', () => {
  const work = repoTemp('judge-cross-transient');
  const tracker = trackerFile('transient');
  try {
    crossEngineSettings(work, {
      claude: engineJudgeStub('claude', 'duplicate', tracker),
      codex: engineJudgeStub('codex', 'duplicate', tracker, { exitCode: 3 }),
    });
    writeExistingCard(work, 'entities/existing.md');
    // 레거시 임계(0.82) 아래 → judge 가 판정하지 못하면 아무것도 큐되지 않는다.
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    const first = runCrossCompile(work, fixture, 'First candidate while codex is broken');
    assert.equal(first.action, 'created', '판정이 없었으므로 score 게이트로 degrade');
    assert.deepEqual(judgedByEngines(tracker), ['codex'], '유료 호출은 run 당 1회');
    assert.equal(existsSync(engineCooldown(work)), true, '실패한 후보만 식힌다');
    assert.match(readFileSync(engineCooldown(work), 'utf8'), /codex/);
    assert.equal(existsSync(globalCooldown(work)), false,
      '전역 식힘을 걸면 다음 run 이 degrade 하지 못하고 judge 가 영구 정지한다');

    const second = runCrossCompile(work, fixture, 'Second candidate after codex was cooled');
    assert.deepEqual(judgedByEngines(tracker), ['codex', 'claude'], '다음 run 은 생산 엔진으로 내려온다');
    assert.equal(second.action, 'merge-needed');
    assert.equal(mergeNeeded(work).at(-1).judgedMode, 'self', 'degrade 사실이 라벨로 남는다');
  } finally { removeTemp(work); }
});

test('write-time: 후보가 소진되면 전역 식힘으로 종점을 만든다(judge 전체 backoff)', () => {
  const work = repoTemp('judge-cross-exhausted');
  const tracker = trackerFile('exhausted');
  try {
    // 후보가 생산 엔진 하나뿐 → 다음 후보가 없으므로 기존 동작(전역 식힘)이 종점이다.
    crossEngineSettings(work, { claude: engineJudgeStub('claude', 'duplicate', tracker, { exitCode: 3 }) });
    writeExistingCard(work, 'entities/existing.md');
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    runCrossCompile(work, fixture, 'Only candidate fails while billing');

    assert.deepEqual(judgedByEngines(tracker), ['claude']);
    assert.equal(existsSync(globalCooldown(work)), true);
    assert.equal(existsSync(engineCooldown(work)), false, '후보가 없으면 엔진 식힘은 의미가 없다');
  } finally { removeTemp(work); }
});

// --------------------------------------------- retroactive scan (wiki_dedup_scan)

function writeScanSettings(work, semanticDedup = {}, compile = {}) {
  mkdirSync(join(work, '.auto-context'), { recursive: true });
  writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: {
      mode: 'auto-wiki',
      semanticDedup,
      ...compile,
    },
  }));
}

function writePage(work, rel, body) {
  const full = join(work, '.auto-context', 'wiki', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, [
    '---',
    'title: "Test Page"',
    'type: entity',
    'status: generated',
    'createdBy: qmd-auto-context',
    '---',
    '',
    '> Auto-generated by qmd-auto-context from conversation/work context. Review, edit, or delete if wrong.',
    '',
    '<!-- qmd:auto:start id="main" sourceHash="abc123" -->',
    '## Summary',
    body,
    '<!-- qmd:auto:end -->',
    '',
  ].join('\n'));
  return full;
}

function runScan(work, env = {}) {
  const dirs = {
    cooldownDir: join(work, 'dedup-cooldown'),
    stateDir: join(work, 'sync-state'),
    logFile: join(work, 'dedup.log'),
  };
  execFileSync('python3', ['core/wiki_dedup_scan.py', '--cwd', work], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QMD_DEDUP_COOLDOWN_DIR: dirs.cooldownDir,
      QMD_SYNC_STATE_DIR: dirs.stateDir,
      QMD_DEDUP_LOG: dirs.logFile,
      ...env,
    },
  });
  return dirs;
}

function clearCooldown(dirs) {
  removeTemp(dirs.cooldownDir);
}

function snapshotOf(stateDir) {
  if (!existsSync(stateDir)) return null;
  const file = readdirSync(stateDir).find((f) => f.endsWith('-wiki-dedup.json'));
  return file ? JSON.parse(readFileSync(join(stateDir, file), 'utf8')) : null;
}

const scanQueue = (work) => jsonl(join(work, '.auto-context/compile/dedup-needed.jsonl'));
const scanSkipped = (work) => jsonl(join(work, '.auto-context/compile/dedup-skipped.jsonl'));

// The measured failure: a real duplicate can only ever be retrieved at rank>=2,
// where the score is capped around 0.625, so autoMergeThreshold's 0.9 default can
// never fire. The judge has to be what decides.
test('retroactive scan: a "duplicate" verdict is queued even though the score is far below the auto-merge threshold', () => {
  const work = repoTemp('judge-scan-below-threshold');
  try {
    const log = join(work, 'calls.jsonl');
    assert.ok(0.56 < DEDUP_AUTO_MERGE_THRESHOLD,
      'the fixture score must sit below the free gate, or this proves nothing about the judge');
    writeScanSettings(work, {}, {
      extractor: { backends: { claude: judgeStub('duplicate', { callLog: log }) }, timeout: 30 },
      budget: { dedupPairsPerScan: 4 },
    });
    writePage(work, 'entities/page-a.md', 'The stalker asked for CCTV footage at the front desk.');
    writePage(work, 'entities/page-b.md', 'A restatement of the very same front desk CCTV request.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    runScan(work, { QMD_QUERY_FIXTURE: fixture });

    const queued = scanQueue(work);
    assert.equal(queued.length, 1, `expected one queued pair, got ${JSON.stringify(queued)}`);
    assert.equal(queued[0].judgeVerdict, 'duplicate');
    assert.equal(queued[0].score, 0.56);
    assert.ok(queued[0].judgeReason);
    // Existing queue contract: pageA/pageB/score stay where every reader expects them.
    assert.ok(queued[0].pageA && queued[0].pageB);
    assert.ok(callCount(log) >= 1);
  } finally {
    removeTemp(work);
  }
});

test('retroactive scan: a "distinct" verdict is not queued, is recorded as a skip, and is not re-judged next scan', () => {
  const work = repoTemp('judge-scan-distinct');
  try {
    const log = join(work, 'calls.jsonl');
    writeScanSettings(work, { candidateMinScore: 0.3 }, {
      extractor: { backends: { claude: judgeStub('distinct', { callLog: log, reason: 'different events' }) }, timeout: 30 },
    });
    writePage(work, 'entities/page-a.md', 'Content about the front desk.');
    writePage(work, 'entities/page-b.md', 'Content about a different corridor entirely.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(scanQueue(work), [], 'a judged non-duplicate must not reach the queue');

    const skipped = scanSkipped(work);
    assert.equal(skipped.length >= 1, true, 'the verdict must be recorded so it is not re-billed');
    assert.equal(skipped[0].judgeVerdict, 'distinct');
    assert.equal(skipped[0].judgeReason, 'different events');
    assert.ok(skipped[0].pageAHash && skipped[0].pageBHash, 'body hashes drive suppression');
    assert.equal(skipped[0].judgedMode, 'unknown', '기존 카드의 생산자는 기록되지 않는다 → 교차 주장 불가');

    const first = callCount(log);
    // Second scan with unchanged bodies: suppression must keep the judge idle.
    clearCooldown(dirs);
    writePage(work, 'entities/page-a.md', 'Content about the front desk.'); // touch mtime only
    runScan(work, { QMD_QUERY_FIXTURE: fixture, QMD_DEDUP_COOLDOWN_DIR: dirs.cooldownDir, QMD_SYNC_STATE_DIR: dirs.stateDir, QMD_DEDUP_LOG: dirs.logFile });
    assert.equal(callCount(log), first, 'suppressed pair must not be re-judged');
    assert.deepEqual(scanQueue(work), []);
  } finally {
    removeTemp(work);
  }
});

test('retroactive scan: budget.dedupPairsPerScan caps LLM calls and leaves unjudged pages for the next scan', () => {
  const work = repoTemp('judge-scan-budget');
  try {
    const log = join(work, 'calls.jsonl');
    // semanticDedup.maxPairsPerScan(무료 score 게이트의 쌍 상한)은 여전히 설정이고,
    // 유료 judge 예산만 compile.budget으로 옮겼다 — 둘을 넉넉히 벌려 판정 주체를 고정한다.
    writeScanSettings(work, { maxPairsPerScan: 10 }, {
      extractor: { backends: { claude: judgeStub('distinct', { callLog: log }) }, timeout: 30 },
      budget: { dedupPairsPerScan: 1 },
    });
    writePage(work, 'entities/page-a.md', 'Body A.');
    writePage(work, 'entities/page-b.md', 'Body B.');
    writePage(work, 'entities/page-c.md', 'Body C.');
    const fixture = join(work, 'fixture.json');
    // Every page retrieves page-c, so each scanned page wants its own judge call.
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-c.md', score: 0.6 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(callCount(log), 1, 'budget.dedupPairsPerScan=1 must allow exactly one call');

    const snap = snapshotOf(dirs.stateDir);
    const recorded = Object.keys(snap.files || {});
    assert.ok(recorded.length < 3, `pages beyond the judge budget must stay unadvanced, got ${JSON.stringify(recorded)}`);
  } finally {
    removeTemp(work);
  }
});

test('retroactive scan: judge timeout sets a cooldown, queues nothing, and leaves the page unadvanced', () => {
  const work = repoTemp('judge-scan-transient');
  try {
    writeScanSettings(work, { judge: { timeout: 1, cooldownSeconds: 900 } }, {
      extractor: { backends: { claude: judgeStub('duplicate', { sleep: 5 }) }, timeout: 30 },
    });
    writePage(work, 'entities/page-a.md', 'Body A.');
    writePage(work, 'entities/page-b.md', 'Body B.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.6 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });

    assert.deepEqual(scanQueue(work), [], 'no judgment happened, so nothing may be queued');
    assert.deepEqual(scanSkipped(work), [], 'a transient failure is not a "distinct" verdict');
    assert.equal(existsSync(join(work, '.auto-context/compile/dedup-judge-cooldown')), true);
    const snap = snapshotOf(dirs.stateDir);
    assert.deepEqual(Object.keys(snap.files || {}), [], 'unjudged pages must be retried, not retired');
  } finally {
    removeTemp(work);
  }
});

test('retroactive scan: an absent host CLI degrades to the legacy score threshold rather than stalling', () => {
  const work = repoTemp('judge-scan-cli-absent');
  try {
    writeScanSettings(work, {}, {
      extractor: { backends: { claude: ['/nonexistent/dedup-judge-xyz'] }, timeout: 30 },
    });
    writePage(work, 'entities/page-a.md', 'Body A.');
    writePage(work, 'entities/page-b.md', 'Body B.');
    const fixture = join(work, 'fixture.json');
    const score = DEDUP_AUTO_MERGE_THRESHOLD + 0.05;   // 무료 게이트 임계 위
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score }] }));

    runScan(work, { QMD_QUERY_FIXTURE: fixture });

    const queued = scanQueue(work);
    assert.equal(queued.length, 1, 'above the legacy threshold, so the legacy gate must still queue it');
    assert.equal(queued[0].judgeVerdict, undefined, 'no judge ran — no verdict may be claimed');
    assert.equal(Object.keys(queued[0]).sort().join(','), 'pageA,pageB,score',
      'unjudged rows must keep the original queue shape');
  } finally {
    removeTemp(work);
  }
});

test('retroactive scan: the judge never deletes or edits a card — it only queues', () => {
  const work = repoTemp('judge-scan-no-writes');
  try {
    writeScanSettings(work, {}, { extractor: { backends: { claude: judgeStub('duplicate') }, timeout: 30 } });
    const a = writePage(work, 'entities/page-a.md', 'Body A.');
    const b = writePage(work, 'entities/page-b.md', 'Body B.');
    const before = [readFileSync(a, 'utf8'), readFileSync(b, 'utf8')];
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.6 }] }));

    runScan(work, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(existsSync(a), true);
    assert.equal(existsSync(b), true);
    assert.deepEqual([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')], before);
    assert.equal(scanQueue(work).length, 1);
  } finally {
    removeTemp(work);
  }
});

// **retroactive scan 은 교차 엔진으로 확장하지 않는다.** 기존 카드 두 장의 생산자는 어디에도
// 기록되지 않아(라이브 실측: judge 가 돈 12쌍 전부 `generated-manifest.jsonl` 에 생산 엔진 없음)
// "무엇이 자기검증인지"가 정의되지 않고, 두 생산자가 다르면 중립 엔진이라는 것 자체가
// 성립하지 않는다. 그래서 이 경로는 예전 선택(host engine → 풀 첫 후보)을 그대로 쓴다.
test('retroactive scan: 엔진 선택이 예전과 같고 판정 mode 는 unknown 이다(확장하지 않음)', () => {
  const work = repoTemp('judge-scan-no-cross');
  const tracker = trackerFile('scan-no-cross');
  try {
    writeScanSettings(work, { candidateMinScore: 0.3 }, {
      extractor: {
        timeout: 30,
        backends: {
          claude: engineJudgeStub('claude', 'duplicate', tracker),
          codex: engineJudgeStub('codex', 'duplicate', tracker),
        },
      },
    });
    writePage(work, 'entities/page-a.md', 'The stalker asked for CCTV footage at the front desk.');
    writePage(work, 'entities/page-b.md', 'A restatement of the very same front desk CCTV request.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    runScan(work, { QMD_QUERY_FIXTURE: fixture });

    assert.deepEqual(judgedByEngines(tracker), ['claude'],
      'sorted 풀의 첫 후보 — 두 호스트가 같은 프로젝트에서 같은 엔진을 고른다');
    const queued = scanQueue(work);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].judgedBy, 'claude');
    assert.equal(queued[0].judgedMode, 'unknown');
  } finally { removeTemp(work); }
});

test('QMD_DEDUP_JUDGE=off disables judging entirely (legacy threshold behavior)', () => {
  const work = repoTemp('judge-kill-switch');
  try {
    const log = join(work, 'calls.jsonl');
    writeScanSettings(work, {}, {
      extractor: { backends: { claude: judgeStub('duplicate', { callLog: log }) }, timeout: 30 },
    });
    writePage(work, 'entities/page-a.md', 'Body A.');
    writePage(work, 'entities/page-b.md', 'Body B.');
    const fixture = join(work, 'fixture.json');
    const score = DEDUP_AUTO_MERGE_THRESHOLD + 0.05;   // 무료 게이트 임계 위
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score }] }));

    runScan(work, { QMD_QUERY_FIXTURE: fixture, QMD_DEDUP_JUDGE: 'off' });

    assert.equal(callCount(log), 0, 'kill switch must prevent any LLM call');
    assert.equal(scanQueue(work).length, 1, 'legacy threshold still applies');
  } finally {
    removeTemp(work);
  }
});

// verify 원장과 같은 클래스: `distinct` 판정(유료)을 기록할 곳이 없으면 다음 scan 이 같은 쌍을
// 다시 판정하고 매 scan 이 과금이다. 종점은 유료 호출을 아예 하지 않는 것이므로 판정 전에
// 억제 원장 쓰기 가능성을 확인한다(`wiki_compile.ledger_writable` — verify 와 같은 함수).
test('retroactive scan: 억제 원장에 쓸 수 없으면 judge 를 부르지 않는다 (유료 호출 0회)', () => {
  const work = repoTemp('judge-scan-ledger-blocked');
  try {
    const log = join(work, 'calls.jsonl');
    writeScanSettings(work, { candidateMinScore: 0.3 }, {
      extractor: { backends: { claude: judgeStub('distinct', { callLog: log }) }, timeout: 30 },
    });
    writePage(work, 'entities/page-a.md', 'Content about the front desk.');
    writePage(work, 'entities/page-b.md', 'Content about a different corridor entirely.');
    // 억제 원장 경로를 **디렉터리**로 만들어 append 불가 상태를 만든다(실측된 실패 모드).
    mkdirSync(join(work, '.auto-context', 'compile', 'dedup-skipped.jsonl'), { recursive: true });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(callCount(log), 0, 'judge(유료)를 한 번도 부르지 않는다');
    // judge 없이는 레거시 score 게이트(기본 0.9)가 남고 0.56 은 통과하지 못한다 →
    // 이번 scan 은 아무것도 큐하지 않는다. 유료 루프보다 낮은 등급의 대가다.
    assert.deepEqual(scanQueue(work), []);
    assert.match(readFileSync(dirs.logFile, 'utf8'), /judge=off:skipped_ledger_unwritable/,
      '무료 게이트로 degrade 한 사실이 로그에 남아야 진단이 가능하다');
  } finally {
    removeTemp(work);
  }
});

// ========================================================== 적대적 리뷰 major 3건 (2026-07-31)

// MAJOR 1 — `crossEngine:"require"` 가 retroactive scan 의 판정을 통째로 죽였다.
//
// `require` 는 "생성 엔진이 **아닌** 엔진이 판정한다"는 약속인데 scan 경로에는 생성 엔진이라는
// 사실이 존재하지 않는다(카드 두 장, 둘째 생산자 미기록 — 실측 12쌍 중 0쌍). 즉 **절대 만족될 수
// 없는 조건에 fail-closed** 가 걸려 있었다: producing="" → attributable=False →
// `cross_engine_unavailable` → `is_available` False → scan 의 `judging=False` → retrieval floor 가
// `autoMergeThreshold`(0.9)로 올라가 사실상 아무것도 큐되지 않는다. 이 커밋 자신의 docstring 과
// docs/settings.md 는 "scan 은 확장하지 않고 예전 선택을 그대로 쓴다"고 서술해 그 상실을 부정했다.
test('MAJOR 1 — scan 은 crossEngine:require 로 게이팅되지 않는다(귀속 불가 경로) + 그 사실이 로그에 남는다', () => {
  const work = repoTemp('judge-require-scan');
  const tracker = trackerFile('require-scan');
  try {
    writeScanSettings(work, { candidateMinScore: 0.3, judge: { crossEngine: 'require' } }, {
      extractor: {
        timeout: 30,
        backends: {
          claude: engineJudgeStub('claude', 'duplicate', tracker),
          codex: engineJudgeStub('codex', 'duplicate', tracker),
        },
      },
    });
    writePage(work, 'entities/page-a.md', 'The stalker asked for CCTV footage at the front desk.');
    writePage(work, 'entities/page-b.md', 'A restatement of the very same front desk CCTV request.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });

    // 0.56 은 레거시 임계(0.9) 아래다 — 큐에 들어왔다는 것은 judge 가 실제로 판정했다는 뜻이다.
    assert.deepEqual(judgedByEngines(tracker), ['claude'], 'require 는 이 경로에 적용되지 않으므로 예전 순서 그대로');
    const queued = scanQueue(work);
    assert.equal(queued.length, 1, `require 가 판정을 죽이면 안 된다: ${JSON.stringify(queued)}`);
    assert.equal(queued[0].judgeVerdict, 'duplicate');
    assert.equal(queued[0].judgedMode, 'unknown', '귀속 불가이므로 교차를 주장하지 않는다');
    // **종점**: 왜 require 가 적용되지 않았는지 로그에서 알 수 있어야 한다(차단에 종점 없음 금지).
    assert.match(readFileSync(dirs.logFile, 'utf8'), /crossEngine=require:waived_unattributable_path/);
  } finally { removeTemp(work); }
});

test('MAJOR 1 — 귀속 가능성은 경로의 성질이다: scan 은 waive, write-time 은 그대로 fail-closed', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_dedup_judge as j
cfg = {'extractor': {'backends': {'claude': ['/x/claude'], 'codex': ['/x/codex']}},
       'semanticDedup': {'judge': {'crossEngine': 'require'}}}
out = {}
# retroactive scan: 생산자라는 사실이 존재하지 않는다 → require 미적용, prefer 와 같은 순서.
a, mode, reason = j.plan_judge_attempts(cfg, '', attribution=j.ATTRIBUTION_NONE)
out['scan'] = [[x['engine'] for x in a], mode, reason]
out['scan_modes'] = [x['mode'] for x in a]
out['scan_available'] = j.is_available(cfg, attribution=j.ATTRIBUTION_NONE)
out['scan_waived'] = j.require_waived(cfg, j.ATTRIBUTION_NONE)
# write-time 인데 이번 카드의 생산자를 못 읽음 → 사용자가 고칠 수 있는 상태라 fail-closed 유지.
b, bmode, breason = j.plan_judge_attempts(cfg, '', attribution=j.ATTRIBUTION_JOB)
out['job_unknown_producer'] = [[x['engine'] for x in b], bmode, breason]
out['job_waived'] = j.require_waived(cfg, j.ATTRIBUTION_JOB)
# write-time + 귀속 가능 → 교차가 실제로 강제된다(생산 엔진 제외).
c, _, _ = j.plan_judge_attempts(cfg, 'claude', attribution=j.ATTRIBUTION_JOB)
out['job_attributed'] = [[x['engine'] for x in c], [x['mode'] for x in c]]
# 기본값은 write-time 이다 — 새 호출자가 실수로 waive 하지 않는다.
d, _, dreason = j.plan_judge_attempts(cfg, '')
out['default_reason'] = dreason
print(json.dumps(out))`;
  const out = JSON.parse(runLib(py));
  assert.deepEqual(out.scan, [['claude', 'codex'], 'require', ''], 'scan 은 후보를 잃지 않는다');
  assert.deepEqual(out.scan_modes, ['unknown', 'unknown']);
  assert.equal(out.scan_available, true, 'is_available 도 같은 판정을 써야 한다');
  assert.equal(out.scan_waived, true);
  assert.deepEqual(out.job_unknown_producer, [[], 'require', 'cross_engine_unavailable']);
  assert.equal(out.job_waived, false);
  assert.deepEqual(out.job_attributed, [['codex'], ['cross-engine']]);
  assert.equal(out.default_reason, 'cross_engine_unavailable', '기본 attribution 은 JOB');
});

// MAJOR 2 — 판정 불가 출력이 억제 기록 없이 매 scan 재과금됐다.
//
// judge 는 `invalid_extractor_json`/`invalid_verdict` 를 `unclear`+OK 로 돌리는데 scan 은
// `distinct` 만 `dedup-skipped.jsonl` 에 기록했다 → 마커가 없어 같은 쌍이 매 scan 재판정 = 재과금.
// verify 는 같은 클래스를 `UNUSABLE_OUTPUT_REASONS`+`defer_or_drop` 로 이미 막았다(남은 후보가
// 있으면 degrade, 소진되면 종점). 대칭으로 만든다.
test('MAJOR 2 — 쓸 수 없는 출력(invalid_verdict)은 억제되어 2회차 scan 이 유료 호출을 하지 않는다', () => {
  const work = repoTemp('judge-unusable-suppressed');
  const tracker = trackerFile('unusable');
  try {
    // 후보가 소진된 판정 불가는 전역 식힘도 함께 건다. 2회차를 막은 것이 그 식힘이 아니라
    // **쌍 억제**임을 분리해서 보려면 식힘이 먼저 만료돼야 한다(`coerce_int`가 0을 거부하므로
    // 최소값 1초 + sleep). 이 분리가 없으면 이 테스트는 억제가 아니라 식힘을 검증한다.
    writeScanSettings(work, { candidateMinScore: 0.3, judge: { cooldownSeconds: 1 } }, {
      extractor: {
        timeout: 30,
        backends: { claude: engineJudgeStub('claude', 'maybe', tracker) }, // 스키마 밖 verdict
      },
    });
    writePage(work, 'entities/page-a.md', 'Content about the front desk.');
    writePage(work, 'entities/page-b.md', 'Content about a different corridor entirely.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(judgedByEngines(tracker).length, 1, '쌍당 유료 호출 1회');
    const skipped = scanSkipped(work);
    assert.equal(skipped.length, 1, `억제 마커가 없으면 다음 scan 이 재과금한다: ${JSON.stringify(skipped)}`);
    assert.equal(skipped[0].judgeVerdict, 'unclear', '실제 판정값을 기록한다(distinct 로 위장하지 않는다)');
    assert.equal(skipped[0].judgeReason, 'invalid_verdict');
    assert.ok(skipped[0].pageAHash && skipped[0].pageBHash, 'body hash 가 억제의 키다');
    assert.deepEqual(scanQueue(work), []);
    assert.match(readFileSync(dirs.logFile, 'utf8'), /unusableOutput=True/, '판정 불가 사실이 남아야 한다');

    // 2회차: 본문이 그대로면 유료 호출이 0회여야 한다.
    clearCooldown(dirs);
    execFileSync('sleep', ['1.3']); // 전역 식힘 만료 대기 — 억제만 남긴다
    assert.ok(Number(readFileSync(globalCooldown(work), 'utf8')) < Date.now() / 1000,
      '전역 식힘이 아직 유효하면 이 테스트는 억제를 검증하지 못한다');
    writePage(work, 'entities/page-a.md', 'Content about the front desk.'); // mtime 만 갱신
    runScan(work, {
      QMD_QUERY_FIXTURE: fixture,
      QMD_DEDUP_COOLDOWN_DIR: dirs.cooldownDir,
      QMD_SYNC_STATE_DIR: dirs.stateDir,
      QMD_DEDUP_LOG: dirs.logFile,
    });
    assert.equal(judgedByEngines(tracker).length, 1, '2회차 scan 의 유료 호출은 0회여야 한다');
    assert.equal(scanSkipped(work).length, 1, '재판정이 없으므로 새 마커도 없다');
  } finally { removeTemp(work); }
});

test('MAJOR 2 — 진짜 unclear 판정도 같은 성질이라 함께 억제한다(같은 본문 = 같은 무응답)', () => {
  const work = repoTemp('judge-unclear-suppressed');
  const tracker = trackerFile('unclear');
  try {
    writeScanSettings(work, { candidateMinScore: 0.3 }, {
      extractor: {
        timeout: 30,
        backends: { claude: engineJudgeStub('claude', 'unclear', tracker) },
      },
    });
    writePage(work, 'entities/page-a.md', 'Content about the front desk.');
    writePage(work, 'entities/page-b.md', 'Content about a different corridor entirely.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(judgedByEngines(tracker).length, 1);
    assert.equal(scanSkipped(work)[0].judgeVerdict, 'unclear');
    assert.deepEqual(scanQueue(work), [], 'unclear 는 중복이 아니므로 큐하지 않는다');

    clearCooldown(dirs);
    writePage(work, 'entities/page-a.md', 'Content about the front desk.');
    runScan(work, {
      QMD_QUERY_FIXTURE: fixture,
      QMD_DEDUP_COOLDOWN_DIR: dirs.cooldownDir,
      QMD_SYNC_STATE_DIR: dirs.stateDir,
      QMD_DEDUP_LOG: dirs.logFile,
    });
    assert.equal(judgedByEngines(tracker).length, 1, '같은 본문을 다시 물어보면 같은 무응답 = 순수 낭비');

    // 본문이 바뀌면 재무장한다(영구 억제가 아니다).
    clearCooldown(dirs);
    writePage(work, 'entities/page-a.md', 'A completely rewritten body about the front desk incident.');
    runScan(work, {
      QMD_QUERY_FIXTURE: fixture,
      QMD_DEDUP_COOLDOWN_DIR: dirs.cooldownDir,
      QMD_SYNC_STATE_DIR: dirs.stateDir,
      QMD_DEDUP_LOG: dirs.logFile,
    });
    assert.equal(judgedByEngines(tracker).length, 2, '본문 변경은 억제를 해제한다');
  } finally { removeTemp(work); }
});

test('MAJOR 2 — 남은 후보가 있으면 폐기가 아니라 degrade 다(verify defer_or_drop 와 대칭)', () => {
  const work = repoTemp('judge-unusable-degrade');
  const tracker = trackerFile('degrade');
  try {
    writeScanSettings(work, { candidateMinScore: 0.3 }, {
      extractor: {
        timeout: 30,
        backends: {
          claude: engineJudgeStub('claude', 'maybe', tracker),      // 첫 후보: 쓸 수 없는 출력
          codex: engineJudgeStub('codex', 'duplicate', tracker),    // 다음 후보: 정상
        },
      },
    });
    writePage(work, 'entities/page-a.md', 'The stalker asked for CCTV footage at the front desk.');
    writePage(work, 'entities/page-b.md', 'A restatement of the very same front desk CCTV request.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(judgedByEngines(tracker), ['claude'],
      'run 당 유료 호출 1회 — 같은 run 에서 다음 엔진을 부르지 않는다');
    assert.deepEqual(scanSkipped(work), [], '후보가 남아 있으면 억제하지 않는다(다음 후보가 판정할 수 있다)');
    assert.match(readFileSync(engineCooldown(work), 'utf8'), /claude/, '실패한 후보만 식힌다');

    // 다음 run: 식힌 후보를 건너뛰고 codex 가 판정한다.
    clearCooldown(dirs);
    runScan(work, {
      QMD_QUERY_FIXTURE: fixture,
      QMD_DEDUP_COOLDOWN_DIR: dirs.cooldownDir,
      QMD_SYNC_STATE_DIR: dirs.stateDir,
      QMD_DEDUP_LOG: dirs.logFile,
    });
    assert.deepEqual(judgedByEngines(tracker), ['claude', 'codex'], '다음 run 이 다음 후보로 degrade');
    assert.equal(scanQueue(work).length, 1, 'degrade 후 실제 판정을 얻는다');
  } finally { removeTemp(work); }
});

// MAJOR 3 — dedup 의 transient·식힘이 어디에도 기록되지 않았다(종점 부재 + 거짓 문서).
//
// `_back_off` 의 `engineCooldown`/`cooldownWriteFailed` 를 읽는 소비자가 저장소 전체에 없었고
// (`wiki_dedup_scan`·`wiki_compile` 은 verdict 있는 행만 기록) 요약 줄은 `judged=1 queued=0` 뿐이라
// "판정 실패"와 "unclear 판정"이 구분 불가였다. verify 는 `wiki_verify_worker.defer_or_drop` 에서
// 실제로 로그에 쓴다 — 같은 처방.
test('MAJOR 3 — scan: 유료 실패(exit 3)의 사유·엔진·식힘이 로그에 남는다', () => {
  const work = repoTemp('judge-transient-logged');
  const tracker = trackerFile('transient-log');
  try {
    writeScanSettings(work, { candidateMinScore: 0.3 }, {
      extractor: {
        timeout: 30,
        backends: { claude: engineJudgeStub('claude', 'duplicate', tracker, { exitCode: 3 }) },
      },
    });
    writePage(work, 'entities/page-a.md', 'Body A about the front desk.');
    writePage(work, 'entities/page-b.md', 'Body B about the front desk.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    const logText = readFileSync(dirs.logFile, 'utf8');

    assert.equal(judgedByEngines(tracker).length, 1);
    assert.match(logText, /JUDGE pair=entities\/page-a\.md\|entities\/page-b\.md/);
    assert.match(logText, /outcome=transient/, '"판정 실패"가 "unclear 판정"과 구분되어야 한다');
    assert.match(logText, /engine=claude/);
    assert.match(logText, /reason=\S+/, '사유 없는 실패는 진단할 수 없다');
    // 후보가 하나뿐이므로 종점은 전역 식힘이다(그 사실도 관측 가능해야 한다).
    assert.equal(existsSync(globalCooldown(work)), true);
    assert.deepEqual(scanQueue(work), []);
    assert.deepEqual(scanSkipped(work), [], 'transient 는 판정이 아니므로 억제하지 않는다');
  } finally { removeTemp(work); }
});

test('MAJOR 3 — 식힘 쓰기가 전부 실패하면 cooldownWriteFailed 가 표면화된다(scan)', () => {
  const work = repoTemp('judge-cooldown-write-failed');
  const tracker = trackerFile('cooldown-fail');
  try {
    writeScanSettings(work, { candidateMinScore: 0.3 }, {
      extractor: {
        timeout: 30,
        backends: { claude: engineJudgeStub('claude', 'duplicate', tracker, { exitCode: 3 }) },
      },
    });
    writePage(work, 'entities/page-a.md', 'Body A about the front desk.');
    writePage(work, 'entities/page-b.md', 'Body B about the front desk.');
    // 전역 식힘 경로를 **디렉터리**로 만들어 쓰기 불가 상태를 만든다(실측된 실패 모드).
    mkdirSync(globalCooldown(work), { recursive: true });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.56 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.match(readFileSync(dirs.logFile, 'utf8'), /cooldownWriteFailed=True/,
      '조용히 삼키면 다음 run 이 같은 후보를 다시 유료로 부르는데 흔적이 0이다');
  } finally { removeTemp(work); }
});

test('MAJOR 3 — write-time: 유료 실패가 candidates.jsonl 의 judge 진단에 남는다', () => {
  const work = repoTemp('judge-writetime-diag');
  const tracker = trackerFile('writetime-diag');
  try {
    crossEngineSettings(work, { claude: engineJudgeStub('claude', 'duplicate', tracker, { exitCode: 3 }) });
    writeExistingCard(work, 'entities/existing.md');
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    // 후보가 하나뿐 → 종점은 전역 식힘이고, 그 경로를 디렉터리로 막아 두 쓰기를 모두 실패시킨다.
    mkdirSync(globalCooldown(work), { recursive: true });
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    const out = runCrossCompile(work, fixture, 'Candidate judged while the only CLI fails');
    assert.equal(out.action, 'created', '판정이 없었으므로 score 게이트로 degrade');

    const candidates = jsonl(join(work, '.auto-context/compile/candidates.jsonl'));
    const diag = candidates.at(-1).judge;
    assert.ok(diag, 'judge 진단이 없으면 compile 마다 재과금하는데 흔적이 0이다');
    assert.equal(diag.outcome, 'transient');
    assert.equal(diag.engine, 'claude');
    assert.equal(diag.cooldownWriteFailed, true);
    assert.deepEqual(diag.enginesAttempted, ['claude']);
  } finally { removeTemp(work); }
});

test('정상 판정에도 reasoning-effort audit metadata만 judge 진단으로 남긴다', () => {
  const work = repoTemp('judge-diag-quiet');
  const tracker = trackerFile('diag-quiet');
  try {
    crossEngineSettings(work, { claude: engineJudgeStub('claude', 'distinct', tracker) });
    writeExistingCard(work, 'entities/existing.md');
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    runCrossCompile(work, fixture, 'A genuinely different fact');
    const candidates = jsonl(join(work, '.auto-context/compile/candidates.jsonl'));
    assert.deepEqual(candidates.at(-1).judge._qmd.reasoningEffort, {
      requested: 'medium', applied: null, status: 'unsupported', reason: 'capability_not_declared',
    });
  } finally { removeTemp(work); }
});
