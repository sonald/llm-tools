# Model Files Web

Model Files Web 是纯浏览器、公开只读的 Hugging Face 模型文件检查器。它不加载模型权重，不需要后端，也不发送凭据。

## 用户可见能力

| 文件 | 支持等级 | 读取边界 |
| --- | --- | --- |
| Config、Generation Config、通用 JSON、分片 index | 语义概览、全部字段、原文 | 单文件最多 32 MiB，严格 UTF-8/JSON，1,000 项渐进显示 |
| Markdown、`vocab.json`、`merges.txt` 与文本 | 渲染/原文、搜索、渐进列表 | 单文件最多 32 MiB；raw HTML 与第三方图片请求禁用 |
| SafeTensors | Header、metadata、层级 tensor 目录（自然排序、搜索剪枝、后代计数、折叠、breadcrumb、详情） | 只读 8-byte 长度和精确 Header，0 bytes tensor 数据 |
| GGUF | 基础摘要 | 只读前 24 bytes；版本、字节序、tensor/metadata 数量 |
| `imatrix*.dat` | legacy imatrix 概览、搜索、Entry 详情 | 受限全文解析；累计条目、名称和 float 数量均失败关闭 |
| `tokenizer.json` | 结构/词表分析、Raw/Chat、Token IDs/Special/Role/tools/variables/overhead/template catalog/vocabulary | 同目录 bundle 最多 32 MiB；输入最多 64 KiB；搜索结果最多 1,000 条；Worker latest-only |
| 独立 SentencePiece `.model` | BPE/Unigram 编码、pieces、decode、Raw/Chat 与对照 | 同目录 bundle 最多 32 MiB；输入最多 64 KiB；Worker 内 WASM latest-only |
| Python、YAML/YML、JSON、PDF 与普通源码 | 语法高亮、折叠、当前文件查找；PDF 内嵌预览 | 可读文件最多 32 MiB；>128 KiB 不折叠但全文可查；未知二进制失败关闭 |
| `chat_template.jinja` / `chat_template` | 源码、临时编辑、Template Playground | 最多 64 KiB；Worker 渲染；不支持 include 或代码执行 |
| 其他权重格式 | 锁定 | 不请求文件内容 |

完整 GGUF metadata/tensor directory 的产品门禁为 NO-GO：格式没有独立目录长度，通用顺序 Range 无法在未知 tensor data offset 前保证停止。证据见 [GGUF 可行性记录](docs/gguf-feasibility.md)。

数据来源支持匿名公开 Hugging Face 仓库和用户主动选择的本地目录。远端内容固定到清单返回的 40-hex revision；本地文件只保留在当前页面会话，不上传、不写入 URL。页面只在 `localStorage` 保存最多 10 个远端仓库 ID 并提供清除，不持久化文件内容、目录路径、tokenizer/template 输入或检查结果。

Tokenizer 支持同快照对照、第二公开 Hugging Face 仓库或用户主动选择的第二本地目录；两侧 session 隔离，可比较 token 数、ID 序列、Chat overhead 与 JSON 词表差集。仓库一致性报告覆盖 findings 与 checked/missing/skipped/failed coverage，但不读取权重或扩展 GGUF boundary。界面跟随浏览器语言提供简体中文和 English，没有应用内语言选择器。

不支持 ModelScope（浏览器清单 CORS 门失败）、SSH、私有仓库/token、模型推理、转换/量化/上传或完整权重下载；不会引入后端、代理、浏览器扩展或桌面桥接。SafeTensors 保持精确 Header Range 且 tensor 数据请求为 0 bytes；GGUF 只读 24-byte prefix。完整支持矩阵和证据见 [产品化计划](docs/productization-plan.md)、[本地功能完整性验收记录](docs/local-functionality-acceptance.md) 与 [原生追平验收记录](docs/native-parity-acceptance.md)。

## 本地开发

需要 Node.js 24。

```bash
cd tools/model-files-web
npm ci
npm run dev
```

验证：

```bash
npm run check
npx playwright install chromium firefox webkit
npm run test:e2e
```

真实 Hugging Face smoke 不进入确定性 CI，可手动运行：

```bash
npm run test:e2e:live
node scripts/verify-live-gguf.mjs
```

当前里程碑只要求本地运行与浏览器验收，不发布、不打 tag。

## 发布

`.github/workflows/model-files-web.yml` 只在本目录或工作流变化时验证。推送 `model-files-web-v*` tag 后，工作流从 lockfile 重新构建、上传不可变 Actions artifact，并部署到 GitHub Pages。查询参数位于站点根 URL，刷新不依赖 SPA fallback。

发布不属于当前本地功能完整性门禁。历史纵向结果见 [v0.1 验收记录](docs/v0.1-acceptance.md)。

第三方依赖与许可见 [依赖清单](docs/third-party-dependencies.md)。
