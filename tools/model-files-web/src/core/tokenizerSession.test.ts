import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createComparisonTokenizerSession,
  inspectTokenizerData,
  mainTokenizerSession,
  validateTokenizerVocabularyDiffCounts,
  validateTokenizerVocabularyDiffSearch,
  type TokenizerSession,
} from '../tokenizerClient.ts'
import { type LocalDirectorySnapshot } from './huggingface.ts'
import { isTokenizerRequest } from '../tokenizerProtocol.ts'

class FakeWorker {
  static created: FakeWorker[] = []
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  sent: Array<Record<string, unknown>> = []
  terminated = false

  constructor() {
    FakeWorker.created.push(this)
  }

  postMessage(message: unknown) {
    this.sent.push(message as Record<string, unknown>)
  }

  terminate() {
    this.terminated = true
  }
}

function installFakeWorker() {
  const originalWorker = globalThis.Worker
  globalThis.Worker = FakeWorker as unknown as typeof Worker
  FakeWorker.created.length = 0
  return originalWorker
}

function deliver(worker: FakeWorker, data: Record<string, unknown>) {
  worker.onmessage?.(new MessageEvent('message', { data }))
}

async function waitForSent(worker: FakeWorker, count: number) {
  for (let attempt = 0; attempt < 1000 && worker.sent.length < count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(worker.sent.length >= count, 'FakeWorker did not receive the expected request')
}

async function waitForCreatedWorker(sentCount: number, previous?: FakeWorker): Promise<FakeWorker> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const worker = FakeWorker.created.find(candidate =>
      candidate !== previous && candidate.sent.length >= sentCount
    )
    if (worker) return worker
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail('FakeWorker was not created with the expected request')
}

function replyData(request: unknown, overrides: Record<string, unknown> = {}) {
  const value = request as Record<string, unknown>
  return {
    kind: 'reply',
    operation: value.operation,
    requestId: value.requestId,
    sessionId: value.sessionId,
    generation: value.generation,
    tokenizerIdentity: value.tokenizerIdentity,
    ok: true,
    ...overrides,
  }
}

function reply(worker: FakeWorker, overrides: Record<string, unknown> = {}, index = -1) {
  const request = worker.sent.at(index)
  assert.ok(request, 'FakeWorker did not receive the expected request')
  deliver(worker, {
    kind: 'reply',
    operation: request.operation,
    requestId: request.requestId,
    sessionId: request.sessionId,
    generation: request.generation,
    tokenizerIdentity: request.tokenizerIdentity,
    ok: true,
    value: tokenizerStructure(),
    ...overrides,
  })
}

function tokenizerStructure() {
  return {
    addedTokenCount: null,
    addedTokens: [],
    chatTemplates: { entries: [], activeId: null, conflict: false },
    fields: [],
    mergeCount: null,
    modelType: 'BPE',
    vocabCount: 0,
    version: '1.0',
    vocabulary: null,
    vocabularyError: '',
  }
}

function localSnapshot(
  id: string,
  localFiles: Array<[string, File]> = [['tokenizer.json', new File(['{}'], 'tokenizer.json')]],
): LocalDirectorySnapshot {
  return {
    source: 'local',
    name: id,
    revision: 'live',
    selectionId: id,
    files: [],
    localFiles: new Map(localFiles),
  }
}

function sentencepieceSnapshot(id: string) {
  const modelBytes = new TextEncoder().encode('__SP_')
  const modelFile = {
    path: 'tokenizer.model',
    size: modelBytes.byteLength,
    hash: null,
    category: 'tokenizer',
  } as const
  return {
    ...localSnapshot(id, [['tokenizer.model', {
      size: modelBytes.byteLength,
      arrayBuffer: async () => modelBytes.slice().buffer,
    } as unknown as File]]),
    files: [modelFile],
  }
}

function sentencepieceStructure() {
  return {
    addedTokenCount: 0,
    addedTokens: [],
    chatTemplates: { entries: [], activeId: null, conflict: false },
    fields: [],
    mergeCount: null,
    modelType: 'SentencePiece',
    vocabCount: null,
    version: null,
    vocabulary: null,
    vocabularyError: '',
  }
}

function diffSnapshot(id: string): LocalDirectorySnapshot {
  const left = new File([JSON.stringify({ model: { vocab: { hello: 3 } } })], 'tokenizer.json')
  const rightTokenizer = new File(['{}'], 'tokenizer.json')
  const rightConfig = new File(['{}'], 'tokenizer_config.json')
  return {
    source: 'local',
    name: id,
    revision: 'live',
    selectionId: id,
    files: [],
    localFiles: new Map([
      ['tokenizer.json', left],
      ['right/tokenizer.json', rightTokenizer],
      ['right/tokenizer_config.json', rightConfig],
    ]),
  }
}

function diffSnapshots(id: string) {
  return {
    rightSnapshot: diffSnapshot(`${id}-right`),
    leftSnapshot: diffSnapshot(`${id}-left`),
  }
}

function tokenizerData() {
  return new TextEncoder().encode('{}').buffer as ArrayBuffer
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function cleanup(originalWorker: typeof Worker, comparisons: TokenizerSession[]) {
  for (const comparison of comparisons) {
    comparison.dispose()
  }
  mainTokenizerSession.cancel()
  globalThis.Worker = originalWorker
  FakeWorker.created.length = 0
}

test('comparison sessions isolate workers, cancellation, and disposal', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    let mainStarted = false
    let comparisonStarted = false
    const mainPromise = inspectTokenizerData(tokenizerData(), undefined, () => { mainStarted = true })
    const comparisonPromise = comparison.inspectTokenizerData(tokenizerData(), undefined, () => { comparisonStarted = true })
    await Promise.resolve()
    assert.ok(mainStarted && comparisonStarted)
    assert.equal(FakeWorker.created.length, 2)
    const [mainWorker, comparisonWorker] = FakeWorker.created
    assert.notEqual(mainWorker.sent[0].sessionId, comparisonWorker.sent[0].sessionId)

    comparison.cancel()
    await assert.rejects(comparisonPromise, /已取消/)
    assert.equal(comparisonWorker.terminated, true)
    reply(mainWorker, {}, 0)
    assert.equal((await mainPromise).modelType, 'BPE')

    const reusedComparison = comparison.inspectTokenizerData(tokenizerData())
    await Promise.resolve()
    const replacementWorker = FakeWorker.created.at(-1)!
    assert.equal(replacementWorker.terminated, false)
    reply(replacementWorker)
    await assert.doesNotReject(reusedComparison)

    comparison.dispose()
    await assert.rejects(comparison.inspectTokenizerData(tokenizerData()), /已释放/)
    const recreated = createComparisonTokenizerSession()
    comparisons.push(recreated)
    const mainAgain = inspectTokenizerData(tokenizerData())
    await Promise.resolve()
    reply(mainWorker, {}, -1)
    await assert.doesNotReject(mainAgain)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('only one comparison session can be live', { timeout: 1_000 }, () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    assert.throws(createComparisonTokenizerSession, /comparison session/)
    comparison.dispose()
    const replacement = createComparisonTokenizerSession()
    comparisons.push(replacement)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('one aborted request ignores its late reply and keeps the session usable', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    const controller = new AbortController()
    const aborted = comparison.inspectTokenizerData(tokenizerData(), controller.signal)
    await Promise.resolve()
    controller.abort()
    await assert.rejects(aborted, isAbort)
    const worker = FakeWorker.created[0]
    assert.equal(worker.terminated, false)
    reply(worker)

    const next = comparison.inspectTokenizerData(tokenizerData())
    await Promise.resolve()
    reply(worker, {}, 1)
    await assert.doesNotReject(next)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('aborted SentencePiece load terminates its worker and stale replies cannot publish', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    const controller = new AbortController()
    const aborted = comparison.inspectTokenizer(sentencepieceSnapshot('sp'), {
      path: 'tokenizer.model', size: 5, hash: null, category: 'tokenizer',
    }, undefined, controller.signal)
    const worker = await waitForCreatedWorker(1)
    await waitForSent(worker, 1)
    controller.abort()
    await assert.rejects(aborted, isAbort)

    assert.equal(worker.terminated, true)
    const load = worker.sent[0]
    assert.equal((load as { format?: unknown }).format, 'sentencepiece')
    deliver(worker, replyData(worker.sent[0], { value: tokenizerStructure() }))
    const next = comparison.inspectTokenizer(sentencepieceSnapshot('sp-next'), {
      path: 'tokenizer.model', size: 5, hash: null, category: 'tokenizer',
    }, undefined)
    const replacement = await waitForCreatedWorker(1, worker)
    assert.notEqual(replacement, worker)
    deliver(replacement, replyData(replacement.sent[0], { value: tokenizerStructure() }))
    await assert.doesNotReject(next)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('aborting a loaded SentencePiece operation releases its worker and blocks stale publication', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    const snapshot = sentencepieceSnapshot('sp-operation')
    const file = { path: 'tokenizer.model', size: 5, hash: null, category: 'tokenizer' } as const
    const loaded = comparison.inspectTokenizer(snapshot, file, undefined)
    const firstWorker = await waitForCreatedWorker(1)
    await waitForSent(firstWorker, 1)
    reply(firstWorker, { value: sentencepieceStructure() })
    assert.equal((await loaded).modelType, 'SentencePiece')

    const controller = new AbortController()
    const operation = comparison.tokenize(snapshot, file, undefined, 'hello', controller.signal)
    await waitForSent(firstWorker, 2)
    controller.abort()
    await assert.rejects(operation, isAbort)
    assert.equal(firstWorker.terminated, true)
    deliver(firstWorker, replyData(firstWorker.sent.at(-1), { value: {} }))

    const retry = comparison.inspectTokenizer(sentencepieceSnapshot('sp-retry'), {
      path: 'tokenizer.model', size: 5, hash: null, category: 'tokenizer',
    }, undefined)
    const replacement = await waitForCreatedWorker(1, firstWorker)
    await waitForSent(replacement, 1)
    assert.notEqual(replacement, firstWorker)
    reply(replacement, { value: sentencepieceStructure() })
    await assert.doesNotReject(retry)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('invalid replies and worker errors fail only their own session', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const mainPromise = inspectTokenizerData(tokenizerData())
    await Promise.resolve()
    const mainWorker = FakeWorker.created[0]
    const mismatches = [
      { operation: 'tokenize' },
      { sessionId: 'other-session' },
      { generation: 999 },
      { tokenizerIdentity: 'other-identity' },
      { requestId: 'not-a-number' },
      { extra: true },
    ]
    for (const override of mismatches) {
      const comparison = createComparisonTokenizerSession()
      comparisons.push(comparison)
      const comparisonPromise = comparison.inspectTokenizerData(tokenizerData())
      await Promise.resolve()
      const worker = FakeWorker.created.at(-1)!
      reply(worker, override, 0)
      await assert.rejects(comparisonPromise, /协议|无效/)
      assert.equal(worker.terminated, true)
      comparison.dispose()
    }

    const recoveryComparison = createComparisonTokenizerSession()
    comparisons.push(recoveryComparison)
    const mismatchPromise = recoveryComparison.inspectTokenizerData(tokenizerData())
    await Promise.resolve()
    const mismatchWorker = FakeWorker.created.at(-1)!
    reply(mismatchWorker, { sessionId: 'other-session' }, 0)
    await assert.rejects(mismatchPromise, /协议不一致/)
    const recoveryPromise = recoveryComparison.inspectTokenizerData(tokenizerData())
    await Promise.resolve()
    const recoveryWorker = FakeWorker.created.at(-1)!
    assert.notEqual(recoveryWorker, mismatchWorker)
    reply(recoveryWorker)
    await assert.doesNotReject(recoveryPromise)
    recoveryComparison.dispose()

    const errorComparison = createComparisonTokenizerSession()
    comparisons.push(errorComparison)
    const errorPromise = errorComparison.inspectTokenizerData(tokenizerData())
    await Promise.resolve()
    const errorWorker = FakeWorker.created.at(-1)!
    errorWorker.onerror?.(new ErrorEvent('error', { message: 'worker failed' }))
    await assert.rejects(errorPromise, /worker failed/)
    assert.equal(errorWorker.terminated, true)
    const retryPromise = errorComparison.inspectTokenizerData(tokenizerData())
    await Promise.resolve()
    const retryWorker = FakeWorker.created.at(-1)!
    assert.notEqual(retryWorker, errorWorker)
    reply(retryWorker)
    await assert.doesNotReject(retryPromise)
    errorComparison.dispose()

    reply(mainWorker, {}, 0)
    assert.equal((await mainPromise).modelType, 'BPE')
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('a newer tokenizer identity cancels the old load and the loaded identity is reused', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    const oldPromise = comparison.inspectTokenizer(diffSnapshot('old'), {
      path: 'tokenizer.json', size: 31, hash: null, category: 'tokenizer',
    }, undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    const oldWorker = FakeWorker.created[0]
    const oldRequest = oldWorker.sent[0]
    assert.equal(oldRequest.operation, 'load')
    assert.equal(oldRequest.tokenizerIdentity, 'old/tokenizer.json+no-config')

    const newPromise = comparison.inspectTokenizer(diffSnapshot('new'), {
      path: 'tokenizer.json', size: 31, hash: null, category: 'tokenizer',
    }, undefined)
    await assert.rejects(oldPromise, isAbort)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(FakeWorker.created.length, 2)
    assert.equal(oldWorker.terminated, true)
    const newWorker = FakeWorker.created[1]
    const newRequest = newWorker.sent[0]
    assert.equal(newRequest.operation, 'load')
    assert.equal(newRequest.tokenizerIdentity, 'new/tokenizer.json+no-config')
    reply(newWorker, {}, 0)
    const loaded = await newPromise
    assert.equal(loaded.modelType, 'BPE')

    const loadCount = newWorker.sent.length
    await assert.doesNotReject(comparison.inspectTokenizer(diffSnapshot('new'), {
      path: 'tokenizer.json', size: 31, hash: null, category: 'tokenizer',
    }, undefined))
    assert.equal(newWorker.sent.length, loadCount)
    assert.equal(FakeWorker.created.length, 2)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('local load errors keep their original reason', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    const snapshot: LocalDirectorySnapshot = {
      ...localSnapshot('changed'),
      localFiles: new Map([['tokenizer.json', new File(['{}'], 'tokenizer.json')]]),
    }
    const changed = comparison.inspectTokenizer(snapshot, {
      path: 'tokenizer.json', size: 3, hash: null, category: 'tokenizer',
    }, undefined)
    await assert.rejects(changed, error => {
      assert.match((error as Error).message, /本地文件已变化/)
      assert.equal(isAbort(error), false)
      return true
    })
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('disposed sessions reject every API before input validation', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    const snapshot = localSnapshot('disposed')
    const file = { path: 'tokenizer.json', size: 2, hash: null, category: 'tokenizer' } as const
    comparison.dispose()
    await assert.rejects(comparison.chatTokenize(snapshot, file, undefined, 'x'.repeat(65 * 1024), {}, []), /已释放/)
    await assert.rejects(comparison.decodeTokenIds(snapshot, file, undefined, 'not ids'), /已释放/)
    await assert.rejects(comparison.searchTokenizerVocabulary(snapshot, file, undefined, ''), /已释放/)
    assert.equal(FakeWorker.created.length, 0)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('comparison vocabulary diff is isolated, cleared by reload, and rejected after disposal', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    const rightFile = { path: 'right/tokenizer.json', size: 2, hash: null, category: 'tokenizer' } as const
    const leftFile = { path: 'tokenizer.json', size: 31, hash: null, category: 'tokenizer' } as const
    const configFile = { path: 'right/tokenizer_config.json', size: 2, hash: null, category: 'tokenizer' } as const

    await assert.rejects(comparison.searchVocabularyDiff('shared', 'x'), /尚未准备/)
    const { rightSnapshot, leftSnapshot } = diffSnapshots('diff')
    assert.notEqual(rightSnapshot.selectionId, leftSnapshot.selectionId)
    const loadPromise = comparison.inspectTokenizer(rightSnapshot, rightFile, configFile)
    await new Promise(resolve => setTimeout(resolve, 0))
    const worker = FakeWorker.created[0]
    assert.equal(worker.sent[0].operation, 'load')
    reply(worker, {}, 0)
    await loadPromise

    const prepared = comparison.prepareVocabularyDiff(
      rightSnapshot,
      rightFile,
      configFile,
      leftSnapshot,
      leftFile,
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    const prepareRequest = worker.sent.at(-1)!
    assert.equal(prepareRequest.operation, 'prepare-vocabulary-diff')
    assert.equal(prepareRequest.tokenizerIdentity, 'diff-right/right/tokenizer.json+right/tokenizer_config.json')
    assert.equal(prepareRequest.leftFormat, 'json')
    assert.equal(
      new TextDecoder().decode(prepareRequest.tokenizerData as ArrayBuffer),
      '{"model":{"vocab":{"hello":3}}}',
    )
    reply(worker, {
      value: { leftOnlyCount: 1, rightOnlyCount: 2, sharedCount: 3 },
      operation: 'prepare-vocabulary-diff',
    }, -1)
    await prepared

    const requestCountBeforeOversized = worker.sent.length
    await assert.rejects(
      comparison.searchVocabularyDiff('shared', 'x'.repeat(64 * 1024 + 1)),
      /词表差集搜索输入超过 64 KiB 上限。/,
    )
    assert.equal(worker.sent.length, requestCountBeforeOversized)

    const searched = comparison.searchVocabularyDiff('leftOnly', ' X ')
    await Promise.resolve()
    const searchRequest = worker.sent.at(-1)!
    assert.equal(searchRequest.operation, 'search-vocabulary-diff')
    assert.equal(searchRequest.scope, 'leftOnly')
    assert.equal(searchRequest.query, 'X')
    reply(worker, {
      value: { total: 1, pieces: ['x'] },
      operation: 'search-vocabulary-diff',
    }, -1)
    await searched

    comparison.dispose()
    const replacement = createComparisonTokenizerSession()
    comparisons.push(replacement)
    const reloaded = replacement.inspectTokenizer(diffSnapshots('next').rightSnapshot, rightFile, configFile)
    await new Promise(resolve => setTimeout(resolve, 0))
    const nextWorker = FakeWorker.created.at(-1)!
    await assert.rejects(replacement.searchVocabularyDiff('shared', ''), /尚未准备|尚未加载/)
    reply(nextWorker, {}, 0)
    await assert.doesNotReject(reloaded)

    replacement.dispose()
    await assert.rejects(replacement.prepareVocabularyDiff(
      localSnapshot('next'), rightFile, configFile, localSnapshot('next'), leftFile,
    ), /已释放/)
    await assert.rejects(replacement.searchVocabularyDiff('shared', ''), /已释放/)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('main vocabulary search remains available beside comparison replies', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const snapshot = localSnapshot('search')
    const file = { path: 'tokenizer.json', size: 2, hash: null, category: 'tokenizer' } as const
    const mainPromise = mainTokenizerSession.searchTokenizerVocabulary(snapshot, file, undefined, 'hello')
    await new Promise(resolve => setTimeout(resolve, 0))
    const mainWorker = FakeWorker.created[0]
    assert.equal(mainWorker.sent[0].operation, 'load')
    reply(mainWorker, {}, 0)

    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    assert.rejects(comparison.searchVocabularyDiff('shared', 'hello'), /尚未准备/).catch(() => {})
    comparison.dispose()

    await new Promise(resolve => setTimeout(resolve, 0))
    const searchIndex = mainWorker.sent.findIndex(request => request.operation === 'search-vocabulary')
    assert.notEqual(searchIndex, -1)
    reply(mainWorker, { value: [{ tokenId: 3, token: 'hello', scalarLength: 5 }] }, searchIndex)
    assert.deepEqual(await mainPromise, [{ tokenId: 3, token: 'hello', scalarLength: 5 }])
    assert.equal(mainWorker.terminated, false)
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('rejects malformed vocabulary diff replies without poisoning the session', { timeout: 1_000 }, async () => {
  const originalWorker = installFakeWorker()
  const comparisons: TokenizerSession[] = []
  try {
    const comparison = createComparisonTokenizerSession()
    comparisons.push(comparison)
    const snapshot = localSnapshot('malformed')
    const rightFile = { path: 'tokenizer.json', size: 2, hash: null, category: 'tokenizer' } as const
    const loadPromise = comparison.inspectTokenizer(snapshot, rightFile, undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    const worker = FakeWorker.created[0]
    reply(worker, {}, 0)
    await assert.doesNotReject(loadPromise)

    const malformedCounts: unknown[] = [
      null,
      { leftOnlyCount: 1, rightOnlyCount: 2 },
      { leftOnlyCount: 1, rightOnlyCount: 2, sharedCount: 3, extra: true },
      { leftOnlyCount: -1, rightOnlyCount: 2, sharedCount: 3 },
      { leftOnlyCount: 1.2, rightOnlyCount: 2, sharedCount: 3 },
    ]
    for (const value of malformedCounts) {
      assert.throws(() => validateTokenizerVocabularyDiffCounts(value), /差集统计/)
    }
    const malformedPages: unknown[] = [
      null,
      { total: 1 },
      { total: 1, pieces: ['a'], extra: true },
      { total: 1, pieces: Array.from({ length: 1_001 }, () => 'a') },
      { total: 1, pieces: ['b', 'a'] },
      { total: 0, pieces: ['a'] },
      { total: 1, pieces: [1] },
    ]
    for (const value of malformedPages) {
      assert.throws(() => validateTokenizerVocabularyDiffSearch(value), /差集结果/)
    }

    const badPrepare = comparison.prepareVocabularyDiff(snapshot, rightFile, undefined, snapshot, rightFile)
    await new Promise(resolve => setTimeout(resolve, 0))
    reply(worker, {
      value: { leftOnlyCount: 1, rightOnlyCount: 2 },
      operation: 'prepare-vocabulary-diff',
    }, -1)
    await assert.rejects(badPrepare, /差集统计/)
    assert.equal(worker.terminated, false)

    const goodSearch = comparison.searchVocabularyDiff('shared', '')
    await new Promise(resolve => setTimeout(resolve, 0))
    reply(worker, {
      value: { total: 0, pieces: [] },
      operation: 'search-vocabulary-diff',
    }, -1)
    assert.deepEqual(await goodSearch, { total: 0, pieces: [] })
  }
  finally {
    cleanup(originalWorker, comparisons)
  }
})

test('isTokenizerRequest guards diff operations at the protocol boundary', () => {
  const base = {
    kind: 'request',
    sessionId: 'session',
    generation: 0,
    requestId: 1,
    tokenizerIdentity: '',
  }
  assert.equal(isTokenizerRequest({
    ...base,
    operation: 'prepare-vocabulary-diff',
    tokenizerIdentity: 'identity',
    leftFormat: 'json',
    tokenizerData: new ArrayBuffer(2),
  }), true)
  assert.equal(isTokenizerRequest({
    ...base,
    operation: 'prepare-vocabulary-diff',
    tokenizerIdentity: 'identity',
    tokenizerData: 'not-array-buffer',
  }), false)
  for (const scope of ['leftOnly', 'rightOnly', 'shared'] as const) {
    assert.equal(isTokenizerRequest({
      ...base,
      operation: 'search-vocabulary-diff',
      tokenizerIdentity: 'identity',
      scope,
      query: '',
    }), true)
  }
  assert.equal(isTokenizerRequest({
    ...base,
    operation: 'search-vocabulary-diff',
    tokenizerIdentity: 'identity',
    scope: 'invalid-scope',
    query: '',
  }), false)
  assert.equal(isTokenizerRequest({
    ...base,
    operation: 'search-vocabulary-diff',
    tokenizerIdentity: 'identity',
    scope: 'shared',
    query: 42,
  }), false)
  for (const leftFormat of ['json', 'sentencepiece'] as const) {
    assert.equal(isTokenizerRequest({
      ...base,
      operation: 'prepare-vocabulary-diff',
      tokenizerIdentity: 'identity',
      leftFormat,
      tokenizerData: new ArrayBuffer(2),
    }), true)
  }
  assert.equal(isTokenizerRequest({
    ...base,
    operation: 'prepare-vocabulary-diff',
    tokenizerIdentity: 'identity',
    leftFormat: 'unsupported',
    tokenizerData: new ArrayBuffer(2),
  }), false)
})
