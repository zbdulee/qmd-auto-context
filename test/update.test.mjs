import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function resolvePaths(cwd, configJson) {
  // update.sh --resolve-only: qmd 미실행, 컬렉션→경로 매핑 결과만 stdout JSON.
  // 상태(pending/optout/동의)는 stdin config의 indexing/collections로만 판정(파일/전역 안 읽음).
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson });
  return JSON.parse(out.toString());
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
    rmSync(work, { recursive: true, force: true });
  }
});
