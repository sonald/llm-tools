# ModelFiles Tokenizer Playground 验收记录

结论：**PASS（实现与真实 App 主路径通过；兼容性边界见下文）**

日期：2026-08-09

基线：`main` / `f206590aafd7d925e6e8af10ce7b89e1f0d40a42`，验收对象为未提交工作区。

环境：macOS 26.5.2（25F84），Apple Swift 6.3.3，arm64。

## 1. 实现契约

| 契约 | 结果 | 证据 |
|---|---|---|
| 仅 `tokenizer.json` 出现顶层“试验台” | PASS | 真实 App 的 tokenizer 为四视图；普通配置 JSON 保持三视图 |
| A 为默认左右工作台 | PASS | 左侧 Raw/Chat 与权威输入，右侧指标、彩色片段和 ID；尺寸、间距和层级与 A 原型一致 |
| C 是内部 Token 表 | PASS | `片段 / Token 表` 切换共享同一 `TokenizationResult`，列为 `# / ID / Token Piece / Decoded / Mapping` |
| Chat 可见输出就是编码输入 | PASS | Qwen3 的 165-byte 渲染结果与 `TokenizationResult.input` 相等；管线测试固定断言 |
| 不重复插入特殊 token | PASS | runtime 只调用 `encode(text:addSpecialTokens:false)`；测试拒绝额外 BOS/EOS |
| Exact 与 Decoded only 不混淆 | PASS | Qwen3/GLM 原始样例为 Exact；T5、normalization 与未知 token 样例为 Decoded only；无 bytes/offset 列 |
| latest-only 与安全阈值 | PASS | 225ms 防抖、generation gate、64 KiB 输入上限、32 MiB bundle 上限；切换文件清空旧结果 |
| 不读取模型权重 | PASS | loader spy 只记录 tokenizer/config/template；真实仓库虽列出 242.1 MiB `rust_model.ot`，试验台只读取 1.4 MiB tokenizer bundle |

## 2. 离线测试与构建

标准测试：**发现 57 项；56 项执行并 PASS，1 项显式非 CI benchmark 跳过，0 failure**。真实 tokenizer benchmark 由环境变量触发，标准离线运行不依赖网络或用户缓存。

```bash
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

覆盖内容：

- BPE、WordPiece、Unigram、ByteFallback 四类小 fixture，固定 ID 与 decode 结果；fixture 总计 3,859 bytes。
- 中文、ZWJ/emoji 的多 token 安全分组、unknown/normalization、Exact/Decoded only。
- 同目录伴随文件、根目录不跨目录猜测、未知大小、单文件/总量/实际字节超限、取消和文件变化透传。
- Hugging Face、ModelScope、本地、SSH 四种 `RepositoryLocation` 通过同一个 loader；fake SSH 通过真实进程 runner 完成列表与范围读取。
- Chat Template 的 Jinja 优先级、可见输出等值和不重复特殊 token。
- latest-only、输入超限、切换文件后的旧结果隔离。
- 既有配置、Jinja、GGUF、SafeTensors、Imatrix 与 RepositoryAccess 测试全部回归通过。

Bundle 验证：**PASS**。

```text
Info.plist: OK
Verified tools/model-files/dist/ModelFiles.app
git diff --check: PASS
```

## 3. 真实 tokenizer 矩阵

| 仓库 / 来源 | 资源 | 结果 | 观察 |
|---|---:|---|---|
| `Qwen/Qwen3-0.6B` / ModelScope | tokenizer 11.4 MiB + config 10 KiB | PASS | Chat 默认可用；165 bytes → 30 tokens，special token 只来自模板 |
| `openai-community/gpt2` 的 `onnx/` / ModelScope | tokenizer 2.1 MiB + config 234 bytes | PASS | Raw 81 bytes → 37 tokens，Exact；证明子目录伴随文件匹配 |
| `openai-community/gpt2` 根目录 / ModelScope | tokenizer 1.4 MiB + config 26 bytes | UNSUPPORTED（预期） | config 没有 `tokenizer_class`；严格模式明确失败，不近似降级 |
| `google-bert/bert-base-chinese` / ModelScope | tokenizer 269 KiB + config 49 bytes | UNSUPPORTED（预期） | 发布配置没有 `tokenizer_class`；离线 WordPiece fixture 证明已支持该实现类 |
| `google-t5/t5-small` / Hugging Face | tokenizer 1.4 MiB + config 2 KiB | PASS | Raw 81 bytes → 17 tokens，Decoded only；未把 `<unk>` 映射成原文 |
| `baseten/GLM-5.2-Vision-NVFP4` / ModelScope | tokenizer 20.2 MiB + config/template | PASS（Raw） | Raw 81 bytes → 17 tokens，Exact；见 Chat 兼容性边界 |
| 离线 WordPiece 目录 / 本地 | 998 bytes bundle | PASS | 无模板时自动选择 Raw；`Hello worlds` → `[3, 4, 5]` |
| fixture / SSH source path | 小 fixture | PASS | fake SSH 可执行文件驱动真实 `SSHDirectoryAccess`；外部 SSH 主机不是验收前提 |

## 4. 性能与阈值

官方 Qwen3 文件下载到 `/tmp/model-files-qwen3-tokenizer` 后，以 SHA-256 `aeb13307…` 的 `tokenizer.json` 定标。时间不含网络；load 是 JSON 解码和严格 runtime 构造，encode 项包含结果、piece、decode 和 segment 构造。

| 项目 | 输入 / 规模 | 结果 |
|---|---:|---:|
| bundle | 11,432,386 bytes | load 4.824s |
| encode+result | 8 KiB / 2,048 tokens | 0.045s |
| encode+result | 64 KiB / 16,384 tokens | 0.385s |
| encode+result | 256 KiB / 65,536 tokens | 1.680s |

结论：保留 32 MiB bundle 上限和 64 KiB UI 输入上限。Qwen3、20.2 MiB GLM tokenizer 均在 bundle 上限内；256 KiB 已明显增加等待和结果视图负担，不放宽 UI 上限。

## 5. 真实 App 与原型对照

通过 `bash script/build_and_run.sh run` 启动当前 bundle，并用 macOS Accessibility 树和截图验收：

- Qwen Chat：`file:///var/folders/9k/7j3z072513z5hkf_xgcxzdzm0000gn/T/com.openai.sky.CUAService/ModelFiles%20Screenshot%202026-08-09%20at%203.18.56%20PM.jpeg`
- A / Raw：`file:///var/folders/9k/7j3z072513z5hkf_xgcxzdzm0000gn/T/com.openai.sky.CUAService/ModelFiles%20Screenshot%202026-08-09%20at%203.16.38%20PM.jpeg`
- C / Token 表：`file:///var/folders/9k/7j3z072513z5hkf_xgcxzdzm0000gn/T/com.openai.sky.CUAService/ModelFiles%20Screenshot%202026-08-09%20at%203.16.52%20PM.jpeg`
- 最终浅色：`file:///var/folders/9k/7j3z072513z5hkf_xgcxzdzm0000gn/T/com.openai.sky.CUAService/ModelFiles%20Screenshot%202026-08-09%20at%203.34.53%20PM.jpeg`
- 最终深色：`file:///var/folders/9k/7j3z072513z5hkf_xgcxzdzm0000gn/T/com.openai.sky.CUAService/ModelFiles%20Screenshot%202026-08-09%20at%203.35.36%20PM.jpeg`
- 紧凑窗口：`file:///var/folders/9k/7j3z072513z5hkf_xgcxzdzm0000gn/T/com.openai.sky.CUAService/ModelFiles%20Screenshot%202026-08-09%20at%203.36.29%20PM.jpeg`

验收结果：

- PASS：A 的 46/54 左右层级、14pt 外边距、12pt 间距、39pt panel header、三张指标卡和上下结果区与原型一致。
- PASS：C 为右侧内部切换，不新增顶层 perspective；表格在窄宽度下横向滚动。
- PASS：浅色与深色使用系统语义颜色，文字、彩色分组、边框和选中态均可读；验收后已恢复用户原来的浅色设置。
- PASS：窗口最小约束调整为 900×600；紧凑截图中 Raw/Chat、输入、片段/表格、复制和清空仍可到达，主要操作没有遮挡。
- PASS：AX 可读出输入模式、原始文本、token count、片段范围、每个 ID、Token 表行和复制按钮；模式与结果切换可通过标准 segmented control 到达。

## 6. 已知兼容性边界

- GLM 的 5 KiB `chat_template.jinja` 使用了当前 `swift-jinja` 不支持的语法，真实 App 显示 `Parser error: Expected identifier but found number.`，并在渲染阶段清除旧 token。Raw 不受影响。Qwen3 Chat 主路径已通过；没有为单个模板维护第二套解释器或静默改写模板。
- 严格模式要求 `tokenizer_config.json` 提供可识别的 `tokenizer_class`。旧 GPT-2/BERT 仓库缺少该字段时明确 UNSUPPORTED；这是方案规定的安全边界，不使用 `strict:false` 猜测。
- 没有可用的外部 SSH 测试主机；SSH 行为由真实 `SSHDirectoryAccess` + fake SSH transport 的端到端测试验证，未声称外部网络环境已经验证。
- App 当前没有 URL 级网络日志。无权重读取由访问层 spy、只接受三种 bundle 文件的 loader 和真实 App 在列出大权重时仍只加载 tokenizer 的行为共同证明；没有把 TLS 连接观察伪装成路径级网络 trace。
