import AppKit
import SwiftUI
import XCTest
@testable import ModelFiles

final class InFileFindTests: XCTestCase {
    @MainActor
    func testInFileFindTextViewDefaultsToNativeFindBar() {
        let textView = InFileFindTextView(frame: .zero, textContainer: nil)
        XCTAssertTrue(textView.usesFindBar)
        XCTAssertTrue(textView.isIncrementalSearchingEnabled)
    }

    @MainActor
    func testResetFindStateClearsQueryAndSelectionWithoutChangingText() throws {
        try withIsolatedFindPasteboard {
            let scrollView = scrollableWrappingTextView()
            guard let textView = scrollView.documentView as? InFileFindTextView else {
                return XCTFail("Production text reader should expose an InFileFindTextView")
            }
            let findPasteboard = NSPasteboard(name: .find)
            textView.string = "abcdef"
            textView.setSelectedRange(NSRange(location: 2, length: 3))
            XCTAssertEqual(textView.string, "abcdef")
            XCTAssertEqual(textView.selectedRange, NSRange(location: 2, length: 3))

            textView.resetFindState()

            XCTAssertEqual(textView.selectedRange, NSRange(location: 2, length: 0))
            XCTAssertEqual(textView.string, "abcdef")

            textView.string = "abcdef"
            textView.setSelectedRange(NSRange(location: 2, length: 3))
            try setFindQueryOrSkip("llm-find-reset-direct", on: findPasteboard)
            textView.resetFindState()

            XCTAssertNil(findPasteboard.string(forType: .string))
            XCTAssertEqual(textView.selectedRange, NSRange(location: 2, length: 0))
            XCTAssertEqual(textView.string, "abcdef")
        }
    }

    @MainActor
    func testPureCommandOrControlFIsRoutedButOtherCombinationsPassThrough() {
        XCTAssertTrue(InFileFindTextView.shouldRouteFindShortcut(event: controlFEvent()))
        XCTAssertTrue(InFileFindTextView.shouldRouteFindShortcut(event: commandFEvent()))
        XCTAssertFalse(InFileFindTextView.shouldRouteFindShortcut(event: plainFEvent()))
        XCTAssertFalse(InFileFindTextView.shouldRouteFindShortcut(event: commandControlFEvent()))
        XCTAssertFalse(InFileFindTextView.shouldRouteFindShortcut(event: optionFEvent()))
        XCTAssertFalse(InFileFindTextView.shouldRouteFindShortcut(event: shiftFEvent()))
    }

    @MainActor
    func testCommandAndControlFRoutesShowFindActionWithoutCrashing() {
        let textView = InFileFindTextView(frame: .zero, textContainer: nil)
        XCTAssertEqual(InFileFindTextView.showFindMenuItem().tag, Int(NSFindPanelAction.showFindPanel.rawValue))
        XCTAssertTrue(textView.performKeyEquivalent(with: controlFEvent()))
        XCTAssertTrue(textView.performKeyEquivalent(with: commandFEvent()))
    }

    @MainActor
    func testShowFindIndicatorCallsProductionClosureWithoutCrashing() {
        let textView = InFileFindTextView(frame: .zero, textContainer: nil)
        let range = NSRange(location: 2, length: 3)
        var receivedRanges: [NSRange] = []

        textView.revealFindRange = { receivedRanges.append($0) }
        textView.showFindIndicator(for: range)

        XCTAssertEqual(receivedRanges, [range])
    }

    @MainActor
    func testAppKitSelectionAndScrollPathsNotifyRevealClosure() {
        let textView = InFileFindTextView(frame: .zero, textContainer: nil)
        textView.string = "abcdef"
        let range = NSRange(location: 2, length: 3)
        var receivedRanges: [NSRange] = []
        textView.revealFindRange = { receivedRanges.append($0) }

        textView.showFindIndicator(for: range)
        textView.scrollRangeToVisible(range)
        textView.setSelectedRange(range, affinity: .downstream, stillSelecting: false)
        textView.setSelectedRanges([NSValue(range: range)], affinity: .downstream, stillSelecting: false)

        XCTAssertEqual(receivedRanges, Array(repeating: range, count: 4))
    }

    @MainActor
    func testEmptySelectionDoesNotNotifyRevealClosure() {
        let textView = InFileFindTextView(frame: .zero, textContainer: nil)
        textView.string = "abcdef"
        let empty = NSRange(location: 2, length: 0)
        var receivedRanges: [NSRange] = []
        textView.revealFindRange = { receivedRanges.append($0) }

        textView.showFindIndicator(for: empty)
        textView.scrollRangeToVisible(empty)
        textView.setSelectedRange(empty, affinity: .downstream, stillSelecting: false)
        textView.setSelectedRanges([NSValue(range: empty)], affinity: .downstream, stillSelecting: false)

        XCTAssertEqual(receivedRanges, [])
    }

    @MainActor
    func testScrollInsideRevealClosureDoesNotNotifyRecursively() {
        let textView = InFileFindTextView(frame: .zero, textContainer: nil)
        textView.string = "abcdef"
        let range = NSRange(location: 2, length: 3)
        var notifyCount = 0
        textView.revealFindRange = { notifiedRange in
            notifyCount += 1
            if notifyCount == 1 {
                textView.scrollRangeToVisible(notifiedRange)
            }
        }

        textView.showFindIndicator(for: range)

        XCTAssertEqual(notifyCount, 1)
    }

    @MainActor
    func testCodeReaderTextViewWiresDelegateToItsCoordinator() {
        let host = NSHostingView(
            rootView: CodeReaderView(source: "def run():\n    return 1\n", language: "python")
        )
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
        host.layoutSubtreeIfNeeded()

        func coordinator(from view: NSView) -> CodeReaderTextView.Coordinator? {
            if let textView = view as? InFileFindTextView,
               let delegate = textView.delegate as? CodeReaderTextView.Coordinator {
                return delegate
            }
            for child in view.subviews {
                if let found = coordinator(from: child) {
                    return found
                }
            }
            return nil
        }

        guard let textView = firstInFileFindTextView(in: host) else {
            return XCTFail("CodeReaderView should host an InFileFindTextView")
        }
        XCTAssertNotNil(coordinator(from: host))
        XCTAssertNotNil(textView.revealFindRange)
    }

    @MainActor
    func testPlainTextReaderUsesInFileFindTextView() {
        let host = NSHostingView(rootView: PlainTextReaderView(text: "one\ntwo\n"))
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
        host.layoutSubtreeIfNeeded()

        guard let textView = firstInFileFindTextView(in: host) else {
            return XCTFail("PlainTextReaderView should host an InFileFindTextView")
        }
        XCTAssertTrue(textView.usesFindBar)
        XCTAssertTrue(textView.isIncrementalSearchingEnabled)
        XCTAssertEqual(textView.string, "one\ntwo\n")
        XCTAssertEqual(textView.accessibilityRole()?.rawValue, NSAccessibility.Role.textArea.rawValue)
        XCTAssertEqual(textView.accessibilityLabel(), "原文")
    }

    @MainActor
    func testPlainTextReaderHoldsMoreThan1001Lines() {
        let lines = (1...1_002).map { "line \($0)" }.joined(separator: "\n") + "\n"
        let host = NSHostingView(rootView: PlainTextReaderView(text: lines))
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
        host.layoutSubtreeIfNeeded()
        guard let text = firstInFileFindTextView(in: host) else {
            return XCTFail("Plain text should use InFileFindTextView")
        }
        XCTAssertTrue(text.string.hasSuffix("line 1002\n"))
        XCTAssertTrue(text.string.contains("\nline 1001\n"))
    }

    @MainActor
    func testPlainTextReaderCreationClearsFindQuery() throws {
        try withIsolatedFindPasteboard {
            let findPasteboard = NSPasteboard(name: .find)
            try setFindQueryOrSkip("llm-find-plain-create", on: findPasteboard)
            let host = NSHostingView(rootView: PlainTextReaderView(text: "one\ntwo\n"))
            host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
            host.layoutSubtreeIfNeeded()

            XCTAssertNil(findPasteboard.string(forType: .string))
        }
    }

    @MainActor
    func testPlainTextReaderContentChangeClearsFindQuery() throws {
        try withIsolatedFindPasteboard {
            let host = NSHostingView(rootView: PlainTextReaderView(text: "first\n"))
            host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
            host.layoutSubtreeIfNeeded()
            let findPasteboard = NSPasteboard(name: .find)
            try setFindQueryOrSkip("llm-find-plain-update", on: findPasteboard)

            host.rootView = PlainTextReaderView(text: "second\n")
            host.layoutSubtreeIfNeeded()

            XCTAssertNil(findPasteboard.string(forType: .string))
        }
    }

    @MainActor
    func testCodeReaderCreationAndSourceChangeClearFindQuery() throws {
        try withIsolatedFindPasteboard {
            let findPasteboard = NSPasteboard(name: .find)
            try setFindQueryOrSkip("llm-find-code-create", on: findPasteboard)
            let host = NSHostingView(
                rootView: CodeReaderTextView(
                    source: "value = 1\n",
                    language: "python",
                    foldRanges: [],
                    expandGeneration: 0
                )
            )
            host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
            host.layoutSubtreeIfNeeded()
            XCTAssertNil(findPasteboard.string(forType: .string))

            try setFindQueryOrSkip("llm-find-code-change", on: findPasteboard)
            host.rootView = CodeReaderTextView(
                source: "print(value)\n",
                language: "python",
                foldRanges: [],
                expandGeneration: 0
            )
            host.layoutSubtreeIfNeeded()

            XCTAssertNil(findPasteboard.string(forType: .string))
        }
    }

    @MainActor
    func testJinjaEditorCreationClearsFindQueryButEditingDoesNot() throws {
        try withIsolatedFindPasteboard {
            let findPasteboard = NSPasteboard(name: .find)
            try setFindQueryOrSkip("llm-find-jinja-create", on: findPasteboard)
            let source = "{% if x %}hello{% endif %}"
            let host = NSHostingView(rootView: JinjaTextEditor(text: .constant(source)))
            host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
            host.layoutSubtreeIfNeeded()
            guard let textView = firstInFileFindTextView(in: host),
                  let coordinator = textView.delegate as? JinjaTextEditor.Coordinator else {
                return XCTFail("Jinja editor should expose an InFileFindTextView and coordinator")
            }
            XCTAssertNil(findPasteboard.string(forType: .string))

            try setFindQueryOrSkip("llm-find-jinja-edit", on: findPasteboard)
            XCTAssertEqual(findPasteboard.string(forType: .string), "llm-find-jinja-edit")
            textView.string += "\n"
            coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: textView))

            XCTAssertEqual(findPasteboard.string(forType: .string), "llm-find-jinja-edit")
        }
    }

    @MainActor
    func testJinjaTextEditorUsesInFileFindTextView() {
        let host = NSHostingView(rootView: JinjaTextEditor(text: .constant("{% if x %}hello{% endif %}")))
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
        host.layoutSubtreeIfNeeded()

        guard let text = firstInFileFindTextView(in: host) else {
            return XCTFail("Jinja editor should expose an InFileFindTextView")
        }
        XCTAssertTrue(text.usesFindBar)
        XCTAssertTrue(text.isIncrementalSearchingEnabled)
        XCTAssertTrue(text.isEditable)
    }

    func testExpandedFoldRangesReturnsOnlyFoldsContainingSelection() {
        let source = """
        def outer():
            def inner():
                return 1
            return 2
        """
        let parent = FoldRange(startLine: 1, endLine: 4)
        let child = FoldRange(startLine: 2, endLine: 3)

        let childHiddenRange = hiddenUTF16Range(for: child, in: source)!
        let childSelection = NSRange(location: childHiddenRange.location + 2, length: 4)
        XCTAssertEqual(
            expandedFoldRangesForSelection(
                selection: childSelection,
                collapsed: [parent, child],
                source: source
            ),
            [parent, child]
        )

        let selectionInsideParentOnly = hiddenUTF16Range(for: parent, in: source)!
        XCTAssertEqual(
            expandedFoldRangesForSelection(
                selection: NSRange(location: selectionInsideParentOnly.location, length: 1),
                collapsed: [parent],
                source: source
            ),
            [parent]
        )

        XCTAssertEqual(
            expandedFoldRangesForSelection(
                selection: NSRange(location: 0, length: 1),
                collapsed: [parent, child],
                source: source
            ),
            []
        )
    }

    func testExpandedFoldRangesSurvivesChineseAndEmojiInLongerSource() {
        let source = "中文: {\n  \"词条\": [\n    \"值🙂\",\n    2\n  ]\n}\n"
        let outer = FoldRange(startLine: 1, endLine: 5)
        let inner = FoldRange(startLine: 2, endLine: 4)

        let innerHidden = hiddenUTF16Range(for: inner, in: source)!
        let selection = NSRange(location: innerHidden.location, length: 1)
        let expanded = expandedFoldRangesForSelection(
            selection: selection,
            collapsed: [outer, inner],
            source: source
        )
        XCTAssertEqual(expanded, [outer, inner])
    }

    private func controlFEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.control],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\u{0006}",
            charactersIgnoringModifiers: "f",
            isARepeat: false,
            keyCode: 3
        )!
    }

    private func commandFEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.command],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "f",
            charactersIgnoringModifiers: "f",
            isARepeat: false,
            keyCode: 3
        )!
    }

    private func plainFEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "f",
            charactersIgnoringModifiers: "f",
            isARepeat: false,
            keyCode: 3
        )!
    }

    private func commandControlFEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.command, .control],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\u{0006}",
            charactersIgnoringModifiers: "f",
            isARepeat: false,
            keyCode: 3
        )!
    }

    private func optionFEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.option],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "ƒ",
            charactersIgnoringModifiers: "f",
            isARepeat: false,
            keyCode: 3
        )!
    }

    private func shiftFEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.shift],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "F",
            charactersIgnoringModifiers: "f",
            isARepeat: false,
            keyCode: 3
        )!
    }

    @MainActor
    private func firstInFileFindTextView(in view: NSView) -> InFileFindTextView? {
        if let textView = view as? InFileFindTextView {
            return textView
        }
        for child in view.subviews {
            if let found = firstInFileFindTextView(in: child) {
                return found
            }
        }
        return nil
    }

    @MainActor
    private func setFindQueryOrSkip(_ query: String, on findPasteboard: NSPasteboard) throws {
        guard findPasteboard.setString(query, forType: .string) else {
            throw XCTSkip("Find pasteboard unavailable in this test host")
        }
    }

    @MainActor
    private func withIsolatedFindPasteboard(_ operation: () throws -> Void) rethrows {
        let findPasteboard = NSPasteboard(name: .find)
        let savedQuery = findPasteboard.string(forType: .string)
        defer {
            findPasteboard.clearContents()
            if let savedQuery {
                findPasteboard.setString(savedQuery, forType: .string)
            }
        }
        try operation()
    }
}
