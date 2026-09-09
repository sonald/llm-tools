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
const session = `sjv-string-metrics-${process.pid}`;

async function freePort() {
  const probe = createServer();
  await new Promise((resolveResult, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolveResult); });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise((resolveResult) => probe.close(resolveResult));
  return address.port;
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
  try {
    const result = await execFileAsync("agent-browser", ["--session", session, ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const detail = [error?.stderr, error?.stdout].filter((value) => typeof value === "string" && value.trim()).join("\n").trim();
    throw new Error(`agent-browser ${args[0] ?? "command"} failed${detail ? `: ${detail.slice(-4000)}` : ""}`);
  }
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
let assertions=0;const check=(value,message)=>{assertions+=1;if(!value)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const makeViewer=(invoke,onSessionError=()=>{})=>{const host=document.createElement("div");host.innerHTML='<dialog id="dialog"><button id="close">Close</button><h1 id="title"></h1><div class="content-viewer-meta"><dl><div><dt>Scope</dt><dd id="scope"></dd></div></dl></div><div id="path"></div><div id="node"></div><div id="span-label"></div><div id="span"></div><div id="semantic"></div><div id="detection"></div><div id="plain"></div><div id="representation"></div><div id="note"></div><div id="range"></div><div id="status"></div><div id="alert"></div><div id="tabs"><button id="rendered">Rendered</button><button id="decoded">Decoded</button><button id="raw">Raw</button></div><select id="render-as"><option value="auto">Auto</option><option value="plainText">Plain Text</option></select><div id="content"></div><button id="previous">Previous</button><button id="next">Next</button></dialog>';document.body.append(host);const q=(id)=>host.querySelector("#"+id);const elements={dialog:q("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next"),renderAs:q("render-as"),string:{representations:q("tabs"),renderedTab:q("rendered"),decodedTab:q("decoded"),rawTab:q("raw")}};return {host,elements,viewer:new ContentViewer({elements,invoke,onSessionError})};};
const makeNestedViewer=(invoke,onSessionError=()=>{})=>{
  const host=document.createElement("div");
  host.innerHTML='<dialog id="dialog"><button id="close">Close</button><h1 id="title"></h1><div id="scope"></div><div id="path"></div><div id="node"></div><div id="span-label"></div><div id="span"></div><div id="semantic"></div><div id="detection"></div><div id="plain"></div><div id="representation"></div><div id="note"></div><div id="range"></div><div id="status"></div><div id="alert"></div><div id="tabs"><button id="rendered">Rendered</button><button id="decoded">Decoded</button><button id="raw">Raw</button></div><div id="nested-nav"><button id="back">Back</button><ol id="crumb"></ol></div><div id="nested-tabs"><button id="parsed">Parsed</button><button id="nested-decoded">Decoded String</button><button id="nested-raw">Raw Lexeme</button></div><section id="parsed-panel"><div id="parsed-tree"></div></section><div id="text-panel"></div><form id="search"><input id="query"><input id="decoded-radio" type="radio" checked><input id="raw-radio" type="radio"><button id="submit">Search</button><p id="description"></p></form><div id="results-panel"><div id="search-status"></div><div id="results"></div><button id="prev">Previous</button><button id="next-search">Next</button></div><div id="content"></div><button id="previous">Previous</button><button id="next">Next</button></dialog>';
  document.body.append(host);const q=(id)=>host.querySelector("#"+id);
  const elements={dialog:q("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next"),string:{representations:q("tabs"),renderedTab:q("rendered"),decodedTab:q("decoded"),rawTab:q("raw")},nested:{navigation:q("nested-nav"),back:q("back"),breadcrumb:q("crumb"),representations:q("nested-tabs"),parsedTab:q("parsed"),decodedTab:q("nested-decoded"),rawTab:q("nested-raw"),parsedPanel:q("parsed-panel"),parsedTree:q("parsed-tree"),sharedTextPanel:q("text-panel")},search:{form:q("search"),query:q("query"),decoded:q("decoded-radio"),rawSource:q("raw-radio"),submit:q("submit"),description:q("description"),panel:q("search"),resultsPanel:q("results-panel"),status:q("search-status"),results:q("results"),previous:q("prev"),next:q("next-search")}};
  return {host,elements,viewer:new ContentViewer({elements,invoke,onSessionError})};
};
const metricValues=(viewer)=>{const host=viewer.host??viewer.elements?.scope?.parentElement??document;return Object.fromEntries(["decoded-bytes","characters","lines"].map((key)=>[key,host.querySelector('[data-metric="'+key+'"]')?.textContent]));};
const target=(revision,nodeId,text,scopeId=null)=>({revision,nodeId,spanStart:37,spanEnd:37+new TextEncoder().encode(text).byteLength,scopeId,scopeLabel:scopeId===null?"Document root":"Nested",pathSegments:["$","value"],pathTruncated:false});
const openWith=(text,metrics,revision=1,nodeId=1)=>{const calls=[];const viewer=makeViewer(async(command,args)=>{calls.push({command,args});if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};if(command==="get_string_metrics")return metrics;if(command==="read_decoded_text")return {start:args.offset,text:text.slice(args.offset,args.offset+131072),hasMore:false,nextOffset:null};if(command==="read_raw_slice")return {start:args.sourceStart,text:"\\\"hello\\\"",hasMore:false,nextOffset:null};throw new Error("unexpected metrics command "+command);});return {calls,viewer,target:target(revision,nodeId,text)};};
const ascii=openWith("hello",{decodedBytes:5,characterCount:5,lineCount:1});await ascii.viewer.viewer.open(ascii.target);await settle();check(JSON.stringify(metricValues(ascii.viewer))===JSON.stringify({"decoded-bytes":"5",characters:"5",lines:"1"}),"ASCII metrics were not rendered");check(ascii.calls.filter((call)=>call.command==="get_string_metrics").length===1,"initial metrics request count was not one");ascii.viewer.elements.string.decodedTab.click();await settle();ascii.viewer.elements.string.rawTab.click();await settle();ascii.viewer.elements.string.renderedTab.click();await settle();ascii.viewer.elements.renderAs.value="plainText";ascii.viewer.elements.renderAs.dispatchEvent(new Event("change"));await settle();check(ascii.viewer.elements.representation.textContent==="Plain Text","Render As did not apply the valid Plain Text override");check(ascii.calls.filter((call)=>call.command==="get_string_metrics").length===1,"tab/Render As repeated metrics");ascii.viewer.viewer.clear(false);ascii.viewer.host.remove();
const unicode=openWith("你😀é",{decodedBytes:10,characterCount:4,lineCount:1},2,2);await unicode.viewer.viewer.open(unicode.target);await settle();check(JSON.stringify(metricValues(unicode.viewer))===JSON.stringify({"decoded-bytes":"10",characters:"4",lines:"1"}),"Unicode scalar metrics were not rendered");unicode.viewer.viewer.clear(false);unicode.viewer.host.remove();
const special=openWith("a\\r\\nb\\rc\\n",{decodedBytes:7,characterCount:7,lineCount:4},3,3);await special.viewer.viewer.open(special.target);await settle();check(metricValues(special.viewer).lines==="4","CRLF/CR/trailing line metrics were not rendered");special.viewer.viewer.clear(false);special.viewer.host.remove();
const empty=openWith("",{decodedBytes:0,characterCount:0,lineCount:1},4,4);await empty.viewer.viewer.open(empty.target);await settle();check(JSON.stringify(metricValues(empty.viewer))===JSON.stringify({"decoded-bytes":"0",characters:"0",lines:"1"}),"empty metrics were not rendered");empty.viewer.viewer.clear(false);empty.viewer.host.remove();
const largeText="x".repeat(200000);const large=openWith(largeText,{decodedBytes:200000,characterCount:200000,lineCount:1},5,5);await large.viewer.viewer.open(large.target);await settle();check(metricValues(large.viewer)["decoded-bytes"]==="200000"&&large.calls.some((call)=>call.command==="get_string_metrics"&&call.args.nodeId===5),"large complete metrics were not requested independently of the text window");large.viewer.viewer.clear(false);large.viewer.host.remove();
const deferred=[];const switched=makeViewer(async(command,args)=>{if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};if(command==="read_decoded_text")return {start:0,text:"target",hasMore:false,nextOffset:null};if(command==="get_string_metrics")return new Promise((resolve)=>deferred.push({args,resolve}));throw new Error("unexpected deferred command");});const firstTarget=target(6,20,"target");const firstOpen=switched.viewer.open(firstTarget);await Promise.resolve();check(metricValues(switched).characters==="Loading…","pending metrics did not show Loading");switched.viewer.clear(false);const secondOpen=switched.viewer.open(target(7,21,"target"));await Promise.all([firstOpen,secondOpen]);await Promise.resolve();check(deferred.length===2&&deferred[0].args.nodeId===20&&deferred[1].args.nodeId===21&&deferred[1].args.sessionRevision===7,"target switch metrics args were not identity-bound");switched.elements.renderAs.value="plainText";switched.elements.renderAs.dispatchEvent(new Event("change"));await settle();check(deferred.length===2,"pending metrics were duplicated by Render As");deferred[0].resolve({decodedBytes:1,characterCount:1,lineCount:1});deferred[1].resolve({decodedBytes:6,characterCount:6,lineCount:1});await settle();check(metricValues(switched).characters==="6"&&switched.viewer.isOpen,"late metrics response overwrote current target");switched.viewer.clear(false);await settle();check(switched.host.querySelector(".content-viewer-string-metrics")?.hidden===true,"close did not hide metrics");switched.host.remove();
const bad=makeViewer(async(command)=>{if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};if(command==="get_string_metrics")return {decodedBytes:0,characterCount:0,lineCount:0};if(command==="read_decoded_text")return {start:0,text:"visible",hasMore:false,nextOffset:null};throw new Error("unexpected invalid command");});await bad.viewer.open(target(8,30,"visible"));await settle();check(metricValues(bad).characters==="Unavailable"&&metricValues(bad).lines==="Unavailable"&&bad.elements.content.textContent==="visible","invalid zero-line DTO did not stay unavailable without breaking content");bad.viewer.clear(false);bad.host.remove();
const globalErrors=[];const global=makeViewer(async(command)=>{if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};if(command==="get_string_metrics")throw {code:"file_changed",message:"file changed"};if(command==="read_decoded_text")return {start:0,text:"visible",hasMore:false,nextOffset:null};throw new Error("unexpected global command");},(error)=>globalErrors.push(error));await global.viewer.open(target(8,31,"visible"));await settle();check(globalErrors.length===1&&!global.viewer.isOpen,"global metrics failure did not invalidate the Content Viewer session");global.host.remove();
const nestedCalls=[];
const nested=makeNestedViewer(async(command,args)=>{
  nestedCalls.push({command,args});
  if(command==="get_string_detection") return args.nodeId===77
    ? {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"}
    : {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json") return {scopeId:44,parentScopeId:null,sourceNodeId:20,depth:1,maxDepth:10,parsedBytes:100,cumulativeBytes:100,sessionRevision:9,root:{id:20,kind:"object",spanStart:0,spanEnd:100,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:1}};
  if(command==="get_children") return {nodes:[{id:77,kind:"string",spanStart:10,spanEnd:20,label:"nested",labelHasMore:false,valuePreview:"nested",valueHasMore:false,childCount:0}],hasMore:false,nextCursor:null};
  if(command==="get_string_metrics") return {decodedBytes:12,characterCount:7,lineCount:2};
  if(command==="read_decoded_text") return {start:0,text:"nested",hasMore:false,nextOffset:null};
  if(command==="close_nested_scope") return null;
  throw new Error("unexpected nested command "+command);
});
await nested.viewer.open(target(9,20,"source"));
await settle();
const rootItem=nested.host.querySelector('[data-node-id="20"]');
check(rootItem!==null,"real nested open did not materialize its root Tree node");
rootItem.querySelector(".tree-disclosure")?.dispatchEvent(new MouseEvent("click",{bubbles:true}));
await settle();
const childItem=nested.host.querySelector('[data-node-id="77"]');
check(childItem!==null,"real nested navigation did not load the child string node");
childItem.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));
await settle();
check(nestedCalls.some((call)=>call.command==="get_string_metrics"&&call.args.scopeId===44&&call.args.nodeId===77&&call.args.sessionRevision===9),"nested metrics did not use the real nested child scope identity; calls="+JSON.stringify(nestedCalls));
check(metricValues(nested).characters==="7","nested child metrics were not rendered");
nested.viewer.clear(false);
nested.host.remove();
return {pass:true,assertions};
})()`;
}

const port=await freePort();
const vite=spawn(process.execPath,[viteBin,"--host","127.0.0.1","--port",String(port)],{cwd:root,stdio:["ignore","pipe","pipe"]});
let viteOutput="";vite.stdout.on("data",(chunk)=>{viteOutput+=chunk.toString();});vite.stderr.on("data",(chunk)=>{viteOutput+=chunk.toString();});
try {await waitForPort(port,vite);await browser(["open",`http://127.0.0.1:${port}/`]);const result=parseBrowserValue(await browser(["eval","-b",Buffer.from(browserTest()).toString("base64")]));if(!result.pass)throw new Error("String metrics browser test did not pass.");console.log(`string-metrics-ui PASS (${result.assertions} assertions)`);}catch(error){throw new Error(`${error instanceof Error?error.message:String(error)}\n${viteOutput.slice(-4000)}`);}finally{await browser(["close"]).catch(()=>{});vite.kill("SIGTERM");}
