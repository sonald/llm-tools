import Foundation
import XCTest
@testable import ModelFiles

@MainActor
final class ModelFilesStoreTokenizerTests: XCTestCase {
    func testComparisonSummaryCoversEqualDifferencePrefixAndEmptySides() {
        let equal = TokenizerComparisonSummary(leftIDs: [1, 2], rightIDs: [1, 2])
        XCTAssertEqual(equal.countDelta, 0)
        XCTAssertTrue(equal.idsMatch)
        XCTAssertNil(equal.firstDifference)

        let difference = TokenizerComparisonSummary(leftIDs: [1, 2, 3], rightIDs: [1, 4, 3, 5])
        XCTAssertEqual(difference.countDelta, 1)
        XCTAssertFalse(difference.idsMatch)
        XCTAssertEqual(difference.firstDifference, 1)
        XCTAssertEqual(difference.leftID, 2)
        XCTAssertEqual(difference.rightID, 4)

        let prefix = TokenizerComparisonSummary(leftIDs: [1, 2], rightIDs: [1, 2, 3])
        XCTAssertEqual(prefix.firstDifference, 2)
        XCTAssertNil(prefix.leftID)
        XCTAssertEqual(prefix.rightID, 3)

        let empty = TokenizerComparisonSummary(leftIDs: [], rightIDs: [7])
        XCTAssertEqual(empty.countDelta, 1)
        XCTAssertEqual(empty.firstDifference, 0)
    }

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

    func testExplicitTokenizerClassRetryUsesCachedBundleAndClearsOnFileSwitch() async throws {
        let fixture = try fixtureData(includesOtherFile: true, includesTokenizerClass: false)
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil {
            if case .recoverableTokenizerClassFailure = store.tokenizerPhase { return true }
            return false
        }
        let initialReadCount = await access.readCount()
        XCTAssertNil(store.tokenizerClassOverride)

        store.setTokenizerClassOverride("NotARealTokenizer")
        try await waitUntil {
            if case let .recoverableTokenizerClassFailure(message) = store.tokenizerPhase {
                return message.contains("NotARealTokenizer")
            }
            return false
        }
        XCTAssertEqual(store.tokenizerClassOverride, "NotARealTokenizer")
        let failedRetryReadCount = await access.readCount()
        XCTAssertEqual(failedRetryReadCount, initialReadCount)

        store.setTokenizerClassOverride("GPT2Tokenizer")
        try await waitUntil { store.tokenizerPhase == .ready }
        XCTAssertEqual(store.tokenizerClassOverride, "GPT2Tokenizer")
        let successfulRetryReadCount = await access.readCount()
        XCTAssertEqual(successfulRetryReadCount, initialReadCount)

        store.select(path: "notes.txt")
        XCTAssertNil(store.tokenizerClassOverride)
    }

    func testRetryDoesNotBypassFailedChatCatalogParsing() async throws {
        let fixture = try fixtureData(
            includesJinjaTemplate: false,
            invalidConfigChatTemplate: true
        )
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil {
            if case .failed = store.tokenizerPhase { return true }
            return false
        }
        XCTAssertNil(store.tokenizerChatCatalog)
        let initialReadCount = await access.readCount()

        store.retryTokenizerPlayground()
        XCTAssertEqual(store.tokenizerPhase, .loading)
        try await waitUntil {
            if case .failed = store.tokenizerPhase { return true }
            return false
        }
        XCTAssertNotEqual(store.tokenizerPhase, .ready)
        let retryReadCount = await access.readCount()
        XCTAssertGreaterThan(retryReadCount, initialReadCount)
    }

    func testOrdinaryRuntimeRetryReloadsBundleBytes() async throws {
        var fixture = try fixtureData()
        fixture.data["tokenizer.json"] = Data("{".utf8)
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil {
            if case .failed = store.tokenizerPhase { return true }
            return false
        }
        XCTAssertNotNil(store.tokenizerChatCatalog)
        let initialReadCount = await access.readCount()

        store.retryTokenizerPlayground()
        XCTAssertEqual(store.tokenizerPhase, .loading)
        try await waitUntil {
            if case .failed = store.tokenizerPhase { return true }
            return false
        }
        let retryReadCount = await access.readCount()
        XCTAssertGreaterThan(retryReadCount, initialReadCount)
    }

    func testComparisonUsesSecondSnapshotEntryAndSharedLatestInput() async throws {
        let fixture = try comparisonFixtureData()
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }
        store.tokenize("offline")
        try await waitUntil { store.tokenizationResult?.input == "offline" }
        let selectedPath = store.selectedPath

        store.setComparisonSource(.snapshotPath("alternate/tokenizer.json"))
        try await waitUntil {
            store.comparison?.phase == .ready
                && store.comparison?.right?.input == "offline"
        }

        XCTAssertEqual(store.selectedPath, selectedPath)
        XCTAssertEqual(store.comparison?.left, store.tokenizationResult)
        XCTAssertEqual(store.comparison?.rightIdentity?.path, "alternate/tokenizer.json")

        store.tokenize("path")
        try await waitUntil {
            store.comparison?.left?.input == "path"
                && store.comparison?.right?.input == "path"
        }
        XCTAssertEqual(store.selectedPath, selectedPath)

        store.retryTokenizerPlayground()
        XCTAssertNil(store.tokenizationResult)
        XCTAssertNil(store.comparison?.left)
        XCTAssertNil(store.comparison?.right)
        try await waitUntil {
            store.tokenizerPhase == .ready
                && store.comparison?.right?.input == "path"
        }

        store.decodeTokenIDs("not-an-id")
        XCTAssertNil(store.tokenizationResult)
        XCTAssertNil(store.comparison?.left)
        XCTAssertNil(store.comparison?.right)

        store.setComparisonSource(nil)
        XCTAssertNil(store.comparison)
    }

    func testComparisonChatRendersRightCatalogAndComputesRightOverhead() async throws {
        var fixture = try comparisonFixtureData()
        fixture.data["chat_template.jinja"] = Data("ROOT {{ messages[0].content }}".utf8)
        var alternateConfig = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(fixture.data["alternate/tokenizer_config.json"]))
                as? [String: Any]
        )
        alternateConfig["chat_template"] = [
            "default": "ALT {{ messages[0].content }}",
            "verbose": "VERBOSE {{ messages[0].content }} verbose verbose verbose verbose",
        ]
        let updatedAlternateConfig = try JSONSerialization.data(
            withJSONObject: alternateConfig
        )
        fixture.data["alternate/tokenizer_config.json"] = updatedAlternateConfig
        fixture.files = fixture.files.map { file in
            guard file.path == "alternate/tokenizer_config.json" else { return file }
            return RepositoryFile(
                path: file.path,
                size: Int64(updatedAlternateConfig.count),
                revision: "alternate-updated",
                contentHash: "alternate-template-updated",
                category: file.category
            )
        }
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }

        let seed = ChatAttributionSeed(
            messages: [TemplateMessage(role: "user", content: "hello")],
            addGenerationPrompt: false
        )
        store.tokenize(TokenizerEncodeRequest(text: "ROOT hello", chatAttribution: seed))
        try await waitUntil { store.tokenizationResult?.overhead != nil }
        store.setComparisonSource(.snapshotPath("alternate/tokenizer.json"))
        try await waitUntil { store.comparison?.phase == .ready && store.comparison?.right != nil }

        XCTAssertEqual(store.comparison?.right?.input, "ALT hello")
        XCTAssertNotEqual(store.comparison?.left?.input, store.comparison?.right?.input)
        XCTAssertEqual(store.comparison?.right?.overhead?.contentProbe, "hello")
        XCTAssertEqual(
            store.comparison?.right?.overhead?.totalCount,
            store.comparison?.right?.tokenCount
        )
        let leftInput = store.comparison?.left?.input
        let leftCount = store.comparison?.left?.tokenCount
        let defaultRightCount = store.comparison?.right?.tokenCount

        store.selectComparisonChatTemplate(id: "tokenizerConfig:verbose")
        try await waitUntil {
            store.comparison?.phase == .ready
                && store.comparison?.right?.input.hasPrefix("VERBOSE hello") == true
        }
        XCTAssertEqual(store.comparison?.left?.input, leftInput)
        XCTAssertEqual(store.comparison?.left?.tokenCount, leftCount)
        XCTAssertNotEqual(store.comparison?.right?.tokenCount, defaultRightCount)
    }

    func testComparisonFailureDoesNotReplaceMainResult() async throws {
        let fixture = try comparisonFixtureData()
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }
        store.tokenize("offline")
        try await waitUntil { store.tokenizationResult?.input == "offline" }
        let mainResult = store.tokenizationResult
        let selectedPath = store.selectedPath

        store.setComparisonSource(.snapshotPath("bad/tokenizer.json"))
        try await waitUntil {
            if case .failed = store.comparison?.phase { return true }
            return false
        }

        XCTAssertEqual(store.tokenizerPhase, .ready)
        XCTAssertEqual(store.tokenizationResult, mainResult)
        XCTAssertEqual(store.selectedPath, selectedPath)
        XCTAssertNil(store.comparison?.right)

        store.select(path: "tokenizer_config.json")
        XCTAssertNil(store.comparison)
    }

    func testComparisonMissingChatTemplateRecoversWhenMainInputBecomesRaw() async throws {
        var fixture = try comparisonFixtureData()
        var alternateConfig = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(fixture.data["alternate/tokenizer_config.json"]))
                as? [String: Any]
        )
        alternateConfig.removeValue(forKey: "chat_template")
        fixture.data["alternate/tokenizer_config.json"] = try JSONSerialization.data(
            withJSONObject: alternateConfig
        )
        let access = StoreTokenizerAccess(data: fixture.data, files: fixture.files)
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }
        let seed = ChatAttributionSeed(
            messages: [TemplateMessage(role: "user", content: "hello")],
            addGenerationPrompt: false
        )
        store.tokenize(TokenizerEncodeRequest(text: "ROOT hello", chatAttribution: seed))
        try await waitUntil { store.tokenizationResult?.overhead != nil }
        let selectedPath = store.selectedPath

        store.setComparisonSource(.snapshotPath("alternate/tokenizer.json"))
        try await waitUntil {
            if case .failed = store.comparison?.phase { return true }
            return false
        }
        store.tokenize("offline")
        try await waitUntil {
            store.comparison?.phase == .ready
                && store.comparison?.right?.input == "offline"
        }

        XCTAssertEqual(store.selectedPath, selectedPath)
        XCTAssertEqual(store.comparison?.right?.input, "offline")
    }

    func testComparisonLatestTargetWinsWhenOldLoadIsCancelled() async throws {
        let fixture = try comparisonFixtureData()
        let access = StoreTokenizerAccess(
            data: fixture.data,
            files: fixture.files,
            delays: ["slow/tokenizer.json": .milliseconds(250)]
        )
        let store = ModelFilesStore(service: RepositoryService(makeAccess: { _ in access }))
        store.repositoryInput = "/tmp/tokenizer-store-fixture"

        store.openRepository()
        try await waitUntil { store.selectedInspection != nil }
        store.perspective = .playground
        try await waitUntil { store.tokenizerPhase == .ready }
        store.tokenize("offline")
        try await waitUntil { store.tokenizationResult?.input == "offline" }

        store.setComparisonSource(.snapshotPath("slow/tokenizer.json"))
        store.setComparisonSource(.snapshotPath("alternate/tokenizer.json"))
        try await waitUntil {
            store.comparison?.phase == .ready
                && store.comparison?.rightIdentity?.path == "alternate/tokenizer.json"
        }
        try await Task.sleep(for: .milliseconds(350))

        XCTAssertEqual(store.comparison?.rightIdentity?.path, "alternate/tokenizer.json")
        XCTAssertEqual(store.comparison?.right?.input, "offline")
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
        includesTokenizerClass: Bool = true,
        invalidConfigChatTemplate: Bool = false,
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
        if !includesTokenizerClass {
            configObject.removeValue(forKey: "tokenizer_class")
        }
        if invalidConfigChatTemplate {
            configObject["chat_template"] = 42
        } else if includesConfigTemplate {
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

    private func comparisonFixtureData() throws -> (data: [String: Data], files: [RepositoryFile]) {
        var fixture = try fixtureData()
        let tokenizer = try XCTUnwrap(fixture.data["tokenizer.json"])
        let config = try XCTUnwrap(fixture.data["tokenizer_config.json"])
        for directory in ["alternate", "slow"] {
            let tokenizerPath = "\(directory)/tokenizer.json"
            let configPath = "\(directory)/tokenizer_config.json"
            fixture.data[tokenizerPath] = tokenizer
            fixture.data[configPath] = config
            fixture.files.append(file(tokenizerPath, data: tokenizer, category: .tokenizer))
            fixture.files.append(file(configPath, data: config, category: .tokenizer))
        }
        let badTokenizer = Data("{".utf8)
        fixture.data["bad/tokenizer.json"] = badTokenizer
        fixture.data["bad/tokenizer_config.json"] = config
        fixture.files.append(file("bad/tokenizer.json", data: badTokenizer, category: .tokenizer))
        fixture.files.append(file("bad/tokenizer_config.json", data: config, category: .tokenizer))
        return fixture
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
    private let delays: [String: Duration]
    private var reads = 0

    init(
        data: [String: Data],
        files: [RepositoryFile],
        delays: [String: Duration] = [:]
    ) {
        self.data = data
        self.files = files
        self.delays = delays
    }

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: files)
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        reads += 1
        if let delay = delays[file.path] {
            try await Task.sleep(for: delay)
        }
        guard range == nil, let data = data[file.path] else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        return data
    }

    func readCount() -> Int { reads }
}
