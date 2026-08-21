import CoreFoundation
import Foundation

struct TokenizerFieldInfo: Identifiable, Sendable, Equatable {
    let name: String
    let detail: String

    var id: String { name }
}

struct TokenizerAddedTokenInfo: Sendable, Equatable {
    let id: Int?
    let content: String
    let special: Bool
}

struct TokenizerOverview: Sendable, Equatable {
    let version: String?
    let modelType: String?
    let vocabCount: Int?
    let mergeCount: Int?
    let addedTokenCount: Int?
    let addedTokens: [TokenizerAddedTokenInfo]
    let vocabularyAnalysis: TokenizerVocabularyAnalysis?
    let fields: [TokenizerFieldInfo]
}

struct TokenizerLengthBucket: Sendable, Equatable {
    let label: String
    let count: Int
}

struct TokenizerVocabularyEntry: Sendable, Equatable {
    let tokenID: Int
    let token: String
    let scalarLength: Int
}

struct TokenizerVocabularyIndex: Sendable, Equatable {
    static let maximumMatchCount = 1_000

    let entries: [TokenizerVocabularyEntry]

    func matches(
        query: String,
        limit: Int = TokenizerVocabularyIndex.maximumMatchCount
    ) -> [TokenizerVocabularyEntry] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let limit = min(max(limit, 0), Self.maximumMatchCount)
        guard !query.isEmpty, limit > 0 else { return [] }
        return Array(entries.lazy.filter {
            $0.token.localizedCaseInsensitiveContains(query)
                || String($0.tokenID).contains(query)
        }.prefix(limit))
    }
}

struct TokenizerVocabularyDiff: Sendable, Equatable {
    let leftOnly: [String]
    let rightOnly: [String]
    let sharedCount: Int

    init(left: TokenizerVocabularyIndex, right: TokenizerVocabularyIndex) {
        let leftPieces = Set(left.entries.map(\.token))
        let rightPieces = Set(right.entries.map(\.token))
        leftOnly = leftPieces.subtracting(rightPieces).sorted()
        rightOnly = rightPieces.subtracting(leftPieces).sorted()
        sharedCount = leftPieces.intersection(rightPieces).count
    }
}

func tokenizerVocabularyMatches(
    in pieces: [String],
    query: String,
    limit: Int = TokenizerVocabularyIndex.maximumMatchCount
) -> [String] {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let limit = min(max(limit, 0), TokenizerVocabularyIndex.maximumMatchCount)
    guard limit > 0 else { return [] }
    return Array(pieces.lazy.filter {
        query.isEmpty || $0.localizedCaseInsensitiveContains(query)
    }.prefix(limit))
}

struct TokenizerVocabularyAnalysis: Sendable, Equatable {
    let tokenCount: Int
    let averageScalarLength: Double
    let p50ScalarLength: Int
    let p90ScalarLength: Int
    let p95ScalarLength: Int
    let p99ScalarLength: Int
    let maximumScalarLength: Int
    let buckets: [TokenizerLengthBucket]
    let longestTokens: [TokenizerVocabularyEntry]
}

struct TokenizerInspection: Sendable {
    let overview: TokenizerOverview?
    let error: String?
}

enum TokenizerInspector {
    static func vocabularyIndex(from data: Data) -> TokenizerVocabularyIndex? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = root["model"] as? [String: Any],
              let entries = vocabularyEntries(from: model["vocab"]) else { return nil }
        let sorted = entries.sorted {
            $0.id == $1.id ? $0.token < $1.token : $0.id < $1.id
        }
        return TokenizerVocabularyIndex(entries: sorted.map {
            TokenizerVocabularyEntry(
                tokenID: $0.id,
                token: $0.token,
                scalarLength: $0.token.unicodeScalars.count
            )
        })
    }

    static func inspect(_ data: Data) -> TokenizerInspection {
        do {
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return TokenizerInspection(
                    overview: nil,
                    error: String(localized: "tokenizer.json 根节点不是对象。")
                )
            }
            let model = root["model"] as? [String: Any]
            let vocabulary = model?["vocab"]
            let overview = TokenizerOverview(
                version: root["version"] as? String,
                modelType: model?["type"] as? String,
                vocabCount: collectionCount(vocabulary),
                mergeCount: (model?["merges"] as? [Any])?.count,
                addedTokenCount: (root["added_tokens"] as? [Any])?.count,
                addedTokens: addedTokens(from: root["added_tokens"]),
                vocabularyAnalysis: vocabularyEntries(from: vocabulary).flatMap(analyzeVocabulary),
                fields: root.keys.sorted().map {
                    TokenizerFieldInfo(name: $0, detail: describe(root[$0]))
                }
            )
            return TokenizerInspection(overview: overview, error: nil)
        } catch {
            return TokenizerInspection(overview: nil, error: error.localizedDescription)
        }
    }

    private static func collectionCount(_ value: Any?) -> Int? {
        if let value = value as? [String: Any] { return value.count }
        if let value = value as? [Any] { return value.count }
        return nil
    }

    private static func addedTokens(from value: Any?) -> [TokenizerAddedTokenInfo] {
        guard let values = value as? [Any] else { return [] }
        return values.compactMap { value in
            guard let token = value as? [String: Any],
                  let content = token["content"] as? String else {
                return nil
            }
            return TokenizerAddedTokenInfo(
                id: token["id"].flatMap(integerID),
                content: content,
                special: boolean(token["special"])
            )
        }
    }

    private static func vocabularyEntries(from value: Any?) -> [(id: Int, token: String)]? {
        if let vocabulary = value as? [String: Any] {
            var entries: [(id: Int, token: String)] = []
            entries.reserveCapacity(vocabulary.count)
            var seenIDs: Set<Int> = []
            seenIDs.reserveCapacity(vocabulary.count)
            for (token, rawID) in vocabulary {
                guard let id = integerID(rawID), seenIDs.insert(id).inserted else { return nil }
                entries.append((id, token))
            }
            return entries
        }

        if let vocabulary = value as? [Any] {
            var entries: [(id: Int, token: String)] = []
            entries.reserveCapacity(vocabulary.count)
            for (id, rawEntry) in vocabulary.enumerated() {
                guard let pair = rawEntry as? [Any],
                      pair.count >= 2,
                      let token = pair[0] as? String,
                      let score = pair[1] as? NSNumber,
                      CFGetTypeID(score) != CFBooleanGetTypeID() else {
                    return nil
                }
                entries.append((id, token))
            }
            return entries
        }

        return nil
    }

    private static func integerID(_ value: Any) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              let id = Int(number.stringValue),
              id >= 0 else {
            return nil
        }
        return id
    }

    private static func boolean(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else {
            return false
        }
        return number.boolValue
    }

    private static func analyzeVocabulary(
        _ entries: [(id: Int, token: String)]
    ) -> TokenizerVocabularyAnalysis? {
        guard !entries.isEmpty else { return nil }

        var lengths: [Int] = []
        lengths.reserveCapacity(entries.count)
        var totalLength: Int64 = 0
        var bucketCounts = Array(repeating: 0, count: 9)
        var longestTokens: [TokenizerVocabularyEntry] = []
        longestTokens.reserveCapacity(min(entries.count, 50))

        for entry in entries {
            let length = entry.token.unicodeScalars.count
            lengths.append(length)
            totalLength += Int64(length)
            bucketCounts[bucketIndex(for: length)] += 1
            insert(
                TokenizerVocabularyEntry(tokenID: entry.id, token: entry.token, scalarLength: length),
                into: &longestTokens
            )
        }

        let sortedLengths = lengths.sorted()
        let labels = ["0", "1", "2", "3–4", "5–8", "9–16", "17–32", "33–64", "65+"]
        var buckets = zip(labels, bucketCounts).map {
            TokenizerLengthBucket(label: $0.0, count: $0.1)
        }
        if bucketCounts[0] == 0 {
            buckets.removeFirst()
        }

        return TokenizerVocabularyAnalysis(
            tokenCount: entries.count,
            averageScalarLength: Double(totalLength) / Double(entries.count),
            p50ScalarLength: percentile(0.50, in: sortedLengths),
            p90ScalarLength: percentile(0.90, in: sortedLengths),
            p95ScalarLength: percentile(0.95, in: sortedLengths),
            p99ScalarLength: percentile(0.99, in: sortedLengths),
            maximumScalarLength: sortedLengths[sortedLengths.count - 1],
            buckets: buckets,
            longestTokens: longestTokens
        )
    }

    private static func percentile(_ percentile: Double, in sortedLengths: [Int]) -> Int {
        let rank = Int((Double(sortedLengths.count) * percentile).rounded(.up))
        return sortedLengths[min(sortedLengths.count - 1, max(0, rank - 1))]
    }

    private static func bucketIndex(for length: Int) -> Int {
        switch length {
        case 0: 0
        case 1: 1
        case 2: 2
        case 3...4: 3
        case 5...8: 4
        case 9...16: 5
        case 17...32: 6
        case 33...64: 7
        default: 8
        }
    }

    private static func insert(
        _ entry: TokenizerVocabularyEntry,
        into longestTokens: inout [TokenizerVocabularyEntry]
    ) {
        let insertionIndex = longestTokens.firstIndex { existing in
            if entry.scalarLength != existing.scalarLength {
                return entry.scalarLength > existing.scalarLength
            }
            if entry.tokenID != existing.tokenID {
                return entry.tokenID < existing.tokenID
            }
            return entry.token < existing.token
        }

        if let insertionIndex {
            longestTokens.insert(entry, at: insertionIndex)
            if longestTokens.count > 50 {
                longestTokens.removeLast()
            }
        } else if longestTokens.count < 50 {
            longestTokens.append(entry)
        }
    }

    private static func describe(_ value: Any?) -> String {
        switch value {
        case nil, is NSNull:
            return "null"
        case let value as [String: Any]:
            if let type = value["type"] as? String {
                return String(localized: "对象 · \(value.count) 字段 · type: \(type)")
            }
            return String(localized: "对象 · \(value.count) 字段")
        case let value as [Any]:
            return String(localized: "数组 · \(value.count) 项")
        case let value as String:
            return value.count > 80 ?
                String(localized: "字符串 · \(value.count) 字符") :
                value
        case let value as NSNumber:
            return value.stringValue
        default:
            return String(describing: value)
        }
    }
}
