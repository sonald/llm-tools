import AppKit
import SwiftUI

struct RenderedOutputItem: Identifiable, Equatable {
    let id: Int
    let level: Int
    let title: String
    let detail: String?
    let range: NSRange
    let payloadRange: NSRange?
}

enum RenderedOutputInspector {
    private struct Token {
        let name: String
        let range: NSRange
    }

    private static let tokenPattern = #"<\|([^|\r\n]+)\|>"#

    static func items(in source: String) -> [RenderedOutputItem] {
        let tokens = tokens(in: source)
        let messageIndexes = tokens.indices.filter { tokens[$0].name.hasPrefix("message_") }

        guard !messageIndexes.isEmpty else {
            return tokens.enumerated().map { index, token in
                RenderedOutputItem(
                    id: index,
                    level: 0,
                    title: token.name,
                    detail: "特殊 token",
                    range: token.range,
                    payloadRange: nil
                )
            }
        }

        var result: [RenderedOutputItem] = []
        for (position, tokenIndex) in messageIndexes.enumerated() {
            let token = tokens[tokenIndex]
            let nextMessageStart = position + 1 < messageIndexes.count
                ? tokens[messageIndexes[position + 1]].range.location
                : (source as NSString).length
            let endToken = tokens[(tokenIndex + 1)...].first {
                $0.range.location < nextMessageStart && $0.name == "end_message"
            }
            let messageEnd = endToken.map { NSMaxRange($0.range) } ?? nextMessageStart
            let contentTokens = tokens[(tokenIndex + 1)...].filter {
                $0.range.location < messageEnd && $0.name.hasPrefix("content_")
            }
            let detail = messageDetail(
                in: source,
                from: NSMaxRange(token.range),
                to: contentTokens.first?.range.location ?? messageEnd
            )

            result.append(RenderedOutputItem(
                id: result.count,
                level: 0,
                title: String(token.name.dropFirst("message_".count)).uppercased(),
                detail: detail,
                range: NSRange(location: token.range.location, length: messageEnd - token.range.location),
                payloadRange: nil
            ))

            for contentToken in contentTokens {
                let contentEnd = tokens.first {
                    $0.range.location > contentToken.range.location
                        && $0.range.location <= messageEnd
                        && ($0.name.hasPrefix("content_")
                            || $0.name == "end_message"
                            || $0.name.hasPrefix("message_"))
                }?.range.location ?? messageEnd
                let payloadStart = NSMaxRange(contentToken.range)
                result.append(RenderedOutputItem(
                    id: result.count,
                    level: 1,
                    title: contentToken.name,
                    detail: nil,
                    range: NSRange(
                        location: contentToken.range.location,
                        length: contentEnd - contentToken.range.location
                    ),
                    payloadRange: NSRange(location: payloadStart, length: contentEnd - payloadStart)
                ))
            }

            if contentTokens.isEmpty && token.name == "message_model" {
                result.append(RenderedOutputItem(
                    id: result.count,
                    level: 1,
                    title: "generation prompt",
                    detail: nil,
                    range: token.range,
                    payloadRange: nil
                ))
            }
        }
        return result
    }

    static func prettyPrintedJSON(for item: RenderedOutputItem, in source: String) -> String? {
        guard let range = item.payloadRange,
              range.length > 0,
              NSMaxRange(range) <= (source as NSString).length else { return nil }
        let payload = (source as NSString).substring(with: range)
        guard let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let formatted = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
              ) else { return nil }
        return String(data: formatted, encoding: .utf8)
    }

    static func tokenRanges(in source: String) -> [NSRange] {
        tokens(in: source).map(\.range)
    }

    private static func tokens(in source: String) -> [Token] {
        guard let expression = try? NSRegularExpression(pattern: tokenPattern) else { return [] }
        let range = NSRange(location: 0, length: (source as NSString).length)
        return expression.matches(in: source, range: range).compactMap { match in
            guard match.numberOfRanges == 2 else { return nil }
            return Token(
                name: (source as NSString).substring(with: match.range(at: 1)),
                range: match.range
            )
        }
    }

    private static func messageDetail(in source: String, from start: Int, to end: Int) -> String? {
        guard end > start else { return nil }
        let text = (source as NSString).substring(
            with: NSRange(location: start, length: end - start)
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return text.count > 40 ? String(text.prefix(39)) + "…" : text
    }
}

struct RenderedOutputTextView: NSViewRepresentable {
    let text: String
    let highlightedRange: NSRange?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.usesFindBar = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineBreakMode = .byCharWrapping
        textView.textContainerInset = NSSize(width: 12, height: 10)
        textView.backgroundColor = .textBackgroundColor
        textView.string = text
        applyHighlighting(to: textView)
        context.coordinator.highlightedRange = highlightedRange
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        let selectionChanged = context.coordinator.highlightedRange != highlightedRange
        if textView.string != text {
            textView.string = text
        }
        applyHighlighting(to: textView)
        context.coordinator.highlightedRange = highlightedRange
        if selectionChanged, let highlightedRange, highlightedRange.length > 0 {
            textView.scrollRangeToVisible(highlightedRange)
        }
    }

    private func applyHighlighting(to textView: NSTextView) {
        guard let storage = textView.textStorage else { return }
        let source = textView.string
        let fullRange = NSRange(location: 0, length: (source as NSString).length)
        let font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
        let selectedRanges = textView.selectedRanges

        storage.beginEditing()
        storage.setAttributes([
            .font: font,
            .foregroundColor: NSColor.labelColor,
        ], range: fullRange)
        for range in RenderedOutputInspector.tokenRanges(in: source) {
            storage.addAttributes([
                .foregroundColor: NSColor.systemPink,
                .font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: .semibold),
            ], range: range)
        }
        if let highlightedRange, NSMaxRange(highlightedRange) <= fullRange.length {
            storage.addAttribute(
                .backgroundColor,
                value: NSColor.selectedContentBackgroundColor.withAlphaComponent(0.42),
                range: highlightedRange
            )
        }
        storage.endEditing()
        textView.selectedRanges = selectedRanges
    }

    final class Coordinator {
        var highlightedRange: NSRange?
    }
}
