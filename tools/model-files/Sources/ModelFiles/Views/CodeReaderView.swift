import AppKit
import SwiftUI

private struct CodeReaderFoldKey: Hashable {
    let source: String
    let language: String
}

struct CodeReaderView: View {
    let source: String
    let language: String
    @State private var expandGeneration = 0
    @State private var foldRanges: [FoldRange] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !foldRanges.isEmpty {
                HStack(spacing: 8) {
                    Button("全部展开") {
                        expandGeneration += 1
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
            }
            CodeReaderTextView(
                source: source,
                language: language,
                foldRanges: foldRanges,
                expandGeneration: expandGeneration
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: CodeReaderFoldKey(source: source, language: language)) {
            foldRanges = []
            let source = source
            let language = language
            let ranges = await Task.detached(priority: .userInitiated) {
                SourceFolding.foldRanges(in: source, language: language)
            }.value
            guard !Task.isCancelled else { return }
            foldRanges = ranges
        }
    }
}

func expandedFoldRangesForSelection(
    selection utf16Range: NSRange,
    collapsed: Set<FoldRange>,
    source: String
) -> Set<FoldRange> {
    guard utf16Range.length > 0, !collapsed.isEmpty else { return [] }
    let hidden = collapsed.compactMap { fold -> (FoldRange, NSRange)? in
        guard let range = hiddenUTF16Range(for: fold, in: source) else { return nil }
        return (fold, range)
    }
    return Set(hidden.compactMap { fold, range in
        NSIntersectionRange(utf16Range, range).length > 0 ? fold : nil
    })
}

func hiddenUTF16Range(for fold: FoldRange, in source: String) -> NSRange? {
    guard fold.startLine >= 1, fold.endLine > fold.startLine else { return nil }
    let ns = source as NSString
    let length = ns.length
    guard length > 0 else { return nil }

    var line = 1
    var lineStart = 0
    var index = 0
    var hideStart: Int?
    var hideEnd: Int?

    while index <= length {
        let atEnd = index == length
        let newlineLength = atEnd ? 0 : utf16NewlineLength(in: ns, at: index)
        if hideStart == nil, line == fold.startLine + 1 {
            hideStart = lineStart
        }
        if line == fold.endLine, newlineLength > 0 || atEnd {
            hideEnd = newlineLength > 0 ? index + newlineLength : index
            break
        }
        if atEnd { break }
        if newlineLength > 0 {
            line += 1
            index += newlineLength
            lineStart = index
            continue
        }
        index += 1
    }

    guard let start = hideStart, let end = hideEnd, end > start else { return nil }
    return NSRange(location: start, length: end - start)
}

func headerUTF16Location(for fold: FoldRange, in source: String) -> Int? {
    guard fold.startLine >= 1 else { return nil }
    let ns = source as NSString
    let length = ns.length
    var line = 1
    var lineStart = 0
    var index = 0
    while index <= length {
        if line == fold.startLine {
            return lineStart
        }
        if index == length { break }
        let newlineLength = utf16NewlineLength(in: ns, at: index)
        if newlineLength > 0 {
            line += 1
            index += newlineLength
            lineStart = index
            continue
        }
        index += 1
    }
    return nil
}

func utf16NewlineLength(in source: NSString, at index: Int) -> Int {
    let unit = source.character(at: index)
    if unit == 13 {
        let next = index + 1
        if next < source.length, source.character(at: next) == 10 {
            return 2
        }
        return 1
    }
    return unit == 10 ? 1 : 0
}

func parentHiddenFolds(in ranges: [FoldRange], collapsed: Set<FoldRange>) -> Set<FoldRange> {
    var hidden = Set<FoldRange>()
    for parent in collapsed {
        for child in ranges where child != parent
            && child.startLine > parent.startLine
            && child.endLine <= parent.endLine
        {
            hidden.insert(child)
        }
    }
    return hidden
}

func foldAccessibilityActionName(for fold: FoldRange, collapsed: Bool) -> String {
    collapsed
        ? String(localized: "展开第 \(fold.startLine.formatted()) 行结构")
        : String(localized: "折叠第 \(fold.startLine.formatted()) 行结构")
}

func makeFoldAccessibilityCustomActions(
    ranges: [FoldRange],
    collapsed: Set<FoldRange>,
    onToggle: @escaping (FoldRange) -> Bool,
    onExpandAll: @escaping () -> Bool
) -> [NSAccessibilityCustomAction] {
    let hidden = parentHiddenFolds(in: ranges, collapsed: collapsed)
    var actions: [NSAccessibilityCustomAction] = []
    for fold in ranges where !hidden.contains(fold) {
        let name = foldAccessibilityActionName(for: fold, collapsed: collapsed.contains(fold))
        actions.append(NSAccessibilityCustomAction(name: name) {
            onToggle(fold)
        })
    }
    if !collapsed.isEmpty {
        actions.append(NSAccessibilityCustomAction(
            name: String(localized: "全部展开"),
            handler: onExpandAll
        ))
    }
    return actions
}

struct CodeReaderTextView: NSViewRepresentable {
    let source: String
    let language: String
    let foldRanges: [FoldRange]
    let expandGeneration: Int

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false

        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        let textContainer = NSTextContainer(
            size: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        )
        textContainer.widthTracksTextView = false
        textContainer.heightTracksTextView = false
        textContainer.lineFragmentPadding = 5
        textStorage.addLayoutManager(layoutManager)
        layoutManager.addTextContainer(textContainer)
        layoutManager.delegate = context.coordinator
        layoutManager.allowsNonContiguousLayout = true

        let textView = InFileFindTextView(frame: .zero, textContainer: textContainer)
        let coordinator = context.coordinator
        textView.delegate = context.coordinator
        textView.revealFindRange = { [weak coordinator] range in
            coordinator?.revealFindRange(range)
        }
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.allowsUndo = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.backgroundColor = .textBackgroundColor
        textView.textColor = .labelColor
        textView.font = Self.font
        textView.textContainerInset = NSSize(width: 38, height: 10)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = [.width]
        textView.setAccessibilityElement(true)
        textView.setAccessibilityRole(.textArea)
        textView.setAccessibilityLabel(String(localized: "源码"))
        scrollView.documentView = textView

        context.coordinator.observeScrolling(in: scrollView)
        context.coordinator.textView = textView
        context.coordinator.load(source: source, language: language, into: textView)
        context.coordinator.updateFoldRanges(foldRanges)
        context.coordinator.applyExpandGeneration(expandGeneration)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        context.coordinator.textView = textView
        context.coordinator.load(source: source, language: language, into: textView)
        context.coordinator.updateFoldRanges(foldRanges)
        context.coordinator.applyExpandGeneration(expandGeneration)
    }

    static let font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
    static let gutterWidth: CGFloat = 38
    static let foldButtonSize = NSSize(width: 28, height: 16)

    @MainActor
    final class Coordinator: NSObject, @MainActor NSLayoutManagerDelegate, NSTextViewDelegate {
        weak var textView: NSTextView?
        var foldRanges: [FoldRange] = []
        private var collapsed = Set<FoldRange>()
        private var generation = 0
        private var appliedExpandGeneration = 0
        private var loadedSource: String?
        private var loadedLanguage: String?
        private var highlightTask: Task<Void, Never>?
        private var foldButtons: [NSButton] = []
        private var lineStarts: [Int] = []
        private var hiddenRanges: [NSRange] = []
        private var hiddenByParent = Set<FoldRange>()
        private var positioningButtons = false

        func observeScrolling(in scrollView: NSScrollView) {
            scrollView.contentView.postsBoundsChangedNotifications = true
            scrollView.contentView.postsFrameChangedNotifications = true
            NotificationCenter.default.addObserver(
                self, selector: #selector(viewportChanged),
                name: NSView.frameDidChangeNotification, object: scrollView.contentView
            )
            NotificationCenter.default.addObserver(
                self, selector: #selector(viewportChanged),
                name: NSView.boundsDidChangeNotification, object: scrollView.contentView
            )
        }

        @objc private func viewportChanged(_ notification: Notification) {
            positionVisibleFoldButtons()
        }


        deinit {
            highlightTask?.cancel()
            NotificationCenter.default.removeObserver(self)
        }

        func load(source: String, language: String, into textView: NSTextView) {
            guard loadedSource != source || loadedLanguage != language else { return }
            generation += 1
            let generation = generation
            loadedSource = source
            loadedLanguage = language
            lineStarts = [0]
            let ns = source as NSString
            var offset = 0
            while offset < ns.length {
                let newline = utf16NewlineLength(in: ns, at: offset)
                offset += max(1, newline)
                if newline > 0 { lineStarts.append(offset) }
            }
            collapsed.removeAll()
            hiddenRanges = []
            hiddenByParent = []
            highlightTask?.cancel()
            apply(Self.plainString(source), to: textView)
            (textView as? InFileFindTextView)?.resetFindState()

            highlightTask = Task { [weak self] in
                let tokens = await PrismCodeHighlighter.shared.tokenize(source, language: language)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard let self,
                          self.generation == generation,
                          self.loadedSource == source,
                          self.loadedLanguage == language,
                          self.textView === textView
                    else { return }
                    self.apply(Self.highlightedString(source: source, tokens: tokens), to: textView)
                }
            }
        }

        func updateFoldRanges(_ ranges: [FoldRange]) {
            let sourceChanged = foldRanges != ranges
            foldRanges = ranges
            let valid = Set(ranges)
            let retained = collapsed.intersection(valid)
            if retained != collapsed {
                collapsed = retained
                invalidateFoldGlyphs()
            }
            if sourceChanged {
                rebuildFoldButtons()
            }
        }

        func applyExpandGeneration(_ value: Int) {
            guard value != appliedExpandGeneration else { return }
            appliedExpandGeneration = value
            collapsed.removeAll()
            invalidateFoldGlyphs()
            rebuildFoldButtons()
        }

        @objc func toggleFold(_ sender: NSButton) {
            guard foldRanges.indices.contains(sender.tag) else { return }
            toggle(foldRanges[sender.tag])
        }

        func toggle(_ fold: FoldRange) {
            if collapsed.contains(fold) {
                collapsed.remove(fold)
            } else {
                collapsed.insert(fold)
            }
            invalidateFoldGlyphs()
            rebuildFoldButtons()
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView,
                  let selection = textView.selectedRanges.first?.rangeValue,
                  selection.length > 0
            else { return }

            revealFindRange(selection)
        }

        func revealFindRange(_ range: NSRange) {
            let toExpand = collapsed.filter { fold in
                guard let hidden = hiddenRange(for: fold) else { return false }
                return NSIntersectionRange(range, hidden).length > 0
            }
            guard !toExpand.isEmpty else { return }
            collapsed.subtract(toExpand)
            invalidateFoldGlyphs()
            rebuildFoldButtons()
        }

        func invalidateFoldGlyphs() {
            hiddenRanges = collapsed.compactMap { hiddenRange(for: $0) }
            guard let layoutManager = textView?.layoutManager,
                  let storage = textView?.textStorage
            else { return }
            let full = NSRange(location: 0, length: storage.length)
            layoutManager.invalidateGlyphs(forCharacterRange: full, changeInLength: 0, actualCharacterRange: nil)
            layoutManager.invalidateLayout(forCharacterRange: full, actualCharacterRange: nil)
        }

        func layoutManager(
            _ layoutManager: NSLayoutManager,
            shouldGenerateGlyphs glyphs: UnsafePointer<CGGlyph>,
            properties props: UnsafePointer<NSLayoutManager.GlyphProperty>,
            characterIndexes charIndexes: UnsafePointer<Int>,
            font aFont: NSFont,
            forGlyphRange glyphRange: NSRange
        ) -> Int {
            guard !hiddenRanges.isEmpty else { return 0 }
            let count = glyphRange.length
            var properties = Array(UnsafeBufferPointer(start: props, count: count))
            let hidden = hiddenRanges
            if !hidden.isEmpty {
                for index in 0..<count {
                    let characterIndex = charIndexes[index]
                    if hidden.contains(where: { NSLocationInRange(characterIndex, $0) }) {
                        properties[index].insert(.null)
                    }
                }
            }
            layoutManager.setGlyphs(
                glyphs,
                properties: properties,
                characterIndexes: charIndexes,
                font: aFont,
                forGlyphRange: glyphRange
            )
            return count
        }

        private func hiddenRange(for fold: FoldRange) -> NSRange? {
            guard fold.startLine >= 1, fold.endLine > fold.startLine,
                  fold.startLine < lineStarts.count, fold.endLine <= lineStarts.count
            else { return nil }
            let start = lineStarts[fold.startLine]
            let end = fold.endLine < lineStarts.count
                ? lineStarts[fold.endLine] : (loadedSource as NSString?)?.length ?? start
            return end > start ? NSRange(location: start, length: end - start) : nil
        }

        private func apply(_ attributed: NSAttributedString, to textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            let selectedRanges = textView.selectedRanges
            let origin = textView.enclosingScrollView?.contentView.bounds.origin
            storage.setAttributedString(attributed)
            let length = (textView.string as NSString).length
            textView.selectedRanges = selectedRanges.compactMap { value in
                var range = value.rangeValue
                guard range.location <= length else { return nil }
                if NSMaxRange(range) > length {
                    range.length = length - range.location
                }
                return NSValue(range: range)
            }
            if let origin, let clipView = textView.enclosingScrollView?.contentView {
                clipView.scroll(to: origin)
                textView.enclosingScrollView?.reflectScrolledClipView(clipView)
            }
            rebuildFoldButtons()
        }

        private func rebuildFoldButtons() {
            hiddenByParent = parentHiddenFolds(in: foldRanges, collapsed: collapsed)
            positionVisibleFoldButtons()
        }

        private func positionVisibleFoldButtons() {
            guard !positioningButtons, let textView,
                  let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer else { return }
            positioningButtons = true
            defer {
                syncFoldAccessibilityActions(on: textView)
                positioningButtons = false
            }
            foldButtons.forEach { $0.removeFromSuperview() }
            foldButtons.removeAll()
            guard !foldRanges.isEmpty,
                  let clipView = textView.enclosingScrollView?.contentView,
                  !clipView.bounds.isEmpty else { return }

            let inset = textView.textContainerInset
            let viewport = clipView.bounds.offsetBy(dx: -inset.width, dy: -inset.height)
            let glyphs = layoutManager.glyphRange(forBoundingRect: viewport, in: textContainer)
            let visible = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
            guard visible.length > 0 else { return }

            // Fold ranges are in source order; skip directly to the first visible header.
            var low = 0
            var high = foldRanges.count
            while low < high {
                let middle = (low + high) / 2
                let line = foldRanges[middle].startLine - 1
                if lineStarts.indices.contains(line), lineStarts[line] < visible.location {
                    low = middle + 1
                } else {
                    high = middle
                }
            }
            for index in low..<foldRanges.count {
                let fold = foldRanges[index]
                guard lineStarts.indices.contains(fold.startLine - 1) else { continue }
                let header = lineStarts[fold.startLine - 1]
                if header >= NSMaxRange(visible) { break }
                guard !hiddenByParent.contains(fold) else { continue }
                let glyph = layoutManager.glyphIndexForCharacter(at: header)
                let fragment = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
                guard fragment.maxY >= viewport.minY, fragment.minY <= viewport.maxY else { continue }
                let button = NSButton(frame: NSRect(origin: .zero, size: CodeReaderTextView.foldButtonSize))
                button.bezelStyle = .inline
                button.isBordered = false
                button.imagePosition = .imageLeading
                button.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
                button.focusRingType = .default
                button.refusesFirstResponder = false
                button.setButtonType(.momentaryPushIn)
                button.tag = index
                button.target = self
                button.action = #selector(toggleFold(_:))
                textView.addSubview(button)
                foldButtons.append(button)
                button.setAccessibilityElement(false)
                button.setAccessibilityHidden(true)
                positionFoldButton(
                    button, fold: fold, fragment: fragment, inset: inset
                )
            }
        }

        private func positionFoldButton(
            _ button: NSButton,
            fold: FoldRange,
            fragment: NSRect,
            inset: NSSize
        ) {
            let isCollapsed = collapsed.contains(fold)
            let symbol = NSImage(
                systemSymbolName: isCollapsed ? "chevron.right" : "chevron.down",
                accessibilityDescription: nil
            )
            symbol?.isTemplate = true
            button.image = symbol
            button.title = isCollapsed ? "\(fold.endLine - fold.startLine)" : ""
            let label = isCollapsed
                ? String(localized: "展开第 \(fold.startLine.formatted()) 行结构")
                : String(localized: "折叠第 \(fold.startLine.formatted()) 行结构")
            button.toolTip = label

            let size = CodeReaderTextView.foldButtonSize
            let y = inset.height + fragment.minY + (fragment.height - size.height) / 2
            button.frame = NSRect(
                x: max(4, inset.width - size.width - 2),
                y: y,
                width: size.width,
                height: size.height
            )
        }

        private func syncFoldAccessibilityActions(on textView: NSTextView) {
            textView.setAccessibilityCustomActions(
                makeFoldAccessibilityCustomActions(
                    ranges: foldButtons.map { foldRanges[$0.tag] },
                    collapsed: collapsed,
                    onToggle: { [weak self] fold in
                        guard let self else { return false }
                        self.toggle(fold)
                        return true
                    },
                    onExpandAll: { [weak self] in
                        guard let self else { return false }
                        self.collapsed.removeAll()
                        self.invalidateFoldGlyphs()
                        self.rebuildFoldButtons()
                        return true
                    }
                )
            )
        }

        private static func plainString(_ source: String) -> NSAttributedString {
            NSAttributedString(string: source, attributes: baseAttributes)
        }

        private static func highlightedString(source: String, tokens: [PrismCodeToken]) -> NSAttributedString {
            guard tokens.map(\.content).joined() == source else {
                return plainString(source)
            }
            let result = NSMutableAttributedString()
            result.beginEditing()
            for token in tokens {
                var attributes = baseAttributes
                attributes[.foregroundColor] = color(for: token.type)
                if token.type == "keyword" || token.type == "boolean" || token.type == "literal" {
                    attributes[.font] = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .semibold)
                }
                result.append(NSAttributedString(string: token.content, attributes: attributes))
            }
            result.endEditing()
            return result
        }

        private static let baseAttributes: [NSAttributedString.Key: Any] = [
            .font: CodeReaderTextView.font,
            .foregroundColor: NSColor.labelColor,
        ]

        private static func color(for type: String) -> NSColor {
            switch type {
            case "keyword", "boolean", "literal":
                .systemPink
            case "string", "char", "regex", "attr-value":
                .systemRed
            case "comment", "block-comment", "doc-comment":
                .secondaryLabelColor
            case "number":
                .systemPurple
            case "function", "function-name", "function-definition":
                .systemTeal
            case "class-name":
                .systemGreen
            case "builtin":
                .systemIndigo
            case "constant", "directive", "preprocessor", "important":
                .systemOrange
            case "variable", "property", "symbol", "operator", "punctuation", "attr-name", "attribute":
                .systemCyan
            case "tag", "selector", "atrule":
                .systemBlue
            case "inserted":
                .systemGreen
            case "deleted":
                .systemRed
            default:
                .labelColor
            }
        }
    }
}
