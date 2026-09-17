#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteBin = resolve(root, "node_modules/vite/bin/vite.js");
const session = `sjv-viewer-budget-${process.pid}`;

const mainSource = readFileSync(resolve(root, "src/main.ts"), "utf8");
const viewerSource = readFileSync(resolve(root, "src/content-viewer.ts"), "utf8");
if (!/const projectionBudget = new ProjectionBudget\(\)/.test(mainSource)) throw new Error("main does not construct the shared ProjectionBudget");
const viewerStart = mainSource.indexOf("const contentViewer = new ContentViewer(");
const treeStart = mainSource.indexOf("const treeView = new TreeView(");
if (viewerStart < 0 || treeStart <= viewerStart) throw new Error("main ContentViewer wiring boundaries were not found");
const mainViewerBlock = mainSource.slice(viewerStart, treeStart);
if (!/\bprojectionBudget,/.test(mainViewerBlock)) throw new Error("main does not pass the shared ProjectionBudget to ContentViewer");
if (!/new SearchView\(\{[\s\S]*?projectionBudget: this\.projectionBudget/.test(viewerSource)) throw new Error("ContentViewer does not pass its budget to SourceSearch");
if (!/new RenderedSearch\(\{[\s\S]*?projectionBudget: this\.projectionBudget/.test(viewerSource)) throw new Error("ContentViewer does not pass its budget to RenderedSearch");

async function freePort() {
  const probe = createServer();
  await new Promise((resolveResult, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveResult);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  const port = address.port;
  await new Promise((resolveResult) => probe.close(resolveResult));
  return port;
}

async function waitForPort(port, vite) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error("Vite exited before becoming ready.");
    try {
      await new Promise((resolveResult, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolveResult(); });
        socket.once("error", (error) => { socket.destroy(); reject(error); });
      });
      return;
    } catch {
      await new Promise((resolveResult) => setTimeout(resolveResult, 100));
    }
  }
  throw new Error("Vite did not become ready.");
}

async function browser(args) {
  const result = await execFileAsync("agent-browser", ["--session", session, ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

function parseBrowserValue(output) {
  try { return JSON.parse(output); } catch {
    const start = output.lastIndexOf("{");
    if (start >= 0) return JSON.parse(output.slice(start));
    throw new Error(`Browser returned non-JSON output: ${output}`);
  }
}

function browserTest() {
  return `(async()=>{
const {ContentViewer}=await import("/src/content-viewer.ts");
const {ProjectionBudget}=await import("/src/projection-budget.ts");
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const scope={label:"Document root",description:"Source Search",enabled:true,decodedEnabled:true,scopeStart:0,scopeEnd:1000,sessionRevision:3,scopeId:null,targetNodeId:null};
const target={revision:3,nodeId:10,spanStart:0,spanEnd:1000,scopeId:null,scopeLabel:"Document root",pathSegments:["$"],pathTruncated:false};
const page={matches:[{nodeId:10,field:"value",pathSegments:["$","message"],pathTruncated:false,sourceSpanStart:20,sourceSpanEnd:42,matchStart:0,matchEnd:6}],hasMore:false,nextCursor:null};
const makeViewer=(projectionBudget)=>{
  const host=document.createElement("div");
  host.innerHTML='<dialog><button id="close">Close</button><h1 id="title"></h1><div id="scope"></div><div id="path"></div><div id="node"></div><div id="span-label"></div><div id="span"></div><div id="semantic"></div><div id="detection"></div><div id="plain"></div><div id="representation"></div><div id="note"></div><div id="range"></div><div id="status"></div><div id="alert"></div><div id="content"></div><button id="previous">Previous</button><button id="next">Next</button><form id="search"><input id="query"><input id="decoded" type="radio" checked><input id="raw" type="radio"><button id="submit">Search</button><p id="description"></p></form><div id="results-panel"><div id="search-status"></div><div id="results"></div><button id="search-prev">Previous</button><button id="search-next">Next</button></div></dialog>';
  document.body.append(host);
  const q=(id)=>host.querySelector("#"+id);
  const elements={dialog:host.querySelector("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next"),search:{form:q("search"),query:q("query"),decoded:q("decoded"),rawSource:q("raw"),submit:q("submit"),description:q("description"),panel:q("search"),resultsPanel:q("results-panel"),status:q("search-status"),results:q("results"),previous:q("search-prev"),next:q("search-next")}};
  const invoke=async(command)=>command==="search_current"?page:null;
  const viewer=new ContentViewer({elements,projectionBudget,invoke,onSessionError:()=>{}});
  return {host,elements,viewer};
};
const defaultViewer=makeViewer();
check(defaultViewer.viewer.sourceSearch?.projectionBudget===defaultViewer.viewer.renderedSearch?.projectionBudget,"ContentViewer without an injected budget did not create one shared internal ledger");
defaultViewer.viewer.clear(false);
defaultViewer.host.remove();
const budget=new ProjectionBudget(2000);
const viewer=makeViewer(budget);
check(viewer.viewer.sourceSearch?.projectionBudget===budget&&viewer.viewer.renderedSearch?.projectionBudget===budget,"ContentViewer did not share one ProjectionBudget with SourceSearch and RenderedSearch");
const source=viewer.viewer.sourceSearch;
source.setScope(scope);
viewer.elements.search.query.value="needle";
viewer.elements.search.form.requestSubmit();
await settle();
const sourceBytes=budget.usedBytes;
check(sourceBytes>0,"Viewer SourceSearch did not occupy the shared ledger");
viewer.viewer.renderedSearch.activate("backend",target,null,"Rendered values");
viewer.elements.search.query.value="needle";
viewer.elements.search.form.requestSubmit();
await settle();
check(budget.usedBytes>sourceBytes&&viewer.viewer.renderedSearch.history.size===1,"Viewer RenderedSearch did not use the shared ledger");
const external={};
// The external entry uses the remaining budget and may evict the non-owner SourceSearch page,
// but must not evict the current RenderedSearch page or mutate the shared form.
const pressureBytes=2000-budget.usedBytes+100;
check(budget.admit(external,pressureBytes,()=>{}),"External shared-budget pressure was not admitted");
check(viewer.viewer.sourceSearch.cachedPageCount===0&&viewer.viewer.renderedSearch.history.size===1&&budget.usedBytes<=2000&&viewer.elements.search.form.dataset.searchOwner==="rendered","Shared pressure did not evict the hidden SourceSearch page while preserving active RenderedSearch");
viewer.viewer.clear(false);
check(budget.usedBytes===pressureBytes,"Closing ContentViewer did not release its Source/Rendered entries without clearing the external entry");
budget.release(external);
check(budget.usedBytes===0,"External shared-budget entry did not release after Viewer close");
viewer.host.remove();
return {pass:true,assertions};
})()`;
}

const port=await freePort();
const vite=spawn(process.execPath,[viteBin,"--host","127.0.0.1","--port",String(port)],{cwd:root,stdio:["ignore","pipe","pipe"]});
let viteOutput="";
vite.stdout.on("data",(chunk)=>{viteOutput+=chunk.toString();});
vite.stderr.on("data",(chunk)=>{viteOutput+=chunk.toString();});
try {
  await waitForPort(port,vite);
  await browser(["open",`http://127.0.0.1:${port}/`]);
  const output=await browser(["eval","-b",Buffer.from(browserTest()).toString("base64")]);
  const result=parseBrowserValue(output);
  if(!result.pass)throw new Error("Viewer projection budget test did not pass.");
  console.log(`viewer-projection-budget-ui PASS (${result.assertions} assertions)`);
} catch(error) {
  throw new Error(`${error instanceof Error?error.message:String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(()=>{});
  vite.kill("SIGTERM");
}
