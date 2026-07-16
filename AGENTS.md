# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

This is a LLM/VLM Analysis Tool that enables layer-wise analysis, attention visualization, and confidence calculation for Hugging Face Transformers models. The tool supports text-only, vision-only, and multi-modal models.

## Development Commands

### Setup and Installation
```bash
# Install dependencies
pip install -e .

# Run basic functionality tests
python test_basic.py
```

### Running the Tool
```bash
# Basic text analysis
python main.py --model gpt2 --input "Hello, world!" --layers 0,5,11

# With configuration file
python main.py --config configs/default.yaml --input "text" --output-dir results/

# Help and usage
python main.py --help
```

### Testing and Development
```bash
# Run programmatic examples
python examples/example_usage.py

# Test imports and basic functionality
python test_basic.py
```

## Architecture Overview

### Core Components

The application follows a modular architecture with four main components:

1. **ModelHandler** (`src/model_handler.py`): Manages model loading and hook registration
2. **AnalysisEngine** (`src/analysis.py`): Performs layer-wise analysis and confidence calculations
3. **OutputManager** (`src/output.py`): Handles result serialization and visualization
4. **CLI Interface** (`main.py`): Command-line interface and workflow orchestration

### Key Design Patterns

**Hook-Based Layer Extraction**: The `HookManager` class registers PyTorch forward hooks on transformer layers to capture intermediate outputs without modifying model forward passes. Layer identification is done through pattern matching of module names across different transformer architectures.

**Multi-Modal Model Support**: The `ModelHandler` automatically detects model types (text/vision/multimodal) and loads appropriate tokenizers/processors. It handles different model classes (`AutoModelForCausalLM`, `CLIPModel`, `BlipForConditionalGeneration`, etc.) transparently.

**Analyzer Composition**: The `AnalysisEngine` orchestrates three specialized analyzers:
- `LogitsAnalyzer`: Extracts and analyzes prediction distributions
- `AttentionAnalyzer`: Processes attention patterns and generates visualizations
- `ConfidenceCalculator`: Computes multiple confidence metrics (entropy, max probability, margin, etc.)

**Configuration-Driven Workflow**: Analysis behavior is controlled through hierarchical configuration (YAML files + CLI args). The configuration system supports model settings, analysis parameters, layer specifications, and output options.

### Data Flow

1. **Model Loading**: `ModelHandler` loads model and registers hooks on specified layers
2. **Input Processing**: Text/image inputs are tokenized/preprocessed based on model type
3. **Forward Pass**: Model inference captures layer outputs via registered hooks
4. **Analysis**: `AnalysisEngine` processes captured data through specialized analyzers
5. **Output**: `OutputManager` serializes results and generates visualizations

### Layer Specification System

Layers can be specified flexibly:
- Individual layers: `0,5,11`
- Ranges: `0-5`
- Negative indexing: `-1` (last layer), `-3,-1` (last 3 layers)
- The system automatically resolves negative indices based on model architecture

### Hook Management

The hook system handles multiple transformer architectures by identifying layers through pattern matching:
- GPT-style: `transformer.h.{N}`
- BERT-style: `encoder.layer.{N}`
- T5-style: `decoder.layers.{N}`
- ViT-style: `blocks.{N}`

Hooks capture both hidden states and attention weights, with automatic cleanup to prevent memory leaks.

### Configuration Hierarchy

Configuration merges multiple sources in precedence order:
1. CLI arguments (highest priority)
2. User config file (`--config`)
3. Default configuration (`configs/default.yaml`)

## Key Files to Understand

- **`src/model_handler.py`**: Contains the hook registration logic and transformer layer identification patterns
- **`main.py`**: Shows the complete workflow from CLI parsing to result output
- **`configs/default.yaml`**: Demonstrates all configurable parameters and their defaults
- **`src/analysis.py`**: Implements the core analysis algorithms for confidence and attention

## Working with Models

When adding support for new model architectures, update the layer identification patterns in `HookManager._identify_transformer_layers()`. The system currently recognizes common patterns like `transformer.h`, `encoder.layer`, `decoder.layers`, etc.

For models requiring special handling, extend the model type detection in `ModelHandler._is_vision_model()` and `_is_multimodal_model()`, and add corresponding loading logic.

## Output Formats

The tool generates structured output with consistent schema:
- **model_output**: Top tokens, logit statistics, prediction confidence
- **layer_analysis**: Per-layer hidden state statistics
- **attention_analysis**: Attention patterns, entropy, sparsity metrics
- **summary**: High-level analysis results and confidence levels

Results can be saved in JSON, YAML, or Pickle formats, with optional attention heatmap visualizations.