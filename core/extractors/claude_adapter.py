#!/usr/bin/env python3
"""Claude headless extractor adapter. payload(stdin) -> {"candidates":[...]}(stdout)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import lib

sys.exit(lib.run_adapter(
    "claude",
    "QMD_EXTRACTOR_CLAUDE_BIN",
    lambda b, p: [b, "-p", "--tools", "", "--permission-mode", "plan", "--output-format", "text", p],
))
