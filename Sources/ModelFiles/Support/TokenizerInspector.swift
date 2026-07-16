import Foundation

struct TokenizerFieldInfo: Identifiable, Sendable, Equatable {
    let name: String
    let detail: String

    var id: String { name }
}

struct TokenizerOverview: Sendable, Equatable {
    let version: String?
    let modelType: String?
    let vocabCount: Int?
    let mergeCount: Int?
    let addedTokenCount: Int?
    let fields: [TokenizerFieldInfo]
}

struct TokenizerInspection: Sendable {
    let overview: TokenizerOverview?
    let error: String?
}

enum TokenizerInspector {
    static func inspect(_ data: Data) -> TokenizerInspection {
        do {
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return TokenizerInspection(overview: nil, error: "tokenizer.json 根节点不是对象。")
            }
            let model = root["model"] as? [String: Any]
            let overview = TokenizerOverview(
                version: root["version"] as? String,
                modelType: model?["type"] as? String,
                vocabCount: (model?["vocab"] as? [String: Any])?.count,
                mergeCount: (model?["merges"] as? [Any])?.count,
                addedTokenCount: (root["added_tokens"] as? [Any])?.count,
                fields: root.keys.sorted().map {
                    TokenizerFieldInfo(name: $0, detail: describe(root[$0]))
                }
            )
            return TokenizerInspection(overview: overview, error: nil)
        } catch {
            return TokenizerInspection(overview: nil, error: error.localizedDescription)
        }
    }

    private static func describe(_ value: Any?) -> String {
        switch value {
        case nil, is NSNull:
            return "null"
        case let value as [String: Any]:
            if let type = value["type"] as? String {
                return "对象 · \(value.count.formatted()) 字段 · type: \(type)"
            }
            return "对象 · \(value.count.formatted()) 字段"
        case let value as [Any]:
            return "数组 · \(value.count.formatted()) 项"
        case let value as String:
            return value.count > 80 ? "字符串 · \(value.count.formatted()) 字符" : value
        case let value as NSNumber:
            return value.stringValue
        default:
            return String(describing: value)
        }
    }
}
