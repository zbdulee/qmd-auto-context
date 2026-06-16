# keepalive cold-start 갭 — 데몬 재시작 직후 첫 recall 빈 출력 (2026-06-16, 후속)

## 한 줄 요약
[WAL 슬로다운 이슈](2026-06-16-qmd-recall-wal-slowdown.md)를 고친 뒤에도, **데몬이 재시작/idle 된 직후 첫 recall은 빈 출력**이 날 수 있다. 원인은 WAL이 아니라 **임베딩 모델 cold load(~10초)가 recall·keepalive의 timeout보다 길고, keepalive가 그 cold를 못 깨우는 구조**다.

## 증상
- 데몬 재시작(launchd reload, embed 후 SIGTERM restart 등) 또는 오래 idle 후, **첫 프롬프트의 recall이 빈 출력**.
- 두 번째 프롬프트부터는 정상(warm, ~0.35초).
- WAL 정리와 무관하게 재현된다.

## 측정 (WAL 정리된 깨끗한 상태)
| 상태 | vec query |
|---|---|
| cold (재시작 직후 첫 vec, 모델 로드 포함) | **~10초** |
| warm | ~0.35초 |

recall의 query timeout은 5초 → cold 10초를 못 기다리고 graceful skip → 빈 출력.

## 근본 원인 (3중 갭)
1. **keepalive vec ping timeout이 5초** (`backend/keepalive.sh`: `curl -s -m 5 ... /query`). cold load(~10초) > 5초라, warm ping 자체가 timeout 나서 **모델을 끝까지 로드시키지 못한다.**
2. **keepalive의 health 게이트가 cold를 회피한다** (`curl -s -m 1 .../health` 즉답할 때만 ping). 데몬이 cold/busy면 health 응답도 느려져(관측상 3.5초) `-m 1`을 초과 → ping을 skip → **cold가 안 풀리는 악순환**.
3. **embed 후 health-wait가 vec warm을 보장하지 않는다** (`core/update.sh`: `/health` 200만 확인하고 break). `/health`는 cold여도 1ms로 답하므로, health-wait 통과 ≠ recall이 빠름. 모델은 여전히 cold일 수 있다.

> WAL 이슈 당시 "cold 21초"로 보였던 것은 WAL(데이터) + 모델 cold가 겹친 값이고, WAL 정리 후 순수 모델 cold는 ~10초로 줄었지만 **여전히 5초 timeout보다 길다.**

## 해결 옵션
- **(A) 데몬 startup self-warmup** — `backend/daemon.sh`가 데몬 기동 직후 vec self-query 1회를 쏴 모델을 미리 로드. keepalive에 의존하지 않고 cold 구간을 데몬 스스로 닫는다. **가장 견고(권장).**
- **(B) keepalive timeout 상향 + health 게이트 완화** — `-m 5` → `-m 25`(cold 10초 + 여유), health 게이트도 cold를 허용하도록(또는 첫 N회는 게이트 무시). cold를 keepalive가 실제로 깨우게 한다.
- **(C) embed 후 health-wait를 vec-warm-wait로** — `core/update.sh`의 `/health` 폴링을 가벼운 vec query 1회로 바꿔, 모델이 실제 warm된 뒤 종료. (단 update worker는 background라 사용자 응답은 안 막지만, 이 워밍이 끝나기 전 첫 프롬프트가 오면 여전히 cold일 수 있어 A의 보완재.)
- **비권장**: recall queryTimeout을 cold보다 길게(예 12초) — 첫 프롬프트가 최대 10초 블로킹돼 UX가 나쁘다.

**권장 조합: (A) + (C).** 데몬이 스스로 warm을 책임지고(A), embed 직후에도 vec warm까지 확인(C). keepalive(B)는 idle 후 유지용으로 timeout만 cold보다 길게.

## 검증/테스트 노트
- 라이브 cold 재현은 데몬 재시작이 필요해 단위 테스트로는 결정적 검증이 어렵다.
- source-grep으로 (A) self-warmup 존재, (B) keepalive timeout ≥ cold, (C) update.sh가 vec warm을 확인하는지 정도를 잠글 수 있다.
- metal GPU(Xcode)가 있으면 cold load 자체가 짧아져 이 갭이 크게 완화된다 — 단 별개 트랙(우선순위 낮음).

## 상태
미해결 — 후속 작업. 증상은 "재시작 직후 첫 프롬프트 1회 빈 출력"으로 제한적이라 치명도는 낮음(두 번째부터 정상). WAL 수정([커밋 이력 참조](2026-06-16-qmd-recall-wal-slowdown.md))과는 독립.
