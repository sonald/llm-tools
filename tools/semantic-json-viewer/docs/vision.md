# Semantic JSON Viewer 产品愿景

文档地位：说明为什么做、给谁用、长期往哪走。

v0.1 的范围、上限、验收和实现合同以 [`spec.md`](./spec.md) 为准。本文不构成实现合同。文中出现的类型、schema、视图，只描述产品想理解的世界，不表示某一版必须全部交付。

暂定名称：Semantic JSON Viewer。

---

## 1. 一句话

面向 LLM、Agent 和开发者数据的 JSON/JSONL 阅读器：不只展示结构，还理解 string 和 object 里实际装的是什么，并用适合人读的方式呈现，同时始终能回到原始字节。

---

## 2. 问题

传统 JSON Viewer 建立在 JSON 自己的类型上：

```text
object  array  string  number  boolean  null
```

对 REST API 数据这套够用。LLM、Agent、训练数据、评测数据和程序日志里，真正难读的东西大多被塞进 `string`：

```json
{
  "role": "assistant",
  "content": "## Result\n\nThe answer is **42**.",
  "arguments": "{\"path\":\"src/main.rs\",\"recursive\":true}",
  "html": "<table><tr><td>Hello</td></tr></table>",
  "code": "def hello():\n    print('hello')"
}
```

于是 Viewer 只看到四个 string。后果很具体：

- Markdown、代码、HTML 里全是 `\n`、`\"`，没法直接读。
- JSON string 里再套 JSON，转义叠两层、三层。
- conversation 被拆成字段，看不到对话。
- tool call 的 `arguments` 必须复制出去反转义。
- JSONL 一行一条样本或一行一个事件，普通编辑器既看不清，也打不开大文件。
- 人在 `jq`、编辑器、Markdown 预览、浏览器、JSON Formatter 之间来回切。

产品要做的抽象扩展是：

```text
序列化  →  结构  →  语义
```

传统 Viewer 停在结构。这里多一层：string 不再只是字符数组，object 也不再只是 key/value。

string 里可能是：

```text
plain text / markdown / HTML / JSON / YAML / XML /
source code / SQL / shell / diff / stack trace /
URL / image / Base64 / …
```

object 里可能是：

```text
Message / Content Block / Tool Call / Tool Result /
Conversation / Agent Trajectory / Training Sample /
Evaluation Result / …
```

最终目标：把 JSON 从序列化格式查看器，做成结构化数据的语义阅读器。

---

## 3. 北极星

判断产品有没有做对，看用户第一次打开文件时看到什么。

输入：

```json
{
  "role": "assistant",
  "content": "## Analysis\n\nI will inspect the file.\n\n```python\nprint('hello')\n```",
  "tool_calls": [
    {
      "function": {
        "name": "run",
        "arguments": "{\"cmd\":\"python test.py\",\"env\":{\"DEBUG\":\"1\"}}"
      }
    }
  ]
}
```

默认应先看到：

```text
Assistant

Analysis
────────

I will inspect the file.

┌ Python ───────────────────────┐
│ print('hello')                │
└───────────────────────────────┘

Tool Call
─────────

run

cmd
python test.py

env
└── DEBUG: 1
```

只有切到 Raw，才需要面对 `\n`、`\"`、`\\`。

如果默认仍是转义后的 string，这就还是一个传统 JSON Viewer。

---

## 4. 用户

第一优先：LLM / ML 工程师。日常文件是 `train.jsonl`、`rollout.jsonl`、`eval.jsonl`、`messages.json`。他们要快速看 prompt、response、reasoning、tool call、reward。

其后：

- Agent 开发者：沿 tool call → result → reasoning 读轨迹，而不是对着原始 JSON 猜。
- Backend / Infra：HTTP payload、日志、escaped JSON、stack trace。
- 数据工程师：JSON/JSONL、嵌套记录、异构 dataset。

共同需求是阅读、理解和导航，不是编辑。

---

## 5. 设计原则

这些原则长期有效。某一版怎么落地，见 spec。

**Raw 永远可及。** Semantic 渲染不能藏起原始值。任何节点都能在 Semantic、Tree、Raw 之间切，并尽量停在同一处。

**无损。** 推断、解析、渲染都不改数据。Semantic 层是附加信息。Raw 必须指向源文件字节，而不是 parse 后再 stringify。

**渐进增强。** 认不出的 string 就当 Plain Text。语义检测是增强，不是打开文件的前提。

**判断可解释。** 用户能看到「为什么当成 Markdown」：字段名、heading、fence 之类的信号。不要用校准过的百分比假装精确。

**用户可覆盖。** 自动判断错了，立刻 `Render As`。产品可以猜，但不能把猜测做成唯一真相。

**本地优先。** 训练数据、对话、日志经常含敏感内容。默认只在本机处理，不上传，渲染路径不自动访问网络。

**阅读器，不是工作台。** 长期也不把自己做成 JSON IDE、Schema 设计器、API Client、数据库管理器、ETL 或 Dataset Cleaning Platform。编辑可以以后再加；先把读懂这件事做透。

---

## 6. 产品要理解的两层递归

语义不只发生在单个 string 上。

一层是编码嵌套：

```text
JSON → string → JSON → string → Markdown
```

例如 `arguments` 里再套 `{"foo":{"bar":"{\"x\":1}"}}`，人要看到的是 `x: 1`，不是一串 `\\\"`。

另一层是对象嵌套：

```text
Object → Conversation → Message → Tool Call → arguments → JSON
```

打开 `{"messages":[...]}` 时，默认应是对话，而不是一棵叫 `messages` 的树。

同一份 JSONL 还可能是三种完全不同的东西：

- 一行一条独立样本（SFT、eval）
- 一行一个事件，多行才构成一次 session（Claude Code 一类 trace）
- 单个 JSON 文档里塞完整 conversation

三种的导航模型不同，不能都叫 Conversation。认不出形状时，仍应能当普通记录浏览。

---

## 7. 竞品里要借什么

不复制任何一种现有工具的模型，只借它们已经做对的部分。

**JSON Hero** 把 string 当成有语义的值（URL、图片、日期、颜色）。它面向传统 Web API。这里要把同一思路用到 Markdown、代码、HTML、嵌套 JSON 和 LLM schema。

**Super JSON Editor** 把合法 JSON string 再 parse、再递归展示。这应是基础能力，不是彩蛋。

**JSONL Viewer / Dataset Viewer** 证明大文件要靠流式读取、行偏移和虚拟列表；也证明 `messages[]` 可以直接画成 User / Assistant / Tool。它们往往绑死几个已知 schema。长期方向是：先覆盖常见形状，再允许配置和推断，而不是永远只认某两家 API。

**fx / jless** 提醒 GUI 不能牺牲开发者效率：键盘、路径跳转、大 string 预览、快速在记录间移动。

---

## 8. 三种阅读方式

长期都要在，只是深度随版本变。

- **Semantic：** 给人读。Markdown、代码、HTML、解析后的 JSON string、Conversation、Tool Call。
- **Tree：** 给工程师看结构。节点上可以带语义摘要（`content Markdown · 12 KB`），但结构本身仍是 JSON。
- **Raw：** 给需要对齐源文件的人。内容来自原始字节。

切换时保持当前记录和当前节点。认不出语义时，Tree 和 Raw 仍必须可用。

---

## 9. 长期方向

v0.1 验证三件事：string 可读、conversation 可读、JSONL 可当数据集浏览。具体做哪些、做到哪，只看 spec。

之后才值得考虑的方向，按靠近阅读器的程度大致是：

- 更多对象形状：事件流拼 session、Claude Code、OpenAI Responses、ShareGPT / Alpaca 等训练格式
- 更多 string 类型：YAML、XML、SQL、diff、stack trace、图片
- 用户规则、schema preset、书签、字段统计、跨文件搜索
- gzip / zstd、日志 tail
- 更远：插件、查询语言、轨迹对比、reward 分析、dataset 编辑

这些都可以不做。过早做成 Agent Dataset Workbench，会把阅读器做重。

---

## 10. 和 spec 的关系

| 问题 | 看哪里 |
| --- | --- |
| 为什么做、给谁、原则、长期图像 | 本文 |
| v0.1 做什么、不做什么、上限、验收 | [`spec.md`](./spec.md) |

两份文档冲突时，以 spec 为准。
