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

test("hint skill metadata and wrapper contract", () => {
  const skill = readFileSync("skills/hint/SKILL.md", "utf8");
  const meta = frontmatter(skill);
  assert.equal(meta.name, "hint");
  assert.match(meta.description, /qmd/i);
  assert.match(meta.description, /posttool/i);
  assert.match(meta.description, /PostToolUse/);
  assert.match(skill, /core\/posttool\.py/);
  assert.match(skill, /file/i);

  const wrapper = readFileSync("skills/hint/scripts/hint.sh", "utf8");
  assert.match(wrapper, /SKILL_DIR=.*dirname/);
  assert.match(wrapper, /PLUGIN_ROOT/);
  assert.match(wrapper, /core\/posttool\.py/);
  assert.ok((statSync("skills/hint/scripts/hint.sh").mode & 0o111) !== 0, "wrapper must be executable");
});

test("hint wrapper uses posttool fixture and returns hook context", () => {
  const base = join(homedir(), ".tmp-qmd-hint-skill");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "proj-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  const file = join(dir, "docs", "a.md");
  writeFileSync(join(dir, ".auto-context.json"), JSON.stringify({
    indexing: true,
    collections: ["axiom"],
    collectionPaths: { axiom: "docs" },
  }));
  writeFileSync(file, "원오빌 문의 기반 정렬 어떻게 동작해?\n");
  try {
    const out = execFileSync("bash", ["skills/hint/scripts/hint.sh", dir, file], {
      encoding: "utf8",
      env: { ...process.env, QMD_QUERY_FIXTURE: "test/fixtures/daemon-response.json" },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[axiom\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
