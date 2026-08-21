import AppKit
import SwiftUI
import XCTest
@testable import ModelFiles

final class SourceFoldingTests: XCTestCase {
    func testPythonFoldsNestedBlocksByDeeperIndent() {
        let source = """
        class Model:
            def forward(self, x):
                if x:
                    return x
                return None

        VALUE = 1
        """

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "python"),
            [
                FoldRange(startLine: 1, endLine: 5),
                FoldRange(startLine: 2, endLine: 5),
                FoldRange(startLine: 3, endLine: 4),
            ]
        )
    }

    func testPythonWUsesTheSameIndentScanner() {
        let source = "def run():\n    return 1\n"

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "pyw"),
            [FoldRange(startLine: 1, endLine: 2)]
        )
    }

    func testYAMLFoldsNestedMappingAndSequence() {
        let source = """
        model:
          name: demo
          layers:
            - conv
            - linear
        count: 2
        """

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "yaml"),
            [
                FoldRange(startLine: 1, endLine: 5),
                FoldRange(startLine: 3, endLine: 5),
            ]
        )
    }

    func testYMLUsesTheSameIndentScanner() {
        let source = "root:\n  child: 1\n"

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "yml"),
            [FoldRange(startLine: 1, endLine: 2)]
        )
    }

    func testJSONFoldsMultilineObjectsAndArrays() {
        let source = """
        {
          "a": [
            1,
            2
          ],
          "b": { "ok": true }
        }
        """

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "json"),
            [
                FoldRange(startLine: 1, endLine: 7),
                FoldRange(startLine: 2, endLine: 5),
            ]
        )
    }

    func testJSONIgnoresBracketsInsideEscapedStrings() {
        let source = """
        {
          "text": "not { a } [block]",
          "escaped": "keep { me }",
          "inner": {
            "ok": true
          }
        }
        """

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "json"),
            [
                FoldRange(startLine: 1, endLine: 7),
                FoldRange(startLine: 4, endLine: 6),
            ]
        )
    }

    func testJSONDoesNotFoldSameLineContainers() {
        let source = #"{"a":[1,2],"b":{"ok":true}}"#

        XCTAssertEqual(SourceFolding.foldRanges(in: source, language: "json"), [])
    }

    func testIncompleteJSONDoesNotCrashOrInventFolds() {
        let source = """
        {
          "a": [1,
          "text": "unterminated
        """

        XCTAssertEqual(SourceFolding.foldRanges(in: source, language: "json"), [])
    }

    func testBlankAndUnknownLanguageReturnNoFolds() {
        XCTAssertEqual(SourceFolding.foldRanges(in: "", language: "python"), [])
        XCTAssertEqual(SourceFolding.foldRanges(in: "def run():\n    return 1\n", language: "swift"), [])
    }

    func testPythonDoesNotFoldWhenNoDeeperLineFollows() {
        let source = "def run(): pass\nVALUE = 1\n"

        XCTAssertEqual(SourceFolding.foldRanges(in: source, language: "python"), [])
    }

    func testJSONIgnoresEscapedQuotesAndBackslashes() {
        let source = """
        {
          "quote": "he said \\"hi {there}\\"",
          "slash": "\\\\[not-array\\\\]",
          "ok": [
            1
          ]
        }
        """

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "json"),
            [
                FoldRange(startLine: 1, endLine: 7),
                FoldRange(startLine: 4, endLine: 6),
            ]
        )
    }

    func testPythonDoesNotFoldContinuationsOrComments() {
        let source = """
        values = [
            1,
            2
        ]
        # note:
            ignored = 1
        x = 1
        """

        XCTAssertEqual(SourceFolding.foldRanges(in: source, language: "python"), [])
    }

    func testYAMLFoldsBlockScalarsAndSequenceHeadersOnly() {
        let source = """
        prompt: |
          hello
          world
        items:
          - name: a
            value: 1
          -
            lone: true
        note: plain text
          not a mapping
        folded: >
          one
          two
        """

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "yaml"),
            [
                FoldRange(startLine: 1, endLine: 3),
                FoldRange(startLine: 4, endLine: 8),
                FoldRange(startLine: 5, endLine: 6),
                FoldRange(startLine: 7, endLine: 8),
                FoldRange(startLine: 11, endLine: 13),
            ]
        )
    }

    func testIncompleteJSONWithClosedInnerReturnsNoFolds() {
        let source = """
        {
          "ok": {
            "a": 1
          }
        """

        XCTAssertEqual(SourceFolding.foldRanges(in: source, language: "json"), [])
    }

    func testYAMLDoesNotFoldPlainTextOrScalarItems() {
        let source = """
        title: demo
        items:
          - conv
          - linear
        note: this is not a header
          because it is plain text
        """

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "yaml"),
            [FoldRange(startLine: 2, endLine: 4)]
        )
    }

    func testPythonIgnoresInlineCommentColons() {
        let source = """
        values = [  # note:
            1
        ]
        """
        XCTAssertEqual(SourceFolding.foldRanges(in: source, language: "python"), [])
    }

    func testPythonKeepsColonInsideQuotedHash() {
        let source = """
        if name == "#note:":
            return name
        """
        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "python"),
            [FoldRange(startLine: 1, endLine: 2)]
        )
    }

    func testYAMLFoldsQuotedAndSpacedKeysCommentsAndChomping() {
        let source = """
        model name:
          size: 1
        "quoted:key":
          ok: true
        url: https://example.com
          not-a-child: 1
        parent: # comment
          child: 1
        keep: |-
          a
          b
        plus: |+
          c
        clip: >-
          d
        keepplus: >+
          e
        """

        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "yaml"),
            [
                FoldRange(startLine: 1, endLine: 2),
                FoldRange(startLine: 3, endLine: 4),
                FoldRange(startLine: 7, endLine: 8),
                FoldRange(startLine: 9, endLine: 11),
                FoldRange(startLine: 12, endLine: 13),
                FoldRange(startLine: 14, endLine: 15),
                FoldRange(startLine: 16, endLine: 17),
            ]
        )
    }

    func testHiddenUTF16RangeStartsAfterHeaderLine() {
        let source = "class Model:\n    def run():\n        return 1\n"
        let range = hiddenUTF16Range(for: FoldRange(startLine: 1, endLine: 3), in: source)
        XCTAssertEqual(range, NSRange(location: 13, length: 32))
        XCTAssertEqual((source as NSString).substring(with: range!), "    def run():\n        return 1\n")
    }

    func testHeaderUTF16LocationCountsEmojiAndCRLF() {
        let source = "🙂\r\nclass Model:\r\n    def run():\r\n        return 1\r\n"
        XCTAssertEqual(headerUTF16Location(for: FoldRange(startLine: 1, endLine: 2), in: source), 0)
        XCTAssertEqual(headerUTF16Location(for: FoldRange(startLine: 2, endLine: 4), in: source), 4)
        let ns = source as NSString
        XCTAssertEqual(ns.substring(with: NSRange(location: 4, length: 12)), "class Model:")
    }

    @MainActor
    func testCodeReaderTextViewExposesLabeledTextAreaForVoiceOver() {
        let host = NSHostingView(
            rootView: CodeReaderView(source: "def run():\n    return 1\n", language: "python")
        )
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
        host.layoutSubtreeIfNeeded()

        func findTextView(_ view: NSView) -> NSTextView? {
            if let textView = view as? NSTextView {
                return textView
            }
            for child in view.subviews {
                if let found = findTextView(child) {
                    return found
                }
            }
            return nil
        }

        guard let textView = findTextView(host) else {
            return XCTFail("NSTextView missing")
        }
        XCTAssertTrue(textView.isAccessibilityElement())
        XCTAssertEqual(textView.accessibilityRole(), .textArea)
        XCTAssertEqual(textView.accessibilityLabel(), "源码")
    }

    @MainActor
    func testFoldAccessibilityCustomActionsCoverVisibleFoldsAndExpandAll() {
        let parent = FoldRange(startLine: 1, endLine: 5)
        let child = FoldRange(startLine: 2, endLine: 4)
        let sibling = FoldRange(startLine: 6, endLine: 8)
        var toggled: [FoldRange] = []
        var expandedAll = 0

        let collapsedActions = makeFoldAccessibilityCustomActions(
            ranges: [parent, child, sibling],
            collapsed: [parent],
            onToggle: { fold in
                toggled.append(fold)
                return true
            },
            onExpandAll: {
                expandedAll += 1
                return true
            }
        )
        XCTAssertEqual(
            collapsedActions.map(\.name),
            ["展开第 1 行结构", "折叠第 6 行结构", "全部展开"]
        )
        XCTAssertTrue(collapsedActions[0].handler?() ?? false)
        XCTAssertEqual(toggled, [parent])
        XCTAssertTrue(collapsedActions[2].handler?() ?? false)
        XCTAssertEqual(expandedAll, 1)

        let expandedActions = makeFoldAccessibilityCustomActions(
            ranges: [parent, child, sibling],
            collapsed: [],
            onToggle: { _ in true },
            onExpandAll: { true }
        )
        XCTAssertEqual(
            expandedActions.map(\.name),
            ["折叠第 1 行结构", "折叠第 2 行结构", "折叠第 6 行结构"]
        )

        XCTAssertTrue(
            makeFoldAccessibilityCustomActions(
                ranges: [],
                collapsed: [],
                onToggle: { _ in true },
                onExpandAll: { true }
            ).isEmpty
        )
    }

    func testPythonDoesNotFoldTripleQuotedLinesEndingWithColon() {
        let source = """
        text = '''note:
            not a block
        '''
        other = \"\"\"also:
            still not a block
        \"\"\"
        def run():
            return 1
        """
        XCTAssertEqual(
            SourceFolding.foldRanges(in: source, language: "python"),
            [FoldRange(startLine: 7, endLine: 8)]
        )
    }

    func testPythonFoldScanOn128KiBFixtureStaysUnder50ms() {
        var source = "class Model:\n"
        while source.utf8.count < 128 * 1024 {
            source += "    def method():\n        return 1\n"
        }

        let elapsed = ContinuousClock().measure {
            _ = SourceFolding.foldRanges(in: source, language: "python")
        }
        XCTAssertLessThan(elapsed, .milliseconds(50), "foldRanges took \(elapsed)")
    }
}
