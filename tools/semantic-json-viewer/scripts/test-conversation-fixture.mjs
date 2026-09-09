#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const generator = path.join(root, "fixtures", "generate-conversation-fixture.mjs");
let scratch;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function runGenerator(args) {
  try {
    const result = await execFileAsync(process.execPath, [generator, ...args], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      code: error?.code
    };
  }
}

async function readFixture(file) {
  const bytes = await fs.readFile(file);
  const parsed = JSON.parse(bytes.toString("utf8"));
  check(parsed && typeof parsed === "object" && Array.isArray(parsed.messages), "fixture root/messages shape is invalid");
  return { parsed, bytes };
}

async function main() {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "sjv-f12-selftest-" + process.pid + "-"));
  const smallPath = path.join(scratch, "small.json");
  const emptyPath = path.join(scratch, "empty.json");
  const defaultPath = path.join(scratch, "default.json");
  try {
    const smallRun = await runGenerator(["--count", "16", "--output", smallPath]);
    check(smallRun.ok, "small generation failed: " + (smallRun.stderr || smallRun.stdout));
    const { parsed: small, bytes: smallBytes } = await readFixture(smallPath);
    check(small.messages.length === 16, "small fixture message count is not exact");
    check(small.messages.every((message, index) => message.sequence === index), "message sequence is not unique and ordered");
    check(small.messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls)), "OpenAI tool_calls distribution is missing");
    check(small.messages.some((message) => message.role === "tool" && typeof message.tool_call_id === "string"), "real tool result distribution is missing");
    const callIds = new Set();
    for (const message of small.messages) {
      for (const call of message.tool_calls ?? []) callIds.add(call.id);
      if (message.role === "tool") check(callIds.has(message.tool_call_id), "tool result references a call that has not appeared yet");
    }
    check(small.messages.some((message) => typeof message.content === "string" && message.content.includes("# Message")), "Markdown distribution is missing");
    check(small.messages.some((message) => typeof message.content === "string" && Buffer.byteLength(message.content, "utf8") > 128 * 1024), "long code content is not larger than 128 KiB");
    check(small.messages.at(-1).tail_sentinel === "F12_TAIL_SENTINEL_15", "tail sentinel is not exact");
    check(typeof small.synthetic_unknown === "string" && small.messages.every((message) => typeof message.synthetic_unknown === "string"), "unknown-field preservation points are missing");
    check(smallBytes.length > 128 * 1024, "small fixture did not contain the long content payload");

    const emptyRun = await runGenerator(["--count", "0", "--output", emptyPath]);
    check(emptyRun.ok, "zero-count generation failed: " + (emptyRun.stderr || emptyRun.stdout));
    const { parsed: empty } = await readFixture(emptyPath);
    check(empty.messages.length === 0, "zero-count fixture is not empty");

    const existingRun = await runGenerator(["--count", "16", "--output", smallPath]);
    check(!existingRun.ok, "existing output was overwritten instead of rejected");

    for (const args of [
      ["--count", "-1", "--output", path.join(scratch, "negative.json")],
      ["--count", "1.5", "--output", path.join(scratch, "fraction.json")],
      ["--unknown", "value", "--output", path.join(scratch, "unknown.json")],
      ["--count"],
      ["--count", "1", "--count", "2", "--output", path.join(scratch, "duplicate.json")]
    ]) {
      const invalidRun = await runGenerator(args);
      check(!invalidRun.ok, "invalid arguments unexpectedly succeeded: " + args.join(" "));
    }

    const defaultRun = await runGenerator(["--count", "10000", "--output", defaultPath]);
    check(defaultRun.ok, "default-size generation failed: " + (defaultRun.stderr || defaultRun.stdout));
    const { parsed: large, bytes: largeBytes } = await readFixture(defaultPath);
    check(large.messages.length === 10_000, "default fixture message count is not exact");
    check(large.messages.at(-1).sequence === 9_999, "default fixture sequence does not reach the end");
    check(large.messages.at(-1).tail_sentinel === "F12_TAIL_SENTINEL_9999", "default tail sentinel is not exact");
    check(large.messages.some((message) => message.role === "tool"), "default fixture has no tool result");
    check(large.messages.some((message) => typeof message.content === "string" && Buffer.byteLength(message.content, "utf8") > 128 * 1024), "default fixture has no long code");
    console.log("conversation-fixture PASS (small=" + smallBytes.length + " bytes, default=" + largeBytes.length + " bytes, messages=" + large.messages.length + ")");
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
