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
const harPath = `/tmp/semantic-json-viewer-safe-markdown-${process.pid}.har`;

let vite;
let serverPort;
let assertions = 0;
let harStarted = false;

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

function harEntries(value) {
  if (!value || typeof value !== "object" || !value.log || !Array.isArray(value.log.entries)) {
    throw new Error("agent-browser HAR did not contain a log.entries array.");
  }
  return value.log.entries;
}

function browserExpression(fixtures, commonSource) {
  return `(async()=>{
const {renderSafeMarkdown}=await import("/src/markdown-renderer.ts");
const {renderCode}=await import("/src/code-renderer.ts");
const {ContentViewer}=await import("/src/content-viewer.ts");
const fixtures=${JSON.stringify(fixtures)};
const commonSource=${JSON.stringify(commonSource)};
const nl=String.fromCharCode(10);
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const allowedTags=new Set(["h1","h2","h3","h4","h5","h6","p","ul","ol","li","blockquote","table","thead","tbody","tr","th","td","strong","em","code","pre","br","hr","span"]);
const allowedClasses=new Set(["safe-markdown-link","safe-markdown-del","safe-markdown-align-left","safe-markdown-align-center","safe-markdown-align-right"]);
const allowedCodeClasses=new Set(["sjv-code","sjv-code-source","sjv-code-gutter","sjv-code-highlighted","sjv-code-plain","sjv-token-keyword","sjv-token-string","sjv-token-comment","sjv-token-number","sjv-token-operator","sjv-token-function","sjv-token-class-name","sjv-token-char","sjv-token-boolean","sjv-token-punctuation","sjv-token-property","sjv-token-tag","sjv-token-attr-name","sjv-token-attr-value","sjv-token-regex","sjv-token-builtin","sjv-token-constant","sjv-token-symbol","sjv-token-inserted","sjv-token-deleted","sjv-token-important","sjv-token-bold","sjv-token-italic","sjv-token-variable","sjv-token-namespace","sjv-token-parameter","sjv-token-interpolation","sjv-token-directive","sjv-token-decorator","sjv-token-annotation","sjv-token-selector","sjv-token-plain-text","sjv-token-generic"]);
const allowedCodeLanguageClasses=new Set(["python","javascript","typescript","rust","c","cpp","java","go","shell","sql","json","yaml","generic"].map((language)=>"sjv-code-language-"+language));
const allowedCodeReasonClasses=new Set(["generic","sizeLimit","lineLimit","timeLimit","nodeLimit","rendererError"].map((reason)=>"sjv-code-reason-"+reason));
const forbiddenUrlAttributes=new Set(["href","src","srcset","srcdoc","action","formaction","style"]);
const inspect=(fragment,label)=>{
  check(fragment instanceof DocumentFragment,label+" did not return a detached fragment");
  check(!fragment.isConnected,label+" fragment is connected");
  for(const element of fragment.querySelectorAll("*")){
    const tag=element.localName;
    check(allowedTags.has(tag),label+" emitted "+tag);
    for(const attribute of element.attributes){
      if(attribute.name==="class") for(const className of attribute.value.split(/\\s+/).filter(Boolean)) check(allowedClasses.has(className)||allowedCodeClasses.has(className)||allowedCodeLanguageClasses.has(className)||allowedCodeReasonClasses.has(className),label+" emitted an unknown class "+className);
      else if(tag==="ol"&&attribute.name==="start") check(/^-?[0-9]+$/.test(attribute.value),label+" emitted an unsafe list start");
      else if(attribute.name==="aria-hidden") check(attribute.value==="true",label+" emitted an unsafe aria-hidden value");
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
const fence=String.fromCharCode(96).repeat(3);
const fencedCodeSource="def greet(name):"+nl+"    return name";
const fenced=inspect(renderSafeMarkdown(fence+"python"+nl+fencedCodeSource+nl+fence),"fenced code");
const fencedPre=fenced.querySelector("pre");
check(fenced.querySelectorAll("pre").length===1&&fencedPre?.classList.contains("sjv-code"),"fenced code did not use the Code Renderer wrapper");
check(fencedPre?.classList.contains("sjv-code-language-python"),"fenced code language was not forwarded to Code Renderer");
check(fenced.querySelector("code")?.textContent===fencedCodeSource,"fenced code source was changed");
const manyFencedBlocks=Array.from({length:1000},()=>fence+"js"+nl+"const x = 1;"+nl+fence).join(nl);
check(renderSafeMarkdown(manyFencedBlocks)===null,"multiple fenced blocks bypassed the Markdown node budget");
const styleHost=document.createElement("div");
styleHost.className="content-viewer-content is-markdown";
styleHost.append(common.cloneNode(true));
document.body.append(styleHost);
check(getComputedStyle(styleHost.querySelector("td.safe-markdown-align-center")).textAlign==="center","center alignment CSS is missing");
check(getComputedStyle(styleHost.querySelector("td.safe-markdown-align-right")).textAlign==="right","right alignment CSS is missing");
styleHost.remove();

const codeAllowedClasses=new Set(["sjv-code","sjv-code-source","sjv-code-gutter","sjv-code-highlighted","sjv-code-plain","sjv-token-keyword","sjv-token-string","sjv-token-comment","sjv-token-number","sjv-token-operator","sjv-token-function","sjv-token-class-name","sjv-token-char","sjv-token-boolean","sjv-token-punctuation","sjv-token-property","sjv-token-tag","sjv-token-attr-name","sjv-token-attr-value","sjv-token-regex","sjv-token-builtin","sjv-token-constant","sjv-token-symbol","sjv-token-inserted","sjv-token-deleted","sjv-token-important","sjv-token-bold","sjv-token-italic","sjv-token-variable","sjv-token-namespace","sjv-token-parameter","sjv-token-interpolation","sjv-token-directive","sjv-token-decorator","sjv-token-annotation","sjv-token-selector","sjv-token-plain-text","sjv-token-generic"]);
const codeLanguageClasses=new Set(["python","javascript","typescript","rust","c","cpp","java","go","shell","sql","json","yaml","generic"].map((language)=>"sjv-code-language-"+language));
const codeReasonClasses=new Set(["generic","sizeLimit","lineLimit","timeLimit","nodeLimit","rendererError"].map((reason)=>"sjv-code-reason-"+reason));
const inspectCode=(result,label,source)=>{
  check(result.fragment instanceof DocumentFragment,label+" did not return a detached fragment");
  check(!result.fragment.isConnected,label+" fragment is connected");
  const pre=result.fragment.querySelector("pre");
  const code=result.fragment.querySelector("code");
  check(pre!==null&&code!==null,label+" did not emit pre/code");
  check(code.textContent===source,label+" changed source text");
  for(const element of result.fragment.querySelectorAll("*")){
    check(["pre","code","span"].includes(element.localName),label+" emitted "+element.localName);
    for(const attribute of element.attributes){
      if(attribute.name==="class") for(const className of attribute.value.split(/\\s+/).filter(Boolean)) check(codeAllowedClasses.has(className)||codeLanguageClasses.has(className)||codeReasonClasses.has(className),label+" emitted unknown class "+className);
      else if(attribute.name==="aria-hidden") check(attribute.value==="true"&&!code.contains(element),label+" attached line-number metadata to code");
      else check(false,label+" emitted attribute "+attribute.name);
    }
  }
  check(result.fragment.querySelectorAll("a,img,iframe,script,style,form,button,input,textarea,select,object,video,audio").length===0,label+" emitted an executable or remote element");
  const gutter=pre.querySelector(".sjv-code-gutter");
  if(source.length>0) check(gutter!==null,label+" omitted independent line numbers");
  if(gutter) check(gutter.getAttribute("aria-hidden")==="true"&&!code.contains(gutter),label+" line numbers are not independent");
  return {pre,code};
};

const codeSamples=[
  ["python","def greet(name):"+nl+"    return name",["python","py"]],
  ["javascript","const answer = 42;",["javascript","js","jsx","mjs","cjs"]],
  ["typescript","interface User { id: number; }",["typescript","ts","tsx","mts","cts"]],
  ["rust","fn main() { println!(name); }",["rust","rs"]],
  ["c","int main(void) { return 0; }",["c"]],
  ["cpp","std::cout << 1;",["cpp","c++","cxx","cc","hpp","hxx"]],
  ["java","public class Main { public static void main(String[] args) {} }",["java"]],
  ["go","package main"+nl+"func main() {}",["go","golang"]],
  ["shell","#!/bin/bash"+nl+"echo hi",["shell","sh","bash","zsh"]],
  ["sql","SELECT id FROM users WHERE id = 1;",["sql"]],
  ["json","{key: true}",["json"]],
  ["yaml","name: viewer"+nl+"items:"+nl+"  - one",["yaml","yml"]]
];
for(const [expected,source,aliases] of codeSamples) for(const alias of aliases){
  const result=renderCode(source,alias);
  check(result.language===expected,expected+" alias "+alias+" resolved to "+result.language);
  check(result.presentation==="highlighted"&&result.reason===null,expected+" alias "+alias+" did not highlight");
  inspectCode(result,expected+" alias "+alias,source);
}
const unknown=renderCode("const answer = 42;","made-up-language");
check(unknown.language===null&&unknown.presentation==="plain"&&unknown.reason==="generic","explicit unknown language was guessed");
inspectCode(unknown,"explicit unknown", "const answer = 42;");
const detectorSamples=[
  ["python","def greet(name):"+nl+"    return name"],
  ["javascript","const answer = 42;"],
  ["typescript","interface User { id: number; }"],
  ["rust","fn main() { println!(name); }"],
  ["c","#include <stdio.h>"+nl+"int main(void) { return 0; }"],
  ["cpp","std::cout << 1;"],
  ["java","public class Main { public static void main(String[] args) {} }"],
  ["go","package main"+nl+"func main() {}"],
  ["shell","#!/bin/bash"+nl+"echo hi"],
  ["sql","SELECT id FROM users WHERE id = 1;"],
  ["json","{"+String.fromCharCode(34)+"key"+String.fromCharCode(34)+": true}"],
  ["yaml","name: viewer"+nl+"items:"+nl+"  - one"]
];
for(const [expected,source] of detectorSamples) check(renderCode(source).language===expected,expected+" cheap detector missed a strong sample");
const prefix="const x = 1;";
const detectorBoundary=prefix+" ".repeat(262144-prefix.length);
check(new TextEncoder().encode(detectorBoundary).byteLength===262144,"cheap detector boundary fixture is not 256 KiB");
const boundaryResult=renderCode(detectorBoundary);
check(boundaryResult.language==="javascript"&&boundaryResult.presentation==="highlighted","256 KiB detector boundary was not accepted");
inspectCode(boundaryResult,"256 KiB detector boundary",detectorBoundary);
const detectorOver=prefix+" ".repeat(262145-prefix.length);
const overResult=renderCode(detectorOver);
check(overResult.language===null&&overResult.presentation==="plain"&&overResult.reason==="generic","over-256 KiB source was auto-detected");
inspectCode(overResult,"over-256 KiB source",detectorOver);
const exactMiB=prefix+" ".repeat(1048576-prefix.length);
const exactMiBResult=renderCode(exactMiB,"js");
check(exactMiBResult.presentation==="highlighted"&&exactMiBResult.reason===null,"1 MiB boundary was rejected");
inspectCode(exactMiBResult,"1 MiB boundary",exactMiB);
const overMiBResult=renderCode(prefix+" ".repeat(1048577-prefix.length),"js");
check(overMiBResult.presentation==="plain"&&overMiBResult.reason==="sizeLimit","over-1 MiB source was highlighted");
inspectCode(overMiBResult,"over-1 MiB source",prefix+" ".repeat(1048577-prefix.length));
const exactLines=prefix+nl.repeat(19999);
const exactLinesResult=renderCode(exactLines,"js");
check(exactLinesResult.presentation==="highlighted"&&exactLinesResult.reason===null,"20,000-line boundary was rejected");
check(exactLinesResult.fragment.querySelector(".sjv-code-gutter")?.textContent?.split(nl).length===20000,"20,000-line gutter is wrong");
const overLines=prefix+nl.repeat(20000);
const overLinesResult=renderCode(overLines,"js");
check(overLinesResult.presentation==="plain"&&overLinesResult.reason==="lineLimit","over-20,000-line source was highlighted");
inspectCode(overLinesResult,"over-20,000-line source",overLines);
const mixedLines="a"+String.fromCharCode(13,10)+"b"+String.fromCharCode(10)+"c"+String.fromCharCode(13)+"d"+String.fromCharCode(10);
const mixedLinesResult=renderCode(mixedLines,"js");
check(mixedLinesResult.fragment.querySelector(".sjv-code-gutter")?.textContent==="1"+nl+"2"+nl+"3"+nl+"4"+nl+"5","CRLF/LF/CR/trailing line count is wrong");
const emptyResult=renderCode("");
check(emptyResult.language===null&&emptyResult.reason==="generic"&&emptyResult.fragment.querySelector("code")?.textContent==="","empty source contract is wrong");
const nodeResult=renderCode((prefix+nl).repeat(5000),"js");
check(nodeResult.presentation==="plain"&&nodeResult.reason==="nodeLimit","DOM node limit did not trigger a plain fallback");
inspectCode(nodeResult,"DOM node limit",(prefix+nl).repeat(5000));
const originalPerformanceDescriptor=Object.getOwnPropertyDescriptor(performance,"now");
const originalPerformanceNow=performance.now.bind(performance);
let performanceCalls=0;
Object.defineProperty(performance,"now",{configurable:true,writable:true,value:()=>originalPerformanceNow()+(performanceCalls++===0?0:1000)});
const timeResult=renderCode(prefix,"js");
if(originalPerformanceDescriptor) Object.defineProperty(performance,"now",originalPerformanceDescriptor); else delete performance.now;
check(timeResult.presentation==="plain"&&timeResult.reason==="timeLimit","100 ms code budget did not trigger a time fallback");
inspectCode(timeResult,"time limit",prefix);
const originalCreateElement=document.createElement.bind(document);
let failOneSpan=true;
document.createElement=(tag,...args)=>{if(tag==="span"&&failOneSpan){failOneSpan=false;throw new Error("forced renderer failure");}return originalCreateElement(tag,...args);};
const rendererErrorResult=renderCode(prefix,"js");
document.createElement=originalCreateElement;
check(rendererErrorResult.presentation==="plain"&&rendererErrorResult.reason==="rendererError","renderer exception did not trigger a plain fallback");
inspectCode(rendererErrorResult,"renderer exception",prefix);

const markdownRendererSource=await fetch("/src/markdown-renderer.ts").then((response)=>response.text());
const quote=String.fromCharCode(34);
const markdownImportUrl=markdownRendererSource.split(quote).find((value)=>value.includes("marked.js"));
if(!markdownImportUrl) throw new Error("Could not locate Vite's shared marked module");
const markdownModule=await import(markdownImportUrl);
const originalMarkdownLexer=markdownModule.marked.lexer;
let markdownLexerCalls=0;
markdownModule.marked.lexer=()=>{markdownLexerCalls+=1;return [];};
const markdownLimitSource="x".repeat(32*1024*1024);
check(new TextEncoder().encode(markdownLimitSource).byteLength===32*1024*1024,"32 MiB Markdown boundary fixture is wrong");
const markdownLimitDescriptor=Object.getOwnPropertyDescriptor(performance,"now");
const markdownLimitNow=performance.now();
Object.defineProperty(performance,"now",{configurable:true,writable:true,value:()=>markdownLimitNow});
const markdownExactResult=renderSafeMarkdown(markdownLimitSource);
const markdownOverResult=renderSafeMarkdown("x".repeat(32*1024*1024+1));
if(markdownLimitDescriptor) Object.defineProperty(performance,"now",markdownLimitDescriptor); else delete performance.now;
check(markdownExactResult!==null,"32 MiB Markdown input was rejected");
check(markdownLexerCalls===1,"32 MiB Markdown boundary did not reach the renderer");
check(markdownOverResult===null,"input over 32 MiB was accepted");
check(markdownLexerCalls===1,"over-32 MiB Markdown reached the renderer");
markdownModule.marked.lexer=originalMarkdownLexer;
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
const codeViewerParts=makeViewer();
const codeSource="const value = 42;";
const codeViewer=new ContentViewer({elements:codeViewerParts.elements,invoke:async(command)=>{
  if(command==="get_string_detection") return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  return {start:0,text:codeSource,hasMore:false,nextOffset:null};
}});
await codeViewer.open({revision:1,nodeId:3,spanStart:0,spanEnd:new TextEncoder().encode(codeSource).byteLength,scopeLabel:"Document",pathSegments:["$","code"],pathTruncated:false});
check(codeViewerParts.elements.representation.textContent==="Rendered","code Content Viewer representation is not Rendered");
check(codeViewerParts.elements.status.textContent==="Rendered Code ready","code Content Viewer status is not exact");
check(codeViewerParts.elements.content.querySelector("pre.sjv-code-language-javascript")!==null,"code Content Viewer did not reuse Code Renderer");
check(codeViewerParts.elements.content.querySelectorAll("pre").length===1,"code Content Viewer emitted duplicate pre wrappers");
check(codeViewerParts.elements.content.querySelector(".sjv-code-source")?.textContent===codeSource,"code Content Viewer changed source text");
codeViewer.close();
codeViewerParts.dialog.remove();
const genericCodeParts=makeViewer();
const genericCodeSource="opaque source text";
const genericCodeViewer=new ContentViewer({elements:genericCodeParts.elements,invoke:async(command)=>{
  if(command==="get_string_detection") return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  return {start:0,text:genericCodeSource,hasMore:false,nextOffset:null};
}});
await genericCodeViewer.open({revision:1,nodeId:4,spanStart:0,spanEnd:new TextEncoder().encode(genericCodeSource).byteLength,scopeLabel:"Document",pathSegments:["$","code"],pathTruncated:false});
check(genericCodeParts.elements.representation.textContent==="Rendered","generic code Content Viewer representation is not Rendered");
check(genericCodeParts.elements.status.textContent==="Rendered Code ready","generic code Content Viewer status is not exact");
check(genericCodeParts.elements.rendererNote.textContent==="Generic Code","generic code Content Viewer note is not exact");
check(genericCodeParts.elements.content.querySelector("pre.sjv-code-language-generic")!==null,"generic code Content Viewer did not emit Generic Code");
genericCodeViewer.close();
genericCodeParts.dialog.remove();
const limitedCodeParts=makeViewer();
const limitedCodeSource=prefix+nl.repeat(20000);
const limitedCodeViewer=new ContentViewer({elements:limitedCodeParts.elements,invoke:async(command)=>{
  if(command==="get_string_detection") return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  return {start:0,text:limitedCodeSource,hasMore:false,nextOffset:null};
}});
await limitedCodeViewer.open({revision:1,nodeId:6,spanStart:0,spanEnd:new TextEncoder().encode(limitedCodeSource).byteLength,scopeLabel:"Document",pathSegments:["$","code"],pathTruncated:false});
check(limitedCodeParts.elements.representation.textContent==="Rendered"&&limitedCodeParts.elements.status.textContent==="Rendered Code ready","limited code Content Viewer did not keep Rendered Code state");
check(limitedCodeParts.elements.rendererNote.textContent==="Syntax highlighting disabled for large content.","limited code Content Viewer note is not exact");
check(limitedCodeParts.elements.content.querySelector("pre.sjv-code-plain.sjv-code-reason-lineLimit")!==null,"limited code Content Viewer did not retain plain code fallback");
limitedCodeViewer.close();
limitedCodeParts.dialog.remove();
const pagedCodeParts=makeViewer();
const pagedCodeSource="const value = 42;";
const pagedCodeViewer=new ContentViewer({elements:pagedCodeParts.elements,invoke:async(command)=>{
  if(command==="get_string_detection") return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  return {start:0,text:pagedCodeSource,hasMore:false,nextOffset:null};
}});
await pagedCodeViewer.open({revision:1,nodeId:5,spanStart:0,spanEnd:new TextEncoder().encode(pagedCodeSource).byteLength,scopeLabel:"Document",pathSegments:["$","code"],pathTruncated:false});
check(pagedCodeParts.elements.representation.textContent==="Rendered","complete code was not rendered");
check(pagedCodeParts.elements.content.querySelector("pre")!==null&&pagedCodeParts.elements.next.disabled===true,"complete code controls are wrong");
pagedCodeViewer.close();
pagedCodeParts.dialog.remove();
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

const withStableRenderClock=async(work)=>{
  const descriptor=Object.getOwnPropertyDescriptor(performance,"now");
  const fixedNow=performance.now();
  Object.defineProperty(performance,"now",{configurable:true,writable:true,value:()=>fixedNow});
  try{return await work();}
  finally{if(descriptor) Object.defineProperty(performance,"now",descriptor); else delete performance.now;}
};
const collectorPageBytes=128*1024;
const pagedResponse=(pages,offset)=>{
  const index=offset/collectorPageBytes;
  const text=pages[index];
  if(typeof text!=="string") throw new Error("missing collector page "+offset);
  const bytes=new TextEncoder().encode(text).byteLength;
  const hasMore=index<pages.length-1;
  return {start:offset,text,hasMore,nextOffset:hasMore?offset+bytes:null};
};

const fallbackLargeSource=Array.from({length:10001},(_,index)=>"fallback-"+index+" "+"x".repeat(16)).join(nl+nl);
const fallbackLargePages=[];
for(let start=0;start<fallbackLargeSource.length;start+=collectorPageBytes) fallbackLargePages.push(fallbackLargeSource.slice(start,start+collectorPageBytes));
const fallbackLargeParts=makeViewer();
const fallbackLargeCalls=[];
const fallbackLargeViewer=new ContentViewer({elements:fallbackLargeParts.elements,invoke:async(command,args)=>{
  fallbackLargeCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
  if(command==="read_decoded_text") return pagedResponse(fallbackLargePages,args.offset);
  throw new Error("unexpected large fallback command "+command);
}});
await withStableRenderClock(()=>fallbackLargeViewer.open({revision:20,nodeId:200,spanStart:0,spanEnd:fallbackLargeSource.length,scopeId:null,scopeLabel:"Document",pathSegments:["$","fallback-large"],pathTruncated:false},fallbackLargeParts.elements.close));
check(fallbackLargePages.length>1&&fallbackLargeCalls.filter((call)=>call.command==="read_decoded_text").length===fallbackLargePages.length,"large Markdown fallback did not collect all pages");
check(fallbackLargeParts.elements.representation.textContent==="Decoded Source"&&fallbackLargeParts.elements.content.textContent===fallbackLargePages[0],"failed Markdown render did not retain one source page");
check(fallbackLargeParts.elements.next.disabled===false&&fallbackLargeParts.elements.rendererNote.textContent==="Semantic rendering failed."+nl+"Showing plain text instead.","failed Markdown render lost paging or fallback note");
fallbackLargeViewer.close();
fallbackLargeParts.dialog.remove();

const onePagePlusPrefix="# one page plus one byte"+nl+nl;
const onePagePlusSource=onePagePlusPrefix+"x".repeat(collectorPageBytes-onePagePlusPrefix.length)+"!";
const onePagePlusPages=[onePagePlusSource.slice(0,collectorPageBytes),onePagePlusSource.slice(collectorPageBytes)];
const onePagePlusParts=makeViewer();
const onePagePlusCalls=[];
const onePagePlusViewer=new ContentViewer({elements:onePagePlusParts.elements,invoke:async(command,args)=>{
  onePagePlusCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
  if(command==="read_decoded_text") return pagedResponse(onePagePlusPages,args.offset);
  throw new Error("unexpected one-page-plus command "+command);
}});
await withStableRenderClock(()=>onePagePlusViewer.open({revision:21,nodeId:201,spanStart:0,spanEnd:onePagePlusSource.length,scopeId:null,scopeLabel:"Document",pathSegments:["$","one-page-plus"],pathTruncated:false},onePagePlusParts.elements.close));
check(onePagePlusCalls.filter((call)=>call.command==="read_decoded_text").length===2,"128 KiB+1 Markdown did not fetch exactly two pages");
check(onePagePlusCalls.filter((call)=>call.command==="read_decoded_text").map((call)=>call.args.offset).join(",")==="0,"+collectorPageBytes,"128 KiB+1 Markdown offsets were not sequential");
check(onePagePlusParts.elements.representation.textContent==="Rendered"&&onePagePlusParts.elements.content.classList.contains("is-markdown"),"128 KiB+1 Markdown did not render after collection");
check(onePagePlusParts.elements.content.textContent.endsWith("!"),"128 KiB+1 Markdown did not retain the second-page sentinel");
onePagePlusViewer.close();
onePagePlusParts.dialog.remove();

const utfCollectorPage0="😀".repeat(32768);
const utfCollectorPage1="é".repeat(65536);
const utfCollectorPages=[utfCollectorPage0,utfCollectorPage1];
const utfCollectorSource=utfCollectorPages.join("");
const utfCollectorParts=makeViewer();
const utfCollectorCalls=[];
const utfCollectorViewer=new ContentViewer({elements:utfCollectorParts.elements,invoke:async(command,args)=>{
  utfCollectorCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
  if(command==="read_decoded_text") return pagedResponse(utfCollectorPages,args.offset);
  throw new Error("unexpected UTF-8 collector command "+command);
}});
await withStableRenderClock(()=>utfCollectorViewer.open({revision:22,nodeId:202,spanStart:0,spanEnd:new TextEncoder().encode(utfCollectorSource).byteLength,scopeId:null,scopeLabel:"Document",pathSegments:["$","utf8"],pathTruncated:false},utfCollectorParts.elements.close));
check(new TextEncoder().encode(utfCollectorPage0).byteLength===collectorPageBytes&&new TextEncoder().encode(utfCollectorPage1).byteLength===collectorPageBytes,"collector UTF-8 pages are not exactly 128 KiB");
check(utfCollectorCalls.filter((call)=>call.command==="read_decoded_text").map((call)=>call.args.offset).join(",")==="0,"+collectorPageBytes,"collector UTF-8 offsets were not byte based");
check(utfCollectorParts.elements.content.textContent===utfCollectorSource&&!utfCollectorParts.elements.content.textContent.includes("�"),"collector UTF-8 pages were truncated or replaced");
utfCollectorViewer.close();
utfCollectorParts.dialog.remove();

const markdownAutoLimit=2*1024*1024;
const markdownAutoPages=markdownAutoLimit/collectorPageBytes;
const markdownExactHead="# exact two MiB"+nl+nl;
const markdownExactPages=[markdownExactHead+".".repeat(collectorPageBytes-markdownExactHead.length),...Array.from({length:markdownAutoPages-1},()=>".".repeat(collectorPageBytes))];
markdownExactPages[markdownAutoPages-1]=".".repeat(collectorPageBytes-1)+"!";
const markdownExactParts=makeViewer();
const markdownExactCalls=[];
const markdownExactViewer=new ContentViewer({elements:markdownExactParts.elements,invoke:async(command,args)=>{
  markdownExactCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
  if(command==="read_decoded_text") return pagedResponse(markdownExactPages,args.offset);
  throw new Error("unexpected exact Markdown command "+command);
}});
await withStableRenderClock(()=>markdownExactViewer.open({revision:23,nodeId:203,spanStart:0,spanEnd:markdownAutoLimit,scopeId:null,scopeLabel:"Document",pathSegments:["$","markdown-2m"],pathTruncated:false},markdownExactParts.elements.close));
check(markdownExactCalls.filter((call)=>call.command==="read_decoded_text").length===markdownAutoPages,"2 MiB Markdown did not collect all 128 KiB pages");
check(markdownExactParts.elements.representation.textContent==="Rendered"&&markdownExactParts.elements.content.classList.contains("is-markdown"),"2 MiB Markdown was not fully rendered");
check(markdownExactParts.elements.content.textContent.includes("exact two MiB")&&markdownExactParts.elements.content.textContent.endsWith("!"),"2 MiB Markdown lost the collected tail");
markdownExactViewer.close();
markdownExactParts.dialog.remove();

const markdownOverPages=[...markdownExactPages,"!"];
const markdownOverParts=makeViewer();
const markdownOverCalls=[];
const markdownOverViewer=new ContentViewer({elements:markdownOverParts.elements,invoke:async(command,args)=>{
  markdownOverCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
  if(command==="read_decoded_text") return pagedResponse(markdownOverPages,args.offset);
  throw new Error("unexpected over-limit Markdown command "+command);
}});
const originalGateMarkdownLexer=markdownModule.marked.lexer;
let gateMarkdownLexerCalls=0;
markdownModule.marked.lexer=()=>{gateMarkdownLexerCalls+=1;return [];};
await markdownOverViewer.open({revision:24,nodeId:204,spanStart:0,spanEnd:markdownAutoLimit+1,scopeId:null,scopeLabel:"Document",pathSegments:["$","markdown-over"],pathTruncated:false},markdownOverParts.elements.close);
markdownModule.marked.lexer=originalGateMarkdownLexer;
check(markdownOverCalls.filter((call)=>call.command==="read_decoded_text").length===markdownAutoPages,"over-2 MiB Markdown read past the overlimit gate");
check(markdownOverParts.elements.representation.textContent==="Decoded Source"&&markdownOverParts.elements.content.textContent===markdownExactPages[0],"over-2 MiB Markdown did not retain only its first source page");
check(markdownOverParts.elements.rendererNote.textContent==="Markdown rendering skipped because content exceeds 2 MiB.","over-2 MiB Markdown note is not explicit");
check(markdownOverParts.elements.next.disabled===false&&gateMarkdownLexerCalls===0,"over-2 MiB Markdown bypassed the read/renderer gate");
markdownOverViewer.close();
markdownOverParts.dialog.remove();

const codeAutoLimit=1024*1024;
const codeAutoPages=codeAutoLimit/collectorPageBytes;
const codeExactHead="const value = 42;"+nl;
const codeExactPages=[codeExactHead+" ".repeat(collectorPageBytes-codeExactHead.length),...Array.from({length:codeAutoPages-1},()=>" ".repeat(collectorPageBytes))];
const codeExactParts=makeViewer();
const codeExactCalls=[];
const codeExactViewer=new ContentViewer({elements:codeExactParts.elements,invoke:async(command,args)=>{
  codeExactCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  if(command==="read_decoded_text") return pagedResponse(codeExactPages,args.offset);
  throw new Error("unexpected exact Code command "+command);
}});
await withStableRenderClock(()=>codeExactViewer.open({revision:25,nodeId:205,spanStart:0,spanEnd:codeAutoLimit,scopeId:null,scopeLabel:"Document",pathSegments:["$","code-1m"],pathTruncated:false},codeExactParts.elements.close));
check(codeExactCalls.filter((call)=>call.command==="read_decoded_text").length===codeAutoPages,"1 MiB Code did not collect all 128 KiB pages");
check(codeExactParts.elements.representation.textContent==="Rendered"&&codeExactParts.elements.content.querySelector("pre")!==null,"1 MiB Code was not fully rendered");
check(codeExactParts.elements.content.querySelector(".sjv-code-source")?.textContent===codeExactPages.join(""),"1 MiB Code changed collected source");
codeExactViewer.close();
codeExactParts.dialog.remove();

const codeOverPages=[...codeExactPages,"!"];
const codeOverParts=makeViewer();
const codeOverCalls=[];
const codeOverViewer=new ContentViewer({elements:codeOverParts.elements,invoke:async(command,args)=>{
  codeOverCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  if(command==="read_decoded_text") return pagedResponse(codeOverPages,args.offset);
  throw new Error("unexpected over-limit Code command "+command);
}});
const codeRendererSource=await fetch("/src/code-renderer.ts").then((response)=>response.text());
const prismImportUrl=codeRendererSource.split(quote).find((value)=>value.includes("prism-core.js"));
if(!prismImportUrl) throw new Error("Could not locate Vite's shared Prism module");
const prismModule=await import(prismImportUrl);
const originalGatePrismTokenize=prismModule.default.tokenize;
let gatePrismTokenizeCalls=0;
prismModule.default.tokenize=(...args)=>{gatePrismTokenizeCalls+=1;return originalGatePrismTokenize(...args);};
await codeOverViewer.open({revision:26,nodeId:206,spanStart:0,spanEnd:codeAutoLimit+1,scopeId:null,scopeLabel:"Document",pathSegments:["$","code-over"],pathTruncated:false},codeOverParts.elements.close);
prismModule.default.tokenize=originalGatePrismTokenize;
check(codeOverCalls.filter((call)=>call.command==="read_decoded_text").length===codeAutoPages,"over-1 MiB Code read past the overlimit gate");
check(codeOverParts.elements.representation.textContent==="Decoded Source"&&codeOverParts.elements.content.textContent===codeExactPages[0],"over-1 MiB Code did not retain only its first source page");
check(codeOverParts.elements.rendererNote.textContent==="Syntax highlighting disabled for large content.","over-1 MiB Code note is not exact");
check(codeOverParts.elements.next.disabled===false&&codeOverParts.elements.content.querySelector("pre")===null&&gatePrismTokenizeCalls===0,"over-1 MiB Code bypassed the read/renderer gate");
codeOverViewer.close();
codeOverParts.dialog.remove();

const invalidCollectorCases=[
  ["invalid start",(offset)=>({start:offset-1,text:"bad",hasMore:false,nextOffset:null})],
  ["repeated offset",(offset)=>({start:offset,text:"bad",hasMore:true,nextOffset:offset})],
  ["backward offset",(offset)=>({start:offset,text:"bad",hasMore:true,nextOffset:offset-1})],
  ["oversized page",(offset)=>({start:offset,text:"x".repeat(collectorPageBytes+1),hasMore:false,nextOffset:null})]
];
for(const [caseId,invalidPage] of invalidCollectorCases){
  const parts=makeViewer();
  const calls=[];
  const viewer=new ContentViewer({elements:parts.elements,invoke:async(command,args)=>{
    calls.push({command,args});
    if(command==="get_string_detection") return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
    if(command==="read_decoded_text") {
      if(args.offset===0) return {start:0,text:"x".repeat(collectorPageBytes),hasMore:true,nextOffset:collectorPageBytes};
      return invalidPage(args.offset);
    }
    throw new Error("unexpected "+caseId+" command");
  }});
  await viewer.open({revision:27,nodeId:207,spanStart:0,spanEnd:collectorPageBytes*2+1,scopeId:null,scopeLabel:"Document",pathSegments:["$",caseId],pathTruncated:false},parts.elements.close);
  check(parts.elements.alert.textContent.includes("decoded text response was invalid"),caseId+" collector response was accepted");
  check(calls.filter((call)=>call.command==="read_decoded_text").length===2,caseId+" collector read count changed unexpectedly");
  check(parts.elements.content.textContent===""&&parts.elements.representation.textContent!=="Rendered",caseId+" invalid collector appended content");
  viewer.close();
  parts.dialog.remove();
}

let resolveLateCollector;
const lateCollectorPage=new Promise((resolve)=>{resolveLateCollector=resolve;});
const collectorSettle=async()=>{await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const lateCollectorParts=makeViewer();
const lateCollectorCalls=[];
const lateCollectorViewer=new ContentViewer({elements:lateCollectorParts.elements,invoke:async(command,args)=>{
  lateCollectorCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
  if(command!=="read_decoded_text") throw new Error("unexpected late collector command "+command);
  if(args.nodeId===208) {
    if(args.offset===0) return {start:0,text:"s".repeat(collectorPageBytes),hasMore:true,nextOffset:collectorPageBytes};
    return lateCollectorPage;
  }
  return {start:0,text:"# fresh",hasMore:false,nextOffset:null};
}});
const lateTarget={revision:28,nodeId:208,spanStart:0,spanEnd:collectorPageBytes+1,scopeId:null,scopeLabel:"Document",pathSegments:["$","stale"],pathTruncated:false};
const collectorLateOpen=lateCollectorViewer.open(lateTarget,lateCollectorParts.elements.close);
await collectorSettle();
check(lateCollectorCalls.some((call)=>call.command==="read_decoded_text"&&call.args.nodeId===208&&call.args.offset===collectorPageBytes),"late collector did not reach its pending second page");
await withStableRenderClock(()=>lateCollectorViewer.open({revision:28,nodeId:209,spanStart:0,spanEnd:8,scopeId:null,scopeLabel:"Document",pathSegments:["$","fresh"],pathTruncated:false},lateCollectorParts.elements.close));
resolveLateCollector({start:collectorPageBytes,text:"!",hasMore:false,nextOffset:null});
await collectorLateOpen;
check(lateCollectorParts.elements.content.querySelector("h1")?.textContent==="fresh"&&lateCollectorParts.elements.path.textContent==="$ .fresh".replace("$ ","$"),"late collector response repopulated the current viewer");
check(lateCollectorParts.elements.content.textContent!=="s".repeat(collectorPageBytes)+"!","late collector retained stale source");
lateCollectorViewer.close();
lateCollectorParts.dialog.remove();

const nestedDocumentIds=[
  "content-viewer-nested-navigation","content-viewer-nested-back","content-viewer-nested-breadcrumbs",
  "content-viewer-representations","content-viewer-parsed-tab","content-viewer-decoded-tab",
  "content-viewer-raw-lexeme-tab","content-viewer-parsed-panel","content-viewer-parsed-tree","content-viewer-text-panel"
];
for(const id of nestedDocumentIds) check(document.getElementById(id)!==null,"document is missing "+id);
const documentNestedBack=document.getElementById("content-viewer-nested-back");
const documentNestedNavigation=document.getElementById("content-viewer-nested-navigation");
const documentNestedBreadcrumbs=document.getElementById("content-viewer-nested-breadcrumbs");
const documentNestedRepresentations=document.getElementById("content-viewer-representations");
check(documentNestedNavigation?.getAttribute("aria-label")==="Nested JSON navigation","Nested navigation label changed");
check(documentNestedBack?.getAttribute("aria-label")==="Back to parent nested JSON"&&documentNestedBack?.getAttribute("aria-controls")==="content-viewer-parsed-panel","Nested Back ARIA contract changed");
check(documentNestedBreadcrumbs?.getAttribute("aria-label")==="Nested JSON breadcrumb","Nested breadcrumb label changed");
check(documentNestedRepresentations?.getAttribute("role")==="tablist"&&documentNestedRepresentations?.getAttribute("aria-label")==="Nested JSON representations","Nested representation tablist ARIA contract changed");
for(const [id,controls] of [["content-viewer-parsed-tab","content-viewer-parsed-panel"],["content-viewer-decoded-tab","content-viewer-text-panel"],["content-viewer-raw-lexeme-tab","content-viewer-text-panel"]]) {
  const tab=document.getElementById(id);
  check(tab?.getAttribute("role")==="tab"&&tab?.getAttribute("aria-controls")===controls,"Nested tab ARIA contract changed for "+id);
}
const documentParsedPanel=document.getElementById("content-viewer-parsed-panel");
const documentTextPanel=document.getElementById("content-viewer-text-panel");
check(documentParsedPanel?.getAttribute("role")==="tabpanel"&&documentParsedPanel?.getAttribute("aria-labelledby")==="content-viewer-parsed-tab","Parsed panel ARIA contract changed");
check(documentTextPanel?.getAttribute("role")==="region"&&!documentTextPanel?.hasAttribute("aria-labelledby")&&documentTextPanel?.getAttribute("aria-label")==="Decoded source","Text panel ARIA contract changed");

const settle=async()=>{await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const makeNestedViewer=()=>{
  const parts=makeViewer();
  parts.dialog.className="content-viewer-dialog";
  const element=(tag)=>document.createElement(tag);
  const navigation=element("nav");
  const back=element("button");
  const breadcrumb=element("ol");
  const representations=element("div");
  const parsedTab=element("button");
  const decodedTab=element("button");
  const rawTab=element("button");
  const parsedPanel=element("section");
  const parsedTree=element("div");
  const shell=element("div");
  const header=element("header");
  const meta=element("section");
  const contentRegion=element("section");
  const toolbar=element("div");
  const textPanel=element("section");
  const body=element("div");
  shell.className="content-viewer-shell";
  header.className="content-viewer-header";
  meta.className="content-viewer-meta";
  navigation.className="nested-navigation";
  representations.className="nested-representations";
  parsedPanel.className="nested-parsed-panel";
  parsedTree.className="nested-tree";
  contentRegion.className="content-viewer-stage";
  toolbar.className="content-viewer-toolbar";
  textPanel.className="content-viewer-text-panel";
  body.className="content-viewer-body";
  parts.elements.content.className="content-viewer-content";
  navigation.append(back,breadcrumb);
  representations.append(parsedTab,decodedTab,rawTab);
  parsedPanel.append(parsedTree);
  header.append(parts.elements.title,parts.elements.close);
  meta.append(parts.elements.scope,parts.elements.path,parts.elements.node,parts.elements.spanLabel,parts.elements.span,parts.elements.semanticType,parts.elements.detectionSource,parts.elements.plainReason,parts.elements.representation);
  toolbar.append(parts.elements.range,parts.elements.status,parts.elements.previous,parts.elements.next);
  body.append(parts.elements.content);
  textPanel.append(body);
  contentRegion.append(toolbar,parsedPanel,textPanel);
  shell.append(header,meta,navigation,representations,parts.elements.rendererNote,parts.elements.alert,contentRegion);
  parts.dialog.replaceChildren(shell);
  parts.elements.nested={navigation,back,breadcrumb,representations,parsedTab,decodedTab,rawTab,parsedPanel,parsedTree,sharedTextPanel:textPanel};
  return parts;
};
const node=(id,kind,start,end,label,children,value=null)=>({id,kind,spanStart:start,spanEnd:end,label,labelHasMore:false,valuePreview:value,valueHasMore:false,childCount:children});
const nestedSource='{"child":"{\\"leaf\\":true}"}';
const nestedBytes=new TextEncoder().encode(nestedSource).byteLength;
const leafSource='{"leaf":true}';
const leafBytes=new TextEncoder().encode(leafSource).byteLength;
const nestedRoot=node(0,"object",0,nestedBytes,"$",1);
const nestedChild=node(1,"string",9,nestedBytes-1,"child",0,"{\\"leaf\\":true}");
const leafRoot=node(10,"object",0,leafBytes,"$",0);
const nestedCalls=[];
let failNestedChildClose=true;
let failNestedRootCleanup=true;
const nestedInvoke=async(command,args)=>{
  nestedCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json"){
    if(args.parentScopeId===null) return {scopeId:1,parentScopeId:null,sourceNodeId:7,root:nestedRoot,depth:1,maxDepth:5,parsedBytes:nestedBytes,cumulativeBytes:nestedBytes,sessionRevision:9};
    return {scopeId:2,parentScopeId:1,sourceNodeId:1,root:leafRoot,depth:2,maxDepth:5,parsedBytes:leafBytes,cumulativeBytes:nestedBytes+leafBytes,sessionRevision:9};
  }
  if(command==="get_children"&&args.scopeId===1) return {nodes:[nestedChild],hasMore:false,nextCursor:null};
  if(command==="read_decoded_text"){
    const text=args.scopeId===null?leafSource:nestedSource;
    return {start:args.offset,text,hasMore:false,nextOffset:null};
  }
  if(command==="read_raw_slice") return {start:args.sourceStart,text:nestedSource,hasMore:false,nextOffset:null};
  if(command==="close_nested_scope"){
    if(args.scopeId===2&&failNestedChildClose){failNestedChildClose=false;throw new Error("temporary child close failure");}
    if(args.scopeId===1&&failNestedRootCleanup){failNestedRootCleanup=false;throw new Error("temporary root cleanup failure");}
    return undefined;
  }
  throw new Error("unexpected nested command "+command);
};
const nestedParts=makeNestedViewer();
const nestedViewer=new ContentViewer({elements:nestedParts.elements,invoke:nestedInvoke});
const nestedTarget={revision:9,nodeId:7,spanStart:100,spanEnd:100+nestedBytes,scopeId:null,scopeLabel:"Document",pathSegments:["$","payload"],pathTruncated:false};
await nestedViewer.open(nestedTarget,nestedParts.elements.close);
await settle();
check(nestedCalls.map((call)=>call.command).join("→")==="get_string_detection→open_nested_json","Nested initial calls were not exactly detection→open without a read");
check(nestedCalls[1]?.command==="open_nested_json"&&nestedCalls[1].args.parentScopeId===null&&nestedCalls[1].args.maxDepth===null,"Nested root call did not carry null parent/maxDepth");
check(nestedParts.elements.close===document.activeElement,"Nested initial focus did not remain on Close");
check(nestedParts.elements.nested.back.hidden,"Nested root Back should be hidden");
check(nestedParts.elements.nested.parsedTab.getAttribute("aria-selected")==="true","Nested root did not default to Parsed");
check(nestedParts.elements.range.textContent==="Parsed bytes [0, "+nestedBytes+") · depth 1/5","Nested root Parsed range is not exact");
const nestedDisclosure=nestedParts.elements.nested.parsedTree.querySelector(".tree-disclosure");
check(nestedDisclosure!==null,"Nested root disclosure is missing");
nestedDisclosure.click();
await settle();
const nestedChildButton=nestedParts.elements.nested.parsedTree.querySelector('[data-node-id="1"]');
check(nestedChildButton!==null,"Nested child node did not load: "+JSON.stringify(nestedCalls)+" / "+JSON.stringify(nestedChild)+" / "+nestedParts.elements.nested.parsedTree.textContent);
nestedChildButton.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));
await settle();
check(nestedCalls.some((call)=>call.command==="open_nested_json"&&call.args.parentScopeId===1&&call.args.maxDepth===null),"Nested child call did not use current parent scope/null maxDepth");
check(!nestedParts.elements.nested.back.hidden,"Nested child Back should be visible");
check(nestedParts.elements.nested.parsedTree.querySelector('[data-node-id="10"]')===document.activeElement,"Nested child root did not receive focus");
nestedParts.elements.nested.back.click();
await settle();
check(nestedCalls.filter((call)=>call.command==="close_nested_scope"&&call.args.scopeId===2).length===1,"Nested Back did not close child exactly once");
check(!nestedParts.elements.alert.hidden,"Failed Nested Back did not expose its error");
nestedParts.elements.nested.back.click();
await settle();
check(nestedCalls.filter((call)=>call.command==="close_nested_scope"&&call.args.scopeId===2).length===2,"Nested Back retry did not issue one bounded retry");
check(nestedParts.elements.alert.hidden,"Successful Nested Back retry did not clear the old alert");
check(nestedParts.elements.nested.parsedTab===document.activeElement,"Nested Back did not restore Parsed tab focus");
check(nestedParts.elements.nested.back.hidden,"Nested root Back should be hidden after returning from child");
check(nestedParts.elements.nested.parsedTree.querySelector('[data-node-id="0"]')?.getAttribute("aria-expanded")==="true","Nested Back did not restore parent expansion");
const nestedOpenCount=()=>nestedCalls.filter((call)=>call.command==="open_nested_json").length;
const openCallsBeforeRepresentations=nestedOpenCount();
nestedParts.elements.nested.decodedTab.click();
await settle();
check(!nestedParts.elements.alert.hidden&&nestedParts.elements.alert.textContent.includes("nested text response was invalid"),"Early-terminal Nested Decoded chunk was accepted");
check(nestedOpenCount()===openCallsBeforeRepresentations,"Switching to Nested Decoded added an open call");
nestedParts.elements.nested.rawTab.click();
await settle();
check(nestedOpenCount()===openCallsBeforeRepresentations,"Switching to Nested Raw added an open call");
const rawCall=nestedCalls.findLast((call)=>call.command==="read_raw_slice");
check(rawCall?.args.sourceStart===nestedTarget.spanStart&&rawCall?.args.length===Math.min(128*1024,nestedTarget.spanEnd-nestedTarget.spanStart),"Nested Raw request lost parent-scope absolute range");
check(nestedParts.elements.range.textContent==="Parent scope bytes ["+nestedTarget.spanStart+", "+nestedTarget.spanEnd+") of ["+nestedTarget.spanStart+", "+nestedTarget.spanEnd+")","Nested Raw range did not display the exact absolute span");
nestedParts.elements.nested.parsedTab.click();
await settle();
check(nestedOpenCount()===openCallsBeforeRepresentations,"Switching back to Nested Parsed added an open call");
check(nestedParts.elements.range.getClientRects().length>0&&nestedParts.elements.range.offsetParent!==null,"Nested range toolbar is not visible in the shared content wrapper");
nestedViewer.close();
await settle();
check(nestedCalls.filter((call)=>call.command==="close_nested_scope"&&call.args.scopeId===1).length===2,"Nested root cleanup did not perform one bounded retry");
nestedParts.dialog.remove();

const whitespaceParts=makeNestedViewer();
const whitespaceSource=String.fromCharCode(32,10,123,34,108,101,97,102,34,58,116,114,117,101,125,9);
const whitespaceBytes=new TextEncoder().encode(whitespaceSource).byteLength;
const whitespaceRoot=node(20,"object",2,whitespaceBytes-1,"$",0);
const whitespaceCalls=[];
const whitespaceTarget={revision:9,nodeId:8,spanStart:200,spanEnd:200+whitespaceBytes,scopeId:null,scopeLabel:"Document",pathSegments:["$","whitespace"],pathTruncated:false};
const whitespaceViewer=new ContentViewer({elements:whitespaceParts.elements,invoke:async(command,args)=>{
  whitespaceCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json") return {scopeId:4,parentScopeId:null,sourceNodeId:8,root:whitespaceRoot,depth:1,maxDepth:5,parsedBytes:whitespaceBytes,cumulativeBytes:whitespaceBytes,sessionRevision:9};
  if(command==="close_nested_scope") return undefined;
  throw new Error("unexpected whitespace nested command "+command);
}});
await whitespaceViewer.open(whitespaceTarget,whitespaceParts.elements.close);
await settle();
check(whitespaceCalls.map((call)=>call.command).join("→")==="get_string_detection→open_nested_json"&&whitespaceParts.elements.alert.hidden,"Whitespace-padded nested root was not accepted");
check(whitespaceParts.elements.nested.parsedTree.querySelector('[data-node-id="20"]')!==null,"Whitespace-padded nested root was not shown");
whitespaceViewer.close();
await settle();
check(whitespaceCalls.filter((call)=>call.command==="close_nested_scope"&&call.args.scopeId===4).length===1,"Whitespace nested root close was not exactly once");
whitespaceParts.dialog.remove();

const malformedChildParts=makeNestedViewer();
const malformedChildCalls=[];
const malformedChildViewer=new ContentViewer({elements:malformedChildParts.elements,invoke:async(command,args)=>{
  malformedChildCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json") {
    if(args.parentScopeId===null) return {scopeId:5,parentScopeId:null,sourceNodeId:7,root:nestedRoot,depth:1,maxDepth:5,parsedBytes:nestedBytes,cumulativeBytes:nestedBytes,sessionRevision:9};
    return {scopeId:6,parentScopeId:5,sourceNodeId:1,root:leafRoot,depth:2,maxDepth:5,parsedBytes:leafBytes,cumulativeBytes:nestedBytes+leafBytes+1,sessionRevision:9};
  }
  if(command==="get_children"&&args.scopeId===5) return {nodes:[nestedChild],hasMore:false,nextCursor:null};
  if(command==="close_nested_scope") return undefined;
  throw new Error("unexpected malformed child command "+command);
}});
await malformedChildViewer.open(nestedTarget,malformedChildParts.elements.close);
await settle();
malformedChildParts.elements.nested.parsedTree.querySelector(".tree-disclosure")?.click();
await settle();
malformedChildParts.elements.nested.parsedTree.querySelector('[data-node-id="1"]')?.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));
await settle();
check(malformedChildParts.elements.alert.textContent.includes("scope response was invalid"),"Malformed cumulative child scope was not rejected");
check(malformedChildCalls.filter((call)=>call.command==="close_nested_scope"&&call.args.scopeId===6).length===1,"Malformed cumulative child scope was not best-effort closed");
malformedChildViewer.close();
await settle();
malformedChildParts.dialog.remove();

const depthFailureParts=makeNestedViewer();
const depthFailureCalls=[];
const depthFailureTarget={revision:9,nodeId:77,spanStart:300,spanEnd:300+nestedBytes,scopeId:null,scopeLabel:"Document",pathSegments:["$","depth"],pathTruncated:false};
const depthFailureRoot=(depth)=>node(1000+depth-1,"object",0,10,"$",1);
const depthFailureChild=(depth)=>node(2000+depth,"string",1,9,"child",0,"1234567890");
const depthFailureViewer=new ContentViewer({elements:depthFailureParts.elements,invoke:async(command,args)=>{
  depthFailureCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json") {
    if(args.parentScopeId===null) return {scopeId:100,parentScopeId:null,sourceNodeId:77,root:depthFailureRoot(1),depth:1,maxDepth:5,parsedBytes:10,cumulativeBytes:10,sessionRevision:9};
    if(args.parentScopeId===104) throw {code:"invalid_request",message:"nested JSON depth limit reached"};
    const depth=args.parentScopeId-99;
    const nextDepth=depth+1;
    return {scopeId:99+nextDepth,parentScopeId:args.parentScopeId,sourceNodeId:args.nodeId,root:depthFailureRoot(nextDepth),depth:nextDepth,maxDepth:5,parsedBytes:10,cumulativeBytes:10*nextDepth,sessionRevision:9};
  }
  if(command==="get_children") {
    const depth=args.scopeId-99;
    return {nodes:[depthFailureChild(depth)],hasMore:false,nextCursor:null};
  }
  if(command==="read_decoded_text") return {start:0,text:"1234567890",hasMore:false,nextOffset:null};
  if(command==="read_raw_slice") return {start:args.sourceStart,text:"12345678",hasMore:false,nextOffset:null};
  if(command==="close_nested_scope") return undefined;
  throw new Error("unexpected depth failure command "+command);
}});
await depthFailureViewer.open(depthFailureTarget,depthFailureParts.elements.close);
await settle();
const descendDepthFailure=async(depth)=>{
  const disclosure=depthFailureParts.elements.nested.parsedTree.querySelector(".tree-disclosure");
  check(disclosure!==null,"Depth failure disclosure is missing at depth "+depth);
  disclosure.click();
  await settle();
  const child=depthFailureParts.elements.nested.parsedTree.querySelector("[data-node-id='"+(2000+depth)+"']");
  check(child!==null,"Depth failure child is missing at depth "+depth);
  child.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));
  await settle();
};
for(let depth=1;depth<5;depth++) await descendDepthFailure(depth);
check(depthFailureParts.elements.range.textContent==="Parsed bytes [0, 10) · depth 5/5","Depth failure setup did not reach depth 5");
const depthFailureFinalDisclosure=depthFailureParts.elements.nested.parsedTree.querySelector(".tree-disclosure");
check(depthFailureFinalDisclosure!==null,"Depth failure final disclosure is missing");
depthFailureFinalDisclosure.click();
await settle();
const depthFailureFinalChild=depthFailureParts.elements.nested.parsedTree.querySelector("[data-node-id='"+2005+"']");
check(depthFailureFinalChild!==null,"Depth failure final child is missing");
const depthFailureTreeBefore=depthFailureParts.elements.nested.parsedTree.textContent;
const depthFailureScopeCallsBefore=depthFailureCalls.filter((call)=>call.command==="close_nested_scope"&&call.args.scopeId===104).length;
depthFailureFinalChild.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));
await settle();
check(depthFailureParts.elements.nested.parsedTree.textContent===depthFailureTreeBefore,"Depth-limit child failure changed the current tree");
check(depthFailureParts.elements.range.textContent==="Parsed bytes [0, 10) · depth 5/5","Depth-limit child failure lost the Parsed range");
check(depthFailureParts.elements.status.textContent==="Parsed nested JSON ready","Depth-limit child failure lost the Parsed status");
check(!depthFailureParts.elements.alert.hidden&&depthFailureParts.elements.alert.textContent.includes("nested JSON depth limit reached"),"Depth-limit child failure did not expose its alert");
check(depthFailureParts.elements.nested.parsedTab.getAttribute("aria-selected")==="true"&&!depthFailureParts.elements.nested.back.hidden,"Depth-limit child failure changed the current frame representation");
check(depthFailureCalls.filter((call)=>call.command==="close_nested_scope"&&call.args.scopeId===104).length===depthFailureScopeCallsBefore,"Depth-limit child failure closed the current scope");
depthFailureParts.elements.nested.decodedTab.click();
await settle();
check(depthFailureParts.elements.status.textContent==="Decoded nested string ready"&&depthFailureParts.elements.content.textContent==="1234567890","Decoded tab was unusable after a local child failure");
depthFailureParts.elements.nested.rawTab.click();
await settle();
check(depthFailureParts.elements.status.textContent==="Raw nested lexeme ready"&&depthFailureParts.elements.content.textContent==="12345678","Raw tab was unusable after a local child failure");
depthFailureParts.elements.nested.parsedTab.click();
await settle();
check(depthFailureParts.elements.range.textContent==="Parsed bytes [0, 10) · depth 5/5"&&depthFailureParts.elements.status.textContent==="Parsed nested JSON ready","Parsed tab did not restore the depth-5 state");
depthFailureViewer.close();
await settle();
depthFailureParts.dialog.remove();

const malformedParts=makeNestedViewer();
const malformedCalls=[];
const malformedViewer=new ContentViewer({elements:malformedParts.elements,invoke:async(command,args)=>{
  malformedCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="open_nested_json") return {scopeId:3,parentScopeId:null,sourceNodeId:7,root:nestedRoot,depth:1,maxDepth:5,parsedBytes:2*1024*1024+1,cumulativeBytes:2*1024*1024+1,sessionRevision:9};
  if(command==="close_nested_scope") return undefined;
  throw new Error("unexpected malformed command "+command);
}});
await malformedViewer.open(nestedTarget,malformedParts.elements.close);
await settle();
check(malformedParts.elements.alert.textContent.includes("scope response was invalid"),"Nested oversized scope was not rejected");
check(malformedCalls.filter((call)=>call.command==="close_nested_scope"&&call.args.scopeId===3).length===1,"Malformed successful nested scope was not best-effort closed");
malformedViewer.close();
malformedParts.dialog.remove();

const htmlDocumentIds=[
  "content-viewer-html-representations","content-viewer-html-preview-tab","content-viewer-html-source-tab",
  "content-viewer-html-preview-panel","content-viewer-html-preview-frame"
];
for(const id of htmlDocumentIds) check(document.getElementById(id)!==null,"document is missing "+id);
const htmlDocumentRepresentations=document.getElementById("content-viewer-html-representations");
const htmlDocumentPreviewTab=document.getElementById("content-viewer-html-preview-tab");
const htmlDocumentSourceTab=document.getElementById("content-viewer-html-source-tab");
const htmlDocumentPreviewPanel=document.getElementById("content-viewer-html-preview-panel");
const htmlDocumentPreviewFrame=document.getElementById("content-viewer-html-preview-frame");
check(htmlDocumentRepresentations?.getAttribute("role")==="tablist"&&htmlDocumentRepresentations?.getAttribute("aria-label")==="HTML representations","HTML representation tablist ARIA contract changed");
check(htmlDocumentPreviewTab?.textContent==="Preview"&&htmlDocumentSourceTab?.textContent==="Source","HTML tab labels changed");
check(htmlDocumentPreviewTab?.getAttribute("role")==="tab"&&htmlDocumentPreviewTab?.getAttribute("aria-controls")==="content-viewer-html-preview-panel","HTML Preview tab ARIA contract changed");
check(htmlDocumentSourceTab?.getAttribute("role")==="tab"&&htmlDocumentSourceTab?.getAttribute("aria-controls")==="content-viewer-text-panel","HTML Source tab ARIA contract changed");
check(htmlDocumentPreviewPanel?.getAttribute("role")==="tabpanel"&&htmlDocumentPreviewPanel?.getAttribute("aria-labelledby")==="content-viewer-html-preview-tab","HTML Preview panel ARIA contract changed");
check(htmlDocumentPreviewFrame?.getAttribute("title")==="Isolated HTML preview"&&htmlDocumentPreviewFrame?.getAttribute("sandbox")===""&&htmlDocumentPreviewFrame?.getAttribute("referrerpolicy")==="no-referrer","HTML iframe isolation attributes changed");
check(!htmlDocumentPreviewFrame?.hasAttribute("src")&&!htmlDocumentPreviewFrame?.hasAttribute("allow"),"HTML iframe exposes src or allow attributes");
check(htmlDocumentPreviewFrame?.className==="content-viewer-html-preview-frame","HTML iframe class does not match the real DOM contract");

const makeHtmlViewer=()=>{
  const parts=makeNestedViewer();
  const element=(tag)=>document.createElement(tag);
  const realPreviewFrame=document.getElementById("content-viewer-html-preview-frame");
  const representations=element("div");
  const previewTab=element("button");
  const sourceTab=element("button");
  const previewPanel=element("section");
  const previewFrame=element("iframe");
  const shell=parts.dialog.querySelector(".content-viewer-shell");
  const stage=parts.dialog.querySelector(".content-viewer-stage");
  representations.className="html-representations";
  representations.setAttribute("role","tablist");
  representations.setAttribute("aria-label","HTML representations");
  previewTab.className="view-tab";
  previewTab.setAttribute("role","tab");
  previewTab.setAttribute("aria-controls","html-preview-panel-test");
  previewTab.textContent="Preview";
  sourceTab.className="view-tab";
  sourceTab.setAttribute("role","tab");
  sourceTab.setAttribute("aria-controls","content-viewer-text-panel");
  sourceTab.textContent="Source";
  previewPanel.className="content-viewer-html-preview-panel";
  previewPanel.id="html-preview-panel-test";
  previewFrame.className=realPreviewFrame?.className??"";
  previewPanel.setAttribute("role","tabpanel");
  previewPanel.setAttribute("aria-labelledby","html-preview-tab-test");
  previewTab.id="html-preview-tab-test";
  previewFrame.title="Isolated HTML preview";
  previewFrame.setAttribute("sandbox","");
  previewFrame.setAttribute("referrerpolicy","no-referrer");
  representations.append(previewTab,sourceTab);
  previewPanel.append(previewFrame);
  shell?.insertBefore(representations,parts.elements.rendererNote);
  stage?.append(previewPanel);
  parts.elements.html={representations,previewTab,sourceTab,previewPanel,previewFrame};
  return parts;
};
const htmlSourceA="A".repeat(128*1024);
const htmlSourceB="B".repeat(128*1024);
const htmlSource=htmlSourceA+htmlSourceB;
const htmlSourceBytes=new TextEncoder().encode(htmlSource).byteLength;
const htmlTarget={revision:11,nodeId:42,spanStart:500,spanEnd:500+htmlSourceBytes,scopeId:null,scopeLabel:"Document",pathSegments:["$","html"],pathTruncated:false};
const htmlCalls=[];
const htmlInvoke=async(command,args)=>{
  htmlCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") return {html:"<article><h1>safe preview</h1></article>",reason:null};
  if(command==="read_decoded_text") {
    if(args.offset===0) return {start:0,text:htmlSourceA,hasMore:true,nextOffset:htmlSourceA.length};
    if(args.offset===htmlSourceA.length) return {start:args.offset,text:htmlSourceB,hasMore:false,nextOffset:null};
  }
  throw new Error("unexpected HTML command "+command);
};
const htmlParts=makeHtmlViewer();
const htmlViewer=new ContentViewer({elements:htmlParts.elements,invoke:htmlInvoke});
await htmlViewer.open(htmlTarget,htmlParts.elements.close);
await settle();
check(htmlCalls.map((call)=>call.command).join("→")==="get_string_detection→get_html_preview","HTML initial IPC sequence changed");
check(htmlCalls.filter((call)=>call.command==="read_decoded_text").length===0,"successful HTML Preview read decoded source eagerly");
check(htmlParts.elements.html.previewTab.getAttribute("aria-selected")==="true"&&!htmlParts.elements.html.sourceTab.disabled,"HTML Preview did not default active");
const expectedCsp="default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline';";
check(htmlParts.elements.html.previewFrame.srcdoc.includes(expectedCsp),"HTML Preview did not install the exact CSP");
check(htmlParts.elements.html.previewFrame.srcdoc.includes("<article><h1>safe preview</h1></article>"),"HTML Preview did not use core sanitized HTML");
check(htmlParts.elements.html.previewFrame.getAttribute("sandbox")===""&&!htmlParts.elements.html.previewFrame.hasAttribute("src")&&!htmlParts.elements.html.previewFrame.hasAttribute("allow"),"HTML Preview iframe isolation contract changed");
check(htmlParts.elements.rendererNote.textContent==="Isolated HTML Preview · Opaque origin · scripts, network, forms, navigation, file access and application IPC blocked.","HTML Preview security note is not exact");
check(htmlParts.elements.html.previewPanel.hidden===false&&htmlParts.elements.nested.representations.hidden,"HTML and Nested tablists are not mutually exclusive");
htmlParts.elements.html.previewTab.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
check(document.activeElement===htmlParts.elements.html.sourceTab,"HTML ArrowRight did not move focus without activation");
htmlParts.elements.html.sourceTab.click();
await settle();
check(htmlCalls.filter((call)=>call.command==="read_decoded_text").length===1,"HTML Source did not lazily read exactly once");
  check(htmlParts.elements.html.sourceTab.getAttribute("aria-selected")==="true"&&htmlParts.elements.html.previewPanel.hidden,"HTML Source did not activate its shared text panel");
  check(htmlParts.elements.content.textContent===htmlSourceA&&htmlParts.elements.next.disabled===false,"HTML Source first page is wrong");
  check(htmlParts.elements.range.textContent==="[0, "+new TextEncoder().encode(htmlSourceA).byteLength+")","HTML Source first page range is wrong");
  const htmlCallsAfterSource=htmlCalls.length;
  htmlParts.elements.html.previewTab.click();
  await settle();
  check(htmlCalls.length===htmlCallsAfterSource&&htmlParts.elements.html.previewFrame.srcdoc.includes("safe preview"),"switching HTML Source to Preview repeated IPC or lost preview");
  check(htmlParts.elements.range.textContent==="—","HTML Preview retained the Source range");
  htmlParts.elements.html.sourceTab.click();
  await settle();
  check(htmlCalls.length===htmlCallsAfterSource&&htmlParts.elements.content.textContent===htmlSourceA,"switching HTML Preview to Source did not use its page cache");
  check(htmlParts.elements.range.textContent==="[0, "+new TextEncoder().encode(htmlSourceA).byteLength+")","switching HTML Preview to Source did not restore the Source range");
htmlParts.elements.next.click();
await settle();
check(htmlParts.elements.content.textContent===htmlSourceB,"HTML Source did not load the second page");
const htmlCallsAfterSecondPage=htmlCalls.length;
htmlParts.elements.previous.click();
await settle();
check(htmlParts.elements.content.textContent===htmlSourceA&&htmlCalls.length===htmlCallsAfterSecondPage,"HTML Source previous page did not use cache");
htmlViewer.close();
await settle();
check(htmlParts.elements.html.previewFrame.srcdoc==="","HTML close did not clear iframe srcdoc");
htmlParts.dialog.remove();

const singleHtmlSource="<article>single-page source</article>";
const singleHtmlParts=makeHtmlViewer();
const singleHtmlCalls=[];
const singleHtmlViewer=new ContentViewer({elements:singleHtmlParts.elements,invoke:async(command,args)=>{
  singleHtmlCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") return {html:"<article>single-page preview</article>",reason:null};
  if(command==="read_decoded_text") return {start:0,text:singleHtmlSource,hasMore:false,nextOffset:null};
  throw new Error("unexpected single-page HTML command "+command);
}});
const singleHtmlTarget={...htmlTarget,nodeId:45,spanStart:0,spanEnd:new TextEncoder().encode(singleHtmlSource).byteLength};
await singleHtmlViewer.open(singleHtmlTarget,singleHtmlParts.elements.close);
await settle();
singleHtmlParts.elements.html.sourceTab.click();
await settle();
const singleHtmlCallsAfterSource=singleHtmlCalls.length;
const singleHtmlRange="[0, "+new TextEncoder().encode(singleHtmlSource).byteLength+")";
check(singleHtmlParts.elements.content.textContent===singleHtmlSource&&singleHtmlParts.elements.range.textContent===singleHtmlRange,"single-page HTML Source did not load its terminal page");
singleHtmlParts.elements.html.previewTab.click();
await settle();
check(singleHtmlCalls.length===singleHtmlCallsAfterSource&&singleHtmlParts.elements.html.previewFrame.srcdoc.includes("single-page preview"),"single-page HTML Source to Preview repeated IPC or lost Preview");
singleHtmlParts.elements.html.sourceTab.click();
await settle();
check(singleHtmlCalls.length===singleHtmlCallsAfterSource&&singleHtmlParts.elements.content.textContent===singleHtmlSource&&singleHtmlParts.elements.range.textContent===singleHtmlRange,"single-page HTML Preview to Source did not restore cached text and range");
singleHtmlViewer.close();
await settle();
singleHtmlParts.dialog.remove();

const waitForFrameLoad=async(frame,marker,label,timeoutMs=3000)=>{
  await new Promise((resolve,reject)=>{
    let timer;
    const onLoad=()=>{
      if(!frame.srcdoc.includes(marker)) return;
      clearTimeout(timer);
      frame.removeEventListener("load",onLoad);
      resolve();
    };
    timer=setTimeout(()=>{
      frame.removeEventListener("load",onLoad);
      reject(new Error(label+" iframe did not emit load for the current srcdoc within "+timeoutMs+" ms"));
    },timeoutMs);
    frame.addEventListener("load",onLoad);
  });
};
const hostileParts=makeHtmlViewer();
const hostileCalls=[];
const hostileViewer=new ContentViewer({elements:hostileParts.elements,invoke:async(command,args)=>{
  hostileCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") return {html:fixtures.htmlSource,reason:null};
  throw new Error("unexpected hostile command "+command);
}});
const hostileFrame=hostileParts.elements.html.previewFrame;
const hostileFrameLoad=waitForFrameLoad(hostileFrame,fixtures.truth.probeToken,"hostile");
let hostileMessages=0;
const hostileMessageHandler=(event)=>{if(event.data===fixtures.truth.probeToken) hostileMessages+=1;};
window.addEventListener("message",hostileMessageHandler);
const hostBodyBefore=window.document.body.getAttribute("data-f11-probe");
const hostTopBefore=window.location.href;
let hostTauriCalls=0;
const previousTauri=window.__TAURI_INTERNALS__;
window.__TAURI_INTERNALS__={invoke:()=>{hostTauriCalls+=1;}};
await hostileViewer.open({...htmlTarget,nodeId:43},hostileParts.elements.close);
await settle();
await hostileFrameLoad;
check(hostileFrame.srcdoc.includes("<script")&&hostileFrame.getAttribute("sandbox")===""&&(!hostileFrame.hasAttribute("allow-scripts")&&!hostileFrame.hasAttribute("allow-same-origin")),"hostile core HTML was not placed behind empty sandbox");
check(hostileFrame.srcdoc.includes(expectedCsp),"hostile HTML lost the exact CSP second boundary");
check(hostileFrame.srcdoc.includes(fixtures.htmlSource),"hostile HTML DTO did not use the complete F-11 fixture source");
check(!Object.prototype.hasOwnProperty.call(window,"__sjvProbe"),"hostile HTML polluted the host window");
check(hostileMessages===0,"hostile HTML delivered a probe postMessage to the host");
check(hostTauriCalls===0,"hostile HTML reached the host Tauri probe");
check(window.document.body.getAttribute("data-f11-probe")===hostBodyBefore,"hostile HTML mutated the host DOM");
check(window.location.href===hostTopBefore,"hostile HTML navigated the top window");
check(hostileCalls.filter((call)=>call.command==="read_decoded_text").length===0,"hostile HTML Preview read decoded source eagerly");
window.removeEventListener("message",hostileMessageHandler);
if(previousTauri===undefined) delete window.__TAURI_INTERNALS__; else window.__TAURI_INTERNALS__=previousTauri;
hostileViewer.clear();
await settle();
check(hostileFrame.srcdoc==="","HTML clear did not clear iframe srcdoc");
hostileParts.dialog.remove();

const limitCases=[
  ["sizeLimit","HTML Preview disabled because content exceeds 512 KiB."],
  ["renderLimit","Semantic rendering failed. Showing plain text instead."],
  ["malformed","Semantic rendering failed. Showing plain text instead."]
];
for(const [caseId,expectedNote] of limitCases){
  const parts=makeHtmlViewer();
  const calls=[];
  const viewer=new ContentViewer({elements:parts.elements,invoke:async(command,args)=>{
    calls.push({command,args});
    if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
    if(command==="get_html_preview") return caseId==="malformed"?{html:7,reason:null}:{html:null,reason:caseId==="sizeLimit"?"sizeLimit":"renderLimit"};
    if(command==="read_decoded_text") return {start:0,text:"<p>source fallback</p>",hasMore:false,nextOffset:null};
    throw new Error("unexpected limit command "+command);
  }});
  await viewer.open({...htmlTarget,nodeId:50+limitCases.findIndex((entry)=>entry[0]===caseId)},parts.elements.close);
  await settle();
  check(parts.elements.html.sourceTab.getAttribute("aria-selected")==="true"&&parts.elements.html.previewPanel.hidden,"HTML "+caseId+" did not fall back to Source");
  check(parts.elements.html.previewTab.disabled,"HTML "+caseId+" left Preview bypass enabled");
  check(parts.elements.rendererNote.textContent===expectedNote,"HTML "+caseId+" note changed");
  check(parts.elements.content.textContent==="<p>source fallback</p>","HTML "+caseId+" lost Source text");
  check(calls.map((call)=>call.command).join("→")==="get_string_detection→get_html_preview→read_decoded_text","HTML "+caseId+" IPC sequence changed");
  viewer.close();
  await settle();
  parts.dialog.remove();
}

const unicodePage0="😀".repeat(32768);
const unicodePage1="é".repeat(65536);
const unicodePageBytes=128*1024;
const unicodeSource=unicodePage0+unicodePage1;
const unicodeParts=makeHtmlViewer();
const unicodeCalls=[];
const unicodeViewer=new ContentViewer({elements:unicodeParts.elements,invoke:async(command,args)=>{
  unicodeCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") return {html:null,reason:"sizeLimit"};
  if(command==="read_decoded_text") {
    if(args.offset===0) return {start:0,text:unicodePage0,hasMore:true,nextOffset:unicodePageBytes};
    if(args.offset===unicodePageBytes) return {start:unicodePageBytes,text:unicodePage1,hasMore:false,nextOffset:null};
  }
  throw new Error("unexpected Unicode paging command "+command);
}});
const unicodeTarget={revision:12,nodeId:44,spanStart:700,spanEnd:700+new TextEncoder().encode(unicodeSource).byteLength,scopeId:null,scopeLabel:"Document",pathSegments:["$","unicode"],pathTruncated:false};
await unicodeViewer.open(unicodeTarget,unicodeParts.elements.close);
await settle();
check(new TextEncoder().encode(unicodePage0).byteLength===unicodePageBytes&&new TextEncoder().encode(unicodePage1).byteLength===unicodePageBytes,"Unicode page fixture is not exactly 128 KiB per page");
check(unicodeCalls[2]?.command==="read_decoded_text"&&unicodeCalls[2].args.offset===0&&unicodeCalls[2].args.length===unicodePageBytes,"Unicode Source did not request page 0 with byte offsets");
check(unicodeParts.elements.content.textContent===unicodePage0&&!unicodeParts.elements.content.textContent.includes("�"),"Unicode page 0 was truncated or replaced");
unicodeParts.elements.next.click();
await settle();
check(unicodeCalls[3]?.command==="read_decoded_text"&&unicodeCalls[3].args.offset===unicodePageBytes&&unicodeCalls[3].args.length===unicodePageBytes,"Unicode Source did not request page 1 with the exact byte offset");
check(unicodeParts.elements.content.textContent===unicodePage1&&!unicodeParts.elements.content.textContent.includes("�"),"Unicode page 1 was truncated or replaced");
check(unicodePage0+unicodePage1===unicodeSource,"Unicode paging fixture has an overlap or omission");
const unicodeCallsAfterNext=unicodeCalls.length;
unicodeParts.elements.previous.click();
await settle();
check(unicodeCalls.length===unicodeCallsAfterNext&&unicodeParts.elements.content.textContent===unicodePage0&&!unicodeParts.elements.content.textContent.includes("�"),"Unicode Previous reread or corrupted page 0");
unicodeViewer.close();
await settle();
unicodeParts.dialog.remove();

const invalidHtmlDtos=[
  ["oversized",{html:"x".repeat(1024*1024),reason:null}],
  ["both",{html:"<p>preview</p>",reason:"renderLimit"}],
  ["neither",{html:null,reason:null}],
  ["extra",{html:null,reason:"sizeLimit",unexpected:true}]
];
for(const [caseId,dto] of invalidHtmlDtos){
  const parts=makeHtmlViewer();
  const calls=[];
  const viewer=new ContentViewer({elements:parts.elements,invoke:async(command,args)=>{
    calls.push({command,args});
    if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
    if(command==="get_html_preview") return dto;
    if(command==="read_decoded_text") return {start:0,text:"invalid DTO source fallback",hasMore:false,nextOffset:null};
    throw new Error("unexpected invalid DTO command "+command);
  }});
  await viewer.open({...htmlTarget,nodeId:60+invalidHtmlDtos.findIndex((entry)=>entry[0]===caseId)},parts.elements.close);
  await settle();
  check(parts.elements.html.sourceTab.getAttribute("aria-selected")==="true"&&parts.elements.html.previewPanel.hidden&&parts.elements.html.previewTab.disabled,"HTML "+caseId+" DTO did not force Source fallback");
  check(parts.elements.content.textContent==="invalid DTO source fallback"&&parts.elements.rendererNote.textContent==="Semantic rendering failed. Showing plain text instead.","HTML "+caseId+" DTO lost the fallback source or note");
  check(calls.map((call)=>call.command).join("→")==="get_string_detection→get_html_preview→read_decoded_text","HTML "+caseId+" DTO IPC sequence changed");
  viewer.close();
  await settle();
  parts.dialog.remove();
}

const ordinaryFailureParts=makeHtmlViewer();
const ordinaryFailureCalls=[];
let ordinaryFailureSessionError;
const ordinaryFailureViewer=new ContentViewer({elements:ordinaryFailureParts.elements,onSessionError:(error)=>{ordinaryFailureSessionError=error;},invoke:async(command,args)=>{
  ordinaryFailureCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") throw {code:"preview_failed",message:"preview unavailable"};
  if(command==="read_decoded_text") return {start:0,text:"ordinary failure source",hasMore:false,nextOffset:null};
  throw new Error("unexpected ordinary failure command "+command);
}});
await ordinaryFailureViewer.open({...htmlTarget,nodeId:75},ordinaryFailureParts.elements.close);
await settle();
check(ordinaryFailureParts.elements.html.sourceTab.getAttribute("aria-selected")==="true"&&ordinaryFailureParts.elements.html.previewPanel.hidden,"ordinary get_html_preview failure did not fall back to Source");
check(ordinaryFailureParts.elements.content.textContent==="ordinary failure source"&&ordinaryFailureParts.elements.rendererNote.textContent==="Semantic rendering failed. Showing plain text instead.","ordinary HTML preview failure lost Source fallback");
check(ordinaryFailureSessionError===undefined&&ordinaryFailureCalls.map((call)=>call.command).join("→")==="get_string_detection→get_html_preview→read_decoded_text","ordinary HTML preview failure was misclassified as a session failure");
ordinaryFailureViewer.close();
await settle();
ordinaryFailureParts.dialog.remove();

const sourceChangedParts=makeHtmlViewer();
const sourceChangedCalls=[];
let sourceChangedSessionError;
const sourceChangedViewer=new ContentViewer({elements:sourceChangedParts.elements,onSessionError:(error)=>{sourceChangedSessionError=error;},invoke:async(command,args)=>{
  sourceChangedCalls.push({command,args});
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") return {html:"<article>preview before change</article>",reason:null};
  if(command==="read_decoded_text") throw {code:"file_changed",message:"the file changed on disk"};
  throw new Error("unexpected Source file_changed command "+command);
}});
await sourceChangedViewer.open({...htmlTarget,nodeId:76},sourceChangedParts.elements.close);
await settle();
check(sourceChangedParts.elements.html.previewFrame.srcdoc.includes("preview before change"),"HTML Source file_changed setup did not install Preview");
sourceChangedParts.elements.html.sourceTab.click();
await settle();
check(sourceChangedSessionError?.code==="file_changed"&&!sourceChangedViewer.isOpen&&sourceChangedParts.elements.html.previewFrame.srcdoc==="","HTML Source file_changed did not clear srcdoc and invalidate the session");
check(sourceChangedCalls.map((call)=>call.command).join("→")==="get_string_detection→get_html_preview→read_decoded_text","HTML Source file_changed IPC sequence changed");
sourceChangedParts.dialog.remove();

const cachePageBytes=128*1024;
const cachePageCount=257;
const cacheTotalBytes=cachePageBytes*cachePageCount;
const cachePage=(index)=>{
  const marker="CACHE_PAGE_"+index+":";
  return marker+".".repeat(cachePageBytes-marker.length);
};
const cacheParts=makeViewer();
const cacheReadOffsets=[];
const cacheBodyChildren=()=>document.body.childElementCount;
const cacheViewer=new ContentViewer({elements:cacheParts.elements,invoke:async(command,args)=>{
  if(command==="get_string_detection") return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};
  if(command==="read_decoded_text") {
    cacheReadOffsets.push(args.offset);
    const index=args.offset/cachePageBytes;
    if(!Number.isInteger(index)||index<0||index>=cachePageCount||args.length!==cachePageBytes) throw new Error("unexpected cache page request");
    return {start:args.offset,text:cachePage(index),hasMore:index<cachePageCount-1,nextOffset:index<cachePageCount-1?args.offset+cachePageBytes:null};
  }
  throw new Error("unexpected decoded cache command "+command);
}});
const cacheTarget={revision:13,nodeId:77,spanStart:0,spanEnd:cacheTotalBytes,scopeId:null,scopeLabel:"Document",pathSegments:["$","cache"],pathTruncated:false};
const cacheBodyBefore=cacheBodyChildren();
await cacheViewer.open(cacheTarget,cacheParts.elements.close);
await settle();
for(let index=1;index<cachePageCount;index++){
  cacheParts.elements.next.click();
  await settle();
}
check(cacheReadOffsets.length===cachePageCount&&cacheReadOffsets.at(-1)===(cachePageCount-1)*cachePageBytes,"bounded cache setup did not fetch each 128 KiB page");
check(new TextEncoder().encode(cacheParts.elements.content.textContent).byteLength<=cachePageBytes&&cacheParts.elements.content.textContent.startsWith("CACHE_PAGE_256:"),"bounded cache navigation materialized an oversized DOM");
for(let index=cachePageCount-1;index>0;index--){
  cacheParts.elements.previous.click();
  await settle();
}
check(cacheParts.elements.content.textContent.startsWith("CACHE_PAGE_0:")&&cacheReadOffsets.filter((offset)=>offset===0).length===2,"bounded cache did not evict page 0 for an IPC refetch");
check(cacheBodyChildren()===cacheBodyBefore&&new TextEncoder().encode(cacheParts.elements.content.textContent).byteLength<=cachePageBytes,"bounded cache grew the DOM beyond one page");
cacheViewer.close();
await settle();
cacheParts.dialog.remove();

const lateParts=makeHtmlViewer();
let resolveLate;
const latePromise=new Promise((resolve)=>{resolveLate=resolve;});
const lateViewer=new ContentViewer({elements:lateParts.elements,invoke:async(command)=>{
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") return latePromise;
  throw new Error("unexpected late command");
}});
const lateOpen=lateViewer.open({...htmlTarget,nodeId:80},lateParts.elements.close);
await settle();
lateViewer.clear();
resolveLate({html:"<script>window.__sjvLate=1</script>",reason:null});
await lateOpen;
await settle();
check(lateParts.elements.html.previewFrame.srcdoc===""&&lateParts.elements.content.textContent==="","late HTML response repopulated a cleared viewer");
lateParts.dialog.remove();

const errorParts=makeHtmlViewer();
let sessionError;
const errorViewer=new ContentViewer({elements:errorParts.elements,onSessionError:(error)=>{sessionError=error;},invoke:async(command)=>{
  if(command==="get_string_detection") return {semanticType:"html",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_html_preview") throw {code:"file_changed",message:"the file changed on disk"};
  throw new Error("unexpected error command");
}});
await errorViewer.open({...htmlTarget,nodeId:90},errorParts.elements.close);
await settle();
check(sessionError?.code==="file_changed"&&errorParts.elements.html.previewFrame.srcdoc===""&&!errorViewer.isOpen,"HTML global error did not invalidate the viewer");
errorParts.dialog.remove();
return {assertions};
})()`;
}

const layoutExpression = `(()=>{
const dialog=document.getElementById("content-viewer-dialog");
const stage=document.querySelector("#content-viewer-dialog .content-viewer-stage");
const panel=document.getElementById("content-viewer-html-preview-panel");
const frame=document.getElementById("content-viewer-html-preview-frame");
const htmlTabs=document.getElementById("content-viewer-html-representations");
const parsed=document.getElementById("content-viewer-parsed-panel");
const text=document.getElementById("content-viewer-text-panel");
if(!dialog||!stage||!panel||!frame||!htmlTabs||!parsed||!text) throw new Error("real HTML layout nodes are missing");
const wasOpen=dialog.open;
const hidden=new Map([[htmlTabs,htmlTabs.hidden],[panel,panel.hidden],[parsed,parsed.hidden],[text,text.hidden]]);
if(!wasOpen) dialog.showModal();
htmlTabs.hidden=false;
panel.hidden=false;
parsed.hidden=true;
text.hidden=true;
const rect=(element)=>{const value=element.getBoundingClientRect();return {left:value.left,top:value.top,right:value.right,bottom:value.bottom,width:value.width,height:value.height,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight};};
const computed=getComputedStyle(frame);
const result={viewportWidth:innerWidth,viewportHeight:innerHeight,dialog:rect(dialog),stage:rect(stage),panel:rect(panel),frame:rect(frame),frameClass:frame.className,computed:{display:computed.display,width:computed.width,height:computed.height,minWidth:computed.minWidth,minHeight:computed.minHeight,flex:computed.flex},document:{scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,bodyScrollWidth:document.body.scrollWidth,bodyClientWidth:document.body.clientWidth}};
for(const [element,value] of hidden) element.hidden=value;
if(!wasOpen) dialog.close();
return result;
})()`;

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
  await runAgent(["network","har","start"]);
  harStarted = true;
  const result = parseAgentJson((await runAgent(["eval", browserExpression(fixtures, commonSource)])).stdout);
  await runAgent(["network","har","stop",harPath]);
  harStarted = false;
  assertions += result.assertions;
  for (const width of [320,768,1024,1440]) {
    await runAgent(["set","viewport",String(width),"900"]);
    const layout = parseAgentJson((await runAgent(["eval",layoutExpression])).stdout);
    const epsilon = 1.5;
    check(layout.viewportWidth === width, `responsive layout used the wrong viewport width ${layout.viewportWidth}`);
    check(layout.frameClass === "content-viewer-html-preview-frame", `responsive ${width}px iframe class drifted from the real DOM`);
    check(layout.panel.width > 0 && layout.panel.height > 0 && layout.frame.width > 0 && layout.frame.height > 0, `responsive ${width}px HTML panel/frame is not visible`);
    check(Math.abs(layout.frame.left-layout.panel.left)<=epsilon&&Math.abs(layout.frame.right-layout.panel.right)<=epsilon, `responsive ${width}px iframe does not fill the panel horizontally`);
    check(Math.abs(layout.frame.top-layout.panel.top)<=epsilon&&Math.abs(layout.frame.bottom-layout.panel.bottom)<=epsilon, `responsive ${width}px iframe does not fill the panel vertically`);
    check(layout.panel.scrollWidth<=layout.panel.clientWidth+epsilon&&layout.stage.scrollWidth<=layout.stage.clientWidth+epsilon&&layout.dialog.scrollWidth<=layout.dialog.clientWidth+epsilon, `responsive ${width}px HTML layout has horizontal overflow`);
    check(layout.document.scrollWidth<=layout.document.clientWidth+epsilon&&layout.document.bodyScrollWidth<=layout.document.bodyClientWidth+epsilon, `responsive ${width}px document has horizontal overflow`);
    check(Math.abs(Number.parseFloat(layout.computed.width)-layout.frame.width)<=epsilon&&Math.abs(Number.parseFloat(layout.computed.height)-layout.frame.height)<=epsilon, `responsive ${width}px computed iframe size disagrees with its bounds`);
  }
  const har = JSON.parse(await readFile(harPath,"utf8"));
  const entries = harEntries(har);
  const requestUrls = entries.map((entry)=>entry?.request?.url).filter((url)=>typeof url === "string");
  const sentinels = fixtures.truth.cases.flatMap((fixtureCase)=>fixtureCase.vectors.map((vector)=>vector.sentinel));
  const hostileUrls = requestUrls.filter((url)=>/\.invalid(?:[/:?#]|$)/i.test(url)||sentinels.some((sentinel)=>url.startsWith(sentinel)));
  const hostileHttpUrls = requestUrls.filter((url)=>/^https?:\/\//i.test(url)&&(/\.invalid(?:[/:?#]|$)/i.test(url)||sentinels.some((sentinel)=>url.startsWith(sentinel))));
  const dataUrls = requestUrls.filter((url)=>url.startsWith("data:"));
  check(hostileUrls.length===0, `HAR observed hostile .invalid/sentinel requests: ${hostileUrls.join(", ")}`);
  check(hostileHttpUrls.length===0, `HAR observed hostile http resource requests: ${hostileHttpUrls.join(", ")}`);
  check(dataUrls.length===0, `HAR observed data: resource requests: ${dataUrls.join(", ")}`);
  console.log(`PASS: HTML HAR entries=${entries.length} hostileRequests=${hostileUrls.length} hostileHttpRequests=${hostileHttpUrls.length} dataRequests=${dataUrls.length}`);
  console.log(`PASS: safe markdown assertions=${assertions}`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (harStarted) await runAgent(["network","har","stop",harPath], true).catch(() => undefined);
  await runAgent(["close"], true).catch(() => undefined);
  await stopProcess(vite);
}
