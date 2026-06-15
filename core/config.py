#!/usr/bin/env python3
import argparse
import json
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
    "events": ["sessionStart", "userPromptSubmit", "postToolUse"],
}


def load_input_config():
    raw = sys.stdin.read()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def normalize_config(input_config):
    return {
        key: input_config.get(key, default)
        for key, default in DEFAULT_CONFIG.items()
    }


def main():
    parser = argparse.ArgumentParser(description="Normalize qmd recall configuration.")
    parser.add_argument("--cwd", required=True)
    args = parser.parse_args()
    _cwd = args.cwd

    config = normalize_config(load_input_config())
    print(json.dumps(config, ensure_ascii=False))


if __name__ == "__main__":
    main()
