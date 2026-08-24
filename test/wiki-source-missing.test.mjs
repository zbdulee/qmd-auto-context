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

function writeCard(dir, rel, {
  status = 'generated', sources = [], title = 'Card', createdBy = 'qmd-auto-context',
  sourceRevisions = status === 'verified',
} = {}) {
  const full = join(dir, '.auto-context', 'wiki', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  const lines = ['---', `title: "${title}"`, `status: ${status}`, `createdBy: ${createdBy}`];
  if (sources.length) {
    lines.push('sources:');
    for (const src of sources) lines.push(`  - ${src}`);
  }
  if (sourceRevisions) {
    lines.push('sourceRevisions:');
    lines.push('  - {kind: "file", path: "docs/compiler-source.md", collection: "proj-docs", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", size: 1, mtimeNs: 1}');
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

function runPendingSummary(dir) {
  return JSON.parse(execFileSync('python3', [
    'core/wiki_source_missing.py', '--cwd', dir, '--pending-summary',
  ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }));
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

// `compile.sourceScan`은 정규화 화이트리스트 밖이라 **한 번도 읽힌 적이 없었다**(계획
// 2026-08-19 §3.4). 값 규칙은 test/config.test.mjs가 보고, 여기서는 **종점**을 본다 —
// 정규화 출력이 실제로 스캐너의 동작을 바꾸는지. 단위 테스트만으로는 "화이트리스트에
// 넣었지만 소비자가 다른 자리를 읽는다"를 잡지 못한다.
test('source scan: compile.sourceScan이 실제로 스캐너 동작을 바꾼다 (enabled·창·env 우선순위)', () => {
  const off = setupProject({ compile: { sourceScan: { enabled: false } } });
  try {
    writeCard(off, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone.md')] });
    const result = runScan(off, { QMD_SOURCE_SCAN_MAX: '' });
    assert.equal(result.examined, 0, 'enabled:false면 소실 판정을 하지 않는다');
    assert.equal(result.detected, 0);
    assert.equal(result.recorded, 0);
    assert.equal(existsSync(join(off, LEDGER_REL)), false, '원장을 만들지 않는다');
    assert.match(readFileSync(join(off, 'scan.log'), 'utf8'), /SKIP: compile\.sourceScan\.enabled is false/);
  } finally { removeTemp(off); }

  // 창(maxCardsPerScan)도 설정에서 읽는다 — 예전에는 env만 유효했다.
  const narrow = setupProject({ compile: { sourceScan: { maxCardsPerScan: 1 } } });
  try {
    writeCard(narrow, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone-a.md')] });
    writeCard(narrow, 'entities/b.md', { status: 'verified', sources: [fileSource('docs/gone-b.md')] });
    const first = runScan(narrow, { QMD_SOURCE_SCAN_MAX: '' });
    assert.equal(first.cards, 2);
    assert.equal(first.examined, 1, '창이 1이면 한 회차에 1장만 본다');
    // env는 명시적 디버그 레버라 설정보다 우선한다(문서화된 우선순위).
    const wide = runScan(narrow, { QMD_SOURCE_SCAN_MAX: '2' });
    assert.equal(wide.examined, 2, 'QMD_SOURCE_SCAN_MAX가 설정 창을 덮는다');
  } finally { removeTemp(narrow); }
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

test('source repair: 사라진 카드는 대기에서 빠진다 (유령 행 방지)', () => {
  // 원장은 append-only 이고 스캐너는 **존재하는 카드만** 훑는다. 그래서 사람이 카드를
  // 지우면 그 카드의 `detected` 행이 최신 상태로 영원히 남아 대기 수를 부풀리고,
  // SessionStart 알림이 없는 카드를 계속 지시한다. 라이브 실측으로 261건 중 79건이
  // 이미 없는 카드였다(ktlo-check 는 50건 중 49건). 원장에 `dismissed` 를 써서 지우는
  // 방법도 있지만 사람이 카드를 지우는 시점에 이 코드가 실행되지 않으므로 성립하지 않는다.
  const dir = setupProject();
  try {
    const a = writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/gone-a.md')] });
    writeCard(dir, 'entities/b.md', { status: 'verified', sources: [fileSource('docs/gone-b.md')] });
    runScan(dir);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 2, '둘 다 대기');

    rmSync(a);
    const listed = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(listed.pending, 1, '사라진 카드는 대기에서 빠진다');
    assert.deepEqual(listed.entries.flatMap((e) => e.cards.map((c) => c.targetPath)),
      ['.auto-context/wiki/entities/b.md'], '남은 카드만 목록에 온다');
    // 원장 행은 그대로다(감사 추적) — 걸러내는 것은 읽는 쪽이다.
    const ledger = join(dir, '.auto-context', 'compile', 'source-missing.jsonl');
    assert.match(readFileSync(ledger, 'utf8'), /entities\/a\.md/, '원장에는 흔적이 남는다');
  } finally { removeTemp(dir); }
});

test('source repair: 개명 후보를 제안하고 사람이 지정한 재지정만 적용한다', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', '2026-07-21.md'), 'renamed\n');
    const card = writeCard(dir, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/2026-07-20.md')] });
    runScan(dir);

    const listed = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(listed.pending, 1, 'pending 은 여전히 카드 수다');
    assert.equal(listed.groups, 1, '소실 파일 1개 = 그룹 1개');
    const entry = listed.entries[0];
    assert.equal(entry.missingSource, 'docs/2026-07-20.md');
    assert.equal(entry.cardCount, 1);
    assert.equal(entry.trustedCount, 1);
    assert.equal('reviewed' in entry.cards[0], false);
    assert.deepEqual(entry.candidates.map((c) => c.path), ['docs/2026-07-21.md']);
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

test('source missing trust labels and pending counts use recall ownership + provenance boundary', () => {
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/trusted.md', {
      status: 'verified', sources: [fileSource('docs/trusted-gone.md')],
    });
    writeCard(dir, 'entities/foreign.md', {
      status: 'verified', createdBy: 'foreign-tool',
      sources: [fileSource('docs/foreign-gone.md')],
    });
    writeCard(dir, 'entities/provenance-free.md', {
      status: 'verified', sourceRevisions: false,
      sources: [fileSource('docs/provenance-free-gone.md')],
    });
    writeCard(dir, 'entities/generated.md', {
      status: 'generated', sourceRevisions: true,
      sources: [fileSource('docs/generated-gone.md')],
    });
    runScan(dir);

    const listed = JSON.parse(runRepair(dir, ['--list']));
    const trustByTarget = Object.fromEntries(
      listed.entries.flatMap((entry) => entry.cards.map((c) => [c.targetPath, c.trusted])),
    );
    assert.equal(trustByTarget['.auto-context/wiki/entities/trusted.md'], true);
    assert.equal(trustByTarget['.auto-context/wiki/entities/foreign.md'], false);
    assert.equal(trustByTarget['.auto-context/wiki/entities/provenance-free.md'], false);
    assert.equal(trustByTarget['.auto-context/wiki/entities/generated.md'], false);

    const summary = runPendingSummary(dir);
    assert.equal(summary.pending, 4);
    assert.equal(summary.verified, 1,
      'legacy field name counts only currently auto-trusted cards, not status-only verified cards');
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
    // 합성 원장과 **카드의 실제 소스 상태를 일치**시킨다. 예전 주석은 "sources를 비워 두면
    // detached 스캐너가 이 원장을 못 건드린다"였는데 가정이 정반대였다 — 소스 항목 0은
    // "전부 소실"이 아니라 판정 불가라, 스캐너는 `detected`를 취소하는 `resolved` 행을
    // 매 run append한다. 그래서 이 테스트는 detached worker와 동기 notice 읽기 사이의
    // 레이스를 이기고 있었을 뿐이고, 동기 경로에 latency가 조금만 붙으면(측정: worker가
    // 47ms 승) `pending=0`이 되어 notice 대신 notice_clear가 돌고 출력이 빈다.
    // 스캐너 동작은 옳다(영구 대기·거짓 알림을 막는 전이). 픽스처를 물리적으로 모순 없게
    // 만들어 스캐너 판정이 매 단계 원장과 같아지게 한다.
    writeCard(work, 'entities/a.md', { status: 'verified', sources: [fileSource('docs/x.md')] });
    writeCard(work, 'entities/b.md', { status: 'generated', sources: [fileSource('docs/y.md')] });
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
    // 원장의 resolve와 **실제 파일 상태를 함께** 움직인다 — 원장만 바꾸면 스캐너가
    // 카드를 보고 원장을 되돌려 위와 같은 레이스가 다시 생긴다.
    writeFileSync(join(work, 'docs', 'x.md'), 'x\n');
    writeFileSync(join(work, 'docs', 'y.md'), 'y\n');
    writeFileSync(join(work, LEDGER_REL), readFileSync(join(work, LEDGER_REL), 'utf8') + [
      JSON.stringify({ targetPath: '.auto-context/wiki/entities/a.md', action: 'dismissed', status: 'verified', missingSources: ['docs/x.md'], origin: 'repair', ts: '2026-07-29T01:00:00Z' }),
      JSON.stringify({ targetPath: '.auto-context/wiki/entities/b.md', action: 'repointed', status: 'generated', missingSources: [], origin: 'repair', ts: '2026-07-29T01:00:00Z' }),
    ].join('\n') + '\n');
    assert.doesNotMatch(run(), /원문 소실/, '대기 0이면 무출력');
    // 재발도 파일 상태로 만든다(원장의 `detected`와 카드가 같은 사실을 말하게).
    rmSync(join(work, 'docs', 'x.md'));
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

// `ineligible`은 소실 감지와 **다른 지표**다: "provenance가 없어 recall이 구조적으로
// 주입할 수 없는 카드 수"이고, 종점은 update.sh의 SessionStart notice다. 이 값이 필요한
// 이유는 source freshness 도입으로 기존 카드가 **한 번에** 전부 recall에서 빠지기 때문이다
// (라이브 실측 service-engineering 931/931, ai-proxy 26/26). 절벽 자체는 의도된 정책이지만
// 조용하면 "어느 날 wiki recall이 그냥 비었다"로 보여 버그로 신고된다.
test('source scan: ineligible은 provenance 없는 카드를 recall과 같은 판정으로 센다', () => {
  const dir = setupProject();
  try {
    // 신뢰 조건 3개(verified · qmd 소유 · sourceRevisions)를 하나씩 깨뜨린다.
    writeCard(dir, 'entities/ok.md', { status: 'verified' });                       // 적격
    writeCard(dir, 'entities/no-rev.md', { status: 'verified', sourceRevisions: false }); // 지문 없음
    writeCard(dir, 'entities/draft.md', { status: 'generated' });                   // 미검수
    writeCard(dir, 'entities/foreign.md', { status: 'verified', createdBy: 'human' }); // 외부 작성
    const r = runScan(dir);
    assert.equal(r.cards, 4);
    assert.equal(r.ineligible, 3, 'ok.md만 적격이어야 한다');
  } finally { removeTemp(dir); }
});

// **`sourceScan.enabled`는 소스 소실 스캔만 끈다.** `ineligible`은 별개 기능(provenance
// 결측 총량)이고 별개 알림을 가지므로 그 스위치의 대상이 아니다. 커플링돼 있던 동안
// `enabled:false`는 부적격 카드 N장을 **0장으로 보고**했고, update.sh는 0을 받으면 상태
// 파일을 지워 `notice_clear wiki-ineligible`을 발동한다 — 그 알림 문구가 "남은 수는 이
// 알림이 사라지면 0입니다"라고 스스로 명시하므로 결과는 **거짓 복구 보고**다.
test('source scan: enabled:false는 소실 스캔만 끄고 ineligible 집계는 유지한다', () => {
  const dir = setupProject({ compile: { sourceScan: { enabled: false } } });
  try {
    writeCard(dir, 'entities/ok.md', { status: 'verified' });
    writeCard(dir, 'entities/draft.md', { status: 'generated' });
    writeCard(dir, 'entities/no-rev.md', { status: 'verified', sourceRevisions: false });
    const r = runScan(dir, { QMD_SOURCE_SCAN_MAX: '' });
    assert.equal(r.cards, 3, '카드 목록은 여전히 만든다(집계 입력)');
    assert.equal(r.ineligible, 2, 'ineligible은 스위치와 무관하게 센다');
    assert.equal(r.ineligibleMeasured, true, '측정했다는 사실이 결과에 남아야 한다');
    assert.equal(r.examined, 0, '소실 판정은 하지 않는다');
  } finally { removeTemp(dir); }
});

// **"0"과 "안 셌다"는 다르다.** 미측정 run이 0으로 보고되면 update.sh가 상태 파일을 지워
// 거짓 복구 보고가 된다. 측정 불가 경로(unsafe wikiPath)는 measured:false여야 하고,
// 카드가 하나도 없는 경로는 **측정된 0**이어야 한다(wiki를 지우면 알림도 사라져야 한다).
test('source scan: ineligibleMeasured가 "0"과 "안 셌다"를 구분한다', () => {
  const unsafe = setupProject();
  try {
    // wikiPath가 root 밖 → 판정 불가. 카드가 없다는 뜻이 아니다.
    const settings = join(unsafe, '.auto-context', 'settings.json');
    const cfg = JSON.parse(readFileSync(settings, 'utf8'));
    cfg.wikiPath = '../outside';
    writeFileSync(settings, JSON.stringify(cfg));
    const r = runScan(unsafe, { QMD_SOURCE_SCAN_MAX: '' });
    assert.equal(r.ineligible, 0);
    assert.equal(r.ineligibleMeasured, false, '판정 불가는 미측정이다');
  } finally { removeTemp(unsafe); }

  const noWiki = setupProject();
  try {
    rmSync(join(noWiki, '.auto-context', 'wiki'), { recursive: true, force: true });
    const r = runScan(noWiki, { QMD_SOURCE_SCAN_MAX: '' });
    assert.equal(r.ineligible, 0);
    assert.equal(r.ineligibleMeasured, true, '카드가 없으면 측정된 0이다');
  } finally { removeTemp(noWiki); }

  const normal = setupProject();
  try {
    writeCard(normal, 'entities/draft.md', { status: 'generated' });
    const r = runScan(normal, { QMD_SOURCE_SCAN_MAX: '' });
    assert.equal(r.ineligible, 1);
    assert.equal(r.ineligibleMeasured, true);
  } finally { removeTemp(normal); }
});

// update.sh worker → SessionStart notice의 **상태 파일**까지가 이 신호의 종점이다.
// 스캐너 단위 테스트만으로는 "worker가 0을 받으면 파일을 지운다"는 마지막 한 칸을 못 잡고,
// 그 칸이 거짓 복구 보고(`notice_clear wiki-ineligible`)의 실제 발생 지점이다.
test('update.sh worker: 미측정 run은 ineligible 상태 파일을 지우지 않는다', () => {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(join(base, 'qmd-ineligible-'));
  const fakehome = join(work, 'fakehome');
  const bin = join(work, 'bin');
  mkdirSync(fakehome, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  const statePath = () => {
    const hash = execFileSync('python3', ['-c',
      'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])', work,
    ], { encoding: 'utf8' }).trim();
    return join(fakehome, `notice-wiki-ineligible-state-${hash}`);
  };
  const runWorker = () => execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: fakehome,
      QMD_CACHE_DIR: fakehome,
      QMD_LOCK_BASE: join(work, 'locks'),
      QMD_BACKEND_MANAGER: '/bin/true',
      QMD_SKIP_BACKGROUND_EMBED: '1',
      QMD_SOURCE_SCAN_LOG: join(work, 'scan.log'),
    },
  });
  const setScan = (sourceScan, extra = {}) => {
    const path = join(work, '.auto-context', 'settings.json');
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    cfg.compile.sourceScan = sourceScan;
    Object.assign(cfg, extra);
    writeFileSync(path, JSON.stringify(cfg));
  };

  try {
    setupProject({ base: work });
    writeCard(work, 'entities/draft.md', { status: 'generated' });  // provenance 없음
    runWorker();
    assert.equal(readFileSync(statePath(), 'utf8'), '1', '측정된 1장이 상태 파일에 남는다');

    // 소실 스캔만 껐다 — ineligible은 계속 측정되므로 수가 유지된다.
    setScan({ enabled: false });
    runWorker();
    assert.equal(readFileSync(statePath(), 'utf8'), '1', 'enabled:false가 수를 0으로 만들지 않는다');

    // 측정 불가(unsafe wikiPath) — 0을 보고하지만 상태 파일을 **지우지 않는다**.
    setScan({ enabled: true }, { wikiPath: '../outside' });
    runWorker();
    assert.equal(existsSync(statePath()), true, '미측정 run이 상태를 지우면 거짓 복구 보고가 된다');
    assert.equal(readFileSync(statePath(), 'utf8'), '1');

    // 실제로 복구되면(카드가 적격) 측정된 0이므로 파일이 사라진다 — 알림도 사라져야 한다.
    setScan({ enabled: true }, { wikiPath: '.auto-context/wiki' });
    writeCard(work, 'entities/draft.md', { status: 'verified' });
    runWorker();
    assert.equal(existsSync(statePath()), false, '측정된 0은 상태 파일을 지운다(notice_clear)');
  } finally { removeTemp(work); }
});

// 소실 감지는 순환 커서로 창을 나눠 여러 회차에 덮지만, `ineligible`은 사용자에게 보여 줄
// **총량**이라 같은 창에 갇히면 틀린 수를 말하게 된다("3장 남았습니다"라고 했는데 실제로는
// 300장인 상태). 전량 집계라는 성질을 여기서 못박는다 — frontmatter만 읽으므로
// 라이브 931장 실측 113ms이고 이 경로는 blocking hook이 아니라 update worker다.
test('source scan: ineligible은 순환 커서 창이 아니라 전량을 센다', () => {
  const dir = setupProject();
  try {
    for (let i = 0; i < 5; i += 1) {
      writeCard(dir, `entities/c${i}.md`, { status: 'generated' });
    }
    const r = runScan(dir, { QMD_SOURCE_SCAN_MAX: '1' });
    assert.equal(r.examined, 1, '소실 감지는 창(1장)만 본다');
    assert.equal(r.ineligible, 5, 'ineligible은 창과 무관하게 전량이다');
  } finally { removeTemp(dir); }
});

// ── 목록 배치 상한 ─────────────────────────────────────────────────────────────
// 이 목록은 사람·모델 컨텍스트로 들어간다. 라이브 실측으로 한 프로젝트의 대기가 278건,
// 전량 JSON이 111KB였다 — 상한 없이 "제시하라"고 지시하면 그 한 번으로 세션 예산이 타고
// 결국 아무도 손대지 않는다(그 상태가 3.3의 출발점이다). 상한은 정렬과 한 쌍이어야
// 배치 드레인이 세션 사이에 재현된다.
test('list --limit: pending은 전체를 유지하고 잘린 사실은 returned/truncated로 알린다', () => {
  const dir = setupProject();
  try {
    for (let i = 0; i < 5; i += 1) {
      writeCard(dir, `entities/card-${i}.md`, { sources: [fileSource(`docs/gone-${i}.md`)] });
    }
    runScan(dir);
    const all = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(all.pending, 5);
    assert.equal(all.returned, 5);
    assert.equal(all.truncated, undefined, '자르지 않았는데 truncated가 붙었다');

    const two = JSON.parse(runRepair(dir, ['--list', '--limit', '2']));
    // pending은 기존 wire 키이고 SessionStart 알림의 숫자와 같은 값이어야 한다 —
    // returned로 덮으면 "2건 남았다"로 읽혀 드레인이 끝난 것으로 오인된다.
    assert.equal(two.pending, 5, 'pending이 슬라이스 크기로 바뀌었다');
    assert.equal(two.returned, 2);
    assert.equal(two.entries.length, 2);
    assert.equal(two.truncated, true);

    // 0·미지정은 전체(기존 동작 무변화).
    assert.equal(JSON.parse(runRepair(dir, ['--list', '--limit', '0'])).returned, 5);
  } finally { removeTemp(dir); }
});

test('list: 손상된 ts(null·비문자)가 목록 전체를 죽이지 않는다', () => {
  // 이 CLI는 **원장이 깨졌을 때 쓰는 복구 도구**다. 정렬을 넣으면서 원장 값을 그대로
  // 비교하게 되면 `ts: null` 한 줄이 `None < str` TypeError를 만들고 run_guarded가 목록
  // 전체를 오류 JSON으로 바꾼다 — 복구 도구가 복구 대상 때문에 못 뜨는 조합이다.
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/known.md', { sources: [fileSource('docs/gone-known.md')] });
    writeCard(dir, 'entities/nots.md', { sources: [fileSource('docs/gone-nots.md')] });
    runScan(dir);
    // 스캔이 만든 원장의 ts를 손상시킨다(한 줄은 null, 한 줄은 숫자).
    const ledger = join(dir, LEDGER_REL);
    const rows = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    rows[0].ts = null;
    if (rows[1]) rows[1].ts = 12345;
    writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const out = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(out.ok, true, `손상된 ts가 목록을 죽였다: ${JSON.stringify(out)}`);
    assert.equal(out.pending, rows.length);
    for (const e of out.entries) {
      assert.equal(typeof e.detectedAt, 'string', 'detectedAt이 str로 정규화되지 않았다');
    }
  } finally { removeTemp(dir); }
});

test('list --limit: 시각을 모르는 행은 등급 안에서 뒤로 간다 (미지 ≠ 가장 오래됨)', () => {
  // 빈 문자열을 그대로 비교하면 미지 행이 맨 앞을 점유해 "오래된 감지 먼저"가 거짓이 되고,
  // 배치 드레인이 미지 행만 반복해서 집는다.
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/older.md', { sources: [fileSource('docs/gone-older.md')] });
    writeCard(dir, 'entities/newer.md', { sources: [fileSource('docs/gone-newer.md')] });
    writeCard(dir, 'entities/unknown.md', { sources: [fileSource('docs/gone-unknown.md')] });
    runScan(dir);
    const ledger = join(dir, LEDGER_REL);
    const rows = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const byName = (n) => rows.find((r) => r.targetPath.endsWith(n));
    byName('older.md').ts = '2020-01-01T00:00:00Z';
    byName('newer.md').ts = '2030-01-01T00:00:00Z';
    delete byName('unknown.md').ts;
    writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // 카드 1장 = 그룹 1개인 구성이라 그룹 정렬이 카드 FIFO 를 그대로 드러낸다.
    const order = JSON.parse(runRepair(dir, ['--list']))
      .entries.flatMap((e) => e.cards.map((c) => c.targetPath));
    assert.match(order[0], /older\.md$/, `FIFO가 아니다: ${order.join(', ')}`);
    assert.match(order[1], /newer\.md$/, `FIFO가 아니다: ${order.join(', ')}`);
    assert.match(order[2], /unknown\.md$/, `미지 시각이 앞을 점유했다: ${order.join(', ')}`);
  } finally { removeTemp(dir); }
});

test('list --limit: 음수는 전체 목록으로 정규화된다 (조용한 0건 금지)', () => {
  const dir = setupProject();
  try {
    for (let i = 0; i < 3; i += 1) {
      writeCard(dir, `entities/n-${i}.md`, { sources: [fileSource(`docs/gone-n${i}.md`)] });
    }
    runScan(dir);
    const out = JSON.parse(runRepair(dir, ['--list', '--limit', '-5']));
    assert.equal(out.ok, true);
    assert.equal(out.returned, 3, '음수 상한이 목록을 비웠다');
    assert.equal(out.truncated, undefined);
  } finally { removeTemp(dir); }
});

test('list --limit: trusted 카드가 먼저 온다 (캐논급 주입 중인데 대조 불가라 손해가 가장 크다)', () => {
  const dir = setupProject();
  try {
    // generated 3장을 먼저 써서 원장 순서상 앞에 오게 한다 — 정렬이 없으면 이것들이
    // 슬라이스를 차지하고 trusted 카드가 영구히 밀린다.
    for (let i = 0; i < 3; i += 1) {
      writeCard(dir, `entities/plain-${i}.md`, { sources: [fileSource(`docs/gone-p${i}.md`)] });
    }
    writeCard(dir, 'entities/canon.md', {
      status: 'verified', sourceRevisions: true, sources: [fileSource('docs/gone-canon.md')],
    });
    runScan(dir);

    const all = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(all.pending, 4);
    const trustedGroups = all.entries.filter((e) => e.trustedCount > 0).length;
    assert.equal(trustedGroups, 1, `trusted 판정이 예상과 다르다: ${JSON.stringify(all.entries.map((e) => [e.missingSource, e.trustedCount]))}`);

    const one = JSON.parse(runRepair(dir, ['--list', '--limit', '1']));
    assert.equal(one.entries.length, 1);
    assert.equal(one.entries[0].trustedCount, 1, 'trusted 카드가 슬라이스 밖으로 밀렸다');
    assert.match(one.entries[0].cards[0].targetPath, /canon\.md$/);
    // 후보 제안은 자른 뒤에만 계산한다(버릴 항목의 디렉터리 스캔은 순손실).
    assert.ok(one.entries[0].candidates, '슬라이스 안 항목에 후보가 없다');
  } finally { removeTemp(dir); }
});

// ── 소실 파일 단위 그룹핑 ────────────────────────────────────────────────────
// 결정 단위가 카드가 아니라 소실 파일이다. 라이브 실측으로 대기 카드 73장이 서로 다른
// 소실 파일 **13개**였고(SE 는 65장 ← 9개), 카드 단위 목록은 같은 파일을 인용하는 카드를
// 반복해서 보여주며 13개 결정을 8세션에 걸쳐 나눠 물었다.
test('list: 같은 파일을 잃은 카드들은 한 그룹으로 묶인다', () => {
  const dir = setupProject();
  try {
    for (const n of ['a', 'b', 'c']) {
      writeCard(dir, `entities/${n}.md`, { sources: [fileSource('docs/shared-gone.md')] });
    }
    writeCard(dir, 'entities/solo.md', { sources: [fileSource('docs/solo-gone.md')] });
    runScan(dir);

    const listed = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(listed.pending, 4, 'pending 은 카드 수(기존 wire 의미 유지)');
    assert.equal(listed.groups, 2, '소실 파일 2개');
    assert.equal(listed.entries.length, 2);
    const shared = listed.entries.find((e) => e.missingSource === 'docs/shared-gone.md');
    assert.equal(shared.cardCount, 3);
    assert.deepEqual(shared.cards.map((c) => c.targetPath).sort(),
      ['a', 'b', 'c'].map((n) => `.auto-context/wiki/entities/${n}.md`));
  } finally { removeTemp(dir); }
});

test('list: 그룹 정렬은 카드 수가 많은 쪽을 먼저 낸다 (카드 정렬과 의도적으로 다르다)', () => {
  // 카드 목록의 규칙은 "손해가 큰 카드부터"(trusted → FIFO)였다. 그룹은 **결정 단위**라
  // 같은 노력으로 더 많은 카드를 해소하는 순서가 옳다. 두 정렬은 다른 질문에 답한다 —
  // 한쪽을 "일관성" 명목으로 다른 쪽에 맞추지 말 것.
  const dir = setupProject();
  try {
    writeCard(dir, 'entities/lonely.md', { sources: [fileSource('docs/aaa-gone.md')] });
    for (const n of ['x', 'y', 'z']) {
      writeCard(dir, `entities/${n}.md`, { sources: [fileSource('docs/zzz-gone.md')] });
    }
    runScan(dir);
    const order = JSON.parse(runRepair(dir, ['--list'])).entries.map((e) => e.missingSource);
    assert.deepEqual(order, ['docs/zzz-gone.md', 'docs/aaa-gone.md'],
      '카드 3장 그룹이 1장 그룹보다 먼저 와야 한다(경로 순서로는 반대다)');
  } finally { removeTemp(dir); }
});

test('list: 그룹 안 카드 목록에는 상한이 있다 (그룹핑으로 줄인 컨텍스트를 되돌리지 않는다)', () => {
  const dir = setupProject();
  try {
    for (let i = 0; i < 8; i += 1) {
      writeCard(dir, `entities/m-${i}.md`, { sources: [fileSource('docs/many-gone.md')] });
    }
    runScan(dir);
    const entry = JSON.parse(runRepair(dir, ['--list'])).entries[0];
    assert.equal(entry.cardCount, 8, '전체 수는 cardCount 가 말한다');
    assert.equal(entry.cards.length, 5, '나열은 상한까지만');
    assert.equal(entry.cardsTruncated, true);
  } finally { removeTemp(dir); }
});

test('repoint-source: 그 파일을 인용하는 대기 카드 전부에 한 번에 적용된다', () => {
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', 'renamed.md'), 'renamed\n');
    const cards = ['a', 'b', 'c'].map((n) =>
      writeCard(dir, `entities/${n}.md`, { status: 'verified', sources: [fileSource('docs/old.md')] }));
    runScan(dir);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 3);

    const out = JSON.parse(runRepair(dir, [
      '--repoint-source', 'docs/old.md', '--to', 'docs/renamed.md',
    ]));
    assert.equal(out.ok, true);
    assert.equal(out.action, 'repointed-source');
    assert.equal(out.cardCount, 3);
    assert.equal(out.applied, 3);
    assert.equal(out.failed, 0);
    assert.equal(out.cards.length, 3, 'per-card 결과를 그대로 낸다(부분 실패를 뭉치지 않는다)');
    for (const card of cards) {
      assert.match(readFileSync(card, 'utf8'), /path: "docs\/renamed\.md"/);
      assert.match(readFileSync(card, 'utf8'), /^status: verified$/m, 'status는 건드리지 않는다');
    }
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0, '그룹이 통째로 해소된다');
  } finally { removeTemp(dir); }
});

test('repoint-source: 없는 대상으로는 한 장도 바꾸지 않는다', () => {
  const dir = setupProject();
  try {
    const card = writeCard(dir, 'entities/a.md', { sources: [fileSource('docs/old.md')] });
    runScan(dir);
    let out = '';
    try {
      runRepair(dir, ['--repoint-source', 'docs/old.md', '--to', 'docs/nope.md']);
      assert.fail('없는 경로 재지정은 실패해야 한다');
    } catch (err) { out = err.stdout; }
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false, '한 장이라도 실패하면 ok:false');
    assert.equal(parsed.applied, 0);
    assert.equal(parsed.cards[0].error, 'new_source_missing');
    assert.match(readFileSync(card, 'utf8'), /docs\/old\.md/, '카드는 그대로');
  } finally { removeTemp(dir); }
});

test('dismiss-source: 그 파일을 인용하는 카드 전부를 거절 처리한다', () => {
  const dir = setupProject();
  try {
    for (const n of ['a', 'b']) {
      writeCard(dir, `entities/${n}.md`, { sources: [fileSource('docs/really-gone.md')] });
    }
    runScan(dir);
    const out = JSON.parse(runRepair(dir, ['--dismiss-source', 'docs/really-gone.md']));
    assert.equal(out.ok, true);
    assert.equal(out.applied, 2);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0);
    // 재스캔해도 되살아나지 않는다(per-card dismiss 와 같은 원장 행 형태를 쓴다).
    runScan(dir);
    assert.equal(JSON.parse(runRepair(dir, ['--list'])).pending, 0, 'dismiss 는 sticky');
  } finally { removeTemp(dir); }
});

test('repoint-source: 소실 소스가 둘인 카드는 한쪽을 고치면 대기에서 빠지고 잔여는 stillMissing 으로 알린다', () => {
  // **전부 소실만 대기 대상**이라는 기존 계약을 그대로 따른다 — 일부만 소실인 카드는
  // 살아 있는 원문으로 대조가 되므로 스캐너도 대기로 올리지 않는다. 그래서 한쪽을 고치면
  // 그 카드는 대기에서 빠지고, 남은 깨진 링크는 조용히 사라지지 않고 `stillMissing` 으로
  // 사용자에게 보고된다(그 링크는 recall 주입에서 미존재로 걸러지고 stale 링크가 되지 않는다).
  const dir = setupProject();
  try {
    writeFileSync(join(dir, 'docs', 'fixed.md'), 'fixed\n');
    writeCard(dir, 'entities/two.md', {
      sources: [fileSource('docs/gone-1.md'), fileSource('docs/gone-2.md')],
    });
    runScan(dir);
    const before = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(before.pending, 1);
    assert.equal(before.groups, 2, '한 카드가 두 그룹에 나타난다');

    const out = JSON.parse(runRepair(dir, ['--repoint-source', 'docs/gone-1.md', '--to', 'docs/fixed.md']));
    assert.equal(out.ok, true);
    assert.deepEqual(out.cards[0].stillMissing, ['docs/gone-2.md'],
      '남은 깨진 링크를 보고해야 한다');
    const after = JSON.parse(runRepair(dir, ['--list']));
    assert.equal(after.pending, 0, '일부만 소실은 대기 대상이 아니다(스캐너와 같은 규칙)');
    assert.equal(after.groups, 0);
  } finally { removeTemp(dir); }
});
