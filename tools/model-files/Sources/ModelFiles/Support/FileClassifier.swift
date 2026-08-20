import Foundation

enum FileClassifier {
    private static let blockedExtensions: Set<String> = [
        "safetensors", "bin", "pt", "pth", "ckpt", "onnx",
        "h5", "msgpack", "tflite", "pb"
    ]

    static func isGGUFFileName(_ name: String) -> Bool {
        let lowercasedName = name.lowercased()
        return lowercasedName.hasSuffix(".gguf") || lowercasedName.hasSuffix(".gguf_file")
    }

    static func syntaxLanguage(for path: String) -> String? {
        let languages = [
            "py": "python", "pyw": "python",
            "js": "javascript", "mjs": "javascript", "cjs": "javascript",
            "ts": "typescript", "jsx": "jsx", "tsx": "tsx",
            "sh": "bash", "bash": "bash", "zsh": "bash",
            "swift": "swift", "rs": "rust", "go": "go",
            "c": "c", "h": "c", "cc": "cpp", "cpp": "cpp", "cxx": "cpp", "hpp": "cpp",
            "java": "java", "kt": "kotlin", "kts": "kotlin",
            "rb": "ruby", "php": "php", "lua": "lua",
            "yaml": "yaml", "yml": "yaml", "toml": "toml", "sql": "sql",
            "css": "css", "scss": "scss", "sass": "sass", "less": "less",
            "html": "markup", "htm": "markup", "xml": "markup", "svg": "markup",
        ]
        return languages[URL(fileURLWithPath: path).pathExtension.lowercased()]
    }

    static func category(for path: String) -> FileCategory {
        let name = URL(fileURLWithPath: path).lastPathComponent.lowercased()
        let lowerPath = path.lowercased()

        if name.contains("imatrix"), name.hasSuffix(".dat") || name.contains(".dat.at_") {
            return .weightMetadata
        }

        if isGGUFFileName(name) {
            return .weights
        }

        if name.hasSuffix(".index.json") &&
            (name.contains("safetensors") || name.contains("pytorch_model")) {
            return .weightMetadata
        }

        if blockedExtensions.contains(URL(fileURLWithPath: name).pathExtension) {
            return .weights
        }

        if name == "adapter_config.json" || name == "preprocessor_config.json" ||
            name == "processor_config.json" {
            return .configuration
        }

        if name == "config.json" || name == "configuration.json" ||
            name == "generation_config.json" || name.hasSuffix("_config.json") &&
            !name.contains("tokenizer") && !name.contains("processor") &&
            !name.contains("preprocessor") {
            return .configuration
        }

        if name.contains("tokenizer") || name == "vocab.json" ||
            name == "merges.txt" || name == "special_tokens_map.json" ||
            name.hasPrefix("added_tokens") || name.hasSuffix(".model") {
            return .tokenizer
        }

        if name.hasSuffix(".pdf") {
            return .documentation
        }

        if name.contains("template") || name.hasSuffix(".jinja") ||
            lowerPath.contains("template") {
            return .templates
        }

        if name == "readme.md" || name == "license" || name.hasPrefix("license.") ||
            name == "notice" || name.hasSuffix(".md") || name.hasSuffix(".rst") {
            return .documentation
        }

        return .other
    }

    static func sortPriority(for path: String) -> Int {
        let name = URL(fileURLWithPath: path).lastPathComponent.lowercased()
        let preferred = [
            "config.json", "configuration.json", "generation_config.json",
            "adapter_config.json", "preprocessor_config.json", "processor_config.json",
            "tokenizer_config.json", "tokenizer.json", "vocab.json", "merges.txt",
            "special_tokens_map.json", "model.safetensors.index.json",
            "pytorch_model.bin.index.json", "readme.md", "license"
        ]
        return preferred.firstIndex(of: name) ?? preferred.count
    }
}

extension Int64 {
    var formattedByteCount: String {
        ByteCountFormatter.string(fromByteCount: self, countStyle: .file)
    }
}
