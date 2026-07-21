import SwiftUI

struct IMatrixWorkspaceView: View {
    let overview: IMatrixOverview
    let perspective: InspectionPerspective
    @State private var query = ""

    var body: some View {
        switch perspective {
        case .overview:
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Importance Matrix")
                            .font(.system(size: 25, weight: .semibold, design: .rounded))
                        Text("llama.cpp legacy imatrix.dat · 每个条目记录 tensor 激活的重要性统计。")
                            .foregroundStyle(.secondary)
                    }

                    Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 12) {
                        factRow("条目数", overview.entries.count.formatted())
                        factRow("Chunk 数", overview.chunkCount?.formatted() ?? "未记录")
                        factRow("数据集", overview.dataset ?? "未记录")
                        factRow("文件大小", Int64(overview.byteCount).formattedByteCount)
                    }
                    .padding(16)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
                }
                .frame(maxWidth: 920, alignment: .leading)
                .padding(24)
            }

        case .entries:
            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("筛选 tensor", text: $query)
                        .textFieldStyle(.plain)
                    Spacer()
                    Text("\(filteredEntries.count) / \(overview.entries.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14)
                .frame(height: 38)
                .background(.bar)

                Table(filteredEntries) {
                    TableColumn("Tensor") { entry in
                        Text(entry.name).textSelection(.enabled)
                    }
                    TableColumn("Calls") { entry in
                        Text(entry.callCount.formatted()).monospacedDigit()
                    }
                    .width(min: 70, ideal: 90)
                    TableColumn("Values") { entry in
                        Text(entry.valueCount.formatted()).monospacedDigit()
                    }
                    .width(min: 80, ideal: 100)
                    TableColumn("Mean") { entry in
                        Text(format(entry.mean)).monospacedDigit()
                    }
                    .width(min: 90, ideal: 110)
                    TableColumn("Min") { entry in
                        Text(format(Double(entry.minimum))).monospacedDigit()
                    }
                    .width(min: 90, ideal: 110)
                    TableColumn("Max") { entry in
                        Text(format(Double(entry.maximum))).monospacedDigit()
                    }
                    .width(min: 90, ideal: 110)
                }
            }

        default:
            EmptyView()
        }
    }

    private var filteredEntries: [IMatrixEntry] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return overview.entries }
        return overview.entries.filter { $0.name.localizedCaseInsensitiveContains(needle) }
    }

    @ViewBuilder
    private func factRow(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 110, alignment: .leading)
            Text(value)
                .textSelection(.enabled)
        }
    }

    private func format(_ value: Double) -> String {
        value.formatted(.number.precision(.significantDigits(5)))
    }
}
