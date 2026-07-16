import XCTest
@testable import ModelFiles

final class FileClassifierTests: XCTestCase {
    func testClassifiesReadableMetadataBeforeWeightExtensions() {
        XCTAssertEqual(FileClassifier.category(for: "model.safetensors.index.json"), .weightMetadata)
        XCTAssertEqual(FileClassifier.category(for: "pytorch_model.bin.index.json"), .weightMetadata)
    }

    func testBlocksCommonWeightFormats() {
        XCTAssertEqual(FileClassifier.category(for: "model-00001-of-00003.safetensors"), .weights)
        XCTAssertEqual(FileClassifier.category(for: "weights/model.gguf"), .weights)
        XCTAssertEqual(FileClassifier.category(for: "pytorch_model.bin"), .weights)
    }

    func testOnlySafetensorsWeightsSupportHeaderPreview() {
        let safetensors = remoteWeight("model.safetensors")
        let gguf = remoteWeight("model.gguf")

        XCTAssertTrue(safetensors.supportsMetadataPreview)
        XCTAssertFalse(safetensors.isBlocked)
        XCTAssertFalse(gguf.supportsMetadataPreview)
        XCTAssertTrue(gguf.isBlocked)
    }

    func testClassifiesFilesByIntent() {
        XCTAssertEqual(FileClassifier.category(for: "config.json"), .configuration)
        XCTAssertEqual(FileClassifier.category(for: "tokenizer_config.json"), .tokenizer)
        XCTAssertEqual(FileClassifier.category(for: "chat_template.jinja"), .templates)
        XCTAssertEqual(FileClassifier.category(for: "README.md"), .documentation)
    }

    func testUsesReaderFriendlyOrderingWithinCategories() {
        XCTAssertLessThan(
            FileClassifier.sortPriority(for: "tokenizer_config.json"),
            FileClassifier.sortPriority(for: "merges.txt")
        )
        XCTAssertLessThan(
            FileClassifier.sortPriority(for: "README.md"),
            FileClassifier.sortPriority(for: "LICENSE")
        )
    }

    func testTextLinesPreserveEmptyRowsAndPageMatches() {
        let lines = TextLine.parse(Data("first\n\nsecond\r\nthird".utf8))

        XCTAssertEqual(lines.map(\.text), ["first", "", "second", "third"])
        XCTAssertEqual(
            TextLine.visible(in: lines, matching: "i", limit: 2).map(\.text),
            ["first", "third"]
        )
    }

    func testTokenizerInspectorSummarizesLargeCollectionsWithoutExpandingThem() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "version": "1.0",
            "added_tokens": [["id": 1]],
            "model": [
                "type": "BPE",
                "vocab": ["hello": 1, "world": 2],
                "merges": ["h e", "w o"],
            ],
        ])

        let result = TokenizerInspector.inspect(data)

        XCTAssertNil(result.error)
        XCTAssertEqual(result.overview?.modelType, "BPE")
        XCTAssertEqual(result.overview?.vocabCount, 2)
        XCTAssertEqual(result.overview?.mergeCount, 2)
        XCTAssertEqual(result.overview?.fields.first { $0.name == "model" }?.detail, "对象 · 3 字段 · type: BPE")
    }

    private func remoteWeight(_ path: String) -> RemoteFile {
        RemoteFile(
            path: path,
            size: 1_000,
            isLFS: true,
            revision: "main",
            contentHash: nil,
            category: .weights
        )
    }
}
