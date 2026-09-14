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
const session = `sjv-content-wrap-${process.pid}`;

async function freePort() {
  const probe = createServer();
  await new Promise((resolveResult, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveResult);
  });
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
    const detail = [error?.stderr, error?.stdout]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n")
      .trim();
    throw new Error(`agent-browser ${args[0] ?? "command"} failed${detail ? `: ${detail.slice(-4000)}` : ""}`);
  }
}

function browserTest() {
  return `(async()=>{
const {ContentViewer}=await import("/src/content-viewer.ts");
const {TextLineView}=await import("/src/text-line-view.ts");
let assertions=0;
const check=(value,message)=>{assertions+=1;if(!value)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const utf8=(value)=>new TextEncoder().encode(value).byteLength;
const target=(revision,nodeId,text,scopeId=null)=>({revision,nodeId,spanStart:100,spanEnd:100+utf8(text),scopeId,scopeLabel:scopeId===null?"Document root":"Nested",pathSegments:["$","content"],pathTruncated:false});
const sliceByUtf8=(source,start,length)=>{let offset=0;let result="";for(const character of source){const size=utf8(character);if(offset<start){offset+=size;continue;}if(offset+size-start>length)break;result+=character;offset+=size;}return result;};
const makeViewer=(invoke,{nested=false}={})=>{
  const host=document.createElement("div");
  host.innerHTML='<dialog id="dialog"><button id="close" type="button">Close</button><h1 id="title"></h1><div class="content-viewer-meta"><dl><div><dt>Scope</dt><dd id="scope"></dd></div></dl></div><div id="path"></div><div id="node"></div><div id="span-label"></div><div id="span"></div><div id="semantic"></div><div id="detection"></div><div id="plain"></div><div id="representation"></div><div id="note"></div><div id="range"></div><div id="status"></div><div id="alert"></div><div id="tabs"><button id="rendered" type="button">Rendered</button><button id="decoded" type="button">Decoded</button><button id="raw" type="button">Raw</button></div><select id="render-as"><option value="auto">Auto</option><option value="plainText">Plain Text</option><option value="markdown">Markdown</option><option value="nestedJson">Nested JSON</option><option value="code">Code Auto</option><option value="javascript">JavaScript</option></select><form id="search" role="search"><input id="query" type="search"><input id="search-decoded" type="radio" name="rep" checked><input id="search-raw" type="radio" name="rep"><button id="submit" type="submit">Search</button><p id="description"></p></form><div id="results-panel"><div id="search-status"></div><div id="results"></div><button id="prev" type="button">Previous</button><button id="next-search" type="button">Next</button></div><div id="wrap-controls" role="group" aria-label="Text wrapping"><button id="wrap" type="button">Wrap</button><button id="no-wrap" type="button">No Wrap</button></div><div class="content-viewer-body"><div class="content-viewer-content" id="content" tabindex="0"></div></div><button id="previous" type="button">Previous page</button><button id="next-page" type="button">Next page</button></dialog>';
  if(nested)host.querySelector("dialog").insertAdjacentHTML("beforeend",'<div id="nested-nav"><button id="back" type="button">Back</button><ol id="crumb"></ol></div><div id="nested-tabs"><button id="parsed" type="button">Parsed</button><button id="nested-decoded" type="button">Decoded String</button><button id="nested-raw" type="button">Raw Lexeme</button></div><section id="parsed-panel"><div id="parsed-tree"></div></section><div id="text-panel"></div>');
  document.body.append(host);
  const body=host.querySelector(".content-viewer-body");body.style.width="280px";body.style.height="120px";body.style.overflow="auto";
  const q=(id)=>host.querySelector("#"+id);
  const elements={dialog:q("dialog"),close:q("close"),title:q("title"),scope:q("scope"),path:q("path"),node:q("node"),spanLabel:q("span-label"),span:q("span"),semanticType:q("semantic"),detectionSource:q("detection"),plainReason:q("plain"),representation:q("representation"),rendererNote:q("note"),range:q("range"),status:q("status"),alert:q("alert"),content:q("content"),previous:q("previous"),next:q("next-page"),renderAs:q("render-as"),wrap:{wrap:q("wrap"),noWrap:q("no-wrap")},string:{representations:q("tabs"),renderedTab:q("rendered"),decodedTab:q("decoded"),rawTab:q("raw")},search:{form:q("search"),query:q("query"),decoded:q("search-decoded"),rawSource:q("search-raw"),submit:q("submit"),description:q("description"),panel:q("search"),resultsPanel:q("results-panel"),status:q("search-status"),results:q("results"),previous:q("prev"),next:q("next-search")}};
  if(nested)elements.nested={navigation:q("nested-nav"),back:q("back"),breadcrumb:q("crumb"),representations:q("nested-tabs"),parsedTab:q("parsed"),decodedTab:q("nested-decoded"),rawTab:q("nested-raw"),parsedPanel:q("parsed-panel"),parsedTree:q("parsed-tree"),sharedTextPanel:q("text-panel")};
  return {host,elements,viewer:new ContentViewer({elements,invoke,onSessionError:(error)=>{throw error;}})};
};

const source="first line\\nneedle "+"x".repeat(1800);
const plainCalls=[];
const plainInvoke=async(command,args)=>{
  plainCalls.push({command,args});
  if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};
  if(command==="get_string_metrics")return {decodedBytes:utf8(source),characterCount:source.length,lineCount:2};
  if(command==="search_current")return {matches:[{nodeId:1,field:"value",pathSegments:["$","content"],pathTruncated:false,sourceSpanStart:100,sourceSpanEnd:100+utf8(source),matchStart:utf8("first line\\n"),matchEnd:utf8("first line\\nneedle") }],hasMore:false,nextCursor:null};
  if(command==="read_raw_slice")return {start:args.sourceStart,text:'"'+source+'"',hasMore:false,nextOffset:null};
  if(command==="read_decoded_text") {const text=sliceByUtf8(source,args.offset,args.length);return {start:args.offset,text,hasMore:args.offset+utf8(text)<utf8(source),nextOffset:args.offset+utf8(text)<utf8(source)?args.offset+utf8(text):null};}
  throw new Error("unexpected plain command "+command);
};
const plain=makeViewer(plainInvoke);
const plainTarget=target(1,1,source);
await plain.viewer.open(plainTarget);await settle();
check(plain.host.querySelector(".content-viewer-nested-depth")?.hidden===true,"Nested depth control was visible outside a Nested frame");
check(plain.elements.wrap.wrap.getAttribute("aria-pressed")==="true","Wrap control did not expose the default pressed state");
check(plain.elements.wrap.noWrap.getAttribute("aria-pressed")==="false","No Wrap control did not expose the default unpressed state");
check(!plain.elements.wrap.wrap.disabled&&!plain.elements.wrap.noWrap.disabled,"Wrap controls stayed disabled for Plain Text");
plain.elements.search.query.value="needle";plain.elements.search.form.requestSubmit();await settle();
const plainRenderedResult=plain.elements.search.results.querySelector("button");
check(plainRenderedResult!==null,"Plain Rendered search did not return a result");
plainRenderedResult.click();await settle();
check(plain.elements.content.querySelector("mark[data-rendered-search=\\"true\\"]")?.textContent==="needle","Plain Rendered search did not reproject and highlight its source hit");
const originalRange=plain.elements.range.textContent;
const originalContent=plain.elements.content.textContent;
plain.elements.wrap.noWrap.focus();plain.elements.wrap.noWrap.click();
check(plain.elements.content.classList.contains("is-no-wrap"),"No Wrap did not change the actual content root");
check(plain.elements.range.textContent===originalRange&&plain.elements.content.textContent===originalContent,"No Wrap changed the current node/span or source text");
check(document.activeElement===plain.elements.wrap.noWrap,"No Wrap did not preserve keyboard focus");
check(getComputedStyle(plain.elements.content).whiteSpace==="pre"&&getComputedStyle(plain.elements.content).overflowWrap==="normal","No Wrap did not disable soft wrapping for Plain Text: "+getComputedStyle(plain.elements.content).whiteSpace+"/"+getComputedStyle(plain.elements.content).overflowWrap);
const plainBody=plain.elements.content.parentElement;
const plainWidth=plainBody.clientWidth;
const plainLine=plainBody.scrollWidth;
check(plainLine>plainWidth,"No Wrap did not expose horizontal overflow for a long Plain Text line: "+plainLine+"/"+plainWidth);
plain.elements.wrap.wrap.click();
check(!plain.elements.content.classList.contains("is-no-wrap")&&getComputedStyle(plain.elements.content).whiteSpace==="pre-wrap","Wrap did not restore soft wrapping");
check(plain.elements.content.scrollHeight>0&&plain.elements.content.getBoundingClientRect().height>0,"Plain Text geometry did not produce measurable content dimensions");
plain.elements.string.decodedTab.click();await settle();
plain.elements.search.query.value="needle";plain.elements.search.form.requestSubmit();await settle();
const plainResult=plain.elements.search.results.querySelector("button");check(plainResult!==null,"Decoded search did not return a real result");plainResult.click();await settle();
check(plain.elements.content.querySelector("mark[data-search-match=\\"true\\"]")?.textContent==="needle","Decoded search did not create the visible hit");
const hitText=plain.elements.content.textContent;const hitRange=plain.elements.range.textContent;plain.elements.wrap.noWrap.click();
check(plain.elements.content.querySelector("mark[data-search-match=\\"true\\"]")?.textContent==="needle"&&plain.elements.content.textContent===hitText&&plain.elements.range.textContent===hitRange,"No Wrap discarded an existing search hit or page offset");
plain.elements.renderAs.value="javascript";plain.elements.renderAs.dispatchEvent(new Event("change"));await settle();
check(plain.elements.content.classList.contains("is-no-wrap"),"Render As reset the viewer-wide No Wrap state");
check(plain.elements.content.querySelector(".sjv-code-source")!==null,"Render As JavaScript did not use the existing Code renderer");
plain.elements.string.rawTab.click();await settle();
check(plain.elements.content.classList.contains("is-no-wrap")&&plain.elements.wrap.noWrap.getAttribute("aria-pressed")==="true","Raw Lexeme did not retain the shared No Wrap state");
plain.viewer.clear(false);plain.host.remove();

const pageSource="P".repeat(131072)+"TAIL";
const pageInvoke=async(command,args)=>{
  if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};
  if(command==="get_string_metrics")return {decodedBytes:utf8(pageSource),characterCount:pageSource.length,lineCount:1};
  if(command==="read_decoded_text"){const text=sliceByUtf8(pageSource,args.offset,args.length);return {start:args.offset,text,hasMore:args.offset+utf8(text)<utf8(pageSource),nextOffset:args.offset+utf8(text)<utf8(pageSource)?args.offset+utf8(text):null};}
  throw new Error("unexpected paging command "+command);
};
const paged=makeViewer(pageInvoke);await paged.viewer.open(target(5,5,pageSource));await settle();
const firstPageRange=paged.elements.range.textContent;check(paged.elements.next.disabled===false,"Plain Text did not expose its next page");paged.elements.wrap.noWrap.click();check(paged.elements.content.classList.contains("is-no-wrap"),"No Wrap did not apply before paging");paged.elements.next.click();await settle();
check(paged.elements.previous.disabled===false&&paged.elements.range.textContent!==firstPageRange,"Next page did not advance the decoded page offset");check(paged.elements.content.classList.contains("is-no-wrap"),"Paging discarded the shared No Wrap state");paged.elements.previous.click();await settle();check(paged.elements.range.textContent===firstPageRange,"Previous page did not restore the original page offset");
paged.viewer.clear(false);paged.host.remove();

const virtualLines=Array.from({length:12000},(_,index)=>"row-"+String(index).padStart(5,"0")+" "+(index===10?"long-"+"x".repeat(500):index===9000?"跨页":"payload"));
const virtualSource=virtualLines.join("\\n")+"\\n跨行\\nneedle 中文\\nterminal";
const virtualCalls=[];
const virtualInvoke=async(command,args)=>{
  virtualCalls.push({command,args});
  if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};
  if(command==="get_string_metrics")return {decodedBytes:utf8(virtualSource),characterCount:virtualSource.length,lineCount:virtualLines.length+3};
  if(command==="search_current"){
    const query=args.query;const matchIndex=virtualSource.indexOf(query);
    if(matchIndex<0)throw new Error("virtual search fixture query is absent");
    const matchStart=utf8(virtualSource.slice(0,matchIndex));
    return {matches:[{nodeId:10,field:"value",pathSegments:["$","content"],pathTruncated:false,sourceSpanStart:100,sourceSpanEnd:100+utf8(virtualSource),matchStart,matchEnd:matchStart+utf8(query)}],hasMore:false,nextCursor:null};
  }
  if(command==="read_decoded_text"){
    const text=sliceByUtf8(virtualSource,args.offset,args.length);const end=args.offset+utf8(text);return {start:args.offset,text,hasMore:end<utf8(virtualSource),nextOffset:end<utf8(virtualSource)?end:null};
  }
  if(command==="read_raw_slice"){
    const relative=args.sourceStart-100;const text=sliceByUtf8(virtualSource,relative,args.length);const end=relative+utf8(text);return {start:args.sourceStart,text,hasMore:end<utf8(virtualSource),nextOffset:end<utf8(virtualSource)?args.sourceStart+utf8(text):null};
  }
  throw new Error("unexpected virtual command "+command);
};
const virtual=makeViewer(virtualInvoke);
await virtual.viewer.open(target(10,10,virtualSource));await settle();
const virtualBody=virtual.elements.content.parentElement;
const virtualTotalLines=virtualLines.length+3;
const virtualRows=()=>Array.from(virtual.elements.content.querySelectorAll(".text-line-view-row"));
check(virtualRows().length>0&&virtualRows().length<virtualTotalLines,"128 KiB Plain Text did not render a bounded line window");
check(virtualRows()[0]?.textContent.replace(/\\r?\\n$/,"")===virtualLines[Number(virtualRows()[0]?.dataset.lineIndex??-1)],"virtualized head line changed source text");
virtual.elements.search.query.value="row-00010";virtual.elements.search.form.requestSubmit();await settle();
const virtualRenderedResult=virtual.elements.search.results.querySelector("button");
check(virtualRenderedResult!==null,"virtualized Plain Rendered search did not return a result");
virtualRenderedResult.click();await settle();
check(virtual.elements.content.querySelector("mark[data-rendered-search=\\"true\\"]")?.textContent==="row-00010","virtualized Plain Rendered search did not install its UTF-16 highlight");
virtualBody.scrollTop=virtualBody.scrollHeight/2;virtualBody.dispatchEvent(new Event("scroll"));await settle();
virtualBody.scrollTop=0;virtualBody.dispatchEvent(new Event("scroll"));await settle();
check(virtual.elements.content.querySelector("mark[data-rendered-search=\\"true\\"]")?.textContent==="row-00010","virtualized Plain Rendered search did not rebuild its highlight after row recycling");
const selectionRow=virtualRows().find((row)=>row.dataset.lineIndex==="10");
const selectionText=selectionRow?.firstChild;
if(!(selectionText instanceof Text))throw new Error("virtualized selection fixture did not expose a text node");
const selected=window.getSelection();const selectedRange=document.createRange();selectedRange.setStart(selectionText,5);selectedRange.setEnd(selectionText,15);selected?.removeAllRanges();selected?.addRange(selectedRange);
virtual.elements.wrap.noWrap.click();await settle();
const selectedText=selected?.toString()??"";
virtualBody.scrollLeft=120;virtualBody.dispatchEvent(new Event("scroll"));await settle();
check(selectedText.length>0&&selected?.toString()===selectedText,"horizontal No Wrap scrolling lost the source selection");
selected?.removeAllRanges();
virtualBody.scrollLeft=160;virtualBody.dispatchEvent(new Event("scroll"));await settle();
check(selected?.toString()==="","cleared source selection was resurrected during a stable-window scroll");
const verticalRow=virtualRows().find((row)=>row.dataset.lineIndex==="10");
const verticalTextNode=verticalRow?.firstChild;
if(!(verticalTextNode instanceof Text))throw new Error("vertical selection fixture did not expose a text node");
const verticalRange=document.createRange();verticalRange.setStart(verticalTextNode,5);verticalRange.setEnd(verticalTextNode,15);
selected?.addRange(verticalRange);
const verticalSelected=selected?.toString()??"";
virtualBody.scrollTop=virtualBody.scrollHeight/2;virtualBody.dispatchEvent(new Event("scroll"));await settle();
virtualBody.scrollTop=0;virtualBody.dispatchEvent(new Event("scroll"));await settle();
check(verticalSelected.length>0&&selected?.toString()===verticalSelected,"vertical row recycling did not restore the source selection");
virtual.elements.wrap.wrap.click();await settle();
virtualBody.scrollTop=virtualBody.scrollHeight/2;virtualBody.dispatchEvent(new Event("scroll"));await settle();
const virtualMiddleRows=virtualRows();
check(virtualMiddleRows.length>0&&virtualMiddleRows.length<virtualTotalLines&&virtualMiddleRows.some((row)=>Number(row.dataset.lineIndex)>1000),"virtualized middle scroll did not move the bounded window");
virtualBody.scrollTop=virtualBody.scrollHeight;virtualBody.dispatchEvent(new Event("scroll"));await settle();
const virtualTailRows=virtualRows();
check(virtualTailRows.length>0&&virtualTailRows.length<virtualTotalLines&&virtualTailRows.some((row)=>Number(row.dataset.lineIndex)>6000),"virtualized page tail scroll did not move to the page tail");
virtual.elements.next.click();await settle();
virtualBody.scrollTop=virtualBody.scrollHeight;virtualBody.dispatchEvent(new Event("scroll"));await settle();
const virtualFinalRows=virtualRows();
check(virtualFinalRows.length>0&&virtualFinalRows.length<virtualTotalLines&&virtualFinalRows.some((row)=>row.textContent==="terminal"),"virtualized final page tail did not expose the terminal source line");
virtualBody.scrollTop=virtualBody.scrollHeight/2;virtualBody.dispatchEvent(new Event("scroll"));await settle();
const virtualAnchor=virtualRows().find((row)=>Number(row.dataset.lineIndex)>1000);
const virtualAnchorIndex=Number(virtualAnchor?.dataset.lineIndex??-1);
const virtualAnchorTop=virtualAnchor?.getBoundingClientRect().top??0;
virtualBody.style.width="180px";await new Promise((resolve)=>setTimeout(resolve,50));await settle();
const virtualAnchorAfter=virtual.elements.content.querySelector('[data-line-index="'+virtualAnchorIndex+'"]');
check(virtualAnchorAfter!==null&&Math.abs(virtualAnchorAfter.getBoundingClientRect().top-virtualAnchorTop)<20,"Wrap resize lost the visible line anchor");
virtual.elements.string.decodedTab.click();await settle();
const crossLineQuery="needle 中文";
virtual.elements.search.query.value=crossLineQuery;virtual.elements.search.form.requestSubmit();await settle();
const virtualSearchResult=virtual.elements.search.results.querySelector("button");
check(virtualSearchResult!==null,"virtualized decoded search did not return a result");
virtualSearchResult.click();await settle();
const virtualMarks=Array.from(virtual.elements.content.querySelectorAll("mark[data-search-match=\\"true\\"]"));
check(virtualMarks.length===1&&virtualMarks[0].textContent==="needle 中文","Unicode search did not rebuild the visible line highlight");
virtual.elements.string.rawTab.click();await settle();
check(virtualRows().length>0&&virtualRows().length<virtualTotalLines,"Raw Lexeme did not use the bounded line window");
virtual.elements.next.click();await settle();
virtualBody.scrollTop=virtualBody.scrollHeight;virtualBody.dispatchEvent(new Event("scroll"));await settle();
check(virtual.elements.content.textContent.includes("跨行")&&!virtual.elements.content.textContent.includes("�"),"cross-page multibyte Raw text was not source-faithful");
virtual.viewer.clear(false);await settle();
check(virtualRows().length===0&&!virtual.elements.content.classList.contains("is-text-lines"),"closing the viewer retained virtualized text DOM or state");
virtual.host.remove();

const boundaryPageBytes=128*1024;
const boundaryPage0="x".repeat(boundaryPageBytes-1)+"\\r";
const boundaryPage1="\\nb\\n\\n";
const boundarySource=boundaryPage0+boundaryPage1;
const boundaryInvoke=async(command,args)=>{
  if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};
  if(command==="get_string_metrics")return {decodedBytes:utf8(boundarySource),characterCount:boundarySource.length,lineCount:4};
  if(command==="read_decoded_text"){
    const text=args.offset===0?boundaryPage0:boundaryPage1;
    return {start:args.offset,text,hasMore:args.offset===0,nextOffset:args.offset===0?boundaryPageBytes:null};
  }
  throw new Error("unexpected CRLF boundary command");
};
const boundary=makeViewer(boundaryInvoke);
await boundary.viewer.open(target(11,11,boundarySource));await settle();
const boundaryRows=()=>Array.from(boundary.elements.content.querySelectorAll(".text-line-view-row"));
check(boundaryRows().length===1&&boundaryRows()[0].textContent.startsWith("xxx"),"CRLF page 0 incorrectly materialized a trailing empty line");
boundary.elements.next.click();await settle();
check(boundaryRows().length===3&&boundaryRows()[0].textContent.replace(/\\r?\\n$/,"")==="b"&&boundaryRows()[1].getBoundingClientRect().height>0&&boundaryRows()[2].getBoundingClientRect().height>0&&boundary.elements.content.textContent==="b\\n\\n","CRLF continuation or empty/terminal lines were not source-faithful");
boundary.viewer.clear(false);await settle();
check(boundaryRows().length===0,"CRLF boundary viewer did not dispose its line index on close");
boundary.host.remove();

const crossLineScroll=document.createElement("div");
const crossLineHost=document.createElement("div");
crossLineScroll.style.height="100px";
crossLineHost.className="content-viewer-content";
crossLineScroll.append(crossLineHost);
document.body.append(crossLineScroll);
const crossLineText="跨行\\nneedle 中文";
const crossLineView=new TextLineView(crossLineHost,crossLineScroll);
crossLineView.setText(crossLineText,true,{start:0,end:crossLineText.length});
check(Array.from(crossLineHost.querySelectorAll("mark[data-search-match=\\"true\\"]")).map((mark)=>mark.textContent).join("|")==="跨行|needle 中文","cross-line highlight did not rebuild per-line marks");
crossLineView.dispose();
crossLineScroll.remove();

const copySource=Array.from({length:220},(_,index)=>"row-"+String(index).padStart(3,"0")+(index===100?" 中文😀":"")).join("\\r\\n")+"\\r\\nlast";
const copyInvoke=async(command,args)=>{
  if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"fallback"};
  if(command==="get_string_metrics")return {decodedBytes:utf8(copySource),characterCount:copySource.length,lineCount:221};
  if(command==="read_decoded_text"){
    const text=sliceByUtf8(copySource,args.offset,args.length);const end=args.offset+utf8(text);return {start:args.offset,text,hasMore:end<utf8(copySource),nextOffset:end<utf8(copySource)?end:null};
  }
  throw new Error("unexpected copy selection command");
};
const copy=makeViewer(copyInvoke);
await copy.viewer.open(target(12,12,copySource));await settle();
const copyBody=copy.elements.content.parentElement;
const copyRows=()=>Array.from(copy.elements.content.querySelectorAll(".text-line-view-row"));
copyBody.scrollTop=100*16;copyBody.dispatchEvent(new Event("scroll"));await settle();
const copyFirstRow=copyRows().find((row)=>row.dataset.lineIndex==="100");
const copySecondRow=copyRows().find((row)=>row.dataset.lineIndex==="101");
const copyFirstText=copyFirstRow?.firstChild;
const copySecondText=copySecondRow?.firstChild;
if(!(copyFirstText instanceof Text)||!(copySecondText instanceof Text))throw new Error("copy selection fixture did not expose adjacent text rows");
const copyRange=document.createRange();copyRange.setStart(copyFirstText,0);copyRange.setEnd(copySecondText,copySecondText.data.length);
const copySelection=window.getSelection();copySelection?.removeAllRanges();copySelection?.addRange(copyRange);
const copyStart=Number(copyFirstRow?.dataset.utf16Start);const copyEnd=Number(copySecondRow?.dataset.utf16End);const copyExpected=copySource.slice(copyStart,copyEnd);
copyBody.scrollTop=copyBody.scrollHeight;copyBody.dispatchEvent(new Event("scroll"));await settle();
let copiedText="";
const copyEvent=new Event("copy",{bubbles:true,cancelable:true});
Object.defineProperty(copyEvent,"clipboardData",{value:{setData:(kind,value)=>{if(kind==="text/plain")copiedText=value;}}});
document.dispatchEvent(copyEvent);
check(copyEvent.defaultPrevented&&copiedText===copyExpected&&copiedText.includes("\\r\\n")&&copiedText.includes("中文😀"),"offscreen copy did not preserve the exact CRLF/multibyte source range");
const outside=document.createElement("div");
outside.textContent="external selection";
copy.elements.dialog.append(outside);
const outsideText=outside.firstChild;
if(!(outsideText instanceof Text))throw new Error("external selection fixture did not expose text");
const outsideRange=document.createRange();outsideRange.selectNodeContents(outsideText);
copySelection?.removeAllRanges();copySelection?.addRange(outsideRange);await settle();
copyBody.scrollTop=0;copyBody.dispatchEvent(new Event("scroll"));await settle();
check(copySelection?.toString()==="external selection","external selection did not invalidate the saved source range");
outside.remove();
copyBody.scrollTop=100*16;copyBody.dispatchEvent(new Event("scroll"));await settle();
const cancelRow=copyRows().find((row)=>row.dataset.lineIndex==="100");
const cancelText=cancelRow?.firstChild;
if(!(cancelText instanceof Text))throw new Error("cancel selection fixture did not expose a text row");
const cancelRange=document.createRange();cancelRange.setStart(cancelText,0);cancelRange.setEnd(cancelText,8);
copySelection?.removeAllRanges();copySelection?.addRange(cancelRange);
copyBody.scrollTop=copyBody.scrollHeight;copyBody.dispatchEvent(new Event("scroll"));await settle();
copySelection?.removeAllRanges();document.dispatchEvent(new Event("selectionchange"));await settle();
copyBody.scrollTop=0;copyBody.dispatchEvent(new Event("scroll"));await settle();
check(copySelection?.toString()==="","explicitly cleared offscreen selection was resurrected");
copy.viewer.clear(false);await settle();
check(copyRows().length===0,"copy viewer did not dispose its text rows");
copy.host.remove();

const codeOverflowLines=Array.from({length:22050},(_,index)=>index===21000?"tail😀needle":"line-"+String(index).padStart(5,"0"));
const codeOverflowSource=codeOverflowLines.join("\\r\\n")+"\\r\\n";
const codeOverflowCalls=[];
const codeOverflowInvoke=async(command,args)=>{
  codeOverflowCalls.push({command,args});
  if(command==="get_string_detection")return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_string_metrics")return {decodedBytes:utf8(codeOverflowSource),characterCount:codeOverflowSource.length,lineCount:codeOverflowLines.length+1};
  if(command==="search_current"){
    const query=args.query;const matchIndex=codeOverflowSource.indexOf(query);
    if(matchIndex<0)throw new Error("code overflow search fixture query is absent");
    const matchStart=utf8(codeOverflowSource.slice(0,matchIndex));
    return {matches:[{nodeId:13,field:"value",pathSegments:["$","code"],pathTruncated:false,sourceSpanStart:100,sourceSpanEnd:100+utf8(codeOverflowSource),matchStart,matchEnd:matchStart+utf8(query)}],hasMore:false,nextCursor:null};
  }
  if(command==="read_decoded_text"){
    const text=sliceByUtf8(codeOverflowSource,args.offset,args.length);const end=args.offset+utf8(text);return {start:args.offset,text,hasMore:end<utf8(codeOverflowSource),nextOffset:end<utf8(codeOverflowSource)?end:null};
  }
  throw new Error("unexpected code overflow command");
};
const codeOverflow=makeViewer(codeOverflowInvoke);
await codeOverflow.viewer.open(target(13,13,codeOverflowSource));await settle();
const overflowRows=()=>Array.from(codeOverflow.elements.content.querySelectorAll(".text-line-view-row"));
const overflowGutter=()=>codeOverflow.elements.content.querySelector(".text-line-view-gutter");
const overflowSource=()=>codeOverflow.elements.content.querySelector(".text-line-view-source");
check(codeOverflow.elements.content.classList.contains("is-code-lines")&&overflowRows().length>0&&overflowRows().length<20000&&overflowGutter()?.getAttribute("aria-hidden")==="true","Code line-limit fallback did not use a bounded line window with a hidden gutter");
check(overflowGutter()?.textContent==="1"&&overflowSource()?.textContent.startsWith("line-00000"),"Code line-limit fallback did not start at absolute line 1 without changing source text");
const overflowGutterWidth=overflowGutter()?.getBoundingClientRect().width??0;
check(overflowGutterWidth>0&&overflowRows().every((row)=>row.querySelector(".text-line-view-gutter")?.getBoundingClientRect().width===overflowGutterWidth),"Code gutter width was not fixed for the page");
codeOverflow.elements.wrap.noWrap.click();await settle();
check(codeOverflow.elements.content.classList.contains("is-code-lines")&&getComputedStyle(overflowSource()).whiteSpace==="pre"&&getComputedStyle(overflowGutter()).userSelect==="none","Code No Wrap did not keep source/gutter geometry");
codeOverflow.elements.wrap.wrap.click();await settle();
codeOverflow.elements.next.click();await settle();
check(Number(overflowGutter()?.textContent)>1&&codeOverflow.elements.content.classList.contains("is-code-lines"),"Code next page did not preserve absolute line numbers");
codeOverflow.elements.search.query.value="tail😀needle";codeOverflow.elements.search.form.requestSubmit();await settle();
const codeOverflowResult=codeOverflow.elements.search.results.querySelector("button");
check(codeOverflowResult!==null,"Code overflow Rendered search did not return its distant match");
codeOverflowResult.click();await settle();
check(overflowGutter()?.textContent==="21001"&&codeOverflow.elements.content.querySelector("mark[data-rendered-search=\\"true\\"]")?.textContent==="tail😀needle","Code overflow Rendered search did not seek with absolute lines and source UTF-16 highlight");
const overflowCopySource=overflowSource()?.querySelector("mark")?.firstChild??overflowSource()?.firstChild;
if(!(overflowCopySource instanceof Text))throw new Error("Code overflow copy fixture did not expose a source text node");
const overflowCopyRange=document.createRange();overflowCopyRange.setStart(overflowCopySource,0);overflowCopyRange.setEnd(overflowCopySource,overflowCopySource.data.length);
const overflowSelection=window.getSelection();overflowSelection?.removeAllRanges();overflowSelection?.addRange(overflowCopyRange);
codeOverflow.elements.content.parentElement.scrollTop=codeOverflow.elements.content.parentElement.scrollHeight;codeOverflow.elements.content.parentElement.dispatchEvent(new Event("scroll"));await settle();
let overflowCopiedText="";
const overflowCopyEvent=new Event("copy",{bubbles:true,cancelable:true});
Object.defineProperty(overflowCopyEvent,"clipboardData",{value:{setData:(kind,value)=>{if(kind==="text/plain")overflowCopiedText=value;}}});
document.dispatchEvent(overflowCopyEvent);
check(overflowCopyEvent.defaultPrevented&&overflowCopiedText==="tail😀needle"&&!overflowCopiedText.includes("21001"),"Code overflow copy included a gutter line number or lost source text");
const codeOverflowBody=codeOverflow.elements.content.parentElement;
codeOverflowBody.scrollTop=codeOverflowBody.scrollHeight/2;codeOverflowBody.dispatchEvent(new Event("scroll"));await settle();
codeOverflowBody.scrollTop=0;codeOverflowBody.dispatchEvent(new Event("scroll"));await settle();
check(codeOverflow.elements.content.querySelector("mark[data-rendered-search=\\"true\\"]")?.textContent==="tail😀needle","Code overflow search highlight was not rebuilt after row recycling");
codeOverflow.viewer.clear(false);await settle();
check(codeOverflow.elements.content.querySelector(".text-line-view-row")===null&& !codeOverflow.elements.content.classList.contains("is-code-lines"),"Code overflow close retained its line view");
codeOverflow.host.remove();

const codeSizeSource="x".repeat(1024*1024+1);
const codeSizeInvoke=async(command,args)=>{
  if(command==="get_string_detection")return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_string_metrics")return {decodedBytes:utf8(codeSizeSource),characterCount:codeSizeSource.length,lineCount:1};
  if(command==="read_decoded_text"){const text=sliceByUtf8(codeSizeSource,args.offset,args.length);const end=args.offset+utf8(text);return {start:args.offset,text,hasMore:end<utf8(codeSizeSource),nextOffset:end<utf8(codeSizeSource)?end:null};}
  throw new Error("unexpected code size-limit command");
};
const codeSize=makeViewer(codeSizeInvoke);
await codeSize.viewer.open(target(14,14,codeSizeSource));await settle();
check(codeSize.elements.content.classList.contains("is-code-lines")&&codeSize.elements.content.querySelectorAll(".text-line-view-row").length===1&&codeSize.elements.content.querySelector(".text-line-view-gutter")?.textContent==="1","Code size-limit fallback did not use a bounded code line window");
codeSize.viewer.clear(false);codeSize.host.remove();

const fence=String.fromCharCode(96).repeat(3);
const markdownSource="# Prose\\n\\nThis paragraph should reflow.\\n\\n"+fence+"javascript\\n"+"const veryLongValue = "+'"'+"L".repeat(2200)+'"' + ";\\n"+fence;
const markdownInvoke=async(command,args)=>{
  if(command==="get_string_detection")return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_string_metrics")return {decodedBytes:utf8(markdownSource),characterCount:markdownSource.length,lineCount:6};
  if(command==="read_decoded_text"){const text=sliceByUtf8(markdownSource,args.offset,args.length);return {start:args.offset,text,hasMore:false,nextOffset:null};}
  throw new Error("unexpected markdown command "+command);
};
const markdown=makeViewer(markdownInvoke);await markdown.viewer.open(target(2,2,markdownSource));await settle();
const prose=markdown.elements.content.querySelector("p");const fenced=markdown.elements.content.querySelector("pre");
check(markdown.elements.content.classList.contains("is-markdown")&&prose!==null&&fenced?.classList.contains("sjv-code"),"Markdown or fenced Code did not render through the existing pipelines");
check(getComputedStyle(prose).whiteSpace==="normal","Markdown prose did not keep normal reflow before toggling");
markdown.elements.wrap.noWrap.click();
check(getComputedStyle(prose).whiteSpace==="normal","No Wrap incorrectly disabled Markdown prose reflow");
check(getComputedStyle(fenced).whiteSpace==="pre"&&getComputedStyle(fenced.querySelector(".sjv-code-source")).overflowWrap==="normal","No Wrap did not apply to Markdown fenced Code");
const fencedWidth=fenced.getBoundingClientRect().width;check(fenced.scrollWidth>fencedWidth,"No Wrap did not expose fenced Code horizontal overflow");
markdown.elements.wrap.wrap.click();check(getComputedStyle(prose).whiteSpace==="normal"&&getComputedStyle(fenced).whiteSpace==="pre-wrap","Wrap did not restore fenced Code soft wrapping");
markdown.viewer.clear(false);markdown.host.remove();

const codeLineBreak=String.fromCharCode(13,10);
const codeSource="const longValue = "+'"'+"L".repeat(220)+ '"' + ";"+codeLineBreak+"const second = 2;"+codeLineBreak+codeLineBreak+"console.log(second);"+codeLineBreak;
const codeInvoke=async(command,args)=>{
  if(command==="get_string_detection")return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_string_metrics")return {decodedBytes:utf8(codeSource),characterCount:codeSource.length,lineCount:5};
  if(command==="read_decoded_text"){const text=sliceByUtf8(codeSource,args.offset,args.length);return {start:args.offset,text,hasMore:false,nextOffset:null};}
  throw new Error("unexpected code command "+command);
};
const code=makeViewer(codeInvoke);await code.viewer.open(target(4,4,codeSource));await settle();
const codeSourceNode=code.elements.content.querySelector(".sjv-code-source");const codeGutterNode=code.elements.content.querySelector(".sjv-code-gutter");
const lineBreak=String.fromCharCode(10);const codeMarkers=Array.from(codeSourceNode?.querySelectorAll(".sjv-code-line-marker")??[]);
check(codeSourceNode?.textContent===codeSource&&codeGutterNode?.textContent==="1"+lineBreak+"2"+lineBreak+"3"+lineBreak+"4"+lineBreak+"5"&&codeMarkers.length===5,"Code renderer did not preserve CRLF source, terminal newline, and independent line numbers");
const rangeAt=(root,start,end)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let cursor=0;let first=null;let last=null;let firstOffset=0;let lastOffset=0;while(walker.nextNode()){const node=walker.currentNode;const next=cursor+node.nodeValue.length;if(first===null&&start<=next){first=node;firstOffset=Math.max(0,start-cursor);}if(end<=next){last=node;lastOffset=Math.max(0,end-cursor);break;}cursor=next;}if(!first||!last)throw new Error("Could not locate Code text range");const range=document.createRange();range.setStart(first,firstOffset);range.setEnd(last,lastOffset);return range;};
const sourceFirstRect=rangeAt(codeSourceNode,0,1).getBoundingClientRect();const sourceSecondRect=rangeAt(codeSourceNode,codeSource.indexOf("const second"),codeSource.indexOf("const second")+1).getBoundingClientRect();const gutterFirstRect=codeGutterNode.children[0].getBoundingClientRect();const gutterSecondRect=codeGutterNode.children[1].getBoundingClientRect();
check(sourceSecondRect.top>sourceFirstRect.top,"Wrapped Code did not create a second visible source line");
check(Math.abs(sourceFirstRect.top-gutterFirstRect.top)<=2&&Math.abs(sourceSecondRect.top-gutterSecondRect.top)<=2,"Code line numbers did not remain vertically aligned with wrapped source lines: source="+sourceFirstRect.top+","+sourceSecondRect.top+" gutter="+gutterFirstRect.top+","+gutterSecondRect.top+" style="+codeGutterNode.children[0].style.top+","+codeGutterNode.children[1].style.top+" gutterTop="+codeGutterNode.getBoundingClientRect().top);
const currentMarkers=()=>Array.from(codeSourceNode.querySelectorAll(".sjv-code-line-marker"));
const markerTops=currentMarkers().map((marker)=>marker.getBoundingClientRect().top);const gutterTops=Array.from(codeGutterNode.children,(line)=>line.getBoundingClientRect().top);
check(markerTops.every((top,index)=>index===0||top>markerTops[index-1])&&markerTops.every((top,index)=>Math.abs(top-gutterTops[index])<2),"CRLF/blank/terminal Code rows did not have monotonic marker and gutter geometry: markers="+markerTops+" gutter="+gutterTops);
const codeBody=code.elements.content.parentElement;codeBody.style.width="180px";await new Promise((resolve)=>setTimeout(resolve,50));await settle();
check(currentMarkers().every((marker,index)=>Math.abs(marker.getBoundingClientRect().top-codeGutterNode.children[index].getBoundingClientRect().top)<2),"Code line numbers did not realign after a width change");
codeBody.style.width="280px";await new Promise((resolve)=>setTimeout(resolve,50));await settle();
code.elements.wrap.noWrap.click();await settle();
const noWrapCodeRects=rangeAt(codeSourceNode,0,1).getClientRects();
check(getComputedStyle(codeSourceNode).whiteSpace==="pre"&&getComputedStyle(codeSourceNode).overflowWrap==="normal","No Wrap did not apply to Code source text");
check(codeBody.scrollWidth>codeBody.clientWidth,"No Wrap did not expose Code horizontal scrolling");
check(noWrapCodeRects.length>0&&currentMarkers().every((marker,index)=>Math.abs(marker.getBoundingClientRect().top-codeGutterNode.children[index].getBoundingClientRect().top)<=2),"No Wrap changed Code line-number geometry: rects="+noWrapCodeRects.length+" markers="+currentMarkers().map((marker)=>marker.getBoundingClientRect().top)+" gutter="+Array.from(codeGutterNode.children,(line)=>line.getBoundingClientRect().top));
code.elements.search.query.value="second";code.elements.search.form.requestSubmit();await settle();const codeSearchResult=code.elements.search.results.querySelector("button");check(codeSearchResult!==null,"Code rendered search did not return a line hit");codeSearchResult.click();await settle();check(code.elements.content.querySelector("mark[data-rendered-search]")?.textContent?.includes("second"),"Code rendered search did not highlight the line hit");
for(let index=0;index<3;index+=1){code.elements.wrap.wrap.click();await settle();code.elements.wrap.noWrap.click();await settle();}code.elements.wrap.wrap.click();await settle();codeSearchResult.click();await settle();check(code.elements.content.querySelector("mark[data-rendered-search]")?.textContent?.includes("second")&&currentMarkers().length===5,"Repeated Wrap/No Wrap changed Code search positioning or marker count");
code.viewer.clear(false);code.host.remove();

const makeManyLineCode=(lineCount)=>{
  const first="const longValue = "+'"'+"L".repeat(1200)+'"'+";"+codeLineBreak;
  const second="const second = 2;"+codeLineBreak+codeLineBreak+"console.log(second);"+codeLineBreak;
  return first+second+"x=1;"+codeLineBreak.repeat(Math.max(0,lineCount-5));
};
const manyLineSource=makeManyLineCode(2049);const manyLineCalls=[];
const manyLineInvoke=async(command,args)=>{
  manyLineCalls.push({command,args});
  if(command==="get_string_detection")return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_string_metrics")return {decodedBytes:utf8(manyLineSource),characterCount:manyLineSource.length,lineCount:2049};
  if(command==="read_decoded_text"){const text=sliceByUtf8(manyLineSource,args.offset,args.length);return {start:args.offset,text,hasMore:args.offset+utf8(text)<utf8(manyLineSource),nextOffset:args.offset+utf8(text)<utf8(manyLineSource)?args.offset+utf8(text):null};}
  throw new Error("unexpected many-line command "+command);
};
const manyLine=makeViewer(manyLineInvoke);await manyLine.viewer.open(target(6,6,manyLineSource));await settle();
const manyLineSourceNode=manyLine.elements.content.querySelector(".sjv-code-source");const manyLineGutter=manyLine.elements.content.querySelector(".sjv-code-gutter");const manyLineMarkers=Array.from(manyLineSourceNode?.querySelectorAll(".sjv-code-line-marker")??[]);
check(manyLineSourceNode?.textContent===manyLineSource&&manyLineMarkers.length===2049&&manyLineGutter?.children.length===2049,"2049-line Code page lost source or silently disabled bounded line alignment");
check(manyLineMarkers[2048].getBoundingClientRect().top>manyLineMarkers[0].getBoundingClientRect().top&&Math.abs(manyLineMarkers[2048].getBoundingClientRect().top-manyLineGutter.children[2048].getBoundingClientRect().top)<=2,"2049-line Code terminal row geometry is not aligned");
manyLine.viewer.clear(false);manyLine.host.remove();

const pageBytes=128*1024;const pageFiller="x".repeat(4096)+codeLineBreak;let maxPageSource="const first = "+'"'+"L".repeat(1200)+'"'+";"+codeLineBreak;while(utf8(maxPageSource+pageFiller)<=pageBytes)maxPageSource+=pageFiller;maxPageSource+="x".repeat(pageBytes-utf8(maxPageSource));
check(utf8(maxPageSource)===pageBytes,"maximum 128 KiB Code page fixture is not exactly bounded");
const maxPageInvoke=async(command,args)=>{if(command==="get_string_detection")return {semanticType:"code",detectionSource:"contentDetected",plainReason:null};if(command==="get_string_metrics")return {decodedBytes:pageBytes,characterCount:maxPageSource.length,lineCount:maxPageSource.split(codeLineBreak).length};if(command==="read_decoded_text")return {start:args.offset,text:maxPageSource.slice(args.offset),hasMore:false,nextOffset:null};throw new Error("unexpected maximum-page command "+command);};
const maxPage=makeViewer(maxPageInvoke);await maxPage.viewer.open(target(7,7,maxPageSource));await settle();
const maxPageSourceNode=maxPage.elements.content.querySelector(".sjv-code-source");const maxPageGutter=maxPage.elements.content.querySelector(".sjv-code-gutter");const maxPageMarkers=Array.from(maxPageSourceNode?.querySelectorAll(".sjv-code-line-marker")??[]);
check(maxPageSourceNode?.textContent===maxPageSource&&maxPageMarkers.length===maxPageGutter?.children.length&&maxPageMarkers.length>0,"128 KiB Code page did not retain bounded source and all page line markers: source="+(maxPageSourceNode?.textContent?.length??-1)+" expected="+maxPageSource.length+" markers="+maxPageMarkers.length+" gutter="+(maxPageGutter?.children.length??-1));
check(maxPageMarkers.at(-1)?.getBoundingClientRect().top>maxPageMarkers[0]?.getBoundingClientRect().top,"128 KiB Code page terminal geometry collapsed");
maxPage.viewer.clear(false);maxPage.host.remove();

const nestedSource='{"child":"nested"}';const nestedCalls=[];let nestedRootMaxDepth=5;
const nestedInvoke=async(command,args)=>{
  nestedCalls.push({command,args});
  if(command==="get_string_detection")return args.nodeId===32?{semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null}:{semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_string_metrics")return {decodedBytes:6,characterCount:6,lineCount:1};
  if(command==="open_nested_json"){
    const depth=args.parentScopeId===null?1:2;const scopeId=depth===1?80:81;if(depth===1)nestedRootMaxDepth=args.maxDepth;return {scopeId,parentScopeId:args.parentScopeId,sourceNodeId:args.nodeId,depth,maxDepth:depth===1?args.maxDepth:nestedRootMaxDepth,parsedBytes:depth===1?20:11,cumulativeBytes:depth===1?20:31,sessionRevision:3,root:{id:depth===1?30:40,kind:"object",spanStart:0,spanEnd:depth===1?20:11,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:depth===1?1:0}};
  }
  if(command==="get_children")return {nodes:[{id:32,kind:"string",spanStart:2,spanEnd:18,label:"child",labelHasMore:false,valuePreview:"nested",valueHasMore:true,childCount:0}],hasMore:false,nextCursor:null};
  if(command==="read_decoded_text")return {start:0,text:"nested text",hasMore:false,nextOffset:null};
  if(command==="read_raw_slice")return {start:args.sourceStart,text:'"nested text"',hasMore:false,nextOffset:null};
  if(command==="close_nested_scope")return null;
  throw new Error("unexpected nested command "+command);
};
const nested=makeViewer(nestedInvoke,{nested:true});await nested.viewer.open(target(3,20,nestedSource));await settle();
const nestedDepthControl=nested.host.querySelector(".content-viewer-nested-depth");const nestedDepthSelect=nestedDepthControl?.querySelector("select");check(nestedDepthControl!==null&&nested.elements.dialog.contains(nestedDepthControl)&&nestedDepthSelect instanceof HTMLSelectElement&&nestedDepthSelect.options.length===10&&nestedDepthSelect.value==="5"&&!nestedDepthControl.hidden&&!nestedDepthSelect.disabled&&nestedDepthSelect.title.length>0,"Nested depth control did not expose 1–10 with default 5 inside the viewer dialog");
nested.elements.renderAs.value="nestedJson";nested.elements.renderAs.dispatchEvent(new Event("change"));await settle();check(nested.elements.renderAs.value==="nestedJson"&&nested.elements.representation.textContent.includes("Parsed"),"Root Render As override was not retained before changing Nested depth");
nestedDepthSelect.value="10";nestedDepthSelect.dispatchEvent(new Event("change"));await settle();const rootReopen10=nestedCalls.filter(({command})=>command==="open_nested_json").at(-1);check(rootReopen10?.args.parentScopeId===null&&rootReopen10?.args.maxDepth===10&&nested.elements.range.textContent.includes("depth 1/10"),"Changing Nested depth to 10 did not reopen the root with new metadata");check(nestedDepthSelect.value==="10"&&!nestedDepthControl.hidden&&!nestedDepthSelect.disabled,"Nested depth control did not remain enabled at root depth 10");
nestedDepthSelect.value="5";nestedDepthSelect.dispatchEvent(new Event("change"));await settle();const rootReopen5=nestedCalls.filter(({command})=>command==="open_nested_json").at(-1);check(rootReopen5?.args.parentScopeId===null&&rootReopen5?.args.maxDepth===5&&nested.elements.range.textContent.includes("depth 1/5"),"Changing Nested depth back to 5 did not reopen the root");
const rootItem=nested.host.querySelector('[data-node-id="30"]');check(rootItem!==null,"Nested Parsed root was not rendered");rootItem.querySelector(".tree-disclosure")?.click();await settle();
const childItem=nested.host.querySelector('[data-node-id="32"]');check(childItem!==null,"Nested child was not paged into the tree");childItem.querySelector(".tree-value")?.click();await settle();
const childOpen=nestedCalls.filter(({command})=>command==="open_nested_json").at(-1);check(childOpen?.args.parentScopeId===80&&childOpen?.args.maxDepth===null,"Nested child did not inherit the root depth budget with maxDepth null");check(nested.host.querySelector('[data-node-id="40"]')!==null,"Nested frame did not open");nested.elements.nested.decodedTab.click();await settle();check(nested.elements.content.querySelector(".text-line-view-row")!==null,"Nested decoded string did not use the line view");nested.elements.nested.rawTab.click();await settle();check(nested.elements.content.querySelector(".text-line-view-row")!==null,"Nested raw string did not use the line view");nested.elements.nested.decodedTab.click();await settle();nested.elements.wrap.noWrap.click();
check(nested.elements.content.classList.contains("is-no-wrap"),"Nested decoded source did not accept No Wrap");nested.elements.nested.back.click();await settle();
check(nested.elements.content.classList.contains("is-no-wrap")&&nested.elements.representation.textContent.includes("Parsed"),"Returning from nested frame mixed state or dropped No Wrap");
check(nested.elements.string.representations.hidden,"Returning to Parsed parent left ordinary string representations visible");
check(nested.elements.wrap.noWrap.disabled===true,"No Wrap was not disabled for the Parsed tree");
nested.viewer.clear(false);await settle();check(nestedCalls.some(({command})=>command==="close_nested_scope"),"Closing the Nested viewer did not release its root scope");nested.host.remove();

const nestedLimitCases=[{label:"2 MiB",parsedBytes:2*1024*1024+1,cumulativeBytes:2*1024*1024+1},{label:"8 MiB",parsedBytes:20,cumulativeBytes:8*1024*1024+1}];
for(const [index,limitCase] of nestedLimitCases.entries()){
  const limitCalls=[];const limitInvoke=async(command,args)=>{limitCalls.push({command,args});if(command==="get_string_detection")return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};if(command==="get_string_metrics")return {decodedBytes:6,characterCount:6,lineCount:1};if(command==="open_nested_json")return {scopeId:90+index,parentScopeId:null,sourceNodeId:20,depth:1,maxDepth:5,parsedBytes:limitCase.parsedBytes,cumulativeBytes:limitCase.cumulativeBytes,sessionRevision:3,root:{id:30,kind:"object",spanStart:0,spanEnd:1,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0}};if(command==="close_nested_scope")return null;throw new Error("unexpected nested limit command "+command);};
  const limitViewer=makeViewer(limitInvoke,{nested:true});await limitViewer.viewer.open(target(3,20,nestedSource));await settle();check(limitViewer.elements.alert.textContent.includes("scope response was invalid")&&limitCalls.some(({command})=>command==="close_nested_scope"),"Nested "+limitCase.label+" Core limit was not preserved at the UI scope boundary");limitViewer.viewer.clear(false);limitViewer.host.remove();
}
const mismatchCalls=[];const mismatchInvoke=async(command,args)=>{mismatchCalls.push({command,args});if(command==="get_string_detection")return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};if(command==="get_string_metrics")return {decodedBytes:6,characterCount:6,lineCount:1};if(command==="open_nested_json")return {scopeId:95,parentScopeId:null,sourceNodeId:20,depth:1,maxDepth:4,parsedBytes:20,cumulativeBytes:20,sessionRevision:3,root:{id:30,kind:"object",spanStart:0,spanEnd:1,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0}};if(command==="close_nested_scope")return null;throw new Error("unexpected nested mismatch command "+command);};
const mismatchViewer=makeViewer(mismatchInvoke,{nested:true});await mismatchViewer.viewer.open(target(3,20,nestedSource));await settle();check(mismatchViewer.elements.alert.textContent.includes("requested 5")&&mismatchCalls.some(({command})=>command==="close_nested_scope"),"Nested scope maxDepth mismatch was accepted without release/report");mismatchViewer.viewer.clear(false);mismatchViewer.host.remove();

const deepSource='{"branch":"nested"}';let deepNextScopeId=100;let deepRootMaxDepth=5;const deepScopes=new Map();const deepCalls=[];const deepClosed=[];const deepChildId=(depth)=>depth<=6?40+depth:null;
const deepScopeResponse=(scope)=>({scopeId:scope.scopeId,parentScopeId:scope.parentScopeId,sourceNodeId:scope.sourceNodeId,depth:scope.depth,maxDepth:scope.maxDepth,parsedBytes:scope.parsedBytes,cumulativeBytes:scope.cumulativeBytes,sessionRevision:14,root:{id:scope.rootId,kind:"object",spanStart:0,spanEnd:scope.parsedBytes,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:scope.childId===null?0:1}});
const deepInvoke=async(command,args)=>{
  deepCalls.push({command,args});
  if(command==="get_string_detection")return args.nodeId===45&&deepRootMaxDepth===5?{semanticType:"plainText",detectionSource:"contentDetected",plainReason:"depthLimit"}:{semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_string_metrics")return {decodedBytes:24,characterCount:24,lineCount:1};
  if(command==="open_nested_json"){
    const parentScopeId=args.parentScopeId;
    if(parentScopeId!==null&&args.maxDepth!==null)throw new Error("nested child must inherit maxDepth");
    const parent=parentScopeId===null?null:deepScopes.get(parentScopeId);if(parentScopeId!==null&&!parent)throw new Error("unknown nested parent scope");
    const depth=parent?parent.depth+1:1;const scopeId=deepNextScopeId++;const parsedBytes=parent?100:200;const scope={scopeId,parentScopeId,sourceNodeId:args.nodeId,depth,maxDepth:parent?.maxDepth??args.maxDepth,parsedBytes,cumulativeBytes:(parent?.cumulativeBytes??0)+parsedBytes,rootId:1000+scopeId,childId:deepChildId(depth)};
    if(parentScopeId===null)deepRootMaxDepth=args.maxDepth;deepScopes.set(scopeId,scope);return deepScopeResponse(scope);
  }
  if(command==="get_children"){
    const scope=deepScopes.get(args.scopeId);if(!scope)throw new Error("unknown nested children scope");
    const nodes=scope.childId===null?[]:[{id:scope.childId,kind:"string",spanStart:2,spanEnd:40,label:"level-"+scope.depth,labelHasMore:false,valuePreview:"nested",valueHasMore:true,childCount:scope.depth<6?1:0}];
    return {nodes,hasMore:false,nextCursor:null};
  }
  if(command==="read_decoded_text")return {start:0,text:"depth-limit fallback",hasMore:false,nextOffset:null};
  if(command==="read_raw_slice")return {start:args.sourceStart,text:'"depth-limit fallback"',hasMore:false,nextOffset:null};
  if(command==="close_nested_scope"){deepClosed.push(args.scopeId);return null;}
  throw new Error("unexpected deep nested command "+command);
};
const deep=makeViewer(deepInvoke,{nested:true});await deep.viewer.open(target(14,20,deepSource));await settle();
const deepDepthControl=deep.host.querySelector(".content-viewer-nested-depth");const deepDepthSelect=deepDepthControl?.querySelector("select");check(deepDepthSelect instanceof HTMLSelectElement&&deepDepthControl!==null&&deep.elements.dialog.contains(deepDepthControl)&&deepDepthSelect.value==="5"&&!deepDepthSelect.disabled,"Deep Nested fixture did not start with an in-dialog depth-5 control");
deep.elements.renderAs.value="nestedJson";deep.elements.renderAs.dispatchEvent(new Event("change"));await settle();const firstRoot=[...deepScopes.values()].find((scope)=>scope.parentScopeId===null);check(firstRoot?.depth===1&&firstRoot?.maxDepth===5&&deep.elements.renderAs.value==="nestedJson","Depth-limited root did not retain its own Render As override");
let currentDeepScope=firstRoot;for(let depth=1;depth<=5;depth+=1){const rootItem=deep.host.querySelector('[data-node-id="'+(currentDeepScope?.rootId??"")+'"]');rootItem?.querySelector(".tree-disclosure")?.click();await settle();const childId=deepChildId(depth);const childItem=deep.host.querySelector('[data-node-id="'+(childId??"")+'"]');check(childItem!==null&&childItem.querySelector(".tree-value")!==null,"Depth-limited chain did not expose level "+depth);childItem.querySelector(".tree-value")?.click();await settle();if(depth<5){currentDeepScope=[...deepScopes.values()].find((scope)=>scope.parentScopeId===currentDeepScope?.scopeId);check(currentDeepScope?.depth===depth+1,"Depth-limited chain stopped before depth "+(depth+1));}}
check(deep.elements.content.textContent.includes("depth-limit fallback")&&!deepDepthControl.hidden&&!deepDepthSelect.disabled&&currentDeepScope?.depth===5,"Depth-5 Plain fallback did not retain the enabled Nested depth control");
deepDepthSelect.value="10";deepDepthSelect.dispatchEvent(new Event("change"));check(deepDepthSelect.disabled===true,"Nested depth change did not disable the control while reopening the root from a depth-limit Plain string");await settle();const rootsAfterReopen=[...deepScopes.values()].filter((scope)=>scope.parentScopeId===null);const secondRoot=rootsAfterReopen.at(-1);const rootReopenCall=deepCalls.filter(({command})=>command==="open_nested_json").at(-1);check(secondRoot?.scopeId!==firstRoot?.scopeId&&secondRoot?.maxDepth===10&&rootReopenCall?.args.nodeId===20&&rootReopenCall?.args.parentScopeId===null&&rootReopenCall?.args.maxDepth===10&&deepClosed.includes(firstRoot?.scopeId),"Changing depth did not release the old scope and reopen the root from its source node");check(deep.elements.renderAs.value==="nestedJson"&&deep.elements.content.textContent===""&&deep.elements.range.textContent.includes("depth 1/10")&&!deepDepthControl.hidden&&!deepDepthSelect.disabled,"New root lost its source override or depth metadata");deepDepthSelect.focus();check(document.activeElement===deepDepthSelect,"Nested depth control was not keyboard reachable after root reopen");
currentDeepScope=secondRoot;for(let depth=1;depth<=5;depth+=1){const rootItem=deep.host.querySelector('[data-node-id="'+(currentDeepScope?.rootId??"")+'"]');rootItem?.querySelector(".tree-disclosure")?.click();await settle();const childId=deepChildId(depth);const childItem=deep.host.querySelector('[data-node-id="'+(childId??"")+'"]');check(childItem!==null&&childItem.querySelector(".tree-value")!==null,"Reopened root did not expose level "+depth);childItem.querySelector(".tree-value")?.click();check(deepDepthSelect.disabled===true,"Nested depth control stayed enabled while opening child level "+depth);await settle();currentDeepScope=[...deepScopes.values()].find((scope)=>scope.parentScopeId===currentDeepScope?.scopeId);check(currentDeepScope?.depth===depth+1,"Reopened root did not reach depth "+(depth+1));}
const childOpenCalls=deepCalls.filter(({command,args})=>command==="open_nested_json"&&args.parentScopeId!==null);check(currentDeepScope?.depth===6&&currentDeepScope.maxDepth===10&&childOpenCalls.length>=9&&childOpenCalls.every(({args})=>args.maxDepth===null&&args.parentScopeId!==null),"Nested depth 10 did not permit the new chain to cross depth 5 with inherited maxDepth");
for(let count=0;count<5;count+=1){deep.elements.nested.back.click();await settle();}check(deep.host.querySelector('[data-node-id="'+(secondRoot?.rootId??"")+'"]')!==null&&deepClosed.includes(currentDeepScope?.scopeId),"Back returned through an old or unreleased Nested scope chain");deep.viewer.clear(false);await settle();check(deepClosed.includes(secondRoot?.scopeId),"Closing the reopened Nested root did not release the new scope");deep.host.remove();

let releaseLateRoot=null;let lateRootScopeId=200;let lateRootClosed=[];let latePendingScope=null;const lateSource='{"late":true}';const lateScope=(scopeId,nodeId)=>({scopeId,parentScopeId:null,sourceNodeId:nodeId,depth:1,maxDepth:5,parsedBytes:40,cumulativeBytes:40,sessionRevision:15,root:{id:300+scopeId,kind:"object",spanStart:0,spanEnd:40,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0}});
const lateInvoke=async(command,args)=>{if(command==="get_string_detection")return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};if(command==="get_string_metrics")return {decodedBytes:10,characterCount:10,lineCount:1};if(command==="open_nested_json"){const scopeId=lateRootScopeId++;if(latePendingScope===null){latePendingScope=scopeId;return new Promise((resolve)=>{releaseLateRoot=()=>resolve(lateScope(scopeId,args.nodeId));});}return lateScope(scopeId,args.nodeId);}if(command==="close_nested_scope"){lateRootClosed.push(args.scopeId);return null;}throw new Error("unexpected late root command "+command);};
const lateViewer=makeViewer(lateInvoke,{nested:true});const oldOpen=lateViewer.viewer.open(target(15,20,lateSource));await Promise.resolve();await Promise.resolve();check(typeof releaseLateRoot==="function","Deferred old Nested root request was not started");lateViewer.viewer.clear(false);const newOpen=lateViewer.viewer.open(target(15,21,lateSource));await newOpen;await settle();const lateDepth=lateViewer.host.querySelector(".content-viewer-nested-depth select");check(lateDepth instanceof HTMLSelectElement&&!lateDepth.disabled,"New Nested root did not become interactive after replacing a pending root");lateDepth.focus();const focusedBeforeLate=lateViewer.host.ownerDocument.activeElement;releaseLateRoot?.();await oldOpen;await settle();check(lateRootClosed.includes(latePendingScope)&&lateViewer.elements.dialog.open&&lateViewer.elements.alert.hidden&&lateViewer.host.ownerDocument.activeElement===focusedBeforeLate,"Late old root response polluted the replacement root or focus");lateViewer.viewer.clear(false);lateViewer.host.remove();

let releaseLateRead=null;const lateReadClosed=[];const lateReadSource='{"child":"read"}';const lateReadInvoke=async(command,args)=>{if(command==="get_string_detection")return args.nodeId===42?{semanticType:"plainText",detectionSource:"contentDetected",plainReason:"depthLimit"}:{semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};if(command==="get_string_metrics")return {decodedBytes:10,characterCount:10,lineCount:1};if(command==="open_nested_json")return {scopeId:400,parentScopeId:null,sourceNodeId:20,depth:1,maxDepth:5,parsedBytes:100,cumulativeBytes:100,sessionRevision:17,root:{id:401,kind:"object",spanStart:0,spanEnd:100,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:1}};if(command==="get_children")return {nodes:[{id:42,kind:"string",spanStart:2,spanEnd:40,label:"child",labelHasMore:false,valuePreview:"read",valueHasMore:true,childCount:0}],hasMore:false,nextCursor:null};if(command==="read_decoded_text")return new Promise((resolve)=>{releaseLateRead=()=>resolve({start:0,text:"late read",hasMore:false,nextOffset:null});});if(command==="close_nested_scope"){lateReadClosed.push(args.scopeId);return null;}throw new Error("unexpected late read command "+command);};
const lateReadViewer=makeViewer(lateReadInvoke,{nested:true});await lateReadViewer.viewer.open(target(17,20,lateReadSource));await settle();lateReadViewer.host.querySelector('[data-node-id="401"] .tree-disclosure')?.click();await settle();lateReadViewer.host.querySelector('[data-node-id="42"] .tree-value')?.click();await Promise.resolve();check(typeof releaseLateRead==="function","Deferred old Nested read was not started");lateReadViewer.viewer.clear(false);releaseLateRead?.();await settle();check(!lateReadViewer.elements.dialog.open&&lateReadViewer.elements.content.textContent===""&&lateReadClosed.includes(400),"Late old Nested read repopulated a closed viewer or left its scope open");lateReadViewer.host.remove();

let releaseLateSearch=null;let lateSearchScopeId=500;const lateSearchClosed=[];const lateSearchCalls=[];const lateSearchSource='{"search":"late"}';const lateSearchScope=(scopeId,nodeId,maxDepth)=>({scopeId,parentScopeId:null,sourceNodeId:nodeId,depth:1,maxDepth,parsedBytes:100,cumulativeBytes:100,sessionRevision:18,root:{id:600+scopeId,kind:"object",spanStart:0,spanEnd:100,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0}});
const lateSearchInvoke=async(command,args)=>{lateSearchCalls.push({command,args});if(command==="get_string_detection")return {semanticType:"nestedJson",detectionSource:"contentDetected",plainReason:null};if(command==="get_string_metrics")return {decodedBytes:10,characterCount:10,lineCount:1};if(command==="open_nested_json"){const scopeId=lateSearchScopeId++;return lateSearchScope(scopeId,args.nodeId,args.maxDepth);}if(command==="search_current")return new Promise((resolve)=>{releaseLateSearch=()=>resolve({matches:[{nodeId:20,field:"value",pathSegments:["$","search"],pathTruncated:false,sourceSpanStart:1,sourceSpanEnd:6,matchStart:0,matchEnd:4}],hasMore:false,nextCursor:null});});if(command==="close_nested_scope"){lateSearchClosed.push(args.scopeId);return null;}throw new Error("unexpected late search command "+command);};
const lateSearchViewer=makeViewer(lateSearchInvoke,{nested:true});await lateSearchViewer.viewer.open(target(18,20,lateSearchSource));await settle();const lateSearchDepth=lateSearchViewer.host.querySelector(".content-viewer-nested-depth select");check(lateSearchDepth instanceof HTMLSelectElement&&!lateSearchDepth.disabled,"Late-search Nested root did not expose an enabled depth control");lateSearchViewer.elements.search.query.value="late";lateSearchViewer.elements.search.form.requestSubmit();await Promise.resolve();check(typeof releaseLateSearch==="function","Deferred old Nested search was not started");lateSearchDepth.value="10";lateSearchDepth.dispatchEvent(new Event("change"));check(lateSearchDepth.disabled===true,"Nested depth control did not lock while replacing a searched root");await settle();releaseLateSearch?.();await settle();check(lateSearchClosed.includes(500)&&lateSearchViewer.elements.range.textContent.includes("depth 1/10")&&lateSearchViewer.elements.search.results.children.length===0&&lateSearchViewer.elements.search.resultsPanel.hidden,"Late old Nested search repopulated the new depth root: closed="+lateSearchClosed.join(",")+" range="+lateSearchViewer.elements.range.textContent+" results="+lateSearchViewer.elements.search.results.children.length+" hidden="+lateSearchViewer.elements.search.resultsPanel.hidden+" calls="+lateSearchCalls.map(({command})=>command).join(","));lateSearchViewer.viewer.clear(false);lateSearchViewer.host.remove();
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
  let result;
  try { result = JSON.parse(output.trim()); } catch {
    const start = output.lastIndexOf("{");
    if (start < 0) throw new Error(`Browser returned non-JSON output: ${output}`);
    result = JSON.parse(output.slice(start));
  }
  if (!result.pass) throw new Error("Content wrap browser test did not pass.");
  console.log(`content-wrap-ui PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
