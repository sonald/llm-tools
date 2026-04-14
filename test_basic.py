#!/usr/bin/env python3
"""
Basic functionality test for LLM/VLM Analysis Tool
"""

import sys
import os

# Add the current directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_imports():
    """Test that all modules can be imported."""
    try:
        from src.model_handler import ModelHandler, HookManager
        from src.analysis import AnalysisEngine, LogitsAnalyzer, AttentionAnalyzer, ConfidenceCalculator
        from src.output import OutputManager
        from src.utils import get_device_info, format_model_size
        print("✅ All imports successful")
        return True
    except ImportError as e:
        print(f"❌ Import failed: {e}")
        return False

def test_device_info():
    """Test device information utility."""
    try:
        from src.utils import get_device_info
        info = get_device_info()
        print(f"✅ Device info: CUDA available: {info['cuda_available']}, Devices: {info['device_count']}")
        return True
    except Exception as e:
        print(f"❌ Device info test failed: {e}")
        return False

def test_config_loading():
    """Test configuration loading."""
    try:
        import yaml
        from pathlib import Path

        config_path = Path('configs/default.yaml')
        if config_path.exists():
            with open(config_path, 'r') as f:
                config = yaml.safe_load(f)
            print(f"✅ Configuration loaded successfully: {len(config)} sections")
            return True
        else:
            print("❌ Default configuration file not found")
            return False
    except Exception as e:
        print(f"❌ Config loading test failed: {e}")
        return False

def main():
    """Run basic tests."""
    print("LLM/VLM Analysis Tool - Basic Tests")
    print("="*40)

    tests = [
        ("Import Test", test_imports),
        ("Device Info Test", test_device_info),
        ("Config Loading Test", test_config_loading),
    ]

    passed = 0
    total = len(tests)

    for test_name, test_func in tests:
        print(f"\nRunning {test_name}...")
        if test_func():
            passed += 1
        else:
            print(f"Test {test_name} failed")

    print(f"\n{'='*40}")
    print(f"Results: {passed}/{total} tests passed")

    if passed == total:
        print("🎉 All basic tests passed! The tool is ready to use.")
        print("\nTry running:")
        print("python main.py --help")
    else:
        print("⚠️  Some tests failed. Check the error messages above.")
        return 1

    return 0

if __name__ == "__main__":
    exit(main())