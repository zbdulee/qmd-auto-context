import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const LEDGER_REL = '.auto-context/compile/source-missing.jsonl';

function repoTemp(prefix) {
  // update.sh 경로 테스트는 /private/tmp가 risky_path로 거부되므로 HOME 하위를 쓴다
  // (test/update.test.mjs의 repoTemp와 같은 이유).
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `qmd-test-${prefix}-`));
}

function setupProject({ compile = {}, indexing = true, base } = {}) {
  const dir = base || mkdtempSync(join(tmpdir(), 'qmd-srcmiss-'));
  mkdirSync(join(dir, '.auto-context', 'wiki', 'entities'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing,
    collections: ['proj-docs', 'proj-wiki'],
    collectionPaths: { 'proj-docs': 'docs', 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-docs': 'raw', 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: { enabled: true, mode: 'auto-wiki', ...compile },
  }));
  return dir;
}

function writeCard(dir, rel, { status = 'generated', sources = [], title = 'Card' } = {}) {
  const full = join(dir, '.auto-context', 'wiki', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  const lines = ['---', `title: "${title}"`, `status: ${status}`, 'createdBy: qmd-auto-context'];
  if (sources.length) {
    lines.push('sources:');
    for (const src of sources) lines.push(`  - ${src}`);
  }
  lines.push('---', '', '<!-- qmd:auto:start id="main" sourceHash="abc" -->', '## Summary', 'body', '<!-- qmd:auto:end -->', '');
  writeFileSync(full, lines.join('\n'));
  return full;
}

function fileSource(path) {
  return `{kind: "file", path: "${path}"}`;
}

function runScan(dir, env = {}) {
  const state = join(dir, '.scan-state');
  const out = execFileSync('python3', ['core/wiki_source_scan.py', '--cwd', dir, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      QMD_SYNC_STATE_DIR: state,
      QMD_SOURCE_SCAN_LOG: join(dir, 'scan.log'),
      ...env,
    },
  });
  return out.trim() ? JSON.parse(out) : {};
}

function runRepair(dir, args) {
  return execFileSync('python3', ['core/wiki_source_repair.py', '--cwd', dir, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function ledger(dir) {
  const path = join(dir, LEDGER_REL);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('source scan: 소스 전부 소실만 감지한다 (verified·generated 구분, 일부 소실·메타카드 제외)', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', 'live.md'), 'alive\n');
    writeCard(dir, 'entities/all-gone-verified.md', { status: 'verified', sources: [fileSource('docs/2026-07-20.md')] });
    writeCard(dir, 'entities/all-gone-generated.md', { status: 'generated', sources: [fileSource('docs/vanished.md')] });
    writeCard(dir, 'entities/partial.md', { status: 'verified', sources: [fileSource('docs/live.md'), fileSource('docs/gone.md')] });
    writeCard(dir, 'entities/meta.md', { status: 'verified', sources: ['{kind: "unknown"}'] });
    writeCard(dir, 'entities/no-sources.md', { status: 'verified' });

    const result = runScan(dir);
    assert.equal(result.detected, 2, '전부 소실 카드만 감지');
    const rows = ledger(dir);
    assert.equal(rows.length, 2);
    const byTarget = Object.fromEntries(rows.map((r) => [r.targetPath, r]));
    const verified = byTarget['.auto-context/wiki/entities/all-gone-verified.md'];
    const generated = byTarget['.auto-context/wiki/entities/all-gone-generated.md'];
    assert.equal(verified.status, 'verified', 'status를 기록해 검수 카드를 구분할 수 있어야 한다');
    assert.equal(generated.status, 'generated');
    assert.deepEqual(verified.missingSources, ['docs/2026-07-20.md']);
    assert.equal(verified.action, 'detected');
    assert.equal(verified.origin, 'scan');
    assert.ok(!('content' in verified) && !('body' in verified), '원문 본문은 원장에 담지 않는다');
    // 카드는 절대 수정·삭제되지 않는다(자동 삭제·downgrade 금지).
    for (const rel of ['entities/all-gone-verified.md', 'entities/partial.md']) {
      assert.equal(existsSync(join(dir, '.auto-context', 'wiki', rel)), true);
    }
    assert.match(readFileSync(join(dir, '.auto-context', 'wiki', 'entities/all-gone-verified.md'), 'utf8'), /^status: verified$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source scan: 상태가 그대로면 재실행이 원장을 늘리지 않는다', () => {
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    runScan(dir);
    runScan(dir);
    runScan(dir);
    assert.equal(ledger(dir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source scan: 소실 집합이 바뀌면 새 행을 남긴다', () => {
  const dir = setupProject();
  try {
    const card = writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone-1.md')] });
    runScan(dir);
    writeFileSync(card, readFileSync(card, 'utf8').replace('docs/gone-1.md', 'docs/gone-2.md'));
    runScan(dir);
    const rows = ledger(dir);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1].missingSources, ['docs/gone-2.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source scan: 원장은 트림 대상이 아니다 (256KB 초과 이력이 보존된다)', () => {
  const dir = setupProject();
  try {
    mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
    const filler = [];
    for (let i = 0; i < 3000; i += 1) {
      filler.push(JSON.stringify({
        targetPath: `.auto-context/wiki/entities/old-${i}.md`,
        action: 'dismissed',
        status: 'verified',
        missingSources: [`docs/old-${i}.md`],
        origin: 'scan',
        ts: '2026-01-01T00:00:00Z',
        pad: 'x'.repeat(60),
      }));
    }
    writeFileSync(join(dir, LEDGER_REL), filler.join('\n') + '\n');
    const before = statSync(join(dir, LEDGER_REL)).size;
    assert.ok(before > 256 * 1024, `원장이 트림 임계(256KB)를 넘어야 의미 있는 검증: ${before}`);

    writeCard(dir, 'entities/new.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    runScan(dir);

    const rows = ledger(dir);
    assert.equal(rows.length, filler.length + 1, '기존 행이 하나도 잘려나가지 않아야 한다');
    assert.equal(rows[0].targetPath, '.auto-context/wiki/entities/old-0.md');
    assert.equal(rows[rows.length - 1].targetPath, '.auto-context/wiki/entities/new.md');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source scan: 비용 상한을 넘는 카드는 다음 회차로 이월된다(순환 커서)', () => {
  const dir = setupProject();
  try {
    for (const name of ['a', 'b', 'c']) {
      writeCard(dir, `entities/${name}.md`, { status: 'verified', sources: [fileSource(`docs/gone-${name}.md`)] });
    }
    const first = runScan(dir, { QMD_SOURCE_SCAN_MAX: '1' });
    assert.equal(first.cards, 3);
    assert.equal(first.examined, 1, '한 회차에 상한만큼만 검사');
    runScan(dir, { QMD_SOURCE_SCAN_MAX: '1' });
    runScan(dir, { QMD_SOURCE_SCAN_MAX: '1' });
    const targets = ledger(dir).map((r) => r.targetPath).sort();
    assert.deepEqual(targets, [
      '.auto-context/wiki/entities/a.md',
      '.auto-context/wiki/entities/b.md',
      '.auto-context/wiki/entities/c.md',
    ].map((p) => p), '세 회차에 걸쳐 전량이 덮인다');
    // 한 바퀴를 더 돌아도 상태가 그대로면 행이 늘지 않는다.
    runScan(dir, { QMD_SOURCE_SCAN_MAX: '1' });
    assert.equal(ledger(dir).length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source scan: index.md/log.md와 superseded·discarded 카드는 검사 대상이 아니다', () => {
  const dir = setupProject();
  try {
    writeCard(dir, 'index.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    writeCard(dir, 'log.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    writeCard(dir, 'entities/old.md', { status: 'superseded', sources: [fileSource('docs/gone.md')] });
    writeCard(dir, 'entities/dropped.md', { status: 'discarded', sources: [fileSource('docs/gone.md')] });
    const result = runScan(dir);
    assert.equal(result.detected, 0);
    assert.equal(ledger(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source scan: 지원하지 않는 sources 표기는 소실로 오분류하지 않는다', () => {
  const dir = setupProject();
  try {
    // block mapping(미지원 표기) — "원문이 없다"가 아니라 "판정 불가"다.
    const full = join(dir, '.auto-context', 'wiki', 'entities', 'block.md');
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, [
      '---', 'title: "B"', 'status: verified', 'sources:', '  - kind: file',
      '    path: docs/gone.md', '---', '', 'body', '',
    ].join('\n'));
    const result = runScan(dir);
    assert.equal(result.detected, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source scan: opt-out 프로젝트와 sandbox에서는 무동작', () => {
  const dir = setupProject({ indexing: false });
  try {
    writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    assert.equal(runScan(dir).detected, 0);
    assert.equal(existsSync(join(dir, LEDGER_REL)), false);

    const enabled = setupProject();
    try {
      writeCard(enabled, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
      const out = execFileSync('python3', ['core/wiki_source_scan.py', '--cwd', enabled, '--json'], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, QMD_SANDBOX: '1', QMD_SYNC_STATE_DIR: join(enabled, '.state') },
      });
      assert.equal(out.trim(), '', 'sandbox는 즉시 무출력 종료');
      assert.equal(existsSync(join(enabled, LEDGER_REL)), false);
    } finally { rmSync(enabled, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source repair: 개명 후보를 제안하고 사람이 지정한 재지정만 적용한다', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', '2026-07-21.md'), 'renamed\n');
    const card = writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/2026-07-20.md')] });
    runScan(dir);

    const listed = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(listed.pending, 1);
    const entry = listed.entries[0];
    assert.equal(entry.reviewed, true);
    assert.deepEqual(entry.candidates['docs/2026-07-20.md'].map((c) => c.path), ['docs/2026-07-21.md']);
    // 제안만 했고 카드는 아직 그대로다(자동 재지정 금지).
    assert.match(readFileSync(card, 'utf8'), /docs\/2026-07-20\.md/);

    const applied = JSON.parse(runRepair(dir, [
      '--repoint', '.auto-context/wiki/entities/a.md',
      '--from', 'docs/2026-07-20.md', '--to', 'docs/2026-07-21.md',
    ]));
    assert.equal(applied.ok, true);
    const text = readFileSync(card, 'utf8');
    assert.match(text, /- \{kind: "file", path: "docs\/2026-07-21\.md"\}/);
    assert.match(text, /^status: verified$/m, 'status는 건드리지 않는다');
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0);
    // 고친 뒤 재스캔해도 다시 대기로 올라오지 않는다.
    runScan(dir);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source repair: 존재하지 않는 대상으로는 재지정하지 않는다', () => {
  const dir = setupProject();
  try {
    const card = writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    runScan(dir);
    let out = '';
    try {
      runRepair(dir, ['--repoint', '.auto-context/wiki/entities/a.md', '--from', 'docs/gone.md', '--to', 'docs/nope.md']);
      assert.fail('없는 경로 재지정은 실패해야 한다');
    } catch (err) {
      out = err.stdout;
    }
    assert.equal(JSON.parse(out).error, 'new_source_missing');
    assert.match(readFileSync(card, 'utf8'), /docs\/gone\.md/, '카드는 그대로');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source repair: dismiss는 소실 집합이 바뀔 때까지 재알림을 멈춘다', () => {
  const dir = setupProject();
  try {
    const card = writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    runScan(dir);
    JSON.parse(runRepair(dir, ['--dismiss', '.auto-context/wiki/entities/a.md']));
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0);
    runScan(dir);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0, 'dismiss는 sticky');
    // 소실 집합이 바뀌면 다시 알린다.
    writeFileSync(card, readFileSync(card, 'utf8').replace('docs/gone.md', 'docs/other-gone.md'));
    runScan(dir);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source repair: 일부만 재지정하면 대기에서 빠진다(살아 있는 원문이 생겼으므로) — 남은 소실은 보고한다', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', 'found.md'), 'x\n');
    writeCard(dir, 'entities/a.md', {
      status: 'verified',
      sources: [fileSource('docs/gone-1.md'), fileSource('docs/gone-2.md')],
    });
    runScan(dir);
    const applied = JSON.parse(runRepair(dir, [
      '--repoint', '.auto-context/wiki/entities/a.md',
      '--from', 'docs/gone-1.md', '--to', 'docs/found.md',
    ]));
    assert.deepEqual(applied.stillMissing, ['docs/gone-2.md'], '남은 깨진 링크를 사용자에게 알린다');
    // 스캐너와 같은 규칙: 살아 있는 파일 소스가 하나라도 있으면 "전부 소실"이 아니다
    // (대조 가능한 원문이 있으므로 "stale 링크가 유일 진실"이 성립하지 않는다).
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0);
    runScan(dir);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source repair: 미지원 표기는 재작성하지 않고 거부한다', () => {
  const dir = setupProject();
  try {
    const full = join(dir, '.auto-context', 'wiki', 'entities', 'inline.md');
    mkdirSync(join(full, '..'), { recursive: true });
    const original = ['---', 'title: "I"', 'status: verified',
      'sources: [{kind: "file", path: "docs/gone.md"}]', '---', '', 'body', ''].join('\n');
    writeFileSync(full, original);
    writeFileSync(join(dir, 'docs', 'live.md'), 'x\n');
    let out = '';
    try {
      runRepair(dir, ['--repoint', '.auto-context/wiki/entities/inline.md', '--from', 'docs/gone.md', '--to', 'docs/live.md']);
      assert.fail('미지원 표기는 거부해야 한다');
    } catch (err) { out = err.stdout; }
    assert.equal(JSON.parse(out).error, 'source_entry_not_found');
    assert.equal(readFileSync(full, 'utf8'), original, '카드를 재작성하지 않는다');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SessionStart: 대기 건수를 1줄 표면화하고 TTL로 억제, 해소되면 재무장한다', () => {
  const work = repoTemp('source-missing-notice');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'home');
  try {
    setupProject({ base: work });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(join(work, LEDGER_REL), [
      JSON.stringify({ targetPath: '.auto-context/wiki/entities/a.md', action: 'detected', status: 'verified', missingSources: ['docs/x.md'], origin: 'scan', ts: '2026-07-29T00:00:00Z' }),
      JSON.stringify({ targetPath: '.auto-context/wiki/entities/b.md', action: 'detected', status: 'generated', missingSources: ['docs/y.md'], origin: 'scan', ts: '2026-07-29T00:00:00Z' }),
    ].join('\n') + '\n');
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, QMD_CACHE_DIR: fakeHome };
    const run = () => execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8', input: JSON.stringify({ cwd: work }), env,
    });

    const out = run();
    assert.match(out, /원문 소실 2건 대기\(검수 카드 1건\)/);
    assert.match(out, /wiki-source-repair/);
    // 모델용 spawn 힌트는 두지 않는다(복구는 사람 확인이 필요한 판단).
    assert.doesNotMatch(out, /subagent_type/);

    assert.doesNotMatch(run(), /원문 소실/, 'TTL 안에서는 억제');

    // 전부 resolve되면 marker가 정리돼 재발 시 다시 알린다.
    writeFileSync(join(work, LEDGER_REL), readFileSync(join(work, LEDGER_REL), 'utf8') + [
      JSON.stringify({ targetPath: '.auto-context/wiki/entities/a.md', action: 'dismissed', status: 'verified', missingSources: ['docs/x.md'], origin: 'repair', ts: '2026-07-29T01:00:00Z' }),
      JSON.stringify({ targetPath: '.auto-context/wiki/entities/b.md', action: 'repointed', status: 'generated', missingSources: [], origin: 'repair', ts: '2026-07-29T01:00:00Z' }),
    ].join('\n') + '\n');
    assert.doesNotMatch(run(), /원문 소실/, '대기 0이면 무출력');
    writeFileSync(join(work, LEDGER_REL), readFileSync(join(work, LEDGER_REL), 'utf8') +
      JSON.stringify({ targetPath: '.auto-context/wiki/entities/a.md', action: 'detected', status: 'verified', missingSources: ['docs/z.md'], origin: 'scan', ts: '2026-07-29T02:00:00Z' }) + '\n');
    assert.match(run(), /원문 소실 1건 대기\(검수 카드 1건\)/, '조건 재발 시 다시 알린다');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('source_missing 판정은 recall의 존재 판정을 재사용한다(두 벌 금지)', () => {
  const out = execFileSync('python3', ['-c', [
    'import sys; sys.path.insert(0, "core")',
    'import inspect, recall, wiki_source_missing as wsm',
    // 존재 판정 SSOT: 두 분류 함수가 모두 recall의 함수를 호출한다.
    'src = inspect.getsource(wsm.classify_entries) + inspect.getsource(wsm.classify_records)',
    'assert "classify_source_entry" in src and "resolve_existing_source" in src, src',
    'assert "classify_source_entry(entry, project_root, allow_roots)" in inspect.getsource(recall.resolve_source_path)',
    'print("ok")',
  ].join('\n')], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(out.trim(), 'ok');
});
