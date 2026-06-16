#!/usr/bin/env python3
import argparse
import json
import math
import sys


DEFAULT_CONFIG = {
    "name": "",
    "collections": [],
    "minScore": 0.0,
    "topN": 3,
    "queryTimeout": 5,
    "lexicalPatterns": [],
    "skipPaths": [],
    "collectionPaths": {},
    "allowRoots": [],
    "prefixStyle": "full",
    "events": ["sessionStart", "userPromptSubmit", "postToolUse"],
    "indexing": None,
}

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
    config["topN"] = coerce_int(input_config.get("topN", DEFAULT_CONFIG["topN"]), DEFAULT_CONFIG["topN"])
    config["queryTimeout"] = coerce_float(input_config.get("queryTimeout", DEFAULT_CONFIG["queryTimeout"]), DEFAULT_CONFIG["queryTimeout"])
    config["skipPaths"] = string_list(input_config.get("skipPaths"), DEFAULT_CONFIG["skipPaths"])
    config["collectionPaths"] = string_map(input_config.get("collectionPaths"))
    config["allowRoots"] = string_list(input_config.get("allowRoots"), DEFAULT_CONFIG["allowRoots"])
    config["prefixStyle"] = input_config.get("prefixStyle") if input_config.get("prefixStyle") in ("full", "tag") else DEFAULT_CONFIG["prefixStyle"]
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
    from pathlib import Path
    try:
        Path(path).relative_to(Path(root))
        return True
    except ValueError:
        return False


def load_project_config(cwd):
    """cwd→부모(HOME 경계)로 .auto-context.json 우선, 없으면 레거시 .agents/qmd-recall.json 탐색.
    indexing:false 면 collections=[] (검색/인덱싱 skip). 못 찾으면 빈 설정(collections=[])."""
    from pathlib import Path
    path = Path(cwd).resolve()
    home = Path.home().resolve()
    # HOME 자체이거나 HOME 밖이면 cwd만; HOME 하위면 HOME까지만 부모 탐색.
    if path == home or not _is_within(path, home):
        search = [path]
    else:
        search = [path]
        for parent in path.parents:
            search.append(parent)
            if parent == home:
                break
    config_file = None
    for d in search:
        cand = d / ".auto-context.json"
        legacy = d / ".agents" / "qmd-recall.json"
        if cand.exists():
            config_file = cand
            break
        if legacy.exists():
            config_file = legacy
            break
    if config_file:
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                config = normalize_config(json.load(f))
            if config.get("indexing") is False:
                config["collections"] = []
            return config
        except (json.JSONDecodeError, OSError):
            pass
    fallback = normalize_config({})
    fallback["collections"] = []
    return fallback


def main():
    parser = argparse.ArgumentParser(description="Normalize qmd recall configuration.")
    parser.add_argument("--cwd", required=True)
    args = parser.parse_args()
    _cwd = args.cwd

    config = normalize_config(load_input_config())
    print(json.dumps(config, ensure_ascii=False))


if __name__ == "__main__":
    main()
