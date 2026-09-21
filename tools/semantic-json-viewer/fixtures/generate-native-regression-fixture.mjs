import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

if (!process.argv[2]) throw new Error("Usage: node generate-native-regression-fixture.mjs OUTPUT_DIRECTORY");
const directory = resolve(process.argv[2]);
const nestedText = Array.from({ length: 800 }, (_, i) => `NESTED-${String(i).padStart(4, "0")} 中文😀 ${"z".repeat(26)}`).join("\r\n");
const payload = {
  plain: Array.from({ length: 12000 }, (_, i) => `LINE-${String(i).padStart(5, "0")} 中文😀 ${"x".repeat(24)}`).join("\r\n"),
  nested: JSON.stringify({ nestedText }),
  code: Array.from({ length: 22050 }, (_, i) => `const row${i} = ${i};`).join("\n"),
  codeOneLine: `const value = "${"x".repeat(1024 * 1024)}";`
};
assert(Buffer.byteLength(nestedText) > 32 * 1024 && Buffer.byteLength(nestedText) < 128 * 1024);
assert(Buffer.byteLength(payload.plain) > 128 * 1024);
assert.equal(payload.code.split("\n").length, 22050);
assert(Buffer.byteLength(payload.code) < 1024 * 1024);
assert(Buffer.byteLength(payload.codeOneLine) > 1024 * 1024 && Buffer.byteLength(payload.codeOneLine) < 2 * 1024 * 1024);
const text = JSON.stringify(payload, null, 2) + "\n";
await mkdir(directory, { recursive: true });
const file = resolve(directory, "native-regressions.json");
await writeFile(file, text, { flag: "wx" });
const bytes = await readFile(file);
assert.deepEqual(JSON.parse(bytes), payload);
assert.equal(JSON.parse(JSON.parse(bytes).nested).nestedText, nestedText);
console.log(JSON.stringify({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  decodedPlainBytes: Buffer.byteLength(payload.plain), decodedNestedChildBytes: Buffer.byteLength(nestedText),
  codeLines: 22050, codeBytes: Buffer.byteLength(payload.code), codeOneLineBytes: Buffer.byteLength(payload.codeOneLine) }));
