import { readWholeFile, type RepositoryFile, type RepositorySnapshot } from './core/huggingface.ts'
import type { ChatAttributionMessage, ChatTokenOverhead, ChatTokenRole } from './core/tokenAttribution.ts'
import {
  parseTokenIds,
  tokenizerBundleBytes,
  type AddedTokenSummary,
  type TokenFlag,
  type Tokenization,
  type TokenizerVocabularyAnalysis,
  type TokenizerVocabularyEntry,
  type TokenizerStructure,
  type VocabularyDiffScope,
} from './core/tokenizer.ts'
import type { ChatTemplateCatalog, ChatTemplateEntry, ChatTemplateSource } from './core/chatTemplates.ts'
import { currentLocale, translate as t } from './i18n.ts'
import type { TokenizerOperation, TokenizerReply, TokenizerRequest } from './tokenizerProtocol.ts'

type OutgoingTokenizerRequest =
  | { operation: 'load'; tokenizerIdentity: string; tokenizerData: ArrayBuffer; configData: ArrayBuffer | null }
  | { operation: 'inspect-structure'; tokenizerIdentity: ''; tokenizerData: ArrayBuffer }
  | { operation: 'tokenize'; tokenizerIdentity: string; text: string }
  | { operation: 'chat-tokenize'; tokenizerIdentity: string; template: string; context: Record<string, unknown>; attribution: ChatAttributionMessage[] }
  | { operation: 'decode-token-ids'; tokenizerIdentity: string; ids: number[]; originalInput: string }
  | { operation: 'render-template'; tokenizerIdentity: ''; source: string; context: Record<string, unknown> }
  | { operation: 'search-vocabulary'; tokenizerIdentity: string; query: string }
  | { operation: 'prepare-vocabulary-diff'; tokenizerIdentity: string; tokenizerData: ArrayBuffer }
  | { operation: 'search-vocabulary-diff'; tokenizerIdentity: string; scope: VocabularyDiffScope; query: string }

type PendingTokenizerRequest = {
  operation: TokenizerOperation
  requestId: number
  sessionId: string
  generation: number
  tokenizerIdentity: string
  resolve(value: unknown): void
  reject(error: Error): void
  removeAbort(): void
}

type LoadedTokenizer = {
  identity: string
  structure: TokenizerStructure
}

export type TokenizerSession = {
  inspectTokenizer(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    signal?: AbortSignal,
  ): Promise<TokenizerStructure>
  inspectTokenizerData(
    tokenizerData: ArrayBuffer,
    signal?: AbortSignal,
    onStartRequest?: () => void,
  ): Promise<TokenizerStructure>
  tokenize(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    text: string,
    signal?: AbortSignal,
  ): Promise<Tokenization>
  chatTokenize(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    template: string,
    context: Record<string, unknown>,
    attribution: ChatAttributionMessage[],
    signal?: AbortSignal,
  ): Promise<Tokenization>
  decodeTokenIds(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    input: string,
    signal?: AbortSignal,
  ): Promise<Tokenization>
  searchTokenizerVocabulary(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    query: string,
    signal?: AbortSignal,
  ): Promise<TokenizerVocabularyEntry[]>
  prepareVocabularyDiff(
    rightSnapshot: RepositorySnapshot,
    rightTokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    leftSnapshot: RepositorySnapshot,
    leftTokenizerFile: RepositoryFile,
    signal?: AbortSignal,
  ): Promise<{ leftOnlyCount: number; rightOnlyCount: number; sharedCount: number }>
  searchVocabularyDiff(scope: VocabularyDiffScope, query: string, signal?: AbortSignal): Promise<{
    total: number
    pieces: string[]
  }>
  decodeTokenIdArray(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    ids: number[],
    originalInput?: string,
    signal?: AbortSignal,
  ): Promise<Tokenization>
  renderTemplate(source: string, context: Record<string, unknown>): Promise<string>
  cancel(): void
  dispose(): void
}

class ClientTokenizerSession implements TokenizerSession {
  private isDisposed = false
  private worker: Worker | null = null
  private nextId = 0
  private readonly pending = new Map<number, PendingTokenizerRequest>()
  private loadedIdentity = ''
  private loadedStructure: TokenizerStructure | null = null
  private loading: { identity: string; promise: Promise<LoadedTokenizer> } | null = null
  private loadController: AbortController | null = null
  private generation = 0

  async inspectTokenizer(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    signal?: AbortSignal,
): Promise<TokenizerStructure> {
    return (await this.ensureLoaded(snapshot, tokenizerFile, configFile, signal)).structure
  }

  async inspectTokenizerData(
    tokenizerData: ArrayBuffer,
    signal?: AbortSignal,
    onStartRequest?: () => void,
  ): Promise<TokenizerStructure> {
    this.assertUsable()
    if (tokenizerData.byteLength > 32 * 1024 * 1024) throw new Error(t('tokenizerDataTooLarge'))
    signal?.throwIfAborted()
    onStartRequest?.()
    const reply = await this.request({
      operation: 'inspect-structure',
      tokenizerIdentity: '',
      tokenizerData,
    }, [tokenizerData], signal)
    if (signal?.aborted) throw new DOMException(t('tokenizerRequestCancelled'), 'AbortError')
    return validateTokenizerStructure(reply)
  }

  async tokenize(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    text: string,
    signal?: AbortSignal,
  ): Promise<Tokenization> {
    this.assertUsable()
    if (text.length === 0) return {
      direction: 'encode', input: text, ids: [], pieces: [], decoded: '', segments: [], mapping: 'Exact', flags: [],
      overhead: null, roles: null,
    }
    if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error(t('textTooLarge'))
    const { identity } = await this.ensureLoaded(snapshot, tokenizerFile, configFile, signal)
    return validateTokenization(await this.request({
      operation: 'tokenize',
      tokenizerIdentity: identity,
      text,
    }, [], signal), false)
  }

  async chatTokenize(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    template: string,
    context: Record<string, unknown>,
    attribution: ChatAttributionMessage[],
    signal?: AbortSignal,
  ): Promise<Tokenization> {
    this.assertUsable()
    if (new TextEncoder().encode(template).byteLength > 64 * 1024) throw new Error(t('templateSourceTooLarge'))
    const serializedContext = JSON.stringify(context)
    if (serializedContext === undefined || new TextEncoder().encode(serializedContext).byteLength > 64 * 1024) {
      throw new Error(t('templateContextTooLarge'))
    }
    const { identity } = await this.ensureLoaded(snapshot, tokenizerFile, configFile, signal)
    return validateTokenization(await this.request({
      operation: 'chat-tokenize',
      tokenizerIdentity: identity,
      template,
      context,
      attribution,
    }, [], signal), true)
  }

  async decodeTokenIds(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    input: string,
    signal?: AbortSignal,
  ): Promise<Tokenization> {
    this.assertUsable()
    const ids = parseTokenIds(input)
    const { identity } = await this.ensureLoaded(snapshot, tokenizerFile, configFile, signal)
    return validateTokenization(await this.request({
      operation: 'decode-token-ids',
      tokenizerIdentity: identity,
      ids,
      originalInput: input,
    }, [], signal), false)
  }

  async searchTokenizerVocabulary(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    query: string,
    signal?: AbortSignal,
  ): Promise<TokenizerVocabularyEntry[]> {
    this.assertUsable()
    const term = query.trim()
    if (term.length === 0) return []
    if (new TextEncoder().encode(term).byteLength > 64 * 1024) throw new Error(t('vocabularySearchInputTooLarge'))
    const { identity } = await this.ensureLoaded(snapshot, tokenizerFile, configFile, signal)
    return validateTokenizerVocabularySearch(await this.request({
      operation: 'search-vocabulary',
      tokenizerIdentity: identity,
      query: term,
    }, [], signal))
  }

  async prepareVocabularyDiff(
    rightSnapshot: RepositorySnapshot,
    rightTokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    leftSnapshot: RepositorySnapshot,
    leftTokenizerFile: RepositoryFile,
    signal?: AbortSignal,
  ) {
    this.assertUsable()
    const { identity } = await this.ensureLoaded(rightSnapshot, rightTokenizerFile, configFile, signal)
    const tokenizerData = await readWholeFile(leftSnapshot, leftTokenizerFile, signal)
    if (this.loadedIdentity !== identity) throw new DOMException(t('tokenizerRequestCancelled'), 'AbortError')
    return validateTokenizerVocabularyDiffCounts(await this.request({
      operation: 'prepare-vocabulary-diff',
      tokenizerIdentity: identity,
      tokenizerData,
    }, [tokenizerData], signal))
  }

  async searchVocabularyDiff(scope: VocabularyDiffScope, query: string, signal?: AbortSignal) {
    this.assertUsable()
    if (this.loadedIdentity === '') throw new Error(t('vocabularyDiffNotPrepared'))
    const term = query.trim()
    if (new TextEncoder().encode(term).byteLength > 64 * 1024) {
      throw new Error(t('vocabularyDiffSearchInputTooLarge'))
    }
    return validateTokenizerVocabularyDiffSearch(await this.request({
      operation: 'search-vocabulary-diff',
      tokenizerIdentity: this.loadedIdentity,
      scope,
      query: term,
    }, [], signal))
  }

  async decodeTokenIdArray(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    ids: number[],
    originalInput = JSON.stringify(ids),
    signal?: AbortSignal,
  ): Promise<Tokenization> {
    this.assertUsable()
    if (!Array.isArray(ids) || !ids.every(isSafeNonNegativeInteger)) {
      throw new Error(t('tokenIdArrayInvalid'))
    }
    if (new TextEncoder().encode(originalInput).byteLength > 64 * 1024) {
      throw new Error(t('tokenIdInputTooLarge'))
    }
    const { identity } = await this.ensureLoaded(snapshot, tokenizerFile, configFile, signal)
    return validateTokenization(await this.request({
      operation: 'decode-token-ids',
      tokenizerIdentity: identity,
      ids,
      originalInput,
    }, [], signal), false)
  }

  async renderTemplate(source: string, context: Record<string, unknown>): Promise<string> {
    this.assertUsable()
    if (new TextEncoder().encode(source).byteLength > 64 * 1024) throw new Error(t('templateSourceTooLarge'))
    const serialized = JSON.stringify(context)
    if (new TextEncoder().encode(serialized).byteLength > 64 * 1024) throw new Error(t('templateContextTooLarge'))
    return await this.request({
      operation: 'render-template',
      tokenizerIdentity: '',
      source,
      context,
    }) as string
  }

  cancel(): void {
    if (this.isDisposed) return
    this.invalidate(new DOMException(t('tokenizerRequestCancelled'), 'AbortError'))
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.invalidate(new DOMException(t('tokenizerSessionReleased'), 'AbortError'))
    if (comparisonSession === this) comparisonSession = null
  }

  private assertUsable() {
    if (this.isDisposed) throw new DOMException(t('tokenizerSessionReleased'), 'InvalidStateError')
  }

  private assertLoadActive(generation: number, signal: AbortSignal) {
    if (this.generation !== generation || signal.aborted) {
      throw new DOMException(t('tokenizerRequestCancelled'), 'AbortError')
    }
  }

  private async ensureLoaded(
    snapshot: RepositorySnapshot,
    tokenizerFile: RepositoryFile,
    configFile: RepositoryFile | undefined,
    signal?: AbortSignal,
  ): Promise<LoadedTokenizer> {
    this.assertUsable()
    tokenizerBundleBytes(tokenizerFile, configFile)
    if (tokenizerFile.size === null || configFile?.size === null) throw new Error(t('tokenizerResourceSizeInvalid'))
    const tokenizerSize = tokenizerFile.size
    const configSize = configFile?.size ?? 0
    const identity = tokenizerIdentity(snapshot, tokenizerFile, configFile)
    if (this.loadedIdentity === identity && this.loadedStructure !== null) {
      return { identity, structure: this.loadedStructure }
    }
    if (this.loading?.identity === identity) return await awaitWithAbort(this.loading.promise, signal)
    this.invalidate(new DOMException(t('tokenizerRequestCancelled'), 'AbortError'))
    this.generation += 1
    const activeGeneration = this.generation
    const loadController = new AbortController()
    const runLoad = async (): Promise<LoadedTokenizer> => {
      try {
        const [tokenizerData, configData] = await Promise.all([
          readWholeFile(snapshot, tokenizerFile, loadController.signal, tokenizerSize),
          configFile === undefined ? Promise.resolve(null) : readWholeFile(snapshot, configFile, loadController.signal, configSize),
        ])
        this.assertLoadActive(activeGeneration, loadController.signal)
        const transfer = configData === null ? [tokenizerData] : [tokenizerData, configData]
        const structure = validateTokenizerStructure(await this.request(
          { operation: 'load', tokenizerIdentity: identity, tokenizerData, configData },
          transfer,
          loadController.signal,
        ))
        this.assertLoadActive(activeGeneration, loadController.signal)
        this.loadedIdentity = identity
        this.loadedStructure = structure
        return { identity, structure }
      }
      catch (error) {
        throw normalizedError(error)
      }
      finally {
        if (this.loadController === loadController) this.loadController = null
        if (this.loading?.promise === promise) this.loading = null
      }
    }
    const promise = runLoad()
    this.loading = { identity, promise }
    this.loadController = loadController
    return await awaitWithAbort(promise, signal)
  }

  private request(
    message: OutgoingTokenizerRequest,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.assertUsable()
    if (signal?.aborted) throw new DOMException(t('tokenizerRequestCancelled'), 'AbortError')
    const requestId = ++this.nextId
    let removeAbort: () => void = () => {}
    const expected: PendingTokenizerRequest = {
      operation: message.operation,
      requestId,
      sessionId: sessionIdOf(this),
      generation: this.generation,
      tokenizerIdentity: message.tokenizerIdentity,
      resolve: () => {},
      reject: () => {},
      removeAbort: () => removeAbort(),
    }
    let settled = false
    const settle = (complete: (entry: PendingTokenizerRequest) => void) => {
      if (settled) return
      settled = true
      this.pending.delete(requestId)
      removeAbort()
      complete(expected)
    }
    const onAbort = () => settle(entry => entry.reject(new DOMException(t('tokenizerRequestCancelled'), 'AbortError')))
    removeAbort = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    const activeWorker = this.getWorker()
    const envelope: TokenizerRequest = {
      ...message,
      kind: 'request',
      sessionId: sessionIdOf(this),
      generation: expected.generation,
      requestId,
    } as TokenizerRequest
    return new Promise((resolve, reject) => {
      expected.resolve = resolve
      expected.reject = reject
      this.pending.set(requestId, expected)
      try {
        activeWorker.postMessage(envelope, transfer)
      }
      catch (error) {
        settle(entry => entry.reject(error instanceof Error ? error : new Error(String(error))))
      }
    })
  }

  private getWorker(): Worker {
    if (this.worker !== null) return this.worker
    const worker = new Worker(new URL('./tokenizer.worker.ts', import.meta.url), {
      type: 'module',
      name: currentLocale(),
    })
    worker.onmessage = event => this.receiveReply(event.data)
    worker.onerror = event => {
      this.invalidate(new Error(event.message || t('tokenizerWorkerFailed')))
    }
    this.worker = worker
    return worker
  }

  private receiveReply(data: unknown) {
    if (!isReplyEnvelope(data)) {
      this.invalidate(new Error(t('tokenizerWorkerProtocolInvalid')))
      return
    }
    const expected = this.pending.get(data.requestId)
    if (expected === undefined) return
    if (data.requestId !== expected.requestId
      || data.sessionId !== expected.sessionId
      || data.operation !== expected.operation
      || data.generation !== expected.generation
      || data.tokenizerIdentity !== expected.tokenizerIdentity) {
      this.invalidate(new Error(t('tokenizerWorkerProtocolMismatch')))
      return
    }
    this.pending.delete(data.requestId)
    expected.removeAbort()
    if (data.ok) expected.resolve(data.value)
    else expected.reject(new Error(data.error))
  }

  private invalidate(error: Error) {
    this.loadController?.abort()
    this.loadController = null
    this.worker?.terminate()
    if (this.worker !== null) {
      this.worker.onmessage = null
      this.worker.onerror = null
    }
    this.worker = null
    this.generation += 1
    this.loadedIdentity = ''
    this.loadedStructure = null
    this.loading = null
    for (const entry of this.pending.values()) {
      entry.removeAbort()
      entry.reject(error)
    }
    this.pending.clear()
  }
}

let comparisonSession: ClientTokenizerSession | null = null
let nextSessionId = 0
const sessionIds = new WeakMap<ClientTokenizerSession, string>()

function sessionIdOf(session: ClientTokenizerSession): string {
  let sessionId = sessionIds.get(session)
  if (sessionId === undefined) {
    sessionId = `tokenizer-session-${++nextSessionId}`
    sessionIds.set(session, sessionId)
  }
  return sessionId
}

function isReplyEnvelope(value: unknown): value is TokenizerReply & { ok: boolean } {
  if (!isUnknownRecord(value) || value.kind !== 'reply' || typeof value.ok !== 'boolean') return false
  const keys = Object.keys(value).toSorted().join(',')
  const requiredKeys = ['generation', 'kind', 'ok', 'operation', 'requestId', 'sessionId', 'tokenizerIdentity']
  if (keys !== (value.ok ? [...requiredKeys, 'value'] : [...requiredKeys, 'error']).toSorted().join(',')) return false
  return typeof value.sessionId === 'string' && value.sessionId.length > 0
    && isSafeNonNegativeInteger(value.requestId)
    && isSafeNonNegativeInteger(value.generation)
    && typeof value.tokenizerIdentity === 'string'
    && typeof value.operation === 'string' && operations.has(value.operation)
    && (typeof value.error === 'string' || 'value' in value)
}

const operations = new Set<string>([
  'load', 'inspect-structure', 'tokenize', 'chat-tokenize',
  'decode-token-ids', 'render-template', 'search-vocabulary',
  'prepare-vocabulary-diff', 'search-vocabulary-diff',
] satisfies TokenizerOperation[])

export function validateTokenizerVocabularyDiffCounts(value: unknown): {
  leftOnlyCount: number
  rightOnlyCount: number
  sharedCount: number
} {
  if (!isUnknownRecord(value) || !sameKeys(value, ['leftOnlyCount', 'rightOnlyCount', 'sharedCount'])
  ) {
    throw new Error(t('vocabularyDiffCountsInvalid'))
  }
  const leftOnlyCount = value.leftOnlyCount
  const rightOnlyCount = value.rightOnlyCount
  const sharedCount = value.sharedCount
  if (!isSafeNonNegativeInteger(leftOnlyCount)
    || !isSafeNonNegativeInteger(rightOnlyCount)
    || !isSafeNonNegativeInteger(sharedCount)) {
    throw new Error(t('vocabularyDiffCountsInvalid'))
  }
  return {
    leftOnlyCount,
    rightOnlyCount,
    sharedCount,
  }
}

export function validateTokenizerVocabularyDiffSearch(value: unknown): { total: number; pieces: string[] } {
  if (!isUnknownRecord(value) || !sameKeys(value, ['total', 'pieces'])
    || !isSafeNonNegativeInteger(value.total) || !Array.isArray(value.pieces)
    || value.pieces.length > 1_000 || value.total < value.pieces.length
    || !value.pieces.every(piece => typeof piece === 'string')
    || !isSortedCodePoints(value.pieces)) {
    throw new Error(t('vocabularyDiffSearchResultInvalid'))
  }
  return { total: value.total, pieces: value.pieces }
}

function sameKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).toSorted().join(',') === keys.toSorted().join(',')
}

function isSortedCodePoints(pieces: string[]) {
  for (let index = 1; index < pieces.length; index++) {
    if (compareCodePoints(pieces[index - 1], pieces[index]) >= 0) return false
  }
  return true
}

function compareCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] < rightPoints[index] ? -1 : 1
  }
  return leftPoints.length - rightPoints.length
}

export async function tokenize(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  text: string,
  signal?: AbortSignal,
): Promise<Tokenization> {
  return await mainTokenizerSession.tokenize(snapshot, tokenizerFile, configFile, text, signal)
}

export async function chatTokenize(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  template: string,
  context: Record<string, unknown>,
  attribution: ChatAttributionMessage[],
  signal?: AbortSignal,
): Promise<Tokenization> {
  return await mainTokenizerSession.chatTokenize(snapshot, tokenizerFile, configFile, template, context, attribution, signal)
}

export async function decodeTokenIds(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  input: string,
  signal?: AbortSignal,
): Promise<Tokenization> {
  return await mainTokenizerSession.decodeTokenIds(snapshot, tokenizerFile, configFile, input, signal)
}

export async function inspectTokenizer(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  signal?: AbortSignal,
): Promise<TokenizerStructure> {
  return await mainTokenizerSession.inspectTokenizer(snapshot, tokenizerFile, configFile, signal)
}

export async function inspectTokenizerData(
  tokenizerData: ArrayBuffer,
  signal?: AbortSignal,
  onStartRequest?: () => void,
): Promise<TokenizerStructure> {
  return await mainTokenizerSession.inspectTokenizerData(tokenizerData, signal, onStartRequest)
}

export async function searchTokenizerVocabulary(
  snapshot: RepositorySnapshot,
  tokenizerFile: RepositoryFile,
  configFile: RepositoryFile | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<TokenizerVocabularyEntry[]> {
  return await mainTokenizerSession.searchTokenizerVocabulary(snapshot, tokenizerFile, configFile, query, signal)
}

export async function renderTemplate(source: string, context: Record<string, unknown>): Promise<string> {
  return await mainTokenizerSession.renderTemplate(source, context)
}

export function cancelTokenizerRequests(): void {
  mainTokenizerSession.cancel()
}

export const mainTokenizerSession: TokenizerSession = new ClientTokenizerSession()

export function createComparisonTokenizerSession(): TokenizerSession {
  if (comparisonSession !== null) throw new Error(t('comparisonSessionExists'))
  comparisonSession = new ClientTokenizerSession()
  return comparisonSession
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

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException(t('tokenizerRequestCancelled'), 'AbortError')
  if (!signal) return await promise
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException(t('tokenizerRequestCancelled'), 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function validateTokenization(value: unknown, requiresOverhead: boolean): Tokenization {
  const isStringOrNull = (item: unknown) => item === null || typeof item === 'string'
  const isFlag = (item: unknown): item is TokenFlag => isUnknownRecord(item)
    && typeof item.isSpecial === 'boolean' && (item.specialName === null || typeof item.specialName === 'string')
  if (!isUnknownRecord(value)
    || !('overhead' in value)
    || !('roles' in value)
    || (value.direction !== 'encode' && value.direction !== 'decode')
    || typeof value.input !== 'string'
    || typeof value.decoded !== 'string'
    || !Array.isArray(value.ids) || !value.ids.every(isSafeNonNegativeInteger)
    || !Array.isArray(value.pieces) || !value.pieces.every(isStringOrNull)
    || !Array.isArray(value.segments)
    || (value.mapping !== 'Exact' && value.mapping !== 'Decoded only')
    || (value.direction === 'decode' && value.mapping !== 'Decoded only')
    || !Array.isArray(value.flags) || !value.flags.every(isFlag)) {
    throw new Error(t('tokenizerWorkerReturnedResultInvalid'))
  }
  if (value.pieces.length !== value.ids.length || value.flags.length !== value.ids.length) {
    throw new Error(t('tokenizerWorkerReturnedPieceCountMismatch'))
  }
  const ids = value.ids as number[]
  const roles = validateChatTokenRoles(
    value.roles,
    ids.length,
    requiresOverhead && value.mapping === 'Exact',
  )
  const overhead = validateChatTokenOverhead(value.overhead, requiresOverhead, ids.length)
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
      throw new Error(t('tokenizerWorkerReturnedSegmentInvalid'))
    }
  }
  return { ...(value as Tokenization), overhead, roles }
}

export function validateTokenizerStructure(value: unknown): TokenizerStructure {
  if (!hasExactKeys(value, [
    'addedTokenCount', 'addedTokens', 'chatTemplates', 'fields', 'mergeCount',
    'modelType', 'vocabCount', 'version', 'vocabulary', 'vocabularyError',
  ])) throw new Error(t('tokenizerWorkerReturnedStructureInvalid'))
  const structure = value as TokenizerStructure
  if (!(structure.version === null || typeof structure.version === 'string')
    || !(structure.modelType === null || typeof structure.modelType === 'string')
    || !isOptionalNonNegativeInteger(structure.vocabCount)
    || !isOptionalNonNegativeInteger(structure.mergeCount)
    || !isOptionalNonNegativeInteger(structure.addedTokenCount)
    || !Array.isArray(structure.fields)
    || !structure.fields.every(item => hasExactKeys(item, ['detail', 'name'])
      && typeof item.name === 'string' && typeof item.detail === 'string')) {
    throw new Error(t('tokenizerWorkerReturnedFieldsInvalid'))
  }
  if (!Array.isArray(structure.addedTokens)
    || (structure.addedTokenCount === null ? structure.addedTokens.length !== 0 : structure.addedTokens.length > structure.addedTokenCount)
    || !structure.addedTokens.every(isAddedTokenSummary)) {
    throw new Error(t('tokenizerWorkerReturnedAddedTokensInvalid'))
  }
  if (!(structure.vocabulary === null || isTokenizerVocabularyAnalysis(structure.vocabulary))
    || !(structure.vocabularyError === null || typeof structure.vocabularyError === 'string')) {
    throw new Error(t('tokenizerWorkerReturnedVocabularySummaryInvalid'))
  }
  return { ...(value as TokenizerStructure), chatTemplates: validateChatTemplateCatalog(value.chatTemplates) }
}

function isAddedTokenSummary(value: unknown): value is AddedTokenSummary {
  return hasExactKeys(value, ['content', 'id', 'special'])
    && (value.id === null || isSafeNonNegativeInteger(value.id))
    && typeof value.content === 'string'
    && typeof value.special === 'boolean'
}

function isTokenizerVocabularyEntry(value: unknown): value is TokenizerVocabularyEntry {
  return hasExactKeys(value, ['scalarLength', 'token', 'tokenId'])
    && isSafeNonNegativeInteger(value.tokenId)
    && typeof value.token === 'string'
    && value.scalarLength === Array.from(value.token).length
}

function isTokenizerVocabularyAnalysis(value: unknown): value is TokenizerVocabularyAnalysis {
  if (!hasExactKeys(value, [
    'averageScalarLength', 'buckets', 'longestTokens', 'maximumScalarLength',
    'p50ScalarLength', 'p90ScalarLength', 'p95ScalarLength', 'p99ScalarLength', 'tokenCount',
  ])
    || !isSafeNonNegativeInteger(value.tokenCount)
    || typeof value.averageScalarLength !== 'number' || !Number.isFinite(value.averageScalarLength) || value.averageScalarLength < 0
    || !isSafeNonNegativeInteger(value.p50ScalarLength)
    || !isSafeNonNegativeInteger(value.p90ScalarLength)
    || !isSafeNonNegativeInteger(value.p95ScalarLength)
    || !isSafeNonNegativeInteger(value.p99ScalarLength)
    || !isSafeNonNegativeInteger(value.maximumScalarLength)
    || !Array.isArray(value.buckets)
    || !value.buckets.every(item => hasExactKeys(item, ['count', 'label'])
      && typeof item.label === 'string' && isSafeNonNegativeInteger(item.count))
    || !Array.isArray(value.longestTokens) || value.longestTokens.length > 50
    || !value.longestTokens.every(isTokenizerVocabularyEntry)) {
    throw new Error(t('tokenizerWorkerReturnedLongestOrStatisticsInvalid'))
  }
  return true
}

export function validateTokenizerVocabularySearch(value: unknown): TokenizerVocabularyEntry[] {
  if (!Array.isArray(value) || value.length > 1_000 || !value.every(isSearchReplyItem)) {
    throw new Error(t('tokenizerWorkerReturnedSearchResultInvalid'))
  }
  const result = value.map((item): TokenizerVocabularyEntry => ({
    tokenId: item.tokenId,
    token: item.token,
    scalarLength: item.scalarLength,
  }))
  for (let index = 1; index < result.length; index += 1) {
    if (result[index].tokenId <= result[index - 1].tokenId) throw new Error(t('tokenizerWorkerReturnedSearchOrderInvalid'))
  }
  return result
}

function isSearchReplyItem(value: unknown): value is TokenizerVocabularyEntry {
  return isTokenizerVocabularyEntry(value)
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isUnknownRecord(value) && Object.keys(value).toSorted().join(',') === keys.toSorted().join(',')
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === null || isSafeNonNegativeInteger(value)
}

function validateChatTemplateCatalog(value: unknown): ChatTemplateCatalog {
  if (!isUnknownRecord(value)
    || !Array.isArray(value.entries)
    || typeof value.conflict !== 'boolean'
    || !(value.activeId === null || typeof value.activeId === 'string')) {
    throw new Error(t('tokenizerWorkerReturnedChatTemplateCatalogInvalid'))
  }
  const entries = value.entries.map((item): ChatTemplateEntry => {
    if (!isUnknownRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string'
      || (item.source !== 'tokenizerConfig' && item.source !== 'jinjaFile')
      || typeof item.body !== 'string' || typeof item.usable !== 'boolean'
      || item.id !== `${item.source}:${item.name}` || item.usable !== (item.body.trim().length > 0)) {
      throw new Error(t('tokenizerWorkerReturnedChatTemplateEntryInvalid'))
    }
    return { id: item.id, name: item.name, source: item.source as ChatTemplateSource, body: item.body, usable: item.usable }
  })
  const activeId = value.activeId
  if (activeId !== null && !entries.some(entry => entry.id === activeId && entry.usable)) {
    throw new Error(t('tokenizerWorkerReturnedActiveChatTemplateInvalid'))
  }
  return { entries, activeId, conflict: value.conflict }
}

function validateChatTokenRoles(
  value: unknown,
  idCount: number,
  required: boolean,
): ChatTokenRole[] | null {
  if (!Array.isArray(value)) {
    if (required) throw new Error(t('tokenizerWorkerReturnedExactChatMissingRoles'))
    if (value !== null) throw new Error(t('tokenizerWorkerReturnedRolesInvalid'))
    return null
  }
  if (!required) throw new Error(t('tokenizerWorkerReturnedUnexpectedRoles'))
  if (value.length !== idCount) throw new Error(t('tokenizerWorkerReturnedRolesCountMismatch'))
  return value.map((role): ChatTokenRole => {
    const keys = isUnknownRecord(role) ? Object.keys(role).toSorted() : []
    if (isUnknownRecord(role) && role.kind === 'template' && keys.length === 1) return { kind: 'template' }
    if (isUnknownRecord(role) && role.kind === 'message' && keys.length === 2
      && keys.includes('kind') && keys.includes('role') && typeof role.role === 'string') {
      return { kind: 'message', role: role.role }
    }
    throw new Error(t('tokenizerWorkerReturnedRoleInvalid'))
  })
}

function validateChatTokenOverhead(value: unknown, required: boolean, idCount: number): ChatTokenOverhead | null {
  if (value !== null) {
    const keys = isUnknownRecord(value) ? Object.keys(value).toSorted() : []
    if (!isUnknownRecord(value)
      || keys.length !== 5
      || !['contentCount', 'contentProbe', 'isApproximate', 'templateCount', 'totalCount'].every(key => keys.includes(key))
      || value.isApproximate !== true
      || !isSafeNonNegativeInteger(value.totalCount)
      || !isSafeNonNegativeInteger(value.contentCount)
      || typeof value.templateCount !== 'number' || !Number.isSafeInteger(value.templateCount)
      || typeof value.contentProbe !== 'string'
      || value.templateCount !== value.totalCount - value.contentCount) {
      throw new Error(t('tokenizerWorkerReturnedOverheadInvalid'))
    }
    const overhead = value as ChatTokenOverhead
    if (!required) throw new Error(t('tokenizerWorkerReturnedUnexpectedOverhead'))
    if (overhead.totalCount !== idCount) throw new Error(t('tokenizerWorkerReturnedOverheadCountMismatch'))
    return overhead
  }
  else if (required) throw new Error(t('tokenizerWorkerReturnedChatMissingOverhead'))
  return null
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
