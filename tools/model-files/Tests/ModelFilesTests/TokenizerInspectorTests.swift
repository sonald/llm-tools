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
}
