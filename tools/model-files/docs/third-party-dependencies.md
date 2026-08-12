# ModelFiles 第三方依赖

更新时间：2026-08-12

## Tokenizer Playground 新增依赖

| 依赖 | 固定版本 | 使用范围 | 许可证 |
|---|---:|---|---|
| `huggingface/swift-transformers` | `1.3.3`（exact） | `Hub.Config`、`Tokenizers.AutoTokenizer`、encode/decode 与 token piece 转换 | Apache-2.0 |
| `jkrukowski/swift-sentencepiece` | `0.0.6`（exact） | 读取原生 SentencePiece `.model` 并执行 encode/decode | MIT |
| `google/sentencepiece` | `0.2.0`（封装于上述 XCFramework） | SentencePiece 原生 encode/decode 实现 | Apache-2.0 |

工程只链接 `swift-transformers` 的 `Hub` / `Tokenizers` 和 `swift-sentencepiece` 的 `SentencepieceTokenizer` products，不链接模型推理、生成或 SentencePiece CLI products。运行时只解析当前 `RepositorySnapshot` 中已经列出的 tokenizer 资源，不使用 `AutoTokenizer.from(pretrained:)`，也不下载或执行仓库自定义代码。

`swift-sentencepiece` 封装 Google SentencePiece 0.2.0；其 0.0.6 package 固定使用 0.0.5 release 中校验和为 `4b3b3fef…` 的 XCFramework。ModelFiles 显式使用 `tokenOffset: 0`，保持 `.model` 内原始 token ID，不采用该包装库面向部分 Hugging Face 模型的默认 `+1` 偏移。

## 新增传递依赖

以下版本由 `Package.resolved` 固定；除最后一项来自 `swift-sentencepiece` 外，其余来自 `swift-transformers` 1.3.3：

| 依赖 | 版本 | 许可证 |
|---|---:|---|
| `huggingface/swift-huggingface` | 0.9.0 | Apache-2.0 |
| `mattt/EventSource` | 1.4.1 | MIT |
| `apple/swift-nio` | 2.101.3 | Apache-2.0 |
| `apple/swift-atomics` | 1.3.1 | Apache-2.0 |
| `apple/swift-system` | 1.8.0 | Apache-2.0 |
| `apple/swift-crypto` | 4.5.1 | Apache-2.0 |
| `apple/swift-asn1` | 1.7.1 | Apache-2.0 |
| `ibireme/yyjson` | 0.12.0 | MIT |
| `apple/swift-argument-parser` | 1.8.2 | Apache-2.0；仅由 `swift-sentencepiece` 的 CLI target 声明，ModelFiles 不链接该 CLI |

`swift-jinja` 仍为 2.4.1，`swift-collections` 仍为 1.6.0；本次依赖合并没有升级这两个既有 pin。完整解析图可用下列命令复核：

```bash
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift package --disable-sandbox show-dependencies --format text
```

## 体积与分发注意事项

- 当前 debug App bundle 为约 30 MiB，主可执行文件为 29,884,496 bytes；引入 SentencePiece 前的同文档快照为约 29 MiB / 28,432,832 bytes，但构建时间和源码状态不同，不把差值当作严格发布版增量。
- 离线测试 tokenizer fixtures 共 3,859 bytes，不包含模型权重或 Hub 缓存。
- 发布产物需要随包保留 Apache-2.0 和 MIT 依赖的许可证/NOTICE 要求；最终发布审计仍以实际归档产物为准。
