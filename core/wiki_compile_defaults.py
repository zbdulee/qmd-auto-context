#!/usr/bin/env python3
"""Single source of the wiki auto-compile config block.

--enable-compile, --init-wiki (recall stays separate), and recommend_config all
use these so onboarding paths agree on adapter locations and compile defaults.
"""
from __future__ import annotations

import os
from pathlib import Path

ENGINES = ("claude", "codex", "hermes")


def plugin_root(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    env = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.environ.get("PLUGIN_ROOT")
    if env:
        return Path(env).resolve()
    # this file lives at <root>/core/wiki_compile_defaults.py
    return Path(__file__).resolve().parents[1]


def parse_engines(value: str | None) -> tuple[str, ...]:
    if not value:
        return ENGINES
    picked = tuple(e for e in (s.strip() for s in value.split(",")) if e in ENGINES)
    return picked or ENGINES


def adapter_paths(root, engines=ENGINES) -> dict:
    base = Path(root) / "core" / "extractors"
    return {e: [str(base / f"{e}_adapter.py")] for e in engines}


def compile_block(root, engines=ENGINES) -> dict:
    return {
        "enabled": True,
        "mode": "auto-wiki",
        "autoWrite": True,
        "defaultStatus": "generated",
        "requireReviewForCanon": True,
        "candidatePath": ".auto-context/compile/candidates.jsonl",
        "sourceQueuePath": ".auto-context/compile/source-queue.jsonl",
        "manifestPath": ".auto-context/compile/generated-manifest.jsonl",
        "tombstonePath": ".auto-context/compile/tombstones.jsonl",
        "triggers": ["post_tool_source", "manual"],
        "maxSourceChars": 12000,
        "excludeStatusesFromRecall": ["discarded", "contested"],
        "lowPriorityStatuses": ["generated", "tentative"],
        "maxAutoPageLines": 120,
        "extractor": {
            "dispatch": "by-engine",
            "backends": adapter_paths(root, engines),
            "default": [],
            "timeout": 120,
            "cooldownSeconds": 600,
        },
        "batch": {"idleSeconds": 90, "maxItems": 5},
    }
