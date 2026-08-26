import XCTest
@testable import ModelFiles

final class TensorHierarchyTests: XCTestCase {
    private func tensor(_ name: String, dtype: String = "BF16") -> TensorDescriptor {
        TensorDescriptor(
            name: name,
            dataType: dtype,
            shape: [1],
            parameterCount: 1,
            byteCount: 2,
            offset: 0
        )
    }

    func testCommonPrefixBuildsOneRootGroup() throws {
        let rows = TensorHierarchy.build([
            tensor("model.layers.0.weight"),
            tensor("model.layers.1.weight"),
            tensor("model.embed.weight"),
        ])

        let root = try XCTUnwrap(rows.first)
        guard case let .group(label: label, descendantCount: count) = root.kind else {
            return XCTFail("expected root group")
        }
        XCTAssertEqual(label, "model")
        XCTAssertEqual(count, 3)
        let children = root.children ?? []
        XCTAssertEqual(children.map { $0.id }, [
            "model.embed",
            "model.layers",
        ])
    }

    func testNumericLayerIsAGroup() throws {
        let rows = TensorHierarchy.build([
            tensor("model.layers.0.self_attn.q_proj.weight"),
        ])

        let layers = try XCTUnwrap(rows.first?.children?.first(where: { $0.id.hasSuffix(".layers") }))
        let layer = try XCTUnwrap(layers.children?.first(where: { $0.id == "model.layers.0" }))
        XCTAssertEqual(layer.kind, .group(label: "0", descendantCount: 1))
    }

    func testNumericLayersSortNaturally() throws {
        let rows = TensorHierarchy.build((0...10).map {
            tensor("model.layers.\($0).weight")
        })

        let layers = try XCTUnwrap(rows.first?.children?.first(where: { $0.id.hasSuffix(".layers") }))
        let labels = layers.children?.map { row -> String in
            guard case let .group(label, _) = row.kind else { return "" }
            return label
        } ?? []
        XCTAssertEqual(labels, (0...10).map(String.init))
    }

    func testLeafRowUsesRelativeName() throws {
        let rows = TensorHierarchy.build([
            tensor("model.embed.weight"),
            tensor("model.embed.bias"),
        ])

        let embed = try XCTUnwrap(rows.first?.children?.first(where: { $0.id == "model.embed" }))
        let leafNames = embed.children?.compactMap { row -> String? in
            if case let .leaf(tensor) = row.kind { return tensor.name.split(separator: ".").last.map(String.init) }
            return nil
        } ?? []
        XCTAssertEqual(leafNames, ["bias", "weight"])
    }

    func testSearchKeepsOnlyMatchingLeaves() throws {
        let tensors = [
            tensor("model.layers.0.weight"),
            tensor("model.layers.1.weight"),
            tensor("model.head.bias", dtype: "F32"),
        ]

        XCTAssertEqual(TensorHierarchy.matches(tensors, query: "layers.1").map { $0.name }, ["model.layers.1.weight"])
        XCTAssertEqual(TensorHierarchy.matches(tensors, query: "BF16").map { $0.name }, [
            "model.layers.0.weight",
            "model.layers.1.weight",
        ])
        XCTAssertEqual(TensorHierarchy.matches(tensors, query: "missing").map { $0.name }, [])
    }

    func testSearchTrimsWhitespaceAndTreatsBlankAsEmpty() throws {
        let tensors = [
            tensor("model.layers.0.weight"),
            tensor("model.head.bias", dtype: "F32"),
        ]

        XCTAssertEqual(TensorHierarchy.matches(tensors, query: "  BF16 \n").map { $0.name }, ["model.layers.0.weight"])
        XCTAssertEqual(TensorHierarchy.matches(tensors, query: "   ").map { $0.name }, tensors.map { $0.name })
        XCTAssertEqual(TensorHierarchy.matches(tensors, query: "\t").map { $0.name }, tensors.map { $0.name })
    }
}
