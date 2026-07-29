# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

qmd 기반 자동 컨텍스트 주입 훅을 **Claude Code · Codex · Hermes Agent · Antigravity(Gemini)** 에서 동작시키는 플러그인. 사용자 안내는 `README.md` 참고. 이 문서는 코드 작업 시 알아야 할 구조·명령·함정에 집중한다.

사용자용 문서와 응답에서는 설치 후 운영 인터페이스를 **자연어 요청 또는 노출된 skill 호출** 중심으로 안내한다. `core/`·`skills/`의 shell command는 유지보수/디버깅 인터페이스이므로, 사용자가 명시적으로 요청한 경우나 개발자 문서가 아닌 이상 README 같은 public docs에 직접 실행 흐름으로 노출하지 않는다.

개발 시에는 **Claude Code · Codex · Hermes Agent** 세 host의 동작성을 모두 고려한다. 공통 로직은 `core/`에 두고, host별 adapter/hook 차이(Claude/Codex command hook, Hermes Python plugin 및 observer-only `post_tool_call`)가 깨지지 않는지 함께 확인한다.

## 명령

```bash
npm test                                    # node --test, 전체 단위/회귀 (결정적)
node --test test/recall.test.mjs            # 단일 파일
node --test --test-name-pattern "<정규식>"  # 이름으로 특정 테스트만
QMD_LIVE=1 node --test test/integration.test.mjs   # 실제 데몬 라이브 스모크 (보통은 skip)

bash scripts/agy-local-hook-install.sh <프로젝트>  # Gemini(agy): 공식 payload adapter 전까지 stale qmd AGY hook cleanup only
bash scripts/cleanup-legacy.sh --dry-run    # 기존 글로벌 qmd 훅/managed LaunchAgent cleanup 계획 확인
bash scripts/cleanup-legacy.sh              # 기존 글로벌 qmd 훅/managed LaunchAgent cleanup 실행

bash skills/sync/scripts/sync.sh <프로젝트>  # 수동 CUD sync: snapshot 비교 → dirty queue enqueue
bash skills/query/scripts/query.sh <프로젝트> "<질문>"  # 수동 recall query(core/recall.py 경유)
bash skills/update/scripts/update.sh <프로젝트>  # 수동 SessionStart update(core/update.sh 경유)
bash skills/wiki-compile/scripts/wiki-compile.sh <프로젝트> < compact.json  # compact durable summary → wiki_compile.py

bash core/update.sh --recommend [<경로>]              # 추천 확인 (read-only, 파일 변경 없음)
bash core/update.sh --recommend --json [<경로>]       # 추천 결과를 JSON으로 출력
bash core/update.sh --optin --recommended [<경로>]    # 추천 적용 → .auto-context/settings.json 원자 생성
bash core/update.sh --optout [<경로>]                 # 로컬 decision store에 거절 기록(프로젝트 파일 수정 없음)
bash core/update.sh --migrate-config [<경로>]         # 레거시 .auto-context.json → .auto-context/settings.json 이동
bash core/update.sh --init-wiki [<경로>]              # .auto-context/wiki scaffold 생성 + wiki recall 활성화
bash core/update.sh --enable-compile [<경로>]         # wiki scaffold + compile 설정 한 번에 (recommended 온보딩에서 기본 활성화)
bash core/update.sh --skip [<경로>]                   # 이 프로젝트 임시 gate 통과 마커 (TTL 2h, cwd 단위)
```

테스트/설치를 격리 검증할 때 쓰는 env 가드 (테스트 코드가 이걸로 부작용을 막는다):
- `QMD_FAKE_PLATFORMS=claude,codex,gemini` — 실제 감지 대신 플랫폼 목록 강제 (`none`도 가능)
- `QMD_BACKEND_MANAGER=/path/to/manager.sh` — tests/hooks에서 backend manager override
- `QMD_CLEANUP_LEGACY=1` — managed legacy LaunchAgent cleanup opt-in
- `QMD_QUERY_FIXTURE=test/fixtures/*.json` — 데몬 응답을 파일로 주입 (라이브 데몬 없이 결정적 검증)
- `QMD_SHADOW_QUERY=1` (+ `QMD_RECALL_LOG` 필수) — recall 품질 진단 shadow query opt-in. `QMD_SHADOW_TIMEOUT`으로 per-query timeout(기본 1.0s) override
- `QMD_SANDBOX` / `GEMINI_SANDBOX` / `--sandbox` — 디스패처·코어 즉시 무출력 종료

테스트 작성 시 주의: `execFileSync`는 반드시 `encoding:'utf8'`을 줄 것 (없으면 Buffer 반환 → `.trim()` 에러). 병렬 실행에서 `core/__pycache__`가 spurious 실패를 유발할 수 있어 `.gitignore` 처리돼 있다. **node 테스트 프로세스 안에 http 서버를 띄워 훅에 응답시키려 하지 말 것** — `execFileSync`가 자기 event loop를 막아 서버가 요청을 처리하지 못한다. 라이브 데몬 없이 stub 데몬으로 검증할 때는 `test/helpers/capture_query.py`·`test/helpers/shadow_probe.py`처럼 Python driver(스레드 서버 + subprocess)를 쓴다.

## 아키텍처 (큰 그림)

**3층 구조: 플랫폼 무관 코어 1벌 + 얇은 host adapter + plugin-managed 백엔드.**

```
core/      ← 모든 로직. backend_manager.sh + 플랫폼/도메인 무관 core. stdin {prompt,cwd} → stdout 훅 JSON
hooks/     ← Claude/Codex/Gemini run-hook 디스패처 + hooks.json/hooks-codex.json. backend ensure/kick 후 코어로 패스스루
hermes_adapter/ ← Hermes Agent plugin hook adapter(pre_llm_call/on_session_start/pre_tool_call/post_tool_call) → core로 패스스루
backend/   ← qmd MCP HTTP 데몬(:8483) launcher + keepalive/logrotate/index worker one-shot scripts
```

편집 후 자동 인덱싱: PostToolUse 훅이 편집 파일을 dirty 큐(`~/.config/qmd/dirty-queue`)에 원자 append → backend manager가 one-shot worker를 비동기로 kick해 재인덱싱.

### 코어 (`core/`)
- `recall.py` — UserPromptSubmit 핵심. 흐름: `config.load_project_config(cwd)` → 키워드 추출(`keywords.py`) → 데몬 `/query`(lex+vec 하이브리드, 또는 `QMD_QUERY_FIXTURE`) → skipPaths/minScore 필터 → topN → `additionalContext` 포맷. **CLI fallback은 없음** — 데몬 죽었거나 timeout이면 graceful하게 빈 출력(에러 아님). wiki role 결과는 frontmatter를 재파싱한다. **qmd는 하나의 lex 문자열 안의 positive term을 AND로 결합한다**(`dist/store.js` `positive.join(' AND ')`) — 그래서 term 확장을 한 문자열에 합치면 안 된다. `searches` 배열의 lex 엔트리는 **각각 독립 FTS로 실행돼 RRF로 융합**되므로(structuredSearch step 1) OR 효과가 필요한 확장은 엔트리를 나눈다. EP 변형(`EP012`/`EP12`)이 이 경로다: 합쳐 두면 한 문서가 두 표기를 모두 가져야 해 EP 쿼리의 lex가 **항상 0건**이었다. 분리·예산(`keywords.EP_SEARCH_BUDGET`, qmd MCP `searches` 상한 10 대비 일반 lex 1 + vec 1 예약)은 `keywords.build_lexical_terms`의 `lexQueries`가 SSOT다(`[0]`=일반 AND 문자열, `[1:]`=EP 변형). **일반 키워드의 AND 결합은 유지한다**(검색을 좁히는 의도된 동작). **순수 숫자 변형(`012`)은 만들지 않는다** — AND와 무관한 별개 이유(RRF 노이즈)다: `012`*는 EP 표기가 아니라 "012로 시작하는 아무 토큰"(특히 카드 frontmatter `sources` 경로)에 걸려 novel 실측에서 재현율 없이 무관 히트만 5건 늘렸다. 합성 변형뿐 아니라 원문에 직접 쓴 순수 숫자도 `_ep_mention_fragments`가 일반 문자열에서 빼낸다. **경로 해석(`resolve_wiki_result_path`)은 스킴에 의존하면 안 된다** — 데몬은 `file`을 `qmd://` 없이 `collection/path`로도 반환하므로, prefix 제거 판정은 "첫 세그먼트 == 컬렉션명"으로 한다. 스킴을 전제하면 라이브에서만 해석이 실패해 모든 카드가 미검수로 오판되고 `recallVerifiedOnly`가 wiki recall을 통째로 죽인다(2026-07 재발: `_collection` 주입은 6deed4a에서 고쳤지만 rel 추출이 남아 있었고, fixture가 전부 스킴 형식이라 테스트가 통과했다 — wiki fixture에 plain path 형식을 반드시 섞어 둔다). **`compile.recallVerifiedOnly`(기본 `true`)면 미검수(`_wiki_reviewed`=false, 즉 generated/tentative) wiki 카드는 아예 surface하지 않고** `excludeStatusesFromRecall`과 동일하게 backfill 판정 "전"에 제거한다 — hierarchical에선 wiki가 전부 미검수여도 빈 wiki→raw 원문 backfill로 안전 degrade한다. `recallVerifiedOnly:false`로 끄면 미검수 카드도 surface하되 status generated 등 + reviewed:false 카드에 ` (미검수)` 배지·"단독 캐논 근거 인용 금지" 안내 1줄을 붙이고, `compile.lowPriorityStatuses` 카드는 topN 절단 **전에** 검수 카드 뒤로 강등한다(안정 정렬 — 그룹 내 score 순위 보존). **순위 폴백(rank fallback)**: `rerank:false` 경로의 데몬 score는 1/rank라 `minScore`는 유사도 임계가 아니라 **순위 컷**이다(rank1=1.0, rank2=0.5, rank3=0.33 → `minScore:0.8`은 1위만 통과). 그 1건이 hard filter(skipPaths·`recallVerifiedOnly`·`excludeStatusesFromRecall`)에서 떨어지면 필터 곱셈으로 최종 0건이 됐다. 그래서 자격 판정(`classify`)을 순위 컷과 분리해 전 후보에 적용하고, **컷 이상 후보가 존재했는데** 그것들이 hard filter로 전멸했을 때만 컷 밖 첫 eligible을 **정확히 1건** 구제한다. 컷 이상 후보가 애초에 0건이면(`minScore:999`, `rawFallbackMinScore:1.01`처럼 사용자가 임계로 명시 차단) 폴백하지 않고 0건을 유지한다 — 안 그러면 차단 설정이 무력화된다(docs/settings.md 계약). 컷 안에 eligible이 있으면 기존 동작 그대로다(폴백 미발동). skip/exclude/미검수는 절대 구제하지 않으므로 후보 전체가 미검수면 0건이 올바른 결과다. hierarchical은 wiki 후보 구제를 raw backfill보다 **먼저** 시도하고, raw phase도 `rawFallbackMinScore` 기준으로 같은 1건 구제를 적용한다. 로그의 `dropped_*`는 최초 cutoff/drop 수를 그대로 유지하고(집계 호환) 구제 사실은 `rank_fallback_used`/`rescued_original_rank`/`fallback_phase`(wiki|raw|primary)로만 남는다. `rescued_original_rank`는 EP promotion·재정렬 **전** 데몬 순위(`rank_index`)이며 shadow의 `selected[].original_rank`와 같은 map을 공유한다(한 줄 안에서 두 rank가 어긋나면 안 된다).
- `update.sh` — SessionStart에서 qmd 인덱스 갱신. canonical `.auto-context/settings.json`의 collection root가 사라진 경우 먼저 `qmd collection remove`를 호출하고 성공한 collection만 settings에서 원자 제거한 뒤 update를 계속한다. 이상 상태(데몬 미응답, dirty-queue에 이 프로젝트 컬렉션 라인이 `staleQueueThreshold`(기본 20) 이상 적체)는 opt-in 프로젝트에 한해 stdout 1줄로 표면화하되 `notice_once`(marker TTL 4h, `QMD_NOTICE_TTL_SECS` override)로 반복 세션 잡음을 억제하고 조건 해소 시 재무장한다. 정상이면 기존대로 완전 무출력. `--resolve-only`, `--migrate-config`, `--init-wiki`, `--enable-compile` 모드 있음(`--init-wiki`는 scaffold와 wiki collection/role/hierarchical recall 설정을, `--enable-compile`은 wiki scaffold + compile 설정까지 함께 적용).
- `posttool.py` — 편집 후 연속성 힌트. `is_story_path`는 config의 `collectionPaths`로 판별(하드코딩 없음). 이벤트명 `PostToolUse`(claude/codex)와 `AfterTool`(gemini) **둘 다** 수용. 내부적으로 recall.py를 subprocess로 위임.
- `config.py` — 사용자 로컬 optout marker(`~/.config/qmd/optout`)를 먼저 확인한 뒤, `.auto-context/settings.json`(없으면 레거시 `.auto-context.json`, `.agents/qmd-recall.json`) 로드 + 기본값 병합. 숫자 필드(minScore/topN/queryTimeout) 보수적 coercion, 실패 시 기본값. legacy novel 컬렉션명(`*-manuscript`/`*-plot`)은 `lexicalPatterns:["ep"]` 자동 활성화. **`find_project_config`는 여러 hook entrypoint가 개별 가드 없이 직접 부르는 안전 경계라 내부 탐색(`_find_project_config_unsafe`)을 try/except로 감싸 어떤 예외에도 빈 설정으로 fail-open한다** — 샌드박스/권한 차이로 경로 탐색이 죽어도 호출 훅이 non-zero exit로 죽지 않게 한다.
- `hook_main.py` — **모든 Python hook entrypoint의 단일 fail-safe 경계.** hook은 항상 exit 0이어야 하고(deny는 stdout JSON, non-zero exit이 아님), main() 콜트리에서 새는 어떤 예외든 host가 "hook (failed): exited with code 1"로 표면화한다. recall/posttool/preflight_gate/index_enqueue/wiki_compile_enqueue의 `__main__`은 전부 `sys.exit(hook_main.run(main))` 형태로 이 wrapper를 거친다. run()은 예외를 삼켜 0을 반환하고, `QMD_RECALL_LOG`가 있으면 traceback을 파일에만(stdout 오염 없이) 기록한다. **새 Python hook entrypoint를 추가하거나 `__main__`을 만질 때 반드시 이 wrapper를 거치게 한다** — per-site try/except는 다음 편집에서 빠뜨리기 쉬워 이 클래스 버그가 반복됐다(exit 127/1 계열). update.sh(bash)는 `set -e` 아래 동기 `main()` 경로의 stdin 파싱을 `|| true`로 감싸 같은 클래스를 방어한다.
- `resolve_paths.py` — collectionPaths→경로 매핑 + risky path / allowRoots traversal 검증.
- `dirty_queue.py` — 기존 dirty 큐(`~/.config/qmd/dirty-queue`) append SSOT. `<collection-name>\t<collection-path>` 2컬럼 프로토콜 유지.
- `backend_manager.sh` — plugin runtime backend lifecycle SSOT. qmd version check(`>=2.5.3 <3.0.0`), daemon ensure/reload, health-only keepalive, logrotate, async `index_worker.sh` kick, explicit legacy cleanup. Hooks must keep stdout silent; manual skills may print install guidance. qmd 자동 설치/업그레이드는 하지 않는다.
- `index_enqueue.py` — PostToolUse hook. config 게이팅(collections 미설정/indexing:false/event 비활성/collectionPaths 밖) 후 편집 파일이 속한 (컬렉션명, 절대경로)를 dirty 큐에 원자 append. stdout 무출력.
- `sync.py` — 수동/skill 기반 missed CUD 복구. `.auto-context/settings.json`의 `collectionPaths`를 snapshot(`mtime_ns + size`)과 비교해 변경된 collection만 dirty 큐에 append한다(인덱싱은 컬렉션 단위가 맞다). `skipPaths`는 recall 필터라 sync/delete cleanup에는 적용하지 않는다. **같은 diff로 compile source-queue도 파일 단위로 채운다** — `git pull`·rebase·외부 편집은 PostToolUse를 타지 않아 wiki 카드가 조용히 낡고, `wikiOnly` 프로젝트에선 낡은 카드가 유일한 recall 소스가 된다. `compare_collection`은 이 때문에 카운트가 아니라 상대경로 **목록**을 반환한다. per-file 게이팅(.md/role/dot-prefix/`DENIED_SOURCE_SEGMENTS`)과 compile 설정 게이팅은 복제하지 않고 `wiki_compile_enqueue._source_record`·`compile_gate`를 재사용한다. trigger 라벨은 `post_sync_source`이고, 하위호환으로 `post_tool_source`만 켜 둔 프로젝트도 sync 경유 enqueue를 허용한다(둘 다 없으면 skip). 삭제 파일은 읽을 소스가 없어 제외한다. **백필은 하지 않는다** — 스냅샷 대비 변경만 보므로 baseline이 이미 있는 프로젝트의 미편집 문서는 영원히 enqueue되지 않는다(별도 스펙: `docs/plans/2026-07-29-wiki-only-architecture-review.md` 5.7). 한 번의 sync가 큐에 넣는 파일 수는 `QMD_SYNC_COMPILE_MAX`(기본 50)로 제한되며 초과분은 스냅샷을 진전시키지 않아 다음 sync가 다시 집는다(조용한 유실 없음). sync는 LLM/worker를 직접 실행하지 않는다 — 배수는 기존 `kick-wiki-compile` 경로(편집 훅·SessionStart `--flush`)가 한다.
- `collection_match.py` — 편집 경로 → collectionPaths longest-prefix 컬렉션 선정. 복수 컬렉션 지원, 컬렉션 밖 편집은 빈 결과.
- `recommend_config.py` — `--recommend`용 추천 생성. read-only(`.auto-context/settings.json` 쓰지 않음). `docs/current`·`docs/plans`·`docs` 등 좁은 경로를 탐색해 크기 가드(200파일/5MB) 통과 경로만 추천. `{available, config}` JSON 출력. 쓰기는 `--optin`/`--optin --recommended`에서만.
- `preflight_gate.py` — PreToolUse hook. pending 프로젝트에서 Edit/Write/apply_patch 등 편집 도구를 deny로 차단(Claude·Codex). sandbox·skip 마커·pending 아닌 상태면 즉시 통과.
- `wiki_compile_defaults.py` — recommended 온보딩·`--enable-compile`·SessionStart notice가 공유하는 compile 설정 블록 생성 헬퍼. generated config에는 절대 adapter 경로를 쓰지 않고 `compile.extractor.builtins`에 `claude`/`codex`/`hermes` 같은 symbolic engine만 저장한다.
- `wiki_compile_enqueue.py` / `wiki_compile_worker.py` — 자동 compile source는 `raw`/`session` Markdown만 허용하며, dot segment는 skip/reject한다(`.agents/skills`, `.claude`, `.codex`, `.github` 같은 agent/tooling metadata를 wiki로 승격하지 않기 위한 안전장치). **단 dot 검사 범위는 "명시적으로 등록된 collectionPath 루트 아래"로 한정한다** — 루트 자체의 dot segment(novel의 `.nova/06_Sessions`)는 사용자가 `collectionPaths`에 직접 적은 소스라 면제하고, 그 아래에서 새로 나타나는 dot segment(`.drafts/`, `.hidden.md`)는 그대로 배제한다. 이 좁히기가 완화 범위를 자동으로 봉쇄한다: `collectionPaths`가 `.`(저장소 전체)이면 면제 접두부가 비어 rel path 전체가 여전히 dot 검사를 받으므로 dot 디렉터리가 하나도 열리지 않는다. 여기에 더해 `.auto-context`·`.git`·`node_modules` segment는 role 게이트와 무관하게 항상 deny다(`DENIED_SOURCE_SEGMENTS`) — wiki 카드/compile 큐가 자기 자신의 소스가 되면 무한 증식한다.
- **`post_session_summary` 트리거는 자동 발화 경로가 없다(설계상 불가, 죽은 설정 아님).** 이 트리거는 host가 *compact session summary*를 hook에 넘겨줄 때 발화하도록 의도됐지만 그런 host가 없다 — Claude Code의 SessionEnd/PreCompact/Stop은 `transcript_path`(raw JSONL)만 주고, Codex hooks·Hermes plugin hooks에는 session-end 채널 자체가 없다. raw transcript를 소스로 삼는 것은 금지돼 있고(`raw`/`session` Markdown만), enqueue는 LLM을 호출하지 않으므로 hook-side 요약도 불가하다. 대신 이 값은 **수동 경로의 레코드 라벨**로 실제 소비된다(`wiki_extract.py`가 payload `trigger`를 그대로 기록 → `skills/wiki-compile`). 따라서 `COMPILE_TRIGGERS`에서 제거하지 말 것. 세션 결론의 **자동** 수집은 `post_tool_source`가 담당한다 — 세션 노트를 `raw`/`session` collection의 `.md`로 쓰면 편집 훅이 큐잉한다.
- `wiki_compile.py`의 secret 방어는 **`secret_matches()`/`has_secret_like()`/`redact()`를 거친다**(`SECRET_PATTERNS`를 직접 `search`하지 말 것). `sk-…` 리터럴 패턴은 그대로이고, `(api_key|secret|token)\s*[:=]\s*\S+` 키워드 패턴만 값이 `_NON_SECRET_VALUE_RE`(플레이스홀더 `<…>`/`{{…}}`, env 참조 `$FOO`/`${FOO}`, `[REDACTED]`, `***`/`...`, 타입명 `string`/`bool`, `true`/`false`/`null`)에 해당할 때 무시한다. 축자 보존 강화로 기술 카드가 설정 키를 **이름만** 인용해도 `secret_like` reject되던 오탐만 제거한 것이며 불투명한 값은 여전히 전부 걸린다. 프롬프트에도 "secrets 규칙이 VERBATIM RULES보다 우선"을 명시해 두 층이 같은 방향을 가리킨다.
- `wiki_verify_worker.py` — 기계 검수(auto-verify). wiki_compile이 generated 카드 write 성공 시 `verify-queue.jsonl`에 enqueue하고, compile worker 종료 시 같은 lock 아래 피기백 실행된다. verifier는 extractor와 동일 adapter 풀을 payload `{"task":"verify"}`로 재사용해 카드 주장 vs 원문 소스를 적대 대조한다. pass → `status: verified`+`verifiedBy`/`verifiedAt` 패치(recall 검수급 대우, 단 `is_auto_writable_page` 보호 집합엔 불포함 — 소스 변경 시 자동 갱신되고 갱신 시 generated로 리셋·재검증), fail → `compile.verify.onFail` 기본 `delete`(카드 즉시 삭제, tombstone 없음 — 소스 수정 시 재생성 가능), transient(CLI 부재/timeout) → 큐 보존+`verify-cooldown`(compile cooldown과 분리). 판정은 `verify-log.jsonl`에 기록되며 256KB 초과 시 최근 절반만 유지(트림).
- `wiki_dedup_judge.py` — **dedup 판정 SSOT.** write-time gate(`wiki_compile.py`)와 retroactive scan(`wiki_dedup_scan.py`)이 공유하는 LLM body-vs-body 판정. extractor와 동일 adapter 풀을 payload `{"task":"dedup"}`로 재사용해 두 카드 본문이 같은 사실인지 묻고 `duplicate`/`distinct`/`unclear` + `reason`/`uniqueToA`/`uniqueToB`를 받는다. **daemon `score`는 유사도가 아니다**: rerank=True에서 qmd가 `blendedScore = w*(1/rrfRank) + (1-w)*rerankScore`(w=0.75 rank≤3)로 RRF 순위를 섞으므로 점수 상한이 **순위로 고정**된다(rank1 [0.75,1.0] / rank2 [0.375,0.625] / rank3 [0.25,0.5]; 실측 125카드 wiki에서 rank1 {0.88,0.93} / rank2 {0.55,0.56} / rank3 [0.40,0.44]). 자기 본문은 항상 rank1 self-match이므로 진짜 중복은 rank≥2에만 올 수 있고, 거기서는 `autoMergeThreshold` 기본 0.9가 **수학적으로 도달 불가**다. 그래서 vector는 **후보 retrieval**(`semanticDedup.candidateMinScore`, 기본 0.3)로만 쓰고 판정은 judge가 한다. judge는 **절대 merge/delete하지 않고 큐에만 넣는다.** outcome 3분기: `ok`(판정 유효) / `unavailable`(extractor 미설정·CLI 127 → 레거시 score-threshold로 degrade) / `transient`(timeout·crash → `dedup-judge-cooldown` 설정 + 작업 보존). 비용 상한은 `semanticDedup.judge.maxPairsPerScan`(기본 8)·`maxPairsPerCompile`(기본 1)이며 `distinct` 판정은 `dedup-skipped.jsonl`에 body-hash와 함께 기록돼 본문이 바뀔 때까지 재판정(재과금)되지 않는다. `QMD_DEDUP_JUDGE=off`는 프로세스 단위 kill switch.
- **write-time gate는 `target.exists()`가 false인 모든 신규 카드에 걸린다** (`wiki_compile.py:judge_new_page_duplicate`). 2026-07-29까지는 `target_reason == "slug"`인 경우에만 걸려서, extractor가 `targetPath`를 명시한 후보는 dedup을 **완전히 우회**했다 — novel 실측 130/133(97.7%)이 `targetResolution: "explicit"`이었고 이것이 잔존 근중복의 주 발생원이다. 단 judge가 없는 머신에서는 retrieval query조차 하지 않고(`wiki_dedup_judge.is_available`가 config만 보고 선판정) 기존 slug-only score gate로 그대로 degrade한다 — 이 fallback을 없애면 daemon 없는 환경에서 gate가 약해진다.
- `extractors/` — host-CLI wiki extractor adapters (`claude_adapter.py`, `codex_adapter.py`, `hermes_adapter.py`) + `lib.py`. Pure `payload→{candidates}` functions run in an isolated temp cwd with tools/custom context disabled. Worker는 `compile.extractor.argv`(legacy explicit) → `compile.extractor.backends[engine]`(explicit) → `compile.extractor.builtins`(runtime-resolved adapter) → `extractor.default` 순서로 선택한다. **플러그인 install = consent**: 설치 후 첫 SessionStart에 일회성 안내 notice가 표시되며, recommended 온보딩(`--optin --recommended`)·`--enable-compile`이 기본으로 compile을 활성화한다. Exit 127 = host CLI absent (worker then tries `extractor.default`). 격리: `lib.run_isolated`가 자식 env에 `QMD_SANDBOX=1`을 넣어 nested CLI의 qmd 훅을 즉시 무력화(재귀 차단)하고, claude는 `--safe-mode`·`--tools ""`·`--no-session-persistence`, codex는 `--ephemeral`·`--ignore-user-config`·`--ignore-rules`, hermes는 `--safe-mode`·`--ignore-user-config`·`--ignore-rules`·`-t ""`로 MCP/skills/plugins/rules/tool context를 최소화한다(hermes는 동등 persistence-off 플래그 없어 ~/.hermes에 1회성 기록이 남을 수 있음).
  - **`lib._PROMPT_TEMPLATE`의 VERBATIM RULES는 lex 검색 기반이다.** 카드 본문은 "이 토큰이 문서에 있는가"의 대상이라 토큰이 많을수록 매칭 기회가 늘어난다 — 쿼리 쪽(term이 늘면 AND가 좁아져 0건 위험)과 정반대로 축자 보존은 순수 이득이다. 백틱 코드스팬·**전체 경로**(basename으로 줄이지 말 것: FTS5가 `/`·`.`을 분해하므로 쿼리의 basename stem과 어차피 매칭된다)·시그니처·설정 키·단위 붙은 수치·에러/exit code·대괄호 태그를 축자 유지시킨다. "compact"/"short" 지시는 제거했고 대신 payload `maxLines`(worker가 `compile.maxAutoPageLines`를 그대로 전달)로 lint `too_many_lines`와 상한을 일치시킨다. 코퍼스별 프롬프트 분기는 하지 않는다 — 규칙이 조건부("source가 X를 포함하면")라 코드스팬 없는 서사 소스는 트리거되지 않고, 인명·EP 태그·인용 대사가 같은 목록에 있어 novel에는 additive다. 대신 "NOT a scene-by-scene retelling"으로 재화 방지를 명시한다.
  - **`compile.maxSourceChars`는 12,000자 유지.** 상한을 올리면 extractor+verifier 두 번의 host CLI 호출이 모두 커져 편집당 토큰 비용(사용자 계정 청구)이 선형 증가한다. 대신 절단 사실을 payload `source.truncated`로 전달해 프롬프트가 "보이는 범위만 요약, 부재를 단정하지 말라"로 동작하게 한다(verify는 이전부터 truncated 소스를 `inconclusive`로 처리). 문서 후반부 커버리지는 bulk 재컴파일(P6)이나 소스 분할로 해결할 문제다.

### skills (`skills/`)
- `sync` — agent-facing 수동 동기화 workflow. wrapper가 qmd 설치/버전을 확인하고 `core/sync.py --json` 실행 후 실제 변경이면 `backend_manager.sh kick-index`를 호출한다. 자동 hook이 아니며 사용자가 sync/resync를 요청할 때만 쓴다.
- `query` — hook recall과 동일한 `core/recall.py` 경로를 수동 실행한다. 실행 전 backend manager가 qmd/daemon을 확인한다. qmd 데몬 직접 호출을 중복 구현하지 말 것.
- `update` — SessionStart update와 동일한 `core/update.sh` 경로를 수동 실행한다. 실행 전 backend manager가 qmd/daemon/warm/logrotate를 처리한다. qmd 인덱스 갱신 요청에는 이 skill을 쓴다.
- `wiki-compile` — compact durable summary/candidate JSON을 `core/wiki_extract.py` → `core/wiki_compile.py`로 수동 실행한다. raw transcript를 입력하지 않으며 query-time hook에서는 쓰지 않는다.
- `wiki-review` — write-time semantic gate가 auto-write 대신 `merge-needed.jsonl`에 큐한 신규 후보를 사람 판단으로 per-entry resolve한다(`wiki-review.sh`). 큐 전체 자율 처리는 `agents/wiki-review-resolver.md` 에이전트로 위임. dedup과 대칭으로 SessionStart hint가 대기 건수를 `notice_once`로 사용자에게 표면화하고 모델용 spawn hint도 방출한다(두 파이프라인 동일 구조).
- `wiki-dedup` — retroactive scan(`core/wiki_dedup_scan.py`)이 `dedup-needed.jsonl`에 큐한 **이미 존재하는** wiki 카드 쌍을 정리하는 user-facing 진입점. `agents/wiki-dedup-resolver.md` 에이전트를 스폰해 자율 판단한다(WORKFLOW는 에이전트가 SSOT — skill은 재복제하지 않음). 같은 큐를 SessionStart hint가 자동 스폰하며, hint는 대기 건수를 `notice_once`로 사용자에게 표면화한다. skill 경유(명시적 사용자 요청) 스폰은 요약을 반환하고 hint 경유 자동 스폰은 silent다(에이전트 step 5의 caller 조건부).
- `hint`에 해당하는 skill은 만들지 않는다. PostToolUse posttool은 편집 직후 자동 실행되는 hook-only 연속성 힌트다.
- `gate`에 해당하는 skill은 만들지 않는다. gate는 pending 프로젝트 편집 차단용 내부 안전장치다.

> **dogfooding**: 이 저장소 자체의 `.auto-context/settings.json`(`docs/current`·`docs/plans` 대상)으로 gate·추천·인덱싱을 실사용 중이다. LLM Wiki/promotion layer 설계는 `docs/superpowers/specs/2026-06-25-auto-context-wiki-promotion-layer.md`에 둔다.

### hooks (`hooks/`) — 유일한 훅 진입점
> 구 `adapters/{claude,codex,gemini}/wrapper.py` 3벌은 제거되고 Claude/Codex/Gemini는 `hooks/run-hook` 단일 디스패처로 완전 통합됐다. Hermes Agent는 별도 host protocol이므로 Python plugin adapter(`plugin.yaml`, `__init__.py`, `hermes_adapter/`)가 같은 core 스크립트를 호출한다. **도메인 로직은 여전히 core/가 SSOT**다.

- `run-hook` — 공통 디스패처(bash). 호출: `run-hook <action> <engine>` (action: recall|update|posttool|index|compile|gate, engine: claude|codex|gemini). `dirname "$0"`로 플러그인 루트를 찾고(env `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` 있으면 우선), engine 라벨(`QMD_ENGINE`)·sandbox/headless 가드 후 backend manager ensure/kick와 `core/<script>` stdin 패스스루를 수행한다. **도메인 로직은 core/가 SSOT.**
- `hooks.json` — Claude hooks (`${CLAUDE_PLUGIN_ROOT}`). `hooks-codex.json` — Codex hooks도 **`${CLAUDE_PLUGIN_ROOT}`**를 쓴다(형태: `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook" <action> codex`). Codex가 신뢰성 있게 주입하는 plugin-root 변수가 CLAUDE_PLUGIN_ROOT이고, 로컬 캐시의 OpenAI codex·zax·superpowers 등 **모든 codex 플러그인이 codex hooks에서 이 형태를 쓴다**(shell 확장이든 텍스트 템플릿 치환이든 양쪽 메커니즘에서 입증된 유일한 형태). 과거엔 `${PLUGIN_ROOT}`(codex 바이너리가 인식하는 alias지만 간헐적으로만 주입)를 단독으로 써서, 비면 command가 `/hooks/run-hook`으로 해석돼 **exit 127**(command not found)이 났다 — 실패 지점이 command 확장 단계라 run-hook 내부 dirname fallback으로는 못 막았다. **novel한 `${VAR:-fallback}` 파라미터 확장이나 `;`/`&&` 제어 연산자는 쓰지 않는다**: 어떤 codex 플러그인도 안 쓰는 문법이라, codex가 shell이 아니라 템플릿 치환을 하면 매칭/해석에 실패할 수 있다. run-hook 내부는 여전히 `CLAUDE_PLUGIN_ROOT→PLUGIN_ROOT→dirname` 순서로 방어한다(도달만 하면). CLAUDE_PLUGIN_ROOT 자체가 비면 여전히 127인데, 이는 codex-level 상태로 OpenAI 공식 포함 모든 codex 플러그인에 동일하게 영향한다(우리만의 문제 아님). PreToolUse `gate`도 이 경우 127로 죽어 deny를 못 내므로 pending 편집 차단이 fail-open된다(수용 가능한 트레이드오프). Codex 공식 문서상 same-event command hooks는 동시 실행될 수 있으므로 posttool/index/compile은 서로 순서 의존하면 안 된다.
- Antigravity(agy)는 공식 PostToolUse payload에 edited file path/tool input이 문서화되어 있지 않고 stdout contract도 `{}`라서, 현재 `scripts/agy-local-hook-install.sh`는 깨진 qmd run-hook 항목을 정리만 한다. AGY 자동 posttool/index/compile은 전용 payload adapter가 생긴 뒤 재활성화한다.
- `hooks.json`은 **표준 구조** `{hooks:[{type:"command",command}]}`를 따라야 한다. 비표준 구조면 호스트(Claude/Codex)가 훅을 인식 못 함.
- 매니페스트: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`(+`interface`, `hooks` 경로 명시).

### Hermes Agent plugin (`plugin.yaml`, `__init__.py`, `hermes_adapter/`)
- Hermes는 Claude/Codex hook JSON을 읽지 않고 Python plugin system을 쓴다. root `plugin.yaml` + `__init__.py`가 `hermes_adapter.plugin.register(ctx)`를 노출한다.
- Hook mapping: `pre_llm_call`→`core/recall.py`, `on_session_start`→`core/update.sh`, `pre_tool_call`→`core/preflight_gate.py`, `post_tool_call`→`core/posttool.py` best-effort + `core/index_enqueue.py` + `core/wiki_compile_enqueue.py`.
- Hermes `post_tool_call` 반환값은 observer-only라 같은 턴 모델 컨텍스트에 posttool 힌트를 주입하지 않는다. 따라서 Hermes 경로의 편집 후 동작은 자동 인덱싱 중심이며, Claude/Codex posttool 컨텍스트 주입과 동일하다고 문서화하면 안 된다.
- Hermes `on_session_start`도 context 주입 채널이 없어(반환값 미사용) update.sh의 SessionStart stdout notice(이전 실패·데몬 미응답·색인 대기열 적체 알림 등)가 표면화되지 않는다. `session_update`는 `QMD_SUPPRESS_NOTICE=1`을 넘겨 notice 출력·TTL marker 기록을 생략한다 — Hermes 실행이 marker를 선점해 이후 Claude/Codex 세션 알림을 삼키지 않기 위함.

### 백엔드 (`backend/`)
- `daemon.sh` — qmd HTTP MCP daemon foreground launcher. manager가 필요 시 `nohup`으로 시작한다.
- `keepalive.sh` — one-shot health-only keepalive. 기본은 `/health`만 확인하고, 전역 vec warm ping은 `QMD_KEEPALIVE_VEC_WARM=1` opt-in일 때만 실행한다.
- `logrotate.sh` — one-shot log size guard. `QMD_DAEMON_LOG`/`QMD_BACKEND_MANAGER`/`QMD_DAEMON_PID`를 지원한다.
- `index_worker.sh` — one-shot dirty 큐 drain. writer lock 획득 → `qmd collection add`+`update`+`embed`(embed lock으로 update.sh와 직렬화) → 새 임베딩/삭제 있으면 manager reload. 큐 보존: busy/실패 시 drop 않고 큐를 그대로 둬 다음 kick에 재시도(coalesce).

### 설치 / cleanup
Claude·Codex는 marketplace plugin install이 제품 경로다. 제품용 `install.sh`/`uninstall.sh`는 없다. AGY는 공식 PostToolUse payload adapter 전까지 자동 qmd hook을 설치하지 않으며, `scripts/agy-local-hook-install.sh`는 과거 stale qmd run-hook cleanup만 수행한다. 기존 레거시 qmd 글로벌 훅/managed LaunchAgent 정리는 `scripts/cleanup-legacy.sh` 또는 `backend_manager.sh cleanup-legacy` 같은 명시적 cleanup에서만 수행한다. 일반 hook 실행 중 LaunchAgent cleanup은 `QMD_CLEANUP_LEGACY=1` opt-in일 때만 허용한다.

### 버전 bump 체크리스트
릴리스 버전을 올릴 때는 모든 host manifest와 테스트 기대값을 같은 버전으로 맞춘다.

- `package.json` — project/npm version
- `plugin.json` — root AGY/Gemini plugin metadata
- `plugin.yaml` — Hermes Agent plugin metadata
- `.claude-plugin/plugin.json` — Claude plugin metadata
- `.codex-plugin/plugin.json` — Codex plugin metadata
- `.claude-plugin/marketplace.json` — Claude marketplace entry
- `.agents/plugins/marketplace.json` — Codex marketplace entry
- `test/probe-manifest.test.mjs` — marketplace/root manifest version asserts

과거 계획 문서(`docs/plans/...`) 안의 버전 문자열은 historical record이므로 릴리스 노트 정리 목적이 아니면 보통 수정하지 않는다. 버전 변경 후 최소 `node --test test/probe-manifest.test.mjs`를 실행하고, 릴리스 전에는 `npm test`를 실행한다.

### 설정 해석 우선순위
`config.load_project_config`는 먼저 사용자 로컬 optout marker(`~/.config/qmd/optout/<hash>.json`)를 확인한다. marker가 있으면 프로젝트 설정 파일이 있어도 `indexing:false`로 해석한다. marker가 없으면 cwd에서 HOME 경계까지 위로 올라가며 `.auto-context/settings.json`을 찾고(없으면 레거시 `.auto-context.json`, `.agents/qmd-recall.json`), **둘 다 없으면 빈 설정(`collections=[]`)을 반환**한다(하위호환 `indexing:false`도 동일). 컬렉션이 비면 recall은 `no_collections`로 **빈 출력** — 즉 미설정/미동의/거절 프로젝트는 무동작이다(cwd 폴더명을 컬렉션으로 삼는 fallback은 없다). v0.7 migration window에서는 update-time 경로가 `.auto-context.json`을 `.auto-context/settings.json`으로 검증 후 이동하며, query-time recall은 read-only fallback만 수행한다.

## 운영상 함정 (디버깅 시 참고)

- **데몬은 single-thread (Node).** recall query가 다른 query나 opt-in vec warm ping과 겹치면 직렬로 밀려 timeout → 간헐적 빈 출력이 날 수 있다. 기본 keepalive는 health-only이며, `QMD_HEALTH_TIMEOUT` 기본값은 2초(잘못된 값은 2초 fallback)다. 코드 버그로 오인하지 말 것. 측정할 때 연속/동시 호출로 데몬을 폭격하면 이 현상이 증폭된다.
- **`index.sqlite-wal` 비대화 주의.** 대량 임베딩 쓰기(마이그레이션) 후 데몬이 떠 있으면 WAL이 checkpoint 안 되고 수 GB로 누적 → 모든 vec query가 느려진다. manager reload는 SIGTERM 후 bounded wait로 clean close를 유도한다. 평상시 검색은 WAL을 거의 안 키운다.
- **`minScore`는 유사도 임계가 아니라 순위 컷이다.** recall은 `rerank: False`로 질의하고, qmd 2.5.3은 그 경로에서 score를 RRF 순위의 역수(`1/rank` — 1위=1.0, 2위=0.5, 3위=0.33)로 돌려준다(`dist/store.js`의 `const rrfScore = 1 / rrfRank`). 따라서 `minScore: 0.8`은 사실상 "1위만" 통과시키고 `topN`을 무의미하게 만든다(라이브 확인: 후보 8건 → `dropped_min_score: 7`). 관련성이 아무리 낮아도 1위는 항상 1.0이라 "약한 결과 차단"으로도 동작하지 않고, 서로 다른 query의 score 비교도 무의미하다. **예외: EP exact-match promotion**(`promote_ep_exact_matches`) — `lexicalPatterns:["ep"]`에서 EP 번호가 파일명과 맞으면 원래 순위와 무관하게 score를 1.0으로 덮어쓰므로 1.0이 복수가 되고 `topN`이 다시 실제 상한으로 동작한다(소설 코퍼스에선 "1위만" 규칙이 그대로 적용되지 않는다). **`rerank=True`로 바꿔도 해결되지 않는다** — `wiki_compile.query_wiki_similar`가 그렇게 우회를 시도했지만, rerank 경로도 `blendedScore = w*(1/rrfRank) + (1-w)*rerankScore`로 RRF 순위를 섞어 점수 상한이 순위로 고정된다(위 `wiki_dedup_judge.py` 항목의 실측 참조). 즉 **어느 경로에서도 daemon score는 유사도가 아니다.** dedup은 이 사실을 받아들여 score를 후보 retrieval floor로만 쓰고 판정을 LLM judge로 이관했고(`wiki_dedup_judge.py`), recall 경로의 해법(순위 컷 제거/폴백)은 정책 판단이 남아 미결이다. 현상은 `docs/settings.md`에 기술돼 있다.
- **shadow query 진단으로 recall 손실을 정량화한다.** `QMD_RECALL_LOG` + `QMD_SHADOW_QUERY=1`이면 `qmd_recall_shadow` 라인 한 줄이 추가된다: primary(실제 recall 대상)의 rank/score/status, lex 단독·vec 단독 분리 질의(어느 쪽이 0건을 냈는지 — qmd lex는 positive term AND 결합이라 term 하나가 색인에 없으면 전멸), raw 대조 질의, 그리고 핵심 판정 `verdict.selected_empty_raw_nonempty`. **이 판정은 데몬 후보 수가 아니라 "최종 주입 결과"가 기준이다** — 실제 손실은 대부분 데몬이 결과를 냈는데 후속 필터(순위 컷 × `recallVerifiedOnly` × `excludeStatuses` × topN)가 곱해져 0건이 되는 경우다(라이브 사례: 후보 8건 → 주입 0건). wiki/raw는 파일 경로가 애초에 달라 "raw top이 선택되지 않았다"류 판정은 상시 true인 무의미한 값이라 두지 않는다. 라인은 selection 라인의 `reason`·`dropped_*`를 복제해 **한 줄로 자족**하며(join 불필요 → 동시 hook 실행에도 오짝 없음), `selected[]`는 `original_rank`/`final_rank`/`ep_promoted`를 남겨 promotion으로 절단 밖에서 올라온 결과를 식별한다. **score만 보지 말고 rank를 보라** — 위 항목 때문에 score는 순위의 함수일 뿐이고 ep promotion이 1.0으로 덮어쓴다. 기본 완전 비활성이며(추가 query 0건), 켜면 프롬프트마다 데몬 질의 최대 3건이 직렬로 붙는다(single-thread 데몬 → per-query 1s + 총 2.5s 예산으로 bound). 본 recall 출력은 shadow보다 **먼저** print되므로 shadow 실패·지연은 주입 내용을 바꾸지 않는다. 상시 사용 금지.
- **빈 출력은 정상 동작일 수 있다.** 데몬 부재/timeout/결과 0건/sandbox/yield — 모두 의도적으로 무출력 종료한다. 빈 출력 ≠ 버그. **정상인지 버그인지 가르려면 `QMD_RECALL_LOG=<파일>`을 켜고 `qmd_recall_selection` 줄의 `reason`을 보라** (`event_disabled`/`no_keywords`/`no_collections`/`daemon_unreachable`/`query_failed`/`no_results_after_filter`/`selected`). `no_results_after_filter`인데 `dropped_unverified`>0이면 `recallVerifiedOnly`(기본 true)가 미검수 wiki 카드를 제외한 것이다 — wikiPath/collectionPaths 불일치로 검수 카드까지 경로 해석 실패해 fail-closed drop되는 misconfiguration도 여기 잡힌다. 이 로그는 파일에만 쓰고 stdout(모델 컨텍스트)엔 절대 안 나가며, env가 없으면 no-op다. index_enqueue도 게이팅으로 skip하는 경우(pending/optout/event 비활성/non-collection-path)는 정상 무출력이다.
