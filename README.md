# LLM/VLM Analysis Tool

A flexible tool for analyzing Large Language Models (LLMs) and Vision-Language Models (VLMs) from Hugging Face Transformers. This tool provides layer-wise logits extraction, attention visualization, and confidence calculation capabilities.

## Features

- = **Layer-wise Analysis**: Extract hidden states and logits from any transformer layer
- <¯ **Attention Visualization**: Generate attention heatmaps and analyze attention patterns
- =Ê **Confidence Calculation**: Multiple methods for prediction confidence estimation
- < **Multi-modal Support**: Works with text-only, vision-only, and multi-modal models
- ™ **Configurable**: YAML/JSON configuration files for complex analysis workflows
- =È **Rich Output**: JSON/YAML/Pickle output formats with optional visualizations

## Supported Models

- **Text Models**: GPT-2, GPT-3, BERT, T5, LLaMA, Mistral, etc.
- **Vision Models**: ViT, DeiT, Swin Transformer, etc.
- **Multi-modal Models**: CLIP, BLIP, InstructBLIP, etc.

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd llm-tools

# Install dependencies
pip install -e .
```

## Quick Start

### Basic Text Analysis

```bash
python main.py --model gpt2 --input "Hello, world!" --layers 0,5,11
```

### Vision Model Analysis

```bash
python main.py --model google/vit-base-patch16-224 --input image.jpg --extract-attention
```

### Full Analysis with Configuration

```bash
python main.py --config configs/default.yaml --input "Your text here" --output-dir results/
```

## Command Line Usage

### Basic Arguments

- `--model`, `-m`: Model name/path from HuggingFace (required)
- `--input`, `-i`: Input text, image path, or file path (required)
- `--layers`, `-l`: Layer indices to analyze (e.g., "0,5,11" or "0-5" or "-3,-1")

### Analysis Options

- `--extract-attention`: Extract attention weights from specified layers
- `--confidence-method`: Method for confidence calculation (`max_prob`, `entropy`, `top_k`, `margin`, `temperature_scaled`, `variance`, `all`)
- `--top-k`: Number of top tokens to show (default: 10)

### Generation Options (for generative models)

- `--generate`: Use generation mode
- `--max-new-tokens`: Maximum number of tokens to generate
- `--temperature`: Temperature for generation

### Output Options

- `--output-dir`, `-o`: Output directory for results
- `--output-format`: Output format (`json`, `yaml`, `pickle`)
- `--save-attention-plots`: Save attention visualization plots
- `--plot-format`: Format for attention plots (`png`, `pdf`, `svg`)

### Other Options

- `--config`, `-c`: Configuration file (YAML or JSON)
- `--verbose`, `-v`: Enable verbose logging
- `--no-cuda`: Disable CUDA even if available

## Examples

### 1. Analyze GPT-2 with specific layers

```bash
python main.py --model gpt2 --input "The future of AI is" --layers 0,6,11 --top-k 5
```

### 2. Generate attention visualizations

```bash
python main.py --model distilbert-base-uncased --input "Natural language processing" \
    --extract-attention --save-attention-plots --layers 0-5
```

### 3. Confidence analysis

```bash
python main.py --model microsoft/DialoGPT-medium --input "Hello there" \
    --confidence-method all --layers -3,-1 --verbose
```

### 4. Vision model analysis

```bash
python main.py --model google/vit-base-patch16-224 --input path/to/image.jpg \
    --extract-attention --layers 0,6,11 --save-attention-plots
```

### 5. Use configuration file

```bash
python main.py --config analysis_config.yaml --input "Complex analysis task"
```

## Configuration File

Create a YAML configuration file for complex analysis workflows:

```yaml
# analysis_config.yaml
model:
  device: "auto"
  torch_dtype: "float16"

analysis:
  extract_logits: true
  extract_attention: true
  analyze_layers: true
  top_k: 10
  confidence_method: "all"

layers:
  indices: [0, 3, 6, 9, 11]

output:
  output_dir: "./results"
  format: "json"
  save_attention_plots: true
  create_summary_report: true

generation:
  max_new_tokens: 50
  temperature: 0.7
```

## Programmatic Usage

```python
from src.model_handler import ModelHandler
from src.analysis import AnalysisEngine

# Initialize model
model_handler = ModelHandler('gpt2')

# Setup hooks for layers
model_handler.setup_hooks([0, 5, 11], extract_attention=True)

# Process input
inputs = model_handler.process_input("Hello world")
model_output = model_handler.forward(inputs)

# Get layer outputs and attention
layer_outputs = model_handler.get_layer_outputs()
attention_weights = model_handler.get_attention_weights()

# Run analysis
analysis_engine = AnalysisEngine(model_handler.tokenizer)
results = analysis_engine.run_full_analysis(
    model_output, layer_outputs, attention_weights, config
)

# Cleanup
model_handler.cleanup()
```

## Output Structure

### JSON Output Structure

```json
{
  "model_output": {
    "top_tokens": {
      "tokens": ["token1", "token2", ...],
      "probabilities": [[0.8, 0.1, ...]],
      "token_ids": [[123, 456, ...]]
    },
    "logit_statistics": {
      "mean_logit": 0.5,
      "std_logit": 2.1,
      "entropy": 3.2,
      "perplexity": 24.5
    },
    "prediction_confidence": {
      "max_probability": 0.8,
      "entropy": 0.7,
      "top_5_prob_sum": 0.95
    }
  },
  "layer_analysis": {
    "0": {
      "hidden_state_stats": {
        "shape": [1, 10, 768],
        "mean": 0.02,
        "std": 0.85,
        "norm": 12.3
      }
    }
  },
  "attention_analysis": {
    "0": {
      "num_heads": 12,
      "seq_len": 10,
      "attention_entropy": {"mean_entropy": 2.1},
      "attention_sparsity": {"sparsity_ratio": 0.3}
    }
  },
  "summary": {
    "analyzed_layers": 3,
    "attention_layers": 3,
    "top_prediction": {
      "token": " is",
      "probability": 0.8
    },
    "confidence_level": "high"
  }
}
```

## Attention Visualization

The tool generates attention heatmaps showing:

- **Average attention**: Attention averaged across all heads
- **Individual heads**: Attention patterns for specific heads
- **Pattern analysis**: Diagonal dominance, locality, sparsity metrics

## Confidence Metrics

Multiple confidence calculation methods:

1. **Max Probability**: Highest softmax probability
2. **Entropy**: Information-theoretic uncertainty measure
3. **Top-k Probability**: Sum of top-k probabilities
4. **Margin**: Difference between top two predictions
5. **Temperature Scaling**: Calibrated confidence scores
6. **Variance**: Probability distribution variance

## Layer Specification

Flexible layer specification:

- `0,5,11`: Specific layers
- `0-5`: Layer range
- `-1`: Last layer
- `-3,-1`: Last three and last layer
- `all`: All layers (use with caution for large models)

## Memory Management

For large models, consider:

- Using `--no-cuda` to force CPU usage
- Analyzing fewer layers at once
- Using smaller batch sizes
- Using half precision with compatible models

## Troubleshooting

### Common Issues

1. **CUDA out of memory**: Use `--no-cuda` or analyze fewer layers
2. **Model not found**: Ensure model name is correct and accessible
3. **Import errors**: Verify all dependencies are installed
4. **Attention extraction fails**: Some models don't support attention extraction

### Debug Mode

Enable verbose logging for detailed information:

```bash
python main.py --verbose --model gpt2 --input "debug text"
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Citation

If you use this tool in your research, please cite:

```bibtex
@misc{llm-vlm-analysis-tool,
  title={LLM/VLM Analysis Tool},
  author={Your Name},
  year={2024},
  url={https://github.com/your-username/llm-tools}
}
```

## Acknowledgments

- Built on top of Hugging Face Transformers
- Inspired by various interpretability tools in the ML community
- Thanks to the open-source community for model access