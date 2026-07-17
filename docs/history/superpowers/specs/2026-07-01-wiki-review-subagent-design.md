# Wiki Review Semi-Autonomous Subagent — Design

**Date**: 2026-07-01
**Status**: approved (brainstorming → ready for implementation plan)
**Builds on**: `2026-07-01-wiki-semantic-dedup-supersede-design.md` (Phase 1 — `core/wiki_review.py`, the
`merge`/`supersede`/`separate`/`discard` CLI, `skills/wiki-review/` manual skill; all merged to main)

## Problem

`skills/wiki-review/SKILL.md` today makes the *user* read `.auto-context/compile/merge-needed.jsonl`
one entry at a time, look at the candidate next to the matched existing page, decide an action, and
have the agent run `wiki-review.sh <cwd> <index> <action>` per entry. For a project whose wiki grows
quickly (many episodes/sessions), this queue can accumulate faster than a human wants to babysit it
one entry at a time.

`core/wiki_review.py` already has every safety property needed for autonomous use — it was built in
Phase 1 with a full-branch review pass specifically to survive slug collisions, path escapes, and
crash-mid-resolve without losing data (see `2026-07-01-wiki-semantic-dedup-supersede-design.md`'s
hardening history). What's missing is a way to let an agent *use* it in a loop, and a place to define
that loop as a reusable, host-portable capability rather than one-off ad hoc instructions typed into
a conversation.

## Goals

- Let an agent read the entire `merge-needed.jsonl` queue, judge each entry itself (using the
  candidate's summary and the matched page's actual content), execute the judged action via the
  existing `wiki-review.sh` wrapper, and report a summary — without requiring per-entry human
  approval mid-run.
- Work across all three hosts this plugin supports: Claude Code, Codex, Hermes Agent.
- Reuse `core/wiki_review.py`'s existing CLI and its fail-safes as-is. This design adds a *caller*,
  not new resolution logic.
- Ship as part of the plugin (marketplace-distributed) so any project that installs qmd-auto-context
  gets this capability, consistent with the project's "marketplace install only, no install.sh" rule.

## Non-Goals

- Changing `core/wiki_review.py`, `core/wiki_compile.py`, or any Phase 1/2 resolution logic. This is a
  new consumer of an existing, already-hardened CLI.
- A numeric per-run cap on how many entries get auto-resolved, or a "pause and ask" escape hatch for
  ambiguous cases. Locked during brainstorming: the agent resolves the whole queue every run; the only
  fallback behavior is whatever `wiki_review.py` itself already does (e.g. stale-match → `separate`).
- Restricting the agent's tool access. Locked during brainstorming: full `Read`/`Write`/`Edit`/`Bash`
  access, not narrowed to `Read`+`Bash` even though the workflow only needs those two.
- A persistent, plugin-bundled agent/role definition for Codex or Hermes. Neither host's plugin
  manifest supports bundling one (see Architecture) — both get an in-skill textual spawn instruction
  instead, not a file-based role.

## Architecture

### Per-host capability matrix (confirmed via source research, not assumed)

| Host | Can a *plugin* bundle a persistent agent/role? | Mechanism this design uses |
|---|---|---|
| Claude Code | **Yes.** A plugin's `agents/` directory (plugin root) is auto-scanned the same way `skills/` already is — no manifest declaration needed. Loaded agents are tagged `source: 'plugin'` and merged with user/project agents. (`claude-code-recovered/src/utils/plugins/loadPluginAgents.ts:250-297`, `loadAgentsDir.ts:362-366`) | New file `agents/wiki-review-resolver.md` at the plugin root. |
| Codex | **No.** Plugin manifest (`PluginManifestPaths`) supports `skills`/`mcp_servers`/`apps`/`hooks` only — no agent-role field. Agent roles are discovered solely from the config-layer `agents/` directory stack, which a plugin cannot contribute to. (`codex/codex-rs/plugin/src/manifest.rs:19-23`, `codex/codex-rs/core/src/config/agent_roles.rs:75-81`) | No role file. `skills/wiki-review/SKILL.md` gains a section instructing the model to spawn a subagent via Codex's own multi-agent tool, with the workflow instructions inlined as the spawn prompt. |
| Hermes Agent | **No.** `plugin.yaml`'s manifest (`kind: standalone`, `provides_hooks`, `provides_tools`) has no `provides_skills`/`provides_agents` field — skills live in a separate `~/.hermes/skills/` tree the plugin can't populate, and subagent delegation (`delegate_task`, `leaf`/`orchestrator` roles) is a runtime tool call, not a pre-registered role file. | Same `skills/wiki-review/SKILL.md` section as Codex — host-agnostic instructions work for Hermes's `delegate_task` (role: `leaf`) the same way they work for Codex's spawn tool, since both are "spawn now with this prompt," not "register a persistent role." |

This is why the design converges on **one bundled Agent for Claude, one shared textual instruction
block for Codex+Hermes** rather than three parallel host-specific artifacts — Codex and Hermes have
the same shape of limitation and the same shape of workaround.

### Workflow (shared content — appears in the Claude agent's body, and verbatim in the SKILL.md's
spawn-instruction block for Codex/Hermes)

```
1. Read `.auto-context/compile/merge-needed.jsonl` in the target project.
   Empty or missing → report "nothing pending" and stop.
2. For each entry (in file order):
   a. Read the candidate (title/summary/suggestedType) already embedded in the entry.
   b. Read the actual content at `matchedPath`.
   c. Judge one action:
      - Same fact/event, worth folding in → `merge`
      - `decision`-type candidate that reverses/replaces the matched page's principle → `supersede`
      - Looks unrelated on inspection (semantic gate false positive) → `separate`
      - Not worth keeping at all → `discard`
      - `matchedPath` unreadable/missing → still call the CLI with whatever action was judged;
        `wiki_review.py`'s own stale-match fallback (→ `separate`) handles it. Do not special-case
        this in the agent — that logic already exists and is already tested.
   d. Run: `bash <plugin-root>/skills/wiki-review/scripts/wiki-review.sh <cwd> <index> <action>`
      Re-derive `<index>` fresh before each call by re-reading the queue file — resolving one entry
      removes it from the queue and shifts every later index down by one. Do not compute all indices
      up front from a single initial read.
   e. Record the CLI's JSON stdout (action/targetPath/etc.) for the final report.
   f. If the command exits non-zero, or stdout is not valid JSON: STOP. Do not process any further
      entries this run — you cannot tell from here whether the queue was already mutated before the
      failure, and continuing risks skipping or double-processing entries against a stale index. Go
      straight to step 3's table with this entry marked "resolution failed / not attempted" and every
      remaining unprocessed entry marked "not attempted this run".
3. Print a table: one row per entry reached — `title | judged action | targetPath | one-line reasoning`,
   using "resolution failed" / "not attempted this run" per 2.f where applicable. If nothing was
   pending at step 1, this table is just the "nothing pending" message. If the run stopped early via
   2.f, say so plainly before the table so the human knows to re-run manually after investigating.
```

### Components

- **`agents/wiki-review-resolver.md`** (new, plugin root, Claude Code only): frontmatter
  `name: wiki-review-resolver`, `description` written so Claude auto-delegates on the same trigger
  phrases the SKILL.md already lists ("wiki review 해줘", "merge-needed 처리해줘", etc.) plus explicit
  "resolve pending wiki review items" phrasing; no `tools`/`disallowedTools` restriction (locked
  decision above — full access); no `permissionMode` override (needs to reach `Bash`/`Write`/`Edit`
  freely); body = the Workflow section above, written as agent instructions.
- **`skills/wiki-review/SKILL.md`** (changed): keep the existing manual per-entry workflow as
  documentation for a human who wants to drive it by hand, and add a new section instructing the
  model — for hosts other than Claude, or when the user explicitly wants semi-autonomous handling —
  to spawn a subagent using the Workflow text verbatim as the spawn prompt. This section is written
  host-agnostically ("spawn a subagent with this prompt via whatever delegation mechanism your host
  provides — Codex's multi-agent tool, Hermes's `delegate_task` with role `leaf`") rather than
  branching into host-specific prose, since the instruction content is identical either way.
- No changes to `core/wiki_review.py`, `skills/wiki-review/scripts/wiki-review.sh`, or any Phase 1/2
  file. The wrapper script is called exactly as it already is today, once per resolved entry.

## Error Handling

- Every failure mode `wiki_review.py` already handles *and reports as a clean JSON result* (stale
  match → `separate` fallback, path escape, unwritable target, crash mid-resolve with requeue) is
  handled identically here, because this design never bypasses the CLI — it only decides which
  `--action` to pass and reads back the CLI's own JSON verdict. No new error handling is introduced
  for these cases; introducing any would risk diverging from the already-hardened behavior in
  `core/wiki_review.py`.
- If the CLI wrapper itself fails to produce that clean result — non-zero exit, or stdout that isn't
  valid JSON — the agent cannot tell from the outside whether `wiki_review.py` mutated the queue
  (removed/rewrote the entry) before failing. Continuing to the next entry in that state risks
  processing a stale index against a queue whose actual contents no longer match what the agent last
  read, which can silently skip or double-process entries. **The agent must therefore stop resolving
  entries for the rest of this run immediately** — do not proceed to the next queue entry — and report
  the failing entry plus every entry not yet reached as "resolution failed / not attempted this run"
  in the final table. This is a whole-run stop, not a per-entry skip.
- No queue-level lock is needed beyond what `wiki_review.py`/`claim_queue` already provide (Phase 1) —
  this design calls the CLI sequentially, one entry at a time, never concurrently.

## Testing

- This design has no new Python/Node logic to unit-test — it's a new Markdown agent file and a new
  documentation section in an existing SKILL.md, not executable code. Verification is behavioral:
  1. Manually create a `merge-needed.jsonl` with a few entries (mix of `entity`/`decision` types, one
     with a deliberately-deleted `matchedPath`) in a scratch project with this plugin installed.
  2. In Claude Code, prompt with a trigger phrase and confirm the `wiki-review-resolver` agent gets
     delegated to (not handled inline by the main thread) and produces the expected final table with
     the stale-match entry correctly falling back to `separate`.
  3. Repeat the same scratch-queue scenario via Codex's own subagent spawn to confirm the SKILL.md's
     inlined instructions produce equivalent behavior without a persistent role file.
  4. Add one entry with a malformed/corrupt `merge-needed.jsonl` line, or temporarily rename
     `wiki-review.sh` so the wrapper call itself fails (non-zero exit / non-JSON stdout), and confirm
     the agent stops the whole run per the Error Handling 2.f policy — the table shows that entry and
     every later entry as not attempted, rather than skipping past the failure and continuing.
  5. `npm test` must stay green (no code changed, but confirms nothing was accidentally touched).
- The implementation plan should include a task for checking whether an existing `test/manual-skills.test.mjs`-style
  structural check (e.g. "does `agents/wiki-review-resolver.md` exist and parse as valid frontmatter +
  body") is worth adding — this repo already asserts skill/manifest structure in tests, so a matching
  assertion for the new `agents/` file keeps that convention consistent, even though the agent's
  *behavior* can't be unit-tested the way `core/*.py` can.
