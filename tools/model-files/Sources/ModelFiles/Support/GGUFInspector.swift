import Foundation

struct GGUFMetadataEntry: Identifiable, Sendable, Equatable {
    let key: String
    let type: String
    let value: String
    let stringValue: String?
    let unsignedValue: UInt64?

    var id: String { key }
}

struct GGUFOverview: Sendable, Equatable {
    let version: UInt32
    let isLittleEndian: Bool
    let metadata: [GGUFMetadataEntry]
    let tensors: [TensorDescriptor]
    let parameterCount: UInt64
    let tensorDataOffset: Int
    let alignment: UInt64

    var modelName: String? { entry("general.name")?.stringValue }
    var architecture: String? { entry("general.architecture")?.stringValue }
    var isIMatrix: Bool { entry("general.type")?.stringValue == "imatrix" }

    var imatrixEntryCount: Int? {
        guard isIMatrix else { return nil }
        let sumSuffix = ".in_sum2"
        let countSuffix = ".counts"
        let sums = Set(tensors.compactMap { tensor in
            tensor.name.hasSuffix(sumSuffix)
                ? String(tensor.name.dropLast(sumSuffix.count))
                : nil
        })
        let counts = Set(tensors.compactMap { tensor in
            tensor.name.hasSuffix(countSuffix)
                ? String(tensor.name.dropLast(countSuffix.count))
                : nil
        })
        return sums.intersection(counts).count
    }

    var contextLength: UInt64? {
        if let architecture,
           let value = entry("\(architecture).context_length")?.unsignedValue {
            return value
        }
        return metadata.first {
            $0.key.hasSuffix(".context_length") && $0.unsignedValue != nil
        }?.unsignedValue
    }

    var dtypeCounts: [String: Int] {
        Dictionary(grouping: tensors, by: \.dataType).mapValues(\.count)
    }

    var dominantDataType: String? {
        dtypeCounts.max { lhs, rhs in
            lhs.value == rhs.value ? lhs.key > rhs.key : lhs.value < rhs.value
        }?.key
    }

    func entry(_ key: String) -> GGUFMetadataEntry? {
        metadata.first { $0.key == key }
    }
}

enum GGUFInspection: Sendable, Equatable {
    case complete(GGUFOverview)
    case needsMoreData
    case invalid(String)
}

enum GGUFInspector {
    static let maximumMetadataCount: UInt64 = 100_000
    static let maximumTensorCount: UInt64 = 1_000_000
    static let maximumArrayElements: UInt64 = 1_000_000
    static let maximumStringLength: UInt64 = 10 * 1_024 * 1_024
    static let maximumDimensions: UInt32 = 8
    static let maximumArrayDepth = 4

    static func inspect(_ data: Data) -> GGUFInspection {
        do {
            var parser = try Parser(data: data)
            return .complete(try parser.parse())
        } catch ParseFailure.needsMoreData {
            return .needsMoreData
        } catch let ParseFailure.invalid(message) {
            return .invalid(message)
        } catch {
            return .invalid("GGUF 解析失败：\(error.localizedDescription)")
        }
    }
}

private extension GGUFInspector {
    enum Endianness {
        case little
        case big
    }

    enum ParseFailure: Error, Equatable {
        case needsMoreData
        case invalid(String)
    }

    struct ParsedValue {
        let display: String
        let stringValue: String?
        let unsignedValue: UInt64?

        static let hidden = ParsedValue(display: "", stringValue: nil, unsignedValue: nil)
    }

    struct Parser {
        private var cursor: Cursor
        private let version: UInt32
        private let endianness: Endianness
        private var arrayElementsRead: UInt64 = 0

        init(data: Data) throws {
            guard data.count >= 4 else { throw ParseFailure.needsMoreData }
            guard Array(data.prefix(4)) == Array("GGUF".utf8) else {
                throw ParseFailure.invalid("GGUF magic 无效。")
            }
            guard data.count >= 8 else { throw ParseFailure.needsMoreData }

            let littleVersion = Self.uint32(in: data, at: 4, endianness: .little)
            let bigVersion = Self.uint32(in: data, at: 4, endianness: .big)
            if (1...3).contains(littleVersion) {
                version = littleVersion
                endianness = .little
            } else if bigVersion == 3 {
                version = bigVersion
                endianness = .big
            } else {
                throw ParseFailure.invalid("不支持的 GGUF 版本。")
            }
            cursor = Cursor(data: data, offset: 8, endianness: endianness)
        }

        mutating func parse() throws -> GGUFOverview {
            let tensorCount = try readCount()
            let metadataCount = try readCount()
            guard tensorCount <= GGUFInspector.maximumTensorCount else {
                throw ParseFailure.invalid("GGUF tensor 数量超过安全上限。")
            }
            guard metadataCount <= GGUFInspector.maximumMetadataCount else {
                throw ParseFailure.invalid("GGUF metadata 数量超过安全上限。")
            }

            var metadata: [GGUFMetadataEntry] = []
            var metadataKeys = Set<String>()
            for _ in 0..<metadataCount {
                let key = try readString(maximumLength: 65_535, capture: true) ?? ""
                guard isValidMetadataKey(key), metadataKeys.insert(key).inserted else {
                    throw ParseFailure.invalid("GGUF metadata key 无效或重复。")
                }
                let typeCode = try cursor.readUInt32()
                let value = try readValue(typeCode: typeCode, depth: 0, capture: true)
                metadata.append(GGUFMetadataEntry(
                    key: key,
                    type: typeName(typeCode),
                    value: value.display,
                    stringValue: value.stringValue,
                    unsignedValue: value.unsignedValue
                ))
            }

            let alignment = metadata.first { $0.key == "general.alignment" }?.unsignedValue ?? 32
            guard alignment > 0, alignment.isMultiple(of: 8) else {
                throw ParseFailure.invalid("GGUF general.alignment 无效。")
            }

            var tensors: [TensorDescriptor] = []
            var tensorNames = Set<String>()
            var parameterCount: UInt64 = 0
            for _ in 0..<tensorCount {
                let name = try readString(maximumLength: 64, capture: true) ?? ""
                guard !name.isEmpty, tensorNames.insert(name).inserted else {
                    throw ParseFailure.invalid("GGUF tensor 名称无效或重复。")
                }
                let dimensionCount = try cursor.readUInt32()
                guard dimensionCount <= GGUFInspector.maximumDimensions else {
                    throw ParseFailure.invalid("GGUF tensor \(name) 的维数超过安全上限。")
                }

                var shape: [UInt64] = []
                for _ in 0..<dimensionCount {
                    shape.append(try version == 1 ? UInt64(cursor.readUInt32()) : cursor.readUInt64())
                }
                let typeCode = try cursor.readUInt32()
                let offset = try cursor.readUInt64()
                guard offset.isMultiple(of: alignment) else {
                    throw ParseFailure.invalid("GGUF tensor \(name) 的 offset 未按 alignment 对齐。")
                }
                let parameters = try checkedProduct(shape, context: "tensor \(name) shape")
                parameterCount = try checkedAdd(parameterCount, parameters, context: "参数总数")
                tensors.append(TensorDescriptor(
                    name: name,
                    dataType: tensorTypeName(typeCode),
                    shape: shape,
                    parameterCount: parameters,
                    byteCount: nil,
                    offset: offset
                ))
            }

            let tensorDataOffset = try alignedOffset(cursor.offset, alignment: alignment)
            return GGUFOverview(
                version: version,
                isLittleEndian: endianness == .little,
                metadata: metadata,
                tensors: tensors.sorted {
                    $0.name.localizedStandardCompare($1.name) == .orderedAscending
                },
                parameterCount: parameterCount,
                tensorDataOffset: tensorDataOffset,
                alignment: alignment
            )
        }

        private mutating func readCount() throws -> UInt64 {
            try version == 1 ? UInt64(cursor.readUInt32()) : cursor.readUInt64()
        }

        private mutating func readString(
            maximumLength: UInt64 = GGUFInspector.maximumStringLength,
            capture: Bool
        ) throws -> String? {
            let length = try readCount()
            guard length <= maximumLength, length <= UInt64(Int.max) else {
                throw ParseFailure.invalid("GGUF 字符串超过安全上限。")
            }
            let byteCount = Int(length)
            if capture {
                let bytes = try cursor.readData(count: byteCount)
                guard let value = String(data: bytes, encoding: .utf8) else {
                    throw ParseFailure.invalid("GGUF 字符串不是有效 UTF-8。")
                }
                return value
            }
            try cursor.skip(byteCount)
            return nil
        }

        private mutating func readValue(
            typeCode: UInt32,
            depth: Int,
            capture: Bool
        ) throws -> ParsedValue {
            if version == 1, typeCode > 9 {
                throw ParseFailure.invalid("GGUF v1 包含不支持的 metadata 类型 \(typeCode)。")
            }

            switch typeCode {
            case 0:
                let value = try cursor.readUInt8()
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: UInt64(value)) : .hidden
            case 1:
                let value = Int8(bitPattern: try cursor.readUInt8())
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: nil) : .hidden
            case 2:
                let value = try cursor.readUInt16()
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: UInt64(value)) : .hidden
            case 3:
                let value = Int16(bitPattern: try cursor.readUInt16())
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: nil) : .hidden
            case 4:
                let value = try cursor.readUInt32()
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: UInt64(value)) : .hidden
            case 5:
                let value = Int32(bitPattern: try cursor.readUInt32())
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: nil) : .hidden
            case 6:
                let value = Float(bitPattern: try cursor.readUInt32())
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: nil) : .hidden
            case 7:
                let value = try cursor.readUInt8()
                guard value == 0 || value == 1 else {
                    throw ParseFailure.invalid("GGUF bool 值必须为 0 或 1。")
                }
                return capture ? ParsedValue(display: value == 1 ? "true" : "false", stringValue: nil, unsignedValue: nil) : .hidden
            case 8:
                let value = try readString(capture: capture)
                return capture ? ParsedValue(display: value ?? "", stringValue: value, unsignedValue: nil) : .hidden
            case 9:
                guard depth < GGUFInspector.maximumArrayDepth else {
                    throw ParseFailure.invalid("GGUF metadata array 嵌套超过安全上限。")
                }
                let elementType = try cursor.readUInt32()
                guard elementType <= 12 else {
                    throw ParseFailure.invalid("GGUF metadata array 类型无效。")
                }
                let count = try readCount()
                let nextCount = arrayElementsRead.addingReportingOverflow(count)
                guard !nextCount.overflow,
                      nextCount.partialValue <= GGUFInspector.maximumArrayElements else {
                    throw ParseFailure.invalid("GGUF metadata array 元素数量超过安全上限。")
                }
                arrayElementsRead = nextCount.partialValue

                var preview: [String] = []
                for index in 0..<count {
                    let shouldCapture = capture && index < 16
                    let value = try readValue(
                        typeCode: elementType,
                        depth: depth + 1,
                        capture: shouldCapture
                    )
                    if shouldCapture { preview.append(value.display) }
                }
                guard capture else { return .hidden }
                let suffix = count > 16 ? ", …" : ""
                return ParsedValue(
                    display: "[\(preview.joined(separator: ", "))\(suffix)] · \(count.formatted()) 项",
                    stringValue: nil,
                    unsignedValue: nil
                )
            case 10:
                let value = try cursor.readUInt64()
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: value) : .hidden
            case 11:
                let value = Int64(bitPattern: try cursor.readUInt64())
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: nil) : .hidden
            case 12:
                let value = Double(bitPattern: try cursor.readUInt64())
                return capture ? ParsedValue(display: String(value), stringValue: nil, unsignedValue: nil) : .hidden
            default:
                throw ParseFailure.invalid("GGUF metadata 类型 \(typeCode) 无效。")
            }
        }

        private func isValidMetadataKey(_ key: String) -> Bool {
            guard !key.isEmpty, key.unicodeScalars.allSatisfy(\.isASCII) else { return false }
            return key.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { segment in
                !segment.isEmpty && segment.utf8.allSatisfy { byte in
                    (97...122).contains(byte) || (48...57).contains(byte) || byte == 95
                }
            }
        }

        private func checkedProduct(_ values: [UInt64], context: String) throws -> UInt64 {
            var result: UInt64 = 1
            for value in values {
                let next = result.multipliedReportingOverflow(by: value)
                guard !next.overflow else {
                    throw ParseFailure.invalid("GGUF \(context) 溢出。")
                }
                result = next.partialValue
            }
            return result
        }

        private func checkedAdd(_ lhs: UInt64, _ rhs: UInt64, context: String) throws -> UInt64 {
            let result = lhs.addingReportingOverflow(rhs)
            guard !result.overflow else { throw ParseFailure.invalid("GGUF \(context) 溢出。") }
            return result.partialValue
        }

        private func alignedOffset(_ offset: Int, alignment: UInt64) throws -> Int {
            let value = UInt64(offset)
            let addition = (alignment - value % alignment) % alignment
            let result = value.addingReportingOverflow(addition)
            guard !result.overflow, result.partialValue <= UInt64(Int.max) else {
                throw ParseFailure.invalid("GGUF tensor data offset 溢出。")
            }
            return Int(result.partialValue)
        }

        private func typeName(_ code: UInt32) -> String {
            [
                0: "uint8", 1: "int8", 2: "uint16", 3: "int16",
                4: "uint32", 5: "int32", 6: "float32", 7: "bool",
                8: "string", 9: "array", 10: "uint64", 11: "int64", 12: "float64",
            ][code] ?? "type \(code)"
        }

        private func tensorTypeName(_ code: UInt32) -> String {
            [
                0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 4: "Q4_2", 5: "Q4_3",
                6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1", 10: "Q2_K",
                11: "Q3_K", 12: "Q4_K", 13: "Q5_K", 14: "Q6_K", 15: "Q8_K",
                16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S",
                20: "IQ4_NL", 21: "IQ3_S", 22: "IQ2_S", 23: "IQ4_XS",
                24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64",
                29: "IQ1_M", 30: "BF16", 34: "TQ1_0", 35: "TQ2_0", 39: "MXFP4",
            ][code] ?? "TYPE_\(code)"
        }

        private static func uint32(in data: Data, at offset: Int, endianness: Endianness) -> UInt32 {
            let bytes = data[offset..<(offset + 4)]
            switch endianness {
            case .little:
                return bytes.enumerated().reduce(0) { result, item in
                    result | UInt32(item.element) << UInt32(item.offset * 8)
                }
            case .big:
                return bytes.reduce(0) { ($0 << 8) | UInt32($1) }
            }
        }
    }

    struct Cursor {
        let data: Data
        var offset: Int
        let endianness: Endianness

        mutating func readUInt8() throws -> UInt8 {
            guard offset < data.count else { throw ParseFailure.needsMoreData }
            defer { offset += 1 }
            return data[offset]
        }

        mutating func readUInt16() throws -> UInt16 {
            UInt16(try readInteger(byteCount: 2))
        }

        mutating func readUInt32() throws -> UInt32 {
            UInt32(try readInteger(byteCount: 4))
        }

        mutating func readUInt64() throws -> UInt64 {
            try readInteger(byteCount: 8)
        }

        mutating func readData(count: Int) throws -> Data {
            guard count >= 0, count <= data.count - offset else {
                throw ParseFailure.needsMoreData
            }
            defer { offset += count }
            return data.subdata(in: offset..<(offset + count))
        }

        mutating func skip(_ count: Int) throws {
            guard count >= 0, count <= data.count - offset else {
                throw ParseFailure.needsMoreData
            }
            offset += count
        }

        private mutating func readInteger(byteCount: Int) throws -> UInt64 {
            guard byteCount <= data.count - offset else { throw ParseFailure.needsMoreData }
            var result: UInt64 = 0
            switch endianness {
            case .little:
                for index in 0..<byteCount {
                    result |= UInt64(data[offset + index]) << UInt64(index * 8)
                }
            case .big:
                for index in 0..<byteCount {
                    result = (result << 8) | UInt64(data[offset + index])
                }
            }
            offset += byteCount
            return result
        }
    }
}
