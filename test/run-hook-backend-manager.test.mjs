import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

function runHook(args, input, env = {}) {
  return execFileSync("/bin/bash", ["hooks/run-hook", ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("sandbox exits before backend manager", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-runhook-sandbox-"));
  try {
    const marker = join(d, "manager.log");
    const manager = makeExecutable(join(d, "manager.sh"), `#!/usr/bin/env bash\necho "$@" >> "${marker}"\n`);
    const out = runHook(["update", "claude", "--sandbox"], "{}", { QMD_BACKEND_MANAGER: manager });
    assert.equal(out, "");
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("update action ensures, warms, rotates, then runs update core", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-runhook-update-"));
  try {
    const managerLog = join(d, "manager.log");
    const coreLog = join(d, "core.log");
    const manager = makeExecutable(join(d, "manager.sh"), `#!/usr/bin/env bash\necho "$@" >> "${managerLog}"\n`);
    const updateCore = makeExecutable(join(d, "update.sh"), `#!/usr/bin/env bash\necho update >> "${coreLog}"\n`);
    const out = runHook(["update", "codex"], "{}", {
      QMD_BACKEND_MANAGER: manager,
      QMD_CORE_UPDATE_SCRIPT: updateCore,
    });
    assert.equal(out, "");
    assert.equal(readFileSync(managerLog, "utf8"), "ensure --wait\nwarm\nrotate\n");
    assert.equal(readFileSync(coreLog, "utf8"), "update\n");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("posttool action waits for backend before posttool core", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-runhook-posttool-"));
  try {
    const managerLog = join(d, "manager.log");
    const coreLog = join(d, "core.log");
    const manager = makeExecutable(join(d, "manager.sh"), `#!/usr/bin/env bash\necho "$@" >> "${managerLog}"\n`);
    const posttoolCore = makeExecutable(join(d, "posttool.py"), `#!/usr/bin/env python3\nopen("${coreLog}", "a").write("posttool\\n")\n`);
    const out = runHook(["posttool", "gemini"], "{}", {
      QMD_BACKEND_MANAGER: manager,
      QMD_CORE_POSTTOOL_SCRIPT: posttoolCore,
    });
    assert.equal(out, "");
    assert.equal(readFileSync(managerLog, "utf8"), "ensure --wait\n");
    assert.equal(readFileSync(coreLog, "utf8"), "posttool\n");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("index action enqueues through core then kicks async worker", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-runhook-index-"));
  try {
    const managerLog = join(d, "manager.log");
    const stdinLog = join(d, "stdin.json");
    const manager = makeExecutable(join(d, "manager.sh"), `#!/usr/bin/env bash\necho "$@" >> "${managerLog}"\n`);
    const indexCore = makeExecutable(join(d, "index_enqueue.py"), `#!/usr/bin/env python3\nimport sys\nopen("${stdinLog}", "w").write(sys.stdin.read())\n`);
    const payload = '{"hook_event_name":"PostToolUse","cwd":"/tmp"}';
    const out = runHook(["index", "codex"], payload, {
      QMD_BACKEND_MANAGER: manager,
      QMD_CORE_INDEX_SCRIPT: indexCore,
    });
    assert.equal(out, "");
    assert.equal(readFileSync(stdinLog, "utf8"), payload);
    assert.equal(readFileSync(managerLog, "utf8"), "kick-index\n");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("index action stays silent if mktemp fails", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-runhook-mktemp-"));
  try {
    const managerLog = join(d, "manager.log");
    const stdinLog = join(d, "stdin.json");
    makeExecutable(join(d, "manager.sh"), `#!/usr/bin/env bash\necho "$@" >> "${managerLog}"\n`);
    makeExecutable(join(d, "index_enqueue.py"), `#!/usr/bin/env python3\nimport sys\nopen("${stdinLog}", "w").write(sys.stdin.read())\n`);
    makeExecutable(join(d, "mktemp"), "#!/usr/bin/env bash\necho mktemp failed >&2\nexit 1\n");

    const result = spawnSync("/bin/bash", ["hooks/run-hook", "index", "codex"], {
      input: "{}",
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${d}:${process.env.PATH}`,
        QMD_BACKEND_MANAGER: join(d, "manager.sh"),
        QMD_CORE_INDEX_SCRIPT: join(d, "index_enqueue.py"),
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(existsSync(stdinLog), false);
    assert.equal(existsSync(managerLog), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
