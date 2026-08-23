import type { RepositoryFile, RepositorySnapshot } from './huggingface.ts'
import type { ChatTokenOverhead, ChatTokenRole } from './tokenAttribution.ts'
import type { ChatTemplateCatalog } from './chatTemplates.ts'

export type TokenSegment = {
  start: number
  end: number
  ids: number[]
  text: string
}

export type TokenFlag = { isSpecial: boolean; specialName: string | null }

export type Tokenization = {
  direction: 'encode' | 'decode'
  input: string
  ids: number[]
  pieces: Array<string | null>
  decoded: string
  segments: TokenSegment[]
  mapping: 'Exact' | 'Decoded only'
  flags: TokenFlag[]
  overhead: ChatTokenOverhead | null
  roles: ChatTokenRole[] | null
}

export type TokenizerField = { name: string; detail: string }
export type TokenizerVocabularyEntry = { tokenId: number; token: string; scalarLength: number }
export type TokenizerVocabularyAnalysis = {
  tokenCount: number
  averageScalarLength: number
  p50ScalarLength: number
  p90ScalarLength: number
  p95ScalarLength: number
  p99ScalarLength: number
  maximumScalarLength: number
  buckets: Array<{ label: string; count: number }>
  longestTokens: TokenizerVocabularyEntry[]
}
export type AddedTokenSummary = { id: number | null; content: string; special: boolean }
export type TokenizerStructure = {
  version: string | null
  modelType: string | null
  vocabCount: number | null
  mergeCount: number | null
  addedTokenCount: number | null
  addedTokens: AddedTokenSummary[]
  fields: TokenizerField[]
  vocabulary: TokenizerVocabularyAnalysis | null
  vocabularyError: string | null
  chatTemplates: ChatTemplateCatalog
}

export type TokenizerComparisonSummary = {
  leftCount: number
  rightCount: number
  countDelta: number
  idsMatch: boolean
  firstDifference: { index: number; leftId: number | null; rightId: number | null } | null
  leftTemplateOverhead: number | null
  rightTemplateOverhead: number | null
}

export type TokenizerComparisonTarget = {
  file: RepositoryFile
  config: RepositoryFile | undefined
  templateFile: RepositoryFile | undefined
}

export type VocabularyDiff = {
  leftOnly: string[]
  rightOnly: string[]
  shared: string[]
}

export type VocabularyDiffScope = 'leftOnly' | 'rightOnly' | 'shared'

export type VocabularyDiffSearch = { total: number; pieces: string[] }

export function compareTokenizerTokenizations(
  left: { ids: readonly number[]; overhead: { templateCount: number } | null },
  right: { ids: readonly number[]; overhead: { templateCount: number } | null },
): TokenizerComparisonSummary {
  let index = 0
  while (index < left.ids.length && index < right.ids.length && left.ids[index] === right.ids[index]) index += 1
  return {
    leftCount: left.ids.length,
    rightCount: right.ids.length,
    countDelta: right.ids.length - left.ids.length,
    idsMatch: left.ids.length === right.ids.length && index === left.ids.length,
    firstDifference: index === left.ids.length && index === right.ids.length ? null : {
      index,
      leftId: index < left.ids.length ? left.ids[index] : null,
      rightId: index < right.ids.length ? right.ids[index] : null,
    },
    leftTemplateOverhead: left.overhead?.templateCount ?? null,
    rightTemplateOverhead: right.overhead?.templateCount ?? null,
  }
}

export function selectTokenizerComparisonTargets(
  snapshot: Pick<RepositorySnapshot, 'files'>,
): TokenizerComparisonTarget[] {
  return snapshot.files.flatMap((file): TokenizerComparisonTarget[] => {
    if (file.path.split('/').at(-1) !== 'tokenizer.json') return []
    const config = companion(snapshot.files, file.path, 'tokenizer_config.json')
    return [{
      file,
      config,
      templateFile: companion(snapshot.files, file.path, 'chat_template.jinja'),
    }]
  })
}

function companion(files: RepositoryFile[], path: string, basename: string) {
  const parts = path.split('/')
  parts.pop()
  parts.push(basename)
  const target = parts.join('/')
  return files.find(file => file.path === target)
}

export function buildTokenizerVocabularyDiff(
  left: TokenizerVocabularyEntry[],
  right: TokenizerVocabularyEntry[],
): VocabularyDiff {
  const leftPieces = new Set(left.map(entry => entry.token))
  const rightPieces = new Set(right.map(entry => entry.token))
  const compareCodePoints = (left: string, right: string) => {
    const leftPoints = Array.from(left)
    const rightPoints = Array.from(right)
    for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
      if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] < rightPoints[index] ? -1 : 1
    }
    return leftPoints.length - rightPoints.length
  }
  return {
    leftOnly: [...leftPieces].filter(piece => !rightPieces.has(piece)).toSorted(compareCodePoints),
    rightOnly: [...rightPieces].filter(piece => !leftPieces.has(piece)).toSorted(compareCodePoints),
    shared: [...leftPieces].filter(piece => rightPieces.has(piece)).toSorted(compareCodePoints),
  }
}

export function filterTokenizerVocabularyDiff(
  diff: VocabularyDiff,
  scope: VocabularyDiffScope,
  query: string,
): VocabularyDiffSearch {
  const term = query.trim().toLocaleLowerCase()
  const pieces = term === '' ? diff[scope] : diff[scope].filter(piece => piece.toLocaleLowerCase().includes(term))
  return { total: pieces.length, pieces: pieces.slice(0, 1_000) }
}

export function tokenizerBundleBytes(tokenizerFile: RepositoryFile, configFile?: RepositoryFile): number {
  const tokenizerParts = tokenizerFile.path.split('/')
  const configParts = configFile?.path.split('/')
  if (tokenizerParts.pop() !== 'tokenizer.json' || configParts !== undefined
    && (configParts.pop() !== 'tokenizer_config.json' || tokenizerParts.join('/') !== configParts.join('/'))) {
    throw new Error('Tokenizer 资源必须是同目录的 tokenizer.json 与 tokenizer_config.json。')
  }
  if (tokenizerFile.size === null || configFile?.size === null) {
    throw new Error('仓库未提供完整的 tokenizer 资源大小，已拒绝加载。')
  }
  const total = tokenizerFile.size + (configFile?.size ?? 0)
  if (total > 32 * 1024 * 1024) throw new Error('Tokenizer 资源超过 32 MiB 上限。')
  return total
}

export function inspectTokenizerStructure(value: unknown): TokenizerStructure {
  if (!isRecord(value)) throw new Error('tokenizer.json 根节点不是对象。')
  const model = isRecord(value.model) ? value.model : null
  const rawVocabulary = model?.vocab
  const vocabCount = isRecord(rawVocabulary) || Array.isArray(rawVocabulary) ? Object.keys(rawVocabulary).length : null
  const entries = vocabularyEntries(rawVocabulary)
  return {
    version: typeof value.version === 'string' ? value.version : null,
    modelType: typeof model?.type === 'string' ? model.type : null,
    vocabCount,
    mergeCount: Array.isArray(model?.merges) ? model.merges.length : null,
    addedTokenCount: Array.isArray(value.added_tokens) ? value.added_tokens.length : null,
    addedTokens: summarizeAddedTokens(value.added_tokens),
    fields: Object.keys(value).toSorted().map(name => ({ name, detail: describeValue(value[name]) })),
    vocabulary: entries.entries === null ? null : analyzeVocabulary(entries.entries),
    vocabularyError: entries.error,
    chatTemplates: { entries: [], activeId: null, conflict: false },
  }
}

export function buildTokenization(
  input: string,
  ids: number[],
  pieces: Array<string | null>,
  decoded: string,
  decode: (ids: number[]) => string,
  flags: TokenFlag[],
  direction: 'encode' | 'decode' = 'encode',
  overhead: ChatTokenOverhead | null = null,
): Tokenization {
  if (ids.length !== pieces.length) throw new Error('Tokenizer 返回的 ID 与 piece 数量不一致。')
  if (ids.length !== flags.length) throw new Error('Tokenizer 返回的 ID 与 flags 数量不一致。')
  // ponytail: Large runs stay one grapheme-safe authoritative group; chunk them only if per-token highlighting becomes necessary.
  if (ids.length > 2_000) return authoritativeTokenization(input, ids, pieces, decoded, flags, direction, overhead)
  const provisional: TokenSegment[] = []
  for (let start = 0; start < ids.length;) {
    let end = start + 1
    let text = decode(ids.slice(start, end))
    while (end < ids.length && (text === '' || text.includes('\uFFFD'))) {
      end += 1
      text = decode(ids.slice(start, end))
    }
    provisional.push({ start, end, ids: ids.slice(start, end), text })
    start = end
  }

  let segments = provisional
  if (provisional.map(segment => segment.text).join('') !== decoded) {
    segments = ids.length === 0 ? [] : [{ start: 0, end: ids.length, ids: [...ids], text: decoded }]
  } else {
    segments = mergeAcrossGraphemeBoundaries(provisional, decoded)
  }
  return {
    ids,
    pieces,
    decoded,
    segments,
    mapping: direction === 'encode' && segments.map(segment => segment.text).join('') === input && decoded === input ? 'Exact' : 'Decoded only',
    direction,
    input,
    flags,
    overhead,
    roles: null,
  }
}

function authoritativeTokenization(
  input: string,
  ids: number[],
  pieces: Array<string | null>,
  decoded: string,
  flags: TokenFlag[],
  direction: 'encode' | 'decode',
  overhead: ChatTokenOverhead | null = null,
): Tokenization {
  return {
    direction,
    input,
    ids,
    pieces,
    decoded,
    segments: ids.length === 0 ? [] : [{ start: 0, end: ids.length, ids: [...ids], text: decoded }],
    mapping: direction === 'encode' && decoded === input ? 'Exact' : 'Decoded only',
    flags,
    overhead,
    roles: null,
  }
}

export function parseTokenIds(input: string): number[] {
  if (new TextEncoder().encode(input).byteLength > 64 * 1024) throw new Error('Token ID 输入超过 64 KiB 上限。')
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new Error('Token ID 输入为空。')
  let rawValues: unknown[]
  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(`Token ID JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(parsed)) throw new Error('Token ID JSON 必须是数组。')
    if (parsed.length === 0) throw new Error('Token ID 输入为空。')
    rawValues = parsed
  } else {
    rawValues = trimmed.split(/[\s,]+/)
  }
  return rawValues.map((value, index): number => {
    const id = typeof value === 'string' ? Number(value.trim()) : value
    if (typeof value === 'boolean' || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
      throw new Error(`第 ${index + 1} 个 Token 无效（zero-based index ${index}）：${String(value)}。`)
    }
    return id
  })
}

export function buildTokenizerVocabularyIndex(value: unknown): {
  entries: TokenizerVocabularyEntry[] | null
  error: string | null
} {
  const parsed = vocabularyEntries(value)
  if (parsed.entries === null) return { entries: null, error: parsed.error }
  return {
    entries: parsed.entries.toSorted((left, right) => left.id - right.id).map((entry): TokenizerVocabularyEntry => ({
      tokenId: entry.id,
      token: entry.token,
      scalarLength: Array.from(entry.token).length,
    })),
    error: null,
  }
}

export function filterTokenizerVocabulary(
  entries: TokenizerVocabularyEntry[],
  query: string,
): TokenizerVocabularyEntry[] {
  const term = query.trim()
  if (term.length === 0) return []
  const lowerTerm = term.toLocaleLowerCase()
  return entries.filter(entry => entry.token.toLocaleLowerCase().includes(lowerTerm)
    || String(entry.tokenId).includes(term)).slice(0, 1_000)
}

export type SpecialTokenIndex = {
  byId: Map<number, string>
  byPiece: Map<string, string>
}

export function buildSpecialTokenIndex(
  config: Record<string, unknown>,
  addedTokens: unknown[],
  resolvePieceIds: (piece: string) => number[],
): SpecialTokenIndex {
  const index: SpecialTokenIndex = { byId: new Map(), byPiece: new Map() }
  const candidates: Array<{ piece: string; name: string }> = []
  for (const key of ['bos', 'eos', 'pad', 'unk', 'cls', 'sep', 'mask']) {
    const field = `${key}_token`
    const token = config[field]
    const piece = typeof token === 'string' ? token : isRecord(token) && typeof token.content === 'string' ? token.content : ''
    if (piece) candidates.push({ piece, name: field })
  }
  for (const token of Array.isArray(config.additional_special_tokens) ? config.additional_special_tokens : []) {
    const piece = typeof token === 'string' ? token : isRecord(token) && typeof token.content === 'string' ? token.content : ''
    if (piece) candidates.push({ piece, name: piece })
  }
  const seenPieces = new Set<string>()
  for (const candidate of candidates) {
    if (seenPieces.has(candidate.piece)) continue
    seenPieces.add(candidate.piece)
    index.byPiece.set(candidate.piece, candidate.name)
    const ids = [...new Set(resolvePieceIds(candidate.piece))].filter((id) => safeNonNegativeInteger(id) !== null)
    if (ids.length !== 1) continue
    index.byId.set(ids[0], candidate.name)
  }
  for (const raw of addedTokens) {
    if (!isRecord(raw) || raw.special !== true || typeof raw.content !== 'string' || raw.content === '') continue
    const id = safeNonNegativeInteger(raw.id)
    if (id === null) continue
    const name = index.byPiece.get(raw.content) ?? raw.content
    index.byId.set(id, name)
    if (!index.byPiece.has(raw.content)) index.byPiece.set(raw.content, name)
  }
  return index
}

export function tokenFlag(
  id: number,
  piece: string | null,
  index: SpecialTokenIndex,
  coldFallback?: () => string | null,
): TokenFlag {
  const specialName = index.byId.get(id)
  if (specialName !== undefined) return { isSpecial: true, specialName }
  if (piece !== null && piece !== '') {
    const byPiece = index.byPiece.get(piece)
    return { isSpecial: byPiece !== undefined, specialName: byPiece ?? null }
  }
  const fallbackName = coldFallback?.() ?? null
  if (fallbackName !== null && fallbackName !== '') {
    const matched = index.byPiece.get(fallbackName)
    if (matched !== undefined) return { isSpecial: true, specialName: matched }
  }
  return { isSpecial: false, specialName: null }
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function summarizeAddedTokens(value: unknown): AddedTokenSummary[] {
  if (!Array.isArray(value)) return []
  const tokens: AddedTokenSummary[] = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.content !== 'string'
      || !(raw.id === null || safeNonNegativeInteger(raw.id) !== null)) continue
    tokens.push({
      id: safeNonNegativeInteger(raw.id),
      content: raw.content,
      special: typeof raw.special === 'boolean' ? raw.special : false,
    })
  }
  return tokens
}

function mergeAcrossGraphemeBoundaries(segments: TokenSegment[], decoded: string): TokenSegment[] {
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(decoded), item => (
    item.index + item.segment.length
  )))
  const result: TokenSegment[] = []
  let current: TokenSegment | null = null
  let decodedOffset = 0
  for (const segment of segments) {
    if (current === null) {
      current = { ...segment, ids: [...segment.ids] }
    } else {
      current.end = segment.end
      current.ids.push(...segment.ids)
      current.text += segment.text
    }
    decodedOffset += segment.text.length
    if (boundaries.has(decodedOffset)) {
      result.push(current)
      current = null
    }
  }
  if (current !== null) result.push(current)
  return result
}

function vocabularyEntries(value: unknown): {
  entries: Array<{ id: number; token: string }> | null
  error: string | null
} {
  if (isRecord(value)) {
    const entries: Array<{ id: number; token: string }> = []
    const ids = new Set<number>()
    for (const [token, rawId] of Object.entries(value)) {
      if (!Number.isSafeInteger(rawId) || Number(rawId) < 0 || ids.has(Number(rawId))) {
        return { entries: null, error: '词表包含重复或无效 Token ID，无法分析。' }
      }
      ids.add(Number(rawId))
      entries.push({ id: Number(rawId), token })
    }
    return { entries, error: null }
  }
  if (Array.isArray(value)) {
    const entries: Array<{ id: number; token: string }> = []
    for (const [id, item] of value.entries()) {
      if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== 'string'
        || typeof item[1] !== 'number' || !Number.isFinite(item[1])) {
        return { entries: null, error: 'Unigram 词表结构无效，无法分析。' }
      }
      entries.push({ id, token: item[0] })
    }
    return { entries, error: null }
  }
  return { entries: null, error: '未识别 model.vocab，无法分析。' }
}

function analyzeVocabulary(entries: Array<{ id: number; token: string }>): TokenizerVocabularyAnalysis | null {
  if (entries.length === 0) return null
  const lengths = entries.map(entry => Array.from(entry.token).length)
  const sortedLengths = lengths.toSorted((left, right) => left - right)
  const counts = Array.from({ length: 9 }, () => 0)
  for (const length of lengths) counts[bucketIndex(length)] += 1
  const labels = ['0', '1', '2', '3–4', '5–8', '9–16', '17–32', '33–64', '65+']
  const buckets = labels.map((label, index) => ({ label, count: counts[index] }))
  if (counts[0] === 0) buckets.shift()
  const longestTokens = entries.map((entry): TokenizerVocabularyEntry => ({
    tokenId: entry.id,
    token: entry.token,
    scalarLength: Array.from(entry.token).length,
  })).toSorted((left, right) => right.scalarLength - left.scalarLength
    || left.tokenId - right.tokenId || left.token.localeCompare(right.token)).slice(0, 50)
  return {
    tokenCount: entries.length,
    averageScalarLength: lengths.reduce((sum, length) => sum + length, 0) / entries.length,
    p50ScalarLength: percentile(sortedLengths, 0.5),
    p90ScalarLength: percentile(sortedLengths, 0.9),
    p95ScalarLength: percentile(sortedLengths, 0.95),
    p99ScalarLength: percentile(sortedLengths, 0.99),
    maximumScalarLength: sortedLengths.at(-1) ?? 0,
    buckets,
    longestTokens,
  }
}

function percentile(sorted: number[], fraction: number): number {
  const rank = Math.ceil(sorted.length * fraction)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

function bucketIndex(length: number): number {
  if (length <= 2) return length
  if (length <= 4) return 3
  if (length <= 8) return 4
  if (length <= 16) return 5
  if (length <= 32) return 6
  if (length <= 64) return 7
  return 8
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组 · ${value.length.toLocaleString()} 项`
  if (isRecord(value)) {
    const suffix = typeof value.type === 'string' ? ` · type: ${value.type}` : ''
    return `对象 · ${Object.keys(value).length.toLocaleString()} 字段${suffix}`
  }
  if (typeof value === 'string') return Array.from(value).length > 80 ? `字符串 · ${Array.from(value).length.toLocaleString()} 字符` : value
  return String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
