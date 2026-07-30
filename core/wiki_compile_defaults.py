#!/usr/bin/env python3
"""Single source of the wiki auto-compile config block.

--enable-compile, --init-wiki (recall stays separate), and recommend_config all
use these so onboarding paths agree on portable built-in engine names and
compile defaults. The worker resolves built-in adapter paths at runtime.
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


def builtin_engines(engines=ENGINES) -> list[str]:
    picked = [e for e in engines if e in ENGINES]
    return picked or list(ENGINES)


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
        "triggers": ["post_tool_source", "post_sync_source", "manual"],
        "maxSourceChars": 12000,
        "excludeStatusesFromRecall": ["discarded", "contested"],
        "lowPriorityStatuses": ["generated", "tentative"],
        "maxAutoPageLines": 120,
        "extractor": {
            "dispatch": "by-engine",
            "backends": {},
            "builtins": builtin_engines(engines),
            "default": [],
            "timeout": 120,
            "cooldownSeconds": 600,
        },
        "batch": {"idleSeconds": 90, "maxItems": 5},
        "verify": {
            "enabled": True,
            "timeout": 120,
            "onFail": "delete",
            # 사람 검수가 없다는 전제에서 inconclusive도 사장이므로 fail과 같이 삭제한다.
            # config.py의 verify 기본값과 반드시 동일해야 한다.
            "onInconclusive": "delete",
            # 카드를 만든 엔진과 다른 엔진으로 검수한다. `builtins`를 쓰지 않는 이유는
            # 여기에 목록을 복제하면 사용자가 extractor.builtins를 고친 뒤 검수 후보만
            # 낡기 때문이다 — 비워 두면 extractor 풀을 그대로 물려받는다.
            "crossEngine": "prefer",
            "queuePath": ".auto-context/compile/verify-queue.jsonl",
            "logPath": ".auto-context/compile/verify-log.jsonl",
            "skippedPath": ".auto-context/compile/verify-skipped.jsonl",
            "deletedPath": ".auto-context/compile/verify-deleted.jsonl",
            "cooldownSeconds": 600,
            "maxPerRun": 3,
        },
    }
