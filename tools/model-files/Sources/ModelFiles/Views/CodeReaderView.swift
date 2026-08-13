import SwiftUI
import Textual

struct CodeReaderView: View {
    let source: String
    let language: String

    var body: some View {
        StructuredText(markdown: fencedCodeMarkdown(source, language: language))
            .textual.structuredTextStyle(.gitHub)
            .textual.textSelection(.enabled)
            .textual.overflowMode(.scroll)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

func fencedCodeMarkdown(_ source: String, language: String) -> String {
    var longestRun = 0
    var currentRun = 0
    for character in source {
        if character == "`" {
            currentRun += 1
            longestRun = max(longestRun, currentRun)
        } else {
            currentRun = 0
        }
    }
    let fence = String(repeating: "`", count: max(3, longestRun + 1))
    return "\(fence)\(language)\n\(source)\(source.hasSuffix("\n") ? "" : "\n")\(fence)"
}
