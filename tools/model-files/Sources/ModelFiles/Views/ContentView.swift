import SwiftUI

struct ContentView: View {
    @StateObject private var store = ModelFilesStore()

    var body: some View {
        NavigationSplitView {
            SidebarView(store: store)
                .navigationSplitViewColumnWidth(min: 255, ideal: 292, max: 360)
        } detail: {
            DetailView(store: store)
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                HStack(spacing: 6) {
                    Image(systemName: "doc.text.magnifyingglass")
                    Text("Model Files")
                }
                    .font(.headline)
                    .fixedSize()

                TextField("组织/模型或仓库 URL", text: $store.modelID)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 320)
                    .onSubmit { store.openModel() }
                    .help("可粘贴 Hugging Face 或 ModelScope 仓库 URL")

                Picker("来源", selection: $store.sourceSelection) {
                    ForEach(SourceSelection.allCases) { source in
                        Text(source.title).tag(source)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(width: 132)
                .help("选择模型来源")

                Button("打开") {
                    store.openModel()
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(store.isLoadingRepository)
            }

            ToolbarItem(placement: .primaryAction) {
                if let status = store.statusText {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text(status)
                    }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                        .lineLimit(1)
                } else if store.isLoadingRepository {
                    ProgressView()
                        .controlSize(.small)
                }
            }
        }
        .task {
            if store.snapshot == nil && !store.isLoadingRepository {
                store.openModel()
            }
        }
    }
}
