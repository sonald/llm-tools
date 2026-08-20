import Foundation

enum TokenAttributor {
    static func contentProbe(messages: [TemplateMessage]) -> String {
        messages
            .filter { $0.contentKind == .text }
            .map(\.content)
            .joined(separator: "\n")
    }

    static func overhead(
        rendered: String,
        messages: [TemplateMessage],
        tokenize: (String) throws -> Int
    ) rethrows -> TokenOverhead {
        let contentProbe = contentProbe(messages: messages)
        let totalCount = try tokenize(rendered)
        let contentCount = try tokenize(contentProbe)
        return TokenOverhead(
            totalCount: totalCount,
            contentCount: contentCount,
            templateCount: totalCount - contentCount,
            isApproximate: true,
            contentProbe: contentProbe
        )
    }
}
