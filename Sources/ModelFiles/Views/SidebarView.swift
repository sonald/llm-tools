import SwiftUI

struct SidebarView: View {
    @ObservedObject var store: ModelFilesStore
    @State private var showWeights = false

    private let visibleCategories: [FileCategory] = [
        .configuration, .tokenizer, .templates, .weightMetadata, .documentation, .other
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("筛选文件", text: $store.filter)
                    .textFieldStyle(.plain)
                if !store.filter.isEmpty {
                    Button {
                        store.filter = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 9)
            .frame(height: 30)
            .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 7))
            .padding(12)

            if store.isLoadingRepository {
                Spacer()
                ProgressView("读取文件清单…")
                    .controlSize(.small)
                    .foregroundStyle(.secondary)
                Spacer()
            } else if store.snapshot == nil {
                Spacer()
                EmptyStateView(
                    title: "尚未打开模型",
                    systemImage: "shippingbox",
                    message: "输入模型 ID 后打开仓库。"
                )
                Spacer()
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
                                    SidebarFileRow(file: file, isSelected: store.selectedPath == file.path)
                                        .tag(file.path)
                                }
                            }
                        }
                    }

                    let weights = store.files(in: .weights)
                    if !weights.isEmpty {
                        let previewableCount = weights.count(where: \.supportsMetadataPreview)
                        Section {
                            DisclosureGroup(isExpanded: $showWeights) {
                                ForEach(weights) { file in
                                    if file.supportsMetadataPreview {
                                        SidebarFileRow(file: file, isSelected: store.selectedPath == file.path)
                                            .tag(file.path)
                                    } else {
                                        SidebarFileRow(file: file, isSelected: false)
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
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.42))
    }
}

private struct SidebarFileRow: View {
    let file: RemoteFile
    let isSelected: Bool

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
        .padding(.horizontal, 5)
        .padding(.vertical, 3)
        .background(isSelected ? Color.teal.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        .help(file.path)
    }

    private var icon: String {
        if file.supportsMetadataPreview { return "list.bullet.rectangle" }
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
        if file.name == "tokenizer_config.json" { return "含内嵌 Chat Template（如有）" }
        if file.supportsMetadataPreview { return "只读取结构 Header" }
        if file.isBlocked { return "不可预览" }
        return file.path == file.name ? nil : file.path
    }
}
