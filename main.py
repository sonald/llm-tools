#!/usr/bin/env python3
"""
LLM/VLM Analysis Tool
A flexible tool for analyzing LLMs/VLMs with layer-wise logits extraction,
attention visualization, and confidence calculation.
"""

import argparse
import json
import yaml
import logging
import os
from pathlib import Path
from typing import Dict, Any, List, Optional
import torch
from PIL import Image

from src.model_handler import ModelHandler
from src.analysis import AnalysisEngine
from src.output import OutputManager


def setup_logging(verbose: bool = False):
    """Setup logging configuration."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )


def load_config(config_path: Optional[str] = None) -> Dict[str, Any]:
    """Load configuration from file or use defaults."""
    default_config = {
        'model': {
            'device': 'auto',
            'torch_dtype': 'auto'
        },
        'analysis': {
            'extract_logits': True,
            'extract_attention': False,
            'analyze_layers': True,
            'analyze_attention': True,
            'analyze_confidence_progression': True,
            'top_k': 10,
            'confidence_method': 'all'
        },
        'layers': {
            'indices': [0, -1],  # First and last layer by default
            'extract_all': False
        },
        'output': {
            'format': 'json',
            'save_attention_plots': False,
            'output_dir': './results'
        }
    }

    if config_path and Path(config_path).exists():
        with open(config_path, 'r') as f:
            if config_path.endswith('.yaml') or config_path.endswith('.yml'):
                user_config = yaml.safe_load(f)
            else:
                user_config = json.load(f)

        # Merge configurations
        for key in user_config:
            if key in default_config and isinstance(default_config[key], dict):
                default_config[key].update(user_config[key])
            else:
                default_config[key] = user_config[key]

    return default_config


def parse_layer_indices(layer_str: str, model_num_layers: Optional[int] = None) -> List[int]:
    """Parse layer indices from string specification."""
    if not layer_str:
        return []

    indices = []
    parts = layer_str.split(',')

    for part in parts:
        part = part.strip()
        if '-' in part and not part.startswith('-'):
            # Range specification (e.g., "0-5")
            start, end = map(int, part.split('-'))
            indices.extend(range(start, end + 1))
        elif part.startswith('-') and len(part) > 1:
            # Negative index (from end)
            idx = int(part)
            if model_num_layers:
                indices.append(model_num_layers + idx)
            else:
                indices.append(idx)
        else:
            # Single index
            indices.append(int(part))

    return sorted(list(set(indices)))  # Remove duplicates and sort


def load_input_data(input_path: str, model_type: str) -> Any:
    """Load input data based on model type."""
    if model_type in ['vision', 'multimodal']:
        if os.path.exists(input_path):
            try:
                return Image.open(input_path)
            except Exception as e:
                logging.error(f"Failed to load image {input_path}: {e}")
                raise
        else:
            # Maybe it's a URL or the input is text for multimodal
            return input_path
    else:
        # Text input
        if os.path.exists(input_path):
            with open(input_path, 'r', encoding='utf-8') as f:
                return f.read().strip()
        else:
            return input_path


def main():
    parser = argparse.ArgumentParser(
        description="LLM/VLM Analysis Tool - Extract layer-wise information from transformer models",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Analyze GPT-2 with text input
  python main.py --model gpt2 --input "Hello, world!" --layers 0,5,11

  # Analyze vision model with image
  python main.py --model google/vit-base-patch16-224 --input image.jpg --extract-attention

  # Use configuration file
  python main.py --config analysis_config.yaml --input "text or image"

  # Full analysis with custom output
  python main.py --model microsoft/DialoGPT-medium --input "Hi there" \\
                 --layers 0-5 --extract-attention --confidence-method all \\
                 --output-dir results --verbose
        """
    )

    # Model arguments
    parser.add_argument('--model', '-m', type=str, required=True,
                       help='Model name/path from HuggingFace')
    parser.add_argument('--device', type=str, default='auto',
                       help='Device to run on (cuda, cpu, auto)')

    # Input arguments
    parser.add_argument('--input', '-i', type=str, required=True,
                       help='Input text, image path, or file path')
    parser.add_argument('--max-length', type=int, default=512,
                       help='Maximum input length for text models')

    # Analysis arguments
    parser.add_argument('--layers', '-l', type=str, default='0,-1',
                       help='Layer indices to analyze (e.g., "0,5,11" or "0-5" or "-3,-1")')
    parser.add_argument('--extract-logits', action='store_true', default=True,
                       help='Extract logits from specified layers')
    parser.add_argument('--extract-attention', action='store_true',
                       help='Extract attention weights from specified layers')
    parser.add_argument('--confidence-method', type=str,
                       choices=['max_prob', 'entropy', 'top_k', 'margin', 'temperature_scaled', 'variance', 'all'],
                       default='all', help='Method for confidence calculation')
    parser.add_argument('--top-k', type=int, default=10,
                       help='Number of top tokens to show')

    # Generation arguments (for generative models)
    parser.add_argument('--generate', action='store_true',
                       help='Use generation mode (for causal LMs)')
    parser.add_argument('--max-new-tokens', type=int, default=50,
                       help='Maximum number of tokens to generate')
    parser.add_argument('--temperature', type=float, default=1.0,
                       help='Temperature for generation')

    # Output arguments
    parser.add_argument('--output-dir', '-o', type=str, default='./results',
                       help='Output directory for results')
    parser.add_argument('--output-format', type=str, choices=['json', 'yaml', 'pickle'],
                       default='json', help='Output format')
    parser.add_argument('--save-attention-plots', action='store_true',
                       help='Save attention visualization plots')
    parser.add_argument('--plot-format', type=str, choices=['png', 'pdf', 'svg'],
                       default='png', help='Format for attention plots')

    # Configuration
    parser.add_argument('--config', '-c', type=str,
                       help='Configuration file (YAML or JSON)')

    # Other arguments
    parser.add_argument('--verbose', '-v', action='store_true',
                       help='Enable verbose logging')
    parser.add_argument('--no-cuda', action='store_true',
                       help='Disable CUDA even if available')

    args = parser.parse_args()

    # Setup logging
    setup_logging(args.verbose)
    logger = logging.getLogger(__name__)

    # Load configuration
    config = load_config(args.config)

    # Override config with command line arguments
    if args.device != 'auto':
        config['model']['device'] = args.device
    if args.no_cuda:
        config['model']['device'] = 'cpu'
    if args.extract_attention:
        config['analysis']['extract_attention'] = True
    if args.confidence_method != 'all':
        config['analysis']['confidence_method'] = args.confidence_method
    if args.top_k != 10:
        config['analysis']['top_k'] = args.top_k
    if args.output_dir != './results':
        config['output']['output_dir'] = args.output_dir
    if args.output_format != 'json':
        config['output']['format'] = args.output_format
    if args.save_attention_plots:
        config['output']['save_attention_plots'] = True

    try:
        logger.info(f"Loading model: {args.model}")

        # Initialize model handler
        device = config['model']['device']
        if device == 'auto':
            device = 'cuda' if torch.cuda.is_available() and not args.no_cuda else 'cpu'

        model_handler = ModelHandler(args.model, device=device)

        # Parse layer indices
        # First, let's try to determine the number of layers
        model_num_layers = None
        if hasattr(model_handler.model, 'config'):
            if hasattr(model_handler.model.config, 'num_hidden_layers'):
                model_num_layers = model_handler.model.config.num_hidden_layers
            elif hasattr(model_handler.model.config, 'n_layer'):
                model_num_layers = model_handler.model.config.n_layer
            elif hasattr(model_handler.model.config, 'num_layers'):
                model_num_layers = model_handler.model.config.num_layers

        layer_indices = parse_layer_indices(args.layers, model_num_layers)
        logger.info(f"Analyzing layers: {layer_indices}")

        # Setup hooks
        model_handler.setup_hooks(layer_indices, config['analysis']['extract_attention'])

        # Load and process input
        input_data = load_input_data(args.input, model_handler.model_type)
        logger.info(f"Processing input with model type: {model_handler.model_type}")

        inputs = model_handler.process_input(input_data, max_length=args.max_length)

        # Run inference
        if args.generate and hasattr(model_handler.model, 'generate'):
            logger.info("Running generation...")
            model_output = model_handler.forward(
                inputs,
                generate=True,
                max_new_tokens=args.max_new_tokens,
                temperature=args.temperature,
                do_sample=args.temperature != 1.0
            )
        else:
            logger.info("Running forward pass...")
            model_output = model_handler.forward(inputs)

        # Get layer outputs and attention weights
        layer_outputs = model_handler.get_layer_outputs()
        attention_weights = model_handler.get_attention_weights()

        logger.info(f"Captured outputs from {len(layer_outputs)} layers")
        logger.info(f"Captured attention from {len(attention_weights)} layers")

        # Initialize analysis engine
        tokenizer = getattr(model_handler, 'tokenizer', None)
        analysis_engine = AnalysisEngine(tokenizer)

        # Run analysis
        logger.info("Running analysis...")
        analysis_results = analysis_engine.run_full_analysis(
            model_output,
            layer_outputs,
            attention_weights,
            config['analysis']
        )

        # Initialize output manager and save results
        output_manager = OutputManager(config['output'])

        # Create output directory
        output_dir = Path(config['output']['output_dir'])
        output_dir.mkdir(parents=True, exist_ok=True)

        # Save main results
        output_file = output_manager.save_results(
            analysis_results,
            args.model.replace('/', '_'),
            format=config['output']['format']
        )
        logger.info(f"Results saved to: {output_file}")

        # Save attention plots if requested
        if config['output']['save_attention_plots'] and attention_weights:
            logger.info("Generating attention plots...")
            plot_files = output_manager.save_attention_plots(
                attention_weights,
                analysis_engine.attention_analyzer,
                args.model.replace('/', '_'),
                format=args.plot_format
            )
            logger.info(f"Attention plots saved: {len(plot_files)} files")

        # Print summary to console
        if analysis_results.get('summary'):
            print("\n" + "="*50)
            print("ANALYSIS SUMMARY")
            print("="*50)

            summary = analysis_results['summary']
            print(f"Analyzed layers: {summary.get('analyzed_layers', 0)}")
            print(f"Attention layers: {summary.get('attention_layers', 0)}")

            if 'top_prediction' in summary:
                pred = summary['top_prediction']
                print(f"Top prediction: '{pred['token']}' (prob: {pred['probability']:.4f})")

            if 'confidence_summary' in summary:
                conf = summary['confidence_summary']
                print(f"Confidence: {conf['confidence_level']} (max_prob: {conf['max_probability']:.4f})")
                print(f"Entropy: {conf['entropy']:.4f}")

            print("="*50)

        # Cleanup
        model_handler.cleanup()
        logger.info("Analysis completed successfully!")

    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    exit(main())
