#!/usr/bin/env python3
"""
Example usage of the LLM/VLM Analysis Tool
This script demonstrates various ways to use the analysis tool programmatically.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.model_handler import ModelHandler
from src.analysis import AnalysisEngine
from src.output import OutputManager
import torch
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def example_text_analysis():
    """Example: Analyze a text model (GPT-2)."""
    print("="*50)
    print("Example 1: Text Model Analysis (GPT-2)")
    print("="*50)

    # Initialize model handler
    model_handler = ModelHandler('gpt2')

    # Setup hooks for specific layers
    layer_indices = [0, 5, 11]  # First, middle, and last layers
    model_handler.setup_hooks(layer_indices, extract_attention=True)

    # Process input
    input_text = "The future of artificial intelligence is"
    inputs = model_handler.process_input(input_text)

    # Run forward pass
    model_output = model_handler.forward(inputs)

    # Get captured data
    layer_outputs = model_handler.get_layer_outputs()
    attention_weights = model_handler.get_attention_weights()

    # Initialize analysis engine
    analysis_engine = AnalysisEngine(model_handler.tokenizer)

    # Run analysis
    analysis_config = {
        'extract_logits': True,
        'extract_attention': True,
        'analyze_layers': True,
        'analyze_attention': True,
        'analyze_confidence_progression': True,
        'top_k': 5,
        'confidence_method': 'all'
    }

    results = analysis_engine.run_full_analysis(
        model_output,
        layer_outputs,
        attention_weights,
        analysis_config
    )

    # Print summary
    print(f"Analyzed {len(layer_outputs)} layers")
    print(f"Captured attention from {len(attention_weights)} layers")

    if 'model_output' in results and 'top_tokens' in results['model_output']:
        top_tokens = results['model_output']['top_tokens']
        print(f"Top prediction: {top_tokens['tokens'][0]} ({top_tokens['probabilities'][0][0]:.3f})")

    # Cleanup
    model_handler.cleanup()
    print("Example 1 completed!\n")


def example_vision_analysis():
    """Example: Analyze a vision model (ViT)."""
    print("="*50)
    print("Example 2: Vision Model Analysis (ViT)")
    print("="*50)

    try:
        from PIL import Image
        import numpy as np

        # Create a dummy image or load a real one
        # For demo purposes, create a random image
        dummy_image = Image.fromarray(np.random.randint(0, 255, (224, 224, 3), dtype=np.uint8))

        # Initialize model handler
        model_handler = ModelHandler('google/vit-base-patch16-224')

        # Setup hooks for attention analysis
        layer_indices = [0, 5, 11]  # First, middle, and last layers
        model_handler.setup_hooks(layer_indices, extract_attention=True)

        # Process input
        inputs = model_handler.process_input(dummy_image)

        # Run forward pass
        model_output = model_handler.forward(inputs)

        # Get captured data
        layer_outputs = model_handler.get_layer_outputs()
        attention_weights = model_handler.get_attention_weights()

        print(f"Vision model analyzed {len(layer_outputs)} layers")
        print(f"Attention captured from {len(attention_weights)} layers")

        # Initialize analysis engine
        analysis_engine = AnalysisEngine()

        # Run analysis
        analysis_config = {
            'extract_logits': True,
            'extract_attention': True,
            'analyze_layers': True,
            'analyze_attention': True,
            'top_k': 5,
            'confidence_method': 'max_prob'
        }

        results = analysis_engine.run_full_analysis(
            model_output,
            layer_outputs,
            attention_weights,
            analysis_config
        )

        print("Vision model analysis completed!")

        # Cleanup
        model_handler.cleanup()

    except Exception as e:
        print(f"Vision model example failed (this might be expected if model not available): {e}")

    print("Example 2 completed!\n")


def example_confidence_analysis():
    """Example: Focus on confidence calculation."""
    print("="*50)
    print("Example 3: Confidence Analysis")
    print("="*50)

    # Use a smaller model for quick demo
    model_handler = ModelHandler('distilgpt2')

    # Setup hooks
    layer_indices = [0, -1]  # First and last layer
    model_handler.setup_hooks(layer_indices, extract_attention=False)

    # Test different inputs with varying confidence
    test_inputs = [
        "The capital of France is",  # High confidence
        "The quantum physics of",     # Medium confidence
        "The blurry vague unclear",   # Low confidence
    ]

    analysis_engine = AnalysisEngine(model_handler.tokenizer)

    for i, input_text in enumerate(test_inputs):
        print(f"\nInput {i+1}: '{input_text}'")

        inputs = model_handler.process_input(input_text)
        model_output = model_handler.forward(inputs)

        if model_output.get('logits') is not None:
            # Calculate various confidence metrics
            from src.analysis import ConfidenceCalculator
            confidence_calc = ConfidenceCalculator()

            confidence = confidence_calc.calculate_prediction_confidence(
                model_output['logits'],
                method='all'
            )

            print(f"  Max probability: {confidence.get('max_probability', 0):.3f}")
            print(f"  Entropy: {confidence.get('entropy', 0):.3f}")
            print(f"  Top-5 prob sum: {confidence.get('top_5_prob_sum', 0):.3f}")

            # Get top tokens
            top_tokens = analysis_engine.logits_analyzer.get_top_tokens(
                model_output['logits'], k=3
            )
            if 'tokens' in top_tokens:
                print(f"  Top predictions: {top_tokens['tokens'][:3]}")

    # Cleanup
    model_handler.cleanup()
    print("Example 3 completed!\n")


def example_layer_comparison():
    """Example: Compare confidence across layers."""
    print("="*50)
    print("Example 4: Layer-wise Confidence Progression")
    print("="*50)

    model_handler = ModelHandler('gpt2')

    # Analyze multiple layers
    layer_indices = [0, 3, 6, 9, 11]  # Several intermediate layers
    model_handler.setup_hooks(layer_indices, extract_attention=False)

    input_text = "Machine learning will"
    inputs = model_handler.process_input(input_text)
    model_output = model_handler.forward(inputs)

    layer_outputs = model_handler.get_layer_outputs()

    print(f"Analyzing confidence progression across {len(layer_outputs)} layers")

    # This would require implementing proper logits extraction from hidden states
    # For now, we'll just show the layer information
    for layer_idx in sorted(layer_outputs.keys()):
        layer_data = layer_outputs[layer_idx]
        if 'hidden_states' in layer_data:
            hidden = layer_data['hidden_states']
            print(f"Layer {layer_idx}: shape {list(hidden.shape)}, norm {hidden.norm():.2f}")

    # Cleanup
    model_handler.cleanup()
    print("Example 4 completed!\n")


def example_save_results():
    """Example: Save analysis results in different formats."""
    print("="*50)
    print("Example 5: Saving Analysis Results")
    print("="*50)

    model_handler = ModelHandler('distilgpt2')
    layer_indices = [0, 5]
    model_handler.setup_hooks(layer_indices, extract_attention=True)

    input_text = "Artificial intelligence is transforming"
    inputs = model_handler.process_input(input_text)
    model_output = model_handler.forward(inputs)

    layer_outputs = model_handler.get_layer_outputs()
    attention_weights = model_handler.get_attention_weights()

    analysis_engine = AnalysisEngine(model_handler.tokenizer)

    analysis_config = {
        'extract_logits': True,
        'extract_attention': True,
        'analyze_layers': True,
        'analyze_attention': True,
        'top_k': 5,
        'confidence_method': 'all'
    }

    results = analysis_engine.run_full_analysis(
        model_output,
        layer_outputs,
        attention_weights,
        analysis_config
    )

    # Initialize output manager
    output_config = {
        'output_dir': './example_results',
        'format': 'json',
        'save_attention_plots': True
    }

    output_manager = OutputManager(output_config)

    # Create output directory
    import os
    os.makedirs('./example_results', exist_ok=True)

    # Save results in different formats
    json_file = output_manager.save_results(results, 'distilgpt2_example', format='json')
    print(f"Results saved as JSON: {json_file}")

    yaml_file = output_manager.save_results(results, 'distilgpt2_example', format='yaml')
    print(f"Results saved as YAML: {yaml_file}")

    # Create summary report
    report_file = output_manager.create_summary_report(
        results,
        'distilgpt2_example',
        input_text
    )
    print(f"Summary report saved: {report_file}")

    # Save attention plots if we have attention data
    if attention_weights:
        plot_files = output_manager.save_attention_plots(
            attention_weights,
            analysis_engine.attention_analyzer,
            'distilgpt2_example'
        )
        print(f"Attention plots saved: {len(plot_files)} files")

    # Cleanup
    model_handler.cleanup()
    print("Example 5 completed!\n")


def main():
    """Run all examples."""
    print("LLM/VLM Analysis Tool - Examples")
    print("=" * 60)

    # Set device
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"Using device: {device}")
    print()

    try:
        # Run examples
        example_text_analysis()
        example_confidence_analysis()
        example_layer_comparison()
        example_save_results()

        # Vision example might fail if model not available
        example_vision_analysis()

        print("All examples completed successfully!")

    except Exception as e:
        logger.error(f"Example failed: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()