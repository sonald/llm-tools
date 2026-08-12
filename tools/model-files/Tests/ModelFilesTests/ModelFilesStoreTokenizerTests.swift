import Foundation
import XCTest
@testable import ModelFiles

@MainActor
final class ModelFilesStoreTokenizerTests: XCTestCase {
    func testTokenizerPerspectiveLoadsSessionAndPublishesLatestInputOnly() async throws {
        let fixture = try fixtureData()
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }

        XCTAssertEqual(store.selectedFile?.path, "tokenizer.json")
        XCTAssertEqual(store.availablePerspectives, [.overview, .fields, .raw, .playground])

        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }
        XCTAssertEqual(store.tokenizerChatTemplate, "JINJA_TEMPLATE")

        store.tokenize("offline")
        store.tokenize("path")
        try await waitUntil { store.tokenizationResult?.input == "path" }

        XCTAssertEqual(store.tokenizationResult?.tokenIDs, [22])
        XCTAssertEqual(store.tokenizationResult?.input, "path")
    }

    func testInputLimitAndSelectionChangeClearTokenizerState() async throws {
        let fixture = try fixtureData(includesOtherFile: true)
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }

        store.tokenize(String(repeating: "a", count: ModelFilesStore.maximumTokenizerInputByteCount + 1))
        XCTAssertEqual(
            store.tokenizerPhase,
            .inputTooLarge(limit: ModelFilesStore.maximumTokenizerInputByteCount)
        )
        XCTAssertNil(store.tokenizationResult)

        store.tokenize("offline")
        store.select(path: "notes.txt")
        XCTAssertEqual(store.tokenizerPhase, .idle)
        XCTAssertNil(store.tokenizationResult)
        XCTAssertNil(store.tokenizerChatTemplate)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(store.tokenizationResult)
    }

    func testSentencePieceModelOpensDirectlyInPlayground() async throws {
        let model = Data("invalid".utf8)
        let files = [file("tokenizer.model", data: model, category: .tokenizer)]
        let access = StoreTokenizerAccess(data: ["tokenizer.model": model], files: files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/sentencepiece-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }

        XCTAssertEqual(store.perspective, .playground)
        XCTAssertEqual(store.availablePerspectives, [.playground])
        try await waitUntil {
            if case .failed = store.tokenizerPhase { return true }
            return false
        }
    }

    private func fixtureData(
        includesOtherFile: Bool = false
    ) throws -> (data: [String: Data], files: [RepositoryFile]) {
        let directory = Bundle.module.resourceURL!
            .appending(path: "Fixtures/Tokenizers/bpe", directoryHint: .isDirectory)
        let tokenizer = try Data(contentsOf: directory.appending(path: "tokenizer.json"))
        var configObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: directory.appending(path: "tokenizer_config.json")))
                as? [String: Any]
        )
        configObject["chat_template"] = "CONFIG_TEMPLATE"
        let config = try JSONSerialization.data(withJSONObject: configObject, options: [.sortedKeys])
        let template = Data("JINJA_TEMPLATE".utf8)
        var data = [
            "tokenizer.json": tokenizer,
            "tokenizer_config.json": config,
            "chat_template.jinja": template,
        ]
        var files = [
            file("tokenizer.json", data: tokenizer, category: .tokenizer),
            file("tokenizer_config.json", data: config, category: .tokenizer),
            file("chat_template.jinja", data: template, category: .templates),
        ]
        if includesOtherFile {
            let notes = Data("notes".utf8)
            data["notes.txt"] = notes
            files.append(file("notes.txt", data: notes, category: .other))
        }
        return (data, files)
    }

    private func file(
        _ path: String,
        data: Data,
        category: FileCategory
    ) -> RepositoryFile {
        RepositoryFile(
            path: path,
            size: Int64(data.count),
            revision: "fixture",
            contentHash: path,
            category: category
        )
    }

    private func waitUntil(
        timeout: Duration = .seconds(3),
        condition: @escaping @MainActor () -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition() {
            guard clock.now < deadline else {
                return XCTFail("Timed out waiting for state")
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

private actor StoreTokenizerAccess: RepositoryAccess {
    nonisolated let location = RepositoryLocation.local(
        root: URL(fileURLWithPath: "/tmp/tokenizer-store-fixture", isDirectory: true)
    )
    private let data: [String: Data]
    private let files: [RepositoryFile]

    init(data: [String: Data], files: [RepositoryFile]) {
        self.data = data
        self.files = files
    }

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: files)
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        guard range == nil, let data = data[file.path] else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        return data
    }
}
