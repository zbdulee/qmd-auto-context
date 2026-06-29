#!/usr/bin/env python3
"""Codex headless extractor adapter. payload(stdin) -> {"candidates":[...]}(stdout)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import lib

sys.exit(lib.run_adapter(
    "codex",
    "QMD_EXTRACTOR_CODEX_BIN",
    lambda b, p: [b, "exec", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", p],
))
