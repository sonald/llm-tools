#!/usr/bin/env node

import assert from "node:assert/strict";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = await build({
  root,
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    lib: { entry: resolve(root, "src/projection-budget.ts"), formats: ["es"], fileName: "projection-budget" },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});
const chunk = result[0]?.output.find((entry) => entry.type === "chunk");
assert.ok(chunk && chunk.type === "chunk", "ProjectionBudget bundle was not generated");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;
const { ProjectionBudget } = await import(moduleUrl);

let assertions = 0;
const check = (condition, message) => {
  assertions += 1;
  assert.ok(condition, message);
};

const budget = new ProjectionBudget(10);
const a = {};
const b = {};
const c = {};
const evicted = [];
check(budget.admit(a, 6, () => evicted.push("a")), "first entry was not admitted");
check(budget.admit(b, 4, () => evicted.push("b")), "second entry was not admitted");
budget.touch(a);
check(budget.admit(c, 4, () => evicted.push("c")), "LRU entry could not be reclaimed");
check(evicted.join(",") === "b" && budget.usedBytes === 10, "LRU order or accounting was wrong");

const replacementBudget = new ProjectionBudget(5);
const replacement = {};
check(replacementBudget.admit(replacement, 4, () => {}), "replacement entry was not admitted");
check(replacementBudget.admit(replacement, 2, () => {}) && replacementBudget.usedBytes === 2, "same-key replacement did not replace its old size");

const protectedKey = {};
const protectedBudget = new ProjectionBudget(5);
check(protectedBudget.admit(protectedKey, 5, () => {}, () => false), "protected entry was not admitted");
check(!protectedBudget.admit({}, 1, () => {}), "protected entry was evicted or budget exceeded");
check(protectedBudget.usedBytes === 5, "failed admission exceeded the budget");
check(!protectedBudget.admit({}, 6, () => {}), "oversized entry was admitted");
check(protectedBudget.usedBytes === 5, "oversized admission changed accounting");

const callbackBudget = new ProjectionBudget(4);
const callbackKey = {};
const releasedKey = {};
let callbackObservedUsed = -1;
callbackBudget.admit(callbackKey, 4, () => { callbackObservedUsed = callbackBudget.usedBytes; });
check(callbackBudget.admit(releasedKey, 1, () => {}), "callback test could not reclaim an entry");
check(callbackObservedUsed === 1, "eviction callback ran before accounting was updated");
callbackBudget.release(releasedKey);
check(callbackBudget.usedBytes === 0, "release did not clear accounting");
callbackBudget.release(releasedKey);
check(callbackBudget.usedBytes === 0, "release was not idempotent");

console.log(`projection-budget PASS (${assertions} assertions)`);
