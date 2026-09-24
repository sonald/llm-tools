#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteBin = resolve(root, "node_modules/vite/bin/vite.js");
const session = `sjv-navigation-list-${process.pid}`;
const check = (condition, message) => { if (!condition) throw new Error(message); };

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function browser(args) {
  const result = await execFileAsync("agent-browser", ["--session", session, ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

const test = String.raw`(async () => {
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US" } });
await import("/src/style.css");
const { EntryList } = await import("/src/entry-list.ts");
const { CollectionList } = await import("/src/collection-list.ts");
let assertions = 0;
const check = (value, message) => { assertions++; if (!value) throw new Error(message); };
const wait = async (predicate, message) => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(message); };
const progress = { indexedEntries: 450, indexedSourceLines: 450, complete: true, stride: 1, totalEntries: 450, eventStreamHint: false };
const search = { fileGeneration: 1, searchId: 1, scannedThrough: 450, scannedCount: 450, matchedCount: 450, indexedCount: 450, totalCount: 450, complete: true, stopped: false, skippedInvalidJson: 0, skippedInvalidUtf8: 0, skippedOversized: 0 };
const entry = n => ({ location: { entryOrdinal: n, sourceLine: n + 1, byteStart: n * 10, byteEnd: n * 10 + 9 }, status: "ready" });
const node = n => ({ id: n + 1, kind: "object", spanStart: n * 10, spanEnd: n * 10 + 9, label: String(n), labelHasMore: false, valuePreview: null, valueHasMore: false, childCount: 1 });
const evidence = ordinal => ({ ordinal, path: '$["message"]', field: "value", snippet: "needle " + "long evidence ".repeat(30), matchStart: 0, matchEnd: 6 });
const calls = [], pending = [];
let deferSearch = false;
const invoke = async (command, args) => {
  calls.push({ command, args });
  if (command === "list_entries") return { entries: Array.from({ length: Math.min(200, 450 - args.start) }, (_, i) => entry(args.start + i)), progress, hasMore: args.start + 200 < 450, nextCursor: args.start + 200 < 450 ? args.start + 200 : null };
  if (command === "select_entry") return { entry: entry(args.ordinal), root: node(args.ordinal), sessionRevision: 1 };
  if (command === "get_children") return { nodes: Array.from({ length: Math.min(200, 450 - args.cursor) }, (_, i) => node(args.cursor + i)), hasMore: args.cursor + 200 < 450, nextCursor: args.cursor + 200 < 450 ? args.cursor + 200 : null };
  if (command === "get_navigation_search_page") {
    const ordinals = Array.from({ length: args.ordinalEnd - args.ordinalStart }, (_, i) => args.ordinalStart + i);
    const response = { ordinals, evidence: ordinals.map(evidence) };
    if (deferSearch) return new Promise(resolve => pending.push(() => resolve(response)));
    return response;
  }
  throw new Error(command);
};
window.__TAURI_INTERNALS__ = { invoke };
for (const mode of ["entry", "collection"]) {
  const host = document.createElement("div"); host.style.width = "300px"; document.body.append(host);
  const element = (tag = "div") => { const el = document.createElement(tag); host.append(el); return el; };
  const list = element(); list.style.cssText = "height:320px;overflow:auto;position:relative";
  const options = { list, goInput: element("input"), goButton: element("button"), goError: element(), status: element(), retry: element("button"), onError: error => { throw error; } };
  let selectionCount = 0, view;
  if (mode === "entry") {
    for (const key of ["navigation", "navigationState", "inspector", "inspectorOrdinal", "inspectorStatus", "inspectorSourceLine", "inspectorBytes", "inspectorParseMessage", "inspectorParseByteOffset", "inspectorParseLine", "inspectorParseColumn"]) options[key] = element();
    options.previous = element("button"); options.next = element("button");
    options.onSelection = selection => { selectionCount++; view.adoptSelection(selection, 1); };
    options.onSelectionBusy = () => {}; options.onRevisionUnknown = () => {}; options.onProgress = () => {};
    view = new EntryList(options); view.setSession({ revision: 1, progress });
  } else {
    options.section = element(); options.invoke = invoke; options.onSelection = () => selectionCount++;
    view = new CollectionList(options); view.setSession({ revision: 1, root: { ...node(0), id: 0, kind: "array", childCount: 450 }, sourceSize: 4500 });
  }
  const row = ordinal => list.querySelector('[data-' + mode.replace("collection", "item") + '-ordinal="' + ordinal + '"]');
  await wait(() => row(0), mode + " initial row missing");
  const initialHeight = row(0).getBoundingClientRect().height;
  view.setNavigationSearch(search);
  await wait(() => row(0)?.dataset.searchMatch === "true", mode + " match not marked");
  check(row(0).textContent.includes("Matched") && row(0).textContent.includes("needle"), mode + " lacks visible match evidence");
  check(row(0).title.includes("message") && row(0).getAttribute("aria-label").includes("needle"), mode + " lacks title/accessible evidence");
  check(row(0).getBoundingClientRect().height === initialHeight, mode + " evidence changed row height");
  check(row(0).getBoundingClientRect().width <= 300, mode + " evidence expanded row width");
  const searchCalls = calls.filter(call => call.command === "get_navigation_search_page").length;
  view.setNavigationSearch({ ...search, scannedThrough: 500, matchedCount: 500 });
  await new Promise(resolve => setTimeout(resolve, 10));
  check(calls.filter(call => call.command === "get_navigation_search_page").length === searchCalls, mode + " rescanned a finished window");
  view.setSearchFiltered(true); view.setOpening(true); view.setOpening(false);
  check(list.hidden && options.status.hidden && options.retry.hidden, mode + " render restored filtered list");
  view.setSearchFiltered(false);
  view.navigateToOrdinal(205);
  await wait(() => row(205)?.dataset.searchMatch === "true" && selectionCount === 1, mode + " second window missing");
  check(calls.some(call => call.command === "get_navigation_search_page" && call.args.ordinalStart === 200 && call.args.ordinalEnd === 400), mode + " did not query second ordinal window");
  view.setNavigationSearch(null); view.showSelected();
  await wait(() => row(205), mode + " clear failed to preserve selected row");
  check(row(205).getAttribute("aria-selected") === "true" && !row(205).dataset.searchMatch && selectionCount === 1, mode + " clear changed reading selection");
  deferSearch = true; view.setNavigationSearch({ ...search, searchId: 2 });
  await wait(() => pending.length > 0, mode + " deferred search missing");
  deferSearch = false; view.navigateToOrdinal(405);
  await wait(() => row(405)?.dataset.searchMatch === "true", mode + " third window missing");
  pending.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setTimeout(resolve, 20));
  check(row(405)?.dataset.searchMatch === "true", mode + " stale window response overwrote current matches");
  deferSearch = true; view.setNavigationSearch({ ...search, searchId: 3 });
  await wait(() => pending.length > 0, mode + " deferred clear search missing");
  view.setNavigationSearch(null); pending.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setTimeout(resolve, 20));
  check(!list.querySelector("[data-search-match]"), mode + " stale response restored cleared matches");
  deferSearch = false; view.clear();
  if (mode === "entry") {
    options.navigationState.hidden = true;
    view.setSearchFiltered(true);
    check(options.navigationState.hidden, "Inactive EntryList changed the Collection navigation state");
  }
  host.remove();
}
return { pass: true, assertions };
})()`;

const port = await freePort();
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let output = "";vite.stdout.on("data", chunk => { output += chunk.toString(); });vite.stderr.on("data", chunk => { output += chunk.toString(); });
try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await new Promise((resolveConnect, reject) => { const socket=createConnection({host:"127.0.0.1",port});socket.once("connect",()=>{socket.destroy();resolveConnect();});socket.once("error",reject); }); break; }
    catch { await new Promise(resolveWait=>setTimeout(resolveWait,100)); }
  }
  await browser(["open", `http://127.0.0.1:${port}/scripts/test-i18n-fixture.html`]);
  const result = JSON.parse(await browser(["eval", "-b", Buffer.from(test).toString("base64")]));
  check(result.pass, "navigation list browser checks failed");
  console.log(`navigation-list-ui PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
