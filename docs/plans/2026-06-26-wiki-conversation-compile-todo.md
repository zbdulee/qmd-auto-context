# Wiki Conversation Compile TODO

- 날짜: 2026-06-26
- 상태: TODO / future milestone. 최신 자동화 설계는 `docs/superpowers/specs/2026-06-26-auto-wiki-compile-automation.md` 참고.
- 배경: `.auto-context/wiki/` promotion layer는 raw/source 문서뿐 아니라 세션 대화에서 나온 안정적 결론도 장기 지식 후보로 삼을 수 있다. 단, 대화 전문을 저장하거나 매 세션 요약을 무조건 승격하지 않는다.

## 답변 요약

wiki compile은 사용자 대화 내용을 입력 후보로 참고할 수 있다. wiki에 저장되는 것은 대화 원문이나 전체 세션 요약이 아니라 정제된 장기 지식이다. 최신 방향은 “자동 생성하되 plain markdown으로 두어 사용자가 직접 수정/삭제할 수 있게 하고, 자동 생성 page는 `status: generated`로 표시한다”이다.

## 원칙

1. 대화는 wiki의 입력 후보일 뿐, 저장 단위가 아니다.
2. wiki에는 대화 원문이 아니라 재사용 가능한 장기 지식만 저장한다.
3. 사용자 승인, 반복 등장, cross-file 영향, 다음 세션 재사용 가능성이 generated page 작성 기준이다.
   `canon` 승격은 직접적인 현재 사용자 승인/검토 신호가 있을 때만 가능하다.
4. secret, credential, 일회성 진행 상태, 실패한 임시 가설, 커밋 SHA/PR 번호 같은 stale artifact는 저장하지 않는다.
5. compile은 자동 wiki page 생성을 허용하되 기본 상태는 `generated`이며, `canon` 승격은 lint/review 또는 사용자 승인 신호를 요구한다.
6. query-time hook은 compile/promotion을 수행하지 않고, writer 동작은 명시적 command 또는 review gate 뒤에만 둔다.

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
- [ ] 후보 필드: `type`, `title`, `summary`, `sources`, `confidence`, `trigger`, `created`, `redactions`, `suggestedStatus`, `targetPath`, `action`, `lint`
- [ ] 후보 trigger enum: `explicit_user_approval`, `post_session_summary`, `repeated_recall`, `cross_file_conclusion`, `manual`
- [ ] local-only 권장 파일과 commit 가능 파일 경계 문서화

### 2. Candidate extraction

- [ ] 세션 대화에서 promotion 후보만 추출하는 automatic compact-context extractor 설계
- [ ] `compile.enabled`인 프로젝트에서는 자동 후보화/자동 generated wiki 작성을 허용하되 query-time hook은 read-only 유지
- [ ] pending/unconfigured/risky/sandbox/headless 프로젝트에서는 writer가 no-op 또는 hard reject 되도록 opt-in gate precondition 추가
- [ ] secret/token 패턴 redaction 선행
- [ ] raw transcript 저장 금지 테스트 추가
- [ ] 사용자 발화와 agent 답변을 그대로 저장하지 않고, 후보 `summary`와 `trigger`만 저장하는 extractor 테스트 추가

### 3. Lint / review / editable markdown gate

- [ ] 후보 lint 규칙 추가: secret, 일회성 artifact, stale status, transcript-like content reject
- [ ] 사람이 검토할 수 있도록 findings/queue 출력
- [ ] 자동 생성 wiki markdown에는 `status: generated`, `reviewed:false`, auto-generated banner를 붙인다
- [ ] 사용자 승인 없이 `status: canon`으로 승격하지 않는 기본 정책 유지

### 4. Promotion writer

- [ ] candidate → `wiki/decisions|concepts|entities` markdown 변환
- [ ] frontmatter schema 적용: `title`, `created`, `updated`, `type`, `status`, `sources`, `confidence`, `reviewed`, `createdBy`, `triggers`, `redactions`; `tags`는 optional legacy compatibility로만 둔다
- [ ] 기존 page update는 `qmd:auto:start/end` managed section + `sourceHash` 일치 시에만 수행하고, 사용자 편집 충돌 시 candidate/finding으로 남긴다
- [ ] `.auto-context/compile/generated-manifest.jsonl`을 생성 source of truth로 유지한다
- [ ] 사용자가 generated/reviewed page를 삭제하면 `.auto-context/compile/tombstones.jsonl`에 tombstone을 남기고 같은 `targetPath`/`sourceHash` 자동 재생성을 막는다
- [ ] 사용자가 canon page를 삭제하면 자동 복원/삭제 처리하지 않고 `contested` candidate/finding으로 명시 확인을 요청한다
- [ ] `wiki/index.md` catalog 갱신
- [ ] `wiki/log.md` append-only maintenance log 갱신

### 5. Recall integration

- [ ] `collectionRoles`가 `wiki`인 collection을 먼저 조회
- [ ] wiki 결과가 없거나 낮거나 검증 요청이면 raw backfill
- [ ] conversation-derived wiki page도 source/status tier(`[wiki:generated]`, `[wiki:canon]` 등)로 명시
- [ ] `generated/tentative`는 낮은 우선순위로 recall하되 unreviewed 상태를 모델 컨텍스트에 명시하고, `discarded/contested`는 기본 제외한다
- [ ] raw와 wiki가 같은 내용을 중복 주입하지 않도록 dedupe/priority 정책 추가
- [ ] qmd URI는 `collection -> collectionPaths[collection] -> projectRoot` 순서로 실제 wiki path를 resolve하고 `wikiPath` 밖이면 low-priority generated로 취급한다

## Acceptance criteria

- [ ] 대화 전문이 `.auto-context/wiki/**` 또는 `.auto-context/compile/**`에 저장되지 않는다.
- [ ] secret-like content가 후보/승격 파일에 남지 않는다.
- [ ] invalid/unsafe `.auto-context` 경로에서는 compile/promotion writer가 중단된다.
- [ ] pending/unconfigured/sandbox/headless 프로젝트에서는 compile writer가 wiki/compile 파일을 쓰지 않는다.
- [ ] deleted generated page는 명시 regenerate 전까지 자동 재생성되지 않는다.
- [ ] promotion 전후 `npm test`가 통과한다.
- [ ] wiki page는 사람이 읽고 수정 가능한 plain markdown이다.
