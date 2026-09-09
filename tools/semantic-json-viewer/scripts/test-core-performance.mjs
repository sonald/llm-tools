#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const runner = path.join(root, "scripts", "run-core-performance.mjs");

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sjv-core-runner-selfcheck-"));
  const fixture = path.join(directory, "fixture.json");
  const fakeBinary = path.join(directory, "fake-benchmark.mjs");
  await writeFile(fixture, "{}\n");
  await writeFile(fakeBinary, `#!/usr/bin/env node
import { realpathSync, statSync } from "node:fs";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const fixturePath = value("--path");
const mode = process.env.SJV_CORE_SELF_CHECK_MODE;
const run = {
  schemaVersion: 1,
  runner: "semantic-json-viewer-core-performance",
  scope: "core-only-no-tauri-no-webview",
  scenario: "document",
  debug: mode === "debug" ? true : false,
  cache: { mode: value("--cache"), prepared: mode !== "cold-unprepared", reason: mode === "cold-unprepared" ? "unsupported in selfcheck" : null },
  fixture: { path: realpathSync(fixturePath), bytes: statSync(fixturePath).size, identityCurrent: true },
  timingsUs: mode === "bad-metric" ? { openToRoot: null, openToRawFirstSlice: 2, readyToRawFirstSlice: 1 } : { openToRoot: 1, openToRawFirstSlice: 2, readyToRawFirstSlice: 1 },
  errors: [],
};
console.log(JSON.stringify(run));
`, { mode: 0o755 });
  await chmod(fakeBinary, 0o755);

  const commonArgs = (cache) => [
    runner,
    "--scenario", "document",
    "--path", fixture,
    "--cache", cache,
    "--iterations", "5",
    "--idle-seconds", "0",
    "--binary", fakeBinary,
  ];

  async function expectRejected(mode, message, cache = "warm") {
    await assert.rejects(
      execFileAsync(process.execPath, commonArgs(cache), {
        cwd: root,
        env: { ...process.env, SJV_CORE_SELF_CHECK_MODE: mode },
        maxBuffer: 2 * 1024 * 1024,
      }),
      (error) => String(error.stderr).includes(message),
    );
  }

  try {
    await expectRejected("debug", "release benchmark must report debug=false");
    await expectRejected("bad-metric", "timingsUs.openToRoot must be a finite non-negative number");
    await expectRejected("cold-unprepared", "cold-cache unsupported/preparation failed", "cold");
    console.log("core runner selfcheck: debug, invalid metric, and unprepared cold samples rejected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
