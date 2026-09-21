# Semantic JSON Viewer 支持矩阵

> 这是当前实现的 M4 快照，不是发布声明。源代码行为以当前 checkout 为准；真实 Native 证据见 [`native-acceptance.md`](native-acceptance.md)，Core 性能和内存观测见 [`performance-baseline.md`](performance-baseline.md)。两份证据都明确存在未验收项，不能合并解释为 F-00 至 F-12 全 PASS。

状态含义：`已实现` 表示当前代码有对应路径；`部分/WIP` 表示仍有限制、缺口或只完成局部证据；`未支持/未验` 不纳入当前支持承诺。

## 文件、编码与无损能力

| 范围 | 当前行为 | 状态与证据 |
| --- | --- | --- |
| 本地 `.json` | 按根节点路由：根 array 为 Collection，其他根类型为 Document；pretty 或 one-line 不改变此规则 | 已实现：`src-tauri/src/file_route.rs` 的 `path_kind`、`route_json`、`mode_for_root` |
| `.jsonl` / `.ndjson` | 明确扩展名直接进入 Entry；Entry 列表按非空物理行浏览 | 已实现：`src-tauri/src/file_route.rs`、`src/entry-list.ts` |
| 未知扩展 | 自动判断时，`≤128 MiB` 先尝试完整 JSON；更大输入只取有界 JSONL 样本，至少 2 条且需达到 90% 合法行。`128 MiB` 是自动路由分支阈值，不是 JSON 文件大小上限；显式 Document 选择可走完整读取 | 已实现但需遵守边界：`src-tauri/src/file_route.rs` (`FULL_PARSE_LIMIT_BYTES`、`SAMPLE_SIZE_LIMIT`、`detects_jsonl`) |
| framing | RS framing 有专门拒绝；串接 JSON 在 Unknown 路由有专门检测，显式 `.json` 为 Invalid JSON，`.jsonl` 为坏 Entry，不能称为所有扩展名统一文件级拒绝 | 已实现：`src-tauri/src/file_route.rs`；F00/F07 固定输入生成器见 `fixtures/generate-raw-document-fixtures.mjs` |
| 显式拒绝 | `jsonc`、`json5`、`gz`、`zst` 拒绝，不解压。YAML/XML 没有 parser，但其扩展名属于 unknown，不是一律按扩展名拒绝 | 已实现的路由边界：`src-tauri/src/file_route.rs`；v0.1 排除项见 `docs/spec.md` §24 |
| 编码 | UTF-8 和 UTF-8 BOM 支持；UTF-16/UTF-32 BOM 文件级拒绝；坏 UTF-8 `.json` 可保留为 Raw-only；坏 JSONL 行保留 Lossy Text/Hex，前部样本中坏行超过 20% 时给 warning | 已实现，Native 完整矩阵尚未验：`src-tauri/src/file_route.rs`、`src-tauri/src/jsonl_entry.rs`、`src-tauri/src/jsonl_session.rs`、`src-tauri/src/ipc.rs` |
| 大 Entry | Entry 大于 16 MiB 不解析，保留有界 Raw 预览与位置能力 | 已实现：`src-tauri/src/jsonl_entry.rs` (`MAX_ENTRY_BYTES`)、`src-tauri/src/jsonl_session.rs` |
| 无损 JSON | duplicate key occurrence、原始 span、超大整数、exponent、转义和 emoji 均保留；Copy 从原始 span 读取 | 已实现：`src-tauri/src/json.rs`、`src-tauri/src/tree.rs`、`src-tauri/src/ipc.rs`；局部 Native 证据见 `docs/native-acceptance.md` |
| Schema 重复字段 | 消息、包装对象及已支持的专用子对象按实际依赖检查重复 key；显示歧义提示并保留完整 Raw/Tree source，不继续专用渲染 | `4754220`、`8919672`、`bb8cf6d`；独立 Core 318、Conversation UI 96 通过，Native 未验 |

## 浏览与渲染

| 范围 | 当前行为 | 状态与证据 |
| --- | --- | --- |
| EntryList / Tree | Entry 与 Tree child IPC page 均为 200；Entry 按实测行高挂载视口窗口，Tree 按 35px 行高挂载窗口。主 Tree 与 Nested Tree 的离屏值预览接入共享 LRU，视口/Inspector 使用中的值另计；返回快照不保留值正文，恢复后按 NodeId 重读 | Entry 43；Tree 48 浏览器检查通过，Native 未验。Tree 的 ID、类型、路径标签、跨度、父子/展开状态与行索引按 §8.6 用户确认口径作为导航数据单独估算；`memoryUsage` 分列缓存、活动值和导航，不是实际 heap 测量 |
| Collection / Conversation / Plain | Collection 窗口、Conversation block 窗口和 Plain text line window 已有实现及局部证据；不据此宣称所有列表或 Code 窗口都已虚拟化 | 部分证据：`src/collection-list.ts`、`src/conversation-view.ts`、`src/text-line-view.ts`、`docs/native-acceptance.md` |
| Content text cache | Decoded / Raw / Nested 共用 32 MiB 文本预算，跨缓存 LRU；可见页保留，已淘汰页按偏移重读，Nested CRLF 检查点与正文分离 | `1f96dd0`；独立文本压力 18、真实 CRLF 重读 8 项及构建通过；估算 UTF-16 正文和条目开销，不等于 WebView heap 测量；导航元数据按 §8.6 不计入缓存限额，全应用统计仍未完成 |
| Code | 支持 Python、JavaScript、TypeScript、Rust、C、C++、Java、Go、Shell、SQL、JSON、YAML；自动猜语言上限 256 KiB，高亮上限为 1 MiB 或 20,000 行，超限退回 Plain Code window | `ace1f24` 已实现超限窗口；独立 wrap 90、Rendered 61 自动化通过，Native 尚未验收：`src/code-renderer.ts`、`src/content-viewer.ts` |
| Markdown | 自动渲染上限 2 MiB；显式继续渲染上限 32 MiB；链接显示为文本、图片为占位，raw HTML 不执行 | 已实现但安全 Native 五零证据未闭环：`src/content-viewer.ts`、`src/markdown-renderer.ts` |
| HTML | HTML Preview 输入上限 512 KiB，输出上限 1 MiB；HTML 自动启发式检测上限 64 KiB | Core/浏览器路径已有边界；Native 五项零证据仍未闭环：`src/content-viewer.ts`、`src-tauri/src/html_sanitizer.rs`、`src-tauri/src/semantic_detection.rs` |
| Nested JSON | 单层 2 MiB、累计 8 MiB；默认深度 5，UI 可选 1–10，变更时从嵌套根重新打开；`4a090e6` 的原 Native tabs FAIL 仍待复测 | `d9b6066`；独立 Content Viewer 144、Parsed Search 32 通过，Native 仍不完整：`docs/native-acceptance.md` |
| 搜索历史 | Source / Rendered Search 各自最多保留 16 页并有估算字节上限；淘汰正文与游标，Previous 缺页可取消地重扫，不限制可访问的历史深度 | `5609b71`、`ba99a6b`、`47653aa`；Source 英文 133/中文 8、Rendered 113 通过，同目标重入已关闭；`af42714` 将 Viewer 内部 Source/Rendered 接入 main 同一 ProjectionBudget，独立跨组件压力 8 项通过 |
| Conversation Projection | Conversation 内联/工具投影与主搜索、Viewer 搜索、Tree 离屏值共享 ProjectionBudget；以 ledger/条目估算非 WebView 实际 heap，不宣称 WebView 私有堆 | `e229e0f`、`af42714`；ledger 15、Conversation 10 的独立回归通过；Collection 仍为局部三页保留、尚未接入共享账本，因此不能宣称全前端 32 MiB 已达标 |

Conversation 分页历史现在最多保存 16 个游标检查点；更早的 Previous 从最近可用检查点（或根）重扫，不限制返回深度。重扫失败保留当前页，关闭/切换上下文使迟到结果失效。`test-conversation-projection-budget.mjs` 53 项、现有 Conversation UI 96 项及构建通过；这是浏览器证据，非 Native 全面验收。

## Entry hint、国际化与平台

| 范围 | 当前行为 | 状态与证据 |
| --- | --- | --- |
| Event Stream hint | Core hint 和 summary 路径已提交；`f06d3dc` 已实现 Auto / Generic / Event UI，headless 25 项断言和 main 集成通过 | UI 已提交、Native 未验：`src-tauri/src/event_hint.rs`、`src/entry-list.ts`、`docs/native-acceptance.md` |
| i18n | 壳、列表、Tree、Raw、搜索、Viewer 和 Conversation 已有中英文资源；源角色、路径、协议字段不翻译。底层错误原文与完整 Native 发布文案仍需最终审计 | `68b019b`、`9f643f4`、`23478b9`；独立 Conversation 英文 96/中文 10，Viewer 144、Parsed Search 32 及资源检查通过；Native 实证仍以 `docs/native-acceptance.md` 为准 |
| Main IPC 错误 | 稳定 code 的标题/操作说明本地化，原始 diagnostic 保留；`invalid_json` 继续使用共享 parse formatter，未知 code 回退原文 | `87987b1`；真实 Main 英文 4、中文 8 通过，Native 错误入口仍未验 |
| macOS | 有 macOS arm64 Native 局部真实证据；`4a090e6` 的 Nested tabs 自动化修复已通过，但原 Native FAIL 尚未复测关闭 | 部分验收：`docs/native-acceptance.md` |
| Linux | Linux 参考环境的 cold/warm、fresh 五轮、private-memory 和完整性能门槛尚未测 | 未验：`docs/performance-baseline.md` |
| Windows | `320af83` 已补 FileSource 的平台读取分支；本机回归通过，但未进行 Windows 编译、运行或安全验收，不先列为已支持 | 未验：`src-tauri/src/file_source.rs` |

## 明确排除（v0.1）

不支持或不进入本版本：JSON 编辑、保存/重写、目录批量打开和多文件 Tab、stdin、tail、gzip/zstd 解压、Query Language、全文件 JSONPath、Semantic Search、跨 Entry 聚合/字段统计、远程图片，以及 spec §24 列出的其他扩展能力。这里的“排除”是范围边界，不代表未来实现不存在价值。
