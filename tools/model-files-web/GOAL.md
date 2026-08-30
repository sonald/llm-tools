<goal>
Bring tools/model-files-web to verified user-visible parity with every applicable feature added to tools/model-files after Web baseline 11e1086 through native baseline ef90a92, including the accepted baseline through b889ae5 plus SafeTensors Tensor hierarchy browsing. Functional code is written by OpenRouter stealth/ox-alpha; the primary agent owns orchestration, review, atomic commits, independent tests, and final PASS/FAIL/BLOCKED audit.
</goal>

<context>
Read first:
- tools/model-files-web/SPEC.md
- tools/model-files-web/docs/tensor-hierarchy-parity-plan.md
- tools/model-files-web/package.json
- tools/model-files-web/src/App.tsx
- tools/model-files-web/src/Readers.tsx
- tools/model-files-web/src/TemplateWorkbench.tsx
- tools/model-files-web/src/core/huggingface.ts
- tools/model-files-web/src/core/tokenizer.ts
- tools/model-files-web/src/tokenizer.worker.ts
- tools/model-files-web/src/tokenizerClient.ts
- tools/model-files-web/e2e/fixtures.ts
- tools/model-files-web/e2e/model-files.spec.ts
- tools/model-files-web/e2e/live.spec.ts
- tools/model-files/Sources/ModelFiles/Support/TensorHierarchy.swift
- tools/model-files/Tests/ModelFilesTests/TensorHierarchyTests.swift
- tools/model-files/docs/diagnostic-inspector-spec.md
- tools/model-files/docs/diagnostic-inspector-acceptance.md
- tools/model-files/docs/source-reader-i18n-requirements.md
- tools/model-files/docs/source-reader-i18n-implementation-plan.md

Treat `b889ae5` as the accepted Web baseline and use `git log --reverse b889ae5..ef90a92 -- tools/model-files` to audit the current native delta. Treat the current worktree as authoritative and preserve the existing untracked tools/model-files/.DS_Store.
</context>

<constraints>
- Follow repository AGENTS.md: add no entity or abstraction without a concrete current job; apply YAGNI to every new type and dependency.
- Keep the product pure-browser and read-only. No backend, SSH, ModelScope, private credentials, desktop bridge, inference, conversion, upload, remote code, or model-weight reads.
- Preserve the established 32 MiB readable/bundle cap, 64 KiB input cap, 1,000-result cap, exact SafeTensors ranges, and 24-byte GGUF product path.
- Tensor hierarchy consumes only the existing SafeTensors Header summary. Preserve the semantic table, 100-row progressive DOM budget, two exact Header reads, and 0 bytes Tensor data; add no tree/virtualization dependency, Worker, global state, or persistence.
- Standalone SentencePiece .model remains required. Audit a browser WASM dependency first against SPEC.md section 4.1, including artifact checksum/provenance, no runtime fetch, CSP impact, BPE/Unigram gold, tokenOffset=0 semantics, optional config/template bundle limits, Worker termination cancellation, cold-start cost, and bundle size. If no candidate passes, stop that slice and report BLOCKED; do not implement SentencePiece or protobuf from scratch and do not silently substitute tokenizer.json.
- tokenizer_class override is N/A in @huggingface/tokenizers because that runtime does not dispatch by class. Keep the consistency warning but do not add a fake recovery UI.
- Reuse the existing inspection dispatch, repository loaders, Worker, Tokenization model, visual language, and E2E fixture. Add only the minimum interface required for two isolated tokenizer sessions.
- Treat Hub responses, local files, JSON, token IDs, templates, PDF, WASM output, DOM, console, and network responses as untrusted data. Validate once at boundaries; render through React escaping; never use eval or unsafe HTML.
- Full vocabulary data may live only inside an on-demand Worker/session index. Consistency and overview paths use summaries only.
- A comparison target must never mutate the main snapshot, selected path, history, error, cache, consistency report, or result. At most two runtime sessions exist; each owns its Worker/request map; closing/switching cancels and releases the right session and indexes.
- Preserve strict CSP. PDF may add only `frame-src blob:` while retaining `object-src 'none'`; a SentencePiece candidate that needs broader script/network/style relaxation fails its gate unless the user separately approves it.
- Keep source folding to Python/PythonW, YAML/YML, and JSON at or below 128 KiB. Find searches complete loaded text and must reach past line 1,001.
- Localization supports only zh-Hans and en, follows browser preference, and adds no i18n framework or in-app language selector.
- Do not change native tools/model-files code. Do not touch unrelated files. Do not push, tag, release, deploy, or modify global Codex/router configuration.
</constraints>

<done_when>
- Every row in tools/model-files-web/SPEC.md section 3 has current evidence and ends as PASS, user-approved N/A, or a real dependency BLOCKED. No feature is declared complete from intent, old evidence, or structural tests alone.
- Standalone SentencePiece .model performs real BPE/Unigram encode IDs, pieces, decode, Token IDs round trip, same-directory config/template behavior, Worker cancellation, and size-limit enforcement in browsers; or the approved dependency gate produces a documented blocker and implementation pauses.
- Source/PDF/binary, folding/find, Token ID/Special/Role/template/vocabulary, consistency, comparison, and zh-Hans/en behaviors satisfy SPEC.md sections 4 and 6.
- SafeTensors hierarchy proves dot-path groups, natural numeric order, accurate descendant counts, relative leaf labels, trimmed name/dtype search with visible matches, Collapse All, full breadcrumb, selection persistence, and hide/restore details.
- cd tools/model-files-web && npm run check exits 0.
- cd tools/model-files-web && npm run test:e2e exits 0 across Chromium, Firefox, and WebKit; every skip has an explicit platform reason and alternate executed evidence.
- cd tools/model-files-web && npm run test:e2e:live exits 0; each run records the manifest SHA and proves every subsequent content URL is pinned to it for real tokenizer diagnostics and cross-repository comparison.
- npm audit --omit=dev reports no critical or high vulnerability; every added runtime dependency has exact version, compatible license, provenance, maintenance note, and measured production bundle impact in docs/third-party-dependencies.md.
- Real production-preview Chromium completes all flows in SPEC.md section 6.3, including Tensor hierarchy. Console has zero errors/warnings; accessibility and responsive checks pass at 390x844, 768x1024, and 1280x800; the network ledger contains no model-weight content request and preserves existing SafeTensors/GGUF boundaries.
- README, productization plan, dependency inventory, and a new parity acceptance record match executed evidence.
- git diff --check, scoped secret scan, staged-diff review, and repository status prove only intended Web/CI documentation changes were committed. The existing tools/model-files/.DS_Store remains untouched. No push/tag/release/deployment occurs.
</done_when>

<workflow>
1. Confirm baseline status and run existing npm run check plus offline E2E. Record counts and environment failures separately from product failures.
2. Execute the SentencePiece dependency gate first. Use official project sources and the candidate's repository/package artifacts. Produce a minimal failing fixture test, then the smallest Worker vertical slice. Pause if the gate fails.
3. Implement source/PDF/strict-text dispatch, then folding and find as separate RED-to-GREEN slices with focused unit and Playwright coverage.
4. Extend the existing Tokenization/Worker contract first for Token IDs, flags, and shared selection; then separately add Chat tools/variables, overhead/roles, template catalog, and on-demand vocabulary search. Keep main results authoritative and latest-only.
5. Add the pure repository consistency analyzer and classifier first; then separately add cached material acquisition plus badge/report UI without GGUF or weight background reads.
6. Refactor the global tokenizer client only as far as required to own two isolated sessions. Land session isolation first, comparison UI/vocabulary diff second, and cross-repository sources third.
7. Localize all UI/error/accessibility strings through one minimal zh-Hans/en message catalog after feature strings stabilize.
8. Implement Tensor hierarchy as four accepted slices: pure model/unit tests; SafeTensors outline UI; three-browser/live/responsive evidence; documentation closeout. Keep all prior accepted behavior unchanged.
9. After each independently verifiable slice: review tests first, review implementation for correctness/readability/architecture/security/performance, run focused tests, npm run check, relevant E2E, git diff --check, secret/staged review, then make one atomic commit.
10. Run complete offline, live, production-preview, responsive, keyboard, accessibility, console, and network acceptance. Update docs only from fresh evidence.
11. Audit every SPEC matrix row against current files and runtime evidence before marking the goal complete.
</workflow>

<verification_loop>
Focused first:
- cd tools/model-files-web && node --test src/core/<changed>.test.ts
- cd tools/model-files-web && npx playwright test e2e/model-files.spec.ts --project=chromium -g '<changed flow>'
- cd tools/model-files-web && node --test src/core/tensorHierarchy.test.ts
- cd tools/model-files-web && npx playwright test e2e/model-files.spec.ts --project=chromium -g 'SafeTensors hierarchy'

Broad gates after each slice:
- cd tools/model-files-web && npm run check
- cd tools/model-files-web && npm run test:e2e
- git diff --check -- tools/model-files-web .github/workflows/model-files-web.yml

Dependency/security gate:
- cd tools/model-files-web && npm audit --omit=dev
- inspect exact package license, repository provenance, install scripts, transitive dependencies, built assets, and Vite bundle sizes

Final live/runtime gates:
- cd tools/model-files-web && npm run test:e2e:live
- run the production preview in a real Chromium session; capture DOM/accessibility, screenshots, console, and network evidence for SPEC.md section 6.3
- verify a real Qwen SafeTensors hierarchy from its pinned manifest SHA without any Range or Tensor-data expansion

If localhost binding or browser launch fails only because of the managed sandbox, rerun the same command with approved elevation and label the first result BLOCKED(environment), not product FAIL. If a real product assertion fails, reproduce it, add or keep the failing regression test, fix the root cause, then rerun focused and broad gates.
</verification_loop>

<execution_rules>
- Check git status before edits.
- Preserve unrelated user changes.
- Prefer rg over grep when available.
- Use the runtime's patch/edit tool for manual edits when available.
- Read context files before implementation.
- Batch independent file reads in parallel when the runtime supports it.
- Run focused tests before broad tests.
- Do not paper over failures.
- Do not widen scope.
- Keep the final answer concise.
- Functional implementation is delegated to OpenRouter stealth/ox-alpha. The primary agent writes orchestration/specification artifacts, reviews every produced diff, independently verifies behavior, and owns commits.
- Use RED to GREEN for every behavior change. A test that never failed is not sufficient evidence for a new path.
- Keep each commit independently buildable, tested, reviewable, and scoped. Stage explicit paths only; never stage tools/model-files/.DS_Store.
- Use the first Ponytail rung that satisfies the verified requirement: existing code, platform API, installed dependency, then minimum new code. Do not preserve speculative extension points.
</execution_rules>

<output_contract>
Final repository artifacts:
- tools/model-files-web/SPEC.md
- tools/model-files-web/GOAL.md
- tools/model-files-web/docs/tensor-hierarchy-parity-plan.md
- implemented source/tests/fixtures under tools/model-files-web
- synchronized tools/model-files-web/README.md
- synchronized tools/model-files-web/docs/productization-plan.md
- synchronized tools/model-files-web/docs/third-party-dependencies.md
- a new tools/model-files-web/docs/native-parity-acceptance.md with exact commands, counts, revisions, request ledger, browser evidence, PASS/FAIL/BLOCKED matrix, and commit list

Final response reports the overall status first, then atomic commits, executed verification with exit status/counts, any explicit skips or residual boundaries, and confirms no push/tag/release. Mark the persisted goal complete only after every done_when item has authoritative current evidence.
</output_contract>
