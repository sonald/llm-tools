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
const session = `sjv-conversation-budget-${process.pid}`;

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
  const command = process.env.AGENT_BROWSER_BIN || "agent-browser";
  const result = await execFileAsync(command, ["--session", session, ...args], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024
  }).catch((error) => {
    const detail = [error?.stderr, error?.stdout]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n").trim();
    throw new Error(`${command} ${args[0] ?? "command"} failed${detail ? `: ${detail.slice(-4000)}` : ""}`);
  });
  return result.stdout.trim();
}

function browserTest() {
  return `(async()=>{
Object.defineProperty(globalThis,"navigator",{configurable:true,value:{language:"en-US",languages:["en-US"]}});
const {ConversationView}=await import("/src/conversation-view.ts?conversation-budget");
const {ProjectionBudget}=await import("/src/projection-budget.ts?conversation-budget");
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const node=(id,kind,label,start,end,childCount=0,valuePreview=null)=>({id,kind,label,spanStart:start,spanEnd:end,labelHasMore:false,valuePreview,valueHasMore:false,childCount});
const ref=(nodeId,spanStart,spanEnd)=>({nodeId,spanStart,spanEnd});
const shared=new ProjectionBudget(800);
const makeConversation=(rootId,sourceId,initialText,start=true)=>{
  const root=node(rootId,"array","messages",0,1000,1);
  const candidate=root;
  const source=ref(sourceId,100,400);
  const message=ref(sourceId+1,100,400);
  const role=ref(sourceId+2,110,125);
  const block={kind:"source",messageNodeId:message.nodeId,messageSpanStart:message.spanStart,messageSpanEnd:message.spanEnd,sourceNodeId:source.nodeId,sourceSpanStart:source.spanStart,sourceSpanEnd:source.spanEnd,fieldNodeId:source.nodeId,fieldSpanStart:source.spanStart,fieldSpanEnd:source.spanEnd,category:"content",role:"assistant",roleSourceNodeId:role.nodeId,roleSourceSpanStart:role.spanStart,roleSourceSpanEnd:role.spanEnd,openaiRefs:null,anthropicRefs:null,ambiguousDuplicateField:false};
  const wrapperRef={scopeRootId:rootId,scopeRootSpanStart:0,scopeRootSpanEnd:1000,candidateNodeId:rootId,candidateSpanStart:0,candidateSpanEnd:1000,ambiguousDuplicateField:false};
  const calls=[];const raw=[];const tree=[];let readCount=0;let deferRead=false;let releaseRead;
  const invoke=async(command,args)=>{
    calls.push({command,args});
    if(command==="get_conversation_candidate")return {nodeId:rootId,spanStart:0,spanEnd:1000,messageCount:1,kind:"generic",scopeRootId:rootId,scopeRootSpanStart:0,scopeRootSpanEnd:1000,sessionRevision:rootId,ambiguousDuplicateField:false};
    if(command==="get_conversation_blocks")return {blocks:[block],hasMore:false,nextCursor:null,wrapperRef};
    if(command==="get_node_summary")return node(sourceId,"string","content",100,400,0,initialText);
    if(command==="get_string_metrics"){const bytes=new TextEncoder().encode(initialText).byteLength;return {decodedBytes:bytes,characterCount:initialText.length,lineCount:1};}
    if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"short"};
    if(command==="read_decoded_text"){readCount+=1;if(deferRead)return new Promise((resolve)=>{releaseRead=()=>resolve({start:0,text:initialText,hasMore:false,nextOffset:null});});return {start:0,text:initialText,hasMore:false,nextOffset:null};}
    throw new Error("unexpected command "+command);
  };
  const host=document.createElement("div");host.style.display="block";document.body.append(host);
  const view=new ConversationView({panel:host,projectionBudget:shared,invoke,onError:(error)=>{throw error;},onRaw:(target)=>raw.push(target),onTree:(target)=>tree.push(target),onContent:()=>{}});
  if(start)view.setContext({mode:"document",sessionRevision:rootId,sourceSize:1000,scopeRoot:root,scopeLabel:"budget"+rootId});
  return {root,source,block,calls,raw,tree,host,view,get readCount(){return readCount;},set defer(value){deferRead=value;},release(){releaseRead?.();}};
};
const first=makeConversation(101,201,"first text");const second=makeConversation(102,202,"second text",false);
await settle();await settle();await settle();await settle();
check(shared.usedBytes<=800,"shared Conversation projection budget was exceeded after alternating loads");
const firstReads=first.readCount;const firstRaw=first.raw;const firstTree=first.tree;
first.host.hidden=true;first.view.onSemanticVisible();await settle();
second.view.setContext({mode:"document",sessionRevision:102,sourceSize:1000,scopeRoot:second.root,scopeLabel:"budget102"});
await settle();await settle();await settle();await settle();
second.host.hidden=true;second.view.onSemanticVisible();await settle();
first.host.hidden=false;first.view.onSemanticVisible();await settle();await settle();await settle();
check(first.readCount>firstReads&&second.readCount===1,"an evicted offscreen Conversation projection was not reread when visible again");
check(shared.usedBytes<=800,"shared budget exceeded after an evicted projection was reread");
first.host.querySelector('[data-conversation-action="raw"]')?.click();first.host.querySelector('[data-conversation-action="tree"]')?.click();
check(first.raw.at(-1)?.ref.nodeId===201&&first.raw.at(-1)?.ref.spanStart===100,"Raw source reference changed under projection eviction");
check(first.tree.at(-1)?.ref.nodeId===201&&first.tree.at(-1)?.ref.spanEnd===400,"Tree source reference changed under projection eviction");
const late=makeConversation(103,203,"late text");late.defer=true;await settle();await settle();
late.view.clear();late.release();await settle();await settle();
check(late.host.hidden&&late.host.textContent==="","late projection response repopulated a cleared Conversation view");
check(shared.usedBytes<=800,"late response changed shared budget after its view was cleared");
first.view.clear();second.view.clear();check(shared.usedBytes===0,"clearing both Conversation instances did not release the shared budget");
for(const item of [first,second,late]) item.host.remove();
const ascii="a".repeat(4096);const conservative=ascii.length*2+256;const probe=new ProjectionBudget(conservative-1);check(!probe.admit({},conservative,()=>{}),"conservative ASCII projection estimate bypassed the budget");check(probe.usedBytes===0,"failed conservative admission changed accounting");
const history=makeConversation(104,204,"history",false);
const historyCalls=[];
let failAt=-1;
history.view.invokeRequest=async(command,args)=>{
  if(command!=="get_conversation_blocks")throw new Error("unexpected history command");
  const index=args.cursor?.messageIndex??0;historyCalls.push(index);
  if(index===failAt)throw new Error("history replay failed");
  return {blocks:[],hasMore:index<39,nextCursor:index<39?{kind:"genericConversation",style:"generic",scopeRootId:104,candidateNodeId:104,messageIndex:index+1,phase:"message",fieldIndex:0,elementIndex:0,sessionRevision:104}:null,wrapperRef:{scopeRootId:104,scopeRootSpanStart:0,scopeRootSpanEnd:1000,candidateNodeId:104,candidateSpanStart:0,candidateSpanEnd:1000,ambiguousDuplicateField:false}};
};
history.view.context={mode:"document",sessionRevision:104,sourceSize:1000,scopeRoot:history.root,scopeLabel:"history"};
history.view.selectedCandidate={node:history.root,kind:"generic",messageCount:40,ambiguousDuplicateField:false};
history.view.candidates=[history.view.selectedCandidate];
await history.view.loadPage(null,"initial");
for(let i=0;i<39;i++)await history.view.loadPage(history.view.page.nextCursor,"next");
check(history.view.previousPages.size<=16,"Conversation retained unbounded pagination cursors");
history.view.previousPages.clear();failAt=0;
await history.view.loadPage(null,"previous");
check(history.view.page.pageStart.messageIndex===39&&!history.view.loading,"Failed replay replaced the current page or left navigation busy");
failAt=-1;
for(let i=0;i<39;i++){
  history.host.querySelector('[data-conversation-action="previous"]').click();await settle();
  check((history.view.page.pageStart?.messageIndex??0)===38-i,"Previous could not replay an evicted Conversation cursor");
}
check(historyCalls.filter(index=>index===0).length>1,"Old Conversation pages were never reread");
for(let i=0;i<39;i++)await history.view.loadPage(history.view.page.nextCursor,"next");
history.view.previousPages.clear();
const normalRead=history.view.invokeRequest;let releaseReplay;
history.view.invokeRequest=(command,args)=>new Promise(resolve=>{releaseReplay=async()=>resolve(await normalRead(command,args));});
const pendingReplay=history.view.loadPage(null,"previous");
history.view.clear();await releaseReplay();await pendingReplay;
check(history.view.page===null&&history.view.previousPages.size===0&&history.host.textContent==="","Cancelled replay restored a cleared Conversation");
history.host.remove();
return {pass:true,assertions};})()`;
}

const port = await freePort();
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += chunk; });
vite.stderr.on("data", (chunk) => { viteOutput += chunk; });
try {
  await waitForPort(port, vite);
  await browser(["open", `http://127.0.0.1:${port}/scripts/test-i18n-fixture.html`]);
  const output = await browser(["eval", "-b", Buffer.from(browserTest()).toString("base64")]);
  const result = JSON.parse(output.trim());
  if (!result.pass) throw new Error("Conversation projection budget smoke did not pass.");
  console.log(`conversation-projection-budget PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-5000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
