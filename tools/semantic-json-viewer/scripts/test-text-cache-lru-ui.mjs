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
const session = "sjv-text-cache-lru-" + process.pid;

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
let assertions=0;
const check=(value,message)=>{assertions+=1;if(!value)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const makeViewer=(invoke,budget)=>{
  const host=document.createElement("div");
  host.innerHTML='<dialog><button id="close">Close</button><span id="title"></span><span id="scope"></span><span id="path"></span><span id="node"></span><span id="span-label"></span><span id="span"></span><span id="semantic"></span><span id="detection"></span><span id="plain"></span><span id="representation"></span><span id="note"></span><span id="range"></span><span id="status"></span><span id="alert"></span><div id="content"></div><button id="previous">Previous</button><button id="next">Next</button><select id="render-as"><option value="auto">Auto</option><option value="nestedJson">Nested JSON</option><option value="html">HTML</option></select><button id="markdown-anyway">Render Markdown Anyway</button><div id="string-tabs"><button id="rendered">Rendered</button><button id="decoded">Decoded Source</button><button id="raw">Raw Lexeme</button></div><div id="nested-nav"><button id="back">Back</button><ol id="crumb"></ol></div><div id="nested-tabs"><button id="parsed">Parsed</button><button id="nested-decoded">Decoded String</button><button id="nested-raw">Raw Lexeme</button></div><section id="parsed-panel"><div id="parsed-tree"></div></section><div id="text-panel"></div>';
  document.body.append(host);
  const q=(id)=>id==="dialog"?host.querySelector("dialog"):host.querySelector("#"+id);
  const elements={dialog:q("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next"),renderAs:q("render-as"),string:{representations:q("string-tabs"),renderedTab:q("rendered"),decodedTab:q("decoded"),rawTab:q("raw")},nested:{navigation:q("nested-nav"),back:q("back"),breadcrumb:q("crumb"),representations:q("nested-tabs"),parsedTab:q("parsed"),decodedTab:q("nested-decoded"),rawTab:q("nested-raw"),parsedPanel:q("parsed-panel"),parsedTree:q("parsed-tree"),sharedTextPanel:q("text-panel")}};
  const required=["dialog","close","title","scope","path","node","span-label","span","semantic","detection","plain","representation","note","range","status","alert","content","previous","next","render-as","markdown-anyway","string-tabs","rendered","decoded","raw","nested-nav","back","crumb","nested-tabs","parsed","nested-decoded","nested-raw","parsed-panel","parsed-tree","text-panel"];
  for(const id of required)if(!q(id))throw new Error("missing test element "+id);
  return {host,elements,viewer:new ContentViewer({elements,invoke,textCacheBudgetBytes:budget,markdownAnyway:q("markdown-anyway"),onSessionError:(error)=>{throw error;}})};
};
const target={revision:1,nodeId:1,spanStart:100,spanEnd:140,scopeId:null,scopeLabel:"Document root",pathSegments:["$","payload"],pathTruncated:false};
const decodedPages=new Map([[0,"0123456789"],[10,"abcdefghij"],[20,"KLMNOPQRST"],[30,"uvwxyzABCD"]]);
const rawPages=new Map([[0,'0123456789'],[10,"abcdefghij"],[20,"KLMNOPQRST"],[30,"uvwxyzABCD"]]);
const rootResponse=(scopeId)=>({scopeId,parentScopeId:null,sourceNodeId:1,depth:1,maxDepth:5,parsedBytes:40,cumulativeBytes:40,sessionRevision:1,root:{id:scopeId+100,kind:"object",spanStart:0,spanEnd:40,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0}});
const makeInvoke=(calls,scopeId)=>async(command,args)=>{
  calls.push({command,args});
  if(command==="get_string_detection")return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json")return rootResponse(scopeId);
  if(command==="close_nested_scope")return null;
  if(command==="read_decoded_text"){const text=decodedPages.get(args.offset);if(text===undefined)throw new Error("unexpected decoded offset "+args.offset);const next=args.offset+10;return {start:args.offset,text,hasMore:next<40,nextOffset:next<40?next:null};}
  if(command==="read_raw_slice"){const offset=args.sourceStart-100;const text=rawPages.get(offset);if(text===undefined)throw new Error("unexpected raw offset "+offset);const next=offset+10;return {start:args.sourceStart,text,hasMore:next<40,nextOffset:next<40?args.sourceStart+10:null};}
  throw new Error("unexpected command "+command);
};
const cacheStats=(viewer,budget)=>{
  const instance=viewer.viewer;
  const frame=instance.nestedFrames.at(-1);
  const representation=instance.nestedRepresentation;
  const state=frame&&(representation==="decoded"||representation==="raw")?frame[representation]:null;
  let activeInMap=!state||!state.current||state.pages.get(state.current.start)===state.current;
  if(!state&&instance.nestedRepresentation===null&&(instance.ordinaryRepresentation==="decoded"||instance.ordinaryRepresentation==="rendered"||instance.htmlRepresentation==="source")){
    const offset=instance.offsets[instance.offsetIndex]??0;
    activeInMap=instance.decodedPages.get(offset)?.start===offset;
  }
  return {bytes:instance.textCacheBytes(),recency:instance.textCacheRecency.size,activeInMap,budget};
};

const calls=[];const viewer=makeViewer(makeInvoke(calls,77),300);await viewer.viewer.open(target);await settle();
viewer.elements.nested.decodedTab.click();await settle();
viewer.elements.next.click();await settle();
check(viewer.elements.content.textContent.includes("abcdefghij"),"decoded page 1 was not displayed");
check(cacheStats(viewer,300).bytes<=300&&cacheStats(viewer,300).activeInMap,"active decoded page was not protected/accounted within the budget");
viewer.elements.previous.click();await settle();
check(viewer.elements.content.textContent.includes("0123456789"),"decoded page 0 was not restored before the cross-cache insert");
viewer.elements.nested.rawTab.click();await settle();
check(viewer.elements.content.textContent.includes("0123456789"),"active raw page was not displayed");
viewer.elements.nested.decodedTab.click();await settle();
viewer.elements.next.click();await settle();
const decodedPage1Reads=calls.filter((call)=>call.command==="read_decoded_text"&&call.args.offset===10).length;
check(decodedPage1Reads>=2,"touching decoded page 0 did not make page 1 the LRU victim across decoded/raw caches");
check(viewer.elements.content.textContent.includes("abcdefghij"),"reloaded decoded page 1 was not displayed after LRU eviction");
check(cacheStats(viewer,300).bytes<=300&&cacheStats(viewer,300).activeInMap,"cross-group LRU left an active chunk outside accounting or over budget");
viewer.viewer.clear(false);await settle();check(!viewer.elements.dialog.open&&viewer.elements.content.textContent==="","close did not clear the active text cache presentation");check(viewer.viewer.textCacheBytes()===0&&viewer.viewer.textCacheRecency.size===0,"close did not release text cache accounting");viewer.host.remove();

const activeCalls=[];const active=makeViewer(makeInvoke(activeCalls,88),160);await active.viewer.open(target);await settle();active.elements.nested.decodedTab.click();await settle();active.elements.next.click();await settle();
check(active.elements.content.textContent.includes("abcdefghij"),"active decoded page disappeared when the budget evicted an older page");
check(cacheStats(active,160).bytes<=160&&cacheStats(active,160).activeInMap,"new active page was evicted from the map or left unaccounted");
active.elements.previous.click();await settle();
check(activeCalls.filter((call)=>call.command==="read_decoded_text"&&call.args.offset===0).length>=2,"evicted decoded page was not re-readable by offset");
active.viewer.clear(false);active.host.remove();

let releaseLate=null;const lateCalls=[];const lateInvoke=async(command,args)=>{
  lateCalls.push({command,args});
  if(command==="get_string_detection")return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json")return rootResponse(99);
  if(command==="close_nested_scope")return null;
  if(command==="read_decoded_text")return new Promise((resolve)=>{releaseLate=()=>resolve({start:args.offset,text:"late-page!",hasMore:false,nextOffset:null});});
  throw new Error("unexpected late command "+command);
};
const late=makeViewer(lateInvoke,300);await late.viewer.open(target);await settle();late.elements.nested.decodedTab.click();await Promise.resolve();check(typeof releaseLate==="function","late text request was not started");late.viewer.clear(false);releaseLate?.();await settle();check(!late.elements.dialog.open&&late.elements.content.textContent===""&&lateCalls.some((call)=>call.command==="close_nested_scope"),"late text response repopulated a closed viewer or scope");late.host.remove();

const plainCalls=[];const plain=makeViewer(async(command,args)=>{plainCalls.push({command,args});if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};if(command==="read_decoded_text")return {start:0,text:"plain-page",hasMore:false,nextOffset:null};throw new Error("unexpected plain command "+command);},160);
await plain.viewer.open(target);await settle();check(plain.elements.content.textContent.includes("plain-page")&&cacheStats(plain,160).bytes<=160&&cacheStats(plain,160).activeInMap,"Plain rendered source page was not protected/accounted under cache pressure");
plain.viewer.cacheRawPage({start:0,text:"hidden-raw",hasMore:false,nextOffset:null,lineState:{line:1,previousWasCR:false}});
check(plain.viewer.decodedPages.has(0)&&plain.viewer.textCacheBytes()<=160,"Plain active decoded page was not preserved when hidden Raw cache pressure was inserted");
plain.viewer.clear(false);plain.host.remove();

const htmlCalls=[];const html=makeViewer(async(command,args)=>{htmlCalls.push({command,args});if(command==="get_string_detection")return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};if(command==="get_html_preview")return {html:null,reason:"renderLimit"};if(command==="read_decoded_text")return {start:0,text:"html-source",hasMore:false,nextOffset:null};throw new Error("unexpected html command "+command);},160);
await html.viewer.open(target);await settle();html.elements.renderAs.value="html";html.elements.renderAs.dispatchEvent(new Event("change"));await settle();check(html.viewer.htmlRepresentation==="source"&&html.elements.content.textContent.includes("html-source")&&cacheStats(html,160).bytes<=160&&cacheStats(html,160).activeInMap,"HTML Source page was not protected/accounted under cache pressure");
html.viewer.cacheRawPage({start:0,text:"hidden-raw",hasMore:false,nextOffset:null,lineState:{line:1,previousWasCR:false}});
check(html.viewer.decodedPages.has(0)&&html.viewer.textCacheBytes()<=160,"HTML active decoded page was not preserved when hidden Raw cache pressure was inserted");
html.viewer.clear(false);html.host.remove();

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
  await browser(["open", "http://127.0.0.1:" + port + "/scripts/test-i18n-fixture.html"]);
  const result = parseBrowserValue(await browser(["eval", "-b", Buffer.from(browserTest()).toString("base64")]));
  if (!result.pass) throw new Error("Text cache LRU browser test did not pass.");
  console.log("text-cache-lru-ui PASS (" + result.assertions + " assertions)");
} catch (error) {
  throw new Error((error instanceof Error ? error.message : String(error)) + "\n" + viteOutput.slice(-4000));
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
