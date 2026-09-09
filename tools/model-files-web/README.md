# Model Files Web

Model Files Web 是纯浏览器、只读的模型文件检查器。它不加载模型权重，不需要后端，也不发送凭据。

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

数据来源支持匿名公开 Hugging Face 仓库、HTTPS 文件/清单和用户主动选择的本地目录。Hugging Face 内容固定到清单返回的 40-hex revision；HTTPS 与本地来源均为 live，会话内不重新发现文件，不能保证远端文件不发生同大小修改。HTTPS 地址和本地文件只保留在当前页面会话，不写入页面 URL 或历史；本地文件不上传。页面只在 `localStorage` 保存最多 10 个 Hugging Face 仓库 ID 并提供清除，不持久化文件内容、目录路径、tokenizer/template 输入或检查结果。

Tokenizer 支持同快照对照、第二公开 Hugging Face 仓库、HTTPS 文件/清单或用户主动选择的第二本地目录；两侧 session 隔离，可比较 token 数、ID 序列、Chat overhead 与 JSON 词表差集。仓库一致性报告覆盖 findings 与 checked/missing/skipped/failed coverage，但不读取权重或扩展 GGUF boundary。界面跟随浏览器语言提供简体中文和 English，没有应用内语言选择器。

不支持 ModelScope（浏览器清单 CORS 门失败）、FTP/FTPS、SSH/SFTP、私有仓库登录/token 管理、模型推理、转换/量化/上传或完整权重下载；不会引入后端、代理、浏览器扩展或桌面桥接。SafeTensors 保持精确 Header Range 且 tensor 数据请求为 0 bytes；GGUF 只读 24-byte prefix。完整支持矩阵和证据见 [产品化计划](docs/productization-plan.md)、[本地功能完整性验收记录](docs/local-functionality-acceptance.md) 与 [原生追平验收记录](docs/native-parity-acceptance.md)。

## HTTPS 加载

在顶部“加载方式”选择：

- **HTTPS 文件**：粘贴文件直链，先通过 HEAD 获取 Content-Length，再使用对应阅读器；不会猜测或扫描同目录文件。单独打开 tokenizer.json 不会自动带入 tokenizer_config.json，完整 Raw/Chat 检查请使用清单。
- **HTTPS 清单**：粘贴一个 `.json` 清单地址，列出模型的配置、词表、模板和权重文件。每项的 `size` 是实际字节数；`url` 可为 HTTPS 绝对地址或相对于清单最终地址的链接。`path` 决定文件分类与关联关系，因此应保留原始文件名和目录。

示例（config.json 的内容恰好为 `{}`、无换行，共 2 bytes）：

```json
{
  "files": [
    { "path": "config.json", "url": "./config.json", "size": 2 }
  ]
}
```

清单上限 1 MiB、10,000 个条目；路径不得重复或包含 `..`。清单提供大小后不需要逐文件 HEAD，但实际读取仍校验字节数。普通文件保留 32 MiB 上限；SafeTensors 只读前 8 bytes 和 Header，GGUF 只读 24 bytes。服务器返回 200 或隐藏/返回错误的 Content-Range 时，停止读取，不回退到整文件下载。

服务器的清单、文件和最终重定向目标必须允许本站跨域访问。例如：

```http
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Range
```

文件直链需要 HEAD 返回有效 Content-Length；范围请求需要返回 `206` 及精确 `Content-Range`。如果服务器要求预检，还需允许 GET、HEAD 和 Range。不要使用压缩传输后的大小代替原始文件大小。参见 [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) 和 [Content-Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Range)。

仅支持 HTTPS，不提供账户登录或 Authorization header。带签名参数的 HTTPS URL 可以使用，但不会持久化；刷新后需重新打开。CSP 的 `connect-src` 允许 HTTPS 来源，脚本、图片、Worker 等策略保持原限制。所有请求仍由浏览器直接发送，不增加后端、代理或桌面桥接。

ModelScope 2026-09-09 复测仍未通过清单 CORS 门；通用 HTTPS 入口也不能绕过 CORS。详见 [可行性记录](docs/feasibility-gates.md)。

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

HTTPS E2E 使用临时本地 TLS 文件服务器验证真实 CORS，需要系统提供 `openssl`；测试证书仅由测试浏览器信任，不修改系统证书或产品 TLS 策略。

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
