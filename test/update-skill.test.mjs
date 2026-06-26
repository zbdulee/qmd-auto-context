import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

test("update skill metadata and wrapper contract", () => {
  const skill = readFileSync("skills/update/SKILL.md", "utf8");
  const meta = frontmatter(skill);
  assert.equal(meta.name, "update");
  assert.match(meta.description, /qmd/i);
  assert.match(meta.description, /SessionStart/i);
  assert.match(meta.description, /\.auto-context\/settings\.json/);
  assert.match(meta.description, /index/i);
  assert.match(skill, /core\/update\.sh/);
  assert.match(skill, /hook/i);

  const wrapper = readFileSync("skills/update/scripts/update.sh", "utf8");
  assert.match(wrapper, /SKILL_DIR=.*dirname/);
  assert.match(wrapper, /PLUGIN_ROOT/);
  assert.match(wrapper, /QMD_BACKEND_MANAGER/);
  assert.match(wrapper, /check-qmd --manual/);
  assert.match(wrapper, /ensure --wait/);
  assert.match(wrapper, /warm/);
  assert.match(wrapper, /rotate/);
  assert.match(wrapper, /core\/update\.sh/);
  assert.match(wrapper, /cd "\$TARGET_CWD"/);
  assert.ok((statSync("skills/update/scripts/update.sh").mode & 0o111) !== 0, "wrapper must be executable");
});

test("update wrapper can invoke update path in sandbox without side effects", () => {
  const base = join(homedir(), ".tmp-qmd-update-skill");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "proj-"));
  try {
    const out = execFileSync("bash", ["skills/update/scripts/update.sh", dir], {
      encoding: "utf8",
      env: { ...process.env, QMD_SANDBOX: "1" },
    });
    assert.equal(out, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
