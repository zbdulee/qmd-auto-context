# OSS Launch Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make qmd-auto-context safe and understandable for public adoption without changing its runtime behavior.

**Architecture:** Add a contract test that protects public repository claims, then use it to drive README, governance, CI, release, and historical-document changes. Preserve archived design material under `docs/history/` while declaring README, settings, and architecture as the current sources of truth.

**Tech Stack:** Markdown, JSON, GitHub Actions YAML, Node.js `node:test`, Bash, Python 3.

---

### Task 1: Lock the public-repository contract with tests

**Files:**
- Create: `test/oss-launch-readiness.test.mjs`
- Modify: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `docs/privacy.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/pull_request_template.md`
- Create: `.github/workflows/test.yml`
- Create: `docs/release.md`
- Create: `docs/history/README.md`

**Step 1: Write the failing test**

Add independent tests that assert:

- README names Claude Code, Codex, and Hermes Agent, contains a short English
  quickstart heading, describes temporary skip as project/cwd-scoped for two
  hours, and links to privacy/data handling;
- README and/or `docs/privacy.md` explains that optional wiki compile passes
  selected source content to the configured host CLI;
- policy, release, issue, pull-request, and CI files exist;
- CI uses `actions/setup-node` and runs `npm test`;
- `docs/history/README.md` declares the archive non-authoritative and points to
  README, settings, and architecture as current sources of truth.

**Step 2: Run the test to verify it fails**

Run: `node --test test/oss-launch-readiness.test.mjs`

Expected: FAIL because the public contract files and wording do not yet exist.

**Step 3: Add the minimal public contract files**

Create only the documents and workflow required by the test. Keep policies
short, Korean-first with an English opening where an external adopter needs it.
Do not expose `core/` shell commands as the normal user workflow.

**Step 4: Run the test to verify it passes**

Run: `node --test test/oss-launch-readiness.test.mjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add test/oss-launch-readiness.test.mjs README.md docs/privacy.md \
  CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md docs/release.md \
  .github/ISSUE_TEMPLATE/bug_report.yml .github/pull_request_template.md \
  .github/workflows/test.yml
git commit -m "docs(oss): add public contribution baseline"
```

### Task 2: Archive superseded plans and specifications

**Files:**
- Move: `docs/plans/*` → `docs/history/plans/`
- Move: `docs/superpowers/plans/*` → `docs/history/superpowers/plans/`
- Move: `docs/superpowers/specs/*` → `docs/history/superpowers/specs/`
- Create: `docs/history/README.md`
- Modify: `docs/architecture.md`
- Modify: `test/oss-launch-readiness.test.mjs`

**Step 1: Extend the failing test**

Assert that the old public paths no longer contain legacy plans/specs, archived
files are present under `docs/history/`, and the architecture document links to
the archive instead of treating old locations as live docs.

**Step 2: Run the test to verify it fails**

Run: `node --test test/oss-launch-readiness.test.mjs`

Expected: FAIL because legacy directories still exist at their old paths.

**Step 3: Move files without changing historical content**

Use `git mv` to preserve file history. Do not rewrite dated documents. Add the
archive README as the sole current-state marker, then adjust the architecture
link and wording to reference `docs/history/`.

**Step 4: Run focused verification**

Run:

```bash
node --test test/oss-launch-readiness.test.mjs
git diff --check
```

Expected: both commands succeed.

**Step 5: Commit**

```bash
git add -A docs test/oss-launch-readiness.test.mjs
git commit -m "docs(history): archive superseded plans"
```

### Task 3: Validate the release surface end-to-end

**Files:**
- Verify: `.claude-plugin/plugin.json`
- Verify: `.codex-plugin/plugin.json`
- Verify: `plugin.yaml`
- Verify: `.agents/plugins/marketplace.json`
- Verify: `.claude-plugin/marketplace.json`
- Verify: `README.md`
- Verify: `docs/release.md`

**Step 1: Validate structured metadata**

Run:

```bash
node -e 'for (const p of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", "plugin.json"]) JSON.parse(require("fs").readFileSync(p, "utf8"))'
```

Expected: exit 0.

**Step 2: Run focused and full regression tests**

Run:

```bash
node --test test/oss-launch-readiness.test.mjs
npm test
```

Expected: all tests pass; the live qmd integration test may remain explicitly
skipped when `QMD_LIVE` is not set.

**Step 3: Review the exact change set**

Run:

```bash
git diff main...HEAD --check
git status --short
```

Expected: no whitespace errors and only intended files changed.

**Step 4: Commit verification fixes if needed**

```bash
git add <intended-files>
git commit -m "test(oss): verify public release surface"
```

Only create this commit if a verification-driven correction is required.
