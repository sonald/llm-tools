# ModelFiles 源码阅读与国际化需求

状态：已确认
日期：2026-08-21
适用范围：`tools/model-files/` 原生 macOS 应用

## 结论

三个方向都清楚，但原始表述还不足以直接实现。

| 原始需求 | 清晰度 | 缺失的产品合同 | 本文默认决定 |
| --- | --- | --- | --- |
| py、yaml、json 等文件折叠 | 部分清晰 | “折叠”是源码块还是侧栏目录；“等”包含哪些格式；大文件和折叠状态如何处理 | 指源码结构折叠；V1 只含 Python、YAML、JSON；大于 128 KiB 不折叠 |
| 文件内容支持 ctrl+f 查找（高亮） | 部分清晰 | macOS 快捷键、查找范围、大小写、匹配导航、折叠块内命中如何处理 | `⌘F` 与 `⌃F` 均打开当前文件查找；字面量、不区分大小写；高亮全部并区分当前命中 |
| 国际化（多语言支持） | 不够清晰 | 首批语言、语言切换方式、覆盖范围、回退语言 | V1 为简体中文和英文；跟随系统；不增加应用内语言设置；简体中文为回退语言 |

上述默认决定已作为本轮实现合同；如需变更，只修改对应条目，不重写整体方案。

## 当前基线

当前文件预览链路是：

```text
FileClassifier
  → RepositoryFile.structuredInspectionFormat
  → RepositoryService.inspectFile
  → InspectionDocument
  → InspectionWorkspaceView
  → FileReaderView
  → CodeReaderView / MarkdownReaderView / RawTextView / LinesView
```

与本需求直接相关的事实：

- `FileClassifier.syntaxLanguage(for:)` 已识别 `.py/.pyw` 和 `.yaml/.yml`，但未识别 `.json`。
- 小于等于 128 KiB 的源码由 `CodeReaderView` 使用 Textual 0.5.0 + Prism 静态渲染；当前公开接口没有文件内查找或源码折叠。
- JSON 优先进入配置摘要、Tokenizer 摘要或字段视图；“原文”仍是普通只读文本，没有折叠。
- 大于 128 KiB 的文本进入 `LinesView`。它有一个“搜索”输入框，但行为是筛选匹配行，不是 `⌘F/⌃F`、不高亮命中，也不能在命中间导航。
- 侧栏已有 `.searchable`，用于筛选文件；它与“当前文件内容查找”是两个不同功能，不能共用查询状态。
- `Package.swift` 排除了应用的 `Resources`，打包脚本只复制图标和 Textual 资源；当前没有 `Localizable.xcstrings` 或 `.strings`。
- 源码中约有 441 个含中文的字符串字面量。SwiftUI 的直接字符串可进入本地化流程，但返回 `String` 的标题、错误、辅助说明和可访问性文案需要显式本地化。
- 既有 `docs/format-support-design.md` 已约定“`⌘F` 聚焦当前主画布的搜索；源码模式沿用编辑器查找”，本需求是补齐该未实现合同。

## 目标用户与目标

目标用户是在 ModelFiles 中只读检查模型仓库源码、配置和模板的开发者。

V1 成功时，用户可以：

1. 折叠 Python、YAML 和 JSON 中可确定的多行结构，减少滚动。
2. 不离开当前文件，通过键盘查找文本、看到所有命中并跳转到上一个或下一个命中。
3. 在简体中文或英文系统环境下使用完整、可理解的界面。

## 功能需求

### FR-1：源码结构折叠

#### 支持范围

| 文件 | V1 可折叠单元 | 识别方式 |
| --- | --- | --- |
| `.py`、`.pyw` | 后续存在更深缩进的多行块，例如 class、def、if、for、while、try、with、match | 行与缩进扫描；不构建 Python AST |
| `.yaml`、`.yml` | mapping、sequence、block scalar 等后续存在更深缩进的多行节点 | 行与缩进扫描；不实现完整 YAML parser |
| `.json` | 跨行的 object 与 array | 识别字符串转义后的 `{}`、`[]` 配对；不改变 JSON 内容 |

“等文件”不是开放集合。JavaScript、TypeScript、TOML、XML、Markdown 和 Jinja 折叠不属于 V1；出现真实需求后按格式补充识别器和 fixture。

#### 交互

- 只有实际覆盖至少一行内容的结构显示折叠标记。
- 点击行号区的标记折叠或展开；折叠后保留起始行，并显示被隐藏的行数。
- 提供“全部展开”；V1 不增加“按层级折叠”“记住上次状态”或可配置快捷键。
- 折叠只改变展示，不修改源字符串、复制内容或缓存的 `InspectionDocument`。
- 折叠状态属于当前阅读器实例；切换文件、重新加载仓库或重启应用后重置。
- JSON 的折叠出现在“原文”视图；现有“概览 / 全部字段”语义不变。
- Python/YAML/JSON 大于 128 KiB 时继续使用大文件阅读路径，V1 不提供折叠，并显示简短说明；不能因此阻塞文件打开或查找。
- 无法可靠识别结构时不显示折叠标记，不猜测、不报文件语法错误。

### FR-2：当前文件内容查找

#### 范围与快捷键

- 当焦点位于文本内容阅读器时，`⌘F` 打开 macOS 标准文件内查找；为满足原始需求，`⌃F` 是同一动作的别名。
- 查找只作用于当前文件的当前源码/原文阅读面，不搜索侧栏文件名，也不跨仓库或跨文件。
- V1 覆盖 `CodeReaderView`、JSON/普通文本“原文”、大文件逐行视图和 Jinja 源码。
- Markdown 渲染页、PDF、Metadata/Tensors/Entries 表格不纳入统一文件内查找；这些页面保留各自已有搜索，Markdown 可切到“原文”查找。PDFKit 自带行为不在本需求中重写。

#### 匹配行为

- 默认执行不区分大小写的字面量查找；V1 不增加正则、全词匹配或替换。
- 输入时增量查找；所有可见命中高亮，当前命中使用不同的系统语义样式。
- 显示 `当前序号 / 总数`；支持下一个、上一个和 `Esc` 关闭。
- 查询为空时不显示命中高亮；没有匹配时明确显示 0。
- 查找覆盖完整已加载文本，不受“大文件仅渲染前 1,000 行”影响。
- 当前命中位于折叠块内时，自动展开包含该命中的最小折叠块并滚动到命中；普通“高亮全部”不应自动展开所有折叠块。
- 切换文件后清空查询和命中；不保存查找历史。

### FR-3：国际化

#### 语言与选择

- V1 支持 `zh-Hans` 和 `en`。
- 应用跟随 macOS“语言与地区”选择；V1 不增加应用内语言下拉框，也不保存自定义语言偏好。
- 不支持的系统语言回退到简体中文。
- 应用名 `ModelFiles`、文件名、仓库 ID、路径、代码、JSON/YAML key、模型 metadata key 和技术格式名不翻译。

#### 文案覆盖

以下用户可见文本必须进入本地化资源：

- 窗口、工具栏、侧栏、详情页、空态、加载态和错误。
- 按钮、菜单、Picker、搜索占位、Popover、Tooltip。
- 概览字段名称、来源标签、安全说明和一致性报告。
- Tokenizer、Jinja、GGUF、SafeTensors、Imatrix 工作台文案。
- VoiceOver label、accessibility hint 和格式化计数文案。

动态插值必须保持占位符类型一致。英语中的单复数使用 String Catalog plural variation；不能用字符串拼接制造英语句子。

#### 资源与打包

- 使用一个 `Localizable.xcstrings`；当前规模不需要本地化 service、生成代码或按功能拆 catalog。
- SwiftUI 可本地化参数继续使用字面量；普通 `String` 返回值使用 `String(localized:)`。不新增 `L10n` enum 或 key registry。
- SwiftPM 运行和 `dist/ModelFiles.app` 都必须包含本地化资源 bundle。
- `CFBundleDevelopmentRegion` 使用标准语言标识，并与 SwiftPM `defaultLocalization` 一致。

## 非功能需求

### 性能

- 文件加载和安全上限保持不变：可读文件最多 32 MiB。
- 折叠范围计算不得在主线程执行超过一个显示帧；128 KiB fixture 上的计算应在单元测试中稳定小于 50 ms。
- 大文件查找必须覆盖完整文本；使用系统文本查找的后台能力或现有异步解析，不能在输入每个字符时同步重建全部 SwiftUI 行。

### 只读与数据安全

- 查找和折叠不得写回本地、SSH 或远程仓库文件。
- 不新增网络请求，不执行仓库代码，不放宽 32 MiB 和严格 UTF-8/NUL 校验。
- 折叠与高亮使用派生状态；原始 `Data` 和 `InspectionDocument` 保持不变。

### 可访问性

- 折叠按钮有“折叠/展开第 N 行结构”的 VoiceOver label，并可通过键盘聚焦。
- 命中状态不能只靠颜色；当前命中需同时有选择/描边语义。
- 简体中文和英文在 900 × 600 最小窗口下，主操作不可被截断到不可理解。

## 验收标准

### 折叠

- Python fixture 的嵌套 class/def/if、YAML fixture 的嵌套 mapping/sequence/block scalar、JSON fixture 的嵌套 object/array 都得到稳定且不重叠错误的折叠范围。
- 点击任一折叠标记只隐藏该范围的内部行；展开后源码逐字符恢复。
- 复制全部文本的结果在折叠前后相同。
- 非法或不完整文件不会崩溃，不可靠位置不出现标记。
- 128 KiB 阈值两侧走预期路径；大文件无折叠但查找可用。

### 查找

- `⌘F` 和 `⌃F` 都将焦点交给当前文件查找，而不是侧栏筛选。
- ASCII、中文、重复词、跨大小写文本均显示正确总数；上一个/下一个循环导航。
- 所有可见命中高亮，当前命中可区分；0 命中和关闭状态明确。
- 命中折叠块内文本时只展开必要范围并滚动到命中。
- 32 MiB 上限内的大文件能查到第 1,001 行之后的内容。

### 国际化

- 用 `zh-Hans` 启动时不存在意外英文占位；用 `en` 启动时除约定不翻译内容外不存在中文 UI 文案。
- 英文单复数、数字、字节数和插值顺序正确。
- SwiftPM 测试资源与打包后的 `.app` 均能读取两种语言。
- 两种语言都完成真实应用的打开仓库 → 选文件 → 折叠 → 查找 → 切换 perspective 流程。

## 非目标

- 可编辑源码、查找替换、保存文件、全仓库搜索。
- 完整 Python/YAML 语法验证或 AST/Tree-sitter 基础设施。
- “等文件”的通用插件协议或语言注册表。
- 应用内语言选择器、在线下载语言包、第三种语言。
- PDF/Markdown 渲染内容的统一高亮查找。
- 记忆折叠状态、查找历史或跨启动恢复。

## 实现边界

- 始终：复用 `FileClassifier → InspectionDocument → FileReaderView` 分发链；保留只读、安全上限和现有源码高亮能力；新增非平凡扫描逻辑必须有最小 fixture 测试。
- 先询问：新增第三方编辑器/语法 parser 依赖；扩大折叠格式；增加应用内语言选择；改变 128 KiB 富阅读阈值。
- 禁止：为三种格式建立插件 SDK；修改第三方 Textual 源码；用正则分别“高亮”所有支持语言；把用户内容送往网络翻译。

## 待确认项

以下均已有默认值；只有不同意时才需要回复：

1. `ctrl+f` 是否必须字面限定为 Control，还是泛指查找快捷键？默认同时支持 `⌘F` 与 `⌃F`。
2. 首批语言是否就是简体中文和英文？默认是。
3. JSON 是否接受只在“原文”视图折叠？默认接受，结构化概览不改变。
4. 大于 128 KiB 的文件是否首版可以只查找、不折叠？默认可以。

## 依据

- 当前实现：`Sources/ModelFiles/Support/FileClassifier.swift`、`Views/CodeReaderView.swift`、`Views/DetailView.swift`、`Package.swift`、`script/build_and_run.sh`。
- 既有交互合同：`docs/format-support-design.md`。
- Apple `NSTextFinder`：增量查找可高亮可见命中，`NSTextView` 和 `NSScrollView` 提供系统集成：<https://developer.apple.com/documentation/appkit/nstextfinder>。
- Apple String Catalog：SwiftUI 视图中的多数文字可自动本地化，catalog 支持翻译与 plural variation：<https://developer.apple.com/documentation/xcode/localizing-and-varying-text-with-a-string-catalog>。
