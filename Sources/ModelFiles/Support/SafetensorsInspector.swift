import Foundation

struct SafetensorInfo: Identifiable, Sendable, Equatable {
    let name: String
    let dtype: String
    let shape: [Int64]
    let parameterCount: UInt64
    let byteCount: UInt64

    var id: String { name }
}

struct SafetensorsOverview: Sendable, Equatable {
    let tensors: [SafetensorInfo]
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
            let metadata = root["__metadata__"] as? [String: String] ?? [:]
            let tensors = root.compactMap { name, value -> SafetensorInfo? in
                guard name != "__metadata__",
                      let entry = value as? [String: Any],
                      let dtype = entry["dtype"] as? String,
                      let rawShape = entry["shape"] as? [NSNumber],
                      let offsets = entry["data_offsets"] as? [NSNumber],
                      offsets.count == 2 else { return nil }
                let shape = rawShape.map(\.int64Value)
                let parameters = shape.reduce(UInt64(1)) { partial, dimension in
                    guard dimension >= 0 else { return 0 }
                    let result = partial.multipliedReportingOverflow(by: UInt64(dimension))
                    return result.overflow ? 0 : result.partialValue
                }
                let start = offsets[0].uint64Value
                let end = offsets[1].uint64Value
                return SafetensorInfo(
                    name: name,
                    dtype: dtype,
                    shape: shape,
                    parameterCount: parameters,
                    byteCount: end >= start ? end - start : 0
                )
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

            return SafetensorsInspection(
                overview: SafetensorsOverview(
                    tensors: tensors,
                    metadata: metadata,
                    dtypeCounts: Dictionary(grouping: tensors, by: \.dtype).mapValues(\.count),
                    parameterCount: tensors.reduce(0) { saturatingAdd($0, $1.parameterCount) },
                    byteCount: tensors.reduce(0) { saturatingAdd($0, $1.byteCount) }
                ),
                error: nil
            )
        } catch {
            return SafetensorsInspection(overview: nil, error: error.localizedDescription)
        }
    }

    private static func saturatingAdd(_ lhs: UInt64, _ rhs: UInt64) -> UInt64 {
        let result = lhs.addingReportingOverflow(rhs)
        return result.overflow ? .max : result.partialValue
    }
}
