import Foundation
import XCTest
@testable import ModelFiles

@MainActor
final class ModelFilesStoreConsistencyTests: XCTestCase {
    func testConsistencyBadgeHasCheckingWarningInsufficientAndConsistentStates() throws {
        XCTAssertEqual(consistencyBadgeState(report: nil), .checking)

        let warning = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(Data(#"{"vocab_size":2}"#.utf8)),
            tokenizerConfig: .available(Data(#"{"tokenizer_class":"GPT2Tokenizer"}"#.utf8)),
            tokenizer: .available(tokenizerOverview(vocabCount: 1)),
            chatTemplates: .available(ChatTemplateCatalog(entries: [
                ChatTemplateEntry(name: "default", source: .jinjaFile, body: "{{ messages }}")
            ]))
        ))
        XCTAssertEqual(consistencyBadgeState(report: warning), .warnings(1))

        let insufficient = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            tokenizer: .available(tokenizerOverview(vocabCount: 1))
        ))
        XCTAssertEqual(consistencyBadgeState(report: insufficient), .insufficient)
        XCTAssertEqual(status(.config, in: insufficient), .missing)

        let consistent = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(Data(#"{"vocab_size":1}"#.utf8)),
            tokenizerConfig: .available(Data(#"{"tokenizer_class":"GPT2Tokenizer"}"#.utf8)),
            tokenizer: .available(tokenizerOverview(vocabCount: 1)),
            chatTemplates: .available(ChatTemplateCatalog(entries: [
                ChatTemplateEntry(name: "default", source: .jinjaFile, body: "{{ messages }}")
            ]))
        ))
        XCTAssertEqual(consistencyBadgeState(report: consistent), .consistent)
    }

    func testOpenPublishesVocabMismatchAndDoesNotInventGGUF() async throws {
        let fixture = try fixture(config: #"{"vocab_size":2}"#, tokenizer: tokenizerData(vocabCount: 1))
        let access = ConsistencyAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/consistency-fixture"

        store.openRepository()
        try await waitUntil { store.consistencyReport != nil }

        XCTAssertEqual(store.tokenizerPhase, .idle)
        XCTAssertTrue(store.consistencyReport?.findings.contains { $0.id == "vocab-mismatch" } == true)
        XCTAssertTrue(store.consistencyReport?.findings.contains { $0.id == "missing-chat-template" } == true)
        XCTAssertFalse(store.consistencyReport?.findings.contains { $0.id.hasPrefix("gguf-") } == true)
        XCTAssertEqual(status(.gguf, in: try XCTUnwrap(store.consistencyReport)), .missing)
        let configReads = await access.readCount(for: "config.json")
        XCTAssertEqual(configReads, 1)
        let tokenizerReads = await access.readCount(for: "tokenizer.json")
        XCTAssertEqual(tokenizerReads, 1)
    }

    func testListedGGUFIsSkippedWithoutReadingWhenNotOpened() async throws {
        let fixture = try fixture(
            config: #"{"vocab_size":1}"#,
            tokenizer: tokenizerData(vocabCount: 1),
            includeGGUF: true
        )
        let access = ConsistencyAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/consistency-fixture"

        store.openRepository()
        try await waitUntil { store.consistencyReport != nil }

        XCTAssertEqual(status(.gguf, in: try XCTUnwrap(store.consistencyReport)), .skipped("未在当前会话打开"))
        let ggufReads = await access.readCount(for: "model.gguf")
        XCTAssertEqual(ggufReads, 0)
    }

    func testMalformedSingleMaterialStillPublishesReportWithFailedCoverage() async throws {
        let fixture = try fixture(config: "{", tokenizer: tokenizerData(vocabCount: 1))
        let access = ConsistencyAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/consistency-fixture"

        store.openRepository()
        try await waitUntil { store.consistencyReport != nil }

        guard case let .failed(message) = status(.config, in: try XCTUnwrap(store.consistencyReport)) else {
            return XCTFail("Expected failed config coverage.")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertNotNil(store.consistencyReport)
    }

    func testOldConsistencyTaskCannotPublishAfterRepositorySwitch() async throws {
        let first = try fixture(config: #"{"vocab_size":2}"#, tokenizer: tokenizerData(vocabCount: 1))
        let second = try fixture(config: #"{"vocab_size":1}"#, tokenizer: tokenizerData(vocabCount: 1))
        let firstAccess = ConsistencyAccess(
            data: first.data,
            files: first.files,
            root: "/tmp/consistency-first",
            delay: .milliseconds(250)
        )
        let secondAccess = ConsistencyAccess(
            data: second.data,
            files: second.files,
            root: "/tmp/consistency-second"
        )
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { location in
            location.canonicalInput == "/tmp/consistency-second" ? secondAccess : firstAccess
        }))

        store.repositoryInput = "/tmp/consistency-first"
        store.openRepository()
        try await waitUntil { store.snapshot != nil }
        store.repositoryInput = "/tmp/consistency-second"
        store.openRepository()
        try await waitUntil {
            store.snapshot?.location.canonicalInput == "/tmp/consistency-second"
                && store.consistencyReport != nil
        }

        try await Task.sleep(for: .milliseconds(600))
        XCTAssertNotNil(store.consistencyReport)
        XCTAssertFalse(
            store.consistencyReport?.findings.contains { $0.id == "vocab-mismatch" } == true,
            "findings=\(store.consistencyReport?.findings.map(\.id) ?? [])"
        )
    }

    func testInvalidJinjaMarksChatCoverageFailedWithoutKillingReport() async throws {
        let fixture = try fixture(config: #"{"vocab_size":1}"#, tokenizer: tokenizerData(vocabCount: 1))
        let invalidJinja = Data([0xFF, 0xFE])
        var data = fixture.data
        data["chat_template.jinja"] = invalidJinja
        var files = fixture.files
        files.append(file("chat_template.jinja", invalidJinja, category: .templates))
        let access = ConsistencyAccess(data: data, files: files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/consistency-fixture"

        store.openRepository()
        try await waitUntil { store.consistencyReport != nil }

        guard case let .failed(message) = status(.chatTemplates, in: try XCTUnwrap(store.consistencyReport)) else {
            return XCTFail("Expected failed chat template coverage.")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertNotNil(store.consistencyReport)
    }

    func testOpeningGGUFRefreshesReportUsingOnlyTheSelectedFileRead() async throws {
        let gguf = ggufData(contextLength: 2_048, vocabDimension: 2)
        let fixture = try fixture(
            config: #"{"vocab_size":1,"max_position_embeddings":4096}"#,
            tokenizer: tokenizerData(vocabCount: 1),
            gguf: gguf
        )
        let access = ConsistencyAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/consistency-fixture"

        store.openRepository()
        try await waitUntil { store.consistencyReport != nil }
        XCTAssertEqual(
            status(.gguf, in: try XCTUnwrap(store.consistencyReport)),
            .skipped("未在当前会话打开")
        )
        let initialGGUFReads = await access.readCount(for: "model.gguf")
        XCTAssertEqual(initialGGUFReads, 0)

        store.select(path: "model.gguf")
        try await waitUntil {
            self.status(.gguf, in: store.consistencyReport) == .checked
                && store.consistencyReport?.findings.contains {
                    $0.id == "gguf-context-mismatch"
                } == true
        }
        XCTAssertTrue(
            store.consistencyReport?.findings.contains { $0.id == "gguf-vocab-mismatch" } == true
        )
        let selectedFileReads = await access.readCount(for: "model.gguf")
        XCTAssertGreaterThan(selectedFileReads, 0)
        try await Task.sleep(for: .milliseconds(150))
        let readsAfterRefresh = await access.readCount(for: "model.gguf")
        XCTAssertEqual(readsAfterRefresh, selectedFileReads)

        store.openRepository()
        XCTAssertNil(store.consistencyReport)
    }

    private func status(
        _ kind: ConsistencyMaterialKind,
        in report: RepositoryConsistencyReport?
    ) -> ConsistencyCoverageStatus? {
        report?.coverage.first { $0.material == kind }?.status
    }

    private func fixture(
        config: String,
        tokenizer: Data,
        includeGGUF: Bool = false,
        gguf: Data? = nil
    ) throws -> (data: [String: Data], files: [RepositoryFile]) {
        let configData = Data(config.utf8)
        var data = [
            "config.json": configData,
            "tokenizer.json": tokenizer,
        ]
        var files = [
            file("config.json", configData, category: .configuration),
            file("tokenizer.json", tokenizer, category: .tokenizer),
        ]
        if includeGGUF || gguf != nil {
            let gguf = gguf ?? Data("GGUF".utf8)
            data["model.gguf"] = gguf
            files.append(file("model.gguf", gguf, category: .weights))
        }
        return (data, files)
    }

    private func tokenizerData(vocabCount: Int) -> Data {
        let vocab = Dictionary(uniqueKeysWithValues: (0..<vocabCount).map { ("token\($0)", $0) })
        return try! JSONSerialization.data(withJSONObject: ["model": ["vocab": vocab]])
    }

    private func tokenizerOverview(vocabCount: Int) -> TokenizerOverview {
        TokenizerOverview(
            version: "1.0",
            modelType: "BPE",
            vocabCount: vocabCount,
            mergeCount: nil,
            addedTokenCount: 0,
            addedTokens: [],
            vocabularyAnalysis: nil,
            fields: []
        )
    }

    private func ggufData(contextLength: UInt32, vocabDimension: UInt64) -> Data {
        var data = Data("GGUF".utf8)
        append(3, bytes: 4, to: &data)
        append(1, bytes: 8, to: &data)
        append(2, bytes: 8, to: &data)
        appendMetadataString("general.architecture", "llama", to: &data)
        appendString("llama.context_length", to: &data)
        append(4, bytes: 4, to: &data)
        append(UInt64(contextLength), bytes: 4, to: &data)
        appendString("token_embd.weight", to: &data)
        append(2, bytes: 4, to: &data)
        append(vocabDimension, bytes: 8, to: &data)
        append(8, bytes: 8, to: &data)
        append(0, bytes: 4, to: &data)
        append(0, bytes: 8, to: &data)
        return data
    }

    private func appendMetadataString(_ key: String, _ value: String, to data: inout Data) {
        appendString(key, to: &data)
        append(8, bytes: 4, to: &data)
        appendString(value, to: &data)
    }

    private func appendString(_ value: String, to data: inout Data) {
        let bytes = Data(value.utf8)
        append(UInt64(bytes.count), bytes: 8, to: &data)
        data.append(bytes)
    }

    private func append(_ value: UInt64, bytes: Int, to data: inout Data) {
        for index in 0..<bytes {
            data.append(UInt8(truncatingIfNeeded: value >> UInt64(index * 8)))
        }
    }

    private func file(_ path: String, _ data: Data, category: FileCategory) -> RepositoryFile {
        RepositoryFile(path: path, size: Int64(data.count), revision: "fixture", contentHash: path, category: category)
    }

    private func waitUntil(
        timeout: Duration = .seconds(3),
        condition: @escaping @MainActor () -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition() {
            guard clock.now < deadline else { return XCTFail("Timed out waiting for state") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

private actor ConsistencyAccess: RepositoryAccess {
    nonisolated let location: RepositoryLocation
    private let data: [String: Data]
    private let files: [RepositoryFile]
    private var reads: [String: Int] = [:]
    private let delay: Duration?

    init(
        data: [String: Data],
        files: [RepositoryFile],
        root: String = "/tmp/consistency-fixture",
        delay: Duration? = nil
    ) {
        self.data = data
        self.files = files
        location = .local(root: URL(fileURLWithPath: root, isDirectory: true))
        self.delay = delay
    }

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: files)
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        reads[file.path, default: 0] += 1
        if let delay {
            do { try await Task.sleep(for: delay) } catch { }
        }
        guard let data = data[file.path] else { throw RepositoryService.ServiceError.invalidResponse }
        guard let range else { return data }
        guard range.lowerBound < UInt64(data.count) else { return Data() }
        let upperBound = min(range.upperBound, UInt64(data.count - 1))
        return data.subdata(in: Int(range.lowerBound)..<Int(upperBound + 1))
    }

    func readCount(for path: String) -> Int { reads[path, default: 0] }
}
