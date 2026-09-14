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
const tauriCalls=[];
let selectionMode="valid";
const errors=[];
const selections=[];
let assertions=0;
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const waitFor=async(predicate,message)=>{for(let attempt=0;attempt<80;attempt+=1){await settle();if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,25));}throw new Error(message);};
await waitFor(()=>document.documentElement.dataset.testAppReady==="true","test app fixture did not finish main initialization");
const positiveEntries=[
  {location:{entryOrdinal:0,sourceLine:1,byteStart:0,byteEnd:190},status:"valid",parseError:null,eventSummary:{timestamp:{value:"2026-09-14T10:32:04Z",hasMore:false},eventType:{value:"tool_call",hasMore:true},grouping:{value:"<img src=x onerror=alert(1)>",hasMore:false}}},
  {location:{entryOrdinal:1,sourceLine:2,byteStart:191,byteEnd:230},status:"valid",parseError:null,eventSummary:null},
  {location:{entryOrdinal:2,sourceLine:3,byteStart:231,byteEnd:270},status:"valid",parseError:null}
];
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
    if(pageMode==="positive") return {entries:positiveEntries,hasMore:false,nextCursor:null,progress:{indexedEntries:3,indexedSourceLines:3,complete:false,stride:1,totalEntries:null}};
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
host.innerHTML='<div class="entry-navigation-heading"><h3>Entries</h3><span>50 per page</span></div><div class="entry-go"><input id="go"><button id="go-button">Go</button><span id="go-error"></span></div><div id="list" class="entry-list" role="listbox"></div><button id="previous">Previous</button><button id="next">Next</button><div id="status"></div><button id="retry">Retry</button><aside id="inspector"><span id="ordinal"></span><span id="entry-status"></span><span id="line"></span><span id="bytes"></span><span id="parse-message"></span><span id="parse-byte"></span><span id="parse-line"></span><span id="parse-column"></span></aside><div id="navigation-state"></div>';
document.body.append(host);
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
entryList.setSession({revision:10,progress:{indexedEntries:3,indexedSourceLines:3,complete:false,stride:1,totalEntries:null}});
await settle();
const mode=host.querySelector("select[data-entry-summary-mode]");
const options=()=>Array.from(host.querySelectorAll("[role=option]"));
check(mode instanceof HTMLSelectElement,"Entry Summary Mode native select is missing");
check(Array.from(mode.options).map((option)=>option.value).join(",")==="auto,generic,event","Entry Summary Mode options changed");
check(mode.value==="auto"&&options().length===3,"new JSONL session did not render Auto with all entries");
check(!options()[0].textContent.includes("tool_call"),"Auto rendered Event summary before the final hint");
const callsBeforeHint=listCalls;
entryList.updateProgress(progress(true,true,3),10);
await settle();
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

pageMode="negative";
entryList.setSession({revision:20,progress:progress(true,false,1)});
await settle();
check(mode.value==="auto"&&!options()[0].textContent.includes("training_sample"),"negative hint did not keep Auto generic");
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
