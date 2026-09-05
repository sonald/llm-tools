import fs from "node:fs";
import path from "node:path";

const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const FIRST_CHUNK_BYTES = 256 * 1024;
const OUTPUT_DEFAULT = "/tmp/semantic-json-viewer-entry-list.jsonl";
const outputPath = path.resolve(process.argv[2] ?? OUTPUT_DEFAULT);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const records = [];
let offset = 0;
let sawLf = false;
let sawCrLf = false;
let sawBlank = false;

const descriptor = (ordinal, start, end, kind) => ({ ordinal, start, end, kind });

const fd = fs.openSync(outputPath, "w");
try {
  const write = (bytes) => {
    fs.writeSync(fd, bytes);
    offset += bytes.length;
  };

  const writeBlank = (ending) => {
    write(Buffer.from(`  \t${ending}`));
    sawBlank = true;
    if (ending === "\r\n") sawCrLf = true;
    else sawLf = true;
  };

  const writeEntry = (body, ending, kind = "valid") => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const start = offset;
    write(bytes);
    const end = offset;
    write(Buffer.from(ending));
    if (ending === "\r\n") sawCrLf = true;
    else sawLf = true;
    records.push(descriptor(records.length + 1, start, end, kind));
  };

  for (let ordinal = 1; ordinal <= 60; ordinal += 1) {
    if (ordinal === 40) {
      writeEntry(JSON.stringify({
        entry: ordinal,
        payload: "x".repeat(400 * 1024)
      }), "\r\n", "valid");
    } else if (ordinal === 6) {
      const prefix = Buffer.from('{"invalidJson":"');
      const emoji = Buffer.from("😀");
      const bodyLength = 160 * 1024;
      const emojiOffset = 131071;
      const beforeEmoji = Buffer.alloc(emojiOffset - prefix.length, 0x61);
      const afterEmoji = Buffer.alloc(bodyLength - emojiOffset - emoji.length, 0x62);
      writeEntry(Buffer.concat([prefix, beforeEmoji, emoji, afterEmoji]), "\n", "invalidJson");
    } else if (ordinal === 12) {
      const body = Buffer.concat([
        Buffer.from('{"invalidUtf8":"'),
        Buffer.from([0xff]),
        Buffer.from('"}')
      ]);
      writeEntry(body, "\r\n", "invalidUtf8");
    } else if (ordinal % 3 === 2) {
      writeEntry(JSON.stringify([ordinal, "array", { even: ordinal % 2 === 0 }]), "\n");
    } else if (ordinal % 5 === 0) {
      writeEntry(JSON.stringify(`scalar-${ordinal}`), "\r\n");
    } else if (ordinal % 7 === 0) {
      writeEntry(String(ordinal * 1000000000000), "\n");
    } else {
      writeEntry(JSON.stringify({
        entry: ordinal,
        kind: "object",
        nested: { ready: true, ordinal }
      }), ordinal % 4 === 0 ? "\r\n" : "\n");
    }
    if (ordinal === 10 || ordinal === 31 || ordinal === 50) writeBlank(ordinal % 2 === 0 ? "\r\n" : "\n");
  }

  const oversizedStart = offset;
  const prefix = Buffer.from('{"entry":61,"payload":"');
  const suffix = Buffer.from('"}');
  const fillerLength = MAX_ENTRY_BYTES + 1 - prefix.length - suffix.length;
  if (fillerLength <= 0) throw new Error("oversized fixture shape is too small");
  write(prefix);
  const filler = Buffer.alloc(64 * 1024, 0x78);
  let remaining = fillerLength;
  while (remaining > 0) {
    const chunk = remaining >= filler.length ? filler : Buffer.alloc(remaining, 0x78);
    write(chunk);
    remaining -= chunk.length;
  }
  write(suffix);
  const oversizedEnd = offset;
  write(Buffer.from("\r\n"));
  sawCrLf = true;
  records.push(descriptor(61, oversizedStart, oversizedEnd, "oversized"));

  for (let ordinal = 62; ordinal <= 75; ordinal += 1) {
    const body = ordinal % 2 === 0
      ? { entry: ordinal, afterOversized: true }
      : [ordinal, "after-oversized"];
    writeEntry(JSON.stringify(body), ordinal % 3 === 0 ? "\r\n" : "\n");
  }

  fs.closeSync(fd);

  const size = fs.statSync(outputPath).size;
  const twentieth = records[19];
  const longInvalid = records[5];
  const longValid = records[39];
  const oversized = records[60];
  const afterOversized = records[61];
  if (records.length < 70) throw new Error("fixture must contain at least 70 entries");
  if (!twentieth || twentieth.end > FIRST_CHUNK_BYTES) throw new Error("first 20 entries must fit in the first chunk");
  if (!longInvalid || longInvalid.kind !== "invalidJson" || longInvalid.end - longInvalid.start <= 128 * 1024) {
    throw new Error("entry 6 must be a long UTF-8 invalid JSON entry");
  }
  const emoji = Buffer.from("😀");
  const emojiOffset = 131071;
  const checkFd = fs.openSync(outputPath, "r");
  try {
    const emojiAtBoundary = Buffer.alloc(emoji.length);
    const bytesRead = fs.readSync(checkFd, emojiAtBoundary, 0, emojiAtBoundary.length, longInvalid.start + emojiOffset);
    if (bytesRead !== emoji.length || !emojiAtBoundary.equals(emoji)) {
      throw new Error("entry 6 emoji does not start at the expected byte offset");
    }
    const firstChunk = Buffer.alloc(128 * 1024);
    const firstRead = fs.readSync(checkFd, firstChunk, 0, firstChunk.length, longInvalid.start);
    if (firstRead !== firstChunk.length || firstChunk[emojiOffset] !== emoji[0]) {
      throw new Error("entry 6 first 128 KiB chunk does not end on emoji byte one");
    }
    const secondChunk = Buffer.alloc(128 * 1024);
    const secondRead = fs.readSync(checkFd, secondChunk, 0, secondChunk.length, longInvalid.start + 128 * 1024);
    const continuation = Buffer.concat([firstChunk.subarray(emojiOffset), secondChunk.subarray(0, emoji.length - 1)]);
    if (secondRead === 0 || !continuation.equals(emoji)) {
      throw new Error("entry 6 emoji is not preserved across the 128 KiB boundary");
    }
  } finally {
    fs.closeSync(checkFd);
  }
  if (!longValid || longValid.kind !== "valid" || longValid.end - longValid.start <= 3 * 128 * 1024) {
    throw new Error("entry 40 must be a valid entry larger than three 128 KiB windows");
  }
  if (!oversized || oversized.end - oversized.start !== MAX_ENTRY_BYTES + 1) {
    throw new Error("entry 61 must be exactly 16 MiB + 1 byte");
  }
  if (!afterOversized || afterOversized.kind !== "valid") throw new Error("valid entries must follow entry 61");
  if (!sawLf || !sawCrLf || !sawBlank) throw new Error("fixture must mix LF, CRLF, and blank physical lines");
  if (size <= oversized.end) throw new Error("fixture must contain entries after entry 61");

  console.log(`wrote ${records.length} entries (${size} bytes) to ${outputPath}`);
  console.log(`entry 6 invalid JSON range [${longInvalid.start}, ${longInvalid.end})`);
  console.log(`entry 40 valid range [${longValid.start}, ${longValid.end})`);
  console.log(`entry 61 oversized range [${oversized.start}, ${oversized.end})`);
} catch (error) {
  try {
    fs.closeSync(fd);
  } catch {
    // The original error is more useful than a close error.
  }
  throw error;
}
