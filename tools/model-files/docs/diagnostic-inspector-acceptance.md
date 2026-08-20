# ModelFiles 诊断工作台验收记录

当前结论：**Phase 1 / Phase 2 / Phase 3 PASS；实施计划完成**

日期：2026-08-20

验收基线：`main` / `46b43e9404571a25ae853dc680fc91371267024a`

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

### 2.1 实现契约

| 行为 | 结果 | 证据 |
|---|---|---|
| 8 条一致性规则是纯分析函数 | PASS | `ConsistencyAnalyzerTests`：7/7；覆盖 config、generation、tokenizer、chat template 与 GGUF 的正反例 |
| coverage 区分 checked / missing / skipped / failed | PASS | 缺失、单材料损坏与 GGUF 未打开均有独立断言；单项失败不阻断报告 |
| Store 后台生成报告且 latest-only | PASS | `ModelFilesStoreConsistencyTests`：7/7；切换仓库后旧任务不能发布，打开新仓库立即清空旧报告 |
| 小 JSON 与 tokenizer inspect 复用现有缓存 | PASS | 同一次仓库会话不重复读取；一致性路径不构造 runtime、不调用 `vocabularyIndex` |
| 全文件 header badge 与 Config 顶部报告 | PASS | 真实 App 显示“2 项警告”“材料不足”及 popover；Config 概览复用同一报告视图 |
| GGUF 只在用户打开后加入报告 | PASS | 自动化测试锁定初始 0 reads、coverage skipped；用户选择后 coverage checked，刷新不增加 GGUF read |
| processor / preprocessor / adapter 配置归类 | PASS | `FileClassifierTests`：20/20；三类文件归 `.configuration`，未新增 category |

### 2.2 自动化测试与构建

标准离线测试：**134 tests，2 个明确的非 CI 环境项 skipped，0 failures，exit 0**。

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

跳过项仍仅为 `MODELFILES_REAL_TOKENIZER_DIR` 与
`MODELFILES_REAL_SENTENCEPIECE_DIR` 未设置；Phase 2 新增测试无 skip。

Bundle 验证：**PASS，exit 0**。

```text
tools/model-files/dist/ModelFiles.app/Contents/Info.plist: OK
Verified tools/model-files/dist/ModelFiles.app
git diff --check: PASS
```

### 2.3 真实 App 证据

通过当前 `dist/ModelFiles.app` 和 macOS Accessibility 树验收；结束后恢复
`baseten/GLM-5.2-Vision-NVFP4`，仅终止本次启动的 dist 进程并删除临时 fixture。

#### Qwen3 / ModelScope

仓库：`Qwen/Qwen3-4B`，ModelScope `master`。

- header badge 显示“2 项警告”，Config 概览与 badge popover 内容一致。
- identity：`Qwen3ForCausalLM`、36 layers、hidden size 2,560、config vocab 151,936、context 40,960。
- findings：config vocab 151,936 与 tokenizer vocab 151,643 不一致；generation EOS
  `[151645, 151643]` 与 tokenizer EOS 151,645 不一致；context 40,960 与
  tokenizer `model_max_length` 131,072 的差异以信息项呈现。
- coverage：config、generation_config、tokenizer_config、tokenizer、chat template 已检查；
  adapter_config、processor_config、GGUF 缺失。

#### 材料不足与 GGUF 按需检查

| Fixture | 实际结果 |
|---|---|
| 仅 `config.json`、无 tokenizer | header 显示“材料不足”；tokenizer 与 tokenizer_config coverage 为 missing；界面未崩溃 |
| 无 `config.json`、仅普通文本 | 全文件 header 仍显示“材料不足”；popover 明确列出缺 config 与其他 missing coverage |
| 最小合法 GGUF + config + tokenizer | 初始 GGUF coverage 为“跳过：未在当前会话打开”；选择 `model.gguf` 后变为“已检查”并显示 2 项警告 |

GGUF 两项警告的实际值：config context 4,096 对 GGUF context 2,048；
tokenizer vocab 1 对 `token_embd.weight[0]` 2。详情页同时显示“只读取 metadata 前缀”。

恢复的 GLM 仓库中，`preprocessor_config.json` 出现在配置分组；其一致性 coverage
为 processor_config 已检查，证明分类结果进入真实入口。

### 2.4 Never / 范围抽查

| 边界 | 结果 | 证据 |
|---|---|---|
| 不自动读取 GGUF | PASS | Store 测试初始 read count 为 0；真实 App 未选择时 coverage 明确为 skipped |
| 一致性不建全量词表索引 | PASS | Analyzer API 只接收 overview/material；Store consistency 测试未触发 `vocabularyIndex` |
| 一致性不构造 tokenizer runtime | PASS | Store 复用 `inspect()` 摘要；consistency 调用链不进入 `loadTokenizerRuntime` |
| 不因单材料失败丢整份报告 | PASS | malformed JSON / invalid jinja 仅把对应 coverage 标为 failed |
| 不增加分类实体 | PASS | T12 复用既有 `.configuration`，未新增 `FileCategory` |

### 2.5 Phase 2 原子提交

| 任务 | Commit |
|---|---|
| T9 一致性分析纯函数 | `644bf66` |
| T10 Store 后台一致性报告 | `00ed1cc` |
| T11 badge、popover、Config 报告与 GGUF 刷新 | `1c5e095` |
| T12 processor / adapter 配置分类 | `6b3ca5f` |

Checkpoint B：**PASS**。

## 3. Phase 3 — 对照

### 3.1 实现契约

| 行为 | 结果 | 证据 |
|---|---|---|
| 第二 runtime 会话与主状态隔离 | PASS | Store tests 锁定主 `snapshot`、`selectedPath`、result 与 consistency report 不变；右失败不覆盖左侧 |
| comparison latest-only 与释放 | PASS | slow → fast 等待旧任务完成后仍保留 fast identity；关闭、切主文件与 reset 均令 session/runtime/index 释放 |
| 同快照对照 UI 与差异摘要 | PASS | 自身对照 delta 0 / firstDifference nil；前缀与空侧边界有纯测试；左右选择状态独立 |
| Chat 两侧独立模板 | PASS | 右侧使用自己的 catalog 渲染同一 messages/tools/variables；来源切换只重算右侧；缺模板切 Raw 可原地恢复 |
| 词表差集按 piece 而非 ID | PASS | 同 piece 不同 ID 计共有；only 去重稳定排序；搜索先过滤完整集合再截断 1,000 |
| 词表索引只活在 comparison session | PASS | 两份 index、diff 或 skipped reason 只挂 session；关闭后 `comparison == nil`，Store 无额外 index 字段 |
| SentencePiece 明确跳过差集 | PASS | `.model` bytes 不进入 JSON parser，vocabulary 状态显示 skipped，编码/runtime 错误独立 |
| 跨仓库 tokenizer bundle | PASS | `loadRepository` → root tokenizer / sorted fallback → 既有 bundle loader；不写主历史与错误通道 |

### 3.2 自动化测试与构建

标准离线测试：**147 tests，2 个明确的非 CI 环境项 skipped，0 failures，exit 0**。

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

跳过项仍仅为 `MODELFILES_REAL_TOKENIZER_DIR` 与
`MODELFILES_REAL_SENTENCEPIECE_DIR` 未设置；Phase 3 新增测试无 skip。

Bundle 验证：**PASS，exit 0**。

```text
tools/model-files/dist/ModelFiles.app/Contents/Info.plist: OK
Verified tools/model-files/dist/ModelFiles.app
git diff --check: PASS
```

### 3.3 真实 App 证据

真实 UI 使用最终 `dist/ModelFiles.app` 的同一可执行文件验收。因机器上同时存在
`/Applications/ModelFiles.app` 且 bundle ID 相同，为避免 Computer Use 命中旧窗口，
验收时复制当前 dist 到临时目录，仅给临时 `Info.plist` 改唯一 bundle ID / 名称；
可执行文件与资源未改。临时 App、进程与目录均在验收后删除。

#### 同快照 tokenizer 对照

主目录：仓库内 `Fixtures/Tokenizers`，包含 BPE、ByteFallback、Unigram、WordPiece
四个真实 playground 入口。

| 检查 | 实际结果 |
|---|---|
| 对照入口 | 940 px 窗口中 Menu 可见；列出四个入口并允许选择自身 |
| BPE 对照自身（Chat） | 主 82 / 对照 82；差值 0；ID 序列相同；第一处不同为无；模板开销均为 1 |
| 左右选择隔离 | 左表 Token 0 与右表 Token 0 可分别、同时显示 `(selected)`，互不改写 |
| BPE 对 WordPiece（Raw） | 主 74 / 对照 15；差值 -59；第一处不同 index 0，ID 3 / 0 |
| 窄宽布局 | 两个 token 表上下堆叠；摘要、两表与词表区均可见、可滚动 |
| Chat 缺模板恢复 | WordPiece Chat 只在右侧显示缺模板；切 Raw 后同一右 runtime 原地恢复 74 / 15 |
| 词表差集 | 仅主 23、仅对照 8、共有 0；切“仅对照”显示 8 条；搜索 `UNK` 得到 `[UNK]` 1 条 |

#### 跨仓库路径与模型 ID

主仓库固定为本地 BPE 目录；整个过程中主侧栏仍只有
`tokenizer_config.json`、`tokenizer.json`、`chat_template.jinja`，主工具栏输入不变。

- 第二仓库输入多入口父目录时，sorted fallback 选择
  `bpe/tokenizer.json`；右标题显示 canonical 根路径与 entry path；自身结果 82 / 82，
  词表共有 23。关闭后只剩主结果。
- 第二仓库输入模型 ID `Qwen/Qwen3-4B` 时，右标题为
  `Qwen/Qwen3-4B · tokenizer.json`；Chat 为主 82 / 右 30、差值 -52、首差 index 0，
  模板开销主 1 / 右 13。右侧保留 Qwen Exact roles 与 special token 标记。
- BPE 与 Qwen 的词表差集为仅主 3、仅右 151,623、共有 20；关闭对照后主本地仓库仍未变化。

### 3.4 Never / 范围抽查

| 边界 | 结果 | 证据 |
|---|---|---|
| 不读取权重 | PASS | comparison target 只接受 tokenizer playground entry；跨仓库只调用 tokenizer bundle loader，真实验收未选择权重 |
| 不自动读取 GGUF | PASS | comparison 源码无 GGUF 路径；既有初始 0-read / skipped 测试在 147-test 全量中继续通过 |
| 不静默猜 tokenizer class | PASS | `Sources` / `Tests` 无 `strict:false`；主/右 runtime 均走严格构造，覆盖仍是显式会话动作 |
| 一致性不建全量词表索引 | PASS | `ConsistencyAnalyzer` 无 `vocabularyIndex`；Store 中该调用仅位于 comparison task |
| `inspect()` 不持有全量 vocab | PASS | `TokenizerOverview` / `TokenizerVocabularyAnalysis` 结构未增加 entries/index，最长 50 合同保持 |
| 同时最多两个 runtime | PASS | Store 只有主 `tokenizerRuntime` 与右 `comparisonRuntime`；换目标/关闭均取消并置空右侧 |
| 第二仓库不写历史 | PASS | 成功、失败与 latest-only Store 测试锁定主 input/snapshot/path/history/report/result/error 不变 |
| 不新增依赖或 provider | PASS | `3989df7..46b43e9` 未修改 `Package.swift` / `Package.resolved`；继续使用具体 Store + 既有 service/loader |

### 3.5 Phase 3 原子提交

| 任务 | Commit |
|---|---|
| T13 第二 runtime 会话 | `e3e2001` |
| T14 对照 UI、差异摘要与独立 Chat 模板 | `0446d3a` |
| T15 词表差集与 session 索引生命周期 | `d099951` |
| T16 跨仓库 tokenizer bundle | `46b43e9` |

Checkpoint C：**PASS**。诊断工作台实施计划 T0–T16 全部完成。
