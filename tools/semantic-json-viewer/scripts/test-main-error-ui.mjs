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
const session = `sjv-main-error-ui-${process.pid}`;

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

function parseBrowserValue(output) {
  try { return JSON.parse(output); } catch {
    const start = output.lastIndexOf("{");
    if (start >= 0) return JSON.parse(output.slice(start));
    throw new Error(`Browser returned non-JSON output: ${output}`);
  }
}

function browserTest(expectedLanguage) {
  return `(async()=>{
const expectedLanguage=${JSON.stringify(expectedLanguage)};
let mode="open_failed";
let assertions=0;
let openCalls=0;
const check=(condition,message)=>{assertions+=1;if(!condition)throw new Error(message);};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await new Promise((resolve)=>setTimeout(resolve,0));};
const waitFor=async(predicate,message)=>{for(let attempt=0;attempt<80;attempt+=1){await settle();if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,25));}throw new Error(message);};
await waitFor(()=>document.documentElement.dataset.testAppReady==="true"&&document.documentElement.lang===expectedLanguage,"main fixture did not reach the expected ready locale");
const rawSummary={path:"/tmp/main-error.json",size:20,mode:"document",root:null,progress:null,manyInvalidUtf8Warning:false,documentError:{code:"invalid_json",message:"invalid JSON",parseError:{code:"expected_object_key",message:"raw parser detail",byteOffset:4,line:1,column:5}},sessionRevision:1};
window.__TAURI_INTERNALS__={invoke:async(command)=>{
  if(command==="plugin:dialog|open")return "/tmp/main-error.json";
  if(command!=="open_file")throw new Error("unexpected IPC command "+command);
  openCalls+=1;
  if(mode==="invalid_json")return rawSummary;
  if(mode==="open_failed")throw {code:"open_failed",message:"permission denied: /tmp/private.json"};
  if(mode==="unsupported_format")throw {code:"unsupported_format",message:"extension .yaml is not supported"};
  if(mode==="file_changed")throw {code:"file_changed",message:"file changed on disk: /tmp/live.json"};
  throw {code:"mystery_code",message:"backend sentinel /tmp/unknown diagnostic"};
}};
const errorRegion=document.getElementById("error-region");
const title=document.getElementById("error-title");
const message=document.getElementById("error-message");
const details=document.getElementById("error-details");
const openFile=async(expectedMessage)=>{
  const before=openCalls;
  document.getElementById("open-file").click();
  await waitFor(()=>openCalls>before&&!errorRegion.hidden&&message.textContent.includes(expectedMessage),"main error did not settle for "+mode);
};
check(document.documentElement.lang===expectedLanguage,"fixture locale was not initialized by main");
await openFile("permission denied");
if(expectedLanguage==="zh-CN"){
  check(title.textContent==="打开失败","Chinese open_failed title was not localized");
  check(details.textContent.includes("请检查")&&details.textContent.includes("permission denied"),"Chinese open_failed guidance lost diagnostic");
  mode="unsupported_format";await openFile(".yaml");
  check(title.textContent==="不支持的格式"&&details.textContent.includes("请选择"),"Chinese unsupported_format guidance was not localized");
  mode="file_changed";await openFile("file changed on disk");
  check(title.textContent.includes("更改")&&details.textContent.includes("file changed on disk"),"Chinese file_changed diagnostic was not preserved");
  mode="unknown";await openFile("backend sentinel");
  check(title.textContent==="打开失败"&&message.textContent.includes("backend sentinel")&&details.textContent==="","unknown code changed or hid its diagnostic");
  mode="__proto__";await openFile("backend sentinel");
  check(title.textContent==="打开失败"&&message.textContent.includes("backend sentinel"),"prototype-named unknown code bypassed title fallback");
  mode="invalid_json";await openFile("invalid JSON");
  check(title.textContent==="无效 JSON"&&details.textContent.includes("第 1 行")&&details.textContent.includes("应为对象键"),"Chinese invalid_json parse formatter was not retained");
}else{
  check(title.textContent==="Open failed"&&details.textContent.includes("Check the file path")&&details.textContent.includes("permission denied"),"English open_failed contract changed");
  mode="unsupported_format";await openFile(".yaml");
  check(title.textContent==="Unsupported format"&&details.textContent.includes("Choose a JSON"),"English unsupported_format guidance was not rendered");
  mode="invalid_json";await openFile("invalid JSON");
  check(title.textContent==="Invalid JSON"&&details.textContent.includes("Line 1")&&details.textContent.includes("expected object key"),"English invalid_json parse formatter was not retained");
}
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
  for (const [query, language] of [["lang=en-US", "en"], ["lang=zh-CN", "zh-CN"]]) {
    await browser(["open", `http://127.0.0.1:${port}/scripts/test-app-fixture.html?${query}`]);
    const result = parseBrowserValue(await browser(["eval", "-b", Buffer.from(browserTest(language)).toString("base64")]));
    if (!result.pass) throw new Error(`Main error UI test did not pass for ${language}.`);
    console.log(`main-error-ui ${language} PASS (${result.assertions} assertions)`);
  }
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${viteOutput.slice(-4000)}`);
} finally {
  await browser(["close"]).catch(() => {});
  vite.kill("SIGTERM");
}
