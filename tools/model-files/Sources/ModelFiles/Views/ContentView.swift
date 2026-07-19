import SwiftUI

struct ContentView: View {
    @StateObject private var store = ModelFilesStore()

    var body: some View {
        VStack(spacing: 0) {
            AppToolbarView(store: store)
            Divider()
            NavigationSplitView {
                SidebarView(store: store)
                    .navigationSplitViewColumnWidth(min: 255, ideal: 292, max: 360)
            } detail: {
                DetailView(store: store)
            }
            .navigationSplitViewStyle(.balanced)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            if store.snapshot == nil && !store.isLoadingRepository {
                store.openModel()
            }
        }
    }
}

private struct AppToolbarView: View {
    @ObservedObject var store: ModelFilesStore

    var body: some View {
        HStack(spacing: 14) {
            Label("Model Files", systemImage: "doc.text.magnifyingglass")
                .font(.headline)
                .foregroundStyle(.primary)
                .fixedSize()

            TextField("组织/模型或仓库 URL", text: $store.modelID)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 245, idealWidth: 330, maxWidth: 390)
                .onSubmit { store.openModel() }
                .help("可粘贴 Hugging Face 或 ModelScope 仓库 URL")

            Picker("来源", selection: $store.sourceSelection) {
                ForEach(SourceSelection.allCases) { source in
                    Text(source.title).tag(source)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 350)

            Button {
                store.openModel()
            } label: {
                if store.isLoadingRepository {
                    ProgressView().controlSize(.small).frame(width: 28)
                } else {
                    Text("打开").frame(width: 28)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(.teal)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(store.isLoadingRepository)

            Spacer(minLength: 12)

            if let status = store.statusText {
                Label(status, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.green, .secondary)
                    .lineLimit(1)
            } else if store.isLoadingRepository {
                Text("正在选择可用源…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.leading, 118)
        .padding(.trailing, 18)
        .frame(height: 68)
        .background(.bar)
    }
}
