// Guards on writes that a MODEL chose the destination for, plus the swallowed-return
// class that made a failed write look like a success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      enabled: true, mode: 'auto-wiki', autoWrite: true, defaultStatus: 'generated',
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
      enabled: true, mode: 'auto-wiki', autoWrite: true, defaultStatus: 'generated',
      triggers: ['post_tool_source'], maxSourceChars: 12000,
      extractor: { argv: ['python3', verifier], timeout: 60 },
      verify: { enabled: true, timeout: 60, maxPerRun: 3 },
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
    rmSync(dir, { recursive: true, force: true });
  }
});

// The deletion audit ledger is fail-closed: no card is removed without its audit row. That
// is right, but the failure had NO ENDPOINT — a verdict was paid for, the ledger write
// failed, the job was preserved, and the next run paid again. Measured: 3 runs, 3 paid
// verify calls, card still `generated` (invisible under recallVerifiedOnly), no cooldown and
// no suppression marker, and the only trace was in a log that gets trimmed.
function stampProject({ deletedPath, onFail = 'delete' } = {}) {
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
print(json.dumps({'verdict': 'fail', 'claims': [], 'reasons': ['source contradicts card']}))
`);
  writeFileSync(join(dir, 'docs', 'source.md'), '# s\n\nDurable claim: the source says something else.\n');
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-docs', 'proj-wiki'],
    collectionPaths: { 'proj-docs': 'docs', 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-docs': 'raw', 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: {
      enabled: true, mode: 'auto-wiki', autoWrite: true, defaultStatus: 'generated',
      triggers: ['post_tool_source'], maxSourceChars: 12000,
      extractor: { argv: ['python3', verifier], timeout: 60 },
      verify: { enabled: true, timeout: 60, maxPerRun: 3, onFail, ...(deletedPath ? { deletedPath } : {}) },
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

test('a deletedPath outside the compile dir falls back to the default, like its siblings', () => {
  // candidate_path and log_path both fall back; only this one returned None, and that None
  // was the entrance to the billing loop. `.auto-context/verify-deleted.jsonl` (one segment
  // short) is a natural typo that passes config validation.
  const { dir, cardRel, callLog } = stampProject({ deletedPath: '.auto-context/verify-deleted.jsonl' });
  try {
    const out = runVerify(dir);
    assert.equal(out.processed, 1, 'the verdict is applied, not blocked');
    assert.equal(existsSync(join(dir, cardRel)), false, 'fail verdict deletes the card');
    const ledger = join(dir, '.auto-context', 'compile', 'verify-deleted.jsonl');
    assert.equal(jsonl(ledger).length, 1, 'the row lands in the default location');
    assert.equal(jsonl(ledger)[0].verdict, 'fail');
    assert.equal(paidCalls(callLog), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(ledger, { recursive: true, force: true });
    const after = runVerify(dir);
    assert.equal(after.processed, 1);
    assert.equal(paidCalls(callLog), 1);
    assert.equal(existsSync(join(dir, cardRel)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
  }
});
