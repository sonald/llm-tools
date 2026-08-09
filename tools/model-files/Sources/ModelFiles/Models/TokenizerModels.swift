import Foundation

enum TokenizerPlaygroundPhase: Sendable, Equatable {
    case idle
    case loading
    case ready
    case tokenizing
    case inputTooLarge(limit: Int)
    case failed(String)
}

enum TokenizerSourceMapping: String, Sendable, Equatable {
    case exact
    case decodedOnly

    var title: String {
        switch self {
        case .exact: "Exact"
        case .decodedOnly: "Decoded only"
        }
    }
}

struct TokenSegment: Identifiable, Sendable, Equatable {
    let tokenRange: Range<Int>
    let tokenIDs: [Int]
    let text: String

    var id: Int { tokenRange.lowerBound }
}

struct TokenizationResult: Sendable, Equatable {
    let input: String
    let tokenIDs: [Int]
    let tokenPieces: [String?]
    let decodedText: String
    let segments: [TokenSegment]
    let sourceMapping: TokenizerSourceMapping

    var tokenCount: Int { tokenIDs.count }

    func segment(containing tokenIndex: Int) -> TokenSegment? {
        segments.first { $0.tokenRange.contains(tokenIndex) }
    }
}

struct TokenizerSessionIdentity: Sendable, Hashable {
    let repository: String
    let version: String
    let path: String
    let revision: String?
    let contentHash: String?

    init(snapshot: RepositorySnapshot, file: RepositoryFile) {
        repository = snapshot.location.canonicalInput
        version = switch snapshot.version {
        case let .immutable(label): "immutable:\(label)"
        case .live: "live"
        }
        path = file.path
        revision = file.revision
        contentHash = file.contentHash
    }
}
