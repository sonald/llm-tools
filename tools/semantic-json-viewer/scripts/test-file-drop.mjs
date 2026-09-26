import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual listener with a pending open to catch overlapping sessions.
const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const registration = ast.statements.find((node) => ts.isIfStatement(node)
  && node.expression.getText(ast) === "isTauri()");
assert.ok(registration, "native drop listener is registered");
let drop;
const calls = [];
const oldError = { code: "open_failed", message: "previous error" };
const state = { opening: false, selectionBusy: false, generation: 0, error: oldError };
const modeDialog = { open: false };
const context = {
  isTauri: () => true,
  getCurrentWindow: () => ({ onDragDropEvent: (handler) => { drop = handler; return Promise.resolve(); } }),
  state, modeDialog,
  render: () => {},
  ipcError: (error) => error,
  openPath: (...args) => { calls.push(args); return new Promise(() => {}); }
};
runInNewContext(ts.transpile(registration.getText(ast)), context);
const send = (paths, type = "drop") => drop({ payload: { type, paths } });
send(["/tmp/data.json"], "enter");
send([]);
assert.equal(calls.length, 0);
for (const path of ["/tmp/data.json", "/tmp/中文 data.JSONL"]) {
  state.opening = false;
  send([path, "/tmp/ignored.json"]);
  assert.deepEqual(calls.at(-1), [path, null, state.generation]);
  assert.equal(state.opening, true);
  assert.equal(state.pendingChoicePreviousError, oldError);
  const count = calls.length;
  send(["/tmp/concurrent.json"]);
  assert.equal(calls.length, count);
}
assert.equal(state.generation, 2);
state.opening = false;
state.selectionBusy = true;
send(["/tmp/busy.json"]);
state.selectionBusy = false;
modeDialog.open = true;
send(["/tmp/modal.json"]);
assert.equal(calls.length, 2);
const error = new Error("listener failed");
context.getCurrentWindow = () => ({ onDragDropEvent: () => Promise.reject(error) });
runInNewContext(ts.transpile(registration.getText(ast)), context);
await new Promise(setImmediate);
assert.equal(state.error, error);
console.log("file-drop PASS (JSON/JSONL paths, first file, busy/modal guards, listener error)");
