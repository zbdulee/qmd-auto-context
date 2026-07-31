import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { removeTemp } from './helpers/temp.mjs';

function repoTemp(prefix) {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `qmd-test-${prefix}-`));
}

function writeSettings(work, compile = {}) {
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
      ...compile,
    },
  }));
}

function runExtract(work, payload, env = {}) {
  // QMD_DIRTY_QUEUE를 임시 경로로 격리하지 않으면 dirty queue 유출 시 사용자 실제 qmd 인덱스에 고아 컬렉션이 등록되며(복구 불가 고아 등록), 자동으로 정리할 수 있는 경로가 없다.
  return execFileSync('python3', ['core/wiki_extract.py', '--cwd', work], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { QMD_DIRTY_QUEUE: join(work, 'dirty-queue'), ...process.env, ...env },
  });
}

test('wiki_extract: compact durable summary becomes wiki_compile candidate and page', () => {
  const work = repoTemp('wiki-extract-compact');
  try {
    writeSettings(work);
    const out = runExtract(work, {
      trigger: 'manual',
      sourceRef: 'session:local',
      durable: {
        title: 'Config Layout Decision',
        summary: 'Canonical config lives in .auto-context/settings.json; legacy root config is migration-only.',
        type: 'decision',
        confidence: 'high',
      },
    });

    assert.match(out, /created/);
    const page = readFileSync(join(work, '.auto-context', 'wiki', 'decisions', 'config-layout-decision.md'), 'utf8');
    assert.match(page, /Canonical config lives/);
    assert.match(page, /kind: "session"/);
    assert.match(page, /ref: "session:local"/);
  } finally {
    removeTemp(work);
  }
});

test('wiki_extract: preserves canonicalKey and aliases from compact candidates', () => {
  const work = repoTemp('wiki-extract-identity');
  try {
    writeSettings(work);
    runExtract(work, {
      trigger: 'manual',
      sourceRef: 'session:identity',
      durable: {
        title: 'Signal Perception Rule',
        canonicalKey: 'signal-perception-rule',
        aliases: ['Signal rule'],
        summary: 'Identity fields from compact input should reach the compile writer.',
        type: 'concept',
        confidence: 'high',
      },
    });

    const page = readFileSync(join(work, '.auto-context', 'wiki', 'concepts', 'signal-perception-rule.md'), 'utf8');
    assert.match(page, /canonicalKey: "signal-perception-rule"/);
    assert.match(page, /aliases:\n  - "Signal rule"/);
  } finally {
    removeTemp(work);
  }
});

test('wiki_extract: raw transcript-shaped input is rejected before compile writer persists it', () => {
  const work = repoTemp('wiki-extract-transcript');
  try {
    writeSettings(work);
    const out = runExtract(work, {
      trigger: 'post_session_summary',
      sourceRef: 'session:local',
      durable: {
        title: 'Transcript Dump',
        canonicalKey: 'transcript-dump',
        aliases: ['Transcript dump alias'],
        summary: 'User: save this entire chat\nAssistant: ok I will',
        type: 'session',
        confidence: 'high',
      },
    });

    assert.match(out, /rejected/);
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'sessions', 'transcript-dump.md')), false);
    const candidate = readFileSync(join(work, '.auto-context', 'compile', 'candidates.jsonl'), 'utf8');
    assert.match(candidate, /transcript_like/);
    assert.doesNotMatch(candidate, /User: save this entire chat/);
    assert.match(candidate, /transcript-dump/);
    assert.match(candidate, /Transcript dump alias/);
  } finally {
    removeTemp(work);
  }
});

test('wiki_extract: no durable summary is a no-op with empty stdout', () => {
  const work = repoTemp('wiki-extract-noop');
  try {
    writeSettings(work);
    const out = runExtract(work, { trigger: 'manual', notes: 'brainstorm only' });
    assert.equal(out.trim(), '');
    assert.equal(existsSync(join(work, '.auto-context', 'compile', 'candidates.jsonl')), false);
  } finally {
    removeTemp(work);
  }
});
