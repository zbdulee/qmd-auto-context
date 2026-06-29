import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupProject(extraCompile = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-worker-'));
  mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'wiki'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'source.md'), '# Source\n\nDurable decision: generated wiki pages cite source markdown.\n');
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-docs', 'proj-wiki'],
    collectionPaths: {
      'proj-docs': 'docs',
      'proj-wiki': '.auto-context/wiki',
    },
    collectionRoles: {
      'proj-docs': 'raw',
      'proj-wiki': 'wiki',
    },
    wikiPath: '.auto-context/wiki',
    compile: {
      enabled: true,
      mode: 'guarded',
      autoWrite: true,
      defaultStatus: 'generated',
      triggers: ['post_tool_source', 'manual'],
      sourceQueuePath: '.auto-context/compile/source-queue.jsonl',
      candidatePath: '.auto-context/compile/candidates.jsonl',
      manifestPath: '.auto-context/compile/generated-manifest.jsonl',
      tombstonePath: '.auto-context/compile/tombstones.jsonl',
      maxSourceChars: 12000,
      extractor: { argv: [], timeout: 30 },
      ...extraCompile,
    },
  }));
  writeFileSync(join(dir, '.auto-context', 'compile', 'source-queue.jsonl'), JSON.stringify({
    ts: '2026-06-26T00:00:00Z',
    trigger: 'post_tool_source',
    engine: 'claude',
    cwd: dir,
    source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' },
  }) + '\n');
  return dir;
}

function runWorker(project, env = {}) {
  return execFileSync('python3', ['core/wiki_compile_worker.py', '--cwd', project], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function jsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('worker uses extractor argv, writes generated wiki page, and stays silent', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'extract.py');
  writeFileSync(extractor, `#!/usr/bin/env python3
import json, sys
payload = json.loads(sys.stdin.read())
assert 'content' in payload['source']
print(json.dumps({'candidates': [{
  'title': 'Source Compile Decision',
  'summary': 'Generated wiki pages cite source markdown instead of copying raw source.',
  'suggestedType': 'decision',
  'confidence': 'high',
  'targetPath': '.auto-context/wiki/decisions/source-compile-decision.md'
}]}))
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  const dirtyQueue = join(mkdtempSync(join(tmpdir(), 'dirty-')), 'queue');
  try {
    const out = runWorker(project, { QMD_DIRTY_QUEUE: dirtyQueue, QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    assert.equal(out, '');
    const page = join(project, '.auto-context', 'wiki', 'decisions', 'source-compile-decision.md');
    assert.equal(existsSync(page), true);
    const text = readFileSync(page, 'utf8');
    assert.match(text, /Source Compile Decision/);
    assert.match(text, /path: "docs\/source.md"/);
    assert.equal(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
    assert.match(readFileSync(dirtyQueue, 'utf8'), /^proj-wiki\t/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});


test('compile mode off prevents worker extractor and candidate writes', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-mode-off-')), 'extract.py');
  const marker = join(mkdtempSync(join(tmpdir(), 'extractor-mode-off-marker-')), 'ran');
  writeFileSync(extractor, `#!/usr/bin/env python3
open(${JSON.stringify(marker)}, 'w').write('ran')
print('{"candidates": []}')
`);
  const project = setupProject({ mode: 'off', extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(project, '.auto-context', 'compile', 'candidates.jsonl')), false);
    assert.match(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), /docs\/source.md/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('missing extractor writes bounded needs_extractor record without source content', () => {
  const project = setupProject();
  try {
    const out = runWorker(project);
    assert.equal(out, '');
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'decisions')), false);
    const candidates = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].action, 'needs_extractor');
    assert.equal(candidates[0].source.path, 'docs/source.md');
    assert.equal(JSON.stringify(candidates[0]).includes('Durable decision'), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('invalid extractor JSON permanently drops source queue job', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-bad-')), 'bad.py');
  writeFileSync(extractor, 'print("not json")\n');
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    // permanent failure: queue drained (not preserved)
    assert.equal(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
    const failures = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(failures[0].action, 'extractor_failed');
    assert.equal(failures[0].reason, 'invalid_extractor_json');
    assert.equal(JSON.stringify(failures[0]).includes('Durable decision'), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});


test('worker drops job and audits when extractor returns invalid JSON (permanent)', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'bad.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nprint("not json")\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 } });
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    const cands = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(cands.some((c) => c.reason === 'invalid_extractor_json'), true);
    // permanent failure: queue drained (not preserved)
    assert.equal(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('configured extractor argv is not executed without explicit local trust gate', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-untrusted-')), 'extract.py');
  const marker = join(mkdtempSync(join(tmpdir(), 'extractor-marker-')), 'ran');
  writeFileSync(extractor, `#!/usr/bin/env python3
open(${JSON.stringify(marker)}, 'w').write('ran')
print('{"candidates": []}')
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    runWorker(project);
    assert.equal(existsSync(marker), false);
    const candidates = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(candidates[0].action, 'needs_extractor');
    assert.equal(candidates[0].reason, 'untrusted_extractor');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('worker appends preserved jobs instead of overwriting concurrently-created queue', () => {
  const project = setupProject();
  try {
    const queue = join(project, '.auto-context', 'compile', 'source-queue.jsonl');
    const newJob = JSON.stringify({ ts: 'later', source: { kind: 'file', path: 'docs/new.md', collection: 'proj-docs' } }) + '\n';
    writeFileSync(queue, newJob);
    const rawLine = JSON.stringify({ ts: 'old', source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } });
    execFileSync('python3', ['-c', `
from pathlib import Path
from core import wiki_compile_worker as w
w.requeue_lines(Path(${JSON.stringify(queue)}), [${JSON.stringify(rawLine)}])
`], { cwd: process.cwd() });
    const content = readFileSync(queue, 'utf8');
    assert.match(content, /docs\/new.md/);
    assert.match(content, /docs\/source.md/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('compile writer rejection preserves source queue job with bounded failure', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-unsafe-target-')), 'extract.py');
  writeFileSync(extractor, `#!/usr/bin/env python3
import json
print(json.dumps({'candidates': [{
  'title': 'Unsafe Target',
  'summary': 'This candidate tries to escape the managed wiki root.',
  'suggestedType': 'decision',
  'confidence': 'high',
  'targetPath': '../outside.md'
}]}))
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    const queue = readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8');
    assert.match(queue, /docs\/source.md/);
    const failures = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(failures.at(-1).action, 'compile_failed');
    assert.equal(JSON.stringify(failures.at(-1)).includes('This candidate tries'), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});




test('worker revalidates queued source path against markdown collection role before extractor', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-revalidate-')), 'extract.py');
  const marker = join(mkdtempSync(join(tmpdir(), 'extractor-revalidate-marker-')), 'ran');
  writeFileSync(extractor, `#!/usr/bin/env python3
import json, sys
payload = json.loads(sys.stdin.read())
open(${JSON.stringify(marker)}, 'w').write(payload['source']['path'])
print(json.dumps({'candidates': []}))
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    writeFileSync(join(project, 'README.md'), '# Outside collection but inside root\n');
    writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), JSON.stringify({
      ts: '2026-06-26T00:00:00Z',
      trigger: 'post_tool_source',
      engine: 'claude',
      cwd: project,
      source: { kind: 'file', path: 'README.md', collection: 'proj-docs' },
    }) + '\n');
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    assert.equal(existsSync(marker), false);
    const failures = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(failures.at(-1).action, 'extractor_failed');
    assert.equal(failures.at(-1).reason, 'invalid_source_scope');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('worker restores claimed queue if processing raises unexpectedly', () => {
  const project = setupProject({ extractor: { argv: ['python3', '-c', 'print(1)'], timeout: 30 } });
  try {
    const queue = join(project, '.auto-context', 'compile', 'source-queue.jsonl');
    const rawLine = readFileSync(queue, 'utf8').trim();
    const script = `
from pathlib import Path
import sys
sys.argv = ['wiki_compile_worker.py', '--cwd', ${JSON.stringify(project)}]
sys.path.insert(0, ${JSON.stringify(process.cwd() + '/core')})
import wiki_compile_worker as w

def boom(*args, **kwargs):
    raise RuntimeError('boom')

w.process_job = boom
try:
    w.main()
except RuntimeError:
    pass
`;
    execFileSync('python3', ['-c', script], { cwd: process.cwd(), env: { ...process.env, QMD_COMPILE_TRUST_EXTRACTOR: '1' } });
    assert.match(readFileSync(queue, 'utf8'), new RegExp(rawLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('source queue enqueue and claim share fcntl lock to avoid rename/open append loss', () => {
  const enqueue = readFileSync('core/wiki_compile_enqueue.py', 'utf8');
  const worker = readFileSync('core/wiki_compile_worker.py', 'utf8');
  assert.match(enqueue, /fcntl\.flock/);
  assert.match(worker, /fcntl\.flock/);
  assert.match(worker, /os\.replace/);
});
