import AppKit
import SwiftUI

enum JinjaHighlightKind: Equatable {
    case comment
    case expression
    case statement
    case string
    case keyword
    case delimiter
}

struct JinjaHighlight: Equatable {
    let range: NSRange
    let kind: JinjaHighlightKind
}

enum JinjaSyntaxHighlighter {
    private static let tagPattern = #"\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}"#
    private static let delimiterPattern = #"\{\{|\}\}|\{%|%\}|\{#|#\}"#
    private static let stringPattern = #"'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*""#
    private static let keywordPattern = #"\b(if|else|elif|endif|for|in|endfor|set|true|false|none|and|or|not|is|macro|endmacro|call|endcall|filter|endfilter)\b"#

    static func highlights(in source: String) -> [JinjaHighlight] {
        let fullRange = NSRange(source.startIndex..., in: source)
        guard let tags = try? NSRegularExpression(pattern: tagPattern) else { return [] }
        var result: [JinjaHighlight] = []

        for tag in tags.matches(in: source, range: fullRange) {
            let text = (source as NSString).substring(with: tag.range)
            let kind: JinjaHighlightKind = text.hasPrefix("{#")
                ? .comment
                : (text.hasPrefix("{{") ? .expression : .statement)
            result.append(JinjaHighlight(range: tag.range, kind: kind))
            guard kind != .comment else { continue }
            result.append(contentsOf: matches(stringPattern, in: source, range: tag.range, kind: .string))
            result.append(contentsOf: matches(keywordPattern, in: source, range: tag.range, kind: .keyword))
        }

        result.append(contentsOf: matches(delimiterPattern, in: source, range: fullRange, kind: .delimiter))
        return result
    }

    private static func matches(
        _ pattern: String,
        in source: String,
        range: NSRange,
        kind: JinjaHighlightKind
    ) -> [JinjaHighlight] {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        return expression.matches(in: source, range: range).map {
            JinjaHighlight(range: $0.range, kind: kind)
        }
    }
}

struct JinjaTextEditor: NSViewRepresentable {
    @Binding var text: String

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        textView.delegate = context.coordinator
        textView.string = text
        textView.isRichText = false
        textView.allowsUndo = true
        textView.usesFindBar = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.textContainerInset = NSSize(width: 10, height: 10)
        textView.backgroundColor = .textBackgroundColor
        context.coordinator.textView = textView
        context.coordinator.applyHighlighting()
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView,
              textView.string != text else { return }
        textView.string = text
        context.coordinator.applyHighlighting()
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding private var text: String
        weak var textView: NSTextView?
        private var pendingHighlight: DispatchWorkItem?

        init(text: Binding<String>) {
            _text = text
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            text = textView.string
            pendingHighlight?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.applyHighlighting() }
            pendingHighlight = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.04, execute: work)
        }

        func applyHighlighting() {
            guard let textView, let storage = textView.textStorage else { return }
            let selectedRanges = textView.selectedRanges
            let source = textView.string
            let fullRange = NSRange(location: 0, length: (source as NSString).length)
            let font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)

            storage.beginEditing()
            storage.setAttributes([
                .font: font,
                .foregroundColor: NSColor.labelColor,
            ], range: fullRange)

            for highlight in JinjaSyntaxHighlighter.highlights(in: source) {
                storage.addAttributes(attributes(for: highlight.kind, font: font), range: highlight.range)
            }
            storage.endEditing()
            textView.selectedRanges = selectedRanges
        }

        private func attributes(
            for kind: JinjaHighlightKind,
            font: NSFont
        ) -> [NSAttributedString.Key: Any] {
            switch kind {
            case .comment:
                return [
                    .foregroundColor: NSColor.secondaryLabelColor,
                    .font: NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask),
                ]
            case .expression:
                return [.foregroundColor: NSColor.systemBlue]
            case .statement:
                return [.foregroundColor: NSColor.systemPurple]
            case .string:
                return [.foregroundColor: NSColor.systemOrange]
            case .keyword:
                return [
                    .foregroundColor: NSColor.systemPink,
                    .font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: .semibold),
                ]
            case .delimiter:
                return [
                    .foregroundColor: NSColor.systemTeal,
                    .font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: .bold),
                ]
            }
        }
    }
}
