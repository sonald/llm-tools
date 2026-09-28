#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteBin = resolve(root, "node_modules/vite/bin/vite.js");
const session = `sjv-ux-redesign-${process.pid}`;
const launchOnly = process.env.LAUNCH === "1";

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
  const deadline = Date.now() + 20_000;
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

const browserHome = `${process.env.HOME}/.local/lib/tode/vendor/terminal-browser/agent-browser/bin`;
const browserEnv = existsSync(`${browserHome}/agent-browser`)
  ? { ...process.env, PATH: `${browserHome}:${process.env.PATH}` }
  : process.env;

async function browser(args, attempt = 0) {
  try {
    const result = await execFileAsync("agent-browser", ["--session", session, ...args], {
      cwd: root,
      env: browserEnv,
      maxBuffer: 12 * 1024 * 1024
    });
    return result.stdout.trim();
  } catch (error) {
    const busy = /Resource temporarily unavailable|daemon may be busy/.test(String(error));
    if (busy && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      return browser(args, attempt + 1);
    }
    throw error;
  }
}

function parseBrowserValue(output) {
  try { return JSON.parse(output); } catch {
    const start = output.lastIndexOf("{");
    if (start >= 0) return JSON.parse(output.slice(start));
    throw new Error(`Browser returned non-JSON output: ${output.slice(-2000)}`);
  }
}

function browserTest(expectedLanguage, launch) {
  return `(async()=>{
const expectedLanguage=${JSON.stringify(expectedLanguage)};
const launchOnly=${launch ? "true" : "false"};
const zh=expectedLanguage==="zh-CN";
let assertions=0;
const calls=[];
let doc=null;
let releaseCandidate=null;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message+"\\n"+document.body.innerText.slice(0,1600));};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const waitFor=async(predicate,message)=>{for(let attempt=0;attempt<100;attempt+=1){await settle();if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,30));}throw new Error(message+"\\n"+document.body.innerText.slice(0,1600));};
await waitFor(()=>document.documentElement.dataset.testAppReady==="true","fixture did not become ready");
const node=(id,kind,label,spanStart,spanEnd,childCount,valuePreview=null,valueHasMore=false)=>({id,kind,label,spanStart,spanEnd,labelHasMore:false,valuePreview,valueHasMore,childCount});
const childrenOf=(id,nodes)=>({[id]:{nodes,hasMore:false,nextCursor:null}});
const progress=(indexed,complete=false,total=null)=>({indexedEntries:indexed,indexedSourceLines:indexed,complete,stride:1,totalEntries:total,eventStreamHint:null});
const entry=(ordinal,status,sourceLine,byteStart,byteEnd,parseError=null)=>({location:{entryOrdinal:ordinal,sourceLine,byteStart,byteEnd},status,parseError,eventSummary:null});
const summary=(path,size,mode,root,extra={})=>({path,size,mode,root,progress:extra.progress??null,manyInvalidUtf8Warning:false,documentError:extra.documentError??null,sessionRevision:extra.sessionRevision??1,fileGeneration:extra.fileGeneration??1});
const messageBlock=(role,id,start,end)=>({kind:"message",messageNodeId:id,messageSpanStart:start,messageSpanEnd:end,sourceNodeId:null,sourceSpanStart:null,sourceSpanEnd:null,fieldNodeId:null,fieldSpanStart:null,fieldSpanEnd:null,category:"message",role,roleSourceNodeId:null,roleSourceSpanStart:null,roleSourceSpanEnd:null,openaiRefs:null,anthropicRefs:null,ambiguousDuplicateField:false});
const wrapper=(rootId,start,end,candidateId,candidateStart,candidateEnd)=>({scopeRootId:rootId,scopeRootSpanStart:start,scopeRootSpanEnd:end,candidateNodeId:candidateId,candidateSpanStart:candidateStart,candidateSpanEnd:candidateEnd,ambiguousDuplicateField:false});
const candidateDto=(id,start,end,count,kind,scopeRootId,scopeStart,scopeEnd,revision)=>({nodeId:id,spanStart:start,spanEnd:end,messageCount:count,kind,scopeRootId,scopeRootSpanStart:scopeStart,scopeRootSpanEnd:scopeEnd,sessionRevision:revision,ambiguousDuplicateField:false});
const slice=(source,start,length)=>{const text=source.slice(start,start+length);return {start,text,hasMore:false,nextOffset:null};};
const bytesOf=(text)=>Array.from(new TextEncoder().encode(text));
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
  calls.push({command,args});
  await new Promise((resolve)=>setTimeout(resolve,0));
  if(command==="plugin:dialog|open")return doc.path;
  if(command==="open_file")return doc.summary;
  if(command==="get_root_node")return doc.summary.root;
  if(command==="get_children"){
    if(doc.pagedChildren?.[args.nodeId]){
      const all=doc.pagedChildren[args.nodeId];
      const nodes=all.slice(args.cursor,args.cursor+args.limit);
      const next=args.cursor+nodes.length;
      return {nodes,hasMore:next<all.length,nextCursor:next<all.length?next:null};
    }
    return doc.children[args.nodeId]??{nodes:[],hasMore:false,nextCursor:null};
  }
  if(command==="read_raw_slice")return slice(doc.source,args.sourceStart,args.length);
  if(command==="read_raw_document_bytes"||command==="read_selected_entry_window"){
    const text=(doc.source||"").slice(args.offset,args.offset+args.length);
    return {start:args.offset,bytes:bytesOf(text),hasMore:false,nextOffset:null};
  }
  if(command==="list_entries")return {entries:doc.entries,hasMore:false,nextCursor:null,progress:doc.summary.progress};
  if(command==="select_entry"){
    if(doc.failSelectOrdinal===args.ordinal){
      doc.failSelectOrdinal=null;
      throw {code:"internal",message:"selection temporarily unavailable"};
    }
    const chosen=doc.entries.find((item)=>item.location.entryOrdinal===args.ordinal);
    const root=chosen.status==="valid"?doc.entryRoots[args.ordinal]:null;
    return {entry:chosen,root,sessionRevision:args.sessionRevision+1};
  }
  if(command==="scan_entries"){
    doc.summary={...doc.summary,progress:doc.nextProgress??doc.summary.progress};
    return doc.summary.progress;
  }
  if(command==="get_conversation_candidate"){
    const found=(doc.candidates??[]).find((item)=>item.nodeId===args.candidateNodeId);
    if(doc.candidateParents){
      let current=args.candidateNodeId;
      while(current!==args.scopeRootId&&doc.candidateParents[current]!==undefined)current=doc.candidateParents[current];
      if(current!==args.scopeRootId||found?.scopeRootId!==args.scopeRootId)throw {code:"invalid_request",message:"candidate is outside the selected root"};
    }
    if(doc.delayCandidate)return new Promise((resolve)=>{releaseCandidate=()=>resolve(found);});
    if(!found)throw {code:"invalid_request",message:"not a message array"};
    return {...found,sessionRevision:args.sessionRevision};
  }
  if(command==="get_conversation_blocks"){
    if(doc.candidateParents){
      let current=args.candidateNodeId;
      while(current!==args.scopeRootId&&doc.candidateParents[current]!==undefined)current=doc.candidateParents[current];
      if(current!==args.scopeRootId)throw {code:"invalid_request",message:"candidate is outside the selected root"};
    }
    return doc.blocksFor(args);
  }
  if(command==="copy_node"){
    if(doc.copyFails)throw {code:"file_changed",message:"file changed on disk: "+doc.path};
    return null;
  }
  if(command==="search_current")return doc.searchPage;
  if(command==="start_navigation_search")return doc.navProgress;
  if(command==="advance_navigation_search")return doc.navProgress;
  if(command==="stop_navigation_search")return null;
  if(command==="get_navigation_search_page")return doc.navPage;
  if(command==="get_string_detection")return {semanticType:"markdown",detectionSource:"contentDetected",plainReason:null};
  if(command==="get_string_metrics")return {decodedBytes:doc.longText.length,characterCount:doc.longText.length,lineCount:2};
  if(command==="read_decoded_text")return {start:0,text:doc.longText,hasMore:false,nextOffset:null};
  if(command==="get_node_summary")return doc.summary.root;
  throw new Error("unexpected IPC "+command);
}};
const openDoc=async(next)=>{
  doc=next;
  const before=calls.length;
  document.getElementById("open-file").click();
  await waitFor(()=>calls.slice(before).some((call)=>call.command==="open_file"),"file did not open");
  await settle();await settle();
};
const reading=()=>document.getElementById("generic-reader");
const visibleReading=()=>reading()&&reading().hidden===false?reading().innerText:"";
const plainSource='{"name":"Ada","count":1}';
const plainRoot=node(1,"object","$",0,plainSource.length,2);
const plainName=node(2,"string","name",2,12,0,"Ada");
const plainCount=node(3,"number","count",14,plainSource.length-1,0,"1");
await openDoc({
  path:"/tmp/plain.json",
  source:plainSource,
  summary:summary("/tmp/plain.json",plainSource.length,"document",plainRoot),
  children:{...childrenOf(1,[plainName,plainCount])},
  longText:"# Title\\n\\nhello"
});
await waitFor(()=>visibleReading().includes("Ada")&&visibleReading().includes("name")&&visibleReading().includes("count"),"plain object did not show field names and values");
check(!document.body.innerText.includes(zh?"大纲按需加载":"Outline loads on demand"),"outline promise is still shown");
check(document.getElementById("semantic-panel").hidden===false,"reading surface is not the active view");
check(document.getElementById("reader-state").hidden===true,"empty semantic placeholder is still the reading surface");
check(document.getElementById("semantic-tab").textContent.includes(zh?"阅读":"Reading"),"reading tab label is missing");
check(document.getElementById("raw-tab").textContent.includes(zh?"源文本":"Source text"),"source tab label is missing");
check(document.getElementById("document-outline").hidden===false&&document.getElementById("document-outline").innerText.includes("name"),"real outline is missing");
if(launchOnly)return {pass:true,assertions,launch:true};
const pagedFields=Array.from({length:201},(_,index)=>'"field'+index+'":'+index);
const pagedSource='{'+pagedFields.join(',')+'}';
const pagedRoot=node(1,"object","$",0,bytesOf(pagedSource).length,201);
const pagedNodes=pagedFields.map((field,index)=>{
  const start=pagedSource.indexOf(field,index===0?0:pagedSource.indexOf(pagedFields[index-1])+pagedFields[index-1].length);
  return node(index+2,"number","field"+index,start,start+field.length,0,String(index));
});
check(JSON.parse(pagedSource).field200===200&&pagedNodes[200].spanEnd<pagedRoot.spanEnd,"paged fixture is not a valid source-backed object");
await openDoc({path:"/tmp/paged.json",source:pagedSource,summary:summary("/tmp/paged.json",pagedSource.length,"document",pagedRoot),children:{},pagedChildren:{1:pagedNodes},longText:"x"});
await waitFor(()=>reading().querySelector('[data-action="load-more"]')&&document.querySelector('[data-outline-more="1"]'),"a partial field page did not offer more fields");
reading().querySelector('[data-action="load-more"]').click();
await waitFor(()=>visibleReading().includes("field200")&&reading().querySelector('[data-field-id="202"]'),"reader lost a field after page 200");
document.querySelector('[data-outline-more="1"]').click();
await waitFor(()=>document.getElementById("document-outline").innerText.includes("field200"),"outline lost a field after page 200");
check(calls.some((call)=>call.command==="get_children"&&call.args.nodeId===1&&call.args.cursor===200),"remaining child page was not fetched");
const scalar=async(source,root,needle)=>{
  await openDoc({path:"/tmp/scalar.json",source,summary:summary("/tmp/scalar.json",source.length,"document",root),children:{},longText:"x"});
  await waitFor(()=>visibleReading().includes(needle),"scalar display missing "+needle+" in "+visibleReading());
};
await scalar("{}",node(1,"object","$",0,2,0),zh?"空对象":"Empty object");
await openDoc({path:"/tmp/empty-array.json",source:"[]",summary:summary("/tmp/empty-array.json",2,"collection",node(1,"array","$",0,2,0)),children:{},longText:"x"});
await waitFor(()=>visibleReading().includes(zh?"空数组":"Empty array"),"empty array was not distinct");
await openDoc({path:"/tmp/empty-string.json",source:'""',summary:summary("/tmp/empty-string.json",2,"document",node(1,"string","$",0,2,0,"")),children:{},longText:"x"});
await waitFor(()=>visibleReading().includes(zh?"空字符串":"Empty string"),"empty string was not distinct");
await scalar("null",node(1,"null","$",0,4,0,"null"),"null");
await scalar("0",node(1,"number","$",0,1,0,"0"),"0");
await scalar("false",node(1,"false","$",0,5,0,"false"),"false");
check(!visibleReading().includes(zh?"空对象":"Empty object"),"false was shown as an empty object");
const longText="# Title\\n\\n"+("body ".repeat(40));
const longSource='{"note":"'+longText.replaceAll("\\n","\\\\n")+'"}';
const longRoot=node(1,"object","$",0,longSource.length,1);
const longNote=node(2,"string","note",8,longSource.length-1,0,longText,true);
await openDoc({path:"/tmp/long.json",source:longSource,summary:summary("/tmp/long.json",longSource.length,"document",longRoot),children:childrenOf(1,[longNote]),longText});
await waitFor(()=>visibleReading().includes(zh?"展开阅读":"Expand reading"),"expand reading is not discoverable");
const expand=reading().querySelector('[data-action="expand"]');
check(expand!==null,"expand reading button is missing");
expand.click();
await waitFor(()=>document.getElementById("content-viewer-dialog").open,"expand reading did not open the viewer");
const frame=document.getElementById("content-viewer-html-preview-frame");
check(frame.getAttribute("sandbox")===""&&!String(frame.getAttribute("sandbox")).includes("allow-scripts"),"HTML preview sandbox changed");
document.getElementById("content-viewer-close").click();
await waitFor(()=>!document.getElementById("content-viewer-dialog").open,"content viewer did not close");
await waitFor(()=>document.activeElement===expand||reading().contains(document.activeElement),"focus did not return near expand reading");
const payloadSource=JSON.stringify({title:"Keep this field",payload:{history:[{role:"user",content:"Nested hello"},{role:"assistant",content:"Nested reply"}],note:"Keep this too"}});
const payloadRoot=node(1,"object","$",0,payloadSource.length,2);
const payload=node(2,"object","payload",payloadSource.indexOf('"payload"'),payloadSource.length-1,2);
const historyStart=payloadSource.indexOf('"history"');
const historyEnd=payloadSource.indexOf('],"note"')+1;
const history=node(3,"array","history",historyStart,historyEnd,2);
const payloadTitle=node(4,"string","title",payloadSource.indexOf('"title"'),payloadSource.indexOf(',"payload"'),0,"Keep this field");
const payloadNote=node(5,"string","note",payloadSource.indexOf('"note"'),payloadSource.length-2,0,"Keep this too");
const nestedUser=node(31,"object","[0]",payloadSource.indexOf('{"role"'),payloadSource.indexOf('},{"role"')+1,2);
const nestedAssistant=node(32,"object","[1]",payloadSource.indexOf('{"role"',nestedUser.spanEnd),historyEnd-1,2);
check(JSON.parse(payloadSource).payload.history[1].content==="Nested reply"&&nestedAssistant.spanEnd<history.spanEnd,"nested fixture must be a real source-backed array");
await openDoc({path:"/tmp/payload.json",source:payloadSource,summary:summary("/tmp/payload.json",payloadSource.length,"document",payloadRoot),children:{...childrenOf(1,[payloadTitle,payload]),...childrenOf(2,[history,payloadNote]),...childrenOf(3,[nestedUser,nestedAssistant])},candidateParents:{3:2,2:1},candidates:[candidateDto(3,historyStart,historyEnd,2,"generic",1,0,payloadSource.length,1)],blocksFor:(args)=>({blocks:[messageBlock("user",31,nestedUser.spanStart,nestedUser.spanEnd),messageBlock("assistant",32,nestedAssistant.spanStart,nestedAssistant.spanEnd)],hasMore:false,nextCursor:null,wrapperRef:wrapper(1,0,payloadSource.length,args.candidateNodeId,historyStart,historyEnd)}),longText:"x"});
await waitFor(()=>visibleReading().includes("payload")&&visibleReading().includes("Keep this field"),"nested payload and original sibling were not readable");
check(!document.getElementById("conversation-view").innerText.includes(zh?"消息格式":"Message format"),"nested custom array was auto-opened as a conversation");
reading().querySelector('[data-action="expand-node"][data-field-id="2"]').click();
await waitFor(()=>visibleReading().includes("history")&&visibleReading().includes("Keep this too"),"nested custom array and sibling were not shown on demand");
const readMessages=[...reading().querySelectorAll("button")].find((button)=>button.dataset.action==="messages"&&button.dataset.fieldId==="3");
check(readMessages?.textContent.includes(zh?"按消息阅读":"Read as messages"),"nested custom array action was not discoverable");
readMessages.click();
await waitFor(()=>document.getElementById("conversation-view").innerText.includes("user")&&document.getElementById("conversation-view").innerText.includes("assistant"),"explicit custom array did not render both messages");
check(calls.some((call)=>call.command==="get_conversation_candidate"&&call.args.scopeRootId===1&&call.args.candidateNodeId===3)&&calls.some((call)=>call.command==="get_conversation_blocks"&&call.args.scopeRootId===1&&call.args.candidateNodeId===3),"explicit array did not use root-bound conversation IPC");
check(document.getElementById("conversation-view").querySelector('[data-conversation-action="wrapper-raw"]')!==null,"complete wrapper source is not available");
document.getElementById("conversation-view").querySelector('[data-conversation-action="ordinary"]').click();
await waitFor(()=>visibleReading().includes("Keep this field")&&visibleReading().includes("Keep this too")&&visibleReading().includes("history"),"ordinary JSON lost original wrapper fields");
const arraySource="[{},{}]";
const arrayRoot=node(1,"array","$",0,arraySource.length,2);
await openDoc({path:"/tmp/chat.json",source:arraySource,summary:summary("/tmp/chat.json",1000,"collection",node(1,"array","$",0,1000,2)),children:childrenOf(1,[node(11,"object","[0]",1,40,1),node(12,"object","[1]",41,80,1)]),candidates:[candidateDto(1,0,1000,2,"generic",1,0,1000,1)],blocksFor:()=>({blocks:[messageBlock("user",11,1,40),messageBlock("assistant",12,41,80)],hasMore:false,nextCursor:null,wrapperRef:wrapper(1,0,1000,1,0,1000)}),longText:"x"});
await waitFor(()=>document.getElementById("conversation-view").innerText.includes("user")&&document.getElementById("conversation-view").innerText.includes("assistant"),"root message array did not show the whole conversation");
check(document.getElementById("collection-root").getAttribute("aria-pressed")==="true","root conversation collapsed to one selected item");
check(document.getElementById("generic-reader").hidden===true,"root conversation left only the generic first item visible");
const blocksBeforeMulti=calls.filter((call)=>call.command==="get_conversation_blocks").length;
const multiRoot=node(1,"object","$",0,500,2);
const messages=node(10,"array","messages",10,200,2,"user");
const conversations=node(20,"array","conversations",210,400,1,"assistant");
await openDoc({path:"/tmp/multi.json",source:"{}",summary:summary("/tmp/multi.json",500,"document",multiRoot),children:childrenOf(1,[messages,conversations]),candidates:[candidateDto(10,10,200,2,"generic",1,0,500,1),candidateDto(20,210,400,1,"openai",1,0,500,1)],blocksFor:(args)=>args.style==="openai"?{blocks:[messageBlock("assistant",21,150,190)],hasMore:false,nextCursor:null,wrapperRef:wrapper(1,0,500,args.candidateNodeId,10,200)}:{blocks:[messageBlock("user",11,20,80)],hasMore:false,nextCursor:null,wrapperRef:wrapper(1,0,500,args.candidateNodeId,10,200)},longText:"x"});
await waitFor(()=>document.getElementById("conversation-view").innerText.includes(zh?"消息数组":"Message array")&&document.getElementById("conversation-view").innerText.includes("messages")&&document.getElementById("conversation-view").innerText.includes("conversations"),"multiple message arrays were not choosable");
check(calls.filter((call)=>call.command==="get_conversation_blocks").length===blocksBeforeMulti,"multiple candidates were auto-rendered");
document.querySelector('[data-conversation-candidate="10"]').click();
await waitFor(()=>document.getElementById("conversation-view").innerText.includes(zh?"消息格式":"Message format"),"message format control did not appear");
const format=document.querySelector("[data-conversation-style]");
format.value="openai";
format.dispatchEvent(new Event("change",{bubbles:true}));
await waitFor(()=>document.getElementById("conversation-view").innerText.includes(zh?"无法保持同一条消息":"could not be kept"),"format switch did not explain a lost message");
document.querySelector('[data-conversation-action="ordinary"]').click();
await waitFor(()=>visibleReading().includes("messages")&&visibleReading().includes("conversations"),"ordinary JSON dropped original fields");
const recordRoot=node(8,"object","$",0,20,1);
const recordName=node(9,"string","title",2,12,0,"First");
const entries=[entry(0,"valid",4,0,20),entry(1,"valid",9,21,40)];
let indexed=1;
await openDoc({path:"/tmp/notes.jsonl",source:'{"title":"First"}\\n{"title":"Second"}',summary:summary("/tmp/notes.jsonl",40,"entry",null,{progress:progress(1),fileGeneration:3}),children:childrenOf(8,[recordName]),entries,entryRoots:{0:recordRoot,1:node(18,"object","$",0,20,1)},nextProgress:progress(3),longText:"x"});
await waitFor(()=>visibleReading().includes("First")&&document.body.innerText.includes(zh?"第 1 条":"Record 1"),"first JSONL record was not readable");
check(document.body.innerText.includes(zh?"总数未知":"Total unknown"),"JSONL invented a total while scanning");
const selectsBefore=calls.filter((call)=>call.command==="select_entry").length;
doc.summary.progress=progress(3);
await waitFor(()=>document.body.innerText.includes(zh?"第 1 条":"Record 1"),"record label disappeared");
await new Promise((resolve)=>setTimeout(resolve,80));
check(calls.filter((call)=>call.command==="select_entry").length===selectsBefore,"indexing stole the selected record");
check(document.body.innerText.includes(zh?"第 4 行":"line 4"),"JSONL source line is not separate from the record label");
const bad=entry(0,"invalidJson",1,0,5,{message:"broken record",byteOffset:1,line:1,column:2});
const good=entry(1,"valid",2,6,20);
await openDoc({path:"/tmp/bad.jsonl",source:"[bad]\\n{\\"title\\":\\"Later\\"}",summary:summary("/tmp/bad.jsonl",20,"entry",null,{progress:progress(2,true,2),fileGeneration:4}),children:childrenOf(18,[node(19,"string","title",2,12,0,"Later")]),entries:[bad,good],entryRoots:{1:node(18,"object","$",0,14,1)},longText:"x"});
await waitFor(()=>document.getElementById("raw-panel").hidden===false&&document.getElementById("error-region").hidden===false&&document.body.innerText.includes("broken record"),"damaged first record was skipped");
check(document.querySelector('[data-entry-ordinal="1"]')!==null,"later JSONL record is not navigable");
document.querySelector('[data-entry-ordinal="1"]').click();
await waitFor(()=>calls.some((call)=>call.command==="select_entry"&&call.args.ordinal===1),"later record could not be selected");
const eofEntry=entry(0,"invalidJson",1,0,5,{message:"unexpected end of input",byteOffset:5,line:1,column:6});
await openDoc({path:"/tmp/eof-entry.jsonl",source:'{"a":\\n{"ok":true}',summary:summary("/tmp/eof-entry.jsonl",17,"entry",null,{progress:progress(2,true,2),fileGeneration:5}),children:{},entries:[eofEntry,entry(1,"valid",2,6,17)],entryRoots:{1:node(18,"object","$",0,11,0)},longText:"x"});
await waitFor(()=>document.getElementById("raw-panel").hidden===false,"invalid first record did not open its source");
document.getElementById("error-locate").click();
await waitFor(()=>document.getElementById("locate-note").textContent.includes(zh?"输入末尾":"end of input"),"JSONL EOF was compared to the whole-file size");
check(!document.querySelector('#raw-panel mark[data-source-highlight="bytes"]'),"JSONL EOF highlighted a preceding record byte");
const scopeBefore=document.getElementById("find-scope-label").textContent;
await openDoc({path:"/tmp/plain.json",source:plainSource,summary:summary("/tmp/plain.json",plainSource.length,"document",plainRoot),children:childrenOf(1,[plainName,plainCount]),longText:"x"});
await waitFor(()=>visibleReading().includes("Ada"),"plain object did not return");
const scopeLabel=document.getElementById("find-scope-label").textContent;
reading().querySelector('[data-field-id="2"]').click();
await settle();
check(document.getElementById("find-scope-label").textContent===scopeLabel,"field selection changed the find scope");
check(document.getElementById("semantic-panel").hidden===false,"field selection left reading");
const rawReadsBefore=calls.filter((call)=>call.command==="read_raw_slice").length;
document.getElementById("raw-tab").click();
await waitFor(()=>document.getElementById("raw-panel").hidden===false&&document.querySelector(".raw-scope")&&document.querySelector(".raw-scope").textContent.includes(String(plainSource.length)),"source text did not keep the whole file range");
check(!document.querySelector(".raw-scope").textContent.includes("Node #2"),"source text was replaced by the field range");
const rawReads=calls.slice(rawReadsBefore).filter((call)=>call.command==="read_raw_slice");
check(rawReads.some((call)=>call.args.length>plainName.spanEnd-plainName.spanStart),"source read was limited to the field");
reading().querySelector('[data-action="view-raw"]')?.click();
document.getElementById("semantic-tab").click();
await waitFor(()=>visibleReading().includes("Ada"),"reading did not return");
const viewRaw=[...reading().querySelectorAll('[data-action="view-raw"]')].find((button)=>button.dataset.fieldId==="2");
viewRaw.click();
await waitFor(()=>document.getElementById("field-detail").hidden===false&&document.getElementById("field-detail-title").textContent.includes("name"),"field detail is not titled with the field path");
const scopeAfterDetail=document.querySelector(".raw-scope")?.textContent??"";
check(scopeAfterDetail.includes(String(plainSource.length))||document.getElementById("raw-panel").hidden===true,"field detail replaced the main source range");
const alone=[...reading().querySelectorAll('[data-action="read-alone"]')].find((button)=>button.dataset.fieldId==="2");
alone.click();
await waitFor(()=>document.getElementById("reader-breadcrumb").innerText.includes("name")&&document.getElementById("locate-note").textContent.includes(zh?"阅读范围":"Reading range"),"read-alone did not change the visible range");
document.getElementById("reader-back").click();
await waitFor(()=>!document.getElementById("reader-breadcrumb").innerText.includes("$.name")&&visibleReading().includes("count"),"back did not restore the previous range and fields");
check(document.getElementById("field-detail-title").textContent.includes("name"),"back did not restore the focused field");
check(reading().querySelector('[data-field-id="2"]')?.getAttribute("aria-current")==="true","back did not restore selection");
const copyText=[...reading().querySelectorAll('[data-action="copy-default"]')].find((button)=>button.dataset.fieldId==="2");
copyText.click();
await waitFor(()=>calls.some((call)=>call.command==="copy_node"&&call.args.nodeId===2&&call.args.format==="decoded"),"copy text did not request decoded text");
await waitFor(()=>document.body.innerText.includes(zh?"复制了文本":"Copied text")&&document.body.innerText.includes("name"),"copy feedback did not name text and the path");
const copyRaw=[...reading().querySelectorAll('[data-action="copy-raw"]')].find((button)=>button.dataset.fieldId==="2");
copyRaw.click();
await waitFor(()=>calls.some((call)=>call.command==="copy_node"&&call.args.nodeId===2&&call.args.format==="raw"),"copy raw JSON did not request raw JSON");
await waitFor(()=>document.body.innerText.includes(zh?"原始 JSON":"raw JSON"),"copy feedback did not name raw JSON");
const big="9007199254740993";
const dupSource='{"id":1,"id":'+big+',"word":"caf\\\\u00e9"}';
const dupRoot=node(1,"object","$",0,dupSource.length,3);
const idA=node(2,"number","id",dupSource.indexOf('"id":1'),dupSource.indexOf('"id":1')+'"id":1'.length,0,"1");
const idB=node(3,"number","id#2",dupSource.indexOf('"id":'+big),dupSource.indexOf('"id":'+big)+('"id":'+big).length,0,big);
const word=node(4,"string","word",dupSource.indexOf('"word":'),dupSource.length-1,0,"café");
check(dupSource.includes('\\\\u00e9')&&JSON.parse(dupSource).word==="café"&&idA.spanEnd<idB.spanStart&&word.spanEnd<dupRoot.spanEnd,"escaped duplicate-key fixture is not source-backed");
await openDoc({path:"/tmp/exact.json",source:dupSource,summary:summary("/tmp/exact.json",dupSource.length,"document",dupRoot),children:childrenOf(1,[idA,idB,word]),longText:"x"});
await waitFor(()=>visibleReading().includes(big)&&visibleReading().includes("id#2")&&visibleReading().includes("café"),"lexical number, duplicate key, or decoded text was lost");
check(!visibleReading().includes("9.007"),"big integer was converted through a JS number");
const wordRaw=[...reading().querySelectorAll('[data-action="view-raw"]')].find((button)=>button.dataset.fieldId==="4");
wordRaw.click();
await waitFor(()=>document.getElementById("field-detail-raw").textContent.includes("\\\\u00e9"),"field raw JSON lost the lexical escape");
check(document.getElementById("field-detail-title").textContent.includes("word"),"escaped field detail lost its path");
const structureRoot=node(1,"object","$",0,120,1);
const structureItems=node(2,"array","items",1,110,1);
const structureItem=node(3,"object","[0]",2,100,1);
const structurePayload=node(4,"object","payload",3,90,2);
const structureFirst=node(5,"string","name",4,40,0,"first");
const structureDuplicate=node(6,"string","name#2",41,80,0,"second");
await openDoc({path:"/tmp/structure.json",source:"{}",summary:summary("/tmp/structure.json",120,"document",structureRoot),children:{...childrenOf(1,[structureItems]),...childrenOf(2,[structureItem]),...childrenOf(3,[structurePayload]),...childrenOf(4,[structureFirst,structureDuplicate])},longText:"x"});
document.getElementById("tree-tab").click();
for(const id of [1,2,3,4]){
  await waitFor(()=>document.querySelector('[data-node-id="'+id+'"] .tree-disclosure'),"structure ancestor missing: "+id);
  document.querySelector('[data-node-id="'+id+'"] .tree-disclosure').click();
}
await waitFor(()=>document.querySelector('[data-node-id="6"]'),"nested duplicate field did not load");
document.querySelector('[data-node-id="5"]').click();
await waitFor(()=>document.querySelector('[data-node-id="5"]')?.getAttribute("aria-selected")==="true","first duplicate did not select by NodeId");
check(document.getElementById("raw-panel").textContent.includes("$.items[0].payload.name"),"nested object/array path lost ancestors when selected in Structure");
document.querySelector('[data-node-id="6"]').click();
await waitFor(()=>document.querySelector('[data-node-id="6"]')?.getAttribute("aria-selected")==="true","second duplicate did not select by NodeId");
check(document.getElementById("raw-panel").textContent.includes("$.items[0].payload.name#2"),"duplicate field lost its exact Structure path");
document.getElementById("inspector-toggle").click();
await waitFor(()=>document.getElementById("field-detail").hidden===false&&document.getElementById("field-detail-title").textContent.includes("$.items[0].payload.name#2"),"Structure detail did not show the nested path");
document.getElementById("field-copy-raw").click();
await waitFor(()=>calls.some((call)=>call.command==="copy_node"&&call.args.nodeId===6&&call.args.format==="raw")&&document.getElementById("field-copy-status").textContent.includes("$.items[0].payload.name#2"),"Structure copy feedback lost the nested path or duplicate NodeId");
const collectionPathSource='[{"name":"Ada"}]';
const collectionPathItem=node(11,"object","[0]",1,collectionPathSource.length-1,1);
const collectionPathName=node(12,"string","name",2,collectionPathSource.length-2,0,"Ada");
await openDoc({path:"/tmp/collection.json",source:collectionPathSource,summary:summary("/tmp/collection.json",collectionPathSource.length,"collection",node(10,"array","$",0,collectionPathSource.length,1)),children:{...childrenOf(10,[collectionPathItem]),...childrenOf(11,[collectionPathName])},longText:"x"});
await waitFor(()=>document.querySelector('[data-item-ordinal="0"]'),"collection item missing for Structure path");
document.querySelector('[data-item-ordinal="0"]').click();
await waitFor(()=>visibleReading().includes("Ada"),"collection item did not open");
document.getElementById("tree-tab").click();
await waitFor(()=>document.querySelector('[data-node-id="11"] .tree-disclosure'),"collection item Tree root missing");
document.querySelector('[data-node-id="11"] .tree-disclosure').click();
await waitFor(()=>document.querySelector('[data-node-id="12"]'),"collection item child missing in Structure");
document.querySelector('[data-node-id="12"]').click();
await waitFor(()=>document.querySelector('[data-node-id="12"]')?.getAttribute("aria-selected")==="true","collection Structure child did not select");
check(document.getElementById("raw-panel").textContent.includes("$[0].name"),"collection Structure path lost its root prefix");
const msgSource='{"msg":"caf\\\\u00e9"}';
const msgRoot=node(1,"object","$",0,msgSource.length,1);
const msg=node(2,"string","msg",msgSource.indexOf('"msg":'),msgSource.length-1,0,"café");
check(msgSource.includes('\\\\u00e9')&&JSON.parse(msgSource).msg==="café"&&msg.spanEnd<msgRoot.spanEnd,"decoded-search fixture is not source-backed");
await openDoc({path:"/tmp/search.json",source:msgSource,summary:summary("/tmp/search.json",msgSource.length,"document",msgRoot),children:childrenOf(1,[msg]),searchPage:{matches:[{nodeId:2,field:"value",pathSegments:["$","msg"],pathTruncated:false,sourceSpanStart:msg.spanStart,sourceSpanEnd:msg.spanEnd,matchStart:2,matchEnd:3}],hasMore:false,nextCursor:null},longText:"x"});
await waitFor(()=>visibleReading().includes("café"),"search document did not render");
check(document.getElementById("scope-search-representation-decoded").checked,"new valid document did not default to readable search");
const query=document.getElementById("scope-search-query");
query.value="e";
document.getElementById("scope-search").requestSubmit();
await waitFor(()=>document.querySelector(".search-result-button"),"decoded search returned no hit: "+JSON.stringify({source:msgSource,sourceBytes:bytesOf(msgSource).length,scope:document.getElementById("find-scope-label").textContent,searchCalls:calls.filter((call)=>call.command==="search_current").slice(-1),searchPage:doc.searchPage}));
document.querySelector(".search-result-button").click();
await waitFor(()=>document.getElementById("locate-note").textContent.includes(zh?"整个字段":"whole field"),"decoded hit did not explain the whole-field fallback");
check(document.getElementById("semantic-panel").hidden===false,"decoded hit switched away from reading");
document.getElementById("raw-tab").click();
await waitFor(()=>document.querySelector("mark"),"source view did not locate the field");
const mark=document.querySelector("mark");
check(mark.dataset.sourceHighlight==="field","decoded hit painted a source-byte highlight");
check(mark.textContent!=="e","decoded match offsets were used as source bytes");
const deepSource='{"outer":{"inner":"needle"}}';
const deepRoot=node(1,"object","$",0,deepSource.length,1);
const deepOuter=node(2,"object","outer",1,deepSource.length-1,1);
const deepInner=node(3,"string","inner",deepSource.indexOf('"inner"'),deepSource.length-2,0,"needle");
await openDoc({path:"/tmp/deep-search.json",source:deepSource,summary:summary("/tmp/deep-search.json",deepSource.length,"document",deepRoot),children:{...childrenOf(1,[deepOuter]),...childrenOf(2,[deepInner])},searchPage:{matches:[{nodeId:3,field:"value",pathSegments:["$","outer","inner"],pathTruncated:false,sourceSpanStart:deepInner.spanStart,sourceSpanEnd:deepInner.spanEnd,matchStart:0,matchEnd:6}],hasMore:false,nextCursor:null},longText:"x"});
await waitFor(()=>reading().querySelector('[data-field-id="2"]'),"deep search parent was not loaded");
check(reading().querySelector('[data-field-id="3"]')===null,"deep field was already visible before reveal");
const deepQuery=document.getElementById("scope-search-query");
deepQuery.value="needle";
document.getElementById("scope-search").requestSubmit();
await waitFor(()=>document.querySelector(".search-result-button"),"deep decoded result did not render");
document.querySelector(".search-result-button").click();
await waitFor(()=>document.getElementById("raw-panel").hidden===false&&document.querySelector('mark[data-source-highlight="field"]'),"unloaded deep hit did not reveal its source field");
check(document.getElementById("locate-note").textContent.includes(zh?"整个字段":"whole field"),"deep decoded fallback did not explain source-field precision");
const navRoot=node(1,"object","$",0,10,0);
const navEntries=[entry(0,"valid",1,0,5),entry(1,"valid",2,6,10)];
await openDoc({path:"/tmp/scan.jsonl",source:"{}\\n{}",summary:summary("/tmp/scan.jsonl",10,"entry",null,{progress:progress(2,false,null),fileGeneration:9}),children:{},entries:navEntries,entryRoots:{0:navRoot,1:node(2,"object","$",0,4,0)},navProgress:{searchId:4,fileGeneration:9,scannedThrough:1,scannedCount:1,matchedCount:1,indexedCount:4,totalCount:null,complete:false,stopped:false,skippedInvalidJson:0,skippedInvalidUtf8:0,skippedOversized:0},navPage:{ordinals:[1],evidence:[{ordinal:1,path:"$.title",field:"value",snippet:"Later",matchStart:0,matchEnd:5}]},longText:"x"});
await waitFor(()=>document.getElementById("navigation-search-panel").hidden===false,"file search was not available");
document.querySelector('[data-entry-ordinal="0"]').click();
await waitFor(()=>calls.some((call)=>call.command==="select_entry"&&call.args.ordinal===0)&&document.querySelector('[data-entry-ordinal="0"]')?.getAttribute("aria-selected")==="true","JSONL record was not selected before widening Find");
const fileScope=document.getElementById("find-scope");
fileScope.value="file";
fileScope.dispatchEvent(new Event("change",{bubbles:true}));
const fileFind=document.getElementById("scope-search-query");
fileFind.value="Later";
const recordSearchesBefore=calls.filter((call)=>call.command==="search_current").length;
document.getElementById("scope-search").requestSubmit();
await waitFor(()=>calls.some((call)=>call.command==="start_navigation_search"&&call.args.fileGeneration===9&&call.args.query==="Later"),"JSONL This file Find did not start a file-level scan");
check(calls.filter((call)=>call.command==="search_current").length===recordSearchesBefore,"JSONL This file Find searched only the selected record");
await waitFor(()=>document.querySelector('[data-navigation-ordinal="1"]'),"This file Find did not show a hit in another record");
document.querySelector('[data-navigation-ordinal="1"]').click();
await waitFor(()=>calls.some((call)=>call.command==="select_entry"&&call.args.ordinal===1)&&document.getElementById("locate-note").textContent.includes(zh?"已进入第 2 条":"Entered record 2"),"This file Find did not explicitly enter the matching record");
document.getElementById("navigation-search-query").value="Later";
document.getElementById("navigation-search-form").requestSubmit();
await waitFor(()=>document.getElementById("navigation-search-status").textContent.includes(zh?"扫描未完成":"scan incomplete"),"in-progress file search did not say it was incomplete");
check(!document.getElementById("navigation-search-status").textContent.includes(zh?"未找到匹配项":"No matches found"),"unscanned range was reported as no results");
document.querySelector('input[name="navigation-search-display"][value="filtered"]').click();
await waitFor(()=>document.querySelector("[data-navigation-ordinal]"),"partial file-search hits were hidden");
document.getElementById("navigation-search-stop").click();
await waitFor(()=>document.getElementById("navigation-search-status").textContent.includes(zh?"停止":"Stopped"),"file search stop did not take effect");
document.querySelector("[data-navigation-ordinal]").click();
await waitFor(()=>document.getElementById("locate-note").textContent.includes(zh?"已进入第 2 条":"Entered record 2"),"a hit in another record did not say it entered that record");
await openDoc({path:"/tmp/changed.json",source:plainSource,summary:summary("/tmp/changed.json",plainSource.length,"document",plainRoot),children:childrenOf(1,[plainName,plainCount]),copyFails:true,longText:"x"});
await waitFor(()=>visibleReading().includes("Ada"),"changed-file document did not open");
reading().querySelector('[data-action="copy-default"]').click();
await waitFor(()=>document.getElementById("error-region").hidden===false&&document.getElementById("error-reload").disabled===false,"file change did not offer reload");
const readsBefore=calls.filter((call)=>call.command==="read_raw_slice").length;
document.getElementById("error-locate").click();
await settle();
check(document.getElementById("locate-note").textContent.includes(zh?"重新加载":"reload"),"stale locate was not blocked");
check(calls.filter((call)=>call.command==="read_raw_slice").length===readsBefore,"stale locate reused a source read");
const badUtf="hi\\u00ff!";
await openDoc({path:"/tmp/utf8.json",source:"hi\\u00ff!",summary:summary("/tmp/utf8.json",4,"document",null,{documentError:{code:"unsupported_encoding",message:"invalid utf-8"}}),children:{},longText:"x"});
await waitFor(()=>document.getElementById("raw-panel").hidden===false&&document.body.innerText.includes(zh?"有损":"lossy"),"invalid UTF-8 did not open on marked lossy source");
check([...document.querySelectorAll("button")].some((button)=>button.textContent.includes(zh?"十六进制":"Hex")),"hex view is not available");
check(!calls.some((call)=>/write|save|update_file|set_file/.test(call.command)),"invalid UTF-8 modified the file");
await openDoc({path:"/tmp/bad.json",source:"{",summary:summary("/tmp/bad.json",1,"document",null,{documentError:{code:"invalid_json",message:"invalid JSON",parseError:{message:"expected value",byteOffset:0,line:1,column:1}}}),children:{},longText:"x"});
await waitFor(()=>document.getElementById("raw-panel").hidden===false&&document.getElementById("error-reload")&&document.getElementById("error-view-source")&&document.getElementById("error-locate"),"unparseable JSON did not open on source with recovery");
check(document.body.innerText.includes(zh?"第 1 行":"Line 1"),"parse location was not shown");
await openDoc({path:"/tmp/eof.json",source:'{"a":',summary:summary("/tmp/eof.json",5,"document",null,{documentError:{code:"invalid_json",message:"invalid JSON",parseError:{message:"unexpected end of input",byteOffset:5,line:1,column:6}}}),children:{},longText:"x"});
await waitFor(()=>document.getElementById("raw-panel").hidden===false,"truncated JSON did not open its source");
document.getElementById("error-locate").click();
await waitFor(()=>document.getElementById("locate-note").textContent.includes(zh?"输入末尾":"end of input"),"EOF parse error was not identified as the missing next byte");
check(!document.querySelector('#raw-panel mark[data-source-highlight="bytes"]'),"EOF parse error highlighted a preceding source byte");
document.getElementById("text-size").value="lg";
document.getElementById("text-size").dispatchEvent(new Event("change",{bubbles:true}));
await waitFor(()=>document.documentElement.dataset.textSize==="lg","text size control did not change the document");
check(getComputedStyle(document.body).fontSize!=="13px","text size control did not change the reading font");
check(getComputedStyle(document.getElementById("inspector")).display==="none","field detail column is visible before it is requested");
document.getElementById("navigation-toggle").click();
await waitFor(()=>document.getElementById("app-shell").dataset.navigationOpen==="false","navigation did not collapse");
document.getElementById("navigation-toggle").click();
await waitFor(()=>document.getElementById("app-shell").dataset.navigationOpen==="true","navigation did not restore");
const names=()=>[...reading().querySelectorAll(".generic-field-name")];
await openDoc({path:"/tmp/plain.json",source:plainSource,summary:summary("/tmp/plain.json",plainSource.length,"document",plainRoot),children:childrenOf(1,[plainName,plainCount]),longText:"x",delayCandidate:false});
await waitFor(()=>names().length>1,"fields were not keyboard reachable");
const firstField=names()[0].dataset.fieldId;
names()[0].focus();
names()[0].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));
await waitFor(()=>document.activeElement&&document.activeElement.dataset&&document.activeElement.dataset.fieldId&&document.activeElement.dataset.fieldId!==firstField,"arrow key did not move between fields");
document.dispatchEvent(new KeyboardEvent("keydown",{key:"f",ctrlKey:true,bubbles:true}));
await waitFor(()=>document.activeElement===document.getElementById("scope-search-query"),"find shortcut did not focus search");
const historyA='{"group":{"first":"alpha","second":"bravo","long":"'+('word '.repeat(1600))+'"}}';
const historyB='{"group":{"first":"charlie"}}';
const historyEntries=[entry(0,"valid",1,0,historyA.length),entry(1,"valid",2,historyA.length+1,historyA.length+1+historyB.length)];
const historyRootA=node(31,"object","$",0,historyA.length,1);
const historyGroupA=node(32,"object","group",1,historyA.length-1,3);
const historyFirst=node(33,"string","first",10,25,0,"alpha");
const historySecond=node(34,"string","second",historyA.indexOf('"second"'),historyA.indexOf(',"long"'),0,"bravo");
const historyLong=node(35,"string","long",historyA.indexOf('"long"'),historyA.length-2,0,"word ".repeat(52).slice(0,256),true);
const historyRootB=node(41,"object","$",0,historyB.length,1);
const historyGroupB=node(42,"object","group",1,historyB.length-1,1);
const historyChildB=node(43,"string","first",10,historyB.length-2,0,"charlie");
await openDoc({path:"/tmp/history.jsonl",source:historyA+'\\n'+historyB,summary:summary("/tmp/history.jsonl",historyA.length+1+historyB.length,"entry",null,{progress:progress(2,true,2)}),children:{...childrenOf(31,[historyGroupA]),...childrenOf(32,[historyFirst,historySecond,historyLong]),...childrenOf(41,[historyGroupB]),...childrenOf(42,[historyChildB])},entries:historyEntries,entryRoots:{0:historyRootA,1:historyRootB},longText:"x"});
await waitFor(()=>visibleReading().includes("group")&&document.querySelector('[data-entry-ordinal="1"]'),"history records were not available");
reading().querySelector('[data-action="expand-node"]').click();
await waitFor(()=>visibleReading().includes("bravo"),"first record did not expand");
reading().querySelector('[data-field-id="34"]').click();
const historyScroll=document.getElementById("semantic-panel");
historyScroll.scrollTop=540;
check(historyScroll.scrollTop>0,"history fixture did not create a scrollable reading surface");
const savedHistoryScroll=historyScroll.scrollTop;
document.getElementById("raw-tab").click();
await waitFor(()=>document.getElementById("raw-panel").hidden===false,"source representation did not open");
document.querySelector('[data-entry-ordinal="1"]').click();
await waitFor(()=>document.getElementById("reader-breadcrumb").innerText.includes(zh?"第 2 条":"Record 2"),"second record did not open");
check(document.getElementById("raw-panel").hidden===false,"record selection lost source representation");
document.getElementById("reader-back").click();
await waitFor(()=>document.getElementById("reader-breadcrumb").innerText.includes(zh?"第 1 条":"Record 1")&&document.getElementById("raw-panel").hidden===false,"cross-record back did not restore range and representation");
document.getElementById("semantic-tab").click();
await waitFor(()=>visibleReading().includes("bravo")&&reading().querySelector('[data-field-id="34"]')?.getAttribute("aria-current")==="true","cross-record back lost expansion or focus");
const firstReload=calls.filter((call)=>call.command==="get_children"&&call.args.nodeId===32).length;
check(firstReload>=2,"history did not reload expanded fields after leaving the record");
await waitFor(()=>Math.abs(historyScroll.scrollTop-savedHistoryScroll)<3,"cross-record back lost the reading scroll position: "+JSON.stringify({saved:savedHistoryScroll,actual:historyScroll.scrollTop,height:historyScroll.scrollHeight,client:historyScroll.clientHeight}));
const restoredField=reading().querySelector('[data-field-id="34"]');
check(restoredField?.getAttribute("aria-current")==="true"&&document.activeElement===restoredField,"cross-record back did not restore keyboard focus to the selected field");
document.getElementById("reader-forward").click();
await waitFor(()=>document.getElementById("reader-breadcrumb").innerText.includes(zh?"第 2 条":"Record 2"),"cross-record forward did not restore the second range");
check(document.getElementById("raw-panel").hidden===false,"cross-record forward did not restore the source representation");
doc.failSelectOrdinal=0;
document.getElementById("reader-back").click();
await waitFor(()=>calls.some((call)=>call.command==="select_entry"&&call.args.ordinal===0)&&document.getElementById("reader-back").disabled===false,"failed history selection left navigation disabled");
check(document.getElementById("reader-breadcrumb").innerText.includes(zh?"第 2 条":"Record 2"),"failed history selection changed the current range");
document.getElementById("reader-back").click();
await waitFor(()=>document.getElementById("reader-breadcrumb").innerText.includes(zh?"第 1 条":"Record 1"),"failed history selection could not be retried");
const collectionItems=Array.from({length:1000},(_,index)=>'{"n":'+index+'}');
const collectionSource='['+collectionItems.join(',')+']';
const collectionNodes=[];
let collectionOffset=1;
for(let index=0;index<collectionItems.length;index+=1){
  collectionNodes.push(node(5000+index,"object","["+index+"]",collectionOffset,collectionOffset+collectionItems[index].length,1));
  collectionOffset+=collectionItems[index].length+1;
}
const collectionChildren={1:collectionNodes};
for(let index of [0,600,800]){
  const item=collectionNodes[index];
  collectionChildren[item.id]=[node(7000+index,"number","n",item.spanStart+1,item.spanEnd-1,0,String(index))];
}
const collectionRoot=node(1,"array","$",0,collectionSource.length,collectionNodes.length);
await openDoc({path:"/tmp/history-collection.json",source:collectionSource,summary:summary("/tmp/history-collection.json",collectionSource.length,"collection",collectionRoot),children:{},pagedChildren:collectionChildren,longText:"x"});
await waitFor(()=>document.querySelector('[data-item-ordinal="0"]'),"collection page did not load");
document.querySelector('[data-item-ordinal="0"]').click();
await waitFor(()=>visibleReading().includes("[0]")&&document.getElementById("collection-root").getAttribute("aria-pressed")==="false","first collection item did not open");
await waitFor(()=>reading().querySelector('[data-field-id="7000"]'),"first collection item value did not load");
reading().querySelector('[data-field-id="7000"]').click();
document.getElementById("raw-tab").click();
await waitFor(()=>document.getElementById("raw-panel").hidden===false,"first item source view did not open");
const collectionGo=async(index)=>{
  document.getElementById("collection-go-input").value=String(index);
  document.getElementById("collection-go-button").click();
  await waitFor(()=>document.querySelector('[data-item-ordinal="'+index+'"]'),"collection page did not load item "+index);
  document.querySelector('[data-item-ordinal="'+index+'"]').click();
  await waitFor(()=>visibleReading().includes('n')&&document.querySelector('[data-item-ordinal="'+index+'"]')?.getAttribute("aria-selected")==="true","collection item did not open "+index);
};
await collectionGo(600);
await collectionGo(800);
const pageZeroReads=calls.filter((call)=>call.command==="get_children"&&call.args.nodeId===1&&call.args.cursor===0).length;
document.getElementById("reader-back").click();
await waitFor(()=>document.querySelector('[data-item-ordinal="600"]')?.getAttribute("aria-selected")==="true","back did not restore collection item 600");
document.getElementById("reader-back").click();
await waitFor(()=>document.querySelector('[data-item-ordinal="0"]')?.getAttribute("aria-selected")==="true"&&document.getElementById("raw-panel").hidden===false,"back did not reload evicted item with source representation");
document.getElementById("semantic-tab").click();
await waitFor(()=>document.getElementById("generic-reader").innerText.includes("[0]")&&reading().querySelector('[data-field-id="7000"]')?.getAttribute("aria-current")==="true","evicted item did not restore its focused field");
check(calls.filter((call)=>call.command==="get_children"&&call.args.nodeId===1&&call.args.cursor===0).length>pageZeroReads,"evicted collection page was not fetched again");
document.getElementById("collection-root").click();
await waitFor(()=>document.getElementById("collection-root").getAttribute("aria-pressed")==="true"&&visibleReading().includes(zh?"根数组":"Root array"),"collection root did not open");
document.getElementById("reader-back").click();
await waitFor(()=>document.querySelector('[data-item-ordinal="0"]')?.getAttribute("aria-selected")==="true"&&reading().querySelector('[data-field-id="7000"]')?.getAttribute("aria-current")==="true","back from collection root did not restore item focus");
const delayedRoot=node(1,"object","$",0,40,1);
const delayedMessages=node(10,"array","messages",2,30,1,"user");
await openDoc({path:"/tmp/late.json",source:"{}",summary:summary("/tmp/late.json",40,"document",delayedRoot),children:childrenOf(1,[delayedMessages]),candidates:[candidateDto(10,2,30,1,"generic",1,0,40,1)],blocksFor:()=>({blocks:[messageBlock("user",11,4,20)],hasMore:false,nextCursor:null,wrapperRef:wrapper(1,0,40,10,2,30)}),delayCandidate:true,longText:"x"});
await waitFor(()=>visibleReading().includes("messages"),"late document was not readable before recognition");
document.getElementById("raw-tab").click();
await waitFor(()=>document.getElementById("raw-panel").hidden===false,"source tab did not activate before recognition");
releaseCandidate();
await settle();await new Promise((resolve)=>setTimeout(resolve,60));
check(document.getElementById("raw-panel").hidden===false&&document.getElementById("semantic-panel").hidden===true,"background recognition switched off source text");
await waitFor(()=>document.getElementById("conversation-offer").hidden===false,"recognition did not offer a switch");
document.getElementById("conversation-offer").click();
await waitFor(()=>document.getElementById("semantic-panel").hidden===false,"offered switch did not open reading");
check(scopeBefore!==undefined,"scope baseline was lost");
return {pass:true,assertions};
})()`;
}

const port = await freePort();
try {
  // Pre-bundle dependencies so a mid-test discovery reload cannot abort the run.
  await execFileAsync(process.execPath, [viteBin, "optimize"], { cwd: root, env: browserEnv });
} catch (error) {
  console.log(`vite optimize skipped: ${error instanceof Error ? error.message : String(error)}`);
}
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += chunk.toString(); });
vite.stderr.on("data", (chunk) => { viteOutput += chunk.toString(); });

try {
  await waitForPort(port, vite);
  const languages = launchOnly ? [["lang=en-US", "en"]] : [["lang=en-US", "en"], ["lang=zh-CN", "zh-CN"]];
  for (const [query, language] of languages) {
    await browser(["open", `http://127.0.0.1:${port}/scripts/test-app-fixture.html?${query}`]);
    const raw = await browser(["eval", "-b", Buffer.from(browserTest(language, launchOnly)).toString("base64")]);
    const result = parseBrowserValue(raw);
    check(result.pass === true, `UX redesign UI test did not pass for ${language}.`);
    console.log(`ux-redesign-ui ${language} PASS (${result.assertions} assertions)${launchOnly ? " launch" : ""}`);
  }
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
