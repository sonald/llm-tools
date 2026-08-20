import Foundation
import XCTest
@testable import ModelFiles

@MainActor
final class ModelFilesStoreTokenizerTests: XCTestCase {
    func testPlaygroundInputModesKeepRawChatAndAlwaysExposeTokenIDs() {
        XCTAssertEqual(
            TokenizerPlaygroundView.InputMode.allCases.map(\.rawValue),
            ["raw", "chat", "tokenIDs"]
        )
        XCTAssertEqual(
            TokenizerPlaygroundView.InputMode.allCases.map(\.title),
            ["原始文本", "Chat 对话", "Token IDs"]
        )
    }

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
        XCTAssertEqual(store.tokenizerChatCatalog?.activeEntry?.body, "JINJA_TEMPLATE")

        store.tokenize("offline")
        store.tokenize("path")
        try await waitUntil { store.tokenizationResult?.input == "path" }

        XCTAssertEqual(store.tokenizationResult?.tokenIDs, [22])
        XCTAssertEqual(store.tokenizationResult?.input, "path")
        XCTAssertNil(store.tokenizationResult?.overhead)
        XCTAssertNil(store.tokenizationResult?.roles)
    }

    func testChatEncodePublishesApproximateOverheadWithoutReplacingMainResult() async throws {
        let fixture = try fixtureData()
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }

        let staleRequest = TokenizerEncodeRequest(
            text: "offline",
            chatAttribution: ChatAttributionSeed(
                messages: [TemplateMessage(role: "user", content: "offline")]
            )
        )
        let request = TokenizerEncodeRequest(
            text: "path",
            chatAttribution: ChatAttributionSeed(
                messages: [TemplateMessage(role: "user", content: "path")]
            )
        )
        store.tokenize(staleRequest)
        store.tokenize(request)
        try await waitUntil { store.tokenizationResult?.overhead != nil }

        XCTAssertEqual(store.tokenizationResult?.input, "path")
        XCTAssertEqual(store.tokenizationResult?.tokenIDs, [22])
        XCTAssertEqual(store.tokenizationResult?.overhead?.contentProbe, "path")
        XCTAssertEqual(store.tokenizationResult?.overhead?.templateCount, 0)
        XCTAssertTrue(store.tokenizationResult?.overhead?.isApproximate == true)
        XCTAssertEqual(store.tokenizationResult?.roles, [.user])
        XCTAssertEqual(store.tokenizationResult?.roles?.count, store.tokenizationResult?.tokenIDs.count)
    }

    func testChatAttributionSeedSurvivesRuntimeLoading() async throws {
        let fixture = try fixtureData()
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        let request = TokenizerEncodeRequest(
            text: "path",
            chatAttribution: ChatAttributionSeed(
                messages: [TemplateMessage(role: "user", content: "path")]
            )
        )
        store.tokenize(request)

        try await waitUntil { store.tokenizationResult?.overhead != nil }
        XCTAssertEqual(store.tokenizationResult?.input, "path")
        XCTAssertEqual(store.tokenizationResult?.overhead?.contentCount, 1)
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
        XCTAssertNil(store.tokenizerChatCatalog)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(store.tokenizationResult)
    }

    func testDecodeTokenIDsPublishesLatestValidResultAndParserErrors() async throws {
        let fixture = try fixtureData()
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }

        store.decodeTokenIDs("15, 22")
        try await waitUntil { store.tokenizationResult?.direction == .decode }
        XCTAssertEqual(store.tokenizationResult?.tokenIDs, [15, 22])

        store.decodeTokenIDs("[15, 22]")
        try await waitUntil { store.tokenizationResult?.direction == .decode }
        XCTAssertEqual(store.tokenizationResult?.tokenIDs, [15, 22])

        store.decodeTokenIDs("22")
        try await waitUntil { store.tokenizationResult?.direction == .decode }

        XCTAssertEqual(store.tokenizationResult?.tokenIDs, [22])
        XCTAssertEqual(store.tokenizationResult?.decodedText, "path")

        store.decodeTokenIDs("15, nope")
        guard case let .failed(message) = store.tokenizerPhase else {
            return XCTFail("Expected parser failure.")
        }
        XCTAssertTrue(message.contains("index 1"))
        XCTAssertNil(store.tokenizationResult)

        store.tokenize("offline")
        store.tokenize("path")
        try await waitUntil { store.tokenizationResult?.direction == .encode }
        XCTAssertEqual(store.tokenizationResult?.input, "path")
        XCTAssertEqual(store.tokenizationResult?.tokenIDs, [22])

        let oversized = String(repeating: "1 ", count: TokenIDParser.maximumInputByteCount / 2 + 1)
        store.decodeTokenIDs(oversized)
        XCTAssertEqual(
            store.tokenizerPhase,
            .inputTooLarge(limit: TokenIDParser.maximumInputByteCount)
        )
    }

    func testTokenIDsRemainAvailableWithoutChatTemplate() async throws {
        let fixture = try fixtureData(
            includesConfigTemplate: true,
            includesJinjaTemplate: false,
            configChatTemplateObject: ["default": " ", "tool_use": "\n"]
        )
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }

        XCTAssertEqual(store.tokenizerChatCatalog?.isAvailable, false)
        store.decodeTokenIDs("22")
        try await waitUntil { store.tokenizationResult?.direction == .decode }
        XCTAssertEqual(store.tokenizationResult?.tokenIDs, [22])
        XCTAssertEqual(store.tokenizationResult?.decodedText, "path")
    }

    func testOnlyJinjaTemplateBuildsAvailableCatalog() async throws {
        let fixture = try fixtureData(includesConfigTemplate: false, includesJinjaTemplate: true)
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }

        XCTAssertEqual(store.tokenizerChatCatalog?.activeEntry?.source, .jinjaFile)
        XCTAssertEqual(store.tokenizerChatCatalog?.activeEntry?.body, "JINJA_TEMPLATE")
        XCTAssertFalse(store.tokenizerChatCatalog?.conflict == true)
    }

    func testNamedConfigTemplateBuildsAvailableCatalogWithoutJinja() async throws {
        let fixture = try fixtureData(
            includesConfigTemplate: true,
            includesJinjaTemplate: false,
            configChatTemplateObject: ["default": "CONFIG", "tool_use": "TOOL"]
        )
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }

        XCTAssertEqual(store.tokenizerChatCatalog?.activeEntry?.id, "tokenizerConfig:default")
        XCTAssertEqual(store.tokenizerChatCatalog?.activeEntry?.body, "CONFIG")
        XCTAssertFalse(store.tokenizerChatCatalog?.conflict == true)
    }

    func testBothSourcesDefaultToJinjaAndSwitchWithoutReloadingBundle() async throws {
        let fixture = try fixtureData(
            includesConfigTemplate: true,
            includesJinjaTemplate: true,
            configChatTemplateObject: [
                "default": "CONFIG {{ messages[0].content }}",
                "tool_use": "TOOL {{ messages[0].content }}",
            ],
            jinjaTemplate: "JINJA {{ messages[0].content }}"
        )
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }

        XCTAssertEqual(store.tokenizerChatCatalog?.activeEntry?.source, .jinjaFile)
        XCTAssertTrue(store.tokenizerChatCatalog?.conflict == true)
        let readCount = await access.readCount()
        let messages = [TemplateMessage(role: "user", content: "hello")]
        let request = TemplateRenderRequest(
            template: store.tokenizerChatCatalog!.activeEntry!.body,
            messages: messages,
            includeTools: false,
            tools: [],
            variables: [],
            addGenerationPrompt: false
        )
        let jinjaOutput = TemplateRenderer.render(request).output

        store.selectChatTemplate(id: "tokenizerConfig:tool_use")
        XCTAssertEqual(store.tokenizerChatCatalog?.activeEntry?.id, "tokenizerConfig:tool_use")
        let switchedReadCount = await access.readCount()
        XCTAssertEqual(switchedReadCount, readCount)
        let switchedRequest = TemplateRenderRequest(
            template: store.tokenizerChatCatalog!.activeEntry!.body,
            messages: messages,
            includeTools: false,
            tools: [],
            variables: [],
            addGenerationPrompt: false
        )
        XCTAssertNotEqual(jinjaOutput, TemplateRenderer.render(switchedRequest).output)
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
        includesOtherFile: Bool = false,
        includesConfigTemplate: Bool = true,
        includesJinjaTemplate: Bool = true,
        configChatTemplateObject: [String: String]? = nil,
        jinjaTemplate: String = "JINJA_TEMPLATE"
    ) throws -> (data: [String: Data], files: [RepositoryFile]) {
        let directory = Bundle.module.resourceURL!
            .appending(path: "Fixtures/Tokenizers/bpe", directoryHint: .isDirectory)
        let tokenizer = try Data(contentsOf: directory.appending(path: "tokenizer.json"))
        var configObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: directory.appending(path: "tokenizer_config.json")))
                as? [String: Any]
        )
        if includesConfigTemplate {
            if let configChatTemplateObject {
                configObject["chat_template"] = configChatTemplateObject
            } else {
                configObject["chat_template"] = "CONFIG_TEMPLATE"
            }
        } else {
            configObject.removeValue(forKey: "chat_template")
        }
        let config = try JSONSerialization.data(withJSONObject: configObject, options: [.sortedKeys])
        var data = [
            "tokenizer.json": tokenizer,
            "tokenizer_config.json": config,
        ]
        var files = [
            file("tokenizer.json", data: tokenizer, category: .tokenizer),
            file("tokenizer_config.json", data: config, category: .tokenizer),
        ]
        if includesJinjaTemplate {
            let template = Data(jinjaTemplate.utf8)
            data["chat_template.jinja"] = template
            files.append(file("chat_template.jinja", data: template, category: .templates))
        }
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
    private var reads = 0

    init(data: [String: Data], files: [RepositoryFile]) {
        self.data = data
        self.files = files
    }

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: files)
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        reads += 1
        guard range == nil, let data = data[file.path] else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        return data
    }

    func readCount() -> Int { reads }
}
