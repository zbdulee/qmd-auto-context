# Wiki Conversation Compile TODO

- 날짜: 2026-06-26
- 상태: TODO / future milestone
- 배경: `.auto-context/wiki/` promotion layer는 raw/source 문서뿐 아니라 세션 대화에서 나온 안정적 결론도 장기 지식 후보로 삼을 수 있다. 단, 대화 전문을 저장하거나 매 세션 요약을 무조건 승격하지 않는다.

## 원칙

1. 대화는 wiki의 입력 후보일 뿐, 저장 단위가 아니다.
2. wiki에는 대화 원문이 아니라 재사용 가능한 장기 지식만 저장한다.
3. 사용자 승인, 반복 등장, cross-file 영향, 다음 세션 재사용 가능성이 promotion 기준이다.
4. secret, credential, 일회성 진행 상태, 실패한 임시 가설, 커밋 SHA/PR 번호 같은 stale artifact는 저장하지 않는다.
5. compile은 자동 초안 생성까지만 허용하고, promotion은 lint/review 또는 사용자 승인 후 수행한다.

## 저장 가능한 후보

- 아키텍처 결정: `wiki/decisions/`
- 반복적으로 쓰이는 개념/규칙: `wiki/concepts/`
- 모듈/도구/플랫폼 설명: `wiki/entities/`
- 세션에서 합의된 durable workflow: 필요 시 `wiki/sessions/` 또는 decision/concept로 재분류

## 저장하지 않을 것

- 전체 transcript
- 모든 세션 요약
- 일회성 TODO
- 임시 진행 상황
- 실패한 디버깅 로그 전체
- credential/secret/API key
- 일주일 안에 stale해질 issue/PR/commit/status 번호

## 구현 TODO

### 1. Candidate queue 설계

- [ ] `.auto-context/compile/candidates.jsonl` schema 정의
- [ ] 후보 필드: `type`, `title`, `summary`, `sources`, `confidence`, `reason`, `created`, `redactions`
- [ ] 후보 reason enum: `user_approved_decision`, `repeated_recall`, `cross_file_conclusion`, `manual_note`
- [ ] local-only 권장 파일과 commit 가능 파일 경계 문서화

### 2. Candidate extraction

- [ ] 세션 대화에서 promotion 후보만 추출하는 manual command 설계
- [ ] 자동 실행은 기본 off
- [ ] secret/token 패턴 redaction 선행
- [ ] raw transcript 저장 금지 테스트 추가

### 3. Lint / review gate

- [ ] 후보 lint 규칙 추가: secret, 일회성 artifact, stale status, transcript-like content reject
- [ ] 사람이 검토할 수 있도록 findings/queue 출력
- [ ] 사용자 승인 없이 wiki markdown으로 승격하지 않는 기본 정책 유지

### 4. Promotion writer

- [ ] candidate → `wiki/decisions|concepts|entities` markdown 변환
- [ ] frontmatter schema 적용: `title`, `created`, `updated`, `type`, `tags`, `sources`, `confidence`, `contested`
- [ ] `wiki/index.md` catalog 갱신
- [ ] `wiki/log.md` append-only maintenance log 갱신

### 5. Recall integration

- [ ] `collectionRoles`가 `wiki`인 collection을 먼저 조회
- [ ] wiki 결과가 없거나 낮거나 검증 요청이면 raw backfill
- [ ] conversation-derived wiki page도 source tier `[wiki]`로 명시
- [ ] raw와 wiki가 같은 내용을 중복 주입하지 않도록 dedupe/priority 정책 추가

## Acceptance criteria

- [ ] 대화 전문이 `.auto-context/wiki/**` 또는 `.auto-context/compile/**`에 저장되지 않는다.
- [ ] secret-like content가 후보/승격 파일에 남지 않는다.
- [ ] invalid/unsafe `.auto-context` 경로에서는 compile/promotion writer가 중단된다.
- [ ] promotion 전후 `npm test`가 통과한다.
- [ ] wiki page는 사람이 읽고 수정 가능한 plain markdown이다.
