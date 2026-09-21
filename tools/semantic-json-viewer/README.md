# Semantic JSON Viewer

本地、只读的 JSON / JSONL 查看工具，使用 Tauri 2、Rust 和 TypeScript。支持结构树、原始字节范围、字符串内容预览和会话语义视图。

## 开发与构建

在本目录运行，需要 Node.js/npm、Rust 和对应平台的 Tauri 构建依赖；macOS 需要 Xcode Command Line Tools。

```sh
npm ci
npm run tauri -- dev
```

macOS 本地应用构建：

```sh
npm run tauri -- build --bundles app
```

产物：`src-tauri/target/release/bundle/macos/Semantic JSON Viewer.app`。本地构建成功不代表已完成签名、公证或其他平台验收。

## 使用

1. 点击“打开文件”，选择本地 JSON 或 JSONL。对象/标量根进入 Document，数组根进入 Collection，JSONL 按非空物理行进入 Entry。
2. Collection 可查看根会话，或在左侧跳转并选择 Item；“集合根节点”返回根范围。Entry 的跳转编号从 1 开始，Item 编号从 0 开始。
3. 在 Semantic / Tree / Raw 间切换。Tree 保留重复键的各次出现；Raw 显示原始词法内容和字节范围，不重新序列化数字或字符串。
4. 双击字符串节点打开 Content Viewer，可查看 Plain、Markdown、Code、Nested JSON 或隔离 HTML Preview，也可手动选择“渲染为”。原始表示始终可追溯。
5. 搜索仅作用于界面标明的当前范围。复制原始文本、解码值与 JSON 子树是不同操作；不是编辑或保存文件。

## 边界与状态

- 不修改输入文件，不上传数据，不加载远程图片。HTML/Markdown 的脚本、链接和活动内容受到净化及隔离限制。
- 不支持 JSON 编辑、压缩文件解压、JSON Text Sequence、串接 JSON 或跨 Entry 查询聚合。
- 首版按 macOS arm64 验收。Linux 与 Windows 均按用户决定延期，等待对应环境验证，不阻塞首版；未验证的平台不宣称已支持。
- 真实人工标注统计及严格 Native 零网络/零 IPC 计数证明不作为首版阻塞项；这不代表相关指标已测，也不意味着移除安全防护。
- 当前仍不是所有平台和全部性能门槛的发布 PASS。具体证据与限制见下列文档。

## 验证入口

```sh
npm run build
node scripts/test-i18n.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

浏览器回归脚本位于 `scripts/`，使用 `agent-browser`；它们不替代 Native 操作证据。大文件及安全固定输入生成器位于 `fixtures/`，使用临时目录输出，避免把生成的大文件提交到仓库。

- [规格与当前验收口径](docs/spec.md)
- [支持矩阵](docs/support-matrix.md)
- [Native 验收台账](docs/native-acceptance.md)
- [性能观测与测量边界](docs/performance-baseline.md)
- [安全报告](docs/security-report.md)
