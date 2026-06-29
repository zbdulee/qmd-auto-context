# Wiki Auto-Compile: Default-On + Discoverability — Design

**Date**: 2026-06-29
**Status**: approved (brainstorming → ready for implementation plan)
**Builds on**:
- `2026-06-29-host-adaptive-wiki-extractor-design.md` (the extractor itself)
- `2026-06-26-auto-wiki-compile-automation.md` (queue/worker/compile pipeline)

## Problem

The host-adaptive wiki extractor shipped (0.8.0) but is effectively unusable
without expert setup. To turn it on a user must, by hand: add `post_tool_source`
to `compile.triggers`, hand-write `compile.extractor.backends` with absolute
adapter paths, add `compile.batch`, and export `QMD_COMPILE_TRUST_EXTRACTOR=1`.
Nothing tells them this — a misconfigured project just silently no-ops
(`untrusted_extractor`/`missing_extractor` recorded only in `candidates.jsonl`).
Even the plugin author found the setup too complex to use casually. **If setup is
this hard, nobody enables it.**

## Decision (product pivot)

Prioritize usability. **Opting a project in turns wiki recall + auto-compile ON
by default**, with a one-command path to enable/retrofit, natural-language skill
access, and a clear one-time disclosure. Unconfigured projects are unchanged
(no-op, zero dependency).

Security model shifts from a per-session env gate to **"installing the plugin is
consent; disclose the behavior."** Rationale (agreed during brainstorming): the
extractor only runs if the qmd-auto-context plugin is installed — installing it is
itself the act of permitting it to run configured extractors. A separate env gate
on top of explicit `compile.extractor` config is redundant friction. The residual
risk (a cloned third-party repo whose committed `settings.json` has arbitrary
`backends`, run on a machine with the plugin installed) is accepted and disclosed,
not gated. This intentionally relaxes the `QMD_COMPILE_TRUST_EXTRACTOR` gate that
earlier reviews added.

## Goals

- One command (or one natural-language request) from zero to a working
  edit→wiki loop; no hand-edited JSON, no env to remember.
- Standard opt-in onboarding produces a wiki+compile-wired config by default.
- The behavior (background CLI execution on edits) is disclosed: in docs and as a
  one-time runtime notice.
- Cross-host: core logic written once; Claude/Codex get it for free; Hermes
  limitations documented.

## Non-Goals

- Multi-source batch extraction (one CLI call for a whole batch). The existing
  debounce (idle window + dedup by path) + cooldown already bound cost to
  "distinct files edited per window"; collapsing a batch into a single CLI call is
  deferred. Per-file extractor calls are retained.
- Re-introducing a per-project trust prompt (direnv/VS-Code-style). Explicitly
  rejected in favor of install-as-consent.
- Changing unconfigured-project behavior (still no-op, zero dependency).

## Architecture

Three-layer rule holds: domain logic lives in `core/` (SSOT); hosts are thin.

### A. Remove the trust env gate

`core/wiki_compile_worker.py` `process_job`: delete the
`os.environ.get("QMD_COMPILE_TRUST_EXTRACTOR") != "1"` check (and its
`untrusted_extractor` failure record). After this, a configured + resolvable
extractor runs whenever the four declarative gates pass (`indexing`,
`compile.enabled`+`mode!=off`, `triggers` includes `post_tool_source`, a resolved
backend). Installing the plugin + configuring backends is the consent.

Tests: `test/wiki-compile-worker.test.mjs` currently sets
`QMD_COMPILE_TRUST_EXTRACTOR:'1'` in every extractor test and has a test asserting
the `untrusted_extractor` path. Drop the env from the passing tests; replace the
"untrusted" test with one asserting that a configured backend runs **without** any
env set.

### B. Default-on onboarding

The standard opt-in paths produce a wiki+compile-wired `settings.json`:

- `core/recommend_config.py` — the recommended config (consumed by
  `update.sh --optin --recommended`) gains the wiki collection
  (`<slug>-wiki` → `.auto-context/wiki`, role `wiki`), `recallStrategy:
  "hierarchical"`, `wikiPath`, and a `compile` block (enabled, `mode: "auto-wiki"`,
  `triggers` including `post_tool_source`, `extractor` wired per §C, `batch`
  defaults).
- `core/update.sh --init-wiki` — already scaffolds wiki recall; extend it to also
  wire the `compile` block (triggers + extractor + batch) so a single
  `--init-wiki` yields a working auto-compile project.

"Default on" means: the act of opting in (recommended path or `--init-wiki`)
enables wiki+compile. A bare `--optin` (no `--recommended`) stays minimal
(indexing + folder-name collection only) — it is the deliberate "just index, no
wiki" escape hatch.

### C. `--enable-compile` (one command; retrofit/toggle)

New `core/update.sh` mode: `bash core/update.sh --enable-compile [<path>] [--engines claude,codex,hermes]`.

- **Adapter paths auto-derived**: from `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` if set,
  else from the script location (`dirname "$0"/..`). Never hardcoded, never
  version-pinned. Adapter path = `<root>/core/extractors/<engine>_adapter.py`.
- **Engines**: default wires all three (`claude`, `codex`, `hermes`); a missing
  host CLI resolves to exit 127 → no-op, so over-wiring is harmless and means the
  project works under whichever host edits it. `--engines` overrides the set.
- **Scaffold if missing**: if `.auto-context/wiki` is absent, run the `--init-wiki`
  scaffold first, so `--enable-compile` works standalone in one command.
- **Writes** (atomic, idempotent): adds `post_tool_source` to `compile.triggers`
  (dedup), sets `compile.extractor` (`dispatch: "by-engine"`, `backends`,
  `default: []`, `timeout: 120`, `cooldownSeconds: 600`) and `compile.batch`
  (`idleSeconds: 90`, `maxItems: 5`). Preserves unrelated config. Same path-safety
  as existing `--init-wiki`/`--optin` (no symlink/traversal; `.auto-context` under
  project root).
- **Requires opt-in**: if no project `settings.json` with `indexing:true` exists,
  print guidance to run `--optin`/`--optin --recommended` first and exit 0.
- **Output**: prints the disclosure — which engines are wired, that edits to
  `raw`/`session` `.md` files will run those CLIs in the background to fill the
  wiki, and how to undo (remove `compile.extractor` or set
  `compile.triggers` without `post_tool_source`).

### D. First-run disclosure notice (runtime, not a gate)

`core/update.sh main()` (SessionStart path): when `compile.extractor` is
configured with backends AND a per-project once-marker
(`.auto-context/compile/.notice-shown`) is absent, print a one-time notice to
stdout and create the marker:

> `[qmd] wiki auto-compile is active (engines: <list>). Editing .md files in
> raw/session collections will run those CLIs in the background to draft wiki
> pages (status: generated). To disable, remove compile.extractor from
> .auto-context/settings.json.`

- Channel reach: Claude (`hooks.json` SessionStart) and Codex (`hooks-codex.json`
  SessionStart) surface `update.sh` stdout as session context → notice shows.
- Hermes: `on_session_start` (`session_update`) runs `update.sh` for side-effects
  but is observer-only (returns None, stdout not surfaced) → the notice does not
  display on Hermes. Documented limitation, consistent with the existing Hermes
  posttool observer limitation. (Future: surface via `pre_llm_call` first turn.)
- The notice is shown once per project (marker), so it is not recurring noise.

### E. Skill wrapper

A new skill `skills/enable-compile/` (wrapper + `SKILL.md`) so a natural request
("wiki 자동화 켜줘" / "enable auto wiki compile") runs
`core/update.sh --enable-compile` for the current project. Mirrors the existing
`skills/{update,query,sync,wiki-compile}` wrapper pattern: the wrapper resolves
the plugin root, runs the core command, and relays its disclosure output. No new
domain logic — it only invokes §C.

### F. Docs + version bump

- `README.md`: replace the manual opt-in section — remove the
  `QMD_COMPILE_TRUST_EXTRACTOR` steps; document that opting in (recommended path /
  `--init-wiki` / `--enable-compile`) turns wiki auto-compile on, that the plugin
  **executes the configured host CLI on edits** (install-as-consent disclosure),
  and the one-command / skill paths.
- `CLAUDE.md`: update the `extractors/` bullet — env gate removed (install =
  consent), first-run notice, default-on onboarding.
- Version bump per the CLAUDE.md checklist (all manifests + `probe-manifest`),
  next release after 0.8.0.

## Cost & safety notes

- Cost is bounded by the existing debounce: edits accumulate in
  `source-queue.jsonl`; the worker runs only when the oldest item is older than
  `idleSeconds` (90s) or `maxItems` (5) accumulate; repeated edits of the same
  file dedup to one. A failed/quota-exhausted CLI sets a cooldown that suppresses
  further calls until expiry. Missing host CLI → 127 no-op.
- Safety net unchanged: `wiki_compile.py` still lints (rejects transcript-like /
  secret-like candidates), writes only under `.auto-context/wiki`, marks output
  `generated` (low-priority), and `requireReviewForCanon` stays true.
- The relaxed gate's residual risk (cloned untrusted `backends` auto-running) is
  accepted and disclosed (README + first-run notice), not gated.

## Testing

- **Worker**: configured backend runs with no env set (gate removed); existing
  dispatch/debounce/dedup/cooldown/127-fallback tests stay green with the env
  lines removed.
- **`--enable-compile`**: on a fresh opt-in project, writes triggers+extractor
  +batch with auto-derived adapter paths and all three engines; idempotent
  (second run no-ops cleanly); scaffolds wiki when missing; refuses when no opt-in
  config exists; path-safety honored. Use `CLAUDE_PLUGIN_ROOT` override in tests
  to assert derived paths deterministically.
- **recommend_config / --init-wiki**: produced config includes the wiki+compile
  block; `config.py` normalization preserves it (extractor dispatch/backends/
  default/cooldownSeconds + batch already normalized).
- **First-run notice**: shown once when backends configured and marker absent;
  marker suppresses repeats; not shown when extractor unconfigured.
- **Skill**: wrapper invokes the core command and relays output (fake/stub core
  in test, no real CLI).
- All deterministic; no test invokes a real host CLI.

## Open items for the plan

- Exact `recommend_config.py` shape change (reuse the `--init-wiki` compile block
  to avoid drift between the two onboarding paths).
- Whether `--enable-compile` engine auto-detection should *omit* absent CLIs from
  `backends` instead of wiring all three. Default: wire all three (harmless 127
  no-op, host-portable); revisit only if noise in audit logs is a problem.
- Skill naming/placement consistent with existing `skills/` entries.
