# 第三方依赖与许可

审计日期：2026-08-22。版本与完整依赖图以 `package-lock.json` 为准；`npm ci` 是唯一发布安装方式。

## 直接依赖

| 依赖 | 版本 | 用途 | 许可 |
| --- | --- | --- | --- |
| `@huggingface/jinja` | 0.5.9 | 浏览器 Jinja 运行时 | MIT |
| `@huggingface/tokenizers` | 0.1.3 | 浏览器 tokenizer 运行时 | Apache-2.0 |
| `react` | 19.2.8 | UI | MIT |
| `react-dom` | 19.2.8 | DOM 渲染 | MIT |
| `react-markdown` | 10.1.0 | 安全 Markdown 渲染 | MIT |
| `remark-gfm` | 4.0.1 | GFM 表格、删除线、任务列表 | MIT |
| `prismjs` | 1.30.0 | 安全语法 tokenization/highlighting | MIT |
| `@playwright/test` | 1.62.1 | 浏览器验收（开发） | Apache-2.0 |
| `@types/prismjs` | 1.26.6 | 类型（开发） | MIT |
| `@types/node` | 26.2.0 | 类型（开发） | MIT |
| `@types/react` | 19.2.18 | 类型（开发） | MIT |
| `@types/react-dom` | 19.2.4 | 类型（开发） | MIT |
| `@vitejs/plugin-react` | 6.0.5 | 构建（开发） | MIT |
| `typescript` | 7.0.2 | 类型检查（开发） | Apache-2.0 |
| `vite` | 8.2.1 | 构建与开发服务（开发） | MIT |

## Lockfile 传递依赖

`package-lock.json` 当前锁定 177 个第三方包/平台变体，全部声明 SPDX 许可，没有 `UNDECLARED` 条目：

- MIT：136。
- Apache-2.0：26。
- MPL-2.0：12。
- ISC：2。
- BSD-3-Clause：1。

复核命令：

```bash
node -e 'const j=require("./package-lock.json"); for(const [p,x] of Object.entries(j.packages)) if(p&&x.version) console.log(p.slice(13),x.version,x.license)'
```

应用运行时产物包含 React、React DOM、Markdown/GFM、Prism、Jinja、`@huggingface/tokenizers` 及构建器生成代码；Playwright、TypeScript、Vite 与平台绑定不随静态产物发布。当前生产构建：main 409.93 kB（gzip 125.01 kB）、CSS 20.57 kB（gzip 4.94 kB）、source-highlight Worker 67.90 kB（本地 gzip 为 22.75 kB）、tokenizer/Jinja worker 79.06 kB；相较接入 Prism 前的 reader 基线（main 409.08 kB、gzip 124.69 kB，CSS 19.77 kB、gzip 4.72 kB），main bootstrap/renderer 增加 0.85 kB（gzip 0.32 kB），CSS 增加 0.80 kB（gzip 0.22 kB），并新增 Prism source-highlight Worker 67.90 kB（gzip 22.75 kB）。相较 v0.1 的 main 214.67 KiB、worker 29.53 KiB，增量对应 Markdown、Jinja 与已验收的阅读能力。T20 的 100k 行入口和 10k token Chromium 门分别低于 3 秒和 1.3 秒，无额外虚拟化依赖；32 KiB pathological SCSS 在主线程 RED 为 6,867 ms，而 Worker 三浏览器门控低于 1,000 ms，完整离线 E2E 通过 46 项、有意跳过 11 项。

2026-08-22 新增依赖审计：官方 `prismjs@1.30.0` tarball SHA-256 为 `ac16a9106a28c53b6a6313993c816a3a02525fdfefd7614fc1703df915a9fc11`，lockfile integrity 为 `sha512-DEvV2ZF2r2/63V+tK8hQvrR2ZGn10srHbXviTlcv7Kpzw8jWiNTqbVgjO3IY8RxrrOUF8VPMQQFysYYYv0YZxw==`；该包没有 install script 或运行时依赖，官方 npm audit 报告 0 个漏洞。source-highlight Worker 仅导入 prism-core 与显式语言组件，调用 `Prism.tokenize` 后发送扁平文本/class 分段，React 渲染节点而不使用 innerHTML；Worker 启动时禁用 Prism 自带消息处理器，文件切换或卸载时终止 Worker。最终 Worker bundle 含 Prism core 的通用 `innerHTML` 辅助函数，但 Worker 内不存在 DOM 且产品代码不调用它；该 bundle 不含 XMLHttpRequest、eval、new Function、fetch、WebSocket 或 importScripts。1.30.0 修复 GHSA-x7hr-w5r2-h6wg，其目标语言组件与 1.29.0 字节一致。

各包的完整许可文本随 npm 包提供，仓库来源与完整性哈希记录在 lockfile。
