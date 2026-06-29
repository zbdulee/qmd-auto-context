#!/usr/bin/env python3
"""Hermes headless extractor adapter. payload(stdin) -> {"candidates":[...]}(stdout)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import lib

# NOTE: hermes has no documented flag to disable session/checkpoint persistence
# (unlike claude --no-session-persistence / codex --ephemeral). `-z --safe-mode`
# is the most isolated one-shot mode available; a session record may still land in
# ~/.hermes. Add a suppression flag here if/when hermes exposes one.
sys.exit(lib.run_adapter(
    "hermes",
    "QMD_EXTRACTOR_HERMES_BIN",
    lambda b, p: [b, "-z", p, "--safe-mode", "--ignore-user-config", "--ignore-rules", "-t", ""],
))
