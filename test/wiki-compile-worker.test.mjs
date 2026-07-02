import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
    const out = runWorker(project, { QMD_DIRTY_QUEUE: dirtyQueue });
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

test('worker resolves built-in extractor adapter at runtime from plugin root', () => {
  const fakeCli = join(mkdtempSync(join(tmpdir(), 'fake-claude-cli-')), 'claude');
  writeFileSync(fakeCli, `#!/usr/bin/env python3
import json
print(json.dumps({'candidates': [{
  'title': 'Builtin Adapter Decision',
  'summary': 'Generated through the built-in Claude adapter resolved by the worker.',
  'suggestedType': 'decision',
  'confidence': 'high',
  'targetPath': '.auto-context/wiki/decisions/builtin-adapter-decision.md'
}]}))
`, { mode: 0o755 });
  const project = setupProject({
    extractor: {
      dispatch: 'by-engine',
      backends: {},
      builtins: ['claude'],
      default: [],
      timeout: 30,
    },
  });
  const dirtyQueue = join(mkdtempSync(join(tmpdir(), 'dirty-builtin-')), 'queue');
  try {
    const out = runWorker(project, {
      QMD_DIRTY_QUEUE: dirtyQueue,
      QMD_EXTRACTOR_CLAUDE_BIN: fakeCli,
    });
    assert.equal(out, '');
    const page = join(project, '.auto-context', 'wiki', 'decisions', 'builtin-adapter-decision.md');
    assert.equal(existsSync(page), true);
    const text = readFileSync(page, 'utf8');
    assert.match(text, /Builtin Adapter Decision/);
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
    runWorker(project);
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
    runWorker(project);
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
    runWorker(project);
    const cands = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(cands.some((c) => c.reason === 'invalid_extractor_json'), true);
    // permanent failure: queue drained (not preserved)
    assert.equal(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('configured extractor runs without any trust env (install = consent)', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-noenv-')), 'extract.py');
  const marker = join(mkdtempSync(join(tmpdir(), 'extractor-marker-')), 'ran');
  writeFileSync(extractor, `#!/usr/bin/env python3
open(${JSON.stringify(marker)}, 'w').write('ran')
print('{"candidates": []}')
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    runWorker(project); // NOTE: no QMD_COMPILE_TRUST_EXTRACTOR
    assert.equal(existsSync(marker), true);
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
    runWorker(project);
    const queue = readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8');
    assert.match(queue, /docs\/source.md/);
    const failures = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(failures.at(-1).action, 'compile_failed');
    assert.equal(JSON.stringify(failures.at(-1)).includes('This candidate tries'), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('compile writer merge-needed drains source queue without bounded failure retry', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-merge-needed-')), 'extract.py');
  writeFileSync(extractor, `#!/usr/bin/env python3
import json
print(json.dumps({'candidates': [{
  'title': 'Signal Detection',
  'summary': 'This update should wait for manual merge instead of requeueing forever.',
  'suggestedType': 'concept',
  'confidence': 'high',
  'canonicalKey': 'signal-perception-rule'
}]}))
`);
  const project = setupProject({ mode: 'auto-wiki', extractor: { argv: ['python3', extractor], timeout: 30 } });
  const targetDir = join(project, '.auto-context', 'wiki', 'concepts');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'reviewed-signal.md'), [
    '---',
    'title: "Reviewed Signal Rule"',
    'canonicalKey: "signal-perception-rule"',
    'type: concept',
    'status: reviewed',
    'createdBy: qmd-auto-context',
    'reviewed: true',
    '---',
    '',
    '<!-- qmd:auto:start id="main" sourceHash="aaaaaaaaaaaaaaaa" -->',
    '## Summary',
    'Old reviewed summary.',
    '<!-- qmd:auto:end -->',
    '',
  ].join('\n'));
  try {
    runWorker(project);
    assert.equal(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
    const rows = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(rows.at(-1).action, 'merge-needed');
    assert.equal(rows.some((row) => row.action === 'compile_failed'), false);
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
    runWorker(project);
    assert.equal(existsSync(marker), false);
    const failures = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(failures.at(-1).action, 'extractor_failed');
    assert.equal(failures.at(-1).reason, 'invalid_source_scope');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('worker rejects queued dot-directory markdown source before extractor', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-hidden-source-')), 'extract.py');
  const marker = join(mkdtempSync(join(tmpdir(), 'extractor-hidden-source-marker-')), 'ran');
  writeFileSync(extractor, `#!/usr/bin/env python3
open(${JSON.stringify(marker)}, 'w').write('ran')
print('{"candidates": []}')
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    mkdirSync(join(project, 'docs', '.draft'), { recursive: true });
    writeFileSync(join(project, 'docs', '.draft', 'idea.md'), '# Hidden draft\n');
    writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), JSON.stringify({
      ts: '2026-06-26T00:00:00Z',
      trigger: 'post_tool_source',
      engine: 'claude',
      cwd: project,
      source: { kind: 'file', path: 'docs/.draft/idea.md', collection: 'proj-docs' },
    }) + '\n');
    runWorker(project);
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
    execFileSync('python3', ['-c', script], { cwd: process.cwd(), encoding: 'utf8' });
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

test('resolver keeps extractor.argv ahead of explicit and built-in backends', () => {
  const code = `
import json, sys
sys.path.insert(0, 'core')
import wiki_compile_worker as w
cfg = {'extractor': {'argv': ['python3', 'legacy.py'], 'dispatch': 'by-engine', 'backends': {'codex': ['python3', 'custom.py']}, 'builtins': ['codex'], 'default': ['python3', 'fallback.py']}}
print(json.dumps(w.resolve_extractor_argv(cfg, 'codex')))
`;
  const [primary, fallback] = JSON.parse(execFileSync('python3', ['-c', code], { cwd: process.cwd(), encoding: 'utf8' }));
  assert.deepEqual(primary, ['python3', 'legacy.py']);
  assert.equal(fallback, null);
});

test('resolver keeps explicit engine backend ahead of built-in backend', () => {
  const code = `
import json, sys
sys.path.insert(0, 'core')
import wiki_compile_worker as w
cfg = {'extractor': {'dispatch': 'by-engine', 'backends': {'codex': ['python3', 'custom.py']}, 'builtins': ['codex'], 'default': ['python3', 'fallback.py']}}
print(json.dumps(w.resolve_extractor_argv(cfg, 'codex')))
`;
  const [primary, fallback] = JSON.parse(execFileSync('python3', ['-c', code], { cwd: process.cwd(), encoding: 'utf8' }));
  assert.deepEqual(primary, ['python3', 'custom.py']);
  assert.deepEqual(fallback, ['python3', 'fallback.py']);
});

test('resolver maps built-in engine to adapter path from worker location without plugin env', () => {
  const code = `
import json, os, sys
os.environ.pop('CLAUDE_PLUGIN_ROOT', None)
os.environ.pop('PLUGIN_ROOT', None)
sys.path.insert(0, 'core')
import wiki_compile_worker as w
cfg = {'extractor': {'dispatch': 'by-engine', 'backends': {}, 'builtins': ['codex'], 'default': []}}
print(json.dumps({'primary': w.resolve_extractor_argv(cfg, 'codex')[0], 'executable': sys.executable}))
`;
  const out = JSON.parse(execFileSync('python3', ['-c', code], { cwd: process.cwd(), encoding: 'utf8' }));
  assert.deepEqual(out.primary, [out.executable, join(process.cwd(), 'core', 'extractors', 'codex_adapter.py')]);
});

test('dispatch picks the adapter for payload.engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const marker = join(dir, 'which.txt');
  const codexAd = join(dir, 'codex.py');
  writeFileSync(codexAd, `#!/usr/bin/env python3\nimport json,sys\nopen(${JSON.stringify(marker)},'w').write('codex')\nprint(json.dumps({'candidates':[{'title':'T','summary':'Durable: dispatch chose codex adapter for this edit.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/t.md'}]}))\n`);
  const project = setupProject({ extractor: { dispatch: 'by-engine', backends: { codex: ['python3', codexAd] }, default: [], timeout: 30 } });
  // queue row uses engine 'claude' by default in setupProject; rewrite to codex
  writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
    JSON.stringify({ ts: '2026-06-26T00:00:00Z', trigger: 'post_tool_source', engine: 'codex', cwd: project, source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } }) + '\n');
  try {
    runWorker(project);
    assert.equal(readFileSync(marker, 'utf8'), 'codex');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('non-executable primary (PermissionError) does NOT trigger fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  // primary exists but is not executable -> subprocess raises PermissionError, NOT FileNotFoundError
  const nonExec = join(dir, 'primary-noexec');
  writeFileSync(nonExec, '#!/usr/bin/env bash\necho noop\n', { mode: 0o644 });
  const fallback = join(dir, 'fallback.py');
  writeFileSync(fallback, `#!/usr/bin/env python3\nimport json\nprint(json.dumps({'candidates':[{'title':'FB','summary':'Durable: fallback must NOT run on a runtime failure.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/fb.md'}]}))\n`);
  const project = setupProject({ extractor: { dispatch: 'by-engine', backends: { claude: [nonExec] }, default: ['python3', fallback], timeout: 30 } });
  try {
    runWorker(project);
    // fallback must NOT have run (no double LLM call on a non-127 runtime failure)
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'concepts', 'fb.md')), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('dispatch falls back to default only when primary CLI is absent (exit 127)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const absent = join(dir, 'absent.py');
  writeFileSync(absent, `#!/usr/bin/env python3\nimport sys\nsys.exit(127)\n`);
  const fallback = join(dir, 'fallback.py');
  writeFileSync(fallback, `#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({'candidates':[{'title':'FB','summary':'Durable: default backend handled the edit after primary was absent.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/fb.md'}]}))\n`);
  const project = setupProject({ extractor: { dispatch: 'by-engine', backends: { claude: ['python3', absent] }, default: ['python3', fallback], timeout: 30 } });
  try {
    runWorker(project);
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'concepts', 'fb.md')), true);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('transient extractor failure sets cooldown and preserves the job', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'fail.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport sys\nsys.stderr.write('rate limited')\nsys.exit(1)\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30, cooldownSeconds: 600 } });
  try {
    runWorker(project);
    assert.equal(existsSync(join(project, '.auto-context', 'compile', 'cooldown')), true);
    assert.notEqual(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('active cooldown skips extraction entirely', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'should-not-run.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport sys\nopen('${join(tmpdir(), 'ran-marker-DUMMY')}','w')\nsys.exit(0)\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 } });
  // pre-write a cooldown far in the future
  writeFileSync(join(project, '.auto-context', 'compile', 'cooldown'), String(Date.now() / 1000 + 9999));
  try {
    runWorker(project);
    const cands = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(cands.some((c) => c.reason === 'cooldown_active'), true);
    assert.notEqual(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('debounce: recent single edit under idle window is not processed yet', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'ok.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({'candidates':[{'title':'X','summary':'Durable: should not run while batch is still settling.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/x.md'}]}))\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 }, batch: { idleSeconds: 9999, maxItems: 5 } });
  // overwrite queue row with a fresh ts (now)
  writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
    JSON.stringify({ ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), trigger: 'post_tool_source', engine: 'claude', cwd: project, source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } }) + '\n');
  try {
    runWorker(project);
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'concepts', 'x.md')), false);
    // job is re-queued, not lost
    assert.notEqual(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('--flush-all processes even under idle window', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'ok.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({'candidates':[{'title':'F','summary':'Durable: flush-all forced extraction past the idle gate.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/f.md'}]}))\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 }, batch: { idleSeconds: 9999, maxItems: 99 } });
  writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
    JSON.stringify({ ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), trigger: 'post_tool_source', engine: 'claude', cwd: project, source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } }) + '\n');
  try {
    execFileSync('python3', ['core/wiki_compile_worker.py', '--cwd', project, '--flush-all'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'concepts', 'f.md')), true);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('dedup: repeated edits of same path collapse to one extraction', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'count.py');
  const counter = join(mkdtempSync(join(tmpdir(), 'count-')), 'n');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport json,sys,os\np=${JSON.stringify(counter)}\nn=int(open(p).read()) if os.path.exists(p) else 0\nopen(p,'w').write(str(n+1))\nprint(json.dumps({'candidates':[{'title':'X','summary':'Durable: deduped repeated edits into a single extraction.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/x.md'}]}))\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 }, batch: { idleSeconds: 0, maxItems: 1 } });
  const row = (ts) => JSON.stringify({ ts, trigger: 'post_tool_source', engine: 'claude', cwd: project, source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } });
  writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
    row('2026-06-26T00:00:00Z') + '\n' + row('2026-06-26T00:00:01Z') + '\n' + row('2026-06-26T00:00:02Z') + '\n');
  try {
    runWorker(project);
    assert.equal(readFileSync(counter, 'utf8'), '1');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

function writeFixture(dir, results) {
  const fixture = join(dir, 'daemon-fixture.json');
  writeFileSync(fixture, JSON.stringify({ results }));
  return fixture;
}

function callGatherSimilarPages(project, contentPath, env = {}) {
  const script = `
import sys
sys.path.insert(0, 'core')
import json
from pathlib import Path
import config as qmd_config
import wiki_compile_worker as w
found = qmd_config.find_project_config(${JSON.stringify(project)})
root = Path(found['projectRoot']).resolve()
cfg = found['config']
wiki_root = (root / cfg.get('wikiPath', '.auto-context/wiki')).resolve()
compile_cfg = cfg.get('compile', {})
content = Path(${JSON.stringify(contentPath)}).read_text(encoding='utf-8')
semantic = compile_cfg.get('semanticDedup', {})
result = w.gather_similar_pages(root, wiki_root, cfg, compile_cfg, content, semantic.get('topK', 3), semantic.get('similarPageMaxChars', 12000))
print(json.dumps(result, ensure_ascii=False))
`;
  return execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function callGatherSimilarPagesAsync(project, contentPath, env = {}) {
  // execFileSync would block this process's event loop, starving the in-process
  // mock HTTP server used by the rerank regression test below -- use async
  // spawn instead so the server can actually respond.
  const script = `
import sys
sys.path.insert(0, 'core')
import json
from pathlib import Path
import config as qmd_config
import wiki_compile_worker as w
found = qmd_config.find_project_config(${JSON.stringify(project)})
root = Path(found['projectRoot']).resolve()
cfg = found['config']
wiki_root = (root / cfg.get('wikiPath', '.auto-context/wiki')).resolve()
compile_cfg = cfg.get('compile', {})
content = Path(${JSON.stringify(contentPath)}).read_text(encoding='utf-8')
semantic = compile_cfg.get('semanticDedup', {})
result = w.gather_similar_pages(root, wiki_root, cfg, compile_cfg, content, semantic.get('topK', 3), semantic.get('similarPageMaxChars', 12000))
print(json.dumps(result, ensure_ascii=False))
`;
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`gather_similar_pages exited ${code}: ${stderr}`));
    });
  });
}

test('gather_similar_pages: queries the daemon with rerank=true (async background worker, not the hot per-edit path)', async () => {
  const project = setupProject();
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/query') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const sourcePath = join(project, 'docs', 'source.md');

    await callGatherSimilarPagesAsync(project, sourcePath, { QMD_DAEMON_URL: `http://127.0.0.1:${port}` });

    assert.equal(requests.length, 1, 'expected exactly one /query call from gather_similar_pages');
    assert.equal(requests[0].rerank, true, 'background worker lookup must opt into rerank=true');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: above-threshold match is included with full page content', () => {
  const project = setupProject();
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'known.md'), [
      '---', 'title: "Known"', 'canonicalKey: "known"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'The known fact.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = writeFixture(project, [
      { file: 'proj-wiki/entities/known.md', score: 0.9 },
    ]);

    const out = JSON.parse(callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture }));
    assert.equal(out.length, 1);
    assert.equal(out[0].path, '.auto-context/wiki/entities/known.md');
    assert.equal(out[0].score, 0.9);
    assert.match(out[0].content, /The known fact\./);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: below-threshold match is dropped, returns null', () => {
  const project = setupProject();
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'weak.md'), [
      '---', 'title: "Weak"', 'canonicalKey: "weak"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'Barely related.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = writeFixture(project, [
      { file: 'proj-wiki/entities/weak.md', score: 0.1 },
    ]);

    const out = callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: a resolved match whose file was since deleted is skipped, not fatal', () => {
  const project = setupProject();
  try {
    mkdirSync(join(project, '.auto-context', 'wiki'), { recursive: true });
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = writeFixture(project, [
      { file: 'proj-wiki/entities/gone.md', score: 0.95 },
    ]);

    const out = callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: malformed fixture fails open to null', () => {
  const project = setupProject();
  try {
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = join(project, 'bad-fixture.json');
    writeFileSync(fixture, 'not json');

    const out = callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: semanticDedup.enabled false short-circuits without touching the daemon', () => {
  const project = setupProject({ semanticDedup: { enabled: false } });
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'known.md'), [
      '---', 'title: "Known"', 'canonicalKey: "known"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'The known fact.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const sourcePath = join(project, 'docs', 'source.md');
    // No QMD_QUERY_FIXTURE set at all: if the code tried to reach a real daemon it would
    // hit a real network call. enabled:false must short-circuit before that ever happens.
    const out = callGatherSimilarPages(project, sourcePath);
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: non-numeric score in result does not crash, treated as below-threshold', () => {
  const project = setupProject();
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    // Write a valid wiki page that would be included if score were numeric
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'numeric.md'), [
      '---', 'title: "Numeric"', 'canonicalKey: "numeric"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'A valid numeric score.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    // Write another page with bad score
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'bad-score.md'), [
      '---', 'title: "BadScore"', 'canonicalKey: "bad-score"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'Should be skipped.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const sourcePath = join(project, 'docs', 'source.md');
    // First result has a non-numeric score (string)
    const fixture = writeFixture(project, [
      { file: 'proj-wiki/entities/bad-score.md', score: 'bad' },
      { file: 'proj-wiki/entities/numeric.md', score: 0.9 },
    ]);

    const out = JSON.parse(callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture }));
    // Should succeed (not crash) and include only the numeric score result
    assert.equal(out.length, 1);
    assert.equal(out[0].path, '.auto-context/wiki/entities/numeric.md');
    assert.equal(out[0].score, 0.9);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: null score in result does not crash, treated as below-threshold', () => {
  const project = setupProject();
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'valid.md'), [
      '---', 'title: "Valid"', 'canonicalKey: "valid"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'Good score.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = writeFixture(project, [
      { file: 'proj-wiki/entities/valid.md', score: null },
    ]);

    const out = callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture });
    // Should not crash; null is below threshold, so returns null
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('process_job includes similarPages in the extractor payload when the daemon finds a match', () => {
  const extractorDir = mkdtempSync(join(tmpdir(), 'extractor-similar-'));
  const extractor = join(extractorDir, 'extract.py');
  const dump = join(extractorDir, 'received-wiki.json');
  writeFileSync(extractor, `#!/usr/bin/env python3
import json, sys
payload = json.loads(sys.stdin.read())
open(${JSON.stringify(dump)}, 'w').write(json.dumps(payload['wiki']))
print(json.dumps({'candidates': []}))
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'known.md'), [
      '---', 'title: "Known"', 'canonicalKey: "known"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'The known fact.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const fixture = join(project, 'daemon-fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/known.md', score: 0.9 }] }));

    runWorker(project, { QMD_QUERY_FIXTURE: fixture });

    const receivedWiki = JSON.parse(readFileSync(dump, 'utf8'));
    assert.equal(receivedWiki.similarPages.length, 1);
    assert.equal(receivedWiki.similarPages[0].path, '.auto-context/wiki/entities/known.md');
    assert.match(receivedWiki.similarPages[0].content, /The known fact\./);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('process_job omits similarPages entirely when nothing qualifies (unchanged payload shape)', () => {
  const extractorDir = mkdtempSync(join(tmpdir(), 'extractor-no-similar-'));
  const extractor = join(extractorDir, 'extract.py');
  const dump = join(extractorDir, 'received-wiki.json');
  writeFileSync(extractor, `#!/usr/bin/env python3
import json, sys
payload = json.loads(sys.stdin.read())
open(${JSON.stringify(dump)}, 'w').write(json.dumps(payload['wiki']))
print(json.dumps({'candidates': []}))
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    // No QMD_QUERY_FIXTURE at all and no daemon running: query_wiki_similar fails open to None.
    runWorker(project);
    const receivedWiki = JSON.parse(readFileSync(dump, 'utf8'));
    assert.equal('similarPages' in receivedWiki, false);
    assert.equal(typeof receivedWiki.index, 'string');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
