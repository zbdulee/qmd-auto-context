// Per-run throughput guards for bulk compile (bulk-wiki-backfill-spec 2.2 / 2.3).
//
// 2.2: the compile worker had NO per-run cap — batch.maxItems is a start condition, so a
//      queue of N drove N consecutive host CLI spawns in one worker process.
// 2.3: verify was fixed at 3 per run, so a bulk backfill left most cards `generated`,
//      which `compile.recallVerifiedOnly: true` hides from recall entirely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One mock host CLI adapter serving both tasks: the verifier reuses the extractor pool,
// dispatching on payload.task (see extractors/lib.py).
function mockAdapter(dir, logPath) {
  const script = join(dir, 'adapter.py');
  writeFileSync(script, `#!/usr/bin/env python3
import json, pathlib, sys
payload = json.loads(sys.stdin.read())
log = pathlib.Path(${JSON.stringify(logPath)})
if payload.get('task') == 'verify':
    with log.open('a') as handle:
        handle.write('verify\\t' + payload['card']['path'] + '\\n')
    print(json.dumps({'verdict': 'pass', 'claims': [], 'reasons': []}))
    raise SystemExit(0)
rel = payload['source']['path']
stem = pathlib.Path(rel).stem
with log.open('a') as handle:
    handle.write('extract\\t' + rel + '\\n')
print(json.dumps({'candidates': [{
    'title': 'Card ' + stem,
    'summary': 'Durable decision: the card for ' + rel + ' cites its source markdown.',
    'suggestedType': 'decision',
    'confidence': 'high',
    'targetPath': '.auto-context/wiki/decisions/card-' + stem + '.md',
}]}))
`);
  return script;
}

function setupProject({ sources, compile: compileOverrides = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-throughput-'));
  const logPath = join(dir, 'adapter-calls.log');
  mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'wiki'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const adapter = mockAdapter(dir, logPath);
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-docs', 'proj-wiki'],
    collectionPaths: { 'proj-docs': 'docs', 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-docs': 'raw', 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: {
      enabled: true,
      mode: 'auto-wiki',
      autoWrite: true,
      defaultStatus: 'generated',
      triggers: ['post_tool_source', 'backfill_source', 'manual'],
      maxSourceChars: 12000,
      extractor: { argv: ['python3', adapter], timeout: 60 },
      // keep the run deterministic and daemon-free
      semanticDedup: { enabled: false },
      verify: { enabled: true, timeout: 60 },
      ...compileOverrides,
    },
  }));
  const queue = [];
  for (const rel of sources) {
    writeFileSync(join(dir, rel), `# ${rel}\n\nDurable decision: ${rel} records a real decision.\n`);
    queue.push(JSON.stringify({
      ts: '2026-07-30T00:00:00Z',
      trigger: 'backfill_source',
      engine: 'claude',
      cwd: dir,
      source: { kind: 'file', path: rel, collection: 'proj-docs' },
    }));
  }
  writeFileSync(join(dir, '.auto-context', 'compile', 'source-queue.jsonl'), queue.join('\n') + '\n');
  return { dir, logPath };
}

function runWorker(project, env = {}) {
  const out = execFileSync('python3', ['core/wiki_compile_worker.py', '--cwd', project, '--json', '--flush-all'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...env },
  });
  return JSON.parse(out.trim());
}

function calls(logPath, kind) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([task]) => task === kind)
    .map(([, target]) => target);
}

function queueLines(project) {
  const path = join(project, '.auto-context', 'compile', 'source-queue.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
}

test('compile worker per-run cap bounds host CLI spawns and defers the rest without loss', () => {
  const sources = ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md', 'docs/f.md', 'docs/g.md'];
  const { dir, logPath } = setupProject({ sources, compile: { batch: { idleSeconds: 0, maxItems: 1, maxPerRun: 3 } } });
  const dirtyQueue = join(mkdtempSync(join(tmpdir(), 'dirty-cap-')), 'queue');
  try {
    const first = runWorker(dir, { QMD_DIRTY_QUEUE: dirtyQueue });
    assert.equal(first.processed, 3, 'exactly maxPerRun jobs run');
    assert.equal(first.deferred, 4);
    assert.equal(first.remaining, 4);
    assert.equal(calls(logPath, 'extract').length, 3, 'cap bounds extractor spawns, not just bookkeeping');
    assert.equal(queueLines(dir).length, 4, 'overflow is requeued, never dropped');

    // Draining across runs must cover every source exactly once.
    const second = runWorker(dir, { QMD_DIRTY_QUEUE: dirtyQueue });
    const third = runWorker(dir, { QMD_DIRTY_QUEUE: dirtyQueue });
    assert.equal(second.processed, 3);
    assert.equal(third.processed, 1);
    assert.equal(queueLines(dir).length, 0);
    assert.deepEqual(calls(logPath, 'extract').sort(), [...sources].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify budget rises to the cards the same run produced (no generated backlog)', () => {
  const sources = ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md'];
  const { dir, logPath } = setupProject({
    sources,
    compile: {
      batch: { idleSeconds: 0, maxItems: 1, maxPerRun: 5 },
      // standing backlog budget stays at the shipped default
      verify: { enabled: true, timeout: 60, maxPerRun: 3 },
    },
  });
  const dirtyQueue = join(mkdtempSync(join(tmpdir(), 'dirty-vb-')), 'queue');
  try {
    const out = runWorker(dir, { QMD_DIRTY_QUEUE: dirtyQueue });
    assert.equal(out.processed, 5);
    assert.equal(out.verifyQueued, 5);
    // Before this change the piggybacked pass verified 3 and left 2 cards `generated`,
    // i.e. invisible to recall under recallVerifiedOnly.
    assert.equal(calls(logPath, 'verify').length, 5);
    assert.equal(readFileSync(join(dir, '.auto-context', 'compile', 'verify-queue.jsonl'), 'utf8'), '');
    for (const rel of sources) {
      const card = join(dir, '.auto-context', 'wiki', 'decisions', `card-${rel.split('/')[1].replace('.md', '')}.md`);
      assert.match(readFileSync(card, 'utf8'), /^status: verified$/m, rel);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify keeps its standing per-run cap when nothing was produced this run', () => {
  // The production floor must be a floor, not a replacement: a standalone drain of an
  // existing backlog still honours verify.maxPerRun.
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-verify-cap-'));
  const logPath = join(dir, 'adapter-calls.log');
  mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'wiki', 'decisions'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const adapter = mockAdapter(dir, logPath);
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-docs', 'proj-wiki'],
    collectionPaths: { 'proj-docs': 'docs', 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-docs': 'raw', 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: {
      enabled: true, mode: 'auto-wiki', autoWrite: true, defaultStatus: 'generated',
      triggers: ['post_tool_source'], maxSourceChars: 12000,
      extractor: { argv: ['python3', adapter], timeout: 60 },
      verify: { enabled: true, timeout: 60, maxPerRun: 3 },
    },
  }));
  const jobs = [];
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    writeFileSync(join(dir, 'docs', `${name}.md`), `# ${name}\n\nDurable claim: card ${name} cites markdown.\n`);
    const rel = `.auto-context/wiki/decisions/card-${name}.md`;
    writeFileSync(join(dir, rel), [
      '---', `title: "Card ${name}"`, 'status: generated', 'createdBy: qmd-auto-context',
      'reviewed: false', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="h1" -->', '## Summary',
      `Durable claim: card ${name} cites markdown.`, '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    jobs.push(JSON.stringify({
      ts: '2026-07-30T00:00:00Z', targetPath: rel,
      sources: [{ kind: 'file', path: `docs/${name}.md`, collection: 'proj-docs' }],
      sourceHash: 'h1', engine: 'claude', trigger: 'post_tool_source',
    }));
  }
  writeFileSync(join(dir, '.auto-context', 'compile', 'verify-queue.jsonl'), jobs.join('\n') + '\n');
  try {
    const out = JSON.parse(execFileSync('python3', ['core/wiki_verify_worker.py', '--cwd', dir, '--json'], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, QMD_DIRTY_QUEUE: join(dir, 'dirty-queue') },
    }).trim());
    assert.equal(out.processed, 3);
    assert.equal(out.remaining, 2);
    assert.equal(calls(logPath, 'verify').length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
