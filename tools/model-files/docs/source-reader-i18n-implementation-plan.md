# ModelFiles 源码折叠、文件内查找与国际化实施计划

状态：执行中
日期：2026-08-21
需求：[`source-reader-i18n-requirements.md`](source-reader-i18n-requirements.md)

## 总体方案

按三个可独立验收的纵向切片交付：

```text
阅读器可行性门禁
  → Python/YAML/JSON 折叠 + 当前文件查找
  → 本地化资源与打包
  → 全应用中英文迁移
  → 两种语言真实应用验收
```

最重要的风险不是折叠扫描，而是现有 Textual `StructuredText` 没有公开的查找/折叠接口。计划不先造编辑器，也不直接引入第三方编辑器。第一任务用一个最小原生 AppKit 只读阅读器验证；宿主改为 `NSTextView`，语法高亮直接加载已随 Textual 打包、且现有脚本校验的 `prism-bundle.js`；不修改 Textual checkout、不新增依赖：

- `NSTextView` / `NSTextFinder` 能提供增量查找、命中高亮和导航；
- 折叠只改变布局，不改变底层字符串；
- 现有支持语言的语法高亮不回退；
- SwiftUI 焦点和 `⌘F/⌃F` 能正确路由。

如果 `NSTextView` + 现有 Prism bundle 无法同时满足，不继续堆补丁；先提交可行性证据，再由用户决定是否增加一个生产可用的高亮/编辑器依赖。CodeEditSourceEditor 当前官方仍声明“不适合生产”，不作为默认方案。Jinja 源码已有 `usesFindBar`，T1/T4 只验证快捷键路由，不重做其查找。

## 架构决定

### AD-1：保持现有文件分发链

不新增通用 document protocol、reader registry 或 factory。继续使用：

```text
FileClassifier.syntaxLanguage
  → FileReaderView
  → 具体只读 Reader
```

只在现有分发中补上 JSON 原文和新的源码阅读器入口。

### AD-2：折叠识别是三个具体扫描分支

一个文件内保留三个具体分支：Python/YAML 共享缩进扫描基础，JSON 使用括号与字符串状态扫描。结果使用最小值类型 `FoldRange(startLine, endLine)`；不建立 parser protocol 或语言插件系统。

扫描只产生候选范围，不验证语言合法性。失败结果为空，不阻止阅读。

### AD-3：查找优先使用 AppKit 原生能力

优先使用 `NSTextFinder` / `NSTextView.usesFindBar` / `isIncrementalSearchingEnabled`，不自行实现正则引擎、查找历史或替换。系统能力已经覆盖增量查找、长文档后台搜索和可见命中高亮。

折叠不能删除底层字符串，否则系统查找看不到隐藏内容。实现必须保留原文字符范围，并在当前命中落入折叠范围时展开。

### AD-4：一个 String Catalog，不建本地化层

使用 `Localizable.xcstrings` + SwiftUI 自动本地化 + 必要处 `String(localized:)`。不增加 `LocalizationManager`、`L10n` enum、生成器、语言设置 Store 或通知总线。

### AD-5：简体中文为 source/fallback，英文为唯一新增翻译

`Package.defaultLocalization` 与 `CFBundleDevelopmentRegion` 统一为 `zh-Hans`。系统自动选语言；没有应用内切换。

## 任务列表

### Phase 0：需求与可行性门禁

#### T0：确认 V1 合同

**说明：** 评审需求文档中的四个默认决定，冻结扩展名、快捷键、语言和大文件边界。

**验收：**

- [ ] 需求状态从“待确认”改为“已确认”。
- [ ] Python/YAML/JSON、`⌘F + ⌃F`、`zh-Hans + en`、128 KiB 折叠上限均有明确结论。

**验证：** 人工评审 `docs/source-reader-i18n-requirements.md`。

**依赖：** 无。

**文件：** `docs/source-reader-i18n-requirements.md`。

**规模：** XS。

#### T1：验证最小只读源码阅读器

**说明：** 在现有 `CodeReaderView` 内完成最小 proof，不先拆模块。proof 对象是 `NSTextView` + 现有 Prism bundle，不在 `StructuredText` 公共 API 上打补丁。验证系统查找、折叠隐藏/恢复、现有语法高亮、焦点和复制全文能共存。Jinja 源码已有 `usesFindBar`，此处只确认快捷键能路由到它，不重做查找。

**验收：**

- [ ] Python fixture 保持语法高亮，`⌘F/⌃F` 打开系统查找并高亮重复命中。
- [ ] 折叠后底层字符串与“复制全部”内容不变；查找隐藏命中可触发展开。
- [ ] 没有新增第三方依赖；若失败，记录具体失败 API/阶段并停止后续实现。

**验证：**

- [ ] 最小 AppKit 行为测试或可重复 demo。
- [ ] `swift test --disable-sandbox`。
- [ ] 真实 app 手工走一次折叠与查找。

**依赖：** T0。

**可能修改：** `Views/CodeReaderView.swift`、`Support/PrismCodeHighlighter.swift`、`Tests/ModelFilesTests/FileClassifierTests.swift`。不超过 3 个文件。

**规模：** S。

### Checkpoint A：阅读器方案

- [ ] 保持现有高亮能力。
- [ ] 系统查找与折叠能在同一只读文本面工作。
- [ ] T1 失败时状态为 `BLOCKED（阅读器能力未证实）`，不进入依赖引入或全量重写。

### Phase 1：折叠与查找切片

#### T2：实现并测试折叠范围扫描

**说明：** 添加最小的行扫描逻辑，输出 Python、YAML、JSON 的 `FoldRange`。扫描放后台执行，非法输入返回已确认范围或空数组。

**验收：**

- [ ] Python 嵌套缩进、空行、注释和最后一个块范围正确。
- [ ] YAML mapping、sequence、block scalar 和缩进变化范围正确。
- [ ] JSON 字符串内括号、转义、嵌套 object/array 和不完整输入不会产生越界范围。

**验证：** `swift test --filter SourceFoldingTests --disable-sandbox`。

**依赖：** Checkpoint A。

**可能修改：** `Support/SourceFolding.swift`、`Tests/ModelFilesTests/SourceFoldingTests.swift`。

**规模：** S。

#### T3：接入折叠 UI 与隐藏命中展开

**说明：** 在只读源码阅读器接入行号区折叠标记、隐藏行数提示、全部展开和 VoiceOver 文案。折叠只保存字符范围派生状态。

**验收：**

- [ ] 点击与键盘均可折叠/展开，嵌套范围行为确定。
- [ ] 折叠前后底层源码、复制结果和查找总数一致。
- [ ] 当前查找命中位于隐藏范围时，只展开包含它的最小范围。

**验证：**

- [ ] `swift test --filter SourceFoldingTests --disable-sandbox`。
- [ ] 真实 app 分别打开 `.py/.yaml/.json` fixture 操作。

**依赖：** T2。

**可能修改：** `Views/CodeReaderView.swift`、`Support/SourceFolding.swift`、`Tests/ModelFilesTests/SourceFoldingTests.swift`。

**规模：** M。

#### T4：统一当前文件查找路由

**说明：** 让 `⌘F/⌃F` 路由到当前文本阅读器，不被侧栏筛选吞掉；接入 code/raw/large-lines/Jinja source。复用系统 finder，不新增共享搜索 service。

**验收：**

- [ ] 两个快捷键都聚焦当前文件查找；侧栏筛选状态不变。
- [ ] 显示总数和当前序号，支持上一个/下一个/关闭。
- [ ] 大文件查找覆盖第 1,001 行之后，并保持输入响应。

**验证：**

- [ ] 小文件重复中英文 fixture。
- [ ] 128 KiB 边界 fixture 和接近 32 MiB 上限的生成 fixture。
- [ ] `swift test --disable-sandbox` 后做真实 app 快捷键检查。

**依赖：** T3。

**可能修改：** `Views/CodeReaderView.swift`、`Views/DetailView.swift`、`Views/TemplatePlaygroundView.swift`、`Tests/ModelFilesTests/FileClassifierTests.swift`。

**规模：** M。

#### T5：补齐 JSON 原文路由与大文件降级

**说明：** 在 `FileClassifier` 增加 JSON syntax language；保持配置/Tokenizer JSON 的结构化概览，并只在原文路径启用折叠。大于 128 KiB 显示“不支持折叠”说明但保留查找。

**验收：**

- [ ] `.json` 被识别为 `json`，但现有 config/tokenizer 概览不回退。
- [ ] JSON 原文可折叠；大 JSON 不折叠但可查找完整内容。
- [ ] `.py/.yaml` 和现有其它语言路由无回归。

**验证：** `swift test --filter FileClassifierTests --disable-sandbox`。

**依赖：** T4。

**可能修改：** `Support/FileClassifier.swift`、`Views/DetailView.swift`、`Tests/ModelFilesTests/FileClassifierTests.swift`。

**规模：** S。

### Checkpoint B：源码阅读

- [ ] Python/YAML/JSON 三类 fixture 的折叠验收通过。
- [ ] 小文件、大文件、折叠内命中的查找验收通过。
- [ ] 所有 Swift 测试通过，现有源码高亮和结构化 JSON 概览无回归。
- [ ] 评审后再开始全应用文案迁移，避免两个高冲突改动同时进行。

### Phase 2：本地化基础与分面迁移

#### T6：建立 String Catalog 与打包链

**说明：** 添加一个 `Localizable.xcstrings`，让 executable target 处理资源；打包脚本复制 ModelFiles 的 SwiftPM resource bundle，并校验 `zh-Hans/en` 资源存在。

**验收：**

- [ ] `swift run` 和 `dist/ModelFiles.app` 均能读取 catalog。
- [ ] `Package.swift` 的 `defaultLocalization` 与 `Info.plist` 的 development region 一致。
- [ ] 图标与 `textual_Textual.bundle/prism-bundle.js` 仍被正确打包。

**验证：**

- [ ] `swift test --filter LocalizationTests --disable-sandbox`。
- [ ] `bash script/build_and_run.sh verify`。

**依赖：** Checkpoint B。

**可能修改：** `Package.swift`、`Resources/Localizable.xcstrings`、`script/build_and_run.sh`、`Tests/ModelFilesTests/LocalizationTests.swift`。

**规模：** M。

#### T7：迁移应用壳与文件工作台文案

**说明：** 先迁移打开仓库到阅读文件的完整主路径，包括错误、加载、安全说明和新增查找/折叠 UI。动态文件内容不本地化。

**验收：**

- [ ] 工具栏、侧栏、详情页、空态、Reader 和一致性报告均有中英文。
- [ ] 返回 `String` 的标题和错误显式使用 `String(localized:)`。
- [ ] 900 × 600 下两种语言的主操作可见且可理解。

**验证：** localization key 审计 + 两种语言真实 app 主路径截图。

**依赖：** T6。

**可能修改：** `Views/ContentView.swift`、`Views/SidebarView.swift`、`Views/DetailView.swift`、`Support/EmptyStateView.swift`、`Models/InspectionDocument.swift`。

**规模：** M。

#### T8：迁移 Jinja 与 Tokenizer 工作台文案

**说明：** 分两次小提交迁移 Jinja/Template 和 Tokenizer 的输入、状态、错误、表格及可访问性文案；不重构业务状态。

**验收：**

- [ ] Jinja 源码/试验台完整中英文，渲染结果和模板源码不被翻译。
- [ ] Tokenizer 输入、彩色片段、Token 表、对照与错误完整中英文。
- [ ] 数量相关英文文案使用 plural variation，不做字符串拼接。

**验证：** 既有 Jinja/Tokenizer 单元测试 + 两种语言真实 app 流程。

**依赖：** T7。

**可能修改（提交 1）：** `Views/TemplatePlaygroundView.swift`、`Support/JinjaSyntaxHighlighter.swift`。

**可能修改（提交 2）：** `Views/TokenizerPlaygroundView.swift`、`Views/TokenizerTokenTableView.swift`、`Views/TokenizerComparisonView.swift`。

**规模：** 每次 M。

#### T9：迁移其余格式、服务错误与可访问性文案

**说明：** 按实际字符串清单处理 GGUF/SafeTensors/Imatrix、Repository/SSH、Tokenizer runtime 等剩余用户可见文本；机器可读错误标识和文件字段不翻译。

**验收：**

- [ ] `rg` 审计后，中文源码字面量只剩测试数据、用户内容示例、语言无关格式或明确注释。
- [ ] 所有用户可见错误、help 和 accessibility label 都有英文。
- [ ] 不新增本地化包装层。

**验证：**

- [ ] 全量 `swift test --disable-sandbox`。
- [ ] catalog 缺失翻译/占位符一致性检查。

**依赖：** T8。

**可能修改：** 每次按一个现有 View/Service/Support 文件组提交，单任务不超过 5 个文件；以执行时的字符串清单为准。

**规模：** 多个 S/M，不合并成一个大提交。

### Checkpoint C：国际化完成

- [ ] Catalog 无缺失英文翻译、无占位符类型不一致。
- [ ] 全量单元测试和 app bundle verify 通过。
- [ ] 简体中文与英文各完成一次真实 app 端到端验收。

### Phase 3：最终验收与文档同步

#### T10：真实应用双语言验收

**说明：** 对打包后的 app，而不是 SwiftUI preview，执行两种语言的同一流程并记录证据。

**验收流程：**

1. 以指定语言启动 `dist/ModelFiles.app`。
2. 打开包含 `.py/.yaml/.json` 的本地 fixture 仓库。
3. 分别折叠嵌套块。
4. 用 `⌘F` 和 `⌃F` 查找普通、重复和折叠内文本。
5. 打开大文件，验证第 1,001 行之后命中。
6. 切换 JSON 的概览 / 全部字段 / 原文。
7. 检查窗口最小尺寸、键盘焦点、VoiceOver label 和中英文残留。

**验证命令：**

```bash
cd tools/model-files

CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox

CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
bash script/build_and_run.sh verify

/usr/bin/open -n dist/ModelFiles.app --args -AppleLanguages '(zh-Hans)' -AppleLocale zh_CN
/usr/bin/open -n dist/ModelFiles.app --args -AppleLanguages '(en)' -AppleLocale en_US
```

**依赖：** Checkpoint C。

**可能修改：** `docs/source-reader-i18n-acceptance.md`、`README.md`、`README_CN.md`。

**规模：** S。

## 风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| Textual 不能暴露查找/折叠所需字符布局 | 高 | T1 先证实；失败即停，不修改依赖源码；新增依赖必须另行确认 |
| 折叠通过删除文字实现，导致查找/复制遗漏 | 高 | 底层字符串保持不变；fixture 验证折叠前后内容与查找总数 |
| Python/YAML 启发式误判 | 中 | 只显示能由缩进和后续行确认的范围；不承诺 AST 级语义；失败为空 |
| JSON 结构化概览被源码阅读器覆盖 | 中 | 只改原文路径，并锁定现有 overview tests |
| 侧栏搜索抢占 `⌘F` | 中 | 真实 responder-chain 测试；当前阅读器有焦点时优先文件内查找 |
| 本地化资源未进入手工 `.app` 包 | 高 | T6 同时改 Package 与脚本；verify 检查两种语言资源 |
| 直接 `Text(dynamicString)` 被误当本地化 key | 中 | 动态用户内容使用 verbatim 语义；代码审计覆盖文件名、路径和模型内容 |
| 英文变长导致最小窗口截断 | 中 | 900 × 600 双语言真实 app 检查，不只做字符串测试 |

## 提交建议

需求确认后，每个任务独立提交；T8 按 Jinja 和 Tokenizer 拆成两个提交。不要把全量国际化与阅读器重构塞进同一个 diff。每次提交只暂存对应任务文件，并保留工作区中无关改动。

建议提交序列：

```text
docs(model-files): specify source reader and localization
feat(model-files): prove native source reader interactions
feat(model-files): add source folding ranges
feat(model-files): add in-file find and folding
feat(model-files): package localization resources
feat(model-files): localize repository reader workflow
feat(model-files): localize template workspace
feat(model-files): localize tokenizer workspace
feat(model-files): complete English localization
docs(model-files): record source reader localization acceptance
```

本文授权按已确认需求实施；新增第三方依赖仍需另行确认。
