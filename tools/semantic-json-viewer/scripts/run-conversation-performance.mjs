#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(root, "src-tauri", "Cargo.toml");
const generator = path.join(root, "fixtures", "generate-conversation-fixture.mjs");
const defaultBinary = path.join(root, "src-tauri", "target", "release", "examples", "conversation_performance");
const MESSAGE_COUNT = 10_000;
const MIN_ITERATIONS = 5;

function parseArgs(argv) {
  const result = {
    cache: "warm",
    iterations: MIN_ITERATIONS,
    binary: defaultBinary,
    explicitBinary: false,
    path: null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--cache") result.cache = next();
    else if (arg === "--iterations") result.iterations = Number(next());
    else if (arg === "--binary") {
      result.binary = path.resolve(next());
      result.explicitBinary = true;
    } else if (arg === "--path") result.path = path.resolve(next());
    else if (arg === "--output") result.output = path.resolve(next());
    else if (arg === "--help") throw new Error("Usage: run-conversation-performance.mjs [--cache warm|cold] [--iterations 5] [--path FIXTURE] [--output PATH] [--binary PATH]");
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!["warm", "cold"].includes(result.cache)) throw new Error("--cache must be warm or cold");
  if (!Number.isInteger(result.iterations) || result.iterations < MIN_ITERATIONS) {
    throw new Error(`--iterations must be at least ${MIN_ITERATIONS} for release reporting`);
  }
  if (result.path && result.output) throw new Error("--path and --output cannot be used together");
  return result;
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function parseJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("conversation benchmark emitted no JSON");
  return JSON.parse(lines.at(-1));
}

function requireFiniteMetric(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}

function validateRun(run, options, expectedPath, expectedBytes) {
  if (run.schemaVersion !== 1) throw new Error(`conversation benchmark schema mismatch: ${run.schemaVersion}`);
  if (run.runner !== "semantic-json-viewer-conversation-performance") throw new Error(`unexpected conversation benchmark runner: ${run.runner}`);
  if (run.scope !== "core-only-no-tauri-no-webview") throw new Error("conversation benchmark scope marker is missing");
  if (run.scenario !== "conversation") throw new Error(`conversation benchmark scenario mismatch: ${run.scenario}`);
  if (run.debug !== false) throw new Error("release benchmark must report debug=false");
  if (run.cache?.mode !== options.cache) throw new Error(`conversation benchmark cache mismatch: ${run.cache?.mode}`);
  if (run.cache?.prepared !== true) {
    const reason = run.cache?.reason ?? "preparation did not report success";
    if (options.cache === "cold") throw new Error(`cold-cache unsupported/preparation failed: ${reason}`);
    throw new Error(`cache preparation failed: ${reason}`);
  }
  if (run.errors?.length) throw new Error(`conversation benchmark reported errors: ${run.errors.join("; ")}`);
  if (run.fixture?.path !== expectedPath) throw new Error(`conversation benchmark fixture path mismatch: ${run.fixture?.path}`);
  if (run.fixture?.bytes !== expectedBytes) throw new Error(`conversation benchmark fixture size mismatch: ${run.fixture?.bytes}`);
  if (run.fixture?.identityCurrent !== true) throw new Error("conversation benchmark fixture identity is not current");

  const timings = run.timingsUs ?? {};
  for (const field of ["open", "candidate", "first100BlockPage", "remainingPagesToEnd", "allPagesToEnd"]) {
    requireFiniteMetric(timings[field], `timingsUs.${field}`);
  }

  const conversation = run.conversation ?? {};
  if (conversation.kind !== "openai" || conversation.style !== "openai") throw new Error("generated F-12 fixture did not use the OpenAI conversation adapter");
  if (conversation.messageCount !== MESSAGE_COUNT) throw new Error(`conversation message count mismatch: ${conversation.messageCount}`);
  if (conversation.pageSize !== 100) throw new Error(`conversation page size mismatch: ${conversation.pageSize}`);
  if (!Number.isInteger(conversation.firstPageBlockCount) || conversation.firstPageBlockCount !== 100) throw new Error(`first conversation page has ${conversation.firstPageBlockCount} blocks, expected 100`);
  if (!Number.isInteger(conversation.maxPageBlockCount) || conversation.maxPageBlockCount <= 0 || conversation.maxPageBlockCount > 100) throw new Error("conversation page block bound is invalid");
  if (!Number.isInteger(conversation.pageCount) || conversation.pageCount <= 1) throw new Error("conversation benchmark did not traverse multiple pages to the end");
  if (!Number.isInteger(conversation.totalBlockCount) || conversation.totalBlockCount < conversation.messageCount) throw new Error("conversation total block accounting is invalid");
  if (!Number.isInteger(conversation.messageBlockCount) || conversation.messageBlockCount !== conversation.messageCount) throw new Error("conversation message block accounting is inconsistent");
  if (conversation.reachedEnd !== true) throw new Error("conversation benchmark did not reach the final page");
  if (!Number.isInteger(conversation.unknownSourceRefCount) || conversation.unknownSourceRefCount <= 0) throw new Error("conversation unknown source references were not retained");

  const expectedTail = `F12_TAIL_SENTINEL_${MESSAGE_COUNT - 1}`;
  const tail = conversation.tailSourceSlice ?? {};
  const tailSpan = conversation.tailSourceRef?.span ?? {};
  if (!Number.isInteger(tailSpan.start) || !Number.isInteger(tailSpan.end) || tailSpan.end <= tailSpan.start) throw new Error("tail source reference span is invalid");
  if (!Number.isInteger(tail.sourceSpanBytes) || tail.sourceSpanBytes !== tailSpan.end - tailSpan.start) throw new Error("tail source slice span accounting is invalid");
  if (!Number.isInteger(tail.requestedBytes) || tail.requestedBytes <= 0 || tail.requestedBytes > 256 || tail.requestedBytes !== Math.min(tail.sourceSpanBytes, 256)) throw new Error("tail source slice bound is invalid");
  if (!Number.isInteger(tail.bytes) || tail.bytes <= 0 || tail.bytes > tail.requestedBytes || tail.start !== tailSpan.start) throw new Error("tail source slice byte accounting is invalid");
  if (tail.matchesSentinel !== true || tail.expectedSentinel !== expectedTail || !String(tail.text ?? "").includes(expectedTail)) {
    throw new Error("tail source sentinel was not readable from the bounded source slice");
  }
  const longSlice = conversation.longSourceSlice ?? {};
  if (longSlice.fullRead !== false || longSlice.hasMore !== true || !Number.isInteger(longSlice.requestedBytes) || longSlice.requestedBytes !== 256 || !Number.isInteger(longSlice.returnedBytes) || longSlice.returnedBytes <= 0 || longSlice.returnedBytes > longSlice.requestedBytes || !Number.isInteger(longSlice.sourceSpanBytes) || longSlice.sourceSpanBytes <= 128 * 1024) {
    throw new Error("long content was not observed through a bounded source slice");
  }
  if (run.memory?.measured !== false || !run.memory?.coreRetainedBufferCapacity?.scope?.includes("ParsedJson tree buffers") || !Number.isFinite(run.memory?.coreRetainedBufferCapacity?.totalCapacityBytes) || run.memory.coreRetainedBufferCapacity.totalCapacityBytes < 0) {
    throw new Error("conversation benchmark memory scope is not explicitly Core retained capacity");
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function generateFixture(output) {
  await execFileAsync(process.execPath, [generator, "--count", String(MESSAGE_COUNT), "--output", output], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let scratch;
  let fixturePath = options.path ?? options.output;
  const generated = !options.path;
  if (!fixturePath) {
    scratch = await mkdtemp(path.join(os.tmpdir(), `sjv-conversation-performance-${process.pid}-`));
    fixturePath = path.join(scratch, "f12-10000.json");
  }

  try {
    if (generated) await generateFixture(fixturePath);
    else if (!existsSync(fixturePath)) throw new Error(`conversation fixture does not exist: ${fixturePath}`);
    const expectedPath = realpathSync(fixturePath);
    const expectedBytes = statSync(fixturePath).size;
    const shaBefore = await sha256(fixturePath);

    if (options.explicitBinary) {
      if (!existsSync(options.binary)) throw new Error(`conversation benchmark binary does not exist: ${options.binary}`);
    } else {
      await execFileAsync("cargo", ["build", "--release", "--example", "conversation_performance", "--manifest-path", manifestPath], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      });
    }

    const runs = [];
    for (let index = 0; index < options.iterations; index += 1) {
      const result = await execFileAsync(options.binary, ["--path", fixturePath, "--cache", options.cache], {
        cwd: root,
        maxBuffer: 8 * 1024 * 1024,
      });
      const parsed = parseJson(result.stdout);
      validateRun(parsed, options, expectedPath, expectedBytes);
      runs.push(parsed);
    }
    const shaAfter = await sha256(fixturePath);
    if (shaAfter !== shaBefore) throw new Error(`fixture changed during benchmark: ${shaBefore} -> ${shaAfter}`);

    const fields = ["open", "candidate", "first100BlockPage", "remainingPagesToEnd", "allPagesToEnd"];
    const aggregate = Object.fromEntries(fields.map((field) => {
      const values = runs.map((run, index) => requireFiniteMetric(run.timingsUs[field], `run ${index + 1} timingsUs.${field}`));
      return [field, { median: median(values), p95: percentile(values, 0.95), samples: values }];
    }));
    console.log(JSON.stringify({
      schemaVersion: 1,
      runner: "run-conversation-performance",
      scenario: "conversation",
      messageCount: MESSAGE_COUNT,
      cache: options.cache,
      iterations: options.iterations,
      independentProcesses: true,
      fixture: { ...(runs[0]?.fixture ?? {}), sha256: shaAfter },
      contract: {
        scope: "core-only-no-tauri-no-webview",
        pageSize: 100,
        messageCount: MESSAGE_COUNT,
        fullPageTraversal: true,
        boundedLargeSourceReadBytes: 256,
        coreRetainedCapacityOnly: true,
      },
      aggregate,
      runs,
      errors: [],
    }));
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
