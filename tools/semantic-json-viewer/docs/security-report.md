# Semantic JSON Viewer 安全报告

日期：2026-09-21。结论：**已有安全自动化及 Native 基本恶意样本验证；未声称完整五零计数证明**。用户确认严格 Native 零网络/零 IPC 计数不阻塞首版，防护要求不变。

本报告记录已检查的代码边界、实际测试与缺失证据；不是渗透测试证明，也不是“零漏洞”声明。人工标注集按用户确认不阻塞首版，不影响安全要求。

## 数据与权限边界

| 边界 | 当前实现 | 证据与限制 |
| --- | --- | --- |
| 原文件 | `FileSource` 使用 `File::open` 只读打开，读取前检查 identity，按原始字节跨度读取 | `src-tauri/src/file_source.rs`；原文件写入只出现在测试夹具代码中。应用只读实现不等价于 macOS App Sandbox |
| Native 权限 | capability 仅匹配 `main` 窗口，列出 `core:default`、`dialog:allow-open` | `src-tauri/capabilities/main.json`；自定义 Rust 命令还需校验 revision、scope、NodeId、跨度，不能仅凭 capability 列表证明 iframe 无 IPC |
| 复制 | Rust 通过 `copy_node_to_sink` 等路径检查当前文件后写系统剪贴板，不给 Preview 开放 clipboard 插件权限 | `src-tauri/src/ipc.rs`、`src-tauri/src/lib.rs`；这是用户发起的复制功能，并非原文件写入 |
| Markdown | 用允许的元素和文本节点构造 DOM；原始 HTML、链接和图片 URL 作为文本显示，不自动加载远程资源 | `src/markdown-renderer.ts`；生产路径不直接把 Markdown 字符串写入宿主 `innerHTML` |
| Code | 限定语种、高亮大小和 DOM/深度/时间预算，代码不执行 | `src/code-renderer.ts`；超限回退普通文本，保留源内容 |
| HTML | Rust 白名单净化后放入空 `sandbox` 的 opaque-origin iframe；搜索副本在未挂入宿主 DOM 的 template fragment 中 | `src-tauri/src/html_sanitizer.rs`、`src/content-viewer.ts`；Source/Raw 切换释放隐藏预览、搜索 DOM 和 `srcdoc`，返回时重新净化读取 |
| 网络 | 主壳 CSP 限定同源资源；Preview 单独禁止脚本、连接、图片、字体、媒体、子框架、对象、表单与 base URL | `src-tauri/tauri.conf.json`、`HTML_PREVIEW_CSP`；主壳允许的 `data:` 图片不等于 Preview 允许图片 |

HTML Preview 不授予 `allow-scripts` / `allow-same-origin`。它的固定 CSP 为：

```text
default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none';
media-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none';
form-action 'none'; base-uri 'none'; style-src 'unsafe-inline';
```

限制包括 HTML 输入 512 KiB、序列化输出 1 MiB、10,000 节点、深度 32；Markdown/Code 也有输入、节点与深度限制。时间预算通过遍历时及同步解析前后的检查实现，**不是可抢占第三方解析器的硬超时**；实际峰值内存和最坏响应时间仍需 §18 验收。

## 已执行证据

- `cargo test --lib --quiet`：319 项通过（当前 Rust 源码，含 Nested 祖先缓存压力、文件变化、scope/跨度、净化与复制测试）。
- 升级开发依赖后，`test-safe-markdown.mjs`：1773 项通过；浏览器 HAR 37 条记录，hostile / hostile-http / data 请求均为 0。其宿主 DOM、脚本探针、伪 Tauri 接口检查仅证明该浏览器测试环境，不代替真实 WebView bridge 测试。
- `test-search-ui.mjs`：英文 144 / 中文 8 项通过；`npm run build` 与 `npm run tauri -- build --no-bundle` 成功。
- Parser 固定种子 mutation run 的历史 100,000 次证据见 [parser-fuzzing.md](parser-fuzzing.md)；不是 coverage-guided fuzzing 或所有输入安全性的证明。
- macOS 实际操作的已通过项、旧 FAIL 和尚未验证项见 [native-acceptance.md](native-acceptance.md)，不得把浏览器结果升级为 Native PASS。

## 依赖审计与修复

默认 npm 镜像审计请求解析失败，随后仅对审计/安装命令指定官方 registry，未修改全局配置。

```bash
npm audit --json --registry=https://registry.npmjs.org
```

初次报告 Vite high、esbuild moderate。已将 Vite 从 5.4.21 升至 6.4.3，锁文件中的 esbuild 为 0.25.12；复核输出 critical/high/moderate/low 均为 0。升级针对开发服务器依赖，不能据此认定此前打包应用存在同样可达路径，也不能用本次审计替代未来版本审计。

Vite 官方公告将 6.4.3 列为 Windows 路径绕过问题的修复版本：[GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)。升级范围选择 6.x，按[官方 v5→v6 迁移说明](https://v6.vite.dev/guide/migration.html)核对，并通过上述构建与浏览器检查，没有自动跳到 audit 推荐的最新大版本。

### RustSec（2026-09-21）

使用临时安装的 `cargo-audit 0.22.2`，不改全局 PATH，不改 Cargo.lock，不忽略公告，也不按 OS/CPU 过滤：

```bash
/tmp/sjv-rust-audit.ZjgPxB/bin/cargo-audit audit \
  --db /tmp/sjv-rust-audit.ZjgPxB/advisory-db --file Cargo.lock --json
```

被审计 Cargo.lock 的 SHA-256 为 `2ad18dbeba3f65f1fd87f3cfb6d9c06859520c72ddb98e96694fb5017989904c`。数据库提交为 `d5c17953a895cf19e8d3ce66eaa42b6fcfe1fb16`，最后更新时间 `2026-09-19T10:42:27+02:00`，含 1,251 条公告；扫描 484 个锁定依赖。结果为 `vulnerabilities.count=0`，但有 **6 条 unmaintained 和 1 条 unsound 警告**。默认退出码 0 不表示这些风险已解决。

| 类别 | 包与公告 | 当前处理 |
| --- | --- | --- |
| 内存安全 | `glib 0.18.5`，[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | `VariantStrIter` 的若干迭代方法存在未定义行为/崩溃风险，上游修复范围为 `>=0.20.0`。Linux GTK/WebKit 依赖链引入 0.18.5，GTK 0.18 系列不能通过一次不兼容版本覆盖安全升级。本项目尚未修复、未证明 Linux 上不可达，不能记为 Linux 安全 PASS |
| 停止维护 | `proc-macro-error 1.0.4`，[RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) | Linux 的 `glib-macros` / `gtk3-macros` 引入；无 patched 版本，跟踪上游替换，不用忽略规则隐藏 |
| 停止维护 | `unic-char-property` / `unic-char-range` / `unic-common` / `unic-ucd-ident` / `unic-ucd-version`，均为 0.9.0；公告依次为 RUSTSEC-2025-0081 / 0075 / 0080 / 0100 / 0098 | 经 `urlpattern → tauri-utils` 引入；属于维护状态警告，无 patched 版本，不等同于已证实可利用漏洞，但保留为依赖风险 |

依赖链由 `cargo tree --locked --target x86_64-unknown-linux-gnu -i glib --depth 4` 核实。`--target aarch64-apple-darwin -i glib` 无结果，只能证明该依赖不在本机目标图中，不能替代 Native 安全验收。临时工具和数据库可重建；发布前应重新审计，不能永久复用本次数据库快照。

补充静态检查：在本应用及锁定的 Tauri / tauri-runtime / tauri-runtime-wry / tao / wry / muda / GTK / GIO / WebKit / GDK / ATK / Cairo / Pango / Soup / JavaScriptCore 和相关宏源码中检索 `VariantStrIter`、`array_iter_str`，仅在 glib 自身找到定义、导出、文档示例和测试；其 `impl_get` 仍包含公告所述的不可变输出指针写入。此结果未发现这些源码中的直接生产调用，但不是对所有生成代码、构建配置或 Linux 二进制的全程序可达性证明，故不忽略或关闭该警告，也不为消除审计输出而盲目替换不兼容的 glib 版本。

## Native 观测与后续验证边界

### Native debug Markdown 基本检查（2026-09-21）

实际打开 `security-markdown.json`（2,236 B），由 Tree 双击 `$.data` Node 2，文件范围 `[36,2180)`、解码 2,025 B / 50 行，自动识别 Markdown。AX 与截图确认标题、列表和引用正常渲染；原始 script/iframe/form/img/style/event-handler HTML 均显示为文本，javascript/data URI 链接显示为普通文字，远程/data URI 图片显示 `[image: …]` 占位，围栏中的 script 保持字面内容。没有安装消息/IPC 探针，没有修改 CSP/sandbox。此检查与上述安全自动化共同作为用户调整后首版基本安全证据，不冒称全量计数证明。

### Native debug HTML 自动预览观测（2026-09-21）

- 实际打开 `security/security-html.json`（4,718 B），通过 Tree 的 `$.data` Node 2（文件 `[37,4660)`，decoded 4,425 B）进入自动 HTML Preview。预览显示净化后的纯文本 `submit form / submit / event handlers / javascript URL / inline style URL`。
- Web Inspector 的 Network 在打开文件前清空；进入 Preview 前有 2 条 `about:srcdoc` 基线，进入后共 4 条，均为 `about:srcdoc`，0 redirects，未观察到攻击样本外部域名请求。这是 Network 面板观测，不是全进程网络抓包。
- 通过 Console 只读查询实际 iframe：`content-viewer-html-preview-frame` 的 sandbox 属性为空字符串，srcdoc 包含上述严格 CSP；宿主 `data-f11-parent-probe` 为 null，顶层 URL 仍为 `tauri://localhost`。读取动作没有注入攻击脚本或修改隔离策略。
- Console 的 1 error / 1 warning 在 Preview 之前已存在：文件选择器首次调用 `ipc://localhost/plugin%3Adialog%7Copen` 被主 CSP 拒绝，Tauri 随后回退 postMessage，文件正常打开。不能把这条基线警告误报为 payload IPC，也不能据此宣称应用零错误。
- 未安装消息/IPC 计数探针，未验证全部交互触发；Markdown 基本检查见上节。以上不升级为完整 F-11 五零 PASS。debug 构建 SHA-256 为 `d64619a7b80b697991275f2c0215477a36e8cb5e83c761fc3af79bcc1eb1cb53`。

2026-09-21 Native 观测准备：`npm run tauri -- build --debug --bundles app` 成功，使用 `target/debug/bundle/macos/Semantic JSON Viewer.app` 启动独立 debug 产物（前端仍为 `index-CPNlsFas.js`），未修改生产 CSP、iframe sandbox 或权限。通过原生右键 Inspect Element 打开实际 WKWebView 的 Web Inspector，AX 与截图确认 Elements / Console / Network 可用。尚未在该构建执行 F-11 payload，因此这只是观测入口准备，不新增五零 PASS，也不将 debug 构建冒称 release 验收。

1. F-11 后续验证边界：2026-09-21 用户明确不安装临时计数探针，严格 Native 零网络/零 IPC 计数证明不作为首版阻塞项。保留现有净化、CSP、sandbox 和安全自动化，继续基本恶意样本检查；未测指标不标为 PASS，也不忽略实际发现的缺陷。
2. Linux `glib 0.18.5` 的 unsound 警告处理及上游维护依赖跟踪；至少在对应平台发布前复查，不能仅靠本机测试关闭。
3. Linux 参考环境性能/内存及功能、安全验证：2026-09-21 用户确认待远程环境提供后进行，不阻塞当前项目，已知风险继续跟踪。其他声明支持平台仍需各自验证；本机 arm64 编译不等于跨平台通过。
4. 完整应用私有内存、峰值、renderer 最坏响应时间；缓存的估算/容量统计不是 heap 证明。

本报告不要求上传用户输入或新增遥测。若后续发现风险，先提供精确复现与影响范围，再修复并保留回归。
