import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers/temp.mjs';

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

function sourceRevisionLine(project, relativePath, collection = 'proj-docs') {
  const path = join(project, relativePath);
  const bytes = readFileSync(path);
  const stat = statSync(path, { bigint: true });
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `{kind: "file", path: "${relativePath}", collection: "${collection}", sha256: "${hash}", size: ${stat.size}, mtimeNs: ${stat.mtimeNs}}`;
}

function writeTrustedWikiCard(project, name, sourceText, body = `Fresh card ${name}`) {
  const sourcePath = `docs/source-${name}.md`;
  const cardPath = join(project, '.auto-context', 'wiki', 'concepts', `${name}.md`);
  writeFileSync(join(project, sourcePath), sourceText);
  const revision = sourceRevisionLine(project, sourcePath);
  writeFileSync(cardPath, [
    '---',
    `title: "Card ${name}"`,
    'status: verified',
    'createdBy: qmd-auto-context',
    'sourceRevisions:',
    `  - ${revision}`,
    '---',
    body,
    '',
  ].join('\n'));
  return { sourcePath, cardPath };
}

function freshnessProject(project, { strategy = 'hierarchical', topN = 5, compile = {} } = {}) {
  mkdirSync(join(project, '.auto-context', 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki', 'proj-docs'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki', 'proj-docs': 'docs' },
    collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
    wikiPath: '.auto-context/wiki',
    recallStrategy: strategy,
    topN,
    compile,
  }));
}

function selectionEvent(logPath) {
  return readFileSync(logPath, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .find(event => event.event === 'qmd_recall_selection');
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
    removeTemp(dir);
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
    removeTemp(dir);
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
    removeTemp(tempDir);
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
    removeTemp(tempDir);
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
    removeTemp(tempDir);
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
  } finally { removeTemp(dir); }
});

test('.auto-context.json indexing:false → recall 빈 출력', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rf-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: false, collections: ['sample'] }));
  try {
    assert.equal(recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir }), null);
  } finally { removeTemp(dir); }
});

test('레거시 .agents/qmd-recall.json → recall 동작(하위호환)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rl-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.match(r.hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { removeTemp(dir); }
});

test('hierarchical recall: wiki 결과가 있으면 raw가 더 높아도 wiki만 우선 주입', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rh-'));
  const fixture = join(dir, 'hierarchical-fixture.json');
  freshnessProject(dir, { strategy: 'hierarchical', topN: 3 });
  writeTrustedWikiCard(dir, 'config-layout', '# current config\n', 'Wiki decision body');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-docs/docs/raw-source.md', title: 'Raw source', score: 1.0 },
    { file: 'qmd://proj-wiki/concepts/config-layout.md', title: 'Wiki decision', score: 0.6 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /\[wiki:verified\]/);
    assert.match(r.hookSpecificOutput.additionalContext, /config-layout\.md/);
    assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /raw-source\.md/);
  } finally { removeTemp(dir); }
});

test('hierarchical recall: wiki 메타파일(index.md/log.md)은 노이즈라 제외하고 실제 카드만 주입', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rh-meta-'));
  const fixture = join(dir, 'meta-fixture.json');
  freshnessProject(dir, { strategy: 'hierarchical', topN: 5 });
  writeTrustedWikiCard(dir, 'real-card', '# current source\n', 'Real card body');
  // Meta files score higher than the real card (they aggregate every card name),
  // yet must be dropped so the real card survives.
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/log.md', title: 'Wiki Log', score: 0.99 },
    { file: 'qmd://proj-wiki/index.md', title: 'Wiki Index', score: 0.95 },
    { file: 'qmd://proj-wiki/concepts/real-card.md', title: 'Real card', score: 0.6 },
  ] }));
  try {
    const r = recall({ prompt: '역순 금기 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /real-card\.md/);
    assert.doesNotMatch(ctx, /log\.md/);
    assert.doesNotMatch(ctx, /index\.md/);
  } finally { removeTemp(dir); }
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
  mkdirSync(join(dir, '.auto-context', 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki', 'proj-docs'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki', 'proj-docs': 'docs' },
    collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
    recallStrategy: 'hierarchical',
    topN: 3,
    compile: { enabled: true, recallVerifiedOnly: false, excludeStatusesFromRecall: ['discarded', 'contested'], lowPriorityStatuses: ['generated', 'tentative'] },
  }));
  writeTrustedWikiCard(dir, 'verified', '# verified source\n', '# Verified');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'discarded.md'), '---\nstatus: discarded\ncreatedBy: qmd-auto-context\n---\n# Discarded\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/discarded.md', title: 'Discarded wiki', score: 0.99 },
    { file: 'qmd://proj-wiki/concepts/verified.md', title: 'Verified wiki', score: 0.8 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /\[wiki:verified\]/);
    assert.match(r.hookSpecificOutput.additionalContext, /verified\.md/);
    assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /discarded\.md/);
  } finally { removeTemp(dir); }
});

// 미검수 배지: RC3(오요약 카드를 캐논 근거로 오신뢰) 재발 방지.
// wiki role 프로젝트를 만들고 카드 frontmatter로 검수 여부를 가른다.
function wikiBadgeProject(dir, extraSettings = {}) {
  mkdirSync(join(dir, '.auto-context', 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const { compile: extraCompile, ...rest } = extraSettings;
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki', 'proj-docs'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki', 'proj-docs': 'docs' },
    collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
    topN: 3,
    compile: { recallVerifiedOnly: false, ...(extraCompile || {}) },
    ...rest,
  }));
}

// 회귀: 실데몬 /query는 file을 qmd:// 스킴 없이 "collection/path"로 반환한다.
// 스킴 전제 파싱이면 _collection 미주입 → 배지/강등/exclude가 라이브에서 전부 no-op (2026-07-04 발견).
test('plain-path(스킴 없는) generated wiki도 trusted provenance가 없으면 제외된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-plainpath-'));
  const fixture = join(dir, 'plain-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical' });
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\ntitle: "Auto wiki"\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
  ] }));
  try {
    const r = recall({ prompt: '곁눈으로만 보이는 존재의 관찰 원칙을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(r, null);
  } finally { removeTemp(dir); }
});

test('generated와 reviewed:true 모두 trusted provenance 없이는 제외된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-badge-'));
  const fixture = join(dir, 'badge-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical' });
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\ntitle: "Auto wiki"\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'checked.md'),
    '---\ntitle: "Checked wiki"\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: true\n---\n# Checked\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'qmd://proj-wiki/concepts/checked.md', title: 'Checked wiki', score: 0.8 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(r, null);
  } finally { removeTemp(dir); }
});

test('legacy canon status는 trusted recall 근거가 아니므로 제외된다', () => {
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
    assert.equal(r, null);
  } finally { removeTemp(dir); }
});

test('lowPriority 후보가 높아도 fresh trusted 카드가 topN 슬롯을 확보한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-badge-demote-'));
  const fixture = join(dir, 'demote-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical', topN: 1 });
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\ntitle: "Auto wiki"\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeTrustedWikiCard(dir, 'trusted', '# trusted source\n', '# Trusted');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'qmd://proj-wiki/concepts/trusted.md', title: 'Trusted wiki', score: 0.5 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /trusted\.md/, 'fresh trusted 카드가 저점수여도 topN 슬롯을 확보');
    assert.doesNotMatch(ctx, /auto\.md/, 'untrusted generated 카드는 topN=1에서 탈락');
  } finally { removeTemp(dir); }
});

test('flat 전략에서도 generated wiki는 trusted provenance 없이는 제외된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-badge-flat-'));
  const fixture = join(dir, 'flat-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'flat' }); // flat 명시(기본값은 hierarchical)
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\ntitle: "Auto wiki"\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(r, null);
  } finally { removeTemp(dir); }
});

test('fresh provenanced verified 카드는 [wiki:verified]로 surface한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-verified-'));
  const fixture = join(dir, 'verified-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'hierarchical', topN: 1 });
  writeTrustedWikiCard(dir, 'machine', '# machine source\n', '# Machine');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\ntitle: "Auto wiki"\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
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
  } finally { removeTemp(dir); }
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
    '---\ntitle: "Auto wiki"\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'tent.md'),
    '---\nstatus: tentative\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Tentative\n');
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'qmd://proj-wiki/concepts/tent.md', title: 'Tentative wiki', score: 0.8 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.strictEqual(r, null, '미검수 generated/tentative만 있으면 기본값에서 빈 출력');
  } finally { removeTemp(dir); }
});

test('recallVerifiedOnly 기본(true): fresh provenanced verified만 surface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-vonly-keep-'));
  const fixture = join(dir, 'vonly-keep-fixture.json');
  mkdirSync(join(dir, '.auto-context', 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki', 'proj-docs'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki', 'proj-docs': 'docs' },
    collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
    recallStrategy: 'hierarchical',
    topN: 3,
    // recallVerifiedOnly 미설정 → 기본 true
  }));
  writeTrustedWikiCard(dir, 'machine', '# machine source\n', '# Machine');
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'auto.md'),
    '---\ntitle: "Auto wiki"\nstatus: generated\ncreatedBy: qmd-auto-context\nreviewed: false\n---\n# Auto\n');
  // 라이브 형식(스킴 없는 plain path)으로 둔다 — 데몬 /query가 실제로 이 형태를
  // 반환하므로 스킴 fixture만 있으면 경로 해석 회귀가 라이브에서만 터진다.
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'proj-wiki/concepts/auto.md', title: 'Auto wiki', score: 0.9 },
    { file: 'proj-wiki/concepts/machine.md', title: 'Machine wiki', score: 0.5 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, /machine\.md/, 'verified 카드는 기본값에서도 surface');
    assert.doesNotMatch(ctx, /auto\.md/, '미검수 generated 카드는 기본값에서 제외');
    assert.doesNotMatch(ctx, /미검수/, 'verified만 남으므로 미검수 안내 없음');
  } finally { removeTemp(dir); }
});

test('flat 전략에서도 contested/discarded 카드는 recall에서 제외 (누출 수정)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-flat-excl-'));
  const fixture = join(dir, 'flat-excl-fixture.json');
  wikiBadgeProject(dir, { recallStrategy: 'flat' }); // flat 명시(기본값은 hierarchical)
  writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', 'contested.md'),
    '---\nstatus: contested\ncreatedBy: qmd-auto-context\n---\n# Contested\n');
  writeTrustedWikiCard(dir, 'ok', '# ok source\n', '# OK');
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
  } finally { removeTemp(dir); }
});

test('freshness guard scans past two stale wiki cards until fresh topN is full', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-fresh-select-two-'));
  const fixture = join(dir, 'wiki-fixture.json');
  const logPath = join(dir, 'recall.log');
  try {
    freshnessProject(dir, { topN: 5 });
    const cards = [];
    for (let i = 1; i <= 7; i += 1) {
      const name = String(i);
      const written = writeTrustedWikiCard(dir, name, `# original ${name}\n`,
        `${i <= 2 ? 'Stale' : 'Fresh'} card ${name}`);
      cards.push({ file: `qmd://proj-wiki/concepts/${name}.md`, title: `Card ${name}`, score: 1 - i / 100 });
      if (i <= 2) writeFileSync(join(dir, written.sourcePath), `# changed ${name}\n`);
    }
    writeFileSync(fixture, JSON.stringify({ results: cards }));

    const result = recall(
      { prompt: 'freshness selection order 근거를 알려줘', cwd: dir },
      { QMD_QUERY_FIXTURE: fixture, QMD_RECALL_LOG: logPath },
    );
    const context = result?.hookSpecificOutput.additionalContext || '';
    assert.doesNotMatch(context, /Stale card one|Stale card 1/);
    assert.doesNotMatch(context, /Stale card two|Stale card 2/);
    assert.match(context, /Fresh card 3/);
    assert.match(context, /Fresh card 7/);
    const event = selectionEvent(logPath);
    assert.equal(event.freshness_checked, 7,
      '상위 둘이 stale인 topN:5에서는 #7까지 검사해 fresh 5장을 채운다');
    assert.equal(event.dropped_stale, 2);
    assert.equal(event.freshness_unknown, 0);
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /# changed|# original|[a-f0-9]{64}/i,
      'telemetry must contain counters, not raw bodies or hashes');
  } finally { removeTemp(dir); }
});

test('freshness guard stops at candidate six when one stale card precedes five fresh cards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-fresh-select-one-'));
  const fixture = join(dir, 'wiki-fixture.json');
  const logPath = join(dir, 'recall.log');
  try {
    freshnessProject(dir, { topN: 5 });
    const cards = [];
    for (let i = 1; i <= 7; i += 1) {
      const name = String(i);
      const written = writeTrustedWikiCard(dir, name, `# original ${name}\n`, `Card body ${name}`);
      cards.push({ file: `qmd://proj-wiki/concepts/${name}.md`, title: `Card ${name}`, score: 1 - i / 100 });
      if (i === 1) writeFileSync(join(dir, written.sourcePath), '# changed 1\n');
    }
    writeFileSync(fixture, JSON.stringify({ results: cards }));

    const result = recall(
      { prompt: 'freshness bounded scan 동작을 알려줘', cwd: dir },
      { QMD_QUERY_FIXTURE: fixture, QMD_RECALL_LOG: logPath },
    );
    const context = result?.hookSpecificOutput.additionalContext || '';
    assert.match(context, /Card body 6/);
    assert.doesNotMatch(context, /Card body 7/);
    assert.equal(selectionEvent(logPath).freshness_checked, 6);
  } finally { removeTemp(dir); }
});

test('all stale hierarchical wiki candidates fall back to raw, while wikiOnly stays empty', () => {
  for (const strategy of ['hierarchical', 'wikiOnly']) {
    const dir = mkdtempSync(join(tmpdir(), `qmd-fresh-${strategy}-`));
    const fixture = join(dir, 'wiki-fixture.json');
    const rawFixture = join(dir, 'raw-fixture.json');
    try {
      freshnessProject(dir, { strategy, topN: 3 });
      const written = writeTrustedWikiCard(dir, 'stale', '# original\n', 'Stale wiki body');
      writeFileSync(join(dir, written.sourcePath), '# changed\n');
      writeFileSync(fixture, JSON.stringify({ results: [
        { file: 'qmd://proj-wiki/concepts/stale.md', title: 'Stale wiki', score: 0.95 },
      ] }));
      writeFileSync(rawFixture, JSON.stringify({ results: [
        { file: 'qmd://proj-docs/docs/source-stale.md', title: 'Current raw fallback', score: 0.9 },
      ] }));

      const result = recall(
        { prompt: 'current source fallback 근거를 알려줘', cwd: dir },
        { QMD_QUERY_FIXTURE: fixture, QMD_QUERY_FIXTURE_RAW: rawFixture },
      );
      if (strategy === 'hierarchical') {
        const context = result?.hookSpecificOutput.additionalContext || '';
        assert.match(context, /Current raw fallback/);
        assert.doesNotMatch(context, /Stale wiki body/);
      } else {
        assert.equal(result, null, 'wikiOnly must not replace stale wiki with raw');
      }
    } finally { removeTemp(dir); }
  }
});

test('verified wiki cards without compiler provenance or qmd creator are hard filtered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-fresh-untrusted-'));
  const fixture = join(dir, 'wiki-fixture.json');
  try {
    freshnessProject(dir, { compile: { recallVerifiedOnly: false } });
    writeFileSync(join(dir, 'docs', 'source-good.md'), '# good\n');
    const revision = sourceRevisionLine(dir, 'docs/source-good.md');
    const variants = [
      ['good', `createdBy: qmd-auto-context\nsourceRevisions:\n  - ${revision}`, 'Trusted body'],
      ['legacy', 'createdBy: qmd-auto-context', 'No provenance body'],
      ['missing', `sourceRevisions:\n  - ${revision}`, 'Missing creator body'],
      ['foreign', `createdBy: another-tool\nsourceRevisions:\n  - ${revision}`, 'Foreign creator body'],
    ];
    for (const [name, meta, body] of variants) {
      writeFileSync(join(dir, '.auto-context', 'wiki', 'concepts', `${name}.md`),
        `---\ntitle: "${name}"\nstatus: verified\n${meta}\n---\n${body}\n`);
    }
    writeFileSync(fixture, JSON.stringify({ results: variants.map(([name], index) => ({
      file: `qmd://proj-wiki/concepts/${name}.md`, title: name, score: 0.99 - index / 100,
    })) }));

    const result = recall(
      { prompt: 'trusted wiki provenance 경계를 알려줘', cwd: dir },
      { QMD_QUERY_FIXTURE: fixture },
    );
    const context = result?.hookSpecificOutput.additionalContext || '';
    assert.match(context, /Trusted body/);
    assert.doesNotMatch(context, /No provenance body|Missing creator body|Foreign creator body/);
  } finally { removeTemp(dir); }
});
