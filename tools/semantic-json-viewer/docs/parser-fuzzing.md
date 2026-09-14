# Parser mutation fuzzing

`src-tauri/examples/parser_fuzz.rs` 是 M3 的 bounded mutation-fuzz runner。它直接调用当前 span-preserving `parse_json`，不使用 `serde_json::Value` 作为产品模型，也不是 coverage-guided/libFuzzer。

## 运行

在 `tools/semantic-json-viewer` 目录执行：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --example parser_fuzz -- --selfcheck
cargo run --release --manifest-path src-tauri/Cargo.toml --example parser_fuzz -- \
  --seed 0x534a565f46555a5f --iterations 100000 --max-input 65536
```

默认是固定 seed、10,000 次、单输入最多 64 KiB；`--selfcheck` 使用 128 次和 16 KiB。`--iterations` 上限为 1,000,000，`--max-input` 上限为 4 MiB。每次输入都由固定合法 JSON seed 和确定性 mutation 生成，另有 arbitrary-bytes 分支。

mutation 覆盖 invalid UTF-8、非法 escape、孤立 surrogate、duplicate keys、超大 number、受限深度、截断、尾随 bytes 和任意 bytes。主 mutation 分支会对 seed 做 1–8 次确定性的随机 insert/delete/replace/splice，替换字节取完整 byte 范围；深度分支包含 255、256、257 等边界。runner 只将 parser 明确拒绝的输入计入 `rejected`；成功解析的输入必须通过树不变量检查后才计入 `accepted`。

成功时输出 seed、iterations、max-input、accepted、rejected 摘要。成功不代表 parser 覆盖率、安全完整性或发布性能达标。

## 不变量与失败重现

成功 parse 后检查：

- 所有可达节点的 span 在输入范围内，且 `raw_lexeme` 与源 slice 完全一致。
- root、parent/child、父 span 包含子 span、节点唯一可达关系成立。
- ArrayIndex、ObjectKey 的父类型、子位置、key span 和 duplicate-key occurrence 一致。

panic 或不变量失败会以非零退出；runner 使用 `create_new` 在系统临时目录写入原始输入，不覆盖已有文件，并输出 seed、iteration、mutation、字节数、原因和 repro 路径。深度 case 在 parse 前还会留下 `current` repro；若 parser 回归为不能由 `catch_unwind` 接住的 stack-overflow abort，进程会非零退出但该文件仍可用于复现。使用相同 seed、至少运行到该 iteration 的参数即可重新生成同一输入；repro 文件也保留原始 bytes 供离线检查。

深度边界已改为单一显式 `Vec<Frame>` 容器栈，不再依赖 Rust 调用栈，也不以固定深度拒绝合法 JSON。50,000 层 array、object 和交替混合容器已通过独立 release 进程的 parse、root 读取和正常 drop；单元测试另验证父子节点链和源跨度。深层未闭合输入也返回原有 `ParseError`，而不是 stack-overflow abort。该证据仍不等同于无限资源保证，超大输入应继续使用隔离进程和超时约束进行安全测试。

这不是完整安全报告、coverage 报告或 libFuzzer 证明；长期 100,000 次运行仍只是在固定 seed、固定 mutation 和输入上限下的 bounded evidence。
