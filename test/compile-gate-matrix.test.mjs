// compile 활성 게이트 6곳의 **현재** 동작을 입력 조합별로 못박는다.
//
// 스키마 정리 리팩터(`docs/plans/2026-08-03-settings-schema-consolidation.md` §2)가
// `compile.enabled` + `compile.autoWrite`를 `compile.mode` 한 값으로 접는다. 게이트는
// 6곳인데 **판정이 균일하지 않다**:
//
//   - `wiki_compile_enqueue.py` · `wiki_compile_worker.py` · `wiki_compile.py` ·
//     `wiki_verify_worker.py` → `enabled` AND `mode != "off"`
//   - `wiki_dedup_scan.py:310` · `update.sh:1121`(bash) → **`enabled`만** 보고 `mode`는 무시
//
// 그 비대칭 때문에 `enabled:true + mode:"off"`에서 뒤 둘은 **돌고** 앞 넷은 멈춘다.
// 계획이 명시한 유일한 비보존 지점이므로(§2 ※) 여기 표에 그대로 담는다 — 리팩터 후
// 이 파일을 새 입력으로 갱신했을 때 **그 칸 말고 다른 칸의 답이 바뀌면 회귀**다.
//
// 판정을 JS로 재구현하지 않는다. 각 게이트는 실제 모듈/스크립트를 임시 프로젝트에 대해
// 실행하고 "일이 통과했는가"를 관측 가능한 부작용으로 읽는다(큐 줄 · stdout JSON ·
// 로그의 SKIP 줄 · SessionStart notice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedHomeProject, removeTemp } from './helpers/temp.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CORE = join(REPO_ROOT, 'core');

// update.sh --worker의 detached embed fork가 호출자 반환 뒤에도 workdir에 써서
// removeTemp와 경합한다(ENOTEMPTY). 이 파일 전역에서 끈다.
process.env.QMD_SKIP_BACKGROUND_EMBED = '1';

// --- 입력 조합 ---------------------------------------------------------------
//
// `config.compile_config`가 정규화 단계에서 이미 접는 것이 있다(`enabled:false` →
// `mode:"off"` 강제, `COMPILE_MODES` 밖 값 → `"off"`). 그래서 raw 12조합이 도달하는
// 정규화 상태는 5개뿐이고, 그 접힘 자체도 리팩터가 건드리는 표면이라 아래 별도
// 테스트에서 36조합 전수로 따로 단정한다.
const SCENARIOS = [
  { id: 'compile-absent', compile: undefined },
  { id: 'enabled-false', compile: { enabled: false, mode: 'auto-wiki', autoWrite: true } },
  { id: 'enabled-absent', compile: { mode: 'auto-wiki', autoWrite: true } },
  { id: 'enabled-true+mode-off', compile: { enabled: true, mode: 'off', autoWrite: true } },
  { id: 'enabled-true+mode-invalid', compile: { enabled: true, mode: 'bogus', autoWrite: true } },
  { id: 'enabled-true+mode-absent', compile: { enabled: true, autoWrite: true } },
  { id: 'candidates+autoWrite-true', compile: { enabled: true, mode: 'candidates', autoWrite: true } },
  { id: 'candidates+autoWrite-false', compile: { enabled: true, mode: 'candidates', autoWrite: false } },
  { id: 'guarded+autoWrite-true', compile: { enabled: true, mode: 'guarded', autoWrite: true } },
  { id: 'guarded+autoWrite-false', compile: { enabled: true, mode: 'guarded', autoWrite: false } },
  { id: 'auto-wiki+autoWrite-true', compile: { enabled: true, mode: 'auto-wiki', autoWrite: true } },
  { id: 'auto-wiki+autoWrite-false', compile: { enabled: true, mode: 'auto-wiki', autoWrite: false } },
];

// 게이트를 통과했을 때 실제 동작(카드 쓰기·verify 큐잉)까지는 가되, 유료 host CLI가
// 절대 스폰되지 않도록 extractor를 비워 둔다. batch는 "시작 조건 미충족"으로 두어
// worker가 extractor 없이 JSON만 내고 큐를 되돌리게 한다.
function settingsFor(compile) {
  return {
    indexing: true,
    collections: ['gateproj-docs'],
    collectionPaths: { 'gateproj-docs': 'docs' },
    wikiPath: '.auto-context/wiki',
    ...(compile === undefined ? {} : {
      compile: {
        triggers: ['post_tool_source'],
        batch: { idleSeconds: 99999, maxItems: 99 },
        ...compile,
      },
    }),
  };
}

/** 게이트 하나를 위한 독립 프로젝트. 드라이버끼리 부작용이 섞이지 않게 매번 새로 만든다. */
function makeProject(prefix, compile) {
  const { home, dir } = isolatedHomeProject(prefix, 'gateproj');
  mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(join(dir, '.auto-context', 'wiki'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'note.md'), '# note\n\n한 문장 사실.\n');
  writeFileSync(
    join(dir, '.auto-context', 'settings.json'),
    `${JSON.stringify(settingsFor(compile), null, 2)}\n`,
  );
  return { home, dir };
}

function childEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    QMD_CACHE_DIR: join(home, 'cache'),
    QMD_SKIP_BACKGROUND_EMBED: '1',
    QMD_FAKE_PLATFORMS: 'none',
    QMD_BACKEND_MANAGER: '/bin/true',
    // 데몬에 절대 닿지 않게 한다 — 이 머신에 :8483이 떠 있으면 결과가 흔들린다.
    QMD_DAEMON_URL: 'http://127.0.0.1:1',
    QMD_SANDBOX: '',
    ...extra,
  };
}

function py(script, args, env, input) {
  return execFileSync('python3', [join(CORE, script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    ...(input === undefined ? {} : { input }),
  });
}

// --- 게이트 드라이버 ---------------------------------------------------------
//
// 각 드라이버는 'pass' | 'skip'(또는 wiki_compile처럼 더 구체적인 결과 문자열)을 돌려준다.

const GATES = {
  // 1. core/wiki_compile_enqueue.py:106 (compile_gate)
  //    관측: 편집 훅 payload를 먹였을 때 source-queue.jsonl에 줄이 생기는가.
  'enqueue': (compile) => {
    const { home, dir } = makeProject('gate-enq', compile);
    try {
      py('wiki_compile_enqueue.py', [], childEnv(home), JSON.stringify({
        hook_event_name: 'PostToolUse',
        cwd: dir,
        tool_input: { file_path: join(dir, 'docs', 'note.md') },
      }));
      const queue = join(dir, '.auto-context', 'compile', 'source-queue.jsonl');
      if (!existsSync(queue)) return 'skip';
      return readFileSync(queue, 'utf8').trim() ? 'pass' : 'skip';
    } finally {
      removeTemp(home);
    }
  },

  // 2. core/wiki_compile_worker.py:953
  //    관측: --json이 무언가를 출력하는가. 게이트에서 막히면 print 전에 return 0이다.
  //    batch 시작 조건을 일부러 미충족으로 둬서 extractor 스폰 없이 JSON만 나온다.
  'worker': (compile) => {
    const { home, dir } = makeProject('gate-wrk', compile);
    try {
      writeFileSync(
        join(dir, '.auto-context', 'compile', 'source-queue.jsonl'),
        `${JSON.stringify({
          ts: '2026-08-03T00:00:00Z',
          trigger: 'post_tool_source',
          engine: 'unknown',
          cwd: dir,
          source: { kind: 'file', path: 'docs/note.md', collection: 'gateproj-docs' },
        })}\n`,
      );
      const out = py('wiki_compile_worker.py', ['--cwd', dir, '--json'], childEnv(home)).trim();
      return out ? 'pass' : 'skip';
    } finally {
      removeTemp(home);
    }
  },

  // 3. core/wiki_compile.py:1270 (+ autoWrite/guarded 분기 :1365,:1371)
  //    관측: stdout의 action. 게이트에서 막히면 무출력, 통과하면 'created' 또는
  //    'candidate'다. `targetPath`를 명시해 target_reason='explicit'으로 만들고
  //    extractor를 비워 judge를 unavailable로 두면 데몬 질의가 한 번도 일어나지 않는다.
  'wiki_compile': (compile, { confidence = 'high' } = {}) => {
    const { home, dir } = makeProject('gate-cmp', compile);
    try {
      const out = py('wiki_compile.py', ['--cwd', dir], childEnv(home), JSON.stringify({
        title: 'Gate probe',
        summary: '한 문장 사실.',
        suggestedType: 'concept',
        targetPath: 'concepts/gate-probe.md',
        confidence,
        sources: [{ kind: 'file', path: 'docs/note.md' }],
      })).trim();
      if (!out) return 'skip';
      return JSON.parse(out).action;
    } finally {
      removeTemp(home);
    }
  },

  // 4. core/wiki_dedup_scan.py:310  ← `enabled`만 본다
  //    관측: dedup.log의 SKIP 줄. 게이트에서 막히면 'compile.enabled is false',
  //    통과하면 그 다음 게이트('no wiki collection configured')까지 간다.
  //    wiki collection을 설정하지 않았으므로 데몬에는 닿지 않는다.
  'dedup_scan': (compile) => {
    const { home, dir } = makeProject('gate-ded', compile);
    const log = join(home, 'dedup.log');
    try {
      py('wiki_dedup_scan.py', ['--cwd', dir], childEnv(home, { QMD_DEDUP_LOG: log }));
      const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
      if (text.includes('SKIP: compile.enabled is false')) return 'skip';
      assert.match(text, /SKIP: no wiki collection configured/, 'dedup scan이 예상 밖 지점에서 멈췄다');
      return 'pass';
    } finally {
      removeTemp(home);
    }
  },

  // 5. core/wiki_verify_worker.py:959
  //    관측: --json이 무언가를 출력하는가(게이트 통과 시 run() 결과가 반드시 찍힌다).
  'verify_worker': (compile) => {
    const { home, dir } = makeProject('gate-ver', compile);
    try {
      const out = py('wiki_verify_worker.py', ['--cwd', dir, '--json'], childEnv(home)).trim();
      return out ? 'pass' : 'skip';
    } finally {
      removeTemp(home);
    }
  },

  // 6. core/update.sh:1121 (bash)  ← `enabled`만 본다
  //    관측: SessionStart의 verify-ledger notice. compile 디렉터리를 읽기 전용으로 만들면
  //    `preflight_block_reason`이 'audit_ledger_unwritable'을 돌려주고 update.sh가 1줄
  //    알린다. 게이트에서 막히면 python 스니펫이 빈 문자열을 찍어 notice가 없다.
  //    (`test/wiki-compile-notice.test.mjs`에 이 케이스가 없어 침묵해도 스위트가 통과했다.)
  'update_notice': (compile) => {
    const { home, dir } = makeProject('gate-upd', compile);
    const bin = join(home, 'bin');
    const compileDir = join(dir, '.auto-context', 'compile');
    mkdirSync(bin, { recursive: true });
    // 실제 qmd/데몬에 닿지 않게 stub. (notice 테스트와 같은 관용구)
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'nohup'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    chmodSync(compileDir, 0o555);
    try {
      const out = execFileSync('bash', [join(CORE, 'update.sh')], {
        cwd: REPO_ROOT,
        input: JSON.stringify({ cwd: dir }),
        encoding: 'utf8',
        env: childEnv(home, {
          PATH: `${bin}:${process.env.PATH}`,
          QMD_NOTICE_STATE_DIR: join(home, 'notice-state'),
          QMD_DIRTY_QUEUE: join(home, 'dirty-queue'),
          QMD_LOCK_BASE: join(home, 'locks'),
        }),
      });
      return out.includes('verify-deleted.jsonl') ? 'pass' : 'skip';
    } finally {
      chmodSync(compileDir, 0o755);
      removeTemp(home);
    }
  },
};

// --- 기대 매트릭스 -----------------------------------------------------------
//
// 열: enqueue · worker · wiki_compile · dedup_scan · verify_worker · update_notice
// `wiki_compile`만 'created'/'candidate'로 갈린다(autoWrite·guarded가 붙는 유일한 게이트).
const EXPECTED = {
  'compile-absent':            ['skip', 'skip', 'skip',      'skip', 'skip', 'skip'],
  'enabled-false':             ['skip', 'skip', 'skip',      'skip', 'skip', 'skip'],
  'enabled-absent':            ['skip', 'skip', 'skip',      'skip', 'skip', 'skip'],
  // ↓ 계획 §2 ※ — 유일한 비보존 지점. 지금은 뒤 둘만 돈다.
  'enabled-true+mode-off':     ['skip', 'skip', 'skip',      'pass', 'skip', 'pass'],
  'enabled-true+mode-invalid': ['skip', 'skip', 'skip',      'pass', 'skip', 'pass'],
  'enabled-true+mode-absent':  ['skip', 'skip', 'skip',      'pass', 'skip', 'pass'],
  'candidates+autoWrite-true':  ['pass', 'pass', 'candidate', 'pass', 'pass', 'pass'],
  'candidates+autoWrite-false': ['pass', 'pass', 'candidate', 'pass', 'pass', 'pass'],
  'guarded+autoWrite-true':     ['pass', 'pass', 'created',   'pass', 'pass', 'pass'],
  'guarded+autoWrite-false':    ['pass', 'pass', 'candidate', 'pass', 'pass', 'pass'],
  'auto-wiki+autoWrite-true':   ['pass', 'pass', 'created',   'pass', 'pass', 'pass'],
  'auto-wiki+autoWrite-false':  ['pass', 'pass', 'candidate', 'pass', 'pass', 'pass'],
};

const GATE_NAMES = ['enqueue', 'worker', 'wiki_compile', 'dedup_scan', 'verify_worker', 'update_notice'];

test('기대 매트릭스가 시나리오·게이트를 빠짐없이 덮는다', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), SCENARIOS.map((s) => s.id).sort());
  // 복사본을 정렬한다 — GATE_NAMES 자체를 정렬하면 열 순서가 바뀌어 아래 매트릭스가
  // 통째로 어긋난다(실제로 그렇게 깨졌다).
  assert.deepEqual([...GATE_NAMES].sort(), Object.keys(GATES).sort());
  for (const [id, row] of Object.entries(EXPECTED)) {
    assert.equal(row.length, GATE_NAMES.length, `${id}: 행 길이`);
  }
});

for (const scenario of SCENARIOS) {
  test(`게이트 매트릭스: ${scenario.id}`, () => {
    const observed = GATE_NAMES.map((name) => GATES[name](scenario.compile));
    assert.deepEqual(
      observed,
      EXPECTED[scenario.id],
      `${scenario.id}\n  gates:    ${GATE_NAMES.join(' ')}\n  expected: ${EXPECTED[scenario.id].join(' ')}\n  observed: ${observed.join(' ')}`,
    );
  });
}

// `guarded`는 dead가 아니다(계획 "검토에서 정정된 사실"). `mode:"guarded"`에서
// `confidence != "high"`인 후보는 auto-write되지 않고 candidate로 강등된다
// (`wiki_compile.py:1371`). 매트릭스 본체는 confidence='high'로 돌리므로 낮은 쪽을 따로 본다.
test('guarded는 confidence가 high가 아니면 candidate로 강등한다', () => {
  const compile = { enabled: true, mode: 'guarded', autoWrite: true };
  assert.equal(GATES.wiki_compile(compile, { confidence: 'high' }), 'created');
  assert.equal(GATES.wiki_compile(compile, { confidence: 'medium' }), 'candidate');
  // auto-wiki는 confidence를 보지 않는다 — 두 모드의 차이가 바로 이것이다.
  const auto = { enabled: true, mode: 'auto-wiki', autoWrite: true };
  assert.equal(GATES.wiki_compile(auto, { confidence: 'medium' }), 'created');
});

// 게이트가 보는 값은 raw가 아니라 `config.compile_config()`가 정규화한 값이다.
// 그 정규화가 이미 조합을 접고 있으므로(`enabled:false` → mode 강제 off, 무효 mode → off),
// raw 36조합이 도달하는 상태는 5개뿐이다. 리팩터가 `enabled`를 없애면 이 접힘 로직도
// 사라지므로, 지금의 접힘을 명시적으로 남겨 마이그레이션 진리표(§2)와 대조할 수 있게 한다.
test('정규화가 raw 36조합을 5개 상태로 접는다', () => {
  const script = `import json, sys
sys.path.insert(0, sys.argv[1])
import config as qmd_config
out = []
for enabled in (True, False, None):
    for mode in ("off", "candidates", "guarded", "auto-wiki", "bogus", None):
        for auto in (True, False):
            raw = {}
            if enabled is not None:
                raw["enabled"] = enabled
            if mode is not None:
                raw["mode"] = mode
            raw["autoWrite"] = auto
            n = qmd_config.compile_config(raw)
            out.append({
                "in": [enabled, mode, auto],
                "out": [n["enabled"], n["mode"], n["autoWrite"]],
            })
print(json.dumps(out))`;
    const rows = JSON.parse(execFileSync('python3', ['-c', script, CORE], {
      cwd: REPO_ROOT, encoding: 'utf8',
    }));
  assert.equal(rows.length, 36);
  const states = new Set(rows.map((r) => JSON.stringify(r.out)));
  assert.deepEqual([...states].sort(), [
    '[false,"off",false]',
    '[false,"off",true]',
    '[true,"auto-wiki",false]',
    '[true,"auto-wiki",true]',
    '[true,"candidates",false]',
    '[true,"candidates",true]',
    '[true,"guarded",false]',
    '[true,"guarded",true]',
    '[true,"off",false]',
    '[true,"off",true]',
  ].sort());
  for (const row of rows) {
    const [enabled, mode] = row.in;
    const expectedMode = enabled === true && ['candidates', 'guarded', 'auto-wiki'].includes(mode)
      ? mode
      : 'off';
    assert.equal(row.out[1], expectedMode, `in=${JSON.stringify(row.in)}`);
    assert.equal(row.out[0], enabled === true, `in=${JSON.stringify(row.in)} enabled`);
    // autoWrite는 enabled/mode와 무관하게 그대로 통과한다 — 그래서 `enabled:false`인데
    // `autoWrite:true`인 상태가 존재하고, 진리표가 그 조합에도 답을 줘야 한다.
    assert.equal(row.out[2], row.in[2], `in=${JSON.stringify(row.in)} autoWrite`);
  }
});
