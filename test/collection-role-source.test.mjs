// role `source` (로드맵 7단계) — qmd 등록과 compile 입력의 분리.
//
// 계약 한 줄: `source`는 **인덱싱·recall에서 빠지고 compile 입력으로는 남는다.**
// 그리고 `raw`/`wiki`/`session`을 쓰는 기존 프로젝트는 **완전 무변화**여야 한다.
// 미지 role은 `raw`로 fail-open한다(role 도입 전 동작 = 안전한 방향).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // 오타(`sourse`)와 미설정(`nope`)은 둘 다 raw다 — 여집합이 아니라 기본값이다.
  assert.deepEqual(r.roles, ['raw', 'wiki', 'session', 'source', 'raw', 'raw']);
  // 인덱싱: source만 빠진다. 오타는 raw로 fail-open해 **인덱싱된다**(안전 방향).
  assert.deepEqual(r.indexed, ['r', 'w', 's', 'typo', 'nope']);
  assert.deepEqual(r.wiki, ['w']);
  // hierarchical raw backfill 대상 = 인덱싱되는 non-wiki. source는 없다.
  assert.deepEqual(r.recallRaw, ['r', 's', 'typo', 'nope']);
  // compile 입력에는 source가 있고 wiki는 없다.
  assert.deepEqual(r.compileSrc, ['r', 's', 'src', 'typo', 'nope']);
  // fail-open 자체는 조용하면 안 된다 — 오타는 목록으로 표면화된다.
  assert.deepEqual(r.invalid, ['typo']);
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
  // source는 유지, 미지 값은 버려져 collection_role이 raw로 답한다.
  assert.deepEqual(JSON.parse(out), { a: 'source' });
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

    // (b) role 값이 오타 → raw로 fail-open해 여전히 인덱싱된다.
    writeSettings(dir, {
      indexing: true, collections: ['a'], collectionPaths: { a: 'docs' },
      collectionRoles: { a: 'sourse' },
    });
    r = resolveOnly(dir);
    assert.deepEqual(r.indexEntries.map(e => e.name), ['a']);
    assert.deepEqual(r.sourceEntries, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(f.base, { recursive: true, force: true }); }
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
  } finally { rmSync(work, { recursive: true, force: true }); }
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
  } finally { rmSync(work, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    rmSync(dir, { recursive: true, force: true });
    rmSync(qdir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
    rmSync(qdir, { recursive: true, force: true });
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(project, { recursive: true, force: true }); }
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
    rmSync(dir, { recursive: true, force: true });
    rmSync(envBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 여집합 금지 — 회귀 가드
// ---------------------------------------------------------------------------

test('여집합 금지: core/에 `role != "wiki"` 형태의 raw 판정이 남아 있지 않다', () => {
  // 세 번째 role(`source`)이 생긴 뒤로 "wiki가 아니면 raw"는 항상 오분류다.
  // 새 판정 지점이 들어와도 여기서 걸린다.
  // 산문(주석·docstring)은 제외한다 — config.py가 이 안티패턴을 **금지하는 이유**로
  // 패턴 자체를 인용하고 있다. 인용은 백틱 안이고 Python 코드 줄에는 백틱이 없다.
  const out = execFileSync('bash', ['-c',
    `grep -rn --include='*.py' 'role[s]\\?\\(\\.get([^)]*)\\|\\[[^]]*\\]\\) *!= *"wiki"' core/ `
    + `| grep -v ':[0-9]*: *#' | grep -v '\`' || true`,
  ], { encoding: 'utf8' }).trim();
  assert.equal(out, '', `여집합 role 판정이 남아 있다:\n${out}`);
});
