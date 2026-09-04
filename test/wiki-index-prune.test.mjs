import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { removeTemp } from './helpers/temp.mjs';

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
    compile: { mode: 'auto-wiki' },
  }));
}

function writeWikiPage(work, rel, content) {
  const full = join(work, '.auto-context', 'wiki', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function writeIndex(work, lines) {
  mkdirSync(join(work, '.auto-context', 'wiki'), { recursive: true });
  writeFileSync(join(work, '.auto-context', 'wiki', 'index.md'),
    `# Auto-context Wiki Index\n\n${lines.join('\n')}\n`);
}

function readIndexLines(work) {
  const path = join(work, '.auto-context', 'wiki', 'index.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').split('\n');
}

function readLog(work) {
  const path = join(work, '.auto-context', 'wiki', 'log.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

// Call remove_from_index directly; returns the boolean it reports.
function removeFromIndex(work, rel) {
  return execFileSync('python3', ['-c', [
    'import sys',
    "sys.path.insert(0, 'core')",
    'from pathlib import Path',
    'from wiki_compile import remove_from_index',
    'wiki = Path(sys.argv[1])',
    'print(remove_from_index(wiki, wiki / sys.argv[2]), end="")',
  ].join('\n'), join(work, '.auto-context', 'wiki'), rel], { encoding: 'utf8' });
}

test('remove_from_index: drops the exact line and leaves every other entry', () => {
  const work = repoTemp('index-prune-exact');
  try {
    writeIndex(work, [
      '- decisions/',
      '- concepts/',
      '- entities/a.md - A',
      '- entities/b.md - B',
      '- entities/c.md - C',
    ]);
    assert.equal(removeFromIndex(work, 'entities/b.md'), 'True');
    const lines = readIndexLines(work);
    assert.ok(lines.includes('- entities/a.md - A'));
    assert.ok(lines.includes('- entities/c.md - C'));
    assert.ok(!lines.some((l) => l.startsWith('- entities/b.md ')));
    // the bare directory markers at the head are not entries and must survive
    assert.ok(lines.includes('- decisions/'));
    assert.ok(lines.includes('- concepts/'));
    assert.ok(lines[0].startsWith('# Auto-context Wiki Index'));
  } finally {
    removeTemp(work);
  }
});

// update_index dedups with `rel in text`, a substring test. Removal must not
// inherit it: pruning foo.md would otherwise take foo-bar.md down with it.
test('remove_from_index: a path that is a prefix of another entry does not take it along', () => {
  const work = repoTemp('index-prune-substring');
  try {
    writeIndex(work, [
      '- entities/foo.md - Foo',
      '- entities/foo-bar.md - Foo Bar',
      '- concepts/x.md - mentions entities/foo.md in the title',
    ]);
    assert.equal(removeFromIndex(work, 'entities/foo.md'), 'True');
    const lines = readIndexLines(work);
    assert.ok(!lines.some((l) => l.startsWith('- entities/foo.md ')));
    assert.ok(lines.includes('- entities/foo-bar.md - Foo Bar'));
    assert.ok(lines.includes('- concepts/x.md - mentions entities/foo.md in the title'));
  } finally {
    removeTemp(work);
  }
});

test('remove_from_index: absent line and absent index.md are both no-ops reporting agreement', () => {
  const work = repoTemp('index-prune-absent');
  try {
    writeIndex(work, ['- entities/a.md - A']);
    const before = readIndexLines(work);
    assert.equal(removeFromIndex(work, 'entities/never-there.md'), 'True');
    assert.deepEqual(readIndexLines(work), before, 'a missing line must not rewrite the file');

    const empty = repoTemp('index-prune-noindex');
    try {
      mkdirSync(join(empty, '.auto-context', 'wiki'), { recursive: true });
      assert.equal(removeFromIndex(empty, 'entities/a.md'), 'True');
      assert.equal(readIndexLines(empty), null, 'must not create index.md');
    } finally {
      removeTemp(empty);
    }
  } finally {
    removeTemp(work);
  }
});

test('wiki_dedup_resolve: merging prunes the deleted card from index.md and logs it', () => {
  const work = repoTemp('index-prune-dedup');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/loser.md', '---\ntitle: Loser Card\n---\n\nloser\n');
    writeWikiPage(work, 'entities/winner.md', '---\ntitle: Winner Card\n---\n\nwinner\n');
    writeIndex(work, [
      '- entities/loser.md - Loser Card',
      '- entities/winner.md - Winner Card',
    ]);
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
      JSON.stringify({ pageA: 'entities/loser.md', pageB: 'entities/winner.md', score: 0.95 }) + '\n');

    const out = execFileSync('python3', [
      'core/wiki_dedup_resolve.py', '--cwd', work,
      '--index', '0', '--action', 'merge', '--delete', 'entities/loser.md',
    ], { encoding: 'utf8' });
    assert.equal(JSON.parse(out).action, 'deleted');
    assert.equal(JSON.parse(out).indexOk, true);

    const lines = readIndexLines(work);
    assert.ok(!lines.some((l) => l.startsWith('- entities/loser.md ')), 'deleted card must leave the index');
    assert.ok(lines.includes('- entities/winner.md - Winner Card'), 'the keeper stays');
    assert.match(readLog(work), /deleted entities\/loser\.md - Loser Card/);
  } finally {
    removeTemp(work);
  }
});
