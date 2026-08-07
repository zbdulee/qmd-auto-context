// Guards on writes that a MODEL chose the destination for, plus the swallowed-return
// class that made a failed write look like a success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers/temp.mjs';

const EXISTING_REL = '.auto-context/wiki/entities/existing-a.md';

function existingCard({ status = 'verified', manual = '' } = {}) {
  return [
    '---', 'title: "Existing A"', 'canonicalKey: "existing-a"', 'type: entity',
    `status: ${status}`, 'createdBy: qmd-auto-context', 'reviewed: false',
    'sources:', '  - {kind: file, path: "docs/a.md", collection: "proj-docs"}', '---', '',
    '<!-- qmd:auto:start id="main" sourceHash="a01da0" -->', '## Summary',
    'Durable decision: card A records the A decision.', '<!-- qmd:auto:end -->', '',
    ...(manual ? ['## Manual notes', manual, ''] : []),
  ].join('\n');
}

function setupProject({ compile: compileOverrides = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-guards-'));
  mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'wiki', 'entities'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'a.md'), '# a\n\nDurable decision: card A records the A decision.\n');
  writeFileSync(join(dir, 'docs', 'b.md'), '# b\n\nDurable decision: card B records the unrelated B decision.\n');
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-docs', 'proj-wiki'],
    collectionPaths: { 'proj-docs': 'docs', 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-docs': 'raw', 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: {
      mode: 'auto-wiki', defaultStatus: 'generated',
      triggers: ['post_tool_source', 'manual'], maxSourceChars: 12000,
      semanticDedup: { enabled: false },
      verify: { enabled: false },
      ...compileOverrides,
    },
  }));
  return dir;
}

function compile(dir, candidate) {
  const out = execFileSync('python3', ['core/wiki_compile.py', '--cwd', dir], {
    cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(candidate),
    env: { ...process.env, QMD_DIRTY_QUEUE: join(dir, 'dirty-queue') },
  });
  return JSON.parse(out.trim());
}

function jsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// `targetPath` is model output and resolve_target trusts it over identity lookup, so an
// extractor can aim an unrelated candidate at an existing card. Both downstream verdicts
// are destructive: inconclusive deletes the page (losing any human `## Manual notes`,
// which the deletion ledger does not store), and pass keeps A's frontmatter while the body
// becomes B — provenance silently wrong, and the injected source path points at the wrong
// file.
test('an unrelated candidate cannot overwrite an existing card; it goes to merge-needed', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, EXISTING_REL), existingCard({ manual: 'Hand-written context that cannot be regenerated.' }));
    const before = readFileSync(join(dir, EXISTING_REL), 'utf8');

    const result = compile(dir, {
      trigger: 'post_tool_source',
      engine: 'codex',
      title: 'Unrelated B',
      canonicalKey: 'unrelated-b',
      summary: 'Durable decision: card B records the unrelated B decision.',
      suggestedType: 'entity',
      confidence: 'high',
      targetPath: EXISTING_REL,
      sources: [{ kind: 'file', path: 'docs/b.md', collection: 'proj-docs' }],
    });

    assert.equal(result.action, 'merge-needed');
    assert.equal(result.reason, 'identity_mismatch');
    assert.equal(readFileSync(join(dir, EXISTING_REL), 'utf8'), before, 'card must be byte-identical');

    // The candidate is recoverable through the existing review queue, not just logged.
    const queued = jsonl(join(dir, '.auto-context', 'compile', 'merge-needed.jsonl'));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].matchedPath, EXISTING_REL);
    assert.equal(queued[0].reason, 'identity_mismatch');
    assert.equal(queued[0].candidate.title, 'Unrelated B');
    const rows = jsonl(join(dir, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(rows.at(-1).action, 'merge-needed');
    assert.deepEqual(rows.at(-1).lint.findings, ['identity_mismatch']);
  } finally {
    removeTemp(dir);
  }
});

test('a re-extraction of the same document still updates its own card', () => {
  // The guard must not block the legitimate case the update path exists for: same
  // identity (canonicalKey) or same source means "this card's source changed".
  const dir = setupProject();
  try {
    writeFileSync(join(dir, EXISTING_REL), existingCard({ status: 'verified' }));
    const sameKey = compile(dir, {
      trigger: 'post_tool_source', engine: 'codex',
      title: 'Existing A renamed',
      canonicalKey: 'existing-a',
      summary: 'Durable decision: card A now records a revised A decision.',
      suggestedType: 'entity', confidence: 'high', targetPath: EXISTING_REL,
      sources: [{ kind: 'file', path: 'docs/a.md', collection: 'proj-docs' }],
    });
    assert.equal(sameKey.action, 'updated');
    const text = readFileSync(join(dir, EXISTING_REL), 'utf8');
    assert.match(text, /revised A decision/);
    assert.match(text, /^status: generated$/m, 'stale verification must be reset');
  } finally {
    removeTemp(dir);
  }
});

test('a shared source path counts as agreement even when the identity was renamed', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, EXISTING_REL), existingCard({ status: 'generated' }));
    const sameSource = compile(dir, {
      trigger: 'post_tool_source', engine: 'codex',
      title: 'Totally different label',
      canonicalKey: 'totally-different-label',
      summary: 'Durable decision: the A document was retitled but is the same source.',
      suggestedType: 'entity', confidence: 'high', targetPath: EXISTING_REL,
      sources: [{ kind: 'file', path: 'docs/a.md', collection: 'proj-docs' }],
    });
    assert.equal(sameSource.action, 'updated');
  } finally {
    removeTemp(dir);
  }
});

test('a failed verification stamp preserves the job instead of logging success', () => {
  // Measured: with the card directory chmod 500, verify-log said "verified", the queue was
  // emptied, and the card stayed `status: generated` — a paid call spent, no retry, and the
  // card permanently invisible under the default recallVerifiedOnly.
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-stamp-'));
  const cardDir = join(dir, '.auto-context', 'wiki', 'concepts');
  const cardRel = '.auto-context/wiki/concepts/stamp-card.md';
  mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(cardDir, { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const verifier = join(dir, 'verify.py');
  writeFileSync(verifier, `#!/usr/bin/env python3
import json, sys
json.loads(sys.stdin.read())
print(json.dumps({'verdict': 'pass', 'claims': [], 'reasons': []}))
`);
  writeFileSync(join(dir, 'docs', 'source.md'), '# s\n\nDurable claim: the source cites markdown.\n');
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-docs', 'proj-wiki'],
    collectionPaths: { 'proj-docs': 'docs', 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-docs': 'raw', 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: {
      mode: 'auto-wiki', defaultStatus: 'generated',
      triggers: ['post_tool_source'], maxSourceChars: 12000,
      extractor: { backends: { claude: ['python3', verifier] }, timeout: 60 },
      budget: { verifyPerRun: 3 },
      verify: { enabled: true, timeout: 60 },
    },
  }));
  writeFileSync(join(dir, cardRel), [
    '---', 'title: "Stamp Card"', 'status: generated', 'createdBy: qmd-auto-context',
    'reviewed: false', '---', '',
    '<!-- qmd:auto:start id="main" sourceHash="h1" -->', '## Summary',
    'Durable claim: the source cites markdown.', '<!-- qmd:auto:end -->', '',
  ].join('\n'));
  writeFileSync(join(dir, '.auto-context', 'compile', 'verify-queue.jsonl'), JSON.stringify({
    ts: '2026-07-30T00:00:00Z', targetPath: cardRel,
    sources: [{ kind: 'file', path: 'docs/source.md', collection: 'proj-docs' }],
    sourceHash: 'h1', engine: 'claude', trigger: 'post_tool_source',
  }) + '\n');
  try {
    chmodSync(cardDir, 0o500);  // readable + executable, not writable -> atomic write fails
    const out = JSON.parse(execFileSync('python3', ['core/wiki_verify_worker.py', '--cwd', dir, '--json'], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, QMD_DIRTY_QUEUE: join(dir, 'dirty-queue') },
    }).trim());

    assert.equal(out.processed, 0, 'a failed stamp is not a processed job');
    assert.equal(out.remaining, 1, 'the job must survive for the next run');
    chmodSync(cardDir, 0o700);
    assert.match(readFileSync(join(dir, cardRel), 'utf8'), /^status: generated$/m);
    const log = jsonl(join(dir, '.auto-context', 'compile', 'verify-log.jsonl'));
    assert.equal(log.at(-1).result, 'stamp_failed');
    assert.equal(log.at(-1).stampStatus, 'verified');
    assert.ok(!log.some((row) => row.result === 'verified'), 'must not claim success');

    // Once the directory is writable again the retry succeeds.
    const retry = JSON.parse(execFileSync('python3', ['core/wiki_verify_worker.py', '--cwd', dir, '--json'], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, QMD_DIRTY_QUEUE: join(dir, 'dirty-queue') },
    }).trim());
    assert.equal(retry.processed, 1);
    assert.match(readFileSync(join(dir, cardRel), 'utf8'), /^status: verified$/m);
  } finally {
    try { chmodSync(cardDir, 0o700); } catch { /* already restored */ }
    removeTemp(dir);
  }
});

// The deletion audit ledger is fail-closed: no card is removed without its audit row. That
// is right, but the failure had NO ENDPOINT — a verdict was paid for, the ledger write
// failed, the job was preserved, and the next run paid again. Measured: 3 runs, 3 paid
// verify calls, card still `generated` (invisible under recallVerifiedOnly), no cooldown and
// no suppression marker, and the only trace was in a log that gets trimmed.
function stampProject({ onFail = 'delete', onInconclusive, verdict = 'fail' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-ledger-'));
  const cardRel = '.auto-context/wiki/concepts/ledger-card.md';
  mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const verifier = join(dir, 'verify.py');
  const callLog = join(dir, 'verify-calls.log');
  writeFileSync(verifier, `#!/usr/bin/env python3
import json, sys, pathlib
json.loads(sys.stdin.read())
with pathlib.Path(${JSON.stringify(callLog)}).open('a') as h:
    h.write('call\\n')
print(json.dumps({'verdict': ${JSON.stringify(verdict)}, 'claims': [], 'reasons': ['source contradicts card']}))
`);
  writeFileSync(join(dir, 'docs', 'source.md'), '# s\n\nDurable claim: the source says something else.\n');
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-docs', 'proj-wiki'],
    collectionPaths: { 'proj-docs': 'docs', 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-docs': 'raw', 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: {
      mode: 'auto-wiki', defaultStatus: 'generated',
      triggers: ['post_tool_source'], maxSourceChars: 12000,
      extractor: { backends: { claude: ['python3', verifier] }, timeout: 60 },
      budget: { verifyPerRun: 3 },
      verify: {
        enabled: true, timeout: 60, onFail,
        ...(onInconclusive ? { onInconclusive } : {}),
      },
    },
  }));
  writeFileSync(join(dir, cardRel), [
    '---', 'title: "Ledger Card"', 'status: generated', 'createdBy: qmd-auto-context',
    'reviewed: false', '---', '',
    '<!-- qmd:auto:start id="main" sourceHash="h1" -->', '## Summary',
    'Durable claim: the card says one thing.', '<!-- qmd:auto:end -->', '',
  ].join('\n'));
  writeFileSync(join(dir, '.auto-context', 'compile', 'verify-queue.jsonl'), JSON.stringify({
    ts: '2026-07-30T00:00:00Z', targetPath: cardRel,
    sources: [{ kind: 'file', path: 'docs/source.md', collection: 'proj-docs' }],
    sourceHash: 'h1', engine: 'claude', trigger: 'post_tool_source',
  }) + '\n');
  return { dir, cardRel, callLog };
}

function runVerify(dir) {
  return JSON.parse(execFileSync('python3', ['core/wiki_verify_worker.py', '--cwd', dir, '--json'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, QMD_DIRTY_QUEUE: join(dir, 'dirty-queue') },
  }).trim());
}

function paidCalls(log) {
  if (!existsSync(log)) return 0;
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length;
}

test('the deletion audit row always lands in the fixed compile-dir ledger', () => {
  // `compile.verify.deletedPath` is gone: the path is a constant in core/compile_paths.py,
  // so the typo that used to return None (and open the billing loop) is unspellable. What
  // still has to hold is the destination — every machine deletion is auditable at exactly
  // `<root>/.auto-context/compile/verify-deleted.jsonl`, for one paid call.
  const { dir, cardRel, callLog } = stampProject();
  try {
    const out = runVerify(dir);
    assert.equal(out.processed, 1, 'the verdict is applied, not blocked');
    assert.equal(existsSync(join(dir, cardRel)), false, 'fail verdict deletes the card');
    const ledger = join(dir, '.auto-context', 'compile', 'verify-deleted.jsonl');
    assert.equal(jsonl(ledger).length, 1, 'the row lands in the default location');
    assert.equal(jsonl(ledger)[0].verdict, 'fail');
    assert.equal(paidCalls(callLog), 1);
  } finally {
    removeTemp(dir);
  }
});

// The removed `*Path` settings each carried a containment check (`safe_compile_file`).
// Constant names removed the typo, not the escape: the file itself can be a symlink out of
// the project, and then an append rewrites something outside `.auto-context/compile`.
// `compile_paths.ledger()` is now the single place that refuses that.
test('compile_paths.ledger refuses a symlink escape out of the compile dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-escape-'));
  try {
    mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(join(dir, 'outside.jsonl'), '');
    symlinkSync(join(dir, 'outside.jsonl'), join(dir, '.auto-context', 'compile', 'verify-deleted.jsonl'));
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });

    const probe = execFileSync('python3', ['-c', `import sys, json, pathlib
sys.path.insert(0, ${JSON.stringify(process.cwd() + '/core')})
import compile_paths as cp
root = pathlib.Path(${JSON.stringify(dir)}).resolve()
out = {
  'escaped': cp.ledger(root, cp.VERIFY_DELETED),
  'contained': cp.ledger(root, cp.VERIFY_SKIPPED),
  'dir': cp.compile_dir(root),
}
print(json.dumps({k: (str(v) if v is not None else None) for k, v in out.items()}))
`], { cwd: process.cwd(), encoding: 'utf8' });
    const r = JSON.parse(probe.trim());
    assert.equal(r.escaped, null, 'a ledger symlinked outside the compile dir is refused');
    const compileDir = execFileSync('python3', ['-c',
      `import pathlib; print(pathlib.Path(${JSON.stringify(dir)}).resolve() / '.auto-context/compile')`],
      { cwd: process.cwd(), encoding: 'utf8' }).trim();
    assert.equal(r.dir, compileDir);
    assert.equal(r.contained, join(compileDir, 'verify-skipped.jsonl'), 'ordinary names resolve normally');
    assert.equal(readFileSync(join(dir, 'outside.jsonl'), 'utf8'), '', 'probing never writes through the symlink');
  } finally {
    removeTemp(dir);
  }
});

test('an unwritable audit ledger stops verification before spending anything', () => {
  const { dir, cardRel, callLog } = stampProject();
  const ledger = join(dir, '.auto-context', 'compile', 'verify-deleted.jsonl');
  try {
    // A directory at the ledger path is the measured failure mode: writable compile dir,
    // unwritable ledger. Without a preflight this cost one paid call per run, forever.
    mkdirSync(ledger, { recursive: true });
    for (const attempt of [1, 2, 3]) {
      const out = runVerify(dir);
      assert.equal(out.reason, 'audit_ledger_unwritable', `run ${attempt}`);
      assert.equal(out.processed, 0);
      assert.equal(paidCalls(callLog), 0, `run ${attempt}: no host CLI call may happen`);
      assert.equal(existsSync(join(dir, cardRel)), true, 'the card is preserved (fail-closed)');
    }
    // The job is still queued, so fixing the ledger resumes verification.
    assert.equal(jsonl(join(dir, '.auto-context', 'compile', 'verify-queue.jsonl')).length, 1);
    removeTemp(ledger);
    const after = runVerify(dir);
    assert.equal(after.processed, 1);
    assert.equal(paidCalls(callLog), 1);
    assert.equal(existsSync(join(dir, cardRel)), false);
  } finally {
    removeTemp(dir);
  }
});

test('the preflight does not create the ledger when nothing was deleted', () => {
  // The ledger's existence reads as "cards have been deleted in this project", so probing
  // must not fabricate it.
  const { dir } = stampProject({ onFail: 'contested' });
  try {
    runVerify(dir);
    assert.equal(existsSync(join(dir, '.auto-context', 'compile', 'verify-deleted.jsonl')), false);
  } finally {
    removeTemp(dir);
  }
});

test('a mid-run ledger failure leaves a trace instead of an rc=1 traceback', () => {
  // record_verify_deletion used to let OSError propagate: the standalone worker died with a
  // traceback and verify-log.jsonl got NO line, so "at least there is a trace" was false.
  const { dir, cardRel } = stampProject();
  try {
    const py = `import json, sys, pathlib
sys.argv = ['wiki_verify_worker.py', '--cwd', ${JSON.stringify(dir)}, '--json']
sys.path.insert(0, ${JSON.stringify(process.cwd() + '/core')})
import wiki_verify_worker as v
real = v.wc.append_jsonl
def boom(path, payload):
    if 'verify-deleted' in str(path):
        raise OSError('ENOSPC')
    return real(path, payload)
v.wc.append_jsonl = boom
v.ledger_writable = lambda path: True   # pass the preflight, fail at write time
v.main()
`;
    const out = execFileSync('python3', ['-c', py], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, QMD_DIRTY_QUEUE: join(dir, 'dirty-queue') },
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.processed, 0);
    assert.equal(parsed.remaining, 1, 'job preserved');
    assert.equal(existsSync(join(dir, cardRel)), true, 'card not deleted without its audit row');
    const log = jsonl(join(dir, '.auto-context', 'compile', 'verify-log.jsonl'));
    assert.equal(log.at(-1).result, 'delete_blocked');
    assert.equal(log.at(-1).reason, 'audit_ledger_unwritable');
  } finally {
    removeTemp(dir);
  }
});

// 6단계에서 삭제 감사 원장에 적용한 처방(삭제 전 기록 + 실패에 fail-closed + 유료 호출 전
// preflight)이 **억제 원장에는 적용되지 않았다**. inconclusive 삭제는 마커 없이는 unchanged
// source가 재컴파일→재검수→재삭제를 반복하고 매 반복이 유료 호출이다.
test('inconclusive: 억제 원장 쓰기 실패면 카드를 지우지 않는다 (fail-closed)', () => {
  const { dir, cardRel } = stampProject({ verdict: 'inconclusive' });
  try {
    const py = `import sys
sys.argv = ['wiki_verify_worker.py', '--cwd', ${JSON.stringify(dir)}, '--json']
sys.path.insert(0, ${JSON.stringify(process.cwd() + '/core')})
import wiki_verify_worker as v
real = v.wc.append_jsonl
def boom(path, payload):
    if 'verify-skipped' in str(path):
        raise OSError('ENOSPC')
    return real(path, payload)
v.wc.append_jsonl = boom
v.ledger_writable = lambda path: True   # preflight 통과 → 쓰기 시점에서 실패
v.main()
`;
    const out = execFileSync('python3', ['-c', py], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, QMD_DIRTY_QUEUE: join(dir, 'dirty-queue') },
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.processed, 0);
    assert.equal(parsed.remaining, 1, '잡 보존 → 재시도 가능');
    assert.equal(existsSync(join(dir, cardRel)), true,
      '억제 마커 없이 지우면 재컴파일→재삭제 과금 루프가 열린다');
    const log = jsonl(join(dir, '.auto-context', 'compile', 'verify-log.jsonl'));
    assert.equal(log.at(-1).result, 'delete_blocked');
    assert.equal(log.at(-1).reason, 'suppression_ledger_unwritable');
  } finally {
    removeTemp(dir);
  }
});

// 종점: fail-closed 만으로는 "판정(유료) → 원장 실패 → 잡 보존 → 재판정(유료)" 루프가
// 남는다. 유료 호출 **전에** 막아야 호출 0회가 된다.
test('inconclusive 삭제 설정 + 억제 원장 불가 → 유료 호출 0회로 선차단', () => {
  const { dir, callLog } = stampProject({ verdict: 'inconclusive' });
  try {
    // 억제 원장 자리에 **디렉터리**가 있으면 append 불가(실측된 실패 모드). 경로는 이제
    // 상수이므로 오타로는 못 만들지만 쓰기 불가 상태 자체는 그대로 발생한다.
    mkdirSync(join(dir, '.auto-context', 'compile', 'verify-skipped.jsonl'), { recursive: true });
    const parsed = runVerify(dir);
    assert.equal(parsed.reason, 'suppression_ledger_unwritable');
    assert.equal(parsed.processed, 0);
    assert.equal(existsSync(callLog), false, 'verifier(유료)를 부르지 않았다');
    assert.equal(
      readFileSync(join(dir, '.auto-context', 'compile', 'verify-queue.jsonl'), 'utf8').trim().length > 0,
      true, '큐를 claim하지 않았으므로 잡이 그대로 있다');
  } finally {
    removeTemp(dir);
  }
});

// `onInconclusive`가 삭제가 아니면 억제 마커가 필요 없다 — 무조건 검사하면 그 프로젝트의
// 검수를 이유 없이 막는다.
test('onInconclusive=none이면 억제 원장 불가가 검수를 막지 않는다', () => {
  const { dir, callLog } = stampProject({ verdict: 'inconclusive', onInconclusive: 'none' });
  try {
    mkdirSync(join(dir, '.auto-context', 'compile', 'verify-skipped.jsonl'), { recursive: true });
    const parsed = runVerify(dir);
    assert.equal(parsed.reason, undefined, '선차단되지 않는다');
    assert.equal(parsed.processed, 1);
    assert.equal(existsSync(callLog), true);
  } finally {
    removeTemp(dir);
  }
});

// `verify_deleted_path`가 이미 닫은 것과 같은 과금 루프 입구: 억제 마커 경로가 `None`이
// 되면 "마커가 한 줄도 안 남는" 상태가 된다. 설정 키(`skippedPath`)는 사라졌지만
// `cp.ledger`는 symlink escape에서 여전히 None을 내므로 두 경로 다 기본값으로 떨어져야 한다.
test('cp.ledger가 None을 내도 verify 원장 경로는 None이 아니라 기본 경로다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-fallback-'));
  try {
    mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(join(dir, 'outside.jsonl'), '');
    for (const name of ['verify-skipped.jsonl', 'verify-deleted.jsonl']) {
      symlinkSync(join(dir, 'outside.jsonl'), join(dir, '.auto-context', 'compile', name));
    }
    const out = execFileSync('python3', ['-c', `import sys, pathlib, json
sys.path.insert(0, ${JSON.stringify(process.cwd() + '/core')})
import compile_paths as cp
import wiki_verify_worker as v
root = pathlib.Path(${JSON.stringify(dir)}).resolve()
print(json.dumps({
  'ledgerRefused': cp.ledger(root, cp.VERIFY_SKIPPED) is None and cp.ledger(root, cp.VERIFY_DELETED) is None,
  'skipped': str(v.verify_skipped_path(root, {})),
  'deleted': str(v.verify_deleted_path(root, {})),
  'root': str(root),
}))
`], { cwd: process.cwd(), encoding: 'utf8' });
    const r = JSON.parse(out.trim());
    assert.equal(r.ledgerRefused, true, 'the escape is what forces the fallback');
    assert.equal(r.skipped, `${r.root}/.auto-context/compile/verify-skipped.jsonl`);
    assert.equal(r.deleted, `${r.root}/.auto-context/compile/verify-deleted.jsonl`);
  } finally {
    removeTemp(dir);
  }
});

// MAJOR 1 층 2: 순서가 아니라 **필드**가 보장이어야 한다. 모델 항목이 MAX_SOURCES를 채워도
// `authoritativeSources`는 잘리지 않는다.
test('load_sources는 MAX_SOURCES와 무관하게 authoritativeSources를 읽는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-loadsrc-'));
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    for (const name of ['real.md', 'd1.md', 'd2.md', 'd3.md']) {
      writeFileSync(join(dir, 'docs', name), `# ${name}\n`);
    }
    const job = {
      authoritativeSources: [{ kind: 'file', path: 'docs/real.md', collection: 'c' }],
      // 모델 목록에는 실제 소스가 **없다**(또는 뒤에 있다) — 예전 코드는 d1..d3만 읽었다.
      sources: [
        { kind: 'file', path: 'docs/d1.md' },
        { kind: 'file', path: 'docs/d2.md' },
        { kind: 'file', path: 'docs/d3.md' },
        { kind: 'file', path: 'docs/real.md' },
      ],
    };
    const out = execFileSync('python3', ['-c', `import sys, json, pathlib
sys.path.insert(0, ${JSON.stringify(process.cwd() + '/core')})
import wiki_verify_worker as v
job = json.loads(sys.stdin.read())
loaded = v.load_sources(pathlib.Path(${JSON.stringify(dir)}).resolve(), job, 12000)
print(json.dumps([s['path'] for s in loaded]))
`], { cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(job) });
    const paths = JSON.parse(out.trim());
    assert.equal(paths[0], 'docs/real.md', '권위 소스가 먼저');
    assert.equal(paths.filter((p) => p === 'docs/real.md').length, 1, '같은 경로는 한 번만 읽는다');
    // 총 읽기 수는 여전히 MAX_SOURCES로 유계다(권위 항목이 예산을 함께 쓴다) — 권위
    // 항목이 상한보다 많을 때만 초과하고, 실제로는 잡당 1건이다.
    assert.deepEqual(paths, ['docs/real.md', 'docs/d1.md', 'docs/d2.md'],
      '권위 소스가 예산을 먼저 차지하고 모델 항목이 남은 칸을 채운다');
  } finally {
    removeTemp(dir);
  }
});

function migrationCard(frontmatter, body = 'Durable migrated card body.') {
  return [
    '---', frontmatter, '---', '',
    '<!-- qmd:auto:start id="main" sourceHash="legacy" -->',
    '## Summary', body, '<!-- qmd:auto:end -->', '',
  ].join('\n');
}

function validRevision(rel = 'docs/a.md') {
  return [
    'sourceRevisions:',
    `  - {kind: "file", path: "${rel}", collection: "proj-docs", sha256: "${'a'.repeat(64)}", size: 1, mtimeNs: 1}`,
  ].join('\n');
}

function runReviewedMigration(dir) {
  const out = execFileSync('python3', ['-c', `import dataclasses, json, pathlib, sys
sys.path.insert(0, 'core')
from wiki_reviewed_migrate import migrate_reviewed_state
report = migrate_reviewed_state(pathlib.Path(${JSON.stringify(dir)}))
print(json.dumps(dataclasses.asdict(report), sort_keys=True))
`], { cwd: process.cwd(), encoding: 'utf8' });
  return JSON.parse(out.trim());
}

test('offline reviewed migration normalizes only qmd cards and is idempotent', () => {
  const dir = setupProject();
  const wiki = join(dir, '.auto-context', 'wiki', 'entities');
  const audit = join(dir, '.auto-context', 'compile', 'reviewed-state-migration.jsonl');
  const cards = {
    'legacy-reviewed.md': migrationCard([
      'title: "Legacy reviewed"', 'status: reviewed', 'createdBy: qmd-auto-context',
      'reviewed: true', 'verifiedBy: human', 'verifiedAt: 2026-01-01T00:00:00Z', 'verifiedMode: self',
      validRevision(),
    ].join('\n')),
    'legacy-canon.md': migrationCard([
      'title: "Legacy canon"', 'status: canon', 'createdBy: qmd-auto-context', 'reviewed: false',
      'verifiedBy: claude', 'verifiedAt: 2026-01-01T00:00:00Z', 'verifiedMode: cross-engine', validRevision('docs/b.md'),
    ].join('\n')),
    'legacy-manual.md': migrationCard([
      'title: "Legacy manual"', 'status: manual', 'createdBy: qmd-auto-context', 'reviewed: true', validRevision('docs/c.md'),
    ].join('\n')),
    'provenance-free-verified.md': migrationCard([
      'title: "No provenance"', 'status: verified', 'createdBy: qmd-auto-context', 'reviewed: true',
      'verifiedBy: claude', 'verifiedAt: 2026-01-01T00:00:00Z', 'verifiedMode: self',
    ].join('\n')),
    'valid-verified.md': migrationCard([
      'title: "Valid verified"', 'status: verified', 'createdBy: qmd-auto-context', 'reviewed: false',
      'verifiedBy: claude', 'verifiedAt: 2026-01-01T00:00:00Z', 'verifiedMode: cross-engine', validRevision('docs/d.md'),
    ].join('\n')),
    'superseded.md': migrationCard([
      'title: "Historical"', 'status: superseded', 'createdBy: qmd-auto-context', 'reviewed: true',
    ].join('\n')),
    'foreign.md': migrationCard([
      'title: "Foreign"', 'status: canon', 'createdBy: another-tool', 'reviewed: true',
      'verifiedBy: foreign', 'verifiedAt: 2026-01-01T00:00:00Z', 'verifiedMode: self',
    ].join('\n'), 'Foreign body and source values stay byte-for-byte.'),
    'creator-missing.md': migrationCard([
      'title: "Creator missing"', 'status: reviewed', 'reviewed: true',
    ].join('\n')),
  };
  try {
    for (const [name, text] of Object.entries(cards)) writeFileSync(join(wiki, name), text);
    runReviewedMigration(dir);

    for (const name of ['legacy-reviewed.md', 'legacy-canon.md', 'legacy-manual.md', 'provenance-free-verified.md']) {
      const text = readFileSync(join(wiki, name), 'utf8');
      assert.match(text, /^status: generated$/m, name);
      assert.doesNotMatch(text, /^reviewed:/m, name);
      for (const field of ['verifiedBy', 'verifiedAt', 'verifiedMode']) {
        assert.doesNotMatch(text, new RegExp(`^${field}:`, 'm'), `${name}: ${field}`);
      }
    }
    const valid = readFileSync(join(wiki, 'valid-verified.md'), 'utf8');
    assert.match(valid, /^status: verified$/m);
    assert.match(valid, /^verifiedMode: cross-engine$/m);
    assert.doesNotMatch(valid, /^reviewed:/m);
    assert.match(readFileSync(join(wiki, 'superseded.md'), 'utf8'), /^status: superseded$/m,
      'superseded remains a historical excluded state');
    assert.equal(readFileSync(join(wiki, 'foreign.md'), 'utf8'), cards['foreign.md']);
    assert.equal(readFileSync(join(wiki, 'creator-missing.md'), 'utf8'), cards['creator-missing.md']);
    assert.equal(existsSync(join(dir, '.auto-context', 'compile', 'verify-queue.jsonl')), false,
      'migration never fabricates verification work');

    const rows = readFileSync(audit, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.action === 'foreign_card_retained'));
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['action', 'path'], 'audit is metadata-only');
      assert.match(row.path, /^\.auto-context\/wiki\//);
    }

    const beforeCards = Object.fromEntries(Object.keys(cards).map((name) => {
      const path = join(wiki, name);
      return [name, { text: readFileSync(path, 'utf8'), mtimeNs: statSync(path, { bigint: true }).mtimeNs }];
    }));
    const beforeAudit = { text: readFileSync(audit, 'utf8'), mtimeNs: statSync(audit, { bigint: true }).mtimeNs };
    runReviewedMigration(dir);
    for (const name of Object.keys(cards)) {
      const path = join(wiki, name);
      assert.equal(readFileSync(path, 'utf8'), beforeCards[name].text, `${name}: second run content`);
      assert.equal(statSync(path, { bigint: true }).mtimeNs, beforeCards[name].mtimeNs, `${name}: second run no write`);
    }
    assert.equal(readFileSync(audit, 'utf8'), beforeAudit.text, 'second run does not append audit');
    assert.equal(statSync(audit, { bigint: true }).mtimeNs, beforeAudit.mtimeNs, 'second run does not rewrite audit');
  } finally {
    removeTemp(dir);
  }
});

function childExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)));
  });
}

async function waitForFile(path, timeoutMs = 3000) {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('migration waits for CARD_WRITE_LOCK and sees the completed worker revision', async () => {
  const dir = setupProject();
  const target = join(dir, EXISTING_REL);
  const ready = join(dir, 'holder-ready');
  const release = join(dir, 'holder-release');
  const completed = migrationCard([
    'title: "Completed worker revision"', 'status: verified', 'createdBy: qmd-auto-context',
    'verifiedBy: claude', 'verifiedAt: 2026-08-07T00:00:00Z', 'verifiedMode: cross-engine', validRevision(),
  ].join('\n'), 'The complete new auto block must not be mixed with the legacy revision.');
  writeFileSync(target, migrationCard([
    'title: "Legacy"', 'status: reviewed', 'createdBy: qmd-auto-context', 'reviewed: true',
    'verifiedBy: human', 'verifiedAt: 2026-01-01T00:00:00Z', 'verifiedMode: self',
  ].join('\n')));

  const holderCode = `import fcntl, os, pathlib, time
root = pathlib.Path(${JSON.stringify(dir)})
lock_path = root / '.auto-context/compile/.card-write.lock'
with lock_path.open('a+') as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    pathlib.Path(${JSON.stringify(ready)}).write_text('ready')
    while not pathlib.Path(${JSON.stringify(release)}).exists():
        time.sleep(0.02)
    target = pathlib.Path(${JSON.stringify(target)})
    tmp = target.with_name('.holder-complete.tmp')
    tmp.write_text(${JSON.stringify(completed)})
    os.replace(tmp, target)
`;
  const migrationCode = `import dataclasses, json, pathlib, sys
sys.path.insert(0, 'core')
from wiki_reviewed_migrate import migrate_reviewed_state
print(json.dumps(dataclasses.asdict(migrate_reviewed_state(pathlib.Path(${JSON.stringify(dir)})))))
`;
  const holder = spawn('python3', ['-c', holderCode], { cwd: process.cwd() });
  const holderDone = childExit(holder);
  let migration;
  try {
    await waitForFile(ready);
    migration = spawn('python3', ['-c', migrationCode], { cwd: process.cwd() });
    let exited = false;
    const migrationDone = childExit(migration).finally(() => { exited = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(exited, false, 'migration blocks behind the project card writer');
    writeFileSync(release, 'release');
    await holderDone;
    await migrationDone;
    assert.equal(readFileSync(target, 'utf8'), completed,
      'migration observes one completed revision and preserves its proof fields and auto block');
  } finally {
    if (!existsSync(release)) writeFileSync(release, 'release');
    await holderDone.catch(() => {});
    if (migration && migration.exitCode === null) migration.kill();
    removeTemp(dir);
  }
});

test('compiler and verifier sources contain no reviewed-state decision branches', () => {
  for (const file of ['core/wiki_compile.py', 'core/wiki_verify_worker.py']) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /meta\.get\(["']reviewed["']\)/, file);
  }
});
