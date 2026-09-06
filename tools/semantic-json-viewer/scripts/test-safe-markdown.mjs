#!/usr/bin/env node

import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureScript = resolve(root, "fixtures/generate-security-fixtures.mjs");
const fixtureDir = "/tmp/semantic-json-viewer-security-fixtures";
const viteBin = resolve(root, "node_modules/vite/bin/vite.js");
const session = `sjv-safe-markdown-${process.pid}`;

let vite;
let serverPort;
let assertions = 0;

const check = (condition, message) => {
  assertions += 1;
  if (!condition) throw new Error(message);
};

async function runAgent(args, allowFailure = false) {
  return await new Promise((resolveResult, reject) => {
    execFile("agent-browser", ["--session", session, ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error(`${args[0]} failed: ${stderr || stdout || error.message}`));
        return;
      }
      resolveResult({ stdout, stderr, error });
    });
  });
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolveResult, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveResult);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local test port.");
  serverPort = address.port;
  await new Promise((resolveResult) => probe.close(resolveResult));
}

async function waitForVite() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite exited before becoming ready: ${viteOutput()}`);
    try {
      await new Promise((resolveResult, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: serverPort });
        socket.once("connect", () => {
          socket.destroy();
          resolveResult();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Vite did not become ready: ${viteOutput()}`);
}

const viteLogs = [];
function viteOutput() {
  return viteLogs.join("").slice(-4000);
}

function parseAgentJson(output) {
  const text = output.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("{");
    if (start >= 0) return JSON.parse(text.slice(start));
    throw new Error(`Browser returned non-JSON output: ${text}`);
  }
}

function browserExpression(fixtures, commonSource) {
  return `(async()=>{
const {renderSafeMarkdown}=await import("/src/markdown-renderer.ts");
const {ContentViewer}=await import("/src/content-viewer.ts");
const fixtures=${JSON.stringify(fixtures)};
const commonSource=${JSON.stringify(commonSource)};
const nl=String.fromCharCode(10);
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const allowedTags=new Set(["h1","h2","h3","h4","h5","h6","p","ul","ol","li","blockquote","table","thead","tbody","tr","th","td","strong","em","code","pre","br","hr","span"]);
const allowedClasses=new Set(["safe-markdown-link","safe-markdown-del","safe-markdown-align-left","safe-markdown-align-center","safe-markdown-align-right"]);
const forbiddenUrlAttributes=new Set(["href","src","srcset","srcdoc","action","formaction","style"]);
const inspect=(fragment,label)=>{
  check(fragment instanceof DocumentFragment,label+" did not return a detached fragment");
  check(!fragment.isConnected,label+" fragment is connected");
  for(const element of fragment.querySelectorAll("*")){
    const tag=element.localName;
    check(allowedTags.has(tag),label+" emitted "+tag);
    for(const attribute of element.attributes){
      if(attribute.name==="class") check(allowedClasses.has(attribute.value),label+" emitted an unknown class");
      else if(tag==="ol"&&attribute.name==="start") check(/^-?[0-9]+$/.test(attribute.value),label+" emitted an unsafe list start");
      else check(false,label+" emitted attribute "+attribute.name);
    }
  }
  for(const element of fragment.querySelectorAll("a,img,input,iframe,script,style,form,button,textarea,select,object,video,audio")) check(false,label+" emitted forbidden "+element.localName);
  return fragment;
};
const before=document.body.childElementCount;
const htmlFragment=inspect(renderSafeMarkdown(fixtures.htmlSource),"F-11 HTML");
const markdownFragment=inspect(renderSafeMarkdown(fixtures.markdownSource),"F-11 Markdown");
check(document.body.childElementCount===before,"renderer polluted the active document");
for(const fixtureCase of fixtures.truth.cases){
  const fragment=fixtureCase.renderer==="html"?htmlFragment:markdownFragment;
  for(const vector of fixtureCase.vectors){
    check(fragment.textContent.includes(vector.needle),fixtureCase.id+" lost "+vector.id);
    check(fragment.textContent.includes(vector.sentinel),fixtureCase.id+" lost sentinel "+vector.id);
  }
  for(const [effect,value] of Object.entries(fixtureCase.expectedEffects)) check(value===0,fixtureCase.id+" effect contract changed: "+effect);
}
check(htmlFragment.textContent.includes(fixtures.truth.probeToken),"F-11 HTML probe token is not visible text");
check(markdownFragment.textContent.includes(fixtures.truth.probeToken),"F-11 Markdown probe token is not visible text");
for(const fragment of [htmlFragment,markdownFragment]) for(const element of fragment.querySelectorAll("*")) for(const attribute of element.attributes) check(!forbiddenUrlAttributes.has(attribute.name),"F-11 emitted URL attribute "+attribute.name);

const common=inspect(renderSafeMarkdown(commonSource),"CommonMark/GFM");
const commonTags=new Set([...common.querySelectorAll("*")].map((element)=>element.localName));
for(const tag of ["h1","p","strong","em","code","ul","ol","li","blockquote","table","thead","tbody","tr","th","td","pre","br","hr"]) check(commonTags.has(tag),"CommonMark/GFM missing "+tag);
check(common.textContent.includes("☑ done")&&common.textContent.includes("☐ todo"),"task list checkbox text is missing");
check(common.textContent.includes("<div onclick=\\"bad()\\">raw html</div>"),"raw HTML was not escaped as visible text");
check(common.textContent.includes("javascript:alert(1)"),"link destination was not rendered as text");
check(common.textContent.includes("[image: pic] (https://img.invalid/x)"),"image fallback text is missing");
check(common.querySelectorAll("a,img,input").length===0,"CommonMark/GFM emitted an interactive element");
const ordered=common.querySelector("ol");
check(ordered instanceof HTMLOListElement&&ordered.start===42,"ordered list start 42 was not preserved numerically");
check(common.querySelector("td.safe-markdown-align-center")?.textContent==="C","center table alignment class is missing");
check(common.querySelector("td.safe-markdown-align-right")?.textContent==="R","right table alignment class is missing");
const styleHost=document.createElement("div");
styleHost.className="content-viewer-content is-markdown";
styleHost.append(common.cloneNode(true));
document.body.append(styleHost);
check(getComputedStyle(styleHost.querySelector("td.safe-markdown-align-center")).textAlign==="center","center alignment CSS is missing");
check(getComputedStyle(styleHost.querySelector("td.safe-markdown-align-right")).textAlign==="right","right alignment CSS is missing");
styleHost.remove();

const exactBytes=renderSafeMarkdown("x".repeat(128*1024));
check(exactBytes!==null,"128 KiB input was rejected");
check(renderSafeMarkdown("x".repeat(128*1024+1))===null,"input over 128 KiB was accepted");
check(renderSafeMarkdown("😀".repeat(32768))!==null,"UTF-8 exact 128 KiB input was rejected");
check(renderSafeMarkdown("😀".repeat(32769))===null,"UTF-8 input over 128 KiB was accepted");
const paragraphs=Array.from({length:5000},(_,index)=>"p"+index).join(nl+nl);
check(renderSafeMarkdown(paragraphs)!==null,"10,000-node input was rejected");
check(renderSafeMarkdown(Array.from({length:5001},(_,index)=>"p"+index).join(nl+nl))===null,"over 10,000 nodes was accepted");
const depth32=Array.from({length:31},()=>"> ").join("")+"x";
const depth33=Array.from({length:32},()=>"> ").join("")+"x";
check(renderSafeMarkdown(depth32)!==null,"depth 32 DOM/token input was rejected");
check(renderSafeMarkdown(depth33)===null,"depth over 32 DOM/token input was accepted");
const originalDescriptor=Object.getOwnPropertyDescriptor(performance,"now");
const originalNow=performance.now.bind(performance);
let nowCalls=0;
Object.defineProperty(performance,"now",{configurable:true,writable:true,value:()=>originalNow()+(nowCalls++===0?0:1000)});
const timed=renderSafeMarkdown("# budget");
if(originalDescriptor) Object.defineProperty(performance,"now",originalDescriptor); else delete performance.now;
check(timed===null,"100 ms budget was not enforced");

const makeViewer=()=>{
  const dialog=document.createElement("dialog");
  const element=(tag)=>document.createElement(tag);
  const elements={dialog,close:element("button"),title:element("span"),scope:element("span"),path:element("span"),node:element("span"),spanLabel:element("span"),span:element("span"),semanticType:element("span"),detectionSource:element("span"),plainReason:element("span"),representation:element("span"),rendererNote:element("span"),range:element("span"),status:element("span"),alert:element("span"),content:element("div"),previous:element("button"),next:element("button")};
  for(const value of Object.values(elements)) if(value!==dialog) dialog.append(value);
  document.body.append(dialog);
  return {dialog,elements};
};
const fallbackSource=Array.from({length:5001},(_,index)=>"fallback"+index).join(nl+nl);
const fallback=makeViewer();
const fallbackViewer=new ContentViewer({elements:fallback.elements,invoke:async(command)=>command==="get_string_detection"?{semanticType:"markdown",detectionSource:"contentDetected",plainReason:null}:{start:0,text:fallbackSource,hasMore:false,nextOffset:null}});
await fallbackViewer.open({revision:1,nodeId:1,spanStart:0,spanEnd:new TextEncoder().encode(fallbackSource).byteLength,scopeLabel:"Document",pathSegments:["$","content"],pathTruncated:false});
check(fallback.elements.representation.textContent==="Decoded Source","fallback representation is not Decoded Source");
check(fallback.elements.rendererNote.textContent==="Semantic rendering failed.\\nShowing plain text instead.","fallback note is not exact");
check(fallback.elements.content.textContent===fallbackSource,"fallback did not preserve source text");
check(!fallback.elements.content.classList.contains("is-markdown"),"fallback left markdown class installed");
fallbackViewer.close();
fallback.dialog.remove();
const rendered=makeViewer();
const renderedSource="# rendered"+nl+nl+"**safe**";
const renderedViewer=new ContentViewer({elements:rendered.elements,invoke:async(command)=>command==="get_string_detection"?{semanticType:"markdown",detectionSource:"contentDetected",plainReason:null}:{start:0,text:renderedSource,hasMore:false,nextOffset:null}});
await renderedViewer.open({revision:1,nodeId:2,spanStart:0,spanEnd:new TextEncoder().encode(renderedSource).byteLength,scopeLabel:"Document",pathSegments:["$","content"],pathTruncated:false});
check(rendered.elements.representation.textContent==="Rendered","successful representation is not Rendered");
check(rendered.elements.status.textContent==="Rendered Markdown ready","successful status is not exact");
check(rendered.elements.content.classList.contains("is-markdown"),"successful render did not install markdown class");
check(rendered.elements.content.querySelector("h1")?.textContent==="rendered","successful Markdown DOM is missing heading");
renderedViewer.close();
rendered.dialog.remove();
return {assertions};
})()`;
}

async function stopProcess(process) {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([once(process, "exit"), delay(2_000)]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

try {
  const generated = execFileSync(process.execPath, [fixtureScript], { cwd: root, encoding: "utf8" });
  if (!generated.includes("security fixture verification: PASS")) throw new Error("F-11 generator did not report PASS.");
  const html = JSON.parse(await readFile(resolve(fixtureDir, "security-html.json"), "utf8"));
  const markdown = JSON.parse(await readFile(resolve(fixtureDir, "security-markdown.json"), "utf8"));
  const truth = JSON.parse(await readFile(resolve(fixtureDir, "security-ground-truth.json"), "utf8"));
  check(html.data && markdown.data && truth.cases?.length === 2, "F-11 fixture artifacts are incomplete");
  const css = await readFile(resolve(root, "src/style.css"), "utf8");
  for (const alignment of ["left", "center", "right"]) check(css.includes(`.safe-markdown-align-${alignment} { text-align: ${alignment}; }`), `missing fixed ${alignment} table CSS`);
  await freePort();
  vite = execFile(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(serverPort)], { cwd: root });
  vite.stdout?.on("data", (chunk) => viteLogs.push(String(chunk)));
  vite.stderr?.on("data", (chunk) => viteLogs.push(String(chunk)));
  await waitForVite();
  await runAgent(["open", `http://127.0.0.1:${serverPort}/`]);
  await runAgent(["wait", "--load", "networkidle"]);
  const fixtures = { htmlSource: html.data, markdownSource: markdown.data, truth };
  const commonSource = [
    "# Heading",
    "paragraph **strong** *em* `inline`",
    "- [x] done\n- [ ] todo",
    "42. forty-two\n43. next",
    "> quote",
    "| left | center | right |\n| :--- | :----: | ---: |\n| L | C | R |",
    "line  \nb",
    "---",
    "[unsafe](javascript:alert(1)) ![pic](https://img.invalid/x)",
    '<div onclick="bad()">raw html</div>',
    "```html\n<script>SJV_F11_PROBE_V1</script>\n```",
  ].join("\n\n");
  const result = parseAgentJson((await runAgent(["eval", browserExpression(fixtures, commonSource)])).stdout);
  assertions += result.assertions;
  console.log(`PASS: safe markdown assertions=${assertions}`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await runAgent(["close"], true).catch(() => undefined);
  await stopProcess(vite);
}
