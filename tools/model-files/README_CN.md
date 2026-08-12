# ModelFiles（原生 macOS）

ModelFiles 是一款原生 macOS 模型文件查看器，面向 Hugging Face / ModelScope 模型产物。它的核心是可视化 tokenizer 试玩台：看清词表结构、真实 chat template 的渲染结果，以及一段文本究竟如何变成 Token。

## 主要特性

- 支持本地目录与远端仓库（Hugging Face / ModelScope）加载
- 支持 `.gguf`、SafeTensors 等文件的轻量元数据查看
- **词表结构可视化。** 一眼查看 tokenizer 类型、词表和合并规则数量、新增 Token、长度分位数、长度分布图，以及最长 Token Piece 的 Unicode 标量数和 UTF-8 字节数。
- **分词渲染** 彩色 Token 片段展示渲染后文本中的分词边界；可显示空白字符，并切换到 Token 表查看 Token ID、原始 Piece 与解码结果。参考的https://tiktokenizer.vercel.app/。
- **看清 chat template 的真实开销。** 编辑 `system` / `user` / `assistant` 消息，渲染当前 Jinja chat template，检查实际送入 tokenizer 的文本，并对照 Token 数、Unicode 字符数和每 Token 字节数。
- **明确区分 exact 与 decoded。** 并列查看原始 Token、解码 Token，以及 exact 映射和仅 decoded 映射的区别，便于排查 byte fallback 等场景。
- 支持加载和查看 `tokenizer.json`、`tokenizer_config.json`、`chat_template.jinja`
- 支持 Jinja chat template 渲染与验证
- 支持展示 imatrix 元数据（如可用）
- 保持轻量化数据读取：不会读取模型权重文件
- SwiftUI + AppKit 混合窗口，使用 macOS Swift Package 组织

## 功能截图

### 词表结构与长 Token 分析
![Tokenizer 词表分析](docs/tokenizer-vocabulary-overview.png)

概览页把大型 `tokenizer.json` 转化为可读的结构信息：BPE 词表和合并规则数量、分位数卡片、长度分布图，以及字符长度与 UTF-8 字节长度分开统计的最长 Token。

### Chat Template 与彩色分词可视化
![Chat Template 分词可视化](docs/tokenizer-chat-visualization.png)

输入原始文本或聊天消息后，可以先检查实际送入 tokenizer 的完整文本，再从彩色 Token 片段一路追踪到完整 Token ID 列表。

### 紧凑窗口模式
![紧凑窗口](docs/model-files-compact.png)

## 目录结构

```text
tools/model-files/
├── Sources/ModelFiles/        # SwiftUI App 源码
├── Tests/ModelFilesTests/     # 单元测试与测试数据
├── docs/                     # 设计文档与验收记录
├── script/                   # 构建/运行脚本
├── Prototypes/               # 早期 HTML 原型
├── dist/                     # 本地构建产物目录
└── Package.swift             # SwiftPM 包描述
```

## 环境要求

- macOS 15.0+
- Swift 6.0+
- 命令行依赖：`git`, `swift`

## 构建与运行

```bash
# 在仓库根目录或 tools/model-files 目录下执行
cd tools/model-files

# 构建并运行应用
./script/build_and_run.sh run

# 仅构建并校验 app bundle
./script/build_and_run.sh verify
```

## 使用流程

1. 启动应用。
2. 选择仓库源：本地目录、Hugging Face / ModelScope 或 SSH 源。
3. 在侧栏确认 tokenizer bundle 命中。
4. 打开 tokenizer 概览，查看词表结构、长度分布和长 Token 详情。
5. 切到 chat 分页，用当前 template 对测试消息分词。
6. 查看渲染后的 prompt、彩色片段、Token ID，以及 exact 与 decoded 的关系。

## 测试

在 `tools/model-files` 目录执行：

```bash
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

## 验收与证据

真实 App 验收记录见：`tools/model-files/docs/tokenizer-playground-acceptance.md`。

## 许可证

本项目使用 MIT 协议，详见 [`LICENSE`](LICENSE)。
