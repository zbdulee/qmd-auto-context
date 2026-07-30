# 훅 경유 E2E 테스트 계획 (1~8단계 완료 후)

주입 품질 로드맵 1~8단계를 마친 뒤 **실제 훅 경유**로 전 흐름을 검증하는 계획.
사용자 결정: **8단계까지 완료 후 실행**, 규모는 **문서 4~6건**(두 프로젝트에 각 2~3건).

## 왜 별도 계획이 필요한가 — cache staleness 는 버전으로 탐지되지 않는다

2026-07-30 실측:

| 위치 | 상태 | `core/recall.py` |
|---|---|---|
| dev repo | `161ac2e`, **push 안 된 커밋 15개** | 1899줄 |
| marketplace clone | `54c94a2` (0.22.1) | 962줄 |
| cache `0.22.2` | 내용은 낡음 | 962줄 |
| cache `0.22.1` | 오늘 08:56 수정됨 | 962줄 |

**dev repo 와 cache 가 같은 버전 번호(0.22.2)인데 내용이 다르다.** `BODY_LINE_PREFIX`(1단계)·
`injectSourcePathsPerCard`(2단계)·`resolve_existing_source`·`write_text_atomic`(3단계) 마커가
cache 전 버전에서 0건이고, 3단계 신규 파일(`core/wiki_source_*.py`)도 없다.

즉 **버전 문자열 비교로는 stale 을 판정할 수 없다.** 이 세션에서 실제로 이 함정에 걸렸다 —
개발은 0.21.0~0.22.x 에서 진행되는 동안 훅은 cache 0.19.11 을 실행했고, 그동안의 "라이브 검증"은
전부 `python3 core/recall.py` **직접 호출**이었다(훅 경유가 아니었다).

**판정 기준은 내용이다**: 아래 마커가 cache 에 존재하는지 확인한다.

```bash
C=~/.claude/plugins/cache/qmd-auto-context-marketplace/qmd-auto-context/<version>
wc -l "$C/core/recall.py"                     # dev repo 와 같은지
ls "$C/core/" | grep wiki_source              # 3단계 신규 파일
grep -c BODY_LINE_PREFIX "$C/core/recall.py"  # 1단계
grep -c injectSourcePathsPerCard "$C/core/recall.py"  # 2단계
grep -c write_text_atomic "$C/core/wiki_compile.py"   # 3단계
```

## 배포 체인

```
dev repo  →  GitHub  →  marketplaces/<name>/ (git clone)  →  cache/<marketplace>/<plugin>/<version>/
```

cache 는 **버전 디렉터리 이름**으로 구분한다. `0.22.2` 가 이미 낡은 내용으로 존재하므로 같은
번호로 덮으면 어느 것이 무엇인지 알 수 없게 된다 → **버전 bump 가 선행 조건이다.**

## 활성 전환 메커니즘 (2026-07-30 확인)

cache 에 버전 디렉터리를 만드는 것만으로는 **활성이 되지 않는다.** 레지스트리가 명시적으로
설치 경로·버전·커밋을 기록한다:

`~/.claude/plugins/installed_plugins.json`
```json
"qmd-auto-context@qmd-auto-context-marketplace": [{
  "scope": "user",
  "installPath": ".../cache/qmd-auto-context-marketplace/qmd-auto-context/<version>",
  "version": "<version>",
  "gitCommitSha": "<commit>",
  "lastUpdated": "<iso8601>"
}]
```

`marketplaces/qmd-auto-context-marketplace/` 는 저장소의 git clone 이고 정규 경로(`/plugin`)는
그것을 갱신한 뒤 cache 로 추출한다. Remote Control 환경에서 `/plugin` 을 쓸 수 없을 때의
수동 절차:

1. **추적 파일만** 복사한다 — `git archive HEAD | tar -x -C <cache>/<version>/`.
   `cp -r` 는 테스트 임시 디렉터리·`.worktrees` 를 함께 담는다(실제로 `git add -A` 로
   `.tmp-qmd-http-hier-raw-threshold-*` 가 커밋에 섞인 사고가 있었다 → `.gitignore` 를
   `.tmp-qmd-*/` 로 넓혔다)
2. 내용 마커로 stale 을 판정한다(버전 문자열로는 불가 — 위 절 참조)
3. `installed_plugins.json` 을 백업하고 `installPath`·`version`·`gitCommitSha`·`lastUpdated`
   를 갱신한다
4. **새 세션에서 확인한다** — 실행 중 세션은 레지스트리를 다시 읽지 않는다

## Phase A — 코드를 실제로 도는 플러그인에 넣기

1. **버전 bump** (CLAUDE.md 체크리스트: 매니페스트 7곳 + `test/probe-manifest.test.mjs`).
   1~8단계 분량이므로 minor bump.
2. **cache 수동 설치** — 새 버전 디렉터리에 복사. push 없이 로컬만으로 가능하므로
   **테스트 통과 후 push** 가 순서상 안전하다(원격 반영은 되돌리기 어렵다).
   사용자가 Remote Control 환경에서 `/plugin` 을 쓸 수 없었던 선례가 있다.
3. **훅이 새 코드를 실행하는지 확인** — 위 마커 확인 + `python3 core/recall.py` 직접 호출이
   **아닌** 실제 훅 경유 주입 관찰. 이 단계가 지난번에 빠졌다.

## Phase B — 검증할 흐름

`claude -p` 로 라이브 프로젝트(`../service-engineering`, `../novel/귀신은 약효가 돌 때 보인다`)에
문서를 쓰며 각 지점을 관찰한다. 전 구간에서 `QMD_RECALL_LOG` 를 켜 둔다.

| # | 단계 | 확인 |
|---|---|---|
| 1 | SessionStart | `update` 실행, stdout 무출력(또는 예상된 notice 1줄) |
| 2 | 문서 작성 | PostToolUse → dirty 큐 + compile source 큐 적재 |
| 3 | compile worker | extractor 호출 → `.auto-context/wiki/` 에 카드 생성 |
| 4 | verify worker | **extractor 와 다른 엔진**으로 검증(4단계) → `status: verified`, `verifiedBy` ≠ extractor engine |
| 5 | 새 프롬프트 | 그 카드가 본문 `  \| ` 인용 + 원문 경로 `  ↳ ` 로 주입 |
| 6 | 소스 개명 | source scan 감지 → 원장 1행 + SessionStart notice → `wiki-source-repair --list` → `--repoint` 복구 |
| 7 | 로그 | `reason`·`card_read_*`·`bodies_*`·`sources_*`·`source_drop_reasons` — **조용한 실패 0** |

6행이 3단계 전체를 훅 경유로 처음 태우는 지점이다.

## 비용과 영향 범위

- 문서 1건당 **extractor + verifier = host CLI 호출 2회 이상이 사용자 계정에 청구된다.**
  4단계 교차 검증이 붙으면 엔진이 둘이므로 더 늘어난다. 4~6건 = 대략 20~30회.
- 라이브 저장소에 **실제 파일과 실제 wiki 카드가 생성된다.** 생성 경로·카드 목록을 남겨
  되돌릴 수 있게 한다.
- 개명 테스트(6행)는 **기존 파일을 개명**한다 — 테스트 전용으로 만든 파일에만 적용한다.

## 사용자가 수용한 리스크

E2E 를 8단계 뒤로 미루므로, 훅 경유에서만 드러나는 결함이 늦게 발견되면 **여러 단계를 되짚어야
한다.** 이 트레이드오프를 명시적으로 선택했다(2026-07-30).

완화: 각 단계에서 `python3 core/<script>.py` 직접 호출로 검증하되 **그것이 훅 경유와 다르다는
것을 기록**하고, Phase B 에서 재검증할 항목을 이 문서에 누적한다.

### Phase B 에서 재검증할 항목 (단계 진행 중 누적)

- 1단계: 카드 본문 인용 접두 `  | `, frontmatter title, project-root 상대 경로
- 2단계: `  ↳ ` 원문 경로, 3단 우선순위 안내문, `injectSourcePathsPerCard` 상한
- 3단계: 소스 전멸 감지 → 원장 → notice → repair 재지정, 원자적 쓰기(실패 주입은 훅 경유로 불가)
- 4단계: 교차 검증 — `verifiedBy` ≠ extractor engine, `verifiedMode: cross-engine`.
  다른 엔진 CLI 부재 시 `self` 로 degrade 하고 기록이 남는지. non-127 실패 후 **다음 run 이
  다음 후보로** 내려가는지(`verify-engine-cooldown.json` 이 생기는지)
- 5단계: `core/crowding_probe.py` 는 훅이 import 하지 않는다(blocking 비용 구조적 0).
  E2E 에서는 훅 경유로 **불려서는 안 되는 것**을 확인한다 — recall 로그에 crowding 관련
  항목이 없어야 한다
- 6단계: 한 run 의 유료 호출이 상한 안인가. `verifyQueued` 가 그 run 의 카드를 **먼저**
  검수하는지(backlog 가 있을 때). `cards_per_source_cap` 레코드가 나오는지(모델이 카드를
  많이 낼 때만)
- 7단계: role `source` 는 라이브 프로젝트에 설정하지 않았으므로 **기존 role 경로가 무변화**인지만
  확인한다(`raw`/`wiki` 프로젝트에서 dirty 큐·recall payload 가 이전과 같은지)
- 8단계: orphan 정리 후 인덱스에서 라이브 recall 이 정상 주입되는지(이미 직접 호출로 확인했고
  **훅 경유로 재확인**). `minScore` 순위 컷 때문에 후보 다수가 탈락하는 것은 정상 동작이다

### 훅 경유로 처음 실행되는 코드 (E2E 의 실질 대상)

이 파일들은 1~8단계에서 새로 생겼고 **cache 0.22.2 에는 존재하지 않았다** — 즉 훅 경유
실행 이력이 0 이다:

`core/crowding_probe.py`(훅 미사용) · `core/wiki_markers.py` · `core/wiki_source_missing.py` ·
`core/wiki_source_repair.py` · `core/wiki_source_scan.py` · `core/yaml_scalars.py`

그리고 기존 파일 중 훅 경유 경로가 크게 바뀐 것: `core/recall.py`(962 → 1,917줄) ·
`core/update.sh`(백그라운드 fork + role 판정 + notice 3종) · `core/wiki_compile.py` ·
`core/wiki_verify_worker.py` · `core/config.py`(role SSOT).

**`core/update.sh` 가 가장 위험하다** — SessionStart 마다 돌고, 백그라운드 fork 를 띄우고,
stdout 이 모델 컨텍스트이며, 이 세션에서 조용한 실패(f-string SyntaxError 가 `2>/dev/null` 로
버려지고 `END rc=0` 으로 성공 위장)가 실제로 발생했던 파일이다.
