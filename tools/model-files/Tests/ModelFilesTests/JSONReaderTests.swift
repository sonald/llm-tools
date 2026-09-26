import AppKit
import SwiftUI
import XCTest
@testable import ModelFiles

final class JSONReaderTests: XCTestCase {
    @MainActor
    func testLargeJSONOnlyCreatesVisibleFoldButtons() throws {
        let source = "[\n" + Array(repeating: "{\n  \"value\": true\n}", count: 8_000).joined(separator: ",\n") + "\n]"
        XCTAssertGreaterThan(source.utf8.count, 128 * 1024)
        let folds = SourceFolding.foldRanges(in: source, language: "json")
        let host = NSHostingView(rootView: CodeReaderTextView(
            source: source, language: "json", foldRanges: folds, expandGeneration: 0
        ))
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
        host.layoutSubtreeIfNeeded()
        func descendants(_ view: NSView) -> [NSView] {
            view.subviews.flatMap { [$0] + descendants($0) }
        }
        let textView = try XCTUnwrap(descendants(host).compactMap { $0 as? NSTextView }.first)
        let buttons = textView.subviews.compactMap { $0 as? NSButton }
        XCTAssertGreaterThan(buttons.count, 0)
        XCTAssertLessThan(buttons.count, 50)
        let actions = try XCTUnwrap(textView.accessibilityCustomActions())
        XCTAssertEqual(actions.count, buttons.count)
        XCTAssertEqual(textView.string, source)
        textView.scrollRangeToVisible(NSRange(location: (source as NSString).length - 30, length: 1))
        let scrolledButtons = textView.subviews.compactMap { $0 as? NSButton }
        XCTAssertGreaterThan(scrolledButtons.count, 0)
        XCTAssertLessThan(scrolledButtons.count, 50)
        XCTAssertNotEqual(scrolledButtons.map(\.tag), buttons.map(\.tag))
        let scrolledActions = try XCTUnwrap(textView.accessibilityCustomActions())
        XCTAssertEqual(scrolledActions.count, scrolledButtons.count)
        XCTAssertNotEqual(scrolledActions.map(\.name), actions.map(\.name))
        let coordinator = try XCTUnwrap(textView.delegate as? CodeReaderTextView.Coordinator)
        coordinator.toggle(folds[0])
        let collapsedActions = try XCTUnwrap(textView.accessibilityCustomActions())
        XCTAssertLessThan(collapsedActions.count, 50)
        XCTAssertTrue(collapsedActions.contains { $0.name == String(localized: "全部展开") })
        XCTAssertEqual(textView.string, source, "Folding must preserve copy/find source")
        coordinator.revealFindRange(NSRange(location: 100, length: 4))
        XCTAssertEqual(textView.string, source)
    }

    @MainActor
    func testLargeJSONKeepsTopViewportAfterHighlightAndFold() async throws {
        let source: String
        if let path = ProcessInfo.processInfo.environment["MODELFILES_JSON_FIXTURE"] {
            source = try String(contentsOfFile: path, encoding: .utf8)
        } else {
            source = "[\n" + Array(repeating: "{\n  \"value\": true,\n  \"empty\": null\n}", count: 8_000).joined(separator: ",\n") + "\n]"
        }
        let folds = SourceFolding.foldRanges(in: source, language: "json")
        let host = NSHostingView(rootView: CodeReaderTextView(
            source: source, language: "json", foldRanges: folds, expandGeneration: 0
        ))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.contentView = host
        host.frame = NSRect(x: 0, y: 0, width: 640, height: 480)
        host.layoutSubtreeIfNeeded()
        func findTextView(_ view: NSView) -> NSTextView? {
            if let textView = view as? NSTextView { return textView }
            return view.subviews.lazy.compactMap(findTextView).first
        }
        let textView = try XCTUnwrap(findTextView(host))
        let clip = try XCTUnwrap(textView.enclosingScrollView?.contentView)
        clip.scroll(to: .zero)
        for _ in 0..<1_000 {
            if textView.textStorage?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor != NSColor.labelColor { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertNotEqual(textView.textStorage?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, NSColor.labelColor)
        let nullRange = (source as NSString).range(of: "null")
        XCTAssertNotEqual(nullRange.location, NSNotFound)
        XCTAssertNotEqual(textView.textStorage?.attribute(.foregroundColor, at: nullRange.location, effectiveRange: nil) as? NSColor, NSColor.labelColor)
        host.layoutSubtreeIfNeeded()
        XCTAssertLessThan(clip.bounds.minY, 30)
        let button = try XCTUnwrap(textView.subviews.compactMap { $0 as? NSButton }.first { $0.tag == 1 })
        window.makeFirstResponder(button)
        button.performClick(nil)
        XCTAssertTrue(textView.accessibilityCustomActions()?.contains {
            $0.name == foldAccessibilityActionName(for: folds[1], collapsed: true)
        } == true)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertLessThan(clip.bounds.minY, 30)
        let expandButton = try XCTUnwrap(textView.subviews.compactMap { $0 as? NSButton }.first { $0.tag == 1 })
        window.makeFirstResponder(expandButton)
        expandButton.performClick(nil)
        XCTAssertTrue(textView.accessibilityCustomActions()?.contains {
            $0.name == foldAccessibilityActionName(for: folds[1], collapsed: false)
        } == true)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertLessThan(clip.bounds.minY, 30)
    }

    func testFieldsFormatNestedTokenizerWithoutChangingValues() throws {
        let source = #"{"model":{"vocab":{"{\\\"}":18446744073709551615},"merges":["a b"]},"score":1.234567890123456789,"enabled":true}"#
        let formatted = JSONFormatter.formattedSource(Data(source.utf8)).source
        XCTAssertTrue(formatted.contains("18446744073709551615"))
        XCTAssertTrue(formatted.contains("1.234567890123456789"))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(formatted.utf8)) as? NSDictionary,
                       try JSONSerialization.jsonObject(with: Data(source.utf8)) as? NSDictionary)
        XCTAssertGreaterThan(SourceFolding.foldRanges(in: formatted, language: "json").count, 3)
        XCTAssertEqual(JSONFormatter.formattedSource(Data("invalid {".utf8)).source, "invalid {")
        XCTAssertEqual(JSONFormatter.formattedSource(Data("true".utf8)).source, "true")
        XCTAssertNotNil(JSONFormatter.formattedSource(Data("invalid {".utf8)).error)
        XCTAssertEqual(JSONFormatter.inline(NSNumber(value: 1)), "1")
        XCTAssertEqual(JSONFormatter.inline(NSNumber(value: true)), "true")
    }

    func testJSONFoldsUseSameLineNumbersForAllLineEndings() {
        for newline in ["\n", "\r\n", "\r"] {
            let source = ["{", "  \"items\": [", "    1", "  ]", "}"].joined(separator: newline)
            XCTAssertEqual(SourceFolding.foldRanges(in: source, language: "json"), [
                FoldRange(startLine: 1, endLine: 5), FoldRange(startLine: 2, endLine: 4)
            ])
        }
    }
}
