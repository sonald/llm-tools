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
const session = `sjv-search-ui-${process.pid}`;

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
const {SearchView}=await import("/src/search-view.ts");
const {CollectionList}=await import("/src/collection-list.ts");
const {RawView,MAX_ENTRY_BYTES}=await import("/src/raw-view.ts");
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const scope=(overrides={})=>({label:"Document root",description:"Current scope: Document root.",enabled:true,decodedEnabled:true,scopeStart:0,scopeEnd:1000,sessionRevision:7,targetNodeId:null,...overrides});
const page=(overrides={})=>({matches:[],hasMore:false,nextCursor:null,...overrides});
const decodedMatch=(overrides={})=>({nodeId:4,field:"value",pathSegments:["$","message"],pathTruncated:false,sourceSpanStart:20,sourceSpanEnd:42,matchStart:0,matchEnd:6,...overrides});
const decodedCursor=(overrides={})=>({kind:"decoded",nodeId:4,field:"value",byteOffset:6,query:"needle",sessionRevision:7,scopeId:null,targetNodeId:null,...overrides});
const rawCursor=(overrides={})=>({kind:"rawSource",byteOffset:6,query:"needle",sessionRevision:7,scopeId:null,targetNodeId:null,...overrides});
const makeSearch=(invoke,onReveal=()=>{},onError=()=>{})=>{
  const host=document.createElement("div");
  host.innerHTML='<section id="test-search-panel"><form id="test-search" role="search" aria-describedby="test-search-description"><label>Query <input id="test-query" name="query" type="search"></label><fieldset><legend>Search in</legend><label><input id="test-decoded" type="radio" name="representation" value="decoded" checked> Decoded</label><label><input id="test-raw" type="radio" name="representation" value="rawSource"> Raw Source</label><button id="test-submit" type="submit">Search</button><p id="test-search-description"></p></form><div id="test-results-panel"><div id="test-status" role="status"></div><div id="test-results" role="list"></div><button id="test-prev" type="button">Previous page</button><button id="test-next" type="button">Next page</button></div></section>';
  document.body.append(host);
  const el={form:host.querySelector("form"),query:host.querySelector("#test-query"),decoded:host.querySelector("#test-decoded"),rawSource:host.querySelector("#test-raw"),submit:host.querySelector("#test-submit"),description:host.querySelector("#test-search-description"),panel:host.querySelector("#test-search-panel"),resultsPanel:host.querySelector("#test-results-panel"),status:host.querySelector("#test-status"),results:host.querySelector("#test-results"),previous:host.querySelector("#test-prev"),next:host.querySelector("#test-next")};
  const view=new SearchView({...el,invoke,onReveal,onError});
  return {host,el,view};
};

const collectionHost=document.createElement("div");
collectionHost.innerHTML='<section class="collection-navigation"><label>Go to Item <input id="item-go"></label><button id="item-go-button">Go</button><span id="item-go-error"></span><div class="collection-list" id="item-list" role="listbox"></div><div id="item-status"></div><button id="item-retry">Retry</button></section>';
document.body.append(collectionHost);
const collectionCalls=[];
const collectionSelections=[];
const collectionRoot={id:1,kind:"array",spanStart:0,spanEnd:20_000_000,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:1_000_000};
const collection= new CollectionList({
  section:collectionHost.querySelector("section"),
  goInput:collectionHost.querySelector("#item-go"),
  goButton:collectionHost.querySelector("#item-go-button"),
  goError:collectionHost.querySelector("#item-go-error"),
  list:collectionHost.querySelector("#item-list"),
  status:collectionHost.querySelector("#item-status"),
  retry:collectionHost.querySelector("#item-retry"),
  invoke:async(command,args)=>{
    collectionCalls.push({command,args});
    const start=args.cursor;
    const end=Math.min(1_000_000,start+200);
    return {nodes:Array.from({length:end-start},(_,index)=>({id:2+start+index,kind:"object",spanStart:start+index+1,spanEnd:start+index+2,label:"["+String(start+index)+"]",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0})),hasMore:end<1_000_000,nextCursor:end<1_000_000?end:null};
  },
  onSelection:(node,ordinal)=>collectionSelections.push({node,ordinal}),
  onError:(error)=>{throw error;}
});
collection.setSession({revision:7,root:collectionRoot,sourceSize:20_000_000});
await settle();
const collectionList=collectionHost.querySelector("#item-list");
collectionList.style.height="240px";
collectionList.style.width="320px";
await settle();
check(collectionCalls[0]?.command==="get_children"&&collectionCalls[0].args.limit===200&&collectionCalls[0].args.cursor===0,"Collection Item list did not use bounded get_children pages");
check(collectionList.querySelectorAll("[role=option]").length<=400,"Collection Item list exceeded two bounded IPC pages");
check(Number.parseFloat(collectionList.querySelector(".collection-list-spacer")?.style.height||"0")===24_000_000,"Collection Item spacer does not map one million rows within the browser limit");
collectionHost.querySelector("#item-go").value="999999";
collectionHost.querySelector("#item-go-button").click();
await settle();
check(collectionCalls.some((call)=>call.args.cursor===999800),"Go to Item did not fetch the final bounded page");
const endItem=collectionList.querySelector('[data-item-ordinal="999999"]');
check(endItem!==null,"Collection Item list did not reach the final Item; calls="+JSON.stringify(collectionCalls.map((call)=>call.args.cursor))+" scroll="+collectionList.scrollTop+" client="+collectionList.clientHeight+" height="+collectionList.scrollHeight+" window="+collectionList.querySelector(".collection-list-window")?.style.top+" first="+collectionList.querySelector("[role=option]")?.dataset.itemOrdinal+" status="+collectionHost.querySelector("#item-status").textContent);
const endRect=endItem.getBoundingClientRect();
const listRect=collectionList.getBoundingClientRect();
check(endRect.top>=listRect.top&&endRect.bottom<=listRect.bottom&&endRect.height>0,"final Item was not physically inside the scroll viewport");
const endHit=document.elementFromPoint((endRect.left+endRect.right)/2,(endRect.top+endRect.bottom)/2);
check(endHit===endItem||endItem.contains(endHit),"final Item center was not hit-testable in the viewport");
endItem.click();
check(collectionSelections.at(-1)?.ordinal===999999,"Collection Item selection did not expose the zero-based ordinal");
collectionHost.querySelector('#item-go').value="199";
collectionHost.querySelector('#item-go-button').click();
await settle();
const row199=collectionList.querySelector('[data-item-ordinal="199"]');
const row200=collectionList.querySelector('[data-item-ordinal="200"]');
const row199Rect=row199.getBoundingClientRect();
const row200Rect=row200.getBoundingClientRect();
check(row199Rect.bottom>listRect.top&&row200Rect.top<listRect.bottom,"199→200 viewport boundary left a blank visible row");
const row200Hit=document.elementFromPoint((row200Rect.left+row200Rect.right)/2,(row200Rect.top+row200Rect.bottom)/2);
check(row200Hit===row200||row200.contains(row200Hit),"Item 200 was not hit-testable across the viewport boundary");
row200.click();
check(collectionSelections.at(-1)?.ordinal===200,"viewport boundary Item selection did not expose its ordinal");
collectionHost.remove();

const deferredHost=document.createElement("div");
deferredHost.innerHTML='<section class="collection-navigation"><div class="collection-list" id="deferred-list" role="listbox"></div><input id="deferred-go"><button id="deferred-go-button">Go</button><span id="deferred-error"></span><div id="deferred-status"></div><button id="deferred-retry">Retry</button></section>';
document.body.append(deferredHost);
deferredHost.querySelector("section").style.height="300px";
const deferredCalls=[];
const deferredPage=(start)=>{const end=Math.min(600,start+200);return {nodes:Array.from({length:end-start},(_,index)=>({id:1000+start+index,kind:"number",spanStart:start+index+1,spanEnd:start+index+2,label:"["+String(start+index)+"]",labelHasMore:false,valuePreview:String(start+index),valueHasMore:false,childCount:0})),hasMore:end<600,nextCursor:end<600?end:null};};
const deferredCollection=new CollectionList({
  section:deferredHost.querySelector("section"),
  goInput:deferredHost.querySelector("#deferred-go"),
  goButton:deferredHost.querySelector("#deferred-go-button"),
  goError:deferredHost.querySelector("#deferred-error"),
  list:deferredHost.querySelector("#deferred-list"),
  status:deferredHost.querySelector("#deferred-status"),
  retry:deferredHost.querySelector("#deferred-retry"),
  invoke:async(command,args)=>new Promise((resolve)=>deferredCalls.push({command,args,resolve})),
  onSelection:()=>{},
  onError:(error)=>{throw error;}
});
const deferredList=deferredHost.querySelector("#deferred-list");
deferredList.style.height="240px";
deferredList.style.width="320px";
deferredCollection.setSession({revision:8,root:{id:2,kind:"array",spanStart:0,spanEnd:10_000,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:600},sourceSize:10_000});
await settle();
deferredCalls.shift().resolve(deferredPage(0));
await settle();
await settle();
check(deferredList.clientHeight>0&&deferredList.scrollHeight>deferredList.clientHeight,"deferred Collection list did not have a real scroll viewport");
deferredList.scrollTop=200*24;
deferredList.dispatchEvent(new Event("scroll"));
await settle();
await settle();
deferredList.scrollTop=400*24;
deferredList.dispatchEvent(new Event("scroll"));
deferredList.scrollTop=200*24;
deferredList.dispatchEvent(new Event("scroll"));
await settle();
const pendingPage200=deferredCalls.filter((call)=>call.args.cursor===200).at(-1);
check(pendingPage200!==undefined,"deferred scroll regression did not create the Item 200 request");
pendingPage200.resolve(deferredPage(200));
await settle();
check(deferredList.querySelector('[data-item-ordinal="200"]')!==null&&deferredList.querySelector(".collection-list-window")?.style.top==="4800px","latest scroll intent did not return to the inflight Item 200 page; calls="+JSON.stringify(deferredCalls.map((call)=>call.args.cursor))+" top="+deferredList.querySelector(".collection-list-window")?.style.top+" first="+deferredList.querySelector("[role=option]")?.dataset.itemOrdinal+" wantedScroll="+deferredList.scrollTop);
deferredHost.remove();

const appForm=document.querySelector('form[role="search"]');
check(appForm instanceof HTMLFormElement,"the app search form is not native");
check(appForm.querySelector('input[name="query"]') instanceof HTMLInputElement,"native query input is missing");
check(appForm.querySelectorAll('input[type="radio"]').length===2,"decoded/raw radio controls are missing");
check(appForm.querySelector('button[type="submit"]') instanceof HTMLButtonElement,"native search submit is missing");

const previousTauri=window.__TAURI_INTERNALS__;
const mainTauriCalls=[];
let mainCollectionMode=false;
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
  mainTauriCalls.push({command,args});
  if(command==="plugin:dialog|open") return "/tmp/search-ui-document.json";
  if(command==="open_file") return mainCollectionMode
    ? {path:"/tmp/search-ui-collection.json",size:100,mode:"collection",root:{id:1,kind:"array",spanStart:0,spanEnd:100,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:2},progress:null,manyInvalidUtf8Warning:false,documentError:null,sessionRevision:22}
    : {path:"/tmp/search-ui-document.json",size:262300,mode:"document",root:{id:1,kind:"object",spanStart:200,spanEnd:262200,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0},progress:null,manyInvalidUtf8Warning:false,documentError:null,sessionRevision:21};
  if(command==="get_children" && mainCollectionMode) return {nodes:[{id:10,kind:"object",spanStart:10,spanEnd:40,label:"[0]",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0},{id:11,kind:"object",spanStart:50,spanEnd:80,label:"[1]",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0}],hasMore:false,nextCursor:null};
  if(command==="read_raw_slice" && mainCollectionMode) return {start:args.sourceStart,text:"A".repeat(args.length),hasMore:false,nextOffset:null};
  if(command==="search_current" && mainCollectionMode) return args.representation==="rawSource"
    ? {matches:[{nodeId:args.nodeId,field:"rawSource",pathSegments:["$","[0]"],pathTruncated:false,sourceSpanStart:10,sourceSpanEnd:40,matchStart:20,matchEnd:26}],hasMore:false,nextCursor:null}
    : {matches:[{nodeId:args.nodeId,field:"value",pathSegments:["$","[0]"],pathTruncated:false,sourceSpanStart:10,sourceSpanEnd:40,matchStart:0,matchEnd:6}],hasMore:false,nextCursor:null};
  if(command==="search_current") return {matches:[],hasMore:false,nextCursor:null};
  throw new Error("unexpected main mock command "+command);
}};
document.getElementById("open-file").click();
await settle();
const mainSearchPanel=document.getElementById("scope-search-panel");
const mainQuery=document.getElementById("scope-search-query");
check(mainTauriCalls.some((call)=>call.command==="open_file")&&!mainSearchPanel.hidden&&!mainQuery.disabled,"main did not open a scope with a visible enabled search form");
const mainFindEvent=new KeyboardEvent("keydown",{key:"f",ctrlKey:true,bubbles:true,cancelable:true});
document.dispatchEvent(mainFindEvent);
check(mainFindEvent.defaultPrevented&&document.activeElement===mainQuery&&mainQuery.selectionStart===0&&mainQuery.selectionEnd===mainQuery.value.length,"main Cmd/Ctrl+F did not focus/select the query");
const modeDialog=document.getElementById("mode-dialog");
modeDialog.showModal();
const modalFindEvent=new KeyboardEvent("keydown",{key:"f",ctrlKey:true,bubbles:true,cancelable:true});
document.dispatchEvent(modalFindEvent);
check(!modalFindEvent.defaultPrevented,"Cmd/Ctrl+F was prevented while a modal was open");
modeDialog.close();
mainQuery.value="";
document.getElementById("scope-search").requestSubmit();
await settle();
check(mainSearchPanel.hidden===false&&document.getElementById("error-region").hidden,"empty main query raised an Open failed banner");
mainQuery.value="needle";
document.getElementById("scope-search").requestSubmit();
await settle();
check(document.getElementById("error-region").hidden&&document.getElementById("scope-search-status").textContent.includes("No matches"),"valid search did not clear the local query error");
mainCollectionMode=true;
document.getElementById("open-file").click();
await settle();
const mainCollectionList=document.getElementById("collection-list");
check(!document.getElementById("collection-navigation").hidden&&mainCollectionList.querySelectorAll("[role=option]").length===2,"main Collection Item list was not visible after opening");
check(document.getElementById("tree-tab").disabled&&document.getElementById("raw-tab").disabled&&document.getElementById("scope-search-submit").disabled,"Tree/Raw/search were enabled before selecting an Item");
mainCollectionList.querySelector('[data-item-ordinal="0"]').click();
await settle();
check(!document.getElementById("tree-tab").disabled&&!document.getElementById("raw-tab").disabled&&!document.getElementById("scope-search-submit").disabled,"selecting an Item did not enable Tree/Raw/search");
check(document.getElementById("scope-search-description").textContent.includes("Item 0"),"selected Item was not named as the current search scope");
mainQuery.value="needle";
document.getElementById("scope-search").requestSubmit();
await settle();
const itemDecodedCall=mainTauriCalls.filter((call)=>call.command==="search_current").at(-1);
check(itemDecodedCall?.args.nodeId===10&&itemDecodedCall.args.representation==="decoded","main selected Item decoded search did not bind nodeId");
document.getElementById("scope-search-representation-raw").click();
mainQuery.value="needle";
document.getElementById("scope-search").requestSubmit();
await settle();
const itemRawCall=mainTauriCalls.filter((call)=>call.command==="search_current").at(-1);
check(itemRawCall?.args.nodeId===10&&itemRawCall.args.representation==="rawSource","main selected Item Raw search did not bind nodeId");
document.querySelector("#scope-search-results button")?.click();
await settle();
check(mainTauriCalls.some((call)=>call.command==="read_raw_slice"&&call.args.sourceStart===20),"main Item Raw result did not reveal the exact match offset");
check(document.querySelector("#raw-panel mark")?.textContent?.length===6,"main Item Raw result highlighted the whole Item");
mainCollectionList.querySelector('[data-item-ordinal="1"]').click();
await settle();
check(document.getElementById("scope-search-results").children.length===0&&document.getElementById("scope-search-description").textContent.includes("Item 1"),"switching Items did not clear stale search results and scope");
if(previousTauri===undefined) delete window.__TAURI_INTERNALS__; else window.__TAURI_INTERNALS__=previousTauri;

const noSelection=makeSearch(async()=>page());
noSelection.view.setScope(scope({label:"Selected Entry",description:"Select an Entry to enable search.",enabled:false,scopeEnd:0}));
check(noSelection.el.query.disabled&&noSelection.el.submit.disabled,"search remained enabled without an Entry selection");
check(noSelection.el.description.textContent.includes("Select an Entry"),"current Entry scope explanation is missing");
noSelection.host.remove();

const calls=[];
let basicReveal=null;
const basic=makeSearch(async(command,args)=>{calls.push({command,args});return page({matches:[decodedMatch({matchEnd:10})],hasMore:false,nextCursor:null});},(match)=>{basicReveal=match;});
basic.view.setScope(scope());
basic.el.query.value="  needle  ";
basic.el.form.requestSubmit();
await settle();
check(calls.length===1&&calls[0].command==="search_current","decoded search did not call search_current");
check(calls[0].args.query==="  needle  ","search query was trimmed");
check(calls[0].args.representation==="decoded"&&calls[0].args.scopeId===null&&calls[0].args.nodeId===null,"decoded search request scope is wrong");
check(calls[0].args.cursor===null&&calls[0].args.limit===50&&calls[0].args.sessionRevision===7,"decoded search request paging is wrong");
check(basic.el.results.querySelectorAll("button").length===1,"decoded search result is not a native button");
basic.el.results.querySelector("button").click();
check(basicReveal?.sourceSpanStart===20&&basicReveal?.matchStart===0,"decoded result button did not preserve source span separately from decoded offset");
check(basic.el.next.disabled,"next page was enabled without hasMore");

const itemCalls=[];
const itemSearch=makeSearch(async(command,args)=>{itemCalls.push({command,args});return page({matches:[args.representation==="rawSource"?{nodeId:77,field:"rawSource",pathSegments:["$","[3]"],pathTruncated:false,sourceSpanStart:100,sourceSpanEnd:160,matchStart:120,matchEnd:126}:decodedMatch({sourceSpanStart:110,sourceSpanEnd:120,matchEnd:6})],hasMore:false,nextCursor:null});});
itemSearch.view.setScope(scope({label:"Item 3",description:"Current scope: selected Item 3.",scopeStart:100,scopeEnd:160,targetNodeId:77}));
itemSearch.el.query.value="needle";
itemSearch.el.form.requestSubmit();
await settle();
check(itemCalls[0].args.nodeId===77,"selected Item decoded search did not bind its node target");
check(itemSearch.el.results.querySelector("button")!==null,"selected Item decoded result was not rendered");
itemSearch.el.rawSource.checked=true;
itemSearch.el.rawSource.dispatchEvent(new Event("change",{bubbles:true}));
itemSearch.el.query.value="needle";
itemSearch.el.form.requestSubmit();
await settle();
check(itemCalls.at(-1).args.nodeId===77&&itemCalls.at(-1).args.representation==="rawSource","selected Item raw search did not bind its node target");
check(itemSearch.el.results.querySelector("button")?.textContent?.includes("match [120, 126)")&&itemSearch.el.results.querySelector("button")?.title.includes("match [120, 126)"),"raw target result did not expose the exact match range");
itemSearch.host.remove();

basic.el.query.value="changed";
basic.el.query.dispatchEvent(new Event("input",{bubbles:true}));
check(basic.el.query.value==="changed"&&basic.el.results.children.length===0&&basic.el.next.disabled,"query edit did not clear old search results while retaining the query");
basic.el.rawSource.checked=true;
basic.el.rawSource.dispatchEvent(new Event("change",{bubbles:true}));
check(basic.el.results.children.length===0&&basic.el.rawSource.checked,"representation edit did not clear search history");

const rawCalls=[];
const rawSearch=makeSearch(async(command,args)=>{rawCalls.push({command,args});return page({matches:[{nodeId:null,field:"rawSource",pathSegments:["$"],pathTruncated:false,sourceSpanStart:5,sourceSpanEnd:11,matchStart:5,matchEnd:11}],hasMore:false,nextCursor:null});});
rawSearch.view.setScope(scope({decodedEnabled:false,description:"Raw-only Document · Raw Source only."}));
check(rawSearch.el.decoded.disabled&&rawSearch.el.rawSource.checked,"raw-only scope did not force Raw Source");
rawSearch.el.query.value="\\\\u4f60";
rawSearch.el.form.requestSubmit();
await settle();
check(rawCalls[0].args.representation==="rawSource"&&rawCalls[0].args.query==="\\\\u4f60","raw search representation/query changed");
check(rawSearch.el.results.querySelector("button")?.textContent?.includes("Raw Source"),"raw result label is missing");
rawSearch.host.remove();

const validationCalls=[];
const validationErrors=[];
const validation=makeSearch(async(command,args)=>{validationCalls.push({command,args});return page();},()=>{},(error)=>validationErrors.push(error));
validation.view.setScope(scope());
validation.el.query.value="";
validation.el.form.requestSubmit();
await settle();
check(validationCalls.length===0&&validationErrors.length===0&&validation.el.status.getAttribute("role")==="alert","empty query was not rejected locally");
validation.el.query.value="x".repeat(4097);
validation.el.form.requestSubmit();
await settle();
check(validationCalls.length===0&&validationErrors.length===0&&validation.el.status.textContent.includes("4096-byte"),"oversized query was sent to IPC");
validation.el.query.value="needle";
validation.el.form.requestSubmit();
await settle();
check(validationCalls.length===1&&validationErrors.length===0&&validation.el.status.getAttribute("role")==="status","valid search did not clear the local query alert");
validation.host.remove();

const globalErrors=[];
const globalFailure=makeSearch(async()=>{throw {code:"file_changed",message:"file changed"};},()=>{},(error)=>globalErrors.push(error));
globalFailure.view.setScope(scope());
globalFailure.el.query.value="needle";
globalFailure.el.form.requestSubmit();
await settle();
check(globalErrors.length===1&&globalFailure.el.status.textContent==="file changed","global search invalidation did not reach main");
globalFailure.host.remove();

const continuationCalls=[];
const continuation=makeSearch(async(command,args)=>{
  continuationCalls.push({command,args});
  return continuationCalls.length===1
    ? page({matches:[],hasMore:true,nextCursor:rawCursor({byteOffset:1})})
    : page({matches:[{nodeId:null,field:"rawSource",pathSegments:["$"],pathTruncated:false,sourceSpanStart:12,sourceSpanEnd:18,matchStart:12,matchEnd:18}],hasMore:false,nextCursor:null});
});
continuation.view.setScope(scope());
continuation.el.rawSource.checked=true;
continuation.el.query.value="needle";
continuation.el.form.requestSubmit();
await settle();
check(continuation.el.next.disabled===false&&continuation.el.status.textContent.includes("more results"),"empty continuation page lost Next");
continuation.el.next.click();
await settle();
check(continuationCalls.length===2&&continuationCalls[1].args.cursor?.byteOffset===1,"cursor continuation did not advance from history");
check(continuation.el.results.querySelectorAll("button").length===1,"continuation result page was not rendered");
check(continuation.el.previous.disabled===false,"previous page history was not retained");

const malformedErrors=[];
const malformed=makeSearch(async()=>({matches:[],hasMore:true,nextCursor:null}),()=>{},(error)=>malformedErrors.push(error));
malformed.view.setScope(scope());
malformed.el.query.value="needle";
malformed.el.form.requestSubmit();
await settle();
check(malformedErrors.length===0&&malformed.el.status.textContent.includes("invalid")&&malformed.el.status.getAttribute("role")==="alert","malformed hasMore/nextCursor escaped as a global error");
malformed.host.remove();

const strictErrors=[];
const strict=makeSearch(async()=>({matches:[{...decodedMatch(),sourceSpanEnd:1001}],hasMore:false,nextCursor:null}),()=>{},(error)=>strictErrors.push(error));
strict.view.setScope(scope());
strict.el.query.value="needle";
strict.el.form.requestSubmit();
await settle();
check(strictErrors.length===0&&strict.el.status.getAttribute("role")==="alert","out-of-scope source span escaped as a global error");
strict.host.remove();

const malformedPathErrors=[];
const malformedPath=makeSearch(async()=>({matches:[{...decodedMatch(),pathSegments:["$",""]}],hasMore:false,nextCursor:null}),()=>{},(error)=>malformedPathErrors.push(error));
malformedPath.view.setScope(scope());
malformedPath.el.query.value="needle";
malformedPath.el.form.requestSubmit();
await settle();
check(malformedPathErrors.length===0&&malformedPath.el.status.getAttribute("role")==="alert","empty path segments bypassed the bounded path contract");
malformedPath.host.remove();

const deepPath=makeSearch(async()=>({matches:[{...decodedMatch(),pathSegments:["$",...Array(682).fill("x")]}],hasMore:false,nextCursor:null}));
deepPath.view.setScope(scope());
deepPath.el.query.value="needle";
deepPath.el.form.requestSubmit();
await settle();
check(deepPath.el.results.children.length===1,"valid deep path segments were rejected");
deepPath.host.remove();

const malformedRawErrors=[];
const malformedRaw=makeSearch(async()=>({matches:[{nodeId:null,field:"rawSource",pathSegments:["$"],pathTruncated:false,sourceSpanStart:5,sourceSpanEnd:10,matchStart:5,matchEnd:10}],hasMore:false,nextCursor:null}),()=>{},(error)=>malformedRawErrors.push(error));
malformedRaw.view.setScope(scope());
malformedRaw.el.rawSource.checked=true;
malformedRaw.el.query.value="needle";
malformedRaw.el.form.requestSubmit();
await settle();
check(malformedRawErrors.length===0&&malformedRaw.el.status.getAttribute("role")==="alert","raw result accepted a match length different from the UTF-8 query");
malformedRaw.host.remove();

const malformedCursorErrors=[];
const malformedCursor=makeSearch(async()=>({matches:[],hasMore:true,nextCursor:rawCursor({query:"other",byteOffset:1})}),()=>{},(error)=>malformedCursorErrors.push(error));
malformedCursor.view.setScope(scope());
malformedCursor.el.rawSource.checked=true;
malformedCursor.el.query.value="needle";
malformedCursor.el.form.requestSubmit();
await settle();
check(malformedCursorErrors.length===0&&malformedCursor.el.status.getAttribute("role")==="alert","cursor query binding was not checked");
malformedCursor.host.remove();

let releaseLate;
const latePromise=new Promise((resolve)=>{releaseLate=resolve;});
const late=makeSearch(async()=>latePromise);
late.view.setScope(scope());
late.el.query.value="needle";
late.el.form.requestSubmit();
await Promise.resolve();
late.view.setScope(scope({sessionRevision:8}));
releaseLate(page({matches:[decodedMatch()],hasMore:false,nextCursor:null}));
await settle();
check(late.el.results.children.length===0&&late.el.status.textContent==="","late response repopulated a changed scope");
late.host.remove();

const errorCalls=[];
const failed=makeSearch(async()=>{throw {code:"invalid_request",message:"mock search failed"};},()=>{},(error)=>errorCalls.push(error));
failed.view.setScope(scope());
failed.el.query.value="needle";
failed.el.form.requestSubmit();
await settle();
check(errorCalls.length===0&&failed.el.status.textContent==="mock search failed"&&failed.el.status.getAttribute("role")==="alert","ordinary search error escaped to the main error banner");
failed.view.focusQuery();
check(document.activeElement===failed.el.query&&failed.el.query.selectionStart===0&&failed.el.query.selectionEnd===6,"Cmd/Ctrl+F target did not focus and select query");
failed.el.resultsPanel.hidden=false;
const escapeEvent=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
check(failed.view.handleEscape(escapeEvent)&&!failed.el.panel.hidden&&failed.el.resultsPanel.hidden&&document.activeElement===failed.el.query,"Escape did not return from results to query");
failed.host.remove();

const rawHost=document.createElement("div");
const rawPanel=document.createElement("section");
const rawTab=document.createElement("button");
rawHost.append(rawPanel,rawTab);
document.body.append(rawHost);
const rawCallsForReveal=[];
const raw=new RawView({panel:rawPanel,tab:rawTab,invoke:async(command,args)=>{
  rawCallsForReveal.push({command,args});
  if(command!=="read_raw_slice") throw new Error("unexpected parsed raw command "+command);
  const size=Math.min(131072,args.length);
  return {start:args.sourceStart,text:"A".repeat(size),hasMore:args.sourceStart+size<262300,nextOffset:args.sourceStart+size<262300?args.sourceStart+size:null};
},onError:()=>{}});
const rootNode={id:1,kind:"object",spanStart:200,spanEnd:262200,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:1};
raw.setSession(9,rootNode,262300,"document");
raw.revealRange(10,12,"decoded escape");
raw.activate();
await settle();
check(rawCallsForReveal[0]?.command==="read_raw_slice"&&rawCallsForReveal[0].args.sourceStart===10,"Raw reveal did not seek from the decoded source span");
check(rawCallsForReveal[0].args.length===131072,"Raw reveal did not request the first 128 KiB page");
check(rawPanel.querySelector("mark")!==null,"Raw reveal did not mark the source intersection");
check(document.activeElement===rawPanel.querySelector(".raw-chunk"),"Raw reveal did not focus the raw content");
raw.deactivate();
raw.setScope({...rootNode,id:2,spanStart:300,spanEnd:310});
const beforeNonzero=rawCallsForReveal.length;
raw.revealRange(10,12,"raw source");
raw.activate();
await settle();
check(rawCallsForReveal.length>beforeNonzero&&rawCallsForReveal.at(-1).args.sourceStart===10,"Tree setScope replaced the Raw base scope");
raw.revealRange(262300,262302,"outside");
check(rawCallsForReveal.at(-1).args.sourceStart===10,"out-of-bounds Raw reveal issued an IPC read");
raw.deactivate();
raw.setItemSession(10,{id:77,kind:"object",spanStart:100,spanEnd:160,label:"[0]",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0},262300,"collection");
raw.revealRange(120,126,"raw Item match");
raw.activate();
await settle();
check(rawCallsForReveal.at(-1)?.args.sourceStart===120,"Item Raw reveal did not seek the exact raw match");
check(rawPanel.querySelector("mark")?.textContent?.length===6,"Item Raw reveal highlighted the whole Item instead of the match");
rawHost.remove();

const validEntryHost=document.createElement("div");
const validEntryPanel=document.createElement("section");
const validEntryTab=document.createElement("button");
validEntryHost.append(validEntryPanel,validEntryTab);
document.body.append(validEntryHost);
const validEntryCalls=[];
const validEntryRaw=new RawView({panel:validEntryPanel,tab:validEntryTab,invoke:async(command,args)=>{
  validEntryCalls.push({command,args});
  if(command==="read_selected_entry_window") return {start:args.offset,bytes:new Array(args.length).fill(65),hasMore:false,nextOffset:null};
  if(command==="read_raw_slice") return {start:args.sourceStart,text:"zz",hasMore:false,nextOffset:null};
  throw new Error("unexpected valid Entry Raw command "+command);
},onError:()=>{}});
const validEntryRoot={id:3,kind:"object",spanStart:20,spanEnd:30,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:1};
validEntryRaw.setSession(15,validEntryRoot,100,"entry");
validEntryRaw.revealRange(5,7,"valid Entry result");
validEntryRaw.activate();
await settle();
check(validEntryCalls[0]?.command==="read_selected_entry_window"&&validEntryCalls[0].args.offset===5,"valid Entry root-outside reveal did not use the selected Entry window");
validEntryRaw.deactivate();
validEntryRaw.setScope({...validEntryRoot,id:4,spanStart:22,spanEnd:24});
validEntryRaw.activate();
await settle();
check(validEntryCalls.at(-1)?.command==="read_raw_slice"&&validEntryCalls.at(-1).args.sourceStart===22,"Tree node Raw behavior was not kept independent");
validEntryHost.remove();

const entryHost=document.createElement("div");
const entryPanel=document.createElement("section");
const entryTab=document.createElement("button");
entryHost.append(entryPanel,entryTab);
document.body.append(entryHost);
const entryCalls=[];
let oversizedMode=false;
const entryRaw=new RawView({panel:entryPanel,tab:entryTab,invoke:async(command,args)=>{
  entryCalls.push({command,args});
  check(command==="read_selected_entry_window","selected Entry Raw used an obsolete IPC command");
  if(args.offset===0&&!oversizedMode) return {start:0,bytes:[34,255,34,10],hasMore:false,nextOffset:null};
  return {start:args.offset,bytes:new Array(args.length).fill(65),hasMore:args.offset+args.length<MAX_ENTRY_BYTES+131073,nextOffset:args.offset+args.length<MAX_ENTRY_BYTES+131073?args.offset+args.length:null};
},onError:()=>{}});
entryRaw.setNonValidEntry(10,{status:"invalidUtf8",location:{entryOrdinal:0,sourceLine:1,byteStart:100,byteEnd:104}});
entryRaw.activate();
await settle();
check(entryCalls[0]?.args.offset===0&&entryCalls[0].args.length===4,"invalid UTF-8 Entry did not use relative bounded bytes");
check(entryPanel.textContent.includes("lossy")||entryPanel.textContent.includes("Original"),"invalid UTF-8 Entry state is missing");
entryRaw.deactivate();
entryCalls.length=0;
oversizedMode=true;
entryRaw.setNonValidEntry(11,{status:"oversized",location:{entryOrdinal:1,sourceLine:2,byteStart:500,byteEnd:500+MAX_ENTRY_BYTES+131073}});
entryRaw.activate();
await settle();
check(entryCalls[0]?.command==="read_selected_entry_window"&&entryCalls[0].args.offset===0&&entryCalls[0].args.length===131072,"oversized Entry did not load its first 128 KiB window");
const nextButton=Array.from(entryPanel.querySelectorAll("button")).find((button)=>button.textContent==="Next");
check(nextButton instanceof HTMLButtonElement&&!nextButton.disabled,"oversized Entry middle paging was disabled");
nextButton.click();
await settle();
check(entryCalls.some((call)=>call.command==="read_selected_entry_window"&&call.args.offset===131072),"oversized Entry did not read the middle window");
check(!entryCalls.some((call)=>call.command==="get_oversized_preview"),"oversized Entry still used head/tail preview IPC");
entryHost.remove();

const rawDocumentHost=document.createElement("div");
const rawDocumentPanel=document.createElement("section");
const rawDocumentTab=document.createElement("button");
rawDocumentHost.append(rawDocumentPanel,rawDocumentTab);
document.body.append(rawDocumentHost);
let rawDocumentCommand="";
const rawDocument=new RawView({panel:rawDocumentPanel,tab:rawDocumentTab,invoke:async(command,args)=>{rawDocumentCommand=command;return {start:args.offset,bytes:[123,125],hasMore:false,nextOffset:null};},onError:()=>{}});
rawDocument.setRawDocument(12,2,{code:"invalid_json",message:"bad",parseError:{message:"bad",byteOffset:1,line:1,column:2}});
rawDocument.activate();
await settle();
check(rawDocumentCommand==="read_raw_document_bytes","Raw-only Document changed its byte IPC");
rawDocumentHost.remove();

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
  if (!result.pass) throw new Error("Search UI browser test did not pass.");
  console.log(`search-ui PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
