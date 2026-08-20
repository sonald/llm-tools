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

    static func roles(
        rendered: String,
        messages: [TemplateMessage],
        result: TokenizationResult
    ) -> [TokenRole]? {
        guard result.sourceMapping == .exact,
              result.segments.map(\.text).joined() == rendered else {
            return nil
        }

        var matches: [(range: Range<String.Index>, role: TokenRole)] = []
        var searchStart = rendered.startIndex
        for message in messages where message.contentKind == .text && !message.content.isEmpty {
            guard let range = rendered.range(
                of: message.content,
                range: searchStart..<rendered.endIndex
            ) else {
                continue
            }
            matches.append((range, TokenRole(message.role)))
            searchStart = range.upperBound
        }

        var roles = Array(repeating: TokenRole.template, count: result.tokenIDs.count)
        var renderedStart = rendered.startIndex
        var matchIndex = 0
        for segment in result.segments {
            guard segment.tokenRange.lowerBound >= 0,
                  segment.tokenRange.upperBound <= roles.count,
                  let renderedEnd = rendered.index(
                    renderedStart,
                    offsetBy: segment.text.count,
                    limitedBy: rendered.endIndex
                  ),
                  rendered[renderedStart..<renderedEnd] == segment.text else {
                return nil
            }

            while matchIndex < matches.count,
                  matches[matchIndex].range.upperBound <= renderedStart {
                matchIndex += 1
            }
            if renderedStart < renderedEnd,
               matchIndex < matches.count,
               matches[matchIndex].range.lowerBound <= renderedStart,
               renderedEnd <= matches[matchIndex].range.upperBound {
                for tokenIndex in segment.tokenRange {
                    roles[tokenIndex] = matches[matchIndex].role
                }
            }
            renderedStart = renderedEnd
        }

        return renderedStart == rendered.endIndex ? roles : nil
    }
}
