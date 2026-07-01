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
    "collectionRoles": {},
    "recallStrategy": "flat",
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
        "triggers": [],
        "canonSignals": [],
        "maxAutoPageLines": 120,
        "maxSourceChars": 12000,
        "extractor": {
            "argv": [],
            "timeout": 30,
            "cooldownSeconds": 600,
        },
        "batch": {
            "idleSeconds": 90,
            "maxItems": 5,
        },
        "semanticDedup": {
            "enabled": True,
            "threshold": 0.82,
            "topK": 3,
            "similarPageMaxChars": 12000,
        },
    },
}

COMPILE_MODES = {"off", "candidates", "guarded", "auto-wiki"}
WIKI_STATUSES = {"generated", "reviewed", "canon", "tentative", "contested", "discarded", "superseded"}
COMPILE_TRIGGERS = {
    "explicit_user_approval",
    "post_session_summary",
    "post_tool_source",
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
    allowed_roles = {"raw", "wiki", "session"}
    allowed_collections = set(collections)
    return {
        key: item
        for key, item in value.items()
        if isinstance(key, str)
        and key in allowed_collections
        and isinstance(item, str)
        and item in allowed_roles
    }


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
    result["triggers"] = [
        trigger for trigger in string_list(value.get("triggers"), defaults["triggers"])
        if trigger in COMPILE_TRIGGERS
    ]
    result["canonSignals"] = string_list(value.get("canonSignals"), defaults["canonSignals"])
    result["maxAutoPageLines"] = coerce_int(value.get("maxAutoPageLines", defaults["maxAutoPageLines"]), defaults["maxAutoPageLines"])
    result["maxSourceChars"] = coerce_int(value.get("maxSourceChars", defaults["maxSourceChars"]), defaults["maxSourceChars"])
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
    result["batch"] = {
        "idleSeconds": coerce_int(batch.get("idleSeconds", 90), 90),
        "maxItems": coerce_int(batch.get("maxItems", 5), 5),
    }
    raw_semantic = value.get("semanticDedup")
    semantic = raw_semantic if isinstance(raw_semantic, dict) else {}
    default_semantic = defaults.get("semanticDedup", {"enabled": True, "threshold": 0.82, "topK": 3, "similarPageMaxChars": 12000})
    result["semanticDedup"] = {
        "enabled": semantic.get("enabled") if isinstance(semantic.get("enabled"), bool) else default_semantic["enabled"],
        "threshold": coerce_float(semantic.get("threshold", default_semantic["threshold"]), default_semantic["threshold"]),
        "topK": coerce_int(semantic.get("topK", default_semantic["topK"]), default_semantic["topK"]),
        "similarPageMaxChars": coerce_int(semantic.get("similarPageMaxChars", default_semantic["similarPageMaxChars"]), default_semantic["similarPageMaxChars"]),
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
    config["topN"] = coerce_int(input_config.get("topN", DEFAULT_CONFIG["topN"]), DEFAULT_CONFIG["topN"])
    config["queryTimeout"] = coerce_float(input_config.get("queryTimeout", DEFAULT_CONFIG["queryTimeout"]), DEFAULT_CONFIG["queryTimeout"])
    config["skipPaths"] = string_list(input_config.get("skipPaths"), DEFAULT_CONFIG["skipPaths"])
    config["collectionPaths"] = string_map(input_config.get("collectionPaths"))
    config["allowRoots"] = string_list(input_config.get("allowRoots"), DEFAULT_CONFIG["allowRoots"])
    config["prefixStyle"] = input_config.get("prefixStyle") if input_config.get("prefixStyle") in ("full", "tag") else DEFAULT_CONFIG["prefixStyle"]
    config["collectionRoles"] = collection_role_map(input_config.get("collectionRoles"), config["collections"])
    config["recallStrategy"] = input_config.get("recallStrategy") if input_config.get("recallStrategy") in ("flat", "hierarchical") else DEFAULT_CONFIG["recallStrategy"]
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
    """cwd→부모(HOME 경계)로 project config를 찾고 normalized config와 위치를 반환한다."""
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
