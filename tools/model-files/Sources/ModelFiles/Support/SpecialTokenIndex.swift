import CoreFoundation
import Foundation

struct SpecialTokenIndex: Sendable, Equatable {
    enum ParseError: LocalizedError, Equatable {
        case rootNotObject(String)

        var errorDescription: String? {
            switch self {
            case let .rootNotObject(name):
                String(localized: "\(name) 根节点不是对象。")
            }
        }
    }

    private(set) var specialIDs: Set<Int>
    let specialPieces: [String: String]
    private(set) var specialNamesByID: [Int: String]
    private var specialIDByPiece: [String: Int]

    var unresolvedPieces: [String] {
        specialPieces.keys.filter { specialIDByPiece[$0] == nil }.sorted()
    }

    init(tokenizerData: Data? = nil, tokenizerConfigData: Data? = nil) throws {
        let tokenizer = try Self.object(from: tokenizerData, named: "tokenizer.json")
        let config = try Self.object(from: tokenizerConfigData, named: "tokenizer_config.json")
        var pieces: [String: String] = [:]
        var namesByID: [Int: String] = [:]
        var idsByPiece: [String: Int] = [:]

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
                      let content = Self.content(from: token) else {
                    continue
                }
                pieces[content] = pieces[content] ?? content
                if let id = Self.nonNegativeInteger(token["id"]) {
                    namesByID[id] = namesByID[id] ?? pieces[content]
                    idsByPiece[content] = id
                }
            }
        }

        specialIDs = Set(namesByID.keys)
        specialPieces = pieces
        specialNamesByID = namesByID
        specialIDByPiece = idsByPiece
    }

    mutating func registerEncodedID(_ id: Int, for piece: String) {
        guard let name = specialPieces[piece] else { return }
        specialIDs.insert(id)
        specialNamesByID[id] = specialNamesByID[id] ?? name
        specialIDByPiece[piece] = id
    }

    private static func object(from data: Data?, named name: String) throws -> [String: Any] {
        guard let data else { return [:] }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ParseError.rootNotObject(name)
        }
        return object
    }

    private static func content(from value: Any?) -> String? {
        let content = value as? String ?? (value as? [String: Any])?["content"] as? String
        return content?.isEmpty == false ? content : nil
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
