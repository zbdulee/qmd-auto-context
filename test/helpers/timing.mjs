// 벽시계(wall-clock) 단정의 단일 창구.
//
// 이 스위트는 커밋 게이트이고 CLAUDE.md 는 그것을 "결정적"이라고 부른다. 벽시계 단정은
// 그 서술을 깬다 — 부하의 함수라서 subagent·다른 CLI 가 동시에 도는 머신에서는 회차마다
// 1~3건이 터지고 단독 재실행은 전부 통과한다. 실패가 제품 결함과 무관해지는 순간
// "0 fail" 의 신호 가치가 사라지고, 그것이 지켜야 할 대상이다.
//
// 그래서 기본은 **건너뛴다**. 기능 단정(개수·상태·내용)은 언제나 실행되고 벽시계 비교만
// `QMD_TEST_TIMING=1` opt-in 이다. 선례는 `QMD_SKIP_BACKGROUND_EMBED` 이고 근거도 같다.
//
// **새 벽시계 단정을 추가하기 전에 먼저 물어라: 그 회귀를 개수·상태로 표현할 수 있는가?**
// 대개 표현할 수 있고, 그러면 부하와 무관해진다. 실제로 4곳이 그렇게 대체됐다 —
//   - 예산이 곱해지면 프로브·질의 **개수**가 늘어난다(`df_probes.length`, `queries.length`)
//   - 30초 대기에 걸리면 하네스 timeout 이 자식을 죽여 **`res.signal`** 이 남는다
//   - 백그라운드로 넘겼어야 할 일을 기다렸으면 그 일의 완료 **마커가 존재**한다
// 표현할 수 없는 자리만 아래 표에 예산을 등록하고 `assertWithinBudget` 를 쓴다.
// 상한 숫자를 호출부에 리터럴로 흘리지 말 것 — 흩어지면 다음에 또 하나만 고쳐진다.

import assert from 'node:assert/strict';

/** 벽시계 비교를 실제로 단정하는가. 기본 false. */
export const TIMING_ENFORCED = process.env.QMD_TEST_TIMING === '1';

/**
 * 예산(ms). 등록 조건은 "개수·상태로 표현할 수 없는 회귀"다.
 * 각 항목에 실측값과 무엇을 잡는지 적는다.
 */
export const TIMING_BUDGETS_MS = {
  // test/recall-fixes.test.mjs — 데몬 부재 시 graceful skip.
  // 실측 ~130ms. 잡는 것: 죽은 포트에 대해 recall 이 빠르게 포기하지 않는 모든 형태
  // (제거된 CLI fallback 23초, 또는 새로 들어온 재시도 루프). 재시도 횟수는 데몬에
  // 닿지 못하므로 세어 볼 종점이 없고 — 응답이 없는 포트라 요청 로그도 남지 않는다 —
  // 관측 가능한 신호가 경과 시간뿐인 유일한 자리다. 같은 파일의
  // "CLI fallback 코드가 제거됨" 소스 단정이 **이름이 알려진** 회귀만 덮는다.
  recall_dead_daemon_skip: 8000,
};

/**
 * 부하 무관 기본 동작: 아무것도 단정하지 않는다.
 * `QMD_TEST_TIMING=1` 이면 등록된 예산으로 단정한다.
 *
 * @param {keyof TIMING_BUDGETS_MS} name 예산 표의 키
 * @param {number} elapsed 측정된 경과 ms
 * @returns {boolean} 실제로 단정했는지
 */
export function assertWithinBudget(name, elapsed) {
  const budget = TIMING_BUDGETS_MS[name];
  assert.ok(
    typeof budget === 'number',
    `등록되지 않은 타이밍 예산: ${name} (test/helpers/timing.mjs 표에 추가할 것)`,
  );
  if (!TIMING_ENFORCED) return false;
  assert.ok(
    elapsed < budget,
    `${name}: 예산 ${budget}ms 초과 (${elapsed}ms). ` +
      '부하가 걸린 머신이면 유휴 상태에서 다시 확인할 것 — 이 단정은 QMD_TEST_TIMING=1 opt-in 이다.',
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 백그라운드 산출물 대기 (`waitUntil` / `waitUntilAsync`)
//
// **`assertWithinBudget` 과 처방이 정반대이므로 뭉치지 말 것.** 위쪽은 "이 일이 너무
// 오래 걸리지 않았는가"를 재고, 그 회귀는 대개 개수·상태로 표현할 수 있어 제거 대상이었다.
// 여기서 기다리는 것은 **일어나야 하는 일**(detached fork 가 파일을 쓴다)이고 타임아웃은
// "안 일어났다"를 잡는 **정당한 검출자**다 — 중복 백스톱이 아니므로 opt-in 으로 끄거나
// 제거하지 않는다. 대신 부하에 견디게 만든다. 규칙 셋:
//
// (1) **폴링에 프로세스를 쓰지 않는다.** `execFileSync('sleep', ['0.05'])` 는 폴 1회당
//     프로세스 스폰이라 부하가 걸리면 폴링 자체가 대기 예산을 먹는다(100폴 = 100 스폰,
//     그리고 스폰 지연은 정확히 부하에 비례한다 — 기다려 주려던 그 부하다).
//     `Atomics.wait` 는 스폰 없이 정확히 그 ms 만 잔다. `test/backend-manager.test.mjs`
//     가 이미 쓰던 관례이고, 실측 실패는 전부 `execFileSync('sleep')` 쪽에서 났다.
// (2) **상한은 넉넉하게, 한 곳에.** 상한을 키우는 대가는 **실패할 때만** 치른다 —
//     성공 경로는 조건이 만족되는 즉시 반환하므로 유휴 실행 시간은 그대로다. 즉 비용은
//     "진짜 회귀가 있을 때 그 테스트 하나가 최대 `WAIT_TIMEOUT_MS` 만큼 느려진다"이고,
//     상한이 얇을 때의 비용은 "부하마다 거짓 실패 = 커밋 게이트를 못 쓴다"다.
//     후자가 더 낮은 등급이라 넉넉한 쪽을 택한다. 사이트마다 20·80·200 같은 반복 횟수를
//     손으로 적지 말 것 — 그렇게 흩어져 있던 동안 얇은 자리만 부하에서 터졌다.
// (3) **판정은 호출부의 기능 단정이 그대로 한다.** `waitUntil` 은 기다리기만 하고
//     단정하지 않는다(반환값을 버려도 다음 줄의 단정이 같은 사실을 잡는다).
//     "무엇을 기다리는지"는 predicate 에 그대로 남으므로 대기 사유가 코드에 보인다.
//
// **모든 대기를 이걸로 바꿀 수는 없다.** predicate 가 "아직 안 일어남 → 일어남"으로 단조
// 변하는 경우만 해당한다. **부재를 확인하는 고정 지연**(예: "중복 sleeper 가 추가로 깨지
// 않았다")은 조건이 만족되는 즉시 반환하면 검증이 사라지므로 고정 대기로 남겨야 한다.
// 그 자리에는 왜 폴링이 아닌지 주석을 달아 둔다.

/** 대기 상한(ms). 사이트별 리터럴을 두지 않는다 — 근거는 위 (2). */
export const WAIT_TIMEOUT_MS = Number(process.env.QMD_TEST_WAIT_TIMEOUT_MS) || 20000;

/** 폴 간격(ms). 스폰이 없어 짧게 잡아도 부하를 만들지 않는다. */
export const WAIT_INTERVAL_MS = 25;

/** 프로세스를 스폰하지 않는 동기 sleep. */
function sleepSync(ms) {
  // SharedArrayBuffer 는 Atomics.wait 의 요구사항(공유 메모리)일 뿐이고,
  // 여기서는 "이 스레드를 ms 만큼 재운다"에만 쓴다.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * predicate 가 참이 될 때까지 동기 대기. 참이 되면 즉시 `true`, 상한 초과면 `false`.
 * predicate 가 던지면(아직 없는 파일 읽기 등) "아직 아님"으로 취급한다.
 *
 * **event loop 를 막으므로 자식 프로세스를 다루는 비동기 테스트에서는 쓰지 말 것.**
 * 두 가지가 깨진다: (a) stdout/stderr 를 이벤트 핸들러로 모으면 파이프 버퍼가 차서
 * 자식이 멈춰 교착하고(`test/compile-write-guards.test.mjs`), (b) node 가 SIGCHLD 를
 * 수확하지 못해 죽은 자식이 좀비로 남아 `kill(pid, 0)` 이 계속 성공한다 — 즉 "죽었는가"
 * 단정이 영원히 거짓이 된다(`test/backend-manager-daemon-pid.test.mjs` 선두 주석이
 * 그 실측을 못박고 있다). 그 경우 `waitUntilAsync` 를 쓴다.
 */
export function waitUntil(predicate, { timeoutMs = WAIT_TIMEOUT_MS, intervalMs = WAIT_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ready = false;
    try { ready = Boolean(predicate()); } catch { ready = false; }
    if (ready) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(intervalMs);
  }
}

/** `waitUntil` 의 비동기판. event loop 를 막지 않는다(자식 파이프를 읽는 테스트용). */
export async function waitUntilAsync(predicate, { timeoutMs = WAIT_TIMEOUT_MS, intervalMs = WAIT_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ready = false;
    try { ready = Boolean(await predicate()); } catch { ready = false; }
    if (ready) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}
