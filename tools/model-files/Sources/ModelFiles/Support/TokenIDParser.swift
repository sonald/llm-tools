import CoreFoundation
import Foundation

enum TokenIDParser {
    static let maximumInputByteCount = 64 * 1_024

    enum ParseError: LocalizedError, Equatable {
        case inputTooLarge(limit: Int)
        case empty
        case invalidJSON(String)
        case invalidToken(index: Int, token: String)
        case negativeToken(index: Int, token: String)
        case integerOverflow(index: Int, token: String)

        var errorDescription: String? {
            switch self {
            case let .inputTooLarge(limit):
                "Token ID 输入超过 \(Int64(limit).formattedByteCount) 上限。"
            case .empty:
                "请输入至少一个 Token ID。"
            case let .invalidJSON(message):
                "Token ID JSON 数组无效：\(message)"
            case let .invalidToken(index, token):
                "第 \(index + 1) 个 token（index \(index)）不是整数：\(token)"
            case let .negativeToken(index, token):
                "第 \(index + 1) 个 token（index \(index)）不能是负数：\(token)"
            case let .integerOverflow(index, token):
                "第 \(index + 1) 个 token（index \(index)）超过 Int 范围：\(token)"
            }
        }
    }

    static func parse(_ input: String) throws -> [Int] {
        guard input.utf8.count <= maximumInputByteCount else {
            throw ParseError.inputTooLarge(limit: maximumInputByteCount)
        }

        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let tokens: [String]
        if trimmed.hasPrefix("[") {
            tokens = try jsonTokens(from: input)
        } else {
            tokens = input.split { $0 == "," || $0.isWhitespace }.map(String.init)
        }
        guard !tokens.isEmpty else { throw ParseError.empty }
        return try tokens.enumerated().map { try parseToken($0.element, at: $0.offset) }
    }

    private static func jsonTokens(from input: String) throws -> [String] {
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: Data(input.utf8))
        } catch {
            throw ParseError.invalidJSON(error.localizedDescription)
        }
        guard let values = value as? [Any] else {
            throw ParseError.invalidJSON("根节点必须是数组。")
        }
        return values.map(displayToken)
    }

    private static func displayToken(_ value: Any) -> String {
        if value is NSNull { return "null" }
        if let string = value as? String { return "\"\(string)\"" }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return number.boolValue ? "true" : "false"
            }
            return number.stringValue
        }
        return String(describing: value)
    }

    private static func parseToken(_ token: String, at index: Int) throws -> Int {
        if let value = Int(token) {
            guard value >= 0 else { throw ParseError.negativeToken(index: index, token: token) }
            return value
        }

        let digits = token.first == "+" || token.first == "-" ? token.dropFirst() : token[...]
        if !digits.isEmpty, digits.allSatisfy(Self.isASCIIDigit) {
            if token.first == "-" {
                throw ParseError.negativeToken(index: index, token: token)
            }
            throw ParseError.integerOverflow(index: index, token: token)
        }
        throw ParseError.invalidToken(index: index, token: token)
    }

    private static func isASCIIDigit(_ character: Character) -> Bool {
        guard character.unicodeScalars.count == 1,
              let value = character.unicodeScalars.first?.value else {
            return false
        }
        return (48...57).contains(value)
    }
}
