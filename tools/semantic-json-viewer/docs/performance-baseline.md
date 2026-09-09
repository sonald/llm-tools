# Semantic JSON Viewer Core 性能基线

> 状态：pre-lazy Core baseline，非发布验收 PASS，也不是最终性能报告。

## 测试边界

- 日期：2026-09-09。
- 环境：macOS Darwin，arm64/aarch64，11 logical CPUs，36 GiB 内存。
- 构建：release，Core-only；未包含 Tauri/WebView，未测 RAM。
- 运行方式：warm，JSONL indexing 后空闲 5 秒；5 轮，每轮新进程。Document runner 未记录 idle 等待。
- 冷文件缓存准备：当前 runner 在 macOS 上不支持，未准备成功的 cold 样本会被拒绝聚合。
- runner：`c214a20`。本基线对应源码仍为 eager string decode，spec §18.4 尚未完成。

## 固定输入

输入由 `fixtures/generate-benchmark-fixture.mjs` 生成，分布固定，不得用其他输入替换本表结果。

| 输入 | 实际大小 | 条目数 | SHA-256 |
| --- | ---: | ---: | --- |
| JSONL，默认 full-size | 1,073,741,824 B（1 GiB） | 4,228,181 rows | `9cf86a730854780a4bb9f2f60f066484b63d35438e9eb41b41645d15483c1e54` |
| JSON，默认 full-size | 104,857,600 B（100 MiB） | 419,528 items | `2ec0583721d1d5473a824a0f49fb213845fb51427f289e390cd622e68f89d680` |

## 结果

下表单位均为 µs；p95 依据当前 5 个样本取 nearest-rank，因此等于该组最大样本。JSONL 每轮包含 100 个 distinct head-tail seeks，均为 Valid。

### JSONL

| 指标 | 5 次原始样本（µs） | median（µs） | p95（µs） |
| --- | --- | ---: | ---: |
| openToFirst20 | 475, 943, 900, 600, 608 | 608 | 943 |
| scanComplete | 860481, 803120, 810061, 822853, 799886 | 810061 | 860481 |
| perRunSeekP95 | 80, 66, 50, 52, 106 | 66 | 106 |
| perRunSeekMedian | 55, 51.5, 38, 32, 50 | 50 | 55 |

### Document（JSON）

| 指标 | 5 次原始样本（µs） | median（µs） | p95（µs） |
| --- | --- | ---: | ---: |
| Document root | 770716, 755510, 801670, 969988, 730933 | 770716 | 969988 |
| openToRaw | 774717, 757643, 807332, 975471, 733550 | 774717 | 975471 |
| readyToRaw | 4000, 2133, 5661, 5483, 2616 | 4000 | 5661 |

## 复现命令

以下命令从仓库根目录执行，描述复现路径；本记录不声称在本次写文档操作中重新运行过这些命令。输出目录应为本次新建的临时目录，避免覆盖已有文件：

```bash
cd tools/semantic-json-viewer
tmpdir="$(mktemp -d /tmp/sjv-benchmark.XXXXXX)"
node fixtures/generate-benchmark-fixture.mjs --kind jsonl --output "$tmpdir/benchmark.jsonl"
node fixtures/generate-benchmark-fixture.mjs --kind json --output "$tmpdir/benchmark.json"
npm run benchmark:core -- --scenario jsonl --path "$tmpdir/benchmark.jsonl" --cache warm
npm run benchmark:core -- --scenario document --path "$tmpdir/benchmark.json" --cache warm
```

## 未测与后续门槛

- 未测 Tauri/WebView 端到端耗时、RAM、index/LRU/private/inputmapping 内存。
- Linux x86_64（至少 8 logical cores、16 GiB、NVMe）尚待验证。
- 该结果只反映固定输入分布下的 lazy 前 Core 基线；不能外推到其他数据分布，也不能替代 spec §18 的最终性能验收。
