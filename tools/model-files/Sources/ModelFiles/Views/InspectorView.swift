import AppKit
import SwiftUI

/// Trailing inspector: the problem picked in the Problems panel, then the open file's facts.
struct InspectorView: View {
    @ObservedObject var store: ModelFilesStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if store.docksTokenizerResults,
                   let result = store.tokenizationResult,
                   let index = store.selectedTokenIndex,
                   result.tokenIDs.indices.contains(index) {
                    selectedToken(result, index: index)
                }

                if let finding = store.selectedFinding {
                    section("选中问题") {
                        Label {
                            Text(finding.title)
                        } icon: {
                            SeverityIcon(severity: finding.severity)
                        }
                        .font(.headline)

                        VStack(alignment: .leading, spacing: 10) {
                            comparisonField(finding.left)
                            Divider()
                            comparisonField(finding.right)
                        }
                        .padding(10)
                        .background(
                            Color(nsColor: .controlBackgroundColor),
                            in: RoundedRectangle(cornerRadius: 8)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .strokeBorder(Color(nsColor: .separatorColor))
                        )

                        Text(finding.detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let file = store.selectedFile {
                    section("文件") {
                        fact("路径", file.path)
                        if let size = file.size {
                            fact("大小", size.formattedByteCount)
                        }
                    }
                }

                if store.selectedFinding == nil && store.selectedFile == nil {
                    Text("打开文件或在问题面板中选择一项，这里会显示详情。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityLabel(Text("检查器"))
    }

    private func selectedToken(_ result: TokenizationResult, index: Int) -> some View {
        let id = result.tokenIDs[index]
        let visible = { (text: String) in visibleTokenizerText(text, showWhitespace: store.showsTokenWhitespace) }
        return section("选中 Token") {
            fact("序号", index.formatted())
            fact("ID", id.formatted())
            if let piece = result.tokenPieces[index] {
                fact("Token Piece", visible(piece))
            }
            if let segment = result.segment(containing: index) {
                fact("解码片段", visible(segment.text))
            }
            if let roles = result.roles, roles.indices.contains(index) {
                let role = roles[index]
                fact("角色", role.title)
            }
            if result.flags[index].isSpecial {
                fact("Special", result.flags[index].specialName ?? "—")
            }
            Button("复制 ID") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(String(id), forType: .string)
            }
            .controlSize(.small)
        }
    }

    private func section<Content: View>(
        _ title: LocalizedStringKey,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }

    private func fact(_ title: LocalizedStringKey, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func comparisonField(_ field: InspectionField) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(field.key)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(field.value)
                .font(.callout.monospaced().weight(.semibold))
                .textSelection(.enabled)
            Text(field.origin.title)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SeverityIcon: View {
    let severity: ConsistencySeverity

    var body: some View {
        Image(systemName: severity == .warning ? "exclamationmark.triangle.fill" : "info.circle.fill")
            .foregroundStyle(severity == .warning ? Color.orange : Color.blue)
            .accessibilityLabel(Text(severity == .warning ? "警告" : "提示"))
    }
}
