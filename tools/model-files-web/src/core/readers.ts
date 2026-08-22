import type { RepositorySnapshot } from './huggingface.ts'

export type JsonSummary = { title: string; facts: Array<[string, string]> }

export function decodeStrictText(data: ArrayBuffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new Error('文本不是有效的 UTF-8。')
  }
  if (text.includes('\0')) throw new Error('文本包含 NUL 字节。')
  return text
}

export function validatePdfData(data: ArrayBuffer): void {
  const bytes = new Uint8Array(data, 0, Math.min(5, data.byteLength))
  if (bytes.length !== 5 || bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68
    || bytes[3] !== 70 || bytes[4] !== 45) throw new Error('不是有效的 PDF 文件签名。')
}

export function summarizeJson(path: string, value: unknown): JsonSummary {
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  if (!isRecord(value)) return { title: 'JSON', facts: [['根类型', Array.isArray(value) ? '数组' : typeof value]] }
  if (name === 'config.json' || name === 'configuration.json') {
    return { title: 'Model Config', facts: compactFacts([
      ['模型类型', scalar(value.model_type)],
      ['架构', stringList(value.architectures)],
      ['Hidden Size', scalar(value.hidden_size)],
      ['层数', scalar(value.num_hidden_layers ?? value.n_layer)],
      ['词表大小', scalar(value.vocab_size)],
      ['数据类型', scalar(value.torch_dtype ?? value.dtype)],
    ]) }
  }
  if (name === 'generation_config.json') {
    return { title: 'Generation Config', facts: compactFacts([
      ['最大长度', scalar(value.max_new_tokens ?? value.max_length)],
      ['采样', scalar(value.do_sample)],
      ['Temperature', scalar(value.temperature)],
      ['Top P', scalar(value.top_p)],
      ['BOS Token ID', scalar(value.bos_token_id)],
      ['EOS Token ID', scalar(value.eos_token_id)],
    ]) }
  }
  if (name === 'tokenizer_config.json') {
    return { title: 'Tokenizer Config', facts: compactFacts([
      ['Tokenizer Class', scalar(value.tokenizer_class)],
      ['最大长度', scalar(value.model_max_length)],
      ['BOS Token', tokenText(value.bos_token)],
      ['EOS Token', tokenText(value.eos_token)],
      ['Chat Template', typeof value.chat_template === 'string' ? `${new TextEncoder().encode(value.chat_template).byteLength} bytes` : undefined],
    ]) }
  }
  if (isWeightIndex(name)) {
    const weightMap = isRecord(value.weight_map) ? value.weight_map : {}
    const shards = new Set(Object.values(weightMap).filter((item): item is string => typeof item === 'string'))
    const metadata = isRecord(value.metadata) ? value.metadata : {}
    return { title: 'Weight Index', facts: compactFacts([
      ['Tensor 条目', Object.keys(weightMap).length.toLocaleString()],
      ['分片数量', shards.size.toLocaleString()],
      ['声明总大小', scalar(metadata.total_size)],
      ['Metadata 字段', Object.keys(metadata).length.toLocaleString()],
    ]) }
  }
  return { title: 'JSON', facts: [['根字段', Object.keys(value).length.toLocaleString()]] }
}

export function jsonRows(path: string, value: unknown): Array<[string, string]> {
  if (!isRecord(value)) return [['$', preview(value)]]
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  const collection = name === 'vocab.json'
    ? value
    : isWeightIndex(name) && isRecord(value.weight_map) ? value.weight_map : value
  return Object.entries(collection)
    .map(([key, item]): [string, string] => [key, preview(item)])
    .toSorted(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
}

export function visibleRows(rows: Array<[string, string]>, query: string, limit: number): Array<[string, string]> {
  const term = query.trim().toLocaleLowerCase()
  return rows.filter(([key, value]) => term === '' || key.toLocaleLowerCase().includes(term)
    || value.toLocaleLowerCase().includes(term)).slice(0, limit)
}

export function textLines(content: string): string[] {
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
}

export type TextFindNavigation = 'initial' | 'next' | 'previous'
export type TextFindState = { total: number; current: number; start: number; end: number }

export function navigateTextMatches(
  content: string,
  query: string,
  navigation: TextFindNavigation,
  current = 0,
): TextFindState {
  if (query === '') return { total: 0, current: 0, start: 0, end: 0 }
  let total = 0
  let first = -1
  forEachTextMatch(content, query, (index) => {
    if (first === -1) first = index
    total++
  })
  if (total === 0) return { total, current: 0, start: 0, end: 0 }

  const ordinal = navigation === 'initial'
    ? 0
    : navigation === 'next'
      ? (current % total + total) % total
      : ((current - 2) % total + total) % total
  let start = first
  let seen = 0
  forEachTextMatch(content, query, (index) => {
    if (seen++ === ordinal) start = index
  })
  return { total, current: ordinal + 1, start, end: start + query.length }
}

export function forEachTextMatch(content: string, query: string, visit: (start: number) => void): void {
  const source = query.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')
  const pattern = new RegExp(source, 'giu')
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
    const resolved = new URL(value, `https://relative.invalid/${encodePath(filePath)}`)
    const path = resolved.pathname.split('/').filter(Boolean).map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/')
    const action = attribute === 'src' ? 'resolve' : 'blob'
    return `https://huggingface.co/${encodePath(snapshot.modelId)}/${action}/${snapshot.revision}/${path}${resolved.search}${resolved.hash}`
  } catch {
    return null
  }
}

function compactFacts(facts: Array<[string, string | undefined]>): Array<[string, string]> {
  return facts.filter((fact): fact is [string, string] => fact[1] !== undefined)
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined
}

function stringList(value: unknown): string | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(', ') : undefined
}

function tokenText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  return isRecord(value) && typeof value.content === 'string' ? value.content : undefined
}

function preview(value: unknown): string {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  if (rendered === undefined) return String(value)
  return rendered.length > 500 ? `${rendered.slice(0, 500)}…` : rendered
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWeightIndex(name: string): boolean {
  return name.endsWith('.index.json') && (name.includes('safetensors') || name.includes('pytorch_model'))
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
