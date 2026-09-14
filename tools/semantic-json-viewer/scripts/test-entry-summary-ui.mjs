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
const session = `sjv-entry-summary-ui-${process.pid}`;

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
  return `(async () => {
Object.defineProperty(globalThis,"navigator",{configurable:true,value:{language:"en-US"}});
let pageMode="positive";
let appPhase=false;
let appOpenCount=0;
let listCalls=0;
let tailEntries=[];
let lateResolve=null;
const tauriCalls=[];
let selectionMode="valid";
const errors=[];
const selections=[];
let assertions=0;
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const waitFrames=async(count)=>{for(let frame=0;frame<count;frame+=1)await new Promise((resolve)=>requestAnimationFrame(()=>resolve()));};
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const waitFor=async(predicate,message)=>{for(let attempt=0;attempt<80;attempt+=1){await settle();if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,25));}throw new Error(message);};
await waitFor(()=>document.documentElement.dataset.testAppReady==="true","test app fixture did not finish main initialization");
const positiveEntries=[
  {location:{entryOrdinal:0,sourceLine:1,byteStart:0,byteEnd:190},status:"valid",parseError:null,eventSummary:{timestamp:{value:"2026-09-14T10:32:04Z",hasMore:false},eventType:{value:"tool_call",hasMore:true},grouping:{value:"<img src=x onerror=alert(1)>",hasMore:false}}},
  {location:{entryOrdinal:1,sourceLine:2,byteStart:191,byteEnd:230},status:"valid",parseError:null,eventSummary:null},
  {location:{entryOrdinal:2,sourceLine:3,byteStart:231,byteEnd:270},status:"valid",parseError:null}
];
for(let ordinal=positiveEntries.length;ordinal<400;ordinal+=1){positiveEntries.push({location:{entryOrdinal:ordinal,sourceLine:ordinal+1,byteStart:ordinal*10,byteEnd:ordinal*10+9},status:"valid",parseError:null});}
const negativeEntries=[{location:{entryOrdinal:0,sourceLine:1,byteStart:0,byteEnd:40},status:"valid",parseError:null,eventSummary:{timestamp:null,eventType:{value:"training_sample",hasMore:false},grouping:null}}];
const unicodeEntry={location:{entryOrdinal:0,sourceLine:1,byteStart:0,byteEnd:1000},status:"valid",parseError:null,eventSummary:{timestamp:null,eventType:{value:"😀".repeat(256),hasMore:true},grouping:null}};
const invalidUnicodeEntry={...unicodeEntry,eventSummary:{timestamp:null,eventType:{value:"😀".repeat(257),hasMore:false},grouping:null}};
const appEntry={...positiveEntries[0],eventSummary:{timestamp:{value:"2026-09-14T10:32:04Z",hasMore:false},eventType:{value:"message",hasMore:false},grouping:{value:"session-17",hasMore:false}}};
const appRoot={id:101,kind:"object",spanStart:0,spanEnd:190,label:"$",labelHasMore:false,valuePreview:null,valueHasMore:false,childCount:0};
const progress=(complete,eventStreamHint,totalEntries)=>({indexedEntries:complete?totalEntries:3,indexedSourceLines:complete?totalEntries:3,complete,stride:1,totalEntries,eventStreamHint});
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
  tauriCalls.push({command,args});
  if(command==="plugin:dialog|open") return "/tmp/main-entry.jsonl";
  if(command==="open_file") {
    appPhase=true;
    appOpenCount+=1;
    if (appOpenCount > 1) {
      return {path:"/tmp/main-entry-invalid.jsonl",size:1000,mode:"entry",root:null,progress:{indexedEntries:1,indexedSourceLines:1,complete:true,stride:1,totalEntries:1,eventStreamHint:"yes"},manyInvalidUtf8Warning:false,documentError:null,sessionRevision:50};
    }
    return {path:"/tmp/main-entry.jsonl",size:1000,mode:"entry",root:null,progress:progress(true,true,1),manyInvalidUtf8Warning:false,documentError:null,sessionRevision:40};
  }
  if(command==="list_entries") {
    listCalls+=1;
    if(appPhase) return {entries:[appEntry],hasMore:false,nextCursor:null,progress:progress(true,true,1)};
    if(pageMode==="positive") {const start=args.start??0;const entries=positiveEntries.slice(start,start+200);return {entries,hasMore:start+entries.length<positiveEntries.length,nextCursor:start+entries.length<positiveEntries.length?start+entries.length:null,progress:{indexedEntries:400,indexedSourceLines:400,complete:false,stride:1,totalEntries:null,eventStreamHint:null}};}
    if(pageMode==="tail") return {entries:tailEntries,hasMore:false,nextCursor:null,progress:{indexedEntries:tailEntries.length,indexedSourceLines:tailEntries.length,complete:false,stride:1,totalEntries:null,eventStreamHint:null}};
    if(pageMode==="late") {
      if (args.sessionRevision===31) return new Promise((resolve)=>{lateResolve=resolve;});
      const lateEntry={location:{entryOrdinal:0,sourceLine:900,byteStart:9000,byteEnd:9010},status:"valid",parseError:null};
      return {entries:[lateEntry],hasMore:false,nextCursor:null,progress:progress(true,false,1)};
    }
    if(pageMode==="negative") return {entries:negativeEntries,hasMore:false,nextCursor:null,progress:progress(true,false,1)};
    if(pageMode==="unicode") return {entries:[unicodeEntry],hasMore:false,nextCursor:null,progress:progress(true,true,1)};
    return {entries:[invalidUnicodeEntry],hasMore:false,nextCursor:null,progress:progress(true,true,1)};
  }
  if(command==="select_entry") {
    if(appPhase) return {entry:appEntry,root:appRoot,sessionRevision:41};
    if(selectionMode==="invalid") return {entry:{...positiveEntries[0],eventSummary:{eventType:{value:42,hasMore:false}}},root:null,sessionRevision:11};
    if(selectionMode==="nonobject") return {entry:{...positiveEntries[0],eventSummary:"not-an-object"},root:null,sessionRevision:11};
    return {entry:{...positiveEntries[0],eventSummary:{...positiveEntries[0].eventSummary}},root:null,sessionRevision:11};
  }
  throw new Error("unexpected command "+command);
}};
const host=document.createElement("section");
host.className="entry-navigation";
host.innerHTML='<div class="entry-navigation-heading"><h3>Entries</h3><span>200 per page</span></div><div class="entry-go"><input id="go"><button id="go-button">Go</button><span id="go-error"></span></div><div id="list" class="entry-list" role="listbox"></div><button id="previous">Previous</button><button id="next">Next</button><div id="status"></div><button id="retry">Retry</button><aside id="inspector"><span id="ordinal"></span><span id="entry-status"></span><span id="line"></span><span id="bytes"></span><span id="parse-message"></span><span id="parse-byte"></span><span id="parse-line"></span><span id="parse-column"></span></aside><div id="navigation-state"></div>';
document.body.append(host);
const viewport=host.querySelector("#list");
viewport.style.height="180px";
viewport.style.flex="none";
let entryList;
entryList=new (await import("/src/entry-list.ts")).EntryList({
  navigation:host,
  navigationState:host.querySelector("#navigation-state"),
  goInput:host.querySelector("#go"),
  goButton:host.querySelector("#go-button"),
  goError:host.querySelector("#go-error"),
  list:host.querySelector("#list"),
  previous:host.querySelector("#previous"),
  next:host.querySelector("#next"),
  status:host.querySelector("#status"),
  retry:host.querySelector("#retry"),
  inspector:host.querySelector("#inspector"),
  inspectorOrdinal:host.querySelector("#ordinal"),
  inspectorStatus:host.querySelector("#entry-status"),
  inspectorSourceLine:host.querySelector("#line"),
  inspectorBytes:host.querySelector("#bytes"),
  inspectorParseMessage:host.querySelector("#parse-message"),
  inspectorParseByteOffset:host.querySelector("#parse-byte"),
  inspectorParseLine:host.querySelector("#parse-line"),
  inspectorParseColumn:host.querySelector("#parse-column"),
  onSelection:(selection)=>{selections.push(selection);entryList.adoptSelection(selection,selection.sessionRevision);},
  onSelectionBusy:()=>{},
  onError:(error)=>errors.push(error),
  onRevisionUnknown:()=>{},
  onProgress:()=>{}
});
entryList.setSession({revision:10,progress:{indexedEntries:400,indexedSourceLines:400,complete:false,stride:1,totalEntries:null}});
const mode=host.querySelector("select[data-entry-summary-mode]");
const options=()=>Array.from(host.querySelectorAll("[role=option]"));
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="0"),"initial Entry viewport did not mount");
check(mode instanceof HTMLSelectElement,"Entry Summary Mode native select is missing");
check(Array.from(mode.options).map((option)=>option.value).join(",")==="auto,generic,event","Entry Summary Mode options changed");
check(mode.value==="auto"&&options().length>0&&options().length<30&&options().some((option)=>option.dataset.entryOrdinal==="0")&&!options().some((option)=>option.dataset.entryOrdinal==="199"),"new JSONL session did not render a bounded first viewport");
check(options()[0].getAttribute("aria-posinset")==="1"&&options()[0].getAttribute("aria-setsize")==="-1","Entry option ARIA position used page size or omitted the unknown total incorrectly");
check(!options()[0].textContent.includes("tool_call"),"Auto rendered Event summary before the final hint");
const callsBeforeHint=listCalls;
entryList.updateProgress(progress(true,true,400),10);
await waitFor(()=>options()[0]?.textContent.includes("2026-09-14T10:32:04Z"),"Event hint did not refresh the mounted Entry options");
check(listCalls===callsBeforeHint,"Event hint arrival reread the current Entry page");
check(options()[0].textContent.includes("2026-09-14T10:32:04Z"),"Auto did not use Event summary after a positive hint");
const eventText=options()[0].textContent;
check(eventText.indexOf("2026-09-14T10:32:04Z")<eventText.indexOf("tool_call")&&eventText.indexOf("tool_call")<eventText.indexOf("<img src=x"),"Event summary order is not timestamp/type/group");
check(eventText.includes("truncated")&&options()[0].querySelector("img")===null&&eventText.includes("<img src=x onerror=alert(1)>"),"Event summary truncation or textContent safety failed");
check(!options()[1].textContent.includes("undefined")&&!options()[2].textContent.includes("undefined"),"missing Event summary did not fall back to Generic");
mode.value="generic";mode.dispatchEvent(new Event("change",{bubbles:true}));await settle();
check(!options()[0].textContent.includes("tool_call"),"Generic mode did not restore the original Entry summary");
mode.value="event";mode.dispatchEvent(new Event("change",{bubbles:true}));await settle();
check(options()[0].textContent.includes("tool_call"),"Event mode did not use available summary data");
options()[0].click();await settle();
check(mode.value==="event"&&options()[0].getAttribute("aria-selected")==="true"&&selections[0].entry.eventSummary!==null,"selection revision reset mode or dropped eventSummary");

const callsBeforeScroll=listCalls;
const topFocused=options().find((option)=>option.dataset.entryOrdinal==="0");
topFocused.focus();
viewport.scrollTop=viewport.scrollHeight-viewport.clientHeight;
viewport.dispatchEvent(new Event("scroll"));
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="199"),"manual scroll did not mount the page tail");
check(listCalls===callsBeforeScroll&&document.activeElement===viewport,"manual scroll reread the page or retained focus on an unmounted option");
check(options().some((option)=>option.dataset.entryOrdinal==="199")&&options().length<30,"scrolling to the page tail did not mount a bounded tail window");
const tailAnchorOrdinal=options()[0].dataset.entryOrdinal;
const tailAnchorScrollTop=viewport.scrollTop;
const callsBeforeMode=listCalls;
mode.value="generic";mode.dispatchEvent(new Event("change",{bubbles:true}));
await waitFor(()=>options()[0]?.dataset.entryOrdinal===tailAnchorOrdinal,"summary mode change did not preserve the visible anchor");
check(listCalls===callsBeforeMode&&Math.abs(viewport.scrollTop-tailAnchorScrollTop)<1,"summary mode change reread the page or moved the viewport anchor");
mode.value="event";mode.dispatchEvent(new Event("change",{bubbles:true}));await settle();
viewport.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));
await waitFor(()=>document.activeElement?.getAttribute("data-entry-ordinal")==="1","list viewport did not continue keyboard navigation from its retained logical Entry");
check(document.activeElement?.getAttribute("data-entry-ordinal")==="1","keyboard navigation after an offscreen focused Entry did not restore the logical focus");
const goInput=host.querySelector("#go");
goInput.value="not-a-number";
host.querySelector("#go-button").click();
check(document.activeElement===goInput,"Go validation render stole focus from its input");
goInput.value="200";
host.querySelector("#go-button").click();
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="199"),"Go to Entry 200 did not settle on the current page");
const callsBeforeCrossPage=listCalls;
const row199=options().find((option)=>option.dataset.entryOrdinal==="199");
row199.focus();
row199.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="200"),"ArrowDown did not settle on the next page");
check(listCalls===callsBeforeCrossPage+1&&options().some((option)=>option.dataset.entryOrdinal==="200"),"ArrowDown from Entry 199 did not load the next 200-entry page");
goInput.value="201";
host.querySelector("#go-button").click();
await waitFor(()=>document.activeElement?.getAttribute("data-entry-ordinal")==="200","same-page Go did not focus Entry 200");
check(options().find((option)=>option.dataset.entryOrdinal==="200")?.getAttribute("aria-selected")==="false"&&document.activeElement?.getAttribute("data-entry-ordinal")==="200","same-page Go to Entry 201 did not focus Entry 200");
const row200=options().find((option)=>option.dataset.entryOrdinal==="200");
row200.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true,cancelable:true}));
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="399"),"End did not mount the final Entry");
check(document.activeElement?.getAttribute("data-entry-ordinal")==="399","End did not focus the final Entry on the current page");
const row399=options().find((option)=>option.dataset.entryOrdinal==="399");
row399.dispatchEvent(new KeyboardEvent("keydown",{key:"PageUp",bubbles:true,cancelable:true}));
await waitFor(()=>document.activeElement?.getAttribute("data-entry-ordinal")==="199","PageUp did not settle on the previous page");
check(document.activeElement?.getAttribute("data-entry-ordinal")==="199","PageUp did not load the previous page");
const row199AfterUp=options().find((option)=>option.dataset.entryOrdinal==="199");
row199AfterUp.dispatchEvent(new KeyboardEvent("keydown",{key:"PageDown",bubbles:true,cancelable:true}));
await waitFor(()=>document.activeElement?.getAttribute("data-entry-ordinal")==="200","PageDown did not settle on the next page");
check(document.activeElement?.getAttribute("data-entry-ordinal")==="200","PageDown did not load the next page");
const pageTwoRow=options().find((option)=>option.dataset.entryOrdinal==="200");
pageTwoRow.dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true,cancelable:true}));
await waitFor(()=>document.activeElement?.getAttribute("data-entry-ordinal")==="0","Home did not settle on the first page");
check(document.activeElement?.getAttribute("data-entry-ordinal")==="0","Home did not return to the first page");

const variableHeightStyle=document.createElement("style");
variableHeightStyle.textContent=".entry-navigation .entry-option { min-height: 80px; }";
host.append(variableHeightStyle);
await waitFrames(2);
const variableEndRow=options().find((option)=>option.dataset.entryOrdinal==="0");
variableEndRow.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true,cancelable:true}));
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="399"),"variable-height End did not mount the final Entry");
await waitFrames(2);
const variableViewportRect=viewport.getBoundingClientRect();
const variableTarget=options().find((option)=>option.dataset.entryOrdinal==="399");
const variableTargetRect=variableTarget.getBoundingClientRect();
check(variableTargetRect.bottom<=variableViewportRect.top+viewport.clientTop+viewport.clientHeight+1,"End target fell below the viewport after its measured height grew");
variableHeightStyle.remove();
await waitFrames(2);

entryList.setSession({revision:23,progress:{indexedEntries:400,indexedSourceLines:400,complete:false,stride:1,totalEntries:null}});
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="0"),"fresh session did not mount its first Entry");
viewport.focus();
viewport.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));
await waitFor(()=>document.activeElement?.getAttribute("data-entry-ordinal")==="1","ArrowDown from a freshly focused viewport did not choose the first logical Entry");
check(document.activeElement?.getAttribute("data-entry-ordinal")==="1","fresh viewport focus did not continue keyboard navigation");

entryList.setSession({revision:24,progress:{indexedEntries:400,indexedSourceLines:400,complete:false,stride:1,totalEntries:null}});
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="0"),"fresh first option focus fixture did not mount");
const tabFocusedFirst=options().find((option)=>option.dataset.entryOrdinal==="0");
tabFocusedFirst.focus();
viewport.scrollTop=viewport.scrollHeight-viewport.clientHeight;viewport.dispatchEvent(new Event("scroll"));
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="199")&&document.activeElement===viewport,"Tab-focused first Entry did not hand focus to the viewport at the page tail");
viewport.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));
await waitFor(()=>document.activeElement?.getAttribute("data-entry-ordinal")==="1","keyboard navigation after a Tab-focused Entry lost its logical ordinal");
check(document.activeElement?.getAttribute("data-entry-ordinal")==="1","Tab-focused Entry did not retain logical focus after scrolling out");

pageMode="tail";
tailEntries=Array.from({length:60},(_,entryOrdinal)=>({location:{entryOrdinal,sourceLine:entryOrdinal+1,byteStart:entryOrdinal*12,byteEnd:entryOrdinal*12+11},status:"valid",parseError:null}));
entryList.setSession({revision:30,progress:{indexedEntries:60,indexedSourceLines:60,complete:false,stride:1,totalEntries:null}});
await waitFor(()=>options().some((option)=>option.dataset.entryOrdinal==="0"),"tail-refresh fixture did not load its first Entry page");
viewport.scrollTop=Math.floor((viewport.scrollHeight-viewport.clientHeight)/2);viewport.dispatchEvent(new Event("scroll"));
await settle();
const tailRefreshAnchor=options()[0]?.dataset.entryOrdinal;
const tailRefreshScrollTop=viewport.scrollTop;
const callsBeforeTailRefresh=listCalls;
tailEntries.push({location:{entryOrdinal:60,sourceLine:61,byteStart:720,byteEnd:731},status:"valid",parseError:null});
entryList.updateProgress({indexedEntries:61,indexedSourceLines:61,complete:false,stride:1,totalEntries:null,eventStreamHint:null},30);
await waitFor(()=>listCalls===callsBeforeTailRefresh+1,"indexed tail growth did not refresh the current short page");
check(options()[0]?.dataset.entryOrdinal===tailRefreshAnchor&&Math.abs(viewport.scrollTop-tailRefreshScrollTop)<1,"same-page tail refresh did not preserve its visible anchor");

pageMode="late";
entryList.setSession({revision:31,progress:{indexedEntries:1,indexedSourceLines:1,complete:false,stride:1,totalEntries:null}});
entryList.setSession({revision:32,progress:{indexedEntries:1,indexedSourceLines:1,complete:false,stride:1,totalEntries:null}});
await waitFor(()=>options()[0]?.textContent.includes("9000"),"new Entry session did not replace the stale page request");
lateResolve?.({entries:[{location:{entryOrdinal:0,sourceLine:31,byteStart:3100,byteEnd:3110},status:"valid",parseError:null}],hasMore:false,nextCursor:null,progress:progress(true,false,1)});
await settle();
check(options()[0]?.textContent.includes("9000"),"late response from the previous Entry session overwrote the current page");

pageMode="negative";
entryList.setSession({revision:20,progress:progress(true,false,1)});
await settle();
check(mode.value==="auto"&&!options()[0].textContent.includes("training_sample"),"negative hint did not keep Auto generic");
check(options()[0].getAttribute("aria-setsize")==="1","known Entry total did not set global aria-setsize");
mode.value="event";mode.dispatchEvent(new Event("change",{bubbles:true}));await settle();
check(options()[0].textContent.includes("training_sample"),"Event mode did not use a partial available summary");
selectionMode="nonobject";options()[0].click();await settle();
check(errors.length>0,"non-object eventSummary was not rejected at the selection boundary");
selectionMode="invalid";options()[0].click();await settle();
check(errors.length>1,"malformed eventSummary value was not rejected at the selection boundary");

pageMode="unicode";
entryList.setSession({revision:21,progress:progress(true,true,1)});
await settle();
mode.value="event";mode.dispatchEvent(new Event("change",{bubbles:true}));await settle();
check(options()[0].textContent.includes("😀".repeat(256))&&options()[0].textContent.includes("truncated"),"256-scalar bounded summary or hasMore marker was lost");

pageMode="invalid";
entryList.setSession({revision:22,progress:progress(true,true,1)});
await settle();
check(host.textContent.includes("invalid")&&options().length===0,"257-scalar eventSummary was not rejected");

host.remove();
document.getElementById("open-file").click();
await waitFor(()=>document.querySelector("#entry-list [role=option]")!==null,"main did not render its Entry page; calls="+JSON.stringify(tauriCalls)+" error="+document.getElementById("error-message").textContent+" navHidden="+document.getElementById("entry-navigation").hidden);
const appMode=document.querySelector("#entry-navigation select[data-entry-summary-mode]");
check(appMode instanceof HTMLSelectElement,"main did not initialize Entry Summary Mode");
appMode.value="event";appMode.dispatchEvent(new Event("change",{bubbles:true}));await settle();
const appOption=document.querySelector("#entry-list [role=option]");
check(appOption instanceof HTMLElement,"main did not render the Entry page; calls="+JSON.stringify(tauriCalls)+" error="+document.getElementById("error-message").textContent+" navHidden="+document.getElementById("entry-navigation").hidden);
appOption.click();await settle();
await waitFor(()=>document.querySelector("#entry-list [role=option]")?.getAttribute("aria-selected")==="true","main selection did not settle");
const appSelected=document.querySelector("#entry-list [role=option]");
const appSelectCall=tauriCalls.filter((call)=>call.command==="select_entry").at(-1);
check(appSelectCall?.args.sessionRevision===40&&appSelectCall.args.ordinal===0,"main selection did not send the current revision/ordinal");
check(appMode.value==="event"&&appSelected?.getAttribute("aria-selected")==="true","main selection did not retain the user summary mode");
check(appSelected?.textContent.includes("session-17")&&document.getElementById("tree-tab").disabled===false,"main selection dropped eventSummary or left Tree disabled");
check(document.getElementById("error-region").hidden,"valid main Entry selection raised an error");
document.getElementById("open-file").click();
await waitFor(()=>document.getElementById("error-region").hidden===false,"invalid main progress did not settle");
check(document.getElementById("error-region").hidden===false&&document.getElementById("entry-navigation").hidden,"main accepted an invalid eventStreamHint type");

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
  await browser(["open", `http://127.0.0.1:${port}/scripts/test-app-fixture.html`]);
  const output = await browser(["eval", "-b", Buffer.from(browserTest()).toString("base64")]);
  const result = JSON.parse(output.trim());
  if (!result.pass) throw new Error("Entry Summary Mode UI test did not pass.");
  console.log(`entry-summary-ui PASS (${result.assertions} assertions; UI simulation only, not Native Core acceptance)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
