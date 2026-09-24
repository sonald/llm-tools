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
const session = `sjv-navigation-search-${process.pid}`;
const check = (condition, message) => { if (!condition) throw new Error(message); };

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function browser(args) {
  const result = await execFileAsync("agent-browser", ["--session", session, ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

const test = ` (async()=>{
Object.defineProperty(globalThis,"navigator",{configurable:true,value:{language:"en-US"}});
let assertions=0;const check=(value,message)=>{assertions+=1;if(!value)throw new Error(message)};
const calls=[];window.__TAURI_INTERNALS__={invoke:async(command,args)=>{calls.push({command,args});if(command==="start_navigation_search")return{searchId:7,fileGeneration:4,scannedThrough:0,scannedCount:0,matchedCount:0,indexedCount:4,totalCount:4,complete:false,stopped:false,skippedInvalidJson:0,skippedInvalidUtf8:0,skippedOversized:0};if(command==="advance_navigation_search")return{searchId:7,fileGeneration:4,scannedThrough:4,scannedCount:4,matchedCount:2,indexedCount:4,totalCount:4,complete:true,stopped:false,skippedInvalidJson:0,skippedInvalidUtf8:0,skippedOversized:0};if(command==="get_navigation_search_page")return{ordinals:[1,3].slice(args.cursor,args.cursor+args.limit),evidence:[{ordinal:1,path:"$.message",field:"value",snippet:"found needle here",matchStart:6,matchEnd:12}],hasMore:false,nextCursor:null};return{};}};
const {NavigationSearch}=await import("/src/navigation-search.ts");
const host=document.createElement("div");host.innerHTML='<section hidden><form><input id="query"><select id="syntax"><option value="literal">text</option><option value="glob">glob</option></select><select id="representation"><option value="decoded">decoded</option><option value="rawSource">raw</option></select><button id="clear" type="button">clear</button><button id="stop" type="button">stop</button><button id="previous" type="button">previous</button><button id="next" type="button">next</button></form><div id="status"></div><div id="description"></div><label><input type="radio" name="display" value="highlight" checked>highlight</label><label><input type="radio" name="display" value="filtered">filtered</label><div id="results-panel" hidden><div id="results" role="list"></div><button id="results-prev">previous</button><button id="results-next">next</button></div></section>';document.body.append(host);
const section=host.querySelector("section"),form=host.querySelector("form"),destinations=[],displayModes=host.querySelectorAll('input[name="display"]');
const view=new NavigationSearch({panel:section,form,query:host.querySelector("#query"),syntax:host.querySelector("#syntax"),representation:host.querySelector("#representation"),clear:host.querySelector("#clear"),stop:host.querySelector("#stop"),previous:host.querySelector("#previous"),next:host.querySelector("#next"),status:host.querySelector("#status"),description:host.querySelector("#description"),displayModes,resultsPanel:host.querySelector("#results-panel"),results:host.querySelector("#results"),resultsPrevious:host.querySelector("#results-prev"),resultsNext:host.querySelector("#results-next")},ordinal=>destinations.push(ordinal));
view.setContext({fileGeneration:4,mode:"entry"});check(!section.hidden,"JSONL search control did not appear");check(host.querySelector("#description").textContent.includes("JSONL"),"JSONL scope description was missing");
host.querySelector("#query").value="needle";form.requestSubmit();
const wait=async()=>{for(let n=0;n<80;n++){await new Promise(resolve=>setTimeout(resolve,10));if(host.querySelector("#status").textContent.includes("Found"))return;}throw new Error("search did not finish");};await wait();
check(calls.some(call=>call.command==="start_navigation_search"&&call.args.query==="needle"),"Search submit did not start a file-level task");
host.querySelector('input[value="filtered"]').click();await new Promise(resolve=>setTimeout(resolve,0));check(!host.querySelector("#results-panel").hidden&&host.querySelector("#results button strong")?.textContent==="Entry 2","Filtered mode did not project an original Entry ordinal");
host.querySelector("#next").click();await new Promise(resolve=>setTimeout(resolve,0));check(destinations[0]===1,"Next match did not navigate to its original ordinal");
host.querySelector("#next").click();await new Promise(resolve=>setTimeout(resolve,0));check(destinations[1]===3,"Second result lost its original ordinal");
check(host.querySelector("#results mark")?.textContent==="needle","Matching content was not highlighted");
host.querySelector("#query").value="changed";host.querySelector("#query").dispatchEvent(new Event("input"));await new Promise(resolve=>setTimeout(resolve,0));check(calls.some(call=>call.command==="stop_navigation_search"&&call.args.releaseResults),"Changing the query did not release stale results");check(host.querySelector("#status").textContent.includes("Enter"),"Query edit did not ask for explicit submission");


const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const until=async(predicate,message)=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}throw new Error(message);};
const progress=(id,extra={})=>({searchId:id,fileGeneration:4,scannedThrough:0,scannedCount:0,matchedCount:0,indexedCount:500,totalCount:500,complete:false,stopped:false,skippedInvalidJson:0,skippedInvalidUtf8:0,skippedOversized:0,...extra});
let resolveA;const advances=[];
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==="start_navigation_search")return progress(args.query==="A"?10:11);
 if(command==="advance_navigation_search"){advances.push(args.searchId);if(args.searchId===10)return await new Promise(resolve=>{resolveA=resolve});return progress(11,{scannedThrough:500,scannedCount:500,complete:true});}
 if(command==="get_navigation_search_page")return {ordinals:[],evidence:[]};return {};
};
host.querySelector("#query").value="A";form.requestSubmit();await until(()=>resolveA,"A scan did not begin");
host.querySelector("#query").value="B";host.querySelector("#query").dispatchEvent(new Event("input"));form.requestSubmit();await until(()=>advances.includes(11),"B incorrectly reused A's in-flight advance");
resolveA(progress(10,{complete:true}));await tick();check(host.querySelector("#status").textContent.includes("Found"),"Late A response overwrote B");check(advances.filter(id=>id===11).length===1,"B did not advance independently");
const pages=[];
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==="start_navigation_search")return progress(12,{matchedCount:500,scannedThrough:500,scannedCount:500,complete:true});
 if(command==="get_navigation_search_page")return await new Promise(resolve=>pages.push({args,resolve}));return {};
};
host.querySelector("#query").value="paged";form.requestSubmit();await until(()=>pages.length===1,"First result page did not begin");
host.querySelector("#results-next").click();await until(()=>pages.length===2,"Next result page did not begin");
pages[1].resolve({ordinals:[220],evidence:[{ordinal:220,path:"$.value",field:"value",snippet:"<img onerror=alert(1)>needle",matchStart:21,matchEnd:27}]});await tick();
pages[0].resolve({ordinals:[20],evidence:[]});await tick();check(host.querySelector("#results button").dataset.navigationOrdinal==="220","Late page response overwrote current page");check(!host.querySelector("#results img"),"Evidence was interpreted as HTML");check(host.querySelector("#results button").getAttribute("aria-posinset")==="201","Page ordinal accessibility index was stale");
host.querySelector("#results button").click();await tick();check(destinations.at(-1)===220,"Paged result navigated to a result index rather than source ordinal");
host.querySelector("#clear").click();check(!host.querySelector('input[value="filtered"]').checked,"Clear did not restore full list mode");
window.__TAURI_INTERNALS__.invoke=async(command)=>{if(command==="start_navigation_search")throw {code:"invalid_request",message:"invalid glob"};return {};};
host.querySelector("#query").value="bad";form.requestSubmit();await until(()=>host.querySelector("#status").textContent==="invalid glob","Structured IPC error lost its message");check(true,"Structured IPC error displayed");
view.setContext(null);check(section.hidden,"Search controls remained visible without a file");host.remove();return{pass:true,assertions};
})()`;

const port = await freePort();
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let output = "";vite.stdout.on("data", chunk => { output += chunk.toString(); });vite.stderr.on("data", chunk => { output += chunk.toString(); });
try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await new Promise((resolveConnect, reject) => { const socket=createConnection({host:"127.0.0.1",port});socket.once("connect",()=>{socket.destroy();resolveConnect();});socket.once("error",reject); }); break; }
    catch { await new Promise(resolveWait=>setTimeout(resolveWait,100)); }
  }
  await browser(["open", `http://127.0.0.1:${port}/scripts/test-i18n-fixture.html`]);
  const result = JSON.parse(await browser(["eval", "-b", Buffer.from(test).toString("base64")]));
  check(result.pass, "navigation search browser checks failed");
  console.log(`navigation-search-ui PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
