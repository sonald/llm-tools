# ModelFiles Web ↔ 原生全量对照矩阵

日期：2026-11-12 初版；2026-11-13 按工作台重设计后的代码重新审计；2026-11-14 批次 6 后复核剩余「部分」行（原生自 `6e32ede` 起无新提交）
原生对照：`tools/model-files` @ `6e32ede`（含工作台重设计 `7b69613`、`595a44f`、`0d68126`、`6e32ede`）
Web 对照：`tools/model-files-web` @ `81a8884`（含工作台重设计 `762f2dc`、`e87a905`、`81a8884`）

## 0. 规则

- **目标**：Web 与原生的用户可见功能、布局、交互和文案尽可能一模一样，以当前原生版为准。
- **例外**只有两类：
  - **平台限制**：必须引用具体的浏览器约束和证据。
  - **用户裁决**：用户明确批准的产品例外。
- 本表来自两次三路只读代码审计（壳层与侧栏 / 文件阅读器 / Tokenizer 与模板），每行引用两侧的 `file:line`。它是**差异清单，不是验收**：每行修复后必须附新证据（单测、E2E 或真实浏览器检查）才能改为 PASS。
- 原生 `ef90a92` 之后的提交在 Web 都有对应提交：`77743ea`↔`bb6e992`、`1ed4fd3`↔`fb7ea1f`、`58f16c3`↔`d0b9397`/`50757f4`、工作台 `7b69613`/`595a44f`/`0d68126`/`6e32ede` ↔ `762f2dc`/`e87a905`/`81a8884`；`f141608`、`fbca37a` 两端共用。配对只代表方向一致，细节差异按下表逐行核对。

路径缩写：
- **N:** = `tools/model-files/Sources/ModelFiles/`
- **W:** = `tools/model-files-web/src/`
- 原生视图：DV = `Views/DetailView.swift`，CV = `Views/ContentView.swift`，SV = `Views/SidebarView.swift`，IV = `Views/InspectorView.swift`，TPV = `Views/TemplatePlaygroundView.swift`，TKP = `Views/TokenizerPlaygroundView.swift`，TCV = `Views/TokenizerComparisonView.swift`，TTV = `Views/TokenizerTokenTableView.swift`
- 原生其他：ST = `Stores/ModelFilesStore.swift`，ROI = `Support/RenderedOutputInspector.swift`，TR = `Support/TemplateRenderer.swift`
- Web：App = `App.tsx`，TK = `TokenizerPlayground.tsx`，WR = `WeightsReaders.tsx`，TW = `TemplateWorkbench.tsx`，TP = `TemplatePlayground.tsx`，TQ = `core/templateRequest.ts`，RO = `core/renderedOutput.ts`，CSS = `styles.css`
- E2E：MF = `e2e/model-files.spec.ts`，JP = `e2e/json-parity.spec.ts`；单测 TPT = `core/templatePlayground.test.ts`

状态：`缺失`（Web 没有）· `不同`（有，但行为、布局或文案不同）· `平台限制`（已有证据）· `待裁决` · `未验证`（需要实测或黄金用例）· `Web 独有` · `已关闭` · `部分`（已做一部分，**仍有可做的缺口**）· `PASS（平台调整）`（其余已对齐，剩下的差异全是写明证据的平台调整或用户裁决）

**本表是压缩版。** 每行只概括差异。实现某一批前，必须重新阅读两侧引用的行号范围，逐个控件、逐条文案核对。

### 未审计范围（不在表中不代表一致）

- ~~英文界面文案~~：2026-11-14 已审计，见 §3.13
- 视觉样式、间距、系统选中色、材质：要靠截图对比，代码判断不了
- 颜色只对比了代码里的色值，没有用截图核对

## 1. 平台限制（已有证据，接受为例外）

| ID | 原生行为 | Web 处理 | 证据 |
| --- | --- | --- | --- |
| P-1 | ModelScope 来源，与 HF 并行竞速（N: `Services/RepositoryService.swift:133-160`） | 只支持 HF | 浏览器清单 CORS 门失败：`docs/feasibility-gates.md:7-30,84-86` |
| P-2 | `ssh://` 目录（N: `Services/DirectoryRepositoryAccess.swift:158-358`） | 无 | 浏览器无法建立 SSH 连接 |
| P-3 | 输入本地绝对路径或 `file://` 打开；选目录后先填进输入框，再点「打开」（ST:12-14,97,186-194） | 选中目录后直接加载 | 浏览器不能按路径访问文件系统 |
| P-4 | 本地文件「复制全路径」、「在 Finder 中显示」（DV:230-257） | 不可用 | File System Access 不暴露绝对路径，也不能在 Finder 中定位。**布局应改为禁用而不是隐藏**，见 H-5 |
| P-5 | 窗口最小尺寸、隐藏标题栏 | 不适用 | 浏览器窗口 |
| P-6 | PDFKit 连续阅读器（N: `Views/PDFReaderView.swift:12-21`） | blob iframe，W: `Readers.tsx:223-240` | 浏览器内置 PDF viewer，SPEC §4.2 |
| P-7 | `tokenizer_class` 覆盖恢复（TKP:69-70,421-422,520-546,625-634） | 不适用 | `@huggingface/tokenizers` 不按 class 分派；用户已批准，SPEC §3 |

## 2. 待裁决

**2026-11-13 用户裁决：**

- **D-1**：跟原生一样。接入完整 GGUF 解析，按原生的 1 MiB 分块、32 MiB 上限读取，接受少量越读；同时补 Q-9。
- **D-4 / D-5 / D-6**：对齐原生，界面一次显示全部，内部做懒渲染。
- **D-7**：CSP 的 `img-src` 放宽到 `https:`。
- **D-13**（2026-11-13）：方案 ①。Web 保持 transformers 的 `tojson` 行为，原生的 swift-jinja 偏差另行修复。
- **D-9 / D-11**：
  - 保留不与原生冲突的：HTTPS 来源、深链、清除历史、复制反馈。
  - 删除或改回原生样式：底部状态栏移回工具栏；读取信息条改成原生的底部提示；去掉占比条和行内问题说明。
  - §4 其余各项实施时逐项按这条原则处理。

- **D-2 / D-3 / D-12**（2026-11-14）：历史不限条数、只记 Hugging Face（本地目录无法凭路径重开，平台限制）；启动时重开上次输入，默认 Qwen/Qwen3-4B（`?repo=` 优先）；背景改成接近 macOS 系统色。

**尚未单独确认，默认对齐原生**（实施到相关批次时再确认）：

- **D-8**：取消 Chat Template 的 64 KiB 上限。
- **D-10**：Web 不加 ⌘1–4 视角快捷键，保留浏览器原有的切换标签页（2026-11-13 用户裁决）。
- **D-15**（2026-11-14 用户裁决）：原生有 7 处中文字面量不在 xcstrings（图片阅读器、图片提示，E-4），英文界面显示中文。Web 保留英文，原生另行补进 catalog。


| ID | 原生行为 | Web 现状 | 说明 |
| --- | --- | --- | --- |
| D-1 | GGUF 完整 metadata + tensor 工作区（DV:348-362,415-459,687-1007） | 只读 24 bytes，显示 4 个计数（App:382-384,1503-1527） | `docs/gguf-feasibility.md` 判 NO-GO，原因是按 1 MiB 顺序读 Range 时，最后一块会越过 tensor 数据起点。Qwen3-0.6B 实测越读了 339,552 字节，但 32 MiB 预算和 2 秒耗时都通过了，没过的只是自定的「0 字节 tensor 数据」规则。原生 `RepositoryService.swift:359-390` 用的正是同一策略，并接受这部分越读。Web 的完整解析器 `core/gguf.ts:42 inspectGGUF()` 已存在，但页面没有调用。连带缺 GGUF 相关一致性问题（Q-9）。→ 批次 5 已实现（G-1、Q-9），2026-11-14 |
| D-2 | 历史不限条数，含本地路径和 ssh（ST:160-166,1163-1189） | 最多 10 条，只存 HF ID（`core/history.ts:17,27`） | 本地路径无法重开（P-3），条数上限可以对齐 → 已裁决：不限条数，只记 Hugging Face。批次 6 去掉 10 条上限，2026-11-14 |
| D-3 | 启动时重开上次输入，默认 **Qwen/Qwen3-4B**（ST:12-14,97） | 固定 Qwen/Qwen3-0.6B，只有带 `?repo=` 时才自动打开（App:121,198-226） | → 已裁决：跟原生一样。批次 6：启动时重开上次成功打开的 Hugging Face 输入（`model-files.last-repository-input`），默认 Qwen/Qwen3-4B；`?repo=` 优先。上次打开的是本地目录或 HTTPS 来源时，启动不打开任何东西（同原生 `shouldOpenOnLaunch`，ST:96）。「清除历史」同时清掉它。真实 Hugging Face 首次启动未实测（本机代理不通），只用 fixture 验证，2026-11-14 |
| D-4 | JSON 不限大小整份渲染；其他语言 ≤128 KB 进代码阅读器，否则用纯文本全量显示（DV:633-650） | 按 128K 字符分页（`Readers.tsx:369,419-422,674-680`） | 性能选择 |
| D-5 | Token 流、表、IDs 全部显示（TTV:73-77,185-213） | 每页 1,000 条；>2,000 个 id 折叠成一个片段；>100 个 id 合并成一个片段（`core/tokenizer.ts:222`，App:2821,2831,2870,2887,2899）。停靠的 Token IDs 标签**没有**「再显示」按钮，超过 1,000 条看不到 | 性能选择。→ 已裁决：全部显示，内部懒渲染（2026-11-13）。批次 4 已按原生 makeSegments 切片（去掉 100/2,000 合并），Token 表只渲染可见行，Token 流和 IDs 全部渲染 |
| D-6 | Tensor 列表一次全部显示（DV:869-874） | 每次 100 行（App:1112,1275） | SPEC §4.7。→ 已裁决全部显示；批次 5 改为虚拟表，2026-11-14 |
| D-7 | Markdown 加载第三方 HTTPS 图片（`MarkdownReaderView.swift:226-259`） | 显示占位；CSP 为 `img-src 'self' data: blob:`（`index.html:9`） | 是否放宽 CSP。→ 已裁决；批次 5 `img-src` 加入 `https:`，2026-11-14 |
| D-8 | Chat Template 没有单独上限（只有 32 MiB bundle 上限） | 64 KiB（`tokenizerClient.ts:183-186`，App:540,1812,1923 的 tokenizer Chat 读取）；2026-11-13 已取消 `.jinja` 阅读器和试验台的上限，批次 4 又取消了 tokenizer Chat 和一致性检查读取的上限（只保留渲染后输入的 64 KiB，同原生） | Tokenizer 输入的 64 KiB 两端一致，不在此列 |
| D-9 | — | Web 独有功能（§4） | 保留、改造还是删除 |
| D-10 | ⌘1–⌘4 切换视角（DV:262-275） | 没有 | 只查了资料，没有实测：Chrome/Edge、Firefox 页面能拦截（Chromium 保留键列表不含按序号切标签，Mozilla Bug 1074971），Safari 很可能拦不到（只有一篇厂商 KB 佐证）。→ 已裁决：Web 不加，算平台差异（2026-11-13） |
| D-11 | 状态放在工具栏右侧，原生**没有**底部状态栏（CV:62-77） | 新增底部状态栏：仓库状态，以及与头部重复的「路径 · 格式 · 大小」（App:759-777） | 保留状态栏，还是移回工具栏 → 已移回工具栏右侧，底部状态栏已删除（2026-11-13）；状态内容见 S-6 |
| D-12 | 原生明确保留系统背景材质（`Support/Palette.swift:5` 注释） | 自定义暗色背景面（CSS:1-19,698-716） | 是否改为接近系统色 → 已裁决：接近系统色。批次 6 把 `--panel`/`--bar`/`--sidebar`/`--line` 等改成 macOS 中性灰（浅色 textBackground #fff、windowBackground #ececec；深色 #1e1e1e/#2d2d2d），次要文字改为 #636366，浅色下在侧栏、工具栏、白底实测 4.89–5.07:1（系统 secondaryLabel 只有约 3.9:1），2026-11-14 |
| D-13 | swift-jinja：`tojson` 排序键、紧凑分隔符、`\u00e9` 和 `\/` 转义；JSON 变量里的 `true` 变成 `1`；JSON `null` 报错；小数 `1.0`、`7/2→3.0` 保留小数点；`sort_keys=false` 或其他 separators 直接报错（TR:116-130，2026-11-13 金样） | @huggingface/jinja：插入顺序、`", "`/`": "`、不转义；`true`/`null` 正常；JS 数字不区分 `1.0` 和 `1`；kwargs 全部支持 | transformers `chat_template_utils.py` 的 `tojson` 是 `json.dumps(x, ensure_ascii=False, indent=None, separators=None, sort_keys=False)`，Web 与之一致，原生偏离。可选：①Web 保持 transformers 行为，原生另行修复；②Web 模拟原生输出。→ 已裁决 ①（2026-11-13）。另：原生 `RenderedOutputInspector.prettyPrintedJSON` 遇到标量 JSON 负载（如 `<\|content_x\|>123`）会抛 ObjC 异常导致崩溃，Web 不复刻 |
| D-14 | swift-transformers 要求显式 `tokenizer_class` 时，失败页给出 Picker + 自定义输入，「使用指定的 tokenizer_class 重试」（TKP:520-545,626，`Support/TokenizerRuntime.swift:23,145`） | Web 没有这个界面 | Web 用 `@huggingface/tokenizers`（`tokenizer.worker.ts:105` `new Tokenizer(tokenizer.json, config)`），按 tokenizer.json 的 model 类型构造，库里没有任何地方读 `tokenizer_class`（dist 中 0 处引用）；实测 config 为 `{}` 或 `tokenizer_class: "NoSuchTokenizerClass"` 时都能正常编码。原生的失败场景在 Web 不会出现。→ 已裁决：算引擎差异，Web 不做（2026-11-13） |

## 3. 缺口矩阵

### 3.1 工具栏、来源与状态

| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| S-1 | 仓库输入框占位符与 tooltip | CV:41,45,99 | App:618-632 | PASS（平台调整） | 2026-11-14：占位符「模型 ID 或仓库 URL…」，tooltip「输入模型 ID 或仓库 URL」。平台调整：去掉「本地路径」「ssh://」，Web 不能凭输入的路径打开（P-1、P-3）。2026-11-14 复核：剩余差异均为平台调整或裁决，没有可做的缺口 |
| S-2 | 输入时弹出的指引（模型仓库 / 本地目录 / SSH） | CV:156-176,205-238 | 缺 | PASS（平台调整） | 2026-11-14：聚焦或输入时在输入框下方显示同宽指引，失焦、回车、选历史、Esc 时关闭。平台调整：只保留「模型仓库 — Qwen/Qwen3-4B 或仓库 URL」一行，本地目录和 SSH 两行在 Web 无法输入。2026-11-14 复核：剩余差异均为平台调整或裁决，没有可做的缺口 |
| S-3 | 历史下拉 | CV:38-44,112-133（只列历史） | App:633-637 | PASS | 2026-11-14：datalist 只列历史，去掉 2 个硬编码示例。不限条数见 D-2 |
| S-4 | 选择目录按钮 | CV:47-53（只有图标，help「选择本地模型目录」） | App:641-650（文字按钮） | PASS | 2026-11-14：只有文件夹图标，无障碍名称「选择文件夹」，tooltip「选择本地模型目录」。选中后直接加载属 P-3 |
| S-5 | 「打开」按钮：加载中禁用；⌘Return 在整个窗口生效 | CV:55-59 | App:624-629,638-640 | PASS | 2026-11-14：按钮固定为「打开」，清单加载期间禁用（同原生，清单返回即解除，不等首个文件）；⌘Return（非 macOS 为 Ctrl+Enter）在整个窗口生效，加载中同样不生效；输入框回车始终可重开（同原生 onSubmit） |
| S-6 | 来源状态：「来源 · 分支 · 文件 SHA」，加载中显示 spinner | ST:99-111，CV:62-77 | App:759-771（底部状态栏） | PASS | 2026-11-13：工具栏显示「Hugging Face · main · SHA {文件 SHA，未选文件时用 commit}」，绿色对勾，加载中 spinner。本地为「本地 · 实时目录」。HTTPS 来源原生没有，用「HTTPS · 实时来源」 |
| S-7 | 模型 URL 解析：http(s)、www | `RepositoryService.swift:178-199` | `core/huggingface.ts:64-73` | PASS（平台调整） | 2026-11-14：接受 http/https、huggingface.co 与 www.huggingface.co（主机不分大小写），取前两段路径。平台调整：modelscope.cn 留到 Web 有 ModelScope 来源时再做。2026-11-14 复核：剩余差异均为平台调整或裁决，没有可做的缺口 |
| S-8 | 仓库加载错误：详情区显示「无法打开位置」+ 重试 | DV:70-78 | App:690-697（侧栏内联） | PASS | 2026-11-13：未选文件时详情区显示「无法打开位置」+ 消息；可重试时显示「重试」。本地目录选择失败不可重试，所以没有按钮 |
| S-9 | 工具栏品牌区 | CV:26-36 | App:605-609 | PASS | 2026-11-14：去掉「Web」标签，只剩图标 +「Model Files」 |
| S-10 | 工具栏两层结构：窗口工具栏 + 详情头（文件名、副标题、徽章、格式、视角、3 个按钮） | CV:38-90，DV:143-276 | App:604-675,858-898（单层可换行） | PASS（平台调整） | 2026-11-13：两层结构、视角控件、面板开关禁用已对齐。平台调整：手机宽度（≤640px）没有空间放第三栏，检查器和它的开关隐藏。2026-11-14 复核：剩余差异均为平台调整或裁决，没有可做的缺口 |
| S-11 | 键盘：⌘Return、⌘1–4、Esc 在任意标签关闭底部面板 | CV:58，DV:266,1708 | App:624-629,1337,175 | PASS（平台调整） | 2026-11-14：⌘Return 见 S-5；Esc 在任意标签、窗口任意位置关闭底部面板（输入法组字时除外）。⌘1–4 按 D-10 不做。2026-11-14 复核：剩余差异均为平台调整或裁决，没有可做的缺口 |

### 3.2 侧栏

| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| B-1 | 行主文本为文件名，嵌套路径作副标题 | SV:121-129,171 | App:724 | PASS | 2026-11-13：主文本为文件名，嵌套路径作副标题；为了让嵌套文件可区分，按钮的可访问名称仍以完整路径开头 |
| B-2 | 行副标题说明（「含内嵌 Chat Template（如有）」「只读取 JSON Header」等） | SV:165-172 | 缺 | PASS | 2026-11-13：备注规则和优先级同原生（特殊备注优先于路径） |
| B-3 | 分类图标 | SV:117-120,151-163，`Palette.swift:13-21` | App:3077-3095，CSS:126-136,725-729 | PASS | 2026-11-13：7 个分类图标 + 可预览权重图标，用手绘 SVG 代替 SF Symbol（平台限制，形状近似），颜色用 Palette.glyph，锁定行灰色 |
| B-4 | 权重组折叠，标签「权重文件 · N/M 可预览」，锁定行变暗且不可选 | SV:55-81 | App:702-731 | PASS | 2026-11-13：`<details>` 默认折叠，标签「权重文件 · N/M 可预览」；锁定行 0.62 透明度、aria-disabled、点击无效，右键菜单仍可用；深链仍可打开锁定页。E2E「workbench shell follows native header, sidebar and panel conventions」 |
| B-5 | 无匹配时显示「没有匹配文件」+「清除筛选」 | SV:27-36 | 缺 | PASS | 2026-11-13：「没有匹配文件」+「清除筛选」 |
| B-6 | 侧栏空状态（图标 + 文案）和加载中 spinner | SV:13-26 | App:698-700 | PASS | 2026-11-13：未打开时「尚未打开模型」（文案去掉 SSH，加上 HTTPS，P-2），加载中「读取文件清单…」+ spinner |
| B-7 | 侧栏可调宽（255–360）、可折叠 | CV:11-12 | CSS:93（固定 280px） | 部分 | 2026-11-14：侧栏默认 292px，拖动范围 255–360px；工具栏最左「隐藏边栏 / 显示边栏」按钮折叠。平台调整：≤900px 固定 230px 不可拖，≤640px 侧栏放到上方；不支持拖到最小以下自动折叠。**仍缺（不是平台限制）**：原生侧栏拖到最小宽度以下会自动折叠，Web 停在 255px |
| B-8 | 右键菜单：本地来源也显示「复制全路径」（禁用）和「打开原始文件」 | SV:89-109，ST:1127-1152 | App:778-808（本地时隐藏这两项） | PASS | 2026-11-14：本地来源也显示「打开原始文件」+ 分隔线：图片、PDF 用 blob URL 在新标签打开，其余文本（含 HTML、SVG）按纯文本打开，避免在本站源下运行；权重文件改为下载，与 Hub resolve 链接的行为一致。三引擎都实测了真实新标签和下载；「复制全路径」保留但禁用（P-4），Hugging Face 来源照常可用 |
| B-9 | 文件大小：以 1000 为底，本地化（「2 KB」「字节」） | `Support/FileClassifier.swift:113-117` | `core/huggingface.ts:416-420`（以 1024 为底的 KiB，中文界面显示英文 bytes） | PASS | 2026-11-13：`formatBytes` 改为 ByteCountFormatter(.file) 规则（1000 为底，KB 整数、MB 一位、GB 起两位，先舍入再选单位，「Zero KB / 0 KB」「1 byte / 1 字节」），en 与 zh-Hans 都按 ByteCountFormatter 实际输出核对并写进单元测试。2026-11-14 复核：「32 MiB」硬编码文案和 validation strip 已随批次 2 / D-11 删除，剩下的「1 MiB」只出现在 Web 独有的 HTTPS 清单说明里。错误消息的文案见 §3.12 |
| B-10 | 分类与排序规则（processor 排除、tiff/tif、adapter 与 processor 排序） | `FileClassifier.swift:9-11,65-110` | `core/huggingface.ts:75-95,154-156,482-501` | PASS | 2026-11-14：adapter / preprocessor / processor_config.json 归配置；`*_config.json` 排除含 processor 的名称；图片扩展名加 tiff、tif（只有 WebKit 能解码 TIFF，Chromium、Firefox 显示「无法显示图片」，平台限制）；优先排序表与原生一致；同优先级按数字、不区分大小写比较（localizedStandardCompare；ICU 排序规则在第一层本就不分大小写） |
| B-11 | 侧栏问题计数：权重组不显示 | SV:60-69,132-140 | App:1431-1440，CSS:110-111,725 | PASS | 2026-11-13：权重组不显示问题计数 |

### 3.3 详情头部

| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| H-1 | **头部统一分段控件「概览 / 全部字段 / 原文（/ 试验台）」，所有文件类型共用** | DV:207-220，`Models/InspectionDocument.swift:119-134` | 每个阅读器自带一排标签（`Readers.tsx:110-112,191,283`，TW:130，App:1153,2379） | PASS | 2026-11-13：统一分段控件在 `FileHeader`，视角集合 `core/readers.ts` `inspectionPerspectives` 与 `InspectionDocument.perspectives` 逐项一致（另加原生 ST:86-94 的 tokenizer.json / `.model` 试验台），选文件或换仓库时回到概览。2026-11-14 复核：过渡项都已消失——Markdown 三视角（C-8）、代码概览高亮其余纯文本（C-1）、无效 JSON 保留视角（R-3）、GGUF 三视角（G-1）、内嵌模板不再有小标签（R-8）；格式胶囊含「GGUF Imatrix」 |
| H-2 | 副标题「用途 · 大小 · 来源 · 分支 · SHA」，文件名 21pt | DV:149-173,278-297 | App:863-866（13px 面包屑 +「格式 · 大小」） | PASS | 2026-11-13：h1 21px 圆体；副标题「用途 · 大小 · 来源 · 分支 · SHA」，大小未知时省略。E2E「workbench shell follows native header, sidebar and panel conventions」 |
| H-3 | 一致性徽章：带图标，有 help，只在选中文件后出现；点击打开问题面板 | DV:178-196,305-320 | App:883-885,1296-1319 | PASS | 2026-11-13：四种状态的图标（时钟 / 三角 / 问号 / 对勾）、title「查看仓库一致性报告」、胶囊 14% 着色、Palette 色值；只在有文件时显示。图标是手绘 SVG，形状与 SF Symbol 不完全相同 |
| H-4 | 格式标签只用于结构化格式（SafeTensors / GGUF v3 / Imatrix DAT / Jinja / PDF / SVG / Image） | DV:198-205，`InspectionDocument.swift:136-146` | App:865,3138-3150（并进副标题） | PASS | 2026-11-13：独立格式胶囊，规则同原生：载入后用文档的格式名（GGUF v{n}、SVG、Imatrix DAT），载入前用文件结构格式；JSON、文本、Markdown、tokenizer 不显示 |
| H-5 | 图标按钮：复制文件路径 / 复制完整路径或 URL / 在浏览器中打开当前版本（本地：在 Finder 中显示）；不可用时禁用 | DV:222-257 | App:867-880 | PASS | 2026-11-13：三个图标按钮，aria-label 用原生标签（复制路径 / 复制全路径 / 在源站打开），title 用原生 help。不可用时禁用（本地文件按 P-4）。保留 Web 独有的「已复制」反馈 |
| H-6 | config 概览内嵌一致性报告 | — | — | 已关闭 | 两端都改为文件内诊断 + 问题面板（§3.4） |
| H-7 | 底部只读安全提示条（锁图标） | DV:393-413 | `App.tsx` SafetyNotice + `safetyNotice()` | PASS | 2026-11-13：SafeTensors/GGUF/imatrix/PDF/图片/权重索引用原生文案；PDF 按 P-6 改为「浏览器内置查看器」。Jinja 概览和 tokenizer.json 结构页仍有各自的信息条，归 J-/T- 行。2026-11-14：GGUF 提示已是原生全文（含「最后一个 Range…」，`wtGgufNotice`） |
| H-8 | 状态页：未选文件、加载中（按格式区分文案 +「大小 · 来源 · 可切换到其他文件取消」）、锁定、「没有内容」、「无法读取文件」 | DV:80-139，`Support/EmptyStateView.swift` | App:1022-1040,3042-3067 | PASS | 2026-11-13：未选文件、加载中（按格式文案 +「大小 · 来源 · 可切换到其他文件取消」）、锁定、无法读取、无法打开位置都按原生文案和图标。2026-11-14：「没有内容」在 Web 不可达（每种文件都有对应 inspection），按不可达关闭 |

### 3.4 工作台：底部面板、问题与检查器

| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| L-1 | 底部面板显示条件与开关 | DV:48-52，CV:80-84 | App:969-980,887-891 | 一致 | |
| L-2 | 标签顺序「问题(N)、Token 表、Token IDs(token 数)」，计数为胶囊 | DV:1689-1694 | App:1331-1334（Token 表、Token IDs、问题 N） | PASS | 2026-11-13：顺序「问题、Token 表、Token IDs」；计数为胶囊，没有报告时不显示，Token IDs 显示 token 数。E2E「workbench shell follows native header, sidebar and panel conventions」 |
| L-3 | 问题标签激活时，右侧显示徽章状态文字 | DV:1696-1709 | App:1354-1356 | PASS | 2026-11-13：问题标签激活时右侧显示徽章状态文字 |
| L-4 | 面板高度可拖动（110–600，默认 240） | DV:42,1654-1677 | CSS:175-176,675（固定） | PASS | 2026-11-13：顶边拖动，110–600，默认 240。手机宽度仍用固定高度 |
| L-5 | Esc 在任意标签、全局关闭面板 | DV:1708 | App:1337-1343（只在问题标签、焦点在面板内） | PASS | 2026-11-13：窗口级 Esc 在任意标签关闭面板；查找框、右键菜单先消费 Esc。关闭时焦点回到徽章（Web 保留） |
| L-6 | 检查器：默认打开，窗口 <1100pt 自动关闭，宽 220–380 可调 | CV:7,15-24 | App:145-148，CSS:200-203,650-653,674 | PASS（平台调整） | 2026-11-13：默认打开，窗口 <1100 自动关闭且不自动重开，宽度 220–380 可拖（默认 260）。平台调整：≤900px 堆到下方，≤640px 隐藏（见 S-10）。2026-11-14 复核：剩余差异均为平台调整或裁决，没有可做的缺口 |
| L-7 | 检查器「文件」区与空文案 | IV:49-62 | App:1389-1398 | 一致 | 大小格式见 B-9 |
| Q-1 | 问题面板空状态与「核心材料不足」提示 | DV:1778-1835 | App `ConsistencyReportBody` | PASS | 2026-11-14：材料不足提示、「未发现可报告的不一致。」、加载中转圈（MF 一致性用例） |
| Q-2 | 问题行：中间截断 | DV:1840-1867，IV:137-145 | App `ConsistencyReportBody` / `MiddleTruncated` / `SeverityIcon` | PASS | 2026-11-14：中间截断用两段（头部省略号 + 尾部 rtl 裁剪）；严重度图标改为三角 / 圆形 SVG，颜色取原生色板 |
| Q-3 | 「身份」区：标题，key、value、来源，与 Coverage 并排 | DV:1800-1809,1875-1887 | App `ConsistencyReportBody` | PASS | 2026-11-14：窄屏上下排 |
| Q-4 | Coverage：带状态图标的列表，材料名同原生 | DV:1811-1827,1889-1926 | App `CoverageIcon`，`materialTitles` | PASS | 2026-11-14：原表写的「材料名本地化」有误，原生显示原始名（config、generation_config、chat template、GGUF…），Web 一致 |
| Q-5 | 检查器「选中问题」区（含来源） | IV:18-47,121-134 | App `Inspector` / `FindingComparison` | PASS | 2026-11-14：两侧字段都显示来源（文件内嵌 / 应用推导 / 来源信息） |
| Q-6 | 选中问题时不强制打开检查器 | IV:18，ST `selectedFindingID` | App `onSelectFinding` | 已关闭 | 2026-11-14 按 D-9「删冲突的」：Web 不再强制打开检查器（MF 一致性用例） |
| Q-7 | 文件内问题列表：贴满宽度的 bar 行，选中底色为 accent 16%，每行有 note tooltip | DV:477-540 | `Readers.tsx` JsonInspection，CSS `.reader-diagnostics` | PASS | 2026-11-13 |
| Q-8 | 哪些文件显示诊断和侧栏计数：config、generation_config、**tokenizer_config** | ST:930-945 | App:504-506 | PASS | 2026-11-13：tokenizer_config 有问题列表、行标记和侧栏计数（E2E 覆盖） |
| Q-9 | GGUF 上下文和词表不一致锚定到 config.json | `Support/ConsistencyAnalyzer.swift:287-314,494-505`，ST:1032-1039 | `core/consistency.ts`，App `ggufMaterial` | PASS | 2026-11-14：只用当前会话已打开的 GGUF（按路径第一个），否则「未在当前会话打开」；打开 GGUF 后重新分析；embedding 按原生顺序选 tensor（`consistency.test.ts`，MF 一致性用例）。**原生 bug，Web 照搬**：两端都按文件顺序保存维度，ggml 的 `token_embd.weight` 是 `[n_embd, n_vocab]`，`shape.first` 取到的是 embedding 宽度而不是词表大小；只在仓库同时有 tokenizer 时会误报，应两端一起改成取最后一维 |
| Q-10 | 原文行标记：只给文字范围着色（warning 20%、info 14%，亮暗自适应） | `CodeReaderView.swift:400-413` | `CodeReader.tsx` `.line-text[data-severity]` | PASS | 2026-11-13：浮动注释已删，注释只在问题列表 tooltip 和检查器里 |
| Q-11 | 点击问题跳行：放在视口上方 1/3，放置光标并闪烁查找指示 | DV:509-513，`CodeReaderView.swift:415-436` | `CodeReader.tsx` jump effect | PASS | 2026-11-13：行放在上方 1/3，光标落在行首，闪烁动画；最后几行到不了 1/3 时停在底部 |

### 3.5 JSON 与摘要阅读器

| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| R-1 | **JSON「全部字段」是整份格式化的代码阅读器（高亮、折叠、查找）** | DV:544-545,654-685 | `Readers.tsx` FormattedJson + `core/jsonSource.ts` formatJsonSource | PASS | 2026-11-13：移植原生 formattedSource（按字符，保留数字和字符串原样） |
| R-2 | 没有专门摘要的 JSON，概览也是格式化代码 | DV:544,615-626 | `Readers.tsx` JsonInspection | PASS | 2026-11-13 |
| R-3 | 无效 JSON：代码上方显示红色错误详情，视角保留 | DV:660-666 | `Readers.tsx` FormattedJson | PASS | 2026-11-13：2026-11-14 改为同原生「JSON: 」+ Foundation 原文（M-2） |
| R-4 | 摘要布局：标题 + 副标题 + 分组属性行 | DV:2134-2187 | `Readers.tsx` SummaryView，CSS `.reader-title/.property-group/.key-value-row` | PASS | 2026-11-13 |
| R-5 | 取值格式：null、数组、对象内联显示，大整数完整显示 | DV:2222-2230 | `core/jsonValue.ts` nativeInline/nativeNumberString | PASS | 2026-11-13：单元测试固定了 Swift 输出 |
| R-6 | config.json：标题为 architectures[0]，没有就用 model_type，再没有就用「模型配置」；副标题 `model_type · torch_dtype · N layers`；分组「模型规模 / Attention / 上下文」，含 intermediate_size、num_attention_heads、num_key_value_heads、head_dim、max_position_embeddings、rope_theta | DV:1929-1973 | `core/readers.ts` jsonSummary(config) | PASS | 2026-11-13 |
| R-7 | generation_config：「采样」「终止与长度」两组；有 Top K、PAD、重复惩罚，没有 BOS；数组 EOS 照常显示；最大新 token 只读 max_new_tokens | DV:1975-2000 | `core/readers.ts` jsonSummary(generation) | PASS | 2026-11-13 |
| R-8 | **tokenizer_config：标题为 tokenizer_class；「核心设置」含最大长度 / Padding side / BOS / EOS / UNK；内嵌可折叠的 Chat Template 试验台（只用配置里的 chat_template，变量由配置预填）；有文件内诊断** | DV:2002-2038，TPV:592-606 | `core/readers.ts:50-57`，TW:80-97 | PASS | 2026-11-13：标题、核心设置、诊断已对齐。内嵌试验台是折叠的「Chat Template 试验台」+ 说明，展开时才创建、收起即丢弃临时修改（按 SwiftUI DisclosureGroup 语义，未在原生界面实测），高 640，用配置自己的 chat_template 和 bos/eos/pad/unk 预填（MF「opens every supported local directory reader」：`unk_token` 预填、实时输出） |
| R-9 | 权重 index：标题「权重分片索引」，总大小格式化，「前 80 条映射」列表 | DV:2040-2065 | `core/readers.ts` jsonSummary(weightIndex) | PASS | 2026-11-13 |
| R-10 | vocab.json 专用视图：「共 N 个 token」、按 token/ID 搜索、按 ID 排序、显示前 1,000 条 | DV:2067-2107 | `Readers.tsx` VocabSummary + `core/readers.ts` vocabEntries | PASS | 2026-11-13 |

### 3.6 源码、文本与 Markdown

批次 5 证据：`e2e/readers-parity.spec.ts`（RP）、`e2e/weights-parity.spec.ts`（WP）、MF 一致性用例，三个引擎全过。


| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| C-1 | 代码文件也有三个视角 | DV:543-560,601-650 | `Readers.tsx` SourceInspection | PASS | 2026-11-13：概览高亮，全部字段/原文是纯文本 |
| C-2 | >128 KB 代码、`.txt`、merges.txt：完整换行文本 + 系统查找 | `Support/InFileFindTextView.swift:97-157`，DV:601-613 | `CodeReader.tsx`（language=null） | PASS | 2026-11-13：整篇文本懒渲染，按字符换行；查找用 Web 自己的查找条（Cmd/Ctrl+F），32 MiB 尾部查找 <1 s |
| C-3 | 代码不换行，横向滚动；字号 12.5pt | `CodeReaderView.swift:207-249` | `CodeReader.tsx`，CSS `.code-reader` | PASS | 2026-11-13。平台调整：超过 4K 字符的单行（压缩 JSON）切成 4K 字符一行显示，滚动到时保持纯文本，查找、跳转、标记命中的那段才高亮；原生是一整行全高亮。WebKit 对超长无换行行的排版太慢（64K 字符一行时查找要 8 s） |
| C-4 | 语法高亮 | `Palette.swift:24-48`，`CodeReaderView.swift:660-684`，Textual `flattenPrismTokens` | `core/syntaxTokens.ts`，`sourceHighlight.worker.ts`，`core/jsonSource.ts` | PASS | 2026-11-14：按原生表映射 Prism 类型（取最内层 type，忽略 alias；含 literal、directive、function-name、attribute、variable、inserted→string、deleted→structure 等）；keyword、boolean、literal 加粗 600；注释不再斜体（`syntaxTokens.test.ts`，RP「C-4…」） |
| C-5 | 查找：增量查找，包含 / 前缀 / 整词选项，⌘G，不需要焦点 | `InFileFindTextView.swift:4-95`（AppKit NSTextFinder 查找栏） | `Readers.tsx` FindBar，`core/readers.ts` `TextFindOptions` | 部分 | 2026-11-14：布局和文案按 AppKit 查找栏实测（放大镜菜单：忽略大小写 / 循环查找 / 包含 / 开头是 / 整个词；框内只显示总数；‹ › 与「完成」）；⌘F 不需要焦点，⌘G / ⇧⌘G 上下一个（单测 + RP「C-5…」）。快捷键：三个引擎的合成按键都被页面拦截（preventDefault）；真实按键只在 Chromium 内核的应用内浏览器实测过，Safari / Firefox 是否会先弹出自带查找未验证。渲染 Markdown 没有查找，同原生。**仍缺**：框内清除按钮、插入模式 / 最近搜索；整词边界按 `[\p{L}\p{N}\p{M}_]` 近似（CJK 与 ICU 断词不同）；「开头是 / 整个词」的语义按 Apple 文档实现，原生只实测了默认「包含」 |
| C-6 | Markdown 去掉 YAML front matter | `MarkdownReaderView.swift:127-136` | `core/modelCardMarkdown.ts` | PASS | 2026-11-14：逐行移植并带原生单测用例。原生按 Character 切行，`\r\n` 算一个字符，CRLF 文件的 front matter 不会被去掉；Web 有意照搬（单测覆盖），属于原生 bug，两端应一起修 |
| C-7 | Markdown 内联 HTML：`<img>`、`<a>`、`<br>` 转成 Markdown，其他标签剥离，保留图片宽度 | `MarkdownReaderView.swift:147-259` | `core/modelCardMarkdown.ts`，`Readers.tsx` ModelCardImage | PASS | 2026-11-14：顺序同原生；仍不渲染原始 HTML、保留 URL 协议过滤；只加载 `https:` 图片（no-referrer），失败时显示 alt。单测 + RP 断言事件属性、`javascript:`、script/iframe 均被去掉 |
| C-8 | Markdown 主题用分段控件；三个视角，全部字段和原文是纯文本 | `MarkdownReaderView.swift:8-40,110-123`，DV:543-613 | `Readers.tsx` MarkdownReader | 部分 | 2026-11-14：「Markdown」标题 +「排版主题」+ GitHub / 默认 / 紧凑分段控件，正文最宽 920 px；窄屏不撑宽（RP 宽度用例含长代码行）。**仍缺**：三套主题的排版只近似 Textual 的 `.gitHub` / `.default` 样式 |
| C-9 | 图片工具栏「W × H px · 扩展名 · 大小」、1:1、步长 0.25、按尺寸缩放并可滚动 | `ImageReaderView.swift:24-180` | `Readers.tsx` ImageReader | PASS | 2026-11-14：适应窗口 / 1:1 / 缩小 / 放大，25%–500%，按实际像素缩放（不用 transform），无固有尺寸的 SVG 以 400 px 为基准；解码失败显示原生文案（RP「C-9…」）。原生 xcstrings 没有这几个词的英文，英文为 Web 自拟 |
| C-10 | Jinja 概览（大小、行数、来源、状态 +「查看源码」「打开试验台」）；就地编辑高亮（6 类 token，系统色）；「源码详情」侧栏 | DV:1009-1103，`Support/JinjaSyntaxHighlighter.swift:128-156` | TW:8-77，TP:88-123，`core/jinjaHighlight.ts` | PASS | 2026-11-13：概览是「Jinja Chat Template」+ 副标题 + 带来源列的「概览」事实表 + 两个按钮（切换视角）；源码视图有「临时修改」标记、「恢复来源原文」、可拖动（260–390）的「源码详情」侧栏（行数按原生含空行）。三个视角共用一份临时源码（MF「Jinja workspace shares one temporary source…」）。高亮按原生分层顺序（TPT），颜色取 macOS 系统色。**平台调整**：浏览器没有可富文本的 textarea，编辑器是透明 textarea 叠在排版相同的高亮 `<pre>` 上，textarea 负责滚动、`<pre>` 同步滚动位置；三个引擎实测：加粗 token 宽度差 0，两层内容高度一致，方向键和输入时光标都在可见区内，滚到底两层偏移相同（MF「…follows the selection in long output…」） |
| C-11 | 「全部展开」：左对齐，小号无边框 | `CodeReaderView.swift:31-42` | CSS `.fold-toolbar` | PASS | 2026-11-13 |

### 3.7 SafeTensors / GGUF / imatrix

批次 5 证据：`e2e/readers-parity.spec.ts`（RP）、`e2e/weights-parity.spec.ts`（WP）、MF 一致性用例，三个引擎全过。


| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| W-1 | SafeTensors 概览：标题、带「来源」列的事实行、主要数据类型、Header 大小、两个「查看全部」按钮 | DV:285-293,323-341,725-729 | `WeightsReaders.tsx`，`core/inspectors.ts` `safeTensorsFacts` | PASS | 2026-11-14（单测 + WP） |
| W-2 | Metadata 表：类型和来源列、详情检查器、⌘F 聚焦 | DV:705-710,739-813 | `WeightsReaders.tsx` | PASS | 2026-11-14：详情是视图内右侧面板（260–390 px，同原生 HSplitView）。**平台调整**：原生列表最小 520 + 面板最小 260 = 780，窗口会被撑宽；浏览器做不到，内容区窄于 780 px 时面板移到列表下方（WP） |
| W-3 | Tensor 列表：列顺序（名称 / Shape / 类型 / 参数），默认不选中，面包屑在列表上方，图标按钮 | DV:815-945 | `WeightsReaders.tsx` `VirtualTable` | PASS | 2026-11-14：全部显示（D-6），28 px 行虚拟渲染；↑ / ↓ 逐行移动选中；面包屑中间截断；搜索不自动展开分组，同原生（WP）。窄于 780 px 的布局同 W-2 |
| W-4 | Tensor 检查器：参数、格式化大小、offset、说明文字、面板内隐藏按钮 | DV:940-990 | `WeightsReaders.tsx` `TensorDetail` | PASS | 2026-11-14：面板 260–390 px 可拖动（WP） |
| W-5 | 大小以 1000 为底 | `FileClassifier.swift:114-116` | `core/huggingface.ts:416-420` | PASS | 随 B-9 |
| W-6 | Header 校验严格度 | `Support/SafetensorsInspector.swift:1-129`，`RepositoryService.loadSafetensorsHeader` | `core/inspectors.ts` | 部分 | 2026-11-14：按原生逐项移植（长度 ≤1 / >25,000,000 / 超出文件、首字节 `{`、严格 UTF-8、`__metadata__` 字符串字典、`[NSNumber]` → Int64 语义、offsets 恰好 2 个且 end ≥ start、溢出检查），删除 Web 独有的 dtype / 对齐 / 连续性检查；金样由 swiftc 编译原生 inspector 生成（`inspectors.test.ts`）。平台限制：>2^53 的整数在不支持 `JSON.parse` source 访问的引擎里按 double 取整。**仍缺**：Hub 清单没给 size 时 Web 拒绝读取（`core/inspectors.ts:42`），原生不需要 size 也照读 header（`RepositoryService.swift:405` 只在有 size 时比较） |
| G-1 | GGUF 完整概览、metadata、tensor | DV:348-362,415-459,687-1007，`RepositoryService.swift:359-392`，`GGUFInspector.swift` | `core/gguf.ts`，`WeightsReaders.tsx` GGUFReader | PASS | 2026-11-14 按 D-1：1 MiB 顺序 Range、32 MiB 上限、接受越读；浮点显示同 Swift `String(Float)`；事实行顺序同原生。HTTP 200 回 Range 仍失败关闭，结果按 snapshot 缓存不重复读取（`gguf.test.ts`、WP、MF） |
| I-1 | imatrix：分概览和 Entries 两页；标题「Importance Matrix」；缺失值显示「未记录」；列顺序 Mean / Min / Max；数字取 5 位有效数字 | `Views/IMatrixWorkspaceView.swift:1-104` | `WeightsReaders.tsx` ImatrixReader，`core/imatrix.ts` | PASS | 2026-11-14：5 位有效数字用 halfEven，37 个 Swift 打印金样（含 12344.5→12,344、1.03125→1.0312） |

### 3.8 Chat Template 试验台（批次 3，2026-11-13 实现）

| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| T-1 | **布局：左侧 Jinja 编辑器（就地高亮、行数）+ 渲染结果，右侧「运行选项」** | TPV:61-137 | TP:200-227，CSS | PASS | 2026-11-13：左列「Jinja 模板 · N 行」（N 不含空行，同原生 `split`）在上、「渲染结果」在下，右列输入，三处分隔都能拖动，范围同原生（MF「Chat Template playground indexes…」拖动断言）。**平台调整**：原生最小宽度 560+280+360 放不进侧栏和检查器之间的详情列，所以按试验台自身宽度（container query）调整：窄于 760px 时输入区移到编辑器下方，窄于 480px 时所有分隔纵向堆叠（已截图检查 1440、1280、1024、390px，均无横向溢出） |
| T-2 | 标题 + 状态（渲染中 / 输入或模板有错误 / 实时预览）+「载入示例」+「恢复原模板」 | TPV:47-58,100-115 | TP:187-206 | PASS | 2026-11-13：同原生。「载入示例」原生是 Menu，Web 用同名下拉框 |
| T-3 | **实时渲染（220 ms）** | TPV:81-97 | TP:157-178，`templateRender.ts` | PASS | 2026-11-13：输入变化即显示「渲染中」，220 ms 后在专用 Worker 渲染；新请求到来时终止旧 Worker，失控模板不会卡住输入或 tokenizer Worker（MF「…drops superseded renders」）。渲染后选中第一个带 JSON 的结构项，否则第一项 |
| T-4 | **Messages 卡片：角色、文本/JSON、删除、添加** | TPV:474-489,591-635 | TP:393-415 | PASS | 2026-11-13：角色 115 宽、类型 80 宽、删除；「添加」追加空 user 消息 |
| T-5 | **Tools 开关（关闭时不传 `tools`）+ Tool 卡片** | TPV:497-515,637-668，TR:138-140 | TP:356-370,417-432，TQ:76-106 | PASS | 2026-11-13：关闭时 context 里没有 `tools`（TPT、MF 断言输出无 `tools=`），开启后显示 Tool 卡片和「添加 Tool」（new_tool） |
| T-6 | **带类型的其他变量（字符串 / 整数 / 小数 / 布尔 / JSON / Null）+ 说明** | TPV:517-537,670-720 | TP:434-470，TQ:108-151 | PASS | 2026-11-13：值控件随类型切换；整数/小数解析按 Swift `Int()`/`Double()` 金样（TPT） |
| T-7 | 变量预填：配置里的 bos/eos/pad/unk；模板提到 enable_thinking 时为 true；提到 documents 时为 `[]` | TPV:365-382（TKP:720-749 同样逻辑） | TQ:61-73 | PASS | 2026-11-13：只预填字符串或显式 null 的 token（TPT）。tokenizer 试验台的同名逻辑属于批次 4 |
| T-8 | 示例（基础对话 / 工具调用 get_weather / 多模态 content） | TPV:296-350 | TP:180-184，TQ:31-59 | PASS | 2026-11-13：示例只改 messages、Tools 开关、add_generation_prompt（工具示例还重置 tools），不动变量和模板 |
| T-9 | 校验错误：保留名、空名、重名、Tool 字段、数字格式；JSON 错误本地化 | TR:142-215 | TQ:76-133 | PASS | 2026-11-13：文案取原生目录（TPT 逐条断言；MF 断言保留名错误、状态和「未生成」） |
| T-10 | **输出：「结构索引·只读」与「原始输出·权威」并排；按消息边界建索引；选中后高亮并滚动；内容检查器；说明文字** | TPV:139-294，ROI:19-208 | TP:240-297，RO | PASS | 2026-11-13：索引规则逐项对齐原生金样（TPT）；内容检查器用共享 CodeReader（MF「Chat Template playground indexes…」）；选中项在长输出里自动滚到可见（MF「…follows the selection in long output…」）。原生遇到标量 JSON 负载会崩溃，Web 不显示检查器 |
| T-11 | 原始输出：`<\|…\|>` 粉色加粗、查找、「模板没有产生输出。」、字节数、内容为空时复制按钮禁用 | ROI:150-208，TPV:145-177 | TP:299-331 | PASS | 2026-11-13：按字符折行；⌘F 查找只标记、滚动输出区（MF「Chat Template playground indexes…」）；选中范围用强调色 42% |
| T-12 | `tojson` 的 sort_keys 和 separators 兼容 | TR:105-130 | `templateRender.worker.ts`（@huggingface/jinja） | 已关闭 | 2026-11-13 按 D-13 ①：Web 与 transformers 的 `tojson` 一致（金样见 D-13），原生偏差另行修复 |

### 3.9 Tokenizer 试验台（批次 4，2026-11-13 实现）
批次 4 证据（2026-11-13）：MF 中 tokenizer 相关用例按新界面重写（Raw/Chat/IDs 实时与 latest-only、10k token 虚拟表、选中联动、对照同仓库 / 公开仓库 / 本地目录 / 延迟 manifest、SentencePiece、视口 390–1280、CR/LF），english-core、https 同步；chromium、firefox、webkit 全过。


| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| K-1 | **视角「概览 / 全部字段 / 原文 / 试验台」；试验台内用模式选择器切换，默认 Chat，没有模板时退回 Raw；`.model` 直接进试验台** | `InspectionDocument.swift:131-132`，ST:86-94,169,201，TKP:49,99-101,172-180 | TK:149-470，App `TokenizerInspection` | PASS | 2026-11-13：「输入模式」分段控件（原始文本 / Chat 对话 / Token IDs），默认 Chat；bundle 加载完仍没有可用模板时退回原始文本，Chat 按钮禁用。浏览器实测 Qwen2.5-0.5B-Instruct |
| K-2 | **三种模式都实时：Raw、Chat 的编码都等 225 ms（Chat 先立即渲染），IDs 在视图里等 225 ms 再解析并解码；每次新请求先清空结果** | TKP:567-615，ST:205-215 | TK:230-300 | PASS | 2026-11-13：去掉「立即分词」「解码 ID」「渲染并分词」按钮。原表写的「Raw 立即、IDs 等 225 ms」有误，原生三种都等 225 ms |
| K-3 | 输入头「输入」+ 实时状态；底部「N 字节 · 清空」/「支持逗号、空白或 JSON 数组 · 清空」；示例文本 | TKP:50,166-239,621-629 | TK:387-420 | PASS | 2026-11-13：字节数按原生 `String(localized:)` 插值分组 |
| K-4 | Chat 紧凑编辑器（角色 + 文本 + ✕，添加时 user/assistant 交替）+「高级选项」；默认带 get_weather 工具 | TPV:410-464 | TP `RequestEditor compact` | PASS | 2026-11-13：与 Chat Template 试验台共用 `RequestEditor`；变量按 tokenizer_config 预填一次（同 T-7） |
| K-5 | 「送入 tokenizer 的文本 / 解码文本」独立面板：复制、详情、空状态、模板错误 | TKP:241-279,636-644,715-718 | TK:424-433 | PASS | 2026-11-13 |
| K-6 | 指标：Token 数量 / Unicode 字符 / 字节 / Token（1 位小数）；Chat 模式加「正文 token」「模板开销（近似）」；没有值时显示「—」 | TKP:376-407,654-666 | TK:363-379 | PASS | 2026-11-13：卡片宽 63/105 px 同原生 |
| K-7 | 结果头「分词结果」+「路径 · 映射」+「对照」菜单 +「复制 IDs」 | TKP:303-319,646-652 | TK:436-450 | PASS | 2026-11-13 |
| K-8 | 「显示空白符」默认关闭，全局共享；符号 `·` `→` `↵`；关闭时保留 tab | TKP:4-17，ST `showsTokenWhitespace` | TK `visibleTokenizerText`，App `showWhitespace` | PASS | 2026-11-13：状态放在工作区 slots，试验台、对照、底部面板共用 |
| K-9 | Token 流：10 色、未选中变暗到 0.28、3 px 角色色条、2 px 描边 | TKP:448-489,690-707 | TK:551-630，CSS `.tkp-stream` | PASS | 2026-11-13：10 色取 iOS 系统色（含暗色变体）。**实现调整**：变暗用覆盖层（容器 `::after` 0.72 遮罩，选中项 `z-index: 2` 浮在上面）而非逐个改 opacity；60 KB 输入约 18k 片段时，逐个改样式让选中在 WebKit 要 2.8–3.6 s，现在 Chromium 26 ms、WebKit 42 ms，按键 7 ms。视觉一致 |
| K-10 | Token IDs（底部面板）：标签计数、复制全部、数字分组、未选中变暗、显示全部 | DV:1693，TTV:177-219，TKP:307-309,709-713 | TK:733-750 | PASS | 2026-11-13：全部显示（D-5），变暗同 K-9 覆盖层 |
| K-11 | 状态：加载 tokenizer / 编码中 / 超过上限（65,536 字节，`ByteCountFormatter .file` 显示为「66 KB」，Web `formatBytes` 相同）；失败时有「重试」（IDs 模式没有） | TKP:410-434,491-493 | TK:518-549 | PASS | 2026-11-13：Web 没有原生的 idle 阶段（输入变化直接进入编码中，画面相同）；「重试」重新检查整个 bundle，失败结果不缓存 |
| K-12 | Token 表（底部面板）：列顺序 # / ID / Token Piece / Decoded / Role / Special / Mapping；# 从 0 开始并带色块；点击整行选中；右键复制；悬停提示；最小宽 850 | DV:1724-1732，TTV:66-175 | TK:632-703 | PASS | 2026-11-13：行高 30 px，表头吸顶，只渲染可见行（D-5）。右键「复制 ID」复制不分组的数字（原生复制分组后的数字是毛病，不照搬） |
| K-13 | Token ID 错误文案逐项区分 | `Support/TokenIDParser.swift:15-30` | `core/tokenizer.ts` `parseTokenIds`，`tokenizer.test.ts` | PASS | 2026-11-13：单测覆盖空输入、`+4`、`05`、`3.0`、`1e1` |
| K-14 | 第一次出结果时自动打开面板，并切到 Token 表 | TKP:68,109-115 | TK:343-350 | PASS | 2026-11-13：只对非空结果、每个文件一次、对照时不停靠；手机宽度不自动打开（平台调整，底部面板在手机上是全屏层） |
| K-15 | 底部面板 token 标签的空状态「输入内容后显示 token。」 | DV:1741-1745 | TK `TokenTable`/`TokenIdChips` | PASS | 2026-11-13 |
| K-16 | 检查器「选中 Token」：序号（从 0 开始）、ID（分组）、Token Piece、解码片段、角色（有才显示）、Special（是才显示）、复制 ID | IV:11-16,70-95 | TK:752-773 | PASS | 2026-11-13：「复制 ID」复制不分组的数字（同 K-12） |
| K-17 | 模板来源菜单：放在模式选择器旁边，选中项打勾 | TKP:121-164 | TK:392-400 | PASS | 2026-11-13：原生是 Menu，Web 用同名下拉框（同 T-2）；只有一个模板时显示为标签 |
| K-18 | Token 流、表、IDs 共享选中；新结果时重置；再点一次取消 | TKP:19-21,453-457 | TK | PASS | 2026-11-13 |
| K-19 | Decoded only 时的角色提示 | TKP:438-447 | TK:540 | PASS | 2026-11-13 |

### 3.10 tokenizer.json 概览与词表
批次 4 证据（2026-11-13）：MF 中 tokenizer 相关用例按新界面重写（Raw/Chat/IDs 实时与 latest-only、10k token 虚拟表、选中联动、对照同仓库 / 公开仓库 / 本地目录 / 延迟 manifest、SentencePiece、视口 390–1280、CR/LF），english-core、https 同步；chromium、firefox、webkit 全过。


| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| V-1 | 标题、副标题、「结构」组、special 列表（内容在左、ID 在右，空 token 显示「（空 Token）」）、页脚建议 | DV:1192-1248 | TK `TokenizerOverview` | PASS | 2026-11-13：浏览器实测 Qwen2.5（BPE · 1.0 · 151,643 · 151,387 · 22） |
| V-2 | 「词表长度」标题 + Base vocab / Added Token 标签 | DV:1365-1378 | TK `VocabularyAnalysis` | PASS | 2026-11-13 |
| V-3 | 6 个指标块 | DV:1399-1426 | TK `VocabularyAnalysis` | PASS | 2026-11-13：平均 / P50 / P90 / P95 / P99 / 最长 |
| V-4 | 可点击的长度分布柱状图 +「统计口径」说明 | DV:1428-1486 | TK `VocabularyAnalysis` | PASS | 2026-11-13：点击柱子显示「长度 a–b：N 项，占基础词表 x%。」 |
| V-5 | 最长 Token 表：5 列，排序说明，选中显示详情 +「复制 Raw」，右键菜单 | DV:1488-1602 | TK `VocabularyAnalysis` | PASS | 2026-11-13：默认 Top 20，可展开 Top 50 |
| V-6 | 可读的 piece 名称（空格 / 换行 / Tab / `\u{..}` / 「x × N」） | DV:1625-1645 | TK `readablePiece` | PASS | 2026-11-13 |
| V-7 | 词表搜索副标题；结果为 token 在左、ID 在右 | DV:1250-1293 | TK `VocabularySearch` | PASS | 2026-11-13：匹配数按原生插值分组 |
| V-8 | 「全部字段」进 JSON 阅读器 | DV:544（`isJSON` 为真时走 `JSONReaderView`） | App `TokenizerJSONInspection` | 已关闭 | 2026-11-13 复核：原表引用的 DV:1321-1332 根字段列表对 tokenizer.json 走不到，原生「全部字段」就是 JSON 阅读器，Web 已一致。概览里的根字段表已删除 |

### 3.11 Tokenizer 对照
批次 4 证据（2026-11-13）：MF 中 tokenizer 相关用例按新界面重写（Raw/Chat/IDs 实时与 latest-only、10k token 虚拟表、选中联动、对照同仓库 / 公开仓库 / 本地目录 / 延迟 manifest、SentencePiece、视口 390–1280、CR/LF），english-core、https 同步；chromium、firefox、webkit 全过。


| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| X-1 | 入口：结果头的「对照」菜单，只列出未锁定的入口 +「选择另一仓库…」 | TKP:324-374 | TK `ComparisonMenu`/`useComparison` | PASS | 2026-11-13：菜单和 popover 挂到 `document.body` 并按按钮位置固定定位，不被面板裁剪 |
| X-2 | 对照时用「对照」面板替换结果面板，带「显示空白符」和「关闭对照」；对照时不停靠 | TKP:288-301,324-335，ST:113-116 | TK:452-460 | PASS | 2026-11-13 |
| X-3 | 摘要文案；差值为 0 时显示 0 | TCV:148-180,255-261 | TK `ComparisonView` | PASS | 2026-11-13：计数按原生插值分组 |
| X-4 | 两栏只显示 Token 表；右侧模板菜单只在 Chat 模式出现 | TCV:115-146,182-246 | TK `ComparisonView` | PASS | 2026-11-13：右侧先用自己的模板渲染再分词；渲染失败、没有模板分别显示原生文案 |
| X-5 | 词表差集：仅主 / 仅对照（默认仅主）、搜索、「显示 N 条，最多 1,000 条」、「（空 Token）」 | TCV:73-113 | TK `VocabularyDiff` | PASS | 2026-11-13：SentencePiece、词表无法解析、主侧尚未就绪时显示跳过原因（主侧未就绪时直接跳过，同原生 `ModelFilesStore.swift:477-478`，不等待） |
| X-6 | 「另一仓库」popover：一个输入框，空时「加载对照」禁用，提交后关闭 | TKP:354-372 | TK `ComparisonMenu` | PASS | 2026-11-13：另保留来源选择和本地目录（D-9 Web 独有，不冲突） |

### 3.12 错误消息（zh-Hans，2026-11-14 首次审计）

明细见 `docs/copy-audit.md` 第二部分。约 49 条逐字一致。

| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| M-1 | 读取、Range、超限、请求失败、路径、UTF-8 / 二进制、图片、imatrix 外壳、tokenizer bundle 与 runtime 外壳、chat_template、一致性检查的错误文案 | `RepositoryService.swift:41-99`，`HTTPRangeLoader.swift`，`TokenizerBundleLoader.swift`，`TokenizerRuntime.swift`，`ChatTemplateCatalog.swift`，`IMatrixInspector.swift` | `i18n.ts`，`core/huggingface.ts`，`tokenizer.worker.ts` | PASS | 2026-11-14 修复：按原生 errorDescription 逐条改写，补回路径、实际大小，拆开「读取不完整 / Range 响应不完整」「单文件 / 合计超限」；请求失败带服务端返回的前 512 字节（同 `RepositoryService.validate`）；补 Imatrix、tokenizer.json、tokenizer_config.json、运行时、chat_template.jinja 外壳；普通文件非 UTF-8 / 含 NUL 用 unsupportedBinary，`.jinja` 允许 NUL；图片先用 `createImageBitmap` 校验（同 `NSImage(data:)`）。平台调整：本地文件变化提示「请重新选择目录」（P-3）。单测 + E2E 三引擎 |
| M-2 | 中文界面不出现英文 | 原生用 Foundation 中文描述 | JSON.parse / TextDecoder / HF fetch 的英文错误透出；文案夹 bytes、safe integer；写死 64 KiB / 4 KiB | PASS | 2026-11-14：JSON 解析失败一律显示 Foundation 原文「未能读取数据，因为它的格式不正确。」（tokenizer、模板变量、Token ID、一致性检查）；Hugging Face 的 fetch 网络错误显示「未能连接到服务器。」；64 KiB / 4 KiB 改为 `formatBytes`（66 KB），去掉 bytes、safe integer 等英文；R-3 JSON 阅读器同原生 `formattedSource` 显示「JSON: 未能读取数据，因为它的格式不正确。」 |
| M-3 | 错误里的数字分组 | 插值 Int 分组 | Token 序号、named index、GGUF typeCode、`wholeFileSizeMismatch` 未分组 | PASS | 2026-11-14：`translate()` 对所有整数插值做千分位分组（同 `String(localized:)`，swift 实测），一处改完覆盖全部调用方（`i18n.test.ts`） |
| M-4 | `tokenIdInputTooLarge` 缺 `{limit}` | — | `tokenizerClient.ts:277` | 已关闭 | 2026-11-14：补上 `{ limit }` |

### 3.13 英文界面（2026-11-14 首次审计）

明细见 `docs/copy-audit.md` 第一部分。zh 精确匹配 466 条，其中英文一致 381 条。

| ID | 元素 | 原生 | Web | 状态 | 差异 |
| --- | --- | --- | --- | --- | --- |
| E-1 | 英文措辞 | `Localizable.xcstrings` | `i18n.ts` | PASS | 2026-11-14：76 条按 xcstrings 原文逐条替换（脚本按 zh 精确匹配生成，占位符按顺序映射） |
| E-2 | 英文单复数 | xcstrings plural | `t(key, { count })` | PASS | 2026-11-14：`i18n.ts` 的 en 支持 `{ one, other }`，按 `count`（可为已分组字符串）用 `Intl.PluralRules` 选择，15 条照原生 plural 变体（`i18n.test.ts`） |
| E-3 | zh 也有偏差的条目 | — | — | PASS | 2026-11-14：imatrix 小写、「SentencePiece model」、去掉多余的「：{reason}」与「左侧」、chat_template 补尾句、named 条目去句号、折叠按钮拆成「展开 / 折叠第 N 行结构」两条、Object 摘要单复数。保留：问题面板 aria-label「仓库一致性报告」（原生 help 在徽章上，Web 徽章 title 已一致）、加载提示的「· 」由模板拼接（显示相同）；chat_template 对象值英文的双句点是原生 bug，Web 不照抄 |
| E-4 | 原生在英文界面显示中文的字面量（图片阅读器 6 条 + 图片提示） | catalog 外字面量 | Web 给英文 | 已关闭 | D-15：Web 保留英文，原生补进 catalog |

## 4. Web 独有（按 D-9 / D-11 处理，2026-11-14 复核）

**保留**（不与原生冲突）：
- HTTPS 文件 / HTTPS 清单来源，以及「使用说明」
- 「清除历史」（同时清掉 D-3 的启动输入）
- `?repo=&file=` 深链与浏览器前进/后退
- 复制按钮的「已复制」对勾反馈
- Tokenizer 对照的 HTTPS 来源和第二本地目录（X-6）

**已删除或改回原生**：
- 底部状态栏（D-11）
- 「读取方式 / 实际读取 / 解析结果」条：改为原生底部安全提示（H-7）
- 原文行右侧浮动的问题说明（Q-10）
- 选中问题时强制打开检查器（Q-6）
- 「正文 / 模板」占比条，带行号和每行计数的「Grapheme-safe 片段」Token 流，检查器隐藏时内联的选中 Token 详情：批次 4 按原生 TKP 重写（K-6、K-9、K-16）
- 模板工作台的概览标签、源码内查找：批次 3 按原生 Jinja 工作区重写（C-10）
- 对照的「取消加载」（原表误把原生也有的「共有 N」列为 Web 独有，原生 TCV:82 有）
- imatrix 选中条目面板（I-1）
- `.model` 的「结构与词表」视图（K-1）

## 5. 建议实施顺序

每一批都可以独立验收，完成后把对应行改为 PASS 并附证据。

1. **外壳与信息架构**：
   - H-1（头部统一视角）与 S-10 两层结构
   - H-2 至 H-5、H-8
   - B-1 至 B-4、B-9 与 W-5（大小格式）
   - L-2 至 L-6

   所有页面都依赖这一批。
2. **JSON 与摘要阅读器**：R-1 至 R-10，C-1 至 C-3，C-11，Q-7、Q-8、Q-10、Q-11。R-8 的内嵌试验台依赖第 3 批，可以先补字段、数字格式和诊断。
3. **Chat Template 试验台**：T-1 至 T-11，然后嵌进 tokenizer_config 概览（R-8）。T-12 先补黄金用例。
4. **Tokenizer 试验台、词表与对照**：K-*、V-*、X-*。
5. **其余阅读器与问题面板正文**：C-4 至 C-10，W-1 至 W-4、W-6，I-1，Q-1 至 Q-5；D-1 裁决后做 G-1 和 Q-9。
6. **细节**：S-1 至 S-9、S-11，B-5 至 B-8、B-10、B-11，H-7。
7. **复核后剩余（2026-11-14）**：
   - ~~文案：M-1 至 M-4、E-1 至 E-3~~（2026-11-14 已完成）
   - 功能缺口：B-7 拖到最小以下自动折叠；W-6 无 size 时照读 header；C-5 查找框清除按钮、最近搜索
   - 需要截图对照原生：C-8 Markdown 三套主题；§0「未审计范围」的视觉样式
   - 原生侧待修（两端一起）：C-6 CRLF front matter、Q-9 `token_embd` 取 `shape.first`、D-13 `tojson`、标量 JSON 负载崩溃、chat_template 对象值英文双句点、E-4 的 7 处字面量补进 xcstrings
