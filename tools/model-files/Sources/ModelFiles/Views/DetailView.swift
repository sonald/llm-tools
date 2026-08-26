import AppKit
import SwiftUI

enum ConsistencyBadgeState: Equatable {
    case checking
    case warnings(Int)
    case insufficient
    case consistent

    var title: String {
        switch self {
        case .checking: String(localized: "检查中")
        case let .warnings(count): String(localized: "\(count) 项警告")
        case .insufficient: String(localized: "材料不足")
        case .consistent: String(localized: "一致")
        }
    }
}

func consistencyBadgeState(report: RepositoryConsistencyReport?) -> ConsistencyBadgeState {
    guard let report else { return .checking }
    let warningCount = report.findings.count { $0.severity == .warning }
    if warningCount > 0 { return .warnings(warningCount) }

    let core: Set<ConsistencyMaterialKind> = [
        .config, .tokenizer, .tokenizerConfig, .chatTemplates,
    ]
    let checked = Set(report.coverage.compactMap { coverage in
        coverage.status == .checked ? coverage.material : nil
    })
    return core.isSubset(of: checked) ? .consistent : .insufficient
}

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
                    title: String(localized: "无法打开位置"),
                    systemImage: "exclamationmark.triangle",
                    message: message,
                    actionTitle: String(localized: "重试")
                ) {
                    store.openRepository()
                }
            } else {
                EmptyStateView(
                    title: String(localized: "选择一个文件"),
                    systemImage: "doc.text",
                    message: String(localized: "文件内容只会在选中后加载。")
                )
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    @ViewBuilder
    private func detailBody(file: RepositoryFile) -> some View {
        if file.isBlocked {
            EmptyStateView(
                title: String(localized: "权重文件已锁定"),
                systemImage: "lock.shield",
                message: String(localized: "为避免意外下载大文件，应用只展示文件名、大小和哈希。")
            )
        } else if store.loadingPath == file.path {
            VStack(spacing: 12) {
                ProgressView()
                Text(file.structuredInspectionFormat?.loadingDescription
                    ?? String(localized: "正在后台读取 \(file.name)…"))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                HStack(spacing: 5) {
                    if let size = file.size {
                        Text(size.formattedByteCount)
                        Text("·")
                    }
                    Text(store.snapshot?.location.title ?? String(localized: "来源"))
                    Text("· 可切换到其他文件取消")
                }
                .font(.caption)
                .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let inspection = store.selectedInspection {
            InspectionWorkspaceView(
                store: store,
                file: file,
                inspection: inspection,
                baseURL: store.snapshot.flatMap { RepositoryService().markdownBaseURL(for: file, in: $0) }
            )
        } else if let message = store.errorMessage {
            EmptyStateView(
                title: String(localized: "无法读取文件"),
                systemImage: "wifi.exclamationmark",
                message: message,
                actionTitle: String(localized: "重试")
            ) {
                store.loadSelectedFile()
            }
        } else {
            EmptyStateView(
                title: String(localized: "没有内容"),
                systemImage: "doc",
                message: String(localized: "来源未返回可显示的内容。")
            )
        }
    }
}

private struct DetailHeader: View {
    @ObservedObject var store: ModelFilesStore
    let file: RepositoryFile
    @State private var showsConsistencyReport = false

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(file.name)
                    .font(.system(size: 21, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(purpose)
                    if let size = file.size {
                        Text("·")
                        Text(size.formattedByteCount)
                    }
                    if let snapshot = store.snapshot {
                        Text("·")
                        switch snapshot.version {
                        case let .immutable(label):
                            let branch = if case .modelScope = snapshot.location { "master" } else { "main" }
                            Text("\(snapshot.location.title) · \(branch) · SHA \(file.shortHash ?? label)")
                        case .live:
                            Text("\(snapshot.location.title) · 实时目录")
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            .layoutPriority(1)

            Spacer(minLength: 8)

            if store.snapshot != nil {
                let badge = consistencyBadgeState(report: store.consistencyReport)
                Button {
                    showsConsistencyReport.toggle()
                } label: {
                    Label(badge.title, systemImage: badgeSystemImage(badge))
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(badgeColor(badge).opacity(0.14), in: Capsule())
                }
                .buttonStyle(.plain)
                .help("查看仓库一致性报告")
                .popover(isPresented: $showsConsistencyReport) {
                    ScrollView {
                        ConsistencyReportView(report: store.consistencyReport)
                            .padding(16)
                    }
                    .frame(width: 540, height: 560)
                }
            }

            if let formatTitle = store.selectedInspection?.formatTitle
                ?? file.structuredInspectionFormat?.title {
                Text(formatTitle)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.quaternary, in: Capsule())
            }

            Picker("查看方式", selection: $store.perspective) {
                ForEach(store.availablePerspectives) { perspective in
                    Text(perspective == .overview && file.structuredInspectionFormat == .pdf
                        ? String(localized: "预览")
                        : perspective == .overview && file.name.lowercased().hasSuffix(".md")
                            ? String(localized: "渲染")
                            : perspective.title)
                        .tag(perspective)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: store.availablePerspectives.count >= 4 ? 320 : 240)
            .disabled(file.isBlocked || store.selectedInspection == nil)

            Button {
                store.copySelectedPath()
            } label: {
                Label("复制路径", systemImage: "doc.on.doc")
                    .labelStyle(.iconOnly)
            }
            .help("复制文件路径")

            if let snapshot = store.snapshot,
               case .ssh = snapshot.location {
                EmptyView()
            } else {
                Button {
                    store.openSelectedExternally()
                } label: {
                    Label(
                        isLocal ? String(localized: "在 Finder 中显示") : String(localized: "在源站打开"),
                        systemImage: isLocal ? "folder" : "arrow.up.right.square"
                    )
                    .labelStyle(.iconOnly)
                }
                .help(
                    isLocal
                        ? String(localized: "在 Finder 中显示当前文件")
                        : String(localized: "在浏览器中打开当前版本")
                )
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 13)
        .background(.bar)
        .background(alignment: .topLeading) {
            HStack(spacing: 0) {
                ForEach(Array(store.availablePerspectives.prefix(4).enumerated()), id: \.offset) { index, perspective in
                    Button("") { store.perspective = perspective }
                        .keyboardShortcut(
                            KeyEquivalent(Character(String(index + 1))),
                            modifiers: .command
                        )
                        .frame(width: 0, height: 0)
                        .opacity(0)
                        .accessibilityHidden(true)
                }
            }
        }
    }

    private var purpose: String {
        switch file.category {
        case .configuration: String(localized: "模型配置")
        case .tokenizer: String(localized: "分词器资源")
        case .templates: String(localized: "对话模板")
        case .weightMetadata:
            file.structuredInspectionFormat == .imatrix
                ? "Importance Matrix"
                : String(localized: "权重分片索引")
        case .documentation: String(localized: "模型文档")
        case .other: String(localized: "模型文件")
        case .weights:
            switch file.structuredInspectionFormat {
            case .safetensors: String(localized: "SafeTensors 权重结构")
            case .gguf: String(localized: "GGUF 模型结构")
            case .imatrix: "Importance Matrix"
            default: String(localized: "模型权重（禁止加载）")
            }
        }
    }

    private var isLocal: Bool {
        guard let snapshot = store.snapshot else { return false }
        if case .local = snapshot.location { return true }
        return false
    }

    private func badgeSystemImage(_ badge: ConsistencyBadgeState) -> String {
        switch badge {
        case .checking: "clock"
        case .warnings: "exclamationmark.triangle.fill"
        case .insufficient: "questionmark.circle"
        case .consistent: "checkmark.circle.fill"
        }
    }

    private func badgeColor(_ badge: ConsistencyBadgeState) -> Color {
        switch badge {
        case .checking, .insufficient: .gray
        case .warnings: .orange
        case .consistent: .green
        }
    }
}

private struct InspectionWorkspaceView: View {
    @ObservedObject var store: ModelFilesStore
    let file: RepositoryFile
    let inspection: InspectionDocument
    let baseURL: URL?

    var body: some View {
        Group {
            switch inspection {
            case let .safetensors(overview, headerByteCount):
                WeightWorkspaceView(
                    title: String(localized: "SafeTensors 权重结构"),
                    subtitle: String(localized: "Header 描述 tensor 目录；权重数据区未读取。"),
                    facts: [
                        InspectionField(key: String(localized: "Tensor 数量"), type: "count", value: overview.tensors.count.formatted(), origin: .derived),
                        InspectionField(key: String(localized: "参数总数"), type: "count", value: overview.parameterCount.formatted(), origin: .derived),
                        InspectionField(key: String(localized: "权重数据大小"), type: "bytes", value: formattedByteCount(overview.byteCount), origin: .derived),
                        InspectionField(key: String(localized: "主要数据类型"), type: "dtype", value: dtypeSummary(overview.dtypeCounts), origin: .derived),
                        InspectionField(key: String(localized: "Header 大小"), type: "bytes", value: Int64(headerByteCount).formattedByteCount, origin: .runtime),
                    ],
                    metadata: overview.metadata.sorted(by: { $0.key < $1.key }).map {
                        InspectionField(key: $0.key, type: "string", value: $0.value, origin: .embedded)
                    },
                    tensors: overview.tensors,
                    perspective: $store.perspective
                )
            case let .gguf(overview, downloadedByteCount):
                WeightWorkspaceView(
                    title: overview.isIMatrix
                        ? "GGUF Imatrix"
                        : overview.modelName ?? String(localized: "GGUF 模型结构"),
                    subtitle: overview.isIMatrix
                        ? String(localized: "GGUF v\(overview.version) · importance matrix · 只解析 metadata 与 tensor 目录。")
                        : String(localized: "GGUF v\(overview.version) · \(overview.isLittleEndian ? "little-endian" : "big-endian") · 只解析 metadata 与 tensor 目录。"),
                    facts: ggufFacts(overview, downloadedByteCount: downloadedByteCount),
                    metadata: overview.metadata.map {
                        InspectionField(key: $0.key, type: $0.type, value: $0.value, origin: .embedded)
                    },
                    tensors: overview.tensors,
                    perspective: $store.perspective
                )
            case let .imatrix(overview):
                IMatrixWorkspaceView(overview: overview, perspective: store.perspective)
            case let .jinja(document):
                JinjaWorkspaceView(document: document, perspective: $store.perspective)
                    .id(file.path)
            case let .pdf(data):
                PDFReaderView(data: data)
            case let .generic(data):
                if file.isTokenizerPlaygroundEntryPoint, store.perspective == .playground {
                    TokenizerPlaygroundView(store: store, file: file)
                        .id(file.path)
                } else {
                    FileReaderView(
                        file: file,
                        data: data,
                        perspective: store.perspective,
                        baseURL: baseURL,
                        consistencyReport: store.consistencyReport
                    )
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let notice = safetyNotice {
                HStack(spacing: 7) {
                    Image(systemName: "lock.fill")
                    Text(notice)
                    Spacer()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)
                .frame(height: 34)
                .background(.bar)
            }
        }
    }

    private var safetyNotice: String? {
        inspection.safetyNotice ?? (file.category == .weightMetadata
            ? String(localized: "只读取权重分片索引；不会请求任何权重文件。")
            : nil)
    }

    private func ggufFacts(_ overview: GGUFOverview, downloadedByteCount: Int) -> [InspectionField] {
        var facts: [InspectionField] = [
            InspectionField(key: String(localized: "Tensor 数量"), type: "count", value: overview.tensors.count.formatted(), origin: .derived),
            InspectionField(key: String(localized: "参数总数"), type: "count", value: overview.parameterCount.formatted(), origin: .derived),
            InspectionField(key: String(localized: "Metadata 数量"), type: "count", value: overview.metadata.count.formatted(), origin: .derived),
            InspectionField(key: String(localized: "数据区对齐"), type: "bytes", value: Int64(overview.alignment).formattedByteCount, origin: .embedded),
            InspectionField(key: String(localized: "Tensor 数据起点"), type: "offset", value: overview.tensorDataOffset.formatted(), origin: .derived),
            InspectionField(key: String(localized: "已读取前缀"), type: "bytes", value: Int64(downloadedByteCount).formattedByteCount, origin: .runtime),
        ]

        if overview.isIMatrix {
            if let count = overview.imatrixEntryCount {
                facts.insert(InspectionField(key: String(localized: "Imatrix 条目"), type: "count", value: count.formatted(), origin: .derived), at: 0)
            }
            appendMetadataFact("imatrix.datasets", title: String(localized: "数据集"), from: overview, to: &facts)
            appendMetadataFact("imatrix.chunk_count", title: String(localized: "Chunk 数"), from: overview, to: &facts)
            appendMetadataFact("imatrix.chunk_size", title: String(localized: "Chunk 大小"), from: overview, to: &facts)
        } else {
            if let architecture = overview.architecture {
                facts.insert(InspectionField(key: String(localized: "架构"), type: "string", value: architecture, origin: .embedded), at: 0)
            }
            if let dataType = overview.dominantDataType {
                facts.insert(InspectionField(key: String(localized: "主要数据类型"), type: "dtype", value: dataType, origin: .derived), at: min(1, facts.count))
            }
            if let contextLength = overview.contextLength {
                facts.insert(InspectionField(key: String(localized: "上下文长度"), type: "count", value: contextLength.formatted(), origin: .embedded), at: min(2, facts.count))
            }
            appendMetadataFact("quantize.imatrix.file", title: String(localized: "量化 Imatrix"), from: overview, to: &facts)
            appendMetadataFact("quantize.imatrix.dataset", title: String(localized: "Imatrix 数据集"), from: overview, to: &facts)
            appendMetadataFact("quantize.imatrix.entries_count", title: String(localized: "Imatrix 条目"), from: overview, to: &facts)
            appendMetadataFact("quantize.imatrix.chunks_count", title: "Imatrix Chunks", from: overview, to: &facts)
        }
        return facts
    }

    private func appendMetadataFact(
        _ key: String,
        title: String,
        from overview: GGUFOverview,
        to facts: inout [InspectionField]
    ) {
        guard let entry = overview.entry(key) else { return }
        facts.append(InspectionField(key: title, type: entry.type, value: entry.value, origin: .embedded))
    }
}

private struct FileReaderView: View {
    let file: RepositoryFile
    let data: Data
    let perspective: InspectionPerspective
    let baseURL: URL?
    let consistencyReport: RepositoryConsistencyReport?

    var body: some View {
        if let language = codeReaderLanguage {
            CodeReaderView(source: text, language: language)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            if let textSurface = plainTextSurface {
                PlainTextReaderView(text: textSurface)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    Group {
                        switch perspective {
                        case .fields:
                            if isTokenizerJSON {
                                TokenizerJSONView(data: data, showsFields: true)
                            } else if isJSON, let object = jsonObject {
                                JSONFieldsView(object: object)
                            }
                        case .overview:
                            summary
                        default:
                            summary
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder
    private var summary: some View {
        let name = file.name.lowercased()
        if name == "config.json" || name == "configuration.json" {
            ConfigSummaryView(object: jsonDictionary, consistencyReport: consistencyReport)
        } else if name == "generation_config.json" {
            GenerationSummaryView(object: jsonDictionary)
        } else if name == "tokenizer_config.json" {
            TokenizerSummaryView(object: jsonDictionary)
        } else if name == "vocab.json" {
            VocabView(object: jsonDictionary)
        } else if name == "tokenizer.json" {
            TokenizerJSONView(data: data, showsFields: false)
        } else if file.category == .weightMetadata {
            WeightIndexSummaryView(object: jsonDictionary)
        } else if file.category == .documentation && name.hasSuffix(".md") {
            MarkdownReaderView(text: text, baseURL: baseURL)
        } else if let object = jsonObject {
            JSONFieldsView(object: object)
        } else {
            EmptyView()
        }
    }

    private var plainTextSurface: String? {
        switch perspective {
        case .raw:
            return text
        case .fields:
            guard !isTokenizerJSON, !(isJSON && jsonObject != nil) else { return nil }
            return text
        case .overview, .source:
            return isStructuredOverview ? nil : text
        default:
            return nil
        }
    }

    private var isStructuredOverview: Bool {
        let name = file.name.lowercased()
        let structuredNames = [
            "config.json",
            "configuration.json",
            "generation_config.json",
            "tokenizer_config.json",
            "vocab.json",
            "tokenizer.json",
        ]
        return structuredNames.contains(name)
            || file.category == .weightMetadata
            || (file.category == .documentation && name.hasSuffix(".md"))
            || jsonObject != nil
    }

    private var text: String { String(decoding: data, as: UTF8.self) }
    private var codeReaderLanguage: String? {
        guard data.count <= 128 * 1_024,
              let language = FileClassifier.syntaxLanguage(for: file.path)
        else { return nil }
        if language == "json" {
            return perspective == .raw ? language : nil
        }
        switch perspective {
        case .overview, .source:
            return language
        default:
            return nil
        }
    }
    private var isJSON: Bool { file.name.lowercased().hasSuffix(".json") }
    private var isTokenizerJSON: Bool { file.name.lowercased() == "tokenizer.json" }
    private var jsonObject: Any? { try? JSONSerialization.jsonObject(with: data) }
    private var jsonDictionary: [String: Any] { jsonObject as? [String: Any] ?? [:] }
}

private struct WeightWorkspaceView: View {
    let title: String
    let subtitle: String
    let facts: [InspectionField]
    let metadata: [InspectionField]
    let tensors: [TensorDescriptor]
    @Binding var perspective: InspectionPerspective

    @State private var query = ""
    @State private var selectedMetadataKey: String?
    @State private var selectedTensorName: String?
    @State private var showsTensorInspector = true
    @State private var tensorTreeID = UUID()
    @FocusState private var queryIsFocused: Bool

    var body: some View {
        Group {
            switch perspective {
            case .metadata:
                HSplitView {
                    metadataTable.frame(minWidth: 520)
                    metadataInspector
                        .frame(minWidth: 260, idealWidth: 310, maxWidth: 390)
                }
            case .tensors:
                HSplitView {
                    tensorView.frame(minWidth: 520)
                    if showsTensorInspector {
                        tensorInspector
                            .frame(minWidth: 260, idealWidth: 310, maxWidth: 390)
                    }
                }
            default:
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        ReaderTitle(title, subtitle: subtitle)
                        InspectionFactsView(fields: facts)
                        if !metadata.isEmpty {
                            Button(String(localized: "查看全部 \(metadata.count) 条 Metadata")) {
                                perspective = .metadata
                            }
                        }
                        Button(String(localized: "查看全部 \(tensors.count) 个 Tensors")) {
                            perspective = .tensors
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .background(alignment: .topLeading) {
            Button("") { queryIsFocused = true }
                .keyboardShortcut("f", modifiers: .command)
                .frame(width: 0, height: 0)
                .opacity(0)
                .accessibilityHidden(true)
        }
        .onChange(of: perspective) { query = "" }
    }

    private var filteredMetadata: [InspectionField] {
        guard !query.isEmpty else { return metadata }
        return metadata.filter {
            $0.key.localizedCaseInsensitiveContains(query)
                || $0.value.localizedCaseInsensitiveContains(query)
        }
    }

    private var filteredTensors: [TensorDescriptor] {
        TensorHierarchy.matches(tensors, query: query)
    }

    private var tensorRows: [TensorHierarchyRow] {
        TensorHierarchy.build(filteredTensors)
    }

    private var metadataTable: some View {
        VStack(spacing: 0) {
            tableSearch(
                title: "Metadata",
                count: filteredMetadata.count,
                prompt: String(localized: "搜索 key 或值")
            )
            Divider()
            Table(filteredMetadata, selection: $selectedMetadataKey) {
                TableColumn("字段", value: \.key)
                TableColumn("类型", value: \.type)
                TableColumn("值") { field in
                    Text(field.value)
                        .font(.system(.body, design: .monospaced))
                        .lineLimit(1)
                }
                TableColumn("来源") { field in
                    Text(field.origin.title).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var metadataInspector: some View {
        if let field = metadata.first(where: { $0.id == selectedMetadataKey }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("字段详情").font(.headline)
                    PropertyGroup(title: "", rows: [
                        ("Key", field.key),
                        (String(localized: "类型"), field.type),
                        (String(localized: "来源"), field.origin.title),
                    ])
                    Divider()
                    Text("完整值").font(.headline)
                    Text(field.value)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
            }
        } else {
            EmptyStateView(
                title: String(localized: "选择 Metadata"),
                systemImage: "list.bullet.rectangle",
                message: String(localized: "选择一行查看完整值、类型和来源。")
            )
        }
    }

    private var tensorView: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("Tensors").font(.headline)
                Text(String(localized: "\(filteredTensors.count) 项"))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    tensorTreeID = UUID()
                } label: {
                    Label(String(localized: "全部收起"), systemImage: "chevron.up")
                        .font(.caption)
                }
                .help(String(localized: "全部收起"))
                TextField(String(localized: "搜索名称或 dtype"), text: $query)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 280)
                    .focused($queryIsFocused)
                Button {
                    showsTensorInspector.toggle()
                } label: {
                    Label(
                        showsTensorInspector ? String(localized: "隐藏详情") : String(localized: "显示详情"),
                        systemImage: showsTensorInspector ? "rectangle.righthalf.inset.filled.arrow.right" : "rectangle.lefthalf.inset.filled.arrow.left"
                    )
                    .labelStyle(.iconOnly)
                }
                .accessibilityLabel(showsTensorInspector
                    ? String(localized: "隐藏详情")
                    : String(localized: "显示详情"))
                .help(showsTensorInspector
                    ? String(localized: "隐藏右侧 Tensor 详情")
                    : String(localized: "显示右侧 Tensor 详情"))
            }
            .padding(.horizontal, 14)
            .frame(height: 48)
            if selectedTensorName != nil {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(fullTensorPath(selectedTensorName ?? ""))
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(.quaternary.opacity(0.25))
            }
            tensorColumnHeader
            Divider()
            List(tensorRows, id: \.id, children: \.children, selection: $selectedTensorName) { row in
                tensorRow(row)
            }
            .id(tensorTreeID)
            .listStyle(.inset)
        }
    }

    private func fullTensorPath(_ name: String) -> String {
        name.split(separator: ".").joined(separator: " › ")
    }

    private var tensorColumnHeader: some View {
        HStack(spacing: 10) {
            Text(String(localized: "名称"))
                .frame(minWidth: 120, maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 12)
            Text(String(localized: "Shape"))
                .frame(width: columnValueWidth, alignment: .trailing)
            Text(String(localized: "类型"))
                .frame(width: columnDTypeWidth, alignment: .leading)
            Text(String(localized: "参数"))
                .frame(width: columnCountWidth, alignment: .trailing)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    private var columnValueWidth: CGFloat { 104 }
    private var columnDTypeWidth: CGFloat { 52 }
    private var columnCountWidth: CGFloat { 92 }

    @ViewBuilder
    private func tensorRow(_ row: TensorHierarchyRow) -> some View {
        switch row.kind {
        case let .group(label, descendantCount):
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                Text(label)
                Text(tensorCountLabel(descendantCount))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .tag(row.id)
        case let .leaf(tensor):
            HStack(spacing: 10) {
                Text(tensor.name.split(separator: ".").last.map(String.init) ?? tensor.name)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .frame(minWidth: 120, maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 12)
                Text(tensor.shapeText)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
                    .frame(width: columnValueWidth, alignment: .trailing)
                Text(tensor.dataType)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
                    .frame(width: columnDTypeWidth, alignment: .leading)
                Text(tensor.parameterCount.formatted())
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
                    .frame(width: columnCountWidth, alignment: .trailing)
            }
            .help(tensor.name)
            .tag(tensor.name)
        }
    }

    private func tensorCountLabel(_ count: Int) -> String {
        String(localized: "\(count) 个 Tensors")
    }

    @ViewBuilder
    private var tensorInspector: some View {
        if let tensor = tensors.first(where: { $0.id == selectedTensorName }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("Tensor 详情").font(.headline)
                        Spacer()
                        Button {
                            showsTensorInspector = false
                        } label: {
                            Label(String(localized: "隐藏"), systemImage: "rectangle.righthalf.inset.filled.arrow.right")
                                .labelStyle(.iconOnly)
                        }
                        .accessibilityLabel(String(localized: "隐藏"))
                        .help(String(localized: "隐藏右侧 Tensor 详情"))
                    }
                    Text(tensor.name)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                    PropertyGroup(title: "", rows: compactRows([
                        ("Shape", tensor.shapeText),
                        (String(localized: "类型"), tensor.dataType),
                        (String(localized: "参数"), tensor.parameterCount.formatted()),
                        (String(localized: "数据大小"), tensor.byteCount.map(formattedByteCount)),
                        (String(localized: "数据 offset"), tensor.offset.map { $0.formatted() }),
                    ]))
                    Text("这里只展示目录信息，不读取 tensor 数据。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
            }
        } else {
            EmptyStateView(
                title: String(localized: "选择 Tensor"),
                systemImage: "square.stack.3d.up",
                message: String(localized: "选择一行查看 shape、类型和 offset。")
            )
        }
    }

    private func tableSearch(title: String, count: Int, prompt: String) -> some View {
        HStack(spacing: 12) {
            Text(title).font(.headline)
            Text(String(localized: "\(count) 项"))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            Spacer()
            TextField(prompt, text: $query)
                .textFieldStyle(.roundedBorder)
                .frame(width: 280)
                .focused($queryIsFocused)
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
    }
}

private struct JinjaWorkspaceView: View {
    let document: JinjaDocument
    @Binding var perspective: InspectionPerspective
    @State private var source: String

    init(document: JinjaDocument, perspective: Binding<InspectionPerspective>) {
        self.document = document
        _perspective = perspective
        _source = State(initialValue: document.source)
    }

    var body: some View {
        switch perspective {
        case .source:
            HSplitView {
                VStack(spacing: 0) {
                    sourceHeader
                    Divider()
                    JinjaTextEditor(text: $source)
                }
                .frame(minWidth: 560)

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("源码详情").font(.headline)
                        PropertyGroup(title: "", rows: [
                            (String(localized: "格式"), "Jinja"),
                            (String(localized: "UTF-8 大小"), Int64(source.utf8.count).formattedByteCount),
                            (String(localized: "行数"), lineCount.formatted()),
                            (String(localized: "状态"), isModified ? String(localized: "临时修改") : String(localized: "来源原文")),
                        ])
                        Text("修改只保留在当前文件工作台，不会写回来源。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(16)
                }
                .frame(minWidth: 260, idealWidth: 310, maxWidth: 390)
            }
        case .playground:
            TemplatePlaygroundView(
                template: $source,
                originalTemplate: document.source,
                tokenizerConfig: [:]
            )
            .padding(14)
        default:
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ReaderTitle(
                        "Jinja Chat Template",
                        subtitle: String(localized: "在源码和试验台之间切换时，临时修改会保留。")
                    )
                    InspectionFactsView(fields: [
                        InspectionField(key: String(localized: "UTF-8 大小"), type: "bytes", value: Int64(source.utf8.count).formattedByteCount, origin: isModified ? .runtime : .repository),
                        InspectionField(key: String(localized: "行数"), type: "count", value: lineCount.formatted(), origin: .derived),
                        InspectionField(key: String(localized: "来源"), type: "source", value: String(localized: "模型文件"), origin: .repository),
                        InspectionField(key: String(localized: "当前状态"), type: "state", value: isModified ? String(localized: "临时修改") : String(localized: "未修改"), origin: .runtime),
                    ])
                    HStack {
                        Button("查看源码") { perspective = .source }
                        Button("打开试验台") { perspective = .playground }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 18)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var sourceHeader: some View {
        HStack {
            Text("Jinja 源码").font(.headline)
            if isModified {
                Text("临时修改")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
            }
            Spacer()
            Button("恢复来源原文") { source = document.source }
                .disabled(!isModified)
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
    }

    private var lineCount: Int {
        source.isEmpty ? 0 : source.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count
    }

    private var isModified: Bool { source != document.source }
}

private struct InspectionFactsView: View {
    let fields: [InspectionField]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("概览").font(.headline)
            VStack(spacing: 0) {
                ForEach(Array(fields.enumerated()), id: \.element.id) { index, field in
                    HStack(alignment: .firstTextBaseline, spacing: 18) {
                        Text(field.key)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 150, maxWidth: 260, alignment: .leading)
                        Text(field.value)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(field.origin.title)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 6)
                    if index < fields.count - 1 { Divider() }
                }
            }
        }
    }
}

func shouldBuildTokenizerVocabularyIndex(query: String, hasIndex: Bool) -> Bool {
    !hasIndex && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

private struct TokenizerVocabularyIndexTrigger: Hashable {
    let generation: Int
    let hasNonemptyQuery: Bool
}

private struct TokenizerJSONView: View {
    let data: Data
    let showsFields: Bool

    @State private var overview: TokenizerOverview?
    @State private var error: String?
    @State private var isInspecting = true
    @State private var dataGeneration = 0
    @State private var vocabularyQuery = ""
    @State private var vocabularyIndex: TokenizerVocabularyIndex?
    @State private var didAttemptVocabularyIndex = false
    @State private var isIndexingVocabulary = false
    @State private var vocabularyIndexError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
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
        .task(id: data) {
            dataGeneration += 1
            isInspecting = true
            vocabularyIndex = nil
            didAttemptVocabularyIndex = false
            isIndexingVocabulary = false
            vocabularyIndexError = nil
            let inspection = await Task.detached(priority: .userInitiated) {
                TokenizerInspector.inspect(data)
            }.value
            guard !Task.isCancelled else { return }
            overview = inspection.overview
            error = inspection.error
            isInspecting = false
        }
        .task(id: vocabularyIndexTrigger) {
            await buildVocabularyIndexIfNeeded()
        }
    }

    private func summary(_ overview: TokenizerOverview) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            ReaderTitle(
                overview.modelType ?? "Tokenizer",
                subtitle: String(localized: "大型 tokenizer.json 在后台解析；摘要不会展开完整词表和合并规则。")
            )
            PropertyGroup(title: String(localized: "结构"), rows: compactRows([
                (String(localized: "格式版本"), overview.version),
                (String(localized: "模型类型"), overview.modelType),
                (String(localized: "词表项"), overview.vocabCount.map { $0.formatted() }),
                (String(localized: "合并规则"), overview.mergeCount.map { $0.formatted() }),
                (String(localized: "新增 Token"), overview.addedTokenCount.map { $0.formatted() }),
            ]))
            if overview.addedTokens.contains(where: \.special) {
                specialAddedTokens(overview.addedTokens)
            }
            if let analysis = overview.vocabularyAnalysis {
                TokenizerVocabularyAnalysisView(
                    analysis: analysis,
                    addedTokenCount: overview.addedTokenCount
                )
            } else if let vocabCount = overview.vocabCount {
                Text(vocabCount == 0
                    ? "model.vocab 为空，没有可分析的 Token。"
                    : "当前 model.vocab 结构无法进行词表长度分析。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            vocabularySearch
            Text("需要逐项查看时，优先使用仓库中的 vocab.json 和 merges.txt；它们有分页阅读器。")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func specialAddedTokens(_ addedTokens: [TokenizerAddedTokenInfo]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Special added_tokens")
                .font(.subheadline.weight(.semibold))
            ForEach(Array(addedTokens.filter(\.special).enumerated()), id: \.offset) { _, token in
                HStack(spacing: 8) {
                    Text(token.content.isEmpty ? String(localized: "（空 Token）") : token.content)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    if let id = token.id {
                        Text(id.formatted())
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
    }

    private var vocabularySearch: some View {
        VStack(alignment: .leading, spacing: 10) {
            ReaderTitle(
                String(localized: "词表搜索"),
                subtitle: String(localized: "首次输入非空查询时按需构建索引；最多显示 1,000 条匹配。")
            )
            TextField("搜索 token 或 ID", text: $vocabularyQuery)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 380)
            if isIndexingVocabulary {
                ProgressView("正在准备词表索引…")
                    .controlSize(.small)
            } else if let vocabularyIndexError {
                Text(vocabularyIndexError)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else if vocabularyQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("输入 token 或十进制 ID 开始搜索。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else if let vocabularyIndex {
                let matches = vocabularyIndex.matches(query: vocabularyQuery)
                Text(String(localized: "匹配 \(matches.count) 条"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(matches, id: \.tokenID) { entry in
                    HStack(spacing: 10) {
                        Text(entry.token.isEmpty ? String(localized: "（空 Token）") : entry.token)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Text(entry.tokenID.formatted())
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .textSelection(.enabled)
                    Divider()
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
    }

    @MainActor
    private func buildVocabularyIndexIfNeeded() async {
        guard shouldBuildTokenizerVocabularyIndex(
            query: vocabularyQuery,
            hasIndex: didAttemptVocabularyIndex
        ) else { return }
        didAttemptVocabularyIndex = true
        isIndexingVocabulary = true
        vocabularyIndexError = nil
        let generation = dataGeneration
        let built = await Task.detached(priority: .userInitiated) {
            TokenizerInspector.vocabularyIndex(from: data)
        }.value
        guard generation == dataGeneration else { return }
        vocabularyIndex = built
        vocabularyIndexError = built == nil ? String(localized: "当前 vocab 结构无法搜索。") : nil
        isIndexingVocabulary = false
    }

    private var vocabularyIndexTrigger: TokenizerVocabularyIndexTrigger {
        TokenizerVocabularyIndexTrigger(
            generation: dataGeneration,
            hasNonemptyQuery: !vocabularyQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
    }

    private func fields(_ overview: TokenizerOverview) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ReaderTitle(
                String(localized: "根字段"),
                subtitle: String(localized: "只渲染根层级和集合规模，避免展开十几万条词表导致界面失去响应。")
            )
            ForEach(overview.fields) { field in
                KeyValueRow(key: field.name, value: field.detail)
                Divider()
            }
        }
    }
}

private struct TokenizerVocabularyAnalysisView: View {
    let analysis: TokenizerVocabularyAnalysis
    let addedTokenCount: Int?

    @State private var showsTop50 = false
    @State private var selectedBucketLabel: String?
    @State private var selectedTokenID: Int?

    private var selectedBucket: TokenizerLengthBucket {
        if let selectedBucketLabel,
           let bucket = analysis.buckets.first(where: { $0.label == selectedBucketLabel }) {
            return bucket
        }
        return analysis.buckets.max(by: { $0.count < $1.count })!
    }

    private var selectedToken: TokenizerVocabularyEntry? {
        if let selectedTokenID,
           let token = analysis.longestTokens.first(where: { $0.tokenID == selectedTokenID }) {
            return token
        }
        return analysis.longestTokens.first
    }

    private var visibleTokens: [TokenizerVocabularyEntry] {
        Array(analysis.longestTokens.prefix(showsTop50 ? 50 : 20))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("词表长度")
                        .font(.headline)
                    Text(String(localized: "基础词表 \(analysis.tokenCount) 项；按原始 Token Piece 的 Unicode 标量计数。"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                scopePill("Base vocab", emphasized: true)
                if let addedTokenCount {
                    scopePill("Added Token · \(addedTokenCount.formatted())", emphasized: false)
                }
            }

            metrics

            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    distribution
                        .frame(minWidth: 430, maxWidth: .infinity)
                    lengthDefinition
                        .frame(width: 280)
                }
                VStack(alignment: .leading, spacing: 12) {
                    distribution
                    lengthDefinition
                }
            }

            longestTokens
        }
    }

    private var metrics: some View {
        let values = [
            (String(localized: "平均"), analysis.averageScalarLength.formatted(.number.precision(.fractionLength(2)))),
            ("P50", analysis.p50ScalarLength.formatted()),
            ("P90", analysis.p90ScalarLength.formatted()),
            ("P95", analysis.p95ScalarLength.formatted()),
            ("P99", analysis.p99ScalarLength.formatted()),
            (String(localized: "最长"), analysis.maximumScalarLength.formatted()),
        ]
        return LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 108), spacing: 8)],
            alignment: .leading,
            spacing: 8
        ) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                VStack(alignment: .leading, spacing: 4) {
                    Text(value.0)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(value.1)
                        .font(.title3.weight(.semibold).monospacedDigit())
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private var distribution: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("长度分布")
                .font(.subheadline.weight(.semibold))
            HStack(alignment: .bottom, spacing: 6) {
                ForEach(analysis.buckets, id: \.label) { bucket in
                    Button {
                        selectedBucketLabel = bucket.label
                    } label: {
                        VStack(spacing: 4) {
                            Text(bucket.count.formatted())
                                .font(.caption2.monospaced())
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            RoundedRectangle(cornerRadius: 3)
                                .fill(bucket.label == selectedBucket.label ? Color.accentColor : Color.accentColor.opacity(0.48))
                                .frame(height: barHeight(for: bucket))
                            Text(bucket.label)
                                .font(.caption2.monospaced())
                            Text(percentageText(for: bucket))
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        String(localized: "长度 \(bucket.label)，\(bucket.count) 个 Token，占 \(percentageText(for: bucket))")
                    )
                    .accessibilityAddTraits(
                        bucket.label == selectedBucket.label ? .isSelected : []
                    )
                }
            }
            .frame(height: 158)
            Text(String(localized: "长度 \(selectedBucket.label)：\(selectedBucket.count) 项，占基础词表 \(percentageText(for: selectedBucket))。"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(.quaternary.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
    }

    private var lengthDefinition: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("统计口径")
                .font(.subheadline.weight(.semibold))
            Text("统计 tokenizer.json 中 model.vocab 的原始 Piece，不先解码 ByteLevel，也不做 Unicode 归一化。")
            Text("Added Token 单独计数，不进入本分布。最长 Token 用于理解词表构成，不代表 tokenizer 质量。")
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
    }

    private var longestTokens: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("最长 Token")
                    .font(.subheadline.weight(.semibold))
                Text("长度降序，ID 升序")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if analysis.longestTokens.count > 20 {
                    Button(
                        showsTop50
                            ? String(localized: "收起到 Top 20")
                            : String(localized: "展开 Top \(analysis.longestTokens.count)")
                    ) {
                        showsTop50.toggle()
                    }
                    .controlSize(.small)
                }
            }
            .padding(12)

            Divider()
            tokenHeader
            Divider()

            ForEach(Array(visibleTokens.enumerated()), id: \.element.tokenID) { index, entry in
                Button {
                    selectedTokenID = entry.tokenID
                } label: {
                    tokenRow(index: index, entry: entry)
                }
                .buttonStyle(.plain)
                .background(
                    entry.tokenID == selectedToken?.tokenID
                        ? Color.accentColor.opacity(0.12)
                        : Color.clear
                )
                .contextMenu {
                    Button("复制 Token Piece") {
                        copy(entry.token)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    "第 \(index + 1) 名，Token ID \(entry.tokenID)，\(visible(entry.token))，\(entry.scalarLength) 个 Unicode 标量"
                )
                .accessibilityAddTraits(
                    entry.tokenID == selectedToken?.tokenID ? .isSelected : []
                )
                Divider()
            }

            if let selectedToken {
                tokenDetail(selectedToken)
            }
        }
        .background(.quaternary.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var tokenHeader: some View {
        HStack(spacing: 8) {
            Text("#").frame(width: 34, alignment: .trailing)
            Text("ID").frame(width: 72, alignment: .leading)
            Text("Token Piece").frame(maxWidth: .infinity, alignment: .leading)
            Text("标量").frame(width: 54, alignment: .trailing)
            Text("UTF-8 bytes").frame(width: 70, alignment: .trailing)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .frame(height: 28)
    }

    private func tokenRow(index: Int, entry: TokenizerVocabularyEntry) -> some View {
        HStack(spacing: 8) {
            Text((index + 1).formatted()).frame(width: 34, alignment: .trailing)
            Text(entry.tokenID.formatted()).frame(width: 72, alignment: .leading)
            Text(visible(entry.token))
                .lineLimit(1)
                .truncationMode(.middle)
                .help(entry.token)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(entry.scalarLength.formatted()).frame(width: 54, alignment: .trailing)
            Text(entry.token.utf8.count.formatted()).frame(width: 70, alignment: .trailing)
        }
        .font(.system(.caption, design: .monospaced))
        .padding(.horizontal, 12)
        .frame(minHeight: 31)
        .contentShape(Rectangle())
    }

    private func tokenDetail(_ entry: TokenizerVocabularyEntry) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("Token #\(entry.tokenID)")
                    .font(.subheadline.weight(.semibold).monospaced())
                Spacer()
                Button("复制 Raw") {
                    copy(entry.token)
                }
                .controlSize(.small)
            }
            Text(entry.token.isEmpty ? String(localized: "（空字符串）") : entry.token)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(4)
                .truncationMode(.middle)
            Text("\(visible(entry.token)) · \(entry.scalarLength) 标量 · \(entry.token.utf8.count) UTF-8 bytes")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
    }

    private func scopePill(_ text: String, emphasized: Bool) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(emphasized ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                emphasized ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.10),
                in: Capsule()
            )
    }

    private func barHeight(for bucket: TokenizerLengthBucket) -> CGFloat {
        let maximum = analysis.buckets.map(\.count).max() ?? 1
        return max(3, CGFloat(bucket.count) / CGFloat(max(1, maximum)) * 92)
    }

    private func percentageText(for bucket: TokenizerLengthBucket) -> String {
        String(format: "%.2f%%", Double(bucket.count) / Double(analysis.tokenCount) * 100)
    }

    private func visible(_ token: String) -> String {
        guard !token.isEmpty else { return String(localized: "空 Token") }
        let scalars = Array(token.unicodeScalars)
        if scalars.count > 8, scalars.allSatisfy({ $0 == scalars[0] }) {
            return "\(visible(scalars[0])) × \(scalars.count)"
        }
        return scalars.map(visible).joined()
    }

    private func visible(_ scalar: Unicode.Scalar) -> String {
        switch scalar.value {
        case 0x09: "Tab"
        case 0x0A: String(localized: "换行")
        case 0x0D: String(localized: "回车")
        case 0x20: String(localized: "空格")
        default:
            CharacterSet.controlCharacters.contains(scalar)
                ? "\\u{\(String(scalar.value, radix: 16, uppercase: true))}"
                : String(scalar)
        }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

private struct ConsistencyReportView: View {
    let report: RepositoryConsistencyReport?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("一致性")
                    .font(.headline)
                Spacer()
                Text(consistencyBadgeState(report: report).title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            if let report {
                if consistencyBadgeState(report: report) == .insufficient {
                    Label("核心材料不足；以下 coverage 显示缺失、跳过或失败项。", systemImage: "questionmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !report.identityFields.isEmpty {
                    sectionTitle(String(localized: "身份"))
                    VStack(spacing: 6) {
                        ForEach(report.identityFields) { field in
                            fieldRow(field)
                        }
                    }
                }

                sectionTitle(String(localized: "发现"))
                if report.findings.isEmpty {
                    Text("未发现可报告的不一致。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 10) {
                        ForEach(report.findings) { finding in
                            findingView(finding)
                        }
                    }
                }

                sectionTitle("Coverage")
                VStack(spacing: 6) {
                    ForEach(report.coverage) { coverage in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: coverageIcon(coverage.status))
                                .foregroundStyle(coverageColor(coverage.status))
                                .frame(width: 16)
                            Text(materialTitle(coverage.material))
                            Spacer()
                            Text(coverageTitle(coverage.status))
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.trailing)
                        }
                        .font(.caption)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在检查仓库材料…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func fieldRow(_ field: InspectionField) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(field.key)
                .foregroundStyle(.secondary)
            Spacer()
            Text(field.value)
                .textSelection(.enabled)
            Text(field.origin.title)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .font(.caption)
    }

    private func findingView(_ finding: ConsistencyFinding) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(
                finding.title,
                systemImage: finding.severity == .warning
                    ? "exclamationmark.triangle.fill"
                    : "info.circle"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(finding.severity == .warning ? Color.orange : Color.blue)
            Text(finding.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                findingField(finding.left)
                Image(systemName: "arrow.right")
                    .foregroundStyle(.tertiary)
                findingField(finding.right)
            }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }

    private func findingField(_ field: InspectionField) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(field.key)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(field.value)
                .fontWeight(.medium)
                .textSelection(.enabled)
            Text(field.origin.title)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func materialTitle(_ material: ConsistencyMaterialKind) -> String {
        switch material {
        case .config: "config"
        case .generationConfig: "generation_config"
        case .tokenizerConfig: "tokenizer_config"
        case .tokenizer: "tokenizer"
        case .adapterConfig: "adapter_config"
        case .processorConfig: "processor_config"
        case .chatTemplates: "chat template"
        case .gguf: "GGUF"
        }
    }

    private func coverageTitle(_ status: ConsistencyCoverageStatus) -> String {
        switch status {
        case .checked: String(localized: "已检查")
        case .missing: String(localized: "缺失")
        case let .skipped(reason): String(localized: "跳过：\(reason)")
        case let .failed(message): String(localized: "失败：\(message)")
        }
    }

    private func coverageIcon(_ status: ConsistencyCoverageStatus) -> String {
        switch status {
        case .checked: "checkmark.circle.fill"
        case .missing: "minus.circle"
        case .skipped: "forward.circle"
        case .failed: "xmark.octagon.fill"
        }
    }

    private func coverageColor(_ status: ConsistencyCoverageStatus) -> Color {
        switch status {
        case .checked: .green
        case .missing, .skipped: .gray
        case .failed: .red
        }
    }
}

private struct ConfigSummaryView: View {
    let object: [String: Any]
    let consistencyReport: RepositoryConsistencyReport?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ConsistencyReportView(report: consistencyReport)

            VStack(alignment: .leading, spacing: 6) {
                Text(architecture)
                    .font(.system(size: 25, weight: .semibold, design: .rounded))
                Text([string("model_type"), string("torch_dtype"), layerCount].compactMap { $0 }.joined(separator: " · "))
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
            }

            PropertyGroup(title: String(localized: "模型规模"), rows: compactRows([
                (String(localized: "隐藏层维度（hidden_size）"), value("hidden_size")),
                (String(localized: "中间层维度（intermediate_size）"), value("intermediate_size")),
                (String(localized: "词表大小（vocab_size）"), value("vocab_size"))
            ]))

            PropertyGroup(title: "Attention", rows: compactRows([
                (String(localized: "注意力头数（num_attention_heads）"), value("num_attention_heads")),
                (String(localized: "KV 头数（num_key_value_heads）"), value("num_key_value_heads")),
                (String(localized: "头维度（head_dim）"), value("head_dim"))
            ]))

            PropertyGroup(title: String(localized: "上下文"), rows: compactRows([
                (String(localized: "最大上下文长度（max_position_embeddings）"), value("max_position_embeddings")),
                (String(localized: "RoPE θ（rope_theta）"), value("rope_theta"))
            ]))
        }
    }

    private var architecture: String {
        if let values = object["architectures"] as? [String], let first = values.first { return first }
        return string("model_type") ?? String(localized: "模型配置")
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
        VStack(alignment: .leading, spacing: 18) {
            ReaderTitle(
                String(localized: "生成默认值"),
                subtitle: String(localized: "推理框架在调用 generate 时使用的模型目录默认参数。")
            )
            PropertyGroup(title: String(localized: "采样"), rows: compactRows([
                ("Do sample", value("do_sample")),
                ("Temperature", value("temperature")),
                ("Top P", value("top_p")),
                ("Top K", value("top_k"))
            ]))
            PropertyGroup(title: String(localized: "终止与长度"), rows: compactRows([
                ("EOS token", value("eos_token_id")),
                ("PAD token", value("pad_token_id")),
                (String(localized: "最大新 token"), value("max_new_tokens")),
                (String(localized: "重复惩罚"), value("repetition_penalty"))
            ]))
        }
    }

    private func value(_ key: String) -> String? { object[key].map(JSONFormatter.inline) }
}

private struct TokenizerSummaryView: View {
    let object: [String: Any]
    @State private var showsPlayground = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ReaderTitle(
                object["tokenizer_class"] as? String ?? String(localized: "Tokenizer 配置"),
                subtitle: String(localized: "特殊 token、最大长度，以及随模型发布的对话格式。")
            )
            PropertyGroup(title: String(localized: "核心设置"), rows: compactRows([
                (String(localized: "最大长度"), object["model_max_length"].map(JSONFormatter.inline)),
                ("Padding side", object["padding_side"].map(JSONFormatter.inline)),
                ("BOS token", object["bos_token"].map(JSONFormatter.inline)),
                ("EOS token", object["eos_token"].map(JSONFormatter.inline)),
                ("UNK token", object["unk_token"].map(JSONFormatter.inline))
            ]))

            if let template = object["chat_template"] as? String, !template.isEmpty {
                DisclosureGroup(isExpanded: $showsPlayground) {
                    EmbeddedTemplatePlaygroundView(template: template, tokenizerConfig: object)
                        .frame(height: 640)
                        .padding(.top, 12)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Chat Template 试验台", systemImage: "curlybraces.square")
                            .font(.headline)
                        Text("展开后编辑输入并实时查看渲染结果")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 4)
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
        VStack(alignment: .leading, spacing: 18) {
            ReaderTitle(
                String(localized: "权重分片索引"),
                subtitle: String(localized: "只读取映射关系，不读取任何权重分片。")
            )
            PropertyGroup(title: String(localized: "概览"), rows: compactRows([
                (String(localized: "参数张量"), String(map.count)),
                (String(localized: "分片数量"), String(shards.count)),
                (String(localized: "权重总大小"), (metadata["total_size"] as? NSNumber).map { Int64(truncating: $0).formattedByteCount })
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
            ReaderTitle(
                String(localized: "词表"),
                subtitle: String(localized: "共 \(object.count) 个 token；列表最多展示当前筛选结果的前 1,000 项。")
            )
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

private struct JSONFieldsView: View {
    let object: Any

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ReaderTitle(
                String(localized: "全部字段"),
                subtitle: String(localized: "按字段名排序；复杂值以格式化 JSON 展示。")
            )
                .padding(.bottom, 4)
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
                        KeyValueRow(key: row.0, value: row.1)
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

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            Text(key)
                .foregroundStyle(.secondary)
                .frame(minWidth: 150, maxWidth: 260, alignment: .leading)
            Text(value)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
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

private func formattedByteCount(_ value: UInt64) -> String {
    Int64(min(value, UInt64(Int64.max))).formattedByteCount
}

private func dtypeSummary(_ counts: [String: Int]) -> String {
    counts.sorted(by: { $0.key < $1.key })
        .map { "\($0.key) × \($0.value.formatted())" }
        .joined(separator: " · ")
}
