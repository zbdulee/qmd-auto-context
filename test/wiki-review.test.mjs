import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('wiki_review: merge falls back to a new page when the matched target is not auto-writable (missing managed block)', () => {
  const work = repoTemp('wiki-review-unwritable');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'entities'), { recursive: true });
    const originalText = [
      '---', 'title: "Existing"', 'canonicalKey: "existing"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '## Summary', 'This page has no managed block at all (manually edited).', '',
    ].join('\n');
    writeFileSync(join(work, '.auto-context', 'wiki', 'entities', 'existing.md'), originalText);
    writeMergeNeeded(work, [{
      candidate: {
        title: 'Existing candidate update', summary: 'Merged, richer summary.', suggestedType: 'entity',
        confidence: 'high', canonicalKey: 'existing', targetPath: '.auto-context/wiki/entities/existing.md',
      },
      matchedPath: '.auto-context/wiki/entities/existing.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'merge'));

    // (a) existing page must be completely untouched
    const afterText = readFileSync(join(work, '.auto-context', 'wiki', 'entities', 'existing.md'), 'utf8');
    assert.equal(afterText, originalText);

    // (b) a new independent page was created instead with the candidate's content
    assert.equal(out.action, 'created');
    assert.notEqual(out.targetPath, '.auto-context/wiki/entities/existing.md');
    const newPagePath = join(work, out.targetPath);
    assert.equal(existsSync(newPagePath), true);
    const newText = readFileSync(newPagePath, 'utf8');
    assert.match(newText, /Merged, richer summary\./);

    // (c) result reports the fallback
    assert.equal(out.fallback, 'target_not_writable');

    // (d) queue entry is still removed
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: merge falls back to a new page when the matched target has a protected status', () => {
  const work = repoTemp('wiki-review-protected');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'entities'), { recursive: true });
    const originalText = [
      '---', 'title: "Existing"', 'canonicalKey: "existing"', 'type: entity', 'status: reviewed',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="deadbeef" -->', '## Summary', 'Human-reviewed summary.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n');
    writeFileSync(join(work, '.auto-context', 'wiki', 'entities', 'existing.md'), originalText);
    writeMergeNeeded(work, [{
      candidate: {
        title: 'Existing candidate update', summary: 'Merged, richer summary.', suggestedType: 'entity',
        confidence: 'high', canonicalKey: 'existing', targetPath: '.auto-context/wiki/entities/existing.md',
      },
      matchedPath: '.auto-context/wiki/entities/existing.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'merge'));

    // existing protected page must be completely untouched
    const afterText = readFileSync(join(work, '.auto-context', 'wiki', 'entities', 'existing.md'), 'utf8');
    assert.equal(afterText, originalText);

    assert.equal(out.action, 'created');
    assert.equal(out.fallback, 'target_not_writable');
    assert.deepEqual(readMergeNeeded(work), []);
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

test('wiki_review: separate never clobbers an unrelated existing page at the same slug path (Finding 1)', () => {
  const work = repoTemp('wiki-review-slug-collision');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'entities'), { recursive: true });
    const unrelatedPath = join(work, '.auto-context', 'wiki', 'entities', 'shared-slug.md');
    const unrelatedText = [
      '---', 'title: "Totally unrelated page"', 'canonicalKey: "shared-slug"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="cafebabe" -->', '## Summary', 'This page has nothing to do with the candidate.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n');
    writeFileSync(unrelatedPath, unrelatedText);

    writeMergeNeeded(work, [{
      // Title slugifies to the same "shared-slug" path as the unrelated page above,
      // but this candidate is a completely different topic (simulates a race where
      // another wiki-compile run created an unrelated page at that slug in the meantime).
      candidate: { title: 'Shared Slug', summary: 'A different topic entirely.', suggestedType: 'entity', confidence: 'high' },
      matchedPath: '.auto-context/wiki/entities/other-existing.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'separate'));

    // The unrelated pre-existing page must be byte-unchanged.
    const afterUnrelated = readFileSync(unrelatedPath, 'utf8');
    assert.equal(afterUnrelated, unrelatedText);

    // A new page was written at a different path (disambiguated), not clobbering the slug collision.
    assert.equal(out.action, 'created');
    assert.notEqual(out.targetPath, '.auto-context/wiki/entities/shared-slug.md');
    const newPagePath = join(work, out.targetPath);
    assert.equal(existsSync(newPagePath), true);
    const newText = readFileSync(newPagePath, 'utf8');
    assert.match(newText, /A different topic entirely\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: matchedPath escaping wiki_root is rejected and falls back like a stale match (Finding 2)', () => {
  const work = repoTemp('wiki-review-path-escape');
  try {
    writeSettings(work);
    // File that lives outside the wiki root (and outside the project root entirely),
    // simulating a hand-edited/corrupted merge-needed.jsonl with a traversal path.
    const outsideDir = repoTemp('wiki-review-path-escape-outside');
    const outsidePath = join(outsideDir, 'outside.md');
    const outsideText = 'this file must never be read or written by wiki_review\n';
    writeFileSync(outsidePath, outsideText);

    try {
      writeMergeNeeded(work, [{
        candidate: { title: 'Escaping candidate', summary: 'Tries to point outside wiki_root.', suggestedType: 'entity', confidence: 'high' },
        matchedPath: `../${outsideDir.split('/').pop()}/outside.md`,
        matchedScore: 0.9,
        suggestedAction: 'merge',
      }]);

      const out = JSON.parse(runReview(work, 0, 'merge'));

      // The outside file must be byte-identical — never touched.
      const afterOutside = readFileSync(outsidePath, 'utf8');
      assert.equal(afterOutside, outsideText);

      // Falls back the same way a stale/missing match does: creates a new independent page.
      assert.equal(out.action, 'created');
      assert.equal(out.fallback, 'stale_match');
      assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'escaping-candidate.md')), true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: a crash mid-resolve_entry leaves the queue exactly as it was (Finding 3)', () => {
  const work = repoTemp('wiki-review-crash-preserve');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki'), { recursive: true });
    writeMergeNeeded(work, [
      { candidate: { title: 'A', summary: 'a', suggestedType: 'entity' }, matchedPath: 'x', matchedScore: 0.9, suggestedAction: 'merge' },
      { candidate: { title: 'B', summary: 'b', suggestedType: 'entity' }, matchedPath: 'y', matchedScore: 0.9, suggestedAction: 'merge' },
    ]);

    const wikiRoot = join(work, '.auto-context', 'wiki');
    const before = readMergeNeeded(work);
    // Make the wiki root unwritable so write_new_page()'s mkdir/write_text
    // inside resolve_entry() fails with a genuine PermissionError partway
    // through, instead of a contrived/synthetic failure.
    chmodSync(wikiRoot, 0o500); // read + execute only, no write
    try {
      let threw = false;
      try {
        runReview(work, 0, 'separate');
      } catch (e) {
        threw = true;
      }
      assert.equal(threw, true, 'expected resolve_entry to actually fail when the wiki root is not writable');
    } finally {
      chmodSync(wikiRoot, 0o755);
    }

    // The whole point of Finding 3: nothing is lost on a crash. The queue
    // (including the entry that was being resolved) must be exactly as it
    // was before the failed attempt.
    const after = readMergeNeeded(work);
    assert.deepEqual(after, before);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
