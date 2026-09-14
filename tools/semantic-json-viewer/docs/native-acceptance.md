# Semantic JSON Viewer Native 验收证据台账

> 状态：部分 Native 真实验收证据；不是 F-00 至 F-12 全部通过，也不是发布 PASS。以下记录来自 2026-09-14 的真实 Tauri 应用操作；未把 Core benchmark、截图缺失或 AX 的部分窗口误判为完整 UI 证据。

## 构建与证据边界

- `npm run tauri build -- --bundles app` exit 0；bundle 嵌入的前端入口为 `index-Cn2orAV9.js`。
- 构建时仓库仍有部分 WIP；之后分别提交了行窗口修复 `fbd1016` 和列表翻译 `c1d9b82`。因此不能把该 bundle 冒称为单一最终 HEAD 的构建产物。
- 本台账只记录 Native 应用、真实鼠标/键盘、剪贴板和可见 UI 证据；不等价于 Core、WebView 私有内存或 Linux 性能门槛。

## 后续代码与自动化状态（不计入 Native PASS）

- `f06d3dc` 已实现 F6 Auto/Generic/Event UI；headless 25 项断言和 main 集成通过，但尚未做 Native 真实复测。
- `4a090e6` 已修复 Nested 重复 tabs；自动化已通过，但原 Native tabs FAIL 尚未重新启动应用复测，因此不关闭下述 FAIL。
- `ace1f24` 已实现 Code 超限窗口；独立 wrap 90 项、Rendered 61 项通过，但尚未做 Native 真实复测。
- `4754220` 已实现 Conversation 消息及包装对象依赖字段重复时的完整 source 回退与 `ambiguousDuplicateField` DTO 标记；主代理独立 `cargo test --lib --quiet` 为 310 passed。宽对象的 Generic/Anthropic 连续分页与 style 切换只执行一次包装字段检查，切换 scope/candidate 会重新检查。该提交不包含专用子对象适配、UI 歧义提示或 Native 验收，不能据此关闭 spec §6.3。
- 后续 Tauri bundle 构建成功，嵌入 assets 为 `index-CYvEL1Ai.js` / `index-C3LmfEmL.css`。尝试退出旧应用时 CUA 报告 macOS 锁屏，未能启动新实例复测；本节不能新增该 bundle 的 Native PASS。已有 Native 表格仍明确只对应 `index-Cn2orAV9.js`。

## 已实证项目

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

## 已知未闭环 FAIL

- 从 Nested 子字符串 Back 回父树后，在 Decoded / Raw 切换中，普通 String 的 tabs 与 Nested tabs 同时可见。这是已观察到的真实 UI FAIL；`4a090e6` 的自动化修复已通过，但原 Native FAIL 尚未重新启动应用复测，当前仍未关闭。
- 中文壳、Tree、Entry、Collection、Raw 标签已实见；Viewer、Conversation 仍为英文，错误文案翻译待接。这是发布 i18n 未完成项，不把局部中文标签升级为全量通过。

## 尚未验收

- 其他 F-00/F-07 固定输入的完整 Native 路由矩阵。
- Code 超限窗口的 Native 真实流程（`ace1f24` 自动化已通过，Native 未测）。
- F6 Auto/Generic/Event UI 的 Native 真实流程（`f06d3dc` headless/main 集成已通过，Native 未测）。
- F-11 Native 五项零证据（脚本、网络、IPC、top navigation、宿主 DOM）。
- F-09/F-10 在 Linux 参考环境的 fresh 五轮、cold/warm、private-memory 和完整应用门槛。
- 其他未列出的 F-01 至 F-12 最终 Native/UI 与发布证据。

因此，本台账的结论是：上述单项 Native 证据按表记录，存在一个已知未关闭 FAIL，且仍有多项未验；整体保持 `INCOMPLETE`，不标记 F-00 至 F-12 全 PASS。
