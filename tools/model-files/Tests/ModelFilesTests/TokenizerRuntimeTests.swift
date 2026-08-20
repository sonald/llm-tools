import Foundation
import XCTest
@testable import ModelFiles

final class TokenizerRuntimeTests: XCTestCase {
    func testStrictlyLoadsOfflineBPEAndReturnsStableIDs() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "bpe"))

        let result = try await runtime.tokenize("offline path")

        XCTAssertEqual(result.input, "offline path")
        XCTAssertEqual(result.tokenIDs, [15, 22])
        XCTAssertEqual(result.tokenPieces, ["offline", "path"])
        XCTAssertEqual(result.decodedText, "offlinepath")
        XCTAssertEqual(result.sourceMapping, .decodedOnly)
        XCTAssertEqual(result.direction, .encode)
        XCTAssertEqual(
            result.flags,
            Array(repeating: TokenFlags(isSpecial: false, specialName: nil), count: result.tokenIDs.count)
        )
        XCTAssertNil(result.roles)
        XCTAssertNil(result.overhead)
        XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
        let fallbackCount = await runtime.specialTokenDecodeFallbackCount
        XCTAssertEqual(fallbackCount, 0)
    }

    func testStrictlyLoadsWordPieceAndPreservesSubwordIDs() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "wordpiece"))

        let result = try await runtime.tokenize("Hello worlds 中文")

        XCTAssertEqual(result.tokenIDs, [3, 4, 5, 6, 7])
        XCTAssertEqual(result.tokenPieces, ["hello", "world", "##s", "中", "文"])
        XCTAssertEqual(result.decodedText, "hello worlds 中 文")
        XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
        XCTAssertEqual(result.flags.map(\.isSpecial), [false, false, false, false, false])
        let fallbackCount = await runtime.specialTokenDecodeFallbackCount
        XCTAssertEqual(fallbackCount, 0)
    }

    func testStrictlyLoadsUnigramAndUsesMetaspaceDecoder() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "unigram"))

        let result = try await runtime.tokenize("hello world")

        XCTAssertEqual(result.tokenIDs, [2, 3])
        XCTAssertEqual(result.tokenPieces, ["▁hello", "▁world"])
        XCTAssertEqual(result.decodedText, "hello world")
        XCTAssertEqual(result.sourceMapping, .exact)
        XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
        XCTAssertEqual(result.flags.map(\.isSpecial), [false, false])
        let fallbackCount = await runtime.specialTokenDecodeFallbackCount
        XCTAssertEqual(fallbackCount, 0)
    }

    func testByteFallbackGroupsOneEmojiWithoutDroppingItsFourIDs() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "byte-fallback"))

        let result = try await runtime.tokenize("😀x")

        XCTAssertEqual(result.tokenIDs, [1, 2, 3, 4, 5])
        XCTAssertEqual(result.tokenPieces, ["<0xF0>", "<0x9F>", "<0x98>", "<0x80>", "x"])
        XCTAssertEqual(result.decodedText, "😀x")
        XCTAssertEqual(result.sourceMapping, .exact)
        XCTAssertEqual(result.segments, [
            TokenSegment(tokenRange: 0..<5, tokenIDs: [1, 2, 3, 4, 5], text: "😀x")
        ])
        XCTAssertEqual(result.flags.map(\.isSpecial), [false, false, false, false, false])
        let fallbackCount = await runtime.specialTokenDecodeFallbackCount
        XCTAssertEqual(fallbackCount, 0)
    }

    func testDecodeRoundTripsBPEAndUnigramResults() async throws {
        for (fixture, input) in [("bpe", "offline path"), ("unigram", "hello world")] {
            let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: fixture))
            let encoded = try await runtime.tokenize(input)

            let decoded = try await runtime.decode(encoded.tokenIDs)

            XCTAssertEqual(decoded.direction, .decode, fixture)
            XCTAssertEqual(decoded.input, encoded.tokenIDs.map(String.init).joined(separator: ", "), fixture)
            XCTAssertEqual(decoded.tokenIDs, encoded.tokenIDs, fixture)
            XCTAssertEqual(decoded.tokenPieces, encoded.tokenPieces, fixture)
            XCTAssertEqual(decoded.decodedText, encoded.decodedText, fixture)
            XCTAssertEqual(decoded.sourceMapping, .decodedOnly, fixture)
            XCTAssertEqual(decoded.flags.count, decoded.tokenIDs.count, fixture)
        }
    }

    func testDecodeEmptyIDsReturnsEmptyDecodedOnlyResult() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "bpe"))

        let result = try await runtime.decode([])

        XCTAssertEqual(result.direction, .decode)
        XCTAssertEqual(result.input, "")
        XCTAssertEqual(result.tokenIDs, [])
        XCTAssertEqual(result.tokenPieces, [])
        XCTAssertEqual(result.decodedText, "")
        XCTAssertEqual(result.segments, [])
        XCTAssertEqual(result.sourceMapping, .decodedOnly)
        XCTAssertEqual(result.flags, [])
        XCTAssertNil(result.roles)
        XCTAssertNil(result.overhead)
    }

    func testFlagsPreferReliableIDsThenEncodedConfigPieces() async throws {
        let wordPiece = try TokenizerRuntime(bundle: try fixtureBundle(named: "wordpiece"))
        let wordPieceResult = try await wordPiece.decode([1, 3, 2])

        XCTAssertEqual(wordPieceResult.flags, [
            TokenFlags(isSpecial: true, specialName: "[CLS]"),
            TokenFlags(isSpecial: false, specialName: nil),
            TokenFlags(isSpecial: true, specialName: "[SEP]"),
        ])

        let bpe = try TokenizerRuntime(bundle: try fixtureBundle(named: "bpe"))
        let bpeResult = try await bpe.decode([0, 15, 2])

        XCTAssertEqual(bpeResult.flags, [
            TokenFlags(isSpecial: true, specialName: "bos_token"),
            TokenFlags(isSpecial: false, specialName: nil),
            TokenFlags(isSpecial: true, specialName: "eos_token"),
        ])
    }

    func testDecodePreservesUnknownHuggingFaceIDAsNilPiece() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "bpe"))

        let result = try await runtime.decode([15, 999, 22])

        XCTAssertEqual(result.tokenIDs, [15, 999, 22])
        XCTAssertEqual(result.tokenPieces, ["offline", nil, "path"])
        XCTAssertEqual(result.decodedText, "offlinepath")
        XCTAssertEqual(result.segments.flatMap(\.tokenIDs), result.tokenIDs)
        XCTAssertEqual(result.flags.count, result.tokenIDs.count)
        XCTAssertFalse(result.flags[1].isSpecial)
        let fallbackCount = await runtime.specialTokenDecodeFallbackCount
        XCTAssertEqual(fallbackCount, 1)
    }

    func testEmptyConfiguredSpecialDoesNotMarkUnknownID() async throws {
        let fixture = try fixtureBundle(named: "bpe")
        let configData = try XCTUnwrap(fixture.tokenizerConfigData)
        var config = try XCTUnwrap(
            JSONSerialization.jsonObject(with: configData) as? [String: Any]
        )
        config["additional_special_tokens"] = [""]
        let bundle = TokenizerBundle(
            file: fixture.file,
            tokenizerData: fixture.tokenizerData,
            tokenizerConfigData: try JSONSerialization.data(withJSONObject: config),
            chatTemplateData: nil
        )
        let runtime = try TokenizerRuntime(bundle: bundle)

        let result = try await runtime.decode([999])

        XCTAssertEqual(result.tokenPieces, [nil])
        XCTAssertEqual(result.flags, [TokenFlags(isSpecial: false, specialName: nil)])
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
        let result = try await runtime.tokenize(rendered.output)

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

    func testInvalidSentencePieceModelReportsItsStage() throws {
        let bundle = TokenizerBundle(
            file: RepositoryFile(
                path: "tokenizer.model",
                size: 7,
                revision: "fixture",
                contentHash: "fixture",
                category: .tokenizer
            ),
            tokenizerData: Data("invalid".utf8),
            tokenizerConfigData: nil,
            chatTemplateData: nil
        )

        XCTAssertThrowsError(try TokenizerRuntime(bundle: bundle)) { error in
            guard case TokenizerRuntime.RuntimeError.invalidSentencePieceModel = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testSegmenterGroupsPartialUnicodeBytesWithoutLosingIDs() throws {
        let segments = try TokenizerRuntime.makeSegments(
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

    func testSegmenterFallsBackToOneAuthoritativeDecodedGroup() throws {
        let segments = try TokenizerRuntime.makeSegments(
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

    func testTokenSelectionClickTogglesExactIndex() {
        XCTAssertEqual(toggleTokenSelection(nil, clicked: 2), 2)
        XCTAssertNil(toggleTokenSelection(2, clicked: 2))
        XCTAssertEqual(toggleTokenSelection(2, clicked: 3), 3)
    }

    func testTokenTableRowsKeepExactIndexesAndSpecialNames() async throws {
        let runtime = try TokenizerRuntime(bundle: try fixtureBundle(named: "bpe"))
        let result = try await runtime.decode([0, 15, 2])

        let rows = TokenizerTokenTableView.makeRows(result: result)

        XCTAssertEqual(rows.map(\.index), [0, 1, 2])
        XCTAssertEqual(rows.map(\.specialName), ["bos_token", nil, "eos_token"])
        XCTAssertEqual(rows.count, result.flags.count)
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
