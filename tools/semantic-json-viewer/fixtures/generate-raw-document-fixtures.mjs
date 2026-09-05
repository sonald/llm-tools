import fs from "node:fs";
import path from "node:path";

const outputDirectory = path.resolve(
  process.argv[2] ?? "/tmp/semantic-json-viewer-raw-document-fixtures"
);
const longLength = 160 * 1024;
const emojiOffset = 131071;
const emoji = Buffer.from("😀");
const longPrefix = Buffer.from('{"payload":"');

if (emojiOffset < longPrefix.length || longLength <= emojiOffset + emoji.length) {
  throw new Error("long invalid JSON fixture bounds are inconsistent");
}

const longInvalidJson = Buffer.concat([
  longPrefix,
  Buffer.alloc(emojiOffset - longPrefix.length, 0x61),
  emoji,
  Buffer.alloc(longLength - emojiOffset - emoji.length, 0x62)
]);

const fixtures = new Map([
  ["invalid-json.json", Buffer.from("{")],
  ["long-invalid-json.json", longInvalidJson],
  ["invalid-utf8.json", Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])],
  ["empty.json", Buffer.alloc(0)],
  ["utf16-bom.json", Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00])],
  ["record-sequence.json", Buffer.from([0x1e, 0x7b, 0x7d, 0x0a])]
]);

fs.mkdirSync(outputDirectory, { recursive: true });
for (const [name, bytes] of fixtures) {
  fs.writeFileSync(path.join(outputDirectory, name), bytes);
}

function fail(message) {
  throw new Error(message);
}

function read(name) {
  return fs.readFileSync(path.join(outputDirectory, name));
}

function expectFatalUtf8(bytes, name) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  fail(`${name} unexpectedly decoded as UTF-8`);
}

function expectInvalidJson(bytes, name) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    JSON.parse(text);
  } catch {
    return;
  }
  fail(`${name} unexpectedly parsed as JSON`);
}

for (const [name, expected] of fixtures) {
  const bytes = read(name);
  if (bytes.length !== expected.length) fail(`${name} has an unexpected length`);
  if (!bytes.equals(expected)) fail(`${name} is not deterministic`);
}

const invalidJson = read("invalid-json.json");
if (invalidJson.length !== 1 || invalidJson[0] !== 0x7b) fail("invalid-json.json is not a single '{' byte");
expectInvalidJson(invalidJson, "invalid-json.json");

const long = read("long-invalid-json.json");
if (long.length !== longLength) fail("long-invalid-json.json is not exactly 160 KiB");
new TextDecoder("utf-8", { fatal: true }).decode(long);
expectInvalidJson(long, "long-invalid-json.json");
if (!long.subarray(emojiOffset, emojiOffset + emoji.length).equals(emoji)) {
  fail("long-invalid-json.json emoji is not at the requested offset");
}
if (long[emojiOffset] !== emoji[0]) fail("long-invalid-json.json does not cross the 128 KiB boundary");
if (!long.subarray(128 * 1024, 128 * 1024 + emoji.length - 1).equals(emoji.subarray(1))) {
  fail("long-invalid-json.json emoji continuation is not in the next 128 KiB chunk");
}

const invalidUtf8 = read("invalid-utf8.json");
if (!invalidUtf8.includes(0xff) || invalidUtf8[0] === 0xef) fail("invalid-utf8.json lacks a non-BOM invalid byte");
expectFatalUtf8(invalidUtf8, "invalid-utf8.json");

if (read("empty.json").length !== 0) fail("empty.json is not empty");

const utf16 = read("utf16-bom.json");
if (!utf16.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) fail("utf16-bom.json lacks its UTF-16 BOM");
const utf16Text = new TextDecoder("utf-16le", { fatal: true }).decode(utf16).replace(/^\uFEFF/, "");
if (utf16Text !== "{}") fail("utf16-bom.json is not valid UTF-16LE JSON");
try {
  JSON.parse(utf16Text);
} catch {
  fail("utf16-bom.json did not parse after UTF-16LE decoding");
}

if (read("record-sequence.json")[0] !== 0x1e) fail("record-sequence.json lacks its RS framing byte");

for (const [name, bytes] of fixtures) {
  console.log(`${name}: ${bytes.length} bytes -> ${path.join(outputDirectory, name)}`);
}
console.log("raw document fixture verification: PASS");
