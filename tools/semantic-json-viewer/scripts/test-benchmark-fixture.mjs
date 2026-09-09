#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const generator = path.join(root, "fixtures", "generate-benchmark-fixture.mjs");
let scratch;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function runGenerator(args) {
  try {
    const result = await execFileAsync(process.execPath, [generator, ...args], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" };
  }
}

function assertAscii(bytes, label) {
  check(bytes.every((byte) => byte < 128), label + " contains non-ASCII bytes");
}

async function assertJsonl(file, expectedBytes) {
  const bytes = await fs.readFile(file);
  check(bytes.length === expectedBytes, "JSONL byte count is not exact");
  assertAscii(bytes, "JSONL");
  const rows = bytes.toString("ascii").trimEnd().split("\n").map((line) => JSON.parse(line));
  check(rows.length > 1, "JSONL small fixture has no useful rows");
  check(rows.every((row, index) => row.format === "benchmark-jsonl" && row.sequence === index), "JSONL sequence/metadata is not stable");
  check(rows.every((row) => typeof row.metadata?.synthetic_unknown === "string"), "JSONL unknown metadata is missing");
  check(rows.at(-1).tail_sentinel === "BENCHMARK_TAIL_SENTINEL_" + (rows.length - 1), "JSONL tail sentinel is not exact");
}

async function assertJson(file, expectedBytes, requireMultiple = true) {
  const bytes = await fs.readFile(file);
  check(bytes.length === expectedBytes, "JSON byte count is not exact");
  assertAscii(bytes, "JSON");
  const rootValue = JSON.parse(bytes.toString("ascii"));
  check(rootValue.format === "benchmark-json" && Array.isArray(rootValue.items), "JSON root/items shape is invalid");
  check(rootValue.metadata.target_bytes === expectedBytes, "JSON metadata does not preserve target bytes");
  if (requireMultiple) check(rootValue.items.length > 1, "JSON small fixture has no useful subset");
  check(rootValue.items.every((row, index) => row.sequence === index), "JSON sequence is not stable");
  check(rootValue.items.at(-1).tail_sentinel === "BENCHMARK_TAIL_SENTINEL_" + (rootValue.items.length - 1), "JSON item tail sentinel is not exact");
  check(rootValue.tail_sentinel === "BENCHMARK_TAIL_SENTINEL", "JSON root tail sentinel is missing");
  check(rootValue.items.every((row) => JSON.stringify(row).length < 4096), "JSON rows are unexpectedly giant");
}

async function main() {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "sjv-benchmark-selftest-" + process.pid + "-"));
  const jsonlPath = path.join(scratch, "small.jsonl");
  const jsonPath = path.join(scratch, "small.json");
  const edgeJsonlPath = path.join(scratch, "edge.jsonl");
  const edgeJsonPath = path.join(scratch, "edge.json");
  const failedPath = path.join(scratch, "failed.jsonl");
  try {
    const jsonlRun = await runGenerator(["--kind", "jsonl", "--bytes", "16384", "--output", jsonlPath]);
    check(jsonlRun.ok, "small JSONL generation failed: " + (jsonlRun.stderr || jsonlRun.stdout));
    await assertJsonl(jsonlPath, 16384);

    const jsonRun = await runGenerator(["--kind", "json", "--bytes", "16384", "--output", jsonPath]);
    check(jsonRun.ok, "small JSON generation failed: " + (jsonRun.stderr || jsonRun.stdout));
    await assertJson(jsonPath, 16384);

    const edgeJsonlRun = await runGenerator(["--kind", "jsonl", "--bytes", "2598", "--output", edgeJsonlPath]);
    check(edgeJsonlRun.ok, "JSONL sequence-length edge generation failed: " + (edgeJsonlRun.stderr || edgeJsonlRun.stdout));
    await assertJsonl(edgeJsonlPath, 2598);
    const edgeJsonRun = await runGenerator(["--kind", "json", "--bytes", "780", "--output", edgeJsonPath]);
    check(edgeJsonRun.ok, "JSON comma edge generation failed: " + (edgeJsonRun.stderr || edgeJsonRun.stdout));
    await assertJson(edgeJsonPath, 780, false);

    const original = await fs.readFile(jsonlPath);
    const existing = await runGenerator(["--kind", "jsonl", "--bytes", "16384", "--output", jsonlPath]);
    check(!existing.ok && Buffer.compare(original, await fs.readFile(jsonlPath)) === 0, "existing output was overwritten");

    for (const args of [
      ["--kind", "xml", "--bytes", "4096", "--output", path.join(scratch, "bad-kind")],
      ["--kind", "jsonl", "--bytes", "0", "--output", path.join(scratch, "bad-bytes")],
      ["--kind", "jsonl", "--bytes", "1.5", "--output", path.join(scratch, "bad-fraction")],
      ["--kind", "jsonl", "--bytes", "4096", "--kind", "json", "--output", path.join(scratch, "duplicate")],
      ["--kind", "jsonl", "--bytes", "4096", "--output"]
    ]) {
      check(!(await runGenerator(args)).ok, "invalid benchmark arguments unexpectedly succeeded: " + args.join(" "));
    }

    const writeFailure = await runGenerator(["--kind", "jsonl", "--bytes", "1", "--output", failedPath]);
    check(!writeFailure.ok && writeFailure.stdout.trim() === "", "write failure reported success");
    check(!(await fs.stat(failedPath).catch(() => null)), "failed output was not cleaned up");
    console.log("benchmark-fixture PASS (jsonl/json exact 16384-byte fixtures, metadata, sequences, tail, wx, invalid args, write failure)");
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
