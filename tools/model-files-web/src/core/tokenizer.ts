import type { RepositoryFile } from './huggingface.ts'

export type TokenSegment = {
  start: number
  end: number
  ids: number[]
  text: string
}

export type Tokenization = {
  ids: number[]
  pieces: string[]
  decoded: string
  segments: TokenSegment[]
  mapping: 'Exact' | 'Decoded only'
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
export type TokenizerStructure = {
  version: string | null
  modelType: string | null
  vocabCount: number | null
  mergeCount: number | null
  addedTokenCount: number | null
  fields: TokenizerField[]
  vocabulary: TokenizerVocabularyAnalysis | null
  vocabularyError: string | null
  chatTemplate: string | null
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
    fields: Object.keys(value).toSorted().map(name => ({ name, detail: describeValue(value[name]) })),
    vocabulary: entries.entries === null ? null : analyzeVocabulary(entries.entries),
    vocabularyError: entries.error,
    chatTemplate: null,
  }
}

export function buildTokenization(
  input: string,
  ids: number[],
  pieces: string[],
  decoded: string,
  decode: (ids: number[]) => string,
): Tokenization {
  if (ids.length !== pieces.length) throw new Error('Tokenizer 返回的 ID 与 piece 数量不一致。')
  // ponytail: Large runs stay one grapheme-safe authoritative group; chunk them only if per-token highlighting becomes necessary.
  if (ids.length > 2_000) return authoritativeTokenization(input, ids, pieces, decoded)
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
    mapping: segments.map(segment => segment.text).join('') === input && decoded === input ? 'Exact' : 'Decoded only',
  }
}

function authoritativeTokenization(input: string, ids: number[], pieces: string[], decoded: string): Tokenization {
  return {
    ids,
    pieces,
    decoded,
    segments: ids.length === 0 ? [] : [{ start: 0, end: ids.length, ids: [...ids], text: decoded }],
    mapping: decoded === input ? 'Exact' : 'Decoded only',
  }
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
    return entries.length === 0
      ? { entries: null, error: '词表为空，无法分析。' }
      : { entries, error: null }
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
    return entries.length === 0
      ? { entries: null, error: '词表为空，无法分析。' }
      : { entries, error: null }
  }
  return { entries: null, error: '未识别 model.vocab，无法分析。' }
}

function analyzeVocabulary(entries: Array<{ id: number; token: string }>): TokenizerVocabularyAnalysis {
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
