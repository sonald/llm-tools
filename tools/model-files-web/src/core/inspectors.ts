import { formatNumber, translate as t } from '../i18n.ts'

export type TensorSummary = {
  name: string
  dtype: string
  shape: number[]
  parameters: bigint
  bytes: bigint
  dataStart: bigint
  dataEnd: bigint
}

export type SafeTensorsSummary = {
  tensors: TensorSummary[]
  metadata: Record<string, string>
  parameterCount: bigint
  dataBytes: bigint
}

export type GGUFPrefix = {
  version: number
  endianness: 'little' | 'big'
  tensorCount: bigint
  metadataCount: bigint
}

const maximumSafeTensorsHeader = 25_000_000n
const maximumUInt64 = (1n << 64n) - 1n
const dtypeBits: Record<string, bigint> = {
  BOOL: 8n,
  F4: 4n,
  F6_E2M3: 6n,
  F6_E3M2: 6n,
  U8: 8n,
  I8: 8n,
  F8_E5M2: 8n,
  F8_E4M3: 8n,
  F8_E8M0: 8n,
  F8_E4M3FNUZ: 8n,
  F8_E5M2FNUZ: 8n,
  I16: 16n,
  U16: 16n,
  F16: 16n,
  BF16: 16n,
  I32: 32n,
  U32: 32n,
  F32: 32n,
  C64: 64n,
  F64: 64n,
  I64: 64n,
  U64: 64n,
}

export function safeTensorsHeaderLength(prefix: ArrayBuffer): number {
  if (prefix.byteLength !== 8) throw new Error(t('safeTensorsPrefixLengthInvalid'))
  const length = new DataView(prefix).getBigUint64(0, true)
  if (length < 2n || length > maximumSafeTensorsHeader || length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(t('safeTensorsHeaderLengthInvalid'))
  }
  return Number(length)
}

export function inspectSafeTensorsHeader(header: ArrayBuffer, expectedDataBytes?: bigint): SafeTensorsSummary {
  const root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header)) as unknown
  if (!isRecord(root)) throw new Error(t('safeTensorsRootNotObject'))
  const rawMetadata = root.__metadata__
  const metadata = isStringRecord(rawMetadata) ? rawMetadata : rawMetadata === undefined ? {} : null
  if (metadata === null) throw new Error(t('safeTensorsMetadataNotStringDictionary'))

  const parsed: Array<{ summary: TensorSummary; start: bigint; end: bigint }> = []
  let parameterCount = 0n
  for (const [name, value] of Object.entries(root)) {
    if (name === '__metadata__') continue
    if (!isRecord(value) || typeof value.dtype !== 'string' || !isNumberArray(value.shape)
      || !isNumberArray(value.data_offsets) || value.data_offsets.length !== 2) {
      throw new Error(t('safeTensorsTensorShapeInvalid', { name }))
    }
    const bits = dtypeBits[value.dtype]
    if (bits === undefined) throw new Error(t('safeTensorsDtypeUnsupported', { name, dtype: value.dtype }))
    const [rawStart, rawEnd] = value.data_offsets
    const start = BigInt(rawStart)
    const end = BigInt(rawEnd)
    if (end < start) throw new Error(t('safeTensorsTensorOffsetsInvalid', { name }))
    let parameters = 1n
    for (const dimension of value.shape) {
      parameters *= BigInt(dimension)
      if (parameters > maximumUInt64) throw new Error(t('safeTensorsShapeOverflow', { name }))
    }
    const bitCount = parameters * bits
    if (bitCount > maximumUInt64 * 8n) throw new Error(t('safeTensorsShapeOverflow', { name }))
    if (bitCount % 8n !== 0n) throw new Error(t('safeTensorsByteAlignmentInvalid', { name }))
    const bytes = end - start
    if (bytes !== bitCount / 8n) {
      throw new Error(t('safeTensorsTensorLayoutMismatch', { name }))
    }
    parameterCount += parameters
    if (parameterCount > maximumUInt64) throw new Error(t('safeTensorsParameterTotalOverflow'))
    parsed.push({ summary: {
      name, dtype: value.dtype, shape: value.shape, parameters, bytes, dataStart: start, dataEnd: end,
    }, start, end })
  }
  parsed.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0)
  let dataBytes = 0n
  for (const tensor of parsed) {
    if (tensor.start !== dataBytes) {
      throw new Error(t('safeTensorsTensorOffsetsNonContiguous', { name: tensor.summary.name }))
    }
    dataBytes = tensor.end
  }
  if (expectedDataBytes !== undefined && dataBytes !== expectedDataBytes) {
    throw new Error(t('safeTensorsDataSizeMismatch', {
      actual: formatNumber(dataBytes),
      expected: formatNumber(expectedDataBytes),
    }))
  }
  const tensors = parsed.map(item => item.summary)
  tensors.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return { tensors, metadata, parameterCount, dataBytes }
}

export function inspectGGUFPrefix(prefix: ArrayBuffer): GGUFPrefix {
  if (prefix.byteLength < 16) throw new Error(t('ggufPrefixTooShort'))
  const view = new DataView(prefix)
  const magic = new TextDecoder().decode(prefix.slice(0, 4))
  if (magic !== 'GGUF') throw new Error(t('ggufMagicInvalid'))
  const littleVersion = view.getUint32(4, true)
  const bigVersion = view.getUint32(4, false)
  const endianness = littleVersion >= 1 && littleVersion <= 3 ? 'little' : bigVersion === 3 ? 'big' : null
  if (endianness === null) throw new Error(t('ggufVersionUnsupported'))
  const version = endianness === 'little' ? littleVersion : bigVersion
  const little = endianness === 'little'
  const tensorCount = version === 1 ? BigInt(view.getUint32(8, little)) : view.getBigUint64(8, little)
  const metadataCount = version === 1 ? BigInt(view.getUint32(12, little)) : view.getBigUint64(16, little)
  if (tensorCount > 1_000_000n || metadataCount > 100_000n) throw new Error(t('ggufCountExceeded'))
  return { version, endianness, tensorCount, metadataCount }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => Number.isSafeInteger(item) && item >= 0)
}
