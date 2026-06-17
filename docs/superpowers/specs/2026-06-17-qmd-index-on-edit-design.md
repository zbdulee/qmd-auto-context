# qmd `index-on-edit`: 편집 후 자동 인덱싱 설계

- 날짜: 2026-06-17
- 상태: 설계 확정 (구현 전)
- 리뷰: claude subagent + codex(gpt-5.5, high) + agy 3사 — 만장일치 반영

## 1. 배경 / 문제

현재 편집 후 qmd 인덱스 갱신은 두 경로뿐이다.
- `core/update.sh` (SessionStart) — 세션 시작 시 1회 전체 incremental.
- novel 자체 훅 `post-manuscript-edit.sh` (PostToolUse) — 편집 직후 `novel-qmd-session-update.sh`(qmd) + `build_nova_index.py`(Nova). **claude 전용, 소설 폴더 한정, 수동 컬렉션 매핑 하드코딩.**

문제: skill/사람이 "qmd update 하라"를 수동으로 신경 써야 하고(실제로 novel skill 문서들이 그렇게 안내), 자체 훅은 claude/특정 폴더에만 묶여 있다. 글로벌 plugin이 편집 직후 인덱싱을 표준 제공하면 skill의 수동 지시가 불필요해진다.

핵심 제약(`CLAUDE.md` / `docs/issues/` 실측):
- **qmd 데몬은 single-thread.** query·embed·keepalive ping이 겹치면 직렬로 밀려 timeout → 간헐 빈 출력.
- **embed 후 데몬 reload 필요** — 떠있는 데몬은 시작 시점 인덱스를 들고 있어 reload 없이는 새 벡터 stale.
- **WAL 비대화** — 대량 embed 후 데몬 상주 시 checkpoint 안 됨. SIGTERM graceful close가 checkpoint 유도(SIGKILL은 못 함).

## 2. 목표 / Non-goals

### 목표
- 편집(Write/Edit 등) 후, `.auto-context.json`으로 연결된 폴더의 변경을 **자동으로** qmd 인덱스에 반영.
- **"꼭 필요한 것만"** — 데몬 단일스레드를 때리지 않게 부하를 구조적으로 최소화.
- 3플랫폼(claude/codex/agy) 공통 core, hooks 디스패처 패스스루(SSOT 유지).

### Non-goals (이번 범위 밖)
- **크로스플랫폼(Linux/Windows)** — 데몬·keepalive·logrotate가 전부 launchd(`~/Library/LaunchAgents`)라 이 플러그인은 **현재 macOS 전용**. worker도 launchd를 따른다. 크로스플랫폼은 데몬째 OS추상화하는 별도 대형 과제로 분리.
- **파일 단위 부분 인덱싱** — qmd CLI 실측상 불가(`qmd collection add <단일파일>` 크래시, update/embed에 파일 인자 없음). 최소 단위 = 컬렉션.
- **삭제(delete) 완전 처리** — Claude엔 delete 도구가 없고 `Bash(rm)`이라 PostToolUse matcher로 일관 포착 불가. 삭제 stale 벡터 정리는 SessionStart full update에 위임(아래 7.5).

## 3. 아키텍처 개요

3사 리뷰 만장일치 결론 = **"편집마다 즉시 embed+reload"를 버리고 dirty 큐 + 단일 워커 coalesce.** 이유: 기존 lock은 `mkdir` non-blocking try-lock이라 경합 시 embed/reload를 **조용히 drop**(`update.sh:257`) → 최대 디바운스 간격만큼 stale + WAL 누적.

```
┌─ PostToolUse (Write|Edit / apply_patch / write_to_file|replace_file_content)
│   core/index_enqueue.py
│     · config 게이팅(pending/optout → skip)            ← posttool.py 게이팅 재사용
│     · is_story_path? 아니오 → skip
│     · 편집 경로 → (project_root, collection_name, collection_path) 해석
│     · 글로벌 dirty 큐에 append (원자적)
│     · 즉시 종료 (0ms, 데몬·embed·lock 무관)
│
└─ launchd worker  com.qmd-index-worker.plist (keepalive 패턴, StartInterval)
    core/index_worker.sh   ── single-flight (mkdir lock)
      · dirty 큐 drain → (project, collection) 집합으로 그룹핑
      · writer lock 획득(update.sh와 공유, qmd 모든 쓰기 직렬화)
      · touched 컬렉션: qmd collection add(멱등) + qmd update + qmd embed
      · 실제 새 임베딩 발생 시에만 SIGTERM reload 1회 (structured count 판정)
      · 성공한 항목만 큐에서 제거
      · lock 놓기 전 큐 재확인 → 남았으면 dirty 플래그 유지(다음 tick coalesce)
```

worker는 OS가 돌리는 **단 하나의 인스턴스** → claude·codex·agy 어느 엔진이 편집하든 직렬 처리 → 멀티엔진 동시성 자연 해소. keepalive(`StartInterval 30`, single-flight `mkdir` lock, health 가드)와 **동일 패턴 복제**.

## 4. 컴포넌트

### 4.1 `core/index_enqueue.py` (PostToolUse)
- 입력: hook payload(stdin). 이벤트 `PostToolUse`/`AfterTool` 수용(posttool.py와 동일).
- `QMD_SANDBOX`/`--sandbox` → 무출력 종료.
- `config.load_project_config(cwd)` → `collections` 비면(pending/optout) 종료.
- `event_enabled(config, "postToolUse")` 확인.
- 편집 경로 추출(posttool.py의 path 추출 로직 재사용: `file_path`/`path`/patch `paths_from_patch`/`edits`).
- **컬렉션 선정(신규, longest-prefix)** — 4.4. (project_root는 config 탐색용으로만 쓰고 큐엔 넣지 않음 — collection_path 절대경로로 충분.)
- 각 (collection_name, collection_abs_path)를 dirty 큐에 원자 append.
- **stdout 무출력** (이 hook은 컨텍스트 주입 안 함. recall 주입은 기존 posttool.py가 별도 담당).

### 4.2 dirty 큐
- 위치: `~/.config/qmd/dirty-queue` (단일 글로벌. `/tmp`가 아닌 영속 경로 — 세션/재부팅 가로질러 worker가 처리. `$TMPDIR` launchd vs 셸 불일치 회피 — agy 지적).
- 포맷: 한 줄 = `<collection_name>\t<collection_abs_path>` (TSV). 중복은 worker가 dedupe.
- 쓰기: append + `flock` 또는 원자적 임시파일 머지(동시 enqueue 안전).

### 4.3 `core/index_worker.sh` + `backend/launchd/com.qmd-index-worker.plist`
- plist: keepalive plist 복제. `StartInterval`(기본 60s — keepalive 30s보다 길게, 인덱싱은 덜 급함), `RunAtLoad true`, `managed-by: qmd-auto-context` 마커. install.sh의 `backend/launchd/*.plist` glob이 자동 설치.
- worker:
  - single-flight: `mkdir /tmp/qmd-index-worker.lock.d` 실패 시 종료(stale 10분 방어 — keepalive 패턴).
  - 큐 비었으면 즉시 종료.
  - 큐 읽어 dedupe → (collection, path) 집합.
  - **writer lock**(`/tmp/qmd-update.lock.d` — update.sh와 공유) 획득. busy면 종료(큐 보존 → 다음 tick).
  - 각 컬렉션: `[ -d "$path" ]` 확인(없으면 skip+로그 — agy 지적) → `qmd collection add "$path" --name "$name"`.
  - `qmd update` (전체 incremental — 컬렉션 인자 무시 확정).
  - `qmd embed` (전체 incremental. **컬렉션 인자 가정 안 함** — 3사 공통).
  - embed 출력에서 **새 임베딩 수를 structured 파싱**("Embedded N chunks") → N>0이면 reload. grep `embedded|chunks`에만 의존하지 않음(취약성 — claude/codex 지적). 파싱 실패 시 보수적으로 reload.
  - reload: **SIGTERM graceful**(`launchctl kill TERM` + `/health` bounded wait) — update.sh 경로로 **통일**. novel의 `kickstart -k`(하드) 방식 폐기(WAL checkpoint 보장 — claude 지적).
  - 성공 처리된 큐 항목만 제거(성공 후 제거 — 실패 시 다음 tick 재시도).
  - lock 놓기 전 큐 재확인(처리 중 새 enqueue) → 남으면 다음 tick이 coalesce.

### 4.4 컬렉션 선정 (신규 로직)
- `is_story_path`는 bool만 반환 → **재사용 불가, 신규 구현**(3사 지적).
- `collectionPaths`(컬렉션명 → 상대경로)를 절대경로로 펴고, 편집 파일에 대해 **longest-prefix 매칭**으로 정확히 1개 컬렉션 선정. 중첩 경로(예: `01_Settings`가 다른 컬렉션의 하위)도 가장 긴 prefix 우선.
- 한 편집(patch)이 여러 파일/여러 컬렉션을 건드리면 **여러 컬렉션 모두 enqueue**("컬렉션 1개만"은 틀림 — codex 지적).

### 4.5 lock & coalesce 정책
- **writer lock 통일**: update.sh(`/tmp/qmd-update.lock.d`)와 worker가 동일 lock 공유 → `collection add`/`update`/`embed`/`reload` 전체를 직렬화. novel `/tmp/qmd-update.lock`(파일)과 불일치는 통합으로 해소(codex 지적).
- **drop 대신 coalesce**: lock busy거나 처리 실패면 큐 항목을 **남겨둔다**(제거 안 함) → 다음 worker tick이 처리. embed/reload가 "조용히 사라지는" 일 없음(3사 핵심 must-fix).

### 4.6 reload 빈도
- 편집 빈도와 **디커플**: reload는 worker tick당 최대 1회, 새 임베딩이 실제 생겼을 때만. 편집이 다다닥 와도 reload는 tick 간격(기본 60s)으로 합쳐짐.
- (선택, 후속) qmd 데몬에 in-process hot-reload 엔드포인트가 있으면 SIGTERM 재시작 대신 사용 → query 중단 윈도우 소멸. 현재 미확인 → 이슈로 기록.

## 5. 게이팅 (`.auto-context.json` = "필요한 것만"의 1차 관문)
- enqueue·worker 모두 config 우선 로드. pending(config없음/collections빈)/optout(`indexing:false`)/risky → skip.
- 연결된 폴더의, collectionPaths 내부 파일 편집만 큐에 들어간다. 그 외는 0ms skip.

## 6. Nova 분리
- 글로벌 hook은 **qmd만**. `build_nova_index.py` 등 소설 고유 후처리는 자체 훅 잔류.
- **독립 디바운스/stamp**: novel 자체 훅이 qmd와 nova를 공유 stamp·공유 subshell로 순차 실행하던 것을 분리하면 디바운스가 어긋날 수 있음(3사 지적). nova 훅은 자체 stamp를 쓰고, "qmd가 skip돼도 nova는 돈다"를 보장. nova가 qmd 최신성에 의존하지 않음을 전제(현재 build_nova_index는 파일만 읽음 → 안전).

## 7. 엣지케이스 / 실패 모드 (3사 종합)
1. **lock 경로/`$TMPDIR` 불일치** — writer lock은 `/tmp` 절대경로 고정(launchd vs 셸 환경차 회피).
2. **존재하지 않는 컬렉션 경로** — 폴더 삭제/이름변경 시 `[ -d ]` 선검사로 add 크래시 방지(파이프라인 중단 방지).
3. **새 임베딩 0건 판정** — structured count 파싱. 실패 시 보수적 reload.
4. **멀티엔진 동시성** — 단일 launchd worker로 구조적 해소.
5. **삭제 stale 벡터** — 편집 hook 범위 밖. SessionStart `update.sh` full update가 정리(remove 감지). Non-goal로 명시.
6. **posttool recall 폭격(별개, 후속 검토)** — 에이전트가 다다닥 편집하면 기존 `posttool.py`의 recall query도 디바운스 없이 데몬 직행(agy/codex 지적). 이번 spec 범위 밖이나, worker reload 중 recall이 겹치면 빈 출력 증가 가능. 후속 이슈로 기록(posttool recall throttle 또는 reload 중 skip).
7. **헬스체크 부재** — worker는 embed 전 데몬 down이어도 동작(embed는 CLI/sqlite 직접). reload(SIGTERM)는 죽은 데몬엔 no-op, keepalive가 respawn. 의도된 동작으로 문서화.

## 8. 테스트 (`test/index_on_edit.test.mjs`, node --test, 결정적)
- 게이팅: pending/optout/non-story-path → enqueue 안 함.
- 컬렉션 선정: longest-prefix, 중첩 경로, 멀티컬렉션 patch.
- 큐 원자성: 동시 enqueue 중복/유실 없음.
- worker: dedupe, `[ -d ]` skip, lock busy 시 큐 보존, 새임베딩0 시 reload skip, 성공 후 큐 제거.
- `QMD_QUERY_FIXTURE`/`QMD_FAKE` 패턴으로 데몬 없이 결정적 검증.
- **capability probe**(별도): `qmd embed <collection>` 단독 처리 여부를 2-컬렉션 fixture로 1회 검증. 현재 설계는 전체 incremental이라 결과 불변이지만, 후속 최적화 가부 판단용으로 기록만.

## 9. 플랫폼별 동작
- claude/codex: marketplace plugin → PostToolUse enqueue 자동. worker는 공통 launchd.
- agy: PostToolUse만 존재(SessionStart/recall 훅 없음 — `test/probe-manifest.test.mjs`). enqueue는 `--agy-local`의 `.agents/hooks.json` PostToolUse에 추가(기존 posttool 설치 경로에 index action 병기). worker는 동일 launchd(머신 단위 1개).
- `hooks/run-hook`에 action `index` 추가. `hooks.json`/`hooks-codex.json`에 PostToolUse 엔트리 추가.

## 10. 구현 시 검증 필요 (미해결)
- `qmd embed`의 "새 임베딩 수" structured 출력 형식 확정(파싱 신뢰성).
- qmd 데몬 hot-reload 엔드포인트 존재 여부(있으면 reload 비용 대폭 절감).
- worker `StartInterval` 최적값(60s 시작, 체감 지연 vs 부하 튜닝).

## 11. 3사 리뷰 반영 추적
| must-fix (3사) | 반영 |
|---|---|
| lock drop → coalesce | §4.5 큐 보존, 성공 후 제거 |
| reload coalescing | §4.3/§4.6 tick당 1회, 편집과 디커플 |
| multi-collection / longest-prefix | §4.4 |
| embed 컬렉션 인자 미가정(전체 incremental) | §4.3 |
| reload SIGTERM 통일 | §4.3 |
| writer lock 통일 + /tmp 고정 | §4.5/§7.1 |
| structured count(grep 탈피) | §4.3/§7.3 |
| Nova 독립 stamp | §6 |
| dir 존재 검사 | §7.2 |
| posttool recall throttle | §7.6 (후속 이슈) |
