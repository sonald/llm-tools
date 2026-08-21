import Foundation

struct FoldRange: Equatable, Hashable, Sendable {
    let startLine: Int
    let endLine: Int
}

enum SourceFolding {
    static func foldRanges(in source: String, language: String) -> [FoldRange] {
        switch language.lowercased() {
        case "python", "py", "pyw":
            return indentFolds(in: source, isHeader: isPythonHeader)
        case "yaml", "yml":
            return indentFolds(in: source, isHeader: isYAMLHeader)
        case "json":
            return jsonFolds(in: source)
        default:
            return []
        }
    }

    private static func indentFolds(in source: String, isHeader: (Substring) -> Bool) -> [FoldRange] {
        let lines = splitLines(source)
        guard !lines.isEmpty else { return [] }

        var ranges: [FoldRange] = []
        for index in lines.indices {
            let line = lines[index]
            guard let indent = leadingWhitespaceWidth(line), isHeader(line) else { continue }

            var end = index
            var sawDeeper = false
            var cursor = index + 1
            while cursor < lines.count {
                let next = lines[cursor]
                if next.isEmpty || next.allSatisfy(\.isWhitespace) {
                    cursor += 1
                    continue
                }
                guard let nextIndent = leadingWhitespaceWidth(next) else { break }
                if nextIndent > indent {
                    sawDeeper = true
                    end = cursor
                    cursor += 1
                    continue
                }
                break
            }
            if sawDeeper, end > index {
                ranges.append(FoldRange(startLine: index + 1, endLine: end + 1))
            }
        }
        return ranges
    }

    private static func jsonFolds(in source: String) -> [FoldRange] {
        var ranges: [FoldRange] = []
        var stack: [(closer: Character, startLine: Int)] = []
        var line = 1
        var inString = false
        var escaped = false
        var mismatched = false
        var index = source.startIndex

        while index < source.endIndex {
            let ch = source[index]
            if inString {
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == "\"" {
                    inString = false
                }
                if ch == "\n" { line += 1 }
                source.formIndex(after: &index)
                continue
            }

            switch ch {
            case "\"":
                inString = true
            case "{":
                stack.append(("}", line))
            case "[":
                stack.append(("]", line))
            case "}", "]":
                if let last = stack.last, last.closer == ch {
                    stack.removeLast()
                    if line > last.startLine {
                        ranges.append(FoldRange(startLine: last.startLine, endLine: line))
                    }
                } else {
                    mismatched = true
                }
            case "\n":
                line += 1
            default:
                break
            }
            source.formIndex(after: &index)
        }

        if mismatched || inString || !stack.isEmpty {
            return []
        }

        ranges.sort { lhs, rhs in
            if lhs.startLine != rhs.startLine { return lhs.startLine < rhs.startLine }
            return lhs.endLine > rhs.endLine
        }
        return ranges
    }

    private static func isPythonHeader(_ line: Substring) -> Bool {
        let code = pythonCodeWithoutComment(line).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return false }
        if code.contains("\"\"\"") || code.contains("'''") { return false }
        return code.hasSuffix(":")
    }

    private static func pythonCodeWithoutComment(_ line: Substring) -> String {
        var result = ""
        var quote: Character?
        var escaped = false
        for ch in line {
            if let current = quote {
                result.append(ch)
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == current {
                    quote = nil
                }
                continue
            }
            if ch == "#" { break }
            result.append(ch)
            if ch == "\"" || ch == "'" { quote = ch }
        }
        return result
    }

    private static func isYAMLHeader(_ line: Substring) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { return false }
        if trimmed == "-" { return true }
        if trimmed.hasPrefix("- ") {
            let item = trimmed.dropFirst(2).trimmingCharacters(in: .whitespaces)
            return item.isEmpty || yamlKeyColon(in: Substring(item)) != nil
        }
        guard let colon = yamlKeyColon(in: trimmed[...]) else { return false }
        let rest = trimmed[trimmed.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        if rest.isEmpty || rest.hasPrefix("#") { return true }
        return yamlIsBlockScalarIndicator(rest)
    }

    private static func yamlIsBlockScalarIndicator(_ rest: String) -> Bool {
        guard let first = rest.first, first == "|" || first == ">" else { return false }
        let marker = rest.dropFirst()
        if marker.isEmpty || marker.hasPrefix("#") { return true }
        if marker.first == "-" || marker.first == "+" {
            let after = marker.dropFirst()
            return after.isEmpty || after.first!.isWhitespace || after.hasPrefix("#")
        }
        return false
    }

    private static func yamlKeyColon(in text: Substring) -> String.Index? {
        var quote: Character?
        var escaped = false
        var index = text.startIndex
        while index < text.endIndex {
            let ch = text[index]
            if let current = quote {
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == current {
                    quote = nil
                }
            } else if ch == "\"" || ch == "'" {
                quote = ch
            } else if ch == ":" {
                let next = text.index(after: index)
                if next == text.endIndex || text[next].isWhitespace {
                    return index
                }
            }
            text.formIndex(after: &index)
        }
        return nil
    }

    private static func splitLines(_ source: String) -> [Substring] {
        if source.isEmpty { return [] }
        var lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        if source.hasSuffix("\n"), lines.last?.isEmpty == true {
            lines.removeLast()
        }
        return lines
    }

    private static func leadingWhitespaceWidth(_ line: Substring) -> Int? {
        var width = 0
        for ch in line {
            if ch == " " {
                width += 1
            } else if ch == "\t" {
                width += 1
            } else if ch.isWhitespace || ch == "\r" {
                continue
            } else {
                return width
            }
        }
        return nil
    }
}
