# Semantic JSON Viewer Core 性能基线

> 状态：保留 2026-09-09 pre-lazy Core baseline，并追加 2026-09-14 lazy-string/explicit-stack 复测；两者均非发布验收 PASS，也不是最终性能报告。

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

## 2026-09-14 复测（lazy string decode + explicit container stack）

- 环境：同一台 macOS Darwin arm64/aarch64 主机，11 logical CPUs，36 GiB 内存。
- 构建与版本：release、Core-only（不含 Tauri/WebView，未测 RAM）；源码版本 `5cae6e5`，同时包含显式容器栈与 eager decoded 移除，不能将结果变化单独归因于其中一项。
- 输入：沿用“固定输入”中的 100 MiB JSON 与 1 GiB JSONL，字节数和 SHA-256 完全一致。
- 运行方式：每个 scenario 各 5 个全新 release 进程；JSONL 完成 index 后 idle 5 秒，再进行每轮 100 个 distinct head-tail selects，全部 `Valid`。所有结果的 `error[]` 为空，`identityCurrent` 为 `true`。
- runner：`c214a20`。
- p95 仍按 5 个样本 nearest-rank 计算，因此等于该组最大样本；单位均为 µs。

### JSONL

| 指标 | 5 次原始样本（µs） | median（µs） | p95（µs） |
| --- | --- | ---: | ---: |
| openToFirst20 | 658, 556, 487, 501, 632 | 556 | 658 |
| index | 833992, 789032, 1096148, 783740, 779325 | 789032 | 1096148 |
| perRunSeekMedian | 79.5, 27, 51, 53, 35 | 51 | 79.5 |
| perRunSeekP95 | 140, 32, 57, 60, 63 | 60 | 140 |

### Document（JSON）

| 指标 | 5 次原始样本（µs） | median（µs） | p95（µs） |
| --- | --- | ---: | ---: |
| Document root | 569347, 516463, 517314, 521839, 516680 | 517314 | 569347 |
| openToRaw | 571495, 518415, 519375, 523963, 518823 | 519375 | 571495 |
| readyToRaw | 2147, 1951, 2061, 2122, 2143 | 2122 | 2147 |

### 复测边界（仍非发布 PASS）

- 未测 Tauri/WebView 首屏、完整应用私有工作集、index/arena/cache 的精确 capacity。
- Linux 参考环境与 cold cache 尚未验证；macOS 的 cold preparation 不受 runner 支持，不能与 warm 结果聚合或据此推断 cold 性能。
- 无预物化 value 的独立 allocation 回归已通过，但它只证明 parse 阶段的分配行为，不是整应用内存证明。

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
- 9/9 与 9/14 记录都只反映固定输入分布下的 Core 行为；不能外推到其他数据分布，也不能替代 spec §18 的最终性能验收。
