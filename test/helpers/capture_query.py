#!/usr/bin/env python3
"""Run core/recall.py against a stub qmd daemon and print the /query payloads it sent.

Lets tests assert on the *actual* lex query string the hook builds — the CLI
(core/keywords.py) and the hook path share build_lexical_terms, but only this
covers recall.py wiring (config lexicalPatterns gating, term ordering).

Usage: capture_query.py '<prompt>' '<settings.json contents>'
Output: {"queries": [<daemon /query payload>, ...]}
"""
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading

payloads: list[dict] = []
probes: list[dict] = []


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
        # 본 질의와 프로브를 갈라 담는다. 판정 기준은 **vec 엔트리 유무**다 —
        # recall 이 보내는 질의 중 vec 을 포함하는 것은 본 질의뿐이고(DF 좁히기·lex
        # 게이트 프로브는 lex 단독), payload 에 테스트 전용 표식을 넣으면 라이브
        # 데몬 스키마와 갈린다.
        searches = payload.get("searches") or []
        is_probe = isinstance(searches, list) and not any(
            isinstance(s, dict) and s.get("type") == "vec" for s in searches
        )
        (probes if is_probe else payloads).append(payload)
        # DF 프로브에는 히트를 돌려준다 = "모든 term 이 코퍼스에 있다". 그래야 본 질의의
        # lex 문자열이 위치 컷 기대값과 같아져, 이 헬퍼를 쓰는 기존 테스트가 term 선택
        # 규칙이 아니라 **조립 규칙**(EP 분리·순서·dedup)만 계속 검증한다.
        hit = [{"file": "stub/present.md", "score": 1.0}] if is_probe else []
        body = json.dumps({"results": hit}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep stdout clean for the caller
        pass


def main() -> int:
    prompt = sys.argv[1]
    settings = json.loads(sys.argv[2])

    server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    daemon_url = f"http://127.0.0.1:{server.server_port}"

    repo_root = pathlib.Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory() as project_dir:
        config_dir = pathlib.Path(project_dir, ".auto-context")
        config_dir.mkdir()
        (config_dir / "settings.json").write_text(
            json.dumps(settings), encoding="utf-8"
        )
        env = dict(os.environ, QMD_DAEMON_URL=daemon_url)
        env.pop("QMD_QUERY_FIXTURE", None)
        subprocess.run(
            [sys.executable, str(repo_root / "core" / "recall.py")],
            input=json.dumps({"prompt": prompt, "cwd": project_dir}),
            text=True,
            capture_output=True,
            env=env,
            cwd=str(repo_root),
            timeout=30,
        )
    server.shutdown()
    print(json.dumps({"queries": payloads, "probes": probes}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
