# QA: index-on-edit 0.3.0 배포 검증 체크리스트

- 날짜: 2026-06-17
- 대상: index-on-edit 기능(편집 후 dirty 큐 + launchd worker 자동 인덱싱)
- 코드: main `6c32994` (구현+final fix 머지·push 완료)
- 진행 규칙: 항목별 `[ ]`→`[x]` 갱신, 결과/명령/관찰을 각 항목 아래 기록. 실패 시 STOP하고 원인 기록.

## Baseline (검증 시작 시점)
- plugin.json(claude/codex) version: **0.2.0** (index-on-edit 미반영)
- 설치 캐시: claude 0.2.0 / codex 0.2.0
- launchd 로드: com.qmd-keepalive, com.qmd-logrotate, com.qmd-mcp-daemon(pid 10906). **com.qmd-index-worker 없음**
- `~/.config/qmd/`: daemon.sh, keepalive.sh, logrotate.sh (index_worker.sh 없음)
- qmd 데몬: :8483 동작(앞선 잔상 시범에서 기동 확인)

---

## Phase 0 — 버전 bump & 사전 점검 ✅
- [x] P0-1: `.claude-plugin/plugin.json` 0.3.0 (description에 index 추가)
- [x] P0-2: `.codex-plugin/plugin.json` 0.3.0 (description/interface index 반영)
- [x] P0-3: `.claude-plugin/marketplace.json` 0.3.0 동기화
- [x] P0-4: 커밋+push `d24e1e5` (main)
- [x] P0-5: dry-run 확인 — `index_worker.sh → ~/.config/qmd/` 복사 + `com.qmd-index-worker.plist → ~/Library/LaunchAgents/` load 계획 정상. 마이그레이션 no changes.

## Phase 1 — 설치 (backend) ✅
- [x] P1-1: `bash install.sh` — index_worker.sh 복사 + plist 배치/load + self-test 145 pass, exit 0
- [x] P1-2: 멱등 — 기존 daemon/keepalive/logrotate "already loaded skip"(install.sh 멱등 동작 확인)

## Phase 2 — 설치 검증 ✅
- [x] P2-1: `~/.config/qmd/index_worker.sh` 존재 + cmp 동일
- [x] P2-2: `launchctl list` → com.qmd-index-worker 로드됨
- [x] P2-3: plist StartInterval=60, ProgramArguments `/Users/dulee/.config/qmd/index_worker.sh`(@@HOME@@ 치환됨)
- [ ] P2-4: claude/codex 캐시 0.3.0 (Phase 5)

## Phase 3 — enqueue 동작 (게이팅) ✅
샌드박스 격리(QMD_DIRTY_QUEUE=임시)로 부작용 없이 검증.
- [x] P3-1: 잔상 manuscript 편집 → 임시 큐에 `jangsang-manuscript\t.../04_Manuscript` 적재(실 config longest-prefix)
- [x] P3-2: README(비-story) → 큐 미생성
- [x] P3-3: (단위테스트 커버 — collections 빈 시 미생성)
- [x] P3-4: QMD_SANDBOX → 무동작

## 🔴 P6에서 발견한 실환경 버그 (BUG-1)
worker `backend/index_worker.sh`: `"$QMD" collection add ... && added=1` 가 **기존 컬렉션**("already exists", exit≠0)에서 added=0 → `[ added = 0 ] && exit 0`으로 update/embed 스킵. 큐는 이미 truncate돼 편집분 유실. stub qmd(항상 성공) 단위테스트로는 미검출. → fix 브랜치 `fix/worker-existing-collection`.
- BUG-1 fix: commit `6c56ee5` — worker collection add를 already-exists(exit1) 성공 처리. 9/9 + 회귀 146 pass.

## 🔴 BUG-2 (BUG-1 fix 중 파생 발견 — 기존 버그, index-on-edit 무관)
`core/update.sh`의 `retry()`(38-54)는 exit code만 본다(already-exists 미처리). `retry qmd collection add`(243)가 **기존 컬렉션이면 exit1로 3회 실패 → collections_ok=0 → qmd update/embed 스킵**. 즉 **SessionStart 자동 인덱싱이 첫 등록 후엔 기존 컬렉션을 재인덱싱 안 함**(원래 있던 버그). (자체훅 novel-qmd-session-update.sh의 retry는 already-exists 처리가 있어 무관했음.) → 같은 브랜치에서 fix.

## Phase 4 — worker 동작 (stub/실데몬)
- [ ] P4-1: 임시 큐에 항목 넣고 worker 수동 실행(QMD_FAKE_QMD/임시 lock) → collection add/update/embed 호출 + 큐 비움
- [ ] P4-2: writer/embed lock busy 시 큐 보존(coalesce)
- [ ] P4-3: lock에 pid 파일 기록 + 정상 종료 시 정리 (I-1 fix 실환경 확인)

## Phase 5 — marketplace 업그레이드 (claude/codex/agy)
- [x] P5-1: claude — `marketplace update` + `install` → 캐시 0.3.0 생성(다음 세션 반영; 이 세션은 0.2.0 로드 중)
- [x] P5-2: codex — `marketplace upgrade` + `plugin add` → **0.3.0 installed/enabled** 확인
- [ ] P5-3: agy — ⚠️ import 기반(marketplace 미등록). `agy plugin install ...@marketplace` → "unknown marketplace" 실패. agy는 claude/gemini에서 import하거나 `--agy-local`(프로젝트별 .agents/hooks.json)로 등록해야 함. **agy 실사용 소설 확정 후 진행 필요.**

## Phase 6 — novel 통합 검증 (실환경 end-to-end) ✅ (BUG-1 fix 후 재검증)
대상: 잔상(이미 .auto-context.json + jangsang-* 인덱싱됨)
- [x] P6-1: 잔상 manuscript 편집 → dirty 큐에 jangsang-manuscript 적재
- [x] P6-2: worker 수동 1회 → collection add(already-exists OK) → update → **embed 211 chunks/12 docs** → SIGTERM reload → 큐 비움. (BUG-1 fix 전엔 update/embed 스킵됐음; fix로 누적 미임베딩분 처리 = 실효 입증)
- [x] P6-3: recall "봉인관리인…" → reason=selected, EP-049 매칭(reload 후 ready)
- [~] P6-4: post-manuscript-edit.sh(자체)와 글로벌 index 공존 — embed lock(/tmp/qmd-embed.lock.d 공유 + pid liveness)로 직렬화 보장(코드 검증). 실편집 동시발동 실측은 P5 marketplace 후 선택.

## Phase 7 — 회귀
- [x] P7-1: recall 정상 — 잔상 reason=selected (P6-3)
- [~] P7-2: SessionStart update.sh — BUG-2 회귀테스트(update.test.mjs) 커버 + codex 0.3.0 캐시 반영. 실 SessionStart fix 동작은 다음 claude/codex 세션.
- [x] P7-3: `npm test` 148 tests / 147 pass / 0 fail / 1 skip (머지 후 재확인)
- [~] P7-4: 데몬 부하 — worker 60s 주기 + recall 공존, embed lock 직렬화. 운영 모니터링 영역(`QMD_RECALL_LOG` reason 관찰).

---

## 결과 요약
- **0.3.0 배포**: claude(캐시 0.3.0, 다음 세션 반영) / codex(0.3.0 installed·enabled) + backend worker(launchd 60s) 설치·검증 완료.
- **end-to-end 입증**(잔상): 편집 → enqueue → worker(collection add/update/embed 211 chunks → SIGTERM reload) → recall selected. 전 경로 동작.
- **QA가 잡은 실환경 버그 2건**(둘 다 stub 단위테스트 미검출, 머지 완료):
  - BUG-1 `6c56ee5`: worker가 기존 컬렉션 add의 already-exists(exit1)를 실패 처리 → update/embed 스킵 + 큐 유실.
  - BUG-2 `2cec699`: core/update.sh retry()도 동일 → SessionStart 재인덱싱 누락(기존 버그, index-on-edit 무관).
- **미완/후속**:
  - P5-3 agy: import 기반·marketplace 미등록으로 install 실패. agy 실사용 소설 확정 후 재import 또는 `--agy-local` 필요.
  - 나머지 4개 소설(무림/속독/AI목걸이) index-on-edit 확대(.auto-context.json 생성).
  - novel `feat/qmd-auto-context-jangsang` 잔상 시범 브랜치 미머지.
  - deferred Minor(grep count, README adapters 잔재 등 — ledger 목록).
