import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sha = (value) => createHash('sha256').update(value).digest('hex');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'qmd-topical-test-'));
  mkdirSync(join(root, 'sources'));
  writeFileSync(join(root, '.qmd-topical-sandbox'), 'synthetic only\n');
  return root;
}

function source(root, name, body) {
  const rel = `sources/${name}.md`;
  writeFileSync(join(root, rel), body);
  return { rel, body, revision: sha(body) };
}

function evidence(src, quote, startLine, endLine) {
  return { sourcePath: src.rel, sourceRevisionSha256: src.revision,
    startLine, endLine, quoteAnchor: quote, quoteSha256: sha(quote) };
}

function claim(claimId, statement, state, timeScope, condition, sources) {
  return { claimId, statement, state, timeScope, condition, evidence: sources };
}

function card(cardId, title, category, claims, details = '') {
  return { cardId, title, category, details, claims };
}

function run(root, cards, leadBudget = 600) {
  const process = spawnSync('python3', ['core/wiki_topical.py', '--sandbox-root', root,
    '--lead-budget', String(leadBudget)], {
    input: JSON.stringify({ schema: 'qmd-topical-sandbox-v1', cards }), encoding: 'utf8',
    env: { ...processEnv(), QMD_RECALL_LOG: '', QMD_SANDBOX: '1' },
  });
  assert.equal(process.stderr, '', process.stderr);
  return { code: process.status, result: JSON.parse(process.stdout) };
}

function processEnv() { return process.env; }

function python(script) {
  const result = spawnSync('python3', ['-c', script], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...processEnv(), QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('topical sandbox: one source yields two intact topic cards in one atomic generation', () => {
  const root = sandbox();
  try {
    const src = source(root, 'notes', 'Character A keeps the key.\nThe blue gate opens only at dawn.\n');
    const cards = [
      card('character-a-key', 'Character A key', 'entity', [
        claim('key-owner', 'Character A keeps the key.', 'actual', 'chapter-1', '',
          [evidence(src, 'Character A keeps the key.', 1, 1)]),
      ]),
      card('blue-gate-rule', 'Blue gate rule', 'world-rule', [
        claim('gate-dawn', 'The blue gate opens only at dawn.', 'rule', 'chapter-1', 'only at dawn',
          [evidence(src, 'The blue gate opens only at dawn.', 2, 2)]),
      ]),
    ];
    const { code, result } = run(root, cards);
    assert.equal(code, 0);
    assert.equal(result.status, 'generated_unverified');
    assert.equal(result.cardCount, 2);
    const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8'));
    assert.equal(manifest.cards.length, 2);
    assert.deepEqual(manifest.cards.map((c) => c.sources), [1, 1]);
    const first = readFileSync(join(result.path, 'cards', 'blue-gate-rule.md'), 'utf8');
    assert.match(first, /status: generated/);
    assert.match(first, /\[rule\|chapter-1; 조건:only at dawn\] The blue gate opens only at dawn\./);
    assert.match(first, /sourceRevisions:/);
    assert.doesNotMatch(first, /Character A keeps the key/);
    const sidecar = JSON.parse(readFileSync(join(result.path, 'cards', 'blue-gate-rule.evidence.json'), 'utf8'));
    assert.equal(sidecar.claims[0].evidence[0].startLine, 2);
    assert.equal(sidecar.sourceRevisions[0].sha256, src.revision);
    assert.ok(result.cards.every((item) => item.leadChars <= 600));
    assert.equal(readdirSync(join(root, 'topical-generations')).filter((name) => name.startsWith('.stage-')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topical generation parent symlink cannot redirect writes outside the sandbox', () => {
  const root = sandbox();
  const outside = mkdtempSync(join(tmpdir(), 'qmd-topical-outside-'));
  try {
    symlinkSync(outside, join(root, 'topical-generations'), 'dir');
    const src = source(root, 'notes', 'The blue gate opens only at dawn.\n');
    const entry = card('blue-gate', 'Blue gate', 'world-rule', [
      claim('opens', 'The blue gate opens only at dawn.', 'rule', 'chapter-1', 'at dawn',
        [evidence(src, 'The blue gate opens only at dawn.', 1, 1)]),
    ]);
    const { code, result } = run(root, [entry]);
    assert.equal(code, 1);
    assert.equal(result.reason, 'unsafe_generation_parent');
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('topical dirfd commit stays inside sandbox during parent swap', () => {
  const result = python(`
import json,os,sys,tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,'core')
import wiki_topical as t
with tempfile.TemporaryDirectory(prefix='qmd-topical-race-') as temporary:
 root=Path(temporary).resolve();(root/t.MARKER).write_text('synthetic only\\n');(root/'sources').mkdir()
 outside=root/'outside';outside.mkdir()
 quote='The synthetic door closes at dusk.'
 (root/'sources/story.md').write_text(quote+'\\n')
 revision=t.source_snapshot(root,'sources/story.md',{})[0]
 span={'sourcePath':'sources/story.md','sourceRevisionSha256':revision['sha256'],
       'startLine':1,'endLine':1,'quoteAnchor':quote,'quoteSha256':t.digest(quote.encode())}
 card={'cardId':'dusk-door','title':'Dusk door','category':'world-rule','details':'',
       'claims':[{'claimId':'closing','statement':quote,'state':'rule',
                  'timeScope':'chapter-1','condition':'dusk','evidence':[span]}]}
 original=os.rename;swapped=[]
 def redirect(src,dst,*args,**kwargs):
  if kwargs.get('src_dir_fd') is not None and not swapped:
   original(root/'topical-generations',root/'held-generations')
   (root/'topical-generations').symlink_to(outside,target_is_directory=True)
   swapped.append(True)
  return original(src,dst,*args,**kwargs)
 with patch.object(os,'rename',side_effect=redirect):
  try:t.compile_sandbox(root,{'schema':t.SCHEMA,'cards':[card]})
  except t.TopicalError as exc:assert exc.code=='generation_parent_changed'
  else:raise AssertionError('swapped parent accepted')
 assert swapped and not list(outside.iterdir())
 assert len(list((root/'held-generations').glob('*/manifest.json')))==1
 print(json.dumps({'outsideEmpty':True,'heldGeneration':True,'swapRejected':True}))
`);
  assert.deepEqual(result, { outsideEmpty: true, heldGeneration: true, swapRejected: true });
});

test('topical sandbox: omitted optional details and exact multiline evidence compile without altering the quote', () => {
  const root = sandbox();
  try {
    const src = source(root, 'multiline', 'The first condition holds.\nThe second condition is required.\n');
    const quote = 'The first condition holds.\nThe second condition is required.';
    const entry = card('two-conditions', 'Two conditions', 'world-rule', [
      claim('both-required', 'Both conditions are required.', 'rule', 'chapter-1', 'both conditions',
        [evidence(src, quote, 1, 2)]),
    ]);
    delete entry.details;
    const { code, result } = run(root, [entry]);
    assert.equal(code, 0);
    assert.equal(result.status, 'generated_unverified');
    assert.equal(result.cardCount, 1);
    const sidecar = JSON.parse(readFileSync(join(result.path, 'cards', 'two-conditions.evidence.json'), 'utf8'));
    assert.equal(sidecar.claims[0].evidence[0].quoteAnchor, quote);
    assert.equal(sidecar.claims[0].evidence[0].quoteSha256, sha(quote));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topical sandbox: multiline evidence rejects altered bytes and a truncated line range', () => {
  const root = sandbox();
  try {
    const src = source(root, 'multiline', 'Alpha condition.\nBeta condition.\n');
    const quote = 'Alpha condition.\nBeta condition.';
    const entry = card('alpha-beta', 'Alpha beta', 'world-rule', [
      claim('both', 'Both conditions apply.', 'rule', 'chapter-1', '', [evidence(src, quote, 1, 2)]),
    ]);
    const altered = structuredClone(entry);
    altered.claims[0].evidence[0].quoteAnchor = 'Alpha condition.\nChanged condition.';
    altered.claims[0].evidence[0].quoteSha256 = sha(altered.claims[0].evidence[0].quoteAnchor);
    assert.equal(run(root, [altered]).result.reason, 'quote_outside_span');
    const wrongRange = structuredClone(entry);
    wrongRange.claims[0].evidence[0].endLine = 1;
    assert.equal(run(root, [wrongRange]).result.reason, 'quote_outside_span');
    assert.equal(existsSync(join(root, 'topical-generations')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topical sandbox: same canonical subject merges two authoritative sources and retains plan/actual states', () => {
  const root = sandbox();
  try {
    const plan = source(root, 'plan', 'The plan says the bell should ring twice.\n');
    const scene = source(root, 'scene', 'In the scene the bell rings once.\n');
    const entries = [
      card('bell-event', 'Bell event', 'timeline', [
        claim('planned-rings', 'The bell should ring twice.', 'plan', 'chapter-2', 'if the bell is used',
          [evidence(plan, 'The plan says the bell should ring twice.', 1, 1)]),
      ]),
      card('bell-event', 'Bell event', 'timeline', [
        claim('actual-rings', 'The bell rings once.', 'actual', 'chapter-2', '',
          [evidence(scene, 'In the scene the bell rings once.', 1, 1)]),
      ]),
    ];
    const { code, result } = run(root, entries);
    assert.equal(code, 0);
    assert.equal(result.cardCount, 1);
    assert.equal(result.cards[0].sources, 2);
    const cardData = JSON.parse(readFileSync(join(result.path, 'cards', 'bell-event.evidence.json'), 'utf8'));
    assert.deepEqual(cardData.claims.map((c) => c.state), ['actual', 'plan']);
    assert.deepEqual(cardData.sourceRevisions.map((s) => s.path), ['sources/plan.md', 'sources/scene.md']);
    const page = readFileSync(join(result.path, 'cards', 'bell-event.md'), 'utf8');
    assert.match(page, /\[actual\|chapter-2\]/);
    assert.match(page, /\[plan\|chapter-2; 조건:if the bell is used\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topical sandbox: same claim may collect two source spans without duplicating the lead', () => {
  const root = sandbox();
  try {
    const a = source(root, 'a', 'The archive key is stored in a blue box.\n');
    const b = source(root, 'b', 'The blue box contains the archive key.\n');
    const one = claim('archive-key', 'The archive key is in a blue box.', 'actual', 'chapter-3', '',
      [evidence(a, 'The archive key is stored in a blue box.', 1, 1)]);
    const two = claim('archive-key', 'The archive key is in a blue box.', 'actual', 'chapter-3', '',
      [evidence(b, 'The blue box contains the archive key.', 1, 1)]);
    const { code, result } = run(root, [card('archive-key', 'Archive key', 'entity', [one]),
      card('archive-key', 'Archive key', 'entity', [two])]);
    assert.equal(code, 0);
    const data = JSON.parse(readFileSync(join(result.path, 'cards', 'archive-key.evidence.json'), 'utf8'));
    assert.equal(data.claims.length, 1);
    assert.equal(data.claims[0].evidence.length, 2);
    assert.equal(data.lead.split('\n').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topical sandbox: excess lead requires semantic split and commits nothing', () => {
  const root = sandbox();
  try {
    const src = source(root, 'long', 'The complete source confirms the long statement.\n');
    const entry = card('long-rule', 'Long rule', 'world-rule', [
      claim('long-fact', 'A'.repeat(650), 'rule', 'chapter-4', '',
        [evidence(src, 'The complete source confirms the long statement.', 1, 1)]),
    ]);
    const { code, result } = run(root, [entry]);
    assert.equal(code, 1);
    assert.equal(result.reason, 'semantic_split_required');
    assert.equal(existsSync(join(root, 'topical-generations')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topical sandbox: line drift, bad quote, and changed revisions fail before commit', () => {
  const root = sandbox();
  try {
    const src = source(root, 'drift', 'A first line.\nThe exact event happens here.\n');
    const row = card('event-line', 'Event line', 'timeline', [
      claim('event', 'The event happens.', 'actual', 'chapter-5', '',
        [evidence(src, 'The exact event happens here.', 2, 2)]),
    ]);
    writeFileSync(join(root, src.rel), 'Inserted line.\n' + src.body);
    assert.equal(run(root, [row]).result.reason, 'source_revision_mismatch');
    const updated = { ...src, revision: sha('Inserted line.\n' + src.body) };
    row.claims[0].evidence = [evidence(updated, 'The exact event happens here.', 2, 2)];
    assert.equal(run(root, [row]).result.reason, 'quote_outside_span');
    row.claims[0].evidence = [evidence(updated, 'The exact event happens here.', 3, 3)];
    assert.equal(run(root, [row]).code, 0);
    assert.equal(run(root, [row]).result.reason, 'generation_already_exists');
    assert.equal(readdirSync(join(root, 'topical-generations')).filter((name) => name.startsWith('.stage-')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topical sandbox: ambiguous anchors, conflicting states, and path escapes reject', () => {
  const root = sandbox();
  try {
    const src = source(root, 'duplicate', 'Shared phrase is repeated.\nShared phrase is repeated.\n');
    const base = card('shared-rule', 'Shared rule', 'world-rule', [
      claim('shared', 'Shared phrase is repeated.', 'rule', 'chapter-6', '',
        [evidence(src, 'Shared phrase is repeated.', 1, 1)]),
    ]);
    assert.equal(run(root, [base]).result.reason, 'ambiguous_quote_anchor');
    source(root, 'unique', 'A unique source observation.\n');
    const unique = { rel: 'sources/unique.md', revision: sha('A unique source observation.\n') };
    const first = card('same-subject', 'Same subject', 'entity', [
      claim('same-claim', 'A unique source observation.', 'plan', 'chapter-6', '',
        [evidence(unique, 'A unique source observation.', 1, 1)]),
    ]);
    const conflicting = card('same-subject', 'Same subject', 'entity', [
      claim('same-claim', 'A unique source observation.', 'actual', 'chapter-6', '',
        [evidence(unique, 'A unique source observation.', 1, 1)]),
    ]);
    assert.equal(run(root, [first, conflicting]).result.reason, 'conflicting_claim_identity');
    first.claims[0].evidence[0].sourcePath = '../outside.md';
    assert.equal(run(root, [first]).result.reason, 'unsafe_source_path');
    symlinkSync('/etc/hosts', join(root, 'sources', 'escape.md'));
    first.claims[0].evidence[0].sourcePath = 'sources/escape.md';
    assert.equal(run(root, [first]).result.reason, 'unsafe_source_path');
    assert.equal(existsSync(join(root, 'topical-generations')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topical sandbox: explicit marker is required', () => {
  const root = sandbox();
  try {
    rmSync(join(root, '.qmd-topical-sandbox'));
    const { code, result } = run(root, []);
    assert.equal(code, 1);
    assert.equal(result.reason, 'sandbox_marker_required');
    assert.equal(existsSync(join(root, 'topical-generations')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
