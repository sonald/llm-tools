import AppKit
import SwiftUI

func visibleTokenizerText(_ text: String, showWhitespace: Bool) -> String {
    guard showWhitespace else {
        return text
            .replacingOccurrences(of: "\r\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
    }
    return text
        .replacingOccurrences(of: " ", with: "·")
        .replacingOccurrences(of: "\t", with: "→")
        .replacingOccurrences(of: "\r\n", with: "↵")
        .replacingOccurrences(of: "\r", with: "↵")
        .replacingOccurrences(of: "\n", with: "↵")
}

func toggleTokenSelection(_ current: Int?, clicked: Int) -> Int? {
    current == clicked ? nil : clicked
}

struct TokenizerPlaygroundView: View {
    enum InputMode: String, CaseIterable, Identifiable {
        case raw
        case chat
        case tokenIDs

        var id: Self { self }
        var title: String {
            switch self {
            case .raw: "原始文本"
            case .chat: "Chat 对话"
            case .tokenIDs: "Token IDs"
            }
        }
    }

    private enum WorkRequest: Hashable {
        case waiting
        case raw(String)
        case chat(TemplateRenderRequest)
        case tokenIDs(String)
    }

    private enum ResultMode: String, CaseIterable, Identifiable {
        case segments
        case table

        var id: Self { self }
        var title: String { self == .segments ? "片段" : "Token 表" }
    }

    @ObservedObject var store: ModelFilesStore
    let file: RepositoryFile

    @State private var inputMode: InputMode = .chat
    @State private var rawText = "ModelFiles 让 tokenizer 的行为变得可见。 👩‍💻\nWhitespace matters."
    @State private var tokenIDsText = ""
    @State private var messages = [
        TemplateMessage(role: "system", content: "You are a concise assistant."),
        TemplateMessage(role: "user", content: "解释一下：分词为什么会影响上下文长度？"),
    ]
    @State private var includeTools = false
    @State private var tools = [TemplateTool(
        name: "get_weather",
        description: "Get the current weather for a city.",
        parametersJSON: #"{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}"#
    )]
    @State private var variables: [TemplateVariable] = []
    @State private var didInitializeVariables = false
    @State private var addGenerationPrompt = true
    @State private var renderedText = ""
    @State private var renderError: String?
    @State private var isRendering = false
    @State private var showWhitespace = false
    @State private var resultMode: ResultMode = .segments
    @State private var selectedTokenIndex: Int?

    var body: some View {
        GeometryReader { proxy in
            let available = max(0, proxy.size.width - 12)
            let leftWidth = max(360, min(540, available * 0.46))

            HStack(spacing: 12) {
                leftColumn
                    .frame(width: leftWidth)
                rightColumn
                    .frame(maxWidth: .infinity)
            }
            .padding(14)
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.48))
        .task(id: workRequest) {
            await updateAuthoritativeInput()
        }
        .onChange(of: store.tokenizerPhase) { _, phase in
            let bundleLoadFinished: Bool
            switch phase {
            case .ready, .failed:
                bundleLoadFinished = true
            default:
                bundleLoadFinished = false
            }
            if bundleLoadFinished, store.tokenizerChatTemplate == nil, inputMode == .chat {
                inputMode = .raw
            }
        }
        .onChange(of: store.tokenizerConfigData) { _, _ in
            initializeVariablesIfNeeded()
        }
        .onChange(of: store.tokenizerChatTemplate) { _, _ in
            initializeVariablesIfNeeded()
        }
        .onChange(of: store.tokenizationResult) { _, _ in
            selectedTokenIndex = nil
        }
        .onAppear {
            initializeVariablesIfNeeded()
        }
    }

    private var leftColumn: some View {
        VStack(spacing: 12) {
            TokenizerPanel {
                TokenizerPanelHeader(title: "输入", detail: inputStatus) {
                    Picker("输入模式", selection: $inputMode) {
                        ForEach(InputMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                                .disabled(mode == .chat && !chatIsAvailable)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .frame(width: 250)
                    .help(chatIsAvailable ? "选择原始文本、Chat Template 或 Token IDs 输入" : "当前目录没有可用 Chat Template；Token IDs 仍可用")
                }

                Group {
                    if inputMode == .chat {
                        TemplateRequestEditor(
                            messages: $messages,
                            includeTools: $includeTools,
                            tools: $tools,
                            variables: $variables,
                            addGenerationPrompt: $addGenerationPrompt,
                            compact: true
                        )
                    } else if inputMode == .raw {
                        VStack(spacing: 0) {
                            TextEditor(text: $rawText)
                                .font(.system(size: 12.5, design: .monospaced))
                                .scrollContentBackground(.hidden)
                                .padding(9)
                                .accessibilityLabel("原始文本")
                            Divider()
                            HStack {
                                Text("\(rawText.utf8.count.formatted()) bytes")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("清空") { rawText = "" }
                                    .controlSize(.small)
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 38)
                        }
                    } else {
                        VStack(spacing: 0) {
                            TextEditor(text: $tokenIDsText)
                                .font(.system(size: 12.5, design: .monospaced))
                                .scrollContentBackground(.hidden)
                                .padding(9)
                                .accessibilityLabel("Token IDs")
                            Divider()
                            HStack {
                                Text("支持逗号、空白或 JSON 数组")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("清空") { tokenIDsText = "" }
                                    .controlSize(.small)
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 38)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxHeight: .infinity)

            TokenizerPanel {
                TokenizerPanelHeader(
                    title: inputMode == .tokenIDs ? "解码文本" : "送入 tokenizer 的文本",
                    detail: authoritativeInputDetail
                ) {
                    Button("复制") { copyAuthoritativeInput() }
                        .controlSize(.small)
                        .disabled(authoritativeText.isEmpty)
                }
                Group {
                    if let renderError {
                        Label(renderError, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .padding(12)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    } else if authoritativeText.isEmpty {
                        Text(inputMode == .tokenIDs ? "输入 Token ID 后显示解码文本。" : "输入内容后显示实际编码文本。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(12)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    } else {
                        ScrollView([.horizontal, .vertical]) {
                            Text(authoritativeText)
                                .font(.system(size: 11.5, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(11)
                        }
                    }
                }
            }
            .frame(minHeight: 138, idealHeight: 170, maxHeight: 230)
        }
    }

    private var rightColumn: some View {
        VStack(spacing: 12) {
            metrics
                .frame(height: inputMode == .chat ? 105 : 63)

            TokenizerPanel {
                TokenizerPanelHeader(title: "分词结果", detail: resultStatus) {
                    HStack(spacing: 10) {
                        Picker("结果视图", selection: $resultMode) {
                            ForEach(ResultMode.allCases) { mode in
                                Text(mode.title).tag(mode)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .frame(width: 128)
                        Toggle("显示空白符", isOn: $showWhitespace)
                            .toggleStyle(.checkbox)
                            .font(.caption)
                    }
                }
                resultBody
            }
            .frame(maxHeight: .infinity)

            TokenizerPanel {
                TokenizerPanelHeader(
                    title: "Token IDs",
                    detail: "\(store.tokenizationResult?.tokenCount.formatted() ?? "0") items"
                ) {
                    Button("复制") { copyTokenIDs() }
                        .controlSize(.small)
                        .disabled(store.tokenizationResult?.tokenIDs.isEmpty != false)
                }
                idsBody
            }
            .frame(minHeight: 164, idealHeight: 198, maxHeight: 250)
        }
    }

    private var metrics: some View {
        VStack(spacing: 6) {
            HStack(spacing: 9) {
                metricCard("Token count", value: store.tokenizationResult?.tokenCount.formatted() ?? "—")
                metricCard("Unicode 字符", value: authoritativeText.count.formatted())
                metricCard("Bytes / token", value: bytesPerToken)
            }
            if inputMode == .chat {
                HStack(spacing: 9) {
                    metricCard("正文 token", value: chatContentCount, compact: true)
                    metricCard("模板开销（近似）", value: chatTemplateCount, compact: true)
                }
            }
        }
    }

    private func metricCard(_ title: String, value: String, compact: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: compact ? 14 : 19, weight: .semibold, design: .rounded))
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 11)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.65))
        }
    }

    @ViewBuilder
    private var resultBody: some View {
        switch store.tokenizerPhase {
        case .loading:
            stateView(title: "正在加载 tokenizer…", progress: true)
        case .tokenizing:
            stateView(title: "正在编码最新输入…", progress: true)
        case let .inputTooLarge(limit):
            stateView(title: "输入超过 \(Int64(limit).formattedByteCount) 上限", systemImage: "exclamationmark.triangle")
        case let .failed(message):
            if inputMode == .tokenIDs {
                stateView(title: message, systemImage: "xmark.octagon")
            } else {
                VStack(spacing: 10) {
                    stateView(title: message, systemImage: "xmark.octagon")
                    Button("重试") { store.retryTokenizerPlayground() }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case .idle:
            stateView(title: "等待加载 tokenizer", systemImage: "hourglass")
        case .ready:
            if let result = store.tokenizationResult, !result.tokenIDs.isEmpty {
                if resultMode == .segments {
                    ScrollView {
                        TokenizerWrapLayout(spacing: 3) {
                            ForEach(Array(result.segments.enumerated()), id: \.element.id) { index, segment in
                                let selected = selectedTokenIndex.map(segment.tokenRange.contains) == true
                                Button {
                                    selectedTokenIndex = toggleTokenSelection(
                                        selectedTokenIndex,
                                        clicked: segment.tokenRange.lowerBound
                                    )
                                } label: {
                                    Text(visible(segment.text))
                                        .font(.system(size: 12.5, design: .monospaced))
                                        .padding(.horizontal, 3)
                                        .padding(.vertical, 2)
                                        .background(segmentColor(index), in: RoundedRectangle(cornerRadius: 3))
                                        .overlay {
                                            if selected {
                                                RoundedRectangle(cornerRadius: 3)
                                                    .stroke(.primary.opacity(0.7), lineWidth: 2)
                                            }
                                        }
                                        .opacity(selectedTokenIndex == nil || selected ? 1 : 0.28)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(
                                    "Token \(segment.tokenRange.lowerBound) 到 \(segment.tokenRange.upperBound - 1)，ID \(segment.tokenIDs.map(String.init).joined(separator: ", "))，文本 \(visible(segment.text))"
                                )
                                .accessibilityAddTraits(selected ? .isSelected : [])
                            }
                        }
                        .padding(13)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    TokenizerTokenTableView(
                        result: result,
                        showWhitespace: showWhitespace,
                        selectedTokenIndex: $selectedTokenIndex
                    )
                }
            } else {
                stateView(title: "输入内容后显示 token。", systemImage: "text.word.spacing")
            }
        }
    }

    @ViewBuilder
    private var idsBody: some View {
        if let result = store.tokenizationResult, !result.tokenIDs.isEmpty {
            ScrollView {
                TokenizerWrapLayout(spacing: 3) {
                    ForEach(result.tokenIDs.indices, id: \.self) { index in
                        let selected = selectedTokenIndex == index
                        let tokenText = result.tokenPieces[index]
                            ?? result.segment(containing: index)?.text
                            ?? "无"
                        Button {
                            selectedTokenIndex = toggleTokenSelection(selectedTokenIndex, clicked: index)
                        } label: {
                            Text(result.tokenIDs[index].formatted())
                                .font(.system(size: 11.5, design: .monospaced))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .foregroundStyle(selectedTokenIndex == nil || selected ? .primary : .secondary)
                                .background(selected ? Color.accentColor.opacity(0.16) : .clear)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                                .overlay {
                                    if selected {
                                        RoundedRectangle(cornerRadius: 4)
                                            .stroke(Color.accentColor.opacity(0.65))
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            "Token \(index)，ID \(result.tokenIDs[index])，文本 \(visible(tokenText))"
                        )
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            stateView(title: "暂无 token ID。", systemImage: "number")
        }
    }

    private func stateView(
        title: String,
        systemImage: String? = nil,
        progress: Bool = false
    ) -> some View {
        VStack(spacing: 8) {
            if progress {
                ProgressView().controlSize(.small)
            } else if let systemImage {
                Image(systemName: systemImage)
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var workRequest: WorkRequest {
        switch inputMode {
        case .raw:
            return .raw(rawText)
        case .chat:
            guard let template = store.tokenizerChatTemplate else { return .waiting }
            return .chat(TemplateRenderRequest(
                template: template,
                messages: messages,
                includeTools: includeTools,
                tools: tools,
                variables: variables,
                addGenerationPrompt: addGenerationPrompt
            ))
        case .tokenIDs:
            return .tokenIDs(tokenIDsText)
        }
    }

    @MainActor
    private func updateAuthoritativeInput() async {
        switch workRequest {
        case .waiting:
            renderedText = ""
            renderError = nil
            isRendering = false
            store.clearTokenizationResult()
        case let .raw(text):
            renderedText = text
            renderError = nil
            isRendering = false
            store.tokenize(text)
        case let .tokenIDs(raw):
            renderedText = ""
            renderError = nil
            isRendering = false
            do {
                try await Task.sleep(for: .milliseconds(225))
                try Task.checkCancellation()
            } catch {
                return
            }
            store.decodeTokenIDs(raw)
        case let .chat(request):
            isRendering = true
            let outcome = await Task.detached(priority: .userInitiated) {
                TemplateRenderer.render(request)
            }.value
            guard !Task.isCancelled else { return }
            isRendering = false
            renderedText = outcome.output
            renderError = outcome.error
            if outcome.error == nil {
                store.tokenize(TokenizerEncodeRequest(
                    text: outcome.output,
                    chatAttribution: ChatAttributionSeed(messages: request.messages)
                ))
            } else {
                store.clearTokenizationResult()
            }
        }
    }

    private var chatIsAvailable: Bool {
        store.tokenizerChatTemplate != nil || store.tokenizerPhase == .loading
    }

    private var inputStatus: String {
        if isRendering { return "正在渲染" }
        if renderError != nil { return "模板错误" }
        if inputMode == .tokenIDs { return "由 Token ID 解码" }
        return "实时编码"
    }

    private var authoritativeInputDetail: String {
        if inputMode == .tokenIDs {
            return "由 Token ID 解码 · \(authoritativeText.utf8.count.formatted()) bytes"
        }
        let source = inputMode == .chat ? "chat_template 渲染结果" : "原始文本"
        return "\(source) · \(renderedText.utf8.count.formatted()) bytes"
    }

    private var resultStatus: String {
        if inputMode == .tokenIDs {
            return "\(file.path) · 由 Token ID 解码"
        }
        let mapping = store.tokenizationResult?.sourceMapping.title ?? "等待结果"
        return "\(file.path) · \(mapping)"
    }

    private var bytesPerToken: String {
        guard let count = store.tokenizationResult?.tokenCount, count > 0 else { return "—" }
        return String(format: "%.1f", Double(authoritativeText.utf8.count) / Double(count))
    }

    private var chatContentCount: String {
        store.tokenizationResult?.overhead?.contentCount.formatted() ?? "—"
    }

    private var chatTemplateCount: String {
        guard let count = store.tokenizationResult?.overhead?.templateCount else { return "—" }
        return count < 0 ? "无法按差量拆分" : count.formatted()
    }

    private var authoritativeText: String {
        if inputMode == .tokenIDs {
            return store.tokenizationResult?.decodedText ?? ""
        }
        return renderedText
    }

    private func visible(_ text: String) -> String {
        visibleTokenizerText(text, showWhitespace: showWhitespace)
    }

    private func segmentColor(_ index: Int) -> Color {
        let colors: [Color] = [.cyan, .yellow, .blue, .green, .orange, .mint, .purple, .pink, .indigo, .teal]
        return colors[index % colors.count].opacity(0.30)
    }

    private func copyTokenIDs() {
        guard let ids = store.tokenizationResult?.tokenIDs else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ids.map(String.init).joined(separator: ", "), forType: .string)
    }

    private func copyAuthoritativeInput() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(authoritativeText, forType: .string)
    }

    private func initializeVariablesIfNeeded() {
        guard !didInitializeVariables,
              let template = store.tokenizerChatTemplate else { return }
        let object = store.tokenizerConfigData.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        } ?? [:]
        variables = Self.initialVariables(template: template, tokenizerConfig: object)
        didInitializeVariables = true
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

private struct TokenizerPanel<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10).stroke(.separator.opacity(0.70))
            }
            .shadow(color: .black.opacity(0.025), radius: 2, y: 1)
    }
}

private struct TokenizerPanelHeader<Trailing: View>: View {
    let title: String
    let detail: String
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.caption.weight(.semibold))
            Text(detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 6)
            trailing
        }
        .padding(.horizontal, 12)
        .frame(height: 39)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct TokenizerWrapLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let width = proposal.width ?? .greatestFiniteMagnitude
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + rowHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(
                at: CGPoint(x: x, y: y),
                anchor: .topLeading,
                proposal: ProposedViewSize(size)
            )
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
