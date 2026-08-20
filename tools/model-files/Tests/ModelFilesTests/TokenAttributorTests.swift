import XCTest
@testable import ModelFiles

final class TokenAttributorTests: XCTestCase {
    func testSingleTextMessageHasNoTemplateOverheadWhenProbeMatchesRendered() throws {
        let messages = [TemplateMessage(role: "user", content: "hello")]
        var probes: [String] = []

        let overhead = TokenAttributor.overhead(
            rendered: "hello",
            messages: messages
        ) { input in
            probes.append(input)
            return input == "hello" ? 4 : 0
        }

        XCTAssertEqual(probes, ["hello", "hello"])
        XCTAssertEqual(overhead.contentProbe, "hello")
        XCTAssertEqual(overhead.totalCount, 4)
        XCTAssertEqual(overhead.contentCount, 4)
        XCTAssertEqual(overhead.templateCount, 0)
        XCTAssertTrue(overhead.isApproximate)
    }

    func testContentProbeJoinsOnlyTextMessagesWithOneNewline() throws {
        let messages = [
            TemplateMessage(role: "system", content: "one"),
            TemplateMessage(role: "user", contentKind: .json, content: #"{"image":"ignored"}"#),
            TemplateMessage(role: "user", content: "two"),
        ]
        var probes: [String] = []

        let overhead = TokenAttributor.overhead(
            rendered: "<system>one<user>two",
            messages: messages
        ) { input in
            probes.append(input)
            return input == "one\ntwo" ? 3 : 8
        }

        XCTAssertEqual(probes, ["<system>one<user>two", "one\ntwo"])
        XCTAssertEqual(overhead.contentProbe, "one\ntwo")
        XCTAssertEqual(overhead.totalCount, 8)
        XCTAssertEqual(overhead.contentCount, 3)
        XCTAssertEqual(overhead.templateCount, 5)
    }

    func testNegativeTemplateCountIsPreservedForUIToExplain() throws {
        let overhead = TokenAttributor.overhead(
            rendered: "rendered",
            messages: [TemplateMessage(role: "user", content: "content")]
        ) { input in
            input == "rendered" ? 2 : 5
        }

        XCTAssertEqual(overhead.templateCount, -3)
        XCTAssertTrue(overhead.isApproximate)
    }

    func testRolesAssignTextContentAndLeaveTemplateShell() throws {
        let rendered = "SYShelloEOS"
        let result = makeResult(
            rendered: rendered,
            segments: [(0..<1, "SYS"), (1..<2, "hello"), (2..<3, "EOS")]
        )

        let roles = TokenAttributor.roles(
            rendered: rendered,
            messages: [TemplateMessage(role: "user", content: "hello")],
            result: result
        )

        XCTAssertEqual(roles, [.template, .user, .template])
        XCTAssertEqual(roles?.count, result.tokenIDs.count)
        XCTAssertEqual(
            TokenizerTokenTableView.makeRows(
                result: result.with(overhead: nil, roles: roles)
            ).map(\.role),
            [.template, .user, .template]
        )
    }

    func testRolesConsumeRepeatedContentMonotonically() throws {
        let rendered = "same|same"
        let result = makeResult(
            rendered: rendered,
            segments: [(0..<1, "same"), (1..<2, "|"), (2..<3, "same")]
        )

        let roles = TokenAttributor.roles(
            rendered: rendered,
            messages: [
                TemplateMessage(role: "user", content: "same"),
                TemplateMessage(role: "assistant", content: "same"),
            ],
            result: result
        )

        XCTAssertEqual(roles, [.user, .template, .assistant])
    }

    func testRolesKeepSegmentCrossingContentBoundaryAsTemplate() throws {
        let rendered = "SYShelloEOS"
        let result = makeResult(
            rendered: rendered,
            segments: [(0..<1, "SYSh"), (1..<2, "ello"), (2..<3, "EOS")]
        )

        let roles = TokenAttributor.roles(
            rendered: rendered,
            messages: [TemplateMessage(role: "user", content: "hello")],
            result: result
        )

        XCTAssertEqual(roles, [.template, .user, .template])
    }

    func testRolesReturnNilForDecodedOnlyMapping() throws {
        let result = makeResult(
            rendered: "hello",
            segments: [(0..<1, "hello")],
            sourceMapping: .decodedOnly
        )

        XCTAssertNil(TokenAttributor.roles(
            rendered: "hello",
            messages: [TemplateMessage(role: "user", content: "hello")],
            result: result
        ))
    }

    func testRolesPreserveCustomRoleAndIgnoreEmptyJSONAndMissingContent() throws {
        let rendered = "<payload>"
        let result = makeResult(
            rendered: rendered,
            segments: [(0..<1, "<"), (1..<2, "payload"), (2..<3, ">")]
        )

        let roles = TokenAttributor.roles(
            rendered: rendered,
            messages: [
                TemplateMessage(role: "user", content: ""),
                TemplateMessage(role: "tool", contentKind: .json, content: "payload"),
                TemplateMessage(role: "assistant", content: "missing"),
                TemplateMessage(role: "critic", content: "payload"),
            ],
            result: result
        )

        XCTAssertEqual(roles, [.template, .custom("critic"), .template])
    }

    private func makeResult(
        rendered: String,
        segments: [(Range<Int>, String)],
        sourceMapping: TokenizerSourceMapping = .exact
    ) -> TokenizationResult {
        let count = segments.map(\.0.upperBound).max() ?? 0
        let tokenIDs = Array(0..<count)
        return TokenizationResult(
            direction: .encode,
            input: rendered,
            tokenIDs: tokenIDs,
            tokenPieces: Array(repeating: nil, count: count),
            decodedText: rendered,
            segments: segments.map { range, text in
                TokenSegment(tokenRange: range, tokenIDs: Array(tokenIDs[range]), text: text)
            },
            sourceMapping: sourceMapping,
            flags: Array(repeating: TokenFlags(isSpecial: false, specialName: nil), count: count),
            roles: nil,
            overhead: nil
        )
    }
}
