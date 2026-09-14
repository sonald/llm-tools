#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "vite";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const codes = [
  "trailing_data",
  "invalid_utf8",
  "unexpected_end_of_input",
  "expected_scalar_json_value",
  "expected_object_key",
  "expected_colon_after_object_key",
  "expected_object_value_separator",
  "expected_array_element_separator",
  "invalid_json_literal",
  "leading_zero_not_allowed",
  "expected_digit",
  "expected_digit_after_decimal_point",
  "expected_digit_in_exponent",
  "unterminated_string",
  "unescaped_control_character_in_string",
  "unterminated_string_escape",
  "invalid_string_escape",
  "unpaired_high_surrogate",
  "invalid_low_surrogate",
  "unpaired_low_surrogate",
  "incomplete_unicode_escape",
  "invalid_unicode_escape_digit"
];

const enSource = await readFile(resolve(root, "src/i18n/en.ts"), "utf8");
const parseErrorKeys = [...enSource.matchAll(/^\s+"parseError\.([^\"]+)":/gm)].map((match) => match[1]);
assert.equal(parseErrorKeys.length, codes.length, "English catalog does not contain exactly 22 parse error messages");

Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US" } });
const bundleResult = await build({
  root,
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    lib: { entry: resolve(root, "src/parse-error-message.ts"), formats: ["es"], fileName: "parse-error-message" },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});
const bundle = bundleResult[0]?.output.find((entry) => entry.type === "chunk");
assert.ok(bundle && bundle.type === "chunk", "parse-error-message bundle was not generated");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.code).toString("base64")}`;

const english = await import(`${moduleUrl}#en`);
for (const code of codes) {
  assert.notEqual(english.parseErrorMessage({ code, message: "raw diagnostic" }), "raw diagnostic", `missing English code ${code}`);
}
assert.equal(english.parseErrorMessage({ message: "raw diagnostic" }), "raw diagnostic");
assert.equal(english.parseErrorMessage({ code: "unknown_code", message: "raw diagnostic" }), "raw diagnostic");
assert.equal(english.parseErrorMessage({ code: "__proto__", message: "raw diagnostic" }), "raw diagnostic");
assert.equal(english.parseErrorMessage({ code: "toString", message: "raw diagnostic" }), "raw diagnostic");
const inheritedCode = Object.create({ code: "expected_object_key" });
inheritedCode.message = "raw diagnostic";
assert.equal(english.parseErrorMessage(inheritedCode), "raw diagnostic", "inherited code was translated");

Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "zh-CN" } });
const chinese = await import(`${moduleUrl}#zh`);
assert.equal(chinese.parseErrorMessage({ code: "expected_object_key", message: "raw diagnostic" }), "应为对象键");
assert.equal(chinese.parseErrorMessage({ code: "unknown_code", message: "原始诊断" }), "原始诊断");

const main = await readFile(resolve(root, "src/main.ts"), "utf8");
const entryList = await readFile(resolve(root, "src/entry-list.ts"), "utf8");
assert.match(main, /parseErrorMessage\(parse\)/, "main does not use the shared parse error formatter");
assert.match(entryList, /parseErrorMessage\(parse\)/, "Entry Inspector does not use the shared parse error formatter");
assert.match(main, /line: parse\.line,\s*column: parse\.column,\s*byteOffset: parse\.byteOffset/s);
assert.match(entryList, /String\(parse\.byteOffset\)/);

console.log(`parse-error-message checks passed: ${codes.length} codes, English/Chinese fallback and coordinate preservation`);
