# ModelFiles 第三方依赖

更新时间：2026-08-09

## Tokenizer Playground 新增依赖

| 依赖 | 固定版本 | 使用范围 | 许可证 |
|---|---:|---|---|
| `huggingface/swift-transformers` | `1.3.3`（exact） | `Hub.Config`、`Tokenizers.AutoTokenizer`、encode/decode 与 token piece 转换 | Apache-2.0 |

工程只链接该包的 `Hub` 和 `Tokenizers` products，不链接模型推理与生成 products。运行时只解析当前 `RepositorySnapshot` 中已经列出的 tokenizer 资源，不使用 `AutoTokenizer.from(pretrained:)`，也不下载或执行仓库自定义代码。

## 新增传递依赖

以下版本由 `swift-transformers` 1.3.3 的依赖图和 `Package.resolved` 固定：

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

`swift-jinja` 仍为 2.4.1，`swift-collections` 仍为 1.6.0；本次依赖合并没有升级这两个既有 pin。完整解析图可用下列命令复核：

```bash
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift package --disable-sandbox show-dependencies --format text
```

## 体积与分发注意事项

- 当前 debug App bundle 为约 29 MiB，主可执行文件为 28,432,832 bytes；没有可比较的同构建配置发布版基线，因此不虚构增量。
- 离线测试 tokenizer fixtures 共 3,859 bytes，不包含模型权重或 Hub 缓存。
- 发布产物需要随包保留 Apache-2.0 和 MIT 依赖的许可证/NOTICE 要求；最终发布审计仍以实际归档产物为准。
