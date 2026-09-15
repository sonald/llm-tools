#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "vite";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { language: "en-US" }
});

const bundleResult = await build({
  root,
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    lib: { entry: resolve(root, "src/i18n.ts"), formats: ["es"], fileName: "i18n" },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});
const bundle = bundleResult[0]?.output.find((entry) => entry.type === "chunk");
assert.ok(bundle && bundle.type === "chunk", "i18n bundle was not generated");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.code).toString("base64")}`;

const english = await import(`${moduleUrl}#en`);
english.validateMessages();
assert.equal(english.locale, "en");
assert.equal(english.resolveLocale("zh-Hans"), "zh-CN");
assert.equal(english.resolveLocale("zh-TW"), "zh-CN");
assert.equal(english.resolveLocale("en-US"), "en");
assert.equal(
  english.t("main.entryProgress", { entry: 3, line: 4, start: 5, end: 6, progress: "Ready" }),
  "Entry 3 · source line 4 · bytes [5, 6) · Ready"
);

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { language: "zh-CN" }
});
const chinese = await import(`${moduleUrl}#zh`);
chinese.validateMessages();
assert.equal(chinese.locale, "zh-CN");
assert.equal(
  chinese.t("main.entryProgress", { entry: 3, line: 4, start: 5, end: 6, progress: "就绪" }),
  "条目 3 · 源文件行 4 · 字节 [5, 6) · 就绪"
);
assert.throws(() => chinese.t("main.entryLabel"), /Missing i18n parameter ordinal/);
assert.throws(() => chinese.t("main.entryLabel", { ordinal: 3, extra: "x" }), /Unexpected i18n parameter extra/);

const html = await readFile(resolve(root, "index.html"), "utf8");
const englishSource = await readFile(resolve(root, "src/i18n/en.ts"), "utf8");
const englishKeys = new Set([...englishSource.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1]));
const staticKeys = [...html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder))?="([^"]+)"/g)].map((match) => match[1]);
assert.ok(staticKeys.length > 0, "index.html has no static i18n markers");
for (const key of staticKeys) {
  assert.ok(englishKeys.has(key), `missing English catalog key ${key}`);
}
assert.match(html, /<span data-i18n="shell\.openFile">Open File<\/span> <span class="shortcut"[^>]*>Ctrl\/Cmd\+O/);
assert.match(html, /value="json"/);
assert.match(html, /value="jsonl"/);

const main = await readFile(resolve(root, "src/main.ts"), "utf8");
const dynamicKeys = [...main.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
for (const key of dynamicKeys) {
  assert.ok(englishKeys.has(key), `missing dynamic English catalog key ${key}`);
}
assert.match(main, /setText\(filePath, summary\.path\)/);
assert.match(main, /setText\(inspectorPath, summary\.path\)/);
assert.doesNotMatch(main, /MutationObserver/);

const localizedModules = ["entry-list.ts", "collection-list.ts", "tree-view.ts", "raw-view.ts", "content-viewer.ts"];
const moduleKeys = new Set();
for (const fileName of localizedModules) {
  const source = await readFile(resolve(root, "src", fileName), "utf8");
  const keys = [...source.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  for (const key of keys) {
    moduleKeys.add(key);
    assert.ok(englishKeys.has(key), `${fileName} references missing English catalog key ${key}`);
  }
}

assert.equal(
  english.t("raw.preSource", { source: "payload" }),
  "Raw UTF-8 bytes for payload",
  "English Raw labels changed user-provided source text"
);
assert.equal(
  chinese.t("raw.preSource", { source: "payload" }),
  "payload的原始 UTF-8 字节",
  "Chinese Raw labels translated user-provided source text"
);
assert.equal(
  chinese.t("tree.copyFailed", { message: "backend diagnostic" }),
  "复制失败：backend diagnostic",
  "Chinese Tree copy status translated a backend diagnostic"
);

console.log(`i18n checks passed: ${staticKeys.length} static markers, ${new Set(dynamicKeys).size} main keys, ${moduleKeys.size} view keys`);
