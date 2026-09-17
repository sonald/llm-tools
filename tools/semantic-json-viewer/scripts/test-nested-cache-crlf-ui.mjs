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
const session = `sjv-nested-cache-crlf-${process.pid}`;

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
  const result = await execFileAsync("agent-browser", ["--session", session, ...args], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024
  });
  return result.stdout.trim();
}

function parseBrowserValue(output) {
  try { return JSON.parse(output); } catch {
    const start = output.lastIndexOf("{");
    if (start >= 0) return JSON.parse(output.slice(start));
    throw new Error("Browser returned non-JSON output: " + output);
  }
}

function browserTest() {
  return `(async()=>{
Object.defineProperty(globalThis,"navigator",{configurable:true,value:{language:"en-US"}});
const {ContentViewer}=await import("/src/content-viewer.ts");
const N=128*1024;
const page0="A".repeat(N-1)+String.fromCharCode(13);
const page1=String.fromCharCode(10)+"B"+" ".repeat(N-2);
const page2="C".repeat(N);
const page3="D".repeat(N);
const pages=new Map([[0,page0],[N,page1],[N*2,page2],[N*3,page3]]);
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
check(page0.length===N&&page0.charCodeAt(N-1)===13&&page1.length===N&&page1.charCodeAt(0)===10,"CRLF boundary fixture is not byte-sized CR then LF");
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const makeViewer=(invoke)=>{
  const host=document.createElement("div");
  host.innerHTML='<dialog><button id="close">Close</button><span id="title"></span><span id="scope"></span><span id="path"></span><span id="node"></span><span id="span-label"></span><span id="span"></span><span id="semantic"></span><span id="detection"></span><span id="plain"></span><span id="representation"></span><span id="note"></span><span id="range"></span><span id="status"></span><span id="alert"></span><div id="content"></div><button id="previous">Previous</button><button id="next">Next</button><select id="render-as"><option value="auto">Auto</option><option value="nestedJson">Nested JSON</option></select><button id="markdown-anyway">Render Markdown Anyway</button><div id="string-tabs"><button id="rendered">Rendered</button><button id="decoded">Decoded Source</button><button id="raw">Raw Lexeme</button></div><div id="nested-nav"><button id="back">Back</button><ol id="crumb"></ol></div><div id="nested-tabs"><button id="parsed">Parsed</button><button id="nested-decoded">Decoded String</button><button id="nested-raw">Raw Lexeme</button></div><section id="parsed-panel"><div id="parsed-tree"></div></section><div id="text-panel"></div></dialog>';
  document.body.append(host);
  const q=(id)=>id==="dialog"?host.querySelector("dialog"):host.querySelector("#"+id);
  const elements={dialog:q("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next"),renderAs:q("render-as"),markdownAnyway:q("markdown-anyway"),string:{representations:q("string-tabs"),renderedTab:q("rendered"),decodedTab:q("decoded"),rawTab:q("raw")},nested:{navigation:q("nested-nav"),back:q("back"),breadcrumb:q("crumb"),representations:q("nested-tabs"),parsedTab:q("parsed"),decodedTab:q("nested-decoded"),rawTab:q("nested-raw"),parsedPanel:q("parsed-panel"),parsedTree:q("parsed-tree"),sharedTextPanel:q("text-panel")}};
  return {host,elements,viewer:new ContentViewer({elements,invoke,textCacheBudgetBytes:2*N+128,onSessionError:(error)=>{throw error;}})};
};
const target={revision:1,nodeId:1,spanStart:0,spanEnd:N*4,scopeId:null,scopeLabel:"Document",pathSegments:["$","payload"],pathTruncated:false};
const calls=[];
const invoke=async(command,args)=>{
  calls.push({command,args});
  if(command==="get_string_detection")return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json")return {scopeId:77,parentScopeId:null,sourceNodeId:1,depth:1,maxDepth:5,parsedBytes:N*4,cumulativeBytes:N*4,sessionRevision:1,root:{id:7,kind:"object",spanStart:0,spanEnd:N*4,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:3}};
  if(command==="close_nested_scope")return null;
  if(command==="read_decoded_text"){
    const text=pages.get(args.offset);if(text===undefined)throw new Error("unexpected decoded offset "+args.offset);
    const next=args.offset+N;return {start:args.offset,text,hasMore:next<N*4,nextOffset:next<N*4?next:null};
  }
  if(command==="read_raw_slice"){
    const offset=args.sourceStart;const text=pages.get(offset);if(text===undefined)throw new Error("unexpected raw offset "+offset);
    const next=offset+N;return {start:offset,text,hasMore:next<N*4,nextOffset:next<N*4?next:null};
  }
  throw new Error("unexpected command "+command);
};
const viewer=makeViewer(invoke);
await viewer.viewer.open(target);await settle();
viewer.elements.nested.decodedTab.click();await settle();
const state=()=>viewer.viewer.nestedFrames.at(-1).decoded;
const lineState=()=>({text:viewer.viewer.textLineView?.text,lines:viewer.viewer.textLineView?.lines.length});
check(state().current?.start===0,"initial nested decoded page did not load");
viewer.elements.next.click();await settle();
const firstMiddle=lineState();
check(firstMiddle.text?.startsWith("\\nB")&&firstMiddle.lines===1,"first middle page did not coalesce the CRLF boundary");
viewer.elements.next.click();await settle();
check(state().current?.start===N*2,"third nested page did not load");
viewer.elements.previous.click();await settle();
const rereadMiddle=lineState();
check(rereadMiddle.text===firstMiddle.text&&rereadMiddle.lines===firstMiddle.lines,"evicted middle page changed text or line count on re-read");
check(calls.filter((call)=>call.command==="read_decoded_text"&&call.args.offset===N).length>=2,"Previous did not re-read the evicted middle page");
viewer.elements.nested.rawTab.click();await settle();
check(state().pages.size===0||state().current===null,"raw pressure did not evict the hidden decoded page");
const beforeInitialRead=calls.filter((call)=>call.command==="read_decoded_text"&&call.args.offset===N).length;
viewer.elements.nested.decodedTab.click();await settle();
const restoredMiddle=lineState();
check(calls.filter((call)=>call.command==="read_decoded_text"&&call.args.offset===N).length>beforeInitialRead&&restoredMiddle.text===firstMiddle.text&&restoredMiddle.lines===firstMiddle.lines,"returning to decoded did not re-read the hidden evicted page with the original line state");
viewer.viewer.clear(false);viewer.host.remove();
return {pass:true,assertions};
})()`;
}

const port = await freePort();
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += chunk.toString(); });
vite.stderr.on("data", (chunk) => { viteOutput += chunk.toString(); });
try {
  await waitForPort(port, vite);
  await browser(["open", `http://127.0.0.1:${port}/scripts/test-i18n-fixture.html`]);
  const result = parseBrowserValue(await browser(["eval", "-b", Buffer.from(browserTest()).toString("base64")]));
  if (!result.pass) throw new Error("Nested cache CRLF UI test did not pass.");
  console.log(`nested-cache-crlf-ui PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
