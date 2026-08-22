import { readWholeFile, type RepositoryFile, type RepositorySnapshot } from './core/huggingface.ts'
import {
  parseTokenIds,
  tokenizerBundleBytes,
  type TokenFlag,
  type Tokenization,
  type TokenizerStructure,
} from './core/tokenizer.ts'

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }
type Request =
  | { id: number; type: 'load'; tokenizerData: ArrayBuffer; configData: ArrayBuffer | null }
  | { id: number; type: 'tokenize'; text: string }
  | { id: number; type: 'decode-token-ids'; ids: number[]; originalInput: string }
  | { id: number; type: 'render-template'; source: string; context: Record<string, unknown> }

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
let loadedIdentity = ''
let loadedStructure: TokenizerStructure | null = null
let loading: { identity: string; promise: Promise<TokenizerStructure> } | null = null
let generation = 0

export async function tokenize(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  text: string,
  signal?: AbortSignal,
): Promise<Tokenization> {
  if (text.length === 0) return {
    direction: 'encode', input: text, ids: [], pieces: [], decoded: '', segments: [], mapping: 'Exact', flags: [],
  }
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error('输入超过 64 KiB 上限。')
  await ensureLoaded(snapshot, tokenizerFile, configFile, signal)
  return validateTokenization(await request({ id: ++nextId, type: 'tokenize', text }))
}

export async function decodeTokenIds(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  input: string,
  signal?: AbortSignal,
): Promise<Tokenization> {
  const ids = parseTokenIds(input)
  await ensureLoaded(snapshot, tokenizerFile, configFile, signal)
  return validateTokenization(await request({ id: ++nextId, type: 'decode-token-ids', ids, originalInput: input }))
}

export async function inspectTokenizer(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  signal?: AbortSignal,
): Promise<TokenizerStructure> {
  return await ensureLoaded(snapshot, tokenizerFile, configFile, signal)
}

export async function renderTemplate(source: string, context: Record<string, unknown>): Promise<string> {
  if (new TextEncoder().encode(source).byteLength > 64 * 1024) throw new Error('模板源码超过 64 KiB 上限。')
  const serialized = JSON.stringify(context)
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1024) throw new Error('模板输入超过 64 KiB 上限。')
  return await request({ id: ++nextId, type: 'render-template', source, context }) as string
}

async function ensureLoaded(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  signal?: AbortSignal,
): Promise<TokenizerStructure> {
  tokenizerBundleBytes(tokenizerFile, configFile)
  if (tokenizerFile.size === null || configFile?.size === null) throw new Error('Tokenizer 资源大小无效。')
  const tokenizerSize = tokenizerFile.size
  const configSize = configFile?.size ?? 0
  const identity = tokenizerIdentity(snapshot, tokenizerFile, configFile)
  if (loadedIdentity === identity && loadedStructure !== null) return loadedStructure
  if (loading?.identity === identity) return await loading.promise
  const activeGeneration = generation
  const promise = (async () => {
    const [tokenizerData, configData] = await Promise.all([
      readWholeFile(snapshot, tokenizerFile, signal, tokenizerSize),
      configFile === undefined ? Promise.resolve(null) : readWholeFile(snapshot, configFile, signal, configSize),
    ])
    if (signal?.aborted || generation !== activeGeneration) throw new DOMException('Tokenizer 请求已取消。', 'AbortError')
    const transfer = configData === null ? [tokenizerData] : [tokenizerData, configData]
    const structure = await request({ id: ++nextId, type: 'load', tokenizerData, configData }, transfer) as TokenizerStructure
    if (signal?.aborted || generation !== activeGeneration) throw new DOMException('Tokenizer 请求已取消。', 'AbortError')
    loadedIdentity = identity
    loadedStructure = structure
    return structure
  })()
  loading = { identity, promise }
  try {
    return await promise
  } finally {
    if (loading?.promise === promise) loading = null
  }
}

export function cancelTokenizerRequests(): void {
  generation += 1
  worker?.terminate()
  worker = null
  loadedIdentity = ''
  loadedStructure = null
  loading = null
  for (const promise of pending.values()) promise.reject(new DOMException('Tokenizer 请求已取消。', 'AbortError'))
  pending.clear()
}

function tokenizerIdentity(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
): string {
  const source = snapshot.source === 'huggingface'
    ? `${snapshot.modelId}@${snapshot.revision}`
    : snapshot.selectionId
  return `${source}/${tokenizerFile.path}+${configFile?.path ?? 'no-config'}`
}

function request(message: Request, transfer: Transferable[] = []): Promise<unknown> {
  const activeWorker = getWorker()
  return new Promise((resolve, reject) => {
    pending.set(message.id, { resolve, reject })
    activeWorker.postMessage(message, transfer)
  })
}


function getWorker(): Worker {
  if (worker !== null) return worker
  worker = new Worker(new URL('./tokenizer.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data
    const promise = pending.get(reply.id)
    if (promise === undefined) return
    pending.delete(reply.id)
    if (reply.ok) promise.resolve(reply.value)
    else promise.reject(new Error(reply.error))
  }
  worker.onerror = event => {
    for (const promise of pending.values()) promise.reject(new Error(event.message || 'Tokenizer Worker 失败。'))
    pending.clear()
    worker = null
    loadedIdentity = ''
    loadedStructure = null
    loading = null
  }
  return worker
}

function validateTokenization(value: unknown): Tokenization {
  const isStringOrNull = (item: unknown) => item === null || typeof item === 'string'
  const isFlag = (item: unknown): item is TokenFlag => isUnknownRecord(item)
    && typeof item.isSpecial === 'boolean' && (item.specialName === null || typeof item.specialName === 'string')
  if (!isUnknownRecord(value)
    || (value.direction !== 'encode' && value.direction !== 'decode')
    || typeof value.input !== 'string'
    || typeof value.decoded !== 'string'
    || !Array.isArray(value.ids) || !value.ids.every(isSafeNonNegativeInteger)
    || !Array.isArray(value.pieces) || !value.pieces.every(isStringOrNull)
    || !Array.isArray(value.segments)
    || (value.mapping !== 'Exact' && value.mapping !== 'Decoded only')
    || (value.direction === 'decode' && value.mapping !== 'Decoded only')
    || !Array.isArray(value.flags) || !value.flags.every(isFlag)) {
    throw new Error('Tokenizer Worker 返回的结果结构无效。')
  }
  if (value.pieces.length !== value.ids.length || value.flags.length !== value.ids.length) {
    throw new Error('Tokenizer Worker 返回的 ID、piece 与 flag 数量不一致。')
  }
  const ids = value.ids as number[]
  for (const segment of value.segments) {
    if (!isUnknownRecord(segment)
      || !isSafeNonNegativeInteger(segment.start)
      || !isSafeNonNegativeInteger(segment.end)
      || segment.start >= segment.end
      || segment.end > value.ids.length
      || !Array.isArray(segment.ids)
      || !segment.ids.every(isSafeNonNegativeInteger)
      || typeof segment.text !== 'string'
      || segment.ids.length !== segment.end - segment.start
      || segment.ids.some((id, index) => id !== ids[Number(segment.start) + index])) {
      throw new Error('Tokenizer Worker 返回的片段结构无效。')
    }
  }
  return value as Tokenization
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
