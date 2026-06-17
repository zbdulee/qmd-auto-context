# qmd auto-context

qmd 기반 자동 컨텍스트 주입(세션 시작 시 인덱스 갱신 + 프롬프트마다 관련 문서 recall + 편집 후 연속성 힌트)을 **Claude Code · Codex · Antigravity(Gemini) 세 플랫폼**에서 동작시키는 플러그인.

흩어져 있던 글로벌/프로젝트 qmd 훅을 단일 리포로 SSOT화했다. 플랫폼 무관 `core/` 1벌 + 플랫폼별 얇은 `adapters/` 구조.

## 구조

```
core/        recall.py · update.sh · posttool.py · config.py · keywords.py · resolve_paths.py
adapters/    claude/ · codex/ · gemini/   (wrapper.py + hooks.json)
backend/     daemon.sh · keepalive.sh · logrotate.sh · launchd/*.plist (@@HOME@@ 템플릿)
config/      qmd-recall.schema.json
test/        *.test.mjs (node:test)
install.sh · uninstall.sh
```

## 동작

| 훅 | 역할 | Claude | Codex | Gemini |
|----|------|--------|-------|--------|
| 세션 시작 | qmd 인덱스 갱신 | `SessionStart` | `SessionStart` | `SessionStart` |
| 프롬프트 제출 | 관련 문서 recall | `UserPromptSubmit` | `UserPromptSubmit` | `BeforeAgent` |
| 도구 사용 후 | 연속성 힌트 | `PostToolUse` | `PostToolUse` | `AfterTool` |

어댑터는 stdin `{prompt,cwd}`를 코어에 패스스루하고 engine 라벨/로그 경로/headless·sandbox 체크만 주입한다.

## 설정 / opt-in (프로젝트 로컬)

동의·거절·설정은 **프로젝트 루트 `.auto-context.json` 단일 파일**로 표현한다. **파일이 없으면 인덱싱·검색하지 않고**(미동의=pending), 세션 시작 시 1회 안내만 한다. 동의/거절은 헬퍼 한 줄로:

```bash
bash core/update.sh --optin  [<프로젝트경로>]   # 동의 → 인덱싱 + 매 세션 자동 갱신
bash core/update.sh --optout [<프로젝트경로>]   # 거절 → 인덱싱·검색 안 함 (영구 침묵)
```

상태는 명시 boolean `indexing`으로 결정된다(`true`=동의 / `false`=거절 / 파일 없음=pending):

```jsonc
{
  "indexing": true,                  // 필수: 인덱싱 동의 여부
  "name": "내 프로젝트",
  "collections": ["proj-manuscript", "proj-plot"],
  "minScore": 0.8,
  "collectionPaths": { "proj-manuscript": "04_Manuscript" }, // posttool reader-facing 판별
  "lexicalPatterns": ["ep"],         // EP/화 번호 exact 검색 (소설 도메인)
  "prefixStyle": "full",             // "full"(기본) | "tag"(마지막 세그먼트)
  "skipPaths": [".zb-context"],
  "topN": 3, "queryTimeout": 5
}
```

레거시 `.agents/qmd-recall.json`은 하위호환으로 계속 읽힌다(`indexing` 키 없으면 collections 있을 때 동의로 간주). `install.sh`는 `QMD_MIGRATE_SCAN`(기본 `~/work/novel`) 범위의 레거시를 `.auto-context.json`으로 마이그레이션하며(멱등·백업), 그 밖의 프로젝트는 `--optin` 실행 시 레거시 내용을 그대로 승계한다.

## 설치 / 제거

```bash
bash install.sh --dry-run    # 변경 계획만 출력 (파일 변경 없음)
bash install.sh              # 3플랫폼 감지 → .bak-original 백업 → 어댑터 등록 → 백엔드 멱등 → npm test
bash uninstall.sh            # .bak-original 복원 + 어댑터 제거
```

install은 멱등하며, 기존 qmd 글로벌 훅을 어댑터로 교체하고 비-qmd 훅은 보존한다. 프로젝트가 자체 `.auto-context.json`(또는 레거시 `.agents/qmd-recall.json`) + 로컬 훅을 가지면 글로벌 어댑터는 양보(이중 실행 방지)한다. 또한 install 시 레거시 `.agents/qmd-recall.json`을 `.auto-context.json`으로 마이그레이션한다.

### sandbox

`QMD_SANDBOX=true`/`GEMINI_SANDBOX=true` 또는 `--sandbox` 인자 시 어댑터/코어는 즉시 무출력 종료(격리 환경 데몬 hang 방지).

## 백엔드

`backend/`의 qmd MCP HTTP 데몬(8483) + keepalive + logrotate를 launchd로 상시 운영. install이 `@@HOME@@`를 실제 홈으로 치환해 `~/Library/LaunchAgents`에 배치한다.

편집 후 자동 인덱싱: PostToolUse 훅이 편집 파일을 dirty 큐에 쌓으면, launchd worker(60초 주기)가 백그라운드에서 해당 컬렉션만 `qmd add`+`embed`해 자동으로 최신 상태를 유지한다(macOS 전용).

## 테스트

```bash
npm test    # node --test, 결정적 단위/회귀 테스트
QMD_LIVE=1 node --test test/integration.test.mjs   # 데몬 라이브 스모크
```

데몬 응답은 `test/fixtures/`로 주입(`QMD_QUERY_FIXTURE`)해 라이브 의존 없이 결정적으로 검증한다.
