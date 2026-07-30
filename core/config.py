#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
import sys
import tempfile
from pathlib import Path


CONFIG_DIR_NAME = ".auto-context"
SETTINGS_FILE_NAME = "settings.json"
LEGACY_CONFIG_FILE_NAME = ".auto-context.json"
LEGACY_AGENTS_DIR = ".agents"
LEGACY_AGENTS_FILE_NAME = "qmd-recall.json"
LOCAL_OPTOUT_DIR = Path(".config") / "qmd" / "optout"

# ---------------------------------------------------------------------------
# Collection roles (SSOT)
#
# 네 role은 **두 축의 조합**이다: qmd 인덱스에 등록되는가(=recall 대상), wiki compile의
# 입력이 되는가. `source`는 "compile 입력이지만 인덱싱·recall 대상 아님"을 표현하기 위해
# 도입됐다(로드맵 7단계) — raw를 인덱스에서 빼면서도 그 문서로 카드를 계속 만들기 위한
# 선행 작업이다.
#
#   role      | qmd 등록/인덱싱/recall | compile 입력 | hierarchical raw backfill
#   ----------|------------------------|--------------|--------------------------
#   raw       | O                      | O            | O
#   session   | O                      | O            | O
#   wiki      | O                      | X            | X (wiki phase에서 먼저 질의)
#   source    | X                      | O            | X
#
# 판정을 `roles.get(c) != "wiki"` 같은 **여집합**으로 쓰지 말 것. 세 번째 값이 들어오는
# 순간 그 지점 전부가 오분류한다. 아래 집합과 헬퍼(`collection_role` 외)를 쓴다.
COLLECTION_ROLE_RAW = "raw"
COLLECTION_ROLE_WIKI = "wiki"
COLLECTION_ROLE_SESSION = "session"
COLLECTION_ROLE_SOURCE = "source"
COLLECTION_ROLES = frozenset({
    COLLECTION_ROLE_RAW,
    COLLECTION_ROLE_WIKI,
    COLLECTION_ROLE_SESSION,
    COLLECTION_ROLE_SOURCE,
})
# role 미설정 = role 도입 전 동작(인덱싱 + compile 입력). 미지 값도 여기로 fail-open한다.
DEFAULT_COLLECTION_ROLE = COLLECTION_ROLE_RAW
# qmd `collection add`/`update`/`embed`, dirty queue, recall 질의 대상.
INDEXED_ROLES = frozenset({COLLECTION_ROLE_RAW, COLLECTION_ROLE_WIKI, COLLECTION_ROLE_SESSION})
# hierarchical raw backfill / flat recall의 non-wiki 대상(= 인덱싱되는 non-wiki).
RECALL_RAW_ROLES = frozenset({COLLECTION_ROLE_RAW, COLLECTION_ROLE_SESSION})
# wiki compile source가 될 수 있는 role.
COMPILE_SOURCE_ROLES = frozenset({
    COLLECTION_ROLE_RAW,
    COLLECTION_ROLE_SESSION,
    COLLECTION_ROLE_SOURCE,
})
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "name": "",
    "collections": [],
    "minScore": 0.0,
    "rawFallbackMinScore": 0.0,
    "topN": 3,
    "queryTimeout": 5,
    "staleQueueThreshold": 20,
    "lexicalPatterns": [],
    "skipPaths": [],
    "collectionPaths": {},
    "allowRoots": [],
    "prefixStyle": "full",
    # wiki 카드 본문(요약)을 recall 주입에 넣을 때의 카드 1장당 문자 상한. 0이면 본문
    # 주입을 끄고 예전처럼 경로+title만 넣는다. 기본값 근거는 docs/settings.md 참고.
    "injectSummaryMaxChars": 600,
    # wiki 카드의 원문 경로(`sources[].path`)를 카드 1장당 몇 개까지 주입할지. 0이면 끈다.
    # 기본값 근거는 docs/settings.md 참고(849장 전수: median 1 / p95 1 / max 4).
    "injectSourcePathsPerCard": 3,
    "events": ["sessionStart", "userPromptSubmit", "postToolUse"],
    "indexing": None,
    "collectionRoles": {},
    "recallStrategy": "hierarchical",
    "wikiPath": ".auto-context/wiki",
    "compile": {
        "enabled": False,
        "mode": "off",
        "autoWrite": False,
        "defaultStatus": "generated",
        "requireReviewForCanon": True,
        "candidatePath": ".auto-context/compile/candidates.jsonl",
        "sourceQueuePath": ".auto-context/compile/source-queue.jsonl",
        "tombstonePath": ".auto-context/compile/tombstones.jsonl",
        "manifestPath": ".auto-context/compile/generated-manifest.jsonl",
        "mergeNeededPath": ".auto-context/compile/merge-needed.jsonl",
        "excludeStatusesFromRecall": ["discarded", "contested"],
        "lowPriorityStatuses": ["generated", "tentative"],
        "recallVerifiedOnly": True,
        "triggers": [],
        "canonSignals": [],
        "maxAutoPageLines": 120,
        "maxSourceChars": 12000,
        "extractor": {
            "argv": [],
            "timeout": 30,
            "cooldownSeconds": 600,
        },
        # 한 소스에서 컴파일할 후보 카드 수 상한. **candidates 길이는 모델 출력이고 예전에는
        # 어디에도 상한이 없었다** — worker가 `for candidate in candidates:`로 전량을 순회했고,
        # 신규 카드마다 write-time dedup judge(유료)가 붙고 각 카드가 verify 큐(유료)로 가므로
        # 모델이 한 run의 과금 규모를 정하는 구조였다(실측: 소스 5건 + 모델이 카드 40장 →
        # 한 run 유료 호출 205회). 프롬프트의 "쪼개지 말라"는 요청이지 한계가 아니다.
        "maxCardsPerSource": 10,
        "batch": {
            "idleSeconds": 90,
            "maxItems": 5,
            # **처리 시작 조건(maxItems)과 다르다.** maxItems는 "이만큼 모이면 지금 돌려라"이고
            # 이 값은 "한 run에서 extractor를 이보다 많이 spawn하지 마라"는 상한이다. 예전에는
            # 상한이 아예 없어 큐에 든 전량을 한 워커가 연속 실행했다(큐 수백 건 = 유료 호출
            # 수백 회 직렬). 초과분은 큐에 되돌려(requeue) 다음 kick이 집어 가므로 조용히
            # 유실되지 않는다.
            #
            # **이 값이 보장하는 것은 extractor 호출 수뿐이다.** 한 run의 유료 호출 총량은
            # extractor(≤ maxPerRun) + dedup judge(≤ 쓰인 카드 수) + verify(아래 예산)이고,
            # 카드 수는 `compile.maxCardsPerSource`가, verify는 `VERIFY_PRODUCED_HARD_CAP`이
            # 각각 유계로 만든다. 예전 주석은 "extractor 10회 + verify 10회로 유계"라고
            # 적었지만 verify는 카드 수를 따르므로 실측과 어긋난 거짓 계약이었다.
            "maxPerRun": 10,
        },
        "semanticDedup": {
            "enabled": True,
            "threshold": 0.82,
            "topK": 3,
            "similarPageMaxChars": 12000,
            "autoMergeThreshold": 0.9,
            "maxPairsPerScan": 10,
            # Retrieval floor for LLM judging. The daemon score is rank-bounded, not a
            # similarity (see wiki_dedup_judge.py), so it may only narrow the candidate
            # set -- the verdict comes from the judge.
            "candidateMinScore": 0.3,
            "judge": {
                "enabled": True,
                "timeout": 120,
                "cooldownSeconds": 600,
                "maxPairsPerScan": 8,
                "maxPairsPerCompile": 1,
                "maxCharsPerPage": 6000,
            },
        },
        "verify": {
            "enabled": True,
            "timeout": 120,
            "onFail": "delete",
            "onInconclusive": "delete",
            # 검수 엔진 분리(VERIFY_CROSS_ENGINE 참고). builtins가 비면 검수 후보 엔진을
            # compile.extractor 풀에서 물려받는다 — adapter argv 해석은 여전히 한 벌
            # (wiki_compile_worker.resolve_extractor_argv)이다.
            "crossEngine": "prefer",
            "builtins": [],
            "queuePath": ".auto-context/compile/verify-queue.jsonl",
            "logPath": ".auto-context/compile/verify-log.jsonl",
            "skippedPath": ".auto-context/compile/verify-skipped.jsonl",
            # 삭제 전용 감사 원장. logPath는 pass까지 담아 트림되므로 삭제 이력을 보존하지 못한다.
            "deletedPath": ".auto-context/compile/verify-deleted.jsonl",
            "cooldownSeconds": 600,
            "maxPerRun": 3,
        },
    },
}

# injectSummaryMaxChars 상한. 이 값은 카드 파일 읽기 창까지 키우므로(recall의
# wiki_card_read_limit) 상한 없이 두면 사용자 설정이 blocking hook의 I/O·CPU 예산을
# 무제한 확대한다. 4000은 관측된 최장 카드 본문(1574자)의 2.5배이고, topN 기본 3에서
# 주입 본문 최악 12000자(읽기 창 10048자/장)로 유계다.
MAX_INJECT_SUMMARY_CHARS = 4000

# injectSourcePathsPerCard 상한. 이 값이 카드당 stat() 호출 수이자 주입 줄 수의 상한이므로
# (topN × 이 값) blocking hook 예산을 유계로 둔다. 관측 최대 소스 수는 4다.
MAX_INJECT_SOURCE_PATHS_PER_CARD = 10

# 유료 host CLI 호출 수를 정하는 값들의 **상한 클램프**. 이 값들은 "설정 오류나 모델 출력이
# 과금 규모를 정하지 못한다"를 보장하는 자리이므로 설정으로 다시 열지 않는다.
#   - MAX_COMPILE_PER_RUN: `compile.batch.maxPerRun`(= run당 extractor 호출 수). 예전에는
#     `99999999`도 그대로 통과해 한 run이 수만 회 호출을 시도할 수 있었다.
#   - MAX_CARDS_PER_SOURCE: `compile.maxCardsPerSource`(= 소스당 카드 수, 모델 출력 상한).
#   - MAX_VERIFY_PER_RUN: `compile.verify.maxPerRun`(사람이 명시한 검수 예산).
#   - VERIFY_PRODUCED_HARD_CAP: **모델 출력에서 유도된** 검수 예산의 상한. verify 예산은
#     `max(verify.maxPerRun, min(생산량, 이 값))`이라 사람이 적은 값은 언제나 존중되고
#     모델이 만든 카드 수는 이 상한을 넘겨 과금을 늘릴 수 없다. 30은 기본 배치
#     (maxPerRun 10 × 실측 카드 증폭 2.68 ≈ 27)를 덮어 정상 흐름의 즉시 검수를 유지하면서
#     퇴화한 run(카드 200장)의 호출 폭발을 막는 값이다.
MAX_COMPILE_PER_RUN = 50
MAX_CARDS_PER_SOURCE = 50
MAX_VERIFY_PER_RUN = 50
VERIFY_PRODUCED_HARD_CAP = 30

COMPILE_MODES = {"off", "candidates", "guarded", "auto-wiki"}
WIKI_STATUSES = {"generated", "verified", "reviewed", "canon", "tentative", "contested", "discarded", "superseded"}
# onFail과 onInconclusive가 공유하는 값 집합. "none"이 유일한 "현행 유지"(카드를
# generated로 남김) 표현이므로, 기본값을 delete로 올려도 기존 동작을 명시 선택할 수 있다.
VERIFY_ON_FAIL = {"delete", "contested", "none"}
# 기계 검수 엔진을 카드를 만든 엔진과 분리하는 정책. LLM 자기 검수는 성능을 떨어뜨리고
# (Huang et al. ICLR'24) 문헌이 제시한 완화법은 생성 모델과 판정 모델의 분리다.
#   prefer  — 다른 엔진을 먼저 시도하고, 없으면 같은 엔진으로 검증(자기검증으로 기록)
#   require — 다른 엔진만 허용. 없으면 검증하지 않고 큐를 보존한다(카드는 generated로
#             남아 recallVerifiedOnly 기본값 아래 recall에서 빠진다 — 단일 CLI 머신에서는
#             wiki가 통째로 사라지므로 명시 선택만 허용한다)
#   off     — 0.x 동작(카드를 만든 엔진으로 검증)
VERIFY_CROSS_ENGINE = {"prefer", "require", "off"}
# 카드 frontmatter `verifiedMode` = 검수 엔진과 생성 엔진의 관계. 값 집합은 코드가 정하고
# 모델 입력이 아니다. 이 필드가 **없는** 카드는 4단계 이전에 검수된 카드로, 자기검증일
# 가능성이 높다(실측 655/688) — 없음은 cross-engine을 뜻하지 않는다.
VERIFIED_MODE_CROSS = "cross-engine"
VERIFIED_MODE_SELF = "self"
VERIFIED_MODE_UNKNOWN = "unknown"
VERIFIED_MODES = {VERIFIED_MODE_CROSS, VERIFIED_MODE_SELF, VERIFIED_MODE_UNKNOWN}
# status: verified/contested와 **함께** 써야 하는 증명 필드. 리셋 시 함께 제거된다.
VERIFY_PROOF_FIELDS = ("verifiedBy", "verifiedAt", "verifiedMode")
# 생성 엔진을 알 수 없을 때 큐/레코드에 쓰는 sentinel. **리터럴을 각자 들고 있으면 안 된다** —
# `wiki_verify_worker`가 "귀속 불가"를 이 값으로 판정하므로(교차검증 주장 금지) 생산 측
# (`wiki_compile_enqueue`·`sync`·`wiki_compile_worker`)과 같은 문자열이어야 한다. 갈려 있던
# 동안 planner의 빈 문자열 가드가 사실상 죽은 분기였다.
UNKNOWN_ENGINE = "unknown"
COMPILE_TRIGGERS = {
    "explicit_user_approval",
    "post_session_summary",
    "post_tool_source",
    # 수동 sync(core/sync.py)가 스냅샷 diff로 찾아낸 소스 변경. git pull·rebase·외부
    # 편집은 PostToolUse 훅을 타지 않으므로 `post_tool_source`로는 잡히지 않는다.
    "post_sync_source",
    "repeated_recall",
    "cross_file_conclusion",
    "manual",
}
BUILTIN_EXTRACTOR_ENGINES = {"claude", "codex", "hermes"}

EVENT_ALIASES = {
    "SessionStart": "sessionStart",
    "session_start": "sessionStart",
    "UserPromptSubmit": "userPromptSubmit",
    "BeforeAgent": "userPromptSubmit",
    "user_prompt_submit": "userPromptSubmit",
    "PostToolUse": "postToolUse",
    "AfterTool": "postToolUse",
    "post_tool_use": "postToolUse",
}


def coerce_float(value, default):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def coerce_int(value, default):
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    return result if result > 0 else default


def coerce_nonneg_int(value, default, maximum=None):
    """coerce_int와 달리 0을 유효값으로 받고, maximum으로 clamp한다.

    0이 "기능 끄기"의 의미를 갖는 필드(injectSummaryMaxChars)에 쓴다 — coerce_int는
    `result > 0`만 통과시켜 0을 기본값으로 되돌리므로 끌 수 없다.
    bool을 거부하는 이유: JSON `"injectSummaryMaxChars": true`는 흔한 오타이고
    `int(True) == 1`이라 본문이 1자로 잘린 채 조용히 동작한다.
    maximum이 필요한 이유: 이 값이 카드 파일 읽기 창까지 키우므로(recall.wiki_card_read_limit)
    사용자 설정이 blocking hook의 I/O·CPU 예산을 무제한으로 늘릴 수 있다.
    """
    if isinstance(value, bool):
        return default
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    if result < 0:
        return default
    if maximum is not None and result > maximum:
        return maximum
    return result


def coerce_capped_int(value, default, maximum):
    """1 이상 maximum 이하로 강제한다(유료 호출 수를 정하는 필드 전용).

    `coerce_int`는 양수면 무엇이든 통과시키므로 `99999999`가 그대로 run당 호출 상한이
    됐다. 문자열(`"100"`)도 `int()`로 통과하는데 문제는 형이 아니라 **크기**다.
    """
    result = coerce_int(value, default)
    if result > maximum:
        return maximum
    return result


def string_list(value, default=None):
    if default is None:
        default = []
    if not isinstance(value, list):
        return list(default)
    return [item for item in value if isinstance(item, str)]


def string_map(value):
    if not isinstance(value, dict):
        return {}
    return {
        key: item
        for key, item in value.items()
        if isinstance(key, str) and isinstance(item, str)
    }


def argv_list(value, default=None):
    if default is None:
        default = []
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    return list(default)


def extractor_backends(value):
    if not isinstance(value, dict):
        return {}
    return {
        key: item
        for key, item in value.items()
        if isinstance(key, str)
        and isinstance(item, list)
        and item
        and all(isinstance(arg, str) for arg in item)
    }


def builtin_extractor_engines(value):
    return [
        item
        for item in string_list(value, [])
        if item in BUILTIN_EXTRACTOR_ENGINES
    ]


def collection_role_map(value, collections):
    if not isinstance(value, dict):
        return {}
    allowed_collections = set(collections)
    return {
        key: item
        for key, item in value.items()
        if isinstance(key, str)
        and key in allowed_collections
        and isinstance(item, str)
        and item in COLLECTION_ROLES
    }


def invalid_role_collections(value, collections):
    """`collectionRoles`에서 **role 값이 미지**라 무시된 collection 이름 목록.

    `collection_role_map`이 그런 항목을 조용히 버리므로(fail-open → `raw`) 사용자
    의도가 반영되지 않은 사실이 어디에도 남지 않는다. 이 함수의 결과는 SessionStart
    notice로 표면화된다(`core/update.sh`) — 오타 하나가 "인덱싱 제외"를 "인덱싱"으로
    뒤집으므로 조용히 넘어가면 안 된다. collection에 없는 키·비문자열 키는 role 오타가
    아니라 무관한 항목이므로 세지 않는다.
    """
    if not isinstance(value, dict):
        return []
    allowed_collections = set(collections)
    return sorted(
        key
        for key, item in value.items()
        if isinstance(key, str)
        and key in allowed_collections
        and (not isinstance(item, str) or item not in COLLECTION_ROLES)
    )


def collection_role(roles, collection):
    """collection의 유효 role. 미설정·미지 값은 `raw`(role 도입 전 기본 동작)다.

    **역할 판정은 반드시 이 함수(또는 아래 헬퍼)를 거친다.** 예전에는 여러 곳이
    `roles.get(c) != "wiki"`로 raw를 wiki의 **여집합**으로 정의했는데, `source` 같은
    세 번째 값이 들어오면 그 지점 전부가 오분류한다(인덱싱 안 되는 컬렉션을 recall
    질의에 넣는 등). 여집합을 쓰지 말고 양성 집합으로 판정한다.
    """
    if not isinstance(roles, dict):
        return DEFAULT_COLLECTION_ROLE
    value = roles.get(collection)
    if isinstance(value, str) and value in COLLECTION_ROLES:
        return value
    return DEFAULT_COLLECTION_ROLE


def role_map(config):
    """config에서 `collectionRoles`를 안전하게 꺼낸다(dict가 아니면 빈 dict)."""
    if not isinstance(config, dict):
        return {}
    value = config.get("collectionRoles")
    return value if isinstance(value, dict) else {}


def is_wiki_collection(roles, collection):
    return collection_role(roles, collection) == COLLECTION_ROLE_WIKI


def is_indexed_collection(roles, collection):
    return collection_role(roles, collection) in INDEXED_ROLES


def is_compile_source_collection(roles, collection):
    return collection_role(roles, collection) in COMPILE_SOURCE_ROLES


def wiki_collections(collections, roles):
    return [c for c in collections if isinstance(c, str) and is_wiki_collection(roles, c)]


def indexed_collections(collections, roles):
    """qmd에 등록·질의되는 collection만. `source` role은 여기서 빠진다."""
    return [c for c in collections if isinstance(c, str) and is_indexed_collection(roles, c)]


def recall_raw_collections(collections, roles):
    """hierarchical raw backfill 대상 = **인덱싱되는 non-wiki** collection.

    `!= "wiki"` 여집합을 쓰면 안 되는 대표 지점이다 — `source`는 qmd에 등록조차
    되지 않으므로 backfill 질의에 넣으면 그 컬렉션 이름이 데몬에서 무의미해진다.
    """
    return [
        c for c in collections
        if isinstance(c, str) and collection_role(roles, c) in RECALL_RAW_ROLES
    ]


def compile_config(value):
    if not isinstance(value, dict):
        return dict(DEFAULT_CONFIG["compile"])
    defaults = DEFAULT_CONFIG["compile"]
    result = dict(defaults)
    result["enabled"] = value.get("enabled") if isinstance(value.get("enabled"), bool) else defaults["enabled"]
    result["mode"] = value.get("mode") if value.get("mode") in COMPILE_MODES else defaults["mode"]
    if not result["enabled"]:
        result["mode"] = "off"
    result["autoWrite"] = value.get("autoWrite") if isinstance(value.get("autoWrite"), bool) else defaults["autoWrite"]
    result["defaultStatus"] = value.get("defaultStatus") if value.get("defaultStatus") in WIKI_STATUSES else defaults["defaultStatus"]
    result["requireReviewForCanon"] = value.get("requireReviewForCanon") if isinstance(value.get("requireReviewForCanon"), bool) else defaults["requireReviewForCanon"]
    for key in ("candidatePath", "sourceQueuePath", "tombstonePath", "manifestPath", "mergeNeededPath"):
        if isinstance(value.get(key), str):
            result[key] = value[key]
    result["excludeStatusesFromRecall"] = [
        status for status in string_list(value.get("excludeStatusesFromRecall"), defaults["excludeStatusesFromRecall"])
        if status in WIKI_STATUSES
    ]
    result["lowPriorityStatuses"] = [
        status for status in string_list(value.get("lowPriorityStatuses"), defaults["lowPriorityStatuses"])
        if status in {"generated", "tentative", "superseded"}
    ]
    result["recallVerifiedOnly"] = (
        value.get("recallVerifiedOnly")
        if isinstance(value.get("recallVerifiedOnly"), bool)
        else defaults["recallVerifiedOnly"]
    )
    result["triggers"] = [
        trigger for trigger in string_list(value.get("triggers"), defaults["triggers"])
        if trigger in COMPILE_TRIGGERS
    ]
    result["canonSignals"] = string_list(value.get("canonSignals"), defaults["canonSignals"])
    result["maxAutoPageLines"] = coerce_int(value.get("maxAutoPageLines", defaults["maxAutoPageLines"]), defaults["maxAutoPageLines"])
    result["maxSourceChars"] = coerce_int(value.get("maxSourceChars", defaults["maxSourceChars"]), defaults["maxSourceChars"])
    result["maxCardsPerSource"] = coerce_capped_int(
        value.get("maxCardsPerSource", defaults["maxCardsPerSource"]),
        defaults["maxCardsPerSource"], MAX_CARDS_PER_SOURCE,
    )
    raw_extractor = value.get("extractor")
    extractor = raw_extractor if isinstance(raw_extractor, dict) else {}
    default_extractor = defaults.get("extractor") if isinstance(defaults.get("extractor"), dict) else {"argv": [], "timeout": 30}
    normalized_argv = argv_list(extractor.get("argv"), default_extractor["argv"])
    normalized_extractor = {
        "argv": normalized_argv,
        "timeout": coerce_int(extractor.get("timeout", default_extractor["timeout"]), default_extractor["timeout"]),
        "cooldownSeconds": coerce_int(extractor.get("cooldownSeconds", default_extractor.get("cooldownSeconds", 600)), 600),
    }
    if extractor.get("dispatch") == "by-engine":
        normalized_extractor["dispatch"] = "by-engine"
        normalized_extractor["backends"] = extractor_backends(extractor.get("backends"))
        normalized_extractor["builtins"] = builtin_extractor_engines(extractor.get("builtins"))
        normalized_extractor["default"] = argv_list(extractor.get("default"), [])
    result["extractor"] = normalized_extractor
    raw_batch = value.get("batch")
    batch = raw_batch if isinstance(raw_batch, dict) else {}
    default_batch = defaults.get("batch") if isinstance(defaults.get("batch"), dict) else {}
    result["batch"] = {
        "idleSeconds": coerce_int(batch.get("idleSeconds", 90), 90),
        "maxItems": coerce_int(batch.get("maxItems", 5), 5),
        "maxPerRun": coerce_capped_int(
            batch.get("maxPerRun", default_batch.get("maxPerRun", 10)),
            default_batch.get("maxPerRun", 10), MAX_COMPILE_PER_RUN,
        ),
    }
    raw_semantic = value.get("semanticDedup")
    semantic = raw_semantic if isinstance(raw_semantic, dict) else {}
    default_semantic = defaults.get("semanticDedup", {
        "enabled": True, "threshold": 0.82, "topK": 3, "similarPageMaxChars": 12000,
        "autoMergeThreshold": 0.9, "maxPairsPerScan": 10, "candidateMinScore": 0.3,
        "judge": {},
    })
    raw_judge = semantic.get("judge")
    judge = raw_judge if isinstance(raw_judge, dict) else {}
    default_judge = default_semantic.get("judge") if isinstance(default_semantic.get("judge"), dict) else {}
    result["semanticDedup"] = {
        "enabled": semantic.get("enabled") if isinstance(semantic.get("enabled"), bool) else default_semantic["enabled"],
        "threshold": coerce_float(semantic.get("threshold", default_semantic["threshold"]), default_semantic["threshold"]),
        "topK": coerce_int(semantic.get("topK", default_semantic["topK"]), default_semantic["topK"]),
        "similarPageMaxChars": coerce_int(semantic.get("similarPageMaxChars", default_semantic["similarPageMaxChars"]), default_semantic["similarPageMaxChars"]),
        "autoMergeThreshold": coerce_float(semantic.get("autoMergeThreshold", default_semantic["autoMergeThreshold"]), default_semantic["autoMergeThreshold"]),
        "maxPairsPerScan": coerce_int(semantic.get("maxPairsPerScan", default_semantic["maxPairsPerScan"]), default_semantic["maxPairsPerScan"]),
        "candidateMinScore": coerce_float(semantic.get("candidateMinScore", default_semantic["candidateMinScore"]), default_semantic["candidateMinScore"]),
        "judge": {
            "enabled": judge.get("enabled") if isinstance(judge.get("enabled"), bool) else default_judge.get("enabled", True),
            "timeout": coerce_int(judge.get("timeout", default_judge.get("timeout", 120)), default_judge.get("timeout", 120)),
            "cooldownSeconds": coerce_int(judge.get("cooldownSeconds", default_judge.get("cooldownSeconds", 600)), default_judge.get("cooldownSeconds", 600)),
            "maxPairsPerScan": coerce_int(judge.get("maxPairsPerScan", default_judge.get("maxPairsPerScan", 8)), default_judge.get("maxPairsPerScan", 8)),
            "maxPairsPerCompile": coerce_int(judge.get("maxPairsPerCompile", default_judge.get("maxPairsPerCompile", 1)), default_judge.get("maxPairsPerCompile", 1)),
            "maxCharsPerPage": coerce_int(judge.get("maxCharsPerPage", default_judge.get("maxCharsPerPage", 6000)), default_judge.get("maxCharsPerPage", 6000)),
        },
    }
    raw_verify = value.get("verify")
    verify = raw_verify if isinstance(raw_verify, dict) else {}
    default_verify = defaults["verify"]
    result["verify"] = {
        "enabled": verify.get("enabled") if isinstance(verify.get("enabled"), bool) else default_verify["enabled"],
        "timeout": coerce_int(verify.get("timeout", default_verify["timeout"]), default_verify["timeout"]),
        "onFail": verify.get("onFail") if verify.get("onFail") in VERIFY_ON_FAIL else default_verify["onFail"],
        "onInconclusive": verify.get("onInconclusive") if verify.get("onInconclusive") in VERIFY_ON_FAIL else default_verify["onInconclusive"],
        "crossEngine": verify.get("crossEngine") if verify.get("crossEngine") in VERIFY_CROSS_ENGINE else default_verify["crossEngine"],
        # 심볼릭 엔진 이름만 받는다(adapter 경로 금지). 빈 목록 = extractor 풀 상속.
        "builtins": string_list(verify.get("builtins"), default_verify["builtins"]),
        "queuePath": verify.get("queuePath") if isinstance(verify.get("queuePath"), str) and verify.get("queuePath") else default_verify["queuePath"],
        "logPath": verify.get("logPath") if isinstance(verify.get("logPath"), str) and verify.get("logPath") else default_verify["logPath"],
        "skippedPath": verify.get("skippedPath") if isinstance(verify.get("skippedPath"), str) and verify.get("skippedPath") else default_verify["skippedPath"],
        "deletedPath": verify.get("deletedPath") if isinstance(verify.get("deletedPath"), str) and verify.get("deletedPath") else default_verify["deletedPath"],
        "cooldownSeconds": coerce_int(verify.get("cooldownSeconds", default_verify["cooldownSeconds"]), default_verify["cooldownSeconds"]),
        "maxPerRun": coerce_capped_int(
            verify.get("maxPerRun", default_verify["maxPerRun"]),
            default_verify["maxPerRun"], MAX_VERIFY_PER_RUN,
        ),
    }
    return result


def has_legacy_novel_collection(collections):
    return any(
        collection.endswith("-manuscript") or collection.endswith("-plot")
        for collection in collections
    )


def canonical_event_name(event_name):
    return EVENT_ALIASES.get(event_name, event_name)


def event_enabled(config, event_name):
    events = config.get("events", DEFAULT_CONFIG["events"])
    if not isinstance(events, list):
        events = DEFAULT_CONFIG["events"]
    return canonical_event_name(event_name) in events


def load_input_config():
    raw = sys.stdin.read()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def normalize_config(input_config):
    config = dict(DEFAULT_CONFIG)
    config["name"] = input_config.get("name", DEFAULT_CONFIG["name"]) if isinstance(input_config.get("name", ""), str) else DEFAULT_CONFIG["name"]
    config["collections"] = string_list(input_config.get("collections"), DEFAULT_CONFIG["collections"])
    config["minScore"] = coerce_float(input_config.get("minScore", DEFAULT_CONFIG["minScore"]), DEFAULT_CONFIG["minScore"])
    config["rawFallbackMinScore"] = coerce_float(input_config.get("rawFallbackMinScore", config["minScore"]), config["minScore"])
    config["topN"] = coerce_int(input_config.get("topN", DEFAULT_CONFIG["topN"]), DEFAULT_CONFIG["topN"])
    config["queryTimeout"] = coerce_float(input_config.get("queryTimeout", DEFAULT_CONFIG["queryTimeout"]), DEFAULT_CONFIG["queryTimeout"])
    config["staleQueueThreshold"] = coerce_int(input_config.get("staleQueueThreshold", DEFAULT_CONFIG["staleQueueThreshold"]), DEFAULT_CONFIG["staleQueueThreshold"])
    config["skipPaths"] = string_list(input_config.get("skipPaths"), DEFAULT_CONFIG["skipPaths"])
    config["collectionPaths"] = string_map(input_config.get("collectionPaths"))
    config["allowRoots"] = string_list(input_config.get("allowRoots"), DEFAULT_CONFIG["allowRoots"])
    config["prefixStyle"] = input_config.get("prefixStyle") if input_config.get("prefixStyle") in ("full", "tag") else DEFAULT_CONFIG["prefixStyle"]
    config["injectSummaryMaxChars"] = coerce_nonneg_int(
        input_config.get("injectSummaryMaxChars", DEFAULT_CONFIG["injectSummaryMaxChars"]),
        DEFAULT_CONFIG["injectSummaryMaxChars"],
        MAX_INJECT_SUMMARY_CHARS,
    )
    config["injectSourcePathsPerCard"] = coerce_nonneg_int(
        input_config.get("injectSourcePathsPerCard", DEFAULT_CONFIG["injectSourcePathsPerCard"]),
        DEFAULT_CONFIG["injectSourcePathsPerCard"],
        MAX_INJECT_SOURCE_PATHS_PER_CARD,
    )
    config["collectionRoles"] = collection_role_map(input_config.get("collectionRoles"), config["collections"])
    config["recallStrategy"] = input_config.get("recallStrategy") if input_config.get("recallStrategy") in ("flat", "hierarchical", "wikiOnly") else DEFAULT_CONFIG["recallStrategy"]
    config["wikiPath"] = input_config.get("wikiPath") if isinstance(input_config.get("wikiPath"), str) else DEFAULT_CONFIG["wikiPath"]
    config["compile"] = compile_config(input_config.get("compile"))
    if "events" in input_config and isinstance(input_config.get("events"), list):
        config["events"] = [
            canonical_event_name(event)
            for event in string_list(input_config.get("events"), [])
            if canonical_event_name(event) in DEFAULT_CONFIG["events"]
        ]
    else:
        config["events"] = list(DEFAULT_CONFIG["events"])

    val = input_config.get("indexing")
    if isinstance(val, str):                      # "true"/"false" 문자열만 boolean으로 강제, 그 외는 None
        low = val.strip().lower()
        val = True if low == "true" else (False if low == "false" else None)
    config["indexing"] = val if isinstance(val, bool) else None

    if "lexicalPatterns" in input_config:
        config["lexicalPatterns"] = string_list(input_config.get("lexicalPatterns"), DEFAULT_CONFIG["lexicalPatterns"])
    elif has_legacy_novel_collection(config["collections"]):
        config["lexicalPatterns"] = ["ep"]
    else:
        config["lexicalPatterns"] = list(DEFAULT_CONFIG["lexicalPatterns"])
    return config


def _is_within(path, root):
    try:
        Path(path).relative_to(Path(root))
        return True
    except ValueError:
        return False

def _project_search_dirs(cwd):
    path = Path(cwd).resolve()
    home = Path.home().resolve()
    # HOME 자체이거나 HOME 밖이면 cwd만; HOME 하위면 HOME까지만 부모 탐색.
    if path == home or not _is_within(path, home):
        return [path]
    search = [path]
    for parent in path.parents:
        search.append(parent)
        if parent == home:
            break
    return search


def project_identity_root(cwd):
    """Return the repo-level root used for local per-user decisions."""
    path = Path(cwd).resolve()
    home = Path.home().resolve()
    if path == home or not _is_within(path, home):
        return path
    for candidate in _project_search_dirs(path):
        if (candidate / ".git").exists():
            return candidate
    return path


def _local_optout_marker_path(root):
    key = hashlib.sha256(str(Path(root).resolve()).encode("utf-8")).hexdigest()
    return Path.home() / LOCAL_OPTOUT_DIR / f"{key}.json"


def local_optout_marker_path(cwd):
    return _local_optout_marker_path(project_identity_root(cwd))


def find_local_optout(cwd):
    cwd_path = Path(cwd).resolve()
    direct = local_optout_marker_path(cwd_path)
    if direct.is_file():
        return {"marker": direct, "root": project_identity_root(cwd_path)}

    marker_dir = Path.home() / LOCAL_OPTOUT_DIR
    try:
        candidates = list(marker_dir.glob("*.json"))
    except OSError:
        return None

    matches = []
    for marker in candidates:
        try:
            raw = json.loads(marker.read_text(encoding="utf-8"))
            root_value = raw.get("root") if isinstance(raw, dict) else None
            if not isinstance(root_value, str):
                continue
            root = Path(root_value).resolve()
        except (OSError, json.JSONDecodeError):
            continue
        if _is_within(cwd_path, root):
            matches.append((len(root.parts), marker, root))
    if not matches:
        return None
    _, marker, root = max(matches, key=lambda item: item[0])
    return {"marker": marker, "root": root}


def has_local_optout(cwd):
    return find_local_optout(cwd) is not None



def write_local_optout(cwd):
    root = project_identity_root(cwd)
    marker = _local_optout_marker_path(root)
    marker.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(marker.parent), prefix=marker.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"indexing": False, "root": str(root)}, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, marker)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return marker


def clear_local_optout(cwd):
    found = find_local_optout(cwd)
    marker = found["marker"] if found else local_optout_marker_path(cwd)
    try:
        marker.unlink()
    except FileNotFoundError:
        pass
    return marker


def _candidate_configs(project_dir):
    return [
        (project_dir / CONFIG_DIR_NAME / SETTINGS_FILE_NAME, "auto-context-dir", project_dir),
        (project_dir / LEGACY_CONFIG_FILE_NAME, "auto-context-json", project_dir),
        (project_dir / LEGACY_AGENTS_DIR / LEGACY_AGENTS_FILE_NAME, "agents-legacy", project_dir),
    ]


def find_project_config(cwd):
    """cwd→부모(HOME 경계)로 project config를 찾고 normalized config와 위치를 반환한다.

    recall/posttool/index_enqueue/wiki_compile_enqueue/preflight_gate 등 여러 hook
    entrypoint가 이 함수를 개별 try/except 없이 안전한 최종 경계로 기대하고 직접
    호출한다. 샌드박스/권한 등 예상 못한 환경 차이로 경로 탐색이 실패해도 여기서
    죽으면 hook 프로세스 자체가 non-zero exit로 죽어 host UI에 hook 실패로
    표면화된다 -- "설정 없음"으로 fail-open해 호출자가 정상 종료하게 한다."""
    try:
        return _find_project_config_unsafe(cwd)
    except Exception:
        try:
            project_root = str(Path(cwd).resolve())
        except Exception:
            project_root = str(cwd)
        fallback = normalize_config({})
        fallback["collections"] = []
        return {
            "config": fallback,
            "configPath": None,
            "configFormat": "none",
            "projectRoot": project_root,
        }


def _find_project_config_unsafe(cwd):
    path = Path(cwd).resolve()
    local_optout = find_local_optout(path)
    if local_optout:
        config = normalize_config({"indexing": False})
        config["collections"] = []
        return {
            "config": config,
            "configPath": str(local_optout["marker"]),
            "configFormat": "local-optout",
            "projectRoot": str(local_optout["root"]),
        }
    config_file = None
    config_format = "none"
    project_root = path
    for d in _project_search_dirs(cwd):
        for cand, fmt, root in _candidate_configs(d):
            if cand.exists():
                config_file = cand
                config_format = fmt
                project_root = root
                break
        if config_file:
            break
    if config_file:
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                config = normalize_config(json.load(f))
            if config.get("indexing") is False:
                config["collections"] = []
            return {
                "config": config,
                "configPath": str(config_file),
                "configFormat": config_format,
                "projectRoot": str(project_root),
            }
        except (json.JSONDecodeError, OSError):
            pass
    fallback = normalize_config({})
    fallback["collections"] = []
    return {
        "config": fallback,
        "configPath": None,
        "configFormat": "none",
        "projectRoot": str(path),
    }


def find_legacy_auto_context_json(cwd):
    """Find the nearest legacy .auto-context.json, unless new settings already exist first."""
    for d in _project_search_dirs(cwd):
        settings = d / CONFIG_DIR_NAME / SETTINGS_FILE_NAME
        legacy_json = d / LEGACY_CONFIG_FILE_NAME
        agents_legacy = d / LEGACY_AGENTS_DIR / LEGACY_AGENTS_FILE_NAME
        if settings.exists():
            return {"path": None, "projectRoot": str(d), "reason": "settings_exists"}
        if legacy_json.exists():
            return {"path": str(legacy_json), "projectRoot": str(d), "reason": None}
        if agents_legacy.exists():
            return {"path": None, "projectRoot": str(d), "reason": "agents_legacy_not_migrated"}
    return {"path": None, "projectRoot": str(Path(cwd).resolve()), "reason": "no_legacy_config"}


def _read_json_object(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
    except json.JSONDecodeError:
        return None, "invalid_json"
    except OSError:
        return None, "read_error"
    if not isinstance(parsed, dict):
        return None, "invalid_json"
    return parsed, None


def _safe_project_settings_dir(project_root):
    """Return .auto-context only if it is a real directory inside project_root."""
    root = Path(project_root).resolve()
    settings_dir = root / CONFIG_DIR_NAME
    if settings_dir.exists():
        if settings_dir.is_symlink() or not settings_dir.is_dir():
            return None, "unsafe_settings_dir"
    else:
        try:
            settings_dir.mkdir(parents=True, exist_ok=False)
        except OSError:
            return None, "write_error"
    try:
        resolved = settings_dir.resolve()
        resolved.relative_to(root)
    except (OSError, ValueError):
        return None, "unsafe_settings_dir"
    if resolved != settings_dir:
        return None, "unsafe_settings_dir"
    return settings_dir, None


def migrate_legacy_config(cwd):
    """Move .auto-context.json to .auto-context/settings.json safely.

    This is intentionally separate from read-only config lookup so query-time
    hooks can load config without mutating the project.
    """
    found = find_legacy_auto_context_json(cwd)
    if not found.get("path"):
        return {"migrated": False, "reason": found.get("reason", "no_legacy_config")}

    legacy_path = Path(found["path"]).resolve()
    project_root = Path(found["projectRoot"]).resolve()
    settings_dir, dir_reason = _safe_project_settings_dir(project_root)
    settings_path = project_root / CONFIG_DIR_NAME / SETTINGS_FILE_NAME
    if dir_reason:
        return {"migrated": False, "reason": dir_reason, "from": str(legacy_path), "to": str(settings_path)}
    assert settings_dir is not None
    tmp_path = None

    if settings_path.exists():
        return {"migrated": False, "reason": "settings_exists"}

    parsed, reason = _read_json_object(legacy_path)
    if reason:
        return {"migrated": False, "reason": reason, "from": str(legacy_path)}
    normalized = normalize_config(parsed)

    try:
        fd, tmp_name = tempfile.mkstemp(
            dir=str(settings_dir),
            prefix=f"{SETTINGS_FILE_NAME}.",
            suffix=".tmp",
            text=True,
        )
        tmp_path = Path(tmp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(parsed, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

        tmp_parsed, reason = _read_json_object(tmp_path)
        if reason or normalize_config(tmp_parsed) != normalized:
            try:
                tmp_path.unlink()
            except OSError:
                pass
            return {"migrated": False, "reason": reason or "verification_failed", "from": str(legacy_path), "to": str(settings_path)}

        tmp_path.replace(settings_path)

        final_parsed, reason = _read_json_object(settings_path)
        if reason or normalize_config(final_parsed) != normalized:
            return {"migrated": False, "reason": reason or "verification_failed", "from": str(legacy_path), "to": str(settings_path)}

        legacy_path.unlink()
        return {"migrated": True, "from": str(legacy_path), "to": str(settings_path)}
    except OSError as exc:
        try:
            if tmp_path and tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        return {"migrated": False, "reason": "write_error", "error": str(exc), "from": str(legacy_path), "to": str(settings_path)}


def load_project_config(cwd):
    """Load effective config: local optout marker, then project settings/legacy config.
    indexing:false means collections=[] (검색/인덱싱 skip). 못 찾으면 빈 설정(collections=[])."""
    return find_project_config(cwd)["config"]


def load_project_config_raw(cwd):
    """Return the raw JSON object for the discovered project config, or {}."""
    found = find_project_config(cwd)
    config_path = found.get("configPath")
    if not config_path:
        return {}
    parsed, reason = _read_json_object(config_path)
    return parsed if not reason else {}


def main():
    parser = argparse.ArgumentParser(description="Normalize qmd recall configuration.")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--raw", action="store_true", help="Print raw discovered project config JSON instead of stdin normalization.")
    parser.add_argument("--migrate", action="store_true", help="Migrate .auto-context.json to .auto-context/settings.json.")
    args = parser.parse_args()

    if args.migrate:
        print(json.dumps(migrate_legacy_config(args.cwd), ensure_ascii=False))
        return

    if args.raw:
        print(json.dumps(load_project_config_raw(args.cwd), ensure_ascii=False))
        return

    config = normalize_config(load_input_config())
    print(json.dumps(config, ensure_ascii=False))


if __name__ == "__main__":
    main()
