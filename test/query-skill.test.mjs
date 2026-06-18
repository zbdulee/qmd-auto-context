import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(match, "missing YAML frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const idx = line.indexOf(":");
    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }));
}

test("query skill metadata and wrapper contract", () => {
  const skill = readFileSync("skills/query/SKILL.md", "utf8");
  const meta = frontmatter(skill);
  assert.equal(meta.name, "query");
  assert.match(meta.description, /qmd/i);
  assert.match(meta.description, /recall/i);
  assert.match(meta.description, /\.auto-context\.json/);
  assert.match(skill, /core\/recall\.py/);
  assert.match(skill, /hook/i);

  const wrapper = readFileSync("skills/query/scripts/query.sh", "utf8");
  assert.match(wrapper, /SKILL_DIR=.*dirname/);
  assert.match(wrapper, /PLUGIN_ROOT/);
  assert.match(wrapper, /core\/recall\.py/);
  assert.ok((statSync("skills/query/scripts/query.sh").mode & 0o111) !== 0, "wrapper must be executable");
});

test("query wrapper uses recall fixture and returns hook context", () => {
  const base = join(homedir(), ".tmp-qmd-query-skill");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "proj-"));
  writeFileSync(join(dir, ".auto-context.json"), JSON.stringify({
    indexing: true,
    collections: ["axiom"],
  }));
  try {
    const out = execFileSync("bash", ["skills/query/scripts/query.sh", dir, "원오빌 문의 기반 정렬 어떻게 동작해?"], {
      encoding: "utf8",
      env: { ...process.env, QMD_QUERY_FIXTURE: "test/fixtures/daemon-response.json" },
    });
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[axiom\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
