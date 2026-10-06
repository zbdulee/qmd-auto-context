# QMD v2 요구사항·검증 추적 (2026-10-06 개발 checkout)

범위: 이 표의 `검증됨`은 **격리된 합성 프로젝트**에서 해당 entrypoint가 실행됐다는 뜻이다. 이 checkout은 설치·운영 활성화·비공개 문서 처리의 증거가 아니다. `제안` 행은 사용자의 명시 요구와 구분한다. 원본, 운영 QMD DB, 전역 hook, 호스트 plugin 등록은 변경하지 않았다.

| ID | 출처 | 수락 기준 | 코드 진입점 | 현재 상태·증거 | 남은 제한 |
| --- | --- | --- | --- | --- | --- |
| W-01 | 사용자 | 원문 C/U/D를 감지하고 출처 역참조로 영향받는 wiki 카드를 찾는다 | `core/wiki_topical_reconcile.py`, `core/wiki_topical_create.py`, `core/wiki_topical_refresh.py`, `core/topical_hook_queue.py` | 새 원문은 owner-only opt-in·teacher 예산 뒤 durable batch→합성 승인 teacher CLI→검수→유사성 판정→게시→격리 QMD 색인·임베딩까지 실제 hook 진입점 시험. 정책 부재는 `auto_teacher_policy_required` 보류, 외부 호출 0. 수정·삭제 중단, 불명확 호출 중복 방지 검증 | 한 worker당 새 원문 1개·카드 최대 12개. 후보가 있으면 명시적 distinct 판결 대기. OS/shell 변경은 다음 경계에서 검출 |
| W-02 | 사용자 | v2 생성 전후에 유사 wiki 후보를 검색하고 중복·충돌을 판단해 검증된 카드만 게시한다 | `core/wiki_topical_similarity.py` `retrieve/evaluate` → `core/wiki_topical_refresh.py` → `core/wiki_topical_backend.py` | 실제 격리 QMD `vsearch`가 생성 전 기존 카드 맥락을 전달하고 생성 후 새 카드와 비교; 정확 동일 증명은 중복 보류, 계획/실제·시점 차이도 별도 scope로 보존; 명시 검토 전 게시 보류 `test/wiki-topical-similarity.test.mjs` | 벡터 점수는 판결이 아님. 의미 판정은 owner-only pair-hash 검토 없으면 미결; 이 경로의 teacher 자동 호출·임의 병합/삭제 없음. 후보 상한 초과·검색 실패·형식이 다른 wiki hit는 보류 |
| W-03 | 사용자 | 다중 출처 중 하나가 삭제되면 생존 근거로 재생성하고 마지막 출처 삭제 시 색인에서 제거한다 | `core/wiki_topical_refresh.py` `refresh_one`, `auto_refresh_pending` → backend generation/verification → publisher sync | 기존 다중 출처 삭제와 격리 QMD CLI/SQLite, 기존 카드 수정+새 원문 혼합 배치의 순차 처리 확인 `test/wiki-topical-refresh-backend.test.mjs`, `test/wiki-topical-create-hook.test.mjs` | 한 worker당 한 카드, 최대 생존 출처 3개; 후보 검토 미결이면 대기 |
| W-04 | 사용자 | 갱신 중단 뒤 확인된 완료 단계만 재사용하고 uncertain 호출은 반복하지 않으며 stale 검색을 막는다 | `core/wiki_topical_refresh.py` `recover_pending`, `core/topical_hook_queue.py`, backend attempt audit, `core/wiki_topical_publish.py` | 단계별 중단 복구·잠금·stale 필터, 부모 SIGKILL 후 detached one-shot과 중복 SessionStart 격리 진입점 검증 | 파일 게시와 QMD SQLite는 단일 트랜잭션이 아님. 미확정 model call은 사람 판단 대기. 합성 Codex 호스트의 자식 생존 확인; Claude 호스트 teardown 미검증 |
| R-01 | 사용자 | 실제 프롬프트에서 QMD 최대 15 후보 → 로컬 Laya 0–3장 → 본문 연결을 확인한다 | `core/recall.py`, `core/context_learning/live_select.py` | opt-in 경로 합성 hook 테스트 `test/context-learning-live-recall.test.mjs`, selector 정책·오류 `test/context-learning-live-selector.test.mjs`; 일반 게시 카드 전체 본문 `test/wiki-topical-publish.test.mjs`; 기존 Mini Laya runtime/base head로 합성 1카드 실제 선택기 호출 성공(0장, predict 2.347초, 관측 peak RSS 2,674,032 KiB) | 미학습 base head가 관련 합성 카드에도 0장을 골랐으므로 품질 통과 증거는 아님; 운영 checkpoint·비공개 프롬프트 미실행; 토큰 초과는 fallback |
| R-02 | 사용자 | 편집 후 입력은 실제 추가/수정 내용만 사용하고 삭제만 한 경우 새 내용 검색을 하지 않는다 | `core/posttool.py` `extract_text`, `edited_paths` | Add/Update/Delete/Move patch 테스트 `test/posttool.test.mjs` | 다른 편집 도구의 제공 입력 필드 품질에 의존 |
| R-03 | 제안: 안전한 opt-in | 선택기 사용 불가·잘못된 응답이면 기존 topN≤3으로 복귀하고 이유·자원을 기록한다 | `core/recall.py` `qmd_laya_selection`, `core/context_learning/live_select.py`, `core/hook_budget.py` | 단계별 선택 실패는 QMD topN≤3; 프롬프트 hook 전체 deadline 시 무주입·정상 종료, 2초 실제 진입점 합성 시험 | 로그 경로 설정 없으면 진단 파일 없음; 모델 선택 근거 설명은 별도 계약 없음 |
| C-01 | 사용자 | 후보 모집단과 검색 설정의 변경을 추적하고 과거 평가를 현재 품질로 섞지 않는다 | `core/context_learning/corpus.py`, `core/context_learning/seam.py`, `core/context_learning_auto.py` | 활성 문서 C/U/D·config 변화, 불변 sample·review queue·현재 평가 차단 `test/context-learning-corpus.test.mjs` | fingerprint는 capture/current cycle 때 계산; 자동 재검색·재라벨링 없음 |
| C-02 | 사용자 | 학습/검증/평가 분리 후 로컬 학습·승격한다 | `core/context_learning/local_cycle.py`, `core/context_learning/schedule.py`, `core/context_learning_auto.py` | 합성 250문항 SessionStart due cycle `test/context-learning-auto-hook.test.mjs`, split/승격 `test/context-learning-cycle.test.mjs`; 실제 Laya는 별도 합성 opt-in smoke | 이 작업 범위에서 비공개 문서·실요청 학습은 수행하지 않음 |
| C-03 | 사용자 | 95% 목표에 가까워질수록 학습 간격을 조절하며 데이터 부족·변화·실패에는 보수적으로 한다 | `core/context_learning/cycle_policy.py` | 50/50과 47/50 cadence 수학 테스트 `test/context-learning-cycle.test.mjs`; 24h–14d | 정규화 Wilson 점수는 학습 빈도 휴리스틱이며 통계적 95% 달성 선언 아님 |
| S-01 | 사용자 | SessionStart는 opt-in 이후 비동기 one-shot을 실행하고 기존 색인·복구를 보존한다 | `core/update_hook_queue.py`, `core/update.sh`, `core/topical_hook_queue.py`, `core/context_learning_auto.py` | SessionStart는 소유자 전용 durable job을 짧게 기록; 첫 미결정 opt-in 안내는 읽기 전용 resolve를 1초 상한으로 같은 턴 출력; 실제 격리 hook의 중복 coalesce·완료 상태·부모 SIGKILL 후 v2 재개 검증 | QMD update worker의 실제 embed 완료와 enqueue 완료는 별개; 두 SessionStart hook의 순서 보장 없음. 다른 기존 안내는 worker 로그에만 남음. 합성 Codex 호스트에서 자식 생존 확인; Claude 호스트 미검증 |
| S-02 | 사용자 | 설치·반복 업데이트·v1 migration은 기존 설정·DB를 보존하고 전환 전 대상 corpus를 증명한다 | `skills/setup/SKILL.md`, `core/install_update.py`, `core/config.py`, `core/qmd_route.py`, `core/backend_manager.sh`, `core/runtime_update.py` | setup CLI 합성: 완료 원장 archive 뒤 새 요청, 기본 QMD root/실제 resolver identity, 설정 복사 직후 kill-point 재개·rollback, v1→검증 v2 mapping, wiki 문서 SHA·벡터·원문 revision 대조, 틀린 config/DB·변경 wiki 차단, daemon 세대 handoff·rollback. 기존 실제 QMD 2.5.3 패키지와 오프라인 모델 스냅샷을 별도 HOME에서 재사용해 setup→3개 합성 wiki 문서의 shadow SQLite/벡터 증명→선택→rollback 통과. 별도 격리 daemon PID는 전환·rollback마다 교체되고 원래 QMD 포인터 바이트가 복원됨. 권장 opt-in 설정 게시부터 scaffold까지 한 잠금 구간과 중단 후 사전 검사 drift rollback 회귀 통과 | 새 coordinator의 신규 npm/uv 설치, 실제 운영 migration, 실제 Codex 호스트 worker 종단은 미실행. 합성 QMD 임베딩은 기존 로컬 모델만 사용하고 외부 HTTP는 차단. 이전 native 설치·Codex worker 생존은 하위 모듈 증거이며 새 coordinator E2E로 간주하지 않음 |
| H-01 | 사용자: Codex 설치·이주 | Codex plugin의 setup skill·hook 등록/실행·opt-in/out·중단복구·rollback이 공통 프로젝트 상태를 따른다 | `.codex-plugin/plugin.json`, `hooks/hooks-codex.json`, `hooks/run-hook`, `skills/setup/SKILL.md`, `core/install_update.py` | manifest 등록, 합성 `recall codex` dispatcher, 선택 DB/QMD wrapper, 합성 optout, SessionStart queue, 동시 setup 단일 generation, 재요청·v1 mapping·rollback 확인. `codex-cli 0.160.1` 설치 확인 | 이전 일회용 Codex host worker 생존은 별도 기반 증거. 새 coordinator의 실제 Codex plugin 등록·skill 발견·hook trust/실제 worker 종단 시험 미실행 |
| H-02 | 사용자: Claude Code 설치·이주 | Claude plugin의 setup skill·hook 등록/실행·opt-in/out·중단복구·rollback이 Codex와 같은 프로젝트/DB/runtime를 안전하게 공유한다 | `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/run-hook`, `skills/setup/SKILL.md`, `core/install_update.py` | manifest 등록, 합성 `recall claude` dispatcher, Codex와 동일한 선택 DB/QMD wrapper, 합성 optout, 두 host의 SessionStart 단일 queue 및 동시 setup 단일 generation 확인. 설정·원본 DB byte 보존 | Claude CLI 2.1.285는 설치됐으나 인증은 보류 중이다. 실제 Claude plugin 등록·skill 발견·hook 실행·worker 생존은 미검증; 인증·trust 변경 없이 별도 검증 필요 |
| I-01 | 제안: 관리형 Laya runtime | self-contained 관리형 Python·패키지 hash lock으로 설치·활성화·rollback하거나 기존 Mini runtime을 증명 후 재사용한다 | `core/context_learning/runtime_setup.py`, `runtime_installer.py`, `core/install_update.py`, `locks/laya-macos-arm64-py312.lock` | uv 0.12.20·Python 3.12.14·35개 hash 고정 PyPI 패키지를 Mac mini 소유자 전용 새 세대에 실제 비활성 설치; MPS 합성 smoke. 새 setup CLI는 가짜 installer로 prepare→activate→rollback과 attested reuse 배선을 합성 시험 | 운영 `active.json` 미생성, 프로젝트/운영 checkpoint 미연결. 새 coordinator에서 실제 uv/모델 호출 미실행. 배포 채널별 source/wheel 재현성과 실제 운영 승격 미검증 |

## 수락 증거의 단계

1. **정적/단위:** 계약, 경로·해시, 분리·간격, fallback을 합성 값으로 검증.
2. **격리 E2E:** 실제 `hooks/run-hook`과 실제 로컬 QMD CLI를 합성 프로젝트·격리 SQLite/캐시로 실행. 모델 호출은 stub runner 또는 별도 합성 Laya smoke에 한정.
3. **운영 수락:** 아직 미수행. 비공개 원문·실제 요청·활성 checkpoint·전역 plugin/hook·운영 DB는 이 표의 성공 근거가 아님.

## 리뷰 요청 범위

이전 독립 검토는 live selector 경계, 증명 재검증, 다중 출처 삭제, current-corpus 평가 차단, SessionStart 순서를 확인했다. 이번 W-02/W-04 변경은 새 최종 회귀와 스냅샷을 고정한 뒤 별도 독립 검토가 가능하다. 검토자는 감사 원장의 completed/uncertain 분기, journal과 reconcile 잠금, publish→retire→QMD sync 중간 상태, 검색 후보의 index/hash/attestation 검증, 명시 reviewer 판결의 pair hash 결속, 검색 실패 시 보류를 확인해야 한다.

## REVIEW-3 보정 증거 (합성 fixture)

`test/review3-runtime-routing.test.mjs`의 네 회귀는 다음 경계를 검증한다.

- **F1 / S-02:** 관리형 wrapper가 가리키는 검증된 패키지의 JS entry와 native module 위치를 daemon이 사용한다. 합성 패키지·모듈로 daemon 경로를 검증했고, 별도로 승인된 신규 비활성 QMD의 native 설치·격리 검색 smoke도 통과했다.
- **F2 / W-02·S-02:** v2 publisher는 선택된 프로젝트 DB/config/cache를 한 묶음으로 사용하고 상충하는 상속 환경값을 거부한다. 합성 `sync` 호출의 세 경로와 원본 DB 보존을 확인했다.
- **F3 / R-01·C-01:** recall과 capture에 같은 선택 경로를 전달하고 학습 지문에 pointer generation을 포함한다. 같은 collection의 전역/선택 DB에 서로 다른 hash를 넣어 capture 지문이 선택 DB에 결속되는지 확인했다.
- **F4 / W-04·S-01:** 잠금 획득에 실패한 중복 worker가 남긴 새 job을 소유 worker가 재스캔해 처리한다.

이 합성 회귀와 별도로 승인된 신규 QMD 비활성 `npm ci`·native/격리 query smoke, 공식 trust를 거친 합성 Codex 호스트의 update·topical worker 종료 후 완료가 확인됐다. 운영 프로젝트 pointer 전환, Claude 호스트, 비공개 자료·모델 품질은 미검증이다.

INSTALL-REVIEW-2 경계: `test/install-update-coordinator.test.mjs`의 실제 CLI subprocess는 동일 프로젝트 publisher 잠금 중 wiki 변경을 cutover 전에 거부한다. 포인터 직후 수동 wiki 변경은 post-cutover corpus/DB 대조 실패와 즉시 rollback으로 확인했다. `test/backend-manager.test.mjs`는 살아 있지만 unhealthy인 PID를 daemon 부재와 구분하고, coordinator 합성 CLI는 해당 PID의 reload·새 JS/Node identity를 확인한다. QMD probe 및 manager reload의 `TimeoutExpired`는 traceback 대신 구조화된 rollback/recovery 응답으로 검증한다. 비협조적인 외부 편집기의 적용 완료 후 새 변경, 실제 운영 daemon과 Claude CLI 등록은 별도 미검증이다.

INSTALL-REVIEW-3: 일반 compile·verify·dedup·repair·migration 및 topical wiki writer가 공통 재진입 프로젝트 잠금을 사용한다. 합성 별도 프로세스에서 compile 쓰기와 검수 stamp가 cutover 동안 대기하고 중첩 호출은 교착 없이 끝났다. 포인터 후 `sqlite3.Error`는 즉시 JSON rollback, rollback 자체 오류는 `recovery_required`와 두 사유를 반환한다. 전체 writer/오류 목록과 락 순서는 [`install-update-writer-error-audit-20261006.md`](install-update-writer-error-audit-20261006.md)에 고정했다.
