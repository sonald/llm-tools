# ModelFiles 诊断工作台：实施计划

状态：待确认（已吸收 2026-08-19 计划评审）  
日期：2026-08-19  
规格：[诊断工作台功能说明](diagnostic-inspector-spec.md)  
适用基线：当前 `tools/model-files` 主分支（试验台已验收）

修订：锁定 `inspect()` 不保留全量 vocab、`vocabularyIndex` 按需构建、flags 用 ID 集合、验证命令与规格 §6 对齐、T8 升为 M、T9 依赖改准、PR7 拆成两个、T6 / Checkpoint B 补规格用例。

## 1. 结论

按规格分三期交付。每期结束时应用可运行，测试离线通过，并留下真实 App 验收记录。不在第一期预埋对照框架或一致性协议。

实施顺序跟着数据依赖，不跟着「看起来重要」：

```text
结果模型 + added_tokens 摘要 + SpecialTokenIndex + Catalog
    ├── decode(tokenIDs) + flags（ID 集合，禁止逐 token decode）
    ├── Chat 开销差量
    └── Exact 角色切分
            │
            ├── 试验台 UI（ID 模式、联动、角色、class 覆盖、模板 catalog）
            │
            ├── vocabularyIndex 按需 API + 概览搜索     ← T8，不塞进 inspect()
            │         │
            │         └── 对照词表差集（T15）
            │
            └── 一致性：只用 inspect() 的 vocabCount + T0 的 special / catalog
                    │
                    └── 第二 runtime 对照
```

`TokenizerInspector.vocabularyEntries(from:)` 今天是私有瞬态函数，分析完只留统计和最长 50 条。任何任务都不得把它「顺便」变成常驻全表。

## 1.1 标准验证命令

规格 §6 与 README 要求模块缓存环境变量；沙箱下裸 `swift test` 会失败。下文每条验证都写完整命令。在 `tools/model-files` 目录执行：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter <TestName>
```

全量测试把 `--filter` 去掉。从仓库根目录调用时，把目录换成 `--package-path tools/model-files`，缓存路径换成 `tools/model-files/.build/module-cache`。不要省略这两项环境变量。

App 校验：

```bash
cd tools/model-files
./script/build_and_run.sh verify
```

## 2. 架构调整

### 2.1 保持不动

- `RepositoryAccess` 四来源
- `InspectionPerspective` 枚举（不新增 case）
- 试验台入口：`tokenizer.json` / SentencePiece `.model`
- `encode(text:addSpecialTokens:false)` 与「可见渲染字符串是唯一权威输入」
- 32 MiB bundle / 64 KiB 输入上限
- 不引入 tokenizer provider 协议
- `TokenizerInspector.inspect` 的摘要合同：统计 + 最长 50 + 字段列表。全量 `model.vocab` 仍然不出现在返回值里

### 2.2 要改的缝

| 模块 | 改动 |
| --- | --- |
| `TokenizerModels.swift` | `TokenizationResult` 增加 direction、flags、roles、overhead |
| `TokenizerRuntime.swift` | `decode(_:)`；构造后预处理 `SpecialTokenIndex`（把特殊字符串 encode 成 ID 集合）；tokenize/decode 按 ID/piece 打 flags |
| `TokenizerInspector.swift` | **T0**：从 `added_tokens` 解析小摘要（id / content / special），挂到 overview，不是全量 vocab。**T8**：新增独立 `vocabularyIndex(from:)`，按需返回全表 |
| `TemplateRenderer.swift` | 不改渲染语义。named template 选择发生在调用方 |
| `TokenizerBundleLoader.swift` | 仍只读字节。catalog 解析放纯函数 |
| `ModelFilesStore.swift` | class 覆盖、一致性报告、第三期对照会话；取消语义与现有 generation 相同（`Task` + generation，probe 不另开 `Task.detached`） |
| `TokenizerPlaygroundView.swift` | 第三输入模式、指标、选择联动、来源胶囊 |
| `TokenizerTokenTableView.swift` | Role / Special 列；点击选中 |
| `DetailView.swift` / `ConfigSummaryView` / `TokenizerJSONView` | 一致性分组、词表搜索（索引留在视图状态） |
| `FileClassifier.swift` | processor / adapter 分类 |
| 新增 `Support/TokenIDParser.swift` | ID 文本 → `[Int]` |
| 新增 `Support/TokenAttributor.swift` | 开销 + Exact 角色 |
| 新增 `Support/SpecialTokenIndex.swift` | 从 config / added_tokens 建字符串表；runtime 再补 ID 集合 |
| 新增 `Support/ChatTemplateCatalog.swift` | 字符串 / 字典 / 数组；空模板回退 |
| 新增 `Support/ConsistencyAnalyzer.swift` | 纯函数：材料 → 报告。材料含 `vocabCount`，不含全量词表 |
| 新增 `Views/TokenizerComparisonView.swift` | 第三期 |

归因、flags、词表索引、一致性必须可在无 UI 的测试里跑完。视图只绑定结果。

### 2.3 Store 合同

第一期结束后 Store 对外只多这些：

```swift
func decodeTokenIDs(_ raw: String)
var tokenizerClassOverride: String? { get }
func setTokenizerClassOverride(_ name: String?)
```

`tokenize(_:)` 保持现有入口。Chat 归因参数不要散落成 8 个 `@Published`。建议：

```swift
struct TokenizerEncodeRequest: Equatable {
    var text: String
    var chatAttribution: ChatAttributionSeed?
}

struct ChatAttributionSeed: Equatable {
    var messages: [TemplateMessage]
}
```

视图继续 debounce 后调用 Store。probe 编码在**同一条 encode 任务**（现有 `tokenizerEncodeTask = Task { }` + `tokenizerEncodeGeneration`）里同步完成，主结果仍 latest-only。不要为 probe 再开 `Task.detached`；runtime 构造继续用现有的 detached。Store 只保存一份主 `tokenizationResult`。

词表索引不进 Store。`TokenizerJSONView` 用已经加载的 `Data` 在首次非空搜索时构建；对照会话自己持有最多两份。

第二期：

```swift
private(set) var consistencyReport: RepositoryConsistencyReport?
```

仓库加载成功后启动一致性任务，取消规则与 `repositoryTask` 相同。另设 `consistencyGeneration`，不要复用 encode generation。

第三期：

```swift
private(set) var comparison: TokenizerComparisonSession?
func setComparisonSource(_ source: ComparisonSource?)
```

`ComparisonSource` 为 `.snapshotPath(String)` 或 `.repositoryInput(String)`。主 `snapshot` 不变。

## 3. 分期与检查点

```text
Phase 1  试验台取证     T0–T8
Phase 2  仓库一致性     T9–T12
Phase 3  对照           T13–T16
```

任务按单次实现会话切分。标为 L 的必须再拆；本计划里没有 L。标为 M 的允许 3–5 个文件。T8 是 M，不是 S。

---

## Phase 1 — 试验台取证

### T0 — 结果模型、added_tokens 摘要与解析纯函数（M）

依赖：无。

工作：

- 扩展 `TokenizationResult`：`direction`、`flags`、`roles`、`overhead`。旧测试只编码时 `flags` 全为非 special，`roles` / `overhead` 为 nil。全代码库目前只有 Store 空结果和 Runtime 两处构造点。
- 新增 `TokenIDParser`：三种分隔、JSON 数组、错误定位、64 KiB 拒绝。
- 新增 `SpecialTokenIndex`：从 tokenizer config JSON 与 `added_tokens` **数组**提取 content / 可选 id。此步不读 `model.vocab`。
- `TokenizerInspector.inspect`：把 `added_tokens` 小摘要挂到 overview（例如 `[AddedTokenInfo]`）。**禁止**把 `vocabularyEntries` 全量存进 `TokenizerVocabularyAnalysis`。现有 `tokenCount` / `longestTokens` 行为不变。
- 新增 `ChatTemplateCatalog.parse`：字符串、字典、`[{name,template}]`；未知形态返回明确错误，而不是空目录冒充「无模板」。空字符串模板视为不可用，按规格 §7.5 回退下一项，全部为空则目录不可用于 Chat。
- 不改 UI，不实现 `vocabularyIndex`。

可能修改：

- `Sources/ModelFiles/Models/TokenizerModels.swift`
- `Sources/ModelFiles/Support/TokenizerInspector.swift`
- `Sources/ModelFiles/Support/TokenIDParser.swift`（新）
- `Sources/ModelFiles/Support/SpecialTokenIndex.swift`（新）
- `Sources/ModelFiles/Support/ChatTemplateCatalog.swift`（新）
- `Tests/ModelFilesTests/TokenIDParserTests.swift`（新）
- `Tests/ModelFilesTests/ChatTemplateCatalogTests.swift`（新）
- `Tests/ModelFilesTests/TokenizerRuntimeTests.swift`（适配默认值）
- inspector 测试（新或并入现有）

验收：

- 旧 runtime 测试全部通过。
- Parser 对非法 token 给出 index 级错误。
- Catalog 三种合法形态、一种非法形态、以及「named 中一项为空则回退、全部为空则 Chat 不可用」有固定 fixture。
- `inspect()` 之后 `vocabularyAnalysis.longestTokens.count <= 50`；用带 `added_tokens` 的 fixture 能读出 special 摘要；测试断言 overview **没有**全量 vocab 数组字段。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter TokenIDParserTests
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter ChatTemplateCatalogTests
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter TokenizerRuntimeTests
```

### T1 — Runtime 反解与特殊标记（M）

依赖：T0。

工作：

- `TokenizerRuntime.decode(_:)`。
- **flags 热路径按规格 §7.3 实现，写死如下：**
  1. runtime 构造成功后预处理一次：有 id 的 `added_tokens` 直接进 `Set<Int>`；其余特殊字符串各 encode 一次。单 ID 进集合；多 ID 只进 piece 表，不把组成 ID 标 special。
  2. 每次 tokenize/decode：先查 ID 集合，再查 piece 精确匹配。
  3. 仅当 piece 为 nil/空且 ID 未命中时，才对该 ID 做一次 decode 兜底。
  4. 测试锁：现有 bpe / unigram / wordpiece fixture 的 decode 兜底次数为 0。
- SentencePiece 仅使用能从 config 解析的特殊字符串。
- 未知 ID：按上游实际行为记录，并在结果或错误中可见；不丢弃整次解码，除非上游抛错。
- 用现有 bpe / unigram fixture 锁 decode 往返：encode 得到的 IDs 再 decode，decodedText 与第一次 decode 一致。

可能修改：

- `Sources/ModelFiles/Support/TokenizerRuntime.swift`
- `Sources/ModelFiles/Support/SpecialTokenIndex.swift`
- `Sources/ModelFiles/Stores/ModelFilesStore.swift`（`decodeTokenIDs`，可先最小接入供测试）
- `Tests/ModelFilesTests/TokenizerRuntimeTests.swift`
- `Tests/ModelFilesTests/Fixtures/Tokenizers/bpe/`（如需 added_tokens）

验收：

- fixture 中标记 special 的 piece 或 id 对应 flags 为 true。
- 未标记的普通 piece 为 false。
- 把某特殊字符串 encode 成多个 ID 的样例中，组成字节 ID 不是 special。
- decode 空数组返回 0 token，不崩溃。
- flags 与 tokenIDs 等长。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter TokenizerRuntimeTests
```

### T2 — Token IDs 输入模式（M）

依赖：T1。

工作：

- 试验台增加第三分段：`Token IDs`（规格 §7.0）。
- 解析失败显示 parser 错误，不调用 runtime。
- 超过 64 KiB 走现有 `inputTooLarge`。
- 反解成功后右侧仍是片段 / Token 表 / ID 列表。
- 「送入 tokenizer 的文本」改名为「解码文本」，只读。
- 指标不显示模板开销。

可能修改：

- `Sources/ModelFiles/Views/TokenizerPlaygroundView.swift`
- `Sources/ModelFiles/Stores/ModelFilesStore.swift`
- `Tests/ModelFilesTests/ModelFilesStoreTokenizerTests.swift`

验收：

- 粘贴 `id, id, id` 与 JSON 数组得到相同 tokenIDs。
- Chat 不可用时 Token IDs 仍可用。
- 切换回原始文本时恢复 encode 路径，不把 ID 当普通字符串编码。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter ModelFilesStoreTokenizerTests
./script/build_and_run.sh verify
```

### T3 — 选择联动与 Token 表列（S）

依赖：T2。

工作：

- `selectedTokenIndex` 改为点击选中，三处视图共享。hover 不得作为唯一入口。
- Token 表增加 `Special` 列；`Role` 列在 T5 再打开。
- ID 列表由纯文本改为可点击 chip。
- 重新编码清空选中。

可能修改：

- `Sources/ModelFiles/Views/TokenizerPlaygroundView.swift`
- `Sources/ModelFiles/Views/TokenizerTokenTableView.swift`

验收：

- 点击表中第 N 行，片段与 ID 列表同时高亮同一 token。
- VoiceOver 标签仍包含 index 与文本。

验证：真实 App 点选；`./script/build_and_run.sh run`。表的 row 构造断言 flags 等长（可放在 runtime 测试）。

### T4 — Chat 开销差量（M）

依赖：T1。

工作：

- 新增 `TokenAttributor.overhead(rendered:messages:tokenize:)`。
- Chat encode 时计算 `TokenOverhead`，写入主结果。probe 不得替换 `input` / `segments`。
- probe 在同一 encode `Task` 内完成，沿用 `tokenizerEncodeGeneration`。
- `templateCount < 0` 时 UI 显示「无法按差量拆分」。
- 指标标题含「近似」。

可能修改：

- `Sources/ModelFiles/Support/TokenAttributor.swift`（新）
- `Sources/ModelFiles/Stores/ModelFilesStore.swift`
- `Sources/ModelFiles/Views/TokenizerPlaygroundView.swift`
- `Tests/ModelFilesTests/TokenAttributorTests.swift`（新）

验收：

- 无模板壳的模板 `{{ messages[0].content }}` 且单条文本消息时，用显式 probe 字符串锁数字。
- 主结果 `input` 等于渲染字符串。
- 原始文本模式 overhead 为 nil。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter TokenAttributorTests
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter TokenizerRuntimeTests
```

### T5 — Exact 角色切分（M）

依赖：T4。

工作：

- `TokenAttributor.roles(rendered:messages:result:)` 仅在 `sourceMapping == .exact` 时返回数组。
- 单调子串匹配；失败归 `template`；token 不拆分。
- 片段视图加角色色条；Decoded only 显示说明、不着色角色。
- Token 表增加 `Role` 列。

可能修改：

- `Sources/ModelFiles/Support/TokenAttributor.swift`
- `Sources/ModelFiles/Views/TokenizerPlaygroundView.swift`
- `Sources/ModelFiles/Views/TokenizerTokenTableView.swift`
- `Tests/ModelFilesTests/TokenAttributorTests.swift`

验收：

- fixture 渲染串为 `SYS` + user 正文 + `EOS` 时，正文 token 为 `user`，壳为 `template`。
- 重复 content 按第一次未消费区间匹配。
- Decoded only 结果 `roles == nil`。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter TokenAttributorTests
```

### T6 — 模板 catalog 与来源胶囊（M）

依赖：T0、试验台 Chat 路径。

工作：

- Store 用 `ChatTemplateCatalog` 取代单独的 `tokenizerChatTemplate: String?`。
- 来源胶囊；jinja 与 config 并存时可切换。
- named template 选择器。
- 切换模板只重渲染，不重新下载 bundle。
- 空模板回退：当前选中名为空字符串则选列表中下一项非空；全部为空则 Chat 禁用（分段 disabled，与现在无模板相同）。
- `EmbeddedTemplatePlaygroundView` 可继续只用字符串。第一期以 `tokenizer.json` 试验台为准。

可能修改：

- `Sources/ModelFiles/Stores/ModelFilesStore.swift`
- `Sources/ModelFiles/Views/TokenizerPlaygroundView.swift`
- `Tests/ModelFilesTests/ModelFilesStoreTokenizerTests.swift`
- `Tests/ModelFilesTests/ChatTemplateCatalogTests.swift`
- fixture：带字典 chat_template 的小型 config；带空 named 项的 config

验收：

- 仅 jinja 文件：胶囊显示文件名，Chat 可用。
- 仅 named 字典：默认 `default`。
- 两者都有：默认 jinja，切换到 config 后渲染输出变化。
- named 中 `default` 为空、`tool_use` 非空：激活 `tool_use`，Chat 可用。
- 全部 named 为空且无 jinja：Chat 禁用，Token IDs / 原始文本仍可用。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter ChatTemplateCatalogTests
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter ModelFilesStoreTokenizerTests
```

### T7 — tokenizer_class 会话覆盖（M）

依赖：T1。

工作：

- 加载失败且与 class 相关时，试验台显示选择器 + 自由输入。
- `setTokenizerClassOverride` 合并 JSON 后 `strict: true` 重试。
- 成功状态包含所用 class。
- 切换文件丢弃覆盖。
- 不写 UserDefaults。
- 增加一个缺 class 的小型 fixture，覆盖「未选则失败 / 显式选择后成功」或「显式选择后仍失败且无静默降级」。

可能修改：

- `Sources/ModelFiles/Stores/ModelFilesStore.swift`
- `Sources/ModelFiles/Support/TokenizerRuntime.swift`
- `Sources/ModelFiles/Views/TokenizerPlaygroundView.swift`
- `Tests/ModelFilesTests/ModelFilesStoreTokenizerTests.swift`
- `Tests/ModelFilesTests/Fixtures/Tokenizers/missing-class/`（新）

验收：

- 无覆盖时行为与现有 GPT-2 UNSUPPORTED 记录一致。
- 覆盖后若仍失败，错误可见，且没有第二次自动尝试。
- 测试断言读取到的 tokenizer_config 文件内容未被修改。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter ModelFilesStoreTokenizerTests
```

### T8 — 按需词表索引与概览搜索（M）

依赖：无强制依赖。可与 T2 并行。若要用 T0 的 `added_tokens` 摘要钉在搜索结果上方，则依赖 T0；否则 T8 自己解析 `added_tokens` 数组也可以，但不要重复发明第三份结构——优先复用 T0 摘要。

工作：

这是承重 API，不是「在已有列表上 filter」。当前代码没有可搜索的全量列表。

- 新增 `TokenizerInspector.vocabularyIndex(from:)`，返回 `TokenizerVocabularyIndex`。解析失败返回 nil。
- `inspect()` 合同不变：仍然丢掉全表，只留统计和最长 50。
- `TokenizerJSONView`：搜索框；**首次非空查询**时用已有 `Data` 在后台构建索引，放在视图 `@State`；切文件释放。空查询不构建、不列出 1,000 条普通 token。
- 过滤上限 1,000；按 piece 子串或十进制 ID。
- special 摘要与最长 token 固定在结果上方，不依赖索引是否已建。
- 不把索引写入 `ModelFilesStore`。

可能修改：

- `Sources/ModelFiles/Support/TokenizerInspector.swift`
- `Sources/ModelFiles/Models/` 或同文件中的 `TokenizerVocabularyIndex`
- `Sources/ModelFiles/Views/DetailView.swift`（`TokenizerJSONView`）
- `Tests/ModelFilesTests/` inspector 索引与截断测试
- 小型 vocab fixture（可远小于 15 万，但要大于 1,000 以锁截断）

验收：

- `inspect(data).overview.vocabularyAnalysis` 仍无全量 entries 字段。
- `vocabularyIndex` 条目数等于 `vocabCount`（可解析时）。
- 按 ID 和按 piece 子串都能命中；结果 ≤ 1,000。
- 空查询不调用 `vocabularyIndex`（可用 spy / 计数包装断言），界面不展开全表。
- 同一 `Data` 第二次搜索不重新解析 JSON（视图缓存）。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter Tokenizer
./script/build_and_run.sh verify
```

### Checkpoint A — 第一期完成

- [ ] 上述过滤测试通过（均带模块缓存环境变量）
- [ ] 全量测试通过：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

- [ ] `./script/build_and_run.sh verify` 通过
- [ ] 真实 App 走查：Qwen3 Chat 开销与角色；ID 反解往返；缺 class 仓库显式重试；named / 空模板回退 / jinja 来源胶囊；tokenizer.json 搜索不在未查询时卡死
- [ ] 写 `docs/diagnostic-inspector-acceptance.md` 第一期章节
- [ ] 人工确认后再开始第二期

---

## Phase 2 — 仓库一致性

### T9 — ConsistencyAnalyzer 纯函数（M）

依赖：**T0** 的 `SpecialTokenIndex`、`ChatTemplateCatalog`，以及**现有** `TokenizerInspector.inspect` 的 `vocabCount` / `vocabularyAnalysis.tokenCount`。不依赖 T8 的 `vocabularyIndex`，不依赖试验台 UI。

工作：

- 定义 `RepositoryConsistencyReport` / `ConsistencyFinding`。
- `ConsistencyAnalyzer.analyze(materials:)` 实现规格第 8.3 节规则。
- 词表校对用 `inspect().overview.vocabCount`（或 analysis.tokenCount），禁止为一致性构建全量索引。
- eos 校对用 `added_tokens` / config 里的 id，走 T0 摘要。
- GGUF 规则只接受可选的已解析 `GGUFOverview`，analyzer 不读文件。
- embedding 第一维启发式写死并测试：命中 / 不命中都不准用「第一个 tensor」。

可能修改：

- `Sources/ModelFiles/Support/ConsistencyAnalyzer.swift`（新）
- `Tests/ModelFilesTests/ConsistencyAnalyzerTests.swift`
- 小型 JSON fixture：vocab 一致、vocab 不一致、缺 class、缺模板

验收：

- 每条规则至少一对正反 fixture。
- 缺材料时对应 finding 不出现或为 `missing-*`，不崩溃。
- 测试材料里没有 `TokenizerVocabularyIndex` 类型。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter ConsistencyAnalyzerTests
```

### T10 — 打开仓库后的后台报告（M）

依赖：T9。

工作：

- Store 在 snapshot 成功后读取 config / generation / tokenizer_config / adapter / processor（存在才读）。
- `tokenizer.json` 后台 **`inspect()`**，不 `vocabularyIndex()`，不构造 runtime。
- 独立 `consistencyGeneration`；新的 `openRepository` 使旧报告不得写回。
- 单项失败记录为未检查。

可能修改：

- `Sources/ModelFiles/Stores/ModelFilesStore.swift`
- `Sources/ModelFiles/Services/RepositoryService.swift`（仅当现有 `inspectFile` 不够用）
- Store 级测试，用现有 fake access

验收：

- 本地 fixture 仓库打开后报告非空。
- 切换仓库后旧 `vocab-mismatch` 不会闪到新仓库。
- 没有 GGUF 时不出现 gguf-* finding。
- access spy：一致性路径没有为 tokenizer.json 读第二遍全量索引所需的额外逻辑（一次 inspect 即可）。

验证：Store 测试 + 真实打开一个本地模型目录。测试命令同 §1.1。

### T11 — 一致性 UI 与 GGUF 缓存校对（M）

依赖：T10。

工作：

- `ConfigSummaryView` 顶部一致性分组。
- `DetailHeader` 胶囊：`一致` / `N 项警告` / `检查中` / `材料不足`。
- **无 `config.json` 时胶囊仍显示**，空状态列出缺的材料（规格 §8.1(3)）。
- 若 `contents` 中已有 GGUF 文档，刷新报告以纳入 gguf 规则。
- 用户打开 GGUF 后报告更新；关闭仓库清空。

可能修改：

- `Sources/ModelFiles/Views/DetailView.swift`
- `Sources/ModelFiles/Stores/ModelFilesStore.swift`

验收：

- 先打开 config，再打开 GGUF，胶囊更新且未打开过 GGUF 时没有新的 GGUF Range。
- 仓库无 config.json、有 tokenizer.json：胶囊为材料不足，说明缺 config，应用不崩溃。

验证：真实 App；access spy 单元测试。

### T12 — processor / adapter 分类（S）

依赖：无，可与 T9 并行。

工作：

- `FileClassifier` 把 `preprocessor_config.json`、`processor_config.json`、`adapter_config.json` 归入可发现类别。
- 一致性身份卡读取 adapter / preprocessor 的少量字段。
- 更新 `FileClassifierTests`。

验收：

- 这些文件出现在侧栏 configuration（或新 processor 区），不再落到 other 底部。
- 不增加 processor 试验台。

验证：

```bash
cd tools/model-files
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter FileClassifierTests
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox --filter ConsistencyAnalyzerTests
```

### Checkpoint B — 第二期完成

- [ ] 全量测试通过（带模块缓存环境变量）
- [ ] 打开 Qwen 类仓库：词表校对可见
- [ ] 打开仅 config、无 tokenizer 的目录：材料不足而不是崩溃
- [ ] 打开无 config.json、有其他文件的目录：胶囊仍在，空状态说明缺 config
- [ ] 验收记录补第二期
- [ ] 人工确认后再开始第三期

---

## Phase 3 — 对照

### T13 — 第二 runtime 会话（M）

依赖：Checkpoint A（主结果模型稳定）。建议在 Checkpoint B 之后开始，但不强制依赖一致性 UI。

工作：

- `TokenizerComparisonSession`：左侧用当前 playground runtime，右侧独立 identity / runtime / result。
- `setComparisonSource(.snapshotPath)` 经现有 loader 读同快照另一入口。
- 共享当前权威输入；右侧失败不影响左侧。
- 关闭对照释放右侧 runtime，并丢弃其词表索引。
- 独立 `comparisonGeneration`。

可能修改：

- `Sources/ModelFiles/Stores/ModelFilesStore.swift`
- `Sources/ModelFiles/Models/TokenizerModels.swift`
- `Tests/ModelFilesTests/ModelFilesStoreTokenizerTests.swift`

验收：

- 同快照两个入口可同时 tokenize 同一 raw 字符串。
- 主侧栏 `selectedPath` 仍是左侧文件。
- 取消加载不会把右侧旧结果写到新目标。

验证：Store 测试，命令同 §1.1。

### T14 — 对照 UI 与差异摘要（M）

依赖：T13。

工作：

- 试验台「对照」按钮；同快照文件选择。
- 并排 token count、差值、firstDifference。
- 窄宽度上下堆叠。
- 选择联动只作用于当前列。

可能修改：

- `Sources/ModelFiles/Views/TokenizerComparisonView.swift`（新）
- `Sources/ModelFiles/Views/TokenizerPlaygroundView.swift`

验收：

- 相同 tokenizer 对照自身：差值为 0，无 firstDifference。
- 不同输入路径（Chat 两侧模板不同）允许 count 不同。

验证：真实 App + 能锁数字的 Store 测试。

### T15 — 词表差集（M）

依赖：T13，**T8 的 `vocabularyIndex`**。升为 M：它依赖承重索引 API，不是「已有条目上 count」。

工作：

- 双方 `tokenizer.json` 可解析时调用 `vocabularyIndex`，按 **piece 字符串**做差集（规格 §9.3）。
- 显示仅左 / 仅右 / 共有计数；列表上限 1,000，可搜索。
- 索引挂在对照会话上，每侧最多一份；关闭对照释放。
- SentencePiece 跳过差集并说明原因。
- 不把索引写进 `inspect()` 摘要。

可能修改：

- `Sources/ModelFiles/Support/` 差集纯函数
- `Sources/ModelFiles/Stores/ModelFilesStore.swift` 或 comparison session
- `Sources/ModelFiles/Views/TokenizerComparisonView.swift`
- 对应测试与两个微小 vocab fixture

验收：

- 两个微小 vocab fixture 的仅左 / 仅右 / 共有计数完全锁定。
- 同 piece 不同 ID 记为共有，不记入仅左/仅右。
- 关闭对照后会话中索引为 nil。

验证：命令同 §1.1，过滤差集 / inspector 测试。

### T16 — 跨仓库 tokenizer bundle（M）

依赖：T13。

工作：

- `ComparisonSource.repositoryInput` 走 `loadRepository` + 定位 playground 入口 + `loadTokenizerBundle`。
- 对照输入不写入主仓库历史。
- 错误显示在对照列，不弹成主窗口「无法打开位置」。

可能修改：

- `Sources/ModelFiles/Stores/ModelFilesStore.swift`
- `Sources/ModelFiles/Views/TokenizerComparisonView.swift`
- 测试用 fake 第二仓库

验收：

- 主仓库仍是用户原来打开的那个。
- 对方失败时左侧结果仍在。
- 关闭对照后不保留第二 runtime（identity 重置断言）。

### Checkpoint C — 第三期完成

- [ ] 全量测试通过（带模块缓存环境变量）
- [ ] 真实 App：同仓库两个 tokenizer 或两个模板来源；再测一个第二仓库 ID
- [ ] 验收记录补第三期
- [ ] 规格中 Never 清单抽查：无权重读取、无自动 GGUF、无 class 静默猜测、一致性路径未建全量词表索引

---

## 4. 可并行

| 可并行 | 必须串行 |
| --- | --- |
| T8 与 T1–T7（T8 优先接 T0 摘要） | T1 依赖 T0 |
| T12 与 T9 | T5 依赖 T4 |
| T4 与 T2/T3（UI 不同区域） | T6 依赖 catalog + Chat 路径 |
| T15 与 T14（T15 需要 T8+T13） | T10 依赖 T9 |
| T16 与 T15 | T16 依赖 T13 |
| Phase 3 与 Phase 2 在 Checkpoint A 后理论上可并行，但同一 Store 文件冲突大，默认串行 | |

同一时期不要两个会话同时改 `ModelFilesStore.swift`。

## 5. PR 切分

每个 PR 可单独审查、单独合并。

| PR | 标题 | 包含任务 | 依赖 |
| --- | --- | --- | --- |
| PR1 | feat: tokenizer 结果模型、ID 解析、added_tokens 摘要与模板 catalog | T0 | 无 |
| PR2 | feat: token ID 反解与特殊 token 标记 | T1, T2, T3 | PR1 |
| PR3 | feat: chat token 开销与 Exact 角色切分 | T4, T5 | PR2 |
| PR4 | feat: 模板来源切换与 tokenizer_class 覆盖 | T6, T7 | PR2 |
| PR5 | feat: tokenizer.json 按需词表索引与搜索 | T8 | PR1 |
| PR6 | feat: 仓库一致性报告 | T9–T12 | PR1（不依赖 PR5） |
| PR7 | feat: tokenizer 对照核心 | T13, T14 | PR3、PR4 |
| PR8 | feat: 词表差集与跨仓库对照 | T15, T16 | PR7、PR5 |

PR5 可与 PR2–PR4 平行。PR6 不需要等 PR5：一致性只用 `inspect()` 计数。

## 6. 风险与缓解

| 风险 | 阶段 | 缓解 |
| --- | --- | --- |
| Store 承担太多异步任务互相踩 generation | 1–3 | 每种任务独立 generation：load / encode / consistency / comparison |
| 双次 encode 造成输入卡顿 | T4 | probe 在同一 encode 任务内完成；主结果仍 latest-only。不要 `Task.detached` 跑 probe |
| 逐 token decode 标 special | T1 | 构造时 encode 特殊字符串成 ID 集合；热路径只查集合和 piece；测试锁兜底次数为 0 |
| 全量词表挂上 inspect 摘要 | T8 / T15 | API 分离；T8 验收断言 overview 无全量表；一致性禁止调用 `vocabularyIndex` |
| 大词表搜索卡 UI | T8 / T15 | 后台构建、1,000 截断、未输入查询不构建 |
| 一致性读取 tokenizer.json 与试验台加载争用 | T10 | 共享 `contents` 缓存；已 inspect 的数据不要读第二遍 |
| 对照第二仓库被当成主仓库 | T16 | 对照输入独立状态，禁止写入 `repositoryHistory` |
| 角色切分被误认为权威 offset | T5 | UI 文案写「按渲染字符串切分」；Decoded only 关闭 |

## 7. 验收记录

新建 `docs/diagnostic-inspector-acceptance.md`，结构对齐 [tokenizer-playground-acceptance.md](tokenizer-playground-acceptance.md)：

- 每期一张表：行为 / 结果 / 证据
- 明确记录 PASS、UNSUPPORTED、跳过的非 CI 项
- 抽查 Never：loader spy 只允许 tokenizer / config / template / 小 JSON，不允许 `.safetensors` 数据段或 GGUF 在未选中时出现
- 抽查词表：打开 tokenizer.json 概览且未搜索时，内存中不持有 `TokenizerVocabularyIndex`

## 8. 明确不在任务里的事

不要在上述 PR 中夹带：

- Web 版移植
- CLI、深链接、目录监听
- SafeTensors 按层折叠、量化饼图
- 词表研究原型完整交互
- 把全量 vocab 并入 `TokenizerOverview` / `TokenizerVocabularyAnalysis`
- 第二套 Jinja
- 价格 / context 剩余
- `strict:false`

需要做时另开规格。
