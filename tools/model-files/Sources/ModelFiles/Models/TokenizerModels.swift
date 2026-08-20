import Foundation

enum TokenizerPlaygroundPhase: Sendable, Equatable {
    case idle
    case loading
    case ready
    case tokenizing
    case inputTooLarge(limit: Int)
    case recoverableTokenizerClassFailure(String)
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

enum TokenizationDirection: Sendable, Equatable {
    case encode
    case decode
}

struct TokenFlags: Sendable, Equatable {
    let isSpecial: Bool
    let specialName: String?
}

enum TokenRole: Sendable, Equatable {
    case system
    case user
    case assistant
    case tool
    case template
    case custom(String)

    init(_ role: String) {
        self = switch role {
        case "system": .system
        case "user": .user
        case "assistant": .assistant
        case "tool": .tool
        default: .custom(role)
        }
    }

    var title: String {
        switch self {
        case .system: "system"
        case .user: "user"
        case .assistant: "assistant"
        case .tool: "tool"
        case .template: "template"
        case let .custom(role): role
        }
    }
}

struct TokenOverhead: Sendable, Equatable {
    let totalCount: Int
    let contentCount: Int
    let templateCount: Int
    let isApproximate: Bool
    let contentProbe: String
}

struct ChatAttributionSeed: Sendable, Equatable {
    let messages: [TemplateMessage]
    let includeTools: Bool
    let tools: [TemplateTool]
    let variables: [TemplateVariable]
    let addGenerationPrompt: Bool

    init(
        messages: [TemplateMessage],
        includeTools: Bool = false,
        tools: [TemplateTool] = [],
        variables: [TemplateVariable] = [],
        addGenerationPrompt: Bool = true
    ) {
        self.messages = messages
        self.includeTools = includeTools
        self.tools = tools
        self.variables = variables
        self.addGenerationPrompt = addGenerationPrompt
    }

    func renderRequest(template: String) -> TemplateRenderRequest {
        TemplateRenderRequest(
            template: template,
            messages: messages,
            includeTools: includeTools,
            tools: tools,
            variables: variables,
            addGenerationPrompt: addGenerationPrompt
        )
    }
}

struct TokenizerEncodeRequest: Sendable, Equatable {
    let text: String
    let chatAttribution: ChatAttributionSeed?

    init(text: String, chatAttribution: ChatAttributionSeed? = nil) {
        self.text = text
        self.chatAttribution = chatAttribution
    }
}

enum ComparisonSource: Sendable, Equatable {
    case snapshotPath(String)
}

enum TokenizerComparisonPhase: Sendable, Equatable {
    case loading
    case ready
    case failed(String)
}

enum TokenizerVocabularyComparison: Sendable, Equatable {
    case available(
        left: TokenizerVocabularyIndex,
        right: TokenizerVocabularyIndex,
        diff: TokenizerVocabularyDiff
    )
    case skipped(String)
}

struct TokenizerComparisonSession: Sendable, Equatable {
    let source: ComparisonSource
    let rightIdentity: TokenizerSessionIdentity?
    let phase: TokenizerComparisonPhase
    let left: TokenizationResult?
    let right: TokenizationResult?
    let rightCatalog: ChatTemplateCatalog?
    let vocabulary: TokenizerVocabularyComparison?

    init(
        source: ComparisonSource,
        rightIdentity: TokenizerSessionIdentity?,
        phase: TokenizerComparisonPhase,
        left: TokenizationResult?,
        right: TokenizationResult?,
        rightCatalog: ChatTemplateCatalog? = nil,
        vocabulary: TokenizerVocabularyComparison? = nil
    ) {
        self.source = source
        self.rightIdentity = rightIdentity
        self.phase = phase
        self.left = left
        self.right = right
        self.rightCatalog = rightCatalog
        self.vocabulary = vocabulary
    }
}

struct TokenizerComparisonSummary: Sendable, Equatable {
    let countDelta: Int
    let idsMatch: Bool
    let firstDifference: Int?
    let leftID: Int?
    let rightID: Int?

    init(leftIDs: [Int], rightIDs: [Int]) {
        countDelta = rightIDs.count - leftIDs.count
        let commonCount = min(leftIDs.count, rightIDs.count)
        firstDifference = (0..<commonCount).first(where: { leftIDs[$0] != rightIDs[$0] })
            ?? (leftIDs.count == rightIDs.count ? nil : commonCount)
        if let firstDifference {
            leftID = leftIDs.indices.contains(firstDifference) ? leftIDs[firstDifference] : nil
            rightID = rightIDs.indices.contains(firstDifference) ? rightIDs[firstDifference] : nil
        } else {
            leftID = nil
            rightID = nil
        }
        idsMatch = leftIDs == rightIDs
    }

}

struct TokenSegment: Identifiable, Sendable, Equatable {
    let tokenRange: Range<Int>
    let tokenIDs: [Int]
    let text: String

    var id: Int { tokenRange.lowerBound }
}

struct TokenizationResult: Sendable, Equatable {
    let direction: TokenizationDirection
    let input: String
    let tokenIDs: [Int]
    let tokenPieces: [String?]
    let decodedText: String
    let segments: [TokenSegment]
    let sourceMapping: TokenizerSourceMapping
    let flags: [TokenFlags]
    let roles: [TokenRole]?
    let overhead: TokenOverhead?

    var tokenCount: Int { tokenIDs.count }

    func segment(containing tokenIndex: Int) -> TokenSegment? {
        segments.first { $0.tokenRange.contains(tokenIndex) }
    }

    func with(overhead: TokenOverhead?, roles: [TokenRole]? = nil) -> TokenizationResult {
        TokenizationResult(
            direction: direction,
            input: input,
            tokenIDs: tokenIDs,
            tokenPieces: tokenPieces,
            decodedText: decodedText,
            segments: segments,
            sourceMapping: sourceMapping,
            flags: flags,
            roles: roles,
            overhead: overhead
        )
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
