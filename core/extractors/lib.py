"""Shared helpers for host-CLI wiki extractor adapters.

Adapters are pure functions: read one payload JSON on stdin, run a host CLI in an
isolated temp cwd with tools/writes disabled, emit {"candidates": [...]} on stdout.
They never touch the project filesystem.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CLI_ABSENT = 127

ALLOWED_TYPES = ("concept", "entity", "decision", "comparison")

_PROMPT_TEMPLATE = """You convert one source document into compact, durable wiki candidates.

Output RULES (strict):
- Output ONLY a single JSON object: {{"candidates": [ ... ]}}. No prose, no code fence.
- Each candidate: {{"title": str, "summary": str, "suggestedType": one of {types}, "confidence": "low"|"medium"|"high"}}.
- summary is a short durable conclusion (a decision, rule, concept, or entity fact). NOT a transcript, NOT step-by-step dialog.
- Never include secrets, API keys, tokens, or credentials. Omit anything sensitive.
- If nothing durable is worth saving, output {{"candidates": []}}.
- Do NOT use any tools. Do NOT read or write files. Answer directly.

WIKI SCHEMA (for orientation):
{schema}

EXISTING WIKI INDEX (avoid duplicates):
{index}

SOURCE FILE: {path}
SOURCE CONTENT:
{content}
"""


def read_payload() -> dict:
    try:
        raw = sys.stdin.read()
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def build_prompt(payload: dict) -> str:
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    wiki = payload.get("wiki") if isinstance(payload.get("wiki"), dict) else {}
    return _PROMPT_TEMPLATE.format(
        types="/".join(ALLOWED_TYPES),
        schema=str(wiki.get("schema", ""))[:4000],
        index=str(wiki.get("index", ""))[:4000],
        path=str(source.get("path", "")),
        content=str(source.get("content", "")),
    )


def extract_candidates(text: str) -> dict:
    if not isinstance(text, str) or "candidates" not in text:
        return {}
    # Scan for balanced {...} objects, prefer the last one that parses with "candidates".
    found = None
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    chunk = text[start:i + 1]
                    try:
                        obj = json.loads(chunk)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, dict) and isinstance(obj.get("candidates"), list):
                        found = obj
    return found or {}


def resolve_bin(name: str, env_override: str) -> str | None:
    override = os.environ.get(env_override)
    if override:
        return override
    path = os.environ.get("PATH", "")
    extra = []
    fnm_root = Path.home() / ".local" / "share" / "fnm" / "node-versions"
    if fnm_root.exists():
        versions = sorted(fnm_root.glob("v*/installation/bin"))
        if versions:
            extra.append(str(versions[-1]))
    bun = Path.home() / ".bun" / "bin"
    if bun.exists():
        extra.append(str(bun))
    search = os.pathsep.join(extra + [path]) if extra else path
    return shutil.which(name, path=search)


def run_isolated(cmd: list[str], timeout: int) -> tuple[str | None, int]:
    workdir = tempfile.mkdtemp(prefix="qmd-extract-")
    try:
        proc = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
            cwd=workdir,
        )
        if proc.stderr:
            sys.stderr.write(proc.stderr[-4000:])
        return proc.stdout, proc.returncode
    except subprocess.TimeoutExpired:
        return None, 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def emit(candidates_obj: dict) -> int:
    candidates = candidates_obj.get("candidates") if isinstance(candidates_obj, dict) else None
    if not isinstance(candidates, list):
        return 1
    print(json.dumps({"candidates": candidates}, ensure_ascii=False))
    return 0


def run_adapter(cli_name: str, env_override: str, build_cmd) -> int:
    """Full adapter flow shared by all host adapters."""
    payload = read_payload()
    prompt = build_prompt(payload)
    binary = resolve_bin(cli_name, env_override)
    if not binary:
        return CLI_ABSENT
    timeout = int(payload.get("timeout") or os.environ.get("QMD_EXTRACTOR_TIMEOUT") or 120)
    out, code = run_isolated(build_cmd(binary, prompt), timeout)
    if out is None:
        return 1
    if code != 0:
        return code
    return emit(extract_candidates(out))
