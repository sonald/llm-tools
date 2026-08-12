import { readWholeFile, type RepositoryFile, type RepositorySnapshot } from './core/huggingface.ts'
import { tokenizerBundleBytes, type Tokenization, type TokenizerStructure } from './core/tokenizer.ts'

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }
type Request =
  | { id: number; type: 'load'; tokenizerData: ArrayBuffer; configData: ArrayBuffer | null }
  | { id: number; type: 'tokenize'; text: string }
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
  if (text.length === 0) return { ids: [], pieces: [], decoded: '', segments: [], mapping: 'Exact' }
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error('输入超过 64 KiB 上限。')
  await ensureLoaded(snapshot, tokenizerFile, configFile, signal)
  return await request({ id: ++nextId, type: 'tokenize', text }) as Tokenization
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
