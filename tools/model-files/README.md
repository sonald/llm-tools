# ModelFiles (Native macOS)

ModelFiles is a native macOS inspector for Hugging Face / ModelScope model artifacts. Its centerpiece is a visual tokenizer playground: inspect vocabulary structure, render real chat templates, and see exactly how text becomes tokens.

## Highlights

- Inspect local directories and remote repositories (Hugging Face / ModelScope)
- Open `.gguf` and SafeTensors files for lightweight metadata inspection
- **Visualize tokenizer vocabulary at a glance.** Inspect tokenizer type, vocabulary and merge counts, added tokens, length percentiles, a length-distribution chart, and the longest token pieces with their Unicode-scalar and UTF-8-byte lengths.
- **Make tokenization visible.** Color-coded token segments show boundaries in the rendered input; optionally reveal whitespace and switch to a token table with IDs, raw pieces, and decoded output. inspired by https://tiktokenizer.vercel.app/.
- **Understand chat-template overhead.** Edit `system` / `user` / `assistant` messages, render the active Jinja chat template, inspect the exact string sent to the tokenizer, and compare token count, Unicode characters, and bytes per token.
- **Keep exactness explicit.** Inspect raw tokens, decoded tokens, and the distinction between exact mappings and decoded-only mappings, including byte-fallback cases.
- Load and inspect tokenizer bundles (`tokenizer.json`, `tokenizer_config.json`, `chat_template.jinja`)
- Render and validate Jinja chat templates
- Show imatrix metadata when available
- Keep data flow lightweight: no model weights are read
- Built on macOS SwiftUI / Swift package architecture for AppKit + SwiftUI hybrid window handling

## Screenshots

### Vocabulary structure and long-token analysis
![Tokenizer vocabulary analysis](docs/tokenizer-vocabulary-overview.png)

The overview turns a large `tokenizer.json` into actionable structure: BPE vocabulary/merge counts, percentile cards, a distribution chart, and the longest tokens with separate character and UTF-8-byte measures.

### Chat template and colored token visualization
![Chat template token visualization](docs/tokenizer-chat-visualization.png)

Enter source text or chat messages, inspect the authoritative encoded text, then follow its color-coded token segments through to the complete Token ID list.

### Compact window behavior (UI constraints validation)
![Compact window mode](docs/model-files-compact.png)

## Repository structure

```text
tools/model-files/
├── Sources/ModelFiles/        # SwiftUI app source
├── Tests/ModelFilesTests/     # Unit tests and fixtures
├── docs/                     # Design notes and acceptance docs
├── script/                   # Build/run helper scripts
├── Prototypes/               # Early HTML prototypes
├── dist/                     # Local build artifact output
└── Package.swift             # SwiftPM package manifest
```

## Requirements

- macOS 15.0+
- Swift 6.0+ toolchain
- Command-line tools: `git`, `swift`

## Build and run

```bash
# from repo root or from tools/model-files
cd tools/model-files

# build and run app
./script/build_and_run.sh run

# generate app bundle only and verify metadata
./script/build_and_run.sh verify
```

## Basic workflow

1. Launch the app.
2. Choose repository source:
   - local folder
   - Hugging Face / ModelScope repository
   - SSH source (if configured)
3. Confirm tokenizer bundle detection in the sidebar.
4. Open the tokenizer overview to inspect vocabulary structure, length distribution, and long-token details.
5. Switch to chat mode and tokenize sample messages with the active template.
6. Inspect the rendered prompt, colored segments, Token IDs, and exact versus decoded output.

## Test

From `tools/model-files`:

```bash
CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/module-cache" \
swift test --disable-sandbox
```

## Acceptance evidence

The implementation and behavior were validated via real app launches and acceptance checks under `tools/model-files/docs/tokenizer-playground-acceptance.md`.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE).
