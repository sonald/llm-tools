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

const inlineHost=document.createElement("div");document.body.append(inlineHost);inlineHost.style.height="420px";
const inlineRoot=node(800,"array","messages",0,500000,31);
const inlineTexts=new Map([
  [801,{text:"# Safe markdown\\n\\n**visible** and <script>blocked</script>",semanticType:"markdown"}],
  [802,{text:"const answer = 42;\\nconsole.log(answer);",semanticType:"code"}],
  [804,{text:"# object-shaped source",semanticType:"markdown"}],
  [905,{text:"late visible boundary",semanticType:"plainText"}],
  [806,{text:"L".repeat(140000),semanticType:"plainText"}],
  [811,{text:"OpenAI text body",semanticType:"plainText"}],
  [821,{text:"System instruction",semanticType:"plainText"}],
  [822,{text:"private reasoning",semanticType:"plainText"}],
  [823,{text:"# redacted **opaque**",semanticType:"markdown"}],
  [824,{text:"",semanticType:"plainText"}]
]);
const inlineRef=(id)=>ref(id,id*10,id*10+5);
const inlineBlock=(id,category="content",role="assistant",kind="source",style="generic",refs={})=>({
  kind,messageNodeId:kind==="system"?null:700,messageSpanStart:kind==="system"?null:7000,messageSpanEnd:kind==="system"?null:7005,
  sourceNodeId:id,sourceSpanStart:id*10,sourceSpanEnd:id*10+5,fieldNodeId:id,fieldSpanStart:id*10,fieldSpanEnd:id*10+5,
  category,role,roleSourceNodeId:null,roleSourceSpanStart:null,roleSourceSpanEnd:null,
  openaiRefs:style==="openai"?{block:inlineRef(id),text:refs.text??null,image:null,callId:null,function:null,name:null,arguments:null}:null,
  anthropicRefs:style==="anthropic"?{block:inlineRef(id),text:refs.text??null,thinking:refs.thinking??null,data:refs.data??null,id:null,name:null,input:null,toolUseId:null,content:null}:null
});
const genericInlineBlocks=[
  {kind:"message",messageNodeId:700,messageSpanStart:7000,messageSpanEnd:7005,sourceNodeId:null,sourceSpanStart:null,sourceSpanEnd:null,fieldNodeId:null,fieldSpanStart:null,fieldSpanEnd:null,category:"message",role:"assistant",roleSourceNodeId:null,roleSourceSpanStart:null,roleSourceSpanEnd:null,openaiRefs:null,anthropicRefs:null},
  inlineBlock(801,"content"),inlineBlock(802,"content"),
  inlineBlock(804,"value"),
  ...Array.from({length:26},(_,index)=>inlineBlock(850+index,"unknown")),
  inlineBlock(806,"content")
];
const openaiInlineBlocks=[inlineBlock(811,"content","assistant","source","openai",{text:inlineRef(811)})];
const anthropicInlineBlocks=[
  inlineBlock(821,"system","","system","anthropic",{text:inlineRef(821)}),
  inlineBlock(822,"thinking","assistant","source","anthropic",{thinking:inlineRef(822)}),
  inlineBlock(823,"redactedThinking","assistant","source","anthropic",{data:inlineRef(823)}),
  inlineBlock(824,"content","assistant","source","anthropic",{text:inlineRef(824)})
];
const inlineCalls=[];
const inlineInvoke=async(command,args)=>{
  inlineCalls.push({command,args});
  if(command==="get_conversation_candidate")return {nodeId:800,spanStart:0,spanEnd:500000,messageCount:31,kind:"generic",scopeRootId:800,scopeRootSpanStart:0,scopeRootSpanEnd:500000,sessionRevision:18};
  if(command==="get_conversation_blocks"){
    const blocks=args.style==="openai"?openaiInlineBlocks:args.style==="anthropic"?anthropicInlineBlocks:genericInlineBlocks;
    return {blocks,hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:800,scopeRootSpanStart:0,scopeRootSpanEnd:500000,candidateNodeId:800,candidateSpanStart:0,candidateSpanEnd:500000}};
  }
  if(command==="get_node_summary")return node(args.nodeId,args.nodeId===804?"object":"string","content",args.nodeId*10,args.nodeId*10+5,0);
  const text=inlineTexts.get(args.nodeId);
  if(command==="get_string_metrics"&&text){const bytes=new TextEncoder().encode(text.text).byteLength;return {decodedBytes:bytes,characterCount:text.text.length,lineCount:text.text.split(/\\r\\n|\\r|\\n/).length};}
  if(command==="get_string_detection"&&text)return {semanticType:text.semanticType,detectionSource:"contentDetected",plainReason:text.semanticType==="plainText"?"short":null};
  if(command==="read_decoded_text"&&text){const bytes=new TextEncoder().encode(text.text).byteLength;const partial=bytes>args.length;return {start:0,text:partial?text.text.slice(0,args.length):text.text,hasMore:partial,nextOffset:partial?args.length:null};}
  throw new Error("unexpected inline command "+command);
};
const inlineView=new ConversationView({panel:inlineHost,invoke:inlineInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});
inlineView.setContext({mode:"document",sessionRevision:18,sourceSize:500000,scopeRoot:inlineRoot,scopeLabel:"inline fixture"});await settle();await settle();await settle();
check(inlineHost.querySelector(".conversation-inline-markdown strong")?.textContent==="visible","visible Markdown was not rendered as safe structured content");
check(inlineHost.querySelector("script")==null&&inlineHost.textContent.includes("<script>blocked</script>"),"inline Markdown allowed executable HTML or lost escaped source text");
check(inlineHost.querySelector(".conversation-inline-code code")?.textContent?.includes("const answer = 42"),"visible code content was not rendered inline");
check(inlineCalls.some((call)=>call.command==="get_node_summary"&&call.args.nodeId===804)&&!inlineCalls.some((call)=>call.command==="get_string_metrics"&&call.args.nodeId===804),"structured value was sent to string metrics instead of remaining a source-preserving Tree target");
check(!inlineCalls.some((call)=>call.command==="get_string_metrics"&&call.args.nodeId===806),"offscreen long content was read before entering the viewport");
const inlineViewport=inlineHost.querySelector(".conversation-block-viewport");inlineViewport.style.height="240px";
inlineViewport.dispatchEvent(new Event("scroll"));await settle();
const stableInlineTree=inlineHost.querySelector('[data-conversation-action="tree"][data-conversation-block-index="0"]');inlineViewport.scrollTop=1;inlineViewport.dispatchEvent(new Event("scroll"));await settle();
check(stableInlineTree===inlineHost.querySelector('[data-conversation-action="tree"][data-conversation-block-index="0"]'),"same-window inline scroll rebuilt a stable offscreen action node");
inlineViewport.scrollTop=Math.max(0,inlineViewport.scrollHeight-inlineViewport.clientHeight);inlineViewport.dispatchEvent(new Event("scroll"));await settle();await settle();await settle();
check(inlineCalls.some((call)=>call.command==="get_string_metrics"&&call.args.nodeId===806),"visible long content did not trigger bounded string metrics");
check(inlineHost.querySelector(".conversation-inline-partial")!==null&&inlineHost.querySelector('[data-conversation-action="content"][data-conversation-block-index="30"]')!==null,"long inline content did not expose a partial preview and exact Content Viewer entry");
const inlineStyle=inlineHost.querySelector("select[data-conversation-style]");inlineStyle.value="openai";inlineStyle.dispatchEvent(new Event("change",{bubbles:true}));await settle();await settle();await settle();
check(inlineHost.textContent.includes("OpenAI text body")&&inlineHost.querySelector(".conversation-inline-plain")!==null,"explicit OpenAI inline projection did not render text");
const anthropicStyle=inlineHost.querySelector("select[data-conversation-style]");anthropicStyle.value="anthropic";anthropicStyle.dispatchEvent(new Event("change",{bubbles:true}));await settle();await settle();await settle();
check(inlineHost.textContent.includes("System instruction")&&inlineHost.textContent.includes("private reasoning")&&inlineHost.textContent.includes("# redacted **opaque**"),"Anthropic System/Thinking/redacted data were not rendered inline");
check(inlineHost.querySelector(".conversation-block-system h1")===null&&inlineHost.textContent.includes("# redacted **opaque**"),"redacted data was interpreted as Markdown instead of opaque source");
check(inlineHost.querySelectorAll(".conversation-block-system").length===1&&inlineHost.querySelector(".conversation-block-system [data-conversation-action=content]"),"Anthropic System was not kept as an independent block with a Viewer action");
check(inlineHost.querySelector('[data-conversation-inline-node="824"] .conversation-inline-plain')!==null&&!inlineCalls.some((call)=>call.command==="read_decoded_text"&&call.args.nodeId===824),"empty inline content did not render without an invalid zero-length decoded read");
inlineHost.remove();

const headHost=document.createElement("div");document.body.append(headHost);
const headRoot=node(950,"array","messages",0,500000,20);
const headBlocks=Array.from({length:20},(_,index)=>index===5?inlineBlock(905,"content"):inlineBlock(9500+index,"unknown"));
const headCalls=[];
const headInvoke=async(command,args)=>{
  headCalls.push({command,args});
  if(command==="get_conversation_candidate")return {nodeId:950,spanStart:0,spanEnd:500000,messageCount:20,kind:"generic",scopeRootId:950,scopeRootSpanStart:0,scopeRootSpanEnd:500000,sessionRevision:19};
  if(command==="get_conversation_blocks")return {blocks:headBlocks,hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:950,scopeRootSpanStart:0,scopeRootSpanEnd:500000,candidateNodeId:950,candidateSpanStart:0,candidateSpanEnd:500000}};
  if(command==="get_node_summary")return node(args.nodeId,"string","content",args.nodeId*10,args.nodeId*10+5,0);
  const text=inlineTexts.get(args.nodeId);
  if(command==="get_string_metrics"&&text){const bytes=new TextEncoder().encode(text.text).byteLength;return {decodedBytes:bytes,characterCount:text.text.length,lineCount:1};}
  if(command==="get_string_detection"&&text)return {semanticType:text.semanticType,detectionSource:"contentDetected",plainReason:"short"};
  if(command==="read_decoded_text"&&text)return {start:0,text:text.text,hasMore:false,nextOffset:null};
  throw new Error("unexpected head command "+command);
};
const headView=new ConversationView({panel:headHost,invoke:headInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});
headView.setContext({mode:"document",sessionRevision:19,sourceSize:500000,scopeRoot:headRoot,scopeLabel:"head window"});await settle();await settle();await settle();
const headViewport=headHost.querySelector(".conversation-block-viewport");headViewport.style.height="180px";headViewport.dispatchEvent(new Event("scroll"));await settle();
const stableHeadRow=headHost.querySelector('[data-conversation-block-index="0"]');
const headSummaryTen=headHost.querySelector('[data-conversation-block-index="10"] .conversation-block-summary');
check(headSummaryTen?.textContent?.includes("Summary loads when this block enters the viewport."),"head-window fixture did not keep the offscreen summary lazy");
check(!headCalls.some((call)=>call.command==="get_string_metrics"&&call.args.nodeId===905),"head-window offscreen block was read before it became visible");
headViewport.scrollTop=5*136;headViewport.dispatchEvent(new Event("scroll"));await settle();await settle();
check(stableHeadRow===headHost.querySelector('[data-conversation-block-index="0"]'),"overscan-only head-window scroll rebuilt stable DOM");
check(headCalls.some((call)=>call.command==="get_string_metrics"&&call.args.nodeId===905)&&headHost.textContent.includes("late visible boundary"),"visible-boundary change inside one overscan window did not start inline loading");
headViewport.scrollTop=10*136;headViewport.dispatchEvent(new Event("scroll"));await settle();await settle();
const visibleSummaryTen=headHost.querySelector('[data-conversation-block-index="10"] .conversation-block-summary');
check(!visibleSummaryTen?.textContent?.includes("Summary loads when this block enters the viewport.")&&visibleSummaryTen?.textContent?.includes("string Node 9510"),"visible unknown/message block kept its overscan summary placeholder");
check(headCalls.some((call)=>call.command==="get_node_summary"&&call.args.nodeId===9510),"visible unknown/message block did not request its bounded source summary");
headHost.remove();

const deferredHost=document.createElement("div");document.body.append(deferredHost);let releaseInline;
const deferredRoot=node(970,"array","messages",0,500000,1);
const deferredBlock=inlineBlock(971,"content");
const deferredInvoke=async(command,args)=>{
  if(command==="get_conversation_candidate")return {nodeId:970,spanStart:0,spanEnd:500000,messageCount:1,kind:"generic",scopeRootId:970,scopeRootSpanStart:0,scopeRootSpanEnd:500000,sessionRevision:20};
  if(command==="get_conversation_blocks")return {blocks:[deferredBlock],hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:970,scopeRootSpanStart:0,scopeRootSpanEnd:500000,candidateNodeId:970,candidateSpanStart:0,candidateSpanEnd:500000}};
  if(command==="get_node_summary")return node(args.nodeId,"string","content",args.nodeId*10,args.nodeId*10+5,0);
  if(command==="get_string_metrics")return {decodedBytes:4,characterCount:4,lineCount:1};
  if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"short"};
  if(command==="read_decoded_text")return new Promise((resolve)=>{releaseInline=()=>resolve({start:0,text:"late",hasMore:false,nextOffset:null});});
  throw new Error("unexpected deferred command "+command);
};
const deferredView=new ConversationView({panel:deferredHost,invoke:deferredInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});
deferredView.setContext({mode:"document",sessionRevision:20,sourceSize:500000,scopeRoot:deferredRoot,scopeLabel:"deferred inline"});await settle();await settle();await settle();
check(typeof releaseInline==="function","deferred inline fixture did not reach its decoded read");
deferredView.setContext(null);releaseInline?.();await settle();await settle();
check(deferredHost.hidden&&deferredHost.textContent==="","late inline response mutated a closed Conversation context");deferredHost.remove();

const toolHost=document.createElement("div");document.body.append(toolHost);toolHost.style.height="420px";
const toolRoot=node(1200,"array","messages",0,500000,8);
const toolRef=(id,start=id*10,end=start+5)=>({nodeId:id,spanStart:start,spanEnd:end});
const openRefs=(blockId,nameId,callId,argsId,textId=null,argsRef=null)=>({block:toolRef(blockId),text:textId?toolRef(textId):null,image:null,callId:toolRef(callId),function:null,name:toolRef(nameId),arguments:argsRef??toolRef(argsId)});
const anthRefs=(blockId,id,name,input,toolUseId=null,content=null,blockRef=null,inputRef=null,contentRef=null)=>({block:blockRef??toolRef(blockId),text:null,thinking:null,data:null,id:toolRef(id),name:toolRef(name),input:inputRef??toolRef(input),toolUseId:toolUseId?toolRef(toolUseId):null,content:content?(contentRef??toolRef(content)):null});
const toolBlock=(id,category,role="assistant",openaiRefs=null,anthropicRefs=null,messageId=1300)=>({kind:"source",messageNodeId:messageId,messageSpanStart:1000,messageSpanEnd:1600,sourceNodeId:id,sourceSpanStart:id*10,sourceSpanEnd:id*10+5,fieldNodeId:id,fieldSpanStart:id*10,fieldSpanEnd:id*10+5,category,role,roleSourceNodeId:null,roleSourceSpanStart:null,roleSourceSpanEnd:null,openaiRefs,anthropicRefs});
const toolBlocks=[
  toolBlock(2101,"toolCall","assistant",openRefs(2101,2102,2104,2103,null,toolRef(2103,21030,21100))),
  toolBlock(2111,"toolCall","assistant",openRefs(2111,2112,2114,2113)),
  toolBlock(2120,"toolResult","tool",openRefs(2120,2122,2121,2123,2120),null,1301),
  toolBlock(2130,"toolUse","assistant",null,anthRefs(2130,2131,2132,2133,null,null,toolRef(2130,21300,21450),toolRef(2133,21330,21400)),1302),
  toolBlock(2140,"toolResult","user",null,anthRefs(2140,2141,2142,2143,2141,2143,toolRef(2140,21400,21540),null,toolRef(2143,21430,21500)),1303),
  toolBlock(2150,"toolResult","user",null,anthRefs(2150,2151,2152,2153,2151,2153,toolRef(2150,21500,21540),null),1304),
  toolBlock(2160,"toolResult","user",null,anthRefs(2160,2161,2162,2163,2161,2163,toolRef(2160,21600,21640),null),1305),
  toolBlock(2170,"toolCall","assistant",openRefs(2170,2172,2171,2173),null,1306)
];
const toolTexts=new Map([[2102,"read_file"],[2104,"call_abc"],[2112,"parse_json"],[2114,"call_parse"],[2121,"call_abc"],[2131,"toolu_1"],[2132,"read_file"],[2141,"toolu_1"],[2151,"toolu_missing"],[2161,"toolu_bad"],[2171,"call_big"],[2172,"big_tool"],[2232,"Actual result text body"],[2113,JSON.stringify({path:"src",recursive:true})],[2120,JSON.stringify({status:"ok",items:28})],[2153,"plain result"],[2163,"not-json"],[2173,JSON.stringify({huge:"X".repeat(20000)})]]);
const toolSummaries=new Map();
const addToolSummary=(id,kind,label,preview,childCount=0,start=id*10,end=start+5)=>toolSummaries.set(id,{...node(id,kind,label,start,end,childCount),valuePreview:preview,valueHasMore:typeof preview==="string"&&preview.length>256});
addToolSummary(2102,"string","name","read_file");addToolSummary(2104,"string","id","call_abc");addToolSummary(2103,"object","arguments",null,3,21030,21100);
addToolSummary(2112,"string","name","parse_json");addToolSummary(2114,"string","id","call_parse");addToolSummary(2113,"string","arguments",toolTexts.get(2113));
addToolSummary(2121,"string","tool_call_id","call_abc");addToolSummary(2120,"string","content",toolTexts.get(2120));
addToolSummary(2131,"string","id","toolu_1");addToolSummary(2132,"string","name","read_file");addToolSummary(2133,"object","input",null,2,21330,21400);addToolSummary(2130,"object","tool_use",null,3,21300,21450);
addToolSummary(2141,"string","tool_use_id","toolu_1");addToolSummary(2143,"array","content",null,2,21430,21500);addToolSummary(2140,"object","tool_result",null,3,21400,21540);
addToolSummary(2151,"string","tool_use_id","toolu_missing");addToolSummary(2153,"string","content",toolTexts.get(2153));addToolSummary(2150,"object","tool_result",null,2,21500,21540);
addToolSummary(2161,"string","tool_use_id","toolu_bad");addToolSummary(2163,"string","content",toolTexts.get(2163));addToolSummary(2160,"object","tool_result",null,2,21600,21640);
addToolSummary(2172,"string","name","big_tool");addToolSummary(2171,"string","id","call_big");addToolSummary(2173,"string","arguments",toolTexts.get(2173));
const toolChild=(id,label,kind,preview,start,end)=>({...node(id,kind,label,start,end,0),valuePreview:preview,valueHasMore:false});
const toolChildren=new Map([
  [2103,{nodes:[toolChild(2201,"same","string","src",21040,21050),toolChild(2202,"same#2","string","src2",21051,21061),toolChild(2203,"mystery","object",null,21062,21090)],hasMore:false,nextCursor:null}],
  [2133,{nodes:[toolChild(2211,"path","string","src",21340,21350),toolChild(2212,"recursive","true","true",21351,21355)],hasMore:false,nextCursor:null}],
  [2143,{nodes:[toolChild(2221,"[0]","string","ok",21440,21448),toolChild(2222,"[1]","object",null,21449,21480)],hasMore:false,nextCursor:null}],
  [2222,{nodes:[toolChild(2231,"type","string","text",21450,21455),toolChild(2232,"text","string","Actual result text body",21456,21480)],hasMore:false,nextCursor:null}],
  [2130,{nodes:[toolChild(2231,"type","string","tool_use",21310,21320),toolChild(2232,"is_error","false","false",21321,21326)],hasMore:false,nextCursor:null}],
  [2140,{nodes:[toolChild(2241,"type","string","tool_result",21410,21420),toolChild(2242,"is_error","false","false",21421,21426)],hasMore:false,nextCursor:null}],
  [2150,{nodes:[toolChild(2251,"type","string","tool_result",21510,21520)],hasMore:false,nextCursor:null}],
  [2160,{nodes:[toolChild(2261,"is_error","string","yes",21610,21615)],hasMore:false,nextCursor:null}]
]);
let deferToolLong=false;let releaseToolLong;
const toolCalls=[];
const toolInvoke=async(command,args)=>{
  toolCalls.push({command,args});
  if(command==="get_conversation_candidate")return {nodeId:1200,spanStart:0,spanEnd:500000,messageCount:8,kind:"generic",scopeRootId:1200,scopeRootSpanStart:0,scopeRootSpanEnd:500000,sessionRevision:21};
  if(command==="get_conversation_blocks")return {blocks:toolBlocks,hasMore:false,nextCursor:null,wrapperRef:{scopeRootId:1200,scopeRootSpanStart:0,scopeRootSpanEnd:500000,candidateNodeId:1200,candidateSpanStart:0,candidateSpanEnd:500000}};
  if(command==="get_node_summary")return toolSummaries.get(args.nodeId)??node(args.nodeId,"object","unknown",args.nodeId*10,args.nodeId*10+5,0);
  if(command==="preview_nested_json")return {parsedBytes:50,root:node(7700,"object","$",0,50,1),children:[toolChild(7701,"nested","string","value",5,15)],hasMore:false,sessionRevision:21};
  if(command==="get_children"&&toolChildren.has(args.nodeId))return toolChildren.get(args.nodeId);
  if(command==="get_children")return {nodes:[],hasMore:false,nextCursor:null};
  const textValue=toolTexts.get(args.nodeId);
  if(command==="get_string_metrics"&&textValue){const bytes=new TextEncoder().encode(textValue).byteLength;return {decodedBytes:bytes,characterCount:textValue.length,lineCount:1};}
  if(command==="get_string_detection"&&textValue)return {semanticType:textValue.startsWith("{")?"nestedJson":"plainText",detectionSource:"contentDetected",plainReason:textValue.startsWith("{")?null:"short"};
  if(command==="read_decoded_text"&&args.nodeId===2173&&deferToolLong)return new Promise((resolve)=>{releaseToolLong=()=>resolve({start:0,text:toolTexts.get(2173).slice(0,args.length),hasMore:true,nextOffset:args.length});});
  if(command==="read_decoded_text"&&textValue){const partial=new TextEncoder().encode(textValue).byteLength>args.length;return {start:0,text:partial?textValue.slice(0,args.length):textValue,hasMore:partial,nextOffset:partial?args.length:null};}
  throw new Error("unexpected tool command "+command);
};
const toolRaw=[];const toolTree=[];const toolContent=[];
const toolView=new ConversationView({panel:toolHost,invoke:toolInvoke,onError:(error)=>{throw error;},onRaw:(target)=>toolRaw.push(target),onTree:(target)=>toolTree.push(target),onContent:(target)=>toolContent.push(target)});
toolView.setContext({mode:"document",sessionRevision:21,sourceSize:500000,scopeRoot:toolRoot,scopeLabel:"tool fixture"});await settle();await settle();await settle();await settle();
check(toolHost.querySelectorAll(".conversation-tool-card").length>0,"tool fixture did not render a Tool card");
check(toolHost.querySelector('[data-conversation-block-index="2"] .conversation-block-summary')===null,"loaded ToolResult card kept the generic viewport summary placeholder");
check(toolHost.textContent.includes("read_file")&&toolHost.textContent.includes("call_abc")&&toolHost.textContent.includes("same#2")&&toolHost.textContent.includes("mystery"),"OpenAI object arguments did not show actual name/id and duplicate/unknown fields");
check(toolHost.textContent.includes("Nested JSON")&&toolCalls.some((call)=>call.command==="preview_nested_json")&&!toolCalls.some((call)=>call.command==="open_nested_json"||call.command==="close_nested_scope"),"string arguments did not use the isolated bounded preview command");
const cardRaw=toolHost.querySelector('[data-conversation-action="card-raw"]');check(cardRaw!==null, "Tool card did not expose a precise Raw source action");cardRaw.click();check(toolRaw.length>0&&toolRaw.at(-1).ref.nodeId===2102,"Tool card Raw action did not preserve the exact source NodeId");
const toolViewport=toolHost.querySelector(".conversation-block-viewport");toolViewport.style.height="220px";deferToolLong=true;toolViewport.scrollTop=Math.max(0,toolViewport.scrollHeight-toolViewport.clientHeight);toolViewport.dispatchEvent(new Event("scroll"));await settle();await settle();await settle();await settle();
check(toolHost.textContent.includes("toolu_1")&&toolHost.textContent.includes("Actual result text body")&&toolHost.textContent.includes("is_error: false")&&toolHost.textContent.includes("is_error: missing")&&toolHost.textContent.includes("is_error: invalid")&&toolHost.textContent.includes("not-json"),"Anthropic ToolUse/ToolResult cards did not distinguish ids, text blocks, error states, or parse-failure text");
const loadedResultBlock=toolHost.querySelector('[data-conversation-block-index="2"]');loadedResultBlock?.scrollIntoView({block:"center"});toolViewport.dispatchEvent(new Event("scroll"));await settle();await settle();
check(toolHost.querySelector('[data-conversation-block-index="2"]')?.textContent?.includes("Related call confirmed in loaded page"),"Tool result association was not confirmed from a loaded call: "+toolHost.querySelector('[data-conversation-block-index="2"]')?.textContent);
toolViewport.scrollTop=Math.max(0,toolViewport.scrollHeight-toolViewport.clientHeight);toolViewport.dispatchEvent(new Event("scroll"));await settle();await settle();
check(typeof releaseToolLong==="function"&&!toolHost.querySelector(".conversation-tool-card-truncated"),"long Tool card did not pause before its deferred read");
toolHost.hidden=true;releaseToolLong?.();await settle();await settle();check(!toolHost.textContent.includes("Showing the first"),"hidden Tool card applied a late deferred response");
deferToolLong=false;toolHost.hidden=false;toolView.onSemanticVisible();await settle();await settle();await settle();
const toolReadBytes=toolCalls.filter((call)=>call.command==="read_decoded_text").reduce((total,call)=>total+Number(call.args.length||0),0);
check(toolReadBytes<=256*1024,"Tool card decoded text exceeded the 256 KiB per-card budget: "+toolReadBytes);
check(toolHost.querySelector(".conversation-tool-card-truncated")!==null&&toolHost.textContent.includes("Tool details"),"Tool cards did not resume after a hidden panel");toolHost.remove();

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
let openRevision=31;let deferTree=false;let releaseTree;let deferInlineRead=false;let releaseInlineRead;
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
  if(command==="get_string_metrics")return {decodedBytes:11,characterCount:11,lineCount:1};
  if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"short"};
  if(command==="read_decoded_text"&&deferInlineRead)return new Promise((resolve)=>{releaseInlineRead=()=>resolve({start:0,text:"main inline",hasMore:false,nextOffset:null});});
  if(command==="read_decoded_text")return {start:0,text:"main inline",hasMore:false,nextOffset:null};
  if(command==="read_raw_slice")return {start:args.sourceStart,text:"source",hasMore:false,nextOffset:null};
  throw new Error("unexpected main command "+command);
}};
deferInlineRead=true;document.getElementById("open-file").click();await settle();await settle();await settle();
const mainHost=document.getElementById("conversation-view");
check(!mainHost.hidden&&mainHost.textContent.includes("Conversation"),"main Semantic entry did not expose Conversation view");
check(mainCalls.some((call)=>call.command==="get_conversation_blocks"),"main Semantic entry did not invoke paged Conversation IPC");
check(document.getElementById("reader-state").hidden,"Conversation context did not replace the generic reader placeholder");
const inlineCommands=()=>mainCalls.filter((call)=>call.command==="get_string_metrics"||call.command==="get_string_detection"||call.command==="read_decoded_text");
check(inlineCommands().some((call)=>call.command==="read_decoded_text"),"main fixture did not reach a deferred inline decoded read");
const inlineBeforeHidden=inlineCommands().length;
mainHost.querySelector('[data-conversation-action="tree"][data-conversation-block-index]').click();await settle();await settle();await settle();
check(!document.getElementById("tree-panel").hidden&&document.getElementById("tree-panel").querySelector('[data-node-id="12"]')!==null,"main Tree action did not load the exact source NodeId as a narrow Tree root");
check(document.getElementById("raw-panel").hidden,"main Tree action fell back to Raw instead of opening Tree");
document.getElementById("raw-tab").click();await settle();
deferInlineRead=false;releaseInlineRead?.();await settle();await settle();
check(inlineCommands().length===inlineBeforeHidden,"Tree/Raw-hidden Semantic panel applied or started a late inline response");
document.getElementById("semantic-tab").click();await settle();await settle();await settle();
check(inlineCommands().length>inlineBeforeHidden&&mainHost.textContent.includes("main inline"),"returning to Semantic did not resume the current visible inline block");
check(document.getElementById("semantic-panel").hidden===false&&document.getElementById("raw-panel").hidden===true,"Semantic visibility hook did not restore the projection panel");
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
