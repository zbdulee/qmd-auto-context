// role `source` (로드맵 7단계) — qmd 등록과 compile 입력의 분리.
//
// 계약 한 줄: `source`는 **인덱싱·recall에서 빠지고 compile 입력으로는 남는다.**
// 그리고 `raw`/`wiki`/`session`을 쓰는 기존 프로젝트는 **완전 무변화**여야 한다.
// 미지 role은 `raw`로 fail-open한다(role 도입 전 동작 = 안전한 방향).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers/temp.mjs';

function py(code, args = []) {
  return execFileSync('python3', ['-c', code, ...args], { encoding: 'utf8' });
}

// config 탐색은 HOME 경계까지만 올라가므로 프로젝트는 HOME 아래에 둔다.
function homeProject(prefix) {
  const base = join(homedir(), '.tmp-qmd-role-source');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

function writeSettings(dir, settings) {
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify(settings));
}

// run_update와 **같은 순서**로 돈다: config.py --raw 로 프로젝트 설정을 읽어
// --resolve-only 의 stdin으로 넘긴다. 설정을 직접 주입하면 raw settings 경로
// (미지 role이 살아서 오는 경로)를 건너뛰게 된다.
function resolveOnly(dir) {
  const rawConfig = execFileSync('python3', ['core/config.py', '--cwd', dir, '--raw'], { encoding: 'utf8' });
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', dir], { input: rawConfig });
  return JSON.parse(out.toString());
}

// ---------------------------------------------------------------------------
// config.py — role SSOT
// ---------------------------------------------------------------------------

test('config: role 판정은 양성 집합이고 미지 role은 raw로 fail-open한다', () => {
  const out = py([
    'import json, sys',
    'sys.path.insert(0, "core")',
    'import config',
    'cols = ["r", "w", "s", "src", "typo", "nope"]',
    'roles = {"r": "raw", "w": "wiki", "s": "session", "src": "source", "typo": "sourse"}',
    'print(json.dumps({',
    '  "roles": [config.collection_role(roles, c) for c in cols],',
    '  "indexed": config.indexed_collections(cols, roles),',
    '  "wiki": config.wiki_collections(cols, roles),',
    '  "recallRaw": config.recall_raw_collections(cols, roles),',
    '  "compileSrc": [c for c in cols if config.is_compile_source_collection(roles, c)],',
    '  "invalid": config.invalid_role_collections(roles, cols),',
    '}))',
  ].join('\n'));
  const r = JSON.parse(out);
  // **키 없음(`nope`)과 값 미지(`typo`)는 다르다.** 전자는 role 도입 전 프로젝트라
  // raw로 fail-open하고, 후자는 사용자가 의도한 것을 못 읽은 것이라 fail-closed다.
  assert.deepEqual(r.roles, ['raw', 'wiki', 'session', 'source', 'invalid', 'raw']);
  // 인덱싱: source와 미지 role이 빠진다. 오타가 "색인 제외"를 색인으로 뒤집지 않는다.
  assert.deepEqual(r.indexed, ['r', 'w', 's', 'nope']);
  assert.deepEqual(r.wiki, ['w']);
  // hierarchical raw backfill 대상 = 인덱싱되는 non-wiki.
  assert.deepEqual(r.recallRaw, ['r', 's', 'nope']);
  // compile 입력에는 source가 있고 wiki·미지 role은 없다(유료 호출이라 더더욱).
  assert.deepEqual(r.compileSrc, ['r', 's', 'src', 'nope']);
  // fail-closed 는 조용하면 안 된다 — 오타는 목록으로 표면화된다.
  assert.deepEqual(r.invalid, ['typo']);
});

test('config: 미지 role 판정이 raw settings와 normalize된 config에서 같다', () => {
  // normalize가 미지 항목을 **버리면** 그 자리는 "키 없음"이 되어 raw로 되살아난다.
  // 그러면 raw settings를 읽는 resolve_paths와 normalize를 쓰는 recall/index_enqueue의
  // 판정이 갈리고, 하필 갈리는 방향이 fail-open이다.
  const out = py([
    'import json, sys',
    'sys.path.insert(0, "core")',
    'import config',
    'raw = {"collections": ["a"], "collectionRoles": {"a": "sourse"}}',
    'norm = config.normalize_config(raw)',
    'print(json.dumps({',
    '  "rawRole": config.collection_role(config.role_map(raw), "a"),',
    '  "normRole": config.collection_role(config.role_map(norm), "a"),',
    '  "rawIndexed": config.is_indexed_collection(config.role_map(raw), "a"),',
    '  "normIndexed": config.is_indexed_collection(config.role_map(norm), "a"),',
    '  "normInvalid": config.invalid_role_collections(norm.get("collectionRoles"), ["a"]),',
    '}))',
  ].join('\n'));
  const r = JSON.parse(out);
  assert.equal(r.rawRole, 'invalid');
  assert.equal(r.normRole, 'invalid');
  assert.equal(r.rawIndexed, false);
  assert.equal(r.normIndexed, false);
  // 센티널로 정규화해도 표면화 목록에는 그대로 잡힌다(notice가 죽지 않는다).
  assert.deepEqual(r.normInvalid, ['a']);
});

test('config: collectionRoles 정규화가 source를 닫힌 집합으로 받아들인다', () => {
  const out = py([
    'import json, sys',
    'sys.path.insert(0, "core")',
    'import config',
    'cfg = config.normalize_config({"collections": ["a", "b"],',
    '                               "collectionRoles": {"a": "source", "b": "bogus"}})',
    'print(json.dumps(cfg["collectionRoles"]))',
  ].join('\n'));
  // source는 유지, 미지 값은 버리지 않고 fail-closed 센티널로 정규화한다.
  assert.deepEqual(JSON.parse(out), { a: 'source', b: 'invalid' });
});

// ---------------------------------------------------------------------------
// resolve_paths / update.sh — qmd 등록 대상
// ---------------------------------------------------------------------------

test('resolve: source는 entries에 남고 indexEntries에서만 빠진다', () => {
  const dir = homeProject('resolve');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'archive'), { recursive: true });
  mkdirSync(join(dir, 'notes'), { recursive: true });
  try {
    writeSettings(dir, {
      indexing: true,
      collections: ['p-docs', 'p-archive', 'p-notes', 'p-wiki'],
      collectionPaths: {
        'p-docs': 'docs', 'p-archive': 'archive', 'p-notes': 'notes',
        'p-wiki': '.auto-context/wiki',
      },
      collectionRoles: {
        'p-docs': 'raw', 'p-archive': 'source', 'p-notes': 'session', 'p-wiki': 'wiki',
      },
    });
    mkdirSync(join(dir, '.auto-context', 'wiki'), { recursive: true });
    const r = resolveOnly(dir);
    assert.equal(r.refused, false);
    // entries = 설정에 적힌 전부(compile source 경로가 이것을 쓴다).
    assert.deepEqual(r.entries.map(e => e.name), ['p-docs', 'p-archive', 'p-notes', 'p-wiki']);
    // indexEntries = qmd collection add 대상. source만 빠진다.
    assert.deepEqual(r.indexEntries.map(e => e.name), ['p-docs', 'p-notes', 'p-wiki']);
    assert.deepEqual(r.sourceEntries.map(e => e.name), ['p-archive']);
    // 항목 모양은 {name, path} 그대로다 — role을 얹으면 downstream이 role을 다시 비교한다.
    assert.deepEqual(Object.keys(r.entries[0]).sort(), ['name', 'path']);
  } finally { removeTemp(dir); }
});

test('resolve: role 미사용·미지 role 프로젝트는 indexEntries == entries (하위호환)', () => {
  const dir = homeProject('compat');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  try {
    // (a) collectionRoles 자체가 없다 = role 도입 전 설정.
    writeSettings(dir, { indexing: true, collections: ['a'], collectionPaths: { a: 'docs' } });
    let r = resolveOnly(dir);
    assert.deepEqual(r.indexEntries, r.entries);
    assert.deepEqual(r.sourceEntries, []);

    // (b) 빈 collectionRoles 도 role 도입 전과 같다.
    writeSettings(dir, {
      indexing: true, collections: ['a'], collectionPaths: { a: 'docs' }, collectionRoles: {},
    });
    r = resolveOnly(dir);
    assert.deepEqual(r.indexEntries, r.entries);
    assert.deepEqual(r.sourceEntries, []);
  } finally { removeTemp(dir); }
});

test('resolve: 명시적 미지 role은 fail-closed — entries에만 남고 등록도 해제도 안 한다', () => {
  const dir = homeProject('failclosed');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  try {
    writeSettings(dir, {
      indexing: true, collections: ['a'], collectionPaths: { a: 'docs' },
      collectionRoles: { a: 'sourse' },
    });
    const r = resolveOnly(dir);
    assert.deepEqual(r.entries.map(e => e.name), ['a']);
    // 새로 색인하지 않는다 = `qmd collection add` 대상이 아니다.
    assert.deepEqual(r.indexEntries, []);
    // 해제도 하지 않는다 — 오타 하나로 기존 인덱스를 지우는 것은 파괴적이다.
    assert.deepEqual(r.sourceEntries, []);
  } finally { removeTemp(dir); }
});

test('resolve: role을 source↔raw로 되돌리면 등록 대상이 그대로 복귀한다 (가역성)', () => {
  const dir = homeProject('revert');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  try {
    const base = { indexing: true, collections: ['a'], collectionPaths: { a: 'docs' } };
    writeSettings(dir, { ...base, collectionRoles: { a: 'raw' } });
    assert.deepEqual(resolveOnly(dir).indexEntries.map(e => e.name), ['a']);

    writeSettings(dir, { ...base, collectionRoles: { a: 'source' } });
    let r = resolveOnly(dir);
    assert.deepEqual(r.indexEntries, []);
    assert.deepEqual(r.sourceEntries.map(e => e.name), ['a']);

    // 되돌림에 필요한 것은 role 한 글자뿐이다. settings의 collections/collectionPaths는
    // source 기간에도 손대지 않으므로 재등록 경로(collection add + update + embed)가
    // 다음 SessionStart에 그대로 살아난다.
    writeSettings(dir, { ...base, collectionRoles: { a: 'raw' } });
    r = resolveOnly(dir);
    assert.deepEqual(r.indexEntries.map(e => e.name), ['a']);
    assert.deepEqual(r.sourceEntries, []);
  } finally { removeTemp(dir); }
});

// SessionStart 본 경로를 돌리되 HOME·PATH·캐시를 전부 샌드박스로 가둔다
// (test/wiki-compile-notice.test.mjs와 같은 패턴 — qmd 스텁이라 실제 색인은 없다).
function noticeFixture() {
  const base = mkdtempSync(join(process.cwd(), '.tmp-qmd-role-notice-'));
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  mkdirSync(join(home, 'projects'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'nohup'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  return { base, home, bin, cacheDir: join(base, 'cache'), lockBase: join(base, 'locks') };
}

function runSessionStart(f, projectRoot) {
  return execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
    cwd: process.cwd(),
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: f.home,
      PATH: `${f.bin}:${process.env.PATH}`,
      QMD_BACKEND_MANAGER: '/bin/true',
      QMD_CACHE_DIR: f.cacheDir,
      QMD_DIRTY_QUEUE: join(f.base, 'dirty-queue'),
      QMD_LOCK_BASE: f.lockBase,
      QMD_NOTICE_STATE_DIR: join(f.base, 'notice-state'),
      QMD_SKIP_BACKGROUND_EMBED: '1',
    },
  });
}

test('update.sh: 미지 role 값은 SessionStart notice로 표면화된다 (조용한 fail-open 금지)', () => {
  const f = noticeFixture();
  const project = join(f.home, 'projects', 'typo-role');
  mkdirSync(join(project, 'docs'), { recursive: true });
  try {
    writeSettings(project, {
      indexing: true, collections: ['a'], collectionPaths: { a: 'docs' },
      collectionRoles: { a: 'sourse' },
    });
    const out = runSessionStart(f, project);
    assert.match(out, /collectionRoles/);
    assert.match(out, /raw, wiki, session, source/);
    assert.match(out, /색인·recall·compile에서 제외/, 'fail-closed 라는 결과가 안내에 없다');
    assert.match(out, /\ba\b/, '어느 collection이 문제인지 이름이 나와야 한다');

    // TTL 억제: 같은 조건이면 두 번째 세션은 조용하다.
    assert.doesNotMatch(runSessionStart(f, project), /collectionRoles/);

    // 오타를 고치면 재무장한다(notice_clear) — 다시 틀리면 또 알린다.
    writeSettings(project, {
      indexing: true, collections: ['a'], collectionPaths: { a: 'docs' },
      collectionRoles: { a: 'source' },
    });
    assert.doesNotMatch(runSessionStart(f, project), /collectionRoles/);
    writeSettings(project, {
      indexing: true, collections: ['a'], collectionPaths: { a: 'docs' },
      collectionRoles: { a: 'sourse' },
    });
    assert.match(runSessionStart(f, project), /collectionRoles/);
  } finally { removeTemp(f.base); }
});

// ---------------------------------------------------------------------------
// update.sh worker — qmd 등록/해제
// ---------------------------------------------------------------------------

// repo 루트의 dogfooding 설정을 부모로 상속하지 않도록 HOME 하위에 만든다
// (tmpdir은 risky_path라 resolve_paths가 거부한다). update.test.mjs와 같은 규칙.
function workerProject(prefix) {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(join(base, `qmd-role-${prefix}-`));
  mkdirSync(join(work, 'bin'), { recursive: true });
  mkdirSync(join(work, 'fakehome'), { recursive: true });
  return work;
}

function runWorker(work) {
  return execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(work, 'bin')}:${process.env.PATH}`,
      HOME: join(work, 'fakehome'),
      QMD_CACHE_DIR: join(work, 'fakehome'),
      QMD_LOCK_BASE: join(work, 'locks'),
      QMD_HOOK_LOG: join(work, 'hook.log'),
      QMD_SKIP_BACKGROUND_EMBED: '1',
    },
  });
}

// `qmd collection list`가 두 컬렉션을 이미 등록된 것으로 보고하는 스텁.
function writeListingStub(work, registered) {
  const listing = registered.map(n => `${n}  10 files`).join('\\n');
  writeFileSync(join(work, 'bin', 'qmd'), [
    '#!/usr/bin/env sh',
    `echo "$@" >> "${join(work, 'qmd.log')}"`,
    'if [ "$1 $2" = "collection list" ]; then',
    `  printf '%b\\n' "${listing}"`,
    'fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
}

test('update.sh: role source는 collection add 대상에서 빠지고 이미 등록됐으면 remove된다', () => {
  const work = workerProject('unreg');
  mkdirSync(join(work, 'docs'), { recursive: true });
  mkdirSync(join(work, 'archive'), { recursive: true });
  try {
    writeSettings(work, {
      indexing: true,
      collections: ['p-docs', 'p-archive'],
      collectionPaths: { 'p-docs': 'docs', 'p-archive': 'archive' },
      collectionRoles: { 'p-docs': 'raw', 'p-archive': 'source' },
    });
    writeListingStub(work, ['p-docs', 'p-archive']);
    runWorker(work);

    const qmd = readFileSync(join(work, 'qmd.log'), 'utf8');
    const hook = readFileSync(join(work, 'hook.log'), 'utf8');
    // 등록: raw만.
    assert.match(qmd, /collection add .*docs --name p-docs/);
    assert.doesNotMatch(qmd, /collection add .*archive --name p-archive/);
    // 해제: 이미 인덱싱된 문서는 collection scope에서만 빠지고 전역 FTS/vec 후보 창은
    // 계속 점유한다 — 8단계가 재려는 것이 그 점유이므로 실제로 지워야 한다.
    assert.match(qmd, /^collection remove p-archive$/m);
    assert.match(hook, /UNREGISTER SOURCE COLLECTION: p-archive/);
  } finally { removeTemp(work); }
});

test('update.sh: role을 raw로 되돌리면 다음 세션이 재등록한다 (가역성 — settings 불변)', () => {
  const work = workerProject('revert');
  mkdirSync(join(work, 'archive'), { recursive: true });
  try {
    const base = {
      indexing: true,
      collections: ['p-archive'],
      collectionPaths: { 'p-archive': 'archive' },
    };
    writeSettings(work, { ...base, collectionRoles: { 'p-archive': 'source' } });
    writeListingStub(work, ['p-archive']);
    runWorker(work);
    assert.match(readFileSync(join(work, 'qmd.log'), 'utf8'), /^collection remove p-archive$/m);
    // settings는 손대지 않는다 — 되돌림에 필요한 것은 role 한 글자뿐이다.
    const after = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(after.collections, ['p-archive']);
    assert.deepEqual(after.collectionPaths, { 'p-archive': 'archive' });

    writeSettings(work, { ...base, collectionRoles: { 'p-archive': 'raw' } });
    writeListingStub(work, []);   // remove 이후라 더 이상 등록돼 있지 않다
    rmSync(join(work, 'qmd.log'), { force: true });
    runWorker(work);
    const qmd = readFileSync(join(work, 'qmd.log'), 'utf8');
    assert.match(qmd, /collection add .*archive --name p-archive/);
    assert.doesNotMatch(qmd, /collection remove/);
  } finally { removeTemp(work); }
});

test('update.sh: 미지 role 컬렉션은 qmd에 등록되지 않는다 (경고만 하고 색인하면 소용없다)', () => {
  const work = workerProject('failclosed');
  mkdirSync(join(work, 'docs'), { recursive: true });
  mkdirSync(join(work, 'archive'), { recursive: true });
  try {
    writeSettings(work, {
      indexing: true,
      collections: ['p-docs', 'p-archive'],
      collectionPaths: { 'p-docs': 'docs', 'p-archive': 'archive' },
      collectionRoles: { 'p-docs': 'raw', 'p-archive': 'sourse' },
    });
    writeListingStub(work, ['p-docs']);
    runWorker(work);
    const qmd = readFileSync(join(work, 'qmd.log'), 'utf8');
    assert.match(qmd, /collection add .*docs --name p-docs/);
    assert.doesNotMatch(qmd, /--name p-archive/,
      `미지 role 컬렉션이 실제로 인덱싱됐다:\n${qmd}`);
    // 해제도 하지 않는다(파괴적 조치 금지).
    assert.doesNotMatch(qmd, /collection remove p-archive/);
  } finally { removeTemp(work); }
});

test('update.sh: root 소실 + role source 여도 등록돼 있으면 지운다 (고아 등록 금지)', () => {
  // prune 이 unregister 보다 **먼저** 돌기 때문에 "아직 등록된 source"가 존재할 수 있다.
  // 예전에는 prune 이 role=source 면 remove 를 건너뛰고 settings 에서만 이름을 지워,
  // 이후 sourceEntries·prune 어디에도 나타나지 않는 **복구 불가 고아 등록**을 만들었다.
  const work = workerProject('orphan');
  mkdirSync(join(work, 'docs'), { recursive: true });
  mkdirSync(join(work, 'archive'), { recursive: true });
  try {
    writeSettings(work, {
      indexing: true,
      collections: ['p-docs', 'p-archive'],
      collectionPaths: { 'p-docs': 'docs', 'p-archive': 'archive' },
      collectionRoles: { 'p-docs': 'raw', 'p-archive': 'source' },
    });
    // 브랜치 전환·rename 으로 root 가 사라진 상태 + 아직 등록돼 있음.
    removeTemp(join(work, 'archive'));
    writeListingStub(work, ['p-docs', 'p-archive']);
    runWorker(work);

    const qmd = readFileSync(join(work, 'qmd.log'), 'utf8');
    assert.match(qmd, /^collection remove p-archive$/m,
      `등록된 채 settings 에서만 사라져 고아 등록이 됐다:\n${qmd}`);
    // settings 정리는 그대로 진행된다.
    const after = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(after.collections, ['p-docs']);
  } finally { removeTemp(work); }
});

test('update.sh: 등록된 적 없는 컬렉션의 root 소실은 remove 실패 없이 settings만 정리한다', () => {
  // 원래 role=source skip 을 만든 동기(매 세션 WARN 반복 + settings 정리 영구 보류)를
  // role 이 아니라 **등록 여부**로 해결한다 — raw 인데 한 번도 등록되지 않은 경우에도 옳다.
  const work = workerProject('neverreg');
  mkdirSync(join(work, 'docs'), { recursive: true });
  mkdirSync(join(work, 'gone'), { recursive: true });
  try {
    writeSettings(work, {
      indexing: true,
      collections: ['p-docs', 'p-gone'],
      collectionPaths: { 'p-docs': 'docs', 'p-gone': 'gone' },
      collectionRoles: { 'p-docs': 'raw', 'p-gone': 'raw' },
    });
    removeTemp(join(work, 'gone'));
    writeListingStub(work, ['p-docs']);   // p-gone 은 등록된 적 없다
    runWorker(work);

    const qmd = readFileSync(join(work, 'qmd.log'), 'utf8');
    const hook = readFileSync(join(work, 'hook.log'), 'utf8');
    assert.doesNotMatch(qmd, /collection remove p-gone/);
    assert.match(hook, /p-gone is not registered in qmd/);
    assert.doesNotMatch(hook, /PRUNE MISSING COLLECTION FAILED: p-gone/);
    const after = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(after.collections, ['p-docs']);
  } finally { removeTemp(work); }
});

// 신호 파일은 notice marker와 같은 캐시 디렉터리에 있다. 경로 규칙을 테스트가
// 재구현하지 않도록 glob으로 찾는다(규칙이 바뀌어도 이 테스트는 계약만 본다).
// 접두는 `-state`까지 정확히 본다 — notice_once의 TTL marker(`notice-unregister-failed-`)와
// **다른 파일**이어야 하고, 같아지면 상태 기록이 자기 notice를 억제한다.
const STATE_PREFIX = 'notice-unregister-failed-state-';
function unregisterStateFiles(f) {
  if (!existsSync(f.cacheDir)) return [];
  return readdirSync(f.cacheDir).filter(n => n.startsWith(STATE_PREFIX));
}

function unregisterFixture(removeExit) {
  const f = noticeFixture();
  const project = join(f.home, 'projects', 'unreg');
  mkdirSync(join(project, 'archive'), { recursive: true });
  writeSettings(project, {
    indexing: true,
    collections: ['p-archive'],
    collectionPaths: { 'p-archive': 'archive' },
    collectionRoles: { 'p-archive': 'source' },
  });
  writeFileSync(join(f.bin, 'qmd'), [
    '#!/usr/bin/env sh',
    `echo "$@" >> "${join(f.base, 'qmd.log')}"`,
    'if [ "$1 $2" = "collection list" ]; then',
    "  printf '%s\\n' 'p-archive  10 files'",
    'fi',
    `if [ "$1 $2" = "collection remove" ]; then exit ${removeExit}; fi`,
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  return { f, project };
}

// worker 는 main 이 nohup 으로 띄우는 백그라운드 fork라, 두 반쪽을 한 흐름으로
// 엮으면 경합이 된다. 여기서는 worker 를 **동기로** 직접 돌려 상태를 확정한 뒤
// 세션 하나로 표면화만 확인한다.
function runWorkerIn(f, project) {
  return execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', project], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: f.home,
      PATH: `${f.bin}:${process.env.PATH}`,
      QMD_BACKEND_MANAGER: '/bin/true',
      QMD_CACHE_DIR: f.cacheDir,
      QMD_DIRTY_QUEUE: join(f.base, 'dirty-queue'),
      QMD_LOCK_BASE: f.lockBase,
      QMD_SKIP_BACKGROUND_EMBED: '1',
    },
  });
}

test('update.sh: unregister 실패가 SessionStart notice로 표면화된다 (종점 신호)', () => {
  // 재시도 자체는 self-healing 이라 옳다. 빠져 있던 것은 **종점 신호**다 — 실패가
  // 로그에만 남으면 "색인하지 마라"고 말한 컬렉션이 조용히 무한정 인덱싱·검색된다.
  const { f, project } = unregisterFixture(3);
  try {
    runWorkerIn(f, project);
    assert.equal(unregisterStateFiles(f).length, 1, 'worker 가 실패 상태를 남기지 않았다');
    const out = runSessionStart(f, project);
    assert.match(out, /role source 컬렉션을 qmd 인덱스에서 제거하지 못했습니다/);
    assert.match(out, /p-archive/);
    assert.match(out, /계속 색인·검색됩니다/, '결과(계속 색인됨)가 안내에 없다');

    // 상태 파일과 notice_once TTL marker는 **다른 파일**이어야 한다. 같으면 상태를
    // 쓰는 순간 그것이 "방금 알렸다"는 marker가 되어 notice가 자기 자신을 억제한다.
    const files = readdirSync(f.cacheDir).filter(n => n.startsWith('notice-unregister-failed'));
    assert.equal(files.filter(n => n.startsWith(STATE_PREFIX)).length, 1);
    assert.equal(files.filter(n => !n.startsWith(STATE_PREFIX)).length, 1,
      `notice marker가 상태 파일과 같은 경로다: ${files.join(', ')}`);
  } finally { removeTemp(f.base); }
});

test('update.sh: unregister 성공이면 상태가 지워져 notice가 나지 않는다 (조건 해소 재무장)', () => {
  const { f, project } = unregisterFixture(0);
  try {
    runWorkerIn(f, project);
    assert.deepEqual(unregisterStateFiles(f), [], '성공했는데 실패 상태가 남았다');
    assert.doesNotMatch(runSessionStart(f, project), /제거하지 못했습니다/);
    // 실제로 제거를 시도했는지도 확인한다(상태가 없는 이유가 "시도 안 함"이면 안 된다).
    assert.match(readFileSync(join(f.base, 'qmd.log'), 'utf8'), /^collection remove p-archive$/m);
  } finally { removeTemp(f.base); }
});

test('update.sh: 등록돼 있지 않은 source는 실패로 치지 않는다 (거짓 경보 금지)', () => {
  // 한 번도 색인된 적 없는 source 컬렉션에서 매 세션 경보가 나면 신호가 죽는다.
  const { f, project } = unregisterFixture(3);
  try {
    // 레지스트리에서 빼면 지울 것이 없다 → 시도도 실패도 없다.
    writeFileSync(join(f.bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `echo "$@" >> "${join(f.base, 'qmd.log')}"`,
      'if [ "$1 $2" = "collection list" ]; then',
      "  printf '%s\\n' 'other-collection  3 files'",
      'fi',
      'if [ "$1 $2" = "collection remove" ]; then exit 3; fi',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    runWorkerIn(f, project);
    assert.deepEqual(unregisterStateFiles(f), []);
    assert.doesNotMatch(readFileSync(join(f.base, 'qmd.log'), 'utf8'), /collection remove p-archive/);
    assert.doesNotMatch(runSessionStart(f, project), /제거하지 못했습니다/);
  } finally { removeTemp(f.base); }
});

// ---------------------------------------------------------------------------
// recall — 질의 대상
// ---------------------------------------------------------------------------

function capturedCollections(prompt, settings) {
  const out = execFileSync(
    'python3', ['test/helpers/capture_query.py', prompt, JSON.stringify(settings)],
    { encoding: 'utf8' });
  return JSON.parse(out).queries.map(q => q.collections);
}

test('recall: source 컬렉션은 데몬 질의 대상에서 빠진다', () => {
  const queries = capturedCollections('정렬 규칙이 어떻게 동작해?', {
    collections: ['p-docs', 'p-archive'],
    collectionRoles: { 'p-docs': 'raw', 'p-archive': 'source' },
    recallStrategy: 'flat',
  });
  assert.ok(queries.length > 0, '질의가 최소 1건은 나가야 한다');
  for (const cols of queries) {
    assert.deepEqual(cols, ['p-docs'], `source가 질의에 샜다: ${JSON.stringify(cols)}`);
  }
});

test('recall: hierarchical raw backfill 대상에 source가 들어가지 않는다', () => {
  const queries = capturedCollections('정렬 규칙이 어떻게 동작해?', {
    collections: ['p-wiki', 'p-docs', 'p-archive'],
    collectionRoles: { 'p-wiki': 'wiki', 'p-docs': 'raw', 'p-archive': 'source' },
    recallStrategy: 'hierarchical',
  });
  // 1차는 wiki-scoped, wiki가 0건이면 2차 raw backfill이 나간다.
  assert.deepEqual(queries[0], ['p-wiki']);
  for (const cols of queries.slice(1)) {
    assert.ok(!cols.includes('p-archive'), `backfill에 source가 샜다: ${JSON.stringify(cols)}`);
    assert.deepEqual(cols, ['p-docs']);
  }
});

test('recall: 컬렉션이 전부 source면 질의 없이 no_indexed_collections로 끝난다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-role-recall-'));
  const logPath = join(dir, 'recall.log');
  try {
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({
      collections: ['p-archive'],
      collectionRoles: { 'p-archive': 'source' },
    }));
    const out = execFileSync('python3', ['core/recall.py'], {
      input: JSON.stringify({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir }),
      encoding: 'utf8',
      env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json',
             QMD_RECALL_LOG: logPath },
    }).trim();
    assert.equal(out, '', 'source 전용 프로젝트는 주입이 없다');
    const ev = readFileSync(logPath, 'utf8').trim().split('\n')
      .map(JSON.parse).filter(e => e.event === 'qmd_recall_selection');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].reason, 'no_indexed_collections');
  } finally { removeTemp(dir); }
});

test('recall: wikiOnly 판정에 source는 포함되지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-role-wikionly-'));
  const logPath = join(dir, 'recall.log');
  try {
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({
      collections: ['p-archive', 'p-docs'],
      collectionRoles: { 'p-archive': 'source', 'p-docs': 'raw' },
      recallStrategy: 'wikiOnly',
    }));
    const out = execFileSync('python3', ['core/recall.py'], {
      input: JSON.stringify({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir }),
      encoding: 'utf8',
      env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json',
             QMD_RECALL_LOG: logPath },
    }).trim();
    assert.equal(out, '');
    const ev = readFileSync(logPath, 'utf8').trim().split('\n')
      .map(JSON.parse).filter(e => e.event === 'qmd_recall_selection');
    // source는 wiki가 아니다 — wikiOnly는 surface할 것이 없다고 판정해야 한다.
    assert.equal(ev[0].reason, 'no_wiki_collections');
  } finally { removeTemp(dir); }
});

// ---------------------------------------------------------------------------
// index_enqueue / sync — dirty 큐 (인덱싱)
// ---------------------------------------------------------------------------

function editProject(roles) {
  const dir = homeProject('edit');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'archive'), { recursive: true });
  writeSettings(dir, {
    indexing: true,
    collections: ['p-docs', 'p-archive'],
    collectionPaths: { 'p-docs': 'docs', 'p-archive': 'archive' },
    collectionRoles: roles,
  });
  return dir;
}

function enqueueEdit(dir, relPath, queuePath) {
  execFileSync('python3', ['core/index_enqueue.py'], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', cwd: dir,
      tool_input: { file_path: join(dir, relPath) },
    }),
    encoding: 'utf8',
    env: { ...process.env, QMD_DIRTY_QUEUE: queuePath },
  });
  return existsSync(queuePath) ? readFileSync(queuePath, 'utf8') : '';
}

test('index_enqueue: source 컬렉션 편집은 dirty 큐에 들어가지 않는다', () => {
  const dir = editProject({ 'p-docs': 'raw', 'p-archive': 'source' });
  const qdir = mkdtempSync(join(tmpdir(), 'qmd-role-q-'));
  try {
    // source: 큐 미생성. 넣으면 index_worker가 collection add로 도로 등록해
    // update.sh의 unregister와 매 편집마다 싸운다.
    assert.equal(enqueueEdit(dir, join('archive', 'old.md'), join(qdir, 'q1')), '');
    // raw: 기존대로 적재(하위호환).
    assert.match(enqueueEdit(dir, join('docs', 'a.md'), join(qdir, 'q2')), /^p-docs\t/);
  } finally {
    removeTemp(dir);
    removeTemp(qdir);
  }
});

test('index_enqueue: source를 raw로 되돌리면 같은 편집이 다시 적재된다 (가역성)', () => {
  const dir = editProject({ 'p-docs': 'raw', 'p-archive': 'source' });
  const qdir = mkdtempSync(join(tmpdir(), 'qmd-role-q2-'));
  try {
    assert.equal(enqueueEdit(dir, join('archive', 'old.md'), join(qdir, 'q1')), '');
    writeSettings(dir, {
      indexing: true,
      collections: ['p-docs', 'p-archive'],
      collectionPaths: { 'p-docs': 'docs', 'p-archive': 'archive' },
      collectionRoles: { 'p-docs': 'raw', 'p-archive': 'raw' },
    });
    assert.match(enqueueEdit(dir, join('archive', 'old.md'), join(qdir, 'q2')), /^p-archive\t/);
  } finally {
    removeTemp(dir);
    removeTemp(qdir);
  }
});

// ---------------------------------------------------------------------------
// compile — source는 여기서 살아 있어야 한다
// ---------------------------------------------------------------------------

function compileProject(role) {
  const dir = homeProject('compile');
  mkdirSync(join(dir, 'archive'), { recursive: true });
  writeSettings(dir, {
    indexing: true,
    collections: ['p-archive'],
    collectionPaths: { 'p-archive': 'archive' },
    collectionRoles: { 'p-archive': role },
    compile: {
      enabled: true,
      mode: 'auto-wiki',
      autoWrite: true,
      triggers: ['post_tool_source', 'post_sync_source', 'manual'],
      sourceQueuePath: '.auto-context/compile/source-queue.jsonl',
      extractor: { dispatch: 'by-engine', backends: {}, builtins: ['claude'], default: [], timeout: 30 },
    },
  });
  writeFileSync(join(dir, 'archive', 'old.md'), '# 오래된 결정\n\n본문.\n');
  return dir;
}

function compileQueue(dir) {
  const p = join(dir, '.auto-context', 'compile', 'source-queue.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('compile enqueue: source 컬렉션의 .md는 compile 입력으로 큐잉된다', () => {
  const dir = compileProject('source');
  try {
    execFileSync('python3', ['core/wiki_compile_enqueue.py'], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse', cwd: dir,
        tool_input: { file_path: join(dir, 'archive', 'old.md') },
      }),
      encoding: 'utf8',
      env: { ...process.env, QMD_ENGINE: 'claude' },
    });
    const rows = compileQueue(dir);
    assert.equal(rows.length, 1, 'source 컬렉션이 compile 큐에 들어가야 한다');
    assert.equal(rows[0].source.collection, 'p-archive');
    assert.equal(rows[0].trigger, 'post_tool_source');
  } finally { removeTemp(dir); }
});

test('compile enqueue: wiki 컬렉션은 여전히 compile 입력이 아니다', () => {
  const dir = compileProject('wiki');
  try {
    execFileSync('python3', ['core/wiki_compile_enqueue.py'], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse', cwd: dir,
        tool_input: { file_path: join(dir, 'archive', 'old.md') },
      }),
      encoding: 'utf8',
      env: { ...process.env, QMD_ENGINE: 'claude' },
    });
    assert.deepEqual(compileQueue(dir), []);
  } finally { removeTemp(dir); }
});

test('compile worker: source 컬렉션 잡을 invalid_source_scope로 버리지 않는다', () => {
  // enqueue와 worker의 role 판정이 갈리면 큐에는 들어가는데 worker가 매번 버리는
  // 무한 왕복이 된다. 두 지점 모두 config.COMPILE_SOURCE_ROLES를 쓴다.
  const project = mkdtempSync(join(tmpdir(), 'qmd-role-worker-'));
  const extractor = join(mkdtempSync(join(tmpdir(), 'qmd-role-extractor-')), 'extract.py');
  try {
    writeFileSync(extractor, [
      '#!/usr/bin/env python3',
      'import json, sys',
      'json.loads(sys.stdin.read())',
      "print(json.dumps({'candidates': [{",
      "  'title': 'Archived Decision',",
      "  'summary': 'source role 컬렉션도 카드의 원천이 된다.',",
      "  'suggestedType': 'decision', 'confidence': 'high',",
      "  'targetPath': '.auto-context/wiki/decisions/archived-decision.md'}]}))",
    ].join('\n'));
    mkdirSync(join(project, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(join(project, '.auto-context', 'wiki'), { recursive: true });
    mkdirSync(join(project, 'archive'), { recursive: true });
    writeFileSync(join(project, 'archive', 'old.md'), '# 오래된 결정\n\n본문.\n');
    writeFileSync(join(project, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['p-archive', 'p-wiki'],
      collectionPaths: { 'p-archive': 'archive', 'p-wiki': '.auto-context/wiki' },
      collectionRoles: { 'p-archive': 'source', 'p-wiki': 'wiki' },
      wikiPath: '.auto-context/wiki',
      compile: {
        enabled: true, mode: 'guarded', autoWrite: true, defaultStatus: 'generated',
        triggers: ['post_tool_source', 'manual'],
        sourceQueuePath: '.auto-context/compile/source-queue.jsonl',
        candidatePath: '.auto-context/compile/candidates.jsonl',
        maxSourceChars: 12000,
        extractor: { argv: ['python3', extractor], timeout: 30 },
      },
    }));
    writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
      JSON.stringify({
        ts: '2026-07-30T00:00:00Z', trigger: 'post_tool_source', engine: 'claude', cwd: project,
        source: { kind: 'file', path: 'archive/old.md', collection: 'p-archive' },
      }) + '\n');

    const dirtyQueue = join(mkdtempSync(join(tmpdir(), 'qmd-role-dirty-')), 'queue');
    execFileSync('python3', ['core/wiki_compile_worker.py', '--cwd', project],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, QMD_DIRTY_QUEUE: dirtyQueue } });

    assert.ok(existsSync(join(project, '.auto-context', 'wiki', 'decisions', 'archived-decision.md')),
      'source 컬렉션 소스로 카드가 만들어져야 한다');
    const cands = readFileSync(join(project, '.auto-context', 'compile', 'candidates.jsonl'), 'utf8');
    assert.doesNotMatch(cands, /invalid_source_scope/);
    // 생성된 wiki 카드는 인덱싱 대상이므로 dirty 큐에는 wiki만 들어간다.
    assert.match(readFileSync(dirtyQueue, 'utf8'), /^p-wiki\t/);
  } finally { removeTemp(project); }
});

test('sync: source 변경은 dirty 큐를 건너뛰고 compile 큐에만 들어간다', () => {
  const dir = compileProject('source');
  const envBase = mkdtempSync(join(tmpdir(), 'qmd-role-sync-'));
  try {
    const env = {
      ...process.env,
      QMD_SYNC_STATE_DIR: join(envBase, 'state'),
      QMD_DIRTY_QUEUE: join(envBase, 'queue'),
      QMD_SYNC_LOCKDIR: join(envBase, 'lock.d'),
      QMD_ENGINE: 'claude',
    };
    // baseline 후 파일을 바꿔 diff를 만든다.
    execFileSync('python3', ['core/sync.py', '--cwd', dir, '--baseline', '--json'], { encoding: 'utf8', env });
    writeFileSync(join(dir, 'archive', 'old.md'), '# 오래된 결정\n\n본문 수정.\n');
    const out = JSON.parse(execFileSync('python3', ['core/sync.py', '--cwd', dir, '--json'],
      { encoding: 'utf8', env }));
    assert.equal(out.reason, 'synced');
    // dirty 큐(=인덱싱)에는 아무것도 없다.
    assert.deepEqual(out.collectionsQueued, []);
    assert.equal(existsSync(join(envBase, 'queue')), false, 'source는 dirty 큐를 만들지 않는다');
    // 그러나 카드 소스로는 살아 있다.
    assert.equal(out.compileQueued, 1);
    assert.equal(compileQueue(dir)[0].source.collection, 'p-archive');
  } finally {
    removeTemp(dir);
    removeTemp(envBase);
  }
});

// ---------------------------------------------------------------------------
// 여집합 금지 — 회귀 가드
// ---------------------------------------------------------------------------

test('여집합 금지: core/에 `role != "wiki"` 형태의 raw 판정이 남아 있지 않다', () => {
  // 세 번째 role(`source`)이 생긴 뒤로 "wiki가 아니면 raw"는 항상 오분류다.
  // 새 판정 지점이 들어와도 여기서 걸린다.
  // 인용 표기는 **양쪽 다** 잡는다 — 큰따옴표만 보면 `roles.get(c) != 'wiki'`가
  // 그대로 통과해 가드가 목적을 달성하지 못한다.
  // 산문(주석·docstring)은 제외한다 — config.py가 이 안티패턴을 **금지하는 이유**로
  // 패턴 자체를 인용하고 있다. 인용은 백틱 안이고 Python 코드 줄에는 백틱이 없다.
  // 셸 문자열은 큰따옴표로 감싸므로 패턴 안의 `"`는 `\"`로 이스케이프해야 한다
  // (안 하면 셸 인용이 거기서 끊겨 패턴이 조용히 반쪽이 된다 — 아래 자체 검증이 잡는다).
  const quoted = `(\\"wiki\\"|'wiki')`;
  const cmd = `grep -rnE --include='*.py' `
    + `"role[s]?(\\.get\\([^)]*\\)|\\[[^]]*\\]) *!= *${quoted}" core/ `
    + `| grep -v ':[0-9]*: *#' | grep -v '\`' || true`;
  const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' }).trim();
  assert.equal(out, '', `여집합 role 판정이 남아 있다:\n${out}`);

  // 가드가 실제로 두 표기를 다 잡는지 자체 검증한다(가드가 조용히 무력해지는 것 방지).
  const probe = mkdtempSync(join(tmpdir(), 'qmd-role-guard-'));
  try {
    mkdirSync(join(probe, 'core'), { recursive: true });
    writeFileSync(join(probe, 'core', 'a.py'), 'x = roles.get(c) != "wiki"\n');
    writeFileSync(join(probe, 'core', 'b.py'), "y = roles.get(c) != 'wiki'\n");
    const hits = execFileSync('bash', ['-c', cmd], { encoding: 'utf8', cwd: probe }).trim();
    assert.match(hits, /a\.py/, `가드가 큰따옴표 표기를 놓쳤다:\n${hits}`);
    assert.match(hits, /b\.py/, `가드가 작은따옴표 표기를 놓쳤다:\n${hits}`);
  } finally { removeTemp(probe); }
});
