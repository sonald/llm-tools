import AppKit
import SwiftUI

struct TokenizerTokenTableView: View {
    private struct Row: Identifiable {
        let index: Int
        let tokenID: Int
        let piece: String?
        let decoded: String
        let mapping: TokenizerSourceMapping
        let segmentRange: Range<Int>
        let colorIndex: Int

        var id: Int { index }
    }

    private let rows: [Row]
    let showWhitespace: Bool
    @Binding var selectedTokenIndex: Int?

    init(
        result: TokenizationResult,
        showWhitespace: Bool,
        selectedTokenIndex: Binding<Int?>
    ) {
        var built: [Row] = []
        built.reserveCapacity(result.tokenIDs.count)
        var segmentIndex = 0
        for index in result.tokenIDs.indices {
            while segmentIndex + 1 < result.segments.count,
                  !result.segments[segmentIndex].tokenRange.contains(index) {
                segmentIndex += 1
            }
            let segment = result.segments[segmentIndex]
            built.append(Row(
                index: index,
                tokenID: result.tokenIDs[index],
                piece: result.tokenPieces[index],
                decoded: segment.text,
                mapping: result.sourceMapping,
                segmentRange: segment.tokenRange,
                colorIndex: segmentIndex
            ))
        }
        rows = built
        self.showWhitespace = showWhitespace
        _selectedTokenIndex = selectedTokenIndex
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                VStack(spacing: 0) {
                    header
                    Divider()
                    ScrollView(.vertical) {
                        LazyVStack(spacing: 0) {
                            ForEach(rows) { row in
                                rowView(row)
                            }
                        }
                    }
                }
                .frame(width: max(642, proxy.size.width), height: proxy.size.height)
            }
        }
        .textSelection(.enabled)
        .accessibilityLabel("Token 表，共 \(rows.count) 行")
    }

    private var header: some View {
        HStack(spacing: 0) {
            headerCell("#", width: 52)
            headerCell("ID", width: 86)
            headerCell("Token Piece", width: 152)
            headerCell("Decoded", width: 220)
            headerCell("Mapping", width: 112)
            Spacer(minLength: 0)
        }
        .frame(height: 29)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func headerCell(_ title: String, width: CGFloat) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .frame(width: width, alignment: .leading)
    }

    private func rowView(_ row: Row) -> some View {
        let selected = selectedTokenIndex.map(row.segmentRange.contains) == true
        return HStack(spacing: 0) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(segmentColor(row.colorIndex))
                    .frame(width: 8, height: 8)
                Text(row.index.formatted())
            }
            .padding(.horizontal, 8)
            .frame(width: 52, alignment: .leading)
            cell(row.tokenID.formatted(), width: 86)
            cell(visible(row.piece ?? "—"), width: 152)
            cell(visible(row.decoded), width: 220)
            cell(row.mapping.title, width: 112)
            Spacer(minLength: 0)
        }
        .font(.system(size: 11, design: .monospaced))
        .frame(height: 30)
        .background(selected ? Color.accentColor.opacity(0.14) : Color.clear)
        .overlay(alignment: .bottom) { Divider().opacity(0.55) }
        .contentShape(Rectangle())
        .onHover { hovering in selectedTokenIndex = hovering ? row.index : nil }
        .contextMenu {
            Button("复制 ID") { copy(row.tokenID.formatted()) }
            if let piece = row.piece {
                Button("复制 Token Piece") { copy(piece) }
            }
            Button("复制解码片段") { copy(row.decoded) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Token \(row.index)，ID \(row.tokenID)，Piece \(visible(row.piece ?? "无"))，Decoded \(visible(row.decoded))，\(row.mapping.title)")
    }

    private func cell(_ text: String, width: CGFloat) -> some View {
        Text(text)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 8)
            .frame(width: width, alignment: .leading)
            .help(text)
    }

    private func visible(_ text: String) -> String {
        visibleTokenizerText(text, showWhitespace: showWhitespace)
    }

    private func segmentColor(_ index: Int) -> Color {
        let colors: [Color] = [.cyan, .yellow, .blue, .green, .orange, .mint, .purple, .pink, .indigo, .teal]
        return colors[index % colors.count].opacity(0.50)
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
