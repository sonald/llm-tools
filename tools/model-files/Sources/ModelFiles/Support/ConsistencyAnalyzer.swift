import CoreFoundation
import Foundation

enum ConsistencyMaterial<Value: Sendable & Equatable>: Sendable, Equatable {
    case missing
    case available(Value)
    case skipped(String)
    case failed(String)

    var value: Value? {
        guard case let .available(value) = self else { return nil }
        return value
    }

    var coverageStatus: ConsistencyCoverageStatus {
        switch self {
        case .missing: .missing
        case .available: .checked
        case let .skipped(reason): .skipped(reason)
        case let .failed(message): .failed(message)
        }
    }
}

enum ConsistencyMaterialKind: String, CaseIterable, Sendable, Equatable {
    case config
    case generationConfig
    case tokenizerConfig
    case tokenizer
    case adapterConfig
    case processorConfig
    case chatTemplates
    case gguf
}

enum ConsistencyCoverageStatus: Sendable, Equatable {
    case checked
    case missing
    case skipped(String)
    case failed(String)
}

struct ConsistencyCoverage: Identifiable, Sendable, Equatable {
    let material: ConsistencyMaterialKind
    let status: ConsistencyCoverageStatus

    var id: ConsistencyMaterialKind { material }
}

enum ConsistencySeverity: String, Sendable, Equatable {
    case warning
    case info
}

struct ConsistencyFinding: Identifiable, Sendable, Equatable {
    let id: String
    let severity: ConsistencySeverity
    let title: String
    let left: InspectionField
    let right: InspectionField
    let detail: String
}

struct RepositoryConsistencyReport: Sendable, Equatable {
    let identityFields: [InspectionField]
    let findings: [ConsistencyFinding]
    let coverage: [ConsistencyCoverage]
}

struct RepositoryConsistencyMaterials: Sendable, Equatable {
    let config: ConsistencyMaterial<Data>
    let generationConfig: ConsistencyMaterial<Data>
    let tokenizerConfig: ConsistencyMaterial<Data>
    let tokenizer: ConsistencyMaterial<TokenizerOverview>
    let adapterConfig: ConsistencyMaterial<Data>
    let processorConfig: ConsistencyMaterial<Data>
    let chatTemplates: ConsistencyMaterial<ChatTemplateCatalog>
    let gguf: ConsistencyMaterial<GGUFOverview>

    init(
        config: ConsistencyMaterial<Data> = .missing,
        generationConfig: ConsistencyMaterial<Data> = .missing,
        tokenizerConfig: ConsistencyMaterial<Data> = .missing,
        tokenizer: ConsistencyMaterial<TokenizerOverview> = .missing,
        adapterConfig: ConsistencyMaterial<Data> = .missing,
        processorConfig: ConsistencyMaterial<Data> = .missing,
        chatTemplates: ConsistencyMaterial<ChatTemplateCatalog> = .missing,
        gguf: ConsistencyMaterial<GGUFOverview> = .missing
    ) {
        self.config = config
        self.generationConfig = generationConfig
        self.tokenizerConfig = tokenizerConfig
        self.tokenizer = tokenizer
        self.adapterConfig = adapterConfig
        self.processorConfig = processorConfig
        self.chatTemplates = chatTemplates
        self.gguf = gguf
    }
}

enum ConsistencyAnalyzer {
    static func analyze(materials: RepositoryConsistencyMaterials) -> RepositoryConsistencyReport {
        let config = jsonObject(materials.config)
        let generationConfig = jsonObject(materials.generationConfig)
        let tokenizerConfig = jsonObject(materials.tokenizerConfig)
        let adapterConfig = jsonObject(materials.adapterConfig)
        let processorConfig = jsonObject(materials.processorConfig)
        let tokenizer = materials.tokenizer.value
        let chatTemplates = materials.chatTemplates.value
        let gguf = materials.gguf.value

        var identityFields: [InspectionField] = []
        if let config = config.object {
            if let architecture = (config["architectures"] as? [Any])?.first as? String
                ?? nonEmptyString(config["model_type"]) {
                identityFields.append(field("architecture", "string", architecture, .embedded))
            }
            appendIdentity(
                "layers",
                keys: ["num_hidden_layers", "n_layer", "num_layers"],
                from: config,
                to: &identityFields
            )
            appendIdentity(
                "hidden_size",
                keys: ["hidden_size", "n_embd", "d_model"],
                from: config,
                to: &identityFields
            )
            appendIdentity("vocab_size", keys: ["vocab_size"], from: config, to: &identityFields)
            appendIdentity(
                "context",
                keys: ["max_position_embeddings", "max_sequence_length", "n_positions"],
                from: config,
                to: &identityFields
            )
            appendIdentity("num_experts", keys: ["num_experts"], from: config, to: &identityFields)
            appendIdentity(
                "num_experts_per_tok",
                keys: ["num_experts_per_tok"],
                from: config,
                to: &identityFields
            )
        }
        if let adapterConfig = adapterConfig.object {
            for key in ["peft_type", "base_model_name_or_path"] {
                if let value = nonEmptyString(adapterConfig[key]) {
                    identityFields.append(field(key, "string", value, .embedded))
                }
            }
        }
        if let processorConfig = processorConfig.object {
            for key in ["image_size", "size", "crop_size", "processor_class", "image_processor_type"] {
                if let value = displayValue(processorConfig[key]) {
                    identityFields.append(field(key, "value", value, .embedded))
                }
            }
        }

        var findings: [ConsistencyFinding] = []
        let configVocab = config.object.flatMap { unsigned($0["vocab_size"]) }
        let tokenizerVocab = tokenizer.flatMap(vocabCount)
        if let configVocab, let tokenizerVocab, configVocab != tokenizerVocab {
            findings.append(ConsistencyFinding(
                id: "vocab-mismatch",
                severity: .warning,
                title: String(localized: "词表大小不一致"),
                left: field("config.vocab_size", "count", String(configVocab), .embedded),
                right: field("tokenizer.vocab_count", "count", String(tokenizerVocab), .derived),
                detail: String(localized: "config.json 与 tokenizer.json 的词表项数不同。")
            ))
        }

        if let tokenizerConfig = tokenizerConfig.object,
           nonEmptyString(tokenizerConfig["tokenizer_class"]) == nil {
            findings.append(ConsistencyFinding(
                id: "missing-tokenizer-class",
                severity: .warning,
                title: String(localized: "缺少 tokenizer_class"),
                left: field(
                    "tokenizer_config.json",
                    "file",
                    String(localized: "已读取"),
                    .repository
                ),
                right: field(
                    "tokenizer_class",
                    "string",
                    String(localized: "缺失"),
                    .embedded
                ),
                detail: String(localized: "严格 tokenizer runtime 无法在未显式指定 class 时构造。")
            ))
        }

        if let chatTemplates, !chatTemplates.isAvailable {
            findings.append(ConsistencyFinding(
                id: "missing-chat-template",
                severity: .info,
                title: String(localized: "缺少可用 Chat Template"),
                left: field(
                    "chat_template.jinja",
                    "template",
                    String(localized: "未发现"),
                    .repository
                ),
                right: field(
                    "tokenizer_config.chat_template",
                    "template",
                    String(localized: "不可用"),
                    .derived
                ),
                detail: String(localized: "仓库中没有可用的独立或内嵌 Chat Template。")
            ))
        }

        if let generation = generationConfig.object.flatMap({ parsedTokenIDs($0["eos_token_id"]) }),
           let tokenizerEOS = tokenizerEOS(config: tokenizerConfig.object, tokenizer: tokenizer),
           Set(generation) != Set(tokenizerEOS.ids) {
            findings.append(ConsistencyFinding(
                id: "eos-mismatch",
                severity: .warning,
                title: String(localized: "EOS Token 不一致"),
                left: field(
                    "generation_config.eos_token_id",
                    "token IDs",
                    tokenIDDisplay(generation),
                    .embedded
                ),
                right: tokenizerEOS.field,
                detail: String(localized: "generation_config 与 tokenizer 的可靠 EOS ID 不同。")
            ))
        }

        let configContext = config.object.flatMap(contextValue)
        let tokenizerContext = tokenizerConfig.object.flatMap { unsigned($0["model_max_length"]) }
        if let configContext, let tokenizerContext, configContext != tokenizerContext {
            findings.append(ConsistencyFinding(
                id: "context-info",
                severity: .info,
                title: String(localized: "上下文长度声明不同"),
                left: field("config.context", "count", String(configContext), .embedded),
                right: field(
                    "tokenizer_config.model_max_length",
                    "count",
                    String(tokenizerContext),
                    .embedded
                ),
                detail: String(localized: "模型与 tokenizer 的长度上限经常承担不同语义，请人工确认。")
            ))
        }

        if let configContext, let ggufContext = gguf?.contextLength, configContext != ggufContext {
            findings.append(ConsistencyFinding(
                id: "gguf-context-mismatch",
                severity: .warning,
                title: String(localized: "GGUF 上下文长度不一致"),
                left: field("config.context", "count", String(configContext), .embedded),
                right: field("GGUF context_length", "count", String(ggufContext), .embedded),
                detail: String(localized: "已检查 GGUF 的 context_length 与 config.json 不同。")
            ))
        }

        if let tokenizerVocab,
           let embedding = gguf.flatMap(embeddingVocabularyDimension),
           embedding.dimension != tokenizerVocab {
            findings.append(ConsistencyFinding(
                id: "gguf-vocab-mismatch",
                severity: .warning,
                title: String(localized: "GGUF Token Embedding 与词表不一致"),
                left: field(
                    "GGUF \(embedding.name)[0]",
                    "count",
                    String(embedding.dimension),
                    .embedded
                ),
                right: field("tokenizer.vocab_count", "count", String(tokenizerVocab), .derived),
                detail: String(localized: "保守识别的 token embedding 第一维与 tokenizer 词表项数不同。")
            ))
        }

        if case .missing = materials.config {
            findings.append(ConsistencyFinding(
                id: "missing-config",
                severity: .info,
                title: String(localized: "缺少模型配置"),
                left: field(
                    "repository",
                    "source",
                    String(localized: "当前仓库"),
                    .repository
                ),
                right: field(
                    "config.json",
                    "file",
                    String(localized: "缺失"),
                    .repository
                ),
                detail: String(localized: "仓库中没有 config.json 或 configuration.json。")
            ))
        }

        let coverage = [
            ConsistencyCoverage(material: .config, status: config.status),
            ConsistencyCoverage(material: .generationConfig, status: generationConfig.status),
            ConsistencyCoverage(material: .tokenizerConfig, status: tokenizerConfig.status),
            ConsistencyCoverage(material: .tokenizer, status: materials.tokenizer.coverageStatus),
            ConsistencyCoverage(material: .adapterConfig, status: adapterConfig.status),
            ConsistencyCoverage(material: .processorConfig, status: processorConfig.status),
            ConsistencyCoverage(material: .chatTemplates, status: materials.chatTemplates.coverageStatus),
            ConsistencyCoverage(material: .gguf, status: materials.gguf.coverageStatus),
        ]
        return RepositoryConsistencyReport(
            identityFields: identityFields,
            findings: findings,
            coverage: coverage
        )
    }

    private static func jsonObject(
        _ material: ConsistencyMaterial<Data>
    ) -> (object: [String: Any]?, status: ConsistencyCoverageStatus) {
        switch material {
        case .missing:
            return (nil, .missing)
        case let .skipped(reason):
            return (nil, .skipped(reason))
        case let .failed(message):
            return (nil, .failed(message))
        case let .available(data):
            do {
                guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return (nil, .failed(String(localized: "JSON 根节点不是对象。")))
                }
                return (object, .checked)
            } catch {
                return (nil, .failed(error.localizedDescription))
            }
        }
    }

    private static func appendIdentity(
        _ key: String,
        keys: [String],
        from object: [String: Any],
        to fields: inout [InspectionField]
    ) {
        guard let value = keys.lazy.compactMap({ unsigned(object[$0]) }).first else { return }
        fields.append(field(key, "count", String(value), .embedded))
    }

    private static func field(
        _ key: String,
        _ type: String,
        _ value: String,
        _ origin: InspectionField.Origin
    ) -> InspectionField {
        InspectionField(key: key, type: type, value: value, origin: origin)
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func unsigned(_ value: Any?) -> UInt64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              let parsed = UInt64(number.stringValue) else {
            return nil
        }
        return parsed
    }

    private static func displayValue(_ value: Any?) -> String? {
        if let value = nonEmptyString(value) { return value }
        if let value = unsigned(value) { return String(value) }
        if let object = value as? [String: Any],
           let height = unsigned(object["height"]),
           let width = unsigned(object["width"]) {
            return "\(width)×\(height)"
        }
        return nil
    }

    private static func vocabCount(_ tokenizer: TokenizerOverview) -> UInt64? {
        let count = tokenizer.vocabCount ?? tokenizer.vocabularyAnalysis?.tokenCount
        guard let count, count >= 0 else { return nil }
        return UInt64(count)
    }

    private static func parsedTokenIDs(_ value: Any?) -> [Int]? {
        if let number = value as? NSNumber,
           CFGetTypeID(number) != CFBooleanGetTypeID(),
           let id = Int(number.stringValue),
           id >= 0 {
            return [id]
        }
        guard let values = value as? [Any], !values.isEmpty else { return nil }
        var ids: [Int] = []
        ids.reserveCapacity(values.count)
        for value in values {
            guard let number = value as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  let id = Int(number.stringValue),
                  id >= 0 else {
                return nil
            }
            ids.append(id)
        }
        return ids
    }

    private static func tokenIDDisplay(_ ids: [Int]) -> String {
        ids.count == 1 ? String(ids[0]) : "[" + ids.map(String.init).joined(separator: ", ") + "]"
    }

    private static func tokenizerEOS(
        config: [String: Any]?,
        tokenizer: TokenizerOverview?
    ) -> (ids: [Int], field: InspectionField)? {
        guard let config else { return nil }
        if config["eos_token_id"] != nil {
            guard let ids = parsedTokenIDs(config["eos_token_id"]) else { return nil }
            return (
                ids,
                field("tokenizer_config.eos_token_id", "token IDs", tokenIDDisplay(ids), .embedded)
            )
        }

        let content: String?
        if let value = config["eos_token"] as? String {
            content = value
        } else {
            content = (config["eos_token"] as? [String: Any])?["content"] as? String
        }
        guard let content, let tokenizer else { return nil }
        let ids = Set(tokenizer.addedTokens.compactMap {
            $0.content == content ? $0.id : nil
        })
        guard ids.count == 1, let id = ids.first else { return nil }
        return (
            [id],
            field("tokenizer.added_tokens.eos_token_id", "token IDs", String(id), .derived)
        )
    }

    private static func contextValue(_ config: [String: Any]) -> UInt64? {
        ["max_position_embeddings", "max_sequence_length", "n_positions"]
            .lazy
            .compactMap { unsigned(config[$0]) }
            .first
    }

    private static func embeddingVocabularyDimension(
        _ gguf: GGUFOverview
    ) -> (name: String, dimension: UInt64)? {
        let tensor = gguf.tensors.first { $0.name == "token_embd.weight" }
            ?? gguf.tensors
                .filter { $0.name.hasSuffix(".token_embd.weight") }
                .sorted { $0.name < $1.name }
                .first
            ?? gguf.tensors.first { $0.name == "model.embed_tokens.weight" }
        guard let tensor, let dimension = tensor.shape.first else { return nil }
        return (tensor.name, dimension)
    }
}
