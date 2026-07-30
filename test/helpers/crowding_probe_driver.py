#!/usr/bin/env python3
"""Drive core/crowding_probe.py against a scripted stub qmd daemon.

Same reason for a Python driver as shadow_probe.py / capture_query.py: node's
execFileSync blocks its own event loop, so an http server created inside the
node test process can never answer the subprocess under test.

Usage: crowding_probe_driver.py '<options json>'
  options: {
    "action": "run" | "unit",
    "scenario": "crowded" | "insulated" | "all-wiki" | "bad-response" | "down",
    "argv": [...],            # extra args appended to the CLI
    "settings": {...},        # .auto-context/settings.json overrides
    "cards": {"rel/path.md": "title", ...},   # wiki cards to create
    "out": "ledger" | "stdout" | "unwritable",
    "runs": int,              # how many times to invoke the CLI (ledger append)
    "unit": "<python expr>"   # action=unit: evaluated with `cp` in scope
  }
Output (action=run): {"queries": [...], "records": [...], "ledger": [...],
                      "stdout": str, "stderr": str, "exit_codes": [...],
                      "project_files_added": [...]}
"""
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

# 라이브에서 관찰된 형태를 재현한다: 전역 창은 raw가 앞자리를 먹고(정렬상 먼저)
# wiki는 뒤에 붙는다. wiki 필터 질의는 "도달 가능한 wiki pool"을 자기 limit으로 자른다
# — 그래서 작은 limit(recall의 8)에서는 전역 창에 없던 wiki 문서가 새로 등장하고,
# 큰 limit(deep)에서는 pool 전체가 창의 wiki 부분집합과 일치해 "창 이후 필터"로 보인다.
RAW_DOCS = [f"proj/raw{i}.md" for i in range(1, 26)]
WIKI_DOCS = [f"proj-wiki/concepts/card{i}.md" for i in range(1, 21)]

# 시나리오별 (전역 창의 raw 수, 필터 질의가 내는 wiki 수)
SCENARIOS = {
    # post-filter 형태(필터 결과 ⊆ 전역 창) + wiki 3 < recall limit 8 → 판정 불가, 상한 5
    "crowded": (25, 3),
    # post-filter 형태 + wiki 12 >= 8 → 굶은 칸 상한 0
    "insulated": (25, 12),
    # 전역 결과에 raw 0 → 되찾을 칸이 없어 상한도 0 이어야 한다
    "all-wiki": (0, 2),
    # 필터 결과가 전역 창 밖 문서를 낸다 → 독립 검색 증명
    "scoped": (25, 12),
}
# 프로브마다 wiki 수를 다르게 만든다. 같은 수가 반복되면 detect_engine_cap 이 cap 으로
# 의심하므로(그게 lex-cap 시나리오의 요지) ambiguous 분기를 시험하려면 값이 달라야 한다.
seen_queries: list[str] = []
# scoped: 필터 질의가 전역 창에 **없던** 문서를 낸다 → 독립 검색 증명 → 판정 가능
SCOPED_EXTRA = [f"proj-wiki/concepts/scoped{i}.md" for i in range(1, 6)]
# lex-cap: 어휘가 다른 프로브들이 **같은 수**를 반복한다(cap 서명). 전역 창의 wiki 부분집합과
# 정확히 일치시켜 scoped 증명이 나오지 않게 한다 → engine_cap_suspected 로만 판정 불가.
LEX_CAP_WIKI = 20
LEX_CAP_GLOBAL_RAW = 20

payloads: list[dict] = []
scenario = "crowded"


def _wiki_hits(query: str) -> list[str]:
    if scenario == "lex-cap":
        return WIKI_DOCS[:LEX_CAP_WIKI]
    if query not in seen_queries:
        seen_queries.append(query)
    base = SCENARIOS.get(scenario, SCENARIOS["crowded"])[1]
    return WIKI_DOCS[:base + seen_queries.index(query)]


def _global_window(query: str, limit: int) -> list[str]:
    if scenario == "lex-cap":
        return (RAW_DOCS[:LEX_CAP_GLOBAL_RAW] + _wiki_hits(query))[:limit]
    raw_count = SCENARIOS.get(scenario, SCENARIOS["crowded"])[0]
    return (RAW_DOCS[:raw_count] + _wiki_hits(query))[:limit]


def _filtered(query: str, limit: int) -> list[str]:
    if scenario == "scoped":
        # 전역 창 앞에 오지 않는 문서를 먼저 내놓아 newVsGlobal > 0 을 만든다.
        return (SCOPED_EXTRA + _wiki_hits(query))[:limit]
    return _wiki_hits(query)[:limit]


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
        payloads.append(payload)
        if scenario == "bad-response":
            body = b'{"results": "not-a-list"}'
        elif scenario == "null-response":
            # object 가 아닌 JSON — 예전엔 `.get` 이 AttributeError 로 실행 전체를 죽였다.
            body = b"null"
        elif scenario == "array-response":
            body = b"[1, 2, 3]"
        elif scenario == "query-500":
            self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        else:
            limit = payload.get("limit") or 0
            query = ((payload.get("searches") or [{}])[0]).get("query", "")
            files = (_filtered(query, limit) if payload.get("collections")
                     else _global_window(query, limit))
            body = json.dumps({
                "results": [{"file": f, "title": f, "score": 1} for f in files]
            }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

    def handle_error(self, *args):
        pass


DEFAULT_CARDS = {
    "concepts/alpha.md": "호갱노노 KTLO 판정 자동화 기준",
    "concepts/beta.md": "호갱노노 지표 전환 판정",
    "concepts/gamma.md": "KTLO 자동화 배포 절차",
    "concepts/delta.md": "단기임대 지표 정의",
    "concepts/epsilon.md": "채팅 이관 결정",
}


def _write_project(project_dir: pathlib.Path, overrides: dict, cards: dict) -> None:
    wiki = project_dir / ".auto-context" / "wiki"
    for rel, title in cards.items():
        target = wiki / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            f"---\nstatus: verified\ntitle: \"{title}\"\n---\n\n## Summary\n\n본문.\n",
            encoding="utf-8")
    # wiki 메타파일은 프로브 표집에서 제외돼야 한다.
    wiki.mkdir(parents=True, exist_ok=True)
    (wiki / "index.md").write_text("# Index\n", encoding="utf-8")
    (wiki / "log.md").write_text("# Log\n", encoding="utf-8")
    docs = project_dir / "docs"
    docs.mkdir(exist_ok=True)
    (docs / "raw.md").write_text("# Raw doc\n", encoding="utf-8")
    settings = {
        "indexing": True,
        "collections": ["proj-wiki", "proj"],
        "collectionPaths": {"proj-wiki": ".auto-context/wiki", "proj": "docs"},
        "collectionRoles": {"proj-wiki": "wiki", "proj": "raw"},
        "recallStrategy": "wikiOnly",
    }
    settings.update(overrides or {})
    (project_dir / ".auto-context" / "settings.json").write_text(
        json.dumps(settings), encoding="utf-8")


def _snapshot(root: pathlib.Path) -> set[str]:
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}


def run_unit(expr: str) -> int:
    sys.path.insert(0, str(REPO_ROOT / "core"))
    import crowding_probe as cp  # noqa: F401
    print(json.dumps(eval(expr, {"cp": cp, "json": json}), ensure_ascii=False))  # noqa: S307
    return 0


def run_unit_exec(script: str) -> int:
    """`result` 변수를 JSON으로 낸다. `captured()`로 대상 코드의 stdout을 회수한다."""
    import io
    import contextlib
    sys.path.insert(0, str(REPO_ROOT / "core"))
    import crowding_probe as cp  # noqa: F401
    buffer = io.StringIO()
    scope = {"cp": cp, "json": json, "captured": buffer.getvalue}
    with contextlib.redirect_stdout(buffer):
        exec(script, scope)  # noqa: S102 - 테스트 드라이버
    print(json.dumps(scope.get("result"), ensure_ascii=False))
    return 0


def main() -> int:
    global scenario
    options = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    if options.get("action") == "unit":
        return run_unit(options["unit"])
    if options.get("action") == "unit_exec":
        return run_unit_exec(options["unit"])
    scenario = options.get("scenario", "crowded")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    daemon_url = f"http://127.0.0.1:{server.server_port}"
    if scenario == "down":
        server.shutdown()
        server.server_close()

    with tempfile.TemporaryDirectory() as tmp:
        project_dir = pathlib.Path(tmp, "project")
        project_dir.mkdir()
        _write_project(project_dir, options.get("settings") or {},
                       options["cards"] if "cards" in options else DEFAULT_CARDS)
        before = _snapshot(project_dir)

        ledger = pathlib.Path(tmp, "ledger", "crowding.jsonl")
        mode = options.get("out", "ledger")
        argv = [sys.executable, str(REPO_ROOT / "core" / "crowding_probe.py"),
                str(project_dir), "--no-index-composition", "--interval", "0"]
        if mode == "stdout":
            argv.append("--stdout")
        elif mode == "unwritable":
            blocker = pathlib.Path(tmp, "blocker")
            blocker.write_text("not a dir", encoding="utf-8")
            argv += ["--out", str(blocker / "sub" / "x.jsonl")]
        else:
            argv += ["--out", str(ledger)]
        argv += [str(a) for a in (options.get("argv") or [])]

        env = dict(os.environ, QMD_DAEMON_URL=daemon_url)
        env.pop("QMD_QUERY_FIXTURE", None)
        exit_codes, stdout, stderr = [], "", ""
        for _ in range(max(1, int(options.get("runs", 1)))):
            proc = subprocess.run(argv, text=True, capture_output=True, env=env,
                                  cwd=str(REPO_ROOT), timeout=120)
            exit_codes.append(proc.returncode)
            stdout += proc.stdout
            stderr += proc.stderr

        records = []
        for line in stdout.splitlines():
            if line.strip().startswith("{"):
                records.append(json.loads(line))
        ledger_lines = []
        if ledger.exists():
            ledger_lines = [json.loads(l) for l in
                            ledger.read_text(encoding="utf-8").splitlines() if l.strip()]
        result = {
            "queries": payloads,
            "records": records,
            "ledger": ledger_lines,
            "stdout": stdout,
            "stderr": stderr,
            "exit_codes": exit_codes,
            "project_files_added": sorted(_snapshot(project_dir) - before),
        }
    if scenario != "down":
        server.shutdown()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
