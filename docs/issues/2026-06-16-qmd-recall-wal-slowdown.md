# qmd recall 느림/빈 출력 이슈 — WAL 비대화가 진범 (2026-06-16)

## 한 줄 요약
recall이 3개 플랫폼(Claude/Codex/Gemini)에서 빈 출력 → **원인은 플러그인 코드가 아니라 qmd 데몬의 `index.sqlite-wal` 파일이 3.5GB로 비대해진 것.** WAL을 비우니 vec query가 **20초 → 0.33초 (60배)** 로 회복, recall 정상 동작 확인.

## 증상
- UserPromptSubmit recall이 빈 `additionalContext` 반환 (3개 플랫폼 동일).
- recall의 query timeout(5초)을 vec 검색이 초과 → graceful skip → 빈 출력.

## 오진과 기각 (중요)
- **초기 가설: "metal 컴파일러 부재 → CPU fallback → 임베딩 20초"** → **기각.**
  - 근거: `xcrun -f metal` 실패, Xcode 없음(CommandLineTools만), 데몬 로그에 `ggml_metal_library_init_from_source: error compiling source` 42회.
  - **반증(사용자 지적): metal 부재는 상수다.** 플러그인 도입 전에도 metal은 없었는데 그땐 빨랐다. 상수는 "빠름→느림" 변화를 설명할 수 없다.
  - 실제로 node-llama-cpp(3.18.1) metal prebuilt dylib는 5/30자 그대로, 환경 불변.

## 진범: WAL 3.5GB
- 측정값(같은 collection, 같은 query, metal 없는 동일 CPU):

  | 상태 | vec query |
  |---|---|
  | WAL 3.5GB | **20초** |
  | WAL 비운 직후 (cold) | 1.35초 |
  | warm | **0.33초** |

- 바뀐 변수는 **데이터/WAL뿐.** 60배 차이 → WAL이 단일 원인 확정.
- 데몬 첫 가동 로그에도 흔적: warm 시 `2 queries(lex+vec) = 3.8초`로 timeout 안에 들었던 기록 존재 → 원래는 동작했음.

## WAL이 왜 생기고, 왜 3.5GB까지 커졌나
**WAL = Write-Ahead Logging** (SQLite 저널 모드, qmd가 사용 중. `journal_mode=wal`):
1. 쓰기(INSERT/UPDATE/DELETE)는 본 DB(`index.sqlite`)에 바로 안 쓰고 **`index.sqlite-wal`에 먼저 append**된다. 덕분에 읽기와 쓰기가 동시에 가능하고 쓰기가 빠르다.
2. **checkpoint**가 일어나면 WAL 내용이 본 DB로 병합되고 WAL은 비워진다(`wal_autocheckpoint=1000` 페이지마다 자동).
3. **그런데 checkpoint는 "그 시점을 보고 있는 reader"가 없을 때만 WAL을 truncate할 수 있다.** 데몬이 항상 떠서 long-lived read 커넥션을 잡고 있으면, checkpoint가 WAL 끝까지 잘라내지 못하고 WAL이 무한 성장한다.

**이번 사건의 시퀀스:**
- 6/15 `embed-migration`(대량 임베딩 재생성 = 수십만 행 쓰기) → WAL에 수 GB append.
- 데몬이 계속 떠 있어(reader) checkpoint가 truncate 못 함 → **WAL 3.5GB 누적.**
- 이후 모든 vec query가 본 DB(2.6GB) + WAL(3.5GB)을 함께 봐야 해서 느려짐.

**자동 해소 지점:** 데몬을 종료하면 모든 커넥션이 닫히며 마지막에 checkpoint가 완료 → WAL이 본 DB로 병합되고 `-wal`/`-shm` 파일이 사라진다. (이번에 `launchctl unload`로 확인됨.)

**평소 read는 WAL을 거의 안 키운다:** vec query 3회 후 WAL은 49KB에 불과. 즉 3.5GB는 평상시 검색이 아니라 **대량 쓰기 1회**가 남긴 것.

## 즉시 조치 (완료)
- `launchctl unload` → WAL 자동 병합 → `PRAGMA wal_checkpoint(TRUNCATE)` 확인(log:0).
- 데몬 재가동 후 vec 0.33초, recall 라이브 정상 동작 확인:
  ```
  관련 문서:
  - [service-engineering] .../figma-browse-design.md - figma-browse Skill Design
  - [service-engineering] .../figma-browse.md - figma-browse Skill Implementation Plan
  - [service-engineering] .../morning-brief-design.md - Morning Brief 스킬 설계
  ```

## 재발 방지 (검토 필요 — 새 세션 과제)
1. **대량 쓰기(embed-migration 등) 직후 명시적 checkpoint** 실행: `PRAGMA wal_checkpoint(TRUNCATE)`.
2. **주기적 checkpoint를 backend 작업에 추가** (logrotate/keepalive 류). 단 데몬이 reader를 잡고 있으면 PASSIVE/FULL checkpoint는 부분만 됨 — 효과 검증 필요.
3. 또는 **데몬이 read 커넥션을 짧게 유지**하도록 qmd 측 개선(upstream 이슈 후보).
4. "프로젝트별 DB 분리" 안은 **불필요** — WAL 비대화는 DB 크기가 아니라 checkpoint 실패 탓이라, 분리해도 같은 구조면 각 WAL도 폭증한다. 분리는 우회일 뿐 해결이 아님.

## 별개로 남은 이슈
- **데몬 single-thread 동시성**: recall query가 keepalive의 cold vec ping(1.35초)이나 다른 query와 겹치면 직렬 처리로 밀려 5초 timeout → 간헐적 빈 출력. 연속/동시 호출 시 재현. 실사용(프롬프트 띄엄띄엄)에선 영향 적으나, keepalive 타이밍과 recall timeout 여유를 점검할 것.
- **keepalive vec 단독 ping이 간헐적으로 비정상 지연**(로그상 1 query가 20~61초인 사례) — WAL 해소 후 재관측 필요.
- **metal/Xcode는 보너스 항목**: 지금도 CPU로 0.33초면 충분. Xcode 설치 시 GPU로 추가 단축 가능하나 우선순위 낮음(근본 문제 아님).

## 핵심 교훈
"환경 상수(metal 부재)"로 "성능 변화(빠름→느림)"를 설명하려 한 것이 오진의 원인. **변화를 설명하려면 변한 변수(WAL/데이터)를 찾아야 한다.** 사용자의 데이터 가설이 처음부터 옳았다.
