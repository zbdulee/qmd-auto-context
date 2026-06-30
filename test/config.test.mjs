import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function loadConfig(json, cwd = '/tmp/x') {
  const out = execFileSync('python3', ['core/config.py', '--cwd', cwd], { input: json });
  return JSON.parse(out);
}

function findProjectConfig(cwd, env = {}) {
  const code = `
import json
import config
result = config.find_project_config(${JSON.stringify(cwd)})
print(json.dumps(result, ensure_ascii=False))
`;
  const out = execFileSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'core', ...env },
  });
  return JSON.parse(out);
}

function migrateLegacyConfig(cwd, env = {}) {
  const code = `
import json
import config
result = config.migrate_legacy_config(${JSON.stringify(cwd)})
print(json.dumps(result, ensure_ascii=False))
`;
  const out = execFileSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'core', ...env },
  });
  return JSON.parse(out);
}

test('기존 novel 스키마 무수정 동작 (신규 필드 부재 → 기본값)', () => {
  const cfg = loadConfig(JSON.stringify({
    name: 'My Story', collections: ['story-manuscript'], minScore: 0.8,
  }));
  assert.equal(cfg.name, 'My Story');
  assert.deepEqual(cfg.collections, ['story-manuscript']);
  assert.equal(cfg.minScore, 0.8);
  assert.equal(cfg.topN, 3);                       // 기본값
  assert.deepEqual(cfg.lexicalPatterns, ['ep']);   // legacy novel collection names auto-enable EP exact search
  assert.deepEqual(cfg.events, ['sessionStart', 'userPromptSubmit', 'postToolUse']);
});

test('신규 필드 파싱', () => {
  const cfg = loadConfig(JSON.stringify({
    name: 'x', collections: ['c'], minScore: 0.5,
    lexicalPatterns: ['ep'], skipPaths: ['.auto-context-ignore'], topN: 5, queryTimeout: 8,
  }));
  assert.deepEqual(cfg.lexicalPatterns, ['ep']);
  assert.deepEqual(cfg.skipPaths, ['.auto-context-ignore']);
  assert.equal(cfg.topN, 5);
  assert.equal(cfg.queryTimeout, 8);
});

test('wiki recall 신규 필드는 additive로 normalize 된다', () => {
  const cfg = loadConfig(JSON.stringify({
    collections: ['proj-docs', 'proj-wiki'],
    collectionRoles: { 'proj-docs': 'raw', 'proj-wiki': 'wiki', 'proj-bad': 'unknown' },
    recallStrategy: 'hierarchical',
    wikiPath: '.auto-context/wiki',
    compile: {
      enabled: true,
      mode: 'auto-wiki',
      autoWrite: true,
      defaultStatus: 'generated',
      requireReviewForCanon: true,
      candidatePath: '.auto-context/compile/candidates.jsonl',
      sourceQueuePath: '.auto-context/compile/source-queue.jsonl',
      tombstonePath: '.auto-context/compile/tombstones.jsonl',
      manifestPath: '.auto-context/compile/generated-manifest.jsonl',
      excludeStatusesFromRecall: ['discarded', 'contested', 'bogus'],
      lowPriorityStatuses: ['generated', 'tentative', 'canon'],
      triggers: ['manual', 'post_session_summary', 'post_tool_source', 'bad'],
      canonSignals: ['확정'],
      maxAutoPageLines: '80',
      maxSourceChars: '12000',
      extractor: { argv: ['python3', 'scripts/extract.py'], timeout: '30' },
    },
  }));
  assert.deepEqual(cfg.collectionRoles, { 'proj-docs': 'raw', 'proj-wiki': 'wiki' });
  assert.equal(cfg.recallStrategy, 'hierarchical');
  assert.equal(cfg.wikiPath, '.auto-context/wiki');
  assert.deepEqual(cfg.compile, {
    enabled: true,
    mode: 'auto-wiki',
    autoWrite: true,
    defaultStatus: 'generated',
    requireReviewForCanon: true,
    candidatePath: '.auto-context/compile/candidates.jsonl',
    sourceQueuePath: '.auto-context/compile/source-queue.jsonl',
    tombstonePath: '.auto-context/compile/tombstones.jsonl',
    manifestPath: '.auto-context/compile/generated-manifest.jsonl',
    excludeStatusesFromRecall: ['discarded', 'contested'],
    lowPriorityStatuses: ['generated', 'tentative'],
    triggers: ['manual', 'post_session_summary', 'post_tool_source'],
    canonSignals: ['확정'],
    maxAutoPageLines: 80,
    maxSourceChars: 12000,
    extractor: { argv: ['python3', 'scripts/extract.py'], timeout: 30, cooldownSeconds: 600 },
    batch: { idleSeconds: 90, maxItems: 5 },
  });
});

test('compile extractor config drops shell strings and invalid timeout', () => {
  const cfg = loadConfig(JSON.stringify({
    compile: {
      enabled: true,
      mode: 'guarded',
      sourceQueuePath: 123,
      maxSourceChars: 'NaN',
      extractor: { command: 'python3 script.py', argv: 'python3 script.py', timeout: 'Infinity' },
    },
  }));
  assert.equal(cfg.compile.sourceQueuePath, '.auto-context/compile/source-queue.jsonl');
  assert.equal(cfg.compile.maxSourceChars, 12000);
  assert.deepEqual(cfg.compile.extractor, { argv: [], timeout: 30, cooldownSeconds: 600 });
});

test('compile extractor config preserves valid built-ins and drops invalid values', () => {
  const cfg = loadConfig(JSON.stringify({
    compile: {
      enabled: true,
      mode: 'auto-wiki',
      extractor: {
        dispatch: 'by-engine',
        argv: [],
        backends: { codex: ['python3', 'custom.py'], bogus: 'python3 bad.py' },
        builtins: ['codex', 'bogus', 42, 'hermes'],
        default: ['python3', 'fallback.py'],
        timeout: 120,
      },
    },
  }));
  assert.deepEqual(cfg.compile.extractor, {
    argv: [],
    timeout: 120,
    cooldownSeconds: 600,
    dispatch: 'by-engine',
    backends: { codex: ['python3', 'custom.py'] },
    builtins: ['codex', 'hermes'],
    default: ['python3', 'fallback.py'],
  });
});

test('빈/깨진 JSON → 전부 기본값', () => {
  const cfg = loadConfig('not json at all');
  assert.deepEqual(cfg.collections, []);
  assert.equal(cfg.topN, 3);
  assert.equal(cfg.queryTimeout, 5);
  assert.equal(cfg.minScore, 0.0);
  assert.deepEqual(cfg.collectionPaths, {});
});

test('indexing 필드 passthrough (true/false/없음)', () => {
  const norm = (input) => JSON.parse(execFileSync('python3', ['core/config.py', '--cwd', '/tmp'], { input: JSON.stringify(input) }).toString());
  assert.equal(norm({ indexing: true }).indexing, true);
  assert.equal(norm({ indexing: false }).indexing, false);
  assert.equal(norm({}).indexing, null);
  assert.equal(norm({ indexing: 'yes' }).indexing, null);
});

test('indexing 문자열 "true"/"false" 강제 (그 외는 null)', () => {
  const norm = (input) => JSON.parse(execFileSync('python3', ['core/config.py', '--cwd', '/tmp'], { input: JSON.stringify(input) }).toString());
  assert.equal(norm({ indexing: 'false' }).indexing, false);   // opt-out 의도 보존
  assert.equal(norm({ indexing: 'TRUE' }).indexing, true);
  assert.equal(norm({ indexing: 'garbage' }).indexing, null);
});

test('config 숫자 타입은 보수적으로 coercion 하고 실패 시 기본값', () => {
  const cfg = loadConfig(JSON.stringify({
    minScore: '0.75',
    topN: '2',
    queryTimeout: '4.5',
  }));
  assert.equal(cfg.minScore, 0.75);
  assert.equal(cfg.topN, 2);
  assert.equal(cfg.queryTimeout, 4.5);

  const fallback = loadConfig(JSON.stringify({
    minScore: 'NaN',
    topN: 'NaN',
    queryTimeout: 'Infinity',
  }));
  assert.equal(fallback.minScore, 0.0);
  assert.equal(fallback.topN, 3);
  assert.equal(fallback.queryTimeout, 5);
});

test('find_project_config: cwd .auto-context.json root/path 반환', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({
    indexing: true,
    collections: ['story'],
  }));
  try {
    const result = findProjectConfig(dir, { HOME: home });
    assert.equal(result.projectRoot, realpathSync(dir));
    assert.equal(result.configPath, join(realpathSync(dir), '.auto-context.json'));
    assert.equal(result.configFormat, 'auto-context-json');
    assert.deepEqual(result.config.collections, ['story']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('find_project_config: .auto-context/settings.json preferred', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['settings'],
  }));
  try {
    const result = findProjectConfig(dir, { HOME: home });
    assert.equal(result.projectRoot, realpathSync(dir));
    assert.equal(result.configPath, join(realpathSync(dir), '.auto-context', 'settings.json'));
    assert.equal(result.configFormat, 'auto-context-dir');
    assert.deepEqual(result.config.collections, ['settings']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('find_project_config: settings.json beats legacy .auto-context.json when both exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({
    indexing: true,
    collections: ['legacy-root'],
  }));
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['settings'],
  }));
  try {
    const result = findProjectConfig(dir, { HOME: home });
    assert.equal(result.configPath, join(realpathSync(dir), '.auto-context', 'settings.json'));
    assert.equal(result.configFormat, 'auto-context-dir');
    assert.deepEqual(result.config.collections, ['settings']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('find_project_config: parent .auto-context.json found from child cwd', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  const child = join(dir, 'docs', 'nested');
  mkdirSync(child, { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({
    indexing: true,
    collections: ['parent'],
  }));
  try {
    const result = findProjectConfig(child, { HOME: home });
    assert.equal(result.projectRoot, realpathSync(dir));
    assert.equal(result.configPath, join(realpathSync(dir), '.auto-context.json'));
    assert.equal(result.configFormat, 'auto-context-json');
    assert.deepEqual(result.config.collections, ['parent']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('find_project_config: legacy .agents/qmd-recall.json still works', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({
    collections: ['legacy'],
  }));
  try {
    const result = findProjectConfig(dir, { HOME: home });
    assert.equal(result.projectRoot, realpathSync(dir));
    assert.equal(result.configPath, join(realpathSync(dir), '.agents', 'qmd-recall.json'));
    assert.equal(result.configFormat, 'agents-legacy');
    assert.deepEqual(result.config.collections, ['legacy']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('find_project_config: no config returns null path and cwd root', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(dir, { recursive: true });
  try {
    const result = findProjectConfig(dir, { HOME: home });
    assert.equal(result.projectRoot, realpathSync(dir));
    assert.equal(result.configPath, null);
    assert.equal(result.configFormat, 'none');
    assert.deepEqual(result.config.collections, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrate_legacy_config moves .auto-context.json to .auto-context/settings.json and deletes old file', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({
    indexing: true,
    collections: ['legacy'],
    minScore: 0.7,
  }));
  try {
    const result = migrateLegacyConfig(dir, { HOME: home });
    assert.equal(result.migrated, true);
    assert.equal(result.from, join(realpathSync(dir), '.auto-context.json'));
    assert.equal(result.to, join(realpathSync(dir), '.auto-context', 'settings.json'));
    assert.equal(existsSync(join(dir, '.auto-context.json')), false);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(cfg.collections, ['legacy']);
    assert.equal(cfg.minScore, 0.7);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrate_legacy_config is no-op when settings.json already exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ collections: ['legacy-root'] }));
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({ collections: ['settings'] }));
  try {
    const result = migrateLegacyConfig(dir, { HOME: home });
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'settings_exists');
    assert.equal(existsSync(join(dir, '.auto-context.json')), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.auto-context', 'settings.json'), 'utf8')).collections, ['settings']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrate_legacy_config leaves legacy file on invalid JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), '{not json');
  try {
    const result = migrateLegacyConfig(dir, { HOME: home });
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'invalid_json');
    assert.equal(existsSync(join(dir, '.auto-context.json')), true);
    assert.equal(existsSync(join(dir, '.auto-context', 'settings.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrate_legacy_config does not migrate .agents/qmd-recall.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-cfg-home-'));
  const dir = join(home, 'proj');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['agents'] }));
  try {
    const result = migrateLegacyConfig(dir, { HOME: home });
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'agents_legacy_not_migrated');
    assert.equal(existsSync(join(dir, '.auto-context', 'settings.json')), false);
    assert.equal(existsSync(join(dir, '.agents', 'qmd-recall.json')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('compile extractor cooldownSeconds is preserved and defaults to 600', () => {
  const withCooldown = loadConfig(JSON.stringify({
    compile: {
      enabled: true,
      mode: 'guarded',
      extractor: { argv: ['python3', 'extract.py'], timeout: 30, cooldownSeconds: 300 },
    },
  }));
  assert.equal(withCooldown.compile.extractor.cooldownSeconds, 300);

  const withDefault = loadConfig(JSON.stringify({
    compile: {
      enabled: true,
      mode: 'guarded',
      extractor: { argv: ['python3', 'extract.py'], timeout: 30 },
    },
  }));
  assert.equal(withDefault.compile.extractor.cooldownSeconds, 600);
});

test('compile.batch normalizes idleSeconds and maxItems; defaults to 90/5 when omitted', () => {
  const withBatch = loadConfig(JSON.stringify({
    compile: {
      enabled: true,
      mode: 'guarded',
      batch: { idleSeconds: 10, maxItems: 2 },
    },
  }));
  assert.deepEqual(withBatch.compile.batch, { idleSeconds: 10, maxItems: 2 });

  const withDefaults = loadConfig(JSON.stringify({
    compile: {
      enabled: true,
      mode: 'guarded',
    },
  }));
  assert.deepEqual(withDefaults.compile.batch, { idleSeconds: 90, maxItems: 5 });
});
