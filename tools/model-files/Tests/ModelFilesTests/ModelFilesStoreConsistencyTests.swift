import Foundation
import XCTest
@testable import ModelFiles

@MainActor
final class ModelFilesStoreConsistencyTests: XCTestCase {
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

    private func status(
        _ kind: ConsistencyMaterialKind,
        in report: RepositoryConsistencyReport
    ) -> ConsistencyCoverageStatus? {
        report.coverage.first { $0.material == kind }?.status
    }

    private func fixture(
        config: String,
        tokenizer: Data,
        includeGGUF: Bool = false
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
        if includeGGUF {
            let gguf = Data("GGUF".utf8)
            data["model.gguf"] = gguf
            files.append(file("model.gguf", gguf, category: .weights))
        }
        return (data, files)
    }

    private func tokenizerData(vocabCount: Int) -> Data {
        let vocab = Dictionary(uniqueKeysWithValues: (0..<vocabCount).map { ("token\($0)", $0) })
        return try! JSONSerialization.data(withJSONObject: ["model": ["vocab": vocab]])
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
        guard range == nil, let data = data[file.path] else { throw RepositoryService.ServiceError.invalidResponse }
        return data
    }

    func readCount(for path: String) -> Int { reads[path, default: 0] }
}
