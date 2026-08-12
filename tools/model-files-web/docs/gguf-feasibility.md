# GGUF 完整目录可行性门禁

日期：2026-08-10
结论：**NO-GO**（v0.1 不接入完整 metadata/tensor directory）

## 判定标准

只有同时满足以下条件才为 GO：32 MiB 前缀内完成 GGUF v1-v3 metadata 与 tensor directory 解析、读取 0 bytes tensor 数据、参考环境累计解析耗时不超过 2 秒。

实现依据为 [GGUF v3 规范](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md)。格式给出 tensor data 的对齐规则，但文件开头没有独立的 directory 长度字段。因此，通用客户端只能继续顺序读取并尝试解析；完成解析的最后一个固定大小 Range 可能越过此前未知的 tensor data offset。

## 可复跑证据

命令：

```bash
node scripts/verify-live-gguf.mjs
```

2026-08-10 对公开仓库 `bartowski/Qwen_Qwen3-0.6B-GGUF` 的输出：

```json
{
  "decision": "NO-GO",
  "file": "Qwen_Qwen3-0.6B-IQ2_M.gguf",
  "revision": "60b85c0e3d8fe0f6474f406922a26d12aca4550d",
  "fileBytes": 331761056,
  "chunkBytes": 1048576,
  "budgetBytes": 33554432,
  "bytesRead": 6291456,
  "rangeRequests": 6,
  "responseOrigins": ["https://huggingface.co", "https://us.aws.cdn.hf.co"],
  "parseMilliseconds": 512.06,
  "parseStatus": "complete",
  "tensorDataOffset": 5951904,
  "tensorDataBytesRead": 339552,
  "metadataCount": 31,
  "tensorCount": 311,
  "parameterCount": "751632384"
}
```

目录在预算内完成，解析耗时也通过，但最后一个 Range 已读取 339,552 bytes tensor 数据，所以零权重读取门禁失败。减小固定分块只能缩小越界量，不能对任意 GGUF 保证为零；预先使用该文件已知的 offset 也不是可泛化的产品行为。

## 产品决定

T5 不执行。v0.1 只保留已验证的 24-byte GGUF 基础摘要（magic、版本、字节序、tensor 数、metadata 数），明确显示实际读取量与 0 bytes 模型数据，不展示完整 metadata 或 tensor directory，也不增加整文件下载回退。

如果未来 GGUF 格式或仓库 API 提供可信的 directory 长度，再重新运行门禁；不为当前版本放宽 32 MiB 或零权重读取条件。
