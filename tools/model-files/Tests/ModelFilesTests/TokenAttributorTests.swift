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
}
