import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers/temp.mjs';

function python(script, ...args) {
  return execFileSync('python3', ['-c', script, ...args], {
    cwd: process.cwd(), encoding: 'utf8',
  }).trim();
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function revision(project, relativePath = 'docs/source.md') {
  return JSON.parse(python([
    'import json, sys',
    'from pathlib import Path',
    'sys.path.insert(0, "core")',
    'import wiki_freshness as F',
    'print(json.dumps(F.snapshot_file(Path(sys.argv[1]) / sys.argv[2])))',
  ].join('\n'), project, relativePath));
}

function check(project, card) {
  return JSON.parse(python([
    'import json, sys',
    'from pathlib import Path',
    'sys.path.insert(0, "core")',
    'import wiki_freshness as F',
    'root = Path(sys.argv[1])',
    'card = json.loads(sys.argv[2])',
    'print(json.dumps(F.check_card(card, root, [(root / "docs").resolve()])))',
  ].join('\n'), project, JSON.stringify(card)));
}

function sourceRevision(project, path = 'docs/source.md') {
  return { kind: 'file', path, collection: 'proj-docs', ...revision(project, path) };
}

function setup() {
  const project = mkdtempSync(join(tmpdir(), 'qmd-freshness-'));
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'source.md'), '# original\n');
  return project;
}

test('stable file revision makes an unchanged source fresh and changed bytes stale', () => {
  const project = setup();
  const source = join(project, 'docs', 'source.md');
  try {
    const card = { sourceRevisions: [sourceRevision(project)] };
    assert.deepEqual(check(project, card), { state: 'fresh', checked: 1 });

    writeFileSync(source, '# changed\n');
    assert.deepEqual(check(project, card), { state: 'stale', reason: 'content_hash_mismatch' });
  } finally { removeTemp(project); }
});

test('mtime-only change remains fresh because SHA-256 is the freshness proof', () => {
  const project = setup();
  const source = join(project, 'docs', 'source.md');
  try {
    const card = { sourceRevisions: [sourceRevision(project)] };
    utimesSync(source, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    assert.deepEqual(check(project, card), { state: 'fresh', checked: 1 });
  } finally { removeTemp(project); }
});

test('outside allow roots and malformed or legacy provenance fail closed as unknown', () => {
  const project = setup();
  const outside = join(tmpdir(), `qmd-freshness-outside-${process.pid}.md`);
  try {
    writeFileSync(outside, '# outside\n');
    const outsideRevision = {
      kind: 'file', path: outside, collection: 'outside',
      sha256: sha256('# outside\n'), size: Buffer.byteLength('# outside\n'), mtimeNs: 1,
    };
    assert.equal(check(project, { sourceRevisions: [outsideRevision] }).state, 'unknown');
    assert.equal(check(project, { sourceRevisions: [] }).state, 'unknown', 'legacy verified cards have no current-state proof');
    assert.equal(check(project, { reviewed: true, sourceRevisions: [] }).state, 'unknown', 'a human approval marker is not a trust substitute');
  } finally {
    try { unlinkSync(outside); } catch {}
    removeTemp(project);
  }
});

test('missing source is stale rather than authorized', () => {
  const project = setup();
  const source = join(project, 'docs', 'source.md');
  try {
    const card = { sourceRevisions: [sourceRevision(project)] };
    unlinkSync(source);
    assert.deepEqual(check(project, card), { state: 'stale', reason: 'missing' });
  } finally { removeTemp(project); }
});

test('snapshot_file refuses a file whose fstat changed during its single read', () => {
  const project = setup();
  try {
    const out = python([
      'import json, os, sys',
      'from pathlib import Path',
      'sys.path.insert(0, "core")',
      'import wiki_freshness as F',
      'path = Path(sys.argv[1]) / "docs/source.md"',
      'real_fstat = F.os.fstat',
      'calls = 0',
      'def changed_fstat(fd):',
      '    global calls',
      '    calls += 1',
      '    if calls == 2:',
      '        path.write_bytes(b"# changed after read\\n")',
      '    return real_fstat(fd)',
      'F.os.fstat = changed_fstat',
      'print(json.dumps(F.snapshot_file(path)))',
    ].join('\n'), project);
    assert.equal(out, 'null');
  } finally { removeTemp(project); }
});

test('sourceRevisions uses a closed typed YAML flow-mapping schema', () => {
  const record = {
    kind: 'file', path: 'docs/source.md', collection: 'proj-docs',
    sha256: sha256('# original\n'), size: 11, mtimeNs: 456,
  };
  const out = JSON.parse(python([
    'import json, sys',
    'sys.path.insert(0, "core")',
    'import yaml_scalars as Y',
    'record = json.loads(sys.argv[1])',
    'emitted = Y.dump_source_revisions([record])',
    'print(json.dumps({"emitted": emitted, "parsed": Y.load_source_revisions(emitted),',
    '                  "closed": Y.load_source_revisions(["{kind: file, path: docs/a.md, collection: c, sha256: ' + 'a'.repeat(64) + ', size: 1, mtimeNs: 2, extra: no}"])}))',
  ].join('\n'), JSON.stringify(record)));
  assert.deepEqual(out.parsed, [record]);
  assert.equal(out.emitted.length, 1);
  assert.deepEqual(out.closed, [], 'unknown keys must not become compiler-owned provenance');
});

test('quoted numeric fields and empty mapping entries fail closed before card freshness', () => {
  const project = setup();
  try {
    const record = sourceRevision(project);
    const emitted = JSON.parse(python([
      'import json, sys',
      'sys.path.insert(0, "core")',
      'import yaml_scalars as Y',
      'record = json.loads(sys.argv[1])',
      'flow = Y.dump_source_revisions([record])[0]',
      'quoted = flow.replace("size: " + str(record["size"]), "size: \\\"" + str(record["size"]) + "\\\"")',
      'empty = flow.replace(", sha256:", ",, sha256:")',
      'print(json.dumps({"quoted": quoted, "empty": empty,',
      '                  "quotedParsed": Y.load_source_revisions([quoted]),',
      '                  "emptyParsed": Y.load_source_revisions([empty])}))',
    ].join('\n'), JSON.stringify(record)));
    assert.deepEqual(emitted.quotedParsed, []);
    assert.deepEqual(emitted.emptyParsed, []);
    assert.equal(check(project, { sourceRevisions: [emitted.quoted] }).state, 'unknown');
    assert.equal(check(project, { sourceRevisions: [emitted.empty] }).state, 'unknown');
  } finally { removeTemp(project); }
});

test('sourceRevisions emission rejects an entire list when any sibling is invalid', () => {
  const record = {
    kind: 'file', path: 'docs/source.md', collection: 'proj-docs',
    sha256: sha256('# original\n'), size: 11, mtimeNs: 456,
  };
  const out = JSON.parse(python([
    'import json, sys',
    'sys.path.insert(0, "core")',
    'import yaml_scalars as Y',
    'record = json.loads(sys.argv[1])',
    'invalid = dict(record)',
    'invalid["size"] = "11"',
    'print(json.dumps(Y.dump_source_revisions([record, invalid])))',
  ].join('\n'), JSON.stringify(record)));
  assert.deepEqual(out, [], 'partial provenance must never be emitted');
});
