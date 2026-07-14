"""Shared fail-safe entrypoint wrapper for hook scripts.

Hooks MUST always exit 0 — a policy "deny"/block decision is expressed as
JSON on stdout, never as a non-zero exit. Any uncaught exception reaching
the process top level turns into a non-zero exit, which the host
(Claude Code / Codex / Hermes / Antigravity) surfaces to the user as a
noisy "hook (failed): exited with code 1".

This is the single fail-open boundary for every Python hook entrypoint:
run `main()`, and on ANY exception return 0 so the hook degrades to a
silent no-op instead of a visible failure. The exception is best-effort
recorded to QMD_RECALL_LOG (file only, never stdout, so it can't pollute
the model context) when that env var is set — preserving the documented
diagnosis path (see CLAUDE.md "빈 출력은 정상 동작일 수 있다").

Rationale for centralizing here rather than per-site try/except: several
entrypoints (recall/posttool/gate/index/compile) call the same config and
filesystem helpers with no guard of their own, and a sandboxed runtime
(e.g. Codex seatbelt workspace-write) can deny filesystem access outside
its allowed roots and raise where an unsandboxed shell would not. Guarding
each call site is easy to miss on the next edit; one wrapper is not.
"""
from __future__ import annotations

import os
import sys
import traceback


def run(main) -> int:
    """Call main() and return its int exit code, coercing any exception to 0."""
    try:
        rc = main()
    except SystemExit:
        # An explicit SystemExit is a deliberate exit request — honor its
        # code, but never let it become an unhandled non-zero surprise.
        raise
    except BaseException:  # noqa: BLE001 — hooks must never crash the host
        _log_exception()
        return 0
    return rc if isinstance(rc, int) else 0


def _log_exception() -> None:
    path = os.environ.get("QMD_RECALL_LOG")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("qmd_hook_uncaught_exception\n")
            traceback.print_exc(file=handle)
    except Exception:  # noqa: BLE001 — logging must not itself raise
        pass
