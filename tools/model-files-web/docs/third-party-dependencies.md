# 第三方依赖与许可

审计日期：2026-08-22。版本与完整依赖图以 `package-lock.json` 为准；`npm ci` 是唯一发布安装方式。

## 直接依赖

| 依赖 | 版本 | 用途 | 许可 |
| --- | --- | --- | --- |
| `@huggingface/jinja` | 0.5.9 | 浏览器 Jinja 运行时 | MIT |
| `@huggingface/tokenizers` | 0.1.3 | 浏览器 tokenizer 运行时 | Apache-2.0 |
| `react` | 19.2.8 | UI | MIT |
| `react-dom` | 19.2.8 | DOM 渲染 | MIT |
| `react-markdown` | 10.1.0 | 安全 Markdown 渲染 | MIT |
| `remark-gfm` | 4.0.1 | GFM 表格、删除线、任务列表 | MIT |
| `prismjs` | 1.30.0 | 安全语法 tokenization/highlighting | MIT |
| `@playwright/test` | 1.62.1 | 浏览器验收（开发） | Apache-2.0 |
| `@types/prismjs` | 1.26.6 | 类型（开发） | MIT |
| `@types/node` | 26.2.0 | 类型（开发） | MIT |
| `@types/react` | 19.2.18 | 类型（开发） | MIT |
| `@types/react-dom` | 19.2.4 | 类型（开发） | MIT |
| `@vitejs/plugin-react` | 6.0.5 | 构建（开发） | MIT |
| `typescript` | 7.0.2 | 类型检查（开发） | Apache-2.0 |
| `vite` | 8.2.1 | 构建与开发服务（开发） | MIT |

## Lockfile 传递依赖

`package-lock.json` 当前锁定 177 个第三方包/平台变体，全部声明 SPDX 许可，没有 `UNDECLARED` 条目：

- MIT：136。
- Apache-2.0：26。
- MPL-2.0：12。
- ISC：2。
- BSD-3-Clause：1。

复核命令：

```bash
node -e 'const j=require("./package-lock.json"); for(const [p,x] of Object.entries(j.packages)) if(p&&x.version) console.log(p.slice(13),x.version,x.license)'
```

应用运行时产物包含 React、React DOM、Markdown/GFM、Prism、Jinja、`@huggingface/tokenizers` 及构建器生成代码；Playwright、TypeScript、Vite 与平台绑定不随静态产物发布。历史快照（2026-08-22）：main 409.93 kB（gzip 125.01 kB）、CSS 20.57 kB（gzip 4.94 kB）、source-highlight Worker 67.90 kB（本地 gzip 为 22.75 kB）、tokenizer/Jinja worker 79.06 kB；相较接入 Prism 前的 reader 基线（main 409.08 kB、gzip 124.69 kB，CSS 19.77 kB、gzip 4.72 kB），main bootstrap/renderer 增加 0.85 kB（gzip 0.32 kB），CSS 增加 0.80 kB（gzip 0.22 kB），并新增 Prism source-highlight Worker 67.90 kB（gzip 22.75 kB）。相较 v0.1 的 main 214.67 KiB、worker 29.53 KiB，增量对应 Markdown、Jinja 与已验收的阅读能力。该历史快照中的 T20 数据为 100k 行入口和 10k token Chromium 门分别低于 3 秒和 1.3 秒；32 KiB pathological SCSS 主线程 RED 为 6,867 ms，Worker 三浏览器门低于 1,000 ms，离线 E2E 当时通过 46 项、有意跳过 11 项。

2026-08-22 新增依赖审计：官方 `prismjs@1.30.0` tarball SHA-256 为 `ac16a9106a28c53b6a6313993c816a3a02525fdfefd7614fc1703df915a9fc11`，lockfile integrity 为 `sha512-DEvV2ZF2r2/63V+tK8hQvrR2ZGn10srHbXviTlcv7Kpzw8jWiNTqbVgjO3IY8RxrrOUF8VPMQQFysYYYv0YZxw==`；该包没有 install script 或运行时依赖，官方 npm audit 报告 0 个漏洞。source-highlight Worker 仅导入 prism-core 与显式语言组件，调用 `Prism.tokenize` 后发送扁平文本/class 分段，React 渲染节点而不使用 innerHTML；Worker 启动时禁用 Prism 自带消息处理器，文件切换或卸载时终止 Worker。最终 Worker bundle 含 Prism core 的通用 `innerHTML` 辅助函数，但 Worker 内不存在 DOM 且产品代码不调用它；该 bundle 不含 XMLHttpRequest、eval、new Function、fetch、WebSocket 或 importScripts。1.30.0 修复 GHSA-x7hr-w5r2-h6wg，其目标语言组件与 1.29.0 字节一致。

各包的完整许可文本随 npm 包提供，仓库来源与完整性哈希记录在 lockfile。

## 固定源码 SentencePiece WebAssembly

2026-08-23 起，独立 `.model` 使用用户批准的固定源码最小 wrapper；没有新增 npm runtime dependency 或 install script。生成的 `src/vendor/sentencepiece/sentencepiece-wasm.mjs` 与 `.wasm` 直接签入仓库，浏览器运行时不请求外部代码或内置模型。

### 来源与许可

| 组成 | 固定来源 | 许可 / 文本 |
| --- | --- | --- |
| Google SentencePiece | `e0cce7d37b065b5140349dbe12c6bcf6192fdd78`，exact tag `v0.2.2` | Apache-2.0；`sentencepiece-LICENSE` |
| Abseil | `5650e9cf76d3be4318d5fa3af38ee483ddfd5e4a`，tag `20260526.0` | Apache-2.0；`abseil-LICENSE` |
| emsdk | repo HEAD `e5bd3d0874e302a18f13c5b41f5bacf9a40c8e59` | MIT；`emsdk-LICENSE` |
| Emscripten compiler | `6.0.5`，`emcc` 报告 compiler commit `1db513…` | MIT / UIUC-NCSA；`emscripten-LICENSE` |
| internal protobuf-lite | SentencePiece v0.2.2 source tree | BSD-3-Clause；`protobuf-lite-LICENSE` |
| darts_clone | SentencePiece v0.2.2 source tree | BSD-3-Clause；`darts_clone-LICENSE` |
| esaxx | SentencePiece v0.2.2 source tree | MIT；`esaxx-LICENSE` |

上述 license 文件均位于 `src/vendor/sentencepiece/licenses/`，并与 `/tmp/model-files-sentencepiece-v0.2.2`、`/tmp/model-files-abseil-20260526.0`、`/tmp/model-files-emsdk-6.0.5` 对应审计源码逐字节一致。emsdk repo HEAD 与 Emscripten compiler commit 是两个不同标识。

### Wrapper 与构建边界

原生 surface 仅含 `LoadFromSerializedProto`、`EncodeAsIds`、`EncodeAsPieces`、`DecodeIds`、`IdToPiece`、status/error 和 release；ModelFiles 不实现 protobuf、BPE 或 Unigram。构建关闭 shared library、tests、tcmalloc、benchmark，使用 internal protobuf，并固定 `-fno-exceptions`、`DISABLE_EXCEPTION_CATCHING=1`、`DYNAMIC_EXECUTION=0`、`MODULARIZE=1`、`EXPORT_ES6=1`、`ALLOW_MEMORY_GROWTH=1`、`FILESYSTEM=0`、`ENVIRONMENT=web,worker,node`。

生成模块仅导入 Emscripten runtime/syscall stubs；Node 分支受环境检测保护，浏览器不执行。产品在同源 Worker 中加载已读取的 model 和同源 `.wasm`，不加载远程代码。

### 校验和、体积与当前构建

| 工件 | SHA-256 | 原始大小 | 独立工件 `gzip -c` |
| --- | --- | ---: | ---: |
| `sentencepiece-wasm.mjs` | `a56d940c2b3b853fea7e05525ed5d00db62017bee0875bc0e9ded3cd81fe43ea` | 34,693 B | 10,538 B |
| `sentencepiece-wasm.wasm` | `603002c9fc7541dbef7966c395e09b09a1c373e3d4e19781c994aadb7082ac2b` | 615,438 B | 239,510 B |
| BPE fixture | `c8636a43e913dad9d5eb5d2eee2077706a55589fd2d6caf1e7ee4a7d03e4360a` | 251,564 B | — |
| Unigram fixture | `4884d27bf50494e080aa99dbb868f27b68b6a3b6bd128da37ad6057c5e3cf5a2` | 253,165 B | — |

两个生成物原始合计 650,131 B。2026-08-23 当前 Vite production report：main 536.15 kB（gzip 155.48 kB）、CSS 30.64 kB（gzip 6.69 kB）、source-highlight Worker 67.90 kB、tokenizer Worker 166.24 kB、WASM 615.43 kB（gzip 243.67 kB）。当前 `dist` 原始字节数分别为 main 536,150、CSS 30,642、source Worker 67,906、tokenizer Worker 166,243、WASM 615,438。

独立源码工件的 `gzip -c` 数值与 Vite 对带 hash 的 production asset 所显示 gzip 数值属于不同测量上下文、命名和压缩报告，不可互换，也不据此声称二者字节相等。

### 安全与维护

- 原严格 meta-CSP 下主线程 WebAssembly compile 会因缺少 `wasm-unsafe-eval` 失败；产品不放宽 CSP，而是在原 CSP 下使用同源 module Worker。Chromium、Firefox、WebKit 的 BPE 与 Unigram 产品路径均通过，console 0 error、外部请求 0。
- 官方 registry `npm audit --omit=dev` 为 0 vulnerabilities、109 prod、177 total；npmmirror audit endpoint 的 404 只是镜像端点问题。
- 本机直接页面冷启动：BPE 6.7/11.2/17.9 ms（import/load/total），Unigram 6.3/7.6/13.9 ms。Chromium production preview 产品路径：BPE cold load 72.08 ms、首次 encode 44.48 ms；新 Worker 的 Unigram load 43.84 ms、首次 encode 48.37 ms。
- 更新任一固定 commit 前，必须重跑许可、checksum、可复现构建、BPE/Unigram gold、CSP、Worker 取消、bundle 边界和冷启动审计；不扩张原生 API。
