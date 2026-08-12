# Model Files Web 本地功能完整性验收记录

日期：2026-08-10
结论：`PASS`。T11–T20 的全部适用能力在本地浏览器通过；不可行能力均保持 `NO-GO`。未发布、未打 tag、未提交。

## 环境与门禁

参考环境：macOS arm64，Node.js 26.7.0，Playwright 1.62.1。

| 引擎 | 版本 | 离线结果 |
| --- | --- | --- |
| Chromium | 151.0.7922.34 | PASS |
| Firefox | 153.0 | PASS |
| WebKit | 26.5 | PASS |

最终复跑命令：

```bash
cd tools/model-files-web
npm ci
npm run check
npm run test:e2e
npm run test:e2e:live
git diff --check
```

- Unit：40 pass，0 fail。
- Production build：main 406,798 bytes（gzip 123.92 kB）；tokenizer/Jinja worker 79,062 bytes。
- 离线 E2E：43 pass；11 条按设计 skip（9 条真实网络用例在离线矩阵跳过，2 条非 Chromium 的单引擎性能门跳过）；总耗时 16.5 秒。
- 真实 Chromium smoke：3 pass，20.4 秒，覆盖 Qwen、T5、GGUF。
- `npm run dev -- --host 127.0.0.1 --port 5174 --strictPort`：85 ms ready；真实 Chromium 打开后 title、品牌和只读状态正确，console 0 error / 0 warning。开发态 CSS 使用原生 `<link>`，生产 CSP 未放宽。
- `git diff --check`：PASS。

## 最终支持矩阵

| 能力 | 状态 | 浏览器证据 |
| --- | --- | --- |
| 公开 Hugging Face、固定 revision、清单、筛选、深链接 | PASS | 三引擎离线；真实 Chromium |
| 本地目录选择与 `File.slice()` | PASS | 三引擎完整 13 文件目录 |
| 历史、分类、路径复制、源站链接、会话缓存 | PASS | 三引擎离线 |
| Config、Generation Config、JSON、文本、分片 index | PASS | 三引擎离线；真实 Qwen Config |
| Markdown 渲染、原文与安全 URL/图片策略 | PASS | 三引擎离线；真实 Qwen README |
| Tokenizer 结构与 BPE/WordPiece/Unigram 词表统计 | PASS | Unit、三引擎 Worker；真实 Qwen/T5 |
| SafeTensors Header 工作台 | PASS | 三引擎离线；真实 Qwen；0 tensor bytes |
| GGUF 24-byte 基础摘要 | PASS | 三引擎离线；真实 GGUF；0 model bytes |
| Legacy Imatrix | PASS | Unit、三引擎远端 fixture 与本地目录 |
| Jinja 源码与 Template Playground | PASS | Unit、三引擎离线、真实 Qwen Chat |
| Tokenizer Raw / Chat | PASS | 三引擎离线；真实 Qwen Exact、T5 Decoded-only |
| 超限、HTTP 200 Range、无效格式、取消与重试 | PASS | Unit 与三引擎失败关闭 E2E |
| 响应式、深色、焦点和键盘工作流 | PASS | 三引擎；390×844、768×1024、1280×800 |
| ModelScope 公共仓库 | NO-GO | 清单无 CORS；见 `feasibility-gates.md` |
| SSH 目录 | NO-GO | 纯浏览器无 SSH；不加桥接 |
| 完整 GGUF metadata/tensor directory | NO-GO | 会越过 tensor data offset；见 `gguf-feasibility.md` |
| PyTorch、ONNX 等权重内容 | NO-GO | 产品显示锁定，内容请求为 0 |
| 私有仓库/token/账号同步 | NO-GO | 不保存凭据 |
| 推理、转换、量化、修改、上传 | NO-GO | 超出只读文件检查器职责 |

## 真实仓库与读取账本

| 仓库与 revision | 路径 | 结果 | 实际内容读取 |
| --- | --- | --- | ---: |
| `Qwen/Qwen3-0.6B` `c1899de289a04d12100db370d81485cdf75e47ca` | Config、README、SafeTensors、Tokenizer 结构、Raw、Chat | PASS，9.6 秒 | 11,482,637 bytes |
| 同上 | `model.safetensors` | 两次严格 Range：`bytes=0-7`、`bytes=8-35559` | 35,560 Header bytes；0 tensor bytes |
| 同上 | `tokenizer.json` + `tokenizer_config.json` | 只读同目录 bundle；Chat 复用嵌入模板 | 11,432,386 bytes |
| `google-t5/t5-small` `df1b051c49625cf57a3d0d8d3863ed4d13564fe4` | Tokenizer Raw normalization | PASS，`Decoded only`，3.7 秒 | 1,391,677 bytes；0 weight bytes |
| `bartowski/Qwen_Qwen3-0.6B-GGUF` `60b85c0e3d8fe0f6474f406922a26d12aca4550d` | `Qwen_Qwen3-0.6B-IQ2_M.gguf` | PASS，5.9 秒 | `bytes=0-23`；24 bytes；0 model bytes |

Qwen 总数由清单固定大小与浏览器请求相加：Config 726、README 13,965、SafeTensors Header 35,560、Tokenizer 11,422,654、Tokenizer Config 9,732 bytes。Tokenizer/Jinja 未读取仓库自定义代码或其他目录资源。

离线综合目录在三个引擎中依次完成 Config、Markdown、10,005 项 JSON、100,002 行文本、weight index、Imatrix、Jinja、Tokenizer、SafeTensors 和 GGUF；外部请求为 0。超限 JSON 和锁定权重不会新增内容请求。

## 性能、console 与视觉证据

- 10k token：修前在 40.4 秒测试超时；共享 decode 与重复 DOM 根因修复后，Chromium 1.2–1.3 秒，首屏 1,000 行、继续后 2,000 行。
- 100,002 行文本：三引擎均满足 `<3 秒` 门；整条阅读器用例分别约 Chromium 0.9 秒、WebKit 1.4 秒、Firefox 1.8 秒。
- 浏览器应用 console：所有离线/真实断言均为 0 error / 0 warning。终端中的 `NO_COLOR` 信息是 Playwright/Node harness warning，不来自页面 console。
- Chromium 截图：
  - `/private/tmp/model-files-web-final-evidence/model-files-keeps-controls-e01d9-orts-keyboard-and-dark-mode-chromium/390x844.png`
  - `/private/tmp/model-files-web-final-evidence/model-files-keeps-controls-e01d9-orts-keyboard-and-dark-mode-chromium/768x1024.png`
  - `/private/tmp/model-files-web-final-evidence/model-files-keeps-controls-e01d9-orts-keyboard-and-dark-mode-chromium/1280x800.png`
  - `/private/tmp/model-files-web-final-evidence/model-files-keeps-controls-e01d9-orts-keyboard-and-dark-mode-chromium/dark-mode.png`

人工查看确认三个尺寸和深色模式均无横向溢出或主操作遮挡。三引擎键盘用例完成打开、筛选、选文件、切 perspective、编辑模板、运行、查看表格与重试。

## 当前边界

本里程碑只验证本地应用。部署、tag、production URL、线上 smoke 和回滚均未执行，也不影响本地功能完整性结果。
