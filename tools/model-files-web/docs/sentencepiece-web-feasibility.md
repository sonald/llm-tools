# SentencePiece WebAssembly 依赖门

日期：2026-08-23
结论：`PASS`，允许在同源 Web Worker 中集成用户授权的固定源码最小 wrapper。

产品浏览器 E2E 已在 Chromium、Firefox、WebKit 覆盖 BPE、Unigram、Raw、Chat、Token IDs、对照与 bundle 溢出预检；更广的全产品最终验收仍单独执行。

## 目标与维护边界

目标是在纯浏览器 ModelFiles 中加载用户或公开 Hugging Face 仓库提供的独立 SentencePiece `.model`，保持原始 token ID（`tokenOffset = 0`）、Worker 隔离、32 MiB bundle 上限、64 KiB 输入上限和现有严格 CSP。

ModelFiles 只维护以下最小原生 surface：`LoadFromSerializedProto`、`EncodeAsIds`、`EncodeAsPieces`、`DecodeIds`、`IdToPiece`、错误状态和释放。protobuf、BPE 与 Unigram 算法均来自固定的 Google SentencePiece 源码，不由 ModelFiles 实现。

## 固定来源

| 组成 | 固定版本 | 许可 |
| --- | --- | --- |
| Google SentencePiece | commit `e0cce7d37b065b5140349dbe12c6bcf6192fdd78`，exact tag `v0.2.2` | Apache-2.0 |
| Abseil | commit `5650e9cf76d3be4318d5fa3af38ee483ddfd5e4a`，tag `20260526.0` | Apache-2.0 |
| emsdk | repo HEAD `e5bd3d0874e302a18f13c5b41f5bacf9a40c8e59` | MIT |
| Emscripten compiler | `6.0.5`；`emcc` 报告 compiler commit `1db513…` | MIT / UIUC-NCSA |

emsdk repo HEAD 与 Emscripten compiler commit 是两个不同来源标识，不得混写。

构建关闭 shared library、tests、tcmalloc 和 benchmark，使用 internal protobuf，并固定 `-fno-exceptions`、`DISABLE_EXCEPTION_CATCHING=1`、`DYNAMIC_EXECUTION=0`、`MODULARIZE=1`、`EXPORT_ES6=1`、`ALLOW_MEMORY_GROWTH=1`、`FILESYSTEM=0`、`ENVIRONMENT=web,worker,node`。未增加 npm runtime dependency 或 install script；生成的 `.mjs` / `.wasm` 直接签入仓库。

## 硬门结果

| 硬门 | 结果 | 当前证据 |
| --- | --- | --- |
| 内存加载且不外传模型 | **PASS** | 从已读取的 `ArrayBuffer` 构造 `Uint8Array`，调用 `LoadFromSerializedProto`；运行时不下载内置模型、不加载远程代码 |
| BPE / Unigram 与原始 ID | **PASS** | 官方固定 fixture 覆盖 IDs、pieces、`IdToPiece` 与 decode round trip；gold 保持原始 ID，未静默增加 BOS/EOS |
| 错误与释放 | **PASS** | 无效 model、非法 ID、WASM status/error 与幂等 release 均有自动化覆盖 |
| Worker 取消与 latest-only | **PASS** | session 取消会终止 SentencePiece Worker；旧响应不能发布；JSON session 的单请求取消复用行为保持不变 |
| 32 MiB / 64 KiB 边界 | **PASS** | `.model`、同目录 config/template 的声明总量预检与实际整文件长度检查已接线；输入继续受 64 KiB 限制；三引擎已证明总量溢出时 model 内容请求为 0 |
| 许可、来源与可复现性 | **PASS** | 固定 commit/tag、生成物 checksum、BPE/Unigram gold 与精确 license 文本均已记录；干净重建结果字节一致 |
| 严格 CSP | **PASS（Worker 路径）** | 原页面 CSP 不变；三引擎同源 module Worker 均可加载 wrapper/WASM/model 并运行 BPE 与 Unigram，console 0 error，外部请求 0 |
| 已知漏洞 | **PASS** | 官方 registry `npm audit --omit=dev`：0 vulnerabilities，109 prod、177 total；默认 npmmirror audit endpoint 的 404 仅是镜像端点问题，不作为 PASS 证据 |

## 校验和与体积

| 工件 | SHA-256 | 原始大小 | `gzip -c` |
| --- | --- | ---: | ---: |
| `sentencepiece-wasm.mjs` | `a56d940c2b3b853fea7e05525ed5d00db62017bee0875bc0e9ded3cd81fe43ea` | 34,693 B | 10,538 B |
| `sentencepiece-wasm.wasm` | `603002c9fc7541dbef7966c395e09b09a1c373e3d4e19781c994aadb7082ac2b` | 615,438 B | 239,510 B |
| 两个生成物合计 | — | 650,131 B | — |
| BPE fixture `test_bpe_model.model` | `c8636a43e913dad9d5eb5d2eee2077706a55589fd2d6caf1e7ee4a7d03e4360a` | 251,564 B | — |
| Unigram fixture `test_model.model` | `4884d27bf50494e080aa99dbb868f27b68b6a3b6bd128da37ad6057c5e3cf5a2` | 253,165 B | — |

## CSP、网络与性能

- 原严格 meta-CSP 下，主线程 WebAssembly compile 会因缺少 `wasm-unsafe-eval` 失败；产品因此只走 Worker，不放宽 CSP。
- 原严格页面 CSP 下，Chromium、Firefox、WebKit 的同源 module Worker 均完成 BPE 与 Unigram 加载/encode/decode；请求仅包含同源应用资源和用户本地 model，console 0 error、外部请求 0。
- 生成模块只导入 Emscripten runtime/syscall stubs。其 Node 分支受环境检测保护，浏览器路径不执行；浏览器只同源读取 `.wasm`。
- 本机浏览器直接页面审计：BPE import 6.7 ms、load 11.2 ms、total 17.9 ms；Unigram import 6.3 ms、load 7.6 ms、total 13.9 ms。Chromium production preview 的产品路径复测：BPE cold load 72.08 ms、首次 encode 44.48 ms；切换到新 Worker 后 Unigram load 43.84 ms、首次 encode 48.37 ms。

## 历史拒绝候选

`@sctg/sentencepiece-js@1.3.3` 因公开浏览器入口依赖 base64/private API、缺少稳定 `IdToPiece` 与错误/释放证明、体积过大且 CSP 未验证而被拒绝。用户随后明确授权固定 Google SentencePiece v0.2.2 的最小 wrapper，才解除该架构阻塞。
