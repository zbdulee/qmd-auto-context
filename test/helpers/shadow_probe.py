#!/usr/bin/env python3
"""Run core/recall.py against a scripted stub qmd daemon and report everything a
shadow-query test needs: the /query payloads sent, the hook's stdout/exit code,
and the parsed QMD_RECALL_LOG lines.

Why a Python driver instead of an http server inside the node test: node's
execFileSync blocks its own event loop, so a server created in the test process
can never answer the hook. capture_query.py already uses this pattern.

Usage: shadow_probe.py '<options json>'
  options: {
    "prompt": str,
    "scenario": "default" | "lex-dead" | "wiki-empty" | "filtered-out"
                | "all-unverified" | "ep-deep" | "ep-rescue" | "raw-ranked"
                | "fail-after-first" | "slow-after-first"
                | "df-absent" | "df-mixed" | "df-fail" | "df-slow",
    "shadow": bool,      # set QMD_SHADOW_QUERY=1
    "log": bool,         # set QMD_RECALL_LOG to a temp file
    "fixture": bool,     # run through QMD_QUERY_FIXTURE instead of the daemon
    "settings": {...},   # .auto-context/settings.json overrides
    "env": {...}         # extra env overrides
  }
Output: {"queries": [...], "df_probes": [...], "stdout": str,
         "exit_code": int, "log": [line, ...]}
  queries  = 본 recall / lex 게이트 / shadow 질의 (DF 좁히기 프로브 제외)
  df_probes = DF(존재) 좁히기 프로브 payload
"""
import http.server
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

WIKI_HIT = [{"file": "qmd://proj-wiki/concepts/card.md", "title": "Card", "score": 1}]
# raw 3건의 score를 전부 동일하게 둔다 — rerank=false 경로에서 score만 남기면 순위
# 정보가 소실된다는 것이 P0-CRITICAL의 요지이고, rank 필드가 그걸 메우는지 본다.
RAW_HITS = [
    {"file": "qmd://proj/raw.md", "title": "Raw doc", "score": 1},
    {"file": "qmd://proj/other.md", "title": "Other", "score": 1},
    {"file": "qmd://proj/third.md", "title": "Third", "score": 1},
]
# 라이브에서 관찰된 실패 형태 재현: 데몬은 8건 중 3건을 상위로 냈지만 1위가 미검수
# generated고 2·3위는 minScore 순위 컷에 걸려 최종 0건이 된다. score는 1/rank.
FILTERED_OUT_WIKI = [
    {"file": "qmd://proj-wiki/concepts/gen.md", "title": "Generated", "score": 1},
    {"file": "qmd://proj-wiki/concepts/card.md", "title": "Card", "score": 0.5},
    {"file": "qmd://proj-wiki/concepts/card2.md", "title": "Card 2", "score": 0.33},
]
# 후보 전체가 미검수(generated)인 경우 — 순위 폴백이 여기서는 아무것도 살리지 않아야
# 한다(recallVerifiedOnly 의도 보존: 미검수 카드를 캐논 근거로 쓰지 않는다).
ALL_UNVERIFIED_WIKI = [
    {"file": "qmd://proj-wiki/concepts/gen.md", "title": "Generated", "score": 1},
    {"file": "qmd://proj-wiki/concepts/gen2.md", "title": "Generated 2", "score": 0.5},
    {"file": "qmd://proj-wiki/concepts/gen3.md", "title": "Generated 3", "score": 0.33},
]
# promotion + rescue 동시 발생: 1위(미검수)와 3위 EP 카드(미검수, promotion으로 score
# 1.0)가 모두 hard filter로 떨어지고, 데몬 2위인 검수 카드가 구제된다. 재정렬 후 위치는
# 3이지만 로그의 rescued_original_rank 는 promotion 전 데몬 순위(2)여야 한다.
EP_RESCUE_WIKI = [
    {"file": "qmd://proj-wiki/concepts/gen.md", "title": "Generated", "score": 1},
    {"file": "qmd://proj-wiki/concepts/card.md", "title": "Card", "score": 0.5},
    {"file": "qmd://proj-wiki/concepts/ep-99.md", "title": "EP 99", "score": 0.33},
]
# raw 후보에 순위 차이를 준다(RAW_HITS 는 동점 score 전제를 검증하는 다른 테스트가 써서
# 그대로 둔다). raw phase 의 순위 폴백/차단을 보려면 서로 다른 score 가 필요하다.
RAW_RANKED = [
    {"file": "qmd://proj/raw.md", "title": "Raw doc", "score": 1},
    {"file": "qmd://proj/other.md", "title": "Other", "score": 0.5},
    {"file": "qmd://proj/third.md", "title": "Third", "score": 0.33},
]
# EP exact-match promotion 검증용: EP 파일이 4위(0.25)로 절단 밖에 있다.
EP_DEEP_WIKI = [
    {"file": "qmd://proj-wiki/concepts/card.md", "title": "Card", "score": 1},
    {"file": "qmd://proj-wiki/concepts/card2.md", "title": "Card 2", "score": 0.5},
    {"file": "qmd://proj-wiki/concepts/gen.md", "title": "Generated", "score": 0.33},
    {"file": "qmd://proj-wiki/concepts/ep-12.md", "title": "EP 12", "score": 0.25},
]

payloads: list[dict] = []
df_probes: list[dict] = []
scenario = "default"


def _is_df_probe(payload: dict) -> bool:
    """DF(존재) 좁히기 프로브인가 — term 하나짜리 lex 질의 + limit 1.

    recall 이 보내는 질의 중 이 모양은 DF 프로브뿐이다(lex 게이트 프로브는 같은
    DAEMON_QUERY_LIMIT=8 을 쓰고 본 질의는 vec 을 포함한다). payload 에 테스트 전용
    표식을 넣지 않는 이유: 라이브 데몬 스키마와 갈리면 안 된다.
    """
    searches = payload.get("searches") or []
    return (
        payload.get("limit") == 1
        and len(searches) == 1
        and searches[0].get("type") == "lex"
    )


# df-mixed 에서 "코퍼스에 없는" term. 라이브 실측의 구어체 군더더기 그대로다
# (`아까 말한 그거 있잖아 VN 콜백 이벤트` → 앞 3개가 DF 0).
DF_ABSENT_TERMS = {"아까", "말한", "있잖아"}


def _results_for(payload: dict) -> list[dict]:
    if _is_df_probe(payload):
        # 기본은 "모든 term 이 코퍼스에 있다" — 그래야 본 질의의 lex 문자열이 위치 컷
        # 기대값과 같아지고, 기존 테스트가 term 선택이 아니라 진단 계약만 계속 본다.
        if scenario == "df-absent":
            return []
        if scenario == "df-mixed":
            term = (payload.get("searches") or [{}])[0].get("query", "")
            return [] if term in DF_ABSENT_TERMS else WIKI_HIT
        return WIKI_HIT
    kinds = "+".join(s.get("type", "") for s in payload.get("searches", []))
    is_wiki = "proj-wiki" in (payload.get("collections") or [])
    if scenario == "lex-dead" and kinds == "lex":
        return []
    if scenario == "wiki-empty" and is_wiki:
        return []
    if scenario == "filtered-out" and is_wiki:
        return FILTERED_OUT_WIKI
    if scenario == "all-unverified" and is_wiki:
        return ALL_UNVERIFIED_WIKI
    if scenario == "ep-rescue" and is_wiki:
        return EP_RESCUE_WIKI
    if scenario == "raw-ranked":
        return [] if is_wiki else RAW_RANKED
    if scenario == "ep-deep" and is_wiki:
        return EP_DEEP_WIKI
    return WIKI_HIT if is_wiki else RAW_HITS


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # /health
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):  # /query
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"_unparsed": raw.decode("utf-8", "replace")}
        # DF 프로브는 별도 목록에 담는다 — 호출자의 queries 인덱스(본 recall 0,
        # 게이트 프로브 1, shadow 2~)를 프로브가 밀지 않게 하기 위함이고, 시나리오의
        # "첫 질의"도 본 recall 질의를 뜻해야 하기 때문이다.
        if _is_df_probe(payload):
            df_probes.append(payload)
            if scenario == "df-slow":
                # per-probe 지연. DF 패스 **전체**가 lex_probe_timeout 안에 들어가는지
                # (= N 개가 곱해지지 않는지) 보는 시나리오다.
                time.sleep(0.5)
            if scenario == "df-fail":
                self.send_response(500)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        else:
            payloads.append(payload)
            first = len(payloads) == 1
            if not first and scenario == "fail-after-first":
                self.send_response(500)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if not first and scenario == "slow-after-first":
                # shadow per-query timeout보다 확실히 길게 — 매 shadow 질의가 timeout으로
                # 예산을 소모하게 만든다. ThreadingHTTPServer라 클라이언트가 포기해도
                # 다음 요청이 이 sleep에 직렬로 묶이지 않는다(예산 계산이 깨끗해진다).
                time.sleep(2.0)
        body = json.dumps({"results": _results_for(payload)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep stdout clean for the caller
        pass

    def handle_error(self, *args):
        # 클라이언트 timeout 후 응답을 쓰면 BrokenPipe가 난다 — 시나리오상 정상.
        pass


def _write_project(project_dir: pathlib.Path, overrides: dict) -> None:
    wiki = project_dir / ".auto-context" / "wiki" / "concepts"
    wiki.mkdir(parents=True)
    docs = project_dir / "docs"
    docs.mkdir()
    trust_source = docs / "trusted-source.md"
    trust_bytes = b"# Trusted source\n"
    trust_source.write_bytes(trust_bytes)
    trust_stat = trust_source.stat()
    revision = (
        '{kind: "file", path: "docs/trusted-source.md", collection: "proj", '
        f'sha256: "{hashlib.sha256(trust_bytes).hexdigest()}", '
        f'size: {trust_stat.st_size}, mtimeNs: {trust_stat.st_mtime_ns}' + '}'
    )

    def trusted_card(title: str) -> str:
        return (
            "---\nstatus: verified\ncreatedBy: qmd-auto-context\n"
            f"sourceRevisions:\n  - {revision}\n---\n# {title}\n"
        )

    # verified + qmd creator + compiler provenance is the injectable contract.
    (wiki / "card.md").write_text(trusted_card("Card"), encoding="utf-8")
    (wiki / "card2.md").write_text(trusted_card("Card 2"), encoding="utf-8")
    (wiki / "ep-12.md").write_text(trusted_card("EP 12"), encoding="utf-8")
    # 미검수 → recallVerifiedOnly가 drop (dropped_unverified 카운트).
    (wiki / "gen.md").write_text("---\nstatus: generated\n---\n# Generated\n", encoding="utf-8")
    (wiki / "gen2.md").write_text("---\nstatus: generated\n---\n# Generated 2\n", encoding="utf-8")
    (wiki / "gen3.md").write_text("---\nstatus: generated\n---\n# Generated 3\n", encoding="utf-8")
    # 미검수 EP 카드 — promotion 은 되지만 recallVerifiedOnly 가 drop 한다.
    (wiki / "ep-99.md").write_text("---\nstatus: generated\n---\n# EP 99\n", encoding="utf-8")
    (docs / "raw.md").write_text("# Raw doc\n", encoding="utf-8")
    settings = {
        "indexing": True,
        "collections": ["proj-wiki", "proj"],
        "collectionPaths": {"proj-wiki": ".auto-context/wiki", "proj": "docs"},
        "collectionRoles": {"proj-wiki": "wiki", "proj": "raw"},
        "recallStrategy": "wikiOnly",
        "topN": 3,
    }
    settings.update(overrides or {})
    (project_dir / ".auto-context" / "settings.json").write_text(
        json.dumps(settings), encoding="utf-8"
    )


def main() -> int:
    global scenario
    options = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    scenario = options.get("scenario", "default")
    prompt = options.get("prompt", "")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    daemon_url = f"http://127.0.0.1:{server.server_port}"

    repo_root = pathlib.Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory() as tmp:
        project_dir = pathlib.Path(tmp, "project")
        project_dir.mkdir()
        _write_project(project_dir, options.get("settings") or {})

        env = dict(os.environ, QMD_DAEMON_URL=daemon_url)
        env.pop("QMD_QUERY_FIXTURE", None)
        env.pop("QMD_SHADOW_QUERY", None)
        env.pop("QMD_RECALL_LOG", None)
        if options.get("shadow"):
            env["QMD_SHADOW_QUERY"] = "1"
        log_path = pathlib.Path(tmp, "recall.log")
        if options.get("log"):
            env["QMD_RECALL_LOG"] = str(log_path)
        if options.get("fixture"):
            fixture = pathlib.Path(tmp, "fixture.json")
            fixture.write_text(json.dumps({"results": WIKI_HIT}), encoding="utf-8")
            env["QMD_QUERY_FIXTURE"] = str(fixture)
        env.update({str(k): str(v) for k, v in (options.get("env") or {}).items()})

        proc = subprocess.run(
            [sys.executable, str(repo_root / "core" / "recall.py")],
            input=json.dumps({"prompt": prompt, "cwd": str(project_dir)}),
            text=True,
            capture_output=True,
            env=env,
            cwd=str(repo_root),
            timeout=60,
        )
        lines = []
        if log_path.exists():
            for line in log_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    lines.append(json.loads(line))
        result = {
            "queries": payloads,
            "df_probes": df_probes,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "exit_code": proc.returncode,
            "log": lines,
            "log_exists": log_path.exists(),
        }
    server.shutdown()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
