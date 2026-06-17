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
worker `backend/index_worker.sh`: `"$QMD" collection add ... && added=1` 가 **기존 컬렉션**("already exists", exit≠0)에서 added=0 → `[ added = 0 ] && exit 0`으로 update/embed 스킵. 큐는 이미 truncate돼 편집분 유실. update.sh는 retry에서 "already exists"를 성공 처리하나 worker엔 누락. stub qmd(항상 성공) 단위테스트로는 미검출. → fix 필요(아래 fix 브랜치).

## Phase 4 — worker 동작 (stub/실데몬)
- [ ] P4-1: 임시 큐에 항목 넣고 worker 수동 실행(QMD_FAKE_QMD/임시 lock) → collection add/update/embed 호출 + 큐 비움
- [ ] P4-2: writer/embed lock busy 시 큐 보존(coalesce)
- [ ] P4-3: lock에 pid 파일 기록 + 정상 종료 시 정리 (I-1 fix 실환경 확인)

## Phase 5 — marketplace 업그레이드 (claude/codex/agy)
- [ ] P5-1: claude — marketplace update + plugin 재설치 → 캐시 0.3.0, hooks.json에 index 엔트리
- [ ] P5-2: codex — marketplace update + plugin 재설치 → 캐시 0.3.0, hooks-codex.json에 index
- [ ] P5-3: agy — 대상 소설에 `--agy-local` 재실행 → .agents/hooks.json PostToolUse에 posttool+index

## Phase 6 — novel 통합 검증 (실환경 end-to-end)
대상: 잔상(이미 .auto-context.json + jangsang-* 인덱싱됨)
- [ ] P6-1: 잔상 04_Manuscript의 한 파일을 실제 편집(혹은 편집 payload 주입) → dirty 큐(`~/.config/qmd/dirty-queue`)에 jangsang-manuscript 적재
- [ ] P6-2: worker 주기(또는 수동 1회) 실행 후 → 큐 비워지고 qmd 인덱스 갱신, 데몬 reload
- [ ] P6-3: 편집한 내용의 키워드로 recall → 갱신 반영 확인 (reason=selected)
- [ ] P6-4: post-manuscript-edit.sh(자체 Nova 훅)와 글로벌 index 공존 — 충돌/이중부하 없는지(embed lock 직렬화)

## Phase 7 — 회귀
- [ ] P7-1: 기존 recall(UserPromptSubmit) 정상 — 잔상에서 recall 동작(앞 시범과 동일)
- [ ] P7-2: SessionStart update 정상
- [ ] P7-3: `npm test` 전체 pass
- [ ] P7-4: 데몬 부하 — worker 60초 주기가 recall query를 과도하게 막지 않는지(빈 출력 reason 관찰)

---

## 결과 요약
(완료 후 작성)
