"""
Utility functions for LLM/VLM Analysis Tool
"""

import torch
import numpy as np
from typing import Dict, List, Optional, Any, Union
import logging

logger = logging.getLogger(__name__)


def get_model_info(model) -> Dict[str, Any]:
    """Extract basic information about the model."""
    info = {
        'model_class': type(model).__name__,
        'num_parameters': sum(p.numel() for p in model.parameters()),
        'trainable_parameters': sum(p.numel() for p in model.parameters() if p.requires_grad),
    }

    # Try to get configuration info
    if hasattr(model, 'config'):
        config = model.config
        info.update({
            'model_type': getattr(config, 'model_type', 'unknown'),
            'hidden_size': getattr(config, 'hidden_size', None),
            'num_hidden_layers': getattr(config, 'num_hidden_layers', getattr(config, 'n_layer', getattr(config, 'num_layers', None))),
            'num_attention_heads': getattr(config, 'num_attention_heads', getattr(config, 'n_head', None)),
            'vocab_size': getattr(config, 'vocab_size', None),
            'max_position_embeddings': getattr(config, 'max_position_embeddings', getattr(config, 'n_positions', None))
        })

    return info


def format_model_size(num_params: int) -> str:
    """Format the number of parameters in a readable way."""
    if num_params >= 1e9:
        return f"{num_params / 1e9:.1f}B"
    elif num_params >= 1e6:
        return f"{num_params / 1e6:.1f}M"
    elif num_params >= 1e3:
        return f"{num_params / 1e3:.1f}K"
    else:
        return str(num_params)


def safe_tensor_to_numpy(tensor: Union[torch.Tensor, np.ndarray]) -> np.ndarray:
    """Safely convert tensor to numpy array."""
    if isinstance(tensor, torch.Tensor):
        return tensor.detach().cpu().numpy()
    elif isinstance(tensor, np.ndarray):
        return tensor
    else:
        raise ValueError(f"Expected torch.Tensor or np.ndarray, got {type(tensor)}")


def get_device_info() -> Dict[str, Any]:
    """Get information about available compute devices."""
    info = {
        'cuda_available': torch.cuda.is_available(),
        'device_count': torch.cuda.device_count() if torch.cuda.is_available() else 0,
    }

    if torch.cuda.is_available():
        info['cuda_version'] = torch.version.cuda
        info['devices'] = []
        for i in range(torch.cuda.device_count()):
            device_props = torch.cuda.get_device_properties(i)
            info['devices'].append({
                'index': i,
                'name': device_props.name,
                'memory_total': device_props.total_memory,
                'memory_available': torch.cuda.get_device_properties(i).total_memory,
                'compute_capability': f"{device_props.major}.{device_props.minor}"
            })

    return info


def estimate_memory_usage(model, input_shape: tuple, batch_size: int = 1) -> Dict[str, float]:
    """Estimate memory usage for model inference."""
    # Get model parameters memory
    param_memory = sum(p.numel() * p.element_size() for p in model.parameters())

    # Estimate activation memory (very rough)
    # This is a simplified calculation
    if hasattr(model, 'config'):
        hidden_size = getattr(model.config, 'hidden_size', 768)
        num_layers = getattr(model.config, 'num_hidden_layers', 12)
        seq_len = input_shape[-1] if input_shape else 512

        # Rough estimate: batch_size * seq_len * hidden_size * num_layers * 4 bytes (float32) * 2 (forward + backward)
        activation_memory = batch_size * seq_len * hidden_size * num_layers * 4 * 2
    else:
        activation_memory = 0

    return {
        'parameters_mb': param_memory / (1024 * 1024),
        'estimated_activations_mb': activation_memory / (1024 * 1024),
        'total_estimated_mb': (param_memory + activation_memory) / (1024 * 1024)
    }


def validate_layer_indices(layer_indices: List[int], num_layers: int) -> List[int]:
    """Validate and normalize layer indices."""
    validated = []

    for idx in layer_indices:
        if idx < 0:
            # Negative indexing
            normalized_idx = num_layers + idx
            if normalized_idx >= 0:
                validated.append(normalized_idx)
            else:
                logger.warning(f"Layer index {idx} is out of range for model with {num_layers} layers")
        elif idx < num_layers:
            validated.append(idx)
        else:
            logger.warning(f"Layer index {idx} is out of range for model with {num_layers} layers")

    return sorted(list(set(validated)))


def create_token_attribution_map(tokens: List[str], attention_weights: np.ndarray) -> Dict[str, Any]:
    """Create a mapping of token attributions from attention weights."""
    if len(tokens) != attention_weights.shape[-1]:
        logger.warning("Token count doesn't match attention matrix size")
        return {}

    # Average attention over heads if multi-head
    if attention_weights.ndim > 2:
        avg_attention = np.mean(attention_weights, axis=tuple(range(attention_weights.ndim - 2)))
    else:
        avg_attention = attention_weights

    attribution_map = {}
    for i, token in enumerate(tokens):
        attribution_map[f"token_{i}_{token}"] = {
            'token': token,
            'position': i,
            'self_attention': float(avg_attention[i, i]) if i < avg_attention.shape[0] else 0.0,
            'incoming_attention': float(np.sum(avg_attention[:, i])) if i < avg_attention.shape[1] else 0.0,
            'outgoing_attention': float(np.sum(avg_attention[i, :])) if i < avg_attention.shape[0] else 0.0
        }

    return attribution_map


def analyze_attention_patterns(attention_weights: np.ndarray) -> Dict[str, Any]:
    """Analyze attention patterns and identify interesting behaviors."""
    patterns = {}

    # Check for diagonal dominance (self-attention)
    if attention_weights.ndim >= 2:
        diag_values = np.diag(attention_weights)
        off_diag_mean = (np.sum(attention_weights) - np.sum(diag_values)) / (attention_weights.size - len(diag_values))
        patterns['diagonal_dominance'] = float(np.mean(diag_values) / off_diag_mean) if off_diag_mean > 0 else float('inf')

    # Check for locality (attention to nearby tokens)
    seq_len = attention_weights.shape[-1]
    if seq_len > 1:
        local_attention = 0
        total_attention = 0
        for i in range(seq_len):
            for j in range(max(0, i-2), min(seq_len, i+3)):  # Window of ±2
                local_attention += attention_weights[i, j] if attention_weights.ndim == 2 else np.mean(attention_weights[:, :, i, j])
            total_attention += np.sum(attention_weights[i, :]) if attention_weights.ndim == 2 else np.mean(np.sum(attention_weights[:, :, i, :], axis=-1))

        patterns['locality_ratio'] = float(local_attention / total_attention) if total_attention > 0 else 0.0

    # Check for sparsity
    threshold = 0.1
    sparse_count = np.sum(attention_weights < threshold)
    patterns['sparsity_ratio'] = float(sparse_count / attention_weights.size)

    # Check for head diversity (if multi-head)
    if attention_weights.ndim == 4:  # [batch, heads, seq, seq]
        head_similarities = []
        num_heads = attention_weights.shape[1]
        for i in range(num_heads):
            for j in range(i+1, num_heads):
                head_i = attention_weights[0, i].flatten()
                head_j = attention_weights[0, j].flatten()
                correlation = np.corrcoef(head_i, head_j)[0, 1]
                if not np.isnan(correlation):
                    head_similarities.append(correlation)

        patterns['head_similarity'] = {
            'mean': float(np.mean(head_similarities)) if head_similarities else 0.0,
            'std': float(np.std(head_similarities)) if head_similarities else 0.0
        }

    return patterns


def compute_token_surprisal(logits: torch.Tensor, token_ids: torch.Tensor) -> torch.Tensor:
    """Compute surprisal (negative log probability) for given tokens."""
    log_probs = torch.log_softmax(logits, dim=-1)

    # Handle different shapes
    if logits.dim() == 3 and token_ids.dim() == 2:
        # Sequence case: [batch, seq, vocab] and [batch, seq]
        surprisal = -log_probs.gather(-1, token_ids.unsqueeze(-1)).squeeze(-1)
    elif logits.dim() == 2 and token_ids.dim() == 1:
        # Single prediction case: [batch, vocab] and [batch]
        surprisal = -log_probs.gather(-1, token_ids.unsqueeze(-1)).squeeze(-1)
    else:
        raise ValueError(f"Incompatible shapes: logits {logits.shape}, token_ids {token_ids.shape}")

    return surprisal


def batch_process_inputs(inputs: List[Any], model_handler, batch_size: int = 8) -> List[Dict[str, Any]]:
    """Process inputs in batches to manage memory usage."""
    results = []

    for i in range(0, len(inputs), batch_size):
        batch = inputs[i:i + batch_size]
        logger.info(f"Processing batch {i // batch_size + 1}/{(len(inputs) - 1) // batch_size + 1}")

        batch_results = []
        for input_item in batch:
            try:
                processed_input = model_handler.process_input(input_item)
                output = model_handler.forward(processed_input)
                batch_results.append(output)
            except Exception as e:
                logger.error(f"Failed to process input: {e}")
                batch_results.append(None)

        results.extend(batch_results)

    return results


def calculate_perplexity(logits: torch.Tensor, target_ids: torch.Tensor) -> float:
    """Calculate perplexity given logits and target token IDs."""
    log_probs = torch.log_softmax(logits, dim=-1)

    if logits.dim() == 3:
        # Sequence case
        target_log_probs = log_probs.gather(-1, target_ids.unsqueeze(-1)).squeeze(-1)
        # Average over sequence length and batch
        avg_log_prob = torch.mean(target_log_probs)
    else:
        # Single token case
        target_log_probs = log_probs.gather(-1, target_ids.unsqueeze(-1)).squeeze(-1)
        avg_log_prob = torch.mean(target_log_probs)

    perplexity = torch.exp(-avg_log_prob)
    return float(perplexity)


def find_model_architecture_type(model) -> str:
    """Determine the architecture type of the model."""
    model_name = type(model).__name__.lower()

    if 'gpt' in model_name or 'causal' in model_name:
        return 'causal_lm'
    elif 'bert' in model_name or 'encoder' in model_name:
        return 'encoder'
    elif 't5' in model_name or 'seq2seq' in model_name:
        return 'seq2seq'
    elif 'vit' in model_name or 'vision' in model_name:
        return 'vision_transformer'
    elif 'clip' in model_name:
        return 'multimodal'
    elif 'blip' in model_name:
        return 'vision_language'
    else:
        return 'unknown'


def setup_reproducibility(seed: int = 42):
    """Setup reproducible random seeds."""
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    np.random.seed(seed)
    # Note: Some operations might still be non-deterministic