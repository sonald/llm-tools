import AppKit
import SwiftUI

struct DetailView: View {
    @ObservedObject var store: ModelFilesStore

    var body: some View {
        Group {
            if let file = store.selectedFile {
                VStack(spacing: 0) {
                    DetailHeader(store: store, file: file)
                    Divider()
                    detailBody(file: file)
                }
            } else if let message = store.errorMessage {
                EmptyStateView(
                    title: "无法打开模型",
                    systemImage: "exclamationmark.triangle",
                    message: message
                )
            } else {
                EmptyStateView(
                    title: "选择一个文件",
                    systemImage: "doc.text",
                    message: "文件内容只会在选中后加载。"
                )
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    @ViewBuilder
    private func detailBody(file: RemoteFile) -> some View {
        if file.isBlocked {
            EmptyStateView(
                title: "权重文件已锁定",
                systemImage: "lock.shield",
                message: "为避免意外下载大文件，应用只展示文件名、大小和哈希。"
            )
        } else if store.loadingPath == file.path {
            VStack(spacing: 12) {
                ProgressView()
                Text(file.supportsMetadataPreview
                    ? "正在读取 \(file.name) 的结构 Header…"
                    : "正在后台下载 \(file.name)…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                HStack(spacing: 5) {
                    if let size = file.size {
                        Text(size.formattedByteCount)
                        Text("·")
                    }
                    Text(store.snapshot?.source.title ?? "源站")
                    Text("· 可切换到其他文件取消")
                }
                .font(.caption)
                .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let data = store.selectedData {
            FileReaderView(file: file, data: data, mode: store.detailMode)
        } else if let message = store.errorMessage {
            EmptyStateView(
                title: "无法读取文件",
                systemImage: "wifi.exclamationmark",
                message: message
            )
        } else {
            EmptyStateView(title: "没有内容", systemImage: "doc", message: "源站未返回可显示的内容。")
        }
    }
}

private struct DetailHeader: View {
    @ObservedObject var store: ModelFilesStore
    let file: RemoteFile

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(file.name)
                        .font(.system(size: 24, weight: .semibold, design: .rounded))
                    HStack(spacing: 6) {
                        Text(purpose)
                        if let size = file.size {
                            Text("·")
                            Text(size.formattedByteCount)
                        }
                        if let snapshot = store.snapshot {
                            Text("·")
                            let branch = snapshot.source == .modelScope ? "master" : "main"
                            let hash = file.shortHash ?? String(file.revision.prefix(7))
                            Text("\(snapshot.source.title) · \(branch) · SHA \(hash)")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    store.copySelectedPath()
                } label: {
                    Label("复制路径", systemImage: "doc.on.doc")
                }
                .help("复制文件路径")

                Button {
                    store.openSelectedOnSource()
                } label: {
                    Label("在源站打开", systemImage: "arrow.up.right.square")
                }
                .help("在浏览器中打开当前版本")
            }

            Picker("查看方式", selection: $store.detailMode) {
                ForEach(DetailMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 310)
            .disabled(file.isBlocked)
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 20)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var purpose: String {
        switch file.category {
        case .configuration: "模型配置"
        case .tokenizer: "分词器资源"
        case .templates: "对话模板"
        case .weightMetadata: "权重分片索引"
        case .documentation: "模型文档"
        case .other: "仓库文件"
        case .weights:
            file.supportsMetadataPreview ? "SafeTensors 权重结构（仅 Header）" : "模型权重（禁止加载）"
        }
    }
}

private struct FileReaderView: View {
    let file: RemoteFile
    let data: Data
    let mode: DetailMode

    var body: some View {
        ScrollView {
            Group {
                switch mode {
                case .raw:
                    if isSafetensors {
                        VStack(alignment: .leading, spacing: 16) {
                            ReaderTitle(
                                "SafeTensors Header 原文",
                                subtitle: "最多展示前 256 KB；完整 tensor 结构请使用“全部字段”。"
                            )
                            RawTextView(data: Data(data.prefix(256 * 1_024)))
                        }
                    } else if data.count > 128 * 1_024 {
                        LinesView(
                            documentID: file.path,
                            data: data,
                            title: "原文",
                            subtitle: "大文件按行分批渲染，避免一次性文本排版阻塞界面。"
                        )
                    } else {
                        RawTextView(data: data)
                    }
                case .fields:
                    if isSafetensors {
                        SafetensorsView(data: data, showsTensors: true)
                    } else if isTokenizerJSON {
                        TokenizerJSONView(data: data, showsFields: true)
                    } else if isJSON, let object = jsonObject {
                        JSONFieldsView(object: object)
                    } else {
                        LinesView(
                            documentID: file.path,
                            data: data,
                            title: "全部行",
                            subtitle: "纯文本没有字段结构，按行分批展示。"
                        )
                    }
                case .summary:
                    summary
                }
            }
            .padding(26)
            .frame(maxWidth: 940, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 7) {
                Image(systemName: "lock.fill")
                Text("权重数据区始终不会下载；SafeTensors 只通过 HTTP Range 读取结构 Header。")
                Spacer()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 22)
            .frame(height: 38)
            .background(.bar)
        }
    }

    @ViewBuilder
    private var summary: some View {
        let name = file.name.lowercased()
        if isSafetensors {
            SafetensorsView(data: data, showsTensors: false)
        } else if name == "config.json" || name == "configuration.json" {
            ConfigSummaryView(object: jsonDictionary)
        } else if name == "generation_config.json" {
            GenerationSummaryView(object: jsonDictionary)
        } else if name == "tokenizer_config.json" {
            TokenizerSummaryView(object: jsonDictionary)
        } else if file.category == .templates {
            TemplatePlaygroundView(template: text, tokenizerConfig: [:])
        } else if name == "vocab.json" {
            VocabView(object: jsonDictionary)
        } else if name == "tokenizer.json" {
            TokenizerJSONView(data: data, showsFields: false)
        } else if name == "merges.txt" {
            LinesView(
                documentID: file.path,
                data: data,
                title: "BPE 合并规则",
                subtitle: "按应用顺序排列；搜索只在已加载内容中进行。"
            )
        } else if file.category == .weightMetadata {
            WeightIndexSummaryView(object: jsonDictionary)
        } else if file.category == .documentation && name.hasSuffix(".md") {
            MarkdownReaderView(text: text)
        } else if let object = jsonObject {
            JSONFieldsView(object: object)
        } else {
            RawTextView(data: data)
        }
    }

    private var text: String { String(decoding: data, as: UTF8.self) }
    private var isJSON: Bool { file.name.lowercased().hasSuffix(".json") }
    private var isTokenizerJSON: Bool { file.name.lowercased() == "tokenizer.json" }
    private var isSafetensors: Bool { file.name.lowercased().hasSuffix(".safetensors") }
    private var jsonObject: Any? { try? JSONSerialization.jsonObject(with: data) }
    private var jsonDictionary: [String: Any] { jsonObject as? [String: Any] ?? [:] }
}

private struct SafetensorsView: View {
    let data: Data
    let showsTensors: Bool

    @State private var overview: SafetensorsOverview?
    @State private var error: String?
    @State private var isInspecting = true
    @State private var query = ""
    @State private var visibleLimit = 300

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if isInspecting {
                ProgressView("正在后台解析 SafeTensors header…")
                    .controlSize(.small)
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            } else if let overview {
                content(overview)
            }
        }
        .task(id: data.count) {
            isInspecting = true
            let inspection = await Task.detached(priority: .userInitiated) {
                SafetensorsInspector.inspect(data)
            }.value
            guard !Task.isCancelled else { return }
            overview = inspection.overview
            error = inspection.error
            isInspecting = false
        }
        .onChange(of: query) { _ in
            visibleLimit = 300
        }
    }

    private func content(_ overview: SafetensorsOverview) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            ReaderTitle(
                "SafeTensors 权重结构",
                subtitle: "只读取了 \(Int64(data.count).formattedByteCount) JSON header；没有请求任何 tensor 数据。"
            )

            PropertyGroup(title: "概览", rows: [
                ("张量数量", overview.tensors.count.formatted()),
                ("参数总数", overview.parameterCount.formatted()),
                ("权重数据大小", byteCount(overview.byteCount)),
                ("数据类型", dtypeSummary(overview.dtypeCounts)),
            ])

            if !overview.metadata.isEmpty {
                PropertyGroup(
                    title: "Metadata",
                    rows: overview.metadata.sorted(by: { $0.key < $1.key })
                )
            }

            if showsTensors {
                tensorList(overview.tensors)
            } else {
                Text("切换到“全部字段”可搜索 tensor 名称，并按需分批加载结构列表。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func tensorList(_ tensors: [SafetensorInfo]) -> some View {
        let filtered = tensors.filter {
            query.isEmpty
                || $0.name.localizedCaseInsensitiveContains(query)
                || $0.dtype.localizedCaseInsensitiveContains(query)
        }
        let visible = Array(filtered.prefix(visibleLimit))

        return VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Tensor 结构").font(.headline)
                Spacer()
                Text("\(filtered.count.formatted()) 项")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            TextField("搜索 tensor 名称或 dtype", text: $query)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 430)

            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(visible) { tensor in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(tensor.name)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                        HStack(spacing: 8) {
                            Text(tensor.dtype)
                            Text(shape(tensor.shape))
                            Spacer()
                            Text("\(tensor.parameterCount.formatted()) params")
                            Text(byteCount(tensor.byteCount))
                        }
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 9)
                    Divider()
                }
            }

            if visible.count < filtered.count {
                Button("再显示 \(min(300, filtered.count - visible.count).formatted()) 项") {
                    visibleLimit += 300
                }
            }
        }
    }

    private func shape(_ dimensions: [Int64]) -> String {
        "[" + dimensions.map(String.init).joined(separator: ", ") + "]"
    }

    private func dtypeSummary(_ counts: [String: Int]) -> String {
        counts.sorted(by: { $0.key < $1.key })
            .map { "\($0.key) × \($0.value.formatted())" }
            .joined(separator: " · ")
    }

    private func byteCount(_ value: UInt64) -> String {
        Int64(min(value, UInt64(Int64.max))).formattedByteCount
    }
}

private struct TokenizerJSONView: View {
    let data: Data
    let showsFields: Bool

    @State private var overview: TokenizerOverview?
    @State private var error: String?
    @State private var isInspecting = true

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if isInspecting {
                ProgressView("正在后台解析 tokenizer.json…")
                    .controlSize(.small)
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            } else if let overview {
                if showsFields {
                    fields(overview)
                } else {
                    summary(overview)
                }
            }
        }
        .task(id: data.count) {
            isInspecting = true
            let inspection = await Task.detached(priority: .userInitiated) {
                TokenizerInspector.inspect(data)
            }.value
            guard !Task.isCancelled else { return }
            overview = inspection.overview
            error = inspection.error
            isInspecting = false
        }
    }

    private func summary(_ overview: TokenizerOverview) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            ReaderTitle(
                overview.modelType ?? "Tokenizer",
                subtitle: "大型 tokenizer.json 在后台解析；摘要不会展开完整词表和合并规则。"
            )
            PropertyGroup(title: "结构", rows: compactRows([
                ("格式版本", overview.version),
                ("模型类型", overview.modelType),
                ("词表项", overview.vocabCount.map { $0.formatted() }),
                ("合并规则", overview.mergeCount.map { $0.formatted() }),
                ("新增 Token", overview.addedTokenCount.map { $0.formatted() }),
            ]))
            Text("需要逐项查看时，优先使用仓库中的 vocab.json 和 merges.txt；它们有分页阅读器。")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func fields(_ overview: TokenizerOverview) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ReaderTitle(
                "根字段",
                subtitle: "只渲染根层级和集合规模，避免展开十几万条词表导致界面失去响应。"
            )
            ForEach(overview.fields) { field in
                KeyValueRow(key: field.name, value: field.detail)
                Divider()
            }
        }
    }
}

private struct ConfigSummaryView: View {
    let object: [String: Any]

    var body: some View {
        VStack(alignment: .leading, spacing: 26) {
            VStack(alignment: .leading, spacing: 6) {
                Text(architecture)
                    .font(.system(size: 25, weight: .semibold, design: .rounded))
                Text([string("model_type"), string("torch_dtype"), layerCount].compactMap { $0 }.joined(separator: " · "))
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
            }

            PropertyGroup(title: "模型规模", rows: compactRows([
                ("隐藏层维度（hidden_size）", value("hidden_size")),
                ("中间层维度（intermediate_size）", value("intermediate_size")),
                ("词表大小（vocab_size）", value("vocab_size"))
            ]))

            PropertyGroup(title: "Attention", rows: compactRows([
                ("注意力头数（num_attention_heads）", value("num_attention_heads")),
                ("KV 头数（num_key_value_heads）", value("num_key_value_heads")),
                ("头维度（head_dim）", value("head_dim"))
            ]))

            PropertyGroup(title: "上下文", rows: compactRows([
                ("最大上下文长度（max_position_embeddings）", value("max_position_embeddings")),
                ("RoPE θ（rope_theta）", value("rope_theta"))
            ]))
        }
    }

    private var architecture: String {
        if let values = object["architectures"] as? [String], let first = values.first { return first }
        return string("model_type") ?? "模型配置"
    }

    private var layerCount: String? {
        guard let value = value("num_hidden_layers") else { return nil }
        return "\(value) layers"
    }

    private func string(_ key: String) -> String? { object[key] as? String }
    private func value(_ key: String) -> String? { object[key].map(JSONFormatter.inline) }
}

private struct GenerationSummaryView: View {
    let object: [String: Any]

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            ReaderTitle("生成默认值", subtitle: "推理框架在调用 generate 时使用的仓库默认参数。")
            PropertyGroup(title: "采样", rows: compactRows([
                ("Do sample", value("do_sample")),
                ("Temperature", value("temperature")),
                ("Top P", value("top_p")),
                ("Top K", value("top_k"))
            ]))
            PropertyGroup(title: "终止与长度", rows: compactRows([
                ("EOS token", value("eos_token_id")),
                ("PAD token", value("pad_token_id")),
                ("最大新 token", value("max_new_tokens")),
                ("重复惩罚", value("repetition_penalty"))
            ]))
        }
    }

    private func value(_ key: String) -> String? { object[key].map(JSONFormatter.inline) }
}

private struct TokenizerSummaryView: View {
    let object: [String: Any]

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            ReaderTitle(
                object["tokenizer_class"] as? String ?? "Tokenizer 配置",
                subtitle: "特殊 token、最大长度，以及随模型发布的对话格式。"
            )
            PropertyGroup(title: "核心设置", rows: compactRows([
                ("最大长度", object["model_max_length"].map(JSONFormatter.inline)),
                ("Padding side", object["padding_side"].map(JSONFormatter.inline)),
                ("BOS token", object["bos_token"].map(JSONFormatter.inline)),
                ("EOS token", object["eos_token"].map(JSONFormatter.inline)),
                ("UNK token", object["unk_token"].map(JSONFormatter.inline))
            ]))

            if let template = object["chat_template"] as? String, !template.isEmpty {
                TemplatePlaygroundView(template: template, tokenizerConfig: object)
            }
        }
    }
}

private struct WeightIndexSummaryView: View {
    let object: [String: Any]

    var body: some View {
        let map = object["weight_map"] as? [String: String] ?? [:]
        let shards = Set(map.values)
        let metadata = object["metadata"] as? [String: Any] ?? [:]
        VStack(alignment: .leading, spacing: 24) {
            ReaderTitle("权重分片索引", subtitle: "只读取映射关系，不读取任何权重分片。")
            PropertyGroup(title: "概览", rows: compactRows([
                ("参数张量", String(map.count)),
                ("分片数量", String(shards.count)),
                ("权重总大小", (metadata["total_size"] as? NSNumber).map { Int64(truncating: $0).formattedByteCount })
            ]))
            VStack(alignment: .leading, spacing: 8) {
                Text("前 80 条映射").font(.headline)
                ForEach(map.sorted(by: { $0.key < $1.key }).prefix(80), id: \.key) { key, value in
                    KeyValueRow(key: key, value: value)
                }
            }
        }
    }
}

private struct VocabView: View {
    let object: [String: Any]
    @State private var query = ""

    var body: some View {
        let entries = object.compactMap { key, value -> (String, Int)? in
            if let int = value as? Int { return (key, int) }
            if let number = value as? NSNumber { return (key, number.intValue) }
            return nil
        }
        .filter { query.isEmpty || $0.0.localizedCaseInsensitiveContains(query) || String($0.1).contains(query) }
        .sorted { $0.1 < $1.1 }

        VStack(alignment: .leading, spacing: 18) {
            ReaderTitle("词表", subtitle: "共 \(object.count.formatted()) 个 token；列表最多展示当前筛选结果的前 1,000 项。")
            TextField("搜索 token 或 ID", text: $query)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 380)
            HStack {
                Text("Token").fontWeight(.semibold)
                Spacer()
                Text("ID").fontWeight(.semibold).frame(width: 90, alignment: .trailing)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Divider()
            ForEach(Array(entries.prefix(1_000).enumerated()), id: \.offset) { _, entry in
                HStack {
                    Text(entry.0).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    Spacer()
                    Text(String(entry.1)).font(.body.monospacedDigit()).foregroundStyle(.secondary)
                        .frame(width: 90, alignment: .trailing)
                }
                Divider()
            }
        }
    }
}

private struct LinesView: View {
    let documentID: String
    let data: Data
    let title: String
    let subtitle: String
    @State private var query = ""
    @State private var lines: [TextLine] = []
    @State private var visibleLimit = 1_000
    @State private var isParsing = true

    var body: some View {
        let visibleLines = TextLine.visible(in: lines, matching: query, limit: visibleLimit)
        VStack(alignment: .leading, spacing: 18) {
            ReaderTitle(title, subtitle: "\(subtitle) 共 \(lines.count.formatted()) 行。")
            TextField("搜索", text: $query)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 380)

            if isParsing {
                ProgressView("正在准备逐行视图…")
                    .controlSize(.small)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(visibleLines) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 16) {
                            Text(String(line.id + 1))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.tertiary)
                                .frame(width: 58, alignment: .trailing)
                            Text(line.text)
                                .font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, 2)
                    }
                }

                if visibleLines.count == visibleLimit {
                    Button("再显示 1,000 行") {
                        visibleLimit += 1_000
                    }
                }
            }
        }
        .task(id: documentID) {
            isParsing = true
            lines = []
            visibleLimit = 1_000
            let parsed = await Task.detached(priority: .userInitiated) {
                TextLine.parse(data)
            }.value
            guard !Task.isCancelled else { return }
            lines = parsed
            isParsing = false
        }
        .onChange(of: query) { _ in
            visibleLimit = 1_000
        }
    }
}

struct TextLine: Identifiable, Sendable, Equatable {
    let id: Int
    let text: String

    static func parse(_ data: Data) -> [TextLine] {
        String(decoding: data, as: UTF8.self)
            .split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
            .enumerated()
            .map { TextLine(id: $0.offset, text: String($0.element)) }
    }

    static func visible(in lines: [TextLine], matching query: String, limit: Int) -> [TextLine] {
        guard !query.isEmpty else { return Array(lines.prefix(limit)) }
        var result: [TextLine] = []
        result.reserveCapacity(limit)
        for line in lines where line.text.localizedCaseInsensitiveContains(query) {
            result.append(line)
            if result.count == limit { break }
        }
        return result
    }
}

private struct MarkdownReaderView: View {
    let text: String

    var body: some View {
        if let attributed = try? AttributedString(markdown: text) {
            Text(attributed)
                .font(.body)
                .lineSpacing(5)
                .textSelection(.enabled)
                .frame(maxWidth: 760, alignment: .leading)
        } else {
            Text(text).textSelection(.enabled)
        }
    }
}

private struct JSONFieldsView: View {
    let object: Any

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ReaderTitle("全部字段", subtitle: "按字段名排序；复杂值以格式化 JSON 展示。")
                .padding(.bottom, 10)
            if let dictionary = object as? [String: Any] {
                ForEach(dictionary.keys.sorted(), id: \.self) { key in
                    if let value = dictionary[key] {
                        KeyValueRow(key: key, value: JSONFormatter.pretty(value))
                    }
                }
            } else {
                Text(JSONFormatter.pretty(object))
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            }
        }
    }
}

private struct RawTextView: View {
    let data: Data

    var body: some View {
        Text(String(decoding: data, as: UTF8.self))
            .font(.system(size: 12.5, design: .monospaced))
            .lineSpacing(2)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ReaderTitle: View {
    let title: String
    let subtitle: String

    init(_ title: String, subtitle: String) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.title2.weight(.semibold))
            Text(subtitle).font(.callout).foregroundStyle(.secondary)
        }
    }
}

private struct PropertyGroup: View {
    let title: String
    let rows: [(String, String)]

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        KeyValueRow(key: row.0, value: row.1, trailingValue: true)
                        if index < rows.count - 1 { Divider() }
                    }
                }
            }
        }
    }
}

private struct KeyValueRow: View {
    let key: String
    let value: String
    var trailingValue = false

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            Text(key)
                .foregroundStyle(.secondary)
                .frame(minWidth: 150, maxWidth: 260, alignment: .leading)
            Text(value)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: trailingValue ? .trailing : .leading)
        }
        .padding(.vertical, 10)
    }
}

private enum JSONFormatter {
    static func inline(_ value: Any) -> String {
        if value is NSNull { return "null" }
        if let bool = value as? Bool { return bool ? "true" : "false" }
        if let string = value as? String { return string }
        if let number = value as? NSNumber { return number.stringValue }
        return pretty(value).replacingOccurrences(of: "\n", with: " ")
    }

    static func pretty(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: data, encoding: .utf8) else {
            return String(describing: value)
        }
        return string
    }
}

private func compactRows(_ rows: [(String, String?)]) -> [(String, String)] {
    rows.compactMap { key, value in value.map { (key, $0) } }
}
