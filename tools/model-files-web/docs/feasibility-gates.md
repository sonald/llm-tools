# T11 纯浏览器可行性门记录

日期：2026-08-10

结论：ModelScope `NO-GO`；本地目录 `GO`（Chromium、Firefox、WebKit）；Jinja `GO`。

## ModelScope：NO-GO

探针从 `http://127.0.0.1` 页面请求：

```text
https://modelscope.cn/api/v1/models/Qwen/Qwen3-0.6B/repo/files?Revision=master&Recursive=true
```

- Chromium 中 `fetch` 结果：`TypeError: Failed to fetch`。
- 移除本机代理环境变量后，直接 HTTPS 请求返回 `200`，但响应没有 `Access-Control-Allow-Origin`。
- 清单是解析 revision、构造固定版本内容 URL 和执行 Range 的前置条件；首个硬门失败，后续检查不成立。
- 按产品计划不增加代理、浏览器扩展、桌面桥接或整文件回退，因此来源结论为 `NO-GO`。

复核命令：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY curl -sS -D - -o /dev/null \
  'https://modelscope.cn/api/v1/models/Qwen/Qwen3-0.6B/repo/files?Revision=master&Recursive=true'
```

## 本地目录：GO

`scripts/verify-browser-feasibility.mjs` 使用原生
`<input type="file" webkitdirectory multiple>` 选择原生 Tokenizer fixtures 目录，并在页面中读取
`webkitRelativePath` 与 `File.slice(0, 8)`。

三种引擎结果一致：

| 引擎 | 文件数 | 相对路径 | `bpe/tokenizer.json` 大小 | 前 8 bytes |
| --- | ---: | --- | ---: | --- |
| Chromium | 9 | `Tokenizers/{bpe,byte-fallback,unigram,wordpiece}/…` | 995 | `123,10,32,32,34,118,101,114` |
| Firefox | 9 | 同上 | 995 | `123,10,32,32,34,118,101,114` |
| WebKit | 9 | 同上 | 995 | `123,10,32,32,34,118,101,114` |

这证明目标三引擎都能在用户选择后稳定保留相对路径，并用原生 `File.slice()` 精确读取内容。目录数量、路径长度、短读、重复规范化路径和再次选择的失败关闭逻辑留在 T12 的产品实现与 E2E 中验证。

复核命令：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY node scripts/verify-browser-feasibility.mjs
```

## Jinja：GO

选择 `@huggingface/jinja` 0.5.9：MIT、零运行时依赖，源码审计没有 `eval`、动态代码执行、`fetch`、`XMLHttpRequest` 或动态 `import`。外部 `include` 在解析阶段稳定拒绝。

兼容证据：

- 基础 messages、Tools、typed variable 和 `add_generation_prompt` 输出逐字匹配固定 gold。
- Qwen 模板使用的 `namespace`、反向遍历和 type tests 通过固定测试。
- 真实 `Qwen/Qwen3-0.6B` 的 `tokenizer_config.json.chat_template` 在默认 native fixture 上渲染为 165 UTF-8 bytes，与原生验收记录逐字一致：

```text
<|im_start|>system
You are a concise assistant.<|im_end|>
<|im_start|>user
解释一下：分词为什么会影响上下文长度？<|im_end|>
<|im_start|>assistant
```

固定测试：

```bash
node --test src/core/template.test.ts
```

结果：3 tests，3 pass，0 fail。

## 边界

- ModelScope 不进入产品 UI，也不增加对应类型、URL 参数或读取代码。
- 本地目录只保留当前会话的 `File` 对象，不持久化目录权限或路径。
- Jinja 只渲染已读取的字符串；不支持 include，不执行仓库代码，不发模板网络请求。
- 完整 GGUF 仍为 `NO-GO`，只保留固定 24-byte 基础摘要。
