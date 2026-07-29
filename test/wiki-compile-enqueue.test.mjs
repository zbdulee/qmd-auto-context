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

// 명시적으로 등록된 dot collection 루트(novel의 `.nova/06_Sessions`)는 compile source가
// 되어야 한다. dot 정책은 "등록된 루트 아래"에만 적용되므로 면제 범위가 루트 접두부로
// 한정되고, `collectionPaths: '.'`처럼 접두부가 비면 아무것도 면제되지 않는다.
function setupDotProject(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwiki-dotenq-'));
  mkdirSync(join(dir, '.nova', '06_Sessions', 'archive'), { recursive: true });
  mkdirSync(join(dir, '.nova', '06_Sessions', '.drafts'), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, '.github'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'wiki'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
  writeFileSync(join(dir, '.nova', '06_Sessions', '2026-07-29.md'), '# Session\n');
  writeFileSync(join(dir, '.nova', '06_Sessions', 'archive', 'old.md'), '# Old\n');
  writeFileSync(join(dir, '.nova', '06_Sessions', '.drafts', 'wip.md'), '# WIP\n');
  writeFileSync(join(dir, '.nova', '06_Sessions', '.hidden.md'), '# Hidden\n');
  writeFileSync(join(dir, '.claude', 'agent.md'), '# Agent\n');
  writeFileSync(join(dir, '.github', 'workflow.md'), '# CI\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'card.md'), '# Card\n');
  writeFileSync(join(dir, '.auto-context', 'compile', 'notes.md'), '# Queue notes\n');
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['sessions'],
    collectionPaths: { sessions: '.nova/06_Sessions' },
    collectionRoles: { sessions: 'session' },
    compile: {
      enabled: true,
      mode: 'auto-wiki',
      autoWrite: true,
      triggers: ['post_tool_source', 'manual'],
      sourceQueuePath: '.auto-context/compile/source-queue.jsonl',
    },
    ...extra,
  }));
  return dir;
}

test('registered dot collection root enqueues, dot paths below it still do not', () => {
  const project = setupDotProject();
  try {
    runEnqueue(project, { tool_input: { file_path: join(project, '.nova', '06_Sessions', '2026-07-29.md') } });
    runEnqueue(project, { tool_input: { file_path: join(project, '.nova', '06_Sessions', 'archive', 'old.md') } });
    const jobs = queueLines(project);
    assert.deepEqual(jobs.map((j) => j.source.path), [
      '.nova/06_Sessions/2026-07-29.md',
      '.nova/06_Sessions/archive/old.md',
    ]);
    assert.deepEqual(jobs[0].source, {
      kind: 'file', path: '.nova/06_Sessions/2026-07-29.md', collection: 'sessions',
    });
    assert.equal('content' in jobs[0].source, false);

    // 등록된 루트 아래에서 새로 나타나는 dot segment는 계속 배제된다.
    runEnqueue(project, { tool_input: { file_path: join(project, '.nova', '06_Sessions', '.drafts', 'wip.md') } });
    runEnqueue(project, { tool_input: { file_path: join(project, '.nova', '06_Sessions', '.hidden.md') } });
    // 등록되지 않은 dot 경로는 collection 밖이므로 애초에 걸리지 않는다.
    runEnqueue(project, { tool_input: { file_path: join(project, '.claude', 'agent.md') } });
    runEnqueue(project, { tool_input: { file_path: join(project, '.github', 'workflow.md') } });
    assert.equal(queueLines(project).length, 2);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('.auto-context stays out of compile sources even when registered as a raw collection', () => {
  // 최악의 오설정: 사용자가 wikiPath와 compile 큐 디렉터리를 raw collection으로 등록.
  // role 게이트를 우회해도 관리 영역 deny가 남아야 한다 — wiki 카드가 자기 자신을
  // 소스로 재컴파일하면 무한 증식한다.
  const project = setupDotProject({
    collections: ['sessions', 'wiki-as-raw', 'compile-as-raw'],
    collectionPaths: {
      sessions: '.nova/06_Sessions',
      'wiki-as-raw': '.auto-context/wiki',
      'compile-as-raw': '.auto-context/compile',
    },
    collectionRoles: { sessions: 'session', 'wiki-as-raw': 'raw', 'compile-as-raw': 'raw' },
  });
  try {
    runEnqueue(project, { tool_input: { file_path: join(project, '.auto-context', 'wiki', 'card.md') } });
    runEnqueue(project, { tool_input: { file_path: join(project, '.auto-context', 'compile', 'notes.md') } });
    assert.deepEqual(queueLines(project), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('collectionPaths "." does not open dot directories via the registered-root exemption', () => {
  // 최대 리스크: 저장소 전체가 등록된 프로젝트. 면제되는 루트 접두부가 비어 있으므로
  // rel path 전체가 dot 검사를 받아 dot 디렉터리가 하나도 열리지 않아야 한다.
  const project = setupDotProject({
    collections: ['repo-root'],
    collectionPaths: { 'repo-root': '.' },
    collectionRoles: { 'repo-root': 'raw' },
  });
  try {
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(join(project, 'docs', 'plain.md'), '# Plain\n');
    for (const p of [
      ['.nova', '06_Sessions', '2026-07-29.md'],
      ['.claude', 'agent.md'],
      ['.github', 'workflow.md'],
      ['.auto-context', 'wiki', 'card.md'],
      ['.auto-context', 'compile', 'notes.md'],
    ]) {
      runEnqueue(project, { tool_input: { file_path: join(project, ...p) } });
    }
    assert.deepEqual(queueLines(project), []);

    // 같은 프로젝트의 non-dot 경로는 정상 큐잉되어야 한다(과도 차단 아님).
    runEnqueue(project, { tool_input: { file_path: join(project, 'docs', 'plain.md') } });
    assert.deepEqual(queueLines(project).map((j) => j.source.path), ['docs/plain.md']);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
