# Design QA：统一位置输入框

- 日期：2026-07-22
- Source visual truth：`/Users/siancao/.codex/generated_images/019f84f5-a4f5-7f90-b91a-7ed5b830479d/exec-63dd1131-2b60-4fb5-90e1-12c07cf77d89.png`
- Implementation screenshot（聚焦提示）：`/tmp/model-files-auto-source-focus.png`
- Implementation screenshot（本地目录已打开）：`/tmp/model-files-auto-source-loaded.png`
- Full-view comparison：`/tmp/model-files-auto-source-comparison.png`
- Focused toolbar comparison：`/tmp/model-files-auto-source-toolbar-comparison.png`
- Source pixels：1457 × 1079
- Implementation pixels：1040 × 768
- Comparison viewport：1040 × 768 points，light mode
- Density normalization：source 等比缩放并居中裁切到 1040 × 768；implementation 为同尺寸原生窗口截图
- State：统一输入框为空且获得编辑焦点，三种格式提示可见；另验证绝对本地路径打开后的完成状态

## Findings

没有剩余的 P0、P1 或 P2 问题。

- Fonts and typography：实现与目标都使用原生 macOS 系统字体；输入提示、三行格式说明和次要示例的层级一致，窄窗口下保持单行截断。
- Spacing and layout rhythm：来源 Picker 已移除；输入框、固定目录按钮和“打开”按钮保持单行。1040-point 默认窗口会把输入框压缩到约 340 points，仍完整保留三个操作入口。
- Colors and visual tokens：实现使用系统背景、分隔线、蓝色焦点环、secondary label 与 SF Symbols，和现有 ModelFiles 视觉语言一致。
- Image quality and asset fidelity：该交互没有位图、插画或品牌图；图标全部使用原生 SF Symbols，没有替代资产或绘制近似图标。
- Copy and content：placeholder 为“模型 ID、仓库 URL、本地路径或 ssh:// 地址…”，聚焦提示覆盖模型仓库、本地目录和 SSH 目录三种格式。
- Accessibility and affordance：组合框、历史下拉、目录按钮和打开按钮都有原生 Accessibility role、label 或 help；提示内容也出现在 Accessibility tree 中。

## Intentional Differences

- 目标图把目录图标视觉上放在输入框尾部；实现按确认需求保留为独立的原生目录按钮，避免与 `NSComboBox` 自带历史下拉按钮冲突。
- 目标图使用更宽的概念窗口；实际默认窗口是 1040 × 768，工具栏按可用宽度自然压缩。
- Full-view 中打开的文件不同，因为本次 QA 只以顶部位置输入交互为设计范围；focused comparison 使用同尺寸工具栏区域判断。

## Primary Interactions Tested

- 输入绝对本地路径并按 Return：自动识别为本地目录，成功加载文件清单和 `config.json`，状态显示“本地 · 实时目录”。
- 点击固定目录按钮：弹出原生目录选择器，按钮文案为“选择模型目录”，取消后原状态不变。
- 清空并编辑输入框：显示三行格式提示。
- 按 Return 提交：提示关闭，进入加载状态，完成后不再覆盖内容。
- SSH 与 Hub 路由：由 `testInfersRepositorySourceFromInput` 覆盖，未对真实 SSH 主机发起测试连接。

## Comparison History

1. 初次真实交互发现 P2：格式提示在按 Return 打开目录后仍保持可见，覆盖内容顶部。
2. 修复：在 `ModelHistoryField.Coordinator` 处理 Return 时先关闭 `NSPopover`，再执行打开操作。
3. Post-fix evidence：Accessibility tree 在 Return 后不再包含“弹出窗口”；`/tmp/model-files-auto-source-loaded.png` 显示本地目录已完成加载且提示关闭。

## Implementation Checklist

- [x] 移除来源 Picker 与持久化来源状态。
- [x] `/` 或 `file://` 自动识别为本地目录。
- [x] `ssh://` 自动识别为 SSH 目录。
- [x] 其他输入沿用 ModelScope / Hugging Face 自动竞速。
- [x] 保留历史补全、目录按钮和 Return-to-open。
- [x] 兼容旧字符串历史和含 `selection` 的 v2 历史。
- [x] 通过 Swift 测试、App bundle verify 与真实原生交互检查。

final result: passed
