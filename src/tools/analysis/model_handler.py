"""
Model Handler for LLM/VLM Analysis Tool
Handles loading models from transformers and registering hooks for layer-wise output extraction.
"""

import torch
import torch.nn as nn
from transformers import (
    AutoModel, AutoTokenizer, AutoProcessor,
    AutoModelForCausalLM, AutoModelForSeq2SeqLM,
    BlipForConditionalGeneration, BlipProcessor,
    CLIPModel, CLIPProcessor
)
from typing import Dict, List, Optional, Union, Any, Callable
import logging
from collections import defaultdict

logger = logging.getLogger(__name__)


class HookManager:
    """Manages forward hooks for capturing layer outputs."""

    def __init__(self):
        self.hooks = []
        self.layer_outputs = defaultdict(dict)
        self.attention_weights = defaultdict(dict)
        self.layer_names = {}

    def register_hooks(self, model: nn.Module, layer_indices: List[int],
                      extract_attention: bool = False):
        """Register forward hooks on specified layers."""
        self.clear_hooks()
        self.layer_outputs.clear()
        self.attention_weights.clear()

        # Get all named modules
        named_modules = list(model.named_modules())

        # Identify transformer layers
        transformer_layers = self._identify_transformer_layers(named_modules)

        if not transformer_layers:
            logger.warning("No transformer layers found in the model")
            return

        # Register hooks on specified layers
        for layer_idx in layer_indices:
            if layer_idx < len(transformer_layers):
                layer_name, layer_module = transformer_layers[layer_idx]
                self.layer_names[layer_idx] = layer_name

                # Hook for hidden states
                hook = layer_module.register_forward_hook(
                    self._create_output_hook(layer_idx)
                )
                self.hooks.append(hook)

                # Hook for attention weights if requested
                if extract_attention:
                    attn_module = self._find_attention_module(layer_module)
                    if attn_module:
                        attn_hook = attn_module.register_forward_hook(
                            self._create_attention_hook(layer_idx)
                        )
                        self.hooks.append(attn_hook)

                logger.info(f"Registered hooks for layer {layer_idx}: {layer_name}")

    def _identify_transformer_layers(self, named_modules) -> List[tuple]:
        """Identify transformer layer modules."""
        transformer_layers = []

        # Common transformer layer patterns
        layer_patterns = [
            'transformer.h',  # GPT-2 style
            'transformer.layers',  # Some models
            'encoder.layer',  # BERT style
            'decoder.layers',  # T5 style
            'model.layers',  # Llama style
            'blocks',  # ViT style
            'encoder.layers',  # General encoder
            'decoder.layers',  # General decoder
        ]

        for name, module in named_modules:
            # Check if this looks like a transformer layer
            for pattern in layer_patterns:
                if pattern in name and self._is_transformer_layer(module):
                    # Extract layer number
                    parts = name.split('.')
                    for i, part in enumerate(parts):
                        if part.isdigit():
                            layer_num = int(part)
                            transformer_layers.append((name, module))
                            break
                    break

        # Sort by layer index
        transformer_layers.sort(key=lambda x: self._extract_layer_number(x[0]))
        return transformer_layers

    def _is_transformer_layer(self, module) -> bool:
        """Check if a module is likely a transformer layer."""
        # Look for common transformer components
        has_attention = any('attention' in name.lower() or 'attn' in name.lower()
                           for name, _ in module.named_modules())
        has_mlp = any('mlp' in name.lower() or 'ffn' in name.lower() or 'feed_forward' in name.lower()
                     for name, _ in module.named_modules())
        has_norm = any('norm' in name.lower() or 'layer_norm' in name.lower()
                      for name, _ in module.named_modules())

        return has_attention or (has_mlp and has_norm)

    def _extract_layer_number(self, layer_name: str) -> int:
        """Extract layer number from layer name."""
        parts = layer_name.split('.')
        for part in parts:
            if part.isdigit():
                return int(part)
        return 0

    def _find_attention_module(self, layer_module) -> Optional[nn.Module]:
        """Find the attention module within a transformer layer."""
        for name, module in layer_module.named_modules():
            if ('attention' in name.lower() or 'attn' in name.lower()) and hasattr(module, 'forward'):
                return module
        return None

    def _create_output_hook(self, layer_idx: int) -> Callable:
        """Create a hook function for capturing layer outputs."""
        def hook_fn(module, input, output):
            if isinstance(output, tuple):
                # Most transformer layers return (hidden_states, attention_weights)
                hidden_states = output[0]
            else:
                hidden_states = output

            self.layer_outputs[layer_idx] = {
                'hidden_states': hidden_states.detach().clone(),
                'input_shape': input[0].shape if input else None
            }

        return hook_fn

    def _create_attention_hook(self, layer_idx: int) -> Callable:
        """Create a hook function for capturing attention weights."""
        def attention_hook_fn(module, input, output):
            if isinstance(output, tuple) and len(output) > 1:
                # Attention weights are typically the second output
                attention_weights = output[1]
                if attention_weights is not None:
                    self.attention_weights[layer_idx] = {
                        'weights': attention_weights.detach().clone(),
                        'shape': attention_weights.shape
                    }

        return attention_hook_fn

    def clear_hooks(self):
        """Remove all registered hooks."""
        for hook in self.hooks:
            hook.remove()
        self.hooks.clear()

    def get_layer_output(self, layer_idx: int) -> Optional[Dict]:
        """Get the captured output for a specific layer."""
        return self.layer_outputs.get(layer_idx)

    def get_attention_weights(self, layer_idx: int) -> Optional[Dict]:
        """Get the captured attention weights for a specific layer."""
        return self.attention_weights.get(layer_idx)


class ModelHandler:
    """Handles model loading and inference with hook management."""

    def __init__(self, model_name: str, device: Optional[str] = None):
        self.model_name = model_name
        self.device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
        self.model = None
        self.tokenizer = None
        self.processor = None
        self.hook_manager = HookManager()
        self.model_type = None

        self._load_model()

    def _load_model(self):
        """Load model, tokenizer/processor based on model type."""
        try:
            logger.info(f"Loading model: {self.model_name}")

            # Try to identify model type and load accordingly
            if self._is_vision_model():
                self._load_vision_model()
            elif self._is_multimodal_model():
                self._load_multimodal_model()
            else:
                self._load_text_model()

            logger.info(f"Model loaded successfully on {self.device}")

        except Exception as e:
            logger.error(f"Failed to load model {self.model_name}: {e}")
            raise

    def _is_vision_model(self) -> bool:
        """Check if the model is primarily a vision model."""
        vision_keywords = ['vit', 'deit', 'swin', 'resnet', 'efficientnet']
        return any(keyword in self.model_name.lower() for keyword in vision_keywords)

    def _is_multimodal_model(self) -> bool:
        """Check if the model is multimodal."""
        multimodal_keywords = ['clip', 'blip', 'instructblip', 'flamingo']
        return any(keyword in self.model_name.lower() for keyword in multimodal_keywords)

    def _load_text_model(self):
        """Load text-only model."""
        self.model_type = 'text'

        # Try different model classes
        try:
            self.model = AutoModelForCausalLM.from_pretrained(self.model_name)
        except:
            try:
                self.model = AutoModelForSeq2SeqLM.from_pretrained(self.model_name)
            except:
                self.model = AutoModel.from_pretrained(self.model_name)

        self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        self.model.to(self.device)

    def _load_vision_model(self):
        """Load vision model."""
        self.model_type = 'vision'
        self.model = AutoModel.from_pretrained(self.model_name)
        self.processor = AutoProcessor.from_pretrained(self.model_name)
        self.model.to(self.device)

    def _load_multimodal_model(self):
        """Load multimodal model."""
        self.model_type = 'multimodal'

        if 'clip' in self.model_name.lower():
            self.model = CLIPModel.from_pretrained(self.model_name)
            self.processor = CLIPProcessor.from_pretrained(self.model_name)
        elif 'blip' in self.model_name.lower():
            self.model = BlipForConditionalGeneration.from_pretrained(self.model_name)
            self.processor = BlipProcessor.from_pretrained(self.model_name)
        else:
            # Fallback to AutoModel
            self.model = AutoModel.from_pretrained(self.model_name)
            self.processor = AutoProcessor.from_pretrained(self.model_name)

        self.model.to(self.device)

    def setup_hooks(self, layer_indices: List[int], extract_attention: bool = False):
        """Setup hooks for specified layers."""
        self.hook_manager.register_hooks(self.model, layer_indices, extract_attention)

    def process_input(self, input_data: Union[str, Any],
                     max_length: int = 512) -> Dict[str, torch.Tensor]:
        """Process input data based on model type."""
        if self.model_type == 'text':
            if isinstance(input_data, str):
                inputs = self.tokenizer(
                    input_data,
                    return_tensors='pt',
                    max_length=max_length,
                    truncation=True,
                    padding=True
                )
            else:
                inputs = input_data
        else:
            # For vision/multimodal models
            inputs = self.processor(input_data, return_tensors='pt')

        # Move to device
        inputs = {k: v.to(self.device) if isinstance(v, torch.Tensor) else v
                 for k, v in inputs.items()}

        return inputs

    def forward(self, inputs: Dict[str, torch.Tensor],
                generate: bool = False, **kwargs) -> Dict[str, Any]:
        """Run forward pass and collect outputs."""
        self.model.eval()

        with torch.no_grad():
            if generate and hasattr(self.model, 'generate'):
                # For generation tasks
                outputs = self.model.generate(
                    inputs['input_ids'],
                    attention_mask=inputs.get('attention_mask'),
                    **kwargs
                )
                return {'generated_ids': outputs}
            else:
                # Regular forward pass
                outputs = self.model(**inputs, output_hidden_states=True, output_attentions=True)

                result = {
                    'logits': outputs.logits if hasattr(outputs, 'logits') else None,
                    'hidden_states': outputs.hidden_states if hasattr(outputs, 'hidden_states') else None,
                    'attentions': outputs.attentions if hasattr(outputs, 'attentions') else None,
                    'last_hidden_state': outputs.last_hidden_state if hasattr(outputs, 'last_hidden_state') else None
                }

                return result

    def get_layer_outputs(self) -> Dict[int, Dict]:
        """Get all captured layer outputs."""
        return dict(self.hook_manager.layer_outputs)

    def get_attention_weights(self) -> Dict[int, Dict]:
        """Get all captured attention weights."""
        return dict(self.hook_manager.attention_weights)

    def cleanup(self):
        """Clean up hooks and free memory."""
        self.hook_manager.clear_hooks()