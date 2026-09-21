# Semantic JSON Viewer 安全报告

日期：2026-09-21。结论：**部分验证，Native 发布安全验收未完成**。

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

Rust 依赖审计：**未执行**，当前环境 `cargo audit --version` 返回未安装。Rust 单元测试不能替代 RustSec 漏洞审计。

## 尚未闭环

1. 当前构建的 F-11 Native 五零：脚本、网络、IPC、top navigation、宿主 DOM，需真实 Tauri/WebView 证据。
2. RustSec 依赖审计。
3. Linux 参考环境性能/内存，以及声明支持平台各自的功能和安全验证；本机 arm64 编译不等于跨平台通过。
4. 完整应用私有内存、峰值、renderer 最坏响应时间；缓存的估算/容量统计不是 heap 证明。

本报告不要求上传用户输入或新增遥测。若后续发现风险，先提供精确复现与影响范围，再修复并保留回归。
