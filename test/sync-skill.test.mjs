import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(match, "missing YAML frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const idx = line.indexOf(":");
    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }));
}

test("sync skill metadata and wrapper contract", () => {
  const skill = readFileSync("skills/sync/SKILL.md", "utf8");
  const meta = frontmatter(skill);
  assert.equal(meta.name, "sync");
  assert.match(meta.description, /\.auto-context\/settings\.json/);
  assert.match(meta.description, /create\/update\/delete|CUD/i);
  assert.match(meta.description, /dirty queue/i);
  assert.match(skill, /core\/sync\.py/);

  const wrapper = readFileSync("skills/sync/scripts/sync.sh", "utf8");
  assert.match(wrapper, /SKILL_DIR=.*dirname/);
  assert.match(wrapper, /PLUGIN_ROOT/);
  assert.match(wrapper, /QMD_BACKEND_MANAGER/);
  assert.match(wrapper, /check-qmd --manual/);
  assert.match(wrapper, /kick-index/);
  assert.match(wrapper, /core\/sync\.py/);
  assert.match(wrapper, /--cwd "\$TARGET_CWD" --json/);
  assert.ok((statSync("skills/sync/scripts/sync.sh").mode & 0o111) !== 0, "wrapper must be executable");
});
