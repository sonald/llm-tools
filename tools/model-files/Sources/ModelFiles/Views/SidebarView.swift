import SwiftUI

struct SidebarView: View {
    @ObservedObject var store: ModelFilesStore
    @State private var showWeights = false

    private let visibleCategories: [FileCategory] = [
        .configuration, .tokenizer, .templates, .weightMetadata, .documentation, .other
    ]

    var body: some View {
        VStack(spacing: 0) {
            if store.isLoadingRepository {
                Spacer()
                ProgressView("读取文件清单…")
                    .controlSize(.small)
                    .foregroundStyle(.secondary)
                Spacer()
            } else if store.snapshot == nil {
                Spacer()
                EmptyStateView(
                    title: String(localized: "尚未打开模型"),
                    systemImage: "shippingbox",
                    message: String(localized: "输入模型 ID、本地目录或 SSH 地址后打开。")
                )
                Spacer()
            } else if !store.filter.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !store.hasMatchingFiles {
                EmptyStateView(
                    title: String(localized: "没有匹配文件"),
                    systemImage: "doc.text.magnifyingglass",
                    message: String(localized: "换个关键词，或清除当前筛选。"),
                    actionTitle: String(localized: "清除筛选")
                ) {
                    store.filter = ""
                }
            } else {
                List(selection: Binding(
                    get: { store.selectedPath },
                    set: { store.select(path: $0) }
                )) {
                    ForEach(visibleCategories) { category in
                        let files = store.files(in: category)
                        if !files.isEmpty {
                            Section(category.title) {
                                ForEach(files) { file in
                                    SidebarFileRow(file: file)
                                        .tag(file.path)
                                }
                            }
                        }
                    }

                    let weights = store.files(in: .weights)
                    if !weights.isEmpty {
                        let previewableCount = weights.count { !$0.isBlocked }
                        Section {
                            DisclosureGroup(isExpanded: $showWeights) {
                                ForEach(weights) { file in
                                    if !file.isBlocked {
                                        SidebarFileRow(file: file)
                                            .tag(file.path)
                                    } else {
                                        SidebarFileRow(file: file)
                                            .opacity(0.62)
                                    }
                                }
                            } label: {
                                HStack {
                                    Label("权重文件", systemImage: "lock.fill")
                                    Spacer()
                                    Text("\(previewableCount)/\(weights.count) 可预览")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .listStyle(.sidebar)
                .tint(.teal)
            }
        }
        .searchable(text: $store.filter, placement: .sidebar, prompt: "筛选文件")
    }
}

private struct SidebarFileRow: View {
    let file: RepositoryFile

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(file.isBlocked ? Color.secondary : Color.teal)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .lineLimit(1)
                if let note {
                    Text(note)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if let size = file.size {
                Text(size.formattedByteCount)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
        .help(file.path)
    }

    private var icon: String {
        if file.category == .weights && !file.isBlocked { return "list.bullet.rectangle" }
        if file.isBlocked { return "lock.fill" }
        return switch file.category {
        case .configuration: "slider.horizontal.3"
        case .tokenizer: "textformat.abc"
        case .templates: "curlybraces.square"
        case .weightMetadata: "square.stack.3d.up"
        case .documentation: "doc.richtext"
        case .other: "doc"
        case .weights: "lock.fill"
        }
    }

    private var note: String? {
        if file.name == "tokenizer_config.json" { return String(localized: "含内嵌 Chat Template（如有）") }
        if file.structuredInspectionFormat == .safetensors { return String(localized: "只读取 JSON Header") }
        if file.structuredInspectionFormat == .gguf { return String(localized: "只读取 metadata 前缀") }
        if file.structuredInspectionFormat == .imatrix { return "legacy importance matrix" }
        if file.isBlocked { return String(localized: "不可预览") }
        return file.path == file.name ? nil : file.path
    }
}
