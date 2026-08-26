import Foundation

struct TensorHierarchyRow: Identifiable, Sendable, Equatable {
    let id: String
    let kind: Kind
    let children: [TensorHierarchyRow]?

    enum Kind: Sendable, Equatable {
        case group(label: String, descendantCount: Int)
        case leaf(TensorDescriptor)
    }
}

enum TensorHierarchy {
    static func build(_ tensors: [TensorDescriptor]) -> [TensorHierarchyRow] {
        var roots: [String: MutableNode] = [:]
        for tensor in tensors {
            insert(tensor.name.split(separator: ".").map(String.init), tensor: tensor, into: &roots)
        }
        return roots.values.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }.map(MutableNode.freeze)
    }

    static func matches(_ tensors: [TensorDescriptor], query: String) -> [TensorDescriptor] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return tensors }
        return tensors.filter { $0.name.localizedCaseInsensitiveContains(trimmed) || $0.dataType.localizedCaseInsensitiveContains(trimmed) }
    }

    fileprivate final class MutableNode {
        let label: String
        let path: String
        var tensor: TensorDescriptor?
        var children: [String: MutableNode] = [:]

        init(label: String, path: String, tensor: TensorDescriptor?) {
            self.label = label
            self.path = path
            self.tensor = tensor
        }
    }

    private static func insert(
        _ segments: [String],
        tensor: TensorDescriptor,
        into roots: inout [String: MutableNode]
    ) {
        let first = segments.first ?? tensor.name
        let node = roots[first] ?? MutableNode(label: first, path: first, tensor: nil)
        roots[first] = node
        add(Array(segments.dropFirst()), tensor: tensor, to: node)
    }

    private static func add(_ segments: [String], tensor: TensorDescriptor, to node: MutableNode) {
        guard let first = segments.first, !segments.isEmpty else {
            node.tensor = tensor
            return
        }
        guard segments.count > 1 else {
            let leaf = node.children[first]
                ?? MutableNode(label: first, path: "\(node.path).\(first)", tensor: tensor)
            node.children[first] = leaf
            return
        }
        let child = node.children[first]
            ?? MutableNode(label: first, path: "\(node.path).\(first)", tensor: nil)
        node.children[first] = child
        add(Array(segments.dropFirst()), tensor: tensor, to: child)
    }
}

private extension TensorHierarchy.MutableNode {
    var id: String {
        tensor.map { $0.name } ?? path
    }

    static func freeze(_ node: TensorHierarchy.MutableNode) -> TensorHierarchyRow {
        TensorHierarchyRow(
            id: node.id,
            kind: node.tensor.map(TensorHierarchyRow.Kind.leaf) ?? .group(label: node.label, descendantCount: node.descendantCount),
            children: node.children.isEmpty
                ? nil
                : node.children.values.sorted(by: { $0.label.localizedStandardCompare($1.label) == .orderedAscending }).map(freeze)
        )
    }

    var descendantCount: Int {
        let own = tensor == nil ? 0 : 1
        return own + children.values.reduce(0) { $0 + $1.descendantCount }
    }
}
