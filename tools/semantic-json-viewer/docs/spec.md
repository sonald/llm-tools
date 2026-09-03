# Semantic JSON Viewer v0.1 Spec Rev 2

文档状态：可用于原型实现、工程拆分、测试和发布验收。

## 0. 规范用语

本文中的：

- **必须**：v0.1 发布合同，缺失即不能认为实现完成。
- **应该**：默认实现要求，只有明确记录原因时才可偏离。
- **可以**：实现可选项，不属于发布门槛。
- **不支持**：v0.1 必须明确拒绝或降级，不能静默产生错误结果。

------

# 1. 产品定义

Semantic JSON Viewer 是一个面向 LLM、Agent、训练数据、评测结果和开发日志的本地 JSON/JSONL 阅读器。

它同时处理三层信息：

```text
原始序列化
    ↓
JSON 结构
    ↓
字符串和对象的实际语义
```

传统 JSON Viewer 看到：

```json
{
  "content": "## Result\n\n```python\nprint('hello')\n```",
  "arguments": "{\"path\":\"src/main.rs\",\"recursive\":true}"
}
```

本产品默认展示：

```text
Result
──────

┌ Python ────────────────────────┐
│ print('hello')                 │
└────────────────────────────────┘

Arguments

path
src/main.rs

recursive
true
```

原始的 `\n`、`\"` 和 `\\` 始终可以在 Raw View 中查看，但不再作为默认阅读形式。

------

# 2. v0.1 产品范围

v0.1 只承诺五项核心能力：

1. 本地打开 JSON、JSONL 和 NDJSON。
2. 大型 JSONL 按 Entry 建索引、按需解析。
3. 对 Markdown、嵌套 JSON、代码和 HTML string 进行语义化展示。
4. 对常见 LLM Message、Tool Call、Tool Result 和 Thinking Block 进行 Conversation 展示。
5. 在 Semantic、Tree 和 Raw 三种视图之间无损切换。

v0.1 是只读工具：

- 不修改原文件。
- 不提供 JSON 编辑。
- 不格式化并写回 JSON。
- 不上传文件。
- 不调用远程 LLM。
- 不执行代码。
- 不自动请求 JSON 中出现的 URL。

------

# 3. 产品形态与技术边界

## 3.1 产品形态

v0.1 是本地桌面应用。

整体结构：

```text
Desktop Shell
├── Rust Native Core
│   ├── 文件访问
│   ├── 字节范围管理
│   ├── JSON/JSONL 索引
│   ├── span-preserving parser
│   ├── semantic detection
│   └── schema adapters
└── Vite / TypeScript Frontend
    ├── Virtual List
    ├── Tree View
    ├── Conversation View
    ├── Content Viewer
    └── Inspector
```

## 3.2 Rust 是否强制

Rust Native Core 是 v0.1 的强制架构决定，不只是推荐。

原因包括：

- 需要处理 GB 级文件和 64 位 byte offset。
- 需要控制 mmap、窗口读取和 page-cache 行为。
- 需要实现保留重复 key、原始数字词法和 source span 的 parser。
- Windows、Linux 和 macOS 需要共用一套核心文件逻辑。
- 不能把大型文件整体交给 WebView 或 JavaScript runtime。

桌面壳可以使用 Tauri、Wry 或具备等价安全和 IPC 能力的实现，具体 crate 在 M0 前通过 ADR 固定。产品规格不绑定某个特定 crate。

## 3.3 平台

v0.1 功能目标：

- Linux x86_64
- Windows x86_64
- macOS arm64

性能发布门槛首先在定义的 Linux 参考环境验收，其他平台必须完成功能和安全测试。

------

# 4. 文件输入合同

## 4.1 支持范围

| 输入                        | v0.1           |
| --------------------------- | -------------- |
| `.json`                     | 支持           |
| `.jsonl`                    | 支持           |
| `.ndjson`                   | 支持           |
| 无扩展名 JSON/JSONL         | 有条件自动识别 |
| JSONC                       | 不支持         |
| JSON5                       | 不支持         |
| JSON Text Sequences         | 不支持         |
| 无换行拼接的多个 JSON value | 不支持         |
| `.gz` / `.zst`              | 不支持         |
| 实时 tail                   | 不支持         |
| stdin                       | 不支持         |
| 目录批量打开                | 不支持         |
| 多文件 Tab                  | 不支持         |

## 4.2 文件模式判定算法

文件扩展名具有最高优先级。

### `.jsonl` 和 `.ndjson`

始终作为 Entry Mode 打开。

每个非空物理行是一条 Entry。

即使文件只包含一行合法 JSON object，也仍然是：

```text
Entry 1 / 1
```

v0.1 不支持跨多行的 pretty-printed JSONL record。

### `.json`

始终尝试作为一个完整 JSON 文档解析。

- 根节点为 object 或 scalar：Document Mode。
- 根节点为 array：Collection Mode。
- 整体解析失败：显示文件级 `Invalid JSON`。
- 不自动退回 JSONL 模式。

因此，pretty-printed `.json` 不会被错误地按行拆分。

### 无扩展名或未知扩展名

当文件大小不超过 128 MiB 时：

1. 先尝试完整 JSON parse。
2. 成功后根据根节点进入 Document 或 Collection Mode。
3. 失败后，再进行 JSONL sample detection。
4. 如果至少存在两条非空行，并且抽样行中至少 90% 是独立合法 JSON value，则进入 Entry Mode。
5. 否则显示无法识别，并允许用户手工选择：

```text
Open as JSON
Open as JSONL
Cancel
```

当文件大于 128 MiB 时：

1. 不尝试完整 JSON parse。
2. 抽取最多 200 条非空物理行，累计最多读取 8 MiB。
3. 如果至少 90% 的样本行是合法独立 JSON，则进入 Entry Mode。
4. 否则要求用户明确选择模式。

### 单行 JSON 的确定行为

```text
data.json      → Document / Collection
data.jsonl     → Entry Mode，1 条 Entry
无扩展名文件    → 完整 parse 成功，因此进入 Document / Collection
```

## 4.3 明确不支持的形状

以下内容不能当成普通 JSONL 自动接受：

```text
{}{}
```

即无分隔符拼接的多个 JSON value。

以下 RFC 7464 形式也不支持：

```text
0x1E {"a":1}
0x1E {"a":2}
```

应用必须显示：

```text
Unsupported JSON framing.
JSON Text Sequences and concatenated JSON values are not supported in v0.1.
```

------

# 5. 编码合同

## 5.1 支持的编码

v0.1 支持：

- UTF-8
- UTF-8 BOM
- LF
- CRLF

不做 GBK、GB18030、Shift-JIS 等编码的自动转码。

## 5.2 文件级编码错误

以下情况属于文件级错误：

1. `.json` 文件包含非法 UTF-8。
2. 任意文件带有 UTF-16 LE、UTF-16 BE、UTF-32 LE 或 UTF-32 BE BOM。
3. 文件无法按照其显式格式合同进行 UTF-8 解析。

UI 显示：

```text
Unsupported encoding

v0.1 accepts UTF-8 and UTF-8 BOM files only.
No data has been converted.
```

对于 `.json`，非法 UTF-8 会阻止 Tree 和 Semantic View，但 Raw Byte View 仍可打开。

## 5.3 JSONL Entry 级非法 UTF-8

JSONL 和 NDJSON 的行边界在原始字节上扫描，因此单个 Entry 含非法 UTF-8 时，不必拒绝整个文件。

该 Entry 状态为：

```text
Invalid UTF-8
```

此时：

- 不进行 JSON parse。
- 不进行 semantic detection。
- 不进入 Conversation View。
- 后续 Entry 继续正常浏览。

该 Entry 提供两个只读标签页：

### Lossy Text

非法字节使用 `U+FFFD` 替换，并在顶部持续显示：

```text
This is a lossy preview.
The source bytes have not been modified.
```

### Hex

按照 16-byte 一行展示：

```text
00000000  7b 22 6e 61 6d 65 22 3a  ff fe 22 78 22 7d 0a
          {  "  n  a  m  e  "  :  ..  "  x  "  }
```

支持：

- Copy Hex。
- Copy Lossy Text。
- 查看 source line。
- 查看 byte start / byte end。

不提供“复制原始二进制到文本剪贴板”，避免把二进制静默转换成文本。

## 5.4 疑似整体使用其他编码

对于没有 BOM 的 JSONL，无法可靠判断它是：

- UTF-8 文件中混入几条坏记录；
- 还是整个文件采用 GBK 等其他编码。

v0.1 不做统计编码转换。

如果前 200 条非空 Entry 中超过 20% 发生 UTF-8 校验失败，应用在文件级显示警告：

```text
Many entries are not valid UTF-8.
This file may use another character encoding.
The file remains open in byte-safe mode.
```

该警告不改变每条 Entry 的独立状态。

------

# 6. JSON 语义与无损 Parser 合同

## 6.1 Span-preserving parser 是强制依赖

Core 必须使用能够保留下列信息的 parser：

```text
NodeId
JSON kind
source_start
source_end
parent
child locator
key occurrence
raw lexeme
optional decoded value
```

不允许将以下结构作为事实来源：

```rust
serde_json::Value
```

或：

```javascript
JSON.parse(...)
```

它们可以用于局部辅助校验，但不能作为原文件的唯一表示，因为它们通常无法完整保留：

- 重复 key。
- key 原始顺序。
- `\uXXXX` 表示。
- 大整数词法。
- 浮点指数形式。
- 原始空白。
- source span。

## 6.2 Source span

节点的 source span：

- 使用半开区间 `[start, end)`。
- 包含节点自身完整 token。
- string 包含引号和转义。
- object 包含 `{ ... }`。
- array 包含 `[ ... ]`。
- 不包含节点前后的逗号和外层空白。

例如：

```json
{
  "a":  123 ,
  "b":  456
}
```

`123` 节点的 span 只对应：

```text
123
```

## 6.3 重复 key

输入：

```json
{
  "value": 1,
  "value": 2
}
```

Tree View 必须显示两个节点：

```text
value#1: 1
value#2: 2
```

两个节点具有不同 NodeId 和 source span。

对象级 Schema Adapter 在遇到依赖字段存在重复 key 时：

- 不得静默取第一个或最后一个。
- 将该对象标记为 `Ambiguous duplicate field`。
- 回退到 Generic Object View。
- 用户仍可查看全部原始内容。

## 6.4 大整数和数字

输入：

```json
{
  "id": 922337203685477580712345,
  "ratio": 1.2300e+10
}
```

必须保留：

```text
922337203685477580712345
1.2300e+10
```

Tree View 可以显示数值类别，但不能先转换成 JavaScript Number 或 f64 后再显示。

## 6.5 Raw 是原始字节

Raw View、Copy Raw 和 Copy JSON Subtree 必须直接读取 source span 对应的原始 byte slice。

禁止：

```text
parse
  ↓
构造对象
  ↓
JSON.stringify
  ↓
冒充 Raw
```

## 6.6 文件 identity

v0.1 的文件 identity 为：

```text
canonical path
+ file size
+ modification timestamp
```

平台能够稳定提供 file ID / inode 时，可以附加使用，但不是跨平台合同。

如果同一路径的 size 或 modification timestamp 变化，进入 §17 的文件变化流程。

------

# 7. 三种信息架构

上一轮评审指出 Dataset JSONL、Event JSONL 和完整 JSON Document 的导航模型不同，不能都伪装成同一种 Conversation。

## 7.1 Document Mode

适用于完整 JSON 的 object 或 scalar 根节点。

左侧显示 Outline：

```text
root
├── messages
├── metadata
└── result
```

## 7.2 Collection Mode

适用于完整 JSON 的 array 根节点。

左侧显示虚拟化 Item List：

```text
Item 0
Item 1
Item 2
...
```

即使顶层数组包含一百万个元素，也不能创建一百万个 DOM 节点。

选择 Item 后，主视图显示该 Item 的：

```text
Semantic | Tree | Raw
```

## 7.3 Entry Mode

适用于 JSONL / NDJSON。

左侧显示虚拟化 Entry List：

```text
Entry 1
Entry 2
Entry 3
...
```

空白行：

- 不计入 Entry 数量。
- 保留并显示源文件行号。

状态栏：

```text
Entry 103 / 4,238,912
Source line 109
Bytes 18320–19482
```

## 7.4 Event Stream Hint

v0.1 不自动跨 Entry 组装 Session，但可以提示“该文件可能是 Event Stream”。

只采样满足以下条件的 Entry：

- UTF-8 合法。
- JSON 合法。
- 根节点为 object。

最多采样：

```text
200 条有效 Entry
或累计 8 MiB
```

定义字段集合：

```text
Event type:
type, event, event_type, kind

Timestamp:
timestamp, time, ts, created_at, createdAt

Grouping:
session_id, sessionId,
trace_id, traceId,
run_id, runId,
conversation_id, conversationId,
request_id, requestId,
case_id, caseId

Sequence:
seq, sequence, step, step_index, index
```

定义：

- `T`：包含 Event type 字段的样本比例。
- `P`：包含 Timestamp 字段的样本比例。
- `G`：包含 Grouping 字段的样本比例。
- `R`：具有 Grouping 字段的样本中，group value 在样本内至少重复一次的比例。
- `S`：包含 Sequence 字段的样本比例。

只有样本数量至少为 10，并满足以下任一条件时，才显示 Event Stream Hint：

```text
T ≥ 70%
并且
(P ≥ 40% 或 (G ≥ 50% 且 R ≥ 50%) 或 S ≥ 40%)
```

或者：

```text
P ≥ 70%
并且
G ≥ 70%
并且
R ≥ 50%
```

仅有每行都包含：

```json
{"type":"training_sample", ...}
```

但没有 timestamp、重复 grouping 或 sequence 的 Dataset，不能被识别为 Event Stream。

Hint 只改变左侧摘要字段，例如显示：

```text
10:32:04  tool_call  session-17
```

它不改变：

- Entry 边界。
- Entry 数量。
- JSON 结构。
- Session 聚合。
- 文件内容。

用户可以在当前会话中选择：

```text
Entry Summary Mode
├── Auto
├── Generic
└── Event
```

------

# 8. Core 到 WebView 的数据合同

## 8.1 总原则

Core 保存：

- 文件句柄。
- Entry index。
- span index。
- parsed node arena。
- semantic cache。

WebView 只保存可见内容的轻量投影。

禁止把：

- 1 GiB 文件；
- 100 MiB JSON AST；
- 一百万个数组节点；
- 一万条完整 Conversation Message；

一次性序列化并发送给 WebView。

## 8.2 Child-on-demand API

逻辑 API 至少包括：

```text
open_file(path)
get_file_summary()

list_entries(start, limit)
list_collection_items(start, limit)

get_root_node()
get_children(node_id, cursor, limit)
get_node_summary(node_id)

get_conversation_blocks(scope_id, cursor, limit)

read_decoded_text(node_id, offset, length)
read_raw_slice(source_start, length)
```

## 8.3 分页常数

默认限制：

```text
Entry / Item batch:          200
Tree child batch:            200
Conversation block batch:    100
Text chunk:                  256 KiB
```

Core 可以为了满足载荷限制进一步缩小 batch。

## 8.4 IPC 载荷上限

单次 Core → WebView 响应的编码后载荷必须不超过：

```text
1 MiB
```

超过时必须返回：

```text
has_more
next_cursor
```

大型文本不得以巨大 JSON string 通过 IPC 发送。

可以使用：

- 分块 IPC。
- 只读 custom protocol。
- 等价的本地流式通道。

无论使用哪种方式，单块不超过 256 KiB。

## 8.5 前端虚拟化

以下结构必须虚拟化：

- Entry List。
- Collection Item List。
- object/array 的大型 child list。
- Conversation Message / Block。
- Content Viewer 的大型文本。

Conversation View 默认仅物化：

```text
可见 block
+ 前后各 20 个 overscan block
```

Entry List 默认 overscan 不超过 50 条。

## 8.6 缓存预算

v0.1 默认预算：

```text
Core parsed / decoded LRU:       64 MiB
Frontend projection cache:       32 MiB
Content text window:             32 MiB
单个 HTML Preview:              16 MiB
```

超过预算使用 LRU 淘汰。

淘汰 semantic cache 不得影响原始数据和 Tree 导航。

------

# 9. 核心视图

## 9.1 Semantic View

面向内容阅读。

可以展示：

- Plain Text。
- Markdown。
- Code。
- HTML Source / Preview。
- Parsed Nested JSON。
- Conversation。
- Tool Call。
- Tool Result。
- Thinking Block。

无法识别时回退 Generic Object 或 Plain Text。

## 9.2 Tree View

面向结构导航。

示例：

```text
messages             Array[124]
content              Markdown · 18.2 KiB
arguments            JSON String · Object{3}
code                 Rust · 182 lines
html                 HTML · 6.4 KiB
```

支持：

- 展开和折叠。
- 分页加载 children。
- Copy Raw。
- Copy Decoded Value。
- Copy Path。
- Copy JSON Subtree。
- 跳转到 source span。

## 9.3 Raw View

Raw View 直接显示原文件 byte slice。

对于 JSONL，默认显示当前 Entry 的原始物理行，不显示重新格式化结果。

对于整个 JSON Document，可按照当前节点 source span 定位。

## 9.4 View 状态保持

在以下视图之间切换：

```text
Semantic | Tree | Raw
```

必须保持：

- 当前文件。
- 当前 Entry / Item。
- 当前 NodeId。
- 当前 source span。
- 当前展开路径。
- 条件允许时的滚动位置。

## 9.5 Inspector

Inspector 至少显示：

```text
Path
$.messages[3].content

Node identity
file-id : byte-range

Source
Line 84
Bytes 10248–14521

JSON Type
string

Semantic Type
Markdown

Detection Source
Schema-directed LLM content

Signals
- parent is assistant message
- field is content
- contains fenced code block
```

不显示未经校准的：

```text
Markdown 92%
```

------

# 10. Content Viewer

Content Viewer 是专门阅读长 string 或富文本内容的主区域，不是一个未定义的泛称。

## 10.1 打开条件

以下操作打开 Content Viewer：

- 双击 string 节点。
- 点击 Tree 中的 Preview。
- 点击 Conversation 中的长 content。
- 点击 Tool Result 内容。
- string 超过 4 KiB 时点击摘要。

v0.1 使用主窗口内的全高面板或覆盖层，不创建独立操作系统窗口。

## 10.2 模式

普通 string：

```text
Rendered | Decoded Source | Raw Lexeme
```

Nested JSON string：

```text
Parsed | Decoded String | Raw Lexeme
```

含义：

- **Rendered**：Markdown、Code、HTML 等语义视图。
- **Decoded Source**：JSON escape 解码后的字符串。
- **Raw Lexeme**：源文件中的字符串 token，包括引号和转义。
- **Parsed**：对 nested JSON string 再次解析后的 Tree。

## 10.3 工具栏

必须提供：

- 当前 path。
- byte size。
- character count。
- line count。
- 当前 renderer。
- Render As。
- Search。
- Wrap / No Wrap。
- Copy。
- Close。

v0.1 不显示 token 数。

## 10.4 大内容降级

Plain Text 和 Decoded Source：

- 超过 256 KiB 时按块读取。
- 使用虚拟化行视图。
- 不一次性创建完整 DOM。

Markdown：

```text
自动完整渲染上限：2 MiB
```

超过时默认进入 Decoded Source，并允许用户显式点击：

```text
Render Markdown Anyway
```

Code Highlight：

```text
自动高亮上限：1 MiB 或 20,000 行
```

超过后使用带行号的普通 monospace text，并显示：

```text
Syntax highlighting disabled for large content.
```

HTML Preview：

```text
自动允许 Preview 的上限：512 KiB
```

超过后只显示 Source。用户不能绕过这一安全和资源上限。

------

# 11. 搜索语义

## 11.1 默认搜索

当前 Entry、Item 或 Document 内的默认搜索作用于 decoded representation：

- string 使用解码后的 Unicode 文本。
- key 使用解码后的 key。
- number 使用原始数字 lexeme。
- boolean / null 使用字面量文本。

因此搜索：

```text
你好
```

可以匹配：

```json
"\u4f60\u597d"
```

## 11.2 Source Search

用户可以切换：

```text
Search In
├── Decoded
└── Raw Source
```

Raw Source 直接匹配原始 UTF-8 字节所代表的文本。

因此搜索：

```text
\u4f60\u597d
```

可以匹配原始转义表示。

## 11.3 Content Viewer Search

搜索范围取决于当前标签页：

- Rendered：匹配渲染后的可见文本。
- Decoded Source：匹配 decoded string。
- Raw Lexeme：匹配原始 source。
- Parsed：匹配解析后 Tree 的 decoded key/value。

## 11.4 非法 UTF-8 Entry

非法 UTF-8 Entry 不参与 decoded search。

Lossy Text 中的搜索只搜索替换后的预览，不代表源字节精确匹配。

Raw Source 可以搜索 ASCII/UTF-8 query 对应的字节序列。

v0.1 不提供任意 hex pattern search。

## 11.5 v0.1 搜索边界

v0.1 只承诺：

- 当前 Entry 搜索。
- 当前 Item 搜索。
- 当前 Document 搜索。
- Tree key 搜索。
- Content Viewer 搜索。

整个 JSONL 文件的流式全文搜索属于 v0.1.x，不属于 v0.1 发布门槛。

------

# 12. String Semantic Detection

## 12.1 检测优先级

```text
1. 当前会话的用户手工覆盖
2. 已识别 Schema 的字段语义
3. 经过 parser 验证的精确结构类型
4. key / path / sibling context
5. 内容启发式
6. Plain Text fallback
```

## 12.2 两类渲染必须区分

### Schema-directed Rendering

例如已经识别为 LLM TextBlock 的 `content`。

其默认使用 Safe Markdown，是产品展示策略，不属于内容分类器给出的“Markdown 判断”。

### Content-detected Rendering

例如普通 object 中一个未知 string，系统根据内容决定它是：

- Markdown。
- Nested JSON。
- Code。
- HTML。
- Plain Text。

后续准确率指标只对 Content-detected Rendering 计算，不能把 Schema-directed Markdown 混进分母。

## 12.3 检测成本

单个 string 自动检测最多读取：

```text
前 64 KiB
```

自动 parser materialization 上限：

```text
2 MiB
```

超过时：

- 可以根据前缀显示弱提示。
- 默认仍以 Plain Text 打开。
- 不自动构建完整 semantic representation。

## 12.4 Nested JSON

只对 trim 后以以下字符开头的 string 尝试：

```text
{
[
```

不自动将以下内容当成 nested JSON：

```text
"hello"
123
true
null
```

默认递归深度：

```text
5
```

用户可调最大值：

```text
10
```

限制：

```text
单层最大输入：       2 MiB
单链累计解析量：     8 MiB
单链最大递归深度：   10
```

解析失败时：

```text
Looks like JSON, but parsing failed.
```

同时提供 Decoded String 和 Raw Lexeme。

## 12.5 普通 Markdown 检测

对不属于 LLM Schema 的任意 string，只有存在较强信号时才自动选择 Markdown，例如：

- fenced code block。
- ATX heading。
- Markdown table。
- 多项列表。
- blockquote。
- 多个明确的 Markdown block。

仅出现：

```text
foo_bar
a*b
```

不能作为足够信号。

## 12.6 HTML 检测

只有满足以下条件才自动选择 HTML：

- 包含完整 HTML element。
- parser 能形成有效 element tree。
- 不是单纯 `<T>` 一类可能属于普通文本的表达。
- 不是 XML declaration。
- 输入大小不超过自动检测限制。

不确定时回退 Plain Text，并提供 `Render As HTML`。

## 12.7 Code 检测

Code detection 可以结合：

- key：`code`、`source`、`script`。
- path。
- fenced language。
- 常见语法模式。
- parser/highlighter 是否接受。

语言猜测错误不属于数据错误，用户可以覆盖。

------

# 13. 检测质量合同

## 13.1 标注集

发布前建立不少于 500 条 string 的人工标注集，类别包括：

- Plain Text。
- Markdown。
- Nested JSON。
- Code。
- HTML。
- Ambiguous。

数据应来自真实的：

- LLM responses。
- tool arguments。
- tool results。
- Agent logs。
- backend payloads。

不能全部由人工编写玩具样例构成。

## 13.2 Precision 定义

定义集合：

```text
A = 在 Auto 模式下，被 Content Detector 自动选择为
    Markdown / Nested JSON / Code / HTML 的 string
```

排除：

- Schema-directed rendering。
- 用户手工 override。
- 超过自动检测大小上限的内容。
- 标记为 Ambiguous 的样本。

定义：

```text
Precision =
A 中 semantic type 判断正确的数量
/
A 的总数量
```

发布门槛：

```text
Overall non-Plain Precision ≥ 97%
Nested JSON Precision ≥ 99%
```

## 13.3 Recall 和 Coverage 定义

对于 semantic type `c`：

```text
Recall(c) =
被正确自动识别为 c 的 eligible 样本数
/
标注为 c 的 eligible 样本总数
```

eligible 指：

- 未超过自动检测大小上限。
- 不是 Ambiguous。
- 未被 schema 或用户 override 强制渲染。

发布门槛：

```text
Markdown Recall ≥ 70%
Nested JSON Recall ≥ 95%
Code Recall ≥ 60%
HTML Recall ≥ 80%
```

整体自动渲染覆盖率：

```text
Correct Auto-rendered Non-Plain
/
All Eligible Labeled Non-Plain
≥ 70%
```

因此，把全部内容都回退为 Plain Text 无法通过验收。

## 13.4 Plain Text 误伤

结构型误判定义为：

```text
Plain Text 被自动识别为 Nested JSON / Code / HTML
```

发布门槛：

```text
结构型误判率 ≤ 2%
```

普通未知 string 被自动识别为 Markdown，并导致源文本的字面字符被明显隐藏、重排或转为结构元素，也计入误伤。

## 13.5 Schema-directed Markdown 不计入检测指标

Recognized LLM TextBlock 默认以 Safe Markdown 展示。

它不参与上述 precision / recall，因为这是一项 schema display policy。

其独立合同是：

- Source 始终可访问。
- 用户可一键切 Plain Text。
- 不允许脚本。
- 不加载远程资源。
- 不产生应用权限。
- Copy Markdown Source 必须完全保留 decoded source。

------

# 14. Renderer 合同

## 14.1 Plain Text

必须支持：

- Unicode。
- 软换行。
- 关闭换行。
- 搜索。
- 复制。
- 大文本虚拟化。

## 14.2 Markdown

支持 CommonMark 和必要的 GFM 扩展：

- heading。
- paragraph。
- list。
- blockquote。
- table。
- task list。
- inline code。
- fenced code。
- link。
- bold / italic。

Raw HTML 必须经过 sanitizer。

远程图片不加载。

## 14.3 Markdown Fenced Code

Markdown 中的 fenced code 必须复用 §14.4 的 Code Renderer 管线。

有显式语言：

~~~text
```rust
...
```
~~~

则直接使用对应语言高亮。

无显式语言：

- block 不超过 256 KiB 时可以运行 cheap language detector。
- 超过时使用 Generic Code。
- 检测不确定时使用 Generic Code。

Code block 仍受：

```text
1 MiB 或 20,000 行
```

的自动高亮限制。

Markdown 首次布局不能等待整个超长代码块完成语法高亮。

## 14.4 Code

首版语言高亮：

- Python
- JavaScript
- TypeScript
- Rust
- C
- C++
- Java
- Go
- Shell
- SQL
- JSON
- YAML

这里只承诺语法高亮，不承诺所有语言都存在 parser。

代码绝不执行。

## 14.5 HTML Preview

HTML 不能直接注入应用主 DOM。

实现必须使用：

- opaque-origin sandbox iframe；
- 或具有等价隔离能力的独立 child WebView。

禁止：

- `allow-scripts`
- `allow-same-origin`
- form submission
- popup
- top navigation
- iframe nesting
- application IPC
- application custom protocol
- file access
- clipboard access

强制 CSP：

```text
default-src 'none';
script-src 'none';
connect-src 'none';
img-src 'none';
media-src 'none';
font-src 'none';
frame-src 'none';
object-src 'none';
form-action 'none';
base-uri 'none';
style-src 'unsafe-inline';
```

Preview 期间必须为零：

- fetch。
- XHR。
- WebSocket。
- EventSource。
- 外部 image request。
- font request。
- media request。

HTML 先 sanitizer，再进入隔离环境。隔离环境是第二道边界，不能用 sanitizer 替代 sandbox。

------

# 15. Schema Adapter 合同

## 15.1 运行范围

Schema Adapter 只在下列候选位置运行：

1. Document / Entry 根对象。
2. 根对象中的：
   - `messages`
   - `conversation`
   - `conversations`
3. Collection Mode 中用户选中的单个 Item。
4. 根节点本身是 message-like array 时。

v0.1 不递归扫描任意深层数组寻找“可能的 Conversation”，避免误判和性能失控。

## 15.2 适配原则

匹配顺序不是简单的品牌优先级，而是：

```text
1. 生态独有 discriminator
2. 明确的 tool/block shape
3. Generic role/content shape
4. Possible Conversation 提示
5. 普通 Tree
```

原因是：

```json
{"role":"user","content":"hello"}
```

本身不能证明数据来自 OpenAI 或 Anthropic。

## 15.3 OpenAI-specific signals

满足任一项时，可以优先使用 OpenAI Adapter：

- `tool_calls`
- `function_call`
- `tool_call_id`
- role 为 `developer`
- role 为 `tool`
- role 为 `function`
- tool call 中包含：
  - `function.name`
  - `function.arguments`

支持：

```text
content: string | array | null
```

支持旧式：

```text
function_call
```

支持新式：

```text
tool_calls[]
```

`function.arguments` 可以为：

- string；
- object。

string 优先尝试 Nested JSON。

## 15.4 Anthropic-specific signals

出现以下 block type 时，优先使用 Anthropic Adapter：

```text
tool_use
tool_result
thinking
redacted_thinking
```

支持：

```text
role: user | assistant
content: string | block[]
```

明确识别的 block：

```text
text
thinking
redacted_thinking
tool_use
tool_result
```

其他 block 一律进入：

```text
UnknownBlock
```

不得把“thinking-like block”作为模糊无限集合。

### 顶层 system

Anthropic Messages API 请求中的顶层 `system` 可以是：

- string；
- text block array。

Conversation View 将其显示为位于 messages 之前的 System Section。

未知 system block：

- 保留顺序。
- 显示 UnknownBlock。
- Raw 可访问。
- 不得丢弃。

## 15.5 混合或冲突 Schema

如果同一候选 scope 同时包含强 OpenAI 和强 Anthropic discriminator，例如同时出现：

```text
tool_calls
tool_use
```

应用不得静默决定品牌。

显示：

```text
Mixed conversation schema detected

Render as:
- OpenAI-style
- Anthropic-style
- Generic
```

默认使用 Generic，保证信息不丢失。

## 15.6 Generic Adapter

数组必须至少有两项。

定义 role key：

```text
role
from
```

定义 content key：

```text
content
value
```

有限角色词汇表：

```text
system
developer
user
assistant
tool
function
human
gpt
bot
model
```

归一化映射：

```text
system                     → system
developer                  → developer
user, human                → user
assistant, gpt, bot, model → assistant
tool, function             → tool
```

Generic 自动触发条件：

1. 至少 80% 的元素是 object。
2. 至少 80% 的元素具有 `role` 或 `from`。
3. 至少 80% 的 role value 落在上述词汇表。
4. 至少 80% 的元素具有：
   - `content`；
   - `value`；
   - 或明确的 tool 信息。

小于 5 项的数组，以上 80% 条件向上取整。

例如两项数组必须两项都满足。

不满足自动触发条件，但结构有一定相似度时，只显示：

```text
Possible Conversation
[Render as Conversation]
```

## 15.7 Conversation 虚拟化

Message 或 Block 超过 100 时，Conversation View 必须分页和虚拟化。

一万条 message 不能一次性：

- 构造 Markdown DOM。
- 运行代码高亮。
- 传输到 WebView。
- 计算全部 semantic detector。

------

# 16. JSONL 索引

## 16.1 扫描行为

打开 JSONL：

```text
读取首个 chunk
    ↓
显示前 20 条 Entry
    ↓
后台扫描换行
    ↓
建立 byte-offset index
    ↓
运行有限 schema sample
```

首次显示不等待完整索引完成。

索引阶段不进行：

- 全量 JSON parse。
- Markdown render。
- Conversation render。
- semantic indexing。
- 全文搜索索引。

## 16.2 Dense Index

当同时满足以下条件时使用 dense index：

```text
Entry 数 ≤ 4,000,000
预计索引内存 ≤ 128 MiB
```

实现可以只保存 start offset 并由下一项推导 end，也可以保存额外的 line 信息，只要不超过预算。

## 16.3 Sparse Index

满足任一条件时进入 sparse index：

```text
Entry 数 > 4,000,000
预计 dense index > 128 MiB
```

Sparse index 的 stride 为最小的 2 的幂 `s`，使得：

```text
ceil(entry_count / s) ≤ 4,000,000
并且
checkpoint memory ≤ 128 MiB
```

每个 checkpoint 至少保存：

```text
entry ordinal
source line
byte offset
```

跳转到 Entry N：

1. 找到最近 checkpoint。
2. seek 到 checkpoint offset。
3. 逐行扫描到 N。
4. 解析目标 Entry。

应用状态栏显示：

```text
Sparse Index · stride 4
```

## 16.4 动态切换

索引过程中如果跨过 dense 上限，Core 必须：

- 将已有 dense offsets 压缩为 stride=2 的 checkpoint。
- 继续扫描。
- 需要时将 stride 提升为 4、8、16。

不得等扫描完成后才发现内存超限。

## 16.5 文件读取窗口

不得长时间保留覆盖整个 1 GiB 文件的热点 mmap。

实现必须采用：

- windowed mmap；
- 或 chunked read / pread。

建议最大扫描窗口：

```text
64 MiB
```

窗口扫过后使用：

- `madvise(DONTNEED)`；
- `posix_fadvise(DONTNEED)`；
- Windows/macOS 等价机制；

尽量释放已扫描的 clean file-backed pages。

------

# 17. 导航与复制

## 17.1 跳转 Entry

v0.1 必须提供：

```text
Go to Entry
```

快捷键：

```text
Ctrl/Cmd + G
```

用户输入：

```text
92831
```

应用跳转到 Entry 92831。

索引尚未完成时：

- 可以跳转到已索引范围内。
- 超过当前范围时显示：
  `Indexing has not reached this entry yet.`
- 不虚构总 Entry 数。

## 17.2 状态栏

索引完成：

```text
Entry 92,831 / 4,238,912
Source line 93,047
Bytes 183928128–183930842
```

索引进行中：

```text
Entry 92,831 / indexing…
Indexed through source line 1,283,491
```

## 17.3 Copy 合同

### Copy Raw

复制节点 source span 的原始文本。

### Copy JSON Subtree

和 Copy Raw 一样，复制原始 JSON node byte slice：

- object 保留内部空白和 key 顺序。
- string 保留引号和 escape。
- number 保留原始 lexeme。

它不是重新 stringify 的规范化 JSON。

### Copy Decoded Value

仅对 scalar 提供。

string 复制解码后的内容，不带 JSON 引号。

### Copy Parsed JSON

只对 Nested JSON string 提供。

这是对 string 内部 JSON 解析后的表示，可以进行规范化格式化，但菜单必须明确写成：

```text
Copy Parsed JSON
```

不能命名为 Raw，也不能暗示它来自原文件直接切片。

------

# 18. 性能合同

## 18.1 参考环境

发布性能门槛在以下参考环境验收：

```text
Linux x86_64
8 logical cores or more
16 GiB RAM
local NVMe SSD
64-bit release build
```

网络盘、机械硬盘和远程文件系统不适用硬性时间 SLO。

## 18.2 1 GiB JSONL

| 指标                       | 目标      |
| -------------------------- | --------- |
| 显示前 20 条 Entry         | ≤ 1.5 秒  |
| 完成 newline scan 和 index | ≤ 8 秒    |
| 已索引 Entry 跳转 p95      | ≤ 100 ms  |
| Core index memory          | ≤ 128 MiB |
| Core parsed/decoded LRU    | ≤ 64 MiB  |
| 应用私有工作集，稳定后     | ≤ 350 MiB |

“Entry 跳转 p95 ≤ 100 ms”只包含：

```text
seek
+ 读取 Entry
+ JSON parse
+ 返回壳视图 / Tree 摘要
```

不包含：

- 1 MiB Markdown 完整排版。
- 大型 HTML Preview。
- 全量代码高亮。
- 外部字体加载，因为产品禁止外部字体加载。

## 18.3 内存口径

不能直接以扫描期间瞬时 RSS 作为唯一指标，因为 clean file-backed pages 和 OS page cache 会影响 RSS。

发布验收同时记录：

### Application-owned Memory

包括：

- native heap。
- node/span arena。
- Entry index。
- decoded cache。
- semantic cache。
- WebView private working set。
- frontend projection cache。

不包括：

- 输入文件对应的 clean file-backed page cache。

目标：

```text
≤ 350 MiB
```

### Input File Resident Window

索引完成并空闲 5 秒后，输入文件仍驻留的映射窗口应：

```text
≤ 64 MiB
```

参考 Linux 测试程序通过 `/proc/<pid>/smaps` 区分输入文件 mapping 和匿名/private memory。

跨平台发布报告必须记录等价指标，不能只写一个模糊的 RSS 数字。

## 18.4 100 MiB JSON Document

| 指标         | 目标    |
| ------------ | ------- |
| 显示根结构   | ≤ 3 秒  |
| Raw 首屏     | ≤ 1 秒  |
| 总私有工作集 | ≤ 1 GiB |

完整 JSON Document 可以进行一次结构扫描，但：

- 不预先 decode 全部 string。
- 不向 WebView 发送完整 AST。
- Tree children 按需获取。
- 超长 string 只显示摘要。
- Collection 根数组必须虚拟化。

## 18.5 Benchmark 方式

每个性能 benchmark：

- 使用 release build。
- 新启动应用进程。
- 运行至少 5 次。
- 报告 median 和 p95。
- 记录冷文件缓存与暖缓存结果。
- Linux 上使用 `posix_fadvise(DONTNEED)` 或等价方式准备 cold-cache 测试。
- 测试文件由仓库固定脚本生成，不能临时更换数据分布。

------

# 19. 错误和文件变化

## 19.1 Invalid JSON Document

显示：

```text
Invalid JSON

Line: 182
Column: 14
Byte offset: 19382

Expected ',' or '}'
```

Raw Byte View 仍可访问。

## 19.2 Invalid JSONL Entry

Entry List：

```text
Entry 12838  Valid
Entry 12839  Invalid JSON
Entry 12840  Valid
```

坏 Entry 不阻断后续浏览。

## 19.3 Oversized Entry

单条 JSONL Entry 最大：

```text
16 MiB
```

超限时：

- 不解析。
- 状态为 `Oversized Entry`。
- 提供前 64 KiB 和后 64 KiB Raw Preview。
- 显示完整 byte range。
- 后续 Entry 继续工作。

## 19.4 文件被修改

如果 canonical path 对应文件的 size 或 modification timestamp 变化：

```text
The file changed on disk.

[Reload]
[Close]
```

如果当前实现可以安全保持旧 snapshot，可以额外提供：

```text
Continue with current snapshot
```

如果使用中的 mmap/span 已不再安全，不得提供该选项。

重新加载后：

- Entry index 作废。
- NodeId 作废。
- semantic cache 作废。
- session override 作废。

------

# 20. 安全和隐私

v0.1 必须满足：

- 无文件上传。
- 无内容遥测。
- 无文件名遥测。
- 无自动崩溃报告上传。
- 无远程 LLM。
- 无远程 renderer。
- 无自动 URL 请求。
- 无 HTML 网络请求。
- 无 Markdown 远程图片。
- 无代码执行。

所有 renderer 都必须有：

- 输入大小上限。
- 递归深度上限。
- DOM 节点上限。
- 时间预算。
- Plain Text fallback。

Renderer 失败：

```text
Semantic rendering failed.
Showing plain text instead.
```

不能丢失源内容。

------

# 21. Fixture 与验收

## F-00：文件模式路由

包含：

```text
pretty.json
one-line.json
one-line.jsonl
unknown-extension-single-json
unknown-extension-jsonl
concatenated-json
json-text-sequence
pretty-printed-records.jsonl
```

验收：

- `.json` pretty-print 进入 Document。
- 单行 `.jsonl` 进入 Entry。
- 未知扩展名单 JSON 进入 Document。
- 合法逐行数据进入 Entry。
- concatenated JSON 明确拒绝。
- JSON Text Sequence 明确拒绝。

## F-01：Rich Strings

覆盖：

- Plain Text。
- Markdown。
- fenced code。
- HTML。
- 易误判负例。

## F-02：Nested JSON

覆盖：

- object string。
- array string。
- invalid JSON-looking string。
- primitive-looking string。
- 超过递归深度。
- 超过累计体积。

## F-03：OpenAI Conversation

覆盖：

- system。
- developer。
- user。
- assistant。
- tool。
- content string / array / null。
- tool_calls。
- function_call。
- arguments string / object。
- unknown content block。

## F-04：Anthropic Blocks

覆盖：

- 顶层 system string。
- 顶层 system text block array。
- text。
- thinking。
- redacted_thinking。
- tool_use。
- tool_result。
- unknown block。

## F-05：Generic Conversation

覆盖：

- role/content。
- from/value。
- `human/gpt`。
- `user/model`。
- 非 Conversation object array。
- 79% 匹配负例。
- 80% 匹配正例。

## F-06A：Event Stream Positive

样本满足：

```text
T ≥ 70%
P ≥ 40%
```

预期显示 Event Stream Hint。

## F-06B：Event Stream Negative

每行均有：

```json
{"type":"training_sample"}
```

但没有 timestamp、重复 grouping 或 sequence。

预期不显示 Event Stream Hint。

## F-07：Encoding

包含：

1. UTF-8 JSON。
2. UTF-8 BOM JSON。
3. UTF-16 BOM JSON。
4. 整体非法 UTF-8 `.json`。
5. JSONL 中一条非法 UTF-8 Entry。
6. JSONL 中超过 20% 非法 UTF-8 Entry。

验收：

- UTF-16 BOM 为文件级拒绝。
- 非法 UTF-8 `.json` 为文件级错误。
- JSONL 单个坏 Entry 不阻断后续记录。
- 坏 Entry 提供 Lossy Text 和 Hex。
- 大量坏 Entry 显示文件级警告，但仍保持逐 Entry 浏览。

## F-08：Lossless JSON

覆盖：

- duplicate key。
- 大整数。
- exponent。
- `\uXXXX`。
- emoji。
- CRLF。
- 特殊空白。

## F-09：1 GiB JSONL

验收：

- 首屏时间。
- 索引时间。
- dense / sparse index。
- 内存。
- Go to Entry。
- 首、中、尾跳转。
- 文件驻留窗口释放。

## F-10：100 MiB JSON

覆盖：

- 大 object。
- 百万元素顶层 array。
- 超长 string。
- 深层结构。

验收：

- Collection 虚拟化。
- child-on-demand。
- 单次 IPC 不超过 1 MiB。
- Content Viewer 分块。
- WebView 不获得完整 AST。

## F-11：Security Payloads

覆盖：

- script。
- iframe。
- form。
- event handler。
- javascript URL。
- remote image。
- CSS URL。
- fetch。
- WebSocket。
- data URI。
- Markdown raw HTML。

验收：

- 零脚本执行。
- 零网络请求。
- 零应用 IPC。
- 零 top navigation。
- 零宿主 DOM 污染。

## F-12：Long Conversation

包含：

```text
10,000 messages
部分 message 含 Markdown
部分 message 含长代码
部分 message 含 tool result
```

验收：

- Conversation 虚拟滚动。
- 未可见 message 不运行重渲染。
- 不一次性传入 WebView。
- UI 可导航。
- 内存不随所有 message 的 rendered DOM 线性增长。

------

# 22. 发布门槛

v0.1 Release 必须同时满足：

## 功能

- F-00 至 F-12 全部通过。
- Semantic、Tree、Raw 切换保持 NodeId 和 source span。
- Go to Entry 可用。
- Content Viewer 定义的三种表示可用。
- OpenAI、Anthropic 和 Generic fixture 无字段丢失。

## 无损

- 原文件零写入。
- Raw 和 source byte slice 一致。
- duplicate key 全部存在。
- 大整数未丢精度。
- 未知 block 未丢失。
- Copy JSON Subtree 来自原始 span。

## 检测

- Overall Precision ≥ 97%。
- Overall Coverage ≥ 70%。
- 各类别 Recall 达到 §13.3。
- 结构型 Plain Text 误判 ≤ 2%。

## 性能

- 达到 §18 的参考环境指标。
- 1 GiB JSONL 不整体载入内存。
- 100 MiB JSON 不向 WebView 发送完整 AST。
- 10,000-message Conversation 不一次性渲染。

## 安全

- HTML/Markdown security fixture 无网络请求。
- 无脚本执行。
- 无宿主 API 访问。
- 无文件数据上传。

------

# 23. 里程碑调整

## M0：文件、Parser 与 Core/UI 边界

必须交付：

- 格式路由算法。
- Encoding 状态。
- span-preserving parser。
- duplicate key 和 big number。
- Document / Collection / Entry Mode。
- JSONL dense/sparse index。
- child-on-demand API。
- 单次 IPC 载荷限制。
- Tree / Raw。
- Go to Entry。

M0 不能把 `serde_json::Value` 或 `JSON.parse` 作为核心数据模型。

## M1：Content Viewer 和 String Renderer

必须交付：

- Content Viewer。
- Plain Text。
- Markdown。
- Nested JSON。
- Code。
- HTML Source / isolated Preview。
- Render As。
- 搜索语义。
- Copy 合同。

## M2：Conversation

必须交付：

- OpenAI-specific Adapter。
- Anthropic-specific Adapter。
- Generic Adapter。
- 顶层 Anthropic system。
- 明确 block type。
- Mixed Schema。
- Conversation virtualization。

## M3：性能和安全硬化

必须交付：

- 1 GiB benchmark。
- 100 MiB JSON benchmark。
- 10,000-message benchmark。
- page-cache 释放。
- LRU budget。
- renderer limit。
- security fixture。
- parser fuzzing。

## M4：发布准备

必须交付：

- 中英文 UI。
- 发布前将用户可见文案抽取到资源文件。
- 性能报告。
- 安全报告。
- 支持/不支持矩阵。
- fixture 和 benchmark 生成脚本。

原型阶段可以临时硬编码少量 UI 文本；从 v0.1 RC 开始，所有发布文案必须进入 i18n 资源。

------

# 24. 明确不进入 v0.1

- JSON 编辑。
- 保存和重写文件。
- JSON Schema IDE。
- 全文件 JSONPath。
- Query Language。
- Semantic Search。
- 字段统计。
- Reward 分析。
- Agent Trajectory 聚合。
- Claude Code Session 组装。
- Bookmark。
- Annotation。
- 持久化 User Rules。
- Plugin SDK。
- Schema Marketplace。
- Tokenizer 和精确 token 数。
- gzip / zstd。
- YAML / XML 文件。
- Base64 Renderer。
- LaTeX / Mermaid。
- 远程图片。
- stdin。
- tail。
- 多文件 Tab。
- 完整 Vim Mode。

------

经过这次修订，规格中的几个核心概念已经形成可测试的闭环：

```text
文件扩展名和内容
    ↓ 确定性路由
Document / Collection / Entry
    ↓ span-preserving parse
Core Node / Byte Range
    ↓ child-on-demand
WebView Projection
    ↓ lazy semantic materialization
Semantic / Tree / Raw
```

同时把几组此前容易混淆的概念拆开：

```text
文件级 Unsupported Encoding
≠
JSONL Entry 级 Invalid UTF-8

Schema-directed Markdown
≠
Content Detector 判断为 Markdown

应用私有工作集
≠
扫描文件造成的 clean page cache

Copy Raw Subtree
≠
Parse 后重新 stringify

Event Stream Hint
≠
自动组装 Session
```

这份 Rev 2 已经足以进入 M0。真正需要在编码前单独做 ADR 的只剩桌面壳选型、span-preserving parser 的具体实现方案，以及 WebView 分块通道采用 IPC 还是本地只读 custom protocol。