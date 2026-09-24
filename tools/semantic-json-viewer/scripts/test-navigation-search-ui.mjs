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
const calls=[];window.__TAURI_INTERNALS__={invoke:async(command,args)=>{calls.push({command,args});if(command==="start_navigation_search")return{searchId:7,fileGeneration:4,scannedThrough:0,scannedCount:0,matchedCount:0,indexedCount:4,totalCount:4,complete:false,stopped:false,skippedInvalidJson:0,skippedInvalidUtf8:0,skippedOversized:0};if(command==="advance_navigation_search")return{searchId:7,fileGeneration:4,scannedThrough:4,scannedCount:4,matchedCount:2,indexedCount:4,totalCount:4,complete:true,stopped:false,skippedInvalidJson:0,skippedInvalidUtf8:0,skippedOversized:0};if(command==="get_navigation_search_page")return{ordinals:[args.cursor===0?1:3],hasMore:args.cursor<1,nextCursor:args.cursor<1?args.cursor+1:null};return{};}};
const {NavigationSearch}=await import("/src/navigation-search.ts");
const host=document.createElement("div");host.innerHTML='<section hidden><form><input id="query"><select id="syntax"><option value="literal">text</option><option value="glob">glob</option></select><select id="representation"><option value="decoded">decoded</option><option value="rawSource">raw</option></select><button id="clear" type="button">clear</button><button id="stop" type="button">stop</button><button id="previous" type="button">previous</button><button id="next" type="button">next</button></form><div id="status"></div><div id="description"></div><label><input type="radio" name="display" value="highlight" checked>highlight</label><label><input type="radio" name="display" value="filtered">filtered</label><div id="results-panel" hidden><div id="results" role="list"></div><button id="results-prev">previous</button><button id="results-next">next</button></div></section>';document.body.append(host);
const section=host.querySelector("section"),form=host.querySelector("form"),destinations=[],displayModes=host.querySelectorAll('input[name="display"]');
const view=new NavigationSearch({panel:section,form,query:host.querySelector("#query"),syntax:host.querySelector("#syntax"),representation:host.querySelector("#representation"),clear:host.querySelector("#clear"),stop:host.querySelector("#stop"),previous:host.querySelector("#previous"),next:host.querySelector("#next"),status:host.querySelector("#status"),description:host.querySelector("#description"),displayModes,resultsPanel:host.querySelector("#results-panel"),results:host.querySelector("#results"),resultsPrevious:host.querySelector("#results-prev"),resultsNext:host.querySelector("#results-next")},ordinal=>destinations.push(ordinal));
view.setContext({fileGeneration:4,mode:"entry"});check(!section.hidden,"JSONL search control did not appear");check(host.querySelector("#description").textContent.includes("JSONL"),"JSONL scope description was missing");
host.querySelector("#query").value="needle";form.requestSubmit();
const wait=async()=>{for(let n=0;n<80;n++){await new Promise(resolve=>setTimeout(resolve,10));if(host.querySelector("#status").textContent.includes("Found"))return;}throw new Error("search did not finish");};await wait();
check(calls.some(call=>call.command==="start_navigation_search"&&call.args.query==="needle"),"Search submit did not start a file-level task");
host.querySelector('input[value="filtered"]').click();await new Promise(resolve=>setTimeout(resolve,0));check(!host.querySelector("#results-panel").hidden&&host.querySelector("#results button")?.textContent==="Entry 2","Filtered mode did not project an original Entry ordinal");
host.querySelector("#next").click();await new Promise(resolve=>setTimeout(resolve,0));check(destinations[0]===1,"Next match did not navigate to its original ordinal");
host.querySelector("#next").click();await new Promise(resolve=>setTimeout(resolve,0));check(destinations[1]===3,"Second result lost its original ordinal");
host.querySelector("#query").value="changed";host.querySelector("#query").dispatchEvent(new Event("input"));await new Promise(resolve=>setTimeout(resolve,0));check(calls.some(call=>call.command==="stop_navigation_search"&&call.args.releaseResults),"Changing the query did not release stale results");check(host.querySelector("#status").textContent.includes("Enter"),"Query edit did not ask for explicit submission");
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
