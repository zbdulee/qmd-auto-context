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
  assert.match(meta.description, /\.auto-context\/settings\.json/);
  assert.match(skill, /core\/recall\.py/);
  assert.match(skill, /hook/i);

  const wrapper = readFileSync("skills/query/scripts/query.sh", "utf8");
  assert.match(wrapper, /SKILL_DIR=.*dirname/);
  assert.match(wrapper, /PLUGIN_ROOT/);
  assert.match(wrapper, /QMD_BACKEND_MANAGER/);
  assert.match(wrapper, /check-qmd --manual/);
  assert.match(wrapper, /ensure --wait/);
  assert.match(wrapper, /core\/recall\.py/);
  assert.ok((statSync("skills/query/scripts/query.sh").mode & 0o111) !== 0, "wrapper must be executable");
});

test("query wrapper uses recall fixture and returns hook context", () => {
  const base = join(homedir(), ".tmp-qmd-query-skill");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "proj-"));
    mkdirSync(join(dir, ".auto-context"), { recursive: true });
    writeFileSync(join(dir, ".auto-context", "settings.json"), JSON.stringify({
      indexing: true,
      collections: ["sample"],
    }));
    const managerLog = join(dir, "manager.log");
    const manager = join(dir, "manager.sh");
    writeFileSync(manager, `#!/usr/bin/env bash\necho "$@" >> "${managerLog}"\n`, { mode: 0o755 });
    try {
      const out = execFileSync("bash", ["skills/query/scripts/query.sh", dir, "검색 결과 정렬은 어떻게 동작해?"], {
        encoding: "utf8",
        env: { ...process.env, QMD_QUERY_FIXTURE: "test/fixtures/daemon-response.json", QMD_BACKEND_MANAGER: manager },
      });
      const parsed = JSON.parse(out);
      assert.match(parsed.hookSpecificOutput.additionalContext, /\[sample\]/);
      assert.equal(readFileSync(managerLog, "utf8"), "check-qmd --manual\nensure --wait\n");
    } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
