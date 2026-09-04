import { translate as t } from './i18n.ts'

interface SentencePieceModule {
  DecodeIds(ids: number[]): unknown
  EncodeAsIds(input: string): unknown
  EncodeAsPieces(input: string): unknown
  IdToPiece(id: number): unknown
  LoadFromSerializedProto(model: Uint8Array): void
  lastError(): string
  release(): void
  status(): number
}

type SentencePieceFactory = () => Promise<SentencePieceModule>

async function createSentencePieceModule(): Promise<SentencePieceModule> {
  return ((await import(
    // @ts-expect-error the generated Emscripten module has no checked-in declaration
    './vendor/sentencepiece/sentencepiece-wasm.mjs'
  )).default as SentencePieceFactory)()
}

function requireModel(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) {
    throw new TypeError(t('sentencepieceModelBytesRequired'))
  }
  return value
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(t('sentencepieceInputRequired'))
  return value
}

function requireId(value: number): number {
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new TypeError(t('sentencepieceIdRange'))
  }
  return value
}

function requireIds(value: number[]): number[] {
  if (!Array.isArray(value)) throw new TypeError(t('sentencepieceIdsRequired'))
  return value.map(requireId)
}

function requireIntegerArray(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.some(id => typeof id !== 'number' || !Number.isSafeInteger(id))
  ) {
    throw new TypeError(t('sentencepieceReturnedIdsInvalid'))
  }
  return value
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(piece => typeof piece !== 'string')) {
    throw new TypeError(t('sentencepieceReturnedPiecesInvalid'))
  }
  return value
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(t('sentencepieceReturnedTextInvalid'))
  return value as string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const tiktokenRankLine = /^[A-Za-z0-9+/]+=* [0-9]+$/

export function looksLikeTiktokenRanks(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false
  const sampleLength = Math.min(bytes.byteLength, 256)
  const sample = bytes.subarray(0, sampleLength)
  for (let index = 0; index < sample.length; index++) {
    const value = sample[index]
    if (value === 0 || value > 127) return false
  }
  const text = String.fromCharCode(...sample)
  const lines = text.split('\n')
  if (sampleLength < bytes.byteLength && !text.endsWith('\n')) lines.pop()
  const candidates = lines.filter(line => line.length > 0)
  return candidates.length > 0 && candidates.every(line => tiktokenRankLine.test(line))
}

export class SentencePieceWasm {
  #module: SentencePieceModule | null

  private constructor(module: SentencePieceModule) {
    this.#module = module
  }

  static async load(model: Uint8Array): Promise<SentencePieceWasm> {
    const validatedModel = requireModel(model)
    if (looksLikeTiktokenRanks(validatedModel)) {
      throw new Error(t('sentencepieceTiktokenRanks'))
    }
    const module = await createSentencePieceModule()
    try {
      module.LoadFromSerializedProto(validatedModel)
    } catch (error) {
      const detail = module.status() !== 0 ? module.lastError() : errorMessage(error)
      module.release()
      throw new Error(t('sentencepieceInvalidModel', { reason: detail }))
    }
    if (module.status() !== 0) {
      const detail = module.lastError()
      module.release()
      throw new Error(t('sentencepieceInvalidModel', { reason: detail }))
    }
    return new SentencePieceWasm(module)
  }

  encodeAsIds(input: unknown): number[] {
    return this.#call(module => requireIntegerArray(module.EncodeAsIds(requireText(input))))
  }

  encodeAsPieces(input: unknown): string[] {
    return this.#call(module => requireStringArray(module.EncodeAsPieces(requireText(input))))
  }

  decodeIds(ids: number[]): string {
    const safeIds = requireIds(ids)
    return this.#call(module => requireString(module.DecodeIds(safeIds)))
  }

  idToPiece(id: number): string {
    const safeId = requireId(id)
    return this.#call(module => requireString(module.IdToPiece(safeId)))
  }

  dispose(): void {
    this.#module?.release()
    this.#module = null
  }

  #call<T>(operation: (module: SentencePieceModule) => T): T {
    const module = this.#module
    if (!module) throw new Error(t('sentencepieceDisposed'))
    try {
      const result = operation(module)
      if (module.status() !== 0) throw new Error(module.lastError())
      return result
    } catch (error) {
      throw new Error(
        t('sentencepieceOperationFailed', {
          reason: module.status() !== 0 ? module.lastError() : errorMessage(error),
        }),
      )
    }
  }
}
