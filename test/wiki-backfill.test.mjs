import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BUILTINS = ["claude", "codex", "hermes"];

function makeEnv(extra = {}) {
  const base = mkdtempSync(join(tmpdir(), "qmd-backfill-env-"));
  return {
    base,
    env: {
      ...process.env,
      QMD_SYNC_STATE_DIR: join(base, "state"),
      QMD_DIRTY_QUEUE: join(base, "queue"),
      QMD_SYNC_LOCKDIR: join(base, "lock.d"),
      QMD_ENGINE: "codex",
      ...extra,
    },
  };
}

function makeProject() {
  // config discovery walks up to the HOME boundary, so projects must live under HOME.
  const base = join(homedir(), ".tmp-qmd-backfill-test");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "proj-"));
}

function writeSettings(dir, overrides = {}) {
  const settings = {
    indexing: true,
    collections: ["docs-src"],
    collectionPaths: { "docs-src": "docs" },
    collectionRoles: { "docs-src": "raw" },
    ...overrides,
    compile: {
      enabled: true,
      mode: "auto-wiki",
      autoWrite: true,
      triggers: ["post_tool_source", "manual"],
      sourceQueuePath: ".auto-context/compile/source-queue.jsonl",
      manifestPath: ".auto-context/compile/generated-manifest.jsonl",
      extractor: {
        dispatch: "by-engine",
        backends: {},
        builtins: BUILTINS,
        default: [],
        timeout: 120,
      },
      ...(overrides.compile || {}),
    },
  };
  mkdirSync(join(dir, ".auto-context"), { recursive: true });
  writeFileSync(join(dir, ".auto-context", "settings.json"), JSON.stringify(settings));
}

function writeDoc(dir, rel, body = "# doc\n") {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function runBackfill(cwd, envInfo, args = []) {
  const out = execFileSync("python3", ["core/wiki_backfill.py", "--cwd", cwd, "--json", ...args], {
    encoding: "utf8",
    env: envInfo.env,
  });
  return out.trim() ? JSON.parse(out) : null;
}

function queuePath(dir) {
  return join(dir, ".auto-context", "compile", "source-queue.jsonl");
}

function queuedSources(dir) {
  const path = queuePath(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("backfill enumerates sources the sync snapshot considers unchanged", () => {
  const project = makeProject();
  const envInfo = makeEnv();
  try {
    writeSettings(project);
    writeDoc(project, "docs/a.md");
    writeDoc(project, "docs/b.md");

    // Record a sync baseline first: after this, sync sees nothing to do.
    const syncOut = execFileSync("python3", ["core/sync.py", "--cwd", project, "--json"], {
      encoding: "utf8", env: envInfo.env,
    });
    assert.equal(JSON.parse(syncOut).reason, "synced");
    const again = JSON.parse(execFileSync("python3", ["core/sync.py", "--cwd", project, "--json"], {
      encoding: "utf8", env: envInfo.env,
    }));
    assert.equal(again.reason, "unchanged");
    assert.equal(again.compileQueued, 0);

    // Backfill ignores the snapshot entirely and still finds both documents.
    const plan = runBackfill(project, envInfo);
    assert.equal(plan.totalSources, 2);
    assert.equal(plan.uncovered, 2);
    assert.deepEqual(plan.selected, ["docs/a.md", "docs/b.md"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});

test("backfill writes nothing without explicit per-run consent", () => {
  const project = makeProject();
  const envInfo = makeEnv();
  try {
    writeSettings(project);
    writeDoc(project, "docs/a.md");

    const plan = runBackfill(project, envInfo);
    assert.equal(plan.reason, "consent_required");
    assert.equal(plan.consent, false);
    assert.equal(plan.enqueued, 0);
    assert.equal(plan.selected.length, 1);
    assert.equal(existsSync(queuePath(project)), false);
    assert.equal(existsSync(join(project, ".auto-context", "compile", "backfill-runs.jsonl")), false);

    const run = runBackfill(project, envInfo, ["--consent"]);
    assert.equal(run.reason, "enqueued");
    assert.equal(run.enqueued, 1);
    assert.deepEqual(queuedSources(project).map((r) => r.source.path), ["docs/a.md"]);
    assert.equal(queuedSources(project)[0].trigger, "backfill_source");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});

test("backfill per-run cap is enforced in code and selection is deterministic", () => {
  const project = makeProject();
  const envInfo = makeEnv();
  try {
    writeSettings(project);
    for (let i = 0; i < 60; i += 1) {
      writeDoc(project, `docs/d${String(i).padStart(2, "0")}.md`);
    }

    // A caller asking for the whole corpus still gets at most MAX_ITEMS_PER_RUN.
    const run = runBackfill(project, envInfo, ["--limit", "999", "--consent"]);
    assert.equal(run.cap, 25);
    assert.equal(run.capApplied, true);
    assert.equal(run.uncovered, 60);
    assert.equal(run.enqueued, 25);
    assert.equal(queuedSources(project).length, 25);

    // Deterministic: a fresh project with the same corpus picks the same 25 files,
    // spread over the sorted path order rather than clustered at the front.
    const other = makeProject();
    try {
      writeSettings(other);
      for (let i = 0; i < 60; i += 1) {
        writeDoc(other, `docs/d${String(i).padStart(2, "0")}.md`);
      }
      const plan = runBackfill(other, envInfo, ["--limit", "999"]);
      assert.deepEqual(plan.selected, run.selected);
      assert.equal(plan.selected[0], "docs/d00.md");
      assert.ok(plan.selected.includes("docs/d57.md"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});

test("backfill skips sources the generated manifest already covers", () => {
  const project = makeProject();
  const envInfo = makeEnv();
  try {
    writeSettings(project);
    writeDoc(project, "docs/a.md");
    writeDoc(project, "docs/b.md");
    const manifest = join(project, ".auto-context", "compile", "generated-manifest.jsonl");
    mkdirSync(join(manifest, ".."), { recursive: true });
    writeFileSync(manifest, JSON.stringify({
      action: "created",
      targetPath: ".auto-context/wiki/concepts/a.md",
      sources: [{ kind: "file", path: "docs/a.md", collection: "docs-src" }],
    }) + "\n");

    const plan = runBackfill(project, envInfo);
    assert.equal(plan.totalSources, 2);
    assert.equal(plan.covered, 1);
    assert.deepEqual(plan.selected, ["docs/b.md"]);

    const recompile = runBackfill(project, envInfo, ["--recompile"]);
    assert.equal(recompile.covered, 0);
    assert.deepEqual(recompile.selected, ["docs/a.md", "docs/b.md"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});

test("backfill reuses the enqueue gating instead of reimplementing it", () => {
  const project = makeProject();
  const envInfo = makeEnv();
  try {
    writeSettings(project, {
      collections: ["docs-src", "proj-wiki"],
      collectionPaths: { "docs-src": "docs", "proj-wiki": ".auto-context/wiki" },
      collectionRoles: { "docs-src": "raw", "proj-wiki": "wiki" },
      skipPaths: ["scratch"],
    });
    writeDoc(project, "docs/keep.md");
    writeDoc(project, "docs/notes.txt");            // not markdown
    writeDoc(project, "docs/.draft/hidden.md");     // dot segment below the collection root
    writeDoc(project, "docs/scratch/junk.md");      // skipPaths (recall would filter the card)
    writeDoc(project, ".auto-context/wiki/entities/card.md"); // wiki role, DENIED segment

    const plan = runBackfill(project, envInfo);
    assert.deepEqual(plan.selected, ["docs/keep.md"]);
    assert.equal(plan.totalSources, 1);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});

test("backfill is a no-op when the project has not opted into source compile", () => {
  const project = makeProject();
  const envInfo = makeEnv();
  try {
    writeSettings(project, { compile: { triggers: ["manual"] } });
    writeDoc(project, "docs/a.md");

    const run = runBackfill(project, envInfo, ["--consent"]);
    assert.equal(run.reason, "compile_disabled");
    assert.equal(run.enqueued, 0);
    assert.equal(existsSync(queuePath(project)), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});

test("backfill records each consented run for traceability", () => {
  const project = makeProject();
  const envInfo = makeEnv();
  try {
    writeSettings(project);
    writeDoc(project, "docs/a.md");
    runBackfill(project, envInfo, ["--consent"]);
    const log = join(project, ".auto-context", "compile", "backfill-runs.jsonl");
    const row = JSON.parse(readFileSync(log, "utf8").trim());
    assert.equal(row.consent, true);
    assert.equal(row.trigger, "backfill_source");
    assert.equal(row.cap, 25);
    assert.deepEqual(row.sources, ["docs/a.md"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});

test("backfill is never reachable from a hook", () => {
  // The whole point of 2.4 is that no automatic path spends the user's tokens on
  // documents they never touched. Guard against a future hook wiring it up.
  for (const rel of ["hooks/run-hook", "hooks/hooks.json", "hooks/hooks-codex.json",
    "core/posttool.py", "core/index_enqueue.py", "core/wiki_compile_enqueue.py",
    "core/update.sh", "core/backend_manager.sh", "hermes_adapter/plugin.py"]) {
    if (!existsSync(rel)) continue;
    assert.equal(readFileSync(rel, "utf8").includes("wiki_backfill"), false, rel);
  }
});

test("backfill sandbox guard exits silently", () => {
  const project = makeProject();
  const envInfo = makeEnv({ QMD_SANDBOX: "1" });
  try {
    writeSettings(project);
    writeDoc(project, "docs/a.md");
    const out = execFileSync("python3", ["core/wiki_backfill.py", "--cwd", project, "--json", "--consent"], {
      encoding: "utf8", env: envInfo.env,
    });
    assert.equal(out.trim(), "");
    assert.equal(existsSync(queuePath(project)), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});

test("backfill trigger literal is shared, not re-declared", () => {
  // If wiki_compile's copy drifts from config.COMPILE_TRIGGERS, the "create only"
  // guard below silently stops firing and pre-existing verified cards go back to
  // being deletable through a backfill-driven update.
  const compile = readFileSync("core/wiki_compile.py", "utf8");
  const cfg = readFileSync("core/config.py", "utf8");
  const backfill = readFileSync("core/wiki_backfill.py", "utf8");
  assert.match(compile, /BACKFILL_TRIGGER = "backfill_source"/);
  assert.match(backfill, /BACKFILL_TRIGGER = "backfill_source"/);
  assert.match(cfg, /"backfill_source"/);
});

test("backfill never updates an existing card (create only)", () => {
  // Measured in the pilot: an extractor picked a targetPath that already existed, the
  // update path reset status to `generated`, and the verifier then deleted a card that
  // had been `verified`. Backfill has no grounds to update -- its source did not change.
  const project = makeProject();
  const envInfo = makeEnv();
  try {
    writeSettings(project, {
      wikiPath: ".auto-context/wiki",
      collections: ["docs-src", "proj-wiki"],
      collectionPaths: { "docs-src": "docs", "proj-wiki": ".auto-context/wiki" },
      collectionRoles: { "docs-src": "raw", "proj-wiki": "wiki" },
      compile: { autoWrite: true, mode: "auto-wiki", verify: { enabled: false } },
    });
    writeDoc(project, "docs/a.md", "# a\n\nDurable decision: the source cites markdown.\n");
    const cardRel = ".auto-context/wiki/entities/existing.md";
    const existing = [
      '---', 'title: "Existing"', 'canonicalKey: "existing"', 'type: entity',
      'status: verified', 'createdBy: qmd-auto-context', 'reviewed: false', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="old" -->', '## Summary',
      'The original verified claim.', '<!-- qmd:auto:end -->', '',
    ].join('\n');
    mkdirSync(join(project, ".auto-context", "wiki", "entities"), { recursive: true });
    writeFileSync(join(project, cardRel), existing);

    const candidate = {
      trigger: "backfill_source",
      engine: "codex",
      title: "Existing",
      summary: "Durable decision: a backfilled candidate aimed at an existing card path.",
      suggestedType: "entity",
      confidence: "high",
      targetPath: cardRel,
      sources: [{ kind: "file", path: "docs/a.md", collection: "docs-src" }],
    };
    const out = execFileSync("python3", ["core/wiki_compile.py", "--cwd", project], {
      encoding: "utf8", env: envInfo.env, input: JSON.stringify(candidate),
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.action, "skipped");
    assert.equal(parsed.reason, "backfill_would_update_existing");
    assert.equal(readFileSync(join(project, cardRel), "utf8"), existing, "card must be byte-identical");

    // The guard is trigger-specific: the edit path reaches the normal existing-card
    // handling (update or merge-needed), never the backfill skip.
    const edited = execFileSync("python3", ["core/wiki_compile.py", "--cwd", project], {
      encoding: "utf8", env: envInfo.env,
      input: JSON.stringify({ ...candidate, trigger: "post_tool_source" }),
    });
    const editedAction = JSON.parse(edited.trim());
    assert.notEqual(editedAction.reason, "backfill_would_update_existing");
    assert.ok(["updated", "merge-needed"].includes(editedAction.action), editedAction.action);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(envInfo.base, { recursive: true, force: true });
  }
});
