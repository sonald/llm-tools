# Semantic JSON Viewer Native 验收证据台账

> 状态：部分 Native 真实验收证据；不是 F-00 至 F-12 全部通过，也不是发布 PASS。以下按 2026-09-14 / 2026-09-21 的具体构建分别记录真实 Tauri 操作；未把 Core benchmark 或 AX 的部分窗口误判为完整 UI 证据。

## 构建与证据边界

- `npm run tauri build -- --bundles app` exit 0；bundle 嵌入的前端入口为 `index-Cn2orAV9.js`。
- 构建时仓库仍有部分 WIP；之后分别提交了行窗口修复 `fbd1016` 和列表翻译 `c1d9b82`。因此不能把该 bundle 冒称为单一最终 HEAD 的构建产物。
- 本台账只记录 Native 应用、真实鼠标/键盘、剪贴板和可见 UI 证据；不等价于 Core、WebView 私有内存或 Linux 性能门槛。

## 后续代码与自动化状态（不计入 Native PASS）

- `f06d3dc` 已实现 F6 Auto/Generic/Event UI；headless 25 项断言和 main 集成通过，但尚未做 Native 真实复测。
- `4a090e6` 已修复 Nested 重复 tabs；自动化已通过，但原 Native tabs FAIL 尚未重新启动应用复测，因此不关闭下述 FAIL。
- `ace1f24` 已实现 Code 超限窗口；独立 wrap 90 项、Rendered 61 项通过，但尚未做 Native 真实复测。
- `4754220` 已实现 Conversation 消息及包装对象依赖字段重复时的完整 source 回退与 `ambiguousDuplicateField` DTO 标记；主代理独立 `cargo test --lib --quiet` 为 310 passed。宽对象的 Generic/Anthropic 连续分页与 style 切换只执行一次包装字段检查，切换 scope/candidate 会重新检查。该提交不包含专用子对象适配、UI 歧义提示或 Native 验收，不能据此关闭 spec §6.3。
- 后续 `8919672` 与 `bb8cf6d` 补充专用子对象和 UI 歧义回退；独立 Core 318、Conversation UI 96 通过。`55d8f92` Entry 窗口独立 43、`453f22a` Tree 窗口独立 33、`d9b6066` Nested 深度设置独立 Content Viewer 144/Parsed Search 32、`68b019b` 搜索本地化独立英文 115/中文 8 通过。最终前端 build/i18n 检查通过；这些均未重跑 Native，不关闭原 Native FAIL。
- `f14c971` 将旧 Code DOM 断言对齐现有 TextLineView，并固定英文测试入口；独立安全渲染套件 1773 项通过，浏览器 HAR 为 2 entries、hostile/http-hostile/data 请求均为 0。这不是 F-11 Native 五零证据。
- 后续 Tauri bundle 构建成功，嵌入 assets 为 `index-CYvEL1Ai.js` / `index-C3LmfEmL.css`。尝试退出旧应用时 CUA 报告 macOS 锁屏，未能启动新实例复测；本节不能新增该 bundle 的 Native PASS。已有 Native 表格仍明确只对应 `index-Cn2orAV9.js`。

## 已实证项目

### 2026-09-21 构建准备（非 Native UI 验收）

- 源码：`d774f76d0f18fe5faf7f8bf89da97b68bb8f03db`，构建前工作区干净。
- `npm run tauri -- build --no-bundle` exit 0，产物为 `src-tauri/target/release/semantic-json-viewer`（Mach-O arm64），SHA-256 `6a382ea6970ad2b8799fa2215e9e12692ea8afb56e482b55cdc1cbfb9a1a65db`。
- 前端为 `index-lGNVQAp4.js`，SHA-256 `e692af9836a5e44b0e52b8783b1097da2095a46e346fa6ba969a29640cdaf2b1`。本次只编译，不重新打包、不启动、不替换此前 `.app`，所以不新增 Native PASS。
- 先前 `/tmp/sjv-lines-native-20260914.json` 与 `/tmp/sjv-code-virtual-native-20260914.json` 已不存在，不能假定旧临时输入仍可复用。后续 UI 复测需先核对实际输入，且须等用户确认当前桌面可操作。
- 已用仓库 `generate-semantic-fixtures.mjs` / `generate-security-fixtures.mjs` 生成 `/tmp/sjv-native-20260921.NVTxYx/{semantic,security}`，两组生成器自检通过；这些是合成验收输入，不替代 §13 的真实人工标注集，也不证明 UI 已通过。

### 2026-09-21 新构建 Native 复测（局部 PASS）

- `npm run tauri -- build --bundles app` 成功；通过原生菜单退出旧实例后，用完整 `.app` 路径启动新实例。前端为 `index-BW2GIGS7.js`，bundle 内 `Contents/MacOS/semantic-json-viewer` 的 SHA-256 为 `6637a60724bb35f66bdcc44fef2f655fb090cd3e36013deaeb7005b6af659fcd`。
- 所有操作均走原生文件选择器、Tree、Viewer、真实点击/键盘及系统粘贴，不是浏览器 mock。CUA AX 与截图观察到应用正常打开，当前 Mac 可操作。
- 小输入 `semantic/nested-json.json`：25,137 B，SHA-256 `b0b9815139855dd6a17de41675ccec217a767b89d0e970ed4aa2d131715ce450`。`$.data.objectString` 的 Node 2、文件范围 `[34,112)`；Decoded 68 B、Raw 78 B。分别点击 Native CopyDecoded / CopyRaw 后粘贴至查看器搜索框，完整文本与输入文件预期一致，Raw 保留引号及转义。
- 长输入由 `fixtures/generate-native-regression-fixture.mjs` 生成在 `/tmp/sjv-native-20260921.NVTxYx/native-regressions.json`：2,221,703 B，SHA-256 `3360fbf4f2c7ad813d370c06dcfa057efc062861290868cd1ebc4c688b014f76`。`$.nested` Node 2 文件范围 `[600025,644042)`，解码为 42,413 B。
- 进入 `$.nested.nestedText`，Native 显示解码 40,798 B、35,198 Unicode scalars、800 行，nested-relative `[14,42412)`；返回父树后仍选中该 Node 1。再切 Decoded / Raw，截图和 AX 均只有一组嵌套表示标签，没有普通 String 标签并存。Decoded 范围 `[0,42413)`，Raw 父范围 `[600025,644042)`。**旧 Nested 重复 tabs FAIL 在此同类长子串路径复测关闭。**
- 新发现：Viewer 主要文案已中文，但搜索说明仍出现 `Search parsed JSON keys and values.` / `Search the decoded source.` / `Search the raw lexeme.` / `Search the visible rendered text.`，因此完整 Native i18n 尚未通过。
- 此轮没有验证 Code 的两种超限输入、F-11 五零或全部 F-00–F-12；生成器内的 22,050 行和超过 1 MiB 单行 Code 仅为下一轮准备，不能记为 PASS。

### 2026-09-21 搜索文案与 Code 降级复测

- 新构建前端 `index-BCTHVp7n.js`，bundle 内可执行文件 SHA-256 `be24fffe7b3576a622caafa6638466fe1adcea071f484e513e386261ea199a05`；退出旧实例后启动新 `.app`。
- 上一轮发现的 Parsed / Decoded / Raw / Rendered 搜索说明均在 Native 中显示中文，分别为“搜索解析后的 JSON 键和值。”“搜索解码源文本。”“搜索原始词法单元。”“搜索可见的渲染文本。”。这些已观察到的英文说明问题关闭；不据此推断未走到的所有文案路径均通过。
- 同一 `native-regressions.json` 的 `$.code`：506,979 B、22,050 行，Native 自动检测为 Code，显示禁用高亮提示和带行号文本。首块 `[0,131072)`，下一块 `[131072,262144)` 的首行号为 6059，与源文本换行数核对一致。
- 在 Native Rendered 搜索中查找 `row22049`，得到 1 个匹配；点击后显示 `[506962,506979)`、`row22049 = 22049;` 和行号 22050。该末行定位与源文本核对一致。
- `$.codeOneLine`：1,048,593 B、1 行，Auto 为 Plain Text；手动选 JavaScript 后显示用户覆盖和禁用高亮提示。翻到第二块 `[131072,262144)`，NoWrap 保持行号 1；继续翻到末块 `[1048576,1048593)`，显示 15 个 `x` 与 `";`，行号仍为 1，Next 禁用。截图和 AX 均已观察。
- 文件操作前后 SHA-256 均为 `3360fbf4f2c7ad813d370c06dcfa057efc062861290868cd1ebc4c688b014f76`，这批只读流程未修改输入。
- 自动化补充：i18n 153 static / 126 main / 299 view keys、Parsed Search 32 项通过；Tauri app bundle 构建成功。未将这些检查替代上述 Native 操作。

### 历史 Native 操作证据（2026-09-14）

| 项目 | 真实输入与操作 | 结果 |
| --- | --- | --- |
| 长文本与指标 | `/tmp/sjv-lines-native-20260914.json`，`1,042,415 B`；plain 外层 span `[9, 523771)`；decoded `505270 B`、`442270` scalars、`9246` lines | PASS |
| 摘要与 Rendered 搜索 | 单击摘要打开 Viewer；搜索 `END-OF-PLAIN` 定位 `[505256, 505270)` | PASS |
| Decoded / JSON 源值复制 | 完整 CopyDecoded 与 JSON 源值字节相等：`505270 B`、`9245` 个 CRLF | PASS |
| Raw Lexeme 复制 | CopyRawLexeme 与文件 span 字节相等：`523762 B` | PASS |
| 原生文本选择 | 鼠标选择 `LINE-00000 中文😀`；PageDown 使首行离开 AX 窗口后 Cmd-C；`NSPasteboard.changeCount` `195 → 196`，`pbpaste` `21 B` 匹配 | PASS；该 Native 选区含 Unicode、不含 CRLF。CRLF 选区只由浏览器回归覆盖，不混称为 Native 证据 |
| Wrap / NoWrap | NoWrap 横向拖动 scrollbar 可见长行尾；恢复 Wrap；清选后回到首行无旧选区 | PASS |
| Nested source、scope 与复制 | `$.nested` root decoded `34742 B`、span `[523781, 559733)`；进入 `nestedText` 子串，nested-relative `[14, 34741)`，decoded `33521 B`、`603` lines；完整 CopyDecoded 与 `JSON.parse(nested).nestedText` 一致；Back 恢复父树和选中子节点；Decoded String / Raw Lexeme 范围正确 | 这些数据行为 PASS；标签可见性另有下述 FAIL |
| F00 单行 JSONL | `/tmp/sjv-f00-f07-5qH2m6/one-line.jsonl`，`25 B`、一条记录；Entry 模式选择 entry 1，span `[0,24)`；中文 Raw 复制 `24 B` 一致 | PASS |
| Collection | `fixtures/tree-collection.json`，`124 B`；Go 3 后 Enter 选择零基项目 3；Raw Node 13、span `[108,121)`，显示原文 `"scalar item"`。截图确认 4 条实际可见；AX 只列部分内容，不能据此否定 DOM | PASS |

## 回归关闭与未闭环问题

- Nested 重复 tabs：已由上方 2026-09-21 新构建的短/长子串复测关闭；保留历史记录，不回写旧 bundle 为 PASS。
- Native i18n：2026-09-21 发现的四种搜索说明已修复并原生复测；其他未走到的文案路径仍不视为全量通过。

## 尚未验收

- 其他 F-00/F-07 固定输入的完整 Native 路由矩阵。
- Code 超限窗口：上述行数/字节大小降级、分页、末行搜索已 Native 验证；其余完整 F-01 矩阵仍待验收。
- F6 Auto/Generic/Event UI 的 Native 真实流程（`f06d3dc` headless/main 集成已通过，Native 未测）。
- F-11 Native 五项零证据（脚本、网络、IPC、top navigation、宿主 DOM）。
- F-09/F-10 在 Linux 参考环境的 fresh 五轮、cold/warm、private-memory 和完整应用门槛：用户确认待远程环境提供后验证，不阻塞当前项目，仍不标为通过。
- 其他未列出的 F-01 至 F-12 最终 Native/UI 与发布证据。

因此，本台账的结论是：已观察到的 Nested 重复 tabs 和搜索说明英文问题已复测关闭，Code 两种超限降级已获得局部证据，仍有多项未验；整体保持 `INCOMPLETE`，不标记 F-00 至 F-12 全 PASS。
