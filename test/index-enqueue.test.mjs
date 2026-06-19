import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function enqueue(cwd, payload, queuePath) {
  execFileSync("python3", ["core/index_enqueue.py"], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, QMD_DIRTY_QUEUE: queuePath },
  });
}

function setupProj(collections, indexing = true) {
  const dir = mkdtempSync(join(tmpdir(), "qproj-"));
  mkdirSync(join(dir, "04_Manuscript"), { recursive: true });
  writeFileSync(join(dir, ".auto-context.json"), JSON.stringify({
    collections, indexing, collectionPaths: { [collections[0]]: "04_Manuscript" },
  }));
  return dir;
}

test("연결된 폴더 story-path 편집 → 큐에 적재", () => {
  const proj = setupProj(["x-manuscript"]);
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(proj, { hook_event_name: "PostToolUse", cwd: proj,
    tool_input: { file_path: join(proj, "04_Manuscript", "ep1.md") } }, q);
  const lines = readFileSync(q, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^x-manuscript\t.*04_Manuscript$/);
});

test("agy TargetFile payload → 큐에 적재", () => {
  const proj = setupProj(["x-manuscript"]);
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(proj, {
    hook_event_name: "PostToolUse",
    tool_name: "write_to_file",
    cwd: proj,
    tool_input: { TargetFile: join(proj, "04_Manuscript", "ep1.md") },
  }, q);
  const lines = readFileSync(q, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^x-manuscript\t.*04_Manuscript$/);
});

test("agy ReplacementChunks payload → 큐에 적재", () => {
  const proj = setupProj(["x-manuscript"]);
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(proj, {
    hook_event_name: "PostToolUse",
    tool_name: "multi_replace_file_content",
    cwd: proj,
    tool_input: {
      ReplacementChunks: [
        { TargetFile: join(proj, "04_Manuscript", "ep1.md"), ReplacementContent: "충분히 긴 수정 텍스트" },
      ],
    },
  }, q);
  const lines = readFileSync(q, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^x-manuscript\t.*04_Manuscript$/);
});

test("collections 빈(pending) → 큐 미생성", () => {
  const proj = setupProj([], false); // indexing:false → collections=[]
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(proj, { hook_event_name: "PostToolUse", cwd: proj,
    tool_input: { file_path: join(proj, "04_Manuscript", "ep1.md") } }, q);
  assert.equal(existsSync(q), false);
});

test("컬렉션 밖 편집 → 큐 미생성", () => {
  const proj = setupProj(["x-manuscript"]);
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(proj, { hook_event_name: "PostToolUse", cwd: proj,
    tool_input: { file_path: join(proj, "README.md") } }, q);
  assert.equal(existsSync(q), false);
});

test("sandbox → 무동작", () => {
  const proj = setupProj(["x-manuscript"]);
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  execFileSync("python3", ["core/index_enqueue.py"], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: proj,
      tool_input: { file_path: join(proj, "04_Manuscript", "ep1.md") } }),
    encoding: "utf8", env: { ...process.env, QMD_DIRTY_QUEUE: q, QMD_SANDBOX: "1" },
  });
  assert.equal(existsSync(q), false);
});

test("postToolUse 이벤트 비활성화 → 큐 미생성", () => {
  const dir = mkdtempSync(join(tmpdir(), "qproj-"));
  mkdirSync(join(dir, "04_Manuscript"), { recursive: true });
  writeFileSync(join(dir, ".auto-context.json"), JSON.stringify({
    collections: ["x-manuscript"], indexing: true,
    collectionPaths: { "x-manuscript": "04_Manuscript" },
    events: ["sessionStart", "userPromptSubmit"],
  }));
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(dir, { hook_event_name: "PostToolUse", cwd: dir,
    tool_input: { file_path: join(dir, "04_Manuscript", "ep1.md") } }, q);
  assert.equal(existsSync(q), false);
});

test("shared dirty_queue writer uses sorted two-column lines", () => {
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  execFileSync("python3", ["-c", `
import sys
sys.path.insert(0, "core")
import dirty_queue
dirty_queue.enqueue_collections({"z": "/tmp/z", "a": "/tmp/a"})
`], {
    encoding: "utf8",
    env: { ...process.env, QMD_DIRTY_QUEUE: q },
  });
  assert.equal(readFileSync(q, "utf8"), "a\t/tmp/a\nz\t/tmp/z\n");
});
