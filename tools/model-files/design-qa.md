# Design QA

- Source visual truth: `/Users/siancao/.codex/generated_images/019f7d68-dbd8-79b2-8025-256832a5dc72/exec-29d6681a-c839-459a-b531-77fd1b582576.png`
- Implementation screenshot: `/tmp/model-files-playground-tools.png`
- Full-view comparison: `/tmp/model-files-design-comparison.png`
- Focused comparison: `/tmp/model-files-design-comparison-focus.png`
- Viewport: 1403 × 1037 points, light mode; Retina capture 2806 × 2034 pixels
- State: `chat_template.jinja`, Tools enabled, `content_xml` selected, JSON inspector visible

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: native system UI typography and the existing 12.5 pt monospaced editor/output style remain consistent with ModelFiles. Special tokens use semibold system pink without replacing characters.
- Spacing and layout: the selected structure/raw split is preserved inside the existing Playground. It is denser than the standalone concept because the repository sidebar, input pane, and Jinja editor remain visible by design; all regions remain scrollable and usable.
- Colors and visual tokens: native semantic backgrounds, separators, selection blue, secondary labels, and system pink token emphasis match the selected direction and adapt to system appearance.
- Image quality and assets: no raster, logo, illustration, or custom image assets are part of this feature.
- Copy and content: “原始输出 · 权威”, “复制原始输出”, the soft-wrap note, and both read-only projection disclaimers make the exact-output boundary explicit.
- Interaction: verified the Tools toggle, automatic JSON inspector selection, structure-item selection, exact raw-range highlighting, and soft wrapping in the running macOS app.

## Intentional Differences

- The concept isolates the result inspector; the implementation keeps the existing repository sidebar, message/tool inputs, and editable Jinja pane so the feature remains part of the real workflow.
- The structure index scrolls when the JSON inspector is open instead of expanding the whole window.

## Comparison History

- Pre-build correction: the original formatted concept visually inserted line breaks. The selected target was revised so only the unchanged raw string is authoritative and wrapping/highlighting are presentation attributes.
- Implementation pass: no P0/P1/P2 issue was found in the full-view or focused comparison, so no post-capture visual fix loop was required.

## Implementation Checklist

- [x] Preserve the renderer output string unchanged.
- [x] Copy only the untouched raw output.
- [x] Build structure entries from exact `NSRange` references.
- [x] Highlight selected ranges without reconstructing text.
- [x] Label JSON as a parsed view outside the output.
- [x] Verify the integrated native window and primary interactions.

final result: passed
