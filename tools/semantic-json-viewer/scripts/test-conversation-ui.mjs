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
const session = `sjv-conversation-ui-${process.pid}`;

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
  try {
    const result = await execFileAsync("agent-browser", ["--session", session, ...args], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = [error?.stderr, error?.stdout]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n").trim();
    throw new Error(`agent-browser ${args[0] ?? "command"} failed${detail ? `: ${detail.slice(-4000)}` : ""}`);
  }
}

function browserTest() {
  return `(async()=>{
const {ConversationView}=await import("/src/conversation-view.ts");
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const node=(id,kind,label,spanStart=0,spanEnd=1000,childCount=0)=>({id,kind,label,spanStart,spanEnd,labelHasMore:false,valuePreview:null,valueHasMore:false,childCount});
const root=node(1,"object","$",0,1000,2);
const messages=node(10,"array","messages",100,900,2);
const messages2=node(20,"array","messages#2",901,999,2);
const ref=(nodeId,spanStart,spanEnd)=>({nodeId,spanStart,spanEnd});
const wrapper=(candidate,scopeRootId=1)=>({scopeRootId,scopeRootSpanStart:0,scopeRootSpanEnd:1000,candidateNodeId:candidate.id,candidateSpanStart:candidate.spanStart,candidateSpanEnd:candidate.spanEnd});
const cursor=(style,messageIndex=1)=>({kind:"genericConversation",style,scopeRootId:1,candidateNodeId:10,messageIndex,phase:"fields",fieldIndex:0,elementIndex:0,sessionRevision:7});
const block=(kind="message",category="message",role="user",index=0,style="generic")=>({kind,messageNodeId:kind==="system"?null:11,messageSpanStart:kind==="system"?null:120,messageSpanEnd:kind==="system"?null:240,sourceNodeId:kind==="message"?null:12,sourceSpanStart:kind==="message"?null:160,sourceSpanEnd:kind==="message"?null:220,fieldNodeId:kind==="message"?null:12,fieldSpanStart:kind==="message"?null:160,fieldSpanEnd:kind==="message"?null:220,category,role,roleSourceNodeId:kind==="message"?null:13,roleSourceSpanStart:kind==="message"?null:140,roleSourceSpanEnd:kind==="message"?null:154,openaiRefs:style==="openai"?{block:null,text:category==="content"?ref(12,160,220):null,image:null,callId:null,function:null,name:category==="toolCall"?ref(14,220,230):null,arguments:null}:null,anthropicRefs:null});
const calls=[];
const raw=[];const tree=[];const content=[];
let possible=false;
let deferContent=false;let releaseContent;
const invoke=async(command,args)=>{
  calls.push({command,args});
  if(command==="get_children") return {nodes:[messages,messages2],hasMore:false,nextCursor:null};
  if(command==="get_conversation_candidate") return {nodeId:args.candidateNodeId,spanStart:args.candidateNodeId===10?100:args.candidateNodeId===20?901:0,spanEnd:args.candidateNodeId===10?900:args.candidateNodeId===20?999:1000,messageCount:2,kind:args.candidateNodeId===10?"generic":possible?"possible":"generic",scopeRootId:args.scopeRootId,scopeRootSpanStart:args.scopeRootId===55?0:0,scopeRootSpanEnd:1000,sessionRevision:7};
  if(command==="get_node_summary"&&deferContent)return new Promise((resolve)=>{releaseContent=resolve;});
  if(command==="get_node_summary") return node(args.nodeId,"string","content",160,220,0);
  if(command==="get_conversation_blocks") {
    const style=args.style;
    if(style==="openai"&&!args.cursor) return {blocks:[block("message","message","user",0,style),block("source","content","user",1,style)],hasMore:true,nextCursor:cursor(style),wrapperRef:wrapper(messages)};
    if(style==="openai"&&args.cursor) return {blocks:[block("source","toolCall","assistant",2,style)],hasMore:false,nextCursor:null,wrapperRef:wrapper(messages)};
    const candidate=style==="generic"&&possible?node(55,"array","messages",0,1000,1):messages;
    return {blocks:[block("message","message","user"),block("source","content","user")],hasMore:false,nextCursor:null,wrapperRef:wrapper(candidate,possible?55:1)};
  }
  throw new Error("unexpected command "+command);
};
const host=document.createElement("div");document.body.append(host);
const view=new ConversationView({panel:host,invoke,onError:(error)=>{throw error;},onRaw:(target)=>raw.push(target),onTree:(target)=>tree.push(target),onContent:(target)=>content.push(target)});
view.setContext({mode:"document",sessionRevision:7,sourceSize:1000,scopeRoot:root,scopeLabel:"Document root"});
await settle();await settle();
check(host.querySelectorAll("[data-conversation-candidate]").length===2,"multiple direct candidates were not presented for explicit choice");
check(!calls.some((call)=>call.command==="get_conversation_blocks"),"multiple candidates were auto-rendered");
host.querySelector('[data-conversation-candidate="10"]').click();
await settle();await settle();
check(calls.some((call)=>call.command==="get_conversation_blocks"&&call.args.style==="generic"&&call.args.cursor===null),"explicit candidate did not load Generic blocks");
check(host.querySelectorAll(".conversation-block").length<=100,"page rendered more than the 100-block IPC cap");
host.querySelector('[data-conversation-action="raw"][data-conversation-block-index="1"]').click();
check(raw.at(-1)?.ref.nodeId===12,"Raw source entry did not preserve the backend NodeId");
host.querySelector('[data-conversation-action="tree"][data-conversation-block-index="1"]').click();
check(tree.at(-1)?.ref.nodeId===12,"Tree source entry did not preserve the backend NodeId");
const staleContentButton=host.querySelector('[data-conversation-action="content"][data-conversation-block-index="1"]');deferContent=true;staleContentButton.focus();staleContentButton.click();await settle();
const style=host.querySelector("select[data-conversation-style]");style.value="openai";style.dispatchEvent(new Event("change",{bubbles:true}));await settle();await settle();deferContent=false;releaseContent?.(node(12,"string","content",160,220,0));await settle();
check(content.length===0,"late Content Viewer response escaped the style/page identity guard");
check(calls.some((call)=>call.command==="get_conversation_blocks"&&call.args.style==="openai"&&call.args.cursor===null),"style change did not reset the cursor");
check(host.contains(document.activeElement)&&document.activeElement instanceof HTMLElement,"style switch did not restore focus to a live Conversation control");
const contentButton=host.querySelector('[data-conversation-action="content"]');check(contentButton!==null,"string content did not expose Content Viewer entry");contentButton.click();await settle();
check(content.at(-1)?.nodeId===12&&content.at(-1)?.pathTruncated===true,"string content did not use an explicitly incomplete source path");
host.querySelector('[data-conversation-action="next"]').click();await settle();await settle();
check(calls.some((call)=>call.command==="get_conversation_blocks"&&call.args.cursor?.style==="openai"),"Next did not continue with the style-bound cursor");
check(host.textContent.includes("toolCall"),"next page block was not rendered");
host.querySelector('[data-conversation-ref-key="name"]').click();
check(raw.at(-1)?.ref.nodeId===14,"OpenAI specialized ref button did not target its exact source NodeId");
host.querySelector('[data-conversation-action="previous"]').click();await settle();await settle();
const conversationCalls=calls.filter((call)=>call.command==="get_conversation_blocks");
check(conversationCalls.at(-1)?.args.cursor===null,"Previous did not return to the first page");
host.remove();

const possibleHost=document.createElement("div");document.body.append(possibleHost);possible=true;
const possibleView=new ConversationView({panel:possibleHost,invoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});
possibleView.setContext({mode:"document",sessionRevision:7,sourceSize:1000,scopeRoot:node(55,"array","messages",0,1000,1),scopeLabel:"Possible scope"});await settle();await settle();
check(possibleHost.querySelector('[data-conversation-candidate="55"]')!==null,"Possible candidate was not presented for explicit choice");
check(!calls.some((call)=>call.command==="get_conversation_blocks"&&call.args.candidateNodeId===55),"Possible candidate fetched blocks before explicit confirmation");
possibleHost.querySelector('[data-conversation-candidate="55"]').click();
check(possibleHost.textContent.includes("Possible Conversation"),"Possible candidate was rendered without its confirmation gate");
possibleHost.querySelector('[data-conversation-action="confirm"]').click();await settle();await settle();
check(calls.some((call)=>call.command==="get_conversation_blocks"&&call.args.candidateNodeId===55),"Possible candidate confirmation did not start rendering");
possibleHost.remove();

const staleHost=document.createElement("div");document.body.append(staleHost);let releaseDiscovery;let deferDiscovery=true;
const staleInvoke=async(command,args)=>{if(command==="get_children"&&deferDiscovery)return new Promise((resolve)=>{releaseDiscovery=resolve;});return invoke(command,args);};
const staleView=new ConversationView({panel:staleHost,invoke:staleInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});
staleView.setContext({mode:"document",sessionRevision:7,sourceSize:1000,scopeRoot:node(77,"object","$",0,1000,2),scopeLabel:"Stale scope"});await settle();staleView.setContext(null);deferDiscovery=false;releaseDiscovery?.({nodes:[messages],hasMore:false,nextCursor:null});await settle();
check(staleHost.hidden&&staleHost.textContent==="","stale discovery response repopulated a closed scope");staleHost.remove();

const largeHost=document.createElement("div");document.body.append(largeHost);largeHost.style.height="360px";
const largeRoot=node(101,"array","messages",0,100000,10000);
const largeBlocks=Array.from({length:100},(_,index)=>{const start=200+index*5;return {...block("source","content","user",index,"generic"),sourceNodeId:500+index,sourceSpanStart:start,sourceSpanEnd:start+4,fieldNodeId:500+index,fieldSpanStart:start,fieldSpanEnd:start+4,messageNodeId:11,messageSpanStart:100,messageSpanEnd:900};});
const largeInvoke=async(command,args)=>{
  if(command==="get_conversation_candidate")return {nodeId:101,spanStart:0,spanEnd:100000,messageCount:10000,kind:"generic",scopeRootId:101,scopeRootSpanStart:0,scopeRootSpanEnd:100000,sessionRevision:8};
  if(command==="get_conversation_blocks")return {blocks:largeBlocks,hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:101,scopeRootSpanStart:0,scopeRootSpanEnd:100000,candidateNodeId:101,candidateSpanStart:0,candidateSpanEnd:100000}};
  if(command==="get_node_summary"){const index=args.nodeId-500;const start=index>=0?200+index*5:100;return node(args.nodeId,"string","content",start,start+4,0);}
  throw new Error("unexpected large command "+command);
};
const largeView=new ConversationView({panel:largeHost,invoke:largeInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});
largeView.setContext({mode:"document",sessionRevision:8,sourceSize:100000,scopeRoot:largeRoot,scopeLabel:"10k messages"});await settle();await settle();
const largeViewport=largeHost.querySelector(".conversation-block-viewport");largeViewport.style.height="240px";largeViewport.dispatchEvent(new Event("scroll"));await settle();const stableFirstTree=largeHost.querySelector('[data-conversation-action="tree"][data-conversation-block-index="0"]');
largeViewport.scrollTop=1;largeViewport.dispatchEvent(new Event("scroll"));largeViewport.dispatchEvent(new Event("scroll"));largeViewport.dispatchEvent(new Event("scroll"));await settle();
check(largeHost.querySelector('[data-conversation-action="tree"][data-conversation-block-index="0"]')===stableFirstTree,"same-window scroll rebuilt a visible Tree action node");
largeHost.querySelector('[data-conversation-action="raw"][data-conversation-block-index="0"]').focus();largeViewport.scrollTop=Math.max(0,largeViewport.scrollHeight-largeViewport.clientHeight);largeViewport.dispatchEvent(new Event("scroll"));await settle();
const visibleLimit=Math.ceil((largeViewport.clientHeight+135)/136)+40;
check(largeHost.querySelectorAll(".conversation-block").length<=visibleLimit,"100-block page exceeded the visible window plus 20-row overscan: rendered="+largeHost.querySelectorAll(".conversation-block").length+" limit="+visibleLimit+" client="+largeViewport.clientHeight+" scroll="+largeViewport.scrollTop+" height="+largeViewport.scrollHeight);
check(largeViewport.scrollTop>0&&largeHost.querySelector('[data-conversation-block-index="99"]')!==null,"virtualized Conversation page did not retain a reachable final block after scrolling");
const liveLastBlock=largeHost.querySelector('[data-conversation-block-index="99"]');const lastRect=liveLastBlock?.getBoundingClientRect();const viewportRect=largeViewport.getBoundingClientRect();
check(liveLastBlock!==null&&lastRect!==undefined&&lastRect.top>=viewportRect.top-1&&lastRect.bottom<=viewportRect.bottom+2,"final virtualized block was not inside the real scroll viewport: last="+JSON.stringify(lastRect ? {top:lastRect.top,bottom:lastRect.bottom}:null)+" viewport="+JSON.stringify({top:viewportRect.top,bottom:viewportRect.bottom})+" scroll="+largeViewport.scrollTop+" max="+(largeViewport.scrollHeight-largeViewport.clientHeight));
const stableLastTree=liveLastBlock?.querySelector('[data-conversation-action="tree"]');largeViewport.dispatchEvent(new Event("scroll"));await settle();
check(stableLastTree===largeHost.querySelector('[data-conversation-action="tree"][data-conversation-block-index="99"]'),"post-window scroll rebuilt a stable end-of-page Tree action");
check(largeViewport.contains(document.activeElement),"virtualized row eviction dropped focus outside the Conversation viewport");largeHost.remove();

const scanHost=document.createElement("div");document.body.append(scanHost);let scanMore=false;
const scanRoot=node(300,"object","$",0,100000,400);
const earlyCandidate=node(302,"array","messages#2",110,800,2);
const lateCandidate=node(310,"array","messages#100",90000,99999,2);
const scanInvoke=async(command,args)=>{
  if(command==="get_children")return args.cursor===0?{nodes:[node(301,"array","messages#10",10,100,2),earlyCandidate],hasMore:true,nextCursor:200}:args.cursor<3200?{nodes:[],hasMore:true,nextCursor:args.cursor+200}:{nodes:[lateCandidate],hasMore:false,nextCursor:null};
  if(command==="get_conversation_candidate"){if(args.candidateNodeId===301)throw {code:"invalid_request",message:"literal key is not a candidate"};if(args.candidateNodeId===302)return {nodeId:302,spanStart:110,spanEnd:800,messageCount:2,kind:"generic",scopeRootId:300,scopeRootSpanStart:0,scopeRootSpanEnd:100000,sessionRevision:9};return {nodeId:310,spanStart:90000,spanEnd:99999,messageCount:2,kind:"generic",scopeRootId:300,scopeRootSpanStart:0,scopeRootSpanEnd:100000,sessionRevision:9};}
  if(command==="get_conversation_blocks"){const candidate=args.candidateNodeId===302?earlyCandidate:lateCandidate;return {blocks:[],hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:300,scopeRootSpanStart:0,scopeRootSpanEnd:100000,candidateNodeId:candidate.id,candidateSpanStart:candidate.spanStart,candidateSpanEnd:candidate.spanEnd}};}
  throw new Error("unexpected scan command "+command);
};
const scanView=new ConversationView({panel:scanHost,invoke:scanInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});
scanView.setContext({mode:"document",sessionRevision:9,sourceSize:100000,scopeRoot:scanRoot,scopeLabel:"late fields"});await settle();await settle();
check(scanHost.querySelector('[data-conversation-action="scan-more"]')!==null&&scanHost.querySelector('[data-conversation-candidate="302"]')!==null,"bounded direct candidate scan did not expose a continuation");scanHost.querySelector('[data-conversation-candidate="302"]').click();await settle();await settle();
check(scanHost.querySelector('[data-conversation-action="scan-more"]')!==null,"selected early candidate lost the continuation entry point");scanHost.querySelector('[data-conversation-action="scan-more"]').click();await settle();await settle();
check(scanHost.querySelector('[data-conversation-action="choose-candidate"]')!==null,"later direct candidate was not retained after continuing the bounded scan");scanHost.querySelector('[data-conversation-action="choose-candidate"]').click();
check(scanHost.textContent.includes("messages#100")&&scanHost.querySelector('[data-conversation-candidate="302"]')!==null,"later direct candidate was not discoverable after continuing the bounded scan");scanHost.remove();

const invalidHost=document.createElement("div");document.body.append(invalidHost);const invalidRoot=node(401,"array","messages",0,1000,2);const invalidInvoke=async(command,args)=>{
  if(command==="get_conversation_candidate")return {nodeId:401,spanStart:0,spanEnd:1000,messageCount:2,kind:"generic",scopeRootId:401,scopeRootSpanStart:0,scopeRootSpanEnd:1000,sessionRevision:10};
  if(command==="get_conversation_blocks")return {blocks:[{...block("message"),messageNodeId:null,messageSpanStart:null,messageSpanEnd:null}],hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:401,scopeRootSpanStart:0,scopeRootSpanEnd:1000,candidateNodeId:401,candidateSpanStart:0,candidateSpanEnd:1000}};
  throw new Error("unexpected invalid command "+command);
};
const invalidView=new ConversationView({panel:invalidHost,invoke:invalidInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});invalidView.setContext({mode:"document",sessionRevision:10,sourceSize:1000,scopeRoot:invalidRoot,scopeLabel:"invalid dto"});await settle();await settle();
check(invalidHost.querySelectorAll(".conversation-block").length===0&&invalidHost.textContent.includes("response was invalid"),"invalid block DTO escaped scope validation");invalidHost.remove();

const lateHost=document.createElement("div");document.body.append(lateHost);let releaseA;
const lateBlock=(sourceId)=>({...block("source","content","user"),sourceNodeId:sourceId,sourceSpanStart:160,sourceSpanEnd:220,fieldNodeId:sourceId,fieldSpanStart:160,fieldSpanEnd:220,messageNodeId:11,messageSpanStart:100,messageSpanEnd:900});
const lateInvoke=async(command,args)=>{
  if(command==="get_conversation_candidate")return {nodeId:args.scopeRootId,spanStart:0,spanEnd:1000,messageCount:2,kind:"generic",scopeRootId:args.scopeRootId,scopeRootSpanStart:0,scopeRootSpanEnd:1000,sessionRevision:args.sessionRevision};
  if(command==="get_conversation_blocks")return {blocks:[lateBlock(args.scopeRootId===501?601:602)],hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:args.scopeRootId,scopeRootSpanStart:0,scopeRootSpanEnd:1000,candidateNodeId:args.candidateNodeId,candidateSpanStart:0,candidateSpanEnd:1000}};
  if(command==="get_node_summary"&&args.nodeId===601)return new Promise((resolve)=>{releaseA=resolve;});
  if(command==="get_node_summary"&&args.nodeId===602)return node(602,"string","content",160,220,0);
  throw new Error("unexpected late-summary command "+command);
};
const lateView=new ConversationView({panel:lateHost,invoke:lateInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});
lateView.setContext({mode:"document",sessionRevision:11,sourceSize:1000,scopeRoot:node(501,"array","messages",0,1000,2),scopeLabel:"old page"});await settle();await settle();
lateView.setContext({mode:"document",sessionRevision:12,sourceSize:1000,scopeRoot:node(502,"array","messages",0,1000,2),scopeLabel:"new page"});await settle();await settle();
check(lateHost.querySelector(".conversation-block-summary")?.textContent?.includes("string Node 602"),"new page did not install its own bounded source summary");
releaseA?.(node(601,"string","content",160,220,0));await settle();
check(lateHost.querySelector(".conversation-block-summary")?.textContent?.includes("string Node 602")&&!lateHost.querySelector(".conversation-block-summary")?.textContent?.includes("Node 601"),"late old-page summary polluted the current page");lateHost.remove();

const focusHost=document.createElement("div");document.body.append(focusHost);const outsideFocus=document.createElement("button");outsideFocus.textContent="outside focus";document.body.append(outsideFocus);let releaseFocusPage;
const focusInvoke=async(command,args)=>{
  if(command==="get_conversation_candidate")return {nodeId:701,spanStart:0,spanEnd:1000,messageCount:2,kind:"generic",scopeRootId:701,scopeRootSpanStart:0,scopeRootSpanEnd:1000,sessionRevision:13};
  if(command==="get_conversation_blocks")return new Promise((resolve)=>{releaseFocusPage=()=>resolve({blocks:[],hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:701,scopeRootSpanStart:0,scopeRootSpanEnd:1000,candidateNodeId:701,candidateSpanStart:0,candidateSpanEnd:1000}});});
  throw new Error("unexpected focus command "+command);
};
const focusView=new ConversationView({panel:focusHost,invoke:focusInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});focusView.setContext({mode:"document",sessionRevision:13,sourceSize:1000,scopeRoot:node(701,"array","messages",0,1000,2),scopeLabel:"focus scope"});await settle();outsideFocus.focus();releaseFocusPage?.();await settle();await settle();
check(typeof releaseFocusPage==="function","focus regression did not reach its deferred Conversation completion");
check(document.activeElement===outsideFocus,"background Conversation completion stole focus from an external control");outsideFocus.remove();focusHost.remove();

const previousTauri=window.__TAURI_INTERNALS__;
const mainCalls=[];
let openRevision=31;let deferTree=false;let releaseTree;
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
  mainCalls.push({command,args});
  if(command==="plugin:dialog|open")return "/tmp/conversation-ui.json";
  if(command==="open_file")return {path:"/tmp/conversation-ui.json",size:1000,mode:"document",root:root,progress:null,manyInvalidUtf8Warning:false,documentError:null,sessionRevision:openRevision};
  if(command==="get_root_node")return root;
  if(command==="get_children")return {nodes:[messages],hasMore:false,nextCursor:null};
  if(command==="get_conversation_candidate")return {nodeId:10,spanStart:100,spanEnd:900,messageCount:2,kind:"generic",scopeRootId:1,scopeRootSpanStart:0,scopeRootSpanEnd:1000,sessionRevision:openRevision};
  if(command==="get_conversation_blocks")return {blocks:[block("source","content","user")],hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:1,scopeRootSpanStart:0,scopeRootSpanEnd:1000,candidateNodeId:10,candidateSpanStart:100,candidateSpanEnd:900}};
  if(command==="get_node_summary"&&deferTree)return new Promise((resolve)=>{releaseTree=resolve;});
  if(command==="get_node_summary")return node(args.nodeId,"string","content",160,220,0);
  if(command==="read_raw_slice")return {start:args.sourceStart,text:"source",hasMore:false,nextOffset:null};
  throw new Error("unexpected main command "+command);
}};
document.getElementById("open-file").click();await settle();await settle();await settle();
const mainHost=document.getElementById("conversation-view");
check(!mainHost.hidden&&mainHost.textContent.includes("Conversation"),"main Semantic entry did not expose Conversation view");
check(mainCalls.some((call)=>call.command==="get_conversation_blocks"),"main Semantic entry did not invoke paged Conversation IPC");
check(document.getElementById("reader-state").hidden,"Conversation context did not replace the generic reader placeholder");
mainHost.querySelector('[data-conversation-action="tree"][data-conversation-block-index]').click();await settle();await settle();await settle();
check(!document.getElementById("tree-panel").hidden&&document.getElementById("tree-panel").querySelector('[data-node-id="12"]')!==null,"main Tree action did not load the exact source NodeId as a narrow Tree root");
check(document.getElementById("raw-panel").hidden,"main Tree action fell back to Raw instead of opening Tree");
const returnScope=document.getElementById("tree-panel").querySelector("[data-return-scope-tree]");check(returnScope!==null,"narrow Tree root did not expose a Return to scope Tree action");returnScope.click();await settle();await settle();
check(document.getElementById("tree-panel").querySelector('[data-node-id="1"]')!==null,"Return to scope Tree did not restore the original scope root");
deferTree=true;mainHost.querySelector('[data-conversation-action="tree"][data-conversation-block-index]').click();await settle();
openRevision=32;document.getElementById("open-file").click();await settle();await settle();
deferTree=false;releaseTree?.(node(12,"string","content",160,220,0));await settle();await settle();
check(!document.getElementById("status-ready").textContent.includes("could not be loaded")&&document.getElementById("tree-panel").querySelector('[data-node-id="12"]')===null,"stale delayed Tree response mutated the newly opened file");
window.__TAURI_INTERNALS__=previousTauri;
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
  await browser(["open", `http://127.0.0.1:${port}/`]);
  const output = await browser(["eval", "-b", Buffer.from(browserTest()).toString("base64")]);
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch {
    const start = output.lastIndexOf("{");
    if (start < 0) throw new Error(`Browser returned non-JSON output: ${output}`);
    result = JSON.parse(output.slice(start));
  }
  if (!result.pass) throw new Error("Conversation UI browser test did not pass.");
  console.log(`conversation-ui PASS (${result.assertions} assertions)`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-5000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
