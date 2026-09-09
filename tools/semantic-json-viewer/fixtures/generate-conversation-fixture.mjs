#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const DEFAULT_COUNT = 10_000;
const MAX_COUNT = 1_000_000;
const LONG_CODE_TARGET_BYTES = 192 * 1024;
const USAGE = "Usage: generate-conversation-fixture.mjs [--count N] [--output PATH]";

function parseArgs(argv) {
  let count = DEFAULT_COUNT;
  let output;
  let countSeen = false;
  let outputSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(USAGE);
      return null;
    }
    if (argument === "--count") {
      if (countSeen) throw new Error("duplicate --count\n" + USAGE);
      countSeen = true;
      const value = argv[++index];
      if (value === undefined || value.startsWith("--") || value.length === 0) throw new Error("missing value for --count\n" + USAGE);
      count = Number(value);
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
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT) {
    throw new Error("--count must be an integer in [0, " + MAX_COUNT + "]");
  }
  const resolvedOutput = path.resolve(
    output ?? path.join(os.tmpdir(), "sjv-long-conversation-" + process.pid + "-" + Date.now() + ".json")
  );
  if (!resolvedOutput || resolvedOutput === path.parse(resolvedOutput).root) {
    throw new Error("--output must identify a file path");
  }
  return { count, output: resolvedOutput };
}

function buildLongCode() {
  const line = "const result = 42; // F12_LONG_CODE\n";
  const repeatCount = Math.ceil(LONG_CODE_TARGET_BYTES / Buffer.byteLength(line, "utf8"));
  const fence = String.fromCharCode(96).repeat(3);
  return fence + "javascript\n" + line.repeat(repeatCount) + fence + "\n";
}

function messageFor(index, count, longCode, longCodeIndex) {
  const tail = index === count - 1;
  let role = "assistant";
  let content = "Assistant response for message " + index + ".";
  const message = {
    id: "f12-message-" + index,
    sequence: index,
    role,
    content,
    synthetic_unknown: "F12_UNKNOWN_MESSAGE_" + index
  };

  if (index === 0) {
    role = "system";
    content = "You are reading the source-preserving F-12 long conversation fixture.";
  } else if (index === longCodeIndex) {
    role = "assistant";
    content = longCode;
    message.long_code = true;
  } else if (index % 7 === 1) {
    role = "user";
    content = "# Message " + index + "\n\n- inspect source\n- preserve spans\n\nUser request " + index + ".";
    message.markdown = true;
  } else if (index % 7 === 2) {
    role = "assistant";
    content = "I will call the status tool for message " + index + ".";
    message.tool_calls = [{
      id: "call_" + index,
      type: "function",
      function: {
        name: "lookup_status",
        arguments: JSON.stringify({ sequence: index, query: "status" }),
        synthetic_unknown: "F12_UNKNOWN_FUNCTION_" + index
      },
      synthetic_unknown: "F12_UNKNOWN_TOOL_CALL_" + index
    }];
  } else if (index % 7 === 3) {
    role = "tool";
    content = "TOOL_RESULT_" + index + ": status=ready";
    message.tool_call_id = "call_" + (index - 1);
    message.tool_name = "lookup_status";
    message.tool_result = true;
  }

  message.role = role;
  message.content = content;
  if (tail) {
    message.tail_sentinel = "F12_TAIL_SENTINEL_" + index;
    message.content += "\nF12_TAIL_SENTINEL_" + index;
  }
  return message;
}

async function* conversationChunks(options) {
  const longCodeIndex = options.count === 0 ? -1 : Math.min(40, options.count - 1);
  const longCode = buildLongCode();
  yield "{\"format\":\"openai-conversation\",\"model\":\"f12-fixture-model\",\"conversation_id\":\"f12-long-conversation\",\"synthetic_unknown\":\"F12_UNKNOWN_ROOT\",\"metadata\":{\"synthetic_unknown\":\"F12_UNKNOWN_METADATA\",\"generator\":\"generate-conversation-fixture.mjs\"},\"messages\":[";
  for (let index = 0; index < options.count; index += 1) {
    if (index > 0) yield ",";
    yield JSON.stringify(messageFor(index, options.count, longCode, longCodeIndex));
  }
  yield "]}";
}

async function generate(options) {
  let handle;
  let created = false;
  try {
    handle = await fs.open(options.output, "wx");
    created = true;
    const stream = handle.createWriteStream({ encoding: "utf8", autoClose: true });
    await pipeline(conversationChunks(options), stream);
    const bytes = (await fs.stat(options.output)).size;
    console.log("wrote " + options.count + " messages (" + bytes + " bytes) to " + options.output);
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
