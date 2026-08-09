# ModelFiles Tokenizer Playground：功能拆解与原型问题

> 状态：原型阶段。本文只确定功能边界和交互方向，不代表生产实现方案。

## 1. 参考实现

分析对象：

- 线上页面：<https://tiktokenizer.vercel.app/>
- 开源仓库：<https://github.com/dqbd/tiktokenizer>
- 本次读取的源码版本：`d71e128430579078c9342b9268073356cc751787`（2025-04-24）
- 许可证：MIT

### 1.1 用户可见功能

1. **选择 tokenizer**
   - 支持 OpenAI model、OpenAI encoding 和一组开源模型。
   - 选择结果写入 URL 的 `?model=`，可以刷新和分享。
   - 下拉框按 Popular、Open-Source、OpenAI Encodings、OpenAI Models 分组并支持搜索。
2. **输入原始文本**
   - 非 Chat 模型直接编辑一段文本。
   - 输入变化后立即重新编码，不需要点击“运行”。
3. **编辑 Chat 消息**
   - Chat 模型显示消息列表，支持 system/user/assistant/custom role、增删消息。
   - 消息先被拼接成 ChatML 风格文本，再送入 tokenizer；拼接后的真实输入仍可编辑和查看。
4. **观察编码结果**
   - 显示 token 总数。
   - 按可读文本片段着色，另一个面板显示 token ID 序列。
   - hover 文本片段时同步高亮对应 ID；一个可读片段可能对应多个 token。
   - 可把空格、换行、Tab 显式显示为 `⋅`、`\\n`、`→` 等符号。

### 1.2 源码调用链

```text
pages/index.tsx
  ├─ EncoderSelect                  选择 model/encoding，写入 ?model=
  ├─ ChatGPTEditor                 Chat 消息 -> ChatML 风格字符串
  ├─ createTokenizer(name)
  │    ├─ TiktokenTokenizer        tiktoken WASM；OpenAI models/encodings
  │    └─ OpenSourceTokenizer      @xenova/transformers；HF tokenizer 文件
  └─ tokenizer.tokenize(text)
       ├─ token IDs + count
       └─ segments.ts              token bytes/decoder 输出 -> grapheme-safe 片段
            └─ TokenViewer         计数、彩色片段、ID、hover、空白符
```

关键实现选择：

- OpenAI 路径在浏览器中运行 `tiktoken`；ChatML 特殊 token 由页面显式注册。
- 开源模型路径使用 `@xenova/transformers`。构建前脚本把指定模型的 `tokenizer.json` 和 `tokenizer_config.json` 下载到站点自身的 `/public/hf/`，浏览器从同源加载。
- tiktoken 分段不能简单地逐 token 解码：单个 token 的 bytes 可能不是完整 UTF-8。实现会累积 token bytes，直到解码结果与输入 grapheme 前缀相符，再形成一个可高亮 segment。
- Hugging Face 路径比较 decoder 的累计输出，切出本轮新增文本，再按 grapheme 对齐。
- `api/v1/encode` 另有只返回 `{name, tokens, count}` 的 API；当前网页主流程直接在客户端编码，不依赖该 API。

### 1.3 参考实现的边界

- Chat 拼接是按少数 OpenAI 模型硬编码的 ChatML 规则，不是通用 Hugging Face `chat_template` 执行器。
- 开源模型是编译期白名单，并非任意仓库都能直接加载。
- 页面没有 offset、bytes、token piece、special/normal 来源等诊断字段。
- loading 主要体现在 tokenizer 选择器；源码没有完整的失败/不兼容状态设计。
- `text-embedding-3-*` 虽出现在模型列表，源码会以“Model may be too new”失败。

## 2. 映射到 ModelFiles

ModelFiles 的上下文与参考网页不同：用户已经打开了一个模型仓库，并且应用只在选中文件时懒加载内容。因此不照搬全局模型选择器，而把当前仓库视为 tokenizer 来源。

### 2.1 已有接缝

- `FileClassifier` 已把 `tokenizer.json`、`tokenizer_config.json`、`vocab.json`、`merges.txt` 等归入 Tokenizer。
- `TokenizerInspector` 已后台解析 `tokenizer.json` 的格式版本、模型类型、词表、merge 和 added token 数量。
- `DetailView` 已为 `tokenizer.json` 提供“概览 / 全部字段 / 原文”视角。
- `tokenizer_config.json` 已能读取特殊 token，并通过现有 `TemplatePlaygroundView` 执行内嵌 `chat_template`。
- 仓库访问层已经具备“列目录 + 按需读取选中文件/Range”的边界。

因此生产实现的自然入口是：

```text
选中 tokenizer.json
  -> 详情顶部新增“试验台”视角
  -> 复用当前 RepositorySnapshot，按需补读 tokenizer_config.json
  -> 原始文本 或 现有 chat_template 渲染结果
  -> 当前仓库 tokenizer 编码
  -> TokenSegment[]
  -> 彩色片段 / ID / 诊断视图
```

### 2.2 第一版功能边界

必须有：

- 原始文本实时编码。
- token 总数、彩色文本片段、token ID。
- 文本与 ID hover/selection 联动。
- 空白符显式显示。
- 当前 tokenizer 的来源、模型类型和已加载文件清晰可见。
- 不兼容 tokenizer、缺文件、解析失败、正在加载四种状态。
- 编码在后台任务执行，输入变化可取消/去抖，不能阻塞 AppKit 主线程。

有 `chat_template` 时再出现：

- 原始文本 / Chat 对话两种输入模式。
- 复用现有消息编辑与模板渲染能力。
- 同时展示“模板渲染结果”和“分词结果”，让 token 数能追溯到实际输入。

第一版不做：

- 不再提供一个脱离当前仓库的全局模型目录。
- 不加载模型权重，不做推理或收费估算。
- 不做 tokenizer 文件编辑、保存或上传。
- 不承诺在首版覆盖所有 Hugging Face tokenizer 类型；应先用真实语料盘点支持矩阵。
- 不增加插件系统、统一 VFS 或通用推理 runtime。

## 3. 原型要回答的问题

原型文件：[`prototypes/tokenizer-playground.html`](prototypes/tokenizer-playground.html)

这是一个自包含、无持久化、使用模拟 token 数据的界面原型。模拟数据只用于验证布局和交互，**不代表真实 tokenizer 已接入**。

三个方案通过 `?variant=` 切换：

- `A — 对照工作台`：左侧组织输入，右侧持续展示结果。最接近参考网页，也最容易嵌入现有详情页。
- `B — 对话优先`：Chat 消息是主画布，token 结果成为底部胶片和右侧摘要。适合主要用例是调 chat template 的用户。
- `C — Token 取证台`：输入、逐 token 表格、诊断三列并排。适合 tokenizer 文件分析和异常定位。

建议先验证三个问题：

1. “试验台”是否应只出现在 `tokenizer.json`，还是在 `tokenizer_config.json` 也提供同一个入口？
2. 默认布局更应服务“快速看 token 数”，还是“查某个字符为什么被这样切分”？
3. Chat 模式是否与现有 Chat Template 试验台合并，避免两个相似消息编辑器？

当前倾向：以 A 为默认骨架，吸收 C 的可选逐 token 表格；Chat 模式直接复用现有 Template Playground 的消息与渲染状态，不再增加第二套消息模型。
