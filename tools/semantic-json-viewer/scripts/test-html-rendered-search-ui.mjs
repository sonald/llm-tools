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
const session = `sjv-html-rendered-${process.pid}`;

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
const {ContentViewer}=await import("/src/content-viewer.ts");
const {projectRenderedText}=await import("/src/rendered-search.ts");
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const safeHtml='<main><p><strong>你</strong>好 &amp; 😀</p><p>a  b</p><div>first<br>second</div><p>foo<wbr>bar</p><pre>pre  b\\nnext</pre><table><tr><td>cell-a</td><td>cell-b</td></tr></table><ol><li>item</li></ol><q>quoted</q>'+Array.from({length:57},()=>'<p>x</p>').join('')+'</main>';
const projectionProbe=document.createElement("div");
projectionProbe.innerHTML=safeHtml;
document.body.append(projectionProbe);
const projectionText=(await projectRenderedText(projectionProbe)).text;
check(projectionText.includes("first\\nsecond")&&projectionText.includes("cell-a\\ncell-b"),"HTML inert projection lost BR/table block boundaries");
projectionProbe.remove();
const detachedTemplate=document.createElement("template");
detachedTemplate.innerHTML="<div><pre>pre  b\\nnext</pre><p>after</p></div>";
const detachedRoot=detachedTemplate.content.firstElementChild;
check(detachedRoot!==null&&!detachedRoot.isConnected,"HTML search projection fixture was not detached from the host document");
check((await projectRenderedText(detachedRoot)).text.includes("pre  b\\nnext"),"detached HTML PRE whitespace was not preserved without live CSS");
const makeViewer=(invoke)=>{
  const host=document.createElement("div");
  host.innerHTML='<dialog id="dialog"><button id="close" type="button">Close</button><h1 id="title"></h1><div id="scope"></div><div id="path"></div><div id="node"></div><div id="span-label"></div><div id="span"></div><div id="semantic"></div><div id="detection"></div><div id="plain"></div><div id="representation"></div><div id="note"></div><div id="range"></div><div id="status"></div><div id="alert"></div><div id="tabs"><button id="rendered" type="button">Rendered</button><button id="decoded" type="button">Decoded</button><button id="raw" type="button">Raw</button></div><div id="html-tabs"><button id="html-preview" type="button">Preview</button><button id="html-source" type="button">Source</button><button id="html-raw" type="button">Raw</button></div><div id="html-panel"><iframe id="html-frame" sandbox="" title="Isolated HTML preview"></iframe></div><form id="search" role="search"><input id="query" type="search"><input id="search-decoded" type="radio" name="rep" checked><input id="search-raw" type="radio" name="rep"><button id="submit" type="submit">Search</button><p id="description"></p></form><div id="results-panel"><div id="search-status"></div><div id="results"></div><button id="prev" type="button">Previous</button><button id="next" type="button">Next</button></div><div id="content"></div><button id="previous" type="button">Previous page</button><button id="next-page" type="button">Next page</button></dialog>';
  document.body.append(host);
  const q=(id)=>host.querySelector("#"+id);
  const elements={dialog:q("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next-page"),html:{representations:q("html-tabs"),previewTab:q("html-preview"),sourceTab:q("html-source"),rawTab:q("html-raw"),previewPanel:q("html-panel"),previewFrame:q("html-frame")},search:{form:q("search"),query:q("query"),decoded:q("search-decoded"),rawSource:q("search-raw"),submit:q("submit"),description:q("description"),panel:q("search"),resultsPanel:q("results-panel"),status:q("search-status"),results:q("results"),previous:q("prev"),next:q("next")}};
  return {host,elements,viewer:new ContentViewer({elements,invoke,onSessionError:()=>{}})};
};
const calls=[];
const invoke=async(command,args)=>{
  calls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") return {html:safeHtml,reason:null};
  if(command==="read_decoded_text") return {start:args.offset,text:safeHtml,hasMore:false,nextOffset:null};
  throw new Error("unexpected HTML command "+command);
};
const viewer=makeViewer(invoke);
const target={revision:31,nodeId:41,spanStart:37,spanEnd:37+new TextEncoder().encode(safeHtml).byteLength,scopeId:null,scopeLabel:"Document root",pathSegments:["$","html"],pathTruncated:false};
await viewer.viewer.open(target);
await settle();
check(viewer.elements.html.previewFrame.getAttribute("sandbox")==="","HTML preview sandbox was widened");
check(viewer.elements.html.previewFrame.srcdoc.includes("Content-Security-Policy")&&!viewer.elements.html.previewFrame.srcdoc.includes("<script")&&!viewer.elements.html.previewFrame.srcdoc.includes("allow-same-origin"),"HTML preview srcdoc lost its fixed security boundary");
check(!viewer.elements.search.query.disabled&&viewer.elements.search.decoded.disabled&&viewer.elements.search.rawSource.disabled,"HTML Preview did not own the Rendered search form");
const submitQuery=async(query)=>{viewer.elements.search.query.value=query;viewer.elements.search.form.requestSubmit();await settle();};
await submitQuery("你好");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML Rendered search did not match across inline elements");
check(viewer.elements.search.form.dataset.searchOwner==="rendered","HTML Rendered result list was not owned by the Rendered controller");
viewer.elements.search.results.querySelector("button").click();
await settle();
check(viewer.elements.html.previewFrame.srcdoc.includes("sjv-html-search-link")&&viewer.elements.html.previewFrame.srcdoc.includes("href=\\"about:srcdoc#sjv-html-search-"),"HTML Rendered result did not install a fixed same-document anchor entry point; status="+viewer.elements.status.textContent+" srcdoc="+viewer.elements.html.previewFrame.srcdoc.slice(0,500));
check(viewer.elements.html.previewFrame.srcdoc.includes("id=\\"sjv-html-search-")&&viewer.elements.html.previewFrame.srcdoc.includes("<mark"),"HTML Rendered result did not preserve a generated mark/anchor in the isolated copy");
await submitQuery("&");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML entity text was not searchable as visible text");
await submitQuery("pre  b");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML PRE whitespace was not preserved");
await submitQuery("first");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML BR preceding text was not searchable");
await submitQuery("second");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML BR following text was not searchable");
await submitQuery("foobar");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML WBR incorrectly inserted a search character");
await submitQuery("cell-a");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML first table cell was not searchable");
await submitQuery("cell-b");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML second table cell was not searchable");
await submitQuery("item");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML list item text was not searchable without relying on generated markers");
await submitQuery("quoted");
check(viewer.elements.search.results.querySelectorAll("button").length===1,"HTML Q text was not searchable without relying on generated quotes");
await submitQuery("x");
check(viewer.elements.search.results.querySelectorAll("button").length===50&&!viewer.elements.search.next.disabled,"HTML Rendered search silently truncated matches beyond 50");
viewer.elements.search.next.click();
check(viewer.elements.search.results.querySelectorAll("button").length===8,"HTML Rendered Next did not continue the exact bounded page without dropping the PRE x");
viewer.elements.search.query.dispatchEvent(new Event("input",{bubbles:true}));
check(!viewer.elements.html.previewFrame.srcdoc.includes("sjv-html-search-link")&&!viewer.elements.html.previewFrame.srcdoc.includes("<mark"),"HTML query invalidation did not restore the original sanitized preview");
await submitQuery("你好");
viewer.elements.search.results.querySelector("button").click();
await settle();
const markedSrcdoc=viewer.elements.html.previewFrame.srcdoc;
viewer.elements.search.query.dispatchEvent(new Event("input",{bubbles:true}));
check(viewer.elements.html.previewFrame.srcdoc!==markedSrcdoc&&!viewer.elements.html.previewFrame.srcdoc.includes("sjv-html-search-link"),"HTML repeated search left stale marks/anchor markup in the iframe");
viewer.elements.html.sourceTab.click();
await settle();
check(viewer.elements.search.decoded.checked&&!viewer.elements.search.query.disabled,"switching from HTML Preview to Source did not restore Source search ownership");
viewer.viewer.clear(false);
viewer.host.remove();

let releaseLate;
const latePromise=new Promise((resolve)=>{releaseLate=resolve;});
const late=makeViewer(async(command)=>{
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") return latePromise;
  throw new Error("unexpected late HTML command "+command);
});
const lateTarget={...target,revision:32};
const lateOpen=late.viewer.open(lateTarget);
await Promise.resolve();
late.viewer.clear(false);
releaseLate({html:safeHtml,reason:null});
await lateOpen;
await settle();
check(late.elements.html.previewFrame.srcdoc===""&&!late.viewer.isOpen,"late HTML preview response did not stay invalidated after close");
late.host.remove();
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
  if(!result.pass) throw new Error("HTML Rendered search browser test did not pass.");
  console.log(`html-rendered-search-ui PASS (${result.assertions} assertions)`);
  const probeCode='(()=>{const host=document.createElement("div");host.id="html-anchor-probe";host.style.cssText="position:fixed;left:8px;top:8px;z-index:2147483647;background:white";host.innerHTML=\'<iframe id="html-anchor-probe-frame" sandbox=""></iframe>\';document.body.append(host);const frame=host.querySelector("#html-anchor-probe-frame");frame.style.cssText="width:420px;height:140px;border:1px solid";frame.srcdoc=\'<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src \\\'none\\\'; script-src \\\'none\\\'; connect-src \\\'none\\\'; img-src \\\'none\\\'; media-src \\\'none\\\'; font-src \\\'none\\\'; frame-src \\\'none\\\'; object-src \\\'none\\\'; form-action \\\'none\\\'; base-uri \\\'none\\\'; style-src \\\'unsafe-inline\\\';"><style>body{margin:0;font:16px sans-serif}nav{height:30px;background:#eee}#target:target{background:red;color:white}#spacer{height:900px}</style></head><body><nav><a id="jump" href="about:srcdoc#target">Jump to matched text</a></nav><div id="spacer"></div><p id="target">target</p></body>\';return {hostUrl:location.href,sandbox:frame.getAttribute("sandbox"),csp:frame.srcdoc.includes("Content-Security-Policy")}})()';
  const probe=parseBrowserValue(await browser(["eval","-b",Buffer.from(probeCode).toString("base64")]));
  await browser(["wait","500"]);
  const boxText=await browser(["get","box","#html-anchor-probe-frame"]);
  const box=Object.fromEntries(["x","y","width","height"].map((key)=>[key,Number(boxText.match(new RegExp(`^${key}:\\s*([0-9.]+)$`,"m"))?.[1]??NaN)]));
  if (!Number.isFinite(box.x)||!Number.isFinite(box.y)) throw new Error(`HTML anchor probe did not return a frame box: ${boxText}`);
  const hostUrlBefore=await browser(["get","url"]);
  const clickX=Math.round(box.x+24);
  const clickY=Math.round(box.y+16);
  await browser(["mouse","move",String(clickX),String(clickY)]);
  await browser(["mouse","down"]);
  await browser(["mouse","up"]);
  await browser(["wait","500"]);
  const hostUrlAfter=await browser(["get","url"]);
  const screenshotPath=`/tmp/semantic-json-viewer-html-anchor-${process.pid}.png`;
  await browser(["screenshot",screenshotPath]);
  const requests=await browser(["network","requests"]);
  const probeAfter=parseBrowserValue(await browser(["eval","(()=>{const frame=document.querySelector(\"#html-anchor-probe-frame\");return {frameSrc:frame?.src,hostHash:location.hash}})()"]));
  const externalRequests=requests.split("\n").filter((line)=>/(?:https?:\/\/|data:)/i.test(line)&&!line.includes("127.0.0.1"));
  if (probe.sandbox!==""||!probe.csp||hostUrlBefore!==hostUrlAfter||externalRequests.length>0||probeAfter.frameSrc!=="") {
    throw new Error(`HTML anchor probe safety failed: sandbox=${probe.sandbox} csp=${probe.csp} hostUrlChanged=${hostUrlBefore!==hostUrlAfter} frameSrc=${probeAfter.frameSrc} externalRequests=${externalRequests.join(" | ")}`);
  }
  console.log(`html-anchor-probe EVIDENCE safety-pass=true host-url-unchanged=true host-hash=${probeAfter.hostHash||"<empty>"} sandbox-empty=true csp-present=true frame-src=${probeAfter.frameSrc||"<empty>"} screenshot=${screenshotPath} target-geometry=MANUAL-INSPECTION-REQUIRED`);
} catch(error) {
  throw new Error(`${error instanceof Error?error.message:String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(()=>{});
  vite.kill("SIGTERM");
}
