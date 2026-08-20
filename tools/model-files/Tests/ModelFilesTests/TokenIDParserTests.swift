import XCTest
@testable import ModelFiles

final class TokenIDParserTests: XCTestCase {
    func testParsesDelimitedAndJSONArrayInputs() throws {
        XCTAssertEqual(try TokenIDParser.parse("151644, 8948\n198\t42"), [151644, 8948, 198, 42])
        XCTAssertEqual(try TokenIDParser.parse("[151644, 8948, 198, 42]"), [151644, 8948, 198, 42])
    }

    func testRejectsEmptyInput() {
        assertError(" \n, ", equals: .empty)
        assertError("[]", equals: .empty)
    }

    func testRejectsNegativeIDAtItsIndex() {
        assertError("10, -2, 30", equals: .negativeToken(index: 1, token: "-2"))
    }

    func testRejectsNonIntegerAtItsIndex() {
        assertError("10 nope 30", equals: .invalidToken(index: 1, token: "nope"))
        assertError("[10, 1.5, 30]", equals: .invalidToken(index: 1, token: "1.5"))
    }

    func testRejectsIntegerOverflowAtItsIndex() {
        assertError(
            "10, 9223372036854775808",
            equals: .integerOverflow(index: 1, token: "9223372036854775808")
        )
        assertError(
            "[10, 9223372036854775808]",
            equals: .integerOverflow(index: 1, token: "9223372036854775808")
        )
    }

    func testRejectsInputLargerThan64KiB() {
        let input = String(repeating: "1 ", count: TokenIDParser.maximumInputByteCount / 2 + 1)

        assertError(input, equals: .inputTooLarge(limit: TokenIDParser.maximumInputByteCount))
    }

    private func assertError(
        _ input: String,
        equals expected: TokenIDParser.ParseError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try TokenIDParser.parse(input), file: file, line: line) { error in
            XCTAssertEqual(error as? TokenIDParser.ParseError, expected, file: file, line: line)
        }
    }
}
