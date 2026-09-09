#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const ONE_MIB = 1024 * 1024;
const DEFAULT_BYTES = {
  jsonl: 1024 * ONE_MIB,
  json: 100 * ONE_MIB
};
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const USAGE = "Usage: generate-benchmark-fixture.mjs [--kind jsonl|json] [--bytes N] [--output PATH]";

function parseArgs(argv) {
  let kind = "jsonl";
  let bytes;
  let output;
  let kindSeen = false;
  let bytesSeen = false;
  let outputSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(USAGE);
      return null;
    }
    if (argument === "--kind") {
      if (kindSeen) throw new Error("duplicate --kind\n" + USAGE);
      kindSeen = true;
      const value = argv[++index];
      if (value === undefined || value.startsWith("--") || value.length === 0) throw new Error("missing value for --kind\n" + USAGE);
      if (value !== "jsonl" && value !== "json") throw new Error("--kind must be jsonl or json");
      kind = value;
      continue;
    }
    if (argument === "--bytes") {
      if (bytesSeen) throw new Error("duplicate --bytes\n" + USAGE);
      bytesSeen = true;
      const value = argv[++index];
      if (value === undefined || value.startsWith("--") || value.length === 0) throw new Error("missing value for --bytes\n" + USAGE);
      bytes = Number(value);
      continue;
    }
    if (argument === "--output") {
      if (outputSeen) throw new Error("duplicate --output\n" + USAGE);
      outputSeen = true;
      const value = argv[++index];
      if (value === undefined || value.startsWith("--") || value.length === 0) throw new Error("missing value for --output\n" + USAGE);
      output = value;
      continue;
    }
    throw new Error("unknown argument: " + argument + "\n" + USAGE);
  }
  const targetBytes = bytes ?? DEFAULT_BYTES[kind];
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0 || targetBytes > MAX_BYTES) {
    throw new Error("--bytes must be an integer in (0, " + MAX_BYTES + "]");
  }
  const extension = kind === "jsonl" ? "jsonl" : "json";
  const resolvedOutput = path.resolve(
    output ?? path.join(os.tmpdir(), "sjv-benchmark-" + kind + "-" + process.pid + "-" + Date.now() + "." + extension)
  );
  if (resolvedOutput === path.parse(resolvedOutput).root) throw new Error("--output must identify a file path");
  return { kind, bytes: targetBytes, output: resolvedOutput };
}

function rowFor(sequence) {
  return {
    format: "benchmark-jsonl",
    sequence,
    kind: "benchmark-row",
    payload: {
      value: "row-" + sequence,
      nested: { sequence, stable: true }
    },
    metadata: {
      generator: "generate-benchmark-fixture.mjs",
      synthetic_unknown: "BENCHMARK_UNKNOWN_" + sequence
    }
  };
}

function tailRowFor(sequence, padding) {
  return {
    format: "benchmark-jsonl",
    sequence,
    kind: "benchmark-row",
    payload: {
      value: "row-" + sequence,
      nested: { sequence, stable: true }
    },
    tail_sentinel: "BENCHMARK_TAIL_SENTINEL_" + sequence,
    metadata: {
      generator: "generate-benchmark-fixture.mjs",
      synthetic_unknown: "BENCHMARK_UNKNOWN_" + sequence
    },
    padding
  };
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

async function* jsonlChunks(options, state) {
  const target = options.bytes;
  let written = 0;
  let sequence = 0;
  while (true) {
    const normal = JSON.stringify(rowFor(sequence)) + "\n";
    const tailBase = JSON.stringify(tailRowFor(sequence, "")) + "\n";
    const nextTailBase = JSON.stringify(tailRowFor(sequence + 1, "")) + "\n";
    if (target - written >= byteLength(normal) + byteLength(nextTailBase)) {
      yield normal;
      written += byteLength(normal);
      sequence += 1;
      state.rows = sequence;
      continue;
    }
    const paddingBytes = target - written - byteLength(tailBase);
    if (paddingBytes < 0) throw new Error("--bytes is too small for a valid JSONL benchmark fixture");
    yield JSON.stringify(tailRowFor(sequence, "x".repeat(paddingBytes))) + "\n";
    written = target;
    state.rows = sequence + 1;
    break;
  }
  if (written !== target) throw new Error("internal JSONL byte accounting error");
}

function jsonDocumentPrefix(options) {
  const value = JSON.stringify({
    format: "benchmark-json",
    metadata: {
      generator: "generate-benchmark-fixture.mjs",
      target_bytes: options.bytes,
      synthetic_unknown: "BENCHMARK_UNKNOWN_ROOT"
    },
    items: []
  });
  return value.slice(0, -3) + "[";
}

function jsonDocumentSuffix() {
  return "],\"tail_sentinel\":\"BENCHMARK_TAIL_SENTINEL\",\"metadata_end\":{\"synthetic_unknown\":\"BENCHMARK_UNKNOWN_END\"}}";
}

async function* jsonChunks(options, state) {
  const target = options.bytes;
  const prefix = jsonDocumentPrefix(options);
  const suffix = jsonDocumentSuffix();
  let written = byteLength(prefix);
  let sequence = 0;
  let first = true;
  if (written + byteLength(suffix) > target) throw new Error("--bytes is too small for a valid JSON benchmark fixture");
  yield prefix;
  while (true) {
    const separator = first ? "" : ",";
    const normal = separator + JSON.stringify(rowFor(sequence));
    const tailBase = separator + JSON.stringify(tailRowFor(sequence, "")) + suffix;
    const nextTailBase = "," + JSON.stringify(tailRowFor(sequence + 1, "")) + suffix;
    if (target - written >= byteLength(normal) + byteLength(nextTailBase)) {
      yield normal;
      written += byteLength(normal);
      first = false;
      sequence += 1;
      state.rows = sequence;
      continue;
    }
    const paddingBytes = target - written - byteLength(tailBase);
    if (paddingBytes < 0) throw new Error("--bytes is too small for a valid JSON benchmark fixture");
    yield separator + JSON.stringify(tailRowFor(sequence, "x".repeat(paddingBytes))) + suffix;
    written = target;
    state.rows = sequence + 1;
    break;
  }
  if (written !== target) throw new Error("internal JSON byte accounting error");
}

async function generate(options) {
  let handle;
  let created = false;
  try {
    handle = await fs.open(options.output, "wx");
    created = true;
    const stream = handle.createWriteStream({ encoding: "utf8", autoClose: true });
    const state = { rows: 0 };
    const chunks = options.kind === "jsonl" ? jsonlChunks(options, state) : jsonChunks(options, state);
    await pipeline(chunks, stream);
    const bytes = (await fs.stat(options.output)).size;
    if (bytes !== options.bytes) throw new Error("internal byte accounting error");
    console.log("wrote kind=" + options.kind + " bytes=" + bytes + " rows=" + state.rows + " to " + options.output);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await fs.unlink(options.output).catch(() => {});
    throw error;
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options) await generate(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
