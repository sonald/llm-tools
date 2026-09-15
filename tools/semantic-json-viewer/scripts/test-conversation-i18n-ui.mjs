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
const session = `sjv-conversation-i18n-${process.pid}`;

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
  try {
    const result = await execFileAsync(command, ["--session", session, ...args], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = [error?.stderr, error?.stdout]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n").trim();
    throw new Error(`${command} ${args[0] ?? "command"} failed${detail ? `: ${detail.slice(-4000)}` : ""}`);
  }
}

function browserTest(port) {
  return `(async()=>{
Object.defineProperty(globalThis,"navigator",{configurable:true,value:{language:"zh-CN",languages:["zh-CN"]}});
const page=await import("/src/conversation-view.ts?conversation-i18n-smoke");
const {ConversationView}=page;
let assertions=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const node=(id,kind,label,spanStart=0,spanEnd=1000,childCount=0,valuePreview=null)=>({id,kind,label,spanStart,spanEnd,labelHasMore:false,valuePreview,valueHasMore:false,childCount});
const ref=(nodeId,spanStart,spanEnd)=>({nodeId,spanStart,spanEnd});
const root=node(1,"object","$",0,1000,1);
const candidate=node(10,"array","messages",100,900,2);
const messageRef=ref(11,120,220);const roleRef=ref(13,130,145);const toolSource=ref(12,230,360);const nameRef=ref(14,240,260);const callRef=ref(15,265,285);const argsRef=ref(16,290,350);const ambiguousRef=ref(20,370,430);
const wrapperRef={scopeRootId:1,scopeRootSpanStart:0,scopeRootSpanEnd:1000,candidateNodeId:10,candidateSpanStart:100,candidateSpanEnd:900,ambiguousDuplicateField:false};
const cursor={kind:"genericConversation",style:"generic",scopeRootId:1,candidateNodeId:10,messageIndex:1,phase:"message",fieldIndex:0,elementIndex:0,sessionRevision:7};
const blockMessage={kind:"message",messageNodeId:11,messageSpanStart:120,messageSpanEnd:220,sourceNodeId:null,sourceSpanStart:null,sourceSpanEnd:null,fieldNodeId:null,fieldSpanStart:null,fieldSpanEnd:null,category:"message",role:"assistant",roleSourceNodeId:13,roleSourceSpanStart:130,roleSourceSpanEnd:145,openaiRefs:null,anthropicRefs:null,ambiguousDuplicateField:false};
const blockTool={kind:"source",messageNodeId:11,messageSpanStart:120,messageSpanEnd:220,sourceNodeId:12,sourceSpanStart:230,sourceSpanEnd:360,fieldNodeId:12,fieldSpanStart:230,fieldSpanEnd:360,category:"toolCall",role:"assistant",roleSourceNodeId:13,roleSourceSpanStart:130,roleSourceSpanEnd:145,openaiRefs:{block:toolSource,text:null,image:null,callId:callRef,function:null,name:nameRef,arguments:argsRef},anthropicRefs:null,ambiguousDuplicateField:false};
const blockAmbiguous={kind:"source",messageNodeId:20,messageSpanStart:370,messageSpanEnd:430,sourceNodeId:20,sourceSpanStart:370,sourceSpanEnd:430,fieldNodeId:null,fieldSpanStart:null,fieldSpanEnd:null,category:"unknown",role:"unknown",roleSourceNodeId:null,roleSourceSpanStart:null,roleSourceSpanEnd:null,openaiRefs:null,anthropicRefs:null,ambiguousDuplicateField:true};
const blockNext={kind:"source",messageNodeId:11,messageSpanStart:120,messageSpanEnd:220,sourceNodeId:12,sourceSpanStart:230,sourceSpanEnd:360,fieldNodeId:12,fieldSpanStart:230,fieldSpanEnd:360,category:"content",role:"assistant",roleSourceNodeId:13,roleSourceSpanStart:130,roleSourceSpanEnd:145,openaiRefs:null,anthropicRefs:null,ambiguousDuplicateField:false};
const calls=[];const raw=[];const tree=[];const content=[];
const summaries=new Map([[14,node(14,"string","name",240,260,0,"read_file")],[15,node(15,"string","id",265,285,0,"call-1")],[16,node(16,"string","arguments",290,350,0,"{\\"x\\":1}")],[12,node(12,"object","tool_call",230,360,2,null)],[20,node(20,"object","whole message",370,430,2,null)]]);
const invoke=async(command,args)=>{
 calls.push({command,args});
 if(command==="get_children")return {nodes:[candidate],hasMore:false,nextCursor:null};
 if(command==="get_conversation_candidate")return {nodeId:10,spanStart:100,spanEnd:900,messageCount:2,kind:"generic",scopeRootId:1,scopeRootSpanStart:0,scopeRootSpanEnd:1000,sessionRevision:7,ambiguousDuplicateField:false};
 if(command==="get_conversation_blocks")return args.cursor?{blocks:[blockNext],hasMore:false,nextCursor:null,wrapperRef}:{blocks:[blockMessage,blockTool,blockAmbiguous],hasMore:true,nextCursor:cursor,wrapperRef};
 if(command==="get_node_summary")return summaries.get(args.nodeId)??node(args.nodeId,"string","content",230,360,0,"text");
 if(command==="get_string_metrics"){const v=summaries.get(args.nodeId)?.valuePreview??"text";const bytes=new TextEncoder().encode(v).byteLength;return {decodedBytes:bytes,characterCount:v.length,lineCount:1};}
 if(command==="get_string_detection")return {semanticType:"plainText",detectionSource:"contentDetected",plainReason:"short"};
 if(command==="read_decoded_text"){const v=summaries.get(args.nodeId)?.valuePreview??"text";return {start:0,text:v,hasMore:false,nextOffset:null};}
 throw new Error("unexpected "+command);
};
const host=document.createElement("div");document.body.append(host);const view=new ConversationView({panel:host,invoke,onError:(error)=>{throw error;},onRaw:(target)=>raw.push(target),onTree:(target)=>tree.push(target),onContent:(target)=>content.push(target)});
view.setContext({mode:"document",sessionRevision:7,sourceSize:1000,scopeRoot:root,scopeLabel:"文档根"});await settle();await settle();await settle();await settle();
check(host.textContent.includes("会话")&&host.textContent.includes("语义投影"),"Chinese Conversation heading/status was not localized");
check(host.querySelector("select[data-conversation-style]")?.selectedOptions[0]?.textContent==="通用","Chinese style label was not localized");
check(host.querySelector('[data-conversation-action="raw"]')?.textContent==="原始"&&host.querySelector('[data-conversation-action="tree"]')?.textContent==="树","Chinese Raw/Tree actions were not localized");
check(host.querySelector('[data-conversation-action="next"]')?.textContent==="下一页"&&host.textContent.includes("3 个块"),"Chinese paging labels/status were not localized");
host.querySelector('[data-conversation-action="raw"][data-conversation-block-index="0"]')?.click();host.querySelector('[data-conversation-action="role"][data-conversation-block-index="0"]')?.click();
check(raw.some((item)=>item.ref.nodeId===11&&item.ref.spanStart===120)&&raw.some((item)=>item.ref.nodeId===13&&item.ref.spanStart===130),"Chinese Raw/role actions changed source references");
host.querySelector('[data-conversation-action="tree"][data-conversation-block-index="0"]')?.click();check(tree.at(-1)?.ref.nodeId===11,"Chinese Tree action changed source reference");
check(host.querySelector(".conversation-block-ambiguity")?.textContent==="存在重复字段歧义","Chinese ambiguity warning was not localized");
host.querySelector('[data-conversation-action="card-raw"]')?.click();check(raw.some((item)=>item.ref.nodeId===14&&item.label.includes("卡片源")),"Chinese tool-card Raw label or source was not preserved");
host.querySelector('[data-conversation-action="next"]')?.click();await settle();await settle();check(host.textContent.includes("内容"),"Chinese next-page content was not rendered");
const badHost=document.createElement("div");document.body.append(badHost);const badInvoke=async(command,args)=>{if(command==="get_children")return {nodes:[candidate],hasMore:false,nextCursor:null};if(command==="get_conversation_candidate")return {nodeId:10,spanStart:100,spanEnd:900,messageCount:2,kind:"generic",scopeRootId:1,scopeRootSpanStart:0,scopeRootSpanEnd:1000,sessionRevision:7,ambiguousDuplicateField:false};if(command==="get_conversation_blocks")return {};throw new Error("unexpected bad command "+command);};const badView=new ConversationView({panel:badHost,invoke:badInvoke,onError:(error)=>{throw error;},onRaw:()=>{},onTree:()=>{},onContent:()=>{}});badView.setContext({mode:"document",sessionRevision:7,sourceSize:1000,scopeRoot:root,scopeLabel:"错误范围"});await settle();await settle();await settle();check(badHost.textContent.includes("会话块响应无效"),"Chinese Conversation error status was not localized");
host.remove();badHost.remove();return {pass:true,assertions};})()`;
}

const port = await freePort();
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += chunk; });
vite.stderr.on("data", (chunk) => { viteOutput += chunk; });
try {
  await waitForPort(port, vite);
  await browser(["open", `http://127.0.0.1:${port}/scripts/test-i18n-fixture.html`]);
  const result = JSON.parse(await browser(["eval", `(${browserTest(port)})`]));
  if (!result.pass) throw new Error("Conversation Chinese smoke did not pass.");
  console.log(`conversation-i18n-ui PASS (${result.assertions} assertions)`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
