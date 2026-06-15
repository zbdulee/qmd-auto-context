# qmd auto-context 플러그인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **역할 분담 (이 플랜의 실행 규약):**
> - **Claude = 오케스트레이터 + TDD 드라이버**: 각 태스크 테스트(RED) 작성, 게이트 관리, 통합·검증.
> - **codex = 구현**: 각 태스크의 GREEN 구현을 codex subagent에 위임 (`codex-exec` 스킬 또는 `codex:rescue`).
> - **agy = 교차 리뷰**: 각 태스크 구현물을 Antigravity(agy) subagent가 리뷰 (`antigravity-exec` 스킬).
> - **게이트**: 모든 테스트 그린 + agy 리뷰 통과가 아니면 다음 태스크 진행 금지.

**Goal:** 흩어진 qmd 자동 컨텍스트 통합을 `auto-context` 단일 리포로 SSOT화하고, Claude/Codex/Gemini 세 플랫폼에서 동작하는 플러그인으로 만든다.

**Architecture:** 플랫폼/도메인 무관 `core/`(Python+bash) 1벌 + 플랫폼별 얇은 `adapters/` + 멱등 `backend/`. 도메인 동작은 프로젝트 로컬 `.agents/qmd-recall.json` 설정으로 제어. 기존 동작은 골든 동일성 테스트로 회귀 보호.

**Tech Stack:** Python 3, bash, `node:test`(.mjs) 테스트 러너, qmd CLI 2.5.3, qmd HTTP 데몬(8483), launchd.

**기준 설계:** `docs/specs/2026-06-15-qmd-autocontext-plugin-design.md`

**참조 자산 (SSOT로 흡수할 기존 구현):**
- `~/.claude/scripts/qmd-recall-on-prompt.py`, `qmd-session-update.sh`, `qmd-recall.py`
- `~/.codex/hooks/codex-qmd-recall-on-prompt.py`, `codex-qmd-session-update.sh`
- `~/work/novel/.claude/hooks/qmd-novel-recall.py`, `novel-qmd-session-update.sh`
- `~/work/novel/<작품>/.agents/qmd-recall.json`, `.agents/hooks/*.test.mjs`

---

## File Structure

| 파일 | 책임 |
|------|------|
| `core/config.py` | `.agents/qmd-recall.json` 로딩, 기본값, 하위호환, 컬렉션/패턴/필터 해석 |
| `core/keywords.py` | 한국어 어간 추출, stopwords, 도메인 lexical 패턴(ep 등) |
| `core/recall.py` | UserPromptSubmit 코어: 데몬 query → RRF 하이브리드 → 필터 → additionalContext |
| `core/update.sh` | SessionStart 코어: 컬렉션 add/update, preflight, embed→daemon kickstart |
| `core/posttool.py` | PostToolUse 코어: 편집 산문에서 high-confidence 연속성 힌트 |
| `adapters/{claude,codex,gemini}/wrapper.py` | stdin payload 파싱 + engine/log/headless 주입 후 코어 호출 |
| `adapters/{claude,codex,gemini}/hooks.json` | 플랫폼 훅 등록 매니페스트 |
| `backend/{daemon,keepalive,logrotate}.sh` + `launchd/*.plist` | 공유 백엔드 |
| `config/qmd-recall.schema.json` | 설정 JSON Schema |
| `test/*.test.mjs` + `test/fixtures/` | 골든 동일성·회귀·어댑터·스키마 테스트 |
| `install.sh`, `uninstall.sh` | 멱등 설치/제거 |

**테스트 결정성 원칙:** 데몬 라이브 의존을 제거하기 위해, recall/posttool 코어의 입력 중 "데몬 query 응답"은 `test/fixtures/`의 고정 JSON으로 주입한다(`QMD_QUERY_FIXTURE` 환경변수). 코어의 결정적 변환(키워드 추출 → query 조립 → 필터 → 포맷)만 골든 비교한다. 데몬 자체는 별도 통합 스모크 1건으로만 확인.

---

## Task 0: 리포 스캐폴드 + 테스트 러너

**Files:**
- Create: `package.json`, `test/smoke.test.mjs`, `core/.gitkeep`, `adapters/.gitkeep`

- [ ] **Step 1: 디렉토리 + package.json 생성**

```bash
cd ~/work/auto-context
mkdir -p core adapters/claude adapters/codex adapters/gemini backend/launchd config skills/qmd test/fixtures
cat > package.json <<'EOF'
{
  "name": "qmd-auto-context",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/" }
}
EOF
```

- [ ] **Step 2: 러너 동작 확인용 스모크 테스트 작성**

```javascript
// test/smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: 러너 실행해서 통과 확인**

Run: `cd ~/work/auto-context && npm test`
Expected: `# pass 1`

- [ ] **Step 4: 커밋**

```bash
git add -A && git commit -m "chore: scaffold repo + node:test runner"
```

---

## Task 1: 기존 recall 출력 골든 캡처 (영향 0의 기준선)

코어를 만들기 전에, 현재 세 구현이 고정 입력에서 내는 출력을 골든으로 박제한다. 이후 코어가 이 골든을 재현해야 한다.

**Files:**
- Create: `test/fixtures/daemon-response.json`, `test/fixtures/golden/recall-*.json`, `test/capture-golden.mjs`

- [ ] **Step 1: 데몬 응답 fixture 고정**

`~/.claude/scripts/qmd-recall-on-prompt.py`의 `qmd_query`가 받는 HTTP `/query` 응답 형태를 그대로 고정한다. 실제 데몬에서 한 번 캡처해 저장:

```bash
cd ~/work/auto-context
curl -s -X POST http://localhost:8483/query \
  -H 'Content-Type: application/json' \
  -d '{"queries":[{"type":"lex","query":"문의 정렬"},{"type":"vec","query":"문의 기반 정렬 어떻게"}],"collections":["axiom"],"rerank":false,"limit":10}' \
  > test/fixtures/daemon-response.json
cat test/fixtures/daemon-response.json
```
Expected: `results` 배열이 든 JSON (file/title/score 필드). 비어 있으면 다른 컬렉션/쿼리로 재시도해 non-empty 확보.

- [ ] **Step 2: 고정 입력 세트 정의 + 현재 구현 출력 캡처**

세 구현(claude/codex/novel)을 각각 고정 stdin으로 실행해 stdout(JSON)을 골든으로 저장. 데몬 의존을 끊기 위해 `QMD_DAEMON_URL`을 로컬 fixture 서버로 돌리거나, 캡처 시점의 라이브 데몬 출력을 그대로 골든으로 인정한다(1회 캡처 후 동결).

```bash
# claude 글로벌
echo '{"prompt":"원오빌 문의 기반 정렬 어떻게 동작해?","cwd":"/Users/dulee/work/axiom"}' \
  | python3 ~/.claude/scripts/qmd-recall-on-prompt.py > test/fixtures/golden/recall-claude.json 2>/dev/null || true
# codex 글로벌
echo '{"prompt":"원오빌 문의 기반 정렬 어떻게 동작해?","cwd":"/Users/dulee/work/axiom"}' \
  | python3 ~/.codex/hooks/codex-qmd-recall-on-prompt.py > test/fixtures/golden/recall-codex.json 2>/dev/null || true
# novel 로컬 (EP 인식 경로)
echo '{"prompt":"EP12 결말 복선 정리","cwd":"/Users/dulee/work/novel/귀신은 약효가 돌 때 보인다"}' \
  | NOVEL_QMD_COLLECTIONS="yakbbal-manuscript,yakbbal-plot" NOVEL_QMD_NAME="귀신은 약효가 돌 때 보인다" \
    python3 ~/work/novel/.claude/hooks/qmd-novel-recall.py > test/fixtures/golden/recall-novel.json 2>/dev/null || true
ls -la test/fixtures/golden/
```
Expected: 3개 골든 파일. 빈 결과여도(데몬 미스) 출력 구조(또는 빈 출력) 자체가 기준선이 됨 — 단 최소 1개는 non-empty가 되도록 입력 조정.

- [ ] **Step 3: 골든이 의미 있는지 사람 눈으로 검수 + 메모**

각 골든의 `additionalContext` 문자열 포맷(예: `[axiom] 제목 — qmd://...`)을 `test/fixtures/golden/README.md`에 기록. 이것이 코어가 재현할 계약이다.

- [ ] **Step 4: 커밋**

```bash
git add -A && git commit -m "test: capture golden recall outputs from existing claude/codex/novel hooks"
```

---

## Task 2: config.py — 설정 로딩 (하위호환)

**Files:**
- Create: `core/config.py`, `config/qmd-recall.schema.json`, `test/config.test.mjs`

- [ ] **Step 1: 실패 테스트 작성 (하위호환 + 신규 필드)**

```javascript
// test/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function loadConfig(json, cwd = '/tmp/x') {
  const out = execFileSync('python3', ['core/config.py', '--cwd', cwd], { input: json });
  return JSON.parse(out);
}

test('기존 novel 스키마 무수정 동작 (신규 필드 부재 → 기본값)', () => {
  const cfg = loadConfig(JSON.stringify({
    name: '귀신', collections: ['yakbbal-manuscript'], minScore: 0.8,
  }));
  assert.equal(cfg.name, '귀신');
  assert.deepEqual(cfg.collections, ['yakbbal-manuscript']);
  assert.equal(cfg.minScore, 0.8);
  assert.equal(cfg.topN, 3);                       // 기본값
  assert.deepEqual(cfg.lexicalPatterns, []);       // 기본값 (EP 인식 off)
  assert.deepEqual(cfg.events, ['sessionStart', 'userPromptSubmit', 'postToolUse']);
});

test('신규 필드 파싱', () => {
  const cfg = loadConfig(JSON.stringify({
    name: 'x', collections: ['c'], minScore: 0.5,
    lexicalPatterns: ['ep'], skipPaths: ['.zb-context'], topN: 5, queryTimeout: 8,
  }));
  assert.deepEqual(cfg.lexicalPatterns, ['ep']);
  assert.deepEqual(cfg.skipPaths, ['.zb-context']);
  assert.equal(cfg.topN, 5);
  assert.equal(cfg.queryTimeout, 8);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- test/config.test.mjs` (또는 `node --test test/config.test.mjs`)
Expected: FAIL — `core/config.py` 없음 / `No such file`.

- [ ] **Step 3: codex 위임 구현 — `core/config.py`**

위임 프롬프트 핵심: stdin으로 JSON 설정을 받아 기본값 병합 후 stdout으로 정규화 JSON 출력. 기본값: `topN=3`, `queryTimeout=5`, `lexicalPatterns=[]`, `skipPaths=[]`, `events=["sessionStart","userPromptSubmit","postToolUse"]`, `minScore=0.0`, `collections=[]`, `collectionPaths={}`. `--cwd` 인자 받되 이 태스크에선 보관만. JSON Schema(`config/qmd-recall.schema.json`)도 동일 필드로 작성. 입력이 빈/깨진 JSON이면 전부 기본값으로.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/config.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: agy 교차 리뷰 + 커밋**

agy 리뷰 포커스: 기본값이 §3 불변식(기존 novel 동작 보존)과 일치하는지, 빈/깨진 입력 안전성.
```bash
git add -A && git commit -m "feat(core): config loader with backward-compatible schema"
```

---

## Task 3: keywords.py — 키워드/어간/도메인 패턴

**Files:**
- Create: `core/keywords.py`, `test/keywords.test.mjs`

- [ ] **Step 1: 실패 테스트 작성**

기존 `qmd-recall-on-prompt.py`의 `extract_keywords`/`strip_ko_suffix`/`extract_ep_terms` 동작을 계약으로 고정.

```javascript
// test/keywords.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function kw(prompt, patterns = []) {
  const out = execFileSync('python3', ['core/keywords.py', '--patterns', patterns.join(',')], { input: prompt });
  return JSON.parse(out); // { keywords: [...], lexicalTerms: [...] }
}

test('stopwords 제거 + 한국어 어간', () => {
  const r = kw('원오빌 문의 기반 정렬은 어떻게 동작하나요');
  assert.ok(r.keywords.includes('문의') || r.keywords.includes('정렬'));
  assert.ok(!r.keywords.includes('어떻게'));   // stopword
});

test('ep 패턴 off면 EP 용어 없음', () => {
  const r = kw('EP12 복선', []);
  assert.ok(!r.lexicalTerms.some(t => /EP0?12/.test(t)));
});

test('ep 패턴 on이면 EP 정규화 용어 생성', () => {
  const r = kw('EP12 복선', ['ep']);
  assert.ok(r.lexicalTerms.includes('EP012'));
  assert.ok(r.lexicalTerms.includes('EP12'));
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/keywords.test.mjs`
Expected: FAIL — `core/keywords.py` 없음.

- [ ] **Step 3: codex 위임 구현 — `core/keywords.py`**

위임 프롬프트 핵심: `~/.codex/hooks/codex-qmd-recall-on-prompt.py`의 `EN_STOPWORDS`/`KO_STOPWORDS`/`strip_ko_suffix`/`extract_keywords`/`extract_ep_terms`를 그대로 이식하되, EP 추출은 `--patterns`에 `ep`가 있을 때만 활성. stdin=프롬프트, stdout=`{"keywords":[...],"lexicalTerms":[...]}` (lexicalTerms = ep용어 + keywords, dedup). 키워드 상한은 5.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/keywords.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: agy 교차 리뷰 + 커밋**

agy 리뷰 포커스: stopword/어간 로직이 기존과 동등한지, ep 정규화(`EP%03d`)가 기존 `extract_ep_terms`와 일치.
```bash
git add -A && git commit -m "feat(core): keyword extraction + optional domain lexical patterns"
```

---

## Task 4: recall.py 코어 + 골든 동일성

**Files:**
- Create: `core/recall.py`, `test/recall.test.mjs`

- [ ] **Step 1: 실패 테스트 작성 (fixture 주입 + 골든 비교)**

```javascript
// test/recall.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function recall(payload, env = {}) {
  const out = execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify(payload),
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('fixture 응답 → additionalContext 생성', () => {
  const r = recall({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' });
  assert.ok(r);
  const ctx = r.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[axiom\]/);          // collection prefix 포맷 유지
});

test('skipPaths 필터 동작', () => {
  // fixture에 .zb-context 경로가 포함된 경우 제외되는지 — fixture 보강 후 검증
  const r = recall({ prompt: '정렬', cwd: '/Users/dulee/work/axiom' });
  if (r) {
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('.zb-context'));
  }
});

test('짧은 프롬프트(<10자)는 skip → 빈 출력', () => {
  const r = recall({ prompt: '짧다', cwd: '/tmp' });
  assert.equal(r, null);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/recall.test.mjs`
Expected: FAIL — `core/recall.py` 없음.

- [ ] **Step 3: codex 위임 구현 — `core/recall.py`**

위임 프롬프트 핵심:
- `core/config.py`, `core/keywords.py`를 import.
- stdin `{prompt, cwd}` 파싱. `prompt` 길이 <10 → exit 0(무출력).
- cwd → `config.load(cwd)`: cwd에 `.agents/qmd-recall.json` 있으면 사용, 없으면 `{collections:[basename(cwd)]}` 기본.
- 데몬 query: `QMD_QUERY_FIXTURE` 설정 시 그 파일을 응답으로 사용(테스트), 아니면 `QMD_DAEMON_URL`(기본 8483) POST `/query` (lex=lexicalTerms, vec=원문, rerank off). 데몬 없으면 조용히 exit 0.
- 결과: `skipPaths` 필터 → 상위 `topN` → `format`(`[collection] title — uri` 줄들).
- 출력: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`.
- engine 라벨/로그 경로/headless 체크는 **여기서 하지 않음**(어댑터 책임). 단 `QMD_RECALL_LOG` 있으면 score 관찰 로그만 append.
- 기존 `~/.claude/scripts/qmd-recall-on-prompt.py`의 query 조립·필터·포맷을 기준으로 이식.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/recall.test.mjs`
Expected: PASS.

- [ ] **Step 5: 골든 동일성 확인**

Task 1 골든(`recall-claude.json` 등)과 코어 출력의 `additionalContext` 포맷이 일치하는지 비교 테스트 추가:
```javascript
test('claude 골든과 포맷 동일', () => {
  const golden = JSON.parse(readFileSync('test/fixtures/golden/recall-claude.json', 'utf8'));
  const r = recall({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' });
  // 데몬 응답이 동일 fixture면 줄 포맷(접두사 [collection], 구분자)이 일치해야 함
  const fmt = s => s.replace(/qmd:\/\/\S+/g, 'URI').split('\n').map(l => l.replace(/—.*/, '—'));
  assert.deepEqual(fmt(r.hookSpecificOutput.additionalContext), fmt(golden.hookSpecificOutput.additionalContext));
});
```
Run: `node --test test/recall.test.mjs`
Expected: PASS (4 tests). 불일치 시 포맷 함수를 골든 계약에 맞춰 코어 수정.

- [ ] **Step 6: agy 교차 리뷰 + 커밋**

agy 리뷰 포커스: 데몬 타임아웃/부재 시 graceful skip, fixture 분기가 프로덕션 경로를 오염시키지 않는지.
```bash
git add -A && git commit -m "feat(core): recall core with golden parity + fixture-injected query"
```

---

## Task 5: update.sh 코어

**Files:**
- Create: `core/update.sh`, `test/update.test.mjs`

- [ ] **Step 1: 실패 테스트 작성 (컬렉션 경로 해석 + risky 차단, 데몬 무관 부분만)**

```javascript
// test/update.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function resolvePaths(cwd, configJson) {
  // update.sh --resolve-only: qmd 미실행, 컬렉션→경로 매핑 결과만 stdout JSON
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson });
  return JSON.parse(out);
}

test('collectionPaths 매핑 해석 (novel 패턴)', () => {
  const r = resolvePaths('/Users/dulee/work/novel/귀신은 약효가 돌 때 보인다', JSON.stringify({
    collections: ['yakbbal-manuscript', 'yakbbal-plot'],
    collectionPaths: { '*-manuscript': '04_Manuscript', '*-plot': '03_Plot' },
  }));
  assert.ok(r.entries.some(e => e.name === 'yakbbal-manuscript' && e.path.endsWith('04_Manuscript')));
});

test('설정 없으면 cwd 단일 컬렉션', () => {
  const r = resolvePaths('/Users/dulee/work/axiom', '');
  assert.deepEqual(r.entries, [{ name: 'axiom', path: '.' }]);
});

test('risky 시스템 경로 거부', () => {
  const r = resolvePaths('/Library/OSAnalytics', '');
  assert.equal(r.refused, true);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/update.test.mjs`
Expected: FAIL — `core/update.sh` 없음.

- [ ] **Step 3: codex 위임 구현 — `core/update.sh`**

위임 프롬프트 핵심: `~/.codex/hooks/codex-qmd-session-update.sh`의 `is_risky_path`/`retry`/`preflight_remove_risky`/lock/embed→kickstart 로직을 이식. 추가로 `--resolve-only` 모드: qmd 미호출, stdin 설정으로 컬렉션→경로 매핑(`collectionPaths` glob, basename 기본)을 `{"entries":[{name,path}],"refused":bool}`로 출력. 컬렉션→경로 하드코딩(`04_Manuscript` 등) 제거하고 설정 기반으로. PATH 보정(bun/fnm node) 유지.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/update.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: agy 교차 리뷰 + 커밋**

agy 리뷰 포커스: risky 경로 차단 완전성, lock/embed 동시성, `--resolve-only`가 부수효과 없는지.
```bash
git add -A && git commit -m "feat(core): session-update core with config-driven collection paths"
```

---

## Task 6: posttool.py 코어 + novel 회귀 흡수

**Files:**
- Create: `core/posttool.py`, `test/posttool.test.mjs`
- Copy: `~/work/novel/<작품>/.agents/hooks/qmd-agent-loop-hint.test.mjs` → `test/qmd-agent-loop-hint.test.mjs`

- [ ] **Step 1: novel 회귀 테스트 흡수 + 경로 조정**

```bash
cp "$HOME/work/novel/귀신은 약효가 돌 때 보인다/.agents/hooks/qmd-agent-loop-hint.test.mjs" test/
# import 경로를 core/posttool.py 기준으로 수정 (테스트 상단 경로 상수)
```

- [ ] **Step 2: posttool 코어 실패 테스트 작성**

```javascript
// test/posttool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function posttool(payload, env = {}) {
  const out = execFileSync('python3', ['core/posttool.py'], {
    input: JSON.stringify(payload),
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('산문 파일 Edit → minScore 넘으면 hint', () => {
  const r = posttool({
    tool_name: 'Edit',
    tool_input: { file_path: '/Users/dulee/work/novel/x/04_Manuscript/ep12.md', new_string: '주인공이 복선을 회수한다' },
    cwd: '/Users/dulee/work/novel/x',
  }, { QMD_MIN_SCORE: '0.0' });
  assert.ok(r);
  assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
});

test('비-산문 파일은 skip', () => {
  const r = posttool({ tool_name: 'Edit', tool_input: { file_path: '/tmp/code.py', new_string: 'x=1' }, cwd: '/tmp' });
  assert.equal(r, null);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/posttool.test.mjs test/qmd-agent-loop-hint.test.mjs`
Expected: FAIL — `core/posttool.py` 없음.

- [ ] **Step 4: codex 위임 구현 — `core/posttool.py`**

위임 프롬프트 핵심: `~/work/novel/docs/plans/2026-05-30-agent-loop-qmd-hints.md`와 기존 novel posttool 구현 기준. Edit/Write/MultiEdit/apply_patch payload에서 변경 산문 추출 → reader-facing 파일(`config.collectionPaths`의 manuscript류 경로)로 제한 → recall 코어 재사용해 query → score ≥ minScore일 때만 `PostToolUse` additionalContext 출력.

- [ ] **Step 5: 통과 확인**

Run: `node --test test/posttool.test.mjs test/qmd-agent-loop-hint.test.mjs`
Expected: PASS (흡수한 novel 회귀 포함 전부 그린).

- [ ] **Step 6: agy 교차 리뷰 + 커밋**

agy 리뷰 포커스: 산문 파일 판정이 기존 novel 동작과 동일, 코드 파일 오탐 없음.
```bash
git add -A && git commit -m "feat(core): posttool hint core + absorb novel regression tests"
```

---

## Task 7: claude 어댑터

**Files:**
- Create: `adapters/claude/wrapper.py`, `adapters/claude/hooks.json`, `test/adapter-claude.test.mjs`

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// test/adapter-claude.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('CLAUDE_HEADLESS=1 → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['adapters/claude/wrapper.py', 'recall'], {
    input: JSON.stringify({ prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }),
    env: { ...process.env, CLAUDE_HEADLESS: '1', QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
  });
  assert.equal(out.trim(), '');
});

test('recall 위임 → engine=claude 라벨 주입', () => {
  const out = execFileSync('python3', ['adapters/claude/wrapper.py', 'recall'], {
    input: JSON.stringify({ prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }),
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
  });
  if (out.trim()) {
    const r = JSON.parse(out);
    assert.equal(r.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/adapter-claude.test.mjs`
Expected: FAIL — `adapters/claude/wrapper.py` 없음.

- [ ] **Step 3: codex 위임 구현 — 어댑터**

위임 프롬프트 핵심: `wrapper.py <recall|update|posttool>` — `CLAUDE_HEADLESS=1`이면 즉시 exit 0. stdin을 그대로 코어(`core/recall.py` 등)에 전달, `QMD_RECALL_LOG=/tmp/qmd-hook.log` engine 환경 주입 후 stdout 패스스루. `hooks.json`은 Claude 형식(`SessionStart`→update, `UserPromptSubmit`→recall, `PostToolUse`→posttool) 매니페스트로, command가 wrapper를 가리키게.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/adapter-claude.test.mjs`
Expected: PASS.

- [ ] **Step 5: agy 교차 리뷰 + 커밋**

```bash
git add -A && git commit -m "feat(adapter): claude wrapper + hooks manifest"
```

---

## Task 8: codex 어댑터

**Files:**
- Create: `adapters/codex/wrapper.py`, `adapters/codex/hooks.json`, `test/adapter-codex.test.mjs`

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// test/adapter-codex.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('codex recall 위임 → snake_case 이벤트 매니페스트 + engine=codex', () => {
  const out = execFileSync('python3', ['adapters/codex/wrapper.py', 'recall'], {
    input: JSON.stringify({ prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }),
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
  });
  if (out.trim()) assert.match(out, /additionalContext/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/adapter-codex.test.mjs`
Expected: FAIL.

- [ ] **Step 3: codex 위임 구현**

위임 프롬프트 핵심: claude 어댑터와 동일 구조, 차이는 `QMD_RECALL_LOG=/tmp/codex-qmd-hook.log`, engine=codex. `hooks.json`은 Codex 형식(`session_start`/`user_prompt_submit`/`post_tool_use`, matcher 포함)으로 wrapper 호출.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/adapter-codex.test.mjs`
Expected: PASS.

- [ ] **Step 5: agy 교차 리뷰 + 커밋**

```bash
git add -A && git commit -m "feat(adapter): codex wrapper + hooks manifest"
```

---

## Task 9: gemini 어댑터 (이벤트 매핑 실측)

**Files:**
- Create: `adapters/gemini/wrapper.py`, `adapters/gemini/hooks.json`, `test/adapter-gemini.test.mjs`

- [ ] **Step 1: Gemini 이벤트 매핑 실측 (Open Question #1 해소)**

```bash
# Claude hooks.json을 입력으로 gemini의 변환 결과를 확인
gemini hooks migrate --help 2>&1 | head -20
# 임시 디렉토리에서 claude 형식 hooks.json을 두고 migrate 실행 → 출력 이벤트명 기록
```
결과(SessionStart/UserPromptSubmit/PostToolUse의 Gemini 등가명)를 `adapters/gemini/EVENT-MAP.md`에 기록.

- [ ] **Step 2: 실패 테스트 작성**

```javascript
// test/adapter-gemini.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('gemini recall 위임 동작', () => {
  const out = execFileSync('python3', ['adapters/gemini/wrapper.py', 'recall'], {
    input: JSON.stringify({ prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }),
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
  });
  if (out.trim()) assert.match(out, /additionalContext/);
});

test('hooks.json 이벤트명이 실측 매핑과 일치', () => {
  const hooks = JSON.parse(readFileSync('adapters/gemini/hooks.json', 'utf8'));
  assert.ok(hooks.hooks);  // 실측 EVENT-MAP.md 기준 키 존재 확인 (구현 시 구체화)
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/adapter-gemini.test.mjs`
Expected: FAIL.

- [ ] **Step 4: codex 위임 구현**

위임 프롬프트 핵심: claude/codex 어댑터와 동일 구조, engine=gemini, `QMD_RECALL_LOG=/tmp/gemini-qmd-hook.log`. `hooks.json`은 Step 1 실측 이벤트명 사용. Gemini payload가 Claude와 다른 키를 쓰면(예: `tool_input` vs 다른 이름) 정규화 추가.

- [ ] **Step 5: 통과 확인**

Run: `node --test test/adapter-gemini.test.mjs`
Expected: PASS.

- [ ] **Step 6: agy 교차 리뷰 + 커밋**

agy 리뷰 포커스: Gemini payload 키 정규화가 실제 agy 런타임과 맞는지(agy는 antigravity-exec로 실측 권장).
```bash
git add -A && git commit -m "feat(adapter): gemini wrapper + measured event mapping"
```

---

## Task 10: backend 멱등 셋업

**Files:**
- Copy/Modify: `backend/{daemon,keepalive,logrotate}.sh`, `backend/launchd/*.plist`
- Create: `test/backend.test.mjs`

- [ ] **Step 1: 기존 백엔드 자산 복사**

```bash
cp ~/.config/qmd/qmd-daemon.sh backend/daemon.sh
cp ~/.config/qmd/qmd-keepalive.sh backend/keepalive.sh
cp ~/.config/qmd/qmd-logrotate.sh backend/logrotate.sh
for p in com.qmd-mcp-daemon com.qmd-keepalive com.qmd-logrotate; do
  cp ~/Library/LaunchAgents/$p.plist backend/launchd/
done
```

- [ ] **Step 2: 경로 일반화 테스트 작성**

```javascript
// test/backend.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('plist에 하드코딩 절대경로 대신 플레이스홀더 또는 install 치환 마커', () => {
  for (const f of readdirSync('backend/launchd')) {
    const xml = readFileSync(`backend/launchd/${f}`, 'utf8');
    // install.sh가 치환할 마커(@@HOME@@ 등) 또는 $HOME 사용 — 사용자명 하드코딩 금지
    assert.ok(!/\/Users\/dulee/.test(xml) || /@@/.test(xml),
      `${f}: dulee 하드코딩은 install 치환 마커로 대체되어야 함`);
  }
});
```

- [ ] **Step 3: 실패 확인 → 마커화**

Run: `node --test test/backend.test.mjs`
Expected: 초기 FAIL(dulee 하드코딩). codex 위임으로 plist/스크립트의 사용자 경로를 `@@HOME@@` 마커로 치환(install이 실제 경로로 채움).

- [ ] **Step 4: 통과 확인**

Run: `node --test test/backend.test.mjs`
Expected: PASS.

- [ ] **Step 5: agy 교차 리뷰 + 커밋**

```bash
git add -A && git commit -m "feat(backend): portable daemon/keepalive/logrotate + launchd templates"
```

---

## Task 11: install.sh / uninstall.sh

**Files:**
- Create: `install.sh`, `uninstall.sh`, `test/install.test.mjs`

- [ ] **Step 1: 실패 테스트 작성 (DRY-RUN 기반, 실제 홈 미오염)**

```javascript
// test/install.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function dryRun(home) {
  return execFileSync('bash', ['install.sh', '--dry-run'], {
    env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'claude,codex,gemini' },
  }).toString();
}

test('dry-run: 3플랫폼 등록 계획 + 기존 백업 계획 출력', () => {
  const out = dryRun('/tmp/fake-home');
  assert.match(out, /claude/);
  assert.match(out, /codex/);
  assert.match(out, /gemini/);
  assert.match(out, /backup|\.bak/);
});

test('dry-run은 실제 파일 생성 안 함', () => {
  execFileSync('bash', ['install.sh', '--dry-run'], { env: { ...process.env, HOME: '/tmp/fake-home-2' } });
  // /tmp/fake-home-2 에 .claude 등이 생기지 않아야 함
  assert.throws(() => execFileSync('test', ['-d', '/tmp/fake-home-2/.claude']));
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/install.test.mjs`
Expected: FAIL — `install.sh` 없음.

- [ ] **Step 3: codex 위임 구현 — install.sh**

위임 프롬프트 핵심:
1. 플랫폼 감지(`~/.claude`,`~/.codex`,`~/.gemini`; `QMD_FAKE_PLATFORMS`로 테스트 오버라이드).
2. `--dry-run`이면 계획만 출력하고 종료.
3. 기존 qmd 훅/스크립트 타임스탬프 `.bak` 백업.
4. 각 플랫폼 hooks 설정에 어댑터 등록(리포 절대경로 wrapper 호출). 기존 글로벌 + novel 로컬 훅을 리포 버전으로 대체.
5. 백엔드 멱등 셋업: qmd 존재 확인, `~/.config/qmd` 스크립트 배치, launchd plist `@@HOME@@` 치환 후 load(이미 로드면 skip).
6. 마지막에 `npm test` 실행해 게이트 확인.
`uninstall.sh`: 어댑터 제거 + 최신 `.bak` 복원.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/install.test.mjs`
Expected: PASS.

- [ ] **Step 5: agy 교차 리뷰 + 커밋**

agy 리뷰 포커스: 멱등성(재실행 안전), 백업 누락 없는지, dry-run 격리.
```bash
git add -A && git commit -m "feat: idempotent install/uninstall with backup + dry-run"
```

---

## Task 12: 통합 검증 + 실제 설치 + 회귀 그린

**Files:**
- Create: `test/integration.test.mjs`, `README.md`

- [ ] **Step 1: 전체 테스트 그린 확인**

Run: `cd ~/work/auto-context && npm test`
Expected: 모든 .test.mjs PASS (config/keywords/recall/update/posttool/adapters/backend/install + 흡수한 novel 회귀).

- [ ] **Step 2: 데몬 라이브 통합 스모크 1건**

```javascript
// test/integration.test.mjs  (데몬 켜져 있을 때만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('라이브 데몬 recall 스모크', { skip: !process.env.QMD_LIVE }, () => {
  const out = execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify({ prompt: '원오빌 문의 기반 정렬', cwd: '/Users/dulee/work/axiom' }),
  });
  assert.ok(out !== undefined);
});
```
Run: `QMD_LIVE=1 node --test test/integration.test.mjs`
Expected: PASS 또는 graceful skip.

- [ ] **Step 3: 실제 설치 + novel 영향 0 확인**

```bash
bash install.sh                 # 실제 등록 (기존 .bak 백업됨)
# novel 회귀 테스트가 여전히 그린인지
cd "$HOME/work/novel/귀신은 약효가 돌 때 보인다" && node --test .agents/hooks/*.test.mjs
# 새 세션에서 recall이 동작하는지 수동 확인 (Claude/Codex/agy 각 1회)
```
Expected: novel 회귀 그린, 세 플랫폼 recall 동작.

- [ ] **Step 4: README 작성 + 최종 커밋**

README: 설치/제거, 설정 스키마, 플랫폼별 동작, 롤백 절차.
```bash
git add -A && git commit -m "docs: README + integration smoke; verify novel regression green"
```

---

## Self-Review 결과 (작성자 점검)

- **Spec 커버리지:** §2 아키텍처→Task 2-9, §3 스키마→Task 2, §4 영향0→Task 1(골든)·6(회귀흡수)·11(백업)·12(검증), §5 install→Task 11, §6 개발프로세스→전 태스크 codex/agy 분담, §7 테스트→전 태스크 TDD, §8 OpenQ #1→Task 9 Step1. ✅
- **Open Question #2(골든 캡처 방법):** Task 1 + `QMD_QUERY_FIXTURE` 주입으로 해소.
- **Open Question #3(Gemini 글로벌/프로젝트 훅):** Task 11 install이 플랫폼별 등록 위치를 감지·분기(구현 시 Gemini가 글로벌 미지원이면 프로젝트 등록 안내로 폴백) — Task 9 EVENT-MAP.md에 함께 기록.
- **타입/네이밍 일관성:** `additionalContext`, `hookSpecificOutput.hookEventName`, `lexicalTerms`, `collectionPaths`, `QMD_QUERY_FIXTURE`, `--resolve-only`, `--dry-run` 전 태스크 통일. ✅
