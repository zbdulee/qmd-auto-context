---
name: setup
description: Use for an explicit auto-context installation, managed runtime preparation, or preserving project upgrade. Shows a read-only inventory, prepares reviewed runtimes/index in isolation, and applies or rolls back only on explicit request.
---

# Setup and preserving upgrade

Users can ask “이 프로젝트 auto-context 설치 상태 보여줘”, “설치 준비해줘”, “검증된 준비를 적용해줘”, or “직전 적용을 되돌려줘”. Always name the project root and show the result of each phase.

1. Install this host plugin through its marketplace before using this skill. Plugin registration and hook trust are separate host actions; this skill never changes them. Resolve `ROOT` from a verified host plugin-root variable (`CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT`), or from the absolute path of this `SKILL.md` by ascending two directories. Verify `ROOT/core/install_update.py` exists. Never infer the plugin root from the target project git root; keep it distinct from `PROJECT_ROOT`. Do not use a global install script.
2. Run the read-only inventory: `python3 "$ROOT/core/install_update.py" inspect --project "$PROJECT_ROOT"`. On unsupported macOS architecture, Linux, or an incompatible runtime, report the exact status and manual global-QMD fallback. Do not present a staged package as installed.
3. Prepare a strict `qmd-install-request-v1` JSON request following `docs/install-update-contract-20261006.md`. Use `inspect.defaultRuntimeRoots.qmd` exactly; include absolute, reviewed Laya root and any original DB/model cache. For a shadow DB, bind the QMD config to the enabled wiki collection and exact wiki directory, and require all wiki documents and vectors to match before cutover. Choose explicit QMD/Laya reuse or install modes and their execution gates. Show the install/download/native lifecycle scope before setting any install gate. Never set a gate by inference from a user's ordinary question.
4. On an explicit prepare request, run `prepare --project "$PROJECT_ROOT" --request "$REQUEST_FILE"`. It writes only the private journal and inactive generations. If it reports `awaiting_legacy_review`, preserve v1 cards and obtain verified v2 replacements; do not automatically rewrite semantic claims. Repeating an identical request resumes an interrupted preparation. A new reviewed request can start after an activated or rolled-back transaction; the prior journal is archived.
5. On an explicit apply request, run `activate --project "$PROJECT_ROOT"` only when status is `prepared` and all source/proof checks still pass. Return the selected QMD/index/Laya modes and the verified hook/daemon QMD identity. A running managed daemon must be reloaded and verified; a failed handoff is a setup failure. For a failure, report `rolled_back_after_activation_failure` or `recovery_required` exactly; do not claim a partial install as success.
6. On an explicit rollback request, run `rollback --project "$PROJECT_ROOT"`. Confirm pointer/settings restoration and report any concurrent change that blocks safe rollback.

The `update` skill refreshes an already configured index; it does not replace this setup flow. Never activate a teacher, private checkpoint, or operating plugin hook as a side effect of preparing a runtime. Private model quality/learning activation requires its separate policy and review.
