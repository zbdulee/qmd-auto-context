import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

test('collectionPaths 매핑 해석 (novel 패턴)', () => {
  const r = resolvePaths('/Users/dulee/work/novel/귀신은 약효가 돌 때 보인다', JSON.stringify({
    collections: ['yakbbal-manuscript', 'yakbbal-plot'],
    collectionPaths: { '*-manuscript': '04_Manuscript', '*-plot': '03_Plot' },
  }));
  assert.ok(r.entries.some(e => e.name === 'yakbbal-manuscript' && e.path.endsWith('04_Manuscript')));
});

test('설정 없으면 인덱싱하지 않고 pending', () => {
  // 빈 config(파일 없음) → pending. resolve_paths는 stdin config만 보므로 전역 파일 불필요.
  const r = resolvePaths('/Users/dulee/work/axiom', '');
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
test('pending: 안내 메시지에 --recommend/--optin --recommended/.auto-context.json/--optout/--skip 5개 포함', () => {
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
    assert.ok(out.includes('.auto-context.json'), `.auto-context.json 없음: ${out}`);
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
  const LOCKDIR = '/tmp/qmd-update.lock.d';
  // 혹시 남은 lock 정리 (cleanup)
  try { rmSync(LOCKDIR, { recursive: true, force: true }); } catch (_) {}
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
        QMD_INSTALL_SKIP_BACKEND: '1',
      },
    });

    const log = readFileSync(qmdLog, 'utf8');
    assert.ok(log.includes('update'), `qmd update가 호출돼야 하는데 qmd.log 내용: ${log}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    try { rmSync(LOCKDIR, { recursive: true, force: true }); } catch (_) {}
  }
});
