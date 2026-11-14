import { translate as t } from '../i18n.ts'

import { formatBytes, type FileCategory, type RepositorySnapshot } from './huggingface.ts'
import { nativeInline, parseJsonNode } from './jsonValue.ts'

export type JsonSummaryGroup = { title: string; rows: Array<[string, string]> }
export type JsonSummary = { title: string; subtitle: string; prominent: boolean; groups: JsonSummaryGroup[]; mappings?: Array<[string, string]> }

export type Perspective = 'overview' | 'metadata' | 'tensors' | 'entries' | 'source' | 'playground' | 'fields' | 'raw'
export type PerspectiveDocument = 'generic' | 'safetensors' | 'gguf' | 'imatrix' | 'jinja' | 'pdf' | 'image'

// Mirrors native InspectionDocument.perspectives plus ModelFilesStore.availablePerspectives.
export function inspectionPerspectives(document: PerspectiveDocument, path: string): Perspective[] {
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  if (name.endsWith('.model')) return ['playground']
  switch (document) {
    case 'safetensors': case 'gguf': return ['overview', 'metadata', 'tensors']
    case 'imatrix': return ['overview', 'entries']
    case 'jinja': return ['overview', 'source', 'playground']
    case 'pdf': return ['overview']
    case 'image': return name.endsWith('.svg') ? ['overview', 'source'] : ['overview']
    case 'generic': return name === 'tokenizer.json' ? ['overview', 'fields', 'raw', 'playground'] : ['overview', 'fields', 'raw']
  }
}

export function perspectiveLabel(perspective: Perspective, document: PerspectiveDocument, path: string): string {
  const name = path.toLocaleLowerCase()
  switch (perspective) {
    case 'overview':
      if (name.endsWith('.svg') || (document === 'generic' && name.endsWith('.md'))) return t('readerRenderedView')
      if (document === 'pdf' || document === 'image') return t('readerPreviewView')
      return t('readerOverview')
    case 'metadata': return 'Metadata'
    case 'tensors': return 'Tensors'
    case 'entries': return 'Entries'
    case 'source': return t('templateSourceTab')
    case 'playground': return t('templatePlaygroundTab')
    case 'fields': return t('readerAllFields')
    case 'raw': return t('readerRawSource')
  }
}

export function decodeStrictText(data: ArrayBuffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new Error(t('invalidUtf8Text'))
  }
  if (text.includes('\0')) throw new Error(t('textContainsNulByte'))
  return text
}

export function validatePdfData(data: ArrayBuffer): void {
  const bytes = new Uint8Array(data, 0, Math.min(5, data.byteLength))
  if (bytes.length !== 5 || bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68
    || bytes[3] !== 70 || bytes[4] !== 45) throw new Error(t('invalidPdfSignature'))
}

export type JsonSummaryKind = 'config' | 'generation' | 'tokenizerConfig' | 'vocab' | 'weightIndex'

// Native FileReaderView.hasSpecializedSummary (tokenizer.json and Markdown have their own readers here).
export function jsonSummaryKind(path: string, category: FileCategory): JsonSummaryKind | null {
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  if (name === 'config.json' || name === 'configuration.json') return 'config'
  if (name === 'generation_config.json') return 'generation'
  if (name === 'tokenizer_config.json') return 'tokenizerConfig'
  if (name === 'vocab.json') return 'vocab'
  return category === 'weightMetadata' ? 'weightIndex' : null
}

// Native ConfigSummaryView / GenerationSummaryView / TokenizerSummaryView / WeightIndexSummaryView.
// An invalid or non-object source yields the empty summary, as native's `as? [String: Any] ?? [:]` does.
export function jsonSummary(kind: Exclude<JsonSummaryKind, 'vocab'>, source: string): JsonSummary {
  const root = parseJsonNode(source)
  const fields = new Map(root?.kind === 'object' ? root.entries : [])
  const value = (key: string) => {
    const node = fields.get(key)
    return node === undefined ? undefined : nativeInline(node)
  }
  const string = (key: string) => {
    const node = fields.get(key)
    return node?.kind === 'string' ? node.value : undefined
  }
  const group = (title: string, rows: Array<[string, string | undefined]>): JsonSummaryGroup => ({
    title, rows: rows.filter((row): row is [string, string] => row[1] !== undefined),
  })
  switch (kind) {
    case 'config': {
      const architectures = fields.get('architectures')
      const first = architectures?.kind === 'array' && architectures.items.every(item => item.kind === 'string')
        ? (architectures.items[0] as { value: string } | undefined)?.value : undefined
      const layers = value('num_hidden_layers')
      return {
        title: first ?? string('model_type') ?? t('summaryModelConfigTitle'),
        subtitle: [string('model_type'), string('torch_dtype'), layers === undefined ? undefined : `${layers} layers`]
          .filter(part => part !== undefined).join(' · '),
        prominent: true,
        groups: [
          group(t('summaryModelScale'), [
            [t('summaryHiddenSize'), value('hidden_size')],
            [t('summaryIntermediateSize'), value('intermediate_size')],
            [t('summaryVocabSize'), value('vocab_size')],
          ]),
          group('Attention', [
            [t('summaryAttentionHeads'), value('num_attention_heads')],
            [t('summaryKeyValueHeads'), value('num_key_value_heads')],
            [t('summaryHeadDim'), value('head_dim')],
          ]),
          group(t('summaryContext'), [
            [t('summaryMaxPositions'), value('max_position_embeddings')],
            [t('summaryRopeTheta'), value('rope_theta')],
          ]),
        ],
      }
    }
    case 'generation':
      return {
        title: t('summaryGenerationTitle'), subtitle: t('summaryGenerationSubtitle'), prominent: false,
        groups: [
          group(t('summarySampling'), [
            ['Do sample', value('do_sample')], ['Temperature', value('temperature')],
            ['Top P', value('top_p')], ['Top K', value('top_k')],
          ]),
          group(t('summaryStopAndLength'), [
            ['EOS token', value('eos_token_id')], ['PAD token', value('pad_token_id')],
            [t('summaryMaxNewTokens'), value('max_new_tokens')], [t('summaryRepetitionPenalty'), value('repetition_penalty')],
          ]),
        ],
      }
    case 'tokenizerConfig':
      return {
        title: string('tokenizer_class') ?? t('summaryTokenizerConfigTitle'), subtitle: t('summaryTokenizerConfigSubtitle'),
        prominent: false,
        groups: [group(t('summaryCoreSettings'), [
          [t('summaryMaxLength'), value('model_max_length')], ['Padding side', value('padding_side')],
          ['BOS token', value('bos_token')], ['EOS token', value('eos_token')], ['UNK token', value('unk_token')],
        ])],
      }
    case 'weightIndex': {
      const map = fields.get('weight_map')
      const entries = map?.kind === 'object' && map.entries.every(([, item]) => item.kind === 'string')
        ? map.entries.map(([key, item]): [string, string] => [key, (item as { value: string }).value]) : []
      const metadata = fields.get('metadata')
      const total = metadata?.kind === 'object' ? new Map(metadata.entries).get('total_size') : undefined
      return {
        title: t('summaryWeightIndexTitle'), subtitle: t('summaryWeightIndexSubtitle'), prominent: false,
        groups: [group(t('summaryOverview'), [
          [t('summaryParameterTensors'), String(entries.length)],
          [t('summaryShardCount'), String(new Set(entries.map(([, shard]) => shard)).size)],
          // NSNumber → Int64(truncating:) → ByteCountFormatter.
          [t('summaryTotalWeightSize'), total?.kind === 'number' ? formatBytes(Math.trunc(Number(total.lexeme))) : undefined],
        ])],
        mappings: entries.toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).slice(0, 80),
      }
    }
  }
}

// Native VocabView: integer IDs only, filtered by token (case-insensitive) or ID digits, sorted by ID.
export function vocabEntries(value: unknown, query: string): Array<[string, number]> {
  if (!isRecord(value)) return []
  const term = query.toLocaleLowerCase()
  return Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .filter(([token, id]) => term === '' || token.toLocaleLowerCase().includes(term) || String(id).includes(query))
    .toSorted(([, left], [, right]) => left - right)
}

export type SourceChunk = { start: number; end: number; firstLine: number; lineCount: number }

// Lazy-rendering units: cut at line starts after `maxLines` lines or before passing `maxChars`.
// A line longer than `maxLineChars` (minified JSON) is cut into pieces; a piece's first row continues the
// previous chunk's last line (same line number). Cuts never split a surrogate pair or CRLF.
// ponytail: 4K-character pieces keep WebKit's no-wrap text layout fast; native shows one unbroken line.
export function sourceChunks(content: string, maxLines = 400, maxChars = 64 * 1024, maxLineChars = 4 * 1024): SourceChunk[] {
  const chunks: SourceChunk[] = []
  const breaks = /\r\n|\r|\n/g
  let start = 0
  let firstLine = 1
  let lineCount = 0
  let line = 1
  const flush = (end: number, rows: number) => {
    chunks.push({ start, end, firstLine, lineCount: rows })
    start = end
  }
  for (let lineStart = 0; lineStart < content.length; line += 1) {
    breaks.lastIndex = lineStart
    const match = breaks.exec(content)
    const lineEnd = match === null ? content.length : match.index + match[0].length
    if (lineCount > 0 && (lineCount >= maxLines || lineEnd - start > maxChars)) {
      flush(lineStart, lineCount)
      firstLine = line
      lineCount = 0
    }
    while (lineEnd - start > Math.min(maxChars, maxLineChars)) {
      let cut = start + Math.min(maxChars, maxLineChars)
      if (/[\uDC00-\uDFFF]/.test(content[cut]) && /[\uD800-\uDBFF]/.test(content[cut - 1]) || content.startsWith('\r\n', cut - 1)) cut += 1
      flush(cut, lineCount + 1)
      firstLine = line
      lineCount = 0
    }
    if (start === lineEnd) firstLine = line + 1 // the last cut swallowed a CRLF ending
    else lineCount += 1
    lineStart = lineEnd
  }
  if (start < content.length || chunks.length === 0) chunks.push({ start, end: content.length, firstLine, lineCount: Math.max(lineCount, 1) })
  return chunks
}

export type TextFindNavigation = 'initial' | 'next' | 'previous'
export type TextFindState = { total: number; current: number; start: number; end: number }
// AppKit find bar menu (NSTextFinder): 忽略大小写 / 循环查找 (both on by default), 包含 / 开头是 / 整个词.
export type TextMatchType = 'contains' | 'startsWith' | 'fullWord'
export type TextFindOptions = { ignoreCase: boolean; wrapAround: boolean; matchType: TextMatchType }
export const defaultTextFindOptions: TextFindOptions = { ignoreCase: true, wrapAround: true, matchType: 'contains' }

export function navigateTextMatches(
  content: string,
  query: string,
  navigation: TextFindNavigation,
  current = 0,
  options: TextFindOptions = defaultTextFindOptions,
): TextFindState {
  if (query === '') return { total: 0, current: 0, start: 0, end: 0 }
  let total = 0
  let first = -1
  forEachTextMatch(content, query, (index) => {
    if (first === -1) first = index
    total++
  }, options)
  if (total === 0) return { total, current: 0, start: 0, end: 0 }

  const wrap = options.wrapAround
  const ordinal = navigation === 'initial'
    ? 0
    : navigation === 'next'
      ? wrap ? (current % total + total) % total : Math.min(Math.max(current, 0), total - 1)
      : wrap ? ((current - 2) % total + total) % total : Math.min(Math.max(current - 2, 0), total - 1)
  let start = first
  let seen = 0
  forEachTextMatch(content, query, (index) => {
    if (seen++ === ordinal) start = index
  }, options)
  return { total, current: ordinal + 1, start, end: start + query.length }
}

// ponytail: word edges are letters, digits, marks and "_" (close to ICU word breaks, which NSTextFinder uses);
// scripts without spaces (CJK) count every ideograph as a word character here.
const wordCharacter = '[\\p{L}\\p{N}\\p{M}_]'

export function forEachTextMatch(
  content: string,
  query: string,
  visit: (start: number) => void,
  options: TextFindOptions = defaultTextFindOptions,
): void {
  let source = query.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')
  if (options.matchType !== 'contains') source = `(?<!${wordCharacter})${source}`
  if (options.matchType === 'fullWord') source = `${source}(?!${wordCharacter})`
  const pattern = new RegExp(source, options.ignoreCase ? 'giu' : 'gu')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    visit(match.index)
    if (match[0] === '') pattern.lastIndex++
  }
}

export function textLineAtOffset(content: string, offset: number): number {
  const end = Math.max(0, Math.min(offset, content.length))
  let lines = 1
  for (let index = 0; index < end; index++) {
    if (content.charCodeAt(index) !== 13 && content.charCodeAt(index) !== 10) continue
    lines++
    if (content.charCodeAt(index) === 13 && content.charCodeAt(index + 1) === 10) index++
  }
  return lines
}

export function repositoryMarkdownUrl(
  snapshot: RepositorySnapshot,
  filePath: string,
  value: string,
  attribute: 'href' | 'src',
): string | null {
  try {
    if (value.startsWith('#')) return value
    const absolute = new URL(value, 'https://relative.invalid/')
    if (absolute.origin !== 'https://relative.invalid') {
      if (absolute.protocol === 'https:' || absolute.protocol === 'http:'
        || attribute === 'href' && absolute.protocol === 'mailto:') return absolute.href
      return null
    }
    if (snapshot.source === 'local') return null
    if (snapshot.source === 'https') {
      const sourceUrl = snapshot.urls.get(filePath)
      if (sourceUrl === undefined) return null
      const resolved = new URL(value, sourceUrl)
      return resolved.protocol === 'https:' ? resolved.href : null
    }
    const resolved = new URL(value, `https://relative.invalid/${encodePath(filePath)}`)
    const path = resolved.pathname.split('/').filter(Boolean).map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/')
    const action = attribute === 'src' ? 'resolve' : 'blob'
    return `https://huggingface.co/${encodePath(snapshot.modelId)}/${action}/${snapshot.revision}/${path}${resolved.search}${resolved.hash}`
  } catch {
    return null
  }
}






function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}


function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
