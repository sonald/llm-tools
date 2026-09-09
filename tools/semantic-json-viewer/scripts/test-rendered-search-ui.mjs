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
const session = `sjv-rendered-search-${process.pid}`;

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
  try {
    const result = await execFileAsync("agent-browser", ["--session", session, ...args], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = [error?.stderr, error?.stdout].filter((value) => typeof value === "string" && value.trim()).join("\n").trim();
    throw new Error(`agent-browser ${args[0] ?? "command"} failed${detail ? `: ${detail.slice(-4000)}` : ""}`);
  }
}

function parseBrowserValue(output) {
  try {
    return JSON.parse(output);
  } catch {
    const start = output.lastIndexOf("{");
    if (start >= 0) return JSON.parse(output.slice(start));
    throw new Error(`Browser returned non-JSON output: ${output}`);
  }
}

function browserTest() {
  return `(async () => {
const {RenderedSearch,projectRenderedText}=await import("/src/rendered-search.ts");
const {renderSafeMarkdown}=await import("/src/markdown-renderer.ts");
const {renderCode,renderPlainCodePage}=await import("/src/code-renderer.ts");
const {ContentViewer}=await import("/src/content-viewer.ts");
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const makeSearch=({invoke=async()=>({matches:[],hasMore:false,nextCursor:null}),onReveal=()=>{},onError=()=>{}}={})=>{
  const host=document.createElement("div");
  host.innerHTML='<section id="panel"><form id="form" role="search"><label>Query <input id="query" type="search"></label><fieldset><label><input id="decoded" type="radio" name="representation" checked>Decoded</label><label><input id="raw" type="radio" name="representation">Raw</label></fieldset><button id="submit" type="submit">Search</button><p id="description"></p></form><div id="results-panel"><div id="status"></div><div id="results"></div><button id="previous" type="button">Previous</button><button id="next" type="button">Next</button></div></section>';
  document.body.append(host);
  const q=(id)=>{const element=id==="dialog"?host.querySelector("dialog"):host.querySelector("#"+id);if(id==="content"&&element)element.className="content-viewer-content";return element;};
  const elements={form:q("form"),query:q("query"),decoded:q("decoded"),rawSource:q("raw"),submit:q("submit"),description:q("description"),panel:q("panel"),resultsPanel:q("results-panel"),status:q("status"),results:q("results"),previous:q("previous"),next:q("next")};
  check(Object.entries(elements).every(([,element])=>element!==null),"Rendered test search fixture missing element: "+Object.entries(elements).filter(([,element])=>element===null).map(([id])=>id).join(","));
  const view=new RenderedSearch({...elements,invoke,onReveal,onError,onIntentChange:()=>{}});
  return {host,elements,view};
};

const markdown=document.createElement("div");
const markdownFragment=renderSafeMarkdown("[link](https://example.test/x) **你**好  \\nnext\\n\\n| A | B |\\n|---|---|\\n| cell | value |\\n\\n    a  b\\n\\nvisible \\u00a0  space\\n\\n![alt](https://img.example.test/a.png)");
check(markdownFragment!==null,"safe Markdown fixture did not render");
markdown.append(markdownFragment);
const hidden=document.createElement("span");
hidden.setAttribute("aria-hidden","true");
hidden.textContent="hidden-source";
markdown.append(hidden);
document.body.append(markdown);
const projection=await projectRenderedText(markdown);
check(projection.text.includes("https://example.test/x"),"Rendered Markdown projection dropped visible link URL");
check(projection.text.includes("https://img.example.test/a.png"),"Rendered Markdown projection dropped visible image URL");
check(projection.text.includes("你好"),"Rendered Markdown projection split inline emphasis text");
check(!projection.text.includes("hidden-source"),"Rendered Markdown projection included aria-hidden source text");
check(projection.text.includes("a  b"),"Rendered Markdown projection collapsed pre/code whitespace");
check(projection.text.includes("cell\\nvalue"),"Rendered Markdown table cells did not get block boundaries");
check(projection.text.includes("\\u00a0")&&!projection.text.includes("visible   space"),"Rendered Markdown projection collapsed NBSP whitespace");
const rootPre=document.createElement("pre");
rootPre.textContent="a  b";
document.body.append(rootPre);
check((await projectRenderedText(rootPre)).text==="a  b","Rendered projection did not preserve whitespace when the root itself was PRE");
rootPre.remove();
const inlineCode=document.createElement("div");
inlineCode.className="content-viewer-content is-markdown";
inlineCode.innerHTML="<p><code>a  b</code></p>";
document.body.append(inlineCode);
check((await projectRenderedText(inlineCode)).text.includes("a b")&&!((await projectRenderedText(inlineCode)).text.includes("a  b")),"Rendered projection forced PRE whitespace on Markdown inline CODE despite its computed CSS");
inlineCode.remove();
const trailingBlocks=document.createElement("div");
trailingBlocks.className="content-viewer-content is-markdown";
trailingBlocks.innerHTML="<p>a </p><p>b</p>";
document.body.append(trailingBlocks);
check((await projectRenderedText(trailingBlocks)).text==="a\\nb","Rendered block boundary retained a trailing collapsed space before the next paragraph");
trailingBlocks.remove();
const inlineSpaces=document.createElement("div");
for(const value of ["a"," "," ","b"]){const span=document.createElement("span");span.textContent=value;inlineSpaces.append(span);}
const inlineSpaceProjection=await projectRenderedText(inlineSpaces);
check(inlineSpaceProjection.text==="a b","Rendered projection did not collapse whitespace across inline nodes");
const worstWhitespace=document.createElement("div");
worstWhitespace.textContent="x ".repeat(1_048_576)+"x";
const worstProjection=await projectRenderedText(worstWhitespace);
check(worstProjection.text.length===worstWhitespace.textContent.length&&worstProjection.segments.length<1000,"2 MiB alternating whitespace projection exceeded the bounded text-segment representation; text="+worstProjection.text.length+" source="+worstWhitespace.textContent.length+" segments="+worstProjection.segments.length);
const projectionAbort=new AbortController();
const cancelledProjection=projectRenderedText(worstWhitespace,{signal:projectionAbort.signal});
projectionAbort.abort();
let projectionWasCancelled=false;
try { await cancelledProjection; } catch { projectionWasCancelled=true; }
check(projectionWasCancelled,"Rendered projection did not cancel a stale segmented execution");
const midProjectionAbort=new AbortController();
const midProjection=projectRenderedText(worstWhitespace,{signal:midProjectionAbort.signal});
setTimeout(()=>midProjectionAbort.abort(),0);
let midProjectionWasCancelled=false;
try { await midProjection; } catch { midProjectionWasCancelled=true; }
check(midProjectionWasCancelled,"Rendered projection did not yield often enough for mid-flight cancellation");
const originalMarkdown=markdown.innerHTML;
const rendered=makeSearch();
rendered.view.activateDom(null,markdown,"Search the visible rendered text.");
await settle();
const originalStrongText=markdown.querySelector("strong")?.firstChild;
rendered.elements.query.value="你好";
rendered.elements.form.requestSubmit();
await settle();
check(rendered.elements.results.querySelectorAll("button").length===1,"Rendered Markdown search did not find cross-inline text");
rendered.elements.results.querySelector("button").click();
check(markdown.querySelector("mark[data-rendered-search]")!==null&&markdown.querySelector("strong")!==null&&markdown.querySelector("table")!==null,"Rendered Markdown highlight damaged emphasis/table DOM");
check(Array.from(markdown.querySelectorAll("mark[data-rendered-search]")).map((mark)=>mark.textContent).join("")==="你好","Cross-inline Rendered highlight did not preserve the complete match text");
rendered.elements.results.querySelector("button").click();
check(Array.from(markdown.querySelectorAll("mark[data-rendered-search]")).map((mark)=>mark.textContent).join("")==="你好"&&Array.from(markdown.querySelectorAll("mark[data-rendered-search]")).some((mark)=>mark.firstChild===originalStrongText),"Repeatedly clicking the same Rendered result did not restore the original Text node before re-highlighting");
rendered.elements.query.value="https://example.test/x";
rendered.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
rendered.elements.form.requestSubmit();
await settle();
check(rendered.elements.results.querySelectorAll("button").length===1,"Rendered Markdown search did not find visible link URL after input invalidation");
rendered.elements.query.value="cell\\nvalue";
rendered.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
rendered.elements.form.requestSubmit();
await settle();
check(rendered.elements.results.querySelectorAll("button").length===0,"Rendered search incorrectly matched across a table block boundary");
rendered.elements.query.value="cell";
rendered.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
rendered.elements.form.requestSubmit();
await settle();
rendered.elements.results.querySelector("button").click();
rendered.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
check(markdown.querySelector("strong")!==null&&markdown.querySelector("table")!==null,"Rendered input invalidation removed source structure");
check(markdown.innerHTML===originalMarkdown,"Rendered highlight clear did not preserve the original Markdown DOM");

const sameText=document.createElement("div");
sameText.textContent="one two";
document.body.append(sameText);
const sameTextSearch=makeSearch();
sameTextSearch.view.activateDom(null,sameText,"Search repeated Text-node matches.");
await settle();
sameTextSearch.elements.query.value="one";
sameTextSearch.elements.form.requestSubmit();
await settle();
const originalSameText=sameText.firstChild;
sameTextSearch.elements.results.querySelector("button").click();
sameTextSearch.elements.results.querySelector("button").click();
check(sameText.querySelector("mark[data-rendered-search]")?.textContent==="one"&&sameText.querySelector("mark[data-rendered-search]")?.firstChild===originalSameText,"Repeatedly clicking a single Text-node result did not preserve its original Text node");
sameTextSearch.elements.query.value="two";
sameTextSearch.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
sameTextSearch.elements.form.requestSubmit();
await settle();
sameTextSearch.elements.results.querySelector("button").click();
check(sameText.querySelector("mark[data-rendered-search]")?.textContent==="two","Different results on the same Text node did not re-highlight the new range");
sameTextSearch.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
check(sameText.innerHTML==="one two","Clearing repeated Text-node highlights did not restore equivalent DOM content");
sameTextSearch.host.remove();

const many=document.createElement("div");
many.textContent=Array.from({length:57},()=>"x").join(" ");
document.body.append(many);
const manySearch=makeSearch();
manySearch.view.activate("dom",null,await projectRenderedText(many),"Search many visible matches.");
manySearch.elements.query.value="x";
manySearch.elements.form.requestSubmit();
await settle();
check(manySearch.elements.results.querySelectorAll("button").length===50&&manySearch.elements.next.disabled===false,"Rendered DOM search silently truncated results beyond 50");
manySearch.elements.next.click();
check(manySearch.elements.results.querySelectorAll("button").length===7&&manySearch.elements.previous.disabled===false,"Rendered DOM Next did not continue from its bounded cursor");
manySearch.elements.previous.click();
check(manySearch.elements.results.querySelectorAll("button").length===50,"Rendered DOM Previous did not restore the first result page");

const code=document.createElement("div");
code.append(renderCode("const value = \\"你好\\";","javascript").fragment);
document.body.append(code);
const codeSearch=makeSearch();
codeSearch.view.activate("dom",null,await projectRenderedText(code),"Search visible code.");
codeSearch.elements.query.value="你好";
codeSearch.elements.form.requestSubmit();
await settle();
codeSearch.elements.results.querySelector("button").click();
check(code.querySelector(".sjv-code-gutter")!==null&&code.querySelector(".sjv-code-source")!==null&&code.querySelector("mark[data-rendered-search]")!==null,"Rendered Code search removed gutter or Prism token DOM");
const codeAfterHighlight=code.innerHTML;
codeSearch.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
check(code.querySelector(".sjv-code-gutter")!==null&&code.querySelector(".sjv-code-source")!==null&&code.innerHTML===codeAfterHighlight.replaceAll('<mark data-rendered-search="true">你好</mark>','你好'),"Rendered Code highlight invalidation changed token structure");
const plainPage=renderPlainCodePage("one\\r\\ntwo",null,"sizeLimit",{line:4,previousWasCR:false}).fragment;
check(plainPage.querySelector(".sjv-code-gutter")?.textContent?.startsWith("4"),"large-code renderer did not preserve absolute line state");

const backendCalls=[];
const backendReveal=[];
const backend=makeSearch({invoke:async(command,args)=>{
  backendCalls.push({command,args});
  return {matches:[{nodeId:10,field:"value",pathSegments:["$","message"],pathTruncated:false,sourceSpanStart:37,sourceSpanEnd:1000,matchStart:5,matchEnd:11}],hasMore:false,nextCursor:null};
},onReveal:(match)=>backendReveal.push(match)});
backend.view.activate("backend",{nodeId:10,scopeId:null,sessionRevision:3,scopeStart:37,scopeEnd:1000},null,"Search visible decoded values.");
backend.elements.query.value="needle";
backend.elements.form.requestSubmit();
await settle();
check(backendCalls[0]?.args.representation==="decoded"&&backendCalls[0].args.nodeId===10&&backendCalls[0].args.limit===50&&backendCalls[0].args.sessionRevision===3,"Rendered backend search did not use the bounded decoded value request");
backend.elements.results.querySelector("button").click();
check(backendReveal.length===1&&backendReveal[0].backend.field==="value","Rendered backend result did not reveal the decoded value");
const abaCalls=[];
const aba=makeSearch({invoke:async(command,args)=>new Promise((resolve)=>abaCalls.push({command,args,resolve}))});
aba.view.activate("backend",{nodeId:10,scopeId:null,sessionRevision:3,scopeStart:37,scopeEnd:1000},null,"Search visible decoded values.");
const validAbaPage=(query)=>({matches:[{nodeId:10,field:"value",pathSegments:["$","message"],pathTruncated:false,sourceSpanStart:37,sourceSpanEnd:1000,matchStart:5,matchEnd:5+new TextEncoder().encode(query).byteLength}],hasMore:false,nextCursor:null});
aba.elements.query.value="A";
aba.elements.form.requestSubmit();
await Promise.resolve();
aba.elements.query.value="B";
aba.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
aba.elements.form.requestSubmit();
await Promise.resolve();
aba.elements.query.value="A";
aba.elements.query.dispatchEvent(new Event("input",{bubbles:true}));
aba.elements.form.requestSubmit();
await Promise.resolve();
check(abaCalls.length===3,"Rendered backend query ABA did not create three independent requests");
abaCalls[0].resolve(validAbaPage("A"));
await settle();
check(aba.elements.results.children.length===0,"Rendered backend accepted the first stale A response after query ABA");
abaCalls[2].resolve(validAbaPage("A"));
await settle();
check(aba.elements.results.children.length===1,"Rendered backend did not accept the latest A response after query ABA");
const globalErrors=[];
const global=makeSearch({invoke:async()=>{throw {code:"file_changed",message:"file changed"};},onError:(error)=>globalErrors.push(error)});
global.view.activate("backend",{nodeId:10,scopeId:null,sessionRevision:3,scopeStart:37,scopeEnd:1000},null,"Search visible decoded values.");
global.elements.query.value="needle";
global.elements.form.requestSubmit();
await settle();
check(globalErrors.length===1&&global.elements.status.getAttribute("role")==="alert","Rendered global file_changed error was not routed to the session handler");

const makeContentViewer=invoke=>{
  const host=document.createElement("div");
  host.innerHTML='<dialog><button id="close" type="button">Close</button><h1 id="title"></h1><div id="scope"></div><div id="path"></div><div id="node"></div><div id="span-label"></div><div id="span"></div><div id="semantic"></div><div id="detection"></div><div id="plain"></div><div id="representation"></div><div id="note"></div><div id="range"></div><div id="status"></div><div id="alert"></div><div id="tabs"><button id="rendered" type="button">Rendered</button><button id="decoded" type="button">Decoded</button><button id="raw" type="button">Raw</button></div><form id="search" role="search"><input id="query" type="search"><input id="search-decoded" type="radio" name="rep" checked><input id="search-raw" type="radio" name="rep"><button id="submit" type="submit">Search</button><p id="description"></p></form><div id="results-panel"><div id="search-status"></div><div id="results"></div><button id="prev" type="button">Previous</button><button id="next" type="button">Next</button></div><div id="content"></div><button id="previous" type="button">Previous page</button><button id="next-page" type="button">Next page</button></dialog>';
  document.body.append(host);
  const q=(id)=>{const element=id==="dialog"?host.querySelector("dialog"):host.querySelector("#"+id);if(id==="content"&&element)element.className="content-viewer-content";return element;};
  const elements={dialog:q("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next-page"),string:{representations:q("tabs"),renderedTab:q("rendered"),decodedTab:q("decoded"),rawTab:q("raw")},search:{form:q("search"),query:q("query"),decoded:q("search-decoded"),rawSource:q("search-raw"),submit:q("submit"),description:q("description"),panel:q("search"),resultsPanel:q("results-panel"),status:q("search-status"),results:q("results"),previous:q("prev"),next:q("next")}};
  check(Object.entries(elements).filter(([,element])=>element===null).length===0,"Content Viewer fixture missing required element: "+Object.entries(elements).filter(([,element])=>element===null).map(([id])=>id).join(","));
  check(Object.entries(elements.string).every(([,element])=>element!==null),"Content Viewer fixture missing string element: "+Object.entries(elements.string).filter(([,element])=>element===null).map(([id])=>id).join(","));
  return {host,elements,viewer:new ContentViewer({elements,invoke,onSessionError:()=>{}})};
};

const plainSource="prefix  \\r\\n  needle 😀  \\r\\n"+"x".repeat(200000);
const plainMatchOffset=new TextEncoder().encode("prefix  \\r\\n  ").byteLength;
const plainByteLength=new TextEncoder().encode(plainSource).byteLength;
const sliceByUtf8=(source,start,length)=>{
  let byteOffset=0;
  let result="";
  for(const character of source){
    const size=new TextEncoder().encode(character).byteLength;
    if(byteOffset<start){byteOffset+=size;continue;}
    if(byteOffset+size-start>length)break;
    result+=character;
    byteOffset+=size;
  }
  return result;
};
const plainCalls=[];
const pendingPlainReads=new Map();
let deferPlainReveal=true;
const plainInvoke=async(command,args)=>{
  plainCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};
  if(command==="search_current") return {matches:[{nodeId:10,field:"value",pathSegments:["$","message"],pathTruncated:false,sourceSpanStart:37,sourceSpanEnd:plainByteLength+37,matchStart:plainMatchOffset,matchEnd:plainMatchOffset+6}],hasMore:false,nextCursor:null};
  if(command!=="read_decoded_text") throw new Error("unexpected plain command "+command);
  const start=args.offset;
  if(start===plainMatchOffset&&deferPlainReveal) return new Promise((resolve)=>pendingPlainReads.set(start,resolve));
  const text=start===plainMatchOffset?"needle 😀  \\r\\n":sliceByUtf8(plainSource,start,args.length);
  const textBytes=new TextEncoder().encode(text).byteLength;
  return {start,text,hasMore:start+textBytes<plainByteLength,nextOffset:start+textBytes<plainByteLength?start+textBytes:null};
};
const plain=makeContentViewer(plainInvoke);
const plainTarget={revision:11,nodeId:10,spanStart:37,spanEnd:plainByteLength+37,scopeId:null,scopeLabel:"Document root",pathSegments:["$"],pathTruncated:false};
await plain.viewer.open(plainTarget);
await settle();
check(plain.elements.content.textContent.includes("  \\r\\n  needle 😀"),"Content Viewer Plain did not preserve CSS pre-wrap spaces, CRLF and emoji in its actual content root");
check(!plain.elements.search.query.disabled&&plain.elements.search.decoded.disabled&&plain.elements.search.rawSource.disabled,"Plain rendered search did not own the active query while source radios were locked");
plain.elements.search.query.value="needle";
plain.elements.search.form.requestSubmit();
await settle();
const plainResult=plain.elements.search.results.querySelector("button");
check(plainResult!==null&&plainCalls.some((call)=>call.command==="search_current"&&call.args.nodeId===10&&call.args.representation==="decoded"),"Content Viewer Plain did not issue its rendered backend search");
plainResult.click();
await Promise.resolve();
check(pendingPlainReads.has(plainMatchOffset),"Rendered Plain result did not create a deferred seek for Escape invalidation");
plain.elements.dialog.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
pendingPlainReads.get(plainMatchOffset)({start:plainMatchOffset,text:"stale",hasMore:false,nextOffset:null});
pendingPlainReads.delete(plainMatchOffset);
await settle();
check(plain.elements.search.resultsPanel.hidden&&plain.elements.content.querySelector("mark[data-rendered-search]")===null,"Rendered Escape did not clear the pending result projection");
deferPlainReveal=false;
plain.elements.search.query.value="needle";
plain.elements.search.query.dispatchEvent(new Event("input",{bubbles:true}));
plain.elements.search.form.requestSubmit();
await settle();
const plainFreshResult=plain.elements.search.results.querySelector("button");
check(plainFreshResult!==null,"Rendered Plain search did not recover after Escape");
plainFreshResult.click();
await settle();
const plainRead=plainCalls.find((call)=>call.command==="read_decoded_text"&&call.args.offset===plainMatchOffset);
check(plainRead!==undefined&&plain.elements.content.textContent.includes("needle")&&plain.elements.content.querySelector("mark[data-rendered-search]")?.textContent==="needle","Content Viewer Plain result did not seek, install and highlight only its rendered match");
plain.elements.string.decodedTab.click();
await settle();
check(plain.elements.search.query.value==="needle"&&!plain.elements.search.query.disabled&&plain.elements.search.decoded.disabled===false,"switching from Rendered to Decoded hid the shared source search or lost its query");
plain.elements.string.renderedTab.click();
await settle();
check(!plain.elements.search.query.disabled&&plain.elements.search.decoded.disabled,"switching back to Rendered did not restore the rendered search owner");
plain.viewer.clear(false);
plain.host.remove();

const codePrefix="x\\r\\n".repeat(366667);
const codeSource=codePrefix+"hit\\r\\n"+"x\\r\\n".repeat(50000);
const codeMatchOffset=codePrefix.length;
const codeCalls=[];
const codeInvoke=async(command,args)=>{
  codeCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  if(command==="search_current") return {matches:[{nodeId:11,field:"value",pathSegments:["$","code"],pathTruncated:false,sourceSpanStart:37,sourceSpanEnd:codeSource.length+37,matchStart:codeMatchOffset,matchEnd:codeMatchOffset+3}],hasMore:false,nextCursor:null};
  if(command!=="read_decoded_text") throw new Error("unexpected code command "+command);
  const start=args.offset;
  const text=codeSource.slice(start,start+args.length);
  return {start,text,hasMore:start+text.length<codeSource.length,nextOffset:start+text.length<codeSource.length?start+text.length:null};
};
const codeViewer=makeContentViewer(codeInvoke);
const codeTarget={revision:12,nodeId:11,spanStart:37,spanEnd:codeSource.length+37,scopeId:null,scopeLabel:"Document root",pathSegments:["$"],pathTruncated:false};
await codeViewer.viewer.open(codeTarget);
await settle();
check(codeViewer.elements.search.query.disabled===false&&codeViewer.elements.search.decoded.disabled,"large Code rendered search was not enabled with radios locked");
codeViewer.elements.search.query.value="hit";
codeViewer.elements.search.form.requestSubmit();
await settle();
const codeResult=codeViewer.elements.search.results.querySelector("button");
check(codeResult!==null,"large Code rendered backend search did not return its tail match");
codeResult.click();
await settle();
const expectedLine=366668;
check(codeCalls.some((call)=>call.command==="read_decoded_text"&&call.args.offset===codeMatchOffset)&&codeViewer.elements.content.querySelector(".sjv-code-gutter")?.textContent?.startsWith(String(expectedLine)),"large Code rendered reveal did not use checkpointed CRLF line state");
codeViewer.viewer.clear(false);
codeViewer.host.remove();

rendered.host.remove();
manySearch.host.remove();
backend.host.remove();
global.host.remove();
markdown.remove();
many.remove();
code.remove();
return {pass:true,assertions};
})()`;
}

const port = await freePort();
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += chunk.toString(); });
vite.stderr.on("data", (chunk) => { viteOutput += chunk.toString(); });

try {
  await waitForPort(port, vite);
  await browser(["open", `http://127.0.0.1:${port}/`]);
  const output = await browser(["eval", "-b", Buffer.from(browserTest()).toString("base64")]);
  const result = parseBrowserValue(output);
  if (!result.pass) throw new Error("Rendered search browser test did not pass.");
  console.log(`rendered-search-ui PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
