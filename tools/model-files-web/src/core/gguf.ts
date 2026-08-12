export type GGUFMetadataEntry = {
  key: string
  type: string
  display: string
  stringValue: string | null
  unsignedValue: bigint | null
}

export type GGUFTensor = {
  name: string
  type: string
  shape: bigint[]
  parameters: bigint
  offset: bigint
}

export type GGUFOverview = {
  version: number
  endianness: 'little' | 'big'
  metadata: GGUFMetadataEntry[]
  tensors: GGUFTensor[]
  parameterCount: bigint
  tensorDataOffset: number
  alignment: bigint
}

export type GGUFInspection =
  | { kind: 'complete'; overview: GGUFOverview }
  | { kind: 'needs-more-data' }
  | { kind: 'invalid'; message: string }

const maximumMetadataCount = 100_000n
const maximumTensorCount = 1_000_000n
const maximumArrayElements = 1_000_000n
const maximumStringLength = 10n * 1024n * 1024n
const maximumUInt64 = (1n << 64n) - 1n
const maximumDimensions = 8
const maximumArrayDepth = 4

export function inspectGGUF(data: ArrayBufferLike): GGUFInspection {
  try {
    return { kind: 'complete', overview: new Parser(data).parse() }
  } catch (error) {
    if (error instanceof NeedsMoreData) return { kind: 'needs-more-data' }
    if (error instanceof InvalidGGUF) return { kind: 'invalid', message: error.message }
    return { kind: 'invalid', message: `GGUF 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

class NeedsMoreData extends Error {}
class InvalidGGUF extends Error {}

type ParsedValue = {
  display: string
  stringValue: string | null
  unsignedValue: bigint | null
}

class Parser {
  private readonly bytes: Uint8Array
  private readonly version: number
  private readonly endianness: 'little' | 'big'
  private readonly cursor: Cursor
  private arrayElementsRead = 0n

  constructor(data: ArrayBufferLike) {
    this.bytes = new Uint8Array(data)
    if (this.bytes.byteLength < 4) throw new NeedsMoreData()
    if (new TextDecoder().decode(this.bytes.slice(0, 4)) !== 'GGUF') throw new InvalidGGUF('GGUF magic 无效。')
    if (this.bytes.byteLength < 8) throw new NeedsMoreData()
    const littleVersion = uint32At(this.bytes, 4, true)
    const bigVersion = uint32At(this.bytes, 4, false)
    if (littleVersion >= 1 && littleVersion <= 3) {
      this.version = littleVersion
      this.endianness = 'little'
    } else if (bigVersion === 3) {
      this.version = bigVersion
      this.endianness = 'big'
    } else {
      throw new InvalidGGUF('不支持的 GGUF 版本。')
    }
    this.cursor = new Cursor(this.bytes, 8, this.endianness)
  }

  parse(): GGUFOverview {
    const tensorCount = this.readCount()
    const metadataCount = this.readCount()
    if (tensorCount > maximumTensorCount) throw new InvalidGGUF('GGUF tensor 数量超过安全上限。')
    if (metadataCount > maximumMetadataCount) throw new InvalidGGUF('GGUF metadata 数量超过安全上限。')

    const metadata: GGUFMetadataEntry[] = []
    const metadataKeys = new Set<string>()
    for (let index = 0n; index < metadataCount; index += 1n) {
      const key = this.readString(65_535n)
      if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(key) || metadataKeys.has(key)) {
        throw new InvalidGGUF('GGUF metadata key 无效或重复。')
      }
      metadataKeys.add(key)
      const typeCode = this.cursor.readUint32()
      const value = this.readValue(typeCode, 0, true)
      metadata.push({ key, type: metadataTypeName(typeCode), ...value })
    }

    const alignment = metadata.find(entry => entry.key === 'general.alignment')?.unsignedValue ?? 32n
    if (alignment <= 0n || alignment % 8n !== 0n) throw new InvalidGGUF('GGUF general.alignment 无效。')

    const tensors: GGUFTensor[] = []
    const tensorNames = new Set<string>()
    let parameterCount = 0n
    for (let index = 0n; index < tensorCount; index += 1n) {
      const name = this.readString(64n)
      if (name === '' || tensorNames.has(name)) throw new InvalidGGUF('GGUF tensor 名称无效或重复。')
      tensorNames.add(name)
      const dimensions = this.cursor.readUint32()
      if (dimensions > maximumDimensions) throw new InvalidGGUF(`GGUF tensor ${name} 的维数超过安全上限。`)
      const shape: bigint[] = []
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        shape.push(this.version === 1 ? BigInt(this.cursor.readUint32()) : this.cursor.readUint64())
      }
      const typeCode = this.cursor.readUint32()
      const offset = this.cursor.readUint64()
      if (offset % alignment !== 0n) throw new InvalidGGUF(`GGUF tensor ${name} 的 offset 未按 alignment 对齐。`)
      const parameters = checkedProduct(shape, `tensor ${name} shape`)
      parameterCount = checkedAdd(parameterCount, parameters, '参数总数')
      tensors.push({ name, type: tensorTypeName(typeCode), shape, parameters, offset })
    }

    const tensorDataOffset = alignedOffset(this.cursor.offset, alignment)
    tensors.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    return { version: this.version, endianness: this.endianness, metadata, tensors, parameterCount, tensorDataOffset, alignment }
  }

  private readCount(): bigint {
    return this.version === 1 ? BigInt(this.cursor.readUint32()) : this.cursor.readUint64()
  }

  private readString(maximum = maximumStringLength): string {
    const length = this.readCount()
    if (length > maximum || length > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidGGUF('GGUF 字符串超过安全上限。')
    const value = this.cursor.readBytes(Number(length))
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value)
    } catch {
      throw new InvalidGGUF('GGUF 字符串不是有效 UTF-8。')
    }
  }

  private readValue(typeCode: number, depth: number, capture: boolean): ParsedValue {
    if (this.version === 1 && typeCode > 9) throw new InvalidGGUF(`GGUF v1 包含不支持的 metadata 类型 ${typeCode}。`)
    const hidden = (): ParsedValue => ({ display: '', stringValue: null, unsignedValue: null })
    switch (typeCode) {
      case 0: {
        const value = this.cursor.readUint8()
        return capture ? unsigned(value) : hidden()
      }
      case 1: {
        const value = BigInt.asIntN(8, BigInt(this.cursor.readUint8()))
        return capture ? signed(value) : hidden()
      }
      case 2: {
        const value = this.cursor.readUint16()
        return capture ? unsigned(value) : hidden()
      }
      case 3: {
        const value = BigInt.asIntN(16, BigInt(this.cursor.readUint16()))
        return capture ? signed(value) : hidden()
      }
      case 4: {
        const value = this.cursor.readUint32()
        return capture ? unsigned(value) : hidden()
      }
      case 5: {
        const value = BigInt.asIntN(32, BigInt(this.cursor.readUint32()))
        return capture ? signed(value) : hidden()
      }
      case 6: {
        const value = this.cursor.readFloat32()
        return capture ? signed(value) : hidden()
      }
      case 7: {
        const value = this.cursor.readUint8()
        if (value !== 0 && value !== 1) throw new InvalidGGUF('GGUF bool 值必须为 0 或 1。')
        return capture ? signed(value === 1) : hidden()
      }
      case 8: {
        const value = this.readString()
        return capture ? { display: value, stringValue: value, unsignedValue: null } : hidden()
      }
      case 9: {
        if (depth >= maximumArrayDepth) throw new InvalidGGUF('GGUF metadata array 嵌套超过安全上限。')
        const elementType = this.cursor.readUint32()
        if (elementType > 12) throw new InvalidGGUF('GGUF metadata array 类型无效。')
        const count = this.readCount()
        this.arrayElementsRead += count
        if (this.arrayElementsRead > maximumArrayElements) {
          throw new InvalidGGUF('GGUF metadata array 元素数量超过安全上限。')
        }
        const preview: string[] = []
        for (let index = 0n; index < count; index += 1n) {
          const shouldCapture = capture && index < 16n
          const value = this.readValue(elementType, depth + 1, shouldCapture)
          if (shouldCapture) preview.push(value.display)
        }
        if (!capture) return hidden()
        return {
          display: `[${preview.join(', ')}${count > 16n ? ', …' : ''}] · ${count.toLocaleString('zh-CN')} 项`,
          stringValue: null,
          unsignedValue: null,
        }
      }
      case 10: {
        const value = this.cursor.readUint64()
        return capture ? unsigned(value) : hidden()
      }
      case 11: {
        const value = BigInt.asIntN(64, this.cursor.readUint64())
        return capture ? signed(value) : hidden()
      }
      case 12: {
        const value = this.cursor.readFloat64()
        return capture ? signed(value) : hidden()
      }
      default:
        throw new InvalidGGUF(`GGUF metadata 类型 ${typeCode} 无效。`)
    }
  }
}

class Cursor {
  private readonly bytes: Uint8Array
  public offset: number
  private readonly endianness: 'little' | 'big'

  constructor(
    bytes: Uint8Array,
    offset: number,
    endianness: 'little' | 'big',
  ) {
    this.bytes = bytes
    this.offset = offset
    this.endianness = endianness
  }

  readUint8(): number {
    this.ensure(1)
    return this.bytes[this.offset++]
  }

  readUint16(): number {
    return Number(this.readInteger(2))
  }

  readUint32(): number {
    return Number(this.readInteger(4))
  }

  readUint64(): bigint {
    return this.readInteger(8)
  }

  readFloat32(): number {
    this.ensure(4)
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
      .getFloat32(this.offset, this.endianness === 'little')
    this.offset += 4
    return value
  }

  readFloat64(): number {
    this.ensure(8)
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
      .getFloat64(this.offset, this.endianness === 'little')
    this.offset += 8
    return value
  }

  readBytes(count: number): Uint8Array {
    this.ensure(count)
    const value = this.bytes.slice(this.offset, this.offset + count)
    this.offset += count
    return value
  }

  private readInteger(count: number): bigint {
    this.ensure(count)
    let value = 0n
    for (let index = 0; index < count; index += 1) {
      const byteIndex = this.endianness === 'little' ? this.offset + count - index - 1 : this.offset + index
      value = (value << 8n) | BigInt(this.bytes[byteIndex])
    }
    this.offset += count
    return value
  }

  private ensure(count: number) {
    if (count < 0 || this.offset + count > this.bytes.byteLength) throw new NeedsMoreData()
  }
}

function uint32At(bytes: Uint8Array, offset: number, little: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little)
}

function unsigned(value: number | bigint): ParsedValue {
  const parsed = BigInt(value)
  return { display: parsed.toString(), stringValue: null, unsignedValue: parsed }
}

function signed(value: string | number | bigint | boolean): ParsedValue {
  return { display: String(value), stringValue: null, unsignedValue: null }
}

function checkedProduct(values: bigint[], context: string): bigint {
  let result = 1n
  for (const value of values) {
    result *= value
    if (result > maximumUInt64) throw new InvalidGGUF(`GGUF ${context} 溢出。`)
  }
  return result
}

function checkedAdd(left: bigint, right: bigint, context: string): bigint {
  const result = left + right
  if (result > maximumUInt64) throw new InvalidGGUF(`GGUF ${context} 溢出。`)
  return result
}

function alignedOffset(offset: number, alignment: bigint): number {
  const value = BigInt(offset)
  const result = value + (alignment - value % alignment) % alignment
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidGGUF('GGUF tensor data offset 溢出。')
  return Number(result)
}

function metadataTypeName(code: number): string {
  return ['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'bool', 'string', 'array', 'uint64', 'int64', 'float64'][code]
    ?? `type ${code}`
}

function tensorTypeName(code: number): string {
  return ({
    0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 4: 'Q4_2', 5: 'Q4_3',
    6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1', 10: 'Q2_K', 11: 'Q3_K',
    12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K', 16: 'IQ2_XXS', 17: 'IQ2_XS',
    18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS',
    24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64', 29: 'IQ1_M', 30: 'BF16',
    34: 'TQ1_0', 35: 'TQ2_0', 39: 'MXFP4',
  } as Record<number, string>)[code] ?? `TYPE_${code}`
}
