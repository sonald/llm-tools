# Semantic JSON Viewer Core 性能基线

> 状态：保留 2026-09-09 pre-lazy Core baseline，并追加 lazy-string/explicit-stack、shrink、JSONL capacity 和 Native smoke 证据；所有记录均非发布验收 PASS，也不是最终性能报告。

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

## b87dde7 复测（shrink 后，100 MiB Document）

- 输入：沿用“固定输入”中的 100 MiB JSON，SHA-256 与 9/9 原始基线完全一致。
- 环境与运行：同一台 macOS Darwin arm64/aarch64、11 logical CPUs、36 GiB 内存；5 个全新 release、warm、Core-only 进程，未包含 Tauri/WebView，未测 RAM。
- 生产解析变更为 `b87dde7`；本次 runner 包含后续 JSONL 观测 `f32a255`，但 Document 分支未改。本次结果反映 `parse_json_owned` 节点 arena shrink 后的 retained capacity；其前置实现同时包含显式容器栈与 lazy string decode，不能将全部性能变化归因于 shrink 单项。
- 每轮 retained capacity 完全相同：source `104,857,600 B`、nodes `563,846,976 B`、children `71,318,912 B`、ObjectKey `35,240,471 B`、decoded checkpoints `0 B`，total `775,263,959 B`（约 `739.35 MiB`）。

| 指标 | 5 次原始样本（µs） | median（µs） | p95（µs） |
| --- | --- | ---: | ---: |
| Document root | 551467, 525305, 539532, 537068, 536368 | 537068 | 551467 |
| openToRaw | 553498, 527610, 541656, 539098, 538403 | 539098 | 553498 |
| readyToRaw | 2030, 2305, 2124, 2029, 2035 | 2035 | 2305 |

与收缩前 `fa3ddf6` 的单样本对照：nodes `939,524,096 B`、total `1,150,941,079 B`，其余分项相同；shrink 后差 `375,677,120 B`（约 `358.27 MiB`）。这只是 retained buffer capacity 差异，不是 peak 或应用私有内存减少证明。

## f32a255 JSONL retained-capacity 功能测量（单次）

- 这不是 5 轮新性能 benchmark，也不是性能 gate。
- 输入：1 GiB JSONL，`4,228,181` rows；index 完成后与 idle 5 秒后的 index capacity 均为 `100,663,296 B`（96 MiB），oversized locations 为 `0 B`。
- 本次 100 个 distinct selects 均为 `Valid`，`error[]` 为空，`identityCurrent` 为 `true`。active selected Tree 的最大 retained capacity 为 `2,344 B`：source `512 B`、nodes `1,568 B`、children `160 B`、ObjectKey `104 B`、decoded checkpoints `0 B`。
- 单次功能测量的耗时（仅记录，不作 5 轮 gate）：openToFirst20 `503 µs`、index `788042 µs`、seek median `94 µs`、seek p95 `123 µs`。

## JSONL active-tree capacity pressure smoke（单次合成输入）

- 临时 fixture：`/tmp/sjv-dense-entry-memory-20260914.jsonl`；首 Entry 为 `600,000` 个 `0` 的数组，raw `1,200,001 B`，另有后续 20 个 `{}`；21 entries 均为 `Valid`，首 Entry 未达到 16 MiB oversized 阈值。
- 首 active Tree retained capacity：source `2,097,152 B`、nodes `67,200,112 B`、children `8,388,608 B`、ObjectKey `0 B`、decoded checkpoints `0 B`，total `77,685,872 B`（约 `74.09 MiB`）；index `768 B`。
- 这是容量预算边界的单次压力证据，不替代固定 benchmark。64 MiB 是否包含 active selected Tree 尚待用户决策；在决策前不将其标为 cache gate PASS，也不据此误标 oversized。

## c06fbd0 Native bundle smoke（流程采样）

- Native bundle 构建版本为 `c06fbd0`，当时尚未包含 shrink；当前进程不是 fresh launch。
- 打开 100 MiB JSON 后，Raw 首片为 `131072 B`。`launchctl` app domain `23943` 显示 GPU `23944`、Networking `23945`、WebContent `23946`、Theme `23950`、OpenSave `23960` 均归属该应用。
- `footprint --noCategories -f bytes` 采样值：

| process/category | footprint（B） |
| --- | ---: |
| total | 926537248 |
| main | 741689024 |
| OpenSave | 85066616 |
| WebContent | 57099272 |
| GPU | 25805712 |
| Theme | 11043392 |
| Networking | 6783504 |

分类项相加为 `927487520 B`，与给定 total `926537248 B` 相差 `950272 B`；两者口径未进一步核定，本页保留原始值，不将分类项相加后冒充 total。主进程 `phys_footprint_peak` 为 `1210894328 B`。

这只是 Native 采样流程 smoke，不是 5 轮 full-app PASS；不把 retained capacity 与 footprint 混为一谈，不与 Linux 直接等价，也不声称 cold cache 或文件 mapping 已测。

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

- 未测 Tauri/WebView 端到端首屏、5 轮 full-app、RAM、LRU/inputmapping、RSS/live/peak 和完整应用私有工作集；本页的 retained capacity 仅是分项 buffer 观测。
- Linux x86_64（至少 8 logical cores、16 GiB、NVMe）尚待验证。
- 9/9、9/14 及后续功能/压力记录都只反映固定或合成输入分布下的 Core 行为；不能外推到其他数据分布，也不能替代 spec §18 的最终性能验收。
