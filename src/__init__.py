"""
LLM/VLM Analysis Tool Package
"""

__version__ = "0.1.0"
__author__ = "Your Name"
__description__ = "A flexible tool for analyzing LLMs/VLMs with layer-wise logits extraction, attention visualization, and confidence calculation"

from .model_handler import ModelHandler, HookManager
from .analysis import AnalysisEngine, LogitsAnalyzer, AttentionAnalyzer, ConfidenceCalculator
from .output import OutputManager
from .utils import (
    get_model_info,
    format_model_size,
    get_device_info,
    estimate_memory_usage,
    validate_layer_indices,
    setup_reproducibility
)

__all__ = [
    'ModelHandler',
    'HookManager',
    'AnalysisEngine',
    'LogitsAnalyzer',
    'AttentionAnalyzer',
    'ConfidenceCalculator',
    'OutputManager',
    'get_model_info',
    'format_model_size',
    'get_device_info',
    'estimate_memory_usage',
    'validate_layer_indices',
    'setup_reproducibility'
]