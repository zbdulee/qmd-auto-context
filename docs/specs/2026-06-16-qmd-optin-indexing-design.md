# opt-in 인덱싱 설계 — 동의 없는 자동 인덱싱 폐지 (2026-06-16)

## 배경 / 문제

엉뚱한 폴더(예: `~`, `~/work`, `~/Downloads`, 큰 모노레포 상위)에서 codex/claude/agy를 열면, 의도치 않게 하위 모든 md가 **전역 단일 DB**(`~/.cache/qmd/index.sqlite`)에 인덱싱+임베딩된다. 결과:

1. **오염**: doc 수가 폭증하고, 전역 DB를 공유하는 **다른 프로젝트의 recall까지 무관한 문서로 오염**된다.
2. **WAL 폭증**: 그 대량 임베딩이 [2026-06-16 WAL 슬로다운 이슈](../issues/2026-06-16-qmd-recall-wal-slowdown.md)의 트리거였다. (long-lived 데몬 reader + 대량 쓰기 → WAL 3.5GB → recall timeout → 빈 출력)

### 근본 원인

`core/resolve_paths.py`의 `resolve_paths()` 67-69행:

```python
if not collections:                  # .agents/qmd-recall.json 설정이 없으면
    name = Path(cwd_str).name...
    return {... "entries": [{"name": name, "path": "."}]}   # cwd 전체를 통째로 인덱싱
```

설정이 없으면 **cwd 전체를 자동 인덱싱**한다. 가드는 `is_risky_path`로 시스템 디렉터리(`/`, `/usr`, `/tmp` 등)만 거부할 뿐, `~`·`~/work` 같은 사용자 폴더는 막지 않는다. 즉 **"동의 없는 자동 인덱싱"이 오염과 WAL 폭증 양쪽의 단일 뿌리**다.

## 목표

- collection이 없는 폴더는 **동의 없이는 "최초" 인덱싱하지 않는다.**
- **한 번 승인한 프로젝트는 기존처럼 매 SessionStart마다 자동 갱신**(`qmd update`+`embed`)된다 — 문서가 바뀌면 자동 반영. 이 플러그인의 핵심 가치는 유지한다.
- 사용자가 의도한 프로젝트만 인덱싱 → 전역 DB 오염 제거, 동의 없는 대량 임베딩(=WAL 트리거) 원천 차단.
- claude / codex / agy(Gemini) **3개 플랫폼에서 동등하게 최소 보장**(안내 + 수동 opt-in)이 동작.
- 거절은 기억하여 다시 묻지 않는다.

> **핵심 구분**: 막는 것은 "동의 없는 폴더의 *최초* 인덱싱"이고, "승인된 프로젝트의 *자동 갱신*"은 그대로 둔다. 동의를 **명시 설정(collection) 생성**으로 표현하면, 승인된 프로젝트는 `resolve_paths.py`의 기존 "collections 있음" 경로를 그대로 타므로 자동 갱신 로직을 새로 만들 필요가 없다.

## 비목표 (YAGNI)

- 데몬리스 CLI 전환 — 기각. (CLI cold load 3.8~19초 실측 → recall timeout으로 증상 재발)
- 프로젝트 로컬 `.qmd` 전환 — 기각. (warm 데몬은 프로세스 1개=인덱스 1개라 충돌; cold cost 또는 다중 데몬 부담)
- WAL checkpoint 보강 — 본 설계로 트리거가 사라지므로 범위 밖. (아래 "별도 이슈" 참조)

## 설계

### 1. 동의 없는 최초 인덱싱 차단 (`core/resolve_paths.py`)

`resolve_paths()`의 "설정 없음" fallback만 교체한다. **명시 설정(`collections`)이 있는 경로 = 승인된 프로젝트는 기존 동작(인덱싱 + 자동 갱신) 그대로** 둔다(회귀 없음). 즉 동의는 "설정 존재" 자체로 표현되고, 자동 갱신은 기존 경로가 담당한다.

설정이 없을 때:

1. 전역 거절 목록(`~/.cache/qmd/optin.json`)에서 cwd가 `out`인지 조회한다.
2. 분기:
   - **`out`** (명시 거절) → `{"refused": True, "entries": []}`. 인덱싱 0, 안내도 안 함(조용).
   - **그 외 = `pending`** (설정도 없고 거절도 안 됨) → `{"refused": True, "entries": [], "prompt": <안내 payload>}`. 인덱싱 0 + 안내 메시지 요청.
3. `is_risky_path`에 **`$HOME` 정확히 일치 거부**를 추가한다.

> `refused=True`면 `update.sh`는 이미 `ABORT`하여 collection add·embed가 일어나지 않는다 → 오염·WAL 트리거 차단.
> `pending`은 별도 기록이 필요 없다 — "설정도 `out`도 없음"이 곧 pending이므로, 무응답이면 다음 세션에 자연히 다시 질문된다.

### 2. 상태 모델

상태는 두 신호의 조합으로 결정된다 — 별도의 `in` 저장이 없다(동의 = 설정 존재로 표현).

| 상태 | 판정 | 인덱싱 | 다음 세션 |
|---|---|---|---|
| **동의(`in`)** | 명시 설정(collection) 존재 | ✓ + **매 세션 자동 갱신** | 질문 안 함 |
| **거절(`out`)** | `optin.json`에 `out` 기록 | ✗ | **영구 침묵** |
| **`pending`** | 설정도 `out`도 없음 | ✗ | **다시 질문** (무응답 = 거절 아님) |

거절 목록 파일 — 전역 1개, 3개 플랫폼 공유:

```json
{ "/Users/dulee/Downloads": { "state": "out", "ts": "..." } }
```

- 쓰기는 [WAL 이슈](../issues/2026-06-16-qmd-recall-wal-slowdown.md) 교훈을 따라 **원자적 쓰기**(temp + rename).
- 동시성: 여러 플랫폼이 동시에 쓸 수 있으므로 mkdir 락(기존 `acquire_lock` 패턴 재사용) 또는 read-modify-write를 락 안에서.

### 3. collection 없는 폴더의 흐름 (하이브리드)

`pending` 폴더에서 SessionStart 시:

1. **인덱싱 보류** (자동 인덱싱 안 함).
2. **항상 보이는 안내 메시지 출력**(3개 플랫폼 동등 보장 — stdout→additionalContext):
   > 이 폴더는 아직 인덱싱되지 않았습니다. 검색에 포함하려면 `<헬퍼> --optin`, 다시 묻지 않으려면 `<헬퍼> --optout` 를 실행하세요. (제안 인덱싱 범위: `<.git 루트 또는 cwd>`)
3. **에이전트 능동 질문(보너스)**: 안내 메시지에 "사용자에게 인덱싱 여부를 물어보고, 동의/거절 시 위 명령을 실행하라"는 지시를 포함. 잘 따르는 플랫폼(Claude)에선 대화로 매끄럽게 처리되고, 안 따라줘도 2번 안내가 떠 있어 사용자가 직접 실행 가능.

`.git`은 **자동 트리거가 아니라 "제안 인덱싱 범위"**로만 쓴다. cwd에서 `$HOME`까지 올라가며 `.git`을 탐색하고, 찾으면 그 루트를, 못 찾으면 cwd를 제안값으로 안내에 표기한다.

### 4. 헬퍼 명령 (동의/거절)

에이전트든 사람이든 한 줄로 실행 가능한 헬퍼를 제공한다. 기존 `core/update.sh`에 서브모드를 추가하는 방안:

- `update.sh --optin [<root>]` → **명시 설정(collection)을 생성**한다(`.agents/qmd-recall.json` 작성 또는 `qmd init`). 이후 그 프로젝트는 "collections 있음" 경로로 들어가 인덱싱되고 **매 세션 자동 갱신**된다. (optin.json에 `in`을 따로 쓰지 않는다 — 설정 존재가 곧 동의)
- `update.sh --optout` → optin.json에 `{state:"out"}` 기록. 이후 침묵.

(헬퍼 위치/이름은 구현 시 확정. 핵심은 "한 줄, 인자 최소".)

## 영향 받는 파일

- `core/resolve_paths.py` — fallback 교체, `is_risky_path`에 `$HOME` 추가, optin.json 조회.
- `core/update.sh` — `--optin`/`--optout` 서브모드, pending 시 안내 payload 출력.
- (신규) optin.json 읽기/쓰기 헬퍼 — `resolve_paths.py` 또는 별도 `core/optin.py`.
- 안내 메시지 문구 — 3개 어댑터가 공통으로 쓰도록 core에 둔다.

## 테스트 계획 (TDD)

`test/`에 케이스 추가 (먼저 실패 → 구현):

- `~/Downloads`(`.git` 없음, 미기록) → refused, prompt 포함, 인덱싱 0.
- `~`(HOME) → refused (risky).
- `~/work`(상위, `.git` 없음) → refused.
- `~/work/auto-context`(`.git` 있음, 미기록) → refused + 제안범위 = git 루트.
- optin.json에 `out` 기록된 경로 → refused, **prompt 없음**(침묵).
- 모노레포 하위(cwd≠git루트) → 제안범위 = git 루트.
- `.agents/qmd-recall.json`(=승인된 프로젝트) 있는 경로 → **기존 동작 유지: 인덱싱 + 자동 갱신(회귀 방지)**.
- `--optin` → 명시 설정 생성 후 해당 경로가 "collections 있음" 경로로 인덱싱됨.
- `--optout` → optin.json 원자적 갱신 + 이후 refused·침묵 확인.

## 별도 이슈 (범위 밖, 기록만)

- ✅ **해결됨** — `update.sh`/`logrotate.sh`의 embed/로그회전 후 `launchctl kickstart -k`(SIGKILL)가 데몬 clean checkpoint를 막던 문제는 `launchctl kill TERM`(graceful shutdown → SQLite clean close → WAL checkpoint) + plist `ExitTimeOut=30`으로 수정됨. 상세: [WAL 슬로다운 이슈](../issues/2026-06-16-qmd-recall-wal-slowdown.md).
- 후속(미해결): 데몬 재시작 직후 cold-start 갭 → [keepalive cold-start 갭](../issues/2026-06-16-keepalive-coldstart-gap.md).
