#!/usr/bin/env python3
"""raw 인덱스가 wiki 후보를 전역 창에서 밀어내는지(crowding) 반복 측정하는 진단 CLI.

로드맵 5단계. 근거는 `docs/plans/2026-07-30-raw-index-crowding-measurement.md`이고,
8단계(raw 제거)가 **제거 전/후를 같은 방법으로** 비교할 수 있게 그 수동 측정을
프로젝트 단위로 재현 가능하게 굳힌 것이다.

## 왜 hook(`QMD_SHADOW_QUERY`) 확장이 아니라 별도 CLI인가

기존 shadow 진단과 목적이 겹치지 않는다 — 재사용은 **코드 수준**(daemon 질의 형태,
frontmatter 파서, 로그 append)에서 하고 실행 경로는 분리한다:

1. **질의가 blocking hook 예산에 들어갈 수 없다.** shadow의 하위 질의는 전부
   `limit: 8` + 컬렉션 필터이고 총 예산 2.5s다. crowding 측정은 정반대로
   **필터 없는 전역 질의**를 `limit: 200`으로, 게다가 창 천장을 찾으려 limit 사다리
   (8/20/60/200)까지 돌린다. UserPromptSubmit을 막는 경로에 둘 수 없다.
2. **프로브가 재현 가능해야 한다.** shadow의 프로브는 사용자가 그때 입력한 프롬프트라
   두 번 같은 값이 나오지 않는다. 8단계의 전/후 비교는 **같은 프로브**를 요구한다.
   여기서는 프로젝트 wiki 카드 title에서 결정적으로 표집하고(정렬 + 균등 stride),
   뽑힌 문자열을 레코드에 남겨 `--probe`로 축자 재생할 수 있게 한다.
3. **답해야 하는 질문이 다르다.** shadow는 "이 recall이 무엇을 잃었나"(프롬프트 의존),
   여기는 "인덱스 구성이 전역 창에서 wiki를 밀어내나"(프롬프트 무의존). 후자는
   필터 없는 질의 대 필터 질의의 대조가 본질이고 shadow는 그 대조를 하지 않는다
   (항상 collections를 넘긴다).
4. **산출물 형태가 다르다.** shadow는 프롬프트마다 로그 한 줄, 여기는 프로젝트 단위
   스냅샷이라 전/후 두 줄을 나란히 놓고 diff해야 한다.

이 모듈은 어떤 hook에서도 import되지 않는다 — blocking hook 비용은 **구조적으로 0**이다.

## 판정 — 창 점유와 recall 피해를 **분리**한다

프로브 하나에 대해 같은 검색을 (a) 필터 없이 (b) 프로젝트 wiki 컬렉션으로 필터해서,
두 limit에서 각각 비교한다(질의 4회). 필터 결과에 전역 창에 없던 문서가 **새로
등장하면** 필터가 그 창 이전에 적용된 것이다.

두 층이 갈리고, 이 도구는 갈린 채로 보고한다:

- `windowCrowding` — 엔진 **내부 창**(deep limit)을 비-wiki가 점유하는가. 원 측정이
  본 값이고, 여기서도 재현된다(필터 시 새 문서 0 = 창 이후 필터).
- `recallStarvation` — 그 점유가 **recall이 실제로 받는 후보 수를 줄이는가**. raw
  제거의 이득은 이쪽에만 있다.

**둘은 실제로 갈린다.** recall은 `limit: 8`로 질의하는데(`recall.DAEMON_QUERY_LIMIT`),
그 limit에서는 wiki 필터 질의가 전역 창에 없던 문서를 새로 내놓는다(실측:
service-engineering vec 전역 8칸 중 wiki 3칸 → wiki 필터 8칸, 새로 등장 5). 즉 내부
창 21~28칸을 raw가 먹어도, 도달 가능한 wiki pool이 8보다 크면 recall은 굶지 않는다.
피해는 `wikiPoolDeep < recallLimit`일 때만 생기고 그 부족분이 `starvedSlots`다.

**창 점유율만 보고 "recall이 10배 손해"라고 읽으면 안 된다** — 그 추론은 recall의
limit이 내부 창과 같다는 전제를 요구하고, 실제로는 8 대 21~28이다.

프로브 종류를 둘로 나눈다: 카드 title은 너무 좁아 내부 창을 채우지 못하므로(실측
점유 1~2칸) **wiki 코퍼스 상위 빈도 어휘**로 만든 넓은 프로브가 판정을 담당하고,
title 프로브는 "평상시 좁은 질의에서는 무슨 일이 일어나는가"를 같은 레코드에 남긴다
(`narrowProbeSummary`).
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import keywords as qmd_keywords
import recall as qmd_recall

SCHEMA = "qmd_crowding_probe/1"

DEFAULT_PROBES = 3
DEFAULT_TITLE_PROBES = 2
# 엔진 내부 창을 드러내는 큰 limit. recall limit은 recall.DAEMON_QUERY_LIMIT를 쓴다
# (리터럴을 복제하면 측정과 실제 recall이 갈린다).
DEFAULT_DEEP_LIMIT = 200
# 넓은 프로브 하나에 넣는 상위 빈도 토큰 수.
VOCAB_TOKENS_PER_PROBE = 4
DEFAULT_QUERY_TIMEOUT = 15.0
# 데몬은 single-thread(Node)다. 연속 질의로 폭격하면 같은 데몬을 쓰는 recall hook이
# 직렬로 밀려 queryTimeout에 걸린다 — 질의 사이에 최소 간격을 둔다.
DEFAULT_INTERVAL = 0.2
DEFAULT_BUDGET = 180.0
# 창 천장 탐색 사다리. 21에서 천장에 닿는 실측(vec)을 재현할 수 있는 최소 집합이다.
CEILING_LIMITS = (8, 20, 60, 200)
# 프로브로 쓸 title의 최대 길이(질의 문자열). 카드 title은 신뢰 입력이 아니다.
MAX_PROBE_CHARS = 120
WIKI_META_BASENAMES = ("index.md", "log.md")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- qmd CLI


def resolve_qmd_bin() -> str | None:
    """qmd 실행 파일 경로. 해석 규칙은 `core/qmd_path.sh`가 SSOT라 그것을 source한다.

    파이썬에 후보 디렉터리 목록을 복제하면 두 벌이 갈린다(fnm/nvm 버전 정렬까지 있다).
    """
    script = Path(__file__).parent / "qmd_path.sh"
    if not script.is_file():
        return None
    try:
        proc = subprocess.run(
            ["bash", "-c", f'. "{script}" && resolve_qmd_bin'],
            capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    path = (proc.stdout or "").strip().splitlines()
    return path[-1] if proc.returncode == 0 and path else None


def parse_collection_list(text: str) -> dict[str, int]:
    """`qmd collection list` 텍스트 출력 → {컬렉션명: 파일 수}.

    `--json`이 없어서 텍스트를 판다. 형식이 바뀌면 빈 dict가 되고 호출부는 인덱스
    구성을 `unavailable`로 남긴 채 창 측정을 계속한다(fail-open).
    """
    counts: dict[str, int] = {}
    current: str | None = None
    for line in text.split("\n"):
        if not line.startswith((" ", "\t")):
            name, sep, rest = line.partition(" (qmd://")
            current = name.strip() if sep and name.strip() else None
            if current:
                counts.setdefault(current, 0)
            continue
        stripped = line.strip()
        if current and stripped.startswith("Files:"):
            value = stripped.split(":", 1)[1].strip()
            try:
                counts[current] = int(value)
            except ValueError:
                pass
    return counts


def collection_root(qmd_bin: str, name: str) -> str | None:
    """`qmd collection show <name>`의 Path. 외부 컬렉션의 role을 알아내는 유일한 단서다."""
    try:
        proc = subprocess.run(
            [qmd_bin, "collection", "show", name],
            capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    for line in (proc.stdout or "").split("\n"):
        stripped = line.strip()
        if stripped.startswith("Path:"):
            return stripped.split(":", 1)[1].strip() or None
    return None


def index_composition(qmd_bin: str | None, project_roles: dict[str, str],
                      wiki_names: set[str]) -> dict:
    """전역 인덱스의 컬렉션·파일 수와 **role별 집계**.

    측정 대상 프로젝트 밖 컬렉션의 role은 그 컬렉션 root에서 상향 탐색해 그 프로젝트의
    `collectionRoles`를 읽어 얻는다(`config.find_project_config` 재사용). 이름 규칙
    (`*-wiki`)으로 추측하지 않는다 — 추측은 baseline에 거짓 수치를 굳힌다. 알 수 없으면
    `unknown`으로 남긴다.
    """
    if not qmd_bin:
        return {"status": "qmd_cli_unavailable"}
    try:
        proc = subprocess.run(
            [qmd_bin, "collection", "list"], capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return {"status": "qmd_cli_error"}
    if proc.returncode != 0:
        return {"status": "qmd_cli_error", "exitCode": proc.returncode}
    counts = parse_collection_list(proc.stdout or "")
    if not counts:
        return {"status": "unparsed"}
    roles: dict[str, str] = {}
    by_role: dict[str, int] = {}
    for name, files in counts.items():
        if name in project_roles:
            role = project_roles[name] or "unknown"
        else:
            root = collection_root(qmd_bin, name)
            role = "unknown"
            if root:
                found = qmd_config.find_project_config(root)
                external_roles = found.get("config", {}).get("collectionRoles", {})
                if isinstance(external_roles, dict) and external_roles.get(name):
                    role = external_roles[name]
        roles[name] = role
        by_role[role] = by_role.get(role, 0) + files
    total = sum(counts.values())
    return {
        "status": "ok",
        "collections": len(counts),
        "files": total,
        "byRole": by_role,
        "byCollection": counts,
        "roleByCollection": roles,
        "projectWikiFiles": sum(counts.get(n, 0) for n in wiki_names),
        "roleSource": "project-config + per-collection root lookup",
    }


# ---------------------------------------------------------------- probes


def card_title(path: Path) -> str:
    """wiki 카드 frontmatter의 title. 파서는 recall과 같은 것을 쓴다(규칙 SSOT)."""
    limit = qmd_recall.wiki_card_read_limit(0)
    try:
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as handle:
            raw_text = handle.read(limit)
    except (OSError, ValueError):
        return ""
    text = qmd_recall.normalize_newlines(raw_text)
    if not text.startswith("---"):
        return ""
    end = text.find("\n---", 3)
    if end == -1:
        return ""
    fields = qmd_recall.parse_frontmatter_scalars(text[3:end])
    return qmd_recall.sanitize_inline(fields.get("title", ""))[:MAX_PROBE_CHARS]


def collect_card_titles(wiki_root: Path, skip_paths: list[str]) -> list[tuple[str, str]]:
    """(title, wiki_root 상대경로) 목록. 경로 정렬이라 회차 간 순서가 안정적이다."""
    try:
        files = sorted(
            p for p in wiki_root.rglob("*.md")
            if p.is_file()
            and p.name not in WIKI_META_BASENAMES
            and not any(skip in p.as_posix() for skip in skip_paths)
        )
    except OSError:
        return []
    titled: list[tuple[str, str]] = []
    for path in files:
        title = card_title(path)
        if len(title) >= 4:
            try:
                rel = path.relative_to(wiki_root).as_posix()
            except ValueError:
                rel = path.name
            titled.append((title, rel))
    return titled


def vocab_probes(titles: list[str], count: int) -> list[dict]:
    """wiki 코퍼스 title의 **상위 빈도 어휘**로 넓은 프로브를 만든다.

    창 포화가 crowding 판정의 전제이고, 좁은 질의는 창을 채우지 못한다(카드 title
    프로브 실측 2·20·1칸). 고빈도 어휘는 정의상 많은 문서와 매칭하므로 창을 채운다
    (실측: 상위 4토큰 프로브가 vec 28칸 — 엔진 상한 절단).

    토큰화는 `keywords.extract_keywords`를 그대로 쓴다(불용어·한국어 접미 규칙 SSOT).
    순위는 (빈도 내림, 토큰 오름)으로 **동수까지 결정적**이고, 겹치지 않는 창으로
    잘라 서로 다른 넓은 프로브를 만든다.
    """
    if count <= 0 or not titles:
        return []
    counter: collections.Counter = collections.Counter()
    for title in titles:
        for token in qmd_keywords.extract_keywords(title):
            token = token.lower()
            if len(token) >= 2:
                counter[token] += 1
    ranked = [token for token, _ in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))]
    probes = []
    for index in range(count):
        window = ranked[index * VOCAB_TOKENS_PER_PROBE:(index + 1) * VOCAB_TOKENS_PER_PROBE]
        if not window:
            break
        probes.append({
            "query": " ".join(window),
            # lex는 한 문자열 안의 positive term을 **AND로 결합**한다(CLAUDE.md / store.js
            # `positive.join(' AND ')`). 4토큰을 그대로 lex로 보내면 한 문서가 넷을 다
            # 가져야 해 오히려 가장 좁은 질의가 된다(실측: 넓은 vec 프로브의 lex 결과가
            # wiki 2건). 그래서 lex 질의는 그 그룹의 **최빈 토큰 하나**로 보낸다.
            "lexQuery": window[0],
            "card": None,
            "source": "wiki_vocab",
            "kind": "broad",
            "tokens": window,
            "tokenCounts": [counter[t] for t in window],
        })
    return probes


def title_probes(titled: list[tuple[str, str]], count: int) -> list[dict]:
    """카드 title에서 **결정적으로** 표집한 좁은 프로브.

    고정 목록은 프로젝트마다 무의미하고 실제 프롬프트는 재현되지 않는다. 정렬 +
    균등 stride라 같은 코퍼스에서 항상 같은 값이 나온다. 판정용이 아니라 "평상시
    좁은 질의에서 창이 포화되는가"를 같은 레코드에 남기기 위한 대조군이다.
    """
    if count <= 0 or not titled:
        return []
    if len(titled) <= count:
        picked = titled
    else:
        span = len(titled) - 1
        indices = sorted({round(i * span / (count - 1)) if count > 1 else 0
                          for i in range(count)})
        picked = [titled[i] for i in indices]
    return [{"query": title, "card": rel, "source": "wiki_title", "kind": "narrow"}
            for title, rel in picked]


# ---------------------------------------------------------------- daemon


class Budget:
    """질의 수·간격·전체 wall-clock을 한곳에서 유계로 만든다."""

    def __init__(self, interval: float, budget: float) -> None:
        self.interval = max(0.0, interval)
        self.deadline = time.monotonic() + max(0.0, budget)
        self.queries = 0
        self._last = 0.0

    def exhausted(self) -> bool:
        return time.monotonic() >= self.deadline

    def before_query(self) -> None:
        if self._last:
            wait = self.interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
        self._last = time.monotonic()
        self.queries += 1


def query_daemon(daemon_url: str, searches: list[dict], collections: list[str] | None,
                 limit: int, timeout: float, budget: Budget) -> dict:
    """1회 질의. 실패는 예외가 아니라 status 문자열로만 남긴다(진단은 절대 죽지 않는다).

    `collections`가 None이면 전역(필터 없음)이다 — 이 대조가 측정의 본질이라
    키를 생략하는 경로를 반드시 유지해야 한다.
    """
    if budget.exhausted():
        return {"status": "budget_exhausted"}
    payload: dict = {
        "searches": searches,
        "limit": limit,
        "minScore": 0,
        "timeout": timeout,
        "rerank": False,
    }
    if collections is not None:
        if not collections:
            return {"status": "no_collections"}
        payload["collections"] = list(collections)
    budget.before_query()
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
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return {"status": "unavailable"}
    if not isinstance(results, list):
        return {"status": "bad_response"}
    # 결과 수를 `files` 길이로 센다 — `file`이 없는 항목은 컬렉션 귀속이 불가해 창 구성
    # 집계에 쓸 수 없다. len(results)를 따로 두면 두 카운트가 갈려 오독을 만든다.
    files = []
    for result in results:
        if isinstance(result, dict):
            file = result.get("file")
            if isinstance(file, str) and file:
                files.append(file)
    return {"status": "ok", "count": len(files), "files": files}


def window_composition(files: list[str], known: dict[str, str],
                       wiki_names: set[str]) -> dict:
    """전역 창의 컬렉션·role 구성. 데몬 `file`은 `collection/path`(스킴 없음)로도 온다."""
    by_collection: dict[str, int] = {}
    by_role: dict[str, int] = {}
    for file in files:
        collection = qmd_recall.qmd_uri_to_collection(file)
        by_collection[collection] = by_collection.get(collection, 0) + 1
        role = known.get(collection, "unknown")
        by_role[role] = by_role.get(role, 0) + 1
    return {
        "byCollection": by_collection,
        "byRole": by_role,
        "projectWikiSlots": sum(by_collection.get(n, 0) for n in wiki_names),
    }


def measure_path(daemon_url: str, path_type: str, probe_query: str,
                 wiki_collections: list[str], known_roles: dict[str, str],
                 wiki_names: set[str], recall_limit: int, deep_limit: int,
                 timeout: float, budget: Budget) -> dict:
    """한 프로브 × 한 경로(vec|lex): 두 limit × {전역, wiki 필터} = 질의 4회.

    **recall_limit(=recall이 실제로 쓰는 limit)에서 재는 것이 본체다.** crowding이
    recall을 해치는 유일한 경로는 "wiki 후보가 recall의 칸 수를 못 채우는 것"이므로,
    deep_limit(엔진 내부 창)만 재면 창 점유율은 나오지만 **피해 여부는 나오지 않는다**.

    deep_limit 쌍은 두 가지를 준다: (a) 엔진 내부 창의 크기·컬렉션 구성(이 문서군의
    원 측정과 대조 가능), (b) `wikiPoolDeep` — 창을 통해 도달 가능한 wiki 문서 총량.
    이 pool이 recall_limit보다 작을 때만 raw 제거가 recall에 칸을 더 줄 수 있다.
    """
    searches = [{"type": path_type, "query": probe_query}]
    blocks = {
        "globalRecall": query_daemon(
            daemon_url, searches, None, recall_limit, timeout, budget),
        "filteredRecall": query_daemon(
            daemon_url, searches, wiki_collections, recall_limit, timeout, budget),
        "globalDeep": query_daemon(
            daemon_url, searches, None, deep_limit, timeout, budget),
        "filteredDeep": query_daemon(
            daemon_url, searches, wiki_collections, deep_limit, timeout, budget),
    }
    entry: dict = {
        "recallLimit": recall_limit,
        "deepLimit": deep_limit,
        "statuses": {name: block.get("status") for name, block in blocks.items()},
    }
    if any(block.get("status") != "ok" for block in blocks.values()):
        entry["informative"] = False
        entry["skipReason"] = "query_failed"
        return entry

    files = {name: block.get("files", []) for name, block in blocks.items()}
    for name in ("globalRecall", "globalDeep"):
        entry[name] = {"slots": len(files[name])}
        entry[name].update(window_composition(files[name], known_roles, wiki_names))
    for name, global_name in (("filteredRecall", "globalRecall"),
                              ("filteredDeep", "globalDeep")):
        seen = set(files[global_name])
        entry[name] = {
            "count": len(files[name]),
            "newVsGlobal": len([f for f in files[name] if f not in seen]),
        }

    recall_filled = entry["filteredRecall"]["count"]
    pool_deep = entry["filteredDeep"]["count"]
    entry["recallSlotsFilled"] = recall_filled
    entry["recallSlotsUnfilled"] = max(0, recall_limit - recall_filled)
    entry["wikiPoolDeep"] = pool_deep
    # recall limit에서 필터가 창 **이전**에 적용된다(= 창에 없던 wiki 문서가 등장).
    # 이것이 참이면 recall은 전역 경쟁 결과와 무관하게 자기 limit만큼 wiki 후보를 받는다
    # — 즉 raw가 전역 창을 얼마나 점유하든 recall은 그만큼 굶지 않는다.
    entry["filterBeforeRecallWindow"] = entry["filteredRecall"]["newVsGlobal"] > 0
    # 엔진 내부 창(deep)에서 필터가 창 이후인가. 창에 비-wiki가 하나도 없으면 걸러낼
    # 것이 없어 "새로 등장 0"이 공허하게 참이 된다 → 그 경우는 undetermined(None)다.
    non_wiki_deep = entry["globalDeep"]["slots"] - entry["globalDeep"]["projectWikiSlots"]
    entry["deepWindowNonWikiSlots"] = non_wiki_deep
    entry["deepFilterAfterWindow"] = (
        None if non_wiki_deep == 0 else entry["filteredDeep"]["newVsGlobal"] == 0)
    # raw 제거가 recall에 칸을 더 줄 수 있는 조건: 도달 가능한 wiki pool이 recall limit
    # 보다 작을 때. 다만 **되찾을 수 있는 칸은 비-wiki가 점유한 칸을 넘지 못한다** —
    # 창이 전부 wiki인데 pool이 2건이면 매칭 문서가 2건뿐인 것이고 raw와 무관하다
    # (좁은 프로브에서 pool 2 / 비-wiki 0인데 6칸 굶었다고 세던 오산).
    entry["poolBelowRecallLimit"] = pool_deep < recall_limit
    entry["starvedSlots"] = min(
        max(0, recall_limit - min(recall_limit, pool_deep)), non_wiki_deep)
    entry["informative"] = entry["globalDeep"]["slots"] > 0
    if not entry["informative"]:
        entry["skipReason"] = "no_global_results"
    return entry


def ceiling_ladder(daemon_url: str, probe_query: str, timeout: float,
                   budget: Budget) -> dict:
    """limit을 올려도 결과가 늘지 않는 지점 = 내부 창 크기. 실행당 1회, vec 경로만.

    lex는 컬렉션당 상한이 따로 있어 전역 사다리로는 창을 특정할 수 없다.
    """
    searches = [{"type": "vec", "query": probe_query}]
    counts: dict[str, int] = {}
    for limit in CEILING_LIMITS:
        block = query_daemon(daemon_url, searches, None, limit, timeout, budget)
        counts[str(limit)] = (
            block.get("count", 0) if block.get("status") == "ok" else None)
    measured = [(limit, counts[str(limit)]) for limit in CEILING_LIMITS
                if counts[str(limit)] is not None]
    plateau_count = measured[-1][1] if measured else None
    # 천장은 "최종 count에 처음 도달한 limit"이다. 직전 rung과 같아진 지점을 쓰면
    # 마지막 rung을 가리켜(8→20→21→21에서 200) 창 크기를 21이 아니라 200처럼 읽힌다.
    plateau_from = next(
        (limit for limit, count in measured if count == plateau_count), None)
    return {
        "path": "vec",
        "probe": probe_query,
        "counts": counts,
        "plateauCount": plateau_count,
        "plateauFromLimit": plateau_from,
        "limitBound": bool(measured) and plateau_count >= CEILING_LIMITS[-1],
        "note": "plateauCount = 내부 창이 낸 문서 수. plateauFromLimit부터 limit을 "
                "올려도 늘지 않는다. limitBound면 사다리 최대 limit에 걸려 천장을 못 봤다.",
    }


# ---------------------------------------------------------------- verdict


def summarize_path(entries: list[dict]) -> dict:
    """경로 하나의 판정. 두 층을 **분리해서** 낸다.

    - `windowCrowding`: 엔진 내부 창을 비-wiki가 점유하는가(구성 사실).
    - `recallStarvation`: 그 점유가 **recall이 받는 칸 수를 실제로 줄이는가**(피해).
      raw 제거의 이득은 이쪽에만 있다. 두 값이 갈릴 수 있고 실제로 갈린다 —
      창은 raw가 먹었는데 wiki pool이 recall limit보다 크면 recall은 굶지 않는다.
    """
    informative = [e for e in entries if e.get("informative")]
    starved = [e for e in informative if e.get("starvedSlots", 0) > 0]
    summary: dict = {
        "probesMeasured": len(entries),
        "probesInformative": len(informative),
        "skipReasons": sorted({e["skipReason"] for e in entries if e.get("skipReason")}),
        "recallLimit": informative[0]["recallLimit"] if informative else None,
        # recall이 실제로 쓰는 limit에서의 전역 창 점유(칸 수)
        "recallWindowSlots": [e["globalRecall"]["slots"] for e in informative],
        "recallWindowWikiSlots": [e["globalRecall"]["projectWikiSlots"] for e in informative],
        # 엔진 내부 창(deep)의 점유 — 원 측정과 대조 가능한 값
        "deepWindowSlots": [e["globalDeep"]["slots"] for e in informative],
        "deepWindowWikiSlots": [e["globalDeep"]["projectWikiSlots"] for e in informative],
        "deepWindowNonWikiSlots": [e["deepWindowNonWikiSlots"] for e in informative],
        # recall이 실제로 받는 것
        "recallSlotsFilled": [e["recallSlotsFilled"] for e in informative],
        "wikiPoolDeep": [e["wikiPoolDeep"] for e in informative],
        "starvedSlots": [e["starvedSlots"] for e in informative],
        "probesFilterBeforeRecallWindow": len(
            [e for e in informative if e.get("filterBeforeRecallWindow")]),
        "probesDeepFilterAfterWindow": len(
            [e for e in informative if e.get("deepFilterAfterWindow") is True]),
        "probesDeepFilterUndetermined": len(
            [e for e in informative if e.get("deepFilterAfterWindow") is None]),
        "probesStarved": len(starved),
    }
    if not informative:
        summary["windowCrowding"] = None
        summary["recallStarvation"] = None
        summary["basis"] = "undetermined: 전역 질의가 결과를 내지 못했다"
        return summary
    non_wiki = sum(summary["deepWindowNonWikiSlots"])
    summary["windowCrowding"] = bool(
        non_wiki > 0 and summary["probesDeepFilterAfterWindow"] > 0)
    summary["recallStarvation"] = bool(starved)
    if starved:
        summary["basis"] = (
            f"프로브 {len(starved)}/{len(informative)}에서 도달 가능한 wiki pool이 "
            f"recall limit보다 작다 → raw 제거가 그 칸을 채울 수 있다(제거 후 확인 필요)")
    elif summary["windowCrowding"]:
        summary["basis"] = (
            "엔진 내부 창은 비-wiki가 점유하지만(창 이후 필터), 도달 가능한 wiki pool이 "
            "recall limit 이상이라 recall이 받는 칸 수는 줄지 않는다")
    else:
        summary["basis"] = "전역 창 점유도 recall 칸 손실도 관측되지 않는다"
    return summary


LIMITATIONS = [
    "이 머신의 전역 인덱스 구성 한 회차 측정이다. raw:wiki 비율이 다른 프로젝트에서는 창 점유율이 달라진다.",
    "측정 대상 프로젝트 밖 컬렉션의 role은 그 컬렉션 root에서 settings.json을 찾아 읽는다 — 설정 파일이 없는 레거시 컬렉션은 unknown이다(추측하지 않는다). 판정 산식은 영향받지 않는다: 비-wiki 칸 수를 '전체 - 프로젝트 wiki'로 세므로 unknown은 정확히 비-wiki로 집계된다.",
    "raw 제거 후 실제로 wiki가 창을 채우는지는 제거해야 확인된다(8단계). 창 구성이 인덱스 구성에 비례한다는 관측에서 추론한 값이다.",
    "rerank=True 경로는 측정하지 않는다 — recall이 rerank:false로 질의하므로 측정도 같은 경로만 본다.",
    "프로브는 wiki 코퍼스에서 결정적으로 파생한다(넓은 프로브=상위 빈도 어휘, 좁은 프로브=카드 title). 실제 사용자 프롬프트 분포가 아니며, 카드가 추가/삭제되면 같은 count에서도 파생 결과가 달라진다 — 전/후를 축자 동일 프로브로 비교하려면 이전 레코드의 probes[].query를 --probe로 넘긴다.",
    "starvedSlots는 '창 이후 필터'라는 관측을 전제로 한 상한 추정이다 — raw가 없으면 그 칸이 wiki로 채워진다는 보장이 아니라, 채워질 수 있는 칸 수다. 실제 충족은 제거 후에만 확인된다.",
    "판정은 넓은 프로브만 쓴다. 좁은 프로브는 내부 창을 채우지 못해 구조적으로 피해가 0이고 narrowProbeSummary에 따로 남는다.",
    "lex 질의는 그룹의 최빈 토큰 하나만 보낸다(qmd가 한 lex 문자열의 term을 AND 결합하므로). vec 질의는 토큰 전체를 보낸다 — 두 경로의 질의 문자열이 다르므로 경로 간 절대 비교는 하지 않는다.",
    "lex 경로의 crowding 없음은 현재 인덱스 크기에서의 결과다. FTS 창 대비 인덱스가 커지면 vec과 같은 문제를 겪는다.",
]


def build_record(project_dir: str, args: argparse.Namespace) -> dict:
    found = qmd_config.find_project_config(project_dir)
    config = found.get("config", {})
    project_root = found.get("projectRoot", project_dir)
    collections = config.get("collections", []) or []
    roles = config.get("collectionRoles", {})
    if not isinstance(roles, dict):
        roles = {}
    wiki_collections = [c for c in collections if roles.get(c) == "wiki"]
    raw_collections = [c for c in collections if roles.get(c) != "wiki"]
    wiki_names = set(wiki_collections)
    record: dict = {
        "ts": now_iso(),
        "schema": SCHEMA,
        "label": args.label or "",
        "project": {
            "root": project_root,
            "name": config.get("name", ""),
            "configPath": found.get("configPath"),
            "recallStrategy": config.get("recallStrategy", "hierarchical"),
            "collections": list(collections),
            "wikiCollections": wiki_collections,
            "rawCollections": raw_collections,
        },
        "limits": {
            "recallLimit": args.recall_limit,
            "recallLimitIsRecallDefault": args.recall_limit == qmd_recall.DAEMON_QUERY_LIMIT,
            "deepLimit": args.deep_limit,
            "queryTimeout": args.timeout,
            "interval": args.interval,
            "budget": args.budget,
        },
        "limitations": LIMITATIONS,
    }
    if not collections:
        record["status"] = "no_collections"
        return record
    if not wiki_collections:
        record["status"] = "no_wiki_collections"
        return record

    daemon_url = os.environ.get("QMD_DAEMON_URL", qmd_recall.DEFAULT_DAEMON_URL)
    record["daemon"] = daemon_url
    qmd_bin = None if args.no_index_composition else resolve_qmd_bin()
    record["index"] = (
        {"status": "skipped"} if args.no_index_composition
        else index_composition(qmd_bin, roles, wiki_names)
    )
    known_roles = dict(record["index"].get("roleByCollection", {})) if isinstance(
        record["index"].get("roleByCollection"), dict) else {}
    for name, role in roles.items():
        known_roles[name] = role

    if args.probe:
        probes = [{"query": q, "card": None, "source": "explicit", "kind": "explicit"}
                  for q in args.probe]
    else:
        wiki_root = (Path(project_root) / config.get("wikiPath", ".auto-context/wiki"))
        titled = collect_card_titles(wiki_root, config.get("skipPaths", []) or [])
        record["wikiCardsWithTitle"] = len(titled)
        probes = (vocab_probes([t for t, _ in titled], args.probes)
                  + title_probes(titled, args.title_probes))
    record["probes"] = probes
    if not probes:
        record["status"] = "no_probes"
        return record

    if not qmd_recall.daemon_alive(daemon_url):
        record["status"] = "daemon_unreachable"
        return record

    budget = Budget(args.interval, args.budget)
    if args.ceiling:
        record["ceiling"] = ceiling_ladder(
            daemon_url, probes[0]["query"], args.timeout, budget)

    measured = []
    for probe in probes:
        entry: dict = {
            "query": probe["query"],
            "lexQuery": probe.get("lexQuery") or probe["query"],
            "card": probe.get("card"),
            "kind": probe.get("kind", "explicit"),
        }
        for path_type in ("vec", "lex"):
            entry[path_type] = measure_path(
                daemon_url, path_type,
                entry["lexQuery"] if path_type == "lex" else entry["query"],
                wiki_collections, known_roles, wiki_names,
                args.recall_limit, args.deep_limit, args.timeout, budget)
        measured.append(entry)
    record["measurements"] = measured
    # 판정은 **넓은 프로브**만 쓴다. 좁은 프로브는 창을 채우지 못해 구조적으로
    # undetermined이고, 판정 집계에 섞으면 넓은 프로브의 신호를 희석한다.
    verdict_kinds = {"broad", "explicit"}
    verdict_set = [m for m in measured if m["kind"] in verdict_kinds] or measured
    record["summary"] = {
        path_type: summarize_path([m[path_type] for m in verdict_set])
        for path_type in ("vec", "lex")
    }
    record["summary"]["basedOnProbeKinds"] = sorted({m["kind"] for m in verdict_set})
    record["narrowProbeSummary"] = {
        path_type: summarize_path(
            [m[path_type] for m in measured if m["kind"] == "narrow"])
        for path_type in ("vec", "lex")
    }
    record["queries"] = budget.queries
    record["status"] = "budget_exhausted" if budget.exhausted() else "ok"
    return record


def default_out_path(project_root: str) -> Path:
    """기본 저장 위치는 **프로젝트 밖**이다.

    라이브 프로젝트에 진단 산출물을 쓰면 측정이 대상을 변경한다(카드·설정 불변이
    baseline 수집의 전제다). 프로젝트별 파일명은 root 경로 해시로 안정화해 8단계가
    전/후를 같은 파일에서 찾는다.
    """
    digest = hashlib.sha256(project_root.encode("utf-8")).hexdigest()[:16]
    return Path.home() / ".cache" / "qmd" / "crowding" / f"{digest}.jsonl"


def append_record(path: Path, record: dict) -> bool:
    """append-only 원장에 한 줄 추가.

    `write_text_atomic`이 아니라 append 모드다 — 전/후 비교는 **누적 이력**이 자산이고,
    `open("a")`는 truncate하지 않는다(`wiki_compile.append_log`와 같은 근거).
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        return True
    except OSError:
        return False


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="crowding_probe",
        description="raw 인덱스의 전역 창 점유(crowding)를 프로젝트 단위로 반복 측정한다.",
    )
    parser.add_argument("project", nargs="?", default=".", help="프로젝트 경로 (기본 cwd)")
    parser.add_argument("--probes", type=int, default=DEFAULT_PROBES,
                        help=f"wiki 상위 빈도 어휘로 만드는 넓은 프로브 수 — 판정용 "
                             f"(기본 {DEFAULT_PROBES})")
    parser.add_argument("--title-probes", type=int, default=DEFAULT_TITLE_PROBES,
                        help=f"카드 title에서 표집하는 좁은 대조 프로브 수 "
                             f"(기본 {DEFAULT_TITLE_PROBES})")
    parser.add_argument("--probe", action="append", default=[],
                        help="프로브 질의를 축자 지정(반복 가능). 지정 시 표집을 대체한다")
    parser.add_argument("--recall-limit", type=int, default=qmd_recall.DAEMON_QUERY_LIMIT,
                        help=f"recall이 실제로 쓰는 limit — 피해 측정의 기준 "
                             f"(기본 {qmd_recall.DAEMON_QUERY_LIMIT}, core/recall.py와 공유)")
    parser.add_argument("--deep-limit", type=int, default=DEFAULT_DEEP_LIMIT,
                        help=f"엔진 내부 창을 보기 위한 큰 limit (기본 {DEFAULT_DEEP_LIMIT})")
    parser.add_argument("--timeout", type=float, default=DEFAULT_QUERY_TIMEOUT)
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL,
                        help="질의 간 최소 간격(초). 데몬은 single-thread다")
    parser.add_argument("--budget", type=float, default=DEFAULT_BUDGET,
                        help="전체 wall-clock 예산(초)")
    parser.add_argument("--ceiling", action="store_true",
                        help="창 천장 limit 사다리를 추가 실행(질의 4회 증가). 포화 판정은 "
                             "프로브별 rung이 이미 하므로 기본 비활성이다")
    parser.add_argument("--no-index-composition", action="store_true",
                        help="qmd CLI로 인덱스 구성을 세지 않는다")
    parser.add_argument("--label", default="", help="레코드 라벨(before/after 등)")
    parser.add_argument("--out", default="", help="원장 경로 (기본 ~/.cache/qmd/crowding/)")
    parser.add_argument("--stdout", action="store_true",
                        help="원장에 쓰지 않고 레코드를 stdout으로만 출력")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(sys.argv[1:] if argv is None else argv))
    if (args.recall_limit <= 0 or args.deep_limit < args.recall_limit
            or args.probes < 0 or args.title_probes < 0):
        sys.stderr.write(
            "crowding_probe: --recall-limit는 양수, --deep-limit는 그 이상, "
            "--probes/--title-probes는 0 이상이어야 한다\n")
        return 1
    project_dir = str(Path(args.project).expanduser())
    record = build_record(project_dir, args)
    text = json.dumps(record, ensure_ascii=False)
    if args.stdout:
        sys.stdout.write(text + "\n")
        return 0
    out = Path(args.out).expanduser() if args.out else default_out_path(
        record["project"]["root"])
    if not append_record(out, record):
        sys.stderr.write(f"crowding_probe: 원장 쓰기 실패 {out}\n")
        sys.stdout.write(text + "\n")
        return 1
    sys.stderr.write(
        f"crowding_probe: {record.get('status')} → {out} "
        f"(queries={record.get('queries', 0)})\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
