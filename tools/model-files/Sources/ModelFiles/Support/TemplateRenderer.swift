import Foundation
import Jinja

enum TemplateValueKind: String, CaseIterable, Identifiable, Sendable {
    case string
    case integer
    case decimal
    case boolean
    case json
    case null

    var id: Self { self }

    var title: String {
        switch self {
        case .string: "字符串"
        case .integer: "整数"
        case .decimal: "小数"
        case .boolean: "布尔"
        case .json: "JSON"
        case .null: "Null"
        }
    }
}

enum MessageContentKind: String, CaseIterable, Identifiable, Sendable {
    case text
    case json

    var id: Self { self }
    var title: String { self == .text ? "文本" : "JSON" }
}

struct TemplateMessage: Identifiable, Hashable, Sendable {
    let id: UUID
    var role: String
    var contentKind: MessageContentKind
    var content: String

    init(
        id: UUID = UUID(),
        role: String,
        contentKind: MessageContentKind = .text,
        content: String
    ) {
        self.id = id
        self.role = role
        self.contentKind = contentKind
        self.content = content
    }
}

struct TemplateTool: Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String
    var description: String
    var parametersJSON: String

    init(
        id: UUID = UUID(),
        name: String,
        description: String,
        parametersJSON: String
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.parametersJSON = parametersJSON
    }
}

struct TemplateVariable: Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String
    var kind: TemplateValueKind
    var value: String

    init(id: UUID = UUID(), name: String, kind: TemplateValueKind, value: String = "") {
        self.id = id
        self.name = name
        self.kind = kind
        self.value = value
    }
}

struct TemplateRenderRequest: Hashable, Sendable {
    let template: String
    let messages: [TemplateMessage]
    let includeTools: Bool
    let tools: [TemplateTool]
    let variables: [TemplateVariable]
    let addGenerationPrompt: Bool
}

struct TemplateRenderOutcome: Sendable {
    let output: String
    let error: String?
}

enum TemplateRenderer {
    static func render(_ request: TemplateRenderRequest) -> TemplateRenderOutcome {
        do {
            let template = try Template(request.template)
            let environment = Environment()
            environment["tojson"] = .function(compatibleToJSON)
            return TemplateRenderOutcome(
                output: try template.render(context(for: request), environment: environment),
                error: nil
            )
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            return TemplateRenderOutcome(output: "", error: message)
        }
    }

    private static let compatibleToJSON: @Sendable ([Value], [String: Value], Environment) throws -> Value = {
        args, kwargs, environment in
        var kwargs = kwargs
        if let sortKeys = kwargs.removeValue(forKey: "sort_keys") {
            guard case .boolean(true) = sortKeys else {
                throw RenderError("tojson 目前只支持 sort_keys=true。")
            }
        }
        if let separators = kwargs.removeValue(forKey: "separators") {
            guard case .array([.string(","), .string(":")]) = separators else {
                throw RenderError("tojson 目前只支持 separators=(\",\", \":\")。")
            }
        }
        return try Filters.tojson(args, kwargs: kwargs, env: environment)
    }

    static func context(for request: TemplateRenderRequest) throws -> [String: Value] {
        var context: [String: Value] = [
            "messages": try Value(any: request.messages.map(messageValue)),
            "add_generation_prompt": .boolean(request.addGenerationPrompt),
        ]

        if request.includeTools {
            context["tools"] = try Value(any: request.tools.map(toolValue))
        }

        let reserved = Set(context.keys).union(["tools"])
        var seen = Set<String>()
        for variable in request.variables {
            let name = variable.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { throw RenderError("变量名不能为空。") }
            guard !reserved.contains(name) else { throw RenderError("“\(name)”由专用编辑器管理。") }
            guard seen.insert(name).inserted else { throw RenderError("变量“\(name)”重复。") }
            context[name] = try value(for: variable)
        }

        return context
    }

    private static func messageValue(_ message: TemplateMessage) throws -> [String: Any] {
        let content: Any
        switch message.contentKind {
        case .text:
            content = message.content
        case .json:
            content = try parseJSON(message.content, label: "\(message.role) message content")
        }
        return ["role": message.role, "content": content]
    }

    private static func toolValue(_ tool: TemplateTool) throws -> [String: Any] {
        let name = tool.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw RenderError("Tool 名称不能为空。") }
        let parameters = try parseJSON(tool.parametersJSON, label: "Tool \(name) parameters")
        guard parameters is [String: Any] else {
            throw RenderError("Tool \(name) 的 parameters 必须是 JSON 对象。")
        }
        return [
            "type": "function",
            "function": [
                "name": name,
                "description": tool.description,
                "parameters": parameters,
            ],
        ]
    }

    private static func value(for variable: TemplateVariable) throws -> Value {
        switch variable.kind {
        case .string:
            return .string(variable.value)
        case .integer:
            guard let value = Int(variable.value) else {
                throw RenderError("变量“\(variable.name)”需要整数。")
            }
            return .int(value)
        case .decimal:
            guard let value = Double(variable.value) else {
                throw RenderError("变量“\(variable.name)”需要数字。")
            }
            return .double(value)
        case .boolean:
            return .boolean(variable.value != "false")
        case .json:
            return try Value(any: parseJSON(variable.value, label: "变量 \(variable.name)"))
        case .null:
            return .null
        }
    }

    private static func parseJSON(_ source: String, label: String) throws -> Any {
        guard let data = source.data(using: .utf8) else {
            throw RenderError("\(label) 不是有效 UTF-8。")
        }
        do {
            return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            throw RenderError("\(label) JSON 无效：\(error.localizedDescription)")
        }
    }
}

private struct RenderError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}
