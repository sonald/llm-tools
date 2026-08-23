import { translate as t } from '../i18n.ts'

export type ImatrixEntry = {
  name: string
  callCount: number
  valueCount: number
  minimum: number
  maximum: number
  mean: number
}

export type ImatrixSummary = {
  entries: ImatrixEntry[]
  chunkCount: number | null
  dataset: string | null
  byteCount: number
}

export function inspectImatrix(data: ArrayBuffer): ImatrixSummary {
  if (data.byteLength > 32 * 1024 * 1024) throw new Error(t('imatrixFileTooLarge'))
  const cursor = new Cursor(data)
  const entryCount = cursor.int32()
  if (entryCount < 1 || entryCount > 100_000) throw new Error(t('imatrixEntryCountInvalid'))
  const entries: ImatrixEntry[] = []
  const names = new Set<string>()
  let totalValueCount = 0
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = cursor.int32()
    if (nameLength < 1 || nameLength > 1024) throw new Error(t('imatrixTensorNameInvalid'))
    const name = cursor.text(nameLength)
    if (names.has(name)) throw new Error(t('imatrixTensorNameInvalid'))
    names.add(name)
    const callCount = cursor.int32()
    const valueCount = cursor.int32()
    if (callCount < 0 || valueCount < 1 || valueCount > 10_000_000 - totalValueCount) {
      throw new Error(t('imatrixCountsInvalid', { name }))
    }
    totalValueCount += valueCount
    let minimum = Number.POSITIVE_INFINITY
    let maximum = Number.NEGATIVE_INFINITY
    let sum = 0
    for (let valueIndex = 0; valueIndex < valueCount; valueIndex += 1) {
      const value = cursor.float32()
      if (!Number.isFinite(value)) throw new Error(t('imatrixNonFiniteValues', { name }))
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
      sum += value
    }
    entries.push({ name, callCount, valueCount, minimum, maximum, mean: sum / valueCount })
  }

  let chunkCount: number | null = null
  let dataset: string | null = null
  if (cursor.remaining > 0) {
    chunkCount = cursor.int32()
    if (chunkCount < 0) throw new Error(t('imatrixChunkCountInvalid'))
    if (cursor.remaining > 0) {
      const length = cursor.int32()
      if (length < 0 || length > cursor.remaining) throw new Error(t('imatrixDatasetLengthInvalid'))
      dataset = cursor.text(length) || null
      if (cursor.remaining !== 0) throw new Error(t('imatrixDatasetInvalid'))
    }
  }
  return {
    entries: entries.toSorted((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true })),
    chunkCount,
    dataset,
    byteCount: data.byteLength,
  }
}

class Cursor {
  readonly #view: DataView
  #offset = 0

  constructor(data: ArrayBuffer) {
    this.#view = new DataView(data)
  }

  get remaining(): number { return this.#view.byteLength - this.#offset }

  int32(): number {
    this.#require(4)
    const value = this.#view.getInt32(this.#offset, true)
    this.#offset += 4
    return value
  }

  float32(): number {
    this.#require(4)
    const value = this.#view.getFloat32(this.#offset, true)
    this.#offset += 4
    return value
  }

  text(length: number): string {
    this.#require(length)
    const bytes = new Uint8Array(this.#view.buffer, this.#view.byteOffset + this.#offset, length)
    this.#offset += length
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(t('imatrixUtf8Invalid'))
    }
  }

  #require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new Error(t('imatrixFileTruncated'))
    }
  }
}
