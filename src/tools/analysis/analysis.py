"""
Analysis Engine for LLM/VLM Analysis Tool
Provides layer-wise logits analysis, attention visualization, and confidence calculation.
"""

import torch
import numpy as np
from typing import Dict, List, Optional, Tuple, Union, Any
import logging
from scipy.stats import entropy
import matplotlib.pyplot as plt
import seaborn as sns

logger = logging.getLogger(__name__)


class LogitsAnalyzer:
    """Analyzes logits from different layers of the model."""

    def __init__(self, tokenizer=None):
        self.tokenizer = tokenizer

    def extract_layer_logits(self, hidden_states: Dict[int, Dict],
                           model_output: Dict) -> Dict[int, torch.Tensor]:
        """Extract logits from layer hidden states."""
        layer_logits = {}

        for layer_idx, layer_data in hidden_states.items():
            if 'hidden_states' in layer_data:
                # For models that output logits from hidden states
                hidden = layer_data['hidden_states']
                # This would need model-specific logic to convert hidden states to logits
                # For now, we'll store the hidden states
                layer_logits[layer_idx] = hidden

        return layer_logits

    def get_top_tokens(self, logits: torch.Tensor, k: int = 10) -> Dict[str, Any]:
        """Get top-k tokens and their probabilities from logits."""
        if logits.dim() > 2:
            # Take the last token if sequence
            logits = logits[:, -1, :]

        probs = torch.softmax(logits, dim=-1)
        top_probs, top_indices = torch.topk(probs, k, dim=-1)

        result = {
            'token_ids': top_indices.cpu().numpy(),
            'probabilities': top_probs.cpu().numpy(),
            'logits': logits[0, top_indices[0]].cpu().numpy() if logits.dim() == 2 else logits[top_indices].cpu().numpy()
        }

        if self.tokenizer:
            result['tokens'] = [self.tokenizer.decode([token_id]) for token_id in result['token_ids'][0]]

        return result

    def compute_logit_statistics(self, logits: torch.Tensor) -> Dict[str, float]:
        """Compute various statistics from logits."""
        if logits.dim() > 2:
            logits = logits[:, -1, :]  # Take last position

        logits_np = logits.cpu().numpy().flatten()
        probs = torch.softmax(logits, dim=-1).cpu().numpy().flatten()

        stats = {
            'mean_logit': float(np.mean(logits_np)),
            'std_logit': float(np.std(logits_np)),
            'min_logit': float(np.min(logits_np)),
            'max_logit': float(np.max(logits_np)),
            'entropy': float(entropy(probs + 1e-12)),  # Add small epsilon to avoid log(0)
            'perplexity': float(np.exp(entropy(probs + 1e-12))),
            'max_prob': float(np.max(probs)),
            'top5_prob_sum': float(np.sum(np.sort(probs)[-5:]))
        }

        return stats


class AttentionAnalyzer:
    """Analyzes attention patterns from transformer models."""

    def __init__(self):
        pass

    def extract_attention_patterns(self, attention_weights: Dict[int, Dict],
                                 model_attentions: Optional[torch.Tensor] = None) -> Dict[int, Dict]:
        """Extract and process attention patterns from different layers."""
        attention_patterns = {}

        # Process hook-captured attention weights
        for layer_idx, attn_data in attention_weights.items():
            if 'weights' in attn_data:
                attn = attn_data['weights']
                patterns = self._analyze_attention_tensor(attn, layer_idx)
                attention_patterns[layer_idx] = patterns

        # Process model's native attention outputs
        if model_attentions is not None:
            for layer_idx, layer_attn in enumerate(model_attentions):
                if layer_idx not in attention_patterns:
                    patterns = self._analyze_attention_tensor(layer_attn, layer_idx)
                    attention_patterns[layer_idx] = patterns

        return attention_patterns

    def _analyze_attention_tensor(self, attention: torch.Tensor,
                                layer_idx: int) -> Dict[str, Any]:
        """Analyze a single attention tensor."""
        # attention shape: [batch_size, num_heads, seq_len, seq_len]
        batch_size, num_heads, seq_len, _ = attention.shape

        # Convert to numpy for analysis
        attn_np = attention.cpu().numpy()

        analysis = {
            'shape': attention.shape,
            'num_heads': num_heads,
            'seq_len': seq_len,
            'mean_attention': np.mean(attn_np, axis=(0, 1)),  # Average over batch and heads
            'head_statistics': self._compute_head_statistics(attn_np),
            'attention_entropy': self._compute_attention_entropy(attn_np),
            'attention_sparsity': self._compute_attention_sparsity(attn_np),
            'diagonal_attention': self._compute_diagonal_attention(attn_np)
        }

        return analysis

    def _compute_head_statistics(self, attention: np.ndarray) -> Dict[str, Any]:
        """Compute statistics for each attention head."""
        batch_size, num_heads, seq_len, _ = attention.shape

        head_stats = []
        for head_idx in range(num_heads):
            head_attn = attention[:, head_idx, :, :]  # [batch, seq, seq]

            stats = {
                'head_idx': head_idx,
                'mean_attention': float(np.mean(head_attn)),
                'std_attention': float(np.std(head_attn)),
                'max_attention': float(np.max(head_attn)),
                'entropy': float(np.mean([entropy(row + 1e-12) for row in head_attn.reshape(-1, seq_len)]))
            }
            head_stats.append(stats)

        return head_stats

    def _compute_attention_entropy(self, attention: np.ndarray) -> Dict[str, float]:
        """Compute entropy statistics for attention patterns."""
        batch_size, num_heads, seq_len, _ = attention.shape

        # Reshape to compute entropy per attention distribution
        attn_reshaped = attention.reshape(-1, seq_len)
        entropies = [entropy(row + 1e-12) for row in attn_reshaped]

        return {
            'mean_entropy': float(np.mean(entropies)),
            'std_entropy': float(np.std(entropies)),
            'min_entropy': float(np.min(entropies)),
            'max_entropy': float(np.max(entropies))
        }

    def _compute_attention_sparsity(self, attention: np.ndarray,
                                  threshold: float = 0.1) -> Dict[str, float]:
        """Compute sparsity metrics for attention patterns."""
        # Compute sparsity as fraction of attention weights below threshold
        total_weights = attention.size
        sparse_weights = np.sum(attention < threshold)

        return {
            'sparsity_ratio': float(sparse_weights / total_weights),
            'threshold': threshold,
            'effective_attention_ratio': float(np.sum(attention > threshold) / total_weights)
        }

    def _compute_diagonal_attention(self, attention: np.ndarray) -> Dict[str, float]:
        """Compute diagonal attention statistics (self-attention strength)."""
        batch_size, num_heads, seq_len, _ = attention.shape

        diagonal_values = []
        for b in range(batch_size):
            for h in range(num_heads):
                diagonal_values.extend(np.diag(attention[b, h]))

        return {
            'mean_diagonal': float(np.mean(diagonal_values)),
            'std_diagonal': float(np.std(diagonal_values)),
            'diagonal_dominance': float(np.mean(diagonal_values) / np.mean(attention))
        }

    def visualize_attention(self, attention: torch.Tensor,
                          layer_idx: int, head_idx: Optional[int] = None,
                          tokens: Optional[List[str]] = None,
                          save_path: Optional[str] = None) -> plt.Figure:
        """Visualize attention patterns as heatmap."""
        if attention.dim() == 4:
            # Select specific head or average over heads
            if head_idx is not None and head_idx < attention.shape[1]:
                attn_matrix = attention[0, head_idx].cpu().numpy()
                title = f'Layer {layer_idx}, Head {head_idx} Attention'
            else:
                attn_matrix = attention[0].mean(dim=0).cpu().numpy()
                title = f'Layer {layer_idx} Average Attention'
        else:
            attn_matrix = attention.cpu().numpy()
            title = f'Layer {layer_idx} Attention'

        fig, ax = plt.subplots(figsize=(10, 8))

        # Create heatmap
        sns.heatmap(attn_matrix,
                   xticklabels=tokens if tokens else False,
                   yticklabels=tokens if tokens else False,
                   cmap='Blues',
                   ax=ax,
                   cbar=True)

        ax.set_title(title)
        ax.set_xlabel('Key Positions')
        ax.set_ylabel('Query Positions')

        plt.tight_layout()

        if save_path:
            plt.savefig(save_path, dpi=300, bbox_inches='tight')

        return fig


class ConfidenceCalculator:
    """Calculates various confidence metrics for model predictions."""

    def __init__(self):
        pass

    def calculate_prediction_confidence(self, logits: torch.Tensor,
                                      method: str = 'max_prob') -> Dict[str, float]:
        """Calculate confidence using various methods."""
        if logits.dim() > 2:
            logits = logits[:, -1, :]  # Take last token

        probs = torch.softmax(logits, dim=-1)

        confidence_metrics = {}

        if method == 'max_prob' or method == 'all':
            confidence_metrics['max_probability'] = float(torch.max(probs))

        if method == 'entropy' or method == 'all':
            # Lower entropy = higher confidence
            ent = entropy(probs.cpu().numpy().flatten() + 1e-12)
            confidence_metrics['entropy'] = float(ent)
            confidence_metrics['normalized_entropy'] = float(ent / np.log(probs.shape[-1]))

        if method == 'top_k' or method == 'all':
            # Top-k probability mass
            top_k_probs, _ = torch.topk(probs, k=min(5, probs.shape[-1]), dim=-1)
            confidence_metrics['top_5_prob_sum'] = float(torch.sum(top_k_probs))
            confidence_metrics['top_1_prob'] = float(top_k_probs[0, 0])

        if method == 'margin' or method == 'all':
            # Margin between top two predictions
            top_2_probs, _ = torch.topk(probs, k=2, dim=-1)
            if top_2_probs.shape[-1] >= 2:
                confidence_metrics['margin'] = float(top_2_probs[0, 0] - top_2_probs[0, 1])

        if method == 'temperature_scaled' or method == 'all':
            # Confidence after temperature scaling
            temperature = 1.5  # Could be learned or set
            temp_scaled_probs = torch.softmax(logits / temperature, dim=-1)
            confidence_metrics['temperature_scaled_max'] = float(torch.max(temp_scaled_probs))

        if method == 'variance' or method == 'all':
            # Variance of the probability distribution
            confidence_metrics['prob_variance'] = float(torch.var(probs))
            confidence_metrics['prob_std'] = float(torch.std(probs))

        return confidence_metrics

    def calculate_layer_confidence_progression(self, layer_logits: Dict[int, torch.Tensor],
                                             method: str = 'max_prob') -> Dict[int, Dict[str, float]]:
        """Calculate confidence progression across layers."""
        layer_confidences = {}

        for layer_idx, logits in layer_logits.items():
            if isinstance(logits, torch.Tensor) and logits.numel() > 0:
                # For hidden states, we need to convert to logits first
                # This is a simplified approach - in practice, you'd need the language model head
                if logits.dim() == 3 and logits.shape[-1] != layer_logits[max(layer_logits.keys())].shape[-1]:
                    # This is likely a hidden state, not logits
                    # Skip for now or implement proper conversion
                    continue

                confidence = self.calculate_prediction_confidence(logits, method)
                layer_confidences[layer_idx] = confidence

        return layer_confidences

    def analyze_confidence_trends(self, layer_confidences: Dict[int, Dict[str, float]]) -> Dict[str, Any]:
        """Analyze trends in confidence across layers."""
        if not layer_confidences:
            return {}

        # Get all metric names
        metric_names = set()
        for conf_dict in layer_confidences.values():
            metric_names.update(conf_dict.keys())

        trends = {}
        for metric in metric_names:
            values = []
            layers = []
            for layer_idx, conf_dict in sorted(layer_confidences.items()):
                if metric in conf_dict:
                    values.append(conf_dict[metric])
                    layers.append(layer_idx)

            if len(values) > 1:
                trends[metric] = {
                    'values': values,
                    'layers': layers,
                    'trend': 'increasing' if values[-1] > values[0] else 'decreasing',
                    'change_ratio': values[-1] / values[0] if values[0] != 0 else float('inf'),
                    'std': float(np.std(values)),
                    'range': float(max(values) - min(values))
                }

        return trends


class AnalysisEngine:
    """Main analysis engine that coordinates all analysis components."""

    def __init__(self, tokenizer=None):
        self.logits_analyzer = LogitsAnalyzer(tokenizer)
        self.attention_analyzer = AttentionAnalyzer()
        self.confidence_calculator = ConfidenceCalculator()
        self.tokenizer = tokenizer

    def run_full_analysis(self, model_output: Dict[str, Any],
                         layer_outputs: Dict[int, Dict],
                         attention_weights: Dict[int, Dict],
                         analysis_config: Dict[str, Any]) -> Dict[str, Any]:
        """Run comprehensive analysis on model outputs."""
        results = {
            'model_output': {},
            'layer_analysis': {},
            'attention_analysis': {},
            'confidence_analysis': {},
            'summary': {}
        }

        # Analyze main model output
        if 'logits' in model_output and model_output['logits'] is not None:
            results['model_output'] = {
                'top_tokens': self.logits_analyzer.get_top_tokens(
                    model_output['logits'],
                    k=analysis_config.get('top_k', 10)
                ),
                'logit_statistics': self.logits_analyzer.compute_logit_statistics(
                    model_output['logits']
                ),
                'prediction_confidence': self.confidence_calculator.calculate_prediction_confidence(
                    model_output['logits'],
                    method=analysis_config.get('confidence_method', 'all')
                )
            }

        # Analyze layer outputs
        if layer_outputs and analysis_config.get('analyze_layers', True):
            layer_logits = self.logits_analyzer.extract_layer_logits(layer_outputs, model_output)

            for layer_idx, layer_data in layer_outputs.items():
                layer_analysis = {}

                if 'hidden_states' in layer_data:
                    hidden_states = layer_data['hidden_states']
                    # Basic statistics for hidden states
                    layer_analysis['hidden_state_stats'] = {
                        'shape': list(hidden_states.shape),
                        'mean': float(torch.mean(hidden_states)),
                        'std': float(torch.std(hidden_states)),
                        'norm': float(torch.norm(hidden_states))
                    }

                results['layer_analysis'][layer_idx] = layer_analysis

        # Analyze attention patterns
        if attention_weights and analysis_config.get('analyze_attention', True):
            attention_patterns = self.attention_analyzer.extract_attention_patterns(
                attention_weights,
                model_output.get('attentions')
            )
            results['attention_analysis'] = attention_patterns

        # Calculate confidence progression
        if analysis_config.get('analyze_confidence_progression', True):
            # This would need proper logits from each layer
            # For now, we'll analyze the final output
            if 'logits' in model_output and model_output['logits'] is not None:
                results['confidence_analysis'] = {
                    'final_layer': self.confidence_calculator.calculate_prediction_confidence(
                        model_output['logits'],
                        method=analysis_config.get('confidence_method', 'all')
                    )
                }

        # Generate summary
        results['summary'] = self._generate_summary(results)

        return results

    def _generate_summary(self, results: Dict[str, Any]) -> Dict[str, Any]:
        """Generate a summary of the analysis results."""
        summary = {
            'analyzed_layers': len(results.get('layer_analysis', {})),
            'attention_layers': len(results.get('attention_analysis', {})),
            'has_confidence_analysis': bool(results.get('confidence_analysis', {}))
        }

        # Add top prediction if available
        if 'model_output' in results and 'top_tokens' in results['model_output']:
            top_tokens = results['model_output']['top_tokens']
            if 'tokens' in top_tokens and len(top_tokens['tokens']) > 0:
                summary['top_prediction'] = {
                    'token': top_tokens['tokens'][0],
                    'probability': float(top_tokens['probabilities'][0][0])
                }

        # Add confidence summary
        if 'model_output' in results and 'prediction_confidence' in results['model_output']:
            conf = results['model_output']['prediction_confidence']
            summary['confidence_summary'] = {
                'max_probability': conf.get('max_probability', 0),
                'entropy': conf.get('entropy', 0),
                'confidence_level': 'high' if conf.get('max_probability', 0) > 0.8 else 'medium' if conf.get('max_probability', 0) > 0.5 else 'low'
            }

        return summary