# Tensor Outline Design QA

- Source visual truth: `/Users/siancao/.codex/generated_images/01a03ced-069c-7e30-9a7b-a3b92e3abe20/exec-91313e44-2752-4d06-aa7e-d524eeeed9a3.png`
- Implementation screenshot: `/tmp/model-files-tensor-outline-final-expanded.jpeg`
- Side-by-side comparison: `/tmp/model-files-tensor-outline-final-comparison.png`
- State: local 10.2 GB sparse SafeTensors fixture; Tensors selected; `model › layers › 0 › self_attn › q_proj › weight` expanded and selected; inspector visible.
- Viewport: native macOS window, app default 1440 × 1024; Computer Use capture normalized to 1024 × 768.
- Pixels and density normalization: source 1487 × 1058, resized proportionally to 1079 × 768; implementation 1024 × 768; both compared at 768 px height. The capture service downscaled the native window, so comparison uses normalized visual density rather than 1:1 device pixels.

## Full-view comparison

The implementation preserves the existing ModelFiles chrome while matching the selected concept's dominant structure: hierarchical disclosure rows, relative tensor names, aligned Shape/DType/parameter columns, selected-path breadcrumb, Collapse All, and an optional trailing inspector. No raster or custom visual assets are involved.

## Focused region comparison

The tensor outline and inspector were checked separately in the real app. Deeply indented `q_proj.weight` stays on one line; the selected full path and all existing detail fields remain readable. AX exposes every group as Expand/Collapse, leaf selection, `全部收起`, `隐藏详情`/`显示详情`, and the tensor safety notice.

## Comparison history

1. Initial implementation: P2 — no column labels, breadcrumb, or Collapse All. Fixed by adding aligned headers, the selected path, and a view-local outline reset.
2. First revised capture: P2 — deep leaf Shape and parameter values wrapped. Fixed with flexible name width, compact monospaced secondary values, fixed aligned columns, and single-line limits.
3. Final capture: no actionable P0/P1/P2 findings. Collapse All, search pruning, leaf selection, and inspector hide/restore were also exercised in the real app.

## Required fidelity surfaces

- Fonts and typography: PASS — native system UI with monospaced tensor paths and compact single-line numeric columns.
- Spacing and layout rhythm: PASS — hierarchy remains the primary surface; inspector is secondary and removable.
- Colors and visual tokens: PASS — semantic native SwiftUI materials, selection, separators, and secondary text.
- Image quality and asset fidelity: PASS — no custom image assets are required for this screen.
- Copy and content: PASS — Chinese and English labels exist for the new controls; tensor safety wording is preserved.

## Follow-up polish

- P3: group counts remain inline beside each module instead of occupying a dedicated aggregate column. This keeps the change smaller and the hierarchy easier to scan at narrow widths.

final result: passed
