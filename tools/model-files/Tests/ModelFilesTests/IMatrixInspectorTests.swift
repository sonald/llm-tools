import Foundation
import XCTest
@testable import ModelFiles

final class IMatrixInspectorTests: XCTestCase {
    func testParsesLegacyEntriesAndOptionalTrailer() {
        let data = makeLegacyIMatrix()
        let result = IMatrixInspector.inspect(data)

        XCTAssertNil(result.error)
        XCTAssertEqual(result.overview?.entries.map(\.name), ["blk.0.attn.weight", "blk.0.ffn.weight"])
        XCTAssertEqual(result.overview?.entries.first?.callCount, 8)
        XCTAssertEqual(result.overview?.entries.first?.valueCount, 3)
        XCTAssertEqual(result.overview?.entries.first?.minimum, 1)
        XCTAssertEqual(result.overview?.entries.first?.maximum, 3)
        XCTAssertEqual(result.overview?.entries.first?.mean, 2)
        XCTAssertEqual(result.overview?.chunkCount, 12)
        XCTAssertEqual(result.overview?.dataset, "calibration.txt")
        XCTAssertEqual(result.overview?.byteCount, data.count)
    }

    func testRejectsTruncatedLegacyFile() {
        let data = Data(makeLegacyIMatrix().dropLast())
        let result = IMatrixInspector.inspect(data)

        XCTAssertNil(result.overview)
        XCTAssertNotNil(result.error)
    }

    private func makeLegacyIMatrix() -> Data {
        var data = Data()
        append(2, to: &data)
        appendEntry("blk.0.ffn.weight", calls: 4, values: [0.5, 1.5], to: &data)
        appendEntry("blk.0.attn.weight", calls: 8, values: [1, 2, 3], to: &data)
        append(12, to: &data)
        appendString("calibration.txt", to: &data)
        return data
    }

    private func appendEntry(
        _ name: String,
        calls: Int32,
        values: [Float],
        to data: inout Data
    ) {
        appendString(name, to: &data)
        append(calls, to: &data)
        append(Int32(values.count), to: &data)
        for value in values {
            append(Int32(bitPattern: value.bitPattern), to: &data)
        }
    }

    private func appendString(_ value: String, to data: inout Data) {
        let bytes = Data(value.utf8)
        append(Int32(bytes.count), to: &data)
        data.append(bytes)
    }

    private func append(_ value: Int32, to data: inout Data) {
        let bits = UInt32(bitPattern: value)
        for shift in stride(from: 0, to: 32, by: 8) {
            data.append(UInt8(truncatingIfNeeded: bits >> UInt32(shift)))
        }
    }
}
