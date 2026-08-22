# ModelFiles Web 原生功能追平规格

状态：已确认
日期：2026-08-22
Web 基线：`11e1086 feat(model-files-web): add complete browser inspector`
原生对照上界：`59292c6 fix(model-files): close English UI localization gaps`

## 1. 目标

把 `tools/model-files/` 在 Web 基线之后新增、且能保持纯浏览器与只读安全合同的用户可见能力移植到 `tools/model-files-web/`，并用离线三浏览器 E2E、固定 revision 的真实 Hugging Face smoke 以及真实 Chromium 交互完成独立验收。

主代理负责编排、规格、审查、独立验证和提交边界；功能代码由 OpenRouter `stealth/ox-alpha` 编写。每个可独立验证的批次必须在 focused tests、`npm run check` 和相关浏览器检查通过后单独提交。

## 2. 保留的现有产品合同

- 纯浏览器，不增加后端、桌面桥、SSH、私有 token 代理或仓库自定义代码执行。
- 远端只支持匿名公开 Hugging Face。每次加载先取得清单返回的 40-hex SHA，当前会话的所有内容请求固定到该 SHA；live 验收记录实际 SHA，不宣称能选择任意历史 revision。本地只处理用户主动选择的目录。
- 可读文件和单个 tokenizer bundle 上限 32 MiB；Tokenizer、Token ID、Jinja 输入上限 64 KiB；搜索/差集结果最多 1,000 条。
- SafeTensors 只读 `bytes=0-7` 与精确 Header Range；GGUF 产品路径只读 `bytes=0-23`。
- 不读取或展示权重内容，不运行推理、转换、上传或远程代码。
- Worker 请求 latest-only；旧仓库、旧文件、旧输入或旧对照结果不得覆盖新状态。
- 保持现有工作台视觉语言、深色模式、键盘路径和响应式布局，不重设计产品。

## 3. 功能差异矩阵

| 原生基线后行为 | Web 当前状态 | 本轮决定 | 主要原生证据 | Web 目标入口 |
| --- | --- | --- | --- | --- |
| Tokenizer 换行/空白片段保持单行显示 | 未完整对齐；CRLF 与关闭空白显示时仍可换行 | 移植 | `7ecdb07` | `visiblePiece()`、Token table E2E |
| 独立 SentencePiece `.model` 编解码 | 缺失 | 必做；先过依赖门 | `cff8139` | Worker runtime、same-directory bundle |
| 源码语法高亮 | 缺失 | 移植 | `457b66e` | `Readers.tsx` 或最小专用 Reader |
| PDF 本地预览 | 缺失 | 移植；浏览器 Blob URL/内建 viewer | `457b66e` | inspection dispatch、PDF Reader |
| 不支持的二进制明确拒绝 | 仅依赖 UTF-8 fatal decode，不拒绝 NUL | 移植 | `457b66e` | 全文读取后的文本边界检查 |
| Token ID parser 与反解模式 | 缺失 | 移植 | `345e874`、`d4ad1f1`、`04b406b` | Worker protocol、Tokenizer workspace |
| Special flag、segment/table/ID 共享选择 | 缺失 | 移植 | `c1e5922` | Tokenizer result model/UI |
| Chat tools/variables、正文/模板开销与 Exact role | Tokenizer Chat 固定 `tools: []`，缺 variables/归因 | 移植；Decoded-only 不归因 | `c0e9d26`、`638c153` | Chat input/encode flow |
| jinja/config/named template catalog | 只支持独立文件或单字符串 | 移植三种已验证形态 | `34f2189` | config parse、Chat source control |
| 缺 `tokenizer_class` 显式恢复 | JS runtime 不按 class 分派 | N/A；不得制造假选择器 | `be7272f` | 一致性仍可报告缺失 class |
| tokenizer.json 按需词表搜索 | 只在 load 时构造统计 | 移植；索引只活在 Worker/session | `ea916c0` | Worker search request |
| 仓库一致性报告与 coverage | 缺失 | 移植 Web 可证明的规则 | `644bf66`、`00ed1cc`、`1c5e095` | 纯分析模块、header badge、Config report |
| adapter/processor 配置分类 | Web 当前排除了 processor/preprocessor | 移植且复用 configuration 类别 | `6b3ca5f` | `classifyFile()` |
| 同快照 tokenizer 对照 | 缺失 | 移植 | `e3e2001`、`0446d3a` | 第二 Tokenizer session、comparison UI |
| 词表差集与搜索 | 缺失 | 移植；按 piece、先过滤后截断 | `d099951` | comparison session |
| 跨仓库 tokenizer 对照 | 缺失 | 移植为第二公开 HF 或第二本地目录选择 | `46b43e9` | 现有 loadRepository/loadLocalDirectory |
| Python/YAML/JSON 折叠 | 缺失 | 移植原生扫描合同 | `0c388fe` | Source Reader、纯扫描模块 |
| 当前文件 `Cmd/Ctrl+F` 查找 | 现有只是行筛选 | 移植完整文本查找 | `5050df3` | Source/Raw/Jinja reader |
| `zh-Hans` / `en` | 仅中文 | 跟随浏览器语言，无应用内选择器 | `ac3249e`、`59292c6` | 一个消息目录与 Intl 格式化 |

文档截图、LICENSE 和验收记录提交本身不算新产品功能；最终只按实际 PASS/N/A/NO-GO 结果同步 Web 文档。

## 4. Web 平台适配

### 4.1 SentencePiece 依赖门

现有 `@huggingface/tokenizers` 只接受 `tokenizer.json` 与 `tokenizer_config.json`，不能直接加载独立二进制 `.model`。本轮必须先审计一个浏览器可运行的 SentencePiece WebAssembly 方案。

门禁必须同时满足：

- 能从已读取的 `ArrayBuffer` 加载用户/仓库提供的 `.model`，不要求网络下载内置模型，不把模型内容转发到外部。
- BPE 与 Unigram 至少覆盖原生真实 fixture 的 encode IDs、pieces、decode round trip；固定 gold 明确证明 `tokenOffset = 0` 语义、保持原始 token IDs 且不静默加 BOS/EOS。
- `.model`、同目录可选 `tokenizer_config.json` 与 `chat_template.jinja` 各自及合计均受 32 MiB bundle 上限约束；按清单大小预检并按实际读取字节复核。缺 config/template 不阻塞 Raw；Chat 仅在 catalog 可用时启用。
- Worker 内运行、latest-only；取消长同步 WASM 调用以终止该 session Worker 为准。切换文件/仓库/对照后旧响应不得发布；64 KiB 输入上限继续生效。
- 许可证兼容；npm tarball、源码仓库、WASM 发布物和传递依赖可追溯；记录 lockfile integrity 与 WASM checksum；无 install script、运行时外部 fetch、远程代码加载或已知 critical/high 漏洞。
- 保持现有 CSP 优先。若 WASM 只能在 `script-src 'wasm-unsafe-eval'` 下实例化，必须单独记录原因和风险并由主代理确认；任何 `unsafe-eval`、`unsafe-inline` 或更宽网络源要求直接判门失败。
- 记录精确版本、原始/压缩 main/worker/WASM 增量、冷启动实例化耗时、最近 release/commit 日期和已知兼容边界。

若候选依赖不满足任一硬门，不自己实现 protobuf + SentencePiece 算法，也不假装以 tokenizer.json 代替 `.model`；暂停并报告 `BLOCKED`，等待用户决定依赖或范围。

### 4.2 源码、折叠与查找

- 代码高亮覆盖原生 `FileClassifier.syntaxLanguage` 已支持的扩展；优先审计 exact-pinned Prism，而不是手写多语言正则高亮器。
- 折叠 V1 只支持 Python/PythonW、YAML/YML、JSON；扫描规则和边界测试从原生 gold 移植为 TypeScript 纯函数。
- 文件大于 128 KiB 时不折叠，但仍能搜索完整已加载文本，包括第 1,001 行之后。
- `Cmd+F` 与 `Ctrl+F` 在当前文本阅读面内打开查找；不改变侧栏筛选；字面量、不区分大小写、显示当前/总数、前后循环、Esc 关闭。
- 当前命中在折叠块内时只展开包含它的最小范围。折叠不得改变底层字符串或“复制全部”结果。
- PDF 读取完整文件但仍受 32 MiB 限制；验证 `%PDF-` magic/可显示结果。内嵌方案只允许把 CSP 的 `frame-src` 从 `none` 收窄为 `blob:`，继续保持 `object-src 'none'`；使用 `Blob(type: application/pdf)` object URL 并在切换文件/卸载时 revoke。浏览器不能内嵌时提供由用户点击触发的 blob 新标签页 fallback；三引擎分别记录实际行为。
- 普通文本要求 fatal UTF-8 且不含 NUL；未知二进制返回安全错误，不渲染乱码。共享全文读取边界必须同时校验声明上限、实际上限和实际字节数等于来源声明，远端短读不得静默返回截断内容。

### 4.3 Tokenizer 诊断

- 扩展现有 `Tokenization`，不平行维护另一套结果模型：direction、input、IDs、pieces、decoded、segments、mapping、flags、roles、overhead、runtime identity。
- Worker 输入采用可判别 union；所有响应做 shape/identity/generation 校验。解析外部 JSON、Token ID 和 template catalog 时只在边界验证一次；tokenizer/config/template 字节一律使用 fatal UTF-8，不能用 replacement character 宽松解码。
- Token ID 支持逗号、空白、换行与 JSON 数组；拒绝空输入、负数、非整数、溢出和 64 KiB 超限，错误包含 item index。
- special 来源固定为标准 config token 字段、`additional_special_tokens` 和 `added_tokens[special=true]`。先用可靠 ID，再用精确 piece；一个 special 字符串编码为多个 ID 时不得把组成 ID 标为 special。仅在 ID 未命中且 piece 为 nil/空时允许单 ID decode 冷兜底；普通 BPE/Unigram fixture 的兜底计数必须为 0。SentencePiece 无 added_tokens 时只用 config 字符串，不猜测。
- Tokenizer Chat 与现有 Template Playground 一样支持 messages、tools、variables、`includeTools` 和 `add_generation_prompt`；不得继续硬编码 `tools: []`。
- Chat 主结果始终对应可见权威渲染字符串；正文 probe 只连接非空文本 message content，按消息顺序用一个换行分隔，不把 tools、多模态 JSON 或 variables 当正文。负差量显示“无法拆分”，不显示负 overhead。
- roles 仅在 Exact 映射上按消息顺序单调匹配非空文本正文；重复正文不能回退匹配，跨边界 segment 归 template，自定义 role 保留，Decoded-only 显示不可归因。
- template catalog 接受 string、named object、named array；独立 `chat_template.jinja` 优先；named object 稳定按 key 排序、named array 保持原顺序；空 entry disabled；未知形态明确失败。
- 词表概览只返回统计、special 摘要和最长 50 条；查询非空时才在 Worker/session 建完整索引，匹配 ID 或 piece，最多返回 1,000 条。

### 4.4 仓库一致性

后台报告覆盖：

- `vocab-mismatch`
- `missing-tokenizer-class`
- `missing-chat-template`
- `eos-mismatch`
- `context-info`
- `missing-config`

coverage 区分 checked/missing/skipped/failed；单材料损坏不能丢弃整份报告。身份字段与原生 alias 对齐：architecture=`architectures[0]`/`model_type`，layers=`num_hidden_layers`/`n_layer`/`num_layers`，hidden=`hidden_size`/`n_embd`/`d_model`，context=`max_position_embeddings`/`max_sequence_length`/`n_positions`；EOS 同时接受非负整数或非空整数数组并按完整序列比较。

`adapter_config.json`、`preprocessor_config.json`、`processor_config.json` 进入 configuration 分组。adapter 至少显示 `peft_type`、`base_model_name_or_path`；processor 至少显示 `processor_class`、`image_processor_type`、`image_size`/`size`/`crop_size` 中可解析值。

Web 继续只读取 GGUF 24-byte prefix，因此 `gguf-context-mismatch` 与 `gguf-vocab-mismatch` 必须显示 skipped/材料不足，不得为追平报告而扩大 GGUF Range。报告不得构造 tokenizer runtime、全量词表索引或读取权重。材料读取复用同一 snapshot 的成功缓存；打开 GGUF 前后台请求为 0，打开后报告只消费既有 24-byte summary，刷新报告不得再读。

### 4.5 Tokenizer 对照

- 当前 tokenizer 与右侧 tokenizer 各有独立 session/Worker 和请求表；同时最多两个 runtime。Worker reply 必须验证 discriminant、request ID、session identity 和 generation 后再做类型收窄，不得只用 TypeScript cast 信任 `event.data`。
- 同快照选择另一个入口；跨仓库只接受第二公开 Hugging Face ID/URL 或用户主动选择的第二本地目录。
- 第二来源不得改写主 snapshot、selectedPath、历史、错误、缓存或一致性报告。
- Raw、Chat、Token IDs 共用左侧输入；Chat 两侧各用自己的模板 catalog 渲染；右侧失败不覆盖左侧。
- 显示两侧 token count、差值（固定为 right - left）、ID 是否相同、第一处差异（前缀结束也算差异）、Chat overhead；左右选择状态独立。
- 两侧都有 JSON 词表时按 piece 求 only-left/only-right/common；搜索完整集合后再截断 1,000。任一侧为 SentencePiece 时明确跳过词表差集，但保留编解码对照。
- 切目标、关对照、切主文件或重载仓库时取消并释放右 session、WASM/runtime 和词表索引。

### 4.6 国际化

- 支持 `zh-Hans` 与 `en`。按 `navigator.languages` 第一项解析：`zh-Hans`、`zh-CN`、`zh-SG` 和其他 `zh-*` 均使用 `zh-Hans`，`en-*` 使用 `en`，其他语言回退 `zh-Hans`；不增加运行时语言设置、第三种语言或 i18n 框架。
- UI、错误、aria-label、placeholder、计数与状态均进入一个消息目录；文件内容、路径、仓库 ID、代码与 metadata key 不翻译。
- 使用 `Intl.NumberFormat` 等原生 API；初始化时把 `<html lang>` 精确设为 `zh-Hans` 或 `en`。除两种 locale 的核心 E2E 外，静态 key/占位符审计和错误路径测试必须证明用户可见源码字面量没有漏出另一语言；技术名、fixture 内容与用户文件除外。

## 5. 实施批次与提交

1. `docs(model-files-web): specify native parity goal`
2. `feat(model-files-web): support SentencePiece tokenizers`
3. `feat(model-files-web): preview source and PDF files`
4. `feat(model-files-web): add source folding ranges`
5. `feat(model-files-web): add in-file find and folding`
6. `feat(model-files-web): decode tokenizer IDs and mark special tokens`
7. `feat(model-files-web): attribute chat tokens and search vocabulary`
8. `feat(model-files-web): analyze repository consistency`
9. `feat(model-files-web): show repository consistency status`
10. `feat(model-files-web): isolate tokenizer comparison sessions`
11. `feat(model-files-web): add tokenizer comparison and vocabulary diff`
12. `feat(model-files-web): add cross-repository tokenizer comparison`
13. `feat(model-files-web): add English localization`
14. `docs(model-files-web): record native parity acceptance`

允许在审查后合并极小且不可独立验收的相邻批次；不允许把多个大功能压成一个提交。每个实现批次遵循 RED → GREEN → review → focused test → `npm run check` → 相关 E2E → staged diff/secret/whitespace review → commit。

## 6. 验收标准（done_when）

### 6.1 工件与矩阵

- `SPEC.md`、`GOAL.md`、README、产品化计划、依赖清单和新的 parity acceptance 互相一致。
- 本规格矩阵每一项最终为 PASS、用户确认的 N/A，或因依赖门明确 BLOCKED；不得以旧测试或作者自述代替证据。
- 除用户已有 `tools/model-files/.DS_Store` 外，不夹带无关工作区文件；不 push、tag、release 或部署。

### 6.2 自动化

- `cd tools/model-files-web && npm run check` exit 0。
- `cd tools/model-files-web && npm run test:e2e` exit 0；Chromium、Firefox、WebKit 的离线 fixture 覆盖新功能；任何 skip 都有平台原因和对应的其他执行证据。
- `cd tools/model-files-web && npm run test:e2e:live` exit 0；每个 manifest 返回 SHA 后，后续内容 URL 全部使用该 SHA；验收记录实际 SHA，并覆盖真实 tokenizer 诊断和跨仓库对照。
- `npm audit --omit=dev` 无 critical/high；新增 runtime 依赖有版本、许可证、bundle 和维护性记录。
- `git diff --check`、目标文件 secret scan、staged diff review 通过。

### 6.3 真实浏览器

真实 Chromium 至少完成：

1. 打开完整本地 fixture；预览源码与 PDF；拒绝未知二进制。
2. Python/YAML/JSON 折叠；`Cmd+F`/`Ctrl+F` 查找普通、重复、中文、大小写和折叠内命中；大文件命中第 1,001 行之后。
3. JSON 概览/字段/原文切换后查找状态与内容正确。
4. tokenizer.json Raw、Chat、Token IDs；segment/table/ID 选择联动；Special/Role、overhead、named template 和词表搜索正确。
5. SentencePiece `.model` Raw 与 Token IDs round trip；Chat 能力按其同目录 config/template 决定。
6. 一致性 badge/report 的 findings 与 coverage 正确；未打开 GGUF 时没有额外 GGUF/权重请求。
7. 同快照与第二公开 HF/本地目录对照；右侧失败恢复、切 Raw、词表差集、关闭释放，主状态保持不变。
8. `zh-Hans` 与 `en` 分别完成核心流程；`390x844`、`768x1024`、`1280x800` 主操作可达，窄屏对照改为上下排列。
9. 键盘焦点、可访问名称、动态状态和颜色之外的状态表达可用。
10. production preview console 0 error/0 warning；网络账本只有预期清单、可读文件和既有严格 Range，权重内容请求为 0。

性能证据至少记录：128 KiB 折叠扫描、接近 32 MiB 文本查找、Qwen 级 150k 词表首次索引/查询、10k token、双 session 首次加载与 SentencePiece WASM 冷启动。阈值以现有 10k token `<10 s`、100k 行 `<3 s` 门为下限；任何更慢路径必须给出用户可见响应性证据和原因。

## 7. 非目标

- ModelScope、SSH、私有仓库/token、后端代理、桌面桥。
- 完整 GGUF metadata/tensor directory、推理、转换、上传和权重读取。
- 手写 SentencePiece 算法、手写多语言语法高亮器、语言插件 SDK、通用 tokenizer provider/factory。
- 可编辑源码、保存、替换、全仓库搜索、折叠状态/查找历史持久化。
- 应用内语言选择器、第三种语言。

## 8. 权威参考

- 原生诊断：`../model-files/docs/diagnostic-inspector-spec.md`、`../model-files/docs/diagnostic-inspector-acceptance.md`
- 原生阅读与国际化：`../model-files/docs/source-reader-i18n-requirements.md`、`../model-files/docs/source-reader-i18n-implementation-plan.md`
- 现有 Web 合同：`docs/productization-plan.md`、`docs/local-functionality-acceptance.md`、`docs/third-party-dependencies.md`
- Hugging Face Tokenizers.js：<https://github.com/huggingface/tokenizers.js/>
- Google SentencePiece：<https://github.com/google/sentencepiece>
- 浏览器 Blob/PDF：<https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications>
