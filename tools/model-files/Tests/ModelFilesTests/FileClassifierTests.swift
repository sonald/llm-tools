import Foundation
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

    func testSafeTensorsAndGGUFWeightsSupportStructuredInspection() {
        let safetensors = remoteWeight("model.safetensors")
        let gguf = remoteWeight("model.gguf")
        let pytorch = remoteWeight("pytorch_model.bin")

        XCTAssertEqual(safetensors.structuredInspectionFormat, .safetensors)
        XCTAssertFalse(safetensors.isBlocked)
        XCTAssertEqual(gguf.structuredInspectionFormat, .gguf)
        XCTAssertFalse(gguf.isBlocked)
        XCTAssertNil(pytorch.structuredInspectionFormat)
        XCTAssertTrue(pytorch.isBlocked)
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

    func testNormalizesModelIDsAndRepositoryURLs() throws {
        XCTAssertEqual(try RepositoryService.normalizedModelID(from: " Qwen/Qwen3-4B "), "Qwen/Qwen3-4B")
        XCTAssertEqual(
            try RepositoryService.normalizedModelID(
                from: "https://huggingface.co/Qwen/Qwen3-4B/blob/main/config.json"
            ),
            "Qwen/Qwen3-4B"
        )
        XCTAssertEqual(
            try RepositoryService.normalizedModelID(
                from: "https://modelscope.cn/models/Qwen/Qwen3-4B/files"
            ),
            "Qwen/Qwen3-4B"
        )
    }

    func testRejectsUnrecognizedRepositoryURLs() {
        XCTAssertThrowsError(
            try RepositoryService.normalizedModelID(from: "https://example.com/Qwen/Qwen3-4B")
        )
    }

    func testModelHistoryKeepsNewestEntryAndRemovesDuplicates() {
        XCTAssertEqual(
            ModelFilesStore.updatedHistory(
                ["meta-llama/Llama-3", "QWEN/Qwen3-4B", "google/gemma-3"],
                with: "Qwen/Qwen3-4B"
            ),
            ["Qwen/Qwen3-4B", "meta-llama/Llama-3", "google/gemma-3"]
        )
    }

    func testPreparesModelCardMarkdownWithoutDamagingCode() {
        let source = """
        ---
        license: apache-2.0
        ---
        # Model
        <img src="https://example.com/model.png" style="display: block; width: 30%;">
        <p align="center"><a href="https://example.com">Docs</a></p>
        <https://example.com/model-card>
        ```html
        <strong>keep source</strong>
        ```
        """

        XCTAssertEqual(
            ModelCardMarkdown.renderable(source),
            """
            # Model
            ![](https://example.com/model.png#model-files-width=30pct)
            [Docs](https://example.com)
            <https://example.com/model-card>
            ```html
            <strong>keep source</strong>
            ```
            """
        )
    }

    func testMarkdownImagesResolveOnlyToHTTPS() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://example.com/repo/"))

        XCTAssertEqual(
            ModelCardImageLoader.resolvedHTTPSURL(
                try XCTUnwrap(URL(string: "images/logo.png")),
                relativeTo: baseURL
            ),
            URL(string: "https://example.com/repo/images/logo.png")
        )
        XCTAssertNil(
            ModelCardImageLoader.resolvedHTTPSURL(
                try XCTUnwrap(URL(string: "http://example.com/logo.png")),
                relativeTo: baseURL
            )
        )
        XCTAssertNil(
            ModelCardImageLoader.resolvedHTTPSURL(
                try XCTUnwrap(URL(string: "file:///etc/passwd")),
                relativeTo: baseURL
            )
        )
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
