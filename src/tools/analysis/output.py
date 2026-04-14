"""
Output Manager for LLM/VLM Analysis Tool
Handles saving analysis results in various formats and creating visualizations.
"""

import json
import yaml
import pickle
from pathlib import Path
from typing import Dict, Any, List, Optional
import logging
import numpy as np
from datetime import datetime

logger = logging.getLogger(__name__)


class OutputManager:
    """Manages output formatting and saving for analysis results."""

    def __init__(self, output_config: Dict[str, Any]):
        self.config = output_config
        self.output_dir = Path(output_config.get('output_dir', './results'))
        self.format = output_config.get('format', 'json')

    def save_results(self, results: Dict[str, Any],
                    model_name: str,
                    timestamp: Optional[str] = None,
                    format: Optional[str] = None) -> str:
        """Save analysis results to file."""
        if timestamp is None:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

        format = format or self.format

        # Create filename
        filename = f"{model_name}_{timestamp}"

        if format == 'json':
            filepath = self.output_dir / f"{filename}.json"
            self._save_json(results, filepath)
        elif format == 'yaml':
            filepath = self.output_dir / f"{filename}.yaml"
            self._save_yaml(results, filepath)
        elif format == 'pickle':
            filepath = self.output_dir / f"{filename}.pkl"
            self._save_pickle(results, filepath)
        else:
            raise ValueError(f"Unsupported output format: {format}")

        logger.info(f"Results saved to {filepath}")
        return str(filepath)

    def _save_json(self, data: Dict[str, Any], filepath: Path):
        """Save data as JSON with custom encoder for numpy arrays."""
        class NumpyEncoder(json.JSONEncoder):
            def default(self, obj):
                if isinstance(obj, np.ndarray):
                    return obj.tolist()
                elif isinstance(obj, (np.int32, np.int64)):
                    return int(obj)
                elif isinstance(obj, (np.float32, np.float64)):
                    return float(obj)
                return super().default(obj)

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, cls=NumpyEncoder, indent=2, ensure_ascii=False)

    def _save_yaml(self, data: Dict[str, Any], filepath: Path):
        """Save data as YAML."""
        # Convert numpy arrays to lists for YAML compatibility
        serializable_data = self._make_serializable(data)

        with open(filepath, 'w', encoding='utf-8') as f:
            yaml.dump(serializable_data, f, default_flow_style=False,
                     allow_unicode=True, indent=2)

    def _save_pickle(self, data: Dict[str, Any], filepath: Path):
        """Save data as pickle (preserves numpy arrays and torch tensors)."""
        with open(filepath, 'wb') as f:
            pickle.dump(data, f)

    def _make_serializable(self, data: Any) -> Any:
        """Convert data to be serializable for JSON/YAML."""
        if isinstance(data, dict):
            return {k: self._make_serializable(v) for k, v in data.items()}
        elif isinstance(data, list):
            return [self._make_serializable(item) for item in data]
        elif isinstance(data, np.ndarray):
            return data.tolist()
        elif isinstance(data, (np.int32, np.int64)):
            return int(data)
        elif isinstance(data, (np.float32, np.float64)):
            return float(data)
        elif hasattr(data, 'cpu') and hasattr(data, 'numpy'):
            # PyTorch tensor
            return data.cpu().numpy().tolist()
        else:
            return data

    def save_attention_plots(self, attention_weights: Dict[int, Dict],
                           attention_analyzer,
                           model_name: str,
                           timestamp: Optional[str] = None,
                           format: str = 'png') -> List[str]:
        """Save attention visualization plots."""
        if timestamp is None:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

        plot_files = []
        plots_dir = self.output_dir / 'plots'
        plots_dir.mkdir(exist_ok=True)

        for layer_idx, attn_data in attention_weights.items():
            if 'weights' in attn_data:
                attention = attn_data['weights']

                # Average attention across heads
                if attention.dim() == 4:
                    num_heads = attention.shape[1]

                    # Save average attention
                    avg_filename = f"{model_name}_{timestamp}_layer{layer_idx}_avg.{format}"
                    avg_path = plots_dir / avg_filename

                    fig = attention_analyzer.visualize_attention(
                        attention, layer_idx, head_idx=None,
                        save_path=str(avg_path)
                    )
                    fig.close()  # Close to free memory
                    plot_files.append(str(avg_path))

                    # Save individual heads (max 4 to avoid too many files)
                    max_heads_to_save = min(4, num_heads)
                    for head_idx in range(max_heads_to_save):
                        head_filename = f"{model_name}_{timestamp}_layer{layer_idx}_head{head_idx}.{format}"
                        head_path = plots_dir / head_filename

                        fig = attention_analyzer.visualize_attention(
                            attention, layer_idx, head_idx=head_idx,
                            save_path=str(head_path)
                        )
                        fig.close()  # Close to free memory
                        plot_files.append(str(head_path))
                else:
                    # 2D attention matrix
                    filename = f"{model_name}_{timestamp}_layer{layer_idx}.{format}"
                    filepath = plots_dir / filename

                    fig = attention_analyzer.visualize_attention(
                        attention, layer_idx,
                        save_path=str(filepath)
                    )
                    fig.close()  # Close to free memory
                    plot_files.append(str(filepath))

        return plot_files

    def save_layer_statistics(self, layer_outputs: Dict[int, Dict],
                            model_name: str,
                            timestamp: Optional[str] = None) -> str:
        """Save layer-wise statistics summary."""
        if timestamp is None:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

        stats = {}
        for layer_idx, layer_data in layer_outputs.items():
            if 'hidden_states' in layer_data:
                hidden_states = layer_data['hidden_states']
                stats[f'layer_{layer_idx}'] = {
                    'shape': list(hidden_states.shape),
                    'mean': float(hidden_states.mean()),
                    'std': float(hidden_states.std()),
                    'min': float(hidden_states.min()),
                    'max': float(hidden_states.max()),
                    'norm': float(hidden_states.norm()),
                }

        filename = f"{model_name}_{timestamp}_layer_stats.json"
        filepath = self.output_dir / filename

        self._save_json(stats, filepath)
        return str(filepath)

    def create_summary_report(self, results: Dict[str, Any],
                            model_name: str,
                            input_text: Optional[str] = None,
                            timestamp: Optional[str] = None) -> str:
        """Create a human-readable summary report."""
        if timestamp is None:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

        filename = f"{model_name}_{timestamp}_report.txt"
        filepath = self.output_dir / filename

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write("="*60 + "\n")
            f.write("LLM/VLM ANALYSIS REPORT\n")
            f.write("="*60 + "\n\n")

            f.write(f"Model: {model_name}\n")
            f.write(f"Timestamp: {timestamp}\n")

            if input_text:
                f.write(f"Input: {input_text[:100]}{'...' if len(input_text) > 100 else ''}\n")

            f.write("\n" + "-"*40 + "\n")
            f.write("SUMMARY\n")
            f.write("-"*40 + "\n\n")

            summary = results.get('summary', {})
            f.write(f"Analyzed layers: {summary.get('analyzed_layers', 'N/A')}\n")
            f.write(f"Attention layers: {summary.get('attention_layers', 'N/A')}\n")
            f.write(f"Has confidence analysis: {summary.get('has_confidence_analysis', 'N/A')}\n")

            if 'top_prediction' in summary:
                pred = summary['top_prediction']
                f.write(f"\nTop prediction: '{pred['token']}'\n")
                f.write(f"Probability: {pred['probability']:.4f}\n")

            if 'confidence_summary' in summary:
                conf = summary['confidence_summary']
                f.write(f"\nConfidence level: {conf['confidence_level']}\n")
                f.write(f"Max probability: {conf['max_probability']:.4f}\n")
                f.write(f"Entropy: {conf['entropy']:.4f}\n")

            # Model output details
            if 'model_output' in results:
                model_output = results['model_output']
                f.write("\n" + "-"*40 + "\n")
                f.write("MODEL OUTPUT DETAILS\n")
                f.write("-"*40 + "\n\n")

                if 'top_tokens' in model_output:
                    top_tokens = model_output['top_tokens']
                    f.write("Top tokens:\n")
                    if 'tokens' in top_tokens and 'probabilities' in top_tokens:
                        for i, (token, prob) in enumerate(zip(
                            top_tokens['tokens'][:5],
                            top_tokens['probabilities'][0][:5]
                        )):
                            f.write(f"  {i+1}. '{token}' - {prob:.4f}\n")

                if 'logit_statistics' in model_output:
                    stats = model_output['logit_statistics']
                    f.write(f"\nLogit statistics:\n")
                    f.write(f"  Mean: {stats.get('mean_logit', 'N/A'):.4f}\n")
                    f.write(f"  Std: {stats.get('std_logit', 'N/A'):.4f}\n")
                    f.write(f"  Range: [{stats.get('min_logit', 'N/A'):.4f}, {stats.get('max_logit', 'N/A'):.4f}]\n")
                    f.write(f"  Entropy: {stats.get('entropy', 'N/A'):.4f}\n")
                    f.write(f"  Perplexity: {stats.get('perplexity', 'N/A'):.2f}\n")

            # Layer analysis
            if 'layer_analysis' in results and results['layer_analysis']:
                f.write("\n" + "-"*40 + "\n")
                f.write("LAYER ANALYSIS\n")
                f.write("-"*40 + "\n\n")

                for layer_idx in sorted(results['layer_analysis'].keys()):
                    layer_data = results['layer_analysis'][layer_idx]
                    f.write(f"Layer {layer_idx}:\n")

                    if 'hidden_state_stats' in layer_data:
                        stats = layer_data['hidden_state_stats']
                        f.write(f"  Shape: {stats['shape']}\n")
                        f.write(f"  Mean: {stats['mean']:.4f}\n")
                        f.write(f"  Std: {stats['std']:.4f}\n")
                        f.write(f"  Norm: {stats['norm']:.4f}\n")
                    f.write("\n")

            # Attention analysis
            if 'attention_analysis' in results and results['attention_analysis']:
                f.write("\n" + "-"*40 + "\n")
                f.write("ATTENTION ANALYSIS\n")
                f.write("-"*40 + "\n\n")

                for layer_idx in sorted(results['attention_analysis'].keys()):
                    attn_data = results['attention_analysis'][layer_idx]
                    f.write(f"Layer {layer_idx}:\n")
                    f.write(f"  Heads: {attn_data.get('num_heads', 'N/A')}\n")
                    f.write(f"  Sequence length: {attn_data.get('seq_len', 'N/A')}\n")

                    if 'attention_entropy' in attn_data:
                        ent = attn_data['attention_entropy']
                        f.write(f"  Attention entropy: {ent.get('mean_entropy', 'N/A'):.4f} ± {ent.get('std_entropy', 'N/A'):.4f}\n")

                    if 'attention_sparsity' in attn_data:
                        sparse = attn_data['attention_sparsity']
                        f.write(f"  Sparsity ratio: {sparse.get('sparsity_ratio', 'N/A'):.4f}\n")

                    if 'diagonal_attention' in attn_data:
                        diag = attn_data['diagonal_attention']
                        f.write(f"  Diagonal dominance: {diag.get('diagonal_dominance', 'N/A'):.4f}\n")
                    f.write("\n")

            f.write("="*60 + "\n")
            f.write("End of Report\n")
            f.write("="*60 + "\n")

        logger.info(f"Summary report saved to {filepath}")
        return str(filepath)

    def export_for_analysis(self, results: Dict[str, Any],
                          format: str = 'csv') -> List[str]:
        """Export key metrics in analysis-friendly formats."""
        export_files = []

        # Export layer statistics as CSV
        if 'layer_analysis' in results and format in ['csv', 'all']:
            import pandas as pd

            layer_stats = []
            for layer_idx, layer_data in results['layer_analysis'].items():
                if 'hidden_state_stats' in layer_data:
                    stats = layer_data['hidden_state_stats'].copy()
                    stats['layer'] = layer_idx
                    layer_stats.append(stats)

            if layer_stats:
                df = pd.DataFrame(layer_stats)
                csv_path = self.output_dir / 'layer_statistics.csv'
                df.to_csv(csv_path, index=False)
                export_files.append(str(csv_path))

        # Export attention metrics as CSV
        if 'attention_analysis' in results and format in ['csv', 'all']:
            import pandas as pd

            attention_stats = []
            for layer_idx, attn_data in results['attention_analysis'].items():
                stats = {
                    'layer': layer_idx,
                    'num_heads': attn_data.get('num_heads'),
                    'seq_len': attn_data.get('seq_len')
                }

                if 'attention_entropy' in attn_data:
                    ent = attn_data['attention_entropy']
                    stats.update({
                        'mean_entropy': ent.get('mean_entropy'),
                        'std_entropy': ent.get('std_entropy')
                    })

                if 'attention_sparsity' in attn_data:
                    sparse = attn_data['attention_sparsity']
                    stats['sparsity_ratio'] = sparse.get('sparsity_ratio')

                attention_stats.append(stats)

            if attention_stats:
                df = pd.DataFrame(attention_stats)
                csv_path = self.output_dir / 'attention_statistics.csv'
                df.to_csv(csv_path, index=False)
                export_files.append(str(csv_path))

        return export_files