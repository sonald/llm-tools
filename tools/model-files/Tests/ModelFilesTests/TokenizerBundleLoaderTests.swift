import Foundation
import XCTest
@testable import ModelFiles

final class TokenizerBundleLoaderTests: XCTestCase {
    func testUsesTheSameBundlePathForEveryRepositoryLocation() async throws {
        let locations: [RepositoryLocation] = [
            .huggingFace(modelID: "org/model"),
            .modelScope(modelID: "org/model"),
            .local(root: URL(fileURLWithPath: "/tmp/model")),
            .ssh(SSHLocation(user: "reader", host: "example.test", port: 22, rootPath: "/models/model")),
        ]
        let tokenizer = file("tokenizer.json", size: 9)

        for location in locations {
            let access = RecordingTokenizerAccess(
                data: ["tokenizer.json": Data("tokenizer".utf8)],
                location: location
            )
            let snapshot = RepositorySnapshot(location: location, version: .live, files: [tokenizer])

            let bundle = try await TokenizerBundleLoader().load(
                file: tokenizer,
                from: snapshot,
                access: access
            )

            XCTAssertEqual(bundle.tokenizerData, Data("tokenizer".utf8), location.title)
            let paths = await access.paths()
            XCTAssertEqual(paths, ["tokenizer.json"], location.title)
        }
    }

    func testLoadsOnlySameDirectoryTokenizerCompanions() async throws {
        let files = [
            file("nested/tokenizer.json", size: 9),
            file("nested/tokenizer_config.json", size: 6),
            file("nested/chat_template.jinja", size: 8, category: .templates),
            file("tokenizer_config.json", size: 11),
            file("model.safetensors", size: 1_000, category: .weights),
        ]
        let access = RecordingTokenizerAccess(data: [
            "nested/tokenizer.json": Data("tokenizer".utf8),
            "nested/tokenizer_config.json": Data("config".utf8),
            "nested/chat_template.jinja": Data("template".utf8),
            "tokenizer_config.json": Data("wrongconfig".utf8),
        ])
        let snapshot = RepositorySnapshot(location: access.location, version: .live, files: files)

        let bundle = try await TokenizerBundleLoader().load(
            file: files[0],
            from: snapshot,
            access: access
        )

        XCTAssertEqual(bundle.tokenizerData, Data("tokenizer".utf8))
        XCTAssertEqual(bundle.tokenizerConfigData, Data("config".utf8))
        XCTAssertEqual(bundle.chatTemplateData, Data("template".utf8))
        let paths = await access.paths()
        XCTAssertEqual(
            paths,
            ["nested/tokenizer.json", "nested/tokenizer_config.json", "nested/chat_template.jinja"]
        )
    }

    func testRootTokenizerDoesNotGuessNestedCompanions() async throws {
        let files = [
            file("tokenizer.json", size: 9),
            file("nested/tokenizer_config.json", size: 6),
            file("nested/chat_template.jinja", size: 8, category: .templates),
        ]
        let access = RecordingTokenizerAccess(data: ["tokenizer.json": Data("tokenizer".utf8)])
        let snapshot = RepositorySnapshot(location: access.location, version: .live, files: files)

        let bundle = try await TokenizerBundleLoader().load(
            file: files[0],
            from: snapshot,
            access: access
        )

        XCTAssertNil(bundle.tokenizerConfigData)
        XCTAssertNil(bundle.chatTemplateData)
        let paths = await access.paths()
        XCTAssertEqual(paths, ["tokenizer.json"])
    }

    func testLoadsSentencePieceModelWithSameDirectoryConfig() async throws {
        let files = [
            file("nested/tokenizer.model", size: 5),
            file("nested/tokenizer_config.json", size: 6),
        ]
        let access = RecordingTokenizerAccess(data: [
            "nested/tokenizer.model": Data("model".utf8),
            "nested/tokenizer_config.json": Data("config".utf8),
        ])

        let bundle = try await TokenizerBundleLoader().load(
            file: files[0],
            from: RepositorySnapshot(location: access.location, version: .live, files: files),
            access: access
        )

        XCTAssertEqual(bundle.tokenizerData, Data("model".utf8))
        XCTAssertEqual(bundle.tokenizerConfigData, Data("config".utf8))
        let paths = await access.paths()
        XCTAssertEqual(paths, ["nested/tokenizer.model", "nested/tokenizer_config.json"])
    }

    func testRejectsMissingSizeAndDeclaredBundleOverflowBeforeReading() async throws {
        let access = RecordingTokenizerAccess(data: [:])
        let missing = file("tokenizer.json", size: nil)
        let missingSnapshot = RepositorySnapshot(
            location: access.location,
            version: .live,
            files: [missing]
        )

        await XCTAssertThrowsErrorAsync(
            try await TokenizerBundleLoader(maximumBundleByteCount: 10).load(
                file: missing,
                from: missingSnapshot,
                access: access
            )
        ) { error in
            XCTAssertEqual(error as? TokenizerBundleLoader.LoaderError, .missingSize("tokenizer.json"))
        }

        let tokenizer = file("tokenizer.json", size: 7)
        let config = file("tokenizer_config.json", size: 4)
        let overflowSnapshot = RepositorySnapshot(
            location: access.location,
            version: .live,
            files: [tokenizer, config]
        )
        await XCTAssertThrowsErrorAsync(
            try await TokenizerBundleLoader(maximumBundleByteCount: 10).load(
                file: tokenizer,
                from: overflowSnapshot,
                access: access
            )
        ) { error in
            XCTAssertEqual(
                error as? TokenizerBundleLoader.LoaderError,
                .bundleTooLarge(size: 11, limit: 10)
            )
        }
        let paths = await access.paths()
        XCTAssertEqual(paths, [])
    }

    func testRejectsInvalidSelectionAndSingleFileOverflow() async throws {
        let access = RecordingTokenizerAccess(data: [:])
        let invalid = file("vocab.json", size: 1)
        let oversized = file("tokenizer.json", size: 11)

        await XCTAssertThrowsErrorAsync(
            try await TokenizerBundleLoader(maximumBundleByteCount: 10).load(
                file: invalid,
                from: RepositorySnapshot(location: access.location, version: .live, files: [invalid]),
                access: access
            )
        ) { error in
            XCTAssertEqual(error as? TokenizerBundleLoader.LoaderError, .invalidSelection("vocab.json"))
        }
        await XCTAssertThrowsErrorAsync(
            try await TokenizerBundleLoader(maximumBundleByteCount: 10).load(
                file: oversized,
                from: RepositorySnapshot(location: access.location, version: .live, files: [oversized]),
                access: access
            )
        ) { error in
            XCTAssertEqual(
                error as? TokenizerBundleLoader.LoaderError,
                .fileTooLarge(path: "tokenizer.json", size: 11, limit: 10)
            )
        }
        let paths = await access.paths()
        XCTAssertEqual(paths, [])
    }

    func testRejectsActualBytesBeyondDeclaredBundleLimit() async throws {
        let tokenizer = file("tokenizer.json", size: 4)
        let access = RecordingTokenizerAccess(data: ["tokenizer.json": Data(repeating: 0, count: 12)])
        let snapshot = RepositorySnapshot(
            location: access.location,
            version: .live,
            files: [tokenizer]
        )

        await XCTAssertThrowsErrorAsync(
            try await TokenizerBundleLoader(maximumBundleByteCount: 10).load(
                file: tokenizer,
                from: snapshot,
                access: access
            )
        ) { error in
            XCTAssertEqual(
                error as? TokenizerBundleLoader.LoaderError,
                .bundleTooLarge(size: 12, limit: 10)
            )
        }
    }

    func testPropagatesSnapshotChangeAndTaskCancellation() async throws {
        let tokenizer = file("tokenizer.json", size: 9)
        let location = RepositoryLocation.local(root: URL(fileURLWithPath: "/tmp/model"))
        let snapshot = RepositorySnapshot(location: location, version: .live, files: [tokenizer])

        await XCTAssertThrowsErrorAsync(
            try await TokenizerBundleLoader().load(
                file: tokenizer,
                from: snapshot,
                access: ChangedTokenizerAccess(location: location)
            )
        ) { error in
            guard case RepositoryService.ServiceError.fileChanged("tokenizer.json") = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }

        let access = SuspendedTokenizerAccess(location: location)
        let task = Task {
            try await TokenizerBundleLoader().load(file: tokenizer, from: snapshot, access: access)
        }
        await access.waitUntilReadStarted()
        task.cancel()
        await XCTAssertThrowsErrorAsync(try await task.value) { error in
            XCTAssertTrue(error is CancellationError, "Unexpected error: \(error)")
        }
    }

    private func file(
        _ path: String,
        size: Int64?,
        category: FileCategory = .tokenizer
    ) -> RepositoryFile {
        RepositoryFile(
            path: path,
            size: size,
            revision: "revision",
            contentHash: "hash",
            category: category
        )
    }
}

private actor RecordingTokenizerAccess: RepositoryAccess {
    nonisolated let location: RepositoryLocation
    private let data: [String: Data]
    private var requestedPaths: [String] = []

    init(
        data: [String: Data],
        location: RepositoryLocation = .local(
            root: URL(fileURLWithPath: "/tmp/model-files-tokenizer-access", isDirectory: true)
        )
    ) {
        self.data = data
        self.location = location
    }

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: [])
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        requestedPaths.append(file.path)
        guard range == nil, let data = data[file.path] else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        return data
    }

    func paths() -> [String] {
        requestedPaths
    }
}

private struct ChangedTokenizerAccess: RepositoryAccess {
    let location: RepositoryLocation

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: [])
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        throw RepositoryService.ServiceError.fileChanged(file.path)
    }
}

private actor SuspendedTokenizerAccess: RepositoryAccess {
    nonisolated let location: RepositoryLocation
    private var readStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []

    init(location: RepositoryLocation) {
        self.location = location
    }

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: [])
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        readStarted = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        try await Task.sleep(for: .seconds(10))
        return Data()
    }

    func waitUntilReadStarted() async {
        if readStarted { return }
        await withCheckedContinuation { continuation in
            startWaiters.append(continuation)
        }
    }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in }
) async {
    do {
        _ = try await expression()
        XCTFail("Expected expression to throw")
    } catch {
        errorHandler(error)
    }
}
