import Foundation

enum SourceSelection: String, CaseIterable, Identifiable, Sendable {
    case automatic
    case modelScope
    case huggingFace

    var id: Self { self }

    var title: String {
        switch self {
        case .automatic: "自动"
        case .modelScope: "ModelScope"
        case .huggingFace: "Hugging Face"
        }
    }
}

enum RepositorySource: String, Sendable {
    case modelScope
    case huggingFace

    var title: String {
        switch self {
        case .modelScope: "ModelScope"
        case .huggingFace: "Hugging Face"
        }
    }
}

enum FileCategory: String, CaseIterable, Identifiable, Sendable {
    case configuration
    case tokenizer
    case templates
    case weightMetadata
    case documentation
    case other
    case weights

    var id: Self { self }

    var title: String {
        switch self {
        case .configuration: "配置"
        case .tokenizer: "Tokenizer"
        case .templates: "模板"
        case .weightMetadata: "权重元数据"
        case .documentation: "文档"
        case .other: "其他"
        case .weights: "权重文件"
        }
    }
}

struct RemoteFile: Identifiable, Hashable, Sendable {
    let path: String
    let size: Int64?
    let isLFS: Bool
    let revision: String
    let contentHash: String?
    let category: FileCategory

    var id: String { path }
    var name: String { URL(fileURLWithPath: path).lastPathComponent }
    var supportsMetadataPreview: Bool { name.lowercased().hasSuffix(".safetensors") }
    var isBlocked: Bool { category == .weights && !supportsMetadataPreview }

    var shortHash: String? {
        guard let contentHash, !contentHash.isEmpty else { return nil }
        return String(contentHash.prefix(7))
    }
}

struct RepositorySnapshot: Sendable {
    let modelID: String
    let source: RepositorySource
    let revision: String
    let revisionLabel: String
    let files: [RemoteFile]
}

enum DetailMode: String, CaseIterable, Identifiable {
    case summary
    case fields
    case raw

    var id: Self { self }

    var title: String {
        switch self {
        case .summary: "摘要"
        case .fields: "全部字段"
        case .raw: "原文"
        }
    }
}
