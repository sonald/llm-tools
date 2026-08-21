import Foundation

struct RepositoryHistoryEntry: Codable, Hashable, Sendable {
    let input: String
}

struct SSHLocation: Hashable, Sendable {
    let user: String?
    let host: String
    let port: Int?
    let rootPath: String

    var canonicalInput: String {
        var components = URLComponents()
        components.scheme = "ssh"
        components.user = user
        components.host = host
        components.port = port
        components.path = rootPath
        return components.string ?? "ssh://\(host)\(rootPath)"
    }
}

enum RepositoryLocation: Hashable, Sendable {
    case modelScope(modelID: String)
    case huggingFace(modelID: String)
    case local(root: URL)
    case ssh(SSHLocation)

    var title: String {
        switch self {
        case .modelScope: "ModelScope"
        case .huggingFace: "Hugging Face"
        case .local: String(localized: "本地")
        case let .ssh(location): "SSH \(location.host)"
        }
    }

    var canonicalInput: String {
        switch self {
        case let .modelScope(modelID), let .huggingFace(modelID): modelID
        case let .local(root): root.path
        case let .ssh(location): location.canonicalInput
        }
    }

}

enum RepositoryVersion: Equatable, Sendable {
    case immutable(label: String)
    case live
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
        case .configuration: String(localized: "配置")
        case .tokenizer: "Tokenizer"
        case .templates: String(localized: "模板")
        case .weightMetadata: String(localized: "权重元数据")
        case .documentation: String(localized: "文档")
        case .other: String(localized: "其他")
        case .weights: String(localized: "权重文件")
        }
    }
}

struct RepositoryFile: Identifiable, Hashable, Sendable {
    let path: String
    let size: Int64?
    let revision: String?
    let contentHash: String?
    let category: FileCategory

    var id: String { path }
    var name: String { URL(fileURLWithPath: path).lastPathComponent }
    var isBlocked: Bool { category == .weights && structuredInspectionFormat == nil }

    var shortHash: String? {
        guard let contentHash, !contentHash.isEmpty else { return nil }
        return String(contentHash.prefix(7))
    }

    static func displayOrder(_ lhs: Self, _ rhs: Self) -> Bool {
        let categories = FileCategory.allCases
        let left = categories.firstIndex(of: lhs.category) ?? categories.endIndex
        let right = categories.firstIndex(of: rhs.category) ?? categories.endIndex
        guard left == right else { return left < right }
        let leftPriority = FileClassifier.sortPriority(for: lhs.path)
        let rightPriority = FileClassifier.sortPriority(for: rhs.path)
        return leftPriority == rightPriority
            ? lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
            : leftPriority < rightPriority
    }
}

struct RepositorySnapshot: Sendable {
    let location: RepositoryLocation
    let version: RepositoryVersion
    let files: [RepositoryFile]
}
