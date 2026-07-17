# Wiki Review Semi-Autonomous Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent resolve the entire `.auto-context/compile/merge-needed.jsonl` queue autonomously (judging each entry itself and calling the existing `wiki-review.sh` CLI) and report a summary afterward, on all three hosts this plugin supports (Claude Code, Codex, Hermes Agent).

**Architecture:** Claude Code auto-scans a plugin's `agents/` directory with no manifest declaration, so add `agents/wiki-review-resolver.md` there. Codex and Hermes Agent plugin manifests have no agent-role field, so `skills/wiki-review/SKILL.md` gains a host-agnostic section instructing the model to spawn a subagent using the exact same Workflow text as the spawn prompt. No `core/*.py` file changes — this plan only adds two Markdown artifacts plus their structural tests.

**Tech Stack:** Markdown (Claude Code agent frontmatter + body), Node's built-in `node:test` for structural verification (same pattern as `test/query-skill.test.mjs` / `test/manual-skills.test.mjs`).

## Global Constraints

- No changes to `core/wiki_review.py`, `skills/wiki-review/scripts/wiki-review.sh`, or any other `core/*.py` file. This plan only adds a *caller* of the already-hardened CLI. (Spec Non-Goals / Components)
- No numeric per-run cap and no "pause and ask" escape hatch. The agent/subagent resolves the whole queue every run; the only fallback is whatever `wiki_review.py` itself already does. (Spec Non-Goals, locked during brainstorming)
- No tool restriction on the agent — do not set `tools` or `disallowedTools` in `agents/wiki-review-resolver.md`'s frontmatter. Full `Read`/`Write`/`Edit`/`Bash` access. (Spec Non-Goals, locked during brainstorming)
- No `permissionMode` override in `agents/wiki-review-resolver.md`'s frontmatter — it needs to reach `Bash`/`Write`/`Edit` freely. (Spec Components)
- No `.claude-plugin/plugin.json` change. Confirmed via `claude-code-recovered/src/utils/plugins/pluginLoader.ts:1530-1532`: a plugin's `agentsPath` is unconditionally set to `<plugin-root>/agents` — there is no manifest field to declare and none should be added.
- The Workflow text (the numbered steps an agent/subagent follows) must be byte-identical between `agents/wiki-review-resolver.md` and the new section in `skills/wiki-review/SKILL.md`. (Spec Components: "verbatim")
- On CLI wrapper failure (non-zero exit, or stdout that isn't valid JSON): the agent must **stop resolving entries for the rest of that run**, not skip just that one entry and continue. Report the failing entry and every unreached entry as "resolution failed / not attempted this run". (Spec Error Handling, added after Codex advisor review)
- This plan adds no new Python/Node production logic — the only executable content is the test file below. (Spec Testing)

---

### Task 1: `agents/wiki-review-resolver.md` — Claude Code plugin agent

**Files:**
- Create: `agents/wiki-review-resolver.md`
- Create: `test/wiki-review-resolver-agent.test.mjs`

**Interfaces:**
- Consumes: `skills/wiki-review/scripts/wiki-review.sh <cwd> <index> <merge|supersede|separate|discard>` (existing wrapper, unchanged — takes 3 positional args, prints one JSON object to stdout, e.g. `{"action":"merged","targetPath":"..."}`). `.auto-context/compile/merge-needed.jsonl` (existing queue file, one JSON object per line, fields include `candidate.title`/`candidate.summary`/`candidate.suggestedType`, `matchedPath`, `matchedScore`).
- Produces: the exact Workflow text block (delimited by `<!-- WORKFLOW:START -->` / `<!-- WORKFLOW:END -->` HTML comments) that Task 2 must reproduce byte-for-byte in `skills/wiki-review/SKILL.md`.

- [ ] **Step 1: Write the failing test**

Create `test/wiki-review-resolver-agent.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(match, "missing YAML frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const idx = line.indexOf(":");
    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }));
}

export function workflowBlock(text, filePath) {
  const startMarker = "<!-- WORKFLOW:START -->";
  const endMarker = "<!-- WORKFLOW:END -->";
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1 && end > start, `${filePath} missing WORKFLOW markers`);
  return text.slice(start + startMarker.length, end).trim();
}

test("wiki-review-resolver agent: metadata has no tool/permission restriction", () => {
  const agent = readFileSync("agents/wiki-review-resolver.md", "utf8");
  const meta = frontmatter(agent);
  assert.equal(meta.name, "wiki-review-resolver");
  assert.match(meta.description, /merge-needed\.jsonl/);
  assert.match(meta.description, /without per-entry human approval/);
  assert.equal(meta.tools, undefined, "must not restrict tools");
  assert.equal(meta.disallowedTools, undefined, "must not restrict tools");
  assert.equal(meta.permissionMode, undefined, "must not override permissionMode");
});

test("wiki-review-resolver agent: body carries the Workflow and whole-run-stop policy", () => {
  const agent = readFileSync("agents/wiki-review-resolver.md", "utf8");
  const block = workflowBlock(agent, "agents/wiki-review-resolver.md");
  assert.match(agent, /wiki-review\.sh/);
  assert.match(block, /Re-derive `<index>` fresh before each call/);
  assert.match(block, /STOP\. Do not process any further/);
  assert.match(block, /not attempted this run/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wiki-review-resolver-agent.test.mjs`
Expected: FAIL — `agents/wiki-review-resolver.md` does not exist yet (`ENOENT`).

- [ ] **Step 3: Create `agents/wiki-review-resolver.md`**

```markdown
---
name: wiki-review-resolver
description: Use to autonomously resolve the entire pending wiki merge/supersede queue in one run without per-entry human approval — e.g. "wiki review 자동으로 처리해줘", "merge-needed 큐 전체 resolve 해줘", "resolve pending wiki review items", "wiki dedup queue 전부 자동으로 처리해줘". Reads .auto-context/compile/merge-needed.jsonl (entries the semantic dedup gate in core/wiki_compile.py queued instead of auto-writing), judges merge, supersede, separate, or discard for every entry itself, applies each via the existing wiki-review.sh CLI, and reports a summary table only after the whole queue is resolved.
---

# Wiki Review Resolver

Autonomously resolves every pending candidate in `.auto-context/compile/merge-needed.jsonl` — the
queue the semantic-dedup gate in `core/wiki_compile.py` populates instead of auto-writing, because a
candidate looked similar to an existing wiki page without an exact `canonicalKey`/`alias`/`title`
match. Judge every entry yourself, in file order, without asking the human mid-run. Report a summary
table only after every entry has been reached (or the run stopped early — see step 2.f below).

## Workflow

<!-- WORKFLOW:START -->
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
<!-- WORKFLOW:END -->

## Notes

- Resolve `<plugin-root>` the same way the `wiki-review` skill does:
  `ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"`.
- Never edit `core/wiki_review.py`, `wiki-review.sh`, or the queue file directly — every mutation goes
  through step 2.d's wrapper call, the same script the manual `wiki-review` skill uses.
- Always show the final table in your response to the human, even when nothing was pending or the run
  stopped early.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/wiki-review-resolver-agent.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add agents/wiki-review-resolver.md test/wiki-review-resolver-agent.test.mjs
git commit -m "feat(wiki-review): add plugin-bundled autonomous resolver agent for Claude Code"
```

---

### Task 2: `skills/wiki-review/SKILL.md` — host-agnostic subagent spawn section for Codex/Hermes

**Files:**
- Modify: `skills/wiki-review/SKILL.md`
- Modify: `test/wiki-review-resolver-agent.test.mjs` (append test cases)

**Interfaces:**
- Consumes: Task 1's `workflowBlock(text, filePath)` helper (already exported from `test/wiki-review-resolver-agent.test.mjs`) and the Workflow text it verifies in `agents/wiki-review-resolver.md`.
- Produces: nothing further downstream — this is the last task in the plan.

- [ ] **Step 1: Write the failing test**

Append to `test/wiki-review-resolver-agent.test.mjs` (add this `import` alongside the existing ones at
the top of the file, and these two `test()` blocks at the end of the file):

```js
// add near the top, with the other imports:
// (no new import needed — workflowBlock is already defined in this same file)

test("wiki-review-resolver agent and wiki-review SKILL.md share byte-identical Workflow text", () => {
  const agent = readFileSync("agents/wiki-review-resolver.md", "utf8");
  const skill = readFileSync("skills/wiki-review/SKILL.md", "utf8");
  const agentBlock = workflowBlock(agent, "agents/wiki-review-resolver.md");
  const skillBlock = workflowBlock(skill, "skills/wiki-review/SKILL.md");
  assert.equal(agentBlock, skillBlock, "Workflow text must be verbatim-identical across both artifacts");
});

test("wiki-review SKILL.md documents host-agnostic subagent spawn for Codex/Hermes", () => {
  const skill = readFileSync("skills/wiki-review/SKILL.md", "utf8");
  assert.match(skill, /delegate_task/);
  assert.match(skill, /role `leaf`/);
  assert.match(skill, /agents\/wiki-review-resolver\.md/);
  assert.match(skill, /spawn/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wiki-review-resolver-agent.test.mjs`
Expected: FAIL — the second new test fails first (`skills/wiki-review/SKILL.md` has no `delegate_task`/`role \`leaf\`` text yet); the byte-identity test also fails (`skills/wiki-review/SKILL.md` has no `WORKFLOW:START` marker yet, so `workflowBlock()` throws via `assert.ok`).

- [ ] **Step 3: Add the new section to `skills/wiki-review/SKILL.md`**

Append this section to the end of `skills/wiki-review/SKILL.md` (after the existing `## Safety`
section, which stays unchanged):

```markdown

## Semi-Autonomous Resolution (Codex / Hermes Agent, or on request)

Claude Code ships this capability as a plugin-bundled agent (`agents/wiki-review-resolver.md`) that
autonomously resolves the whole queue and reports afterward — Claude auto-delegates to it on trigger
phrases like "wiki review 자동으로 처리해줘" without any further prompting from this file.

Codex and Hermes Agent cannot bundle a persistent role the same way — their plugin manifests have no
agent-role field (see `docs/superpowers/specs/2026-07-01-wiki-review-subagent-design.md`'s Architecture
section for the source-level confirmation). On those hosts — or whenever the user explicitly wants the
whole queue resolved on any host without per-entry approval — spawn a subagent right now, using your
host's own delegation mechanism (Codex's multi-agent tool, Hermes's `delegate_task` tool with role
`leaf`), with the following as the subagent's prompt verbatim:

<!-- WORKFLOW:START -->
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
<!-- WORKFLOW:END -->

Do not run this workflow inline in the main thread yourself — spawn it as a subagent so its
entry-by-entry judgment doesn't block on your own turn-by-turn confirmation.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/wiki-review-resolver-agent.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: all prior passing tests still pass, plus the 4 new tests in
`test/wiki-review-resolver-agent.test.mjs` (no regression in `test/manual-skills.test.mjs`, since the
`skillDirs` list it asserts only covers directory names under `skills/`, not file contents, and
`wiki-review` is already in that list).

- [ ] **Step 6: Commit**

```bash
git add skills/wiki-review/SKILL.md test/wiki-review-resolver-agent.test.mjs
git commit -m "feat(wiki-review): document host-agnostic subagent spawn for Codex/Hermes"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Architecture/Components → Task 1 + Task 2. Non-Goals (no core changes, no cap, no
  tool restriction, no persistent Codex/Hermes role) → Global Constraints, enforced by Task 1's test
  asserting absent `tools`/`disallowedTools`/`permissionMode` keys. Error Handling's whole-run-stop
  policy → embedded verbatim in both artifacts' Workflow text (Task 1 step 3, Task 2 step 3) and
  asserted by Task 1's second test (`STOP\. Do not process any further`) and the cross-file identity
  test in Task 2. The spec's Testing section's suggestion to consider a `manual-skills.test.mjs`-style
  structural check is realized as `test/wiki-review-resolver-agent.test.mjs`.
- **Out of scope for this plan (spec Testing items 2-4):** live behavioral verification (agent actually
  gets delegated to in a running Claude Code session; Codex subagent spawn produces equivalent
  behavior; a real wrapper failure triggers the stop-and-report path end-to-end) is manual, human-driven
  verification the spec itself scopes as post-implementation checks, not unit tests — no task in this
  plan can automate them, and none should try to fake it with a mocked "subagent runtime".
- **Type/name consistency:** `wiki-review-resolver` is used identically as the frontmatter `name:` value
  (Task 1) and the file path referenced in Task 2's SKILL.md section and tests — no drift.
