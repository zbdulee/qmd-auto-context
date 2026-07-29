#!/usr/bin/env python3
import sys
import os
import json
import math
import re
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone

# Add current directory to path to import core sibling modules
sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import keywords as qmd_keywords

DEFAULT_DAEMON_URL = "http://localhost:8483"
DEFAULT_HEALTH_TIMEOUT = 2.0
QUERY_TIMEOUT = 5.0

# shadow query(진단 전용) 예산. 데몬은 single-thread이고 UserPromptSubmit은 blocking
# hook이라, 진단 query는 본 recall 질의에 "직렬로" 추가된다. 따라서 본 recall의
# queryTimeout(기본 5s)을 그대로 쓰지 않고 훨씬 짧은 per-query timeout + 전체
# wall-clock 예산을 둔다. warm 인덱스에서 rerank 없는 lex+vec query는 보통 100ms
# 안쪽이라 1s면 정상 응답을 놓치지 않고, 데몬이 직렬로 밀리는 병리적 케이스는
# 빠르게 포기한다. 전체 예산은 진단 모드가 추가할 수 있는 최악 지연의 상한이다.
SHADOW_QUERY_TIMEOUT = 1.0
SHADOW_TOTAL_BUDGET = 2.5
SHADOW_TOP_N = 3

def health_timeout() -> float:
    try:
        timeout = float(os.environ.get("QMD_HEALTH_TIMEOUT", DEFAULT_HEALTH_TIMEOUT))
    except (TypeError, ValueError):
        return DEFAULT_HEALTH_TIMEOUT
    return timeout if math.isfinite(timeout) and timeout > 0 else DEFAULT_HEALTH_TIMEOUT

def daemon_alive(daemon_url: str) -> bool:
    try:
        req = urllib.request.Request(f"{daemon_url}/health", method="GET")
        with urllib.request.urlopen(req, timeout=health_timeout()) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False

def load_project_config(cwd: str) -> dict:
    return qmd_config.load_project_config(cwd)

def qmd_uri_to_filepath(uri: str) -> str:
    if uri.startswith("qmd://"):
        parts = uri[len("qmd://"):].split("/", 1)
        if len(parts) == 2:
            return parts[1]
    return uri

def qmd_uri_to_collection(uri: str) -> str:
    if uri.startswith("qmd://"):
        return uri[len("qmd://"):].split("/", 1)[0]
    return uri.split("/", 1)[0] if "/" in uri else ""

def resolve_wiki_result_path(result: dict, config: dict, cwd: str) -> Path | None:
    uri = result.get("file", "")
    collection = result.get("_collection", "") or qmd_uri_to_collection(uri)
    collection_paths = config.get("collectionPaths", {}) if isinstance(config.get("collectionPaths"), dict) else {}
    wiki_path = config.get("wikiPath", ".auto-context/wiki")
    project_root = Path(qmd_config.find_project_config(cwd).get("projectRoot", cwd)).resolve()
    wiki_root = (project_root / wiki_path).resolve()
    candidates = []
    if uri.startswith("qmd://") and "/" in uri[len("qmd://"):]:
        rel = uri[len("qmd://"):].split("/", 1)[1]
        base = collection_paths.get(collection, "")
        if base:
            candidates.append((project_root / base / rel).resolve())
        candidates.append((project_root / rel).resolve())
    elif uri:
        path = Path(uri)
        candidates.append(path.resolve() if path.is_absolute() else (project_root / path).resolve())
    for candidate in candidates:
        try:
            candidate.relative_to(wiki_root)
        except ValueError:
            continue
        if candidate.is_file():
            return candidate
    return None

# recall에서 검수급으로 대우하는 status 집합. wiki_compile.is_auto_writable_page의
# 보호 집합과 달리 verified를 포함한다(의도적 차이) — verified는 기계 검수 통과라
# recall 신뢰는 얻지만 쓰기 보호는 받지 않아 소스 변경 시 자동 갱신·재검증이 계속된다.
REVIEWED_WIKI_STATUSES = {"verified", "reviewed", "canon", "manual", "superseded"}

def read_wiki_meta(result: dict, config: dict, cwd: str) -> dict:
    """wiki 결과의 frontmatter에서 status와 검수 여부를 읽는다.

    검수 판정: reviewed:true, 보호 status, 또는 createdBy가 명시적으로
    qmd-auto-context가 아닌 경우. createdBy 부재 시에는 status가 기준이다
    (status 부재 기본값 generated = 미검수 — 기존 status 기본값 규약과 일치).
    """
    meta = {"status": "generated", "reviewed": False}
    path = resolve_wiki_result_path(result, config, cwd)
    if path is None:
        return meta
    try:
        text = path.read_text(encoding="utf-8")[:4096]
    except OSError:
        return meta
    if not text.startswith("---"):
        return meta
    end = text.find("\n---", 3)
    if end == -1:
        return meta
    fields = {}
    for line in text[3:end].splitlines():
        stripped = line.strip()
        for key in ("status", "reviewed", "createdBy"):
            if stripped.startswith(f"{key}:"):
                value = stripped.split(":", 1)[1].strip().strip('"\'')
                if value:
                    fields[key] = value
    if fields.get("status"):
        meta["status"] = fields["status"]
    created_by = fields.get("createdBy", "")
    meta["reviewed"] = (
        fields.get("reviewed", "").lower() == "true"
        or meta["status"].lower() in REVIEWED_WIKI_STATUSES
        or (created_by != "" and created_by != "qmd-auto-context")
    )
    return meta

def ep_numbers(prompt: str) -> list[int]:
    nums: list[int] = []
    for match in re.finditer(r"\bEP[\s_-]*0*(\d{1,3})\b|\b0*(\d{1,3})\s*화", prompt, re.IGNORECASE):
        ep = match.group(1) or match.group(2)
        if ep:
            nums.append(int(ep))
    return list(dict.fromkeys(nums))

def ep_file_matches(filepath: str, n: int) -> bool:
    base = qmd_uri_to_filepath(filepath or "").rsplit("/", 1)[-1].lower()
    for match in re.finditer(r"ep[-_]?0*(\d{1,3})(?!\d)|0*(\d{1,3})\s*화(?![가-힣])", base):
        tok = match.group(1) or match.group(2)
        if tok and int(tok) == n:
            return True
    return False


def is_wiki_meta_noise(result: dict, config: dict) -> bool:
    """index.md (목차) / log.md (생성 이력) are auto-generated wiki metadata that
    aggregate every card's name/title, so vec search matches them against almost
    any query -- pure recall noise. Scoped to wiki-role collections so a genuine
    index.md/log.md in a non-wiki collection (e.g. a code repo README-style file)
    is left untouched."""
    roles = config.get("collectionRoles", {})
    if not isinstance(roles, dict) or roles.get(result.get("_collection", "")) != "wiki":
        return False
    base = qmd_uri_to_filepath(result.get("file", "") or "").rsplit("/", 1)[-1]
    return base in ("index.md", "log.md")

def promote_ep_exact_matches(results: list[dict], nums: list[int]) -> None:
    if not nums:
        return
    for result in results:
        filepath = result.get("file", "")
        if any(ep_file_matches(filepath, n) for n in nums):
            try:
                score = float(result.get("score", 0) or 0)
            except (TypeError, ValueError):
                score = 0
            result["score"] = max(score, 1.0)
            result["_exact_match"] = True

def resolve_prefix_style(config: dict) -> str:
    if os.environ.get("QMD_PREFIX_STYLE") == "tag" or config.get("prefixStyle") == "tag":
        return "tag"
    return "full"

def format_context(results: list[dict], prefix_style: str = "full", collection_roles: dict | None = None) -> str:
    collection_roles = collection_roles or {}
    lines = ["관련 문서:"]
    has_unreviewed = False
    for result in results:
        uri = result.get("file", "")
        filepath = qmd_uri_to_filepath(uri)
        title = result.get("title", "")
        collection = result.get("_collection", "") or qmd_uri_to_collection(uri)

        tag = collection_roles.get(collection, collection)
        if tag == "wiki" and result.get("_wiki_status"):
            tag = f"wiki:{result['_wiki_status']}"
        if collection not in collection_roles and prefix_style == "tag" and collection:
            tag = collection.rsplit("-", 1)[-1]
        prefix = f"[{tag}] " if tag else ""

        # 미검수 자동생성 wiki 카드 배지: 모델이 카드를 검수된 캐논으로 오신뢰하는 것 방지.
        suffix = ""
        if result.get("_wiki_status") and not result.get("_wiki_reviewed", False):
            suffix = " (미검수)"
            has_unreviewed = True

        if title:
            lines.append(f"- {prefix}{filepath} - {title}{suffix}")
        else:
            lines.append(f"- {prefix}{filepath}{suffix}")
    if has_unreviewed:
        lines.append("주의: (미검수) 표시는 자동 생성 요약 — 단독 캐논 근거로 인용 금지, 원문 대조 필요.")
    lines.append("필요시 참조.")
    return "\n".join(lines)

def log_score_observation(log_path: str | None, results: list[dict], collections: list[str]) -> None:
    if not log_path or not results:
        return
    scores = [r.get("score", 0) for r in results]
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "qmd_score_observation",
        "engine": os.environ.get("QMD_ENGINE", "gemini"),
        "transport": "http",
        "collections": collections,
        "top_n": len(results),
        "scores": scores,
        "max_score": max(scores) if scores else 0,
    }
    try:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError:
        pass

def log_recall_event(log_path: str | None, reason: str, **fields) -> None:
    """Append a one-line selection/skip reason to QMD_RECALL_LOG.

    Writes to the log file only (never stdout), and only when QMD_RECALL_LOG
    is set — so it never touches the model context and is a no-op in normal runs.
    Lets an operator tell *why* recall produced empty output (event_disabled /
    no_keywords / no_collections / daemon_unreachable / query_failed /
    no_results_after_filter / selected).
    """
    if not log_path:
        return
    # event_override: 같은 append 경로를 쓰면서 event 이름만 바꾼다(shadow 진단 라인).
    # 기존 qmd_recall_selection 소비자가 진단 라인을 selection으로 오독하지 않게 한다.
    event = fields.pop("event_override", None) or "qmd_recall_selection"
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "engine": os.environ.get("QMD_ENGINE", "gemini"),
        "reason": reason,
    }
    payload.update(fields)
    try:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError:
        pass


def shadow_diagnostics_enabled() -> bool:
    """shadow query 진단은 QMD_RECALL_LOG + QMD_SHADOW_QUERY 둘 다 있을 때만 켠다.

    config 필드가 아니라 env인 이유: 프로젝트 설정에 진단 스위치를 남기면 켠 채로
    방치된다. 로그 파일이 없으면 기록할 곳이 없으니 no-op(추가 query 0건)이다.
    """
    if not os.environ.get("QMD_RECALL_LOG"):
        return False
    value = (os.environ.get("QMD_SHADOW_QUERY") or "").strip().lower()
    return value not in ("", "0", "false", "no", "off")


def shadow_query_timeout() -> float:
    try:
        timeout = float(os.environ.get("QMD_SHADOW_TIMEOUT", SHADOW_QUERY_TIMEOUT))
    except (TypeError, ValueError):
        return SHADOW_QUERY_TIMEOUT
    return timeout if math.isfinite(timeout) and timeout > 0 else SHADOW_QUERY_TIMEOUT


def summarize_shadow_results(results: list[dict], limit: int = SHADOW_TOP_N) -> dict:
    """데몬 반환 순서를 그대로 rank로 굳혀 요약한다.

    rerank=False 경로에서 qmd가 주는 score는 의미 유사도가 아니라 RRF 순위의
    역수(1/rank)다. 따라서 score만 남기면 순위 정보가 사실상 소실되고(동일 rank는
    항상 같은 값), ep exact-match promotion이 score를 1.0으로 덮어쓰면 원래 순위조차
    복원할 수 없다. 호출 시점의 리스트 순서를 rank로 즉시 확정해 둔다.
    """
    top = []
    for index, result in enumerate(results[:limit]):
        entry: dict = {"rank": index + 1, "file": result.get("file", "")}
        try:
            entry["score"] = round(float(result.get("score", 0) or 0), 4)
        except (TypeError, ValueError):
            entry["score"] = None
        title = result.get("title") or ""
        if title:
            entry["title"] = title[:80]
        status = result.get("_wiki_status")
        if status:
            entry["status"] = status
            entry["reviewed"] = bool(result.get("_wiki_reviewed", False))
        top.append(entry)
    return {"status": "ok", "count": len(results), "top": top}


def build_rank_index(results: list[dict]) -> dict[str, int]:
    """file → 데몬 반환 rank. 로그에는 top N만 남기지만 `selected`의 original_rank는
    절단 밖(4위 이하)에서 올라온 결과도 가리켜야 하므로 전 구간을 여기 담는다."""
    index: dict[str, int] = {}
    for position, result in enumerate(results):
        file = result.get("file", "")
        if file and file not in index:
            index[file] = position + 1
    return index


def describe_selected(final_results: list[dict], rank_index: dict[str, int]) -> list[dict]:
    """실제 주입된 문서를 원래 rank·promotion 여부와 함께 남긴다.

    EP exact-match promotion(promote_ep_exact_matches)은 파일명이 EP와 정확히
    맞으면 score를 1.0으로 덮어써 순위를 끌어올린다. primary 스냅샷은 promotion
    "전"이고 top[]은 상위 몇 건만 남기므로, 원래 4위 이하였던 EP 결과가 선택되면
    로그만으로는 원래 순위도 promotion 여부도 알 수 없었다.
    """
    entries = []
    for position, result in enumerate(final_results):
        file = result.get("file", "")
        entry: dict = {"file": file, "final_rank": position + 1}
        original = rank_index.get(file)
        if original is not None:
            entry["original_rank"] = original
        entry["ep_promoted"] = bool(result.get("_exact_match", False))
        status = result.get("_wiki_status")
        if status:
            entry["status"] = status
            entry["reviewed"] = bool(result.get("_wiki_reviewed", False))
        entries.append(entry)
    return entries


def run_shadow_query(
    daemon_url: str,
    collections: list[str],
    searches: list[dict],
    deadline: float,
) -> dict:
    """진단 전용 1회성 query. 실패는 예외가 아니라 status 문자열로만 남긴다.

    본 recall 결과는 이 함수 호출 시점에 이미 확정돼 있으므로 어떤 실패도
    사용자에게 보이는 출력에 영향을 주지 않는다.
    """
    if not collections:
        return {"status": "no_collections"}
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {"status": "budget_exhausted"}
    timeout = min(shadow_query_timeout(), remaining)
    payload = {
        "searches": searches,
        "collections": collections,
        "limit": 8,
        "minScore": 0,
        "timeout": timeout,
        "rerank": False,
    }
    try:
        req = urllib.request.Request(
            f"{daemon_url}/query",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
        results = json.loads(body).get("results", [])
        if not isinstance(results, list):
            return {"status": "bad_response"}
        return summarize_shadow_results(results)
    except Exception:  # noqa: BLE001 - 진단 경로는 절대 본 흐름을 깨면 안 된다
        return {"status": "unavailable"}


def log_shadow_diagnostics(
    log_path: str | None,
    *,
    daemon_url: str,
    strategy: str,
    fixture_path: str | None,
    lexical_query: str,
    lexical_terms: list[str],
    vector_query: str,
    queried_collections: list[str],
    raw_collections: list[str],
    primary: dict,
    raw: dict | None,
    selected_entries: list[dict],
    active_min_score: float,
    top_n: int,
    selection_reason: str,
    dropped_skip: int,
    dropped_min_score: int,
    dropped_unverified: int,
    dropped_top_n: int,
) -> None:
    """recall 품질 손실을 정량화하는 한 줄 JSON(`qmd_recall_shadow`)을 기록한다.

    파일에만 쓰고 stdout(모델 컨텍스트)엔 절대 나가지 않는다. 하위 질의는 fixture
    모드에서는 실행하지 않는다(테스트 결정성 유지 — 로컬 데몬 유무에 의존하면 안 됨).

    selection 라인(`qmd_recall_selection`)의 reason·dropped_* 를 그대로 복제해
    라인 하나로 자족하게 만든다. 공통 `recall_id`로 두 라인을 join하는 방식보다
    이쪽을 택한 이유: 진단이 답해야 하는 질문("데몬은 냈는데 왜 0건인가")은 후보
    수와 각 필터의 drop 수를 같은 라인에서 봐야 성립하고, join이 아예 없으면
    동시 hook 실행으로 라인이 뒤섞이는 경우에도 짝을 잘못 맺을 여지가 없다.
    진단 라인이라 필드 중복 비용은 무의미하다.
    """
    if not log_path:
        return
    try:
        deadline = time.monotonic() + SHADOW_TOTAL_BUDGET
        if fixture_path:
            lex_only = {"status": "skipped_fixture"}
            vec_only = {"status": "skipped_fixture"}
            if raw is None:
                raw = {"status": "skipped_fixture"}
        else:
            # lex/vec을 분리 질의해 "어느 쪽이 죽었는지"를 남긴다. qmd 2.5.3의 lex는
            # positive term을 AND로 결합하므로 term 하나가 색인에 없으면 lex 전체가
            # 0건이 된다 — lex_only.count==0이 그 신호다.
            lex_only = run_shadow_query(
                daemon_url, queried_collections,
                [{"type": "lex", "query": lexical_query}], deadline,
            )
            vec_only = run_shadow_query(
                daemon_url, queried_collections,
                [{"type": "vec", "query": vector_query}], deadline,
            )
            if raw is None:
                raw = run_shadow_query(
                    daemon_url, raw_collections,
                    [
                        {"type": "lex", "query": lexical_query},
                        {"type": "vec", "query": vector_query},
                    ],
                    deadline,
                )

        def count_of(block: dict) -> int:
            return block.get("count", 0) if block.get("status") == "ok" else 0

        raw_count = count_of(raw)
        verdict = {
            "selected": len(selected_entries),
            # lex 쿼리에 term이 있는데도 lex 단독 결과가 0 → AND 결합으로 lex가 전멸.
            "lex_dead": bool(lexical_terms) and lex_only.get("status") == "ok" and count_of(lex_only) == 0,
            "vec_dead": vec_only.get("status") == "ok" and count_of(vec_only) == 0,
            # 핵심 판정: 최종적으로 아무것도 주입하지 못했는데 raw엔 있었다.
            # 데몬 후보 수(primary.count)가 아니라 "최종 결과"를 기준으로 본다 —
            # P2가 측정하려는 손실은 대부분 데몬이 결과를 냈는데 후속 필터
            # (minScore 순위 컷 × recallVerifiedOnly × excludeStatuses × topN)가
            # 곱해져 0건이 되는 경우다. primary.count와 dropped_* 를 같이 보면
            # "색인에 없음"과 "필터로 전멸"을 이 라인 안에서 구분할 수 있다.
            "selected_empty_raw_nonempty": not selected_entries and raw_count > 0,
        }
        log_recall_event(
            log_path,
            "shadow",
            event_override="qmd_recall_shadow",
            strategy=strategy or "flat",
            fixture=bool(fixture_path),
            selection_reason=selection_reason,
            dropped_skip=dropped_skip,
            dropped_min_score=dropped_min_score,
            dropped_unverified=dropped_unverified,
            dropped_top_n=dropped_top_n,
            # rerank=False라 score는 1/rank다. 서로 다른 query의 score를 비교하는 것은
            # 무의미하므로(각 query 안에서만 순위 의미) 판정에는 rank/count만 쓴다.
            score_model="1/rank (rerank=false)",
            min_score=active_min_score,
            top_n_limit=top_n,
            lex_query=lexical_query,
            lex_terms=len(lexical_terms),
            vec_query_chars=len(vector_query),
            queried_collections=queried_collections,
            raw_collections=raw_collections,
            shadow_timeout=shadow_query_timeout(),
            primary=primary,
            lex_only=lex_only,
            vec_only=vec_only,
            raw=raw,
            selected=selected_entries,
            verdict=verdict,
        )
    except Exception:  # noqa: BLE001 - 진단 실패가 hook을 죽이면 안 된다
        pass


def main():
    # If QMD_SANDBOX is set or --sandbox option is in sys.argv, exit immediately with no output
    if os.environ.get("QMD_SANDBOX") or "--sandbox" in sys.argv:
        return 0

    # Parse stdin
    raw = sys.stdin.read().strip()
    if not raw:
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0

    prompt = payload.get("prompt", "")
    if len(prompt) < 10:
        return 0

    cwd = payload.get("cwd") or os.getcwd()

    # Read once up front so early-exit paths can record their reason too.
    log_path = os.environ.get("QMD_RECALL_LOG")

    # Load configuration
    config = load_project_config(cwd)
    if not qmd_config.event_enabled(config, payload.get("hook_event_name", "UserPromptSubmit")):
        log_recall_event(log_path, "event_disabled")
        return 0
    
    # Extract keywords + identifiers(정확 토큰) + lexical terms.
    # EP 게이팅과 조립 순서는 keywords.build_lexical_terms가 SSOT다 — CLI(main)와
    # 이 훅 경로가 같은 정책을 쓰게 해서 ep-off일 때 식별자 경로로 EP 용어가
    # 누출되던 불일치를 없앤다. 식별자는 별도 예산(IDENTIFIER_BUDGET)이라
    # 일반 키워드 5개 cap을 건드리지 않는다.
    built_terms = qmd_keywords.build_lexical_terms(
        prompt, config.get("lexicalPatterns", [])
    )
    kw_result_raw = built_terms["keywords"]
    lexical_terms = built_terms["lexicalTerms"]

    # Deduplicate lexical terms
    seen = set()
    deduped_lexical_terms = []
    for term in lexical_terms:
        if term not in seen:
            seen.add(term)
            deduped_lexical_terms.append(term)
            
    if not kw_result_raw and not deduped_lexical_terms:
        log_recall_event(log_path, "no_keywords")
        return 0

    # Query daemon or use fixture
    fixture_path = os.environ.get("QMD_QUERY_FIXTURE")
    results = []
    
    collections = config.get("collections", [])
    if not collections:
        log_recall_event(log_path, "no_collections")
        return 0
    # wikiOnly: wiki role 컬렉션이 하나도 없으면 surface할 게 없다. fixture/live 무관하게
    # 여기서 조기 종료해 raw가 새지 않게 하고 진단 reason도 정확히 남긴다
    # (fixture 경로에서 no_results_after_filter로 잘못 찍히던 오탐 방지).
    if config.get("recallStrategy") == "wikiOnly":
        _roles = config.get("collectionRoles", {}) if isinstance(config.get("collectionRoles"), dict) else {}
        if not any(_roles.get(c) == "wiki" for c in collections):
            log_recall_event(log_path, "no_wiki_collections")
            return 0
    raw_collections = []
    queried_collections = list(collections)
    queried_wiki_first = False
    daemon_url = os.environ.get("QMD_DAEMON_URL", DEFAULT_DAEMON_URL)

    # opt-in 진단(shadow query). env가 없으면 아래 어떤 shadow 코드도 실행되지 않는다.
    shadow_on = shadow_diagnostics_enabled()
    shadow_primary = None
    shadow_raw = None
    shadow_rank_index: dict[str, int] = {}

    # lex/vec 쿼리 문자열은 순수 계산이라 fixture 경로에서도 만들어 둔다(진단 로그용).
    lexical_query = " ".join(deduped_lexical_terms)
    vector_query = re.sub(r"\s+", " ", prompt).strip()

    def query_daemon(query_collections: list[str]) -> list[dict] | None:
        return None

    if fixture_path:
        try:
            with open(fixture_path, "r", encoding="utf-8") as f:
                fixture_data = json.load(f)
                results = fixture_data.get("results", [])
        except (OSError, json.JSONDecodeError):
            log_recall_event(log_path, "fixture_error", fixture=fixture_path)
            return 0
    else:
        if not daemon_alive(daemon_url):
            log_recall_event(log_path, "daemon_unreachable", daemon=daemon_url)
            return 0
        else:
            def query_daemon(query_collections: list[str]) -> list[dict] | None:
                query_payload = {
                    "searches": [
                        {"type": "lex", "query": lexical_query},
                        {"type": "vec", "query": vector_query},
                    ],
                    "collections": query_collections,
                    "limit": 8,
                    "minScore": 0,
                    "timeout": config.get("queryTimeout", QUERY_TIMEOUT),
                    "rerank": False,
                }

                data = json.dumps(query_payload).encode("utf-8")
                req = urllib.request.Request(
                    f"{daemon_url}/query",
                    data=data,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                try:
                    timeout = float(config.get("queryTimeout", QUERY_TIMEOUT))
                    with urllib.request.urlopen(req, timeout=timeout) as resp:
                        body = resp.read().decode("utf-8")
                    parsed = json.loads(body)
                    daemon_results = parsed.get("results", [])
                    return daemon_results if isinstance(daemon_results, list) else []
                except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
                    return None

            strategy = config.get("recallStrategy")
            if strategy in ("hierarchical", "wikiOnly"):
                roles = config.get("collectionRoles", {})
                wiki_collections = [c for c in collections if roles.get(c) == "wiki"]
                raw_collections = [c for c in collections if roles.get(c) != "wiki"]
                if wiki_collections:
                    queried_wiki_first = True
                    queried_collections = list(wiki_collections)
                    results = query_daemon(wiki_collections)
                    if results is None:
                        log_recall_event(log_path, "query_failed", daemon=daemon_url)
                        return 0
                else:
                    # hierarchical without wiki role → flat처럼 전 컬렉션 query.
                    # (wikiOnly + wiki role 없음은 상단에서 이미 조기 종료됨)
                    results = query_daemon(collections)
            else:
                results = query_daemon(collections)

            if results is None:
                log_recall_event(log_path, "query_failed", daemon=daemon_url)
                return 0

    # Log raw score observation if requested (log_path read once near the top)
    if log_path:
        log_score_observation(log_path, results, collections)

    # Inject _collection if missing
    for result in results:
        if "_collection" not in result:
            # 데몬 /query는 file을 qmd:// 스킴 없이 "collection/path"로도 반환한다 —
            # 스킴 전제 파싱이면 wiki 메타(배지·강등·exclude)가 라이브에서 전부 no-op가 된다.
            collection_guess = qmd_uri_to_collection(result.get("file", ""))
            if collection_guess:
                result["_collection"] = collection_guess
        roles = config.get("collectionRoles", {}) if isinstance(config.get("collectionRoles"), dict) else {}
        if roles.get(result.get("_collection", "")) == "wiki":
            wiki_meta = read_wiki_meta(result, config, cwd)
            result["_wiki_status"] = wiki_meta["status"]
            result["_wiki_reviewed"] = wiki_meta["reviewed"]

    # shadow 진단용 primary 스냅샷: 데몬이 돌려준 "순서"와 원래 score를 여기서 굳힌다.
    # 아래 ep promotion이 score를 1.0으로 덮어쓰고 정렬이 순서를 바꾸므로, 그 전에
    # 떠 놓지 않으면 rank 정보가 소실된다. 추가 query 0건(이미 받은 결과 재사용).
    if shadow_on:
        shadow_primary = summarize_shadow_results(results)
        shadow_rank_index = build_rank_index(results)

    if "ep" in config.get("lexicalPatterns", []):
        promote_ep_exact_matches(results, ep_numbers(prompt))

    # Filter and sort results
    # Sort by score descending
    results = sorted(results, key=lambda r: r.get("score", 0), reverse=True)
    
    # Filter based on skipPaths and default .auto-context-ignore
    skip_paths = config.get("skipPaths", [])
    # Always include .auto-context-ignore in skip list
    if ".auto-context-ignore" not in skip_paths:
        skip_paths.append(".auto-context-ignore")
        
    filtered_results = []
    min_score = float(config.get("minScore", 0.0))
    raw_fallback_min_score = float(config.get("rawFallbackMinScore", min_score))
    active_min_score = min_score
    dropped_skip = 0
    dropped_min_score = 0

    # excludeStatusesFromRecall(contested/discarded 등) wiki 카드 제거를 backfill 판정보다
    # "먼저" 적용하기 위한 헬퍼. wiki 히트가 전부 제외 대상이면 filtered_results가 비어
    # hierarchical backfill이 정상 트리거된다(예전엔 exclude가 backfill 뒤라 빈 출력이 됐다).
    compile_cfg = config.get("compile", {}) if isinstance(config.get("compile"), dict) else {}
    roles = config.get("collectionRoles", {}) if isinstance(config.get("collectionRoles"), dict) else {}
    excluded_statuses = set(compile_cfg.get("excludeStatusesFromRecall", ["discarded", "contested"]))
    # recallVerifiedOnly(기본 True): 검수급(_wiki_reviewed) wiki 카드만 surface하고
    # 미검수 generated/tentative는 exclude와 동일하게 backfill 판정 "전"에 제거한다.
    # 이러면 wiki 히트가 전부 미검수여도 filtered_results가 비어 hierarchical backfill이
    # raw 원문으로 정상 fallback한다(미검수 요약 대신 원문 소스 노출 — 의도된 안전 degrade).
    verified_only = bool(compile_cfg.get("recallVerifiedOnly", True))
    # verified_only 필터로 drop된 미검수 wiki 카드 수. 빈 출력이 "미검수 제외" 때문인지
    # 진단 가능하게 log에 노출한다(경로 해석 실패로 검수 카드가 fail-closed drop된
    # misconfiguration도 여기 잡혀 no_results_after_filter의 원인을 특정할 수 있다).
    unverified_counter = [0]

    def drop_excluded_statuses(items):
        kept = []
        for r in items:
            if roles.get(r.get("_collection", "")) != "wiki":
                kept.append(r)
                continue
            if r.get("_wiki_status", "generated") in excluded_statuses:
                continue
            if verified_only and not r.get("_wiki_reviewed", False):
                unverified_counter[0] += 1
                continue
            kept.append(r)
        return kept

    for r in results:
        filepath = r.get("file", "")
        # Drop wiki metadata files (index.md/log.md) -- aggregate noise.
        if is_wiki_meta_noise(r, config):
            dropped_skip += 1
            continue
        # Check skip paths
        should_skip = False
        for skip in skip_paths:
            if skip in filepath:
                should_skip = True
                break
        if should_skip:
            dropped_skip += 1
            continue

        # Check minScore
        if r.get("score", 0) < min_score:
            dropped_min_score += 1
            continue

        filtered_results.append(r)

    # 핵심 수정: exclude를 backfill 판정 "전"에 적용. 이래야 wiki 히트가 전부
    # contested/discarded면 filtered_results가 비어 backfill이 트리거된다.
    filtered_results = drop_excluded_statuses(filtered_results)

    if queried_wiki_first:
        # wiki-scoped 쿼리(hierarchical/wikiOnly가 wiki 컬렉션만 조회) 결과는 정의상 wiki다.
        # _collection이 안 풀려 role이 wiki가 아닌 결과는 status 검증 불가 + raw prefix로
        # 새거나 hierarchical backfill을 막을 수 있어 fail-closed로 drop한다(raw 누출 금지).
        # backfill로 채운 raw 결과에는 적용하지 않는다(그건 정당한 raw다).
        filtered_results = [r for r in filtered_results if roles.get(r.get("_collection", "")) == "wiki"]

    if (
        config.get("recallStrategy") == "hierarchical"
        and queried_wiki_first
        and raw_collections
        and not filtered_results
        and not fixture_path
    ):
        raw_results = query_daemon(raw_collections)
        if raw_results is None:
            log_recall_event(log_path, "query_failed", daemon=daemon_url)
            return 0
        for result in raw_results:
            if "_collection" not in result:
                collection_guess = qmd_uri_to_collection(result.get("file", ""))
                if collection_guess:
                    result["_collection"] = collection_guess
            roles = config.get("collectionRoles", {}) if isinstance(config.get("collectionRoles"), dict) else {}
            if roles.get(result.get("_collection", "")) == "wiki":
                wiki_meta = read_wiki_meta(result, config, cwd)
                result["_wiki_status"] = wiki_meta["status"]
                result["_wiki_reviewed"] = wiki_meta["reviewed"]
        # backfill이 이미 raw를 질의했으면 shadow는 그 결과를 재사용한다(중복 query 방지).
        if shadow_on:
            shadow_raw = summarize_shadow_results(raw_results)
            # backfill이면 최종 선택은 raw에서 나오므로 original_rank도 raw 기준이다.
            shadow_rank_index.update(build_rank_index(raw_results))
        if "ep" in config.get("lexicalPatterns", []):
            promote_ep_exact_matches(raw_results, ep_numbers(prompt))
        results = sorted(raw_results, key=lambda r: r.get("score", 0), reverse=True)
        filtered_results = []
        active_min_score = raw_fallback_min_score
        dropped_skip = 0
        dropped_min_score = 0
        for r in results:
            filepath = r.get("file", "")
            if is_wiki_meta_noise(r, config):
                dropped_skip += 1
                continue
            should_skip = False
            for skip in skip_paths:
                if skip in filepath:
                    should_skip = True
                    break
            if should_skip:
                dropped_skip += 1
                continue
            if r.get("score", 0) < raw_fallback_min_score:
                dropped_min_score += 1
                continue
            filtered_results.append(r)
        # backfill된 raw 결과에도 동일 필터 적용(raw엔 no-op이나 일관성 유지).
        filtered_results = drop_excluded_statuses(filtered_results)

    if config.get("recallStrategy") == "wikiOnly":
        # wikiOnly: raw는 절대 surface하지 않는다. 라이브 경로에선 wiki만 query해 이미
        # wiki뿐이지만, fixture 등으로 raw가 섞여 들어와도 여기서 엄격 제거한다.
        filtered_results = [r for r in filtered_results if roles.get(r.get("_collection", "")) == "wiki"]
    elif config.get("recallStrategy") == "hierarchical":
        wiki_results = [r for r in filtered_results if roles.get(r.get("_collection", "")) == "wiki"]
        if wiki_results:
            filtered_results = wiki_results

    # lowPriorityStatuses 강등: 미검수 low-priority wiki 카드를 topN 절단 전에 뒤로 보낸다.
    # score 내림차순 위의 안정 정렬이라 그룹 내 순위는 유지되고, 검수 카드가
    # 저점수여도 미검수 generated 카드에 topN 슬롯을 뺏기지 않는다.
    low_priority = set(compile_cfg.get("lowPriorityStatuses", ["generated", "tentative"]))
    filtered_results.sort(
        key=lambda r: r.get("_wiki_status") in low_priority and not r.get("_wiki_reviewed", False)
    )

    # Limit to topN
    top_n = int(config.get("topN", 3))
    final_results = filtered_results[:top_n]

    # Record why recall produced (or withheld) output — file-only, never stdout.
    selection_reason = "selected" if final_results else "no_results_after_filter"
    dropped_top_n = max(0, len(filtered_results) - len(final_results))
    log_recall_event(
        log_path,
        selection_reason,
        candidates=len(results),
        dropped_skip=dropped_skip,
        dropped_min_score=dropped_min_score,
        dropped_unverified=unverified_counter[0],
        dropped_top_n=dropped_top_n,
        selected=len(final_results),
        min_score=active_min_score,
        top_n_limit=top_n,
        max_score=max((r.get("score", 0) for r in results), default=0),
    )

    # Output formatted JSON. shadow 진단보다 "먼저" 출력해, 진단이 어떤 이유로 지연·
    # 실패하더라도 본 recall 결과가 구조적으로 영향받지 않게 한다.
    if final_results:
        output = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": format_context(final_results, resolve_prefix_style(config), config.get("collectionRoles", {}))
            }
        }
        print(json.dumps(output, ensure_ascii=False))

    if shadow_on:
        log_shadow_diagnostics(
            log_path,
            daemon_url=daemon_url,
            strategy=config.get("recallStrategy", "flat"),
            fixture_path=fixture_path,
            lexical_query=lexical_query,
            lexical_terms=deduped_lexical_terms,
            vector_query=vector_query,
            queried_collections=queried_collections,
            raw_collections=raw_collections,
            primary=shadow_primary or {"status": "no_primary"},
            raw=shadow_raw,
            selected_entries=describe_selected(final_results, shadow_rank_index),
            active_min_score=active_min_score,
            top_n=top_n,
            selection_reason=selection_reason,
            dropped_skip=dropped_skip,
            dropped_min_score=dropped_min_score,
            dropped_unverified=unverified_counter[0],
            dropped_top_n=dropped_top_n,
        )
    return 0

if __name__ == "__main__":
    import hook_main
    sys.exit(hook_main.run(main))
