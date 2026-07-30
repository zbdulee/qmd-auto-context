import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function resolvePaths(cwd, configJson) {
  // update.sh --resolve-only: qmd 미실행, 컬렉션→경로 매핑 결과만 stdout JSON.
  // 상태(pending/optout/동의)는 stdin config의 indexing/collections로만 판정(파일/전역 안 읽음).
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson });
  return JSON.parse(out.toString());
}

// core/update.sh --worker forks a DETACHED background subshell (embed + dedup scan) that
// keeps writing into the temp workdir after execFileSync returns, racing rmSync (ENOTEMPTY,
// measured ~1 run in 4). Every test here uses a stub qmd, so that background work is
// meaningless; the one test that verifies the fork itself opts out below.
process.env.QMD_SKIP_BACKGROUND_EMBED = '1';

// 정리 자체가 경합에 지지 않게 한다 — 위 가드를 끈 테스트(백그라운드 fork 검증)는 자식이
// 아직 쓰고 있을 수 있으므로 짧게 재시도한다.
function removeTemp(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'EBUSY') throw err;
      execFileSync('sleep', ['0.05']);
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

function repoTemp(prefix) {
  // HOME 하위(~/.cache)에 생성: repo 루트의 .auto-context.json(dogfooding)을 부모 상속하지
  // 않도록 repo 밖에 둔다. tmpdir(/private/tmp)는 risky_path라 resolve_paths가 risky를 반환하므로 쓰지 않는다.
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `qmd-test-${prefix}-`));
}

test('collectionPaths 매핑 해석 (story 패턴)', () => {
  const r = resolvePaths('/Users/example/work/novel/my-novel', JSON.stringify({
    collections: ['story-manuscript', 'story-plot'],
    collectionPaths: { '*-manuscript': '04_Manuscript', '*-plot': '03_Plot' },
  }));
  assert.ok(r.entries.some(e => e.name === 'story-manuscript' && e.path.endsWith('04_Manuscript')));
});

test('설정 없으면 인덱싱하지 않고 pending', () => {
  // 빈 config(파일 없음) → pending. resolve_paths는 stdin config만 보므로 전역 파일 불필요.
  const r = resolvePaths('/Users/example/work/sample', '');
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'pending');
  assert.deepEqual(r.entries, []);
});

test('risky 시스템 경로 거부', () => {
  const r = resolvePaths('/Library/OSAnalytics', '');
  assert.equal(r.refused, true);
});

test('collectionPaths 절대경로와 traversal 은 cwd 밖이면 skip', () => {
  const cwd = repoTemp('qmd-safe-root');
  const outside = repoTemp('qmd-outside');
  try {
    const r = resolvePaths(cwd, JSON.stringify({
      collections: ['ok', 'escape', 'absolute'],
      collectionPaths: {
        ok: '.',
        escape: '../outside',
        absolute: outside,
      },
    }));
    assert.deepEqual(r.entries.map(e => e.name), ['ok']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('collectionPaths 명시 allowRoots 하위 절대경로는 허용', () => {
  const cwd = repoTemp('qmd-safe-root');
  const allowed = repoTemp('qmd-allowed');
  try {
    const r = resolvePaths(cwd, JSON.stringify({
      collections: ['allowed'],
      collectionPaths: { allowed },
      allowRoots: [allowed],
    }));
    assert.deepEqual(r.entries, [{ name: 'allowed', path: allowed }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(allowed, { recursive: true, force: true });
  }
});

test('update core: sessionStart disabled이면 qmd 실행 없이 skip', () => {
  const work = repoTemp('qmd-update-events');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  try {
    mkdirSync(join(work, '.agents'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['x'], events: ['userPromptSubmit'] }));
    writeFileSync(join(bin, 'qmd'), `#!/usr/bin/env sh\necho "$@" >> "${qmdLog}"\nexit 0\n`, { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    assert.throws(() => readFileSync(qmdLog, 'utf8'), 'qmd should not be invoked when sessionStart is disabled');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: sessionStart disabled from .auto-context/settings.json skips qmd', () => {
  const work = repoTemp('qmd-update-settings-events');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      collections: ['x'],
      collectionPaths: { x: 'missing' },
      events: ['userPromptSubmit'],
    }));
    writeFileSync(join(bin, 'qmd'), `#!/usr/bin/env sh\necho "$@" >> "${qmdLog}"\nexit 0\n`, { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    assert.throws(() => readFileSync(qmdLog, 'utf8'), 'qmd should not be invoked when sessionStart is disabled');
    const cfg = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(cfg.collections, ['x'], 'disabled sessionStart must not prune settings');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: missing settings collection root is pruned before qmd update', () => {
  const work = repoTemp('qmd-update-prune-missing');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  const lockBase = join(work, 'locks');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(join(work, 'docs'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['docs', 'gone'],
      collectionPaths: { docs: 'docs', gone: 'missing' },
      collectionRoles: { docs: 'raw', gone: 'wiki' },
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `log="${qmdLog}"`,
      'echo "$@" >> "$log"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: lockBase,
      },
    });

    const cfg = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(cfg.collections, ['docs']);
    assert.deepEqual(cfg.collectionPaths, { docs: 'docs' });
    assert.deepEqual(cfg.collectionRoles, { docs: 'raw' });
    const log = readFileSync(qmdLog, 'utf8');
    assert.match(log, /collection remove gone/);
    assert.doesNotMatch(log, /collection add .*missing --name gone/);
    assert.match(log, /^update$/m);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: failed qmd collection remove keeps settings collection for retry', () => {
  const work = repoTemp('qmd-update-prune-remove-fail');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  const lockBase = join(work, 'locks');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(join(work, 'docs'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['docs', 'gone'],
      collectionPaths: { docs: 'docs', gone: 'missing' },
      collectionRoles: { docs: 'raw', gone: 'wiki' },
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `log="${qmdLog}"`,
      'echo "$@" >> "$log"',
      'case "$1 $2" in',
      '  "collection remove") exit 1 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: lockBase,
      },
    });

    const cfg = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(cfg.collections, ['docs', 'gone']);
    assert.deepEqual(cfg.collectionPaths, { docs: 'docs', gone: 'missing' });
    assert.deepEqual(cfg.collectionRoles, { docs: 'raw', gone: 'wiki' });
    assert.match(readFileSync(qmdLog, 'utf8'), /collection remove gone/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: pruning the last settings collection writes indexing false', () => {
  const work = repoTemp('qmd-update-prune-last');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  const lockBase = join(work, 'locks');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['gone'],
      collectionPaths: { gone: 'missing' },
      collectionRoles: { gone: 'wiki' },
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `log="${qmdLog}"`,
      'echo "$@" >> "$log"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: lockBase,
      },
    });

    const cfg = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, false);
    assert.deepEqual(cfg.collections, []);
    assert.deepEqual(cfg.collectionPaths, {});
    assert.deepEqual(cfg.collectionRoles, {});
    assert.match(readFileSync(qmdLog, 'utf8'), /collection remove gone/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: worker migration does not immediately prune missing legacy collection', () => {
  const work = repoTemp('qmd-update-prune-legacy-migrated');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  const lockBase = join(work, 'locks');
  try {
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context.json'), JSON.stringify({
      indexing: true,
      collections: ['gone'],
      collectionPaths: { gone: 'missing' },
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `log="${qmdLog}"`,
      'echo "$@" >> "$log"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: lockBase,
      },
    });

    const cfg = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(cfg.collections, ['gone']);
    assert.deepEqual(cfg.collectionPaths, { gone: 'missing' });
    assert.doesNotMatch(readFileSync(qmdLog, 'utf8'), /collection remove gone/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: missing root prune refuses symlinked .auto-context directory', () => {
  const work = repoTemp('qmd-update-prune-symlink');
  const outside = repoTemp('qmd-update-prune-symlink-outside');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  const lockBase = join(work, 'locks');
  try {
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    symlinkSync(outside, join(work, '.auto-context'), 'dir');
    writeFileSync(join(outside, 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['gone'],
      collectionPaths: { gone: 'missing' },
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `log="${qmdLog}"`,
      'echo "$@" >> "$log"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: lockBase,
      },
    });

    const cfg = JSON.parse(readFileSync(join(outside, 'settings.json'), 'utf8'));
    assert.deepEqual(cfg.collections, ['gone']);
    assert.doesNotMatch(readFileSync(qmdLog, 'utf8'), /collection remove gone/);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('update core: settings write failure after remove aborts stale update', () => {
  const work = repoTemp('qmd-update-prune-write-fail');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  const lockBase = join(work, 'locks');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(join(work, 'docs'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['docs', 'gone'],
      collectionPaths: { docs: 'docs', gone: 'missing' },
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `log="${qmdLog}"`,
      'echo "$@" >> "$log"',
      'case "$1 $2" in',
      `  "collection remove") chmod 500 "${join(work, '.auto-context')}"; exit 0 ;;`,
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: lockBase,
      },
    });

    const log = readFileSync(qmdLog, 'utf8');
    assert.match(log, /collection remove gone/);
    assert.doesNotMatch(log, /collection add .*missing --name gone/);
    assert.doesNotMatch(log, /^update$/m);
  } finally {
    try {
      execFileSync('chmod', ['700', join(work, '.auto-context')]);
    } catch {
      // ignore cleanup permission repair failures
    }
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: --migrate-config migrates legacy config and prints result', () => {
  const work = repoTemp('qmd-migrate-config');
  try {
    writeFileSync(join(work, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['x'] }));
    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--migrate-config', work], { encoding: 'utf8' });
    assert.ok(out.includes('Migrated'), `expected migrated message, got: ${out}`);
    assert.equal(existsSync(join(work, '.auto-context.json')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8')).collections, ['x']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: --migrate-config no-op when settings exists', () => {
  const work = repoTemp('qmd-migrate-noop');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    writeFileSync(join(work, '.auto-context.json'), JSON.stringify({ collections: ['old'] }));
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({ collections: ['new'] }));
    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--migrate-config', work], { encoding: 'utf8' });
    assert.ok(out.includes('settings_exists'), `expected settings_exists message, got: ${out}`);
    assert.equal(existsSync(join(work, '.auto-context.json')), true);
    assert.deepEqual(JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8')).collections, ['new']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: --migrate-config refuses symlinked .auto-context directory', () => {
  const work = repoTemp('qmd-migrate-symlink');
  const outside = repoTemp('qmd-migrate-outside');
  try {
    writeFileSync(join(work, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['x'] }));
    symlinkSync(outside, join(work, '.auto-context'), 'dir');

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--migrate-config', work], { encoding: 'utf8' });

    assert.match(out, /unsafe_settings_dir/);
    assert.equal(existsSync(join(work, '.auto-context.json')), true);
    assert.equal(existsSync(join(outside, 'settings.json')), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('update core: --init-wiki creates scaffold and enables wiki recall without dropping existing collections', () => {
  const work = repoTemp('qmd-init-wiki');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['docs'],
    }));
    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--init-wiki', work], { encoding: 'utf8' });
    assert.match(out, /wiki scaffold/);
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'SCHEMA.md')), true);
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'decisions')), true);
    const cfg = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    const wikiCollection = cfg.collections.find(c => c !== 'docs');
    assert.match(wikiCollection, /-wiki$/);
    assert.deepEqual(cfg.collections, ['docs', wikiCollection]);
    assert.deepEqual(cfg.collectionPaths, { [wikiCollection]: '.auto-context/wiki' });
    assert.equal(cfg.collectionRoles.docs, 'raw');
    assert.equal(cfg.collectionRoles[wikiCollection], 'wiki');
    assert.equal(cfg.recallStrategy, 'hierarchical');

    writeFileSync(join(work, '.auto-context', 'wiki', 'index.md'), '# custom\n');
    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--init-wiki', work], { encoding: 'utf8' });
    assert.equal(readFileSync(join(work, '.auto-context', 'wiki', 'index.md'), 'utf8'), '# custom\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: --init-wiki without settings creates an opt-in wiki-only config', () => {
  const work = repoTemp('qmd-init-wiki-empty');
  try {
    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--init-wiki', work], { encoding: 'utf8' });
    const cfg = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.equal(cfg.collections.length, 1);
    assert.match(cfg.collections[0], /-wiki$/);
    assert.deepEqual(cfg.collectionPaths, { [cfg.collections[0]]: '.auto-context/wiki' });
    assert.deepEqual(cfg.collectionRoles, { [cfg.collections[0]]: 'wiki' });
    assert.equal(cfg.recallStrategy, 'hierarchical');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: --init-wiki --preset novel creates novel dirs and compile defaults', () => {
  const work = repoTemp('qmd-init-wiki-novel');
  try {
    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--init-wiki', '--preset', 'novel', work], { encoding: 'utf8' });
    assert.match(out, /wiki scaffold/);
    for (const dir of ['characters', 'world', 'timeline', 'plot', 'style', 'discarded', 'sessions', 'decisions']) {
      assert.equal(existsSync(join(work, '.auto-context', 'wiki', dir)), true, `${dir} should exist`);
    }
    const cfg = JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.compile.enabled, true);
    assert.equal(cfg.compile.mode, 'auto-wiki');
    assert.equal(cfg.compile.autoWrite, true);
    assert.equal(cfg.compile.defaultStatus, 'generated');
    assert.equal(cfg.compile.requireReviewForCanon, true);
    // post_tool_source가 없으면 자동 수집 트리거가 하나도 없어 세션 노트를 채워도
    // 카드가 생기지 않는다(post_session_summary는 수동 경로 라벨일 뿐이다).
    assert.ok(cfg.compile.triggers.includes('post_tool_source'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: --init-wiki preserves invalid existing settings.json', () => {
  const work = repoTemp('qmd-init-wiki-invalid');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), '{not json');

    assert.throws(() => execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--init-wiki', work], { encoding: 'utf8' }));

    assert.equal(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8'), '{not json');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki')), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: --init-wiki refuses symlinked .auto-context directory', () => {
  const work = repoTemp('qmd-init-wiki-symlink');
  const outside = repoTemp('qmd-init-wiki-outside');
  try {
    symlinkSync(outside, join(work, '.auto-context'), 'dir');

    assert.throws(() => execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--init-wiki', work], { encoding: 'utf8' }));

    assert.equal(existsSync(join(outside, 'settings.json')), false);
    assert.equal(existsSync(join(outside, 'wiki')), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('update core: --init-wiki refuses symlinked wiki directory', () => {
  const work = repoTemp('qmd-init-wiki-dir-symlink');
  const outside = repoTemp('qmd-init-wiki-dir-outside');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    symlinkSync(outside, join(work, '.auto-context', 'wiki'), 'dir');

    assert.throws(() => execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--init-wiki', work], { encoding: 'utf8' }));

    assert.equal(existsSync(join(outside, 'SCHEMA.md')), false);
    assert.equal(existsSync(join(outside, 'decisions')), false);
    assert.equal(existsSync(join(work, '.auto-context', 'settings.json')), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('update core: worker migrates .auto-context.json before loading config', () => {
  const work = repoTemp('qmd-worker-migrate');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  try {
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context.json'), JSON.stringify({
      indexing: true,
      collections: ['x'],
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `echo "$@" >> "${qmdLog}"`,
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, QMD_CACHE_DIR: fakeHome, QMD_LOCK_BASE: join(work, 'locks') },
    });

    assert.equal(existsSync(join(work, '.auto-context.json')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(work, '.auto-context', 'settings.json'), 'utf8')).collections, ['x']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: QMD_SANDBOX=true → 무출력 exit 0', () => {
  const out = execFileSync('bash', ['core/update.sh'], {
    env: { ...process.env, QMD_SANDBOX: 'true' },
  });
  assert.equal(out.toString().trim(), '');
});

test('update core: --sandbox 인자 → 무출력 exit 0', () => {
  const out = execFileSync('bash', ['core/update.sh', '--sandbox']);
  assert.equal(out.toString().trim(), '');
});

// BUG-2 regression: collection add가 "already exists" + exit 1 반환해도 update/embed는 실행돼야 함
test('pending: 안내 메시지에 --recommend/--optin --recommended/.auto-context/settings.json/--optout/--skip 5개 포함', () => {
  // pending 폴더(config 없음)를 stdin으로 전달해 main() 경로의 pending 분기를 실행.
  // qmd, curl 등 외부 명령이 없어도 pending 분기는 메시지만 출력하고 종료하므로 PATH stub 불필요.
  const work = repoTemp('qmd-pending-msg');
  try {
    // pending 폴더: .auto-context.json 없음. qmd stub도 최소한만 — pending 분기에서 qmd 호출 안 함.
    const bin = join(work, 'bin');
    mkdirSync(bin, { recursive: true });
    // curl stub (healthcheck 억제)
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    // qmd stub (혹시 qmd collection list 같은 게 호출되더라도 exit 0)
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    assert.ok(out.includes('--recommend'), `--recommend 없음: ${out}`);
    assert.ok(out.includes('--optin --recommended'), `--optin --recommended 없음: ${out}`);
    assert.ok(out.includes('.auto-context/settings.json'), `.auto-context/settings.json 없음: ${out}`);
    assert.ok(out.includes('--optout'), `--optout 없음: ${out}`);
    assert.ok(out.includes('--skip'), `--skip 없음: ${out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: collection add already-exists exit 1도 update 실행 (BUG-2)', () => {
  const work = repoTemp('qmd-update-already-exists');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  const lockBase = join(work, 'locks');
  try {
    mkdirSync(join(work, '.agents'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    // indexing: true + collections: ['x'] → resolve-only가 entry를 반환하도록
    writeFileSync(join(work, '.agents', 'qmd-recall.json'), JSON.stringify({
      indexing: true,
      collections: ['x'],
    }));
    // stub qmd: collection list/show → exit 0 (빈 출력); collection add → "already exists" + exit 1;
    // update/embed → exit 0, 로그 기록
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `log="${qmdLog}"`,
      'echo "$@" >> "$log"',
      'case "$1 $2" in',
      '  "collection list") exit 0 ;;',
      '  "collection show") exit 0 ;;',
      '  "collection add") echo "Collection \'x\' already exists" >&2; exit 1 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,           // normalize_qmd_path가 ~/.bun/bin 등을 PATH에 추가 못 하도록
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: lockBase,
      },
    });

    const log = readFileSync(qmdLog, 'utf8');
    assert.ok(log.includes('update'), `qmd update가 호출돼야 하는데 qmd.log 내용: ${log}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: QMD_BIN override may point to a non-qmd filename', () => {
  const work = repoTemp('qmd-update-qmd-bin');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const qmdLog = join(work, 'qmd.log');
  const lockBase = join(work, 'locks');
  const qmdBin = join(bin, 'qmd-custom');
  try {
    mkdirSync(join(work, '.agents'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.agents', 'qmd-recall.json'), JSON.stringify({
      indexing: true,
      collections: ['x'],
    }));
    writeFileSync(qmdBin, [
      '#!/usr/bin/env sh',
      `log="${qmdLog}"`,
      'echo "$@" >> "$log"',
      'case "$1 $2" in',
      '  "collection list") exit 0 ;;',
      '  "collection show") exit 0 ;;',
      '  "collection add") exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `/usr/bin:/bin`,
        HOME: fakeHome,
        QMD_BIN: qmdBin,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: lockBase,
      },
    });

    const log = readFileSync(qmdLog, 'utf8');
    assert.ok(log.includes('update'), `QMD_BIN override가 호출돼야 하는데 qmd.log 내용: ${log}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: dedup hint absent when dedup-needed.jsonl is empty/missing (regression guard)', () => {
  const work = repoTemp('qmd-dedup-hint-empty');
  const bin = join(work, 'bin');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.doesNotMatch(out, /wiki-dedup-resolver/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: dedup hint fires with the exact workflow block when the queue is non-empty (including a stale entry from a past run)', () => {
  const work = repoTemp('qmd-dedup-hint-nonempty');
  const bin = join(work, 'bin');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(
      join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
      JSON.stringify({ pageA: 'entities/a.md', pageB: 'entities/b.md', score: 0.95 }) + '\n',
    );
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.match(out, /wiki-dedup-resolver/);
    const agentBody = readFileSync('agents/wiki-dedup-resolver.md', 'utf8');
    const startMarker = '<!-- WORKFLOW:START -->';
    const endMarker = '<!-- WORKFLOW:END -->';
    const block = agentBody.slice(agentBody.indexOf(startMarker) + startMarker.length, agentBody.indexOf(endMarker)).trim();
    assert.ok(out.includes(block), 'hint stdout must contain the exact workflow block, byte-for-byte');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: dedup hint does not shell out to qmd or curl (file test + text extraction only)', () => {
  const work = repoTemp('qmd-dedup-hint-no-daemon-call');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(
      join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
      JSON.stringify({ pageA: 'entities/a.md', pageB: 'entities/b.md', score: 0.95 }) + '\n',
    );
    // curl always fails (healthcheck suppressed); qmd logs any call it receives.
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), `#!/usr/bin/env sh\necho "$@" >> "${qmdLog}"\nexit 0\n`, { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    // main() legitimately calls qmd for other reasons (preflight, resolve-only) before
    // forking the worker, so we only assert the hint step itself adds no NEW qmd calls
    // beyond what the pre-existing pending/notice logic already makes. The dedup hint
    // logic must never invoke qmd/curl at all -- verified structurally in the next step.
    assert.equal(existsSync(qmdLog), false, 'this pending-style project makes no qmd calls before the dedup hint runs, so any call here would have come from the hint logic');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: dedup queue surfaces a user-facing notice (count + skill trigger), TTL-suppressed on re-run while the model hint still fires every time', () => {
  const work = repoTemp('qmd-dedup-notice');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'home');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(
      join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
      JSON.stringify({ pageA: 'entities/a.md', pageB: 'entities/b.md', score: 0.95 }) + '\n' +
      JSON.stringify({ pageA: 'entities/c.md', pageB: 'entities/d.md', score: 0.91 }) + '\n',
    );
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, QMD_CACHE_DIR: fakeHome };
    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8', input: JSON.stringify({ cwd: work }), env,
    });
    // (a) user-facing notice: exact pending count + skill trigger
    assert.match(out, /wiki 중복 후보 2건 대기/);
    assert.match(out, /\/wiki-dedup/);
    // (b) model-facing spawn hint fires the same run
    assert.match(out, /wiki-dedup-resolver/);

    // Second run within TTL: notice suppressed, but the model hint still fires.
    const out2 = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8', input: JSON.stringify({ cwd: work }), env,
    });
    assert.doesNotMatch(out2, /wiki 중복 후보/);
    assert.match(out2, /wiki-dedup-resolver/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki-dedup skill exists and does NOT re-copy the resolver workflow (SSOT stays in the agent file)', () => {
  const skill = readFileSync('skills/wiki-dedup/SKILL.md', 'utf8');
  // Must reference the resolver agent (the workflow SSOT)...
  assert.match(skill, /wiki-dedup-resolver/);
  // ...but must never re-copy the workflow block itself.
  assert.doesNotMatch(skill, /<!-- WORKFLOW:START -->/);
  // frontmatter name must be the skill's own name
  assert.match(skill, /^name:\s*wiki-dedup\s*$/m);
});

test('update core: merge-review hint absent when merge-needed.jsonl is empty/missing (regression guard)', () => {
  const work = repoTemp('qmd-merge-hint-empty');
  const bin = join(work, 'bin');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.doesNotMatch(out, /wiki-review-resolver/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: merge-review hint fires with the exact workflow block when the queue is non-empty', () => {
  const work = repoTemp('qmd-merge-hint-nonempty');
  const bin = join(work, 'bin');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(
      join(work, '.auto-context', 'compile', 'merge-needed.jsonl'),
      JSON.stringify({ candidate: { title: 'a' }, matchedPath: 'entities/b.md', matchedScore: 0.95, suggestedAction: 'merge' }) + '\n',
    );
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.match(out, /wiki-review-resolver/);
    const agentBody = readFileSync('agents/wiki-review-resolver.md', 'utf8');
    const startMarker = '<!-- WORKFLOW:START -->';
    const endMarker = '<!-- WORKFLOW:END -->';
    const block = agentBody.slice(agentBody.indexOf(startMarker) + startMarker.length, agentBody.indexOf(endMarker)).trim();
    assert.ok(out.includes(block), 'hint stdout must contain the exact workflow block, byte-for-byte');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: merge-needed queue surfaces a user-facing notice (count + skill trigger), TTL-suppressed on re-run while the model hint still fires every time', () => {
  const work = repoTemp('qmd-merge-notice');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'home');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(
      join(work, '.auto-context', 'compile', 'merge-needed.jsonl'),
      JSON.stringify({ candidate: { title: 'a' }, matchedPath: 'entities/b.md', matchedScore: 0.95, suggestedAction: 'merge' }) + '\n' +
      JSON.stringify({ candidate: { title: 'c' }, matchedPath: 'entities/d.md', matchedScore: 0.91, suggestedAction: 'merge' }) + '\n',
    );
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, QMD_CACHE_DIR: fakeHome };
    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8', input: JSON.stringify({ cwd: work }), env,
    });
    assert.match(out, /wiki 병합 검토 후보 2건 대기/);
    assert.match(out, /\/wiki-review/);
    assert.match(out, /wiki-review-resolver/);

    const out2 = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8', input: JSON.stringify({ cwd: work }), env,
    });
    assert.doesNotMatch(out2, /wiki 병합 검토 후보/);
    assert.match(out2, /wiki-review-resolver/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: merge-review hint honors a custom compile.mergeNeededPath instead of the hardcoded default', () => {
  const work = repoTemp('qmd-merge-hint-custom-path');
  const bin = join(work, 'bin');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['x'],
      compile: { mergeNeededPath: '.auto-context/compile/custom-merge-queue.jsonl' },
    }));
    // The default-named file is present but empty -- if the hint reads the hardcoded
    // default path instead of the configured one, this proves it by staying silent.
    writeFileSync(join(work, '.auto-context', 'compile', 'merge-needed.jsonl'), '');
    writeFileSync(
      join(work, '.auto-context', 'compile', 'custom-merge-queue.jsonl'),
      JSON.stringify({ candidate: { title: 'a' }, matchedPath: 'entities/b.md', matchedScore: 0.95, suggestedAction: 'merge' }) + '\n',
    );
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.match(out, /wiki-review-resolver/, 'hint must fire by reading the configured mergeNeededPath, not the hardcoded default');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: merge-review hint does not shell out to qmd or curl (file test + text extraction only)', () => {
  const work = repoTemp('qmd-merge-hint-no-daemon-call');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(
      join(work, '.auto-context', 'compile', 'merge-needed.jsonl'),
      JSON.stringify({ candidate: { title: 'a' }, matchedPath: 'entities/b.md', matchedScore: 0.95, suggestedAction: 'merge' }) + '\n',
    );
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), `#!/usr/bin/env sh\necho "$@" >> "${qmdLog}"\nexit 0\n`, { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(existsSync(qmdLog), false, 'this pending-style project makes no qmd calls before the merge hint runs, so any call here would have come from the hint logic');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: dedup scanner is wired inside the embed subshell, after embed and the conditional reload', () => {
  const script = readFileSync(join(process.cwd(), 'core', 'update.sh'), 'utf8');
  const embedCallIdx = script.indexOf('"$QMD_BIN_RESOLVED" embed');
  const reloadBlockEndIdx = script.indexOf("fi\n", script.indexOf('EMBED reload skipped'));
  const scannerCallIdx = script.indexOf('wiki_dedup_scan.py');
  const nohupBlockEndIdx = script.indexOf("' >/dev/null 2>&1 &");
  assert.ok(embedCallIdx !== -1, 'embed call not found');
  assert.ok(scannerCallIdx !== -1, 'wiki_dedup_scan.py call not found in update.sh');
  assert.ok(scannerCallIdx > embedCallIdx, 'scanner must be wired after the embed call');
  assert.ok(scannerCallIdx > reloadBlockEndIdx, 'scanner must be wired after the conditional reload block');
  assert.ok(scannerCallIdx < nohupBlockEndIdx, 'scanner must still be inside the nested nohup subshell, not after it');
});

test('update core: dedup scanner actually runs inside the embed subshell at runtime', () => {
  const work = repoTemp('qmd-dedup-scanner-runtime');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const dedupLog = join(work, 'dedup.log');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      'case "$1" in',
      '  update) exit 0 ;;',
      '  embed) echo "embedded 0 chunks"; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: join(work, 'locks'),
        QMD_DEDUP_LOG: dedupLog,
        QMD_DEDUP_COOLDOWN_DIR: join(work, 'dedup-cooldown'),
        QMD_SYNC_STATE_DIR: join(work, 'sync-state'),
        // this test IS the fork's regression guard, so it must actually fork
        QMD_SKIP_BACKGROUND_EMBED: '',
      },
    });

    // The embed step (and the scanner after it) run in a detached background
    // subshell; poll briefly for the scanner's own log line to appear.
    const deadline = Date.now() + 3000;
    let seen = false;
    while (Date.now() < deadline) {
      if (existsSync(dedupLog)) { seen = true; break; }
      execFileSync('sleep', ['0.05']);
    }
    assert.equal(seen, true, `wiki_dedup_scan.py did not log within 3s; embed subshell wiring likely broken`);
  } finally {
    removeTemp(work);
  }
});

test('update.sh main: 빈/비JSON stdin에도 SessionStart hook은 exit 0 (set -e 아래 substitution 실패 방어)', () => {
  // 히스토리 버그: main()의 stdin 파싱 substitution이 set -e 아래 python3 crash로
  // 실패하면 SessionStart hook 전체가 exit 1 → 호스트 "SessionStart hook (failed)".
  // main()은 set +e로 동기 경로 전체를 fail-open해야 한다. pending temp dir을 cwd로
  // 줘 fork 없이 pending 안내 후 exit 0 하는 경로를 검증한다.
  const home = repoTemp('update-emptystdin-home');
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    QMD_CACHE_DIR: join(home, 'cache'),
    QMD_DIRTY_QUEUE: join(home, 'dirty-queue'),
    QMD_LOCK_BASE: join(home, 'locks'),
  };
  try {
    for (const input of ['', 'not json {{{', '{}']) {
      const res = spawnSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
        input, cwd: proj, env, encoding: 'utf8',
      });
      assert.equal(res.status, 0, `input=${JSON.stringify(input)} → exit ${res.status} (stderr: ${res.stderr})`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// run_update() 3단계 "Add collections" 회귀 (조용한 실패 = 성공 위장)
//
// 히스토리 버그: entries 추출 python 한 줄이 f-string 안 `\"` 이스케이프 때문에
// SyntaxError 였고 `2>/dev/null` 이 그 stderr 를 버려서, while 루프가 조용히 0회
// 돌았다. collections_ok 초기값 1 → `qmd update` 만 실행 → `END rc=0`.
// 즉 SessionStart 는 `qmd collection add` 를 한 번도 하지 않았는데 로그는 성공으로
// 보였다(index_worker.sh 가 대신 등록해 증상이 가려졌다).
//
// --worker 는 collection add / qmd update 를 동기로 수행하고 embed 만 nohup 백그라운드로
// 넘기므로, 아래 테스트는 폴링 없이 종료 직후 로그를 읽어도 결정적이다.
// ---------------------------------------------------------------------------

function writeQmdStub(path, body) {
  writeFileSync(path, ['#!/usr/bin/env sh', ...body].join('\n'), { mode: 0o755 });
}

function runWorker(work, extraEnv = {}) {
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  return execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: fakeHome,
      QMD_CACHE_DIR: fakeHome,
      QMD_LOCK_BASE: join(work, 'locks'),
      QMD_HOOK_LOG: join(work, 'hook.log'),
      ...extraEnv,
    },
  });
}

test('update core: resolved entries마다 ADD COLLECTION 로그 + qmd collection add 실제 호출 (조용한 0회 루프 회귀)', () => {
  const work = repoTemp('qmd-update-addcol-logs');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  const hookLog = join(work, 'hook.log');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(join(work, 'docs'), { recursive: true });
    mkdirSync(join(work, 'notes'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(work, 'fakehome'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['docs', 'notes'],
      collectionPaths: { docs: 'docs', notes: 'notes' },
    }));
    writeQmdStub(join(bin, 'qmd'), [`echo "$@" >> "${qmdLog}"`, 'exit 0']);

    runWorker(work);

    const hook = readFileSync(hookLog, 'utf8');
    const qmd = readFileSync(qmdLog, 'utf8');

    // (1) 핵심 회귀 방지: 로그 부재가 곧 버그의 증상이었다.
    for (const name of ['docs', 'notes']) {
      assert.ok(
        hook.includes(`ADD COLLECTION: name=${name} path=${join(work, name)}`),
        `ADD COLLECTION 로그가 ${name} 에 없다 — entries 추출이 조용히 0건이 된 회귀:\n${hook}`,
      );
      // (2) 로그만이 아니라 qmd 가 실제 호출됐는지 인자까지 캡처해 확인.
      assert.ok(
        qmd.includes(`collection add ${join(work, name)} --name ${name}`),
        `qmd collection add 가 ${name} 에 대해 호출되지 않았다:\n${qmd}`,
      );
    }
    // entries 가 있었으므로 빈-entries 경고는 없어야 한다.
    assert.doesNotMatch(hook, /WARN: no collection entries resolved/);
    assert.match(hook, /END rc=0/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: entries가 비면 WARN 로그로 표면화 (조용한 실패 금지)', () => {
  const work = repoTemp('qmd-update-addcol-warn');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  const hookLog = join(work, 'hook.log');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(work, 'fakehome'), { recursive: true });
    // cwd 밖 경로는 resolve_paths 가 unsafe 로 skip 하고(entries=[]) prune 도 건드리지
    // 않으므로(unsafe 는 missing 판정에서 continue), refused 아닌 채 entries 만 빈
    // 상태를 만들 수 있다.
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['escape'],
      collectionPaths: { escape: '../outside-of-project' },
    }));
    writeQmdStub(join(bin, 'qmd'), [`echo "$@" >> "${qmdLog}"`, 'exit 0']);

    runWorker(work);

    const hook = readFileSync(hookLog, 'utf8');
    assert.match(hook, /WARN: no collection entries resolved/, `빈 entries가 경고 없이 지나갔다:\n${hook}`);
    assert.doesNotMatch(hook, /ADD COLLECTION/);
    assert.doesNotMatch(readFileSync(qmdLog, 'utf8'), /collection add/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: collection add 실패는 qmd update를 건너뛰고 END rc=1로 남는다 (rc=0 위장 금지)', () => {
  const work = repoTemp('qmd-update-addcol-fail');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  const hookLog = join(work, 'hook.log');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(join(work, 'docs'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(work, 'fakehome'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['docs'],
      collectionPaths: { docs: 'docs' },
    }));
    // "already exists" 를 포함하지 않는 진짜 실패여야 retry() 가 성공으로 삼지 않는다(BUG-2 대비).
    writeQmdStub(join(bin, 'qmd'), [
      `echo "$@" >> "${qmdLog}"`,
      'case "$1 $2" in',
      '  "collection add") echo "permission denied" >&2; exit 1 ;;',
      '  *) exit 0 ;;',
      'esac',
    ]);

    runWorker(work);

    const hook = readFileSync(hookLog, 'utf8');
    const qmd = readFileSync(qmdLog, 'utf8');
    assert.match(hook, /ADD COLLECTION: name=docs/);
    assert.doesNotMatch(qmd, /^update$/m, `collections_ok=0 인데 qmd update가 실행됐다:\n${qmd}`);
    assert.match(hook, /END rc=1/, `collection add 실패가 rc=1로 기록되지 않았다:\n${hook}`);
    assert.doesNotMatch(hook, /END rc=0/, 'collection add 실패가 END rc=0으로 위장됐다');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: entries 추출 python 한 줄이 SyntaxError 없이 TSV를 내고, stderr를 /dev/null로 버리지 않는다', () => {
  // 원인 자체를 직접 단정한다: update.sh 안의 구현 문자열을 그대로 꺼내 실행하므로
  // f-string(또는 다른 quoting 사고)이 다시 들어오면 여기서 즉시 깨진다.
  const script = readFileSync(join(process.cwd(), 'core', 'update.sh'), 'utf8');
  // 키 이름은 role 도입(7단계)에서 entries → indexEntries 로 바뀌었다. 가드가 지키는
  // 성질(구문 오류 없이 TSV를 내고 stderr를 버리지 않는다)은 그대로이므로 키만 따라간다.
  const line = script.split('\n').find(l => l.includes('get("indexEntries", [])') && l.includes('python3 -c'));
  assert.ok(line, 'collection add용 entries 추출 python3 -c 한 줄을 update.sh에서 찾지 못했다');

  // 버그의 은폐 절반: stderr 를 버리면 SyntaxError 가 다시 조용해진다.
  assert.doesNotMatch(line, /2>\/dev\/null/, `entries 추출 stderr를 /dev/null로 버리면 안 된다: ${line}`);

  const open = line.indexOf("python3 -c '") + "python3 -c '".length;
  const code = line.slice(open, line.indexOf("'", open));
  assert.ok(code.includes('json.load'), `추출한 python 코드가 이상하다: ${code}`);

  // 실행: SyntaxError면 exit 1 → execFileSync throw.
  // 동시에 role 계약도 못박는다 — collection add 대상은 indexEntries 뿐이고, role
  // `source`만 담긴 entries/sourceEntries 는 여기로 새면 안 된다.
  const out = execFileSync('python3', ['-c', code], {
    encoding: 'utf8',
    input: JSON.stringify({
      entries: [{ name: 'a', path: 'docs' }, { name: 'b', path: 'notes' }, { name: 'src', path: 'archive' }],
      indexEntries: [{ name: 'a', path: 'docs' }, { name: 'b', path: 'notes' }],
      sourceEntries: [{ name: 'src', path: 'archive' }],
    }),
  });
  assert.equal(out, 'a\tdocs\nb\tnotes\n');

  // indexEntries 키가 없어도 조용히 빈 출력(기본값 경로).
  assert.equal(execFileSync('python3', ['-c', code], { encoding: 'utf8', input: '{}' }), '');
});
