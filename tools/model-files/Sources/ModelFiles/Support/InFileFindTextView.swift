import AppKit
import SwiftUI

final class InFileFindTextView: NSTextView {
    var revealFindRange: ((NSRange) -> Void)?
    private var isNotifyingWillReveal = false
    private var isUpdatingSelection = false

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
        usesFindBar = true
        isIncrementalSearchingEnabled = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    static func shouldRouteFindShortcut(event: NSEvent) -> Bool {
        guard event.type == .keyDown,
              event.charactersIgnoringModifiers?.lowercased() == "f",
              event.modifierFlags.contains(.command) != event.modifierFlags.contains(.control)
        else {
            return false
        }
        return !event.modifierFlags.contains(.option)
            && !event.modifierFlags.contains(.shift)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard Self.shouldRouteFindShortcut(event: event) else {
            return super.performKeyEquivalent(with: event)
        }
        performFindPanelAction(Self.showFindMenuItem())
        return true
    }

    func resetFindState() {
        let findBarContainer: NSTextFinderBarContainer? = enclosingScrollView
        findBarContainer?.isFindBarVisible = false
        // ponytail: AppKit exposes one shared .find pasteboard and no public per-document finder query storage, so clearing it here is the platform-level ceiling.
        NSPasteboard(name: .find).clearContents()
        let location = min(selectedRange.location, (string as NSString).length)
        setSelectedRange(NSRange(location: location, length: 0))
    }

    private func notifyWillReveal(_ range: NSRange) {
        guard !isNotifyingWillReveal, !isUpdatingSelection, range.length > 0 else { return }
        isNotifyingWillReveal = true
        defer { isNotifyingWillReveal = false }
        revealFindRange?(range)
    }

    override func showFindIndicator(for charRange: NSRange) {
        notifyWillReveal(charRange)
        super.showFindIndicator(for: charRange)
    }

    override func scrollRangeToVisible(_ charRange: NSRange) {
        notifyWillReveal(charRange)
        super.scrollRangeToVisible(charRange)
    }

    override func setSelectedRange(
        _ charRange: NSRange,
        affinity: NSSelectionAffinity,
        stillSelecting: Bool
    ) {
        notifyWillReveal(charRange)
        isUpdatingSelection = true
        defer { isUpdatingSelection = false }
        super.setSelectedRange(charRange, affinity: affinity, stillSelecting: stillSelecting)
    }

    override func setSelectedRanges(
        _ ranges: [NSValue],
        affinity: NSSelectionAffinity,
        stillSelecting: Bool
    ) {
        if let firstNonEmpty = ranges.lazy.compactMap({ $0.rangeValue }).first(where: { $0.length > 0 }) {
            notifyWillReveal(firstNonEmpty)
        }
        isUpdatingSelection = true
        defer { isUpdatingSelection = false }
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
    }

    static func showFindMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        item.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
        return item
    }

}

@MainActor
func scrollableWrappingTextView() -> NSScrollView {
    let textStorage = NSTextStorage()
    let layoutManager = NSLayoutManager()
    let textContainer = NSTextContainer(
        size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
    )
    textContainer.widthTracksTextView = true
    textContainer.heightTracksTextView = false
    textContainer.lineFragmentPadding = 5
    textStorage.addLayoutManager(layoutManager)
    layoutManager.addTextContainer(textContainer)

    let textView = InFileFindTextView(frame: .zero, textContainer: textContainer)
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.autoresizingMask = [.width]
    textView.minSize = NSSize(width: 0, height: 0)
    textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    textView.textContainer?.lineBreakMode = .byCharWrapping
    textView.backgroundColor = .textBackgroundColor

    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = false
    scrollView.autohidesScrollers = true
    scrollView.borderType = .noBorder
    scrollView.documentView = textView
    return scrollView
}

struct PlainTextReaderView: NSViewRepresentable {
    let text: String

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = scrollableWrappingTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        configure(nsTextView: textView)
        textView.string = text
        (textView as? InFileFindTextView)?.resetFindState()
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView,
              textView.string != text else { return }
        textView.string = text
        (textView as? InFileFindTextView)?.resetFindState()
    }

    private func configure(nsTextView textView: NSTextView) {
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
        textView.textContainerInset = NSSize(width: 10, height: 10)
        textView.setAccessibilityElement(true)
        textView.setAccessibilityRole(.textArea)
        textView.setAccessibilityLabel("原文")
    }
}
