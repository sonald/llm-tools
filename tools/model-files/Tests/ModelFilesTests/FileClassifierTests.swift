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

    func testSafeTensorsGGUFAndIMatrixSupportStructuredInspection() {
        let safetensors = remoteWeight("model.safetensors")
        let gguf = remoteWeight("model.gguf")
        let disguisedGGUF = RepositoryFile(
            path: "imatrix_unsloth.gguf_file",
            size: 5_150_000,
            revision: "main",
            contentHash: nil,
            category: FileClassifier.category(for: "imatrix_unsloth.gguf_file")
        )
        let imatrix = RepositoryFile(
            path: "imatrix_unsloth.dat",
            size: 1_000,
            revision: "main",
            contentHash: nil,
            category: FileClassifier.category(for: "imatrix_unsloth.dat")
        )
        let pytorch = remoteWeight("pytorch_model.bin")

        XCTAssertEqual(safetensors.structuredInspectionFormat, .safetensors)
        XCTAssertFalse(safetensors.isBlocked)
        XCTAssertEqual(gguf.structuredInspectionFormat, .gguf)
        XCTAssertFalse(gguf.isBlocked)
        XCTAssertEqual(disguisedGGUF.category, .weights)
        XCTAssertEqual(disguisedGGUF.structuredInspectionFormat, .gguf)
        XCTAssertFalse(disguisedGGUF.isBlocked)
        XCTAssertEqual(imatrix.category, .weightMetadata)
        XCTAssertEqual(imatrix.structuredInspectionFormat, .imatrix)
        XCTAssertFalse(imatrix.isBlocked)
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
        XCTAssertEqual(result.overview?.vocabularyAnalysis?.tokenCount, 2)
        XCTAssertEqual(result.overview?.vocabularyAnalysis?.averageScalarLength, 5)
        XCTAssertEqual(result.overview?.vocabularyAnalysis?.p50ScalarLength, 5)
        XCTAssertEqual(result.overview?.vocabularyAnalysis?.longestTokens.map(\.tokenID), [1, 2])
    }

    func testTokenizerInspectorAnalyzesUnicodeScalarLengthsAndExcludesAddedTokens() throws {
        let family = "👨‍👩‍👧‍👦"
        let data = try JSONSerialization.data(withJSONObject: [
            "version": "1.0",
            "added_tokens": [[
                "id": 10,
                "content": String(repeating: "x", count: 100),
            ]],
            "model": [
                "type": "BPE",
                "vocab": [
                    "": 0,
                    "a": 1,
                    "e\u{301}": 2,
                    "long": 3,
                    "wide": 9,
                    family: 4,
                ],
                "merges": [],
            ],
        ])

        let result = TokenizerInspector.inspect(data)
        let analysis = try XCTUnwrap(result.overview?.vocabularyAnalysis)

        XCTAssertNil(result.error)
        XCTAssertEqual(result.overview?.vocabCount, 6)
        XCTAssertEqual(result.overview?.addedTokenCount, 1)
        XCTAssertEqual(analysis.tokenCount, 6)
        XCTAssertEqual(analysis.averageScalarLength, 3, accuracy: 0.000_001)
        XCTAssertEqual(analysis.p50ScalarLength, 2)
        XCTAssertEqual(analysis.p90ScalarLength, 7)
        XCTAssertEqual(analysis.p95ScalarLength, 7)
        XCTAssertEqual(analysis.p99ScalarLength, 7)
        XCTAssertEqual(analysis.maximumScalarLength, 7)
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: analysis.buckets.map { ($0.label, $0.count) }),
            ["0": 1, "1": 1, "2": 1, "3–4": 2, "5–8": 1, "9–16": 0, "17–32": 0, "33–64": 0, "65+": 0]
        )
        XCTAssertEqual(analysis.longestTokens.map(\.tokenID), [4, 3, 9, 2, 1, 0])
        XCTAssertEqual(analysis.longestTokens.first?.token, family)
        XCTAssertEqual(analysis.longestTokens.first?.scalarLength, 7)
    }

    func testTokenizerInspectorAnalyzesUnigramVocabularyByArrayIndex() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "version": "1.0",
            "model": [
                "type": "Unigram",
                "vocab": [
                    ["<unk>", 0.0],
                    ["▁hello", -1.0],
                    ["a", -2.0],
                ],
            ],
        ])

        let result = TokenizerInspector.inspect(data)
        let analysis = try XCTUnwrap(result.overview?.vocabularyAnalysis)

        XCTAssertNil(result.error)
        XCTAssertEqual(result.overview?.vocabCount, 3)
        XCTAssertEqual(analysis.tokenCount, 3)
        XCTAssertEqual(analysis.averageScalarLength, 4, accuracy: 0.000_001)
        XCTAssertEqual(analysis.p50ScalarLength, 5)
        XCTAssertEqual(analysis.maximumScalarLength, 6)
        XCTAssertEqual(analysis.longestTokens.map(\.tokenID), [1, 0, 2])
    }

    func testTokenizerInspectorLeavesUnsupportedOrEmptyVocabularyAnalysisAbsent() throws {
        let emptyData = try JSONSerialization.data(withJSONObject: [
            "model": ["type": "BPE", "vocab": [:]],
        ])
        let malformedData = try JSONSerialization.data(withJSONObject: [
            "model": [
                "type": "Unigram",
                "vocab": [["ok", 0.0], ["missing score"]],
            ],
        ])
        let malformedObjectData = try JSONSerialization.data(withJSONObject: [
            "model": ["type": "BPE", "vocab": ["not an ID": true]],
        ])
        let duplicateIDData = try JSONSerialization.data(withJSONObject: [
            "model": ["type": "BPE", "vocab": ["first": 1, "second": 1]],
        ])

        let empty = TokenizerInspector.inspect(emptyData)
        let malformed = TokenizerInspector.inspect(malformedData)
        let malformedObject = TokenizerInspector.inspect(malformedObjectData)
        let duplicateID = TokenizerInspector.inspect(duplicateIDData)

        XCTAssertNil(empty.error)
        XCTAssertEqual(empty.overview?.vocabCount, 0)
        XCTAssertNil(empty.overview?.vocabularyAnalysis)
        XCTAssertNil(malformed.error)
        XCTAssertEqual(malformed.overview?.vocabCount, 2)
        XCTAssertNil(malformed.overview?.vocabularyAnalysis)
        XCTAssertNil(malformedObject.error)
        XCTAssertEqual(malformedObject.overview?.vocabCount, 1)
        XCTAssertNil(malformedObject.overview?.vocabularyAnalysis)
        XCTAssertNil(duplicateID.error)
        XCTAssertEqual(duplicateID.overview?.vocabCount, 2)
        XCTAssertNil(duplicateID.overview?.vocabularyAnalysis)
    }

    func testTokenizerInspectorKeepsOnlyTheLongestFiftyTokens() throws {
        let vocabulary = Dictionary(uniqueKeysWithValues: (0..<55).map { ("x\($0)", $0) })
        let data = try JSONSerialization.data(withJSONObject: [
            "model": ["type": "BPE", "vocab": vocabulary],
        ])

        let analysis = try XCTUnwrap(TokenizerInspector.inspect(data).overview?.vocabularyAnalysis)

        XCTAssertEqual(analysis.longestTokens.count, 50)
        XCTAssertEqual(analysis.longestTokens.first?.tokenID, 10)
        XCTAssertEqual(analysis.longestTokens.last?.tokenID, 4)
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
        let history = [
            RepositoryHistoryEntry(input: "meta-llama/Llama-3"),
            RepositoryHistoryEntry(input: "QWEN/Qwen3-4B"),
            RepositoryHistoryEntry(input: "google/gemma-3"),
        ]
        XCTAssertEqual(
            ModelFilesStore.updatedHistory(
                history,
                with: RepositoryHistoryEntry(input: "Qwen/Qwen3-4B")
            ),
            [
                RepositoryHistoryEntry(input: "Qwen/Qwen3-4B"),
                RepositoryHistoryEntry(input: "meta-llama/Llama-3"),
                RepositoryHistoryEntry(input: "google/gemma-3"),
            ]
        )

        XCTAssertEqual(
            ModelFilesStore.updatedHistory(
                [RepositoryHistoryEntry(input: "/Models/Qwen")],
                with: RepositoryHistoryEntry(input: "/models/qwen")
            ).count,
            2
        )
    }

    func testMigratesLegacyRepositoryHistories() throws {
        let suiteName = "ModelFilesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(["Qwen/Qwen3-4B"], forKey: "ModelFiles.modelHistory")

        XCTAssertEqual(
            ModelFilesStore.loadHistory(from: defaults),
            [RepositoryHistoryEntry(input: "Qwen/Qwen3-4B")]
        )

        defaults.set(
            Data(#"[{"input":"ssh://gpu/models/Qwen","selection":"ssh"}]"#.utf8),
            forKey: "ModelFiles.repositoryHistory.v2"
        )
        XCTAssertEqual(
            ModelFilesStore.loadHistory(from: defaults),
            [RepositoryHistoryEntry(input: "ssh://gpu/models/Qwen")]
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

    private func remoteWeight(_ path: String) -> RepositoryFile {
        RepositoryFile(
            path: path,
            size: 1_000,
            revision: "main",
            contentHash: nil,
            category: .weights
        )
    }
}
