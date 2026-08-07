// wiki 결과 경로 해석(resolve_wiki_result_path) 회귀 테스트.
//
// 데몬 /query 는 file 을 qmd:// 스킴 **없이** "collection/path" 로도 반환한다. 예전
// 구현은 스킴이 있을 때만 collection prefix 를 벗겨서, 라이브(plain path)에서는 항상
// 존재하지 않는 <root>/<collection>/<rel> 을 만들고 wikiPath 경계 검증에 걸려 None 이
// 됐다 → read_wiki_meta 가 frontmatter 를 못 읽고 기본값 generated/미검수로 fail-close
// → recallVerifiedOnly(기본 true)가 **검수된 카드까지 전부 drop**. 같은 클래스가
// 커밋 6deed4a(_collection 주입)에서 한 번 고쳐졌지만 rel 추출은 스킴을 전제한 채
// 남았고, fixture 가 전부 qmd:// 형식이라 테스트는 통과하고 라이브만 깨졌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers/temp.mjs';

function probePath(dir, uri, collection = '') {
  const out = execFileSync('python3', [
    'test/helpers/wiki_path_probe.py', dir, uri, collection,
  ], { encoding: 'utf8' });
  return JSON.parse(out);
}

// wiki 카드 하나(검수됨)와 wikiPath 밖 문서 하나를 가진 프로젝트.
function wikiProject(dir, extraSettings = {}) {
  mkdirSync(join(dir, '.auto-context', 'wiki', 'decisions'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki', 'proj-docs'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki', 'proj-docs': 'docs' },
    collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
    recallStrategy: 'hierarchical',
    topN: 3,
    ...extraSettings,
  }));
  const sourcePath = join(dir, 'docs', 'outside.md');
  writeFileSync(sourcePath, '---\nstatus: verified\n---\n# Outside\n');
  const bytes = readFileSync(sourcePath);
  const stat = statSync(sourcePath, { bigint: true });
  const hash = createHash('sha256').update(bytes).digest('hex');
  const revision = `{kind: "file", path: "docs/outside.md", collection: "proj-docs", sha256: "${hash}", size: ${stat.size}, mtimeNs: ${stat.mtimeNs}}`;
  writeFileSync(join(dir, '.auto-context', 'wiki', 'decisions', 'card.md'),
    `---\nstatus: verified\ncreatedBy: qmd-auto-context\nsourceRevisions:\n  - ${revision}\nreviewed: false\nverifiedBy: claude\n---\n# Card\n`);
}

function withProject(fn, extraSettings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-wikipath-'));
  wikiProject(dir, extraSettings);
  try {
    return fn(dir);
  } finally {
    removeTemp(dir);
  }
}

test('plain path(<collection>/<rel>)에서 실제 frontmatter status/trusted를 읽는다', () => {
  withProject((dir) => {
    const r = probePath(dir, 'proj-wiki/decisions/card.md');
    assert.ok(r.resolved, '경로가 해석되어야 함 (해석 실패 시 미검수로 오판된다)');
    assert.match(r.resolved, /\.auto-context\/wiki\/decisions\/card\.md$/);
    assert.equal(r.meta.status, 'verified');
    assert.equal(r.meta.trusted, true, 'verified + qmd provenance만 자동 신뢰');
    assert.equal('reviewed' in r.meta, false, '카드 필드로 오인할 호환 telemetry를 노출하지 않음');
  });
});

test('qmd:// 스킴 경로도 계속 동작한다 (회귀 방지)', () => {
  withProject((dir) => {
    const r = probePath(dir, 'qmd://proj-wiki/decisions/card.md');
    assert.ok(r.resolved);
    assert.equal(r.meta.status, 'verified');
    assert.equal(r.meta.trusted, true);
  });
});

test('첫 세그먼트가 collection 이름이 아니면 벗기지 않는다 (collection 상대 경로)', () => {
  withProject((dir) => {
    // 'decisions' 를 컬렉션명으로 착각해 벗기면 <wiki>/card.md 를 찾아 실패한다.
    // _collection 을 명시해 prefix 판정이 컬렉션명 비교로 이뤄지는지 본다.
    const r = probePath(dir, 'decisions/card.md', 'proj-wiki');
    assert.equal(r.resolved, null, 'wikiPath 상대 경로는 해석 대상이 아니다');
    assert.equal(r.meta.trusted, false, '해석 실패는 fail-closed로 남는다');
  });
});

test('wikiPath 밖 경로는 여전히 거부된다 (fail-closed 보안 경계)', () => {
  withProject((dir) => {
    for (const uri of [
      'proj-docs/outside.md',                       // 다른 컬렉션(raw)
      'qmd://proj-docs/outside.md',
      'proj-wiki/../../docs/outside.md',            // traversal
      join(dir, 'docs', 'outside.md'),              // 절대경로
    ]) {
      const r = probePath(dir, uri, uri.includes('proj-wiki') ? 'proj-wiki' : '');
      assert.equal(r.resolved, null, `wiki_root 밖 경로가 통과됨: ${uri}`);
      assert.equal(r.meta.trusted, false);
    }
  });
});

test('wiki 안의 symlink가 밖을 가리키면 거부된다 (resolve 후 경계 검증)', () => {
  withProject((dir) => {
    // wikiPath 안에 있는 것처럼 보이지만 resolve()가 실제 대상(docs/outside.md)으로
    // 풀어 wiki_root 밖이 된다 → frontmatter를 읽어선 안 된다.
    symlinkSync(join(dir, 'docs', 'outside.md'),
      join(dir, '.auto-context', 'wiki', 'decisions', 'link.md'));
    const r = probePath(dir, 'proj-wiki/decisions/link.md');
    assert.equal(r.resolved, null, 'symlink로 wiki 경계를 우회할 수 없어야 함');
    assert.equal(r.meta.trusted, false, 'fail-closed');
  });
});

test('collectionPaths 미등록 컬렉션도 project_root 상대 후보로 해석된다', () => {
  // base 가 없으면 <root>/<rel> 후보가 남는다 — wikiPath 가 곧 collection 경로인
  // 설정에서 이 후보가 유일한 정답이다.
  const dir = mkdtempSync(join(tmpdir(), 'qmd-wikipath-nobase-'));
  mkdirSync(join(dir, '.auto-context', 'wiki', 'decisions'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionRoles: { 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
  }));
  writeFileSync(join(dir, '.auto-context', 'wiki', 'decisions', 'card.md'),
    '---\nstatus: canon\n---\n# Card\n');
  try {
    const r = probePath(dir, 'proj-wiki/.auto-context/wiki/decisions/card.md');
    assert.ok(r.resolved, 'collectionPaths 없이도 root 상대 후보로 해석');
    assert.equal(r.meta.status, 'canon');
  } finally {
    removeTemp(dir);
  }
});

test('end-to-end: plain path 검수 카드가 recallVerifiedOnly 기본값에서 surface한다', () => {
  // 경로 해석이 깨지면 이 카드가 미검수로 오판돼 recall 이 통째로 0건이 된다
  // (라이브 service-engineering 의 실패 형태 그대로).
  withProject((dir) => {
    const fixture = join(dir, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [
      { file: 'proj-wiki/decisions/card.md', title: 'Card', score: 1 },
    ] }));
    const out = execFileSync('python3', ['core/recall.py'], {
      input: JSON.stringify({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }),
      encoding: 'utf8',
      env: { ...process.env, QMD_QUERY_FIXTURE: fixture },
    }).trim();
    assert.ok(out, 'plain path 검수 카드는 기본 설정에서 surface해야 함');
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /\[wiki:verified\]/, 'status가 태그에 반영');
    assert.doesNotMatch(ctx, /미검수/, '검수 카드에 미검수 배지가 붙으면 안 됨');
  });
});
