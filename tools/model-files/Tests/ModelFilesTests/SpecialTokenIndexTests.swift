import Foundation
import XCTest
@testable import ModelFiles

final class SpecialTokenIndexTests: XCTestCase {
    func testCollectsOnlyConfiguredAndSpecialAddedTokensWithoutReadingVocabulary() throws {
        let tokenizerData = try JSONSerialization.data(withJSONObject: [
            "added_tokens": [
                ["id": 7, "content": "<added>", "special": true],
                ["id": -8, "content": "<negative-id>", "special": true],
                ["id": 9, "content": "ordinary", "special": false],
            ],
            "model": ["vocab": ["vocab-only": 99]],
        ])
        let configData = try JSONSerialization.data(withJSONObject: [
            "bos_token": ["content": "<bos>"],
            "additional_special_tokens": ["<extra>", ["content": "<object-extra>"]],
        ])

        let index = try SpecialTokenIndex(
            tokenizerData: tokenizerData,
            tokenizerConfigData: configData
        )

        XCTAssertEqual(index.specialIDs, Set([7]))
        XCTAssertEqual(index.specialNamesByID, [7: "<added>"])
        XCTAssertEqual(index.specialPieces["<bos>"], "bos_token")
        XCTAssertEqual(index.specialPieces["<extra>"], "<extra>")
        XCTAssertEqual(index.specialPieces["<object-extra>"], "<object-extra>")
        XCTAssertEqual(index.specialPieces["<added>"], "<added>")
        XCTAssertEqual(index.specialPieces["<negative-id>"], "<negative-id>")
        XCTAssertNil(index.specialPieces["ordinary"])
        XCTAssertNil(index.specialPieces["vocab-only"])
    }
}
