#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { once } from "node:events";

const args = process.argv.slice(2);
const countIndex = args.indexOf("--count");
const count = Number(countIndex >= 0 ? args[countIndex + 1] : 1_000_000);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : `/tmp/sjv-collection-${process.pid}.json`;
if (!Number.isSafeInteger(count) || count < 0 || count > 10_000_000 || !output) {
  throw new Error("Usage: generate-collection-fixture.mjs [--count N] [--output /tmp/file.json]");
}

const stream = createWriteStream(output, { encoding: "utf8" });
stream.write("[");
for (let start = 0; start < count; start += 10_000) {
  const end = Math.min(count, start + 10_000);
  const chunk = Array.from({ length: end - start }, (_, offset) => String(start + offset)).join(",");
  if (start > 0) stream.write(",");
  if (!stream.write(chunk)) await once(stream, "drain");
}
stream.end("]");
await once(stream, "close");
console.log(output);
