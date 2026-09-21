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
const session = "sjv-tree-virtualization-ui-" + process.pid;

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
  }).catch((error) => { throw new Error(error.stderr || error.message); });
  return result.stdout.trim();
}

function browserTest() {
  return [
    "(async()=>{",
    "const {TreeView}=await import('/src/tree-view.ts');",
    "let assertions=0;",
    "const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};",
    "const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};",
    "const node=(id,kind='number',label=String(id),childCount=0)=>({id,kind,spanStart:id,spanEnd:id+1,label,labelHasMore:false,valuePreview:kind==='number'?String(id):null,valueHasMore:false,childCount});",
    "const hostFor=(height)=>{const host=document.createElement('div');host.style.height=height+'px';host.style.overflow='auto';const panel=document.createElement('section');panel.style.height='100%';const tab=document.createElement('button');host.append(panel,tab);document.body.append(host);return {host,panel,tab};};",
    "const fixture=hostFor(140);",
    "const root=node(1,'array','$',600);",
    "const calls=[];",
    "const page=(cursor)=>{const count=Math.min(200,600-cursor);return {nodes:Array.from({length:count},(_,index)=>node(10+cursor+index,'number','['+(cursor+index)+']')),hasMore:cursor+count<600,nextCursor:cursor+count<600?cursor+count:null};};",
    "const tree=new TreeView({panel:fixture.panel,viewport:fixture.host,tab:fixture.tab,inspector:null,fields:null,onSelection:()=>{},onStringSelection:()=>{},onStringOpen:()=>{},onError:(error)=>{throw error;},invoke:async(command,args)=>{calls.push({command,args});if(command==='get_node_summary')return args.nodeId===9000?node(9000,'string','uncached'):node(args.nodeId,'number','['+(args.nodeId-10)+']');if(command!=='get_children')throw new Error('unexpected Tree command');return page(args.cursor);}});",
    "tree.setSession({mode:'document',sessionRevision:1,scopeId:null,sourceSize:100000,ariaLabel:'JSON structure'},root);",
    "await settle();",
    "fixture.panel.querySelector('.tree-disclosure').click();",
    "await settle();await settle();",
    "const visibleLimit=Math.ceil(fixture.host.clientHeight/35)+22;",
    "check(fixture.panel.querySelectorAll('[role=treeitem]').length<=visibleLimit,'first child page exceeded virtual DOM bound');",
    "check(tree.snapshot().records.length===201,'first child page was not retained in records');",
    "check(calls.length===1&&calls[0].args.cursor===0,'initial page cursor was not zero');",
    "const beforeScrollCalls=calls.length;",
    "fixture.host.scrollTop=fixture.host.scrollHeight;fixture.host.dispatchEvent(new Event('scroll'));await settle();",
    "check(calls.length===beforeScrollCalls,'ordinary scroll issued get_children');",
    "check(fixture.panel.querySelectorAll('[role=treeitem]').length<=visibleLimit,'scrolled DOM exceeded viewport plus overscan');",
    "const load=fixture.panel.querySelector('[data-load-parent=\\'1\\']');",
    "check(load!==null,'partial children did not expose a load row');",
    "load.click();await settle();await settle();",
    "check(calls.length===2&&calls[1].args.cursor===200,'load row did not request cursor 200');",
    "check(tree.snapshot().records.length===401,'load row did not preserve loaded records');",
    "check(Array.from(fixture.panel.querySelectorAll('[aria-level=\\'2\\']')).filter((item)=>item.dataset.nodeId).every((item)=>item.getAttribute('aria-setsize')==='600'),'child aria-setsize did not expose real childCount');",
    "fixture.host.scrollTop=0;fixture.host.dispatchEvent(new Event('scroll'));await settle();fixture.panel.querySelector('[data-node-id=\\'1\\'] .tree-disclosure').click();await settle();",
    "check(fixture.panel.querySelectorAll('[data-node-id]').length===1,'collapse did not hide logical descendants');",
    "fixture.panel.querySelector('[data-node-id=\\'1\\'] .tree-disclosure').click();await settle();",
    "check(calls.length===2&&tree.snapshot().records.length===401,'re-expanding loaded children fetched or discarded records');",
    "fixture.host.scrollTop=3500;fixture.host.dispatchEvent(new Event('scroll'));await settle();const midRow=fixture.panel.querySelector('[data-node-id=\\'100\\']');const midScroll=fixture.host.scrollTop;check(midRow!==null,'middle logical row was not mounted');midRow.click();await settle();check(Math.abs(fixture.host.scrollTop-midScroll)<=1,'selecting a middle virtual row jumped the viewport');",
    "fixture.host.scrollTop=1000;fixture.host.dispatchEvent(new Event('scroll'));await settle();",
    "const cachedCalls=calls.length;",
    "check(await tree.focusNode(210,210,211),'cached focusNode failed');await settle();",
    "check(calls.length===cachedCalls&&fixture.panel.querySelector('[data-return-scope-tree]')===null,'cached focusNode narrowed or requested a summary');",
    "check(fixture.panel.querySelector('[data-node-id=\\'210\\']')?.getAttribute('aria-selected')==='true','cached focusNode did not select target');",
    "fixture.host.scrollTop=0;fixture.host.dispatchEvent(new Event('scroll'));await settle();const activeCached=fixture.panel.querySelector('[data-node-id=\\'22\\']');check(activeCached!==null,'resize target row was not mounted');activeCached.focus();const resizeScroll=fixture.host.scrollTop;fixture.host.style.height='35px';await settle();await settle();",
    "await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const resizedRoot=fixture.panel.querySelector('.tree-root');check(document.activeElement===resizedRoot&&resizedRoot?.tabIndex===0&&fixture.host.scrollTop===resizeScroll,'resize-only unmounted focus did not transfer focus to a tabbable Tree root or changed scroll');",
    "resizedRoot?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await settle();check(document.activeElement?.dataset.nodeId==='211','Tree-root keyboard fallback did not continue from the retained logical focus key');",
    "fixture.host.style.height='140px';fixture.host.scrollTop=0;fixture.host.dispatchEvent(new Event('scroll'));await settle();const outside=document.createElement('button');document.body.append(outside);outside.focus();check(fixture.panel.querySelector('.tree-root')?.tabIndex===0,'offscreen logical focus did not leave a Tree root tab stop');outside.remove();",
    "const savedScroll=fixture.host.scrollTop;",
    "check(await tree.focusNode(9000,9000,9001),'uncached focusNode failed');",
    "check(fixture.panel.querySelector('[data-return-scope-tree]')!==null,'uncached focusNode did not expose return action');",
    "check(calls.filter((call)=>call.command==='get_node_summary').length===1,'uncached focusNode did not use one summary request');",
    "fixture.panel.querySelector('[data-return-scope-tree]').click();await settle();await settle();",
    "check(tree.snapshot().rootId===1&&tree.snapshot().records.some((record)=>record.id===1),'narrow return did not restore parent root records');",
    "check(Math.abs(fixture.host.scrollTop-savedScroll)<=1,'narrow return did not restore parent scroll');",
    "fixture.host.scrollTop=5000;fixture.host.dispatchEvent(new Event('scroll'));await settle();const largeSnapshot=tree.snapshot();check(largeSnapshot.scrollTop===5000&&largeSnapshot.records.length===401,'large parent snapshot did not retain the loaded scroll state');tree.setSession({mode:'document',sessionRevision:9,scopeId:null,sourceSize:100,ariaLabel:'small'},node(900,'object','$',0));await settle();check(fixture.host.scrollTop===0,'small replacement did not reset its scroll state');tree.restore(largeSnapshot);await settle();check(fixture.host.scrollTop===5000&&tree.snapshot().records.length===401,'restoring the large parent after a small tree lost its scroll position');",
    "const retryFixture=hostFor(140);let attempts=0;",
    "const retryTree=new TreeView({panel:retryFixture.panel,viewport:retryFixture.host,tab:retryFixture.tab,inspector:null,fields:null,onSelection:()=>{},onStringSelection:()=>{},onStringOpen:()=>{},onError:(error)=>{throw error;},invoke:async(command)=>{if(command!=='get_children')throw new Error('unexpected retry command');attempts+=1;if(attempts===1)throw new Error('retry');return {nodes:[node(2)],hasMore:false,nextCursor:null};}});",
    "retryTree.setSession({mode:'document',sessionRevision:2,scopeId:null,sourceSize:100,ariaLabel:'Retry'},node(1,'object','$',1));",
    "retryFixture.panel.querySelector('.tree-disclosure').click();await settle();await settle();",
    "const retry=retryFixture.panel.querySelector('[data-retry-parent=\\'1\\']');",
    "check(retry!==null&&retry.dataset.nodeId===undefined&&retry.getAttribute('aria-setsize')==='1','retry row fabricated NodeId or wrong setsize');",
    "retry.focus();retry.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await settle();await settle();",
    "check(attempts===2&&retryFixture.panel.querySelector('[data-node-id=\\'2\\']')!==null,'retry keyboard action did not reload children');",
    "const nestedFixture=hostFor(120);",
    "const nestedTree=new TreeView({panel:nestedFixture.panel,viewport:nestedFixture.host,tab:nestedFixture.tab,inspector:null,fields:null,onSelection:()=>{},onStringSelection:()=>{},onStringOpen:()=>{},onError:(error)=>{throw error;},invoke:async(command,args)=>command==='get_children'?{nodes:[node(2)],hasMore:false,nextCursor:null}:command==='get_node_summary'?node(args.nodeId):Promise.reject(new Error('unexpected nested command'))});",
    "nestedTree.setSession({mode:'nested',sessionRevision:3,scopeId:7,sourceSize:100,ariaLabel:'Nested'},node(1,'object','$',1));",
    "nestedFixture.panel.querySelector('.tree-disclosure').click();await settle();await settle();",
    "nestedFixture.host.scrollTop=35;const snapshot=nestedTree.snapshot();check(snapshot.scrollTop===35,'snapshot did not record outer scroll');nestedFixture.host.scrollTop=0;nestedTree.restore(snapshot);await settle();",
    "check(nestedFixture.host.scrollTop===35,'restore did not restore outer scroll after rebuild');",
    "const staleFixture=hostFor(120);let release;",
    "const staleTree=new TreeView({panel:staleFixture.panel,viewport:staleFixture.host,tab:staleFixture.tab,inspector:null,fields:null,onSelection:()=>{},onStringSelection:()=>{},onStringOpen:()=>{},onError:(error)=>{throw error;},invoke:async(command)=>command==='get_children'?new Promise((resolve)=>{release=resolve;}):Promise.reject(new Error('unexpected stale command'))});",
    "staleTree.setSession({mode:'document',sessionRevision:4,scopeId:null,sourceSize:100,ariaLabel:'stale'},node(1,'object','$',1));staleFixture.panel.querySelector('.tree-disclosure').click();await settle();",
    "staleTree.setSession({mode:'document',sessionRevision:5,scopeId:null,sourceSize:100,ariaLabel:'fresh'},node(50,'object','$',0));release?.({nodes:[node(2)],hasMore:false,nextCursor:null});await settle();",
    "check(staleFixture.panel.querySelector('[data-node-id=\\'2\\']')===null&&staleFixture.panel.querySelector('[data-node-id=\\'50\\']')!==null,'late stale response mutated fresh Tree');",
    "const {ProjectionBudget}=await import('/src/projection-budget.ts');",
    "const budget=new ProjectionBudget(1024);const budgetFixture=hostFor(140);const previewReads=[];",
    "const previewNode=(id)=>({...node(id,'string','['+(id-10)+']'),valuePreview:'value-'+id+'x'.repeat(150)});",
    "let delayedPreview=null;let delayPreviews=false;",
    "const budgetTree=new TreeView({panel:budgetFixture.panel,viewport:budgetFixture.host,tab:budgetFixture.tab,projectionBudget:budget,inspector:null,fields:null,onSelection:()=>{},onStringSelection:()=>{},onStringOpen:()=>{},onError:(error)=>{throw error;},invoke:async(command,args)=>{if(command==='get_children')return {nodes:Array.from({length:200},(_,i)=>previewNode(10+i)),hasMore:false,nextCursor:null};if(command==='get_node_summary'){previewReads.push(args.nodeId);if(delayPreviews)return new Promise(resolve=>{delayedPreview=()=>resolve(previewNode(args.nodeId));});return previewNode(args.nodeId);}throw new Error('unexpected budget command');}});",
    "budgetTree.setSession({mode:'document',sessionRevision:80,scopeId:null,sourceSize:100000,ariaLabel:'Budget'},node(1,'array','$',200));budgetFixture.panel.querySelector('.tree-disclosure').click();await settle();await settle();",
    "check(budgetTree.memoryUsage.cachedValueBytes<=1024&&budgetTree.memoryUsage.cachedValueBytes>0,'Tree values were not accounted within the shared cache budget');",
    "check(budgetTree.memoryUsage.navigationBytes>0&&budgetTree.memoryUsage.activeValueBytes>0,'Tree did not separately account active values and navigation');",
    "const budgetSnapshot=budgetTree.snapshot();check(budgetSnapshot.records.every(record=>record.node.valuePreview===null),'Tree snapshot retained cached value bodies');",
    "budgetFixture.host.scrollTop=3500;budgetFixture.host.dispatchEvent(new Event('scroll'));await settle();await settle();check(previewReads.length>0&&budget.usedBytes<=1024,'Scrolling did not reread evicted values within budget');",
    "await budgetTree.focusNode(100,100,101);await settle();check(budgetFixture.panel.querySelector('[data-node-id=\\'100\\'] .tree-value')?.textContent===previewNode(100).valuePreview&&budgetTree.snapshot().selectedId===100,'Evicted value selection lost content or NodeId');",
    "budgetTree.setSession({mode:'document',sessionRevision:81,scopeId:null,sourceSize:100000,ariaLabel:'Small'},node(2,'object','$'));budgetTree.restore(budgetSnapshot);await settle();await settle();check(budgetTree.snapshot().records.length===201&&budgetTree.snapshot().records[0].expanded&&budgetFixture.panel.querySelector('[data-node-id=\\'10\\'] .tree-value')?.textContent===previewNode(10).valuePreview,'Restoring navigation snapshot lost expanded children or failed to reread visible values');",
    "const external={};budgetFixture.panel.hidden=true;budgetTree.renderWindow();check(budgetTree.memoryUsage.activeValueBytes===0,'Hidden Tree retained active value bodies');budget.admit(external,1024,()=>{});check(budgetTree.memoryUsage.cachedValueBytes===0&&!budgetFixture.panel.textContent.includes('value-'),'External pressure left hidden Tree value bodies in records or DOM');",
    "budgetTree.clear();check(budget.usedBytes===1024,'Clearing Tree released another consumer cache');budget.release(external);check(budget.usedBytes===0,'Clearing Tree did not release cache ledger entries');",
    "budgetFixture.panel.hidden=false;budgetTree.restore(budgetSnapshot);await settle();await settle();delayPreviews=true;budgetFixture.host.scrollTop=3500;budgetFixture.host.dispatchEvent(new Event('scroll'));await settle();check(delayedPreview!==null,'Stale-value test did not issue a preview read');budgetTree.setSession({mode:'document',sessionRevision:82,scopeId:null,sourceSize:100000,ariaLabel:'Fresh'},node(2,'object','$'));delayedPreview();await settle();check(budgetTree.snapshot().rootId===2&&budget.usedBytes===0&&!budgetFixture.panel.textContent.includes('value-'),'Late value response repopulated the replacement Tree or budget');budgetTree.clear();",
    "delayPreviews=false;const normalInvoke=budgetTree.invokeRequest;budgetTree.invokeRequest=async(command,args)=>{if(command==='get_node_summary'&&args.nodeId===10)throw new Error('preview unavailable');return normalInvoke(command,args);};budgetTree.restore(budgetSnapshot);await settle();await settle();check(budgetFixture.panel.querySelector('[data-node-id=\\'10\\'] .tree-value')?.textContent==='preview unavailable','Failed value reload was not visible and retryable');budgetTree.invokeRequest=normalInvoke;budgetFixture.panel.querySelector('[data-node-id=\\'10\\']').click();await settle();await settle();check(budgetFixture.panel.querySelector('[data-node-id=\\'10\\'] .tree-value')?.textContent===previewNode(10).valuePreview,'Retry did not restore the failed value preview');budgetTree.clear();check(budgetTree.memoryUsage.navigationBytes===0&&budgetTree.memoryUsage.activeValueBytes===0&&budget.usedBytes===0,'Tree clear retained navigation or active/cache bodies');",
    "return {pass:true,assertions,visibleLimit};",
    "})()"
  ].join("\n");
}

const port = await freePort();
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += chunk.toString(); });
vite.stderr.on("data", (chunk) => { viteOutput += chunk.toString(); });

try {
  await waitForPort(port, vite);
  await browser(["open", "http://127.0.0.1:" + port + "/scripts/test-app-fixture.html"]);
  const result = JSON.parse(await browser(["eval", "-b", Buffer.from(browserTest()).toString("base64")]));
  if (!result.pass) throw new Error("Tree virtualization UI test did not pass.");
  console.log("tree-virtualization-ui PASS (" + result.assertions + " assertions; DOM simulation, not Native acceptance)");
} catch (error) {
  throw new Error((error instanceof Error ? error.message : String(error)) + "\n" + viteOutput.slice(-4000));
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
