import AppKit
import Foundation
import SwiftUI
import Textual

struct MarkdownReaderView: View {
    let text: String
    let baseURL: URL?
    @State private var theme = MarkdownTheme.gitHub

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label("Markdown", systemImage: "text.document")
                    .font(.headline)
                Spacer()
                Picker("排版主题", selection: $theme) {
                    ForEach(MarkdownTheme.allCases) { theme in
                        Text(theme.title).tag(theme)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 240)
                .accessibilityLabel("Markdown 排版主题")
            }

            Divider()

            themedMarkdown
                .frame(maxWidth: 920, alignment: .leading)
        }
        .padding(24)
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
        }
    }

    @ViewBuilder
    private var themedMarkdown: some View {
        let content = StructuredText(
            markdown: ModelCardMarkdown.renderable(text),
            baseURL: baseURL
        )
        .textual.tableStyle(ModelCardTableStyle())
        .textual.tableCellStyle(ModelCardTableCellStyle())
        .textual.imageAttachmentLoader(ModelCardImageLoader(baseURL: baseURL))
        .textual.textSelection(.enabled)
        .textual.overflowMode(.scroll)
        switch theme {
        case .gitHub:
            content.textual.structuredTextStyle(.gitHub)
        case .standard:
            content.textual.structuredTextStyle(.default)
        case .compact:
            content
                .textual.structuredTextStyle(.default)
                .font(.system(size: 13))
        }
    }
}

private struct ModelCardTableStyle: StructuredText.TableStyle {
    private static let borderWidth: CGFloat = 1

    func makeBody(configuration: Configuration) -> some View {
        Overflow {
            configuration.label
                .fixedSize(horizontal: true, vertical: true)
                .textual.tableBackground { layout in
                    Canvas { context, _ in
                        for row in layout.rowIndices.dropFirst().filter({ $0.isMultiple(of: 2) }) {
                            context.fill(
                                Path(layout.rowBounds(row).integral),
                                with: .style(Color(nsColor: .controlBackgroundColor))
                            )
                        }
                    }
                }
                .textual.tableOverlay { layout in
                    Canvas { context, _ in
                        for divider in layout.dividers() {
                            context.fill(
                                Path(divider),
                                with: .style(Color(nsColor: .separatorColor))
                            )
                        }
                    }
                }
                .padding(Self.borderWidth)
        }
        .textual.tableCellSpacing(horizontal: Self.borderWidth, vertical: Self.borderWidth)
        .textual.blockSpacing(.init(top: 0, bottom: 16))
    }
}

private struct ModelCardTableCellStyle: StructuredText.TableCellStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .fontWeight(configuration.row == 0 ? .semibold : .regular)
            .fixedSize(horizontal: true, vertical: true)
            .padding(.vertical, 6)
            .padding(.horizontal, 13)
            .frame(minWidth: 136, alignment: .leading)
    }
}

private enum MarkdownTheme: String, CaseIterable, Identifiable {
    case gitHub
    case standard
    case compact

    var id: Self { self }

    var title: String {
        switch self {
        case .gitHub: "GitHub"
        case .standard: "默认"
        case .compact: "紧凑"
        }
    }
}

enum ModelCardMarkdown {
    static func renderable(_ source: String) -> String {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let content: ArraySlice<String>
        if lines.first?.trimmingCharacters(in: .whitespacesAndNewlines) == "---",
           let end = lines.dropFirst().firstIndex(where: {
               $0.trimmingCharacters(in: .whitespacesAndNewlines) == "---"
           }) {
            content = lines.dropFirst(end + 1)
        } else {
            content = lines[...]
        }

        var fence: Character?
        return content.map { line in
            if let marker = fenceMarker(in: line) {
                if fence == nil { fence = marker }
                else if fence == marker { fence = nil }
                return line
            }
            guard fence == nil else { return line }
            return replacingImages(in: line)
                .replacingOccurrences(
                    of: #"(?i)<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#,
                    with: "[$2]($1)",
                    options: .regularExpression
                )
                .replacingOccurrences(
                    of: #"(?i)<br\s*/?>"#,
                    with: "  ",
                    options: .regularExpression
                )
                .replacingOccurrences(
                    of: #"(?i)</?[a-z][a-z0-9-]*(?:\s[^>]*)?\s*/?>"#,
                    with: "",
                    options: .regularExpression
                )
        }.joined(separator: "\n")
    }

    private static func replacingImages(in line: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: #"(?i)<img\b([^>]*)>"#) else {
            return line
        }
        var result = line
        let matches = expression.matches(in: line, range: NSRange(line.startIndex..., in: line))
        for match in matches.reversed() {
            guard let attributesRange = Range(match.range(at: 1), in: line),
                  let matchRange = Range(match.range, in: result),
                  let source = attribute("src", in: String(line[attributesRange])) else { continue }
            let attributes = String(line[attributesRange])
            let alt = attribute("alt", in: attributes) ?? ""
            let widthSuffix = imageWidth(in: attributes).map {
                (source.contains("#") ? "&" : "#") + "model-files-width=\($0)"
            } ?? ""
            let url = source + widthSuffix
            result.replaceSubrange(matchRange, with: "![\(alt)](\(url))")
        }
        return result
    }

    private static func attribute(_ name: String, in text: String) -> String? {
        let name = NSRegularExpression.escapedPattern(for: name)
        for pattern in [
            #"(?i)\b"# + name + #"\s*=\s*"([^"]*)""#,
            #"(?i)\b"# + name + #"\s*=\s*'([^']*)'"#,
            #"(?i)\b"# + name + #"\s*=\s*([^\s>]+)"#,
        ] {
            if let value = capture(pattern, in: text)?.0 { return value }
        }
        return nil
    }

    private static func imageWidth(in attributes: String) -> String? {
        let value = attribute("style", in: attributes).flatMap {
            capture(#"(?i)\bwidth\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(%|px)"#, in: $0)
        } ?? attribute("width", in: attributes).flatMap {
            capture(#"^\s*([0-9]+(?:\.[0-9]+)?)\s*(%|px)?\s*$"#, in: $0)
        }
        guard let value else { return nil }
        return value.0 + ((value.1 ?? "px") == "%" ? "pct" : "px")
    }

    private static func capture(_ pattern: String, in text: String) -> (String, String?)? {
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let valueRange = Range(match.range(at: 1), in: text) else { return nil }
        let unit = match.numberOfRanges > 2 && match.range(at: 2).location != NSNotFound
            ? Range(match.range(at: 2), in: text).map { String(text[$0]) }
            : nil
        return (String(text[valueRange]), unit)
    }

    private static func fenceMarker(in line: String) -> Character? {
        let trimmed = line.drop(while: { $0.isWhitespace })
        guard let marker = trimmed.first, marker == "`" || marker == "~" else { return nil }
        return trimmed.prefix(while: { $0 == marker }).count >= 3 ? marker : nil
    }
}

struct ModelCardImageLoader: AttachmentLoader {
    let baseURL: URL?

    func attachment(
        for url: URL,
        text: String,
        environment: ColorEnvironmentValues
    ) async throws -> ModelCardImageAttachment {
        guard let resolvedURL = Self.resolvedHTTPSURL(url, relativeTo: baseURL) else {
            throw URLError(.unsupportedURL)
        }
        let (data, response) = try await URLSession.shared.data(from: resolvedURL)
        guard let response = response as? HTTPURLResponse,
              200..<300 ~= response.statusCode,
              data.count <= 20 * 1_024 * 1_024,
              let image = NSImage(data: data),
              image.size.width > 0,
              image.size.height > 0 else {
            throw URLError(.cannotDecodeContentData)
        }
        return ModelCardImageAttachment(
            url: resolvedURL,
            data: data,
            text: text,
            naturalSize: image.size,
            maximumWidth: maximumWidth(for: resolvedURL)
        )
    }

    static func resolvedHTTPSURL(_ url: URL, relativeTo baseURL: URL?) -> URL? {
        guard let resolvedURL = URL(string: url.relativeString, relativeTo: baseURL)?.absoluteURL,
              resolvedURL.scheme?.lowercased() == "https" else { return nil }
        return resolvedURL
    }

    private func maximumWidth(for url: URL) -> CGFloat? {
        guard let marker = url.fragment?.split(separator: "&").first(where: {
            $0.hasPrefix("model-files-width=")
        })?.split(separator: "=", maxSplits: 1).last else { return nil }
        let value = String(marker)
        if value.hasSuffix("pct"), let percent = Double(value.dropLast(3)) {
            return 920 * min(max(percent, 1), 100) / 100
        }
        if value.hasSuffix("px"), let points = Double(value.dropLast(2)) {
            return min(max(points, 1), 920)
        }
        return nil
    }
}

struct ModelCardImageAttachment: Attachment {
    let url: URL
    let data: Data
    let text: String
    let naturalSize: CGSize
    let maximumWidth: CGFloat?

    var description: String { text }

    @MainActor
    @ViewBuilder
    var body: some View {
        if let image = NSImage(data: data) {
            SwiftUI.Image(nsImage: image)
                .resizable()
                .scaledToFit()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        let width = min(proposal.width ?? naturalSize.width, maximumWidth ?? naturalSize.width)
        return CGSize(width: width, height: width * naturalSize.height / naturalSize.width)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.url == rhs.url && lhs.maximumWidth == rhs.maximumWidth
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(url)
        hasher.combine(maximumWidth)
    }
}
