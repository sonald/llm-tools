import XCTest
@testable import ModelFiles

final class SafetensorsInspectorTests: XCTestCase {
    func testReadsLittleEndianHeaderLength() {
        XCTAssertEqual(
            SafetensorsInspector.headerLength(from: Data([0x20, 0, 0, 0, 0, 0, 0, 0])),
            32
        )
    }

    func testSummarizesTensorStructureWithoutTensorData() throws {
        let header = try JSONSerialization.data(withJSONObject: [
            "__metadata__": ["format": "pt"],
            "model.embed_tokens.weight": [
                "dtype": "BF16",
                "shape": [10, 4],
                "data_offsets": [0, 80],
            ],
            "model.norm.weight": [
                "dtype": "F32",
                "shape": [4],
                "data_offsets": [80, 96],
            ],
        ])

        let result = SafetensorsInspector.inspect(header)

        XCTAssertNil(result.error)
        XCTAssertEqual(result.overview?.tensors.count, 2)
        XCTAssertEqual(result.overview?.parameterCount, 44)
        XCTAssertEqual(result.overview?.byteCount, 96)
        XCTAssertEqual(result.overview?.dtypeCounts, ["BF16": 1, "F32": 1])
        XCTAssertEqual(result.overview?.metadata, ["format": "pt"])
    }

    func testHighlightsJinjaSyntaxByIntent() {
        let source = #"{# note #} {% if name %}Hello {{ "world" }}{% endif %}"#
        let kinds = Set(JinjaSyntaxHighlighter.highlights(in: source).map(\.kind))

        XCTAssertTrue(kinds.contains(.comment))
        XCTAssertTrue(kinds.contains(.statement))
        XCTAssertTrue(kinds.contains(.expression))
        XCTAssertTrue(kinds.contains(.keyword))
        XCTAssertTrue(kinds.contains(.string))
        XCTAssertTrue(kinds.contains(.delimiter))
    }
}
