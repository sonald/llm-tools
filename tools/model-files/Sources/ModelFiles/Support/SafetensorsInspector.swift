import Foundation

struct SafetensorsOverview: Sendable, Equatable {
    let tensors: [TensorDescriptor]
    let metadata: [String: String]
    let dtypeCounts: [String: Int]
    let parameterCount: UInt64
    let byteCount: UInt64
}

struct SafetensorsInspection: Sendable {
    let overview: SafetensorsOverview?
    let error: String?
}

enum SafetensorsInspector {
    static let maximumHeaderLength: UInt64 = 25_000_000

    static func headerLength(from prefix: Data) -> UInt64? {
        guard prefix.count == 8 else { return nil }
        return prefix.enumerated().reduce(UInt64(0)) {
            $0 | (UInt64($1.element) << UInt64($1.offset * 8))
        }
    }

    static func inspect(_ data: Data) -> SafetensorsInspection {
        do {
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return SafetensorsInspection(overview: nil, error: "SafeTensors header 根节点不是对象。")
            }
            let metadata: [String: String]
            if let rawMetadata = root["__metadata__"] {
                guard let parsedMetadata = rawMetadata as? [String: String] else {
                    return SafetensorsInspection(
                        overview: nil,
                        error: "SafeTensors __metadata__ 必须是字符串字典。"
                    )
                }
                metadata = parsedMetadata
            } else {
                metadata = [:]
            }
            var tensors: [TensorDescriptor] = []
            for (name, value) in root where name != "__metadata__" {
                guard let entry = value as? [String: Any],
                      let dtype = entry["dtype"] as? String,
                      let rawShape = entry["shape"] as? [NSNumber],
                      let offsets = entry["data_offsets"] as? [NSNumber],
                      offsets.count == 2,
                      rawShape.allSatisfy({ $0.int64Value >= 0 }),
                      offsets.allSatisfy({ $0.int64Value >= 0 }) else {
                    return SafetensorsInspection(
                        overview: nil,
                        error: "SafeTensors tensor \(name) 的结构无效。"
                    )
                }

                let shape = rawShape.map { UInt64($0.int64Value) }
                guard let parameters = checkedProduct(shape) else {
                    return SafetensorsInspection(
                        overview: nil,
                        error: "SafeTensors tensor \(name) 的 shape 溢出。"
                    )
                }
                let start = UInt64(offsets[0].int64Value)
                let end = UInt64(offsets[1].int64Value)
                guard end >= start else {
                    return SafetensorsInspection(
                        overview: nil,
                        error: "SafeTensors tensor \(name) 的 data_offsets 无效。"
                    )
                }
                tensors.append(TensorDescriptor(
                    name: name,
                    dataType: dtype,
                    shape: shape,
                    parameterCount: parameters,
                    byteCount: end - start,
                    offset: start
                ))
            }
            tensors.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

            guard let parameterCount = checkedSum(tensors.map(\.parameterCount)),
                  let byteCount = checkedSum(tensors.compactMap(\.byteCount)) else {
                return SafetensorsInspection(overview: nil, error: "SafeTensors 汇总值溢出。")
            }

            return SafetensorsInspection(
                overview: SafetensorsOverview(
                    tensors: tensors,
                    metadata: metadata,
                    dtypeCounts: Dictionary(grouping: tensors, by: \.dataType).mapValues(\.count),
                    parameterCount: parameterCount,
                    byteCount: byteCount
                ),
                error: nil
            )
        } catch {
            return SafetensorsInspection(overview: nil, error: error.localizedDescription)
        }
    }

    private static func checkedProduct(_ values: [UInt64]) -> UInt64? {
        var result: UInt64 = 1
        for value in values {
            let next = result.multipliedReportingOverflow(by: value)
            guard !next.overflow else { return nil }
            result = next.partialValue
        }
        return result
    }

    private static func checkedSum(_ values: [UInt64]) -> UInt64? {
        var result: UInt64 = 0
        for value in values {
            let next = result.addingReportingOverflow(value)
            guard !next.overflow else { return nil }
            result = next.partialValue
        }
        return result
    }
}
