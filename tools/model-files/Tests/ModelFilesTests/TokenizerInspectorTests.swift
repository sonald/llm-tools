import Foundation
import XCTest
@testable import ModelFiles

final class TokenizerInspectorTests: XCTestCase {
    func testInspectKeepsAddedTokenSummaryWithoutRetainingFullVocabulary() throws {
        let vocabulary = Dictionary(uniqueKeysWithValues: (0..<75).map { ("token-\($0)", $0) })
        let data = try JSONSerialization.data(withJSONObject: [
            "version": "1.0",
            "added_tokens": [
                ["id": 80, "content": "<special>", "special": true],
                ["id": 81, "content": "ordinary", "special": false],
                ["id": -1, "special": true],
            ],
            "model": ["type": "BPE", "vocab": vocabulary],
        ])

        let overview = try XCTUnwrap(TokenizerInspector.inspect(data).overview)
        let analysis = try XCTUnwrap(overview.vocabularyAnalysis)

        XCTAssertEqual(overview.addedTokenCount, 3)
        XCTAssertEqual(overview.addedTokens, [
            TokenizerAddedTokenInfo(id: 80, content: "<special>", special: true),
            TokenizerAddedTokenInfo(id: 81, content: "ordinary", special: false),
        ])
        XCTAssertEqual(analysis.tokenCount, 75)
        XCTAssertLessThanOrEqual(analysis.longestTokens.count, 50)
        XCTAssertFalse(Mirror(reflecting: analysis).children.contains { $0.label == "entries" })
    }

    func testVocabularyIndexKeepsAllEntriesAndMatchesPieceOrID() throws {
        let vocabulary = ["zeta": 2, "Alpha": 10, "middle": 4]
        let data = try tokenizerData(vocabulary: vocabulary)

        let index = try XCTUnwrap(TokenizerInspector.vocabularyIndex(from: data))

        XCTAssertEqual(index.entries.map(\.tokenID), [2, 4, 10])
        XCTAssertEqual(index.matches(query: "alp").map(\.tokenID), [10])
        XCTAssertEqual(index.matches(query: "10").map(\.tokenID), [10])
        XCTAssertEqual(index.matches(query: " "), [])
    }

    func testVocabularyIndexCapsResultsAndRejectsEmptyOrDuplicateVocabulary() throws {
        let vocabulary = Dictionary(uniqueKeysWithValues: (0..<1_005).map { ("token-\($0)", $0) })
        let data = try tokenizerData(vocabulary: vocabulary)
        let index = try XCTUnwrap(TokenizerInspector.vocabularyIndex(from: data))

        XCTAssertEqual(index.entries.count, 1_005)
        XCTAssertEqual(index.matches(query: "token", limit: 10_000).count, 1_000)
        XCTAssertEqual(index.matches(query: "token", limit: -1), [])

        let duplicate = try JSONSerialization.data(withJSONObject: [
            "model": ["vocab": ["one": 1, "two": 1]]
        ])
        XCTAssertNil(TokenizerInspector.vocabularyIndex(from: duplicate))

        let empty = try JSONSerialization.data(withJSONObject: [
            "model": ["vocab": [:]]
        ])
        let emptyIndex = try XCTUnwrap(TokenizerInspector.vocabularyIndex(from: empty))
        XCTAssertEqual(emptyIndex.entries, [])

        let emptyWithSpecial = try JSONSerialization.data(withJSONObject: [
            "added_tokens": [["id": 7, "content": "<s>", "special": true]],
            "model": ["vocab": [:]]
        ])
        XCTAssertEqual(
            TokenizerInspector.inspect(emptyWithSpecial).overview?.addedTokens,
            [TokenizerAddedTokenInfo(id: 7, content: "<s>", special: true)]
        )
    }

    func testTokenizerVocabularyIndexBuildDecisionSkipsEmptyAndCachedQueries() {
        XCTAssertFalse(shouldBuildTokenizerVocabularyIndex(query: "", hasIndex: false))
        XCTAssertFalse(shouldBuildTokenizerVocabularyIndex(query: "  \n", hasIndex: false))
        XCTAssertFalse(shouldBuildTokenizerVocabularyIndex(query: "token", hasIndex: true))
        XCTAssertTrue(shouldBuildTokenizerVocabularyIndex(query: " token ", hasIndex: false))
    }

    private func tokenizerData(vocabulary: [String: Int]) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "version": "1.0",
            "model": ["type": "BPE", "vocab": vocabulary],
        ])
    }
}
