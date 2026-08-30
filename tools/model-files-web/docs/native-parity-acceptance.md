# ModelFiles Web 原生追平验收记录

日期：2026-08-30。结论：功能/运行时/文档验收 `PASS`；Tensor hierarchy 已完成 fresh unit、离线三浏览器、响应式 Chromium 与 Qwen live 验收。本轮提交为 `6eb16a8`、`4c52e76`、`1c2ad4b`、`5e08c4a`；本记录固化当前 fresh evidence。SPEC 第 3 节全部为 `PASS` 或用户批准的 `N/A`（仅 `tokenizer_class` override）。

## 总体矩阵

| 领域 | 功能/运行时状态 |
| --- | --- |
| Tokenizer 空白单行、SentencePiece `.model`、源码/PDF/binary | PASS |
| Token IDs、Special flags、共享选择、Chat tools/variables/overhead/roles、template catalog | PASS |
| 按需 vocabulary、仓库一致性/coverage、adapter/processor 分类 | PASS |
| 同快照、跨公开 HF、第二本地目录对照和词表差集 | PASS |
| 折叠、当前文件查找、大文件查找 | PASS |
| SafeTensors Tensor hierarchy（展开、搜索、选择、详情与响应式） | PASS |
| zh-Hans/en、响应式、键盘、深色模式和页面 console/network 门 | PASS |
| `tokenizer_class` override | N/A：`@huggingface/tokenizers` 不按 class 分派；一致性缺失 warning 保留 |

ModelScope、SSH、私有凭据、推理、转换、上传、权重内容读取和完整 GGUF directory 是既有非目标，不进入本追平矩阵。

## 命令与结果

所有命令在 `tools/model-files-web` 执行：

```bash
npm run check
# exit 0; unit 167 pass / 0 fail; production build PASS
npm run test:e2e
# exit 0; 138 total, 109 passed, 29 explicit skips, 0 failed, 43.2s
npm run test:e2e:live
# exit 0; 3 passed / 0 failed, 18.8s
npm audit --omit=dev --registry=https://registry.npmjs.org --json
# exit 0; vulnerabilities total/high/critical = 0
sh scripts/build-sentencepiece-wasm.sh
# exit 0; generated artifacts byte-identical to the committed files
npx playwright test e2e/model-files.spec.ts --project=chromium --workers=1 -g 'SafeTensors hierarchy'
# exit 0; 2 passed / 2 total, 2.5s; 390×844/768×1024/1280×800 responsive evidence
git diff --check
# repository-root check: PASS, exit 0
```

`npm run check` production build：main 540.40 kB（gzip 156.88）、CSS 33.06 kB（gzip 7.08）、tokenizer worker 166.88 kB、source worker 67.90 kB、WASM 615.43 kB（gzip 243.67）；仅既有 Vite warnings。Playwright focused responsive 运行在 production preview；页面 console error/warning 为 0/0。临时输出路径不固化。

离线 29 条 skip 全部显式：3 个 live 用例在离线三项目各跳过一次，共 9 条；其余为平台限定的计时/目录时序/取消/布局门，共 20 条。通用 `SafeTensors hierarchy` 流程在 Chromium、Firefox、WebKit 均执行通过；responsive screenshot 测试仅 Chromium 执行，Firefox/WebKit 因已有通用三引擎 hierarchy 证据而按明确原因 skip。其余功能路径仍在适用引擎执行。

## SPEC 6.3 流程映射

| 流程 | E2E 入口 |
| --- | --- |
| 1. 本地 fixture、源码/PDF、拒绝未知二进制 | `opens every supported local directory reader without network upload`; `dispatches local Python and PDF readers safely` |
| 2. Python/YAML/JSON 折叠与查找 | `folds Python YAML and JSON while preserving the full source`; `source find navigates matches and reveals collapsed ancestors`; `find works in JSON Markdown and full progressive text`; `finds the tail of an almost 32 MiB progressive text within budget`; `Jinja source find preserves query while editing and resets on file switch` |
| 3. JSON 视图与查找状态 | `reads semantic JSON, progressive text, and safe Markdown views`; `find works in JSON Markdown and full progressive text` |
| 4. JSON Tokenizer 诊断 | `Tokenizer Worker tokenizes and decodes back to the input`; `attributes Exact Chat tokens to custom message roles`; `searches vocabulary latest-only without rereading tokenizer resources`; `decodes shared Token IDs with special flags and linked selection`; `selects between independent and tokenizer config chat templates`; `sorts named object templates and switches without rereading the config`; `disables chat rendering when every config template is blank` |
| 5. SentencePiece Raw/Round trip/Chat | `runs official SentencePiece models through Raw IDs Chat comparison and recovery` |
| 6. 一致性 badge/report、coverage 与 GGUF 前零请求 | `consistency background acquires materials once and reports repository warnings`; cancellation/latest-only consistency tests |
| 7. 同快照与第二来源对照 | same-snapshot/main-tokenizer/public-HF/local-comparison/delayed-manifest 对照用例 |
| 8. zh-Hans/en 与三视口 | `runs the core repository and tokenizer entry points in English`; `keeps controls reachable across target viewports, keyboard, and dark mode`; `SafeTensors hierarchy stays usable across responsive layouts` |
| 9. 键盘焦点、可访问名称、动态状态与非颜色表达 | `keeps controls reachable across target viewports, keyboard, and dark mode` |
| 10. console 0/0 与网络账本 | 离线和 live 用例的 `collectErrors()` 断言；SafeTensors/GGUF Range、local no-upload、comparison isolation 用例 |
| 11. SafeTensors hierarchy outline | `SafeTensors hierarchy keeps two exact ranges without tensor data`; `SafeTensors hierarchy stays usable across responsive layouts`; Qwen live hierarchy path |

## 性能

最终表使用一次完整离线套件的数字：

| 场景 | 结果 | 门 |
| --- | ---: | --- |
| 128 KiB folding scan | 47.646709 ms | < 50 ms |
| 10k token tokenization | 457 ms | < 10 s |
| SentencePiece first result / dual-session first comparison | 384 / 357 ms | 产品流通过 |
| 32 MiB - 1 exact text load / find | 207 / 168 ms；33554431 bytes，命中第 65,536 行 | load < 10 s；find < 3 s |
| Qwen vocabulary first / cached query | 157 / 123 ms | live suite < 10 s |
| Tensor hierarchy unit build (10,000 tensors) | 29.490042 ms | < 1 s |
| Chromium production responsive focused gate | 2.5 s | 2 passed / 2 total |

Qwen live Tensor hierarchy 计时：从进入 Tensors 到选中详情可见 `tensorHierarchyMs=100`。

## 固定 revision 与 request ledger

固定源码 revisions：

| 来源 | Revision |
| --- | --- |
| Google SentencePiece | `e0cce7d37b065b5140349dbe12c6bcf6192fdd78`（v0.2.2） |
| Abseil | `5650e9cf76d3be4318d5fa3af38ee483ddfd5e4a` |
| emsdk repo HEAD | `e5bd3d0874e302a18f13c5b41f5bacf9a40c8e59` |
| Emscripten compiler commit | `1db513782be24469589d7cb8a1f1834e9a33f271`（版本 6.0.5） |

Live manifest SHA：

| 目标 | Manifest SHA |
| --- | --- |
| `Qwen/Qwen3-0.6B` | `c1899de289a04d12100db370d81485cdf75e47ca` |
| `google-t5/t5-small` | `df1b051c49625cf57a3d0d8d3863ed4d13564fe4` |
| `bartowski/Qwen_Qwen3-0.6B-GGUF` | `60b85c0e3d8fe0f6474f406922a26d12aca4550d` |

Request ledger 断言：每个目标先取得 manifest 40-hex SHA；该目标的全部 Hugging Face content URL 都固定到同一 SHA。Qwen `model.safetensors` 只有 `bytes=0-7` 与 `bytes=8-35559`；GGUF `Qwen_Qwen3-0.6B-IQ2_M.gguf` 只有 `bytes=0-23`。T5 对照只读 tokenizer 资源，无 weight content；无任何 `.bin` 或对照 weight content request。关闭对照前主 URL/history/status/detail header/localStorage history 保持不变，Qwen Chat 保持可用。live 与离线相关用例的 `collectErrors()` 均 assert 0 error / 0 warning；本地目录与 32 MiB 测试外部请求为 0。终端 `NO_COLOR`/Vite 提示不计入页面 console。Playwright attachment 记录每次运行的完整 request JSON。

Qwen SafeTensors hierarchy fresh 交互从进入 Tensors 到选中真实 `q_proj` leaf 详情可见耗时 `tensorHierarchyMs=100`；该交互保持 Tensor data `0 bytes`。

## 截图

Production Chromium screenshots：

| 文件 | SHA-256 |
| --- | --- |
| `/private/tmp/model-files-web-parity-final-evidence/model-files-keeps-controls-e01d9-orts-keyboard-and-dark-mode-chromium/390x844.png` | `3dd96d4678701b729163be16ce2410321ecb9b20b4050b0b57625bebc466a2dd` |
| `/private/tmp/model-files-web-parity-final-evidence/model-files-keeps-controls-e01d9-orts-keyboard-and-dark-mode-chromium/768x1024.png` | `a63ff096c6b2ac3be4970f883eb31d087297135d1ee419f07ebca8a2f3fa9f67` |
| `/private/tmp/model-files-web-parity-final-evidence/model-files-keeps-controls-e01d9-orts-keyboard-and-dark-mode-chromium/1280x800.png` | `1fab74864c9e69c020bce067e68ba673a93af9909b402125528b05511a1ff96b` |
| `/private/tmp/model-files-web-parity-final-evidence/model-files-keeps-controls-e01d9-orts-keyboard-and-dark-mode-chromium/dark-mode.png` | `515683dce4f3740520445636ade431bf3d89b2c4e0f92f6f6c4fb8bb7f97e605` |

主代理视觉抽查 PASS。

T37 fresh responsive screenshots（临时输出路径不固化，仅记录视口与 SHA-256）：

| 视口 | SHA-256 |
| --- | --- |
| 390×844 | `5fb252134ea55490e0e48728b44009fe4bf93d3f8b440b63f3c2d669ec6dfb92` |
| 768×1024 | `26c97b287831d4be5edba566c3d7c7737ebf872f29d566697f975fb6aaf06c2d` |
| 1280×800 | `731c92df8196c5003c2a21fd42b9a9cc4c5feabc88fe5ea7d2e9916cf64ab9f0` |

三视口均无页面级横向溢出，leaf/count 可读；390×844 与 768×1024 inspector 下置，1280×800 inspector 右置；页面 console error/warning 为 0/0。

## 依赖审计与可复现构建

本轮 official registry 审计 `npm audit --omit=dev --registry=https://registry.npmjs.org --json` exit 0；漏洞 total/high/critical 均为 0，无新增 runtime dependency。默认 npmmirror audit 返回 404，只是镜像端点未实现，不代表漏洞结果。npm package 与 vendored WASM 分开记录：React/Jinja/tokenizers/Markdown/Prism 是 npm packages；SentencePiece wrapper/WASM 不是 npm runtime dependency，而是固定源码构建并签入的 vendored artifacts。

可复现构建固定输出：

| 工件 | SHA-256 | 大小 |
| --- | --- | ---: |
| `sentencepiece-wasm.mjs` | `a56d940c2b3b853fea7e05525ed5d00db62017bee0875bc0e9ded3cd81fe43ea` | 34,693 B |
| `sentencepiece-wasm.wasm` | `603002c9fc7541dbef7966c395e09b09a1c373e3d4e19781c994aadb7082ac2b` | 615,438 B |

重建后两个文件均为 `0644` 且哈希不变；编译输出只有固定 Abseil deprecation warnings。Vite production report：main 540.40 kB（gzip 156.88）、CSS 33.06 kB（gzip 7.08）、source worker 67.90 kB、tokenizer worker 166.88 kB、WASM 615.43 kB（gzip 243.67）。详细 license/provenance 见 [third-party-dependencies.md](third-party-dependencies.md)。

## Git 状态与提交边界

现有提交按时间序来自 `git log --oneline --reverse 11e1086..5e08c4a`：

```text
9cc18f0 doc: update
b53de4c docs(model-files): add tokenizer visual guide
7ecdb07 fix(model-files): align tokenizer segments
cff8139 fix(model-files): visualize SentencePiece tokenizers
457b66e feat(model-files): preview code and PDF files
343aadf docs(model-files): add diagnostic inspector spec and plan
345e874 feat(model-files): add tokenizer diagnostic foundations
d4ad1f1 feat(model-files): decode token IDs and mark special tokens
04b406b feat(model-files): add token ID input mode
c1e5922 feat(model-files): synchronize tokenizer selection views
c0e9d26 feat(model-files): attribute chat token overhead
638c153 feat(model-files): attribute exact chat token roles
34f2189 feat(model-files): switch chat template sources
be7272f feat(model-files): retry with explicit tokenizer class
ea916c0 feat(model-files): search tokenizer vocabulary on demand
e8b1ad4 docs(model-files): record diagnostic inspector phase one
644bf66 feat(model-files): analyze repository consistency
00ed1cc feat(model-files): build repository consistency reports
1c5e095 feat(model-files): show repository consistency status
6b3ca5f feat(model-files): classify processor configuration files
3989df7 docs(model-files): record diagnostic inspector phase two
e3e2001 feat(model-files): add tokenizer comparison session
0446d3a feat(model-files): add tokenizer comparison workspace
d099951 feat(model-files): add tokenizer vocabulary comparison
46b43e9 feat(model-files): add cross-repository tokenizer comparison
f6f5dcf docs(model-files): record diagnostic inspector phase three
53d3074 docs(model-files): refresh README for diagnostic inspector
add3cd2 docs(model-files): specify source reader and localization
0c388fe feat(model-files): add source folding
5050df3 feat(model-files): add in-file find
ac3249e feat(model-files): add English localization
59292c6 fix(model-files): close English UI localization gaps
cfee5a8 docs(model-files-web): specify native parity goal
5603fab docs(model-files-web): record SentencePiece dependency blocker
aa0b041 feat(model-files-web): preview source and PDF files
5e40fe6 feat(model-files-web): add source folding ranges
ad81d5d feat(model-files-web): add source folding controls
4fb0cf7 feat(model-files-web): add in-file find scanner
2f3a05b feat(model-files-web): add in-file find
af7f162 feat(model-files-web): add tokenizer ID diagnostics
544f845 feat(model-files-web): add chat token attribution
103a829 feat(model-files-web): add chat token overhead
4e02e5e feat(model-files-web): add chat token roles
66ab409 feat(model-files-web): add chat context controls
b5e589d feat(model-files-web): add chat template catalog
c0a86fb feat(model-files-web): add vocabulary search
34c86c5 feat(model-files-web): analyze repository consistency
0fcb696 feat(model-files-web): add repository consistency report
c533d85 feat(model-files-web): isolate tokenizer comparison sessions
9d76e5c feat(model-files-web): compare snapshot tokenizers
e4dd98b refactor(model-files-web): support cross-snapshot tokenizer diff
ed34bbe feat(model-files-web): compare public repositories
99f0227 feat(model-files-web): compare local directories
0719b62 feat(model-files-web): add English localization
ddc5d02 feat(model-files-web): support SentencePiece tokenizers
ded42c1 test(model-files-web): cover SentencePiece in browsers
16591ac chore(model-files-web): normalize SentencePiece artifacts
93ef3bc test(model-files-web): verify live tokenizer comparison
81b8eb9 test(model-files-web): record parity performance gates
b889ae5 docs(model-files-web): record native parity acceptance
ef90a92 feat(model-files): organize tensors by hierarchy
6eb16a8 docs(model-files-web): specify tensor hierarchy parity
4c52e76 feat(model-files-web): model tensor hierarchy
1c2ad4b feat(model-files-web): browse tensors by hierarchy
5e08c4a test(model-files-web): verify tensor hierarchy in browsers
```

实现/测试提交已到 `5e08c4a`；Tensor hierarchy 由 `4c52e76`、`1c2ad4b`、`5e08c4a` 完成；六份文档由本文件所在提交收口。

未发生 push、tag、release 或 deploy。`tools/model-files/.DS_Store` 保持 untracked 且未被修改、暂存或提交。
六份文档由本文件所在提交收口；最终 scoped secret scan、staged diff 与 whitespace 检查通过；未 push/tag/release/deploy。
