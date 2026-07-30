import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// LLM dedup judge (core/wiki_dedup_judge.py) wired into both dedup paths.
//
// No test here may invoke a real host CLI: every judge is a bash/python stub
// handed to compile.extractor.argv, exactly like test/wiki-verify-worker.test.mjs
// stubs the verifier.

function repoTemp(prefix) {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `qmd-test-${prefix}-`));
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
  rmSync(d, { recursive: true, force: true });
});

test('resolve_engine: backends-only config resolves without a caller hint (retroactive scan has none)', () => {
  // Regression: the scan calls is_available()/judge_pair() with no engine, so a
  // config using extractor.backends WITHOUT builtins resolved to "" -> backends[""]
  // missed -> judge permanently "unavailable" -> every scan silently degraded to the
  // legacy score gate. Both dogfood projects use exactly that shape.
  const py = `import json,os,sys; sys.path.insert(0,'core'); import wiki_dedup_judge as j
backends = {'compile': None}
cfg_backends = {'extractor': {'dispatch': 'by-engine', 'backends': {'codex': ['/x/codex'], 'claude': ['/x/claude']}, 'default': []}}
cfg_builtins = {'extractor': {'dispatch': 'by-engine', 'builtins': ['codex'], 'backends': {'claude': ['/x/claude']}, 'default': []}}
out = {}
out['backends_no_hint'] = j.resolve_engine(cfg_backends)
out['backends_hint_wins'] = j.resolve_engine(cfg_backends, 'hermes')
out['builtins_preferred'] = j.resolve_engine(cfg_builtins)
os.environ['QMD_ENGINE'] = 'codex'
out['env_configured'] = j.resolve_engine(cfg_backends)
os.environ['QMD_ENGINE'] = 'gemini'
out['env_unconfigured'] = j.resolve_engine(cfg_backends)
out['available_no_hint'] = j.is_available(cfg_backends)
print(json.dumps(out))`;
  const out = JSON.parse(runLib(py));
  // Deterministic pick (sorted) so two hosts scanning the same project agree.
  assert.equal(out.backends_no_hint, 'claude');
  assert.equal(out.backends_hint_wins, 'hermes', '명시 hint가 최우선');
  assert.equal(out.builtins_preferred, 'codex', 'builtins가 backends 키보다 우선');
  assert.equal(out.env_configured, 'codex', '설정된 host engine이면 QMD_ENGINE 채택');
  assert.equal(out.env_unconfigured, 'claude', '미설정 engine 라벨로는 죽지 않음');
  assert.equal(out.available_no_hint, true, 'hint 없이도 judge 가용');
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
      enabled: true,
      mode: 'auto-wiki',
      autoWrite: true,
      defaultStatus: 'generated',
      candidatePath: '.auto-context/compile/candidates.jsonl',
      tombstonePath: '.auto-context/compile/tombstones.jsonl',
      manifestPath: '.auto-context/compile/generated-manifest.jsonl',
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
    env: { ...process.env, ...env },
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
    writeCompileSettings(work, { extractor: { argv: judgeStub('duplicate', { callLog: log }), timeout: 30 } });
    writeExistingCard(work, 'entities/existing.md');
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.56 }]);

    const out = runCompile(work, {
      title: 'Restated version of the same event',
      summary: 'A near-duplicate of the existing card, written under its own path.',
      suggestedType: 'entity',
      confidence: 'high',
      targetPath: '.auto-context/wiki/entities/restated.md',
    }, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(out.action, 'queued_for_review');
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
    assert.ok(queued[0].candidate && queued[0].suggestedAction && 'matchedScore' in queued[0]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('write-time gate: a "distinct" verdict lets the page be created (score alone would have blocked it)', () => {
  const work = repoTemp('judge-distinct-creates');
  try {
    const log = join(work, 'calls.jsonl');
    writeCompileSettings(work, { extractor: { argv: judgeStub('distinct', { callLog: log }), timeout: 30 } });
    writeExistingCard(work, 'entities/existing.md');
    // 0.95 is far above the legacy 0.82 threshold: the judge, not the score, decides.
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.95 }]);

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
    rmSync(work, { recursive: true, force: true });
  }
});

test('write-time gate: judge.maxPairsPerCompile caps how many LLM calls one compile can bill', () => {
  const work = repoTemp('judge-compile-budget');
  try {
    const log = join(work, 'calls.jsonl');
    writeCompileSettings(work, {
      extractor: { argv: judgeStub('distinct', { callLog: log }), timeout: 30 },
      semanticDedup: { judge: { maxPairsPerCompile: 2 } },
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
    assert.equal(callCount(log), 2, 'maxPairsPerCompile=2 must cap judge calls at 2, not 3');
  } finally {
    rmSync(work, { recursive: true, force: true });
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
    rmSync(work, { recursive: true, force: true });
  }
});

test('write-time gate: judge on cooldown falls back to the legacy threshold for slug targets', () => {
  const work = repoTemp('judge-cooldown-fallback');
  try {
    writeCompileSettings(work, { extractor: { argv: judgeStub('duplicate'), timeout: 30 } });
    writeExistingCard(work, 'entities/existing.md');
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'compile', 'dedup-judge-cooldown'),
      `${Date.now() / 1000 + 3600}\n`);
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/existing.md', score: 0.95 }]);

    const out = runCompile(work, {
      title: 'Slug target while the judge is cooling down',
      summary: 'Must still be gated by the legacy score threshold rather than silently written.',
      suggestedType: 'entity',
      confidence: 'high',
    }, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(out.action, 'queued_for_review');
    assert.equal(out.judgeVerdict, undefined, 'no verdict exists — this is the score fallback');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('write-time gate: a reviewed target is still only queued, never overwritten or deleted', () => {
  const work = repoTemp('judge-protected-target');
  try {
    writeCompileSettings(work, { extractor: { argv: judgeStub('duplicate'), timeout: 30 } });
    const card = join(work, '.auto-context', 'wiki', 'entities', 'reviewed.md');
    mkdirSync(join(card, '..'), { recursive: true });
    const original = [
      '---',
      'title: "Human reviewed"',
      'type: entity',
      'status: reviewed',
      'createdBy: qmd-auto-context',
      'reviewed: true',
      '---',
      '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->',
      '## Summary',
      'A fact a human confirmed by hand.',
      '<!-- qmd:auto:end -->',
      '',
    ].join('\n');
    writeFileSync(card, original);
    const fixture = fixtureFor(work, [{ file: 'proj-wiki/entities/reviewed.md', score: 0.9 }]);

    const out = runCompile(work, {
      title: 'Restatement of a reviewed fact',
      summary: 'The judge calls this a duplicate; the reviewed card must survive untouched.',
      suggestedType: 'entity',
      confidence: 'high',
    }, { QMD_QUERY_FIXTURE: fixture });

    assert.equal(out.action, 'queued_for_review');
    assert.equal(readFileSync(card, 'utf8'), original, 'reviewed card must be byte-identical');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
      enabled: true,
      mode: 'auto-wiki',
      autoWrite: true,
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
  rmSync(dirs.cooldownDir, { recursive: true, force: true });
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
test('retroactive scan: a "duplicate" verdict is queued even though the score is far below autoMergeThreshold 0.9', () => {
  const work = repoTemp('judge-scan-below-threshold');
  try {
    const log = join(work, 'calls.jsonl');
    writeScanSettings(work, { judge: { maxPairsPerScan: 4 } }, {
      extractor: { argv: judgeStub('duplicate', { callLog: log }), timeout: 30 },
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
    rmSync(work, { recursive: true, force: true });
  }
});

test('retroactive scan: a "distinct" verdict is not queued, is recorded as a skip, and is not re-judged next scan', () => {
  const work = repoTemp('judge-scan-distinct');
  try {
    const log = join(work, 'calls.jsonl');
    writeScanSettings(work, { candidateMinScore: 0.3 }, {
      extractor: { argv: judgeStub('distinct', { callLog: log, reason: 'different events' }), timeout: 30 },
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

    const first = callCount(log);
    // Second scan with unchanged bodies: suppression must keep the judge idle.
    clearCooldown(dirs);
    writePage(work, 'entities/page-a.md', 'Content about the front desk.'); // touch mtime only
    runScan(work, { QMD_QUERY_FIXTURE: fixture, QMD_DEDUP_COOLDOWN_DIR: dirs.cooldownDir, QMD_SYNC_STATE_DIR: dirs.stateDir, QMD_DEDUP_LOG: dirs.logFile });
    assert.equal(callCount(log), first, 'suppressed pair must not be re-judged');
    assert.deepEqual(scanQueue(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('retroactive scan: judge.maxPairsPerScan caps LLM calls and leaves unjudged pages for the next scan', () => {
  const work = repoTemp('judge-scan-budget');
  try {
    const log = join(work, 'calls.jsonl');
    writeScanSettings(work, { judge: { maxPairsPerScan: 1 }, maxPairsPerScan: 10 }, {
      extractor: { argv: judgeStub('distinct', { callLog: log }), timeout: 30 },
    });
    writePage(work, 'entities/page-a.md', 'Body A.');
    writePage(work, 'entities/page-b.md', 'Body B.');
    writePage(work, 'entities/page-c.md', 'Body C.');
    const fixture = join(work, 'fixture.json');
    // Every page retrieves page-c, so each scanned page wants its own judge call.
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-c.md', score: 0.6 }] }));

    const dirs = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(callCount(log), 1, 'judge.maxPairsPerScan=1 must allow exactly one call');

    const snap = snapshotOf(dirs.stateDir);
    const recorded = Object.keys(snap.files || {});
    assert.ok(recorded.length < 3, `pages beyond the judge budget must stay unadvanced, got ${JSON.stringify(recorded)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('retroactive scan: judge timeout sets a cooldown, queues nothing, and leaves the page unadvanced', () => {
  const work = repoTemp('judge-scan-transient');
  try {
    writeScanSettings(work, { judge: { timeout: 1, cooldownSeconds: 900 } }, {
      extractor: { argv: judgeStub('duplicate', { sleep: 5 }), timeout: 30 },
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
    rmSync(work, { recursive: true, force: true });
  }
});

test('retroactive scan: an absent host CLI degrades to the legacy score threshold rather than stalling', () => {
  const work = repoTemp('judge-scan-cli-absent');
  try {
    writeScanSettings(work, { autoMergeThreshold: 0.9 }, {
      extractor: { argv: ['/nonexistent/dedup-judge-xyz'], timeout: 30 },
    });
    writePage(work, 'entities/page-a.md', 'Body A.');
    writePage(work, 'entities/page-b.md', 'Body B.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));

    runScan(work, { QMD_QUERY_FIXTURE: fixture });

    const queued = scanQueue(work);
    assert.equal(queued.length, 1, 'above the legacy threshold, so the legacy gate must still queue it');
    assert.equal(queued[0].judgeVerdict, undefined, 'no judge ran — no verdict may be claimed');
    assert.equal(Object.keys(queued[0]).sort().join(','), 'pageA,pageB,score',
      'unjudged rows must keep the original queue shape');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('retroactive scan: the judge never deletes or edits a card — it only queues', () => {
  const work = repoTemp('judge-scan-no-writes');
  try {
    writeScanSettings(work, {}, { extractor: { argv: judgeStub('duplicate'), timeout: 30 } });
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
    rmSync(work, { recursive: true, force: true });
  }
});

test('QMD_DEDUP_JUDGE=off disables judging entirely (legacy threshold behavior)', () => {
  const work = repoTemp('judge-kill-switch');
  try {
    const log = join(work, 'calls.jsonl');
    writeScanSettings(work, { autoMergeThreshold: 0.9 }, {
      extractor: { argv: judgeStub('duplicate', { callLog: log }), timeout: 30 },
    });
    writePage(work, 'entities/page-a.md', 'Body A.');
    writePage(work, 'entities/page-b.md', 'Body B.');
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));

    runScan(work, { QMD_QUERY_FIXTURE: fixture, QMD_DEDUP_JUDGE: 'off' });

    assert.equal(callCount(log), 0, 'kill switch must prevent any LLM call');
    assert.equal(scanQueue(work).length, 1, 'legacy threshold still applies');
  } finally {
    rmSync(work, { recursive: true, force: true });
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
      extractor: { argv: judgeStub('distinct', { callLog: log }), timeout: 30 },
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
    rmSync(work, { recursive: true, force: true });
  }
});
