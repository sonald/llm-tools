# ModelFiles 诊断工作台验收记录

当前结论：**Phase 1 PASS；Phase 2 / Phase 3 尚未开始**

日期：2026-08-20

验收基线：`main` / `ea916c0fab305081f8715e58214fc825729af674`

环境：macOS 26.6.2（25G83），Apple Swift 6.3.3，arm64。

## 1. Phase 1 — 试验台取证

### 1.1 实现契约

| 行为 | 结果 | 证据 |
|---|---|---|
| Token ID parser 支持逗号、空白、换行与 JSON 数组 | PASS | `TokenIDParserTests`：6/6；非法、负数、溢出均带 index，64 KiB 上限生效 |
| `inspect()` 只保留 added_tokens 小摘要与最长 50 条 | PASS | `TokenizerInspectorTests`；`TokenizerVocabularyAnalysis` 无 full entries；Qwen3 概览显示 151,643 base vocab、26 added tokens |
| 字符串、字典、named 数组模板 catalog 与空项回退 | PASS | `ChatTemplateCatalogTests`：10/10；未知形态明确失败，全空时 catalog 不可用 |
| ID 反解与 special flags | PASS | `TokenizerRuntimeTests`：20/20；BPE/Unigram 往返、WordPiece/BPE special、未知 ID、空数组、multi-ID special 均锁定 |
| special 热路径不逐 token decode | PASS | BPE、Unigram、WordPiece、ByteFallback fixture 的 fallback count 均为 0；仅 unknown/nil piece 走冷兜底 |
| 第三输入模式 `Token IDs` | PASS | 真实 App `[15, 22]` 与 Qwen3 ID 列表均成功反解；Raw 切回后恢复 encode；无 Chat 模板仍可用 |
| segment / Token 表 / ID chip 共享点击选择 | PASS | 真实 App AX：点击任一路径后相同 index 同时为 `(selected)`；再次点击取消；新结果清空选择 |
| Token 表显示 `Special` / `Role` | PASS | 真实 App AX 表头与行标签；Qwen3 `<|im_start|>` / `<|im_end|>` 标为 special，正文与模板角色分开 |
| Chat 开销差量 | PASS | Qwen3 真实 App：总计 30、正文 17、模板开销 13；负差量 fixture 显示“无法按差量拆分”，不显示负数 |
| Exact 角色切分 | PASS | Qwen3 真实 App为 Exact；system/user 正文按角色标记，模板壳标记 `template`；Decoded only 明确说明不能划分 |
| jinja / config / named 来源切换 | PASS | 真实 App 默认 `chat_template.jinja`；空 `default` 在菜单中 disabled；切到 `tool_use` 后胶囊和渲染结果同步变化 |
| 缺 `tokenizer_class` 显式恢复 | PASS | 真实 App先显示 recoverable error；点击 `GPT2Tokenizer` 后进入 ready，并显示所用 override |
| class 覆盖不写回文件、不静默降级 | PASS | 四个 1.3.3 实际 class 通过；unknown class仍失败；config Data字节不变；源码无 `strict:false` |
| tokenizer.json 词表按需搜索 | PASS | 未查询时只显示 special 摘要、最长 token 与提示；Qwen3 查询 ID `56940` 后得到 1 条；index 不在 Store |

### 1.2 自动化测试与构建

标准离线测试：**119 tests，2 个明确的非 CI 环境项 skipped，0 failures，exit 0**。

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

跳过项：

- `MODELFILES_REAL_TOKENIZER_DIR` 未设置。
- `MODELFILES_REAL_SENTENCEPIECE_DIR` 未设置。

真实 Qwen3 已通过 App 路径独立覆盖，不把上述显式非 CI skip 记为执行成功。

Bundle 验证：**PASS，exit 0**。

```text
tools/model-files/dist/ModelFiles.app/Contents/Info.plist: OK
Verified tools/model-files/dist/ModelFiles.app
git diff --check: PASS
```

### 1.3 真实 App 证据

通过当前 `dist/ModelFiles.app` 和 macOS Accessibility 树验收；验收后恢复原仓库输入并终止本次启动的 dist 进程。

#### Qwen3 / ModelScope

仓库：`Qwen/Qwen3-4B`，ModelScope `master`；`tokenizer.json` 11.4 MiB，短 SHA `aeb1330`。

| 检查 | 实际结果 |
|---|---|
| 未查询的 tokenizer.json 概览 | 151,643 base vocab、26 added tokens；special 摘要与最长 token 可见；普通全表未渲染 |
| 按需查询 | 输入 ID `56940` 后显示 1 条匹配；首次查询约 3 秒内完成，界面保持响应 |
| Chat 来源 | `tokenizer_config.json · default` |
| 权威渲染串 | 165 UTF-8 bytes |
| Token 数 | total 30 / content 17 / template overhead 13 |
| 映射 | Exact |
| 角色 | `system` / `user` 正文与 `template` 壳逐 token 可见 |
| special | `<|im_start|>` ID 151644、`<|im_end|>` ID 151645 可见 |

ID 往返抽查：把上述 encode 结果前 9 个 ID
`[151644, 8948, 198, 2610, 525, 264, 63594, 17847, 13]`
切换到 Token IDs 模式后，App 显示 9 items、47 bytes，并反解为以
`<|im_start|>system\nYou are a concise assistant.` 开头的文本；direction 文案为“由 Token ID 解码”，roles 为 nil。

#### 显式 tokenizer_class

临时本地 fixture 仅从现有 BPE fixture 复制并删除 `tokenizer_class`；未修改仓库 fixture。

- 初始严格构造显示：`The tokenizer class is not specified in the configuration.`
- UI 显示四个已验证候选和自由输入。
- 点击 `GPT2Tokenizer` 后恢复编码，状态为 `使用指定的 tokenizer_class=GPT2Tokenizer`。
- 临时目录验收后已删除。

#### 模板来源与空项

临时本地 fixture 同时包含 jinja 与 config named templates：

- 默认胶囊：`chat_template.jinja`。
- 菜单：空 `tokenizer_config.json · default` 显示 disabled。
- 选择 `tokenizer_config.json · tool_use` 后，渲染串切换为 `TOOL …`。
- 该样例 content probe 大于 total 时，UI 显示“无法按差量拆分”。
- 临时目录验收后已删除。

### 1.4 Never / 范围抽查

| 边界 | 结果 | 证据 |
|---|---|---|
| 不新增依赖 | PASS | `343aadf..ea916c0` 未修改 `Package.swift` / `Package.resolved` |
| 不使用 `strict:false` | PASS | `Sources` / `Tests` 搜索无命中 |
| 全量 vocab 不进 Store / inspect summary | PASS | `vocabularyIndex` 只在 Inspector API 与 `TokenizerJSONView @State`；Store 无引用 |
| 不读取权重 | PASS | 真实 Qwen3 仅打开 tokenizer 入口；loader/access 既有边界测试保持通过，未选择权重文件 |
| 不新增 perspective / provider / 第二套 Jinja | PASS | 顶层仍使用既有 `.playground`；实现复用 `swift-jinja` 与具体值类型 |

### 1.5 已知环境观察

全量测试在多次并发作者验收中偶发卡在既有
`SSHProcessRunner.waitUntilExit()`；一次 `sample` 栈定位到
`DirectoryRepositoryAccess.swift:426/495` 的 SSH 取消测试，而非 T0–T8 路径。
主代理清理孤儿测试/App 进程后，最终 Checkpoint A 全量命令以 exit 0 完成。
未在 Phase 1 提交中夹带 SSH runner 修复。

### 1.6 Phase 1 原子提交

| 任务 | Commit |
|---|---|
| T0 诊断基础模型、parser、special 摘要、catalog | `345e874` |
| T1 ID decode 与 special flags | `d4ad1f1` |
| T2 Token IDs 输入模式 | `04b406b` |
| T3 选择联动与 Special 列 | `c1e5922` |
| T4 Chat 开销差量 | `c0e9d26` |
| T5 Exact 角色切分 | `638c153` |
| T6 模板来源 catalog | `34f2189` |
| T7 tokenizer_class 显式恢复 | `be7272f` |
| T8 按需词表索引与搜索 | `ea916c0` |

## 2. Phase 2 — 仓库一致性

**PENDING：等待 Checkpoint A 人工确认后开始。**

## 3. Phase 3 — 对照

**PENDING：等待 Checkpoint B 人工确认后开始。**
