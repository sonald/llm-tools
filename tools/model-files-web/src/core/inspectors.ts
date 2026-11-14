import { formatNumber, translate as t } from '../i18n.ts'
import { formatBytes, readExactRange, type RepositoryFile, type RepositorySnapshot } from './huggingface.ts'

// Native TensorDescriptor: SafeTensors fills bytes and offset; GGUF has an offset only.
export type TensorSummary = {
  name: string
  dtype: string
  shape: readonly bigint[]
  parameters: bigint
  bytes: bigint | null
  offset: bigint | null
}

export type SafeTensorsSummary = {
  tensors: TensorSummary[]
  metadata: Record<string, string>
  dtypeCounts: Record<string, number>
  parameterCount: bigint
  dataBytes: bigint
}

// Native InspectionField.Origin.
export type FieldOrigin = 'embedded' | 'derived' | 'repository' | 'runtime'
export type InspectionField = { key: string; type: string; value: string; origin: FieldOrigin }

const maximumSafeTensorsHeader = 25_000_000
const maximumUInt64 = (1n << 64n) - 1n
const maximumInt64 = (1n << 63n) - 1n

// Native RepositoryService.loadSafetensorsHeader: length must be 2…25,000,000 and fit the file.
export function safeTensorsHeaderLength(prefix: ArrayBuffer, fileSize: number | null): number {
  if (prefix.byteLength !== 8) throw new Error(t('wtSafeTensorsHeaderInvalid'))
  const length = new DataView(prefix).getBigUint64(0, true)
  if (length <= 1n) throw new Error(t('wtSafeTensorsHeaderInvalid'))
  if (length > BigInt(maximumSafeTensorsHeader)) throw new Error(t('wtSafeTensorsHeaderTooLarge', { size: formatNumber(length) }))
  if (fileSize !== null && Number(length) + 8 > fileSize) throw new Error(t('wtSafeTensorsHeaderInvalid'))
  return Number(length)
}

export async function readSafeTensors(snapshot: RepositorySnapshot, file: RepositoryFile, signal?: AbortSignal) {
  // ponytail: readExactRange needs the declared size; native would still try a sizeless local read.
  if (file.size === null) throw new Error(t('appSafeTensorsSizeUnavailable'))
  const headerLength = safeTensorsHeaderLength(await readExactRange(snapshot, file, 0, 7, signal), file.size)
  const header = await readExactRange(snapshot, file, 8, 7 + headerLength, signal)
  // Native throws the generic error and drops the inspector's own message.
  try {
    return { summary: inspectSafeTensorsHeader(header), headerBytes: header.byteLength }
  } catch {
    throw new Error(t('wtSafeTensorsHeaderInvalid'))
  }
}

// Native SafetensorsInspector.inspect plus the loader's `{` / JSON check; nothing stricter (W-6).
export function inspectSafeTensorsHeader(header: ArrayBuffer): SafeTensorsSummary {
  if (new Uint8Array(header)[0] !== 0x7b) throw new Error(t('wtSafeTensorsHeaderInvalid'))
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(header)
  const root = JSON.parse(text, exactIntegers as (key: string, value: unknown) => unknown) as unknown
  if (!isRecord(root)) throw new Error(t('safeTensorsRootNotObject'))
  const rawMetadata = root.__metadata__
  const metadata = isStringRecord(rawMetadata) ? rawMetadata : rawMetadata === undefined ? {} : null
  if (metadata === null) throw new Error(t('safeTensorsMetadataNotStringDictionary'))

  const tensors: TensorSummary[] = []
  for (const [name, value] of Object.entries(root)) {
    if (name === '__metadata__') continue
    const shape = isRecord(value) ? int64Array(value.shape) : null
    const offsets = isRecord(value) ? int64Array(value.data_offsets) : null
    if (!isRecord(value) || typeof value.dtype !== 'string' || shape === null || offsets === null || offsets.length !== 2) {
      throw new Error(t('safeTensorsTensorShapeInvalid', { name }))
    }
    let parameters = 1n
    for (const dimension of shape) {
      parameters *= dimension
      if (parameters > maximumUInt64) throw new Error(t('safeTensorsShapeOverflow', { name }))
    }
    const [start, end] = offsets
    if (end < start) throw new Error(t('safeTensorsTensorOffsetsInvalid', { name }))
    tensors.push({ name, dtype: value.dtype, shape, parameters, bytes: end - start, offset: start })
  }
  tensors.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const parameterCount = tensors.reduce((sum, tensor) => sum + tensor.parameters, 0n)
  const dataBytes = tensors.reduce((sum, tensor) => sum + (tensor.bytes ?? 0n), 0n)
  if (parameterCount > maximumUInt64 || dataBytes > maximumUInt64) throw new Error(t('wtSafeTensorsTotalOverflow'))
  const dtypeCounts: Record<string, number> = {}
  for (const tensor of tensors) dtypeCounts[tensor.dtype] = (dtypeCounts[tensor.dtype] ?? 0) + 1
  return { tensors, metadata, dtypeCounts, parameterCount, dataBytes }
}

// Native DetailView InspectionWorkspaceView `.safetensors` facts and metadata rows.
export function safeTensorsFacts(summary: SafeTensorsSummary, headerBytes: number): InspectionField[] {
  return [
    { key: t('wtTensorCount'), type: 'count', value: formatNumber(summary.tensors.length), origin: 'derived' },
    { key: t('wtParameterTotal'), type: 'count', value: formatNumber(summary.parameterCount), origin: 'derived' },
    { key: t('wtWeightDataSize'), type: 'bytes', value: formatBytes(Number(summary.dataBytes > maximumInt64 ? maximumInt64 : summary.dataBytes)), origin: 'derived' },
    { key: t('wtPrimaryDataType'), type: 'dtype', value: dtypeSummary(summary.dtypeCounts), origin: 'derived' },
    { key: t('wtHeaderSize'), type: 'bytes', value: formatBytes(headerBytes), origin: 'runtime' },
  ]
}

export function safeTensorsMetadata(summary: SafeTensorsSummary): InspectionField[] {
  // Native sorts with String `<`, not a locale collation.
  return Object.entries(summary.metadata).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => ({ key, type: 'string', value, origin: 'embedded' }))
}

export function dtypeSummary(counts: Record<string, number>): string {
  return Object.entries(counts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([dtype, count]) => `${dtype} × ${formatNumber(count)}`).join(' · ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

// JSONSerialization keeps integer literals exact; JSON.parse would round them past 2^53. The reviver's source text
// (JSON.parse source access) restores them where the engine provides it.
function exactIntegers(_key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '')
    ? BigInt(context!.source!) : value
}

// Native `as? [NSNumber]` then `int64Value >= 0`: numbers and booleans pass, fractions truncate toward zero,
// doubles past Int64 saturate (1e20 → Int64.max), integer literals past Int64.max wrap negative and fail.
function int64Array(value: unknown): bigint[] | null {
  if (!Array.isArray(value)) return null
  const result: bigint[] = []
  for (const item of value) {
    let integer: bigint
    if (typeof item === 'bigint') {
      integer = item
    } else {
      const number = typeof item === 'boolean' ? Number(item) : item
      if (typeof number !== 'number' || !Number.isFinite(number)) return null
      integer = number >= 2 ** 63 ? maximumInt64 : BigInt(Math.trunc(number))
    }
    if (integer < 0n || integer > maximumInt64) return null
    result.push(integer)
  }
  return result
}
