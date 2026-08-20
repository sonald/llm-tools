# ModelFiles（原生 macOS）

ModelFiles 是一款原生 macOS 模型文件查看器，面向 Hugging Face / ModelScope 模型产物。打开仓库，读描述它的文件，再诊断 tokenizer 和 chat template 的行为；不读权重，也不跑推理。

## 主要特性

- 打开本地目录、Hugging Face / ModelScope 仓库，或 SSH 目录
- 查看 SafeTensors Header、GGUF metadata 前缀、legacy imatrix、Jinja 模板、Markdown、源码和 PDF
- 加载 tokenizer bundle：`tokenizer.json`、SentencePiece `.model`、`tokenizer_config.json`、`chat_template.jinja`
- 词表结构可视化：类型、词表和合并规则数量、新增 Token、长度分位数、分布图，以及按 Unicode 标量和 UTF-8 字节统计的最长 Piece
- 按需搜索 `tokenizer.json` 词表（ID 或 Piece）；概览只保留 special token 摘要和最长 50 条
- 对原始文本或聊天消息分词，也可粘贴 Token ID 反解
- 彩色片段、Token 表和 ID 列表共享同一选中 Token；表中标记 special token 和 chat 角色
- 渲染当前 Jinja chat template，在 jinja / config / named 来源间切换，并拆出总计 / 正文 / 模板开销
- 明确区分 Exact 与 decoded-only 映射，包括 byte fallback
- 缺少 `tokenizer_class` 时可显式指定后重试；覆盖只存在于当前会话，不写回文件
- 用同一输入对照两个 tokenizer：当前快照中的另一文件，或另一个仓库的 tokenizer bundle
- 检查仓库一致性：`config`、tokenizer、adapter/processor 配置、chat template，以及已经打开过的 GGUF metadata
- 只读：不读权重、不读 tensor 数据、不跑推理

分词可视化参考 [tiktokenizer](https://tiktokenizer.vercel.app/)。

## 功能截图

### 词表结构与长 Token 分析
![Tokenizer 词表分析](docs/tokenizer-vocabulary-overview.png)

概览页把大型 `tokenizer.json` 转化为可读的结构信息：BPE 词表和合并规则数量、分位数卡片、长度分布图，以及字符长度与 UTF-8 字节长度分开统计的最长 Token。

### Chat Template 与彩色分词可视化
![Chat Template 分词可视化](docs/tokenizer-chat-visualization.png)

输入原始文本或聊天消息后，可以先检查实际送入 tokenizer 的完整文本，再从彩色 Token 片段一路追踪到完整 Token ID 列表。

## 上限

- 可读文件和 tokenizer bundle：32 MiB
- 试验台 / Token ID 输入：64 KiB UTF-8
- 词表搜索和对照差集最多显示 1,000 条
- GGUF 一致性只用当前会话里已经打开过的 metadata
- SentencePiece `.model` 可以编码和解码，但没有 `tokenizer.json` 词表索引

## 目录结构

```text
tools/model-files/
├── Sources/ModelFiles/        # SwiftUI App 源码
├── Tests/ModelFilesTests/     # 单元测试与测试数据
├── docs/                      # 设计文档、验收记录、截图
├── script/                    # 构建/运行脚本
├── dist/                      # 本地构建产物目录
└── Package.swift              # SwiftPM 包描述
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
2. 打开本地目录、Hugging Face / ModelScope 仓库，或 SSH 目录。
3. 看标题栏一致性徽章；打开 Config 查看完整报告。
4. 打开 `tokenizer.json` 或 SentencePiece `.model` 进入试验台。
5. 编码原始文本、渲染聊天消息，或粘贴 Token ID 反解。
6. 可选：对照当前快照中的另一个 tokenizer，或加载另一仓库的 tokenizer bundle。
7. 需要时打开 README、源码、PDF、GGUF 或 imatrix。权重文件保持锁定。

## 测试

在 `tools/model-files` 目录执行：

```bash
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

真实模型测试默认跳过；只有设置 `MODELFILES_REAL_TOKENIZER_DIR` 或 `MODELFILES_REAL_SENTENCEPIECE_DIR` 指向完整同目录 tokenizer bundle 时才会执行。

## 验收与证据

- Tokenizer 试验台：[`docs/tokenizer-playground-acceptance.md`](docs/tokenizer-playground-acceptance.md)
- 诊断工作台（Token ID、一致性、对照）：[`docs/diagnostic-inspector-acceptance.md`](docs/diagnostic-inspector-acceptance.md)

## 许可证

本项目使用 MIT 协议，详见 [`LICENSE`](LICENSE)。
