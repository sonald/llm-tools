import AppKit
import SwiftUI

struct TokenizerTokenTableView: View {
    struct Row: Identifiable, Equatable {
        let index: Int
        let tokenID: Int
        let piece: String?
        let decoded: String
        let mapping: TokenizerSourceMapping
        let role: TokenRole?
        let specialName: String?
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
        rows = Self.makeRows(result: result)
        self.showWhitespace = showWhitespace
        _selectedTokenIndex = selectedTokenIndex
    }

    nonisolated static func makeRows(result: TokenizationResult) -> [Row] {
        precondition(
            result.flags.count == result.tokenIDs.count,
            "TokenizationResult.flags must match tokenIDs."
        )
        if let roles = result.roles {
            precondition(
                roles.count == result.tokenIDs.count,
                "TokenizationResult.roles must match tokenIDs."
            )
        }
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
                role: result.roles?[index],
                specialName: result.flags[index].isSpecial ? result.flags[index].specialName : nil,
                colorIndex: segmentIndex
            ))
        }
        return built
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
                .frame(width: max(850, proxy.size.width), height: proxy.size.height)
            }
        }
        .textSelection(.enabled)
        .accessibilityLabel(String(localized: "Token 表，共 \(rows.count) 行"))
    }

    private var header: some View {
        HStack(spacing: 0) {
            headerCell("#", width: 52)
            headerCell("ID", width: 86)
            headerCell("Token Piece", width: 152)
            headerCell("Decoded", width: 220)
            headerCell("Role", width: 96)
            headerCell("Special", width: 112)
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
        let selected = selectedTokenIndex == row.index
        return Button {
            selectedTokenIndex = toggleTokenSelection(selectedTokenIndex, clicked: row.index)
        } label: {
            HStack(spacing: 0) {
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
                cell(row.role?.title ?? "—", width: 96)
                cell(row.specialName ?? "—", width: 112)
                cell(row.mapping.title, width: 112)
                Spacer(minLength: 0)
            }
            .font(.system(size: 11, design: .monospaced))
            .frame(height: 30)
            .background(selected ? Color.accentColor.opacity(0.14) : Color.clear)
            .overlay(alignment: .bottom) { Divider().opacity(0.55) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("复制 ID") { copy(row.tokenID.formatted()) }
            if let piece = row.piece {
                Button("复制 Token Piece") { copy(piece) }
            }
            Button("复制解码片段") { copy(row.decoded) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            String(localized: "Token \(row.index)，ID \(row.tokenID)，Piece \(visible(row.piece ?? String(localized: "无")))，Decoded \(visible(row.decoded))，Role \(row.role?.title ?? String(localized: "无"))，Special \(row.specialName ?? String(localized: "无"))，\(row.mapping.title)")
        )
        .accessibilityAddTraits(selected ? .isSelected : [])
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
