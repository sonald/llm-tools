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
const session = `sjv-copy-ui-${process.pid}`;

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

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

function browserTest() {
  return `(async()=>{
const {TreeView}=await import("/src/tree-view.ts");
const {RawView}=await import("/src/raw-view.ts");
const {ContentViewer}=await import("/src/content-viewer.ts");
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const makeNode=(id,kind="object")=>({id,kind,spanStart:0,spanEnd:20,label:id===1?"$":"message",labelHasMore:false,valuePreview:kind==="string"?"hello":null,valueHasMore:false,childCount:0});

const treeHost=document.createElement("div");
treeHost.innerHTML='<section id="tree"></section><button id="tab"></button><aside id="inspector"><span id="id"></span><span id="label"></span><span id="kind"></span><span id="span"></span><span id="children"></span><span id="value"></span><button id="raw">Copy Raw</button><button id="subtree">Copy JSON Subtree</button><button id="decoded">Copy Decoded Value</button><button id="path">Copy Path</button><span id="copy-status"></span></aside>';
document.body.append(treeHost);
let treeResolve;
const treeCalls=[];
const tree=new TreeView({panel:treeHost.querySelector("#tree"),tab:treeHost.querySelector("#tab"),inspector:treeHost.querySelector("#inspector"),fields:{id:treeHost.querySelector("#id"),label:treeHost.querySelector("#label"),kind:treeHost.querySelector("#kind"),span:treeHost.querySelector("#span"),children:treeHost.querySelector("#children"),value:treeHost.querySelector("#value")},copy:{raw:treeHost.querySelector("#raw"),subtree:treeHost.querySelector("#subtree"),decoded:treeHost.querySelector("#decoded"),path:treeHost.querySelector("#path"),status:treeHost.querySelector("#copy-status")},onSelection:()=>{},onStringSelection:()=>{},onStringOpen:()=>{},onError:(error)=>{throw error;},invoke:async(command,args)=>{treeCalls.push({command,args});return new Promise((resolve)=>{treeResolve=resolve;});}});
tree.setSession({mode:"document",sessionRevision:7,scopeId:null,sourceSize:100,ariaLabel:"JSON structure"},makeNode(1));
treeHost.querySelector('[data-node-id="1"]').click();
treeHost.querySelector("#raw").click();
treeHost.querySelector("#raw").click();
check(treeCalls.length===1&&treeCalls[0].command==="copy_node"&&treeCalls[0].args.nodeId===1&&treeCalls[0].args.scopeId===null&&treeCalls[0].args.sessionRevision===7&&treeCalls[0].args.format==="raw","Tree Copy Raw IPC contract or duplicate guard failed");
check(treeHost.querySelector("#raw").disabled,"Tree copy button was not disabled while pending");
treeResolve();await settle();
check(treeHost.querySelector("#copy-status").textContent==="Copied Raw","Tree copy success was not local");
tree.setSession({mode:"document",sessionRevision:7,scopeId:null,sourceSize:100,ariaLabel:"JSON structure"},makeNode(2,"string"));
check(treeHost.querySelector("#copy-status").textContent===""&&treeHost.querySelector("#raw").disabled===true,"Tree target switch retained stale copy state");
treeHost.querySelector('[data-node-id="2"]').click();
check(!treeHost.querySelector("#decoded").disabled,"Tree scalar did not enable Copy Decoded Value");
treeHost.remove();

const rawHost=document.createElement("div");
const rawPanel=document.createElement("section");
const rawTab=document.createElement("button");
rawHost.append(rawPanel,rawTab);document.body.append(rawHost);
const rawCalls=[];let rawResolve;let rawReject;
const raw=new RawView({panel:rawPanel,tab:rawTab,onError:(error)=>{throw error;},invoke:async(command,args)=>{rawCalls.push({command,args});return new Promise((resolve,reject)=>{rawResolve=resolve;rawReject=reject;});}});
raw.setNonValidEntry(9,{status:"invalidUtf8",location:{entryOrdinal:2,sourceLine:3,byteStart:100,byteEnd:140}});
const copyHex=Array.from(rawPanel.querySelectorAll("button")).find((button)=>button.textContent==="Copy Hex");
copyHex.click();copyHex.click();
check(rawCalls.length===1&&rawCalls[0].command==="copy_current_bytes"&&rawCalls[0].args.format==="hex"&&rawCalls[0].args.sessionRevision===9,"Raw invalid-byte Hex IPC contract or duplicate guard failed");
check(!rawCalls.some((call)=>call.command==="read_selected_entry_window"),"Raw copy unexpectedly copied a rendered page");
rawResolve();await settle();
check(rawPanel.textContent.includes("Copied Hex"),"Raw Hex success was not local");
raw.setRawDocument(10,50,{code:"unsupported_encoding",message:"bad"});
const copyLossy=Array.from(rawPanel.querySelectorAll("button")).find((button)=>button.textContent==="Copy Lossy Text");
copyLossy.click();
check(rawCalls.at(-1)?.command==="copy_current_bytes"&&rawCalls.at(-1).args.format==="lossy"&&rawCalls.at(-1).args.sessionRevision===10,"Raw-only Lossy IPC contract failed");
rawResolve();await settle();
raw.setNonValidEntry(10,{status:"invalidUtf8",location:{entryOrdinal:2,sourceLine:3,byteStart:100,byteEnd:140}});
const localErrorCopy=Array.from(rawPanel.querySelectorAll("button")).find((button)=>button.textContent==="Copy Hex");
localErrorCopy.click();rawReject(new Error("clipboard denied"));await settle();
check(rawPanel.textContent.includes("Copy failed: clipboard denied"),"Raw copy error was not local");
raw.setSession(11,makeNode(4,"string"),50,"document");
const copyRaw=Array.from(rawPanel.querySelectorAll("button")).find((button)=>button.textContent==="Copy Raw");
copyRaw.click();
check(rawCalls.at(-1)?.command==="copy_node"&&rawCalls.at(-1).args.nodeId===4&&rawCalls.at(-1).args.scopeId===null&&rawCalls.at(-1).args.sessionRevision===11&&rawCalls.at(-1).args.format==="raw","Raw node Copy Raw IPC contract failed");
raw.revealRange(2,8,"Search match");
rawResolve();await settle();
raw.setScope({...makeNode(5,"string"),spanStart:2,spanEnd:8});
check(!copyRaw.disabled&&rawPanel.textContent.includes("Select Raw"),"Raw reveal left the new node copy action locked or stale");
rawHost.remove();

const viewerHost=document.createElement("div");
viewerHost.innerHTML='<dialog id="dialog"><button id="close">Close</button><span id="title"></span><span id="scope"></span><span id="path"></span><span id="node"></span><span id="span-label"></span><span id="span"></span><span id="semantic"></span><span id="detection"></span><span id="plain"></span><span id="representation"></span><span id="note"></span><span id="range"></span><span id="status"></span><div id="alert"></div><div id="content"></div><button id="raw-copy">Copy Raw Lexeme</button><button id="decoded-copy">Copy Decoded Value</button><button id="markdown-copy">Copy Markdown Source</button><button id="parsed-copy">Copy Parsed JSON</button><span id="copy-status"></span><select id="render-as"><option value="auto">Auto</option></select><button id="markdown-anyway">Anyway</button><button id="previous">Prev</button><button id="next">Next</button></dialog>';
document.body.append(viewerHost);
const element=(id)=>viewerHost.querySelector("#"+id);
const viewerCalls=[];let viewerResolve;
const viewer=new ContentViewer({elements:{dialog:element("dialog"),close:element("close"),title:element("title"),scope:element("scope"),path:element("path"),node:element("node"),spanLabel:element("span-label"),span:element("span"),semanticType:element("semantic"),detectionSource:element("detection"),plainReason:element("plain"),representation:element("representation"),rendererNote:element("note"),range:element("range"),status:element("status"),alert:element("alert"),content:element("content"),renderAs:element("render-as"),markdownAnyway:element("markdown-anyway"),previous:element("previous"),next:element("next"),copy:{raw:element("raw-copy"),decoded:element("decoded-copy"),markdown:element("markdown-copy"),parsed:element("parsed-copy"),status:element("copy-status")}},invoke:async(command,args)=>{viewerCalls.push({command,args});if(command==="get_string_detection")return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};if(command==="read_decoded_text")return {start:0,text:"# source",hasMore:false,nextOffset:null};return new Promise((resolve)=>{viewerResolve=resolve;});},onSessionError:(error)=>{throw error;}});
const target={revision:12,nodeId:20,spanStart:0,spanEnd:30,scopeId:null,scopeLabel:"Document",pathSegments:["$","message"],pathTruncated:false};
await viewer.open(target);await settle();
element("raw-copy").click();element("raw-copy").click();
check(viewerCalls.at(-1)?.command==="copy_node"&&viewerCalls.at(-1).args.nodeId===20&&viewerCalls.at(-1).args.scopeId===null&&viewerCalls.at(-1).args.sessionRevision===12&&viewerCalls.at(-1).args.format==="raw","Content Viewer Raw Lexeme IPC contract or duplicate guard failed");
check(element("raw-copy").disabled,"Content Viewer copy button was not disabled while pending");
viewerResolve();await settle();
check(element("copy-status").textContent==="Copied Raw Lexeme","Content Viewer copy success was not local");
const target2={...target,nodeId:21};
element("decoded-copy").click();
await viewer.open(target2);await settle();
viewerResolve?.();await settle();
check(element("copy-status").textContent!=="Copied Decoded Value","Content Viewer stale target retained old copy success");
viewer.clear(false);
viewerHost.remove();

const nestedHost=document.createElement("div");
nestedHost.innerHTML='<dialog id="dialog"><button id="close">Close</button><span id="title"></span><span id="scope"></span><span id="path"></span><span id="node"></span><span id="span-label"></span><span id="span"></span><span id="semantic"></span><span id="detection"></span><span id="plain"></span><span id="representation"></span><span id="note"></span><span id="range"></span><span id="status"></span><div id="alert"></div><div id="content"></div><button id="raw-copy">Copy Raw Lexeme</button><button id="decoded-copy">Copy Decoded Value</button><button id="markdown-copy">Copy Markdown Source</button><button id="parsed-copy">Copy Parsed JSON</button><span id="copy-status"></span><select id="render-as"><option value="auto">Auto</option></select><button id="markdown-anyway">Anyway</button><button id="previous">Prev</button><button id="next">Next</button><div id="parsed-panel"></div><div id="parsed-tree"></div><div id="nested-nav"></div><ol id="crumb"></ol><div id="reps"></div><button id="parsed-tab"></button><button id="decoded-tab"></button><button id="raw-tab"></button><div id="text-panel"></div></dialog>';
document.body.append(nestedHost);
const n=(id)=>nestedHost.querySelector("#"+id);
const nestedCalls=[];
const nestedViewer=new ContentViewer({elements:{dialog:n("dialog"),close:n("close"),title:n("title"),scope:n("scope"),path:n("path"),node:n("node"),spanLabel:n("span-label"),span:n("span"),semanticType:n("semantic"),detectionSource:n("detection"),plainReason:n("plain"),representation:n("representation"),rendererNote:n("note"),range:n("range"),status:n("status"),alert:n("alert"),content:n("content"),renderAs:n("render-as"),markdownAnyway:n("markdown-anyway"),previous:n("previous"),next:n("next"),copy:{raw:n("raw-copy"),decoded:n("decoded-copy"),markdown:n("markdown-copy"),parsed:n("parsed-copy"),status:n("copy-status")},nested:{navigation:n("nested-nav"),back:n("close"),breadcrumb:n("crumb"),representations:n("reps"),parsedTab:n("parsed-tab"),decodedTab:n("decoded-tab"),rawTab:n("raw-tab"),parsedPanel:n("parsed-panel"),parsedTree:n("parsed-tree"),sharedTextPanel:n("text-panel")}},invoke:async(command,args)=>{nestedCalls.push({command,args});if(command==="get_string_detection")return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};if(command==="open_nested_json")return {scopeId:99,parentScopeId:null,sourceNodeId:30,depth:1,maxDepth:10,parsedBytes:12,cumulativeBytes:12,sessionRevision:13,root:{id:31,kind:"object",spanStart:0,spanEnd:12,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:1}};if(command==="get_children")return {nodes:[{id:32,kind:"number",spanStart:2,spanEnd:4,label:"value",labelHasMore:false,valuePreview:"42",valueHasMore:false,childCount:0}],hasMore:false,nextCursor:null};return {start:0,text:"{ }",hasMore:false,nextOffset:null};},onSessionError:(error)=>{throw error;}});
await nestedViewer.open({revision:13,nodeId:30,spanStart:0,spanEnd:40,scopeId:null,scopeLabel:"Document",pathSegments:["$","payload"],pathTruncated:false});await settle();
const nestedRootDisclosure=nestedHost.querySelector('[data-node-id="31"] .tree-disclosure');
nestedRootDisclosure.click();await settle();
const nestedChild=nestedHost.querySelector('[data-node-id="32"]');
check(nestedChild!==null,"Nested Parsed tree did not load its child");
nestedChild.click();
const nestedDecodedCopy=Array.from(nestedHost.querySelectorAll(".nested-copy-actions button")).find((button)=>button.textContent==="Copy Decoded Value");
nestedDecodedCopy.click();await settle();
const nestedNodeCopy=nestedCalls.at(-1);
check(nestedNodeCopy?.command==="copy_node"&&nestedNodeCopy.args.nodeId===32&&nestedNodeCopy.args.scopeId===99&&nestedNodeCopy.args.sessionRevision===13&&nestedNodeCopy.args.format==="decoded","Nested Tree scalar copy did not target the active nested scope");
n("parsed-copy").click();await settle();
const parsedCopy=nestedCalls.at(-1);
check(parsedCopy?.command==="copy_node"&&parsedCopy.args.nodeId===31&&parsedCopy.args.scopeId===99&&parsedCopy.args.sessionRevision===13&&parsedCopy.args.format==="parsed","Nested Parsed copy did not target nested scope root");
nestedHost.remove();

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
  await browser(["open", `http://127.0.0.1:${port}/`]);
  const output = await browser(["eval", "-b", Buffer.from(browserTest()).toString("base64")]);
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch {
    const start = output.lastIndexOf("{");
    if (start < 0) throw new Error(`Browser returned non-JSON output: ${output}`);
    result = JSON.parse(output.slice(start));
  }
  if (!result.pass) throw new Error("Copy UI browser test did not pass.");
  console.log(`copy-ui PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
