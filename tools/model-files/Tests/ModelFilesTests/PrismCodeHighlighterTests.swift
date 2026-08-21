import XCTest
@testable import ModelFiles

final class PrismCodeHighlighterTests: XCTestCase {
    func testPythonYAMLAndJSONTokensRoundTripWithNonPlainTypes() async {
        let samples: [(String, String)] = [
            ("python", "def add(x):\n    return x + 1\n"),
            ("yaml", "name: demo\ncount: 2\n"),
            ("json", "{\"ok\": true, \"n\": 1}\n"),
        ]

        for (language, source) in samples {
            let tokens = await PrismCodeHighlighter.shared.tokenize(source, language: language)
            XCTAssertEqual(tokens.map(\.content).joined(), source, language)
            XCTAssertTrue(tokens.contains { $0.type != "plain" }, language)
        }
    }

    func testUnknownLanguageReturnsPlainSource() async {
        let source = "def add(x): return x"
        let tokens = await PrismCodeHighlighter.shared.tokenize(source, language: "not-a-language")
        XCTAssertEqual(tokens.map(\.content).joined(), source)
        XCTAssertEqual(tokens.map(\.type), ["plain"])
    }
}
