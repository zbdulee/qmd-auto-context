#!/usr/bin/env python3
"""Hermes headless extractor adapter. payload(stdin) -> {"candidates":[...]}(stdout)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import lib

sys.exit(lib.run_adapter(
    "hermes",
    "QMD_EXTRACTOR_HERMES_BIN",
    lambda b, p: [b, "-z", p, "--safe-mode", "--ignore-user-config", "--ignore-rules", "-t", ""],
))
