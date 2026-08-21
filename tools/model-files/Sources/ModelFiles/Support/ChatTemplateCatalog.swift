import Foundation

enum ChatTemplateSource: String, Sendable, Equatable {
    case tokenizerConfig
    case jinjaFile
}

struct ChatTemplateEntry: Identifiable, Sendable, Equatable {
    let name: String
    let source: ChatTemplateSource
    let body: String

    var id: String { "\(source.rawValue):\(name)" }
    var isUsable: Bool {
        !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum ChatTemplateCatalogError: LocalizedError, Sendable, Equatable {
    case invalidJSON(String)
    case invalidJinja(String)
    case rootIsNotObject
    case unsupportedShape(String)
    case invalidNamedTemplate(index: Int, reason: String)

    var errorDescription: String? {
        switch self {
        case let .invalidJSON(message):
            String(localized: "tokenizer_config.json 不是有效 JSON：\(message)")
        case let .invalidJinja(message):
            String(localized: "chat_template.jinja 无效：\(message)")
        case .rootIsNotObject:
            String(localized: "tokenizer_config.json 根节点不是对象。")
        case let .unsupportedShape(shape):
            String(localized: "chat_template 不支持的形态：\(shape)。支持字符串、对象字典或 named 数组。")
        case let .invalidNamedTemplate(index, reason):
            String(localized: "chat_template 的第 \(index) 个 named 条目无效：\(reason)")
        }
    }
}

struct ChatTemplateCatalog: Sendable, Equatable {
    let entries: [ChatTemplateEntry]
    let activeID: String?
    let conflict: Bool

    var activeEntry: ChatTemplateEntry? {
        guard let activeID else { return nil }
        return entries.first { $0.id == activeID && $0.isUsable }
    }

    var isAvailable: Bool { activeEntry != nil }

    init(entries: [ChatTemplateEntry], activeID: String? = nil, conflict: Bool = false) {
        self.entries = entries
        self.activeID = Self.selectID(in: entries, requestedID: activeID)
        self.conflict = conflict
    }

    static func parse(configData: Data) throws -> ChatTemplateCatalog {
        let root: [String: Any]
        do {
            guard let object = try JSONSerialization.jsonObject(
                with: configData,
                options: [.fragmentsAllowed]
            ) as? [String: Any] else {
                throw ChatTemplateCatalogError.rootIsNotObject
            }
            root = object
        } catch {
            if let error = error as? ChatTemplateCatalogError { throw error }
            throw ChatTemplateCatalogError.invalidJSON(error.localizedDescription)
        }

        guard let value = root["chat_template"] else {
            return ChatTemplateCatalog(entries: [])
        }

        let entries: [ChatTemplateEntry]
        if let body = value as? String {
            entries = [ChatTemplateEntry(name: "default", source: .tokenizerConfig, body: body)]
        } else if let named = value as? [String: Any] {
            entries = try named.keys.sorted().map { name in
                guard let body = named[name] as? String else {
                    throw ChatTemplateCatalogError.unsupportedShape(String(localized: "对象值必须是字符串"))
                }
                return ChatTemplateEntry(
                    name: name,
                    source: .tokenizerConfig,
                    body: body
                )
            }
        } else if let items = value as? [Any] {
            entries = try items.enumerated().map { index, item in
                guard let fields = item as? [String: Any] else {
                    throw ChatTemplateCatalogError.invalidNamedTemplate(
                        index: index,
                        reason: String(localized: "必须是包含 name 和 template 的对象")
                    )
                }
                guard let name = fields["name"] as? String,
                      !name.isEmpty else {
                    throw ChatTemplateCatalogError.invalidNamedTemplate(
                        index: index,
                        reason: String(localized: "name 必须是非空字符串")
                    )
                }
                guard let body = fields["template"] as? String else {
                    throw ChatTemplateCatalogError.invalidNamedTemplate(
                        index: index,
                        reason: String(localized: "template 必须是字符串")
                    )
                }
                return ChatTemplateEntry(name: name, source: .tokenizerConfig, body: body)
            }
        } else {
            throw ChatTemplateCatalogError.unsupportedShape(String(localized: "null、数字或布尔值"))
        }
        return ChatTemplateCatalog(entries: entries)
    }

    static func parse(
        configData: Data?,
        chatTemplateData: Data?
    ) throws -> ChatTemplateCatalog {
        let config = try configData.map { try parse(configData: $0) } ?? ChatTemplateCatalog(entries: [])
        var entries: [ChatTemplateEntry] = []
        if let chatTemplateData {
            guard let body = String(data: chatTemplateData, encoding: .utf8) else {
                throw ChatTemplateCatalogError.invalidJinja(String(localized: "不是有效 UTF-8"))
            }
            entries.append(ChatTemplateEntry(name: "default", source: .jinjaFile, body: body))
        }
        entries.append(contentsOf: config.entries)
        let jinjaIsUsable = entries.first {
            $0.source == .jinjaFile && $0.isUsable
        } != nil
        let configIsUsable = config.entries.contains(where: \.isUsable)
        let activeID = entries.first(where: {
            $0.source == .jinjaFile && $0.isUsable
        })?.id ?? config.activeID
        return ChatTemplateCatalog(
            entries: entries,
            activeID: activeID,
            conflict: jinjaIsUsable && configIsUsable
        )
    }

    func selecting(_ id: String?) -> ChatTemplateCatalog {
        ChatTemplateCatalog(entries: entries, activeID: id, conflict: conflict)
    }

    private static func selectID(
        in entries: [ChatTemplateEntry],
        requestedID: String?
    ) -> String? {
        if let requestedID, let index = entries.firstIndex(where: { $0.id == requestedID }) {
            let requested = entries[index]
            if requested.isUsable { return requested.id }
            return entries.dropFirst(index + 1).first(where: \.isUsable)?.id
                ?? entries.prefix(index).first(where: \.isUsable)?.id
        }
        return entries.first(where: { $0.name == "default" && $0.isUsable })?.id
            ?? entries.first(where: \.isUsable)?.id
    }
}
