import Foundation
import XCTest
@testable import ModelFiles

final class GGUFInspectorTests: XCTestCase {
    func testParsesV3MetadataAndTensorDirectory() throws {
        let data = makeV3()
        guard case let .complete(overview) = GGUFInspector.inspect(data) else {
            return XCTFail("Expected complete GGUF inspection")
        }

        XCTAssertEqual(overview.version, 3)
        XCTAssertTrue(overview.isLittleEndian)
        XCTAssertEqual(overview.architecture, "llama")
        XCTAssertEqual(overview.contextLength, 4_096)
        XCTAssertEqual(overview.parameterCount, 32)
        XCTAssertEqual(overview.tensors.first?.dataType, "Q6_K")
        XCTAssertEqual(overview.tensors.first?.shape, [4, 8])
        XCTAssertEqual(overview.tensorDataOffset % 32, 0)
        XCTAssertEqual(overview.metadata.first { $0.key == "general.tags" }?.value, "[chat, test] · 2 项")
    }

    func testTruncatedDataRequestsMoreBytes() {
        XCTAssertEqual(GGUFInspector.inspect(Data(makeV3().dropLast())), .needsMoreData)
    }

    func testRejectsTensorShapeOverflow() {
        var data = header(version: 3, tensorCount: 1, metadataCount: 0, littleEndian: true)
        appendString("overflow", to: &data, version: 3, littleEndian: true)
        append(2, bytes: 4, to: &data, littleEndian: true)
        append(UInt64.max, bytes: 8, to: &data, littleEndian: true)
        append(2, bytes: 8, to: &data, littleEndian: true)
        append(0, bytes: 4, to: &data, littleEndian: true)
        append(0, bytes: 8, to: &data, littleEndian: true)

        guard case let .invalid(message) = GGUFInspector.inspect(data) else {
            return XCTFail("Expected invalid GGUF")
        }
        XCTAssertTrue(message.contains("溢出"))
    }

    func testParsesV1CountsAndDimensions() {
        var data = header(version: 1, tensorCount: 1, metadataCount: 0, littleEndian: true)
        appendString("weight", to: &data, version: 1, littleEndian: true)
        append(1, bytes: 4, to: &data, littleEndian: true)
        append(7, bytes: 4, to: &data, littleEndian: true)
        append(1, bytes: 4, to: &data, littleEndian: true)
        append(0, bytes: 8, to: &data, littleEndian: true)

        guard case let .complete(overview) = GGUFInspector.inspect(data) else {
            return XCTFail("Expected complete GGUF v1 inspection")
        }
        XCTAssertEqual(overview.tensors.first?.shape, [7])
    }

    func testDetectsBigEndianV3() {
        let data = header(version: 3, tensorCount: 0, metadataCount: 0, littleEndian: false)

        guard case let .complete(overview) = GGUFInspector.inspect(data) else {
            return XCTFail("Expected complete big-endian GGUF")
        }
        XCTAssertFalse(overview.isLittleEndian)
    }

    func testRecognizesGGUFIMatrixTensorPairs() {
        var data = header(version: 3, tensorCount: 2, metadataCount: 1, littleEndian: true)
        appendMetadataString("general.type", "imatrix", to: &data)
        appendTensor("blk.0.weight.in_sum2", shape: [4], offset: 0, to: &data)
        appendTensor("blk.0.weight.counts", shape: [1], offset: 32, to: &data)

        guard case let .complete(overview) = GGUFInspector.inspect(data) else {
            return XCTFail("Expected complete GGUF imatrix")
        }
        XCTAssertTrue(overview.isIMatrix)
        XCTAssertEqual(overview.imatrixEntryCount, 1)
    }

    private func makeV3() -> Data {
        var data = header(version: 3, tensorCount: 1, metadataCount: 5, littleEndian: true)
        appendMetadataString("general.architecture", "llama", to: &data)
        appendMetadataString("general.name", "Tiny", to: &data)
        appendMetadataUInt32("general.alignment", 32, to: &data)
        appendMetadataUInt32("llama.context_length", 4_096, to: &data)

        appendString("general.tags", to: &data, version: 3, littleEndian: true)
        append(9, bytes: 4, to: &data, littleEndian: true)
        append(8, bytes: 4, to: &data, littleEndian: true)
        append(2, bytes: 8, to: &data, littleEndian: true)
        appendString("chat", to: &data, version: 3, littleEndian: true)
        appendString("test", to: &data, version: 3, littleEndian: true)

        appendString("blk.0.weight", to: &data, version: 3, littleEndian: true)
        append(2, bytes: 4, to: &data, littleEndian: true)
        append(4, bytes: 8, to: &data, littleEndian: true)
        append(8, bytes: 8, to: &data, littleEndian: true)
        append(14, bytes: 4, to: &data, littleEndian: true)
        append(0, bytes: 8, to: &data, littleEndian: true)
        return data
    }

    private func header(
        version: UInt32,
        tensorCount: UInt64,
        metadataCount: UInt64,
        littleEndian: Bool
    ) -> Data {
        var data = Data("GGUF".utf8)
        append(UInt64(version), bytes: 4, to: &data, littleEndian: littleEndian)
        let countBytes = version == 1 ? 4 : 8
        append(tensorCount, bytes: countBytes, to: &data, littleEndian: littleEndian)
        append(metadataCount, bytes: countBytes, to: &data, littleEndian: littleEndian)
        return data
    }

    private func appendMetadataString(_ key: String, _ value: String, to data: inout Data) {
        appendString(key, to: &data, version: 3, littleEndian: true)
        append(8, bytes: 4, to: &data, littleEndian: true)
        appendString(value, to: &data, version: 3, littleEndian: true)
    }

    private func appendMetadataUInt32(_ key: String, _ value: UInt32, to data: inout Data) {
        appendString(key, to: &data, version: 3, littleEndian: true)
        append(4, bytes: 4, to: &data, littleEndian: true)
        append(UInt64(value), bytes: 4, to: &data, littleEndian: true)
    }

    private func appendTensor(_ name: String, shape: [UInt64], offset: UInt64, to data: inout Data) {
        appendString(name, to: &data, version: 3, littleEndian: true)
        append(UInt64(shape.count), bytes: 4, to: &data, littleEndian: true)
        for dimension in shape {
            append(dimension, bytes: 8, to: &data, littleEndian: true)
        }
        append(0, bytes: 4, to: &data, littleEndian: true)
        append(offset, bytes: 8, to: &data, littleEndian: true)
    }

    private func appendString(
        _ value: String,
        to data: inout Data,
        version: UInt32,
        littleEndian: Bool
    ) {
        let bytes = Data(value.utf8)
        append(UInt64(bytes.count), bytes: version == 1 ? 4 : 8, to: &data, littleEndian: littleEndian)
        data.append(bytes)
    }

    private func append(_ value: UInt64, bytes: Int, to data: inout Data, littleEndian: Bool) {
        guard bytes > 0 else { return }
        for index in 0..<bytes {
            let shift = littleEndian ? index * 8 : (bytes - index - 1) * 8
            data.append(UInt8(truncatingIfNeeded: value >> UInt64(shift)))
        }
    }
}
