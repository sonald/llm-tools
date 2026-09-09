#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(root, "src-tauri", "Cargo.toml");
const defaultBinary = path.join(root, "src-tauri", "target", "release", "examples", "core_performance");

function parseArgs(argv) {
  const result = {
    scenario: null,
    path: null,
    cache: "warm",
    iterations: 5,
    idleSeconds: 5,
    binary: defaultBinary,
    explicitBinary: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--scenario") result.scenario = next();
    else if (arg === "--path") result.path = next();
    else if (arg === "--cache") result.cache = next();
    else if (arg === "--iterations") result.iterations = Number(next());
    else if (arg === "--idle-seconds") result.idleSeconds = Number(next());
    else if (arg === "--binary") {
      result.binary = path.resolve(next());
      result.explicitBinary = true;
    }
    else if (arg === "--help") throw new Error("Usage: run-core-performance.mjs --scenario jsonl|document --path FILE [--cache warm|cold] [--iterations 5] [--idle-seconds 5]");
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!result.scenario || !["jsonl", "document"].includes(result.scenario)) throw new Error("--scenario must be jsonl or document");
  if (!result.path) throw new Error("--path is required");
  if (!Number.isInteger(result.iterations) || result.iterations < 5) throw new Error("--iterations must be at least 5 for release reporting");
  if (!Number.isInteger(result.idleSeconds) || result.idleSeconds < 0) throw new Error("--idle-seconds must be a non-negative integer");
  if (!['warm', 'cold'].includes(result.cache)) throw new Error("--cache must be warm or cold");
  return result;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}
function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function parseJson(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("core benchmark emitted no JSON");
  return JSON.parse(lines.at(-1));
}

function requireFiniteMetric(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}

function validateRun(run, options, expectedPath, expectedBytes) {
  if (run.schemaVersion !== 1) throw new Error(`core benchmark schema mismatch: ${run.schemaVersion}`);
  if (run.runner !== "semantic-json-viewer-core-performance") throw new Error(`unexpected core benchmark runner: ${run.runner}`);
  if (run.scope !== "core-only-no-tauri-no-webview") throw new Error("core benchmark scope marker is missing");
  if (run.scenario !== options.scenario) throw new Error(`core benchmark scenario mismatch: ${run.scenario}`);
  if (run.debug !== false) throw new Error("release benchmark must report debug=false");
  if (run.cache?.mode !== options.cache) throw new Error(`core benchmark cache mismatch: ${run.cache?.mode}`);
  if (run.cache?.prepared !== true) {
    const reason = run.cache?.reason ?? "preparation did not report success";
    if (options.cache === "cold") throw new Error(`cold-cache unsupported/preparation failed: ${reason}`);
    throw new Error(`cache preparation failed: ${reason}`);
  }
  if (run.errors?.length) throw new Error(`core benchmark reported errors: ${run.errors.join("; ")}`);
  if (run.fixture?.path !== expectedPath) throw new Error(`core benchmark fixture path mismatch: ${run.fixture?.path}`);
  if (run.fixture?.bytes !== expectedBytes) throw new Error(`core benchmark fixture size mismatch: ${run.fixture?.bytes}`);
  if (run.fixture?.identityCurrent !== true) throw new Error("core benchmark fixture identity is not current");

  const fields = options.scenario === "jsonl"
    ? [
      ["timingsUs.openToFirst20", run.timingsUs?.openToFirst20],
      ["timingsUs.openToScanComplete", run.timingsUs?.openToScanComplete],
      ["timingsUs.scanNextOnly", run.timingsUs?.scanNextOnly],
      ["select.medianUs", run.select?.medianUs],
      ["select.p95Us", run.select?.p95Us],
    ]
    : [
      ["timingsUs.openToRoot", run.timingsUs?.openToRoot],
      ["timingsUs.openToRawFirstSlice", run.timingsUs?.openToRawFirstSlice],
      ["timingsUs.readyToRawFirstSlice", run.timingsUs?.readyToRawFirstSlice],
    ];
  for (const [label, value] of fields) requireFiniteMetric(value, label);
  if (options.scenario === "jsonl") {
    if (run.index?.complete !== true) throw new Error("JSONL benchmark did not complete indexing");
    if (!Number.isInteger(run.select?.sampleCount) || run.select.sampleCount <= 0) throw new Error("JSONL benchmark has no select samples");
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixturePath = path.resolve(options.path);
  const expectedPath = realpathSync(fixturePath);
  const expectedBytes = statSync(fixturePath).size;
  const shaBefore = await sha256(fixturePath);

  if (options.explicitBinary) {
    if (!existsSync(options.binary)) throw new Error(`benchmark binary does not exist: ${options.binary}`);
  } else {
    await execFileAsync("cargo", ["build", "--release", "--example", "core_performance", "--manifest-path", manifestPath], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  }
  const runs = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const result = await execFileAsync(options.binary, ["--scenario", options.scenario, "--path", fixturePath, "--cache", options.cache, "--idle-seconds", String(options.idleSeconds)], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    const parsed = parseJson(result.stdout);
    validateRun(parsed, options, expectedPath, expectedBytes);
    runs.push(parsed);
  }
  const shaAfter = await sha256(fixturePath);
  if (shaAfter !== shaBefore) throw new Error(`fixture changed during benchmark: ${shaBefore} -> ${shaAfter}`);
  const fields = options.scenario === "jsonl"
    ? ["openToFirst20", "openToScanComplete", "selectMedianUs", "selectP95Us"]
    : ["openToRoot", "openToRawFirstSlice", "readyToRawFirstSlice"];
  const aggregate = Object.fromEntries(fields.map((field) => {
    const values = runs.map((run, index) => {
      const value = field.startsWith("select")
        ? run.select[field === "selectMedianUs" ? "medianUs" : "p95Us"]
        : run.timingsUs[field];
      return requireFiniteMetric(value, `run ${index + 1} ${field}`);
    });
    return [field, { median: median(values), p95: percentile(values, 0.95), samples: values }];
  }));
  const fixture = { ...(runs[0]?.fixture ?? {}), sha256: shaAfter };
  console.log(JSON.stringify({
    schemaVersion: 1,
    runner: "run-core-performance",
    scenario: options.scenario,
    cache: options.cache,
    iterations: options.iterations,
    independentProcesses: true,
    fixture,
    aggregate,
    runs,
    errors: []
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
