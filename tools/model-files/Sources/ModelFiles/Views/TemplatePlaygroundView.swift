import AppKit
import SwiftUI

struct TemplatePlaygroundView: View {
    private let originalTemplate: String

    @State private var template: String
    @State private var messages: [TemplateMessage]
    @State private var includeTools = false
    @State private var tools: [TemplateTool]
    @State private var variables: [TemplateVariable]
    @State private var addGenerationPrompt = true
    @State private var output = ""
    @State private var renderError: String?
    @State private var isRendering = false
    @State private var selectedOutputItemID: Int?

    init(template: String, tokenizerConfig: [String: Any]) {
        originalTemplate = template
        _template = State(initialValue: template)
        _messages = State(initialValue: Self.basicMessages)
        _tools = State(initialValue: [Self.weatherTool])
        _variables = State(initialValue: Self.initialVariables(
            template: template,
            tokenizerConfig: tokenizerConfig
        ))
    }

    private var request: TemplateRenderRequest {
        TemplateRenderRequest(
            template: template,
            messages: messages,
            includeTools: includeTools,
            tools: tools,
            variables: variables,
            addGenerationPrompt: addGenerationPrompt
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Label("Chat Template 试验台", systemImage: "curlybraces.square")
                    .font(.headline)
                renderStatus
                Spacer()
                Menu("载入示例") {
                    Button("基础对话") { loadBasicPreset() }
                    Button("工具调用") { loadToolPreset() }
                    Button("多模态 content") { loadMultimodalPreset() }
                }
                Button("恢复原模板") {
                    template = originalTemplate
                }
            }

            HSplitView {
                inputPane
                    .frame(minWidth: 280, idealWidth: 300, maxWidth: 340)

                VSplitView {
                    templatePane
                        .frame(minHeight: 220)
                    previewPane
                        .frame(minHeight: 260)
                }
            }
            .frame(minHeight: 480, maxHeight: .infinity)
            .background(.quaternary.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(.separator.opacity(0.65))
            }
        }
        .task(id: request) {
            isRendering = true
            try? await Task.sleep(nanoseconds: 220_000_000)
            guard !Task.isCancelled else { return }
            let currentRequest = request
            let outcome = await Task.detached(priority: .userInitiated) {
                TemplateRenderer.render(currentRequest)
            }.value
            guard !Task.isCancelled else { return }
            output = outcome.output
            renderError = outcome.error
            let items = RenderedOutputInspector.items(in: outcome.output)
            selectedOutputItemID = items.first {
                RenderedOutputInspector.prettyPrintedJSON(for: $0, in: outcome.output) != nil
            }?.id ?? items.first?.id
            isRendering = false
        }
    }

    private var renderStatus: some View {
        HStack(spacing: 5) {
            if isRendering {
                ProgressView().controlSize(.mini)
                Text("渲染中")
            } else if renderError != nil {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                Text("输入或模板有错误")
            } else {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("实时预览")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var inputPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 9) {
                    Text("运行选项").font(.headline)
                    Toggle("add_generation_prompt", isOn: $addGenerationPrompt)
                        .font(.system(.callout, design: .monospaced))
                }

                Divider()

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Messages").font(.headline)
                        Spacer()
                        Button {
                            messages.append(TemplateMessage(role: "user", content: ""))
                        } label: {
                            Label("添加", systemImage: "plus")
                        }
                    }

                    ForEach($messages) { $message in
                        MessageInputCard(message: $message) {
                            messages.removeAll { $0.id == message.id }
                        }
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 10) {
                    Toggle(isOn: $includeTools) {
                        Text("Tools").font(.headline)
                    }
                    if includeTools {
                        ForEach($tools) { $tool in
                            ToolInputCard(tool: $tool) {
                                tools.removeAll { $0.id == tool.id }
                            }
                        }
                        Button {
                            tools.append(Self.emptyTool)
                        } label: {
                            Label("添加 Tool", systemImage: "plus")
                        }
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("其他变量").font(.headline)
                        Spacer()
                        Button {
                            variables.append(TemplateVariable(
                                name: "custom_arg",
                                kind: .string
                            ))
                        } label: {
                            Label("添加", systemImage: "plus")
                        }
                    }
                    Text("用于特殊 token 和任意 template kwargs。对象与数组使用 JSON。")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    ForEach($variables) { $variable in
                        VariableInputRow(variable: $variable) {
                            variables.removeAll { $0.id == variable.id }
                        }
                    }
                }
            }
            .padding(14)
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.38))
    }

    private var templatePane: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(
                title: "Jinja 模板",
                detail: "\(template.split(whereSeparator: \.isNewline).count) 行"
            )
            Divider()
            JinjaTextEditor(text: $template)
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var previewPane: some View {
        let items = RenderedOutputInspector.items(in: output)
        let selectedItem = items.first { $0.id == selectedOutputItemID }

        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                PaneHeader(
                    title: "渲染结果",
                    detail: renderError == nil ? "\(output.utf8.count.formatted()) bytes" : "未生成"
                )
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(output, forType: .string)
                } label: {
                    Label("复制原始输出", systemImage: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .disabled(output.isEmpty)
                .padding(.trailing, 12)
            }
            Divider()

            if let renderError {
                ScrollView {
                    Label(renderError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                if output.isEmpty {
                    Text("模板没有产生输出。")
                        .font(.system(size: 12.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(14)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                } else {
                    HSplitView {
                        outputStructurePane(items: items, selectedItem: selectedItem)
                            .frame(minWidth: 190, idealWidth: 220, maxWidth: 280)
                        rawOutputPane(selectedItem: selectedItem)
                            .frame(minWidth: 360)
                    }
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private func outputStructurePane(
        items: [RenderedOutputItem],
        selectedItem: RenderedOutputItem?
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("结构索引 · 只读")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .frame(height: 30)
            Divider()

            if items.isEmpty {
                Text("未识别可索引的消息边界")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(10)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(items) { item in
                            Button {
                                selectedOutputItemID = item.id
                            } label: {
                                HStack(spacing: 6) {
                                    if item.level > 0 {
                                        Image(systemName: "circle.fill")
                                            .font(.system(size: 5))
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(item.title)
                                        .font(item.level == 0 ? .caption.weight(.semibold) : .caption)
                                        .lineLimit(1)
                                    if let detail = item.detail {
                                        Text(detail)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.leading, item.level == 0 ? 8 : 24)
                                .padding(.trailing, 8)
                                .frame(height: 25)
                                .contentShape(Rectangle())
                                .background(
                                    item.id == selectedOutputItemID
                                        ? Color.accentColor.opacity(0.16)
                                        : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 5)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(5)
                }
            }

            if let selectedItem,
               let json = RenderedOutputInspector.prettyPrintedJSON(for: selectedItem, in: output) {
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 4) {
                        Text("内容检查器")
                            .font(.caption.weight(.semibold))
                        Text("解析视图，不属于输出")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 28)
                    Divider()
                    ScrollView([.horizontal, .vertical]) {
                        Text(json)
                            .font(.system(size: 11.5, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(9)
                    }
                    .frame(minHeight: 80, idealHeight: 130, maxHeight: 170)
                }
            }

            Divider()
            Text("仅引用原文范围；渲染结果未修改")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .frame(height: 26)
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.28))
    }

    private func rawOutputPane(selectedItem: RenderedOutputItem?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("原始输出 · 权威")
                    .font(.caption.weight(.semibold))
                Spacer()
                Text("软换行仅用于显示，不属于输出")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            Divider()
            RenderedOutputTextView(text: output, highlightedRange: selectedItem?.range)
        }
    }

    private func loadBasicPreset() {
        messages = Self.basicMessages
        includeTools = false
        addGenerationPrompt = true
    }

    private func loadToolPreset() {
        messages = [
            TemplateMessage(role: "system", content: "You are a helpful assistant."),
            TemplateMessage(role: "user", content: "What is the weather in Shanghai?"),
        ]
        tools = [Self.weatherTool]
        includeTools = true
        addGenerationPrompt = true
    }

    private func loadMultimodalPreset() {
        messages = [
            TemplateMessage(
                role: "user",
                contentKind: .json,
                content: """
                [
                  {"type": "image", "url": "image://sample"},
                  {"type": "text", "text": "Describe this image."}
                ]
                """
            )
        ]
        includeTools = false
        addGenerationPrompt = true
    }

    private static var basicMessages: [TemplateMessage] {
        [
            TemplateMessage(role: "system", content: "You are a helpful assistant."),
            TemplateMessage(role: "user", content: "Hello!"),
        ]
    }

    private static var weatherTool: TemplateTool {
        TemplateTool(
            name: "get_weather",
            description: "Get the current weather for a city.",
            parametersJSON: """
            {
              "type": "object",
              "properties": {
                "city": {"type": "string", "description": "City name"}
              },
              "required": ["city"]
            }
            """
        )
    }

    private static var emptyTool: TemplateTool {
        TemplateTool(
            name: "new_tool",
            description: "",
            parametersJSON: """
            {
              "type": "object",
              "properties": {}
            }
            """
        )
    }

    private static func initialVariables(
        template: String,
        tokenizerConfig: [String: Any]
    ) -> [TemplateVariable] {
        var result: [TemplateVariable] = []
        for name in ["bos_token", "eos_token", "pad_token", "unk_token"] {
            if let value = tokenizerConfig[name] as? String {
                result.append(TemplateVariable(name: name, kind: .string, value: value))
            } else if tokenizerConfig[name] is NSNull {
                result.append(TemplateVariable(name: name, kind: .null))
            }
        }
        if template.contains("enable_thinking") {
            result.append(TemplateVariable(name: "enable_thinking", kind: .boolean, value: "true"))
        }
        if template.contains("documents") {
            result.append(TemplateVariable(name: "documents", kind: .json, value: "[]"))
        }
        return result
    }
}

private struct PaneHeader: View {
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.headline)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
    }
}

private struct MessageInputCard: View {
    @Binding var message: TemplateMessage
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("Role", selection: $message.role) {
                    ForEach(["system", "user", "assistant", "tool"], id: \.self) {
                        Text($0).tag($0)
                    }
                }
                .labelsHidden()
                .frame(width: 115)

                Picker("Content 类型", selection: $message.contentKind) {
                    ForEach(MessageContentKind.allCases) { kind in
                        Text(kind.title).tag(kind)
                    }
                }
                .labelsHidden()
                .frame(width: 80)

                Spacer()
                Button(role: .destructive, action: onDelete) {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .help("删除消息")
            }

            TextEditor(text: $message.content)
                .font(.system(.caption, design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(6)
                .frame(minHeight: 64)
                .background(.quaternary.opacity(0.42), in: RoundedRectangle(cornerRadius: 7))
        }
        .padding(10)
        .background(.background, in: RoundedRectangle(cornerRadius: 9))
        .overlay {
            RoundedRectangle(cornerRadius: 9).stroke(.separator.opacity(0.55))
        }
    }
}

private struct ToolInputCard: View {
    @Binding var tool: TemplateTool
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("函数名", text: $tool.name)
                    .font(.system(.callout, design: .monospaced))
                Button(role: .destructive, action: onDelete) {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }
            TextField("描述", text: $tool.description)
            Text("Parameters JSON")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $tool.parametersJSON)
                .font(.system(.caption, design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(6)
                .frame(minHeight: 130)
                .background(.quaternary.opacity(0.42), in: RoundedRectangle(cornerRadius: 7))
        }
        .padding(10)
        .background(.background, in: RoundedRectangle(cornerRadius: 9))
        .overlay {
            RoundedRectangle(cornerRadius: 9).stroke(.separator.opacity(0.55))
        }
    }
}

private struct VariableInputRow: View {
    @Binding var variable: TemplateVariable
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                TextField("变量名", text: $variable.name)
                    .font(.system(.callout, design: .monospaced))
                Picker("类型", selection: $variable.kind) {
                    ForEach(TemplateValueKind.allCases) { kind in
                        Text(kind.title).tag(kind)
                    }
                }
                .labelsHidden()
                .frame(width: 88)
                Button(role: .destructive, action: onDelete) {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }

            switch variable.kind {
            case .boolean:
                Toggle("值", isOn: Binding(
                    get: { variable.value != "false" },
                    set: { variable.value = $0 ? "true" : "false" }
                ))
            case .null:
                Text("null")
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.secondary)
            case .json:
                TextEditor(text: $variable.value)
                    .font(.system(.caption, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(5)
                    .frame(minHeight: 72)
                    .background(.quaternary.opacity(0.42), in: RoundedRectangle(cornerRadius: 7))
            default:
                TextField("值", text: $variable.value)
                    .textFieldStyle(.roundedBorder)
            }
        }
        .padding(9)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.5))
        }
    }
}
