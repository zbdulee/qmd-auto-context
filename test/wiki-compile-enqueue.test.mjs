import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupProject(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-enqueue-'));
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'source.md'), '# Source\n');
  writeFileSync(join(dir, 'docs', 'note.txt'), 'not markdown\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'generated.md'), '# Generated\n');
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
    compile: {
      enabled: true,
      mode: 'guarded',
      autoWrite: true,
      triggers: ['post_tool_source', 'manual'],
      sourceQueuePath: '.auto-context/compile/source-queue.jsonl',
      ...config.compile,
    },
    ...config,
  }));
  return dir;
}

function runEnqueue(cwd, payload, env = {}) {
  return execFileSync('python3', ['core/wiki_compile_enqueue.py'], {
    cwd: process.cwd(),
    input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd, ...payload }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function queueLines(project) {
  const q = join(project, '.auto-context', 'compile', 'source-queue.jsonl');
  if (!existsSync(q)) return [];
  return readFileSync(q, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('raw markdown edit enqueues bounded source job silently', () => {
  const project = setupProject();
  try {
    const out = runEnqueue(project, { tool_input: { file_path: join(project, 'docs', 'source.md') } });
    assert.equal(out, '');
    const jobs = queueLines(project);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].trigger, 'post_tool_source');
    assert.equal(jobs[0].engine, 'unknown');
    assert.equal(jobs[0].cwd, realpathSync(project));
    assert.deepEqual(jobs[0].source, { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' });
    assert.equal('content' in jobs[0].source, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('non-markdown, outside collection, wiki role, disabled trigger, and sandbox do not enqueue', () => {
  const project = setupProject();
  try {
    runEnqueue(project, { tool_input: { file_path: join(project, 'docs', 'note.txt') } });
    runEnqueue(project, { tool_input: { file_path: join(project, 'README.md') } });
    runEnqueue(project, { tool_input: { file_path: join(project, '.auto-context', 'wiki', 'generated.md') } });
    runEnqueue(project, { tool_input: { file_path: join(project, 'docs', 'source.md') } }, { QMD_SANDBOX: '1' });
    const optout = setupProject({ indexing: false });
    try {
      runEnqueue(optout, { tool_input: { file_path: join(optout, 'docs', 'source.md') } });
      assert.deepEqual(queueLines(optout), []);
    } finally {
      rmSync(optout, { recursive: true, force: true });
    }
    const pending = setupProject({ indexing: null });
    try {
      runEnqueue(pending, { tool_input: { file_path: join(pending, 'docs', 'source.md') } });
      assert.deepEqual(queueLines(pending), []);
    } finally {
      rmSync(pending, { recursive: true, force: true });
    }
    assert.deepEqual(queueLines(project), []);

    const disabled = setupProject({ compile: { triggers: ['manual'] } });
    try {
      runEnqueue(disabled, { tool_input: { file_path: join(disabled, 'docs', 'source.md') } });
      assert.deepEqual(queueLines(disabled), []);
    } finally {
      rmSync(disabled, { recursive: true, force: true });
    }
    const modeOff = setupProject({ compile: { mode: 'off' } });
    try {
      runEnqueue(modeOff, { tool_input: { file_path: join(modeOff, 'docs', 'source.md') } });
      assert.deepEqual(queueLines(modeOff), []);
    } finally {
      rmSync(modeOff, { recursive: true, force: true });
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('dot-directory and hidden markdown sources do not enqueue for automatic compile', () => {
  const project = setupProject({
    collections: ['proj-root'],
    collectionPaths: { 'proj-root': '.' },
    collectionRoles: { 'proj-root': 'raw' },
  });
  try {
    mkdirSync(join(project, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(project, 'docs', '.draft'), { recursive: true });
    writeFileSync(join(project, '.agents', 'skills', 'writer.md'), '# Agent Skill\n');
    writeFileSync(join(project, 'docs', '.draft', 'idea.md'), '# Draft\n');
    writeFileSync(join(project, 'docs', '.hidden.md'), '# Hidden file\n');

    runEnqueue(project, { tool_input: { file_path: join(project, '.agents', 'skills', 'writer.md') } });
    runEnqueue(project, { tool_input: { file_path: join(project, 'docs', '.draft', 'idea.md') } });
    runEnqueue(project, { tool_input: { file_path: join(project, 'docs', '.hidden.md') } });

    assert.deepEqual(queueLines(project), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
