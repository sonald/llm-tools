import SwiftUI

struct TokenizerComparisonView: View {
    let session: TokenizerComparisonSession
    let showWhitespace: Bool
    let selectChatTemplate: (String?) -> Void

    @State private var leftSelectedTokenIndex: Int?
    @State private var rightSelectedTokenIndex: Int?

    var body: some View {
        Group {
            switch session.phase {
            case .loading:
                ProgressView("正在加载对照 tokenizer…")
                    .controlSize(.small)
            case let .failed(message):
                Label(message, systemImage: "xmark.octagon")
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            case .ready:
                if let left = session.left, let right = session.right {
                    comparisonBody(left: left, right: right)
                } else {
                    Text("输入内容后显示对照结果。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .onChange(of: session) { _, _ in
            leftSelectedTokenIndex = nil
            rightSelectedTokenIndex = nil
        }
    }

    private func comparisonBody(left: TokenizationResult, right: TokenizationResult) -> some View {
        let summary = TokenizerComparisonSummary(leftIDs: left.tokenIDs, rightIDs: right.tokenIDs)
        return VStack(alignment: .leading, spacing: 10) {
            summaryView(summary, left: left, right: right)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    resultColumn(
                        title: "主侧",
                        result: left,
                        selectedIndex: $leftSelectedTokenIndex
                    )
                    resultColumn(
                        title: rightTitle,
                        result: right,
                        selectedIndex: $rightSelectedTokenIndex
                    )
                }
                VStack(alignment: .leading, spacing: 12) {
                    resultColumn(
                        title: "主侧",
                        result: left,
                        selectedIndex: $leftSelectedTokenIndex
                    )
                    resultColumn(
                        title: rightTitle,
                        result: right,
                        selectedIndex: $rightSelectedTokenIndex
                    )
                }
            }
        }
    }

    private func summaryView(
        _ summary: TokenizerComparisonSummary,
        left: TokenizationResult,
        right: TokenizationResult
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 12) {
                Text("主 \(left.tokenCount.formatted())")
                Text("对照 \(right.tokenCount.formatted())")
                Text("差值 \(deltaText(summary.countDelta))")
                Text(summary.idsMatch ? "ID 序列相同" : "ID 序列不同")
            }
            .font(.caption.weight(.semibold).monospacedDigit())
            if let firstDifference = summary.firstDifference {
                Text("第一处不同：index \(firstDifference)，主 \(summary.leftID.map(String.init) ?? "—")，对照 \(summary.rightID.map(String.init) ?? "—")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("第一处不同：无")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let leftOverhead = left.overhead, let rightOverhead = right.overhead {
                Text("模板开销（近似）：主 \(display(leftOverhead.templateCount)) · 对照 \(display(rightOverhead.templateCount))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 8))
    }

    private func resultColumn(
        title: String,
        result: TokenizationResult,
        selectedIndex: Binding<Int?>
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                if title == rightTitle {
                    rightTemplateControl
                }
            }
            TokenizerTokenTableView(
                result: result,
                showWhitespace: showWhitespace,
                selectedTokenIndex: selectedIndex
            )
            .frame(minHeight: 220, idealHeight: 280)
        }
        .frame(minWidth: 360, maxWidth: .infinity, alignment: .leading)
    }

    private var rightTitle: String {
        if case let .snapshotPath(path) = session.source { return path }
        return "对照"
    }

    @ViewBuilder
    private var rightTemplateControl: some View {
        if session.left?.overhead != nil,
           let catalog = session.rightCatalog,
           let active = catalog.activeEntry {
            let entries = catalog.entries
            if entries.count > 1 {
                Menu {
                    ForEach(entries) { entry in
                        Button(templateLabel(entry)) {
                            selectChatTemplate(entry.id)
                        }
                        .disabled(!entry.isUsable)
                    }
                } label: {
                    Text(templateLabel(active))
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                }
                .menuStyle(.borderlessButton)
            } else {
                Text(templateLabel(active))
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
            }
        }
    }

    private func templateLabel(_ entry: ChatTemplateEntry) -> String {
        switch entry.source {
        case .jinjaFile: "chat_template.jinja"
        case .tokenizerConfig: "tokenizer_config.json · \(entry.name)"
        }
    }

    private func display(_ count: Int) -> String {
        count < 0 ? "无法按差量拆分" : count.formatted()
    }

    private func deltaText(_ count: Int) -> String {
        count > 0 ? "+\(count.formatted())" : count.formatted()
    }
}
