import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function fixture() {
  const base = mkdtempSync(join(ROOT, '.tmp-qmd-notice-'));
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  mkdirSync(join(home, 'projects'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'nohup'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  return {
    base,
    home,
    bin,
    stateDir: join(base, 'notice-state'),
    cacheDir: join(base, 'cache'),
    lockBase: join(base, 'locks'),
    dirtyQueue: join(base, 'dirty-queue'),
  };
}

function settings({ compile = undefined } = {}) {
  return {
    indexing: true,
    collections: ['p-docs'],
    collectionPaths: { 'p-docs': 'docs' },
    ...(compile === undefined ? {} : { compile }),
  };
}

function createProject(f, relative, options = {}) {
  const projectRoot = join(f.home, 'projects', relative);
  mkdirSync(join(projectRoot, 'docs', 'nested'), { recursive: true });
  if (options.config !== false) {
    mkdirSync(join(projectRoot, '.auto-context'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.auto-context', 'settings.json'),
      JSON.stringify(settings({ compile: options.compile }), null, 2),
    );
  }
  if (options.legacyAt === 'root' || options.legacyAt === 'nested') {
    const legacyRoot = options.legacyAt === 'root'
      ? projectRoot
      : join(projectRoot, 'docs', 'nested');
    mkdirSync(join(legacyRoot, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(join(legacyRoot, '.auto-context', 'compile', '.notice-shown'), 'legacy\n');
  }
  return projectRoot;
}

function runMain(f, cwd, { stateDir = f.stateDir, suppressNotice = '' } = {}) {
  const env = {
    ...process.env,
    HOME: f.home,
    PATH: `${f.bin}:${process.env.PATH}`,
    QMD_BACKEND_MANAGER: '/bin/true',
    QMD_CACHE_DIR: f.cacheDir,
    QMD_DIRTY_QUEUE: f.dirtyQueue,
    QMD_LOCK_BASE: f.lockBase,
    QMD_SUPPRESS_NOTICE: suppressNotice,
  };
  if (stateDir === null) {
    delete env.QMD_NOTICE_STATE_DIR;
  } else {
    env.QMD_NOTICE_STATE_DIR = stateDir;
  }
  return execFileSync('bash', [join(ROOT, 'core', 'update.sh')], {
    cwd: ROOT,
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env,
  });
}

function localMarker(f, projectRoot, stateDir = f.stateDir) {
  const hash = createHash('sha256')
    .update(realpathSync(projectRoot), 'utf8')
    .digest('hex');
  return join(stateDir, `${hash}.notice-shown`);
}

function projectMarker(projectRoot) {
  return join(projectRoot, '.auto-context', 'compile', '.notice-shown');
}

const compileWithBuiltins = {
  enabled: true,
  mode: 'auto-wiki',
  triggers: ['post_tool_source'],
  extractor: { dispatch: 'by-engine', backends: {}, builtins: ['claude', 'codex'] },
};

const compileWithoutExtractor = {
  enabled: true,
  mode: 'auto-wiki',
  triggers: ['post_tool_source'],
  extractor: { dispatch: 'by-engine', backends: {}, builtins: [] },
};

test('config 없는 신규 디렉터리는 notice나 프로젝트 파일을 만들지 않는다', () => {
  const f = fixture();
  const project = createProject(f, 'new-novel', { config: false });
  try {
    assert.doesNotMatch(runMain(f, project), /auto-compile/i);
    assert.equal(existsSync(join(project, '.auto-context')), false);
    assert.equal(existsSync(f.stateDir), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('indexing만 활성화된 프로젝트는 compile notice를 만들지 않는다', () => {
  const f = fixture();
  const project = createProject(f, 'index-only');
  try {
    assert.doesNotMatch(runMain(f, project), /auto-compile/i);
    assert.equal(existsSync(f.stateDir), false);
    assert.equal(existsSync(projectMarker(project)), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('compile extractor가 없으면 notice를 만들지 않는다', () => {
  const f = fixture();
  const project = createProject(f, 'no-extractor', { compile: compileWithoutExtractor });
  try {
    assert.doesNotMatch(runMain(f, project), /auto-compile/i);
    assert.equal(existsSync(f.stateDir), false);
    assert.equal(existsSync(projectMarker(project)), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('root cwd에서 user-local marker만 생성되고 프로젝트 내부 marker는 생성되지 않는다', () => {
  const f = fixture();
  const project = createProject(f, 'root-project', { compile: compileWithBuiltins });
  const defaultStateDir = join(f.home, '.config', 'qmd', 'notice-state', 'wiki-auto-compile');
  try {
    const output = runMain(f, project, { stateDir: null });
    assert.match(output, /auto-compile/i);
    assert.match(output, /claude,codex/);
    assert.equal(existsSync(localMarker(f, project, defaultStateDir)), true);
    assert.equal(existsSync(projectMarker(project)), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('nested cwd 실행 후 root cwd를 실행해도 projectRoot marker를 공유하고 재안내하지 않는다', () => {
  const f = fixture();
  const project = createProject(f, 'nested-project', { compile: compileWithBuiltins });
  const nested = join(project, 'docs', 'nested');
  try {
    const first = runMain(f, nested);
    assert.match(first, /auto-compile/i);
    assert.equal(existsSync(localMarker(f, project)), true);
    assert.equal(existsSync(join(nested, '.auto-context')), false);
    assert.equal(existsSync(projectMarker(project)), false);

    const second = runMain(f, project);
    assert.doesNotMatch(second, /auto-compile/i);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('서로 다른 projectRoot는 같은 이름이어도 독립적으로 최초 안내를 받는다', () => {
  const f = fixture();
  const firstProject = createProject(f, 'worktrees/one/same-name', { compile: compileWithBuiltins });
  const secondProject = createProject(f, 'worktrees/two/same-name', { compile: compileWithBuiltins });
  try {
    assert.match(runMain(f, firstProject), /auto-compile/i);
    assert.match(runMain(f, secondProject), /auto-compile/i);
    assert.notEqual(localMarker(f, firstProject), localMarker(f, secondProject));
    assert.equal(existsSync(localMarker(f, firstProject)), true);
    assert.equal(existsSync(localMarker(f, secondProject)), true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('canonical projectRoot의 기존 legacy marker가 있으면 재안내하지 않고 local marker만 생성한다', () => {
  const f = fixture();
  const project = createProject(f, 'legacy-project', {
    compile: compileWithBuiltins,
    legacyAt: 'root',
  });
  try {
    assert.doesNotMatch(runMain(f, project), /auto-compile/i);
    assert.equal(existsSync(localMarker(f, project)), true);
    assert.equal(existsSync(projectMarker(project)), true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('nested cwd 아래에만 있는 legacy marker는 신뢰하지 않고 최초 안내를 표시한다', () => {
  const f = fixture();
  const project = createProject(f, 'nested-legacy-project', {
    compile: compileWithBuiltins,
    legacyAt: 'nested',
  });
  const nested = join(project, 'docs', 'nested');
  try {
    assert.match(runMain(f, nested), /auto-compile/i);
    assert.equal(existsSync(localMarker(f, project)), true);
    assert.equal(existsSync(projectMarker(project)), false);
    assert.equal(existsSync(join(nested, '.auto-context', 'compile', '.notice-shown')), true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('symlink cwd는 realpath projectRoot의 local marker를 공유한다', () => {
  const f = fixture();
  const project = createProject(f, 'symlink-target', { compile: compileWithBuiltins });
  const link = join(f.home, 'projects', 'symlink-entry');
  symlinkSync(project, link, 'dir');
  try {
    assert.match(runMain(f, project), /auto-compile/i);
    assert.doesNotMatch(runMain(f, link), /auto-compile/i);
    assert.equal(localMarker(f, project), localMarker(f, link));
    assert.equal(existsSync(localMarker(f, link)), true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('QMD_SUPPRESS_NOTICE=1이면 wiki notice와 local marker를 선점하지 않는다', () => {
  const f = fixture();
  const project = createProject(f, 'suppressed-project', { compile: compileWithBuiltins });
  try {
    const suppressed = runMain(f, project, { suppressNotice: '1' });
    assert.doesNotMatch(suppressed, /auto-compile/i);
    assert.equal(existsSync(localMarker(f, project)), false);
    assert.equal(existsSync(projectMarker(project)), false);

    const normal = runMain(f, project);
    assert.match(normal, /auto-compile/i);
    assert.equal(existsSync(localMarker(f, project)), true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('쓰기 불가능한 QMD_NOTICE_STATE_DIR도 hook 전체 실패로 전파되지 않는다', () => {
  const f = fixture();
  const project = createProject(f, 'marker-write-failure', { compile: compileWithBuiltins });
  const stateFile = join(f.base, 'state-file');
  writeFileSync(stateFile, 'not a directory\n');
  try {
    assert.doesNotThrow(() => runMain(f, project));
    assert.equal(existsSync(projectMarker(project)), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
