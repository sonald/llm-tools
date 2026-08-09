import Foundation
import XCTest
@testable import ModelFiles

final class TokenizerCompatibilityTests: XCTestCase {
    func testBoundedInputBenchmarkCorpus() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle())

        for kibibytes in [8, 64, 256] {
            let input = String(repeating: "offline ", count: kibibytes * 128)
            let start = ContinuousClock.now
            let result = await runtime.tokenize(input)
            let elapsed = start.duration(to: .now)

            XCTAssertEqual(input.utf8.count, kibibytes * 1_024)
            XCTAssertEqual(result.tokenCount, kibibytes * 128)
            XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
            print("TOKENIZER_BENCHMARK input=\(kibibytes)KiB tokens=\(result.tokenCount) elapsed=\(elapsed)")
        }
    }

    func testRealTokenizerBenchmarkWhenDirectoryIsProvided() async throws {
        guard let path = ProcessInfo.processInfo.environment["MODELFILES_REAL_TOKENIZER_DIR"] else {
            throw XCTSkip("Set MODELFILES_REAL_TOKENIZER_DIR for the non-CI real-tokenizer benchmark.")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        let tokenizerData = try Data(contentsOf: directory.appending(path: "tokenizer.json"))
        let configData = try Data(contentsOf: directory.appending(path: "tokenizer_config.json"))
        let bundle = TokenizerBundle(
            file: RepositoryFile(
                path: "tokenizer.json",
                size: Int64(tokenizerData.count),
                revision: "real-benchmark",
                contentHash: nil,
                category: .tokenizer
            ),
            tokenizerData: tokenizerData,
            tokenizerConfigData: configData,
            chatTemplateData: nil
        )

        let loadStart = ContinuousClock.now
        let runtime = try TokenizerRuntime(bundle: bundle)
        let loadElapsed = loadStart.duration(to: .now)
        print(
            "REAL_TOKENIZER_BENCHMARK bundle=\(tokenizerData.count + configData.count)bytes load=\(loadElapsed)"
        )

        for kibibytes in [8, 64, 256] {
            let input = String(repeating: "Hello世", count: kibibytes * 128)
            let start = ContinuousClock.now
            let result = await runtime.tokenize(input)
            let elapsed = start.duration(to: .now)

            XCTAssertEqual(input.utf8.count, kibibytes * 1_024)
            XCTAssertFalse(result.tokenIDs.isEmpty)
            XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
            print(
                "REAL_TOKENIZER_BENCHMARK input=\(kibibytes)KiB tokens=\(result.tokenCount) elapsed=\(elapsed)"
            )
        }
    }

    private func fixtureBundle() throws -> TokenizerBundle {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "Fixtures/Tokenizers/bpe", directoryHint: .isDirectory)
        let tokenizerData = try Data(contentsOf: directory.appending(path: "tokenizer.json"))
        let configData = try Data(contentsOf: directory.appending(path: "tokenizer_config.json"))
        return TokenizerBundle(
            file: RepositoryFile(
                path: "tokenizer.json",
                size: Int64(tokenizerData.count),
                revision: "fixture",
                contentHash: "fixture",
                category: .tokenizer
            ),
            tokenizerData: tokenizerData,
            tokenizerConfigData: configData,
            chatTemplateData: nil
        )
    }
}
