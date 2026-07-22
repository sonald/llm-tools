import AppKit
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

                ModelHistoryField(
                    text: $store.repositoryInput,
                    history: store.repositoryHistory,
                    placeholder: inputPlaceholder,
                    onSubmit: store.openRepository
                )
                    .frame(width: 460)
                    .help("输入模型 ID、仓库 URL、本地绝对路径或 ssh:// 地址")

                Button {
                    store.chooseLocalDirectory()
                } label: {
                    Label("选择文件夹", systemImage: "folder")
                        .labelStyle(.iconOnly)
                }
                .help("选择本地模型目录")

                Button("打开") {
                    store.openRepository()
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
            if store.shouldOpenOnLaunch && store.snapshot == nil && !store.isLoadingRepository {
                store.openRepository()
            }
        }
    }

    private let inputPlaceholder = "模型 ID、仓库 URL、本地路径或 ssh:// 地址…"
}

private struct ModelHistoryField: NSViewRepresentable {
    @Binding var text: String
    let history: [RepositoryHistoryEntry]
    let placeholder: String
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, history: history, onSubmit: onSubmit)
    }

    func makeNSView(context: Context) -> NSComboBox {
        let field = NSComboBox()
        field.placeholderString = placeholder
        field.completes = true
        field.numberOfVisibleItems = 10
        field.stringValue = text
        field.addItems(withObjectValues: history.map(\.input))
        field.delegate = context.coordinator
        return field
    }

    func updateNSView(_ field: NSComboBox, context: Context) {
        context.coordinator.text = $text
        context.coordinator.history = history
        context.coordinator.onSubmit = onSubmit
        field.placeholderString = placeholder
        let items = (0..<field.numberOfItems).compactMap { field.itemObjectValue(at: $0) as? String }
        let inputs = history.map(\.input)
        if items != inputs {
            field.removeAllItems()
            field.addItems(withObjectValues: inputs)
        }
        if field.stringValue != text {
            field.stringValue = text
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSComboBoxDelegate {
        var text: Binding<String>
        var history: [RepositoryHistoryEntry]
        var onSubmit: () -> Void
        private var guidancePopover: NSPopover?

        init(
            text: Binding<String>,
            history: [RepositoryHistoryEntry],
            onSubmit: @escaping () -> Void
        ) {
            self.text = text
            self.history = history
            self.onSubmit = onSubmit
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSComboBox else { return }
            text.wrappedValue = field.stringValue
            showGuidance(for: field)
        }

        func controlTextDidBeginEditing(_ notification: Notification) {
            guard let field = notification.object as? NSComboBox else { return }
            showGuidance(for: field)
        }

        private func showGuidance(for field: NSComboBox) {
            guard guidancePopover?.isShown != true else { return }
            let popover = NSPopover()
            popover.behavior = .transient
            popover.animates = false
            popover.contentSize = NSSize(width: 460, height: 116)
            popover.contentViewController = NSHostingController(rootView: RepositoryInputGuidanceView())
            popover.show(relativeTo: field.bounds, of: field, preferredEdge: .minY)
            guidancePopover = popover
        }

        func controlTextDidEndEditing(_ notification: Notification) {
            guidancePopover?.close()
        }

        func comboBoxSelectionDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSComboBox,
                  field.indexOfSelectedItem >= 0,
                  history.indices.contains(field.indexOfSelectedItem) else { return }
            let entry = history[field.indexOfSelectedItem]
            text.wrappedValue = entry.input
            guidancePopover?.close()
        }

        func control(
            _ control: NSControl,
            textView: NSTextView,
            doCommandBy commandSelector: Selector
        ) -> Bool {
            guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
            text.wrappedValue = control.stringValue
            guidancePopover?.close()
            onSubmit()
            return true
        }
    }
}

private struct RepositoryInputGuidanceView: View {
    var body: some View {
        VStack(spacing: 0) {
            row(icon: "shippingbox", title: "模型仓库", example: "Qwen/Qwen3-4B 或仓库 URL")
            Divider()
            row(icon: "folder", title: "本地目录", example: "/Users/name/models/Qwen3-4B")
            Divider()
            row(icon: "network", title: "SSH 目录", example: "ssh://user@host/absolute/path")
        }
        .padding(.vertical, 5)
        .frame(width: 460)
    }

    private func row(icon: String, title: String, example: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(title)
                .fontWeight(.medium)
            Text("— \(example)")
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .frame(height: 34)
    }
}
