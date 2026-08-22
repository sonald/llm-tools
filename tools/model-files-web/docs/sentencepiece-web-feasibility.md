# SentencePiece WebAssembly 依赖门

日期：2026-08-22
结论：`BLOCKED`，不进入实现

## 目标

为纯浏览器 ModelFiles 加载用户或公开 Hugging Face 仓库提供的独立 SentencePiece `.model`，同时保持原始 token ID、Worker 隔离、32 MiB bundle 上限、64 KiB 输入上限和严格 CSP。

本门依据 `../SPEC.md` 4.1。门失败不把 `.model` 偷换为 `tokenizer.json`，也不自行实现 protobuf、BPE/Unigram 或维护一份 Google SentencePiece WebAssembly fork。

## 已审计候选

候选：`@sctg/sentencepiece-js@1.3.3`

来源：

- npm：`@sctg/sentencepiece-js@1.3.3`
- 源码：<https://github.com/sctg-development/sentencepiece-js>
- Google SentencePiece submodule：`d8f741853847553169444afc12c00f4bbff3e9ce`
- 源码审计 checkout：`ed260044938b4ee7b35d45c2e03dd19e7a47e5b0`，最后提交时间 2024-10-07
- 许可证：Apache-2.0

npm 发布物：

| 项目 | 证据 |
| --- | --- |
| 发布时间 | 2024-10-07T11:11:36.717Z |
| tarball | 4,903,469 bytes，6 files |
| unpacked | 11,315,824 bytes |
| `dist/index.js` | 4,019,145 bytes；gzip 1,730,834 bytes |
| `dist/index.d.ts` | 3,259,681 bytes |
| integrity | `sha512-iPnzR2HGjdQQG2SpTyPH3wnnpgQ2aS14B3I2jHjomkoaMprM3Sn+WOQblHwByetnvn3n14y3IwjwogVUHA2cVA==` |
| shasum | `35f5604f918757c4a16979b56382cb7c70552418` |
| 本次下载 SHA-256 | `2fed314af57cd0a683dcb9b30fc476eeba7ef080df41923ad20fd5b7aabd421a` |
| runtime dependencies | `app-root-path ^3.1.0`、`buffer ^6.0.3` |
| install scripts | 包自身没有 preinstall/install/postinstall；源码 lockfile 的 `fsevents` install script 仅属 dev/optional 图 |

## 门禁结果

| 硬门 | 结果 | 证据 |
| --- | --- | --- |
| 从用户 `ArrayBuffer` 加载 | **FAIL** | 公共浏览器 API 只有 `loadFromB64StringModel(string)`；`load(url)` 使用 Node `fs.readFileSync`；真正向 Emscripten FS 写字节的 `_loadModel(Buffer)` 是 private |
| 不额外复制大模型 | **FAIL** | 公开浏览器路径要求 ArrayBuffer → base64 → `Buffer.from(base64)`，至少产生 4/3 字符串膨胀和再次复制；与 32 MiB bundle 合同不匹配 |
| BPE/Unigram gold | **UNKNOWN/FAIL** | 底层 Google SentencePiece 支持两类算法，但候选仓库没有覆盖两类固定 IDs/pieces/decode 的自动化测试；只有一个手工 `src/test.js` |
| 原始 ID / 无隐式 BOS/EOS | **UNKNOWN** | wrapper 调用 `EncodeAsIds`，未设置 extra options；没有与原生 `tokenOffset=0` gold 的发布包测试 |
| pieces 与 Token ID decode | **PARTIAL** | 提供 `encodePieces` 和 `decodeIds`；bindings 暴露 `PieceToId` 但 wrapper 不公开，未绑定 `IdToPiece`，无法为任意 Token ID 稳定返回 piece |
| 无效 model 明确失败 | **FAIL** | `_loadModel` 调用 `processor.Load(...)` 后直接 `delete()` status，不检查 `status.ok()` 或错误文本 |
| Worker 取消 / 释放 | **PARTIAL** | 外层可用 terminate Worker 取消；wrapper 没有 dispose，单 session 只能依靠销毁整个 Worker 回收 WASM heap |
| 无运行时外部模型请求 | **PASS（静态）** | Emscripten 使用 `SINGLE_FILE=1`，WASM 以 data URI 内嵌；wrapper 自带三个 base64 示例模型，ModelFiles 不应导入这些导出 |
| CSP | **UNKNOWN** | 发布物内联实例化 WebAssembly；尚未证明可在当前 `script-src 'self'` 下运行，不能先放宽为 `wasm-unsafe-eval` |
| 体积 | **FAIL** | 单一发布 JS 4.02 MB / gzip 1.73 MB；还包含三个内置 base64 模型导出，超过现有 79 KB Worker 一个数量级以上 |
| 维护与发布可追溯 | **PARTIAL** | npm gitHead 为 `30916b62bae58f8bb9cd038d3b5e449eee4cae6e`，但当前公开 main HEAD 为 `ed260044...`；无 release tag，最近发布与提交均为 2024-10 |
| license / npm integrity | **PASS** | Apache-2.0；npm integrity、signature、tarball hash 可取得 |

## 为什么不适配

通过类型逃逸调用 private `_loadModel`、在应用内做 base64 转码或维护一份补 `LoadFromSerializedProto` / `IdToPiece` 的 fork，都会把第三方 wrapper 的内部实现变成 ModelFiles 的长期 API，并增加大模型峰值内存、错误处理和 CSP 风险。这不满足当前依赖门，也违反 YAGNI 和“不得自维护 SentencePiece 实现”的边界。

## 解除阻塞所需外部变化

满足以下任一条件后重新审计：

1. 一个可追溯的浏览器包公开 `load(ArrayBuffer | Uint8Array)`、`encodeIds`、`encodePieces`、`decodeIds`、`idToPiece` 与显式错误/释放 API，并有 BPE/Unigram gold。
2. Google SentencePiece 提供官方浏览器/WASM 发布物与内存加载 API。
3. 用户明确批准维护一个固定 Google SentencePiece commit 的最小 WASM wrapper，并接受其安全、CSP、体积和维护成本。该选项属于新的架构授权，不在当前 goal 内自动展开。
