import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp, tempCacheDir } from './helpers/temp.mjs';

// update.sh main 의 notice/status/log 는 기본값이 `$HOME/.cache/qmd` 라 사용자 홈에 쌓이고,
// workdir 안에 두면 detached worker 가 cleanup 뒤에 되살린다 — tempCacheDir docstring 참고.
const CACHE_DIR = tempCacheDir('source-missing');

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

// python 스크립트를 파일로 실행한다. `bash -c "python3 -c <JSON.stringify(...)>"` 는
// 개행이 `\n` 리터럴로 들어가 python SyntaxError 가 되고, 그 실패가 try/catch 에 삼켜져
// **테스트가 아무것도 검증하지 않는 거짓 통과**가 된다(실제로 한 번 겪었다).
function runPy(dir, lines, { ulimit } = {}) {
  const script = join(dir, `run-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(script, ['import sys', 'sys.path.insert(0, "core")', ...lines].join('\n') + '\n');
  const cmd = ulimit ? `ulimit -f ${ulimit}; exec python3 ${JSON.stringify(script)}`
    : `exec python3 ${JSON.stringify(script)}`;
  return execFileSync('bash', ['-c', cmd], { cwd: process.cwd(), encoding: 'utf8' });
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
  } finally { removeTemp(dir); }
});

test('source scan: 상태가 그대로면 재실행이 원장을 늘리지 않는다', () => {
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    runScan(dir);
    runScan(dir);
    runScan(dir);
    assert.equal(ledger(dir).length, 1);
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
    } finally { removeTemp(enabled); }
  } finally { removeTemp(dir); }
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
    assert.equal(entry.trusted, true);
    assert.equal('reviewed' in entry, false);
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
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
  } finally { removeTemp(dir); }
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
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, QMD_CACHE_DIR: CACHE_DIR };
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
  } finally { removeTemp(work); }
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

// ─────────────────────────────────────────────────────────────────────────────
// 리뷰 반영 (major 3 + minor 4)
// ─────────────────────────────────────────────────────────────────────────────

test('repair 쓰기 실패에서도 원본 카드가 온전히 남는다 (temp + os.replace)', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', 'live.md'), 'x\n');
    const card = writeCard(dir, 'entities/big.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    // 카드를 크게 만들어 쓰기 상한(ulimit -f)에 확실히 걸리게 한다.
    writeFileSync(card, readFileSync(card, 'utf8') + 'x'.repeat(400 * 1024) + '\n');
    const before = readFileSync(card, 'utf8');

    let out = '';
    try {
      // `ulimit -f 4` = 4 블록(2KB) 초과 쓰기 실패 → ENOSPC/quota/EFBIG와 같은 코드 경로.
      execFileSync('bash', ['-c',
        `ulimit -f 4; exec python3 core/wiki_source_repair.py --cwd ${JSON.stringify(dir)} ` +
        '--repoint .auto-context/wiki/entities/big.md --from docs/gone.md --to docs/live.md'],
        { cwd: process.cwd(), encoding: 'utf8' });
      assert.fail('쓰기 상한 아래에서는 실패해야 한다');
    } catch (err) {
      out = String(err.stdout || '');
    }
    assert.equal(JSON.parse(out.trim().split('\n').pop()).error, 'card_unwritable');
    assert.equal(readFileSync(card, 'utf8'), before, '실패 반환과 디스크 상태가 일치해야 한다');
    // 임시파일이 남지 않는다.
    const leftovers = readdirSync(join(dir, '.auto-context', 'wiki', 'entities'))
      .filter((name) => name.includes('.repair.tmp'));
    assert.deepEqual(leftovers, []);
  } finally { removeTemp(dir); }
});

test('resolved 전이: 소스가 복원되면 대기에서 빠지고, 다시 사라지면 재감지된다', () => {
  const dir = setupProject();
  try {
    const source = join(dir, 'docs', 'old-07-20.md');
    writeFileSync(source, 'orig\n');
    writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/old-07-20.md')] });
    // 1) 소실
    rmSync(source);
    assert.equal(runScan(dir).recorded, 1);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 1);
    // 2) 복원(개명 되돌리기·git checkout) → pending 0
    writeFileSync(source, 'restored\n');
    const back = runScan(dir);
    assert.equal(back.resolved, 1);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0, '복원되면 대기에서 빠져야 한다');
    assert.equal(ledger(dir).at(-1).action, 'resolved');
    // 3) 다시 소실 → 재감지
    rmSync(source);
    assert.equal(runScan(dir).recorded, 1);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 1);
    // 4) 건강한 상태에서 스캔을 반복해도 resolved 행이 쌓이지 않는다
    writeFileSync(source, 'again\n');
    runScan(dir);
    const rows = ledger(dir).length;
    runScan(dir);
    runScan(dir);
    assert.equal(ledger(dir).length, rows, '건강한 카드에는 행을 쌓지 않는다');
  } finally { removeTemp(dir); }
});

test('resolved 전이가 dismiss 억제를 재무장한다 (같은 소실 집합이 다시 나타나도 감지)', () => {
  const dir = setupProject();
  try {
    const source = join(dir, 'docs', 'gone.md');
    writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    runScan(dir);
    runRepair(dir, ['--dismiss', '.auto-context/wiki/entities/a.md']);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0);
    // 복원 → resolved (dismissed 행이 더 이상 최신이 아니다)
    writeFileSync(source, 'restored\n');
    runScan(dir);
    // **같은 경로**가 다시 사라져도 이제는 감지된다 (예전엔 dismissed가 영구 억제했다).
    rmSync(source);
    assert.equal(runScan(dir).recorded, 1);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 1);
  } finally { removeTemp(dir); }
});

test('wiki_root 격리: 심볼릭 링크 wiki와 wikiPath 탈출은 repair도 스캐너와 같이 거절한다', () => {
  const dir = setupProject();
  const outside = mkdtempSync(join(tmpdir(), 'qmd-outside-'));
  try {
    writeFileSync(join(dir, 'docs', 'live.md'), 'x\n');
    // (a) .auto-context/wiki → 외부 디렉터리 심볼릭 링크
    const linked = setupProject();
    try {
      writeFileSync(join(linked, 'docs', 'live.md'), 'x\n');
      removeTemp(join(linked, '.auto-context', 'wiki'));
      symlinkSync(outside, join(linked, '.auto-context', 'wiki'));
      mkdirSync(join(outside, 'entities'), { recursive: true });
      const external = join(outside, 'entities', 'ext.md');
      const body = ['---', 'title: "E"', 'status: verified', 'sources:',
        `  - ${fileSource('docs/gone.md')}`, '---', '', 'body', ''].join('\n');
      writeFileSync(external, body);
      let out = '';
      try {
        runRepair(linked, ['--repoint', '.auto-context/wiki/entities/ext.md',
          '--from', 'docs/gone.md', '--to', 'docs/live.md']);
        assert.fail('심볼릭 링크로 root 밖을 가리키는 wiki는 거절해야 한다');
      } catch (err) { out = err.stdout; }
      assert.equal(JSON.parse(out).error, 'card_not_found');
      assert.equal(readFileSync(external, 'utf8'), body, 'root 밖 파일은 수정되지 않는다');
      // 스캐너도 같은 판정이다.
      assert.equal(runScan(linked).cards, 0);
    } finally { removeTemp(linked); }

    // (b) wikiPath: "../escwiki"
    const esc = setupProject({ compile: {} });
    try {
      const settings = JSON.parse(readFileSync(join(esc, '.auto-context', 'settings.json'), 'utf8'));
      settings.wikiPath = '../escwiki';
      writeFileSync(join(esc, '.auto-context', 'settings.json'), JSON.stringify(settings));
      writeFileSync(join(esc, 'docs', 'live.md'), 'x\n');
      const escDir = join(esc, '..', 'escwiki', 't');
      mkdirSync(escDir, { recursive: true });
      const escaped = join(escDir, 'esc.md');
      const body = ['---', 'title: "E"', 'status: verified', 'sources:',
        `  - ${fileSource('docs/gone.md')}`, '---', '', 'body', ''].join('\n');
      writeFileSync(escaped, body);
      let out = '';
      try {
        runRepair(esc, ['--repoint', '../escwiki/t/esc.md', '--from', 'docs/gone.md', '--to', 'docs/live.md']);
        assert.fail('root 밖 wikiPath는 거절해야 한다');
      } catch (err) { out = err.stdout; }
      assert.equal(JSON.parse(out).error, 'card_not_found');
      assert.equal(readFileSync(escaped, 'utf8'), body);
      removeTemp(join(esc, '..', 'escwiki'));
    } finally { removeTemp(esc); }
  } finally {
    removeTemp(outside);
    removeTemp(dir);
  }
});

test('동시 스캔이 같은 카드 행을 중복 append하지 않는다 (원장 락)', async () => {
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    const state = join(dir, '.scan-state');
    const runs = Array.from({ length: 8 }, () => new Promise((resolve) => {
      const child = spawn('python3', ['core/wiki_source_scan.py', '--cwd', dir], {
        cwd: process.cwd(),
        env: { ...process.env, QMD_SYNC_STATE_DIR: state, QMD_SOURCE_SCAN_LOG: join(dir, 'scan.log') },
        stdio: 'ignore',
      });
      child.on('close', resolve);
    }));
    await Promise.all(runs);
    const rows = ledger(dir).filter((r) => r.action === 'detected');
    assert.equal(rows.length, 1, `동시 실행에도 카드당 1행 (실제 ${rows.length})`);
  } finally { removeTemp(dir); }
});

test('비 UTF-8 원장에서도 --list/--dismiss가 뜬다 (fail-open, traceback 없음)', () => {
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    runScan(dir);
    const path = join(dir, LEDGER_REL);
    // 정상 행 + 비 UTF-8 바이트를 섞는다.
    writeFileSync(path, Buffer.concat([
      readFileSync(path),
      Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('\n', 'utf8'),
    ]));
    const listed = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(listed.ok, true);
    assert.equal(listed.pending, 1, '손상은 손상된 줄에만 국한된다');
    const dismissed = JSON.parse(runRepair(dir, ['--dismiss', '.auto-context/wiki/entities/a.md']));
    assert.equal(dismissed.ok, true);
  } finally { removeTemp(dir); }
});

test('repoint는 옛 sourceHash를 새 경로 옆에 남기지 않는다', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', 'new.md'), 'x\n');
    const card = writeCard(dir, 'entities/a.md', {
      status: 'verified',
      sources: ['{kind: "file", path: "docs/old.md", sourceHash: "abc123", collection: "proj-docs"}'],
    });
    runScan(dir);
    const applied = JSON.parse(runRepair(dir, [
      '--repoint', '.auto-context/wiki/entities/a.md', '--from', 'docs/old.md', '--to', 'docs/new.md',
    ]));
    assert.equal(applied.ok, true);
    const text = readFileSync(card, 'utf8');
    // frontmatter 구역만 본다 — auto 블록 마커의 sourceHash는 별개 필드다(건드리지 않는다).
    const fm = text.split('\n---\n')[0];
    assert.match(fm, /path: "docs\/new\.md"/);
    assert.doesNotMatch(fm, /sourceHash/, '옛 본문 해시는 거짓 기록이 되므로 제거한다');
    assert.match(fm, /collection: "proj-docs"/, '경로와 무관한 키는 보존한다');
    assert.match(text, /qmd:auto:start id="main" sourceHash="abc"/, 'auto 블록 마커는 그대로');
  } finally { removeTemp(dir); }
});

test('injectSourcePathsPerCard:0 에서도 진단 로그가 켜지면 카운터가 산다 / 꺼지면 비용 0', () => {
  // (a) 로그 off + 상한 0 → allowRoots resolve도, 분류도 하지 않는다(추가 비용 0 계약).
  const off = execFileSync('python3', ['-c', [
    'import sys, json; sys.path.insert(0, "core")',
    'import recall',
    'cfg = {"injectSourcePathsPerCard": 0, "allowRoots": ["/tmp"]}',
    'print(json.dumps([recall.source_inject_opts(cfg), recall.source_inject_opts(cfg, observe=True)], default=str))',
  ].join('\n')], { cwd: process.cwd(), encoding: 'utf8' });
  const [noObserve, observe] = JSON.parse(off);
  assert.deepEqual(noObserve, [0, [], false]);
  assert.equal(observe[0], 0);
  assert.equal(observe[2], true, '로그가 켜지면 관측 전용 모드');
  assert.ok(observe[1].length > 0, '관측 모드에서는 allowRoots를 해석한다');
});

// ─────────────────────────────────────────────────────────────────────────────
// 확인 라운드 반영 — 자동 경로 원자성 / 권한 / 판정 통일 / observe 死코드
// ─────────────────────────────────────────────────────────────────────────────

test('자동 경로(patch_frontmatter_fields)도 쓰기 실패에서 원본을 지킨다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-atomic-auto-'));
  try {
    const card = join(dir, 'card.md');
    const body = ['---', 'title: "C"', 'status: generated', '---', '', 'body line', ''].join('\n')
      + 'x'.repeat(40 * 1024) + '\n';
    writeFileSync(card, body);
    const out = runPy(dir, [
      'import wiki_compile as wc',
      'from pathlib import Path',
      `ok = wc.patch_frontmatter_fields(Path(${JSON.stringify(card)}), {"status": "verified"})`,
      'print("ok" if ok else "failed")',
    ], { ulimit: 4 });
    assert.equal(out.trim(), 'failed', '쓰기 상한 아래에서는 실패를 반환해야 한다');
    const after = readFileSync(card, 'utf8');
    assert.equal(after, body, '실패해도 원본이 바이트 그대로 남아야 한다');
    assert.match(after, /^status: generated$/m, '패치가 반영되지 않은 상태여야 한다');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
  } finally { removeTemp(dir); }
});

test('verify pass 스탬프(자동, 사람 개입 없음)가 쓰기 실패로 카드를 절단하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-atomic-verify-'));
  try {
    // wiki_verify_worker가 status: verified를 패치하는 그 경로를 직접 호출한다.
    const card = join(dir, 'v.md');
    const body = ['---', 'title: "V"', 'status: generated', 'createdBy: qmd-auto-context',
      '---', '', 'claim body', ''].join('\n') + 'y'.repeat(40 * 1024) + '\n';
    writeFileSync(card, body);
    const out = runPy(dir, [
      'import wiki_compile as wc',
      'from pathlib import Path',
      `ok = wc.patch_frontmatter_fields(Path(${JSON.stringify(card)}), {"status": "verified", "verifiedBy": "claude", "verifiedAt": "2026-07-30T00:00:00Z"})`,
      'print("ok" if ok else "failed")',
    ], { ulimit: 4 });
    assert.equal(out.trim(), 'failed');
    // 이 경로는 verify worker가 사람 개입 없이 도는 곳이다 — 절단되면 다음 회차가
    // 절단본을 읽어 changed_during_verify로 skip하고 영구 손상이 조용히 남는다.
    assert.equal(readFileSync(card, 'utf8'), body, '카드가 바이트 그대로여야 한다');
    // 상한을 풀면 정상 스탬프된다(원자적 경로가 기능을 깨지 않았다).
    assert.equal(runPy(dir, [
      'import wiki_compile as wc',
      'from pathlib import Path',
      `wc.patch_frontmatter_fields(Path(${JSON.stringify(card)}), {"status": "verified"})`,
      'print("done")',
    ]).trim(), 'done');
    assert.match(readFileSync(card, 'utf8'), /^status: verified$/m);
  } finally { removeTemp(dir); }
});

test('원자적 쓰기가 원본 권한을 보존한다 (0600 → 0600)', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', 'new.md'), 'x\n');
    const card = writeCard(dir, 'entities/secret.md', { status: 'verified', sources: [fileSource('docs/old.md')] });
    chmodSync(card, 0o600);
    runScan(dir);
    runRepair(dir, ['--repoint', '.auto-context/wiki/entities/secret.md', '--from', 'docs/old.md', '--to', 'docs/new.md']);
    assert.equal(statSync(card).mode & 0o777, 0o600, 'os.replace가 권한을 넓히면 회귀다');
    // 자동 경로(frontmatter 패치)도 같다.
    runPy(dir, [
      'import wiki_compile as wc',
      'from pathlib import Path',
      `wc.patch_frontmatter_fields(Path(${JSON.stringify(card)}), {"status": "contested"})`,
    ]);
    assert.equal(statSync(card).mode & 0o777, 0o600);
  } finally { removeTemp(dir); }
});

test('전부 소실 판정이 두 경로에서 같은 구현을 쓴다 (예산 절단은 입력 차이로만 남는다)', () => {
  const out = execFileSync('python3', ['-c', [
    'import sys, json; sys.path.insert(0, "core")',
    'import inspect, recall, wiki_source_missing as wsm',
    // 구현은 한 벌이다.
    'assert "sources_all_missing(" in inspect.getsource(wsm.all_sources_missing)',
    'assert "sources_all_missing(" in inspect.getsource(recall.card_sources_all_missing)',
    // 같은 (missing, present, undecidable) 입력이면 답이 같다.
    'cases = [(1,0,0),(0,0,0),(2,1,0),(3,0,1),(1,0,2)]',
    'rule = [recall.sources_all_missing(*c) for c in cases]',
    'wsmr = [wsm.all_sources_missing({"missing": ["x"]*m, "present": ["y"]*p, "unknown": {"z": u} if u else {}}) for m,p,u in cases]',
    'assert rule == wsmr, (rule, wsmr)',
    // recall 쪽 환산: duplicate는 판정불가가 아니고(살아 있는 경로의 중복), over_scan_budget은 판정불가다.
    'r = {"_wiki_source_reasons": {"missing": 7}, "_wiki_source_present": 0}',
    'assert recall.card_sources_all_missing(r) is True',
    'r2 = {"_wiki_source_reasons": {"missing": 6, "over_scan_budget": 1}, "_wiki_source_present": 0}',
    'assert recall.card_sources_all_missing(r2) is False',
    'print(json.dumps({"rule": rule}))',
  ].join('\n')], { cwd: process.cwd(), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out).rule, [true, false, false, false, false]);
});

test('observe 모드에서 duplicate 사유가 실제로 발화한다 (死코드 없음)', () => {
  const out = execFileSync('python3', ['-c', [
    'import sys, json, tempfile, os; sys.path.insert(0, "core")',
    'import recall',
    'from pathlib import Path',
    'root = Path(tempfile.mkdtemp()).resolve()',
    '(root / "docs").mkdir()',
    '(root / "docs" / "a.md").write_text("x")',
    'block = \'sources:\\n  - {kind: "file", path: "docs/a.md"}\\n  - {kind: "file", path: "docs/a.md"}\'',
    'inject = recall.collect_source_paths(block, root, str(root), 3, [], False)',
    'observe = recall.collect_source_paths(block, root, str(root), 0, [], True)',
    'print(json.dumps({"inject": [inject[0], inject[2], inject[3]], "observe": [observe[0], observe[2], observe[3]]}))',
  ].join('\n')], { cwd: process.cwd(), encoding: 'utf8' });
  const { inject, observe } = JSON.parse(out);
  assert.deepEqual(inject[1], { duplicate: 1 });
  assert.deepEqual(observe[1], { duplicate: 1 }, 'observe 모드에서도 중복이 집계돼야 한다');
  assert.deepEqual(observe[0], [], '관측 모드는 주입하지 않는다');
  assert.equal(inject[2], 2);
  assert.equal(observe[2], 2, 'present 집계는 두 모드가 같다');
  // over_cap은 주입 상한 전용이므로 observe 모드에서 발화하지 않는다.
  assert.ok(!('over_cap' in observe[1]));
});

test('resolved 행은 소실 목록을 담지 않는다 (남은 소실은 remainingMissing)', () => {
  const dir = setupProject();
  try {
    const a = join(dir, 'docs', 'a.md');
    writeCard(dir, 'entities/two.md', {
      status: 'verified',
      sources: [fileSource('docs/a.md'), fileSource('docs/b.md')],
    });
    runScan(dir);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 1);
    writeFileSync(a, 'restored\n');   // 하나만 복원 → 부분 소실 → 대기 대상 아님
    runScan(dir);
    const last = ledger(dir).at(-1);
    assert.equal(last.action, 'resolved');
    assert.deepEqual(last.missingSources, [], 'resolved 행에 소실 목록이 있으면 자기모순이다');
    assert.deepEqual(last.remainingMissing, ['docs/b.md']);
  } finally { removeTemp(dir); }
});

test('동시 repoint에서 원장이 거짓 기록을 남기지 않는다 (락 안 read-modify-write)', async () => {
  const dir = setupProject();
  try {
    for (const n of ['1', '2', '3', '4', '5', '6']) writeFileSync(join(dir, 'docs', `new-${n}.md`), `${n}\n`);
    const card = writeCard(dir, 'entities/race.md', {
      status: 'verified',
      sources: ['1', '2', '3', '4', '5', '6'].map((n) => fileSource(`docs/old-${n}.md`)),
    });
    runScan(dir);
    await Promise.all(['1', '2', '3', '4', '5', '6'].map((n) => new Promise((resolve) => {
      const child = spawn('python3', ['core/wiki_source_repair.py', '--cwd', dir,
        '--repoint', '.auto-context/wiki/entities/race.md',
        '--from', `docs/old-${n}.md`, '--to', `docs/new-${n}.md`],
        { cwd: process.cwd(), stdio: 'ignore' });
      child.on('close', resolve);
    })));
    const text = readFileSync(card, 'utf8');
    const rows = ledger(dir).filter((r) => r.action === 'repointed');
    // 원장이 주장하는 재지정은 전부 카드에 반영돼 있어야 한다(거짓 기록 금지).
    for (const row of rows) {
      assert.match(text, new RegExp(`path: "${row.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
        `원장은 ${row.to} 재지정을 기록했는데 카드에 없다`);
    }
    assert.ok(rows.length >= 1);
  } finally { removeTemp(dir); }
});

test('동시 dismiss는 원장에 한 줄만 남긴다', async () => {
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/d.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    runScan(dir);
    await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve) => {
      const child = spawn('python3', ['core/wiki_source_repair.py', '--cwd', dir,
        '--dismiss', '.auto-context/wiki/entities/d.md'], { cwd: process.cwd(), stdio: 'ignore' });
      child.on('close', resolve);
    })));
    assert.equal(ledger(dir).filter((r) => r.action === 'dismissed').length, 1);
  } finally { removeTemp(dir); }
});

test('repair CLI 예외는 원인을 로그 파일에 남긴다 (stdout은 JSON 한 줄)', () => {
  const dir = setupProject();
  const logFile = join(dir, 'repair.log');
  try {
    let out = '';
    try {
      // classify_card가 예외를 던지도록 wikiPath를 파일로 만든다(디렉터리가 아님).
      execFileSync('python3', ['-c', [
        'import sys, json; sys.path.insert(0, "core")',
        'import wiki_source_repair as r',
        'r.main = lambda: (_ for _ in ()).throw(RuntimeError("boom-detail"))',
        'sys.exit(r.run_guarded())',
      ].join('\n')], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, QMD_SOURCE_SCAN_LOG: logFile },
      });
      assert.fail('예외 경로는 non-zero여야 한다');
    } catch (err) { out = err.stdout; }
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.detail, /RuntimeError: boom-detail/, '원인을 잃지 않는다');
    assert.equal(parsed.log, logFile);
    assert.match(readFileSync(logFile, 'utf8'), /REPAIR EXCEPTION[\s\S]*boom-detail/);
    assert.doesNotMatch(out, /Traceback/, 'stdout은 JSON 한 줄이어야 한다');
  } finally { removeTemp(dir); }
});

test('index.md 쓰기 실패에서 누적 인덱스가 온전히 남는다 / 정상 append는 불변 / log는 append 그대로', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-index-'));
  try {
    const wiki = join(dir, 'wiki');
    mkdirSync(join(wiki, 'concepts'), { recursive: true });
    writeFileSync(join(wiki, 'concepts', 'new.md'), 'card\n');
    // 누적 인덱스(라이브는 106KB / 850줄)
    const existing = '# Auto-context Wiki Index\n\n'
      + Array.from({ length: 900 }, (_, i) => `- concepts/old-${i}.md - 카드 ${i}`).join('\n') + '\n';
    writeFileSync(join(wiki, 'index.md'), existing);
    writeFileSync(join(wiki, 'log.md'), '# Auto-context Wiki Log\n\n- old log line\n');

    const call = (limit) => runPy(dir, [
      'import wiki_compile as wc',
      'from pathlib import Path',
      `wiki = Path(${JSON.stringify(wiki)})`,
      'ok = wc.update_index(wiki, wiki / "concepts" / "new.md", "새 카드")',
      'wc.append_log(wiki, "created", wiki / "concepts" / "new.md", "새 카드")',
      'print("ok" if ok else "failed")',
    ], limit ? { ulimit: limit } : {}).trim();

    // (a) 쓰기 상한 아래: 실패를 반환하고 기존 인덱스는 그대로다.
    assert.equal(call(4), 'failed');
    assert.equal(readFileSync(join(wiki, 'index.md'), 'utf8'), existing, '누적 인덱스가 절단되면 안 된다');
    assert.deepEqual(readdirSync(wiki).filter((n) => n.includes('.tmp-')), []);
    // append 모드인 log는 상한 아래에서도 truncate되지 않는다.
    assert.match(readFileSync(join(wiki, 'log.md'), 'utf8'), /^# Auto-context Wiki Log/);
    assert.match(readFileSync(join(wiki, 'log.md'), 'utf8'), /- old log line/);

    // (b) 정상 경로: 한 줄 append + 중복 호출은 늘리지 않는다(기존 동작 불변).
    assert.equal(call(0), 'ok');
    const after = readFileSync(join(wiki, 'index.md'), 'utf8');
    assert.equal(after.split('\n').filter((l) => l.includes('concepts/new.md')).length, 1);
    assert.ok(after.startsWith('# Auto-context Wiki Index'));
    assert.equal(after.split('\n').filter((l) => l.startsWith('- concepts/old-')).length, 900);
    assert.equal(call(0), 'ok');
    assert.equal(readFileSync(join(wiki, 'index.md'), 'utf8'), after, '중복 줄을 추가하지 않는다');
    // log는 호출마다 한 줄씩 늘어난다(append 계약).
    assert.equal(readFileSync(join(wiki, 'log.md'), 'utf8')
      .split('\n').filter((l) => l.includes('created')).length, 3);
  } finally { removeTemp(dir); }
});
