import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function recall(payload, env = {}) {
  try {
    const out = execFileSync('python3', ['core/recall.py'], {
      input: JSON.stringify(payload),
      env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
    });
    const outStr = out.toString().trim();
    return outStr ? JSON.parse(outStr) : null;
  } catch (e) {
    console.error("Exec failed:", e.stderr?.toString());
    throw e;
  }
}

test('fixture 응답 → additionalContext 생성', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recall-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /\[sample\]/);   // collection prefix 포맷 유지
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// opt-in 일치: recall(검색)도 명시 설정 없는 폴더에선 fallback collection을 만들지 않는다.
// (미동의 폴더는 인덱싱도 안 되므로 검색 무의미 + 동명 collection 오검색 방지)
test('명시 설정 없는(미동의) 폴더는 fallback collection 없이 빈 출력 (opt-in 일치)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-nooptin-'));   // .agents 없음
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.equal(r, null, '미동의 폴더에서 fallback collection 으로 검색하면 안 됨');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skipPaths 필터 동작', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  
  const tempDir = '/tmp/qmd-test-skip-paths';
  const agentsDir = path.join(tempDir, '.agents');
  
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir);
  }
  
  // Create .agents/qmd-recall.json under tempDir with skipPaths targeting the fixture doc path
  const config = {
    name: 'test-project',
    collections: ['sample'],
    skipPaths: ['guide']
  };
  
  fs.writeFileSync(path.join(agentsDir, 'qmd-recall.json'), JSON.stringify(config));
  
  try {
    const r = recall({
      prompt: '검색 결과 정렬은 어떻게 동작해?',
      cwd: tempDir
    });
    
    // Interactions should be filtered out, so additionalContext should be empty or null
    assert.equal(r, null);
  } finally {
    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('짧은 프롬프트(<10자)는 skip → 빈 출력', () => {
  const r = recall({ prompt: '짧다', cwd: '/tmp' });
  assert.equal(r, null);
});

test('events 에 userPromptSubmit 없으면 recall core skip', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'qmd-recall-events-'));
  try {
    mkdirSync(join(tempDir, '.agents'), { recursive: true });
    writeFileSync(join(tempDir, '.agents', 'qmd-recall.json'), JSON.stringify({
      collections: ['sample'],
      events: ['sessionStart', 'postToolUse'],
    }));
    const r = recall({
      hook_event_name: 'UserPromptSubmit',
      prompt: '검색 결과 정렬은 어떻게 동작해?',
      cwd: tempDir,
    });
    assert.equal(r, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('legacy novel manuscript collection은 lexicalPatterns 없이도 EP exact 검색', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'qmd-recall-legacy-ep-'));
  try {
    mkdirSync(join(tempDir, '.agents'), { recursive: true });
    writeFileSync(join(tempDir, '.agents', 'qmd-recall.json'), JSON.stringify({
      collections: ['story-manuscript'],
      minScore: 0.99,
    }));
    const r = recall({
      prompt: '4화 도준이 죽었다는 장면 확인해줘',
      cwd: tempDir,
    }, { QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-ep.json' });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /EP004/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('claude 골든과 포맷 동일', () => {
  const golden = JSON.parse(readFileSync('test/fixtures/golden/recall-claude.json', 'utf8'));
  const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: 'test/fixtures/proj' });
  
  assert.ok(r, 'recall output should not be null');
  
  const fmt = s => s.replace(/qmd:\/\/\S+/g, 'URI').split('\n').map(l => l.replace(/—.*/, '—'));
  assert.deepEqual(
    fmt(r.hookSpecificOutput.additionalContext),
    fmt(golden.hookSpecificOutput.additionalContext)
  );
});

test('recall core: QMD_SANDBOX=true → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: '/Users/example/work/sample' }),
    env: { ...process.env, QMD_SANDBOX: 'true' },
  });
  assert.equal(out.toString().trim(), '');
});

test('recall core: health timeout 기본값 완화 + QMD_HEALTH_TIMEOUT override', () => {
  const out = execFileSync('python3', ['-c', [
    'import os',
    'from core.recall import DEFAULT_HEALTH_TIMEOUT, health_timeout',
    'print(DEFAULT_HEALTH_TIMEOUT)',
    'os.environ["QMD_HEALTH_TIMEOUT"] = "3.5"',
    'print(health_timeout())',
    'os.environ["QMD_HEALTH_TIMEOUT"] = "invalid"',
    'print(health_timeout())',
    'os.environ["QMD_HEALTH_TIMEOUT"] = "nan"',
    'print(health_timeout())',
    'os.environ["QMD_HEALTH_TIMEOUT"] = "-1"',
    'print(health_timeout())',
  ].join('\n')], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['2.0', '3.5', '2.0', '2.0', '2.0']);
});

test('recall core: --sandbox 인자 → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['core/recall.py', '--sandbox'], {
    input: JSON.stringify({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: '/Users/example/work/sample' }),
  });
  assert.equal(out.toString().trim(), '');
});

test('.auto-context.json indexing:true → recall 동작', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-r-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['sample'] }));
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.match(r.hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('.auto-context.json indexing:false → recall 빈 출력', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rf-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: false, collections: ['sample'] }));
  try {
    assert.equal(recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('레거시 .agents/qmd-recall.json → recall 동작(하위호환)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rl-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.match(r.hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hierarchical recall: wiki 결과가 있으면 raw가 더 높아도 wiki만 우선 주입', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rh-'));
  const fixture = join(dir, 'hierarchical-fixture.json');
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki', 'proj-docs'],
    collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
    recallStrategy: 'hierarchical',
    topN: 3,
    compile: { recallVerifiedOnly: false },
  }));
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-docs/docs/raw-source.md', title: 'Raw source', score: 1.0 },
    { file: 'qmd://proj-wiki/.auto-context/wiki/decisions/config-layout.md', title: 'Wiki decision', score: 0.6 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /\[wiki(?::generated)?\]/);
    assert.match(r.hookSpecificOutput.additionalContext, /config-layout\.md/);
    assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /raw-source\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hierarchical recall: wiki 메타파일(index.md/log.md)은 노이즈라 제외하고 실제 카드만 주입', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rh-meta-'));
  const fixture = join(dir, 'meta-fixture.json');
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionRoles: { 'proj-wiki': 'wiki' },
    recallStrategy: 'hierarchical',
    topN: 5,
    compile: { recallVerifiedOnly: false },
  }));
  // Meta files score higher than the real card (they aggregate every card name),
  // yet must be dropped so the real card survives.
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/log.md', title: 'Wiki Log', score: 0.99 },
    { file: 'qmd://proj-wiki/index.md', title: 'Wiki Index', score: 0.95 },
    { file: 'qmd://proj-wiki/.auto-context/wiki/concepts/real-card.md', title: 'Real card', score: 0.6 },
  ] }));
  try {
    const r = recall({ prompt: '역순 금기 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /real-card\.md/);
    assert.doesNotMatch(ctx, /log\.md/);
    assert.doesNotMatch(ctx, /index\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recall: is_wiki_meta_noise는 wiki role에서만 index.md/log.md를 노이즈로 판정 (non-wiki·실제카드는 유지)', () => {
  const script = `
import sys
sys.path.insert(0, 'core')
import recall as r
cfg = {"collectionRoles": {"w": "wiki", "raw": "raw"}}
def t(coll, name):
    return r.is_wiki_meta_noise({"_collection": coll, "file": f"qmd://{coll}/{name}"}, cfg)
assert t("w", "log.md") is True
assert t("w", "index.md") is True
assert t("w", "concepts/real.md") is False       # 실제 카드
assert t("raw", "index.md") is False             # non-wiki collection의 동명 파일은 유지
assert t("w", "blog.md") is False                # substring 오탐 방지
print("OK")
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();
  assert.equal(out, 'OK');
});

test('hierarchical recall: wiki frontmatter status를 prefix에 표시하고 discarded는 제외', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rh-status-'));
  const fixture = join(dir, 'status-fixture.json');
  mkdirSync(join(dir, '.auto-context', 'wiki', 'decisions'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    recallStrategy: 'hierarchical',
    topN: 3,
    compile: { enabled: true, recallVerifiedOnly: false, excludeStatusesFromRecall: ['discarded', 'contested'], lowPriorityStatuses: ['generated', 'tentative'] },
  }));
  writeFileSync(join(dir, '.auto-context', 'wiki', 'decisions', 'generated.md'), '---\nstatus: generated\n---\n# Generated\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'decisions', 'discarded.md'), '---\nstatus: discarded\n---\n# Discarded\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/decisions/discarded.md', title: 'Discarded wiki', score: 0.99 },
    { file: 'qmd://proj-wiki/decisions/generated.md', title: 'Generated wiki', score: 0.8 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /\[wiki:generated\]/);
    assert.match(r.hookSpecificOutput.additionalContext, /generated\.md/);
    assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /discarded\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 미검수 배지: RC3(오요약 카드를 캐논 근거로 오신뢰) 재발 방지.
// wiki role 프로젝트를 만들고 카드 frontmatter로 검수 여부를 가른다.
function wikiBadgeProject(dir, extraSettings = {}) {
  mkdirSync(join(dir, '.auto-context', 'wiki', 'concepts'), { recursive: true });
  // 이 헬퍼로 만드는 테스트들은 미검수 generated 카드의 배지/강등/exclude 경로를
  // 검증한다 → recallVerifiedOnly를 명시적으로 꺼야 generated가 surface한다
  // (기본값은 true라 미검수 카드를 제외한다). 호출부가 compile을 넘기면 그걸 우선한다.
  const { compile: extraCompile, ...rest } = extraSettings;
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    topN: 3,
    compile: { recallVerifiedOnly: false, ...(extraCompile || {}) },
    ...rest,
  }));
}

// 회귀: 실데몬 /query는 file을 qmd:// 스킴 없이 "collection/path"로 반환한다.
// 스킴 전제 파싱이면 _collection 미주입 → 배지/강등/exclude가 라이브에서 전부 no-op (2026-07-04 발견).
test('plain-path(스킴 없는) 데몬 응답에도 wiki 메타·(미검수) 배지가 적용된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-plainpath-'));
  const fixture = join(dir, 'plain-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical' });
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
  ] }));
  try {
    const r = recall({ prompt: '곁눈으로만 보이는 존재의 관찰 원칙을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /\[wiki:generated\]/);
    assert.match(r.hookSpecificOutput.additionalContext, /\(미검수\)/);
    assert.match(r.hookSpecificOutput.additionalContext, /단독 캐논 근거로 인용 금지/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('미검수 wiki 카드에 (미검수) 배지 + 안내 문구, reviewed:true 카드는 배지 없음', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-badge-'));
  const fixture = join(dir, 'badge-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical' });
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'checked.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: true\n---\n# Checked\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'qmd://proj-wiki/concepts/checked.md', title: 'Checked wiki', score: 0.8 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /auto\.md - Auto wiki \(미검수\)/);
    assert.doesNotMatch(ctx, /checked\.md - Checked wiki \(미검수\)/);
    assert.match(ctx, /단독 캐논 근거로 인용 금지/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('검수 카드만 있으면 미검수 안내 문구가 붙지 않음', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-badge-clean-'));
  const fixture = join(dir, 'clean-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical' });
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'canon.md'),
    '---\nstatus: canon\ncreatedBy: qmd-auto-context\n---\n# Canon\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/canon.md', title: 'Canon wiki', score: 0.9 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /미검수/);
    assert.match(ctx, /\[wiki:canon\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lowPriorityStatuses 강등: 미검수 generated 카드는 topN 절단 전에 검수 카드에 밀림', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-badge-demote-'));
  const fixture = join(dir, 'demote-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical', topN: 1 });
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'canon.md'),
    '---\nstatus: reviewed\ncreatedBy: qmd-auto-context\n---\n# Reviewed\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'qmd://proj-wiki/concepts/canon.md', title: 'Reviewed wiki', score: 0.5 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /canon\.md/, '검수 카드가 저점수여도 topN 슬롯을 우선 확보');
    assert.doesNotMatch(ctx, /auto\.md/, '미검수 generated 카드는 topN=1에서 탈락');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('flat 전략에서도 wiki role 컬렉션이면 미검수 배지 적용', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-badge-flat-'));
  const fixture = join(dir, 'flat-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'flat' }); // flat 명시(기본값은 hierarchical)
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /auto\.md - Auto wiki \(미검수\)/);
    assert.match(ctx, /단독 캐논 근거로 인용 금지/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verified 카드는 검수급 대우: 배지 없음 + lowPriority 강등 면제 + [wiki:verified] 태그', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-verified-'));
  const fixture = join(dir, 'verified-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical', topN: 1 });
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'machine.md'),
    '---\nstatus: verified\ncreatedBy: qmd-auto-context\nreviewed: false\nverifiedBy: claude\n---\n# Machine\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'qmd://proj-wiki/concepts/machine.md', title: 'Machine wiki', score: 0.5 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /\[wiki:verified\] .*machine\.md/, 'verified 카드가 저점수여도 topN 우선(강등 면제)');
    assert.doesNotMatch(ctx, /미검수/, 'verified 카드에 미검수 배지 없음');
    assert.doesNotMatch(ctx, /auto\.md/, '미검수 generated 카드는 topN=1에서 탈락');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// recallVerifiedOnly 기본값(true): 미검수 generated/tentative wiki 카드는 아예 surface하지 않는다.
// 사용자 결정(2026-07-22): generated는 잘못된 정보일 수 있어 검수급만 recall.
// (라이브 hierarchical 경로에선 wiki가 비면 raw로 backfill되지만, backfill은 fixture 경로에
//  `not fixture_path` 가드로 안 타므로 여기선 "미검수 제외 → 빈 출력"만 검증한다.)
test('recallVerifiedOnly 기본(true): 미검수 generated wiki만 있으면 빈 출력(제외)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-vonly-drop-'));
  const fixture = join(dir, 'vonly-drop-fixture.json');
  mkdirSync(join(dir, '.auto-context', 'wiki', 'concepts'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    recallStrategy: 'hierarchical',
    topN: 3,
    // recallVerifiedOnly 미설정 → 기본 true
  }));
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'tent.md'),
    '---\nstatus: tentative\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Tentative\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'qmd://proj-wiki/concepts/tent.md', title: 'Tentative wiki', score: 0.8 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.strictEqual(r, null, '미검수 generated/tentative만 있으면 기본값에서 빈 출력');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recallVerifiedOnly 기본(true): verified/reviewed 카드는 정상 surface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-vonly-keep-'));
  const fixture = join(dir, 'vonly-keep-fixture.json');
  mkdirSync(join(dir, '.auto-context', 'wiki', 'concepts'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    recallStrategy: 'hierarchical',
    topN: 3,
    // recallVerifiedOnly 미설정 → 기본 true
  }));
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'machine.md'),
    '---\nstatus: verified\ncreatedBy: qmd-auto-context\nreviewed: false\nverifiedBy: claude\n---\n# Machine\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'qmd://proj-wiki/concepts/machine.md', title: 'Machine wiki', score: 0.5 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /machine\.md/, 'verified 카드는 기본값에서도 surface');
    assert.doesNotMatch(ctx, /auto\.md/, '미검수 generated 카드는 기본값에서 제외');
    assert.doesNotMatch(ctx, /미검수/, 'verified만 남으므로 미검수 안내 없음');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('flat 전략에서도 contested/discarded 카드는 recall에서 제외 (누출 수정)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-flat-excl-'));
  const fixture = join(dir, 'flat-excl-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'flat' }); // flat 명시(기본값은 hierarchical)
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'contested.md'),
    '---\nstatus: contested\ncreatedBy: qmd-auto-context\n---\n# Contested\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'ok.md'),
    '---\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# OK\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/contested.md', title: 'Contested wiki', score: 0.99 },
    { file: 'qmd://proj-wiki/concepts/ok.md', title: 'OK wiki', score: 0.8 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /contested\.md/, 'flat에서도 contested 제외');
    assert.match(ctx, /ok\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
