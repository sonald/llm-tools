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
                    text: $store.modelID,
                    history: store.modelHistory,
                    onSubmit: store.openModel
                )
                    .frame(width: 320)
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

private struct ModelHistoryField: NSViewRepresentable {
    @Binding var text: String
    let history: [String]
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, onSubmit: onSubmit)
    }

    func makeNSView(context: Context) -> NSComboBox {
        let field = NSComboBox()
        field.placeholderString = "组织/模型或仓库 URL"
        field.completes = true
        field.numberOfVisibleItems = 10
        field.stringValue = text
        field.addItems(withObjectValues: history)
        field.delegate = context.coordinator
        return field
    }

    func updateNSView(_ field: NSComboBox, context: Context) {
        context.coordinator.text = $text
        context.coordinator.onSubmit = onSubmit
        let items = (0..<field.numberOfItems).compactMap { field.itemObjectValue(at: $0) as? String }
        if items != history {
            field.removeAllItems()
            field.addItems(withObjectValues: history)
        }
        if field.stringValue != text {
            field.stringValue = text
        }
    }

    final class Coordinator: NSObject, NSComboBoxDelegate {
        var text: Binding<String>
        var onSubmit: () -> Void

        init(text: Binding<String>, onSubmit: @escaping () -> Void) {
            self.text = text
            self.onSubmit = onSubmit
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSComboBox else { return }
            text.wrappedValue = field.stringValue
        }

        func comboBoxSelectionDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSComboBox,
                  field.indexOfSelectedItem >= 0,
                  let value = field.itemObjectValue(at: field.indexOfSelectedItem) as? String else { return }
            text.wrappedValue = value
        }

        func control(
            _ control: NSControl,
            textView: NSTextView,
            doCommandBy commandSelector: Selector
        ) -> Bool {
            guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
            text.wrappedValue = control.stringValue
            onSubmit()
            return true
        }
    }
}
