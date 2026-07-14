# Improvement Proposals

코드 리뷰에서 발견된 품질 이슈 4건에 대한 검증 결과와 개선 제안입니다.
각 항목은 실제 코드를 열어 리뷰 지적이 정확한지 먼저 확인한 뒤,
개선 방향과 트레이드오프를 정리했습니다. 유지보수자가 실제 수정 작업을
착수할 때 이 문서를 스펙 초안으로 쓰는 것을 의도합니다.

문서 내 라인 번호는 작성 시점(v0.19.2) 기준이므로 코드가 바뀌면 어긋날 수
있습니다. 함수/식별자 이름을 우선 기준으로 삼으세요.

## 1. `compact_manifest`의 O(n²) 스캔과 반복 비용 (medium)

대상: `core/wiki_compile.py` — `compact_manifest()` (422–444행), `same_generated_identity()` (409–419행)

### 현재 문제

리뷰 지적이 정확합니다. 검증 결과:

- `compact_manifest`는 `generated-manifest.jsonl`이 `LOG_MAX_BYTES`(256KB)를
  넘으면 모든 행 쌍에 대해 `same_generated_identity`를 양방향으로 호출하는
  이중 루프를 돌립니다 — 정확히 O(n²) pairwise scan입니다.
- 이 함수는 auto-write가 일어나는 매 compile마다 호출됩니다 (`main()` 내
  `append_jsonl(manifest_path, ...)` 직후).
- 접힌 행이 없으면(`len(kept) == n`) 파일을 다시 쓰지 않으므로, 페이지들이
  서로 다른 identity를 가진 흔한 경우 파일 크기가 임계 아래로 내려가지
  않습니다. 결과적으로 프로젝트가 커진 뒤에는 **매 compile마다 전체 O(n²)
  스캔을 다시 지불**하게 됩니다.

256KB manifest는 대략 수백\~수천 행 규모라 단발 비용 자체는 치명적이지
않지만, compile은 파일 편집마다 백그라운드로 도는 hot path라 누적 비용이
프로젝트 크기에 비례해 계속 커지는 구조가 문제입니다.

### 근본 원인

두 가지가 겹쳐 있습니다.

1. **알고리즘**: `same_generated_identity`는 세 개의 동등성 키(targetPath,
   sourceHash, canonicalKey)의 합집합 관계인데, 이를 해시 버킷 없이 쌍별
   비교로 풀고 있습니다.
2. **재시도 정책**: "임계 초과 → 압축 시도"만 있고 "압축해도 안 줄어드는
   상태"에 대한 기억이 없어, 접을 게 없는 파일에 대해 같은 스캔을 무한
   반복합니다.

### 제안하는 개선안

**(a) O(n) 역방향 스캔으로 교체.** 관계가 키 동등성의 합집합이므로 최신 행부터
역순으로 훑으며 seen-set을 유지하면 의미를 보존한 채 선형으로 풀 수 있습니다.
주의할 점은 `targetResolution == "explicit"` 가드입니다. 현재 코드는
`same_generated_identity(rows[i], rows[j]) or same_generated_identity(rows[j], rows[i])`
의 대칭 합집합을 쓰는데, 이 관계를 풀어 쓰면:

- targetPath가 같으면 무조건 매치 (가드보다 먼저 검사됨).
- sourceHash 또는 canonicalKey가 같으면, **두 행 중 하나라도 explicit이
  아닐 때** 매치 (각 방향의 가드가 두 번째 인자에만 걸리므로).

따라서 역방향 스캔에서 유지할 seen-set은 다섯 개면 됩니다:

- `seen_target_paths`
- `seen_hashes_any` / `seen_keys_any` — 최신 쪽 explicit 여부와 무관하게
  기록. 검사 대상(더 오래된 행)이 non-explicit일 때 이 셋과 대조.
- `seen_hashes_nonexplicit` / `seen_keys_nonexplicit` — 최신 쪽이
  non-explicit인 행만 기록. 검사 대상이 explicit일 때 이 셋과 대조.

행 i를 drop하는 조건은 "targetPath가 seen에 있거나, (i의 explicit 여부에
맞는 셋에서) hash 또는 key가 seen에 있거나"이며, 이는 기존 pairwise 대칭
관계와 동치입니다. 살아남은 행은 원래 순서로 보존해 `previous[-1]` /
`previousStatus` 계약을 유지합니다. 교체 전 기존 pairwise 구현을 oracle로
삼아 무작위 manifest에 대해 결과 동일성을 검증하는 테스트를 붙이는 것을
권합니다 (explicit 가드 케이스 포함).

**(b) "압축 불가" 상태의 재시도 억제.** O(n)이 되어도 매 compile마다 전체
파일을 읽고 파싱하는 비용은 남습니다. 압축을 시도했는데 크기가 임계 아래로
내려가지 않았다면, 그 시점의 파일 크기를 기억해 두고(예: manifest 옆
`.compact-stamp` 사이드카에 마지막 압축 후 바이트 수 기록) 이후에는
"현재 크기가 스탬프 대비 일정 비율(예: +25%) 이상 커졌을 때"만 다시
시도합니다. 스탬프 파일 유실은 스캔 1회 추가로만 이어지므로 self-heal
성질(기존 docstring이 명시한 worst-case 계약)을 해치지 않습니다.

(a)만으로도 severity는 해소되고, (b)는 저비용 추가 방어입니다.

### 트레이드오프

- O(n) 구현은 explicit 가드 때문에 pairwise 버전보다 읽기 난도가 올라갑니다.
  seen-set 다섯 개의 의미를 주석으로 남기지 않으면 회귀 위험이 있습니다.
- 스탬프 사이드카는 compile 디렉토리에 관리 파일이 하나 늘고, 동시 실행
  race에서 스탬프가 낡은 값을 가질 수 있습니다. 다만 결과는 "스캔을 한 번 더
  하거나 한 번 덜 하는 것"뿐이라 correctness에는 영향이 없습니다.
- 임계값(256KB) 자체를 올리는 우회도 가능하지만, 근본 원인을 남겨두는
  것이라 권하지 않습니다.

## 2. `update.sh`의 부기용 python3 서브프로세스 반복 스폰 (low)

대상: `core/update.sh` — `status_path_for_workdir()` (31–46행), `canonical_workdir()` (48–55행), `set_status_for_workdir()` (57–60행)

### 현재 문제

리뷰 지적이 정확합니다. 검증 결과:

- `status_path_for_workdir`(realpath + sha256 → status 파일 경로)와
  `canonical_workdir`(realpath)는 각각 별도 `python3` heredoc 프로세스를
  스폰합니다.
- `set_status_for_workdir`가 둘을 모두 호출하므로 1회당 프로세스 2개.
- 호출 지점은 `main()`(SessionStart 동기 경로)과 `run_update()`(`--worker`로
  fork된 백그라운드 경로) 두 곳이라, SessionStart 1회당 순수 부기용으로
  python3 프로세스 4개가 뜹니다.
- 두 함수는 같은 realpath 계산을 중복 수행합니다 (status 경로 계산 내부에도
  `os.path.realpath`가 있음).

추가로 확인된 사실: `main()`은 `STATUS`만 사용하고 `STATUS_WORKDIR`은 실패
상태 기록용(`write_failure_status`, `run_update` 경로에서만 호출)에만
쓰입니다. 즉 `main()`의 `canonical_workdir` 호출분은 결과가 버려집니다.

severity low가 타당합니다 — 이 스크립트는 그 외에도 config 파싱 등에서
python3를 여러 번 스폰하며, 여기만 고쳐도 전체 SessionStart 지연의 일부만
줄어듭니다. 다만 개선 비용이 매우 낮습니다.

### 근본 원인

realpath와 sha256을 POSIX sh만으로 이식성 있게 계산하기 어려워 python3에
기댔는데, 함수를 "값 하나당 프로세스 하나" 단위로 잘라서 같은 계산을
중복 스폰하게 됐습니다.

### 제안하는 개선안

**(a) 두 계산을 python3 1회로 합치기.** realpath와 status 경로를 한
프로세스에서 두 줄로 출력하고 셸에서 나눠 받습니다:

```sh
resolve_workdir_meta() {  # stdout: line1=canonical workdir, line2=status path
  python3 - "$_QMD_CACHE_DIR" "$1" <<'PY'
import hashlib, os, sys
cache_dir, cwd = sys.argv[1:3]
real = os.path.realpath(cwd)
digest = hashlib.sha256(real.encode("utf-8")).hexdigest()[:16]
print(real)
print(os.path.join(cache_dir, f"update-status-{digest}.txt"))
PY
}

set_status_for_workdir() {
  if [ -n "${QMD_UPDATE_STATUS:-}" ]; then
    STATUS="$QMD_UPDATE_STATUS"
    STATUS_WORKDIR="$(canonical_workdir "$1")"   # 또는 아래 (b)로 함께 제거
    return 0
  fi
  local meta
  meta="$(resolve_workdir_meta "$1")"
  STATUS_WORKDIR="$(printf '%s\n' "$meta" | sed -n 1p)"
  STATUS="$(printf '%s\n' "$meta" | sed -n 2p)"
}
```

기존 `QMD_UPDATE_STATUS` env override(테스트 주입)는 그대로 살립니다.

**(b) main → worker로 계산 결과 전달.** `main()`이 이미 계산한 값을
`--worker` fork에 env로 넘기면 worker 쪽 재계산이 사라집니다.
`status_path_for_workdir`에는 이미 `QMD_UPDATE_STATUS` override 구멍이
있으므로, fork 라인을 다음처럼 바꾸면 됩니다:

```sh
QMD_UPDATE_STATUS="$STATUS" QMD_CANONICAL_WORKDIR="$STATUS_WORKDIR" \
  nohup bash "$0" --worker "$workdir" </dev/null >>"$LOG" 2>&1 &
```

`canonical_workdir`에도 `QMD_CANONICAL_WORKDIR` 단락을 추가합니다.
(a)+(b)를 함께 적용하면 SessionStart 1회당 부기용 스폰이 4개 → 1개가 됩니다.

**(c) 대안 — 외부 유틸리티 사용은 권하지 않음.** `realpath`(macOS 13+),
`shasum`/`openssl` 조합으로 python3를 완전히 제거할 수도 있지만, 플랫폼별
분기가 늘고 이 저장소의 다른 셸 코드도 어차피 python3에 의존하므로 이식성
이득이 없습니다.

### 트레이드오프

- (b)는 worker가 항상 `main()`을 거쳐 fork된다는 가정을 env 계약으로
  만듭니다. `--worker`를 수동 실행하는 디버깅 경로는 env가 없으므로 기존
  계산 경로가 폴백으로 남아 있어야 합니다 (단락 방식이라 자연히 충족됨).
- 절약분은 SessionStart당 프로세스 3개 수준이라 체감 효과는 작습니다.
  같은 파일의 다른 python3 스폰(config 파싱 3회 등)까지 묶는 더 큰
  리팩터링도 가능하지만, 그건 별도 과제로 다루는 게 안전합니다.

## 3. `run-hook`의 `index` / `compile` stdin 버퍼링 중복 (low)

대상: `hooks/run-hook` — `index` 액션 (70–84행), `compile` 액션 (85–111행)

### 현재 문제

리뷰 지적이 정확합니다. 검증 결과:

- 두 액션 모두 동일한 보일러플레이트로 stdin을 `mktemp` 파일에 버퍼링합니다
  (mktemp 실패 시 stdin drain 후 종료, cat 실패 시 tmp 삭제 후 종료).
- tmp 버퍼가 실제로 필요한 건 `compile`뿐입니다 — payload를 두 번 읽기
  때문입니다 (① `cwd` 추출용 python3, ② `wiki_compile_enqueue.py` 입력).
- `index`는 payload를 `index_enqueue.py`에 한 번만 넘기므로 stdin을 직접
  파이프해도 됩니다. 같은 파일의 `recall` / `posttool` / `gate` 액션이
  이미 stdin 직접 전달 방식을 쓰고 있어 선례도 있습니다.

### 근본 원인

`compile` 액션의 이중 읽기 요구를 해결한 tmp 버퍼링 패턴이 `index`에도
그대로 복제됐습니다.

### 제안하는 개선안

**(a) `index`에서 tmp 버퍼링 제거 (권장, 최소 변경).**

```sh
index)
  python3 "${QMD_CORE_INDEX_SCRIPT:-$ROOT/core/index_enqueue.py}" >/dev/null 2>&1 || true
  bash "$MANAGER" kick-index >/dev/null 2>&1 || true
  exit 0
  ;;
```

이렇게 하면 tmp 버퍼가 필요한 액션은 `compile` 하나만 남으므로 공용 헬퍼
함수를 만들 필요도 없어집니다.

**(b) 선택 — `compile`의 이중 읽기 자체를 없애기.**
`wiki_compile_enqueue.py`가 enqueue 후 payload의 `cwd`를 stdout으로
출력하도록 계약을 바꾸면 `compile`도 stdin 직접 파이프가 가능해집니다:

```sh
compile)
  payload_cwd="$(python3 "${QMD_CORE_COMPILE_ENQUEUE_SCRIPT:-...}" 2>/dev/null || true)"
  [ -n "$payload_cwd" ] && bash "$MANAGER" kick-wiki-compile "$payload_cwd" >/dev/null 2>&1 || true
  exit 0
  ;;
```

다만 이는 enqueue 스크립트의 stdout 계약 변경이라 (a)보다 파급이 큽니다.
현재 enqueue stdout은 버려지고 있어 변경 자체는 안전하지만, 다른 호출자가
생길 경우를 대비해 계약을 스크립트 docstring에 명시해야 합니다.

### 트레이드오프

- tmp 버퍼링에는 부수 효과가 하나 있습니다: python3가 아예 없거나 즉시
  실패해도 `cat`이 stdin을 끝까지 소비해 host 쪽 pipe write가 EPIPE를 맞지
  않습니다. 직접 파이프로 바꾸면 이 보장이 사라집니다. 하지만 `recall` 등
  기존 직접 전달 액션들이 이미 같은 조건에서 동작하고 있으므로, 이 보장은
  이 코드베이스에서 계약으로 취급되지 않는다고 보는 게 일관적입니다.
  보수적으로 가려면 `{ python3 ... || cat >/dev/null; }` 한 줄로 drain
  폴백을 유지할 수 있습니다.
- (b)는 hook 디스패처와 enqueue 스크립트 간 결합을 늘립니다. 중복 제거
  효과 대비 이득이 크지 않아 (a)만 적용하는 것도 충분합니다.

## 4. `verified` status의 write-protection / recall-신뢰 비대칭 (informational)

대상: `core/wiki_compile.py` — `is_auto_writable_page()`의 보호 status 셋 (711행), `core/recall.py` — `REVIEWED_WIKI_STATUSES` (80행)

### 현재 문제 (검증 결과)

리뷰 지적은 대체로 정확하나 한 가지 보정이 필요합니다.

- 비대칭 자체는 사실입니다: `is_auto_writable_page`의 보호 셋은
  `{"reviewed", "canon", "manual", "superseded"}`로 `verified`가 빠져 있고,
  `recall.py`의 `REVIEWED_WIKI_STATUSES`는 `{"verified", "reviewed",
  "canon", "manual", "superseded"}`로 `verified`를 포함합니다.
- 의도된 설계라는 추정도 코드로 뒷받침됩니다: auto-write의 updated 경로는
  기존 페이지의 status를 `defaultStatus`(generated)로 명시 리셋하고
  `verifiedBy`/`verifiedAt`을 비우며(877–888행 주석이 이유를 설명),
  verify worker는 generated 카드를 대조 검증해 verified로 승격합니다
  (904행 이후). 즉 "verified는 recall 신뢰는 받되 쓰기 보호는 받지 않아,
  소스가 바뀌면 generated로 되돌아가 재검증된다"는 라이프사이클이 실제로
  구현되어 있습니다.
- **보정**: "교차 참조 주석이 없다"는 지적은 절반만 맞습니다.
  `recall.py:77–79`에는 이 비대칭이 의도임을 설명하는 주석이 이미
  있습니다. 주석이 없는 쪽은 `wiki_compile.py`의 보호 셋입니다 — 그리고
  실수로 "고치려는" 사람이 만질 파일이 바로 그쪽이라, 위험 지점에 주석이
  없는 상태입니다.

### 근본 원인

한쪽(consumer, recall)에만 의도 설명이 있고, 불변식이 실제로 깨질 수 있는
쪽(producer, wiki_compile)에는 없습니다. 두 셋이 서로 다른 파일에 리터럴로
하드코딩되어 있어 한쪽만 고치는 실수가 구조적으로 가능합니다.

### 제안하는 개선안

코드 동작 변경 없이 문서화로 해결하는 것이 맞습니다.

**(a) `wiki_compile.py` 보호 셋에 미러 주석 추가 (권장).**
`is_auto_writable_page`의 status 검사 줄 위에 다음 취지의 주석을 답니다:

```python
# 주의: verified는 의도적으로 이 보호 셋에서 제외한다. verified는 기계
# 검수 통과라 recall 신뢰(recall.py REVIEWED_WIKI_STATUSES)는 받지만
# 쓰기 보호는 받지 않는다 — 소스 변경 시 updated 경로가 status를
# generated로 리셋해 재검증 대상으로 되돌리기 위함이다. 여기에 verified를
# 추가하면 stale 카드가 영구히 verified로 남는다.
```

**(b) 선택 — 두 셋을 명명 상수로 중앙화.** `core/config.py`에 이미
`WIKI_STATUSES`가 있으므로, 같은 곳에 `WRITE_PROTECTED_STATUSES`와
`RECALL_TRUSTED_STATUSES`를 나란히 정의하고 비대칭 설명 주석을 한 곳에
모으면 "한쪽만 수정" 실수가 원천 차단됩니다. 다만 이는 코드 변경이고,
recall.py는 hot path에서 import 최소화를 의도했을 수 있으므로 (a)를 먼저
적용하고 (b)는 다음 리팩터링 기회에 검토하는 순서를 권합니다.

### 트레이드오프

- (a)는 주석 중복이 생기지만(양쪽에 같은 설명), 이 케이스는 "어느 파일을
  열든 의도를 보게 하는 것"이 목적이므로 중복이 오히려 바람직합니다.
- (b)는 단일 SoT라는 장점이 있으나 recall.py에 config 모듈 의존을
  추가합니다. recall은 UserPromptSubmit hot path라 import 비용과 실패
  모드(fail-open 원칙)를 함께 검토해야 합니다.
