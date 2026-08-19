# ModelFiles 诊断工作台：功能说明

状态：待确认（已吸收 2026-08-19 计划评审）  
日期：2026-08-19  
适用范围：原生 macOS `tools/model-files`  
前置文档：

- [Tokenizer Playground 实施方案](tokenizer-playground-implementation-plan.md)
- [格式检查架构与交互设计](format-support-design.md)
- [本地目录与 SSH 目录加载](local-ssh-source-design.md)
- [实施计划](diagnostic-inspector-implementation-plan.md)

Web 版 `tools/model-files-web` 不在本次范围。原生验收通过后再单独立项移植。

给实施 / 评审 Agent 的阅读顺序：§1–2 边界 → §6 命令与代码位置 → §7.3 flags 热路径 → §7.7 词表索引保留策略 → §8.2 一致性读哪些东西 → §10 领域模型 → 实施计划任务 T0 / T1 / T8 / T9。不要从 `inspect()` 的摘要结构推断「词表已经全量在内存里」。

## 1. 结论

ModelFiles 下一阶段不再扩文件格式，而是把已经打开的仓库讲清楚。产品从「能查看」变成「能诊断」。

分三期，顺序固定：

1. **试验台取证**：同一段输入里，token 从哪来、ID 反解成什么、缺 `tokenizer_class` 时如何显式补上。
2. **仓库一致性**：打开仓库后核对 `config` / tokenizer / 已检查的 GGUF 是否在讲同一件事。
3. **对照**：同一输入跑两个 tokenizer 或两套模板，解释行为差异。

三期都保持既有身份：只读、不读权重、不跑推理、不成为下载器。第一期可以独立交付；后两期建立在第一期的结果模型上。

## 2. 假设

写本说明时采用以下假设。若其中一条不成立，先改本文再实施。

1. 目标用户首先是调试 tokenizer / chat template 的人；打开仓库做收录检查的人是第二用户。
2. 继续只做原生 macOS 应用。不在本计划中改 Web 版、不加 CLI、不加深链接协议。
3. 不增加依赖。继续使用 `swift-transformers` 1.3.3、`swift-jinja`、`swift-sentencepiece` 0.0.6。
4. 不为 GLM 等模板再写第二套 Jinja 解释器。渲染失败保持失败，并让失败更可读。
5. 不静默猜测 `tokenizer_class`。用户必须显式选择后才重试。
6. Token 消耗归因分两层：差量开销始终可算；按角色着色只在 `Exact` 映射下提供。BPE 不可组合，开销数字允许标记为近似。
7. 一致性检查不自动读取尚未打开的 GGUF 前缀。GGUF 校对只使用当前会话里已经检查过的文档。
8. 对照不把 `ModelFilesStore` 改成双仓库浏览器。主快照仍是一个；对照会话只额外加载 tokenizer bundle。
9. 现有安全上限不变：tokenizer bundle 32 MiB，试验台输入 64 KiB UTF-8，普通文件 32 MiB。
10. 本说明确认前不写生产代码。
11. `TokenizerInspector.inspect` 继续只保留统计值与最长 50 条 token，不把 `model.vocab` 全量挂在概览上。搜索和词表差集走独立的按需索引，见 §7.7。
12. 特殊 token 标记按 ID 集合查询，禁止在热路径上对每个 token 调用一次 `decode`。见 §7.3。

## 3. 问题

当前试验台能回答「这段文本被切成了哪些 token」。它还不能回答下面这些实际会出现的问题：

- 这 180 个 token 里，有多少是模板壳、多少是用户正文、哪些是特殊 token。
- 日志里的 `151644, 8948, …` 还原成什么。
- 点一个着色片段时，Token 表和 ID 列表没有跟着定位。
- GPT-2 这类缺少 `tokenizer_class` 的仓库直接 UNSUPPORTED，没有可恢复路径。
- `config.json` 的 `vocab_size`、tokenizer 词表大小、GGUF embedding 行数互相矛盾时，用户得自己心算。
- 微调前后、两套 named template、两个仓库的 tokenizer，无法并排放同一段输入。

这些都不必读权重。缺的是把已经在读的文件当成诊断对象。

## 4. 目标用户与成功标准

### 4.1 用户

| 用户 | 场景 | 成功时的感觉 |
| --- | --- | --- |
| Tokenizer / 模板调试者 | 改消息、改 tools、对照模板 | 能指出多出来的 token 属于哪一段，并能从 ID 反推文本 |
| 模型收录 / 评估者 | 打开一个 Hub 或本地目录 | 十秒内看到架构、词表是否对得上、缺什么关键文件 |
| llama.cpp / 本地 GGUF 使用者 | 已经点开过 GGUF | 一致性报告能用已有 metadata 做上下文和词表校对 |

### 4.2 成功标准

第一期完成后：

- Chat 模式下能看到「总计 / 正文 / 模板开销」三个数字；`Exact` 时着色片段可按角色区分。
- 可以粘贴 token ID 列表并看到解码文本和片段。
- 片段、Token 表、ID 列表共享同一个选中 token。
- 缺少 `tokenizer_class` 时可以显式选择已知类型后加载，选择过程写入状态，不写回仓库。
- 标准测试离线通过；不把 UNSUPPORTED 标成成功。

第二期完成后：

- 打开含 `config.json` 与 `tokenizer.json` 的仓库后，一致性报告给出词表校对结果。
- `vocab_size` 与 tokenizer 词表项数不一致时，报告为警告，而不是只在两份 JSON 里各显示一个数字。
- 未打开过的 GGUF 不会被后台下载。

第三期完成后：

- 同一快照内两个 tokenizer，或主快照与另一个仓库的 tokenizer bundle，可以对同一权威输入编码。
- 对照结果同时给出 token 数差、ID 序列是否相同、词表差集规模。

## 5. 产品身份与边界

### Always

- 只读检查。不修改、上传、删除仓库文件。
- 不读取 tensor 数据，不反序列化 PyTorch / ONNX / pickle。
- 编码继续 `encode(text:addSpecialTokens:false)`。Chat 的权威输入仍是可见的渲染字符串。
- `Exact` 与 `Decoded only` 继续显式区分。没有原文偏移时不假装有。
- 切换文件或仓库时取消进行中的加载与编码；旧结果不得覆盖新选择。
- 标准测试不访问网络、不依赖用户 Hub 缓存。

### Ask first

- 新增第三方依赖。
- 给 Web 版同步功能。
- 私有仓库 token / Keychain。
- 为一致性检查自动读取 GGUF 前缀。
- 把对照升级成第二个完整文件浏览器。
- 放宽 32 MiB / 64 KiB 上限。

### Never

- 模型推理、聊天、logits、价格、剩余 context 计算器。
- 下载器、同步器、量化器、转换器。
- 插件 SDK、通用 VFS、tokenizer provider 注册表。
- 静默 `strict:false` 或静默填写 `tokenizer_class`。
- 为个别模板维护第二套 Jinja 实现。
- 自动聚合多个权重分片。

### 明确不做（本程序）

| 想法 | 原因 |
| --- | --- |
| 词表研究原型的完整 A/B/C 方案 | 第一期只把现有概览补上搜索；完整研究页单独立项 |
| SafeTensors / GGUF 按层折叠与量化饼图 | 有价值，但不阻塞诊断主线 |
| 本地目录监听、CLI、`modelfiles://` 深链接 | 工作流打磨，不改变诊断能力 |
| 权威字节 / 字符 offset 列 | 上游公开 API 仍不足，延续第一版试验台决定 |

## 6. 工程约定

### 技术栈

- macOS 15+，Swift 6，SwiftUI + AppKit
- 依赖锁定：`swift-transformers` 1.3.3、`swift-sentencepiece` 0.0.6、`swift-jinja` ≥ 2.4.1、Textual ≥ 0.5.0

### 命令

```bash
cd tools/model-files

# 构建并运行
./script/build_and_run.sh run

# 仅校验 app bundle
./script/build_and_run.sh verify

# 标准测试（离线）
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

单测过滤沿用现有 `--filter` 模式，例如 `TokenizerRuntimeTests`。

### 代码位置

```text
Sources/ModelFiles/Models/          结果与报告的值类型
Sources/ModelFiles/Services/        RepositoryService、TokenizerBundleLoader、目录/SSH/Hub 读取
Sources/ModelFiles/Support/         纯解析 / 归因 / 一致性 / 词表索引，无 SwiftUI
Sources/ModelFiles/Stores/          ModelFilesStore 状态与取消
Sources/ModelFiles/Views/           试验台、config 摘要、对照 UI
Tests/ModelFilesTests/              离线 fixture 与单元测试
docs/                               本说明、实施计划、验收记录
```

标准测试命令与 README 一致。沙箱下缺少模块缓存环境变量会失败，实施计划里的每一条验证命令都必须带这两项，禁止写成裸 `swift test --package-path ...`。

新增逻辑优先放进 `Support/` 下的具体类型（如 `TokenAttributor`、`TokenIDParser`、`ConsistencyAnalyzer`），不要先加 protocol。现有格式检查已经用 enum + switch，本程序保持同一风格。

### 代码风格

领域结果是值类型，带 `Sendable` 和 `Equatable`。推导值必须带来源，沿用 `InspectionField.Origin`：`embedded` / `derived` / `repository` / `runtime`。

```swift
struct TokenOverhead: Sendable, Equatable {
    let totalCount: Int
    let contentCount: Int
    let templateCount: Int
    let isApproximate: Bool
    let contentProbe: String
}
```

UI 不重新编码；片段、表格、ID 列表、角色色全部从同一份 `TokenizationResult` 派生。

### 测试策略

| 层 | 覆盖 |
| --- | --- |
| 单元 | ID 解析、开销差量、Exact 角色切分、特殊 token 识别、一致性规则、词表差集 |
| Fixture | 现有 BPE / WordPiece / Unigram / byte-fallback；新增带 `added_tokens`、named template、词表不一致的小型 JSON |
| 应用验收 | 每期结束后按 `tokenizer-playground-acceptance.md` 的格式补一份真实 App 记录 |
| 非 CI | 真实 Qwen3 / GLM tokenizer 的开销与对照；缺 class 的 GPT-2 显式重试 |

测试不提交模型权重或大体积 Hub 缓存。

## 7. 功能一：试验台取证

入口不变：选中 `tokenizer.json` 或 SentencePiece `.model`，顶层「试验台」。不新增 `InspectionPerspective`。

左侧输入模式从两种变成三种：

```text
原始文本 | Chat 对话 | Token IDs
```

Chat 在没有可用模板时禁用，行为与现在相同。Token IDs 始终可用。分段宽度从现在的 174 点加到能放下三个标题，窄窗口允许折到下一行，不得因此裁掉第三项。

### 7.0 试验台界面合同

布局保持现有左右栏，不改为对话优先或三列取证。

| 区域 | 现在 | 第一期之后 |
| --- | --- | --- |
| 左上输入 | 原始文本 / Chat | 增加 Token IDs。Chat 无模板时该项 disabled，Token IDs 永远 enabled |
| 左下权威文本 | 「送入 tokenizer 的文本」 | encode：标题不变。decode：标题改为「解码文本」，只读，内容为 `decodedText` |
| 右上指标 | Token count、Unicode 字符、Bytes / token | Chat encode 增加第二行：正文 token、模板开销（近似）。负差量显示「无法按差量拆分」，不显示负数。Raw / IDs 模式没有第二行 |
| 分词结果头 | 片段 / Token 表、显示空白符 | 增加来源映射文案；Decoded only 的 Chat 在结果区顶部一句「不能按原文划分角色」 |
| 片段 | hover 选中 | 点击选中（再点取消）。hover 可作预览，但不能是唯一选中手段。选中项描边；角色色条 3 pt 在左侧。special 细描边 |
| Token 表 | # / ID / Piece / Decoded / Mapping | 增加 Special；T5 后再加 Role。点击行选中 |
| Token IDs 面板 | 纯文本 + 复制 | 每个 ID 可点击；与表、片段共享 `selectedTokenIndex` |
| 输入区状态 | 模板错误时清掉 token | 保持。ID 解析错误不调用 runtime，右侧显示 parser 错误 |

`tokenizer_class` 覆盖控件只出现在「可恢复的 class 失败」状态，成功加载后收成状态栏一句「使用指定的 tokenizer_class=…」，不要常驻在就绪界面。

模板来源胶囊在 Chat 模式输入头：`chat_template.jinja` 或 `tokenizer_config.json · <name>`。并存时胶囊可点开切换。named 列表含空模板的项显示为不可用并自动跳过，见 §7.5。

### 7.1 Token ID 反解

用户粘贴整数列表，应用解码并展示片段。

接受的输入：

- `151644, 8948, 198`
- 空白或换行分隔
- JSON 数组 `[151644, 8948, 198]`

拒绝：空列表、非整数、负数、超过 `Int` 的数字、UTF-8 超过 64 KiB。错误信息指向具体失败 token，不整段静默截断。

运行时新增：

```swift
func decode(_ tokenIDs: [Int]) throws -> TokenizationResult
```

Hugging Face 后端用现有 `decode(tokens:skipSpecialTokens:false)` 和 `convertIdsToTokens`。SentencePiece 后端用现有 `decode` / `idToToken`。分段算法复用 `makeSegments`。

结果方向需要可区分：

```swift
enum TokenizationDirection: Sendable, Equatable {
    case encode
    case decode
}
```

反解结果的 `sourceMapping` 固定为 `decodedOnly`。界面文案为「由 Token ID 解码」，不要写成 Exact。左侧「送入 tokenizer 的文本」在该模式下改为只读的解码全文，标题改为「解码文本」。

未知 ID：后端若把它映射为 UNK 或抛错，把错误显示在试验台状态，不丢弃其余 ID。若上游把未知 ID 解码成替换字符，结果仍展示，并在状态中说明存在未知 ID。

### 7.2 选择联动

`TokenizerPlaygroundView` 已有 `selectedTokenIndex`。把它变成三种结果视图的共享选择：

- 片段：hover 或点击选中该 segment 的起始 token。
- Token 表：点击行选中对应 index。
- Token IDs：每个 ID 可点击；选中项高亮。

选中态用点击切换，hover 不再是唯一入口。再次点击同一 token 取消选择。切换输入、重新编码后清空选择。

Token 表不新增 Bytes / offset 列。可新增一列 `Role`（见 7.4）和一列 `Special`（见 7.3），因为这两列可以从本程序自己的结果模型得到，不依赖上游 offset API。

### 7.3 特殊 Token 标记

从当前 bundle 收集特殊 token 字符串，不调用新的上游 API：

1. `tokenizer_config.json` 的 `bos_token` / `eos_token` / `pad_token` / `unk_token` / `cls_token` / `sep_token` / `mask_token`，以及 `additional_special_tokens`。
2. `tokenizer.json` 的 `added_tokens` 里 `special == true` 的 `content`。`added_tokens` 通常几十条，解析结果可以挂在概览上；这不是 `model.vocab`。
3. 若 token 是对象（带 `content` 字段）而不是字符串，取 `content`。

匹配结果写入：

```swift
struct TokenFlags: Sendable, Equatable {
    let isSpecial: Bool
    let specialName: String?
}
```

`TokenizationResult.flags` 与 `tokenIDs` 等长。UI 在片段上用细描边表示 special，在表中用 `Special` 列显示名称或「—」。

SentencePiece 没有 `added_tokens` 时，只使用 config 中能解析出的特殊字符串；解析不到就全部为非 special，不猜测。

#### 热路径（必须按此实现）

禁止对每个输出 token 调用一次 `decode`。64 KiB 输入可以到上万 token，逐个 decode 会把试验台打卡。

`TokenizerRuntime` 构造完成后、第一次 `tokenize` / `decode` 之前，用 `SpecialTokenIndex` 做一次预处理：

1. 收集特殊字符串（及可选的 `added_tokens.id`）。
2. 若 `added_tokens` 带非负 `id`，直接加入 `Set<Int>`，并记录 `id → name`。
3. 对其余只有字符串、没有可靠 id 的项，调用一次 `encode(text:addSpecialTokens:false)`。
   - 得到**恰好一个** ID：将该 ID 加入集合。
   - 得到多个 ID（例如特殊字符串被 byte-fallback 拆开）：**不要**把这些组成 ID 标成 special，否则 `<0xF0>` 这类公共字节会被误标。这类项只进入 piece 字符串表。
   - encode 失败：只进入 piece 字符串表。
4. 再把特殊字符串本身放入 `Set<String>` / 字典，供 piece 精确匹配。

每次 `tokenize` / `decode` 对第 i 个 token：

1. `tokenIDs[i]` 落在特殊 ID 集合 → special，O(1)。
2. 否则 `tokenPieces[i]` 与特殊字符串表精确相等 → special。
3. 否则非 special。
4. **仅当** piece 为 nil 或空、且 ID 未命中时，才允许对该单个 ID 做一次 decode 兜底，再和字符串表比。这是冷路径，测试里应能断言「普通 BPE/Unigram 样例的兜底次数为 0」。

预处理发生在 runtime 生命周期内一次，不在每次按键编码时重做。覆盖 `tokenizer_class` 导致 runtime 重建时，索引一起重建。

### 7.4 Token 消耗归因

Chat 模式在现有三个指标（Token count / Unicode 字符 / Bytes per token）右侧或下方增加一组开销指标。原始文本和 Token IDs 模式不显示开销。

#### 第一层：差量开销（始终计算）

构造探测字符串 `contentProbe`：

- 仅拼接当前消息里 `contentKind == .text` 的 `content`，之间用单个 `\n`。
- 不包含 role、tools、变量、模板壳。
- JSON 多模态 content 不进入 probe；它们计入模板/结构开销。

对 `contentProbe` 再跑一次 `tokenize`（同样 `addSpecialTokens: false`）。

```text
totalCount     = tokenize(rendered).tokenCount
contentCount   = tokenize(contentProbe).tokenCount
templateCount  = totalCount - contentCount
```

若 `templateCount < 0`，界面显示「无法按差量拆分」，`isApproximate = true`，不展示负数。其余情况也标记 `isApproximate = true`，因为 BPE 对前后文敏感。指标标题用「模板开销（近似）」。

`contentProbe` 和第二次编码都是 `runtime` 来源，不得写成文件内嵌字段。

Tools 开销不另开第三次编码作为默认路径。用户开关「包含 Tools」时，两次结果的 token 差已经可见；第一期不自动并排三次编码。

第二次编码必须走同一套 latest-only / generation 取消。实现上可以在一次 `tokenize` 调用内同步完成 probe，避免 Store 出现两份互相覆盖的 `tokenizationResult`。主结果永远是权威渲染字符串的编码；probe 只产生计数。

#### 第二层：角色切分（仅 Exact）

仅当主结果 `sourceMapping == .exact` 且输入模式为 Chat。

算法：

1. 在渲染字符串中，按消息顺序查找每条文本 content 的首次出现，起点不早于上一条结束位置。
2. 找不到的消息记为未匹配，不猜测。
3. 把 Exact 重建得到的字符前缀映射到 token 区间：片段文本按顺序拼接等于输入，因此可以按字符计数切到 token 边界。一个 token 不得拆开；若 token 横跨正文与模板，整颗归 `template`。
4. 未被任何正文覆盖的 token 归 `template`。
5. `isSpecial` 的 token 额外打上 special 标记，角色仍按上一步。

角色枚举：

```swift
enum TokenRole: String, Sendable, Equatable {
    case system
    case user
    case assistant
    case tool
    case template
}
```

自定义 role 字符串保留原值，UI 用同一色板循环。未匹配且非 template 的 token 不发明第四种「unknown」角色——它们就是 `template`。

`Decoded only` 时不着色角色，只保留第一层数字，并显示一句：「当前映射是 Decoded only，不能按原文划分角色。」

着色不得取代现有的 segment 调色。建议：segment 仍用浅底色区分边界；角色用左侧 3 pt 色条或文字色区分。两者同时存在时以角色色条为准，segment 底色降低对比。

### 7.5 模板来源与 named template

当前加载顺序已经是 `chat_template.jinja` 优先，否则 `tokenizer_config.json` 的字符串 `chat_template`。第一期要让这个选择可见，并覆盖非字符串模板。

`tokenizer_config.json` 的 `chat_template` 支持：

| 形态 | 处理 |
| --- | --- |
| 字符串 | 现有行为 |
| 对象字典 `{ "default": "...", "tool_use": "..." }` | named template，默认选 `default`，没有则选第一个 |
| 数组 `[{ "name", "template" }, ...]` | 同上 |

若 jinja 文件与 config 内嵌模板同时存在：

- 默认仍用 jinja 文件，与现有 loader 一致。
- 试验台输入区显示来源胶囊：「chat_template.jinja」或「tokenizer_config.json · default」。
- 提供切换。切换只影响当前会话的渲染，不写文件。

找不到可用模板时 Chat 禁用，现有行为保留。解析到 named 但当前选中名为空模板，视为该名字不可用，回退到列表中下一项；全部为空则 Chat 禁用。

### 7.6 缺少 tokenizer_class 的显式恢复

严格模式失败且原因是缺少或无法识别 `tokenizer_class` 时，试验台进入可恢复失败，而不是死胡同。

界面：

- 保留现有错误文本。
- 增加「指定 tokenizer_class 后重试」选择器。
- 预置 `swift-transformers` 1.3.3 `AutoTokenizer` 能构造的常见 class：至少包括 `PreTrainedTokenizer`、`GPT2Tokenizer`、`LlamaTokenizer`、`PreTrainedTokenizerFast` 对应的配置形态。具体名单以该版本实际能加载的类型为准，写在测试里而不是硬猜。
- 允许自由输入 class 名。

重试时在内存中把用户选择合并进 `tokenizer_config` JSON，再调用现有 `AutoTokenizer.from(..., strict: true)`。成功后状态显示「使用指定的 tokenizer_class=…」。该覆盖：

- 只活在当前 `TokenizerSessionIdentity`；
- 切换文件或仓库即丢弃；
- 不写回磁盘，不进 UserDefaults。

不得在失败时自动挑一个 class 重试。

### 7.7 tokenizer.json 概览搜索与词表索引

`vocab.json` 已有搜索。`tokenizer.json` 概览目前只有长度分布和最长 50 条 token。这是现状，不是疏漏：`TokenizerInspector.vocabularyEntries(from:)` 是私有瞬态函数，`analyzeVocabulary` 走完后只留下统计值和 `longestTokens`（最多 50）。Qwen 级词表约 15 万条字符串，不能也不应塞进每次 `inspect()` 的摘要。

第一期在概览补搜索，但必须走**独立的按需索引**，不得把全量条目加进 `TokenizerVocabularyAnalysis`。

#### API

```swift
struct TokenizerVocabularyIndex: Sendable, Equatable {
    let entries: [TokenizerVocabularyEntry] // 全量；只存在于索引对象内
    func matches(query: String, limit: Int = 1_000) -> [TokenizerVocabularyEntry]
}

enum TokenizerInspector {
    static func inspect(_ data: Data) -> TokenizerInspection
    // 语义保持现状：统计 + 最长 50 + added_tokens 摘要，不保留 model.vocab

    static func vocabularyIndex(from data: Data) -> TokenizerVocabularyIndex?
    // 失败（无法解析 vocab）返回 nil，调用方显示「当前 vocab 结构无法搜索」
}
```

`inspect` 与 `vocabularyIndex` 可以各走一遍 JSON；允许内部共用私有 `vocabularyEntries`，但 `inspect` 的返回值仍然丢掉全表。

#### 何时构建、何时释放

| 场景 | 是否构建全量索引 | 存活范围 |
| --- | --- | --- |
| 打开 `tokenizer.json` 概览 | 否。只跑 `inspect` | — |
| 用户第一次提交**非空**搜索 | 是，用视图已经拿到的 `Data`，不再读盘 | 该详情视图的 `@State`；切文件即释放 |
| 空查询 / 未搜索 | 否。不渲染 1,000 条普通 token | — |
| 一致性报告（§8） | 否。只用 `inspect` 的 `vocabCount` / `tokenCount` | — |
| 对照词表差集（§9.3） | 是，每侧最多一份 | `TokenizerComparisonSession`；关闭对照即释放 |

同时最多两份索引：当前概览搜索一份，对照右侧一份。不要按仓库缓存全部 tokenizer.json 的词表。

内存按「两个 Qwen 级字符串数组」接受。构建必须在后台（现有 `Task.detached` 解析 tokenizer.json 的方式），主线程只拿结果切片。过滤上限 1,000，文案与 `VocabView` 对齐。

#### 搜索 UI

- 按 token 文本子串或十进制 ID 过滤。
- `added_tokens` 里的 special 列表（小）和 `longestTokens`（最多 50）固定出现在结果上方，不依赖全量索引，也不被 1,000 截断藏起来。
- 索引构建中显示进度；失败显示结构无法搜索，概览其余部分仍可用。

不在第一期做完整词表研究页（分布图交互、按 Unicode 类别切片）。那是 backlog。

## 8. 功能二：仓库一致性

打开仓库后，应用根据清单里的小 JSON 做一份 `RepositoryConsistencyReport`。它不是新的顶层导航，也不取代文件检查。

### 8.1 出现位置

1. `config.json` / `configuration.json` 概览顶部增加「一致性」分组。
2. `DetailHeader` 在文件名下方用一枚胶囊显示摘要：`一致` / `N 项警告` / `检查中` / `材料不足`。
3. 没有 `config.json` 时，胶囊仍可出现（文案 `材料不足` 或 `缺 config.json`）。点开当前选中文件的详情时，一致性空状态列出缺哪些材料（至少包括 config / tokenizer / tokenizer_config / chat template 四类是否存在），不得因为没有 config 就不渲染胶囊。

不新增侧栏虚拟文件。

### 8.2 读取策略

| 材料 | 何时读 | 上限 |
| --- | --- | --- |
| `config.json` / `configuration.json` | 清单存在则读 | 普通文件 32 MiB |
| `generation_config.json` | 清单存在则读 | 同上 |
| `tokenizer_config.json` | 清单存在则读；优先与根目录或 `config.json` 同目录 | 同上 |
| `tokenizer.json` | 后台读，只调用 `TokenizerInspector.inspect` 取 `vocabCount` / `added_tokens` 摘要，**不**调用 `vocabularyIndex`，不构造 `TokenizerRuntime` | bundle 单文件 32 MiB |
| `adapter_config.json` | 清单存在则读 | 同上 |
| `preprocessor_config.json` / `processor_config.json` | 清单存在则读，分类改为 configuration 或新增 `processor` 类别 | 同上 |
| GGUF / SafeTensors | **仅** `ModelFilesStore.contents` 里已有的 `InspectionDocument` | 不新发 Range |

仓库打开后立即在后台生成报告。切换仓库取消。失败的单项标记为「未检查」，不让整份报告死亡。

`tokenizer.json` 很大时允许报告先显示 config 侧字段，词表项就绪后再刷新。不得阻塞 `config.json` 的首次展示。

### 8.3 报告内容

身份卡（有则显示）：

- 架构：`architectures[0]` 或 `model_type`
- 层数、hidden size、vocab_size
- 上下文：`max_position_embeddings` 或 `max_sequence_length`
- MoE：`num_experts` / `num_experts_per_tok`（有则显示）
- 适配器：`adapter_config.json` 的 `peft_type` / `base_model_name_or_path`
- 处理器：preprocessor 的 `image_size` 等少量关键字段，不追求覆盖所有 VLM

校对规则：

| ID | 条件 | 级别 |
| --- | --- | --- |
| `vocab-mismatch` | `config.vocab_size` 与 tokenizer 词表项数不同 | 警告 |
| `missing-tokenizer-class` | 有 `tokenizer_config.json` 但无 `tokenizer_class` | 警告 |
| `missing-chat-template` | 无 jinja 文件且 config 无 chat_template | 信息 |
| `eos-mismatch` | `generation_config.eos_token_id` 与 tokenizer eos id 能解析且不同 | 警告 |
| `context-info` | `model_max_length` 与 `max_position_embeddings` 不同 | 信息（二者经常不同） |
| `gguf-context-mismatch` | 已检查的 GGUF `context_length` 与 config 上下文不同 | 警告 |
| `gguf-vocab-mismatch` | 已检查 GGUF 中能识别的 token embedding 第一维与 tokenizer 词表项数不同 | 警告 |
| `missing-config` | 无 config.json | 信息 |

每条规则的左右值都显示出来，并标注来源（文件内嵌 / 应用推导 / 来源信息）。GGUF embedding 第一维的识别必须写死保守启发式：优先 `token_embd.weight`、`*.token_embd.weight`、`model.embed_tokens.weight`；认不出则跳过 `gguf-vocab-mismatch`，不要拿第一个 tensor 的 shape 充数。

### 8.4 分类调整

`FileClassifier`：

- `adapter_config.json` 归 configuration（若尚未命中现有 `_config.json` 规则，则显式加入）。
- `preprocessor_config.json` / `processor_config.json` 从 `.other` 挪到 configuration，或新增 `processor` 类别。若新增类别，侧栏 `visibleCategories` 必须一起改。

不在第二期做 processor 试验台。

## 9. 功能三：对照

第一、二期仍是单仓库。第三期在试验台增加「对照」，比较的是 tokenizer 行为，不是两个完整的 ModelFiles 窗口。

### 9.1 对照对象

右侧或底部出现第二列。用户选择：

1. **同快照**：当前 snapshot 中另一个 `tokenizer.json` 或 `.model`。
2. **另一仓库**：输入模型 ID / 本地路径 / `ssh://`，只加载对方的 tokenizer bundle，不替换主侧栏。

对方仓库用现有 `RepositoryService.loadRepository` + `TokenizerBundleLoader`。列出对方文件只是为了定位 playground 入口（根目录 `tokenizer.json`，否则第一个 `isTokenizerPlaygroundEntryPoint`）。不提供对方的 Markdown / GGUF 浏览。

主快照的文件选择、历史、一致性报告不受对照影响。关闭对照即释放第二 runtime。

### 9.2 共享输入

对照双方使用同一权威输入：

- 原始文本：同一段 `rawText`。
- Chat：同一组 messages / tools / 变量 / `add_generation_prompt`。双方各自用自己的模板渲染，因此渲染字符串可以不同。
- Token IDs：同一串 ID。若对方词表没有这些 ID，该侧显示解码错误或未知 ID，不中断本侧。

Chat 下双方模板来源独立（各自的 jinja / named template）。不允许在对照里再编辑对方模板源码。

### 9.3 对照结果

并排显示：

- Token count 以及差值。
- Chat 时各自的模板开销（近似）。
- 双方 ID 序列是否完全相同。
- 第一处不同的 index 和两侧 ID。
- 词表差集：仅在双方都能用 `vocabularyIndex` 解析 `tokenizer.json` 时。差集键是 **token piece 字符串**，不是 ID（同一字符串在两侧可以有不同 ID）。显示「仅左侧 / 仅右侧 / 共有」计数；列表最多 1,000 条，可搜索。SentencePiece 无法解析 JSON 词表则跳过差集，只保留编码对照。索引按 §7.7 存活，关闭对照必须释放。

不把两侧着色片段逐 token 对齐成单一时间线。BPE 切分不同时，强制对齐会撒谎。第一期的选择联动只作用于当前列。

### 9.4 容量

同时最多两个 runtime。切换对照目标时取消并释放旧的一侧。两个 bundle 各自遵守 32 MiB 上限。内存峰值按两个 Qwen 级 tokenizer 来接受；不在第三期做权重级缓存策略。

## 10. 领域模型

现有 `TokenizationResult` 扩展，不平行再造一份 UI 状态。

```text
TokenizationResult
├── direction            encode | decode
├── input                encode 时的权威字符串；decode 时用规范化 ID 文本
├── tokenIDs
├── tokenPieces
├── decodedText
├── segments
├── sourceMapping
├── flags                [TokenFlags]    与 tokenIDs 等长
├── roles                [TokenRole]?    Chat + Exact 才有，等长
├── overhead             TokenOverhead?  Chat encode 才有
└── tokenizerClassOverride String?

TokenOverhead
├── totalCount
├── contentCount
├── templateCount
├── isApproximate
└── contentProbe

RepositoryConsistencyReport
├── identityFields       [InspectionField]
├── findings             [ConsistencyFinding]
└── coverage             哪些材料已读 / 跳过 / 失败

ConsistencyFinding
├── id
├── severity             warning | info
├── title
├── left / right         InspectionField
└── detail

TokenizerVocabularyIndex
├── entries              [TokenizerVocabularyEntry]   全量，仅索引对象持有
└── matches(query, limit)

SpecialTokenIndex
├── specialIDs           Set<Int>           runtime 预处理得到
├── specialPieces        [String: String]   piece → 显示名
└── decodeFallbackAllowlist  仅 piece 为空时使用

TokenizerComparison
├── left / right         TokenizationResult
├── firstDifference      Int?
├── vocabDiff            VocabDiff?         piece 字符串差集
└── vocabularyIndexes    每侧可选一份，关闭即丢
```

`ModelFilesStore` 增加的状态应有限：

- `tokenizerClassOverride: String?`
- `consistencyReport: RepositoryConsistencyReport?`
- `comparison: TokenizerComparisonSession?`（第三期；词表索引挂在会话上，不进全局字典）

不要为角色色、搜索框、选择 index、概览词表索引增加 Store 字段。`tokenizer.json` 概览搜索的 `TokenizerVocabularyIndex` 留在 `TokenizerJSONView` 的 `@State`。

Chat 模板选择从「可选字符串」升级为值类型：

```text
ChatTemplateCatalog
├── entries              [ChatTemplateEntry]  name + source + body
├── activeID
└── conflict             是否同时存在 jinja 文件与 config 模板
```

`TokenizerBundleLoader` 仍负责读字节。解析 catalog 放在 Store 或独立纯函数，不要把 Jinja 语义塞进 loader。

## 11. 关键决策

1. **先取证，再一致性，再对照。** 对照依赖稳定的 `TokenizationResult` 和模板 catalog。一致性不依赖 runtime，也不依赖全量词表索引；词表项数用现有 `inspect()` 的 `vocabCount`。
2. **开销用差量，角色用 Exact 切分。** 差量对所有 Chat 可用，并明确「近似」。角色着色拒绝在 Decoded only 上编造原文区间。
3. **probe 编码不得取代主结果。** 用户看到的片段永远对应可见渲染字符串。probe 放在现有 encode `Task` + generation 校验里完成，不另开 `Task.detached` 绕开取消模型。
4. **GGUF 不后台偷读。** 一致性可以不完整，不能悄悄打 32 MiB Range。
5. **对照不是第二个应用。** 主 Store 单快照；第二 runtime 只为 tokenizer。
6. **class 覆盖是会话内显式动作。** 避免把错误加载伪装成仓库自己的配置。
7. **不新增 perspective、不新增插件口。** 继续 enum + 具体类型。
8. **Web 版后置。** 原生契约稳定后再移植，避免两套半成品。
9. **全量词表不进 `inspect()`。** 搜索和差集使用 `vocabularyIndex`，按需构建，最多两份，随视图 / 对照会话释放。
10. **flags 用 ID 集合，不用逐 token decode。** 多 ID encode 的特殊字符串只走 piece 表，避免把 byte-fallback 公共字节标成 special。

## 12. 风险

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| BPE 不可组合，开销为负或跳动 | 用户不信任数字 | 永远标近似；负值改为无法拆分 |
| Exact 子串匹配碰到重复 content | 角色切错 | 按消息顺序、起点单调前进；匹配失败归 template |
| `tokenizer.json` 词表解析阻塞一致性 | 打开仓库变慢 | 一致性只跑 `inspect()`；不建全量索引。后台、可取消、先展示 config |
| 全量词表常驻概览 | 15 万 String 挂在每次打开的文件上 | 索引按需；概览仍只有最长 50 条 |
| 逐 token decode 标 special | 大输入卡死试验台 | ID 集合 + piece 表；decode 只作 piece 为空的冷路径 |
| 双 runtime 内存 | 大词表 × 2 | 只允许一对 runtime；索引最多两份；关闭对照立即释放 |
| named template 形态不统一 | 解析分叉 | 三种形态写死测试；未知形态视为无模板并说明原因 |
| AutoTokenizer 对覆盖 class 仍失败 | 恢复路径空洞 | 保持失败文本；不降到 strict:false |
| GLM Jinja 仍然失败 | Chat 归因不可用 | 原始文本和 ID 反解不受影响；错误指向 parser，不换引擎 |

## 13. 开放问题

下列问题本说明给出建议取值。确认规格时若无异议，按建议实施。

1. **对照布局**：试验台内左右分栏，而不是新窗口。窄窗口改为上下堆叠。
2. **一致性是否在打开仓库时自动跑**：是，后台跑；GGUF 仍仅用缓存。
3. **tokenizer_class 覆盖是否持久化**：否，仅当前会话。
4. **自定义 role 的色板**：循环现有 segment 色板，不为每个字符串配置颜色。
5. **词表搜索是否构造完整可滚动 15 万行表**：否，截断 1,000，与 `VocabView` 相同。全量数据只存在于按需索引对象，不进概览结构。

若要改这五项，改本文第 7–9 节对应段落，不要在实现里另行解释。

## 14. 修订记录

- 2026-08-19：吸收计划评审。锁定 `inspect()` 不保留全量 vocab、`vocabularyIndex` 按需构建、flags 热路径用 ID 集合、代码位置补 `Services/`、测试命令必须带模块缓存环境变量。
