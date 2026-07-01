import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function repoTemp(prefix) {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `qmd-test-${prefix}-`));
}

function writeSettings(work) {
  mkdirSync(join(work, '.auto-context'), { recursive: true });
  writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: { enabled: true, mode: 'auto-wiki', autoWrite: true },
  }));
}

function writeMergeNeeded(work, entries) {
  mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
  writeFileSync(
    join(work, '.auto-context', 'compile', 'merge-needed.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function readMergeNeeded(work) {
  const path = join(work, '.auto-context', 'compile', 'merge-needed.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runReview(work, index, action, extra = []) {
  return execFileSync('python3', [
    'core/wiki_review.py', '--cwd', work, '--index', String(index), '--action', action, ...extra,
  ], { encoding: 'utf8' });
}

test('wiki_review: discard removes the entry, writes no page', () => {
  const work = repoTemp('wiki-review-discard');
  try {
    writeSettings(work);
    writeMergeNeeded(work, [{
      candidate: { title: 'X', summary: 'Y', suggestedType: 'entity' },
      matchedPath: '.auto-context/wiki/entities/existing.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'discard'));
    assert.equal(out.action, 'discarded');
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: separate writes the candidate as an independent new page and clears the entry', () => {
  const work = repoTemp('wiki-review-separate');
  try {
    writeSettings(work);
    writeMergeNeeded(work, [{
      candidate: {
        title: 'Independent fact', summary: 'Not actually related.', suggestedType: 'entity', confidence: 'high',
      },
      matchedPath: '.auto-context/wiki/entities/existing.md',
      matchedScore: 0.83,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'separate'));
    assert.equal(out.action, 'created');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'independent-fact.md')), true);
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: merge updates the matched existing page managed section in place', () => {
  const work = repoTemp('wiki-review-merge');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'wiki', 'entities', 'existing.md'), [
      '---', 'title: "Existing"', 'canonicalKey: "existing"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="deadbeef" -->', '## Summary', 'Old summary.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    writeMergeNeeded(work, [{
      candidate: {
        title: 'Existing', summary: 'Merged, richer summary.', suggestedType: 'entity',
        confidence: 'high', canonicalKey: 'existing', targetPath: '.auto-context/wiki/entities/existing.md',
      },
      matchedPath: '.auto-context/wiki/entities/existing.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'merge'));
    assert.equal(out.action, 'updated');
    const text = readFileSync(join(work, '.auto-context', 'wiki', 'entities', 'existing.md'), 'utf8');
    assert.match(text, /Merged, richer summary\./);
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: supersede creates a new page and marks the old page superseded', () => {
  const work = repoTemp('wiki-review-supersede');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'decisions'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'wiki', 'decisions', 'old-rule.md'), [
      '---', 'title: "Old rule"', 'canonicalKey: "old-rule"', 'type: decision', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="deadbeef" -->', '## Summary', 'The old rule text.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    writeMergeNeeded(work, [{
      candidate: {
        title: 'New rule', summary: 'The rule got reversed.', suggestedType: 'decision', confidence: 'high',
      },
      matchedPath: '.auto-context/wiki/decisions/old-rule.md',
      matchedScore: 0.9,
      suggestedAction: 'supersede-or-new',
    }]);

    const out = JSON.parse(runReview(work, 0, 'supersede'));
    assert.equal(out.action, 'created');
    assert.equal(out.supersedes, '.auto-context/wiki/decisions/old-rule.md');

    const newText = readFileSync(join(work, '.auto-context', 'wiki', 'decisions', 'new-rule.md'), 'utf8');
    assert.match(newText, /supersedes: "\.auto-context\/wiki\/decisions\/old-rule\.md"/);

    const oldText = readFileSync(join(work, '.auto-context', 'wiki', 'decisions', 'old-rule.md'), 'utf8');
    assert.match(oldText, /status: "superseded"/);
    assert.match(oldText, /supersededBy: "\.auto-context\/wiki\/decisions\/new-rule\.md"/);
    assert.match(oldText, /The old rule text\./); // managed body untouched
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: unresolved entries before and after the resolved index are preserved in order', () => {
  const work = repoTemp('wiki-review-preserve-order');
  try {
    writeSettings(work);
    writeMergeNeeded(work, [
      { candidate: { title: 'A', summary: 'a', suggestedType: 'entity' }, matchedPath: 'x', matchedScore: 0.9, suggestedAction: 'merge' },
      { candidate: { title: 'B', summary: 'b', suggestedType: 'entity' }, matchedPath: 'y', matchedScore: 0.9, suggestedAction: 'merge' },
      { candidate: { title: 'C', summary: 'c', suggestedType: 'entity' }, matchedPath: 'z', matchedScore: 0.9, suggestedAction: 'merge' },
    ]);

    runReview(work, 1, 'discard');

    const remaining = readMergeNeeded(work);
    assert.deepEqual(remaining.map((e) => e.candidate.title), ['A', 'C']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: stale matchedPath (deleted since queued) falls back to separate for merge/supersede', () => {
  const work = repoTemp('wiki-review-stale-match');
  try {
    writeSettings(work);
    writeMergeNeeded(work, [{
      candidate: { title: 'Orphaned candidate', summary: 'Its match vanished.', suggestedType: 'entity', confidence: 'high' },
      matchedPath: '.auto-context/wiki/entities/gone.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'merge'));
    assert.equal(out.action, 'created');
    assert.equal(out.fallback, 'stale_match');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'orphaned-candidate.md')), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
