import fs from "node:fs";
import path from "node:path";

const outputDirectory = path.resolve(
  process.argv[2] ?? "/tmp/semantic-json-viewer-raw-document-fixtures"
);
const longLength = 160 * 1024;
const emojiOffset = 131071;
const emoji = Buffer.from("😀");
const longPrefix = Buffer.from('{"payload":"');
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

if (emojiOffset < longPrefix.length || longLength <= emojiOffset + emoji.length) {
  throw new Error("long invalid JSON fixture bounds are inconsistent");
}

const longInvalidJson = Buffer.concat([
  longPrefix,
  Buffer.alloc(emojiOffset - longPrefix.length, 0x61),
  emoji,
  Buffer.alloc(longLength - emojiOffset - emoji.length, 0x62)
]);

const jsonLines = (...values) => Buffer.from(values.map((value) => JSON.stringify(value)).join("\n") + "\n");
const prettyPrintedRecords = Buffer.from([
  JSON.stringify({ id: 1, value: "first" }, null, 2),
  JSON.stringify({ id: 2, value: "second" }, null, 2),
  ''
].join("\n"));
const invalidUtf8Entry = Buffer.concat(
  Array.from({ length: 10 }, (_, index) => index === 1
    ? Buffer.from([0xff, 0x0a])
    : Buffer.from(JSON.stringify({ id: index + 1 }) + "\n"))
);
const manyInvalidUtf8Entries = Buffer.concat(
  Array.from({ length: 10 }, (_, index) => index < 3
    ? Buffer.from([0xff, 0x0a])
    : Buffer.from(JSON.stringify({ id: index + 1 }) + "\n"))
);

const fixtures = new Map([
  ["lossless-strings.json", Buffer.from('{\r\n\t"escaped" : "\\u0041\\ud83d\\ude00",\r\n  "literal": "A😀",\r\n  "spaces": "  keep\\tspace  "\r\n}\r\n')],
  ["invalid-json.json", Buffer.from("{")],
  ["long-invalid-json.json", longInvalidJson],
  ["invalid-utf8.json", Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])],
  ["empty.json", Buffer.alloc(0)],
  ["utf16-bom.json", Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00])],
  ["record-sequence.json", Buffer.from([0x1e, 0x7b, 0x7d, 0x0a])],
  ["pretty.json", Buffer.from('{\n  "fixture": "pretty",\n  "items": [\n    {"id": 1},\n    {"id": 2}\n  ]\n}\n')],
  ["one-line.json", Buffer.from('{"fixture":"one-line","value":1}\n')],
  ["one-line.jsonl", jsonLines({ id: 1, value: "first" })],
  ["unknown-extension-single-json", Buffer.from('{"fixture":"unknown-extension-single-json","value":true}\n')],
  ["unknown-extension-jsonl", jsonLines({ id: 1 }, { id: 2 })],
  ["concatenated-json", Buffer.from("{}[]")],
  ["json-text-sequence", Buffer.from([0x1e, 0x7b, 0x7d, 0x0a, 0x1e, 0x5b, 0x5d, 0x0a])],
  ["pretty-printed-records.jsonl", prettyPrintedRecords],
  ["utf8.json", Buffer.from('{"encoding":"utf8","value":"ok"}\n')],
  ["utf8-bom.json", Buffer.concat([utf8Bom, Buffer.from('{"encoding":"utf8-bom"}\n')])],
  ["invalid-utf8-entry.jsonl", invalidUtf8Entry],
  ["many-invalid-utf8.jsonl", manyInvalidUtf8Entries]
]);

function fail(message) {
  throw new Error(message);
}

fs.mkdirSync(outputDirectory, { recursive: true });
for (const [name] of fixtures) {
  const target = path.join(outputDirectory, name);
  if (fs.existsSync(target)) fail(`${name} already exists; refusing to overwrite`);
}
for (const [name, bytes] of fixtures) {
  fs.writeFileSync(path.join(outputDirectory, name), bytes, { flag: "wx" });
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

function nonEmptyLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (index > start) lines.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

function expectJsonLines(bytes, name, expectedCount) {
  const lines = nonEmptyLines(bytes);
  if (lines.length !== expectedCount) fail(`${name} has ${lines.length} non-empty lines, expected ${expectedCount}`);
  for (const line of lines) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    try {
      JSON.parse(text);
    } catch {
      fail(`${name} contains an invalid JSON line`);
    }
  }
  return lines.length;
}

function invalidUtf8LineCount(bytes) {
  return nonEmptyLines(bytes).filter((line) => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(line);
      return false;
    } catch {
      return true;
    }
  }).length;
}

function expectJsonDocument(bytes, name) {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  try {
    JSON.parse(text);
  } catch {
    fail(`${name} did not contain one valid UTF-8 JSON document`);
  }
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

for (const name of ["lossless-strings.json", "pretty.json", "one-line.json", "unknown-extension-single-json", "utf8.json", "utf8-bom.json"]) {
  expectJsonDocument(read(name), name);
}
if (nonEmptyLines(read("pretty.json")).length <= 1) fail("pretty.json is not pretty-printed");
if (nonEmptyLines(read("one-line.json")).length !== 1) fail("one-line.json is not one line");
for (const name of ["one-line.jsonl", "unknown-extension-jsonl"]) {
  expectJsonLines(read(name), name, name === "one-line.jsonl" ? 1 : 2);
}
const prettyRecordLines = nonEmptyLines(read("pretty-printed-records.jsonl"));
if (prettyRecordLines.length !== 8
  || !prettyRecordLines[0].equals(Buffer.from("{"))
  || !prettyRecordLines[4].equals(Buffer.from("{"))
  || !prettyRecordLines[1].includes(Buffer.from('"id": 1'))
  || !prettyRecordLines[5].includes(Buffer.from('"id": 2'))) {
  fail("pretty-printed-records.jsonl does not contain two multi-line pretty records");
}
if (!read("concatenated-json").equals(Buffer.from("{}[]"))) fail("concatenated-json is not the exact concatenated framing case");
if (read("json-text-sequence")[0] !== 0x1e) fail("json-text-sequence lacks its RS framing byte");

const oneBadUtf8Lines = nonEmptyLines(read("invalid-utf8-entry.jsonl"));
const oneBadUtf8Count = invalidUtf8LineCount(read("invalid-utf8-entry.jsonl"));
if (oneBadUtf8Lines.length !== 10 || oneBadUtf8Count !== 1) fail("invalid-utf8-entry.jsonl is not exactly 1 invalid line out of 10");
const manyBadUtf8Lines = nonEmptyLines(read("many-invalid-utf8.jsonl"));
const manyBadUtf8Count = invalidUtf8LineCount(read("many-invalid-utf8.jsonl"));
if (manyBadUtf8Lines.length !== 10 || manyBadUtf8Count !== 3 || manyBadUtf8Count * 5 <= manyBadUtf8Lines.length) {
  fail("many-invalid-utf8.jsonl is not the required 3/10 (>20%) invalid ratio");
}
if (manyBadUtf8Lines.length - manyBadUtf8Count !== 7) fail("many-invalid-utf8.jsonl does not retain seven valid lines after bad entries");

for (const [name, bytes] of fixtures) {
  console.log(`${name}: ${bytes.length} bytes -> ${path.join(outputDirectory, name)}`);
}
console.log(`raw document fixture shape verification: PASS (${fixtures.size} files; one-bad-utf8=1/10; many-bad-utf8=3/10)`);
