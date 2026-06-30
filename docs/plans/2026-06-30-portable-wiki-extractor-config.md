# Portable Wiki Extractor Config Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop writing user-specific absolute plugin adapter paths into `.auto-context/settings.json` while preserving Claude Code, Codex, and Hermes Agent wiki compile behavior.

**Architecture:** Generated compile config stores symbolic built-in engine names instead of absolute adapter argv paths. `core/wiki_compile_worker.py` resolves built-in adapters at runtime from the installed plugin location, while explicit `extractor.argv`, explicit `extractor.backends[engine]`, and `extractor.default` remain custom override paths.

**Tech Stack:** Python core scripts, Bash `core/update.sh`, Node `node:test`.

---

### Task 1: Make Generated Compile Config Portable

**Files:**
- Modify: `core/wiki_compile_defaults.py`
- Modify: `core/config.py`
- Modify: `core/update.sh`
- Test: `test/wiki-compile-defaults.test.mjs`
- Test: `test/recommend-config.test.mjs`
- Test: `test/resolve-optin.test.mjs`
- Test: `test/enable-compile.test.mjs`
- Test: `test/enable-compile-skill.test.mjs`
- Test: `test/config.test.mjs`
- Test: `test/wiki-compile-notice.test.mjs`

**Requirements:**
- `compile_block()` must not serialize plugin root, `core/extractors`, or `_adapter.py`.
- New default extractor shape uses `dispatch: "by-engine"` plus a symbolic built-in engine list for `claude`, `codex`, and `hermes`.
- `--engines codex` limits the symbolic built-in engine list to `["codex"]`.
- Config normalization preserves valid built-in engines and drops invalid values.
- SessionStart first-run notice still shows enabled built-in engines even when `extractor.backends` is empty.

**Validation commands:**
- `node --test test/wiki-compile-defaults.test.mjs test/recommend-config.test.mjs test/resolve-optin.test.mjs test/enable-compile.test.mjs test/enable-compile-skill.test.mjs test/config.test.mjs test/wiki-compile-notice.test.mjs`

### Task 2: Resolve Built-In Adapters At Worker Runtime

**Files:**
- Modify: `core/wiki_compile_worker.py`
- Test: `test/wiki-compile-worker.test.mjs`

**Requirements:**
- `extractor.argv` still wins over any built-in configuration.
- Explicit `extractor.backends[engine]` still wins over built-in configuration.
- Existing `extractor.default` fallback remains unchanged and only runs when the primary extractor is absent or exits `127`.
- When no explicit backend exists and the queued job engine is in the built-in list, resolve to `[sys.executable, "<plugin-root>/core/extractors/{engine}_adapter.py"]`.
- Plugin root resolution must work without `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT`; use worker file location as the baseline.

**Validation commands:**
- `node --test test/wiki-compile-worker.test.mjs`

### Task 3: Full Verification And Multi-Agent Review

**Files:**
- Review all changed files.

**Requirements:**
- Run the focused test set.
- Run `npm test` if focused tests pass.
- Request at least two independent reviews:
  - Spec compliance: portable settings, backward compatibility, Claude/Codex/Hermes behavior.
  - Code quality: edge cases, tests, maintainability.
- Fix all Critical/Important findings before final report.

**Validation commands:**
- `git diff --check`
- `npm test`
