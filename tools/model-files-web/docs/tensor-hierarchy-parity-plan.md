# ModelFiles Web Tensor 层级浏览增量移植计划

状态：已完成
日期：2026-08-30
上次 Web 收口：`b889ae5 docs(model-files-web): record native parity acceptance`
新增原生上界：`ef90a92 feat(model-files): organize tensors by hierarchy`

## 1. 结论

`b889ae5..HEAD` 中只有一个新增原生功能：SafeTensors 的 Tensor 视图从平面表格改为层级 outline。Web 当前已经从 Header 获得完整 tensor 名称、dtype、shape、参数量、字节数和 offsets，因此该功能可在纯浏览器边界内移植，不需要新 Range、Worker、依赖或权重读取。

执行采用 `gpt-5.6-luna`（max）完成；主代理负责 RED 测试设计、编排、diff 审查、真实浏览器验收和提交边界。

## 2. 增量行为矩阵

| `ef90a92` 用户行为 | Web 当前状态 | 决定 |
| --- | --- | --- |
| 按 `.` 分段形成 module/layer/tensor 层级 | 已实现 | PASS |
| 数字段自然排序（`2` 在 `10` 前） | Header parser 与 hierarchy 均自然排序 | PASS |
| group 显示后代 Tensor 数；leaf 显示相对名 | 已实现 | PASS |
| 名称/dtype 搜索后只保留匹配叶及祖先 | 已实现并自动展开命中路径 | PASS |
| 全部收起 | 已实现 | PASS |
| 选中 Tensor 的完整 breadcrumb | 已实现 `›` 路径并保留完整名称 | PASS |
| 右侧详情隐藏/恢复且不丢选择 | 宽屏侧栏、窄屏下置，可隐藏 | PASS |
| 中英文本与可访问名称 | 已接入现有 `i18n.ts` | PASS |
| Header-only、0 bytes Tensor data | 已 PASS | 必须保持，不扩大读取边界 |

## 3. Web 架构决定

### 3.1 纯层级模型

新增 `src/core/tensorHierarchy.ts`，直接消费既有 `TensorSummary[]`。只增加一个有当前职责的节点类型：

- `path`：完整点分路径；
- `label`：当前相对分段；
- `tensor`：当前路径本身也是 Tensor 时保留该 leaf；
- `descendantCount`：当前过滤集合中的 Tensor 数；
- `children`：自然排序后的子节点。

节点允许同时拥有 `tensor` 和 `children`，避免 `foo` 与 `foo.weight` 的前缀冲突。group ID 使用 `group:${path}`，leaf ID 使用 `tensor:${name}`；点分时忽略空 segment，全部为空时回退到原始非空名称。

模块只负责：过滤名称/dtype、构树、自然排序、按展开集合展平。无全局 store、provider、registry 或第三方树依赖。

### 3.2 保留渐进 DOM

Header 中的全部 Tensor 继续只存在于内存 summary。构树和 group count 使用完整匹配集合；React 只渲染当前展开后的前 100 行，“再显示 100 行”沿用现有渐进交互。不得一次创建全部树节点 DOM，也不引入虚拟列表依赖。

搜索使用 trim 后的不区分大小写 name/dtype 匹配。非空查询默认展开匹配路径，使现有“输入查询即可看到结果”的行为不回退；“全部收起”关闭本次自动展开，下一次修改查询再恢复自动展开。清空查询恢复用户手动展开集合。

### 3.3 表格式 outline

保留语义 `<table>` 与现有 Shape/DType/参数/Bytes 列，不伪造不完整的 ARIA `treegrid`：

- group 行在第一列使用原生 `button[aria-expanded]`、缩进和后代计数；
- leaf 行使用相对名，按钮的可访问名称包含完整 Tensor 名；
- 选中行和详情继续由完整 Tensor 名关联；
- “全部收起”、详情隐藏/显示都使用原生 button 和现有焦点样式。

宽屏用 CSS grid 放置 outline 与详情；窄屏把详情放到 outline 下方。隐藏详情不清除选择，搜索或折叠也不清除已选 Tensor。

### 3.4 安全边界不变

- SafeTensors 远端仍只请求 `bytes=0-7` 与精确 Header Range；本地仍只做两次 `File.slice()`。
- Tensor 数据读取保持 `0 bytes`；展开、搜索、选择、隐藏详情产生 `0` 个网络请求。
- 继续保留 25,000,000-byte Header 上限和现有 parser 校验。
- 不扩展 GGUF、其他权重格式或推理能力。

## 4. 实施任务

### T35 — 层级模型与边界测试（S，2 文件，已完成）

**文件：**

- `src/core/tensorHierarchy.ts`
- `src/core/tensorHierarchy.test.ts`

**验收：**

- common prefix、数字 group、自然排序、相对 leaf、后代计数正确；
- name/dtype 搜索 trim whitespace，空查询返回完整集合；
- prefix collision、空 segment 和 10,000 Tensor 构树均不丢 leaf；10,000 项构树记录耗时并保持 `<1 s`。

**验证：**

```bash
cd tools/model-files-web
node --test src/core/tensorHierarchy.test.ts
npm run check
```

结果：8 个 hierarchy unit 全部通过；10,000 Tensor 构树 29.490042 ms（<1 s），无 leaf 丢失。

**依赖：** 无；提交 `4c52e76`。

### T36 — SafeTensors outline 纵向切片（M，5 文件，已完成）

**文件：**

- `src/App.tsx`
- `src/styles.css`
- `src/i18n.ts`
- `e2e/fixtures.ts`
- `e2e/model-files.spec.ts`

**顺序：** 先把现有 SafeTensors E2E 改为层级 fixture 并得到 RED，再接入 T35 模型和最小 UI。

**验收：**

- 默认显示 root group、准确后代计数和不超过 100 个可见行；展开后按自然顺序显示相对 leaf；
- 搜索 `layer.104` 或 dtype 会自动展开匹配路径，选中后 breadcrumb、详情字段和选中状态正确；
- 全部收起、再显示 100 行、详情隐藏/恢复均不丢选择；zh-Hans/en key 和 placeholder 完整。

**验证：**

```bash
cd tools/model-files-web
npx playwright test e2e/model-files.spec.ts --project=chromium --workers=1 -g 'SafeTensors hierarchy'
npm run check
git diff --check
```

**依赖：** T35；提交 `1c2ad4b`。

结果：focused Chromium hierarchy 初始验收 1/1；group/leaf、搜索自动展开、选择、Collapse All、详情隐藏/恢复与 100 行渐进均通过。

### T37 — 三浏览器、live 与响应式证据（S，2 文件，已完成）

**文件：**

- `e2e/model-files.spec.ts`
- `e2e/live.spec.ts`

**验收：**

- Chromium、Firefox、WebKit 均完成 group 展开、搜索剪枝、leaf 选择、全部收起和详情恢复；
- Qwen 固定 revision 的真实 SafeTensors 至少展开一个真实 module 并选择一个 Tensor；
- 390×844、768×1024、1280×800 无横向溢出，页面 console 0 error/0 warning；请求账本仍只有两段 Header Range、0 bytes Tensor data。

**验证：**

```bash
cd tools/model-files-web
npx playwright test e2e/model-files.spec.ts -g 'SafeTensors hierarchy'
npm run test:e2e
npm run test:e2e:live
```

**依赖：** T36；提交 `5e08c4a`。

结果：离线 `npm run test:e2e` 138 total / 109 passed / 29 skipped / 0 failed（43.2 s）；通用 hierarchy 流程在 Chromium、Firefox、WebKit 均通过。最终 responsive focused Chromium 2/2（2.5 s，390×844/768×1024/1280×800），无页面横向溢出、leaf/count 可读、详情在窄屏下置、宽屏右置，console error/warning 0/0；Qwen live 3/3（18.8 s），hierarchy `tensorHierarchyMs=100`。

### T38 — 规格与验收收口（M，6 文件，已完成）

**文件：**

- `SPEC.md`
- `GOAL.md`
- `README.md`
- `docs/productization-plan.md`
- `docs/native-parity-acceptance.md`
- `docs/tensor-hierarchy-parity-plan.md`

**验收：**

- 新增原生基线 `ef90a92` 与 Tensor hierarchy 行，最终只从 fresh evidence 标为 PASS；
- 记录命令、三浏览器结果、Qwen revision、Range ledger、响应式截图和原子提交；
- `tools/model-files/.DS_Store` 保持 untracked；无 push/tag/release/deploy。

**依赖：** T37；文档由本文件所在提交收口。

结果：六份文档（含本计划）均已按 fresh evidence 同步，由本文件所在提交收口；本计划状态收口为已完成。

## 5. Checkpoints

### Checkpoint A — T35

- [x] 层级模型没有 UI/React 依赖；所有 native gold 和 Web 边界测试通过。
- [x] 评审节点前缀冲突、排序和 10,000 项成本，再进入 UI。

### Checkpoint B — T36

- [x] focused Chromium E2E 通过；表格语义、键盘焦点和渐进 DOM 无回退。
- [x] SafeTensors Range ledger 与改动前完全一致。

### Checkpoint C — T37–T38

- [x] 完整 unit/build、三浏览器、live、响应式和 console/network 证据通过。
- [x] 文档矩阵和 Git 状态与实际提交一致。

## 6. Done when（已确认并完成）

- `SPEC.md` 新增 `ef90a92` 对应行并以当前证据结束为 PASS；既有 18 PASS + 1 N/A 不回退。
- 层级模型 unit 覆盖自然排序、计数、搜索、前缀冲突和 10,000 项性能；`npm run check` exit 0。
- offline Playwright 在 Chromium、Firefox、WebKit 对层级展开、搜索、选择、全部收起和详情恢复均 exit 0；responsive 测试的 Firefox/WebKit skip 有明确平台理由。
- `npm run test:e2e:live` exit 0，并记录真实 Qwen manifest SHA；SafeTensors 仍只读 `bytes=0-7` 与精确 Header Range，Tensor 数据和交互新增请求均为 0。
- production Chromium 在 390×844、768×1024、1280×800 通过布局、键盘、可访问名称、深色与 console 0/0 检查。
- 不新增 runtime dependency；不实现 GGUF hierarchy、权重数据预览、展开状态持久化或通用树组件。
- README、计划和 acceptance 与执行证据一致；`git diff --check`、secret scan、staged review 通过；只提交授权 Web 文件并保留 `.DS_Store`。

## 7. 风险与停止条件

| 风险 | 处理 |
| --- | --- |
| 层级展开导致 DOM 爆炸 | 完整树留在内存；展平后的 DOM 每次最多增加 100 行 |
| 搜索命中藏在折叠祖先下 | 非空查询自动展开匹配路径；Collapse All 可覆盖本次自动展开 |
| tensor 名既是 leaf 又是父路径 | 节点同时保留 tensor 与 children，group/leaf 使用不同 ID |
| 窄屏侧栏挤压内容 | CSS grid 在窄屏改为上下布局；保留详情隐藏按钮 |
| 为树交互引入重依赖 | 停止；复用现有 table、button、React state 和 CSS |
| Range 或 Tensor data 边界变化 | 产品 FAIL；不得以 hierarchy 为由读取任何新字节 |

## 8. 推荐默认（已确认）

1. 层级 outline 直接替换平面 Tensor 表，不增加双模式切换。
2. 搜索非空时自动展开匹配路径；Collapse All 可立即覆盖。
3. 宽屏详情右置，窄屏详情下置；详情隐藏/恢复不丢选择。
4. 不新增依赖、Worker、全局状态或持久化。

上述 `done_when` 和四项默认已完成；T35 → T38 已按顺序收口。
