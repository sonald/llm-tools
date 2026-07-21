import Foundation

struct IMatrixEntry: Identifiable, Sendable, Equatable {
    let name: String
    let callCount: Int32
    let valueCount: Int
    let minimum: Float
    let maximum: Float
    let mean: Double

    var id: String { name }
}

struct IMatrixOverview: Sendable, Equatable {
    let entries: [IMatrixEntry]
    let chunkCount: Int32?
    let dataset: String?
    let byteCount: Int
}

struct IMatrixInspection: Sendable {
    let overview: IMatrixOverview?
    let error: String?
}

enum IMatrixInspector {
    static let maximumEntryCount = 100_000
    static let maximumNameLength = 1_024
    static let maximumValueCount = 10_000_000

    static func inspect(_ data: Data) -> IMatrixInspection {
        do {
            var cursor = Cursor(data: data)
            let entryCount = Int(try cursor.readInt32())
            guard (1...maximumEntryCount).contains(entryCount) else {
                throw ParseFailure.invalid("imatrix 条目数量无效或超过安全上限。")
            }

            var entries: [IMatrixEntry] = []
            var names = Set<String>()
            var totalValueCount = 0

            for _ in 0..<entryCount {
                let nameLength = Int(try cursor.readInt32())
                guard (1...maximumNameLength).contains(nameLength),
                      let name = String(data: try cursor.readData(count: nameLength), encoding: .utf8),
                      names.insert(name).inserted else {
                    throw ParseFailure.invalid("imatrix tensor 名称无效或重复。")
                }

                let callCount = try cursor.readInt32()
                let valueCount = Int(try cursor.readInt32())
                guard callCount >= 0, valueCount > 0,
                      valueCount <= maximumValueCount - totalValueCount else {
                    throw ParseFailure.invalid("imatrix \(name) 的计数无效或超过安全上限。")
                }
                totalValueCount += valueCount

                var minimum = Float.infinity
                var maximum = -Float.infinity
                var sum = 0.0
                for _ in 0..<valueCount {
                    let value = try cursor.readFloat32()
                    guard value.isFinite else {
                        throw ParseFailure.invalid("imatrix \(name) 包含非有限数值。")
                    }
                    minimum = min(minimum, value)
                    maximum = max(maximum, value)
                    sum += Double(value)
                }

                entries.append(IMatrixEntry(
                    name: name,
                    callCount: callCount,
                    valueCount: valueCount,
                    minimum: minimum,
                    maximum: maximum,
                    mean: sum / Double(valueCount)
                ))
            }

            let trailer = try readTrailer(from: &cursor)
            return IMatrixInspection(
                overview: IMatrixOverview(
                    entries: entries.sorted {
                        $0.name.localizedStandardCompare($1.name) == .orderedAscending
                    },
                    chunkCount: trailer.chunkCount,
                    dataset: trailer.dataset,
                    byteCount: data.count
                ),
                error: nil
            )
        } catch let ParseFailure.invalid(message) {
            return IMatrixInspection(overview: nil, error: message)
        } catch {
            return IMatrixInspection(overview: nil, error: "imatrix 文件无效。")
        }
    }

    private static func readTrailer(from cursor: inout Cursor) throws -> (chunkCount: Int32?, dataset: String?) {
        guard cursor.remaining > 0 else { return (nil, nil) }

        let chunkCount = try cursor.readInt32()
        guard chunkCount >= 0 else {
            throw ParseFailure.invalid("imatrix chunk 数量无效。")
        }
        guard cursor.remaining > 0 else { return (chunkCount, nil) }

        let datasetLength = Int(try cursor.readInt32())
        guard datasetLength >= 0, datasetLength <= cursor.remaining else {
            throw ParseFailure.invalid("imatrix dataset 长度无效。")
        }
        let datasetData = try cursor.readData(count: datasetLength)
        guard cursor.remaining == 0,
              let dataset = String(data: datasetData, encoding: .utf8) else {
            throw ParseFailure.invalid("imatrix dataset 无效。")
        }
        return (chunkCount, dataset.isEmpty ? nil : dataset)
    }
}

private extension IMatrixInspector {
    enum ParseFailure: Error {
        case invalid(String)
    }

    struct Cursor {
        let data: Data
        var offset = 0

        var remaining: Int { data.count - offset }

        mutating func readInt32() throws -> Int32 {
            guard remaining >= 4 else {
                throw ParseFailure.invalid("imatrix 文件提前结束。")
            }
            let value = UInt32(data[offset])
                | UInt32(data[offset + 1]) << 8
                | UInt32(data[offset + 2]) << 16
                | UInt32(data[offset + 3]) << 24
            offset += 4
            return Int32(bitPattern: value)
        }

        mutating func readFloat32() throws -> Float {
            Float(bitPattern: UInt32(bitPattern: try readInt32()))
        }

        mutating func readData(count: Int) throws -> Data {
            guard count >= 0, count <= remaining else {
                throw ParseFailure.invalid("imatrix 文件提前结束。")
            }
            defer { offset += count }
            return data.subdata(in: offset..<(offset + count))
        }
    }
}
