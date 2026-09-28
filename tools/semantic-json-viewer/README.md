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

1. 点击“打开文件”，选择本地 JSON 或 JSONL。打开后先看到可读内容：普通 JSON 显示字段和值，JSONL 在第一条记录出现后即可阅读。
2. 中央在“阅读”和“源文本”之间切换。两者是同一阅读范围的不同表示；选择字段只会定位，不会把源文本收成该字段。需要时用“查看结构”看完整结构，或用左侧内容大纲展开更深的字段。
3. 长文本、Markdown、代码、HTML 或嵌套 JSON 用“展开阅读”打开。HTML 仍在隔离预览里阅读。记录列表用“第 N 条”；数组路径保留真实的 `[N-1]`，JSONL 源文件行号单独显示。
4. 查找范围显示为本文件、当前记录或当前字段。复制文本会去掉 JSON 引号并解释转义；复制原始 JSON 保留引号、转义和数字原写法。
5. 这些操作只读，不编辑或保存文件。

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
