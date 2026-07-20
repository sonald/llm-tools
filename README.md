# llm-tools

A collection of small tools for inspecting language models and handling data around them. Each tool is kept independent.

## Tools

| Tool | Purpose | Status |
| --- | --- | --- |
| [`ModelFiles`](tools/model-files/) | Browse model configuration, tokenizer, template, and SafeTensors structure files in a native macOS app | Usable app |
| [`analysis`](src/tools/analysis/) | Inspect Hugging Face LLM/VLM hidden states, attention patterns, logits, and prediction confidence | Prototype |
| [`qrcode2txt`](crates/qrcode2txt/) | Decode QR codes from image files, stdin, or the system clipboard | Usable CLI |

## ModelFiles

`ModelFiles` is a native SwiftUI macOS app for inspecting files published with a model without loading the model itself. Enter a model ID such as `Qwen/Qwen3-4B`, or paste its Hugging Face/ModelScope repository URL; the app can load from either source or automatically use the first available one.

It provides purpose-built views for:

- model and generation configuration;
- tokenizer configuration, vocabulary, and BPE merge rules;
- Jinja chat templates with syntax highlighting, typed test variables, and live rendering;
- model documentation and weight shard indexes;
- SafeTensors tensor names, dtypes, shapes, parameter counts, and metadata.

Files are loaded only when selected. Large text and tokenizer views parse in the background and render incrementally. SafeTensors preview uses HTTP Range requests to read only the JSON header; if a source does not confirm partial responses, the request is cancelled rather than downloading the weight data.

Requires macOS 15 or later and Swift 6.

### Run

```bash
./tools/model-files/script/build_and_run.sh run
```

The staged app is written to `tools/model-files/dist/ModelFiles.app`.

### Test

```bash
swift test --package-path tools/model-files
./tools/model-files/script/build_and_run.sh verify
```

## qrcode2txt

`qrcode2txt` is a Rust CLI that decodes one or more QR codes and writes JSON, YAML, or raw text.

### Run

```bash
# Decode one or more image files
cargo run --manifest-path crates/qrcode2txt/Cargo.toml -- image.png
cargo run --manifest-path crates/qrcode2txt/Cargo.toml -- first.png second.jpg

# Read an image from stdin or the system clipboard
cat image.png | cargo run --manifest-path crates/qrcode2txt/Cargo.toml -- --stdin
cargo run --manifest-path crates/qrcode2txt/Cargo.toml -- --clipboard

# Print raw decoded text
cargo run --manifest-path crates/qrcode2txt/Cargo.toml -- image.png --format raw
```

Run `cargo run --manifest-path crates/qrcode2txt/Cargo.toml -- --help` for all input, output, and error-handling options.

### Test

```bash
cargo test --manifest-path crates/qrcode2txt/Cargo.toml
```

## analysis

The Python analysis tool loads Hugging Face text, vision, and multimodal models, attaches PyTorch forward hooks to selected Transformer layers, and produces:

- hidden-state statistics by layer;
- attention entropy, sparsity, and heatmaps;
- top-token and confidence metrics;
- JSON, YAML, or Pickle results.

Its implementation is under [`src/tools/analysis/`](src/tools/analysis/), with configuration examples in [`configs/default.yaml`](configs/default.yaml). It is currently a prototype: the source layout has been reorganized, but `main.py`, tests, and examples have not yet been updated to the new import paths.

Python dependencies are declared in [`pyproject.toml`](pyproject.toml).

## Repository layout

```text
.
├── tools/
│   └── model-files/      # Native macOS model-file inspector
├── crates/
│   └── qrcode2txt/       # Rust QR-code decoder CLI
├── src/tools/
│   ├── analysis/         # LLM/VLM analysis prototype
│   └── llmi/             # Reserved prototype area
├── configs/              # Analysis configuration
├── examples/             # Analysis examples
└── main.py               # Analysis CLI prototype
```
