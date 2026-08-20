import CoreFoundation
import Foundation

struct SpecialTokenIndex: Sendable, Equatable {
    enum ParseError: LocalizedError, Equatable {
        case rootNotObject(String)

        var errorDescription: String? {
            switch self {
            case let .rootNotObject(name):
                "\(name) 根节点不是对象。"
            }
        }
    }

    let specialIDs: Set<Int>
    let specialPieces: [String: String]
    let specialNamesByID: [Int: String]

    init(tokenizerData: Data? = nil, tokenizerConfigData: Data? = nil) throws {
        let tokenizer = try Self.object(from: tokenizerData, named: "tokenizer.json")
        let config = try Self.object(from: tokenizerConfigData, named: "tokenizer_config.json")
        var pieces: [String: String] = [:]
        var namesByID: [Int: String] = [:]

        for name in [
            "bos_token", "eos_token", "pad_token", "unk_token",
            "cls_token", "sep_token", "mask_token",
        ] {
            if let content = Self.content(from: config[name]) {
                pieces[content] = pieces[content] ?? name
            }
        }

        if let additional = config["additional_special_tokens"] as? [Any] {
            for value in additional {
                if let content = Self.content(from: value) {
                    pieces[content] = pieces[content] ?? content
                }
            }
        }

        if let addedTokens = tokenizer["added_tokens"] as? [Any] {
            for case let token as [String: Any] in addedTokens {
                guard Self.isTrue(token["special"]),
                      let content = token["content"] as? String else {
                    continue
                }
                pieces[content] = pieces[content] ?? content
                if let id = Self.nonNegativeInteger(token["id"]) {
                    namesByID[id] = namesByID[id] ?? pieces[content]
                }
            }
        }

        specialIDs = Set(namesByID.keys)
        specialPieces = pieces
        specialNamesByID = namesByID
    }

    private static func object(from data: Data?, named name: String) throws -> [String: Any] {
        guard let data else { return [:] }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ParseError.rootNotObject(name)
        }
        return object
    }

    private static func content(from value: Any?) -> String? {
        if let value = value as? String { return value }
        return (value as? [String: Any])?["content"] as? String
    }

    private static func isTrue(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else {
            return false
        }
        return number.boolValue
    }

    private static func nonNegativeInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              let id = Int(number.stringValue),
              id >= 0 else {
            return nil
        }
        return id
    }
}
