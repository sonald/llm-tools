# 第三方依赖与许可

审计日期：2026-08-10。版本与完整依赖图以 `package-lock.json` 为准；`npm ci` 是唯一发布安装方式。

## 直接依赖

| 依赖 | 版本 | 用途 | 许可 |
| --- | --- | --- | --- |
| `@huggingface/jinja` | 0.5.9 | 浏览器 Jinja 运行时 | MIT |
| `@huggingface/tokenizers` | 0.1.3 | 浏览器 tokenizer 运行时 | Apache-2.0 |
| `react` | 19.2.8 | UI | MIT |
| `react-dom` | 19.2.8 | DOM 渲染 | MIT |
| `react-markdown` | 10.1.0 | 安全 Markdown 渲染 | MIT |
| `remark-gfm` | 4.0.1 | GFM 表格、删除线、任务列表 | MIT |
| `@playwright/test` | 1.62.1 | 浏览器验收（开发） | Apache-2.0 |
| `@types/node` | 26.2.0 | 类型（开发） | MIT |
| `@types/react` | 19.2.18 | 类型（开发） | MIT |
| `@types/react-dom` | 19.2.4 | 类型（开发） | MIT |
| `@vitejs/plugin-react` | 6.0.5 | 构建（开发） | MIT |
| `typescript` | 7.0.2 | 类型检查（开发） | Apache-2.0 |
| `vite` | 8.2.1 | 构建与开发服务（开发） | MIT |

## Lockfile 传递依赖

`package-lock.json` 当前锁定 175 个第三方包/平台变体，全部声明 SPDX 许可，没有 `UNDECLARED` 条目：

- MIT：134。
- Apache-2.0：26。
- MPL-2.0：12。
- ISC：2。
- BSD-3-Clause：1。

复核命令：

```bash
node -e 'const j=require("./package-lock.json"); for(const [p,x] of Object.entries(j.packages)) if(p&&x.version) console.log(p.slice(13),x.version,x.license)'
```

应用运行时产物包含 React、React DOM、Markdown/GFM、Jinja、`@huggingface/tokenizers` 及构建器生成代码；Playwright、TypeScript、Vite 与平台绑定不随静态产物发布。当前生产构建：main 406,798 bytes（gzip 123.92 kB），tokenizer/Jinja worker 79,062 bytes；相较 v0.1 的 main 214.67 KiB、worker 29.53 KiB，增量对应 Markdown 与 Jinja 的已验收能力。T20 的 100k 行入口和 10k token Chromium 门分别低于 3 秒和 1.3 秒，无额外虚拟化依赖。

各包的完整许可文本随 npm 包提供，仓库来源与完整性哈希记录在 lockfile。
