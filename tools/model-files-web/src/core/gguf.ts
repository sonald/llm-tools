import { formatNumber, translate as t } from '../i18n.ts'
import { formatBytes, readExactRange, type RepositoryFile, type RepositorySnapshot } from './huggingface.ts'
import type { InspectionField, TensorSummary } from './inspectors.ts'

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

export function inspectGGUF(data: ArrayBufferLike | Uint8Array): GGUFInspection {
  try {
    return { kind: 'complete', overview: new Parser(data).parse() }
  } catch (error) {
    if (error instanceof NeedsMoreData) return { kind: 'needs-more-data' }
    if (error instanceof InvalidGGUF) return { kind: 'invalid', message: error.message }
    return { kind: 'invalid', message: t('ggufParseFailed', { reason: error instanceof Error ? error.message : String(error) }) }
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

  constructor(data: ArrayBufferLike | Uint8Array) {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    if (this.bytes.byteLength < 4) throw new NeedsMoreData()
    if (new TextDecoder().decode(this.bytes.slice(0, 4)) !== 'GGUF') throw new InvalidGGUF(t('ggufMagicInvalid'))
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
      throw new InvalidGGUF(t('ggufVersionUnsupported'))
    }
    this.cursor = new Cursor(this.bytes, 8, this.endianness)
  }

  parse(): GGUFOverview {
    const tensorCount = this.readCount()
    const metadataCount = this.readCount()
    if (tensorCount > maximumTensorCount) throw new InvalidGGUF(t('ggufTensorCountExceeded'))
    if (metadataCount > maximumMetadataCount) throw new InvalidGGUF(t('ggufMetadataCountExceeded'))

    const metadata: GGUFMetadataEntry[] = []
    const metadataKeys = new Set<string>()
    for (let index = 0n; index < metadataCount; index += 1n) {
      const key = this.readString(65_535n)
      if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(key) || metadataKeys.has(key)) {
        throw new InvalidGGUF(t('ggufMetadataKeyInvalidOrDuplicate'))
      }
      metadataKeys.add(key)
      const typeCode = this.cursor.readUint32()
      const value = this.readValue(typeCode, 0, true)
      metadata.push({ key, type: metadataTypeName(typeCode), ...value })
    }

    const alignment = metadata.find(entry => entry.key === 'general.alignment')?.unsignedValue ?? 32n
    if (alignment <= 0n || alignment % 8n !== 0n) throw new InvalidGGUF(t('ggufAlignmentInvalid'))

    const tensors: GGUFTensor[] = []
    const tensorNames = new Set<string>()
    let parameterCount = 0n
    for (let index = 0n; index < tensorCount; index += 1n) {
      const name = this.readString(64n)
      if (name === '' || tensorNames.has(name)) throw new InvalidGGUF(t('ggufTensorNameInvalidOrDuplicate'))
      tensorNames.add(name)
      const dimensions = this.cursor.readUint32()
      if (dimensions > maximumDimensions) throw new InvalidGGUF(t('ggufTensorDimensionCountExceeded', { name }))
      const shape: bigint[] = []
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        shape.push(this.version === 1 ? BigInt(this.cursor.readUint32()) : this.cursor.readUint64())
      }
      const typeCode = this.cursor.readUint32()
      const offset = this.cursor.readUint64()
      if (offset % alignment !== 0n) throw new InvalidGGUF(t('ggufTensorOffsetMisaligned', { name }))
      const parameters = checkedProduct(shape, t('ggufTensorShapeContext', { name }))
      parameterCount = checkedAdd(parameterCount, parameters, t('ggufParameterTotalOverflowContext'))
      tensors.push({ name, type: tensorTypeName(typeCode), shape, parameters, offset })
    }

    const tensorDataOffset = alignedOffset(this.cursor.offset, alignment)
    tensors.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    return { version: this.version, endianness: this.endianness, metadata, tensors, parameterCount, tensorDataOffset, alignment }
  }

  private readCount(): bigint {
    return this.version === 1 ? BigInt(this.cursor.readUint32()) : this.cursor.readUint64()
  }

  private readString(maximum = maximumStringLength, capture = true): string {
    const length = this.readCount()
    if (length > maximum || length > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidGGUF(t('ggufStringLimitExceeded'))
    // Native skips uncaptured strings (array elements past the preview) without decoding them.
    if (!capture) {
      this.cursor.skip(Number(length))
      return ''
    }
    const value = this.cursor.readBytes(Number(length))
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value)
    } catch {
      throw new InvalidGGUF(t('ggufStringUtf8Invalid'))
    }
  }

  private readValue(typeCode: number, depth: number, capture: boolean): ParsedValue {
    if (this.version === 1 && typeCode > 9) throw new InvalidGGUF(t('ggufV1MetadataTypeUnsupported', { typeCode }))
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
        return capture ? signed(swiftFloatDescription(value, 32)) : hidden()
      }
      case 7: {
        const value = this.cursor.readUint8()
        if (value !== 0 && value !== 1) throw new InvalidGGUF(t('ggufBoolValueInvalid'))
        return capture ? signed(value === 1) : hidden()
      }
      case 8: {
        const value = this.readString(maximumStringLength, capture)
        return capture ? { display: value, stringValue: value, unsignedValue: null } : hidden()
      }
      case 9: {
        if (depth >= maximumArrayDepth) throw new InvalidGGUF(t('ggufArrayDepthExceeded'))
        const elementType = this.cursor.readUint32()
        if (elementType > 12) throw new InvalidGGUF(t('ggufArrayElementTypeInvalid'))
        const count = this.readCount()
        this.arrayElementsRead += count
        if (this.arrayElementsRead > maximumArrayElements) {
          throw new InvalidGGUF(t('ggufArrayElementCountExceeded'))
        }
        const preview: string[] = []
        for (let index = 0n; index < count; index += 1n) {
          const shouldCapture = capture && index < 16n
          const value = this.readValue(elementType, depth + 1, shouldCapture)
          if (shouldCapture) preview.push(value.display)
        }
        if (!capture) return hidden()
        return {
          display: t('ggufArrayPreviewDisplay', {
            preview: `${preview.join(', ')}${count > 16n ? ', …' : ''}`,
            count: formatNumber(count),
          }),
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
        return capture ? signed(swiftFloatDescription(value, 64)) : hidden()
      }
      default:
        throw new InvalidGGUF(t('ggufMetadataTypeInvalid', { typeCode }))
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

  skip(count: number) {
    this.ensure(count)
    this.offset += count
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
    if (result > maximumUInt64) throw new InvalidGGUF(t('ggufShapeOverflow', { context }))
  }
  return result
}

function checkedAdd(left: bigint, right: bigint, context: string): bigint {
  const result = left + right
  if (result > maximumUInt64) throw new InvalidGGUF(t('ggufShapeOverflow', { context }))
  return result
}

function alignedOffset(offset: number, alignment: bigint): number {
  const value = BigInt(offset)
  const result = value + (alignment - value % alignment) % alignment
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidGGUF(t('ggufTensorDataOffsetOverflow'))
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

// Native `String(Float)` / `String(Double)`: shortest round-trip digits; exponent form below 1e-4 or above 2^24 / 2^53.
export function swiftFloatDescription(value: number, bits: 32 | 64): string {
  if (Number.isNaN(value)) return 'nan'
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf'
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
  let scientific = value.toExponential()
  if (bits === 32) {
    for (let digits = 0; digits < 9; digits += 1) {
      scientific = value.toExponential(digits)
      if (Math.fround(Number(scientific)) === value) break
    }
  }
  const [mantissa, exponentText] = scientific.split('e')
  const exponent = Number(exponentText)
  if (exponent < -4 || Math.abs(value) > 2 ** (bits === 32 ? 24 : 53)) {
    return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`
  }
  const sign = value < 0 ? '-' : ''
  const digits = mantissa.replace(/^-/, '').replace('.', '')
  const point = exponent + 1
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

// Native GGUFOverview computed properties.
export function ggufEntry(overview: GGUFOverview, key: string): GGUFMetadataEntry | undefined {
  return overview.metadata.find(entry => entry.key === key)
}

export function ggufArchitecture(overview: GGUFOverview): string | null {
  return ggufEntry(overview, 'general.architecture')?.stringValue ?? null
}

export function ggufModelName(overview: GGUFOverview): string | null {
  return ggufEntry(overview, 'general.name')?.stringValue ?? null
}

export function ggufIsIMatrix(overview: GGUFOverview): boolean {
  return ggufEntry(overview, 'general.type')?.stringValue === 'imatrix'
}

export function ggufContextLength(overview: GGUFOverview): bigint | null {
  const architecture = ggufArchitecture(overview)
  const own = architecture === null ? null : ggufEntry(overview, `${architecture}.context_length`)?.unsignedValue ?? null
  if (own !== null) return own
  return overview.metadata.find(entry => entry.key.endsWith('.context_length') && entry.unsignedValue !== null)?.unsignedValue ?? null
}

export function ggufIMatrixEntryCount(overview: GGUFOverview): number | null {
  if (!ggufIsIMatrix(overview)) return null
  const stems = (suffix: string) => new Set(overview.tensors.filter(tensor => tensor.name.endsWith(suffix))
    .map(tensor => tensor.name.slice(0, -suffix.length)))
  const counts = stems('.counts')
  return [...stems('.in_sum2')].filter(stem => counts.has(stem)).length
}

// Most tensors wins; a tie goes to the smaller dtype name.
export function ggufDominantDataType(overview: GGUFOverview): string | null {
  const counts = new Map<string, number>()
  for (const tensor of overview.tensors) counts.set(tensor.type, (counts.get(tensor.type) ?? 0) + 1)
  let best: [string, number] | null = null
  for (const entry of counts) {
    if (best === null || entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0])) best = entry
  }
  return best?.[0] ?? null
}

export function ggufTensorSummaries(overview: GGUFOverview): TensorSummary[] {
  return overview.tensors.map(tensor => ({
    name: tensor.name, dtype: tensor.type, shape: tensor.shape, parameters: tensor.parameters, bytes: null, offset: tensor.offset,
  }))
}

// Native InspectionWorkspaceView.ggufFacts, insert positions included.
export function ggufFacts(overview: GGUFOverview, bytesRead: number): InspectionField[] {
  const facts: InspectionField[] = [
    { key: t('wtTensorCount'), type: 'count', value: formatNumber(overview.tensors.length), origin: 'derived' },
    { key: t('wtParameterTotal'), type: 'count', value: formatNumber(overview.parameterCount), origin: 'derived' },
    { key: t('wtMetadataCount'), type: 'count', value: formatNumber(overview.metadata.length), origin: 'derived' },
    { key: t('wtDataAlignment'), type: 'bytes', value: formatBytes(Number(overview.alignment)), origin: 'embedded' },
    { key: t('wtTensorDataOffset'), type: 'offset', value: formatNumber(overview.tensorDataOffset), origin: 'derived' },
    { key: t('wtPrefixRead'), type: 'bytes', value: formatBytes(bytesRead), origin: 'runtime' },
  ]
  const append = (key: string, title: string) => {
    const entry = ggufEntry(overview, key)
    if (entry !== undefined) facts.push({ key: title, type: entry.type, value: entry.display, origin: 'embedded' })
  }
  if (ggufIsIMatrix(overview)) {
    const count = ggufIMatrixEntryCount(overview)
    if (count !== null) facts.unshift({ key: t('wtImatrixEntries'), type: 'count', value: formatNumber(count), origin: 'derived' })
    append('imatrix.datasets', t('wtDataset'))
    append('imatrix.chunk_count', t('wtChunkCount'))
    append('imatrix.chunk_size', t('wtChunkSize'))
  } else {
    const architecture = ggufArchitecture(overview)
    if (architecture !== null) facts.unshift({ key: t('wtArchitecture'), type: 'string', value: architecture, origin: 'embedded' })
    const dataType = ggufDominantDataType(overview)
    if (dataType !== null) facts.splice(Math.min(1, facts.length), 0, { key: t('wtPrimaryDataType'), type: 'dtype', value: dataType, origin: 'derived' })
    const contextLength = ggufContextLength(overview)
    if (contextLength !== null) {
      facts.splice(Math.min(2, facts.length), 0, { key: t('wtContextLength'), type: 'count', value: formatNumber(contextLength), origin: 'embedded' })
    }
    append('quantize.imatrix.file', t('wtQuantizeImatrix'))
    append('quantize.imatrix.dataset', t('wtImatrixDataset'))
    append('quantize.imatrix.entries_count', t('wtImatrixEntries'))
    append('quantize.imatrix.chunks_count', 'Imatrix Chunks')
  }
  return facts
}

export const ggufChunkSize = 1024 * 1024
export const ggufReadBudget = 32 * 1024 * 1024

// Native RepositoryService.loadGGUF: sequential 1 MiB ranges until the directory parses, at most 32 MiB.
// The last range may run past the tensor data start; native accepts that small over-read (ruling D-1).
export async function readGGUFDirectory(
  size: number | null,
  readRange: (start: number, end: number) => Promise<ArrayBuffer>,
  chunkSize = ggufChunkSize,
  budgetLimit = ggufReadBudget,
): Promise<{ overview: GGUFOverview; bytesRead: number }> {
  if (size === null || size <= 0) throw new Error(t('wtGgufMissingSize'))
  const budget = Math.min(size, budgetLimit)
  let data = new Uint8Array(Math.min(budget, chunkSize))
  let length = 0
  for (let start = 0; start < budget;) {
    const end = Math.min(start + chunkSize, budget) - 1
    const chunk = new Uint8Array(await readRange(start, end))
    if (length + chunk.byteLength > data.byteLength) {
      const grown = new Uint8Array(Math.min(budget, Math.max(data.byteLength * 2, length + chunk.byteLength)))
      grown.set(data.subarray(0, length))
      data = grown
    }
    data.set(chunk, length)
    length += chunk.byteLength
    const result = inspectGGUF(data.subarray(0, length))
    if (result.kind === 'complete') return { overview: result.overview, bytesRead: length }
    if (result.kind === 'invalid') throw new Error(t('wtGgufInvalid', { message: result.message }))
    start = end + 1
  }
  if (size <= budget) throw new Error(t('wtGgufInvalid', { message: t('wtGgufEndedEarly') }))
  throw new Error(t('wtGgufTooLarge'))
}

const ggufCache = new WeakMap<RepositorySnapshot, Map<string, { overview: GGUFOverview; bytesRead: number }>>()

// The parsed directory, read once per snapshot and file. The reader uses it; consistency checks (Q-9) can too.
export async function loadGGUF(snapshot: RepositorySnapshot, file: RepositoryFile, signal?: AbortSignal) {
  const cached = ggufCache.get(snapshot)?.get(file.path)
  if (cached !== undefined) return cached
  const result = await readGGUFDirectory(file.size, (start, end) => readExactRange(snapshot, file, start, end, signal))
  const cache = ggufCache.get(snapshot) ?? new Map()
  cache.set(file.path, result)
  ggufCache.set(snapshot, cache)
  return result
}
