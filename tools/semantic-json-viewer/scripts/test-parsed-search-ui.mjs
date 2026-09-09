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
const session = `sjv-parsed-search-${process.pid}`;

const check = (condition, message) => { if (!condition) throw new Error(message); };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolveResult) => setTimeout(resolveResult, 0)); };

async function freePort() {
  const probe = createServer();
  await new Promise((resolveResult, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolveResult); });
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
    } catch { await new Promise((resolveResult) => setTimeout(resolveResult, 100)); }
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
  return `(async () => {
const {ContentViewer}=await import("/src/content-viewer.ts");
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const host=document.createElement("div");
host.innerHTML='<dialog><button id="close">Close</button><div id="title"></div><div id="scope"></div><div id="path"></div><div id="node"></div><div id="span-label"></div><div id="span"></div><div id="semantic"></div><div id="detection"></div><div id="plain"></div><div id="representation"></div><div id="note"></div><div id="range"></div><div id="status"></div><div id="alert"></div><div id="string-tabs"><button id="rendered">Rendered</button><button id="decoded">Decoded Source</button><button id="string-raw">Raw Lexeme</button></div><div id="nested-nav"><button id="back">Back</button><ol id="crumb"></ol></div><div id="nested-tabs"><button id="parsed">Parsed</button><button id="nested-decoded">Decoded String</button><button id="nested-raw">Raw Lexeme</button></div><section id="parsed-panel"><div id="parsed-tree"></div><section id="peek" hidden><h3>Parsed source match</h3><dl><div><dt>Field</dt><dd id="peek-field"></dd></div><div><dt>Node</dt><dd id="peek-node"></dd></div><div><dt>Path</dt><dd id="peek-path"></dd></div><div><dt>Source token span</dt><dd id="peek-span"></dd></div><div><dt>Displayed range</dt><dd id="peek-displayed"></dd></div><div><dt>Decoded match bytes</dt><dd id="peek-decoded"></dd></div></dl><pre id="peek-source"></pre><p id="peek-note"></p></section></section><div id="text-panel"></div><form id="search"><input id="query"><input id="decoded-radio" type="radio" name="rep" checked><input id="raw-radio" type="radio" name="rep"><button id="submit" type="submit">Search</button><p id="description"></p></form><div id="results-panel"><div id="search-status"></div><div id="results"></div><button id="prev">Previous</button><button id="next">Next</button></div><pre id="content"></pre><div id="range"></div><button id="previous">Previous</button><button id="next-page">Next</button></dialog>';
host.innerHTML=host.innerHTML.replace("<dialog>","<dialog id=\\\"dialog\\\">");
host.innerHTML=host.innerHTML.replace('<div id="range"></div><div id="status">','<div id="meta-range"></div><div id="status">');
document.body.append(host);
const q=(id)=>host.querySelector("#"+id);
const elements={dialog:q("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next-page"),nested:{navigation:q("nested-nav"),back:q("back"),breadcrumb:q("crumb"),representations:q("nested-tabs"),parsedTab:q("parsed"),decodedTab:q("nested-decoded"),rawTab:q("nested-raw"),parsedPanel:q("parsed-panel"),parsedTree:q("parsed-tree"),sharedTextPanel:q("text-panel"),parsedSearchPeek:{panel:q("peek"),field:q("peek-field"),node:q("peek-node"),path:q("peek-path"),sourceSpan:q("peek-span"),displayedRange:q("peek-displayed"),decodedRange:q("peek-decoded"),source:q("peek-source"),note:q("peek-note")}},search:{form:q("search"),query:q("query"),decoded:q("decoded-radio"),rawSource:q("raw-radio"),submit:q("submit"),description:q("description"),panel:q("search"),resultsPanel:q("results-panel"),status:q("search-status"),results:q("results"),previous:q("prev"),next:q("next")}};
const calls=[];
const pendingPeek=new Map();
const target={revision:9,nodeId:20,spanStart:37,spanEnd:300500,scopeId:null,scopeLabel:"Parent string",pathSegments:["$","payload"],pathTruncated:false};
const scope={scopeId:7,parentScopeId:null,sourceNodeId:20,depth:1,maxDepth:1,parsedBytes:300000,cumulativeBytes:300000,sessionRevision:9,root:{id:20,kind:"object",spanStart:0,spanEnd:300000,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:4}};
const invoke=async(command,args)=>{
  calls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json") return scope;
  if(command==="search_current") {
    if(args.scopeId===null) return {matches:[],hasMore:false,nextCursor:null};
    check(args.representation==="decoded"&&args.scopeId===7&&args.nodeId===20,"Parsed search did not bind the child scope root");
    if(args.query==="long") return {matches:[{nodeId:22,field:"value",pathSegments:["$","long"],pathTruncated:false,sourceSpanStart:10,sourceSpanEnd:200000,matchStart:0,matchEnd:4}],hasMore:false,nextCursor:null};
    if(args.query==="two") return {matches:[{nodeId:23,field:"value",pathSegments:["$","first"],pathTruncated:false,sourceSpanStart:60,sourceSpanEnd:75,matchStart:0,matchEnd:3},{nodeId:24,field:"value",pathSegments:["$","second"],pathTruncated:false,sourceSpanStart:70,sourceSpanEnd:85,matchStart:0,matchEnd:3}],hasMore:false,nextCursor:null};
    if(args.query==="A") return {matches:[{nodeId:25,field:"value",pathSegments:["$","a"],pathTruncated:false,sourceSpanStart:80,sourceSpanEnd:95,matchStart:0,matchEnd:1}],hasMore:false,nextCursor:null};
    if(args.query==="B") return {matches:[],hasMore:false,nextCursor:null};
    if(args.query==="late") return {matches:[{nodeId:26,field:"value",pathSegments:["$","late"],pathTruncated:false,sourceSpanStart:50,sourceSpanEnd:65,matchStart:0,matchEnd:4}],hasMore:false,nextCursor:null};
    return {matches:[{nodeId:21,field:"key",pathSegments:["$","escaped"],pathTruncated:false,sourceSpanStart:123,sourceSpanEnd:137,matchStart:0,matchEnd:6}],hasMore:false,nextCursor:null};
  }
  if(command==="read_raw_slice") {
    check(args.scopeId===7&&args.length<=131072,"Parsed reveal did not read one bounded child-scope raw window");
    if(args.sourceStart===10) return {start:10,text:"N".repeat(131072),hasMore:true,nextOffset:131082};
    if([50,60,70,80].includes(args.sourceStart)) return new Promise((resolve)=>pendingPeek.set(args.sourceStart,resolve));
    check(args.sourceStart===123,"Parsed reveal did not read the requested source token");
    return {start:123,text:"\\"\\\\u4f60\\\\u597d\\"",hasMore:true,nextOffset:137};
  }
  if(command==="read_decoded_text") return {start:0,text:"source",hasMore:false,nextOffset:null};
  if(command==="close_nested_scope") return null;
  throw new Error("unexpected command "+command);
};
for(const [key,value] of Object.entries(elements)) if(value===null) throw new Error("missing ContentViewer element "+key);
for(const [key,value] of Object.entries(elements.nested)) if(value===null) throw new Error("missing nested ContentViewer element "+key);
for(const [key,value] of Object.entries(elements.search)) if(value===null) throw new Error("missing search ContentViewer element "+key);
const viewer=new ContentViewer({elements,invoke,onSessionError:()=>{throw new Error("unexpected global error");}});
await viewer.open(target);
await settle();
check(q("parsed").classList.contains("is-active"),"Parsed tab was not active");
check(q("raw-radio").disabled&&q("raw-radio").checked===false,"Parsed search did not lock Raw radio");
check(!q("query").disabled,"Parsed search form was not enabled");
q("query").value="你好";
q("search").requestSubmit();
await settle();
q("results").querySelector("button").click();
await settle();
check(q("peek").hidden===false&&q("peek-field").textContent==="Key","Parsed source peek did not identify the field");
check(q("peek-node").textContent==="#21"&&q("peek-path").textContent.includes("$.escaped"),"Parsed source peek lost node/path identity");
check(q("peek-span").textContent==="[123, 137)"&&q("peek-displayed").textContent==="[123, 137)","Parsed source peek ranges were not child-scope relative");
check(q("peek-decoded").textContent==="[0, 6)"&&q("peek-source").textContent.includes("\\\\u4f60"),"Parsed source peek did not show decoded range and raw bytes");
check(q("parsed").classList.contains("is-active")&&!q("parsed-panel").hidden,"Parsed Tree presentation changed during peek");
q("query").value="long";
q("search").requestSubmit();
await settle();
q("results").querySelector("button").click();
await settle();
check(q("peek-source").textContent.length===131072&&q("peek-displayed").textContent==="[10, 131082)"&&q("peek-note").textContent.includes("first 128 KiB"),"Long Parsed token did not stay within the one-window peek limit");
q("query").value="two";
q("search").requestSubmit();
await settle();
const twoResults=q("results").querySelectorAll("button");
check(twoResults.length===2,"Parsed reverse-order search did not render two hits");
twoResults[0].click();
await Promise.resolve();
twoResults[1].click();
await Promise.resolve();
check(pendingPeek.has(60)&&pendingPeek.has(70),"Parsed reverse-order hits did not create two pending peeks");
pendingPeek.get(70)({start:70,text:"B",hasMore:true,nextOffset:71});
pendingPeek.delete(70);
await settle();
pendingPeek.get(60)({start:60,text:"A",hasMore:true,nextOffset:61});
pendingPeek.delete(60);
await settle();
check(q("peek-source").textContent==="B"&&q("peek-displayed").textContent==="[70, 71)","Older Parsed hit overwrote the latest peek");
q("query").value="A";
q("query").dispatchEvent(new Event("input",{bubbles:true}));
q("search").requestSubmit();
await settle();
q("results").querySelector("button").click();
await Promise.resolve();
check(pendingPeek.has(80),"Parsed A search did not create a pending peek");
q("query").value="B";
q("query").dispatchEvent(new Event("input",{bubbles:true}));
q("search").requestSubmit();
await settle();
q("query").value="A";
q("query").dispatchEvent(new Event("input",{bubbles:true}));
q("search").requestSubmit();
await settle();
pendingPeek.get(80)({start:80,text:"stale",hasMore:true,nextOffset:85});
pendingPeek.delete(80);
await settle();
check(q("peek").hidden,"Parsed A→B→A stale response repopulated the peek; source="+q("peek-source").textContent+" field="+q("peek-field").textContent+" status="+q("status").textContent+" search="+q("search-status").textContent);
q("nested-decoded").click();
await settle();
q("query").value="source";
q("search").requestSubmit();
await settle();
check(q("peek").hidden&&q("peek-source").textContent===""&&q("peek-field").textContent==="—"&&q("search").textContent.includes("Search the decoded source"),"switching Source tab did not clear Parsed peek or restore parent scope");
const decodedCall=calls.filter((call)=>call.command==="search_current").at(-1);
check(decodedCall?.args.scopeId===null&&decodedCall?.args.nodeId===20,"Source search did not remain bound to the parent string scope");
await viewer.open(target);
await settle();
q("query").value="late";
q("search").requestSubmit();
await settle();
q("results").querySelector("button").click();
await Promise.resolve();
check(pendingPeek.has(50),"Parsed close test did not create a pending peek");
q("close").click();
pendingPeek.get(50)({start:50,text:"late",hasMore:true,nextOffset:54});
pendingPeek.delete(50);
await settle();
check(q("peek").hidden&&q("peek-source").textContent==="","Closing Parsed viewer did not invalidate a late peek response");
host.remove();
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
  if(!result.pass) throw new Error("Parsed search browser test did not pass.");
  console.log(`parsed-search-ui PASS (${result.assertions} assertions)`);
} catch(error) {
  throw new Error(`${error instanceof Error?error.message:String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(()=>{});
  vite.kill("SIGTERM");
}
