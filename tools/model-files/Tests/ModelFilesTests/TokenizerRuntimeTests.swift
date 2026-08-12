import Foundation
import XCTest
@testable import ModelFiles

final class TokenizerRuntimeTests: XCTestCase {
    func testStrictlyLoadsOfflineBPEAndReturnsStableIDs() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "bpe"))

        let result = await runtime.tokenize("offline path")

        XCTAssertEqual(result.input, "offline path")
        XCTAssertEqual(result.tokenIDs, [15, 22])
        XCTAssertEqual(result.tokenPieces, ["offline", "path"])
        XCTAssertEqual(result.decodedText, "offlinepath")
        XCTAssertEqual(result.sourceMapping, .decodedOnly)
        XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
    }

    func testStrictlyLoadsWordPieceAndPreservesSubwordIDs() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "wordpiece"))

        let result = await runtime.tokenize("Hello worlds 中文")

        XCTAssertEqual(result.tokenIDs, [3, 4, 5, 6, 7])
        XCTAssertEqual(result.tokenPieces, ["hello", "world", "##s", "中", "文"])
        XCTAssertEqual(result.decodedText, "hello worlds 中 文")
        XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
    }

    func testStrictlyLoadsUnigramAndUsesMetaspaceDecoder() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "unigram"))

        let result = await runtime.tokenize("hello world")

        XCTAssertEqual(result.tokenIDs, [2, 3])
        XCTAssertEqual(result.tokenPieces, ["▁hello", "▁world"])
        XCTAssertEqual(result.decodedText, "hello world")
        XCTAssertEqual(result.sourceMapping, .exact)
        XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
    }

    func testByteFallbackGroupsOneEmojiWithoutDroppingItsFourIDs() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "byte-fallback"))

        let result = await runtime.tokenize("😀x")

        XCTAssertEqual(result.tokenIDs, [1, 2, 3, 4, 5])
        XCTAssertEqual(result.tokenPieces, ["<0xF0>", "<0x9F>", "<0x98>", "<0x80>", "x"])
        XCTAssertEqual(result.decodedText, "😀x")
        XCTAssertEqual(result.sourceMapping, .exact)
        XCTAssertEqual(result.segments, [
            TokenSegment(tokenRange: 0..<5, tokenIDs: [1, 2, 3, 4, 5], text: "😀x")
        ])
    }

    func testChatPipelineTokenizesTheVisibleRenderedTextWithoutAddingSpecialTokens() async throws {
        let rendered = TemplateRenderer.render(
            TemplateRenderRequest(
                template: "{{ messages[0].content }}",
                messages: [TemplateMessage(role: "user", content: "offline")],
                includeTools: false,
                tools: [],
                variables: [],
                addGenerationPrompt: false
            )
        )
        XCTAssertNil(rendered.error)

        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "bpe"))
        let result = await runtime.tokenize(rendered.output)

        XCTAssertEqual(result.input, rendered.output)
        XCTAssertEqual(result.tokenIDs, [15])
        XCTAssertFalse(result.tokenIDs.contains(0), "BOS must not be inserted a second time.")
        XCTAssertFalse(result.tokenIDs.contains(2), "EOS must not be inserted a second time.")
    }

    func testMissingTokenizerConfigFailsClearlyWhenStrictConstructionNeedsIt() throws {
        let fixture = try fixtureBundle(named: "bpe")
        let bundle = TokenizerBundle(
            file: fixture.file,
            tokenizerData: fixture.tokenizerData,
            tokenizerConfigData: nil,
            chatTemplateData: nil
        )

        XCTAssertThrowsError(try TokenizerRuntime(bundle: bundle)) { error in
            guard case TokenizerRuntime.RuntimeError.unsupported = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testInvalidTokenizerJSONReportsItsStage() throws {
        let bundle = TokenizerBundle(
            file: tokenizerFile(size: 1),
            tokenizerData: Data("{".utf8),
            tokenizerConfigData: nil,
            chatTemplateData: nil
        )

        XCTAssertThrowsError(try TokenizerRuntime(bundle: bundle)) { error in
            guard case TokenizerRuntime.RuntimeError.invalidTokenizerData = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testSegmenterGroupsPartialUnicodeBytesWithoutLosingIDs() {
        let segments = TokenizerRuntime.makeSegments(
            tokenIDs: [10, 11, 12],
            decodedText: "😀!",
            decode: { ids in
                switch ids {
                case [10]: "\u{FFFD}"
                case [10, 11]: "😀"
                case [12]: "!"
                default: ""
                }
            }
        )

        XCTAssertEqual(segments, [
            TokenSegment(tokenRange: 0..<2, tokenIDs: [10, 11], text: "😀"),
            TokenSegment(tokenRange: 2..<3, tokenIDs: [12], text: "!"),
        ])
    }

    func testSegmenterFallsBackToOneAuthoritativeDecodedGroup() {
        let segments = TokenizerRuntime.makeSegments(
            tokenIDs: [1, 2],
            decodedText: "hello world",
            decode: { ids in ids == [1] ? "hello" : "world" }
        )

        XCTAssertEqual(segments, [
            TokenSegment(tokenRange: 0..<2, tokenIDs: [1, 2], text: "hello world")
        ])
    }

    func testVisibleTokenizerTextKeepsLineBreakTokensSingleLine() {
        XCTAssertEqual(visibleTokenizerText("\n", showWhitespace: false), " ")
        XCTAssertEqual(visibleTokenizerText("\r\n", showWhitespace: true), "↵")
        XCTAssertEqual(visibleTokenizerText(" a\tb ", showWhitespace: true), "·a→b·")
    }

    private func fixtureBundle(named name: String) throws -> TokenizerBundle {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "Fixtures/Tokenizers/\(name)", directoryHint: .isDirectory)
        let tokenizerData = try Data(contentsOf: directory.appending(path: "tokenizer.json"))
        let configData = try Data(contentsOf: directory.appending(path: "tokenizer_config.json"))
        return TokenizerBundle(
            file: tokenizerFile(size: Int64(tokenizerData.count)),
            tokenizerData: tokenizerData,
            tokenizerConfigData: configData,
            chatTemplateData: nil
        )
    }

    private func tokenizerFile(size: Int64) -> RepositoryFile {
        RepositoryFile(
            path: "tokenizer.json",
            size: size,
            revision: "fixture",
            contentHash: "fixture",
            category: .tokenizer
        )
    }
}
