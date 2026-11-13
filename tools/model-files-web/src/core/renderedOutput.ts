import { translate as t } from '../i18n.ts'
import { nativePretty, parseJsonNode } from './jsonValue.ts'

// Native RenderedOutputInspector: a read-only index over `<|…|>` tokens in the raw output. Ranges are UTF-16
// offsets into the output (as NSRange), so selecting an item never changes the authoritative text.
export type OutputRange = { start: number; end: number }
export type RenderedOutputItem = {
  id: number
  level: 0 | 1
  title: string
  detail: string | null
  range: OutputRange
  payloadRange: OutputRange | null
}

type Token = { name: string; range: OutputRange }

export function outputTokenRanges(source: string): OutputRange[] {
  return tokens(source).map(token => token.range)
}

export function renderedOutputItems(source: string): RenderedOutputItem[] {
  const all = tokens(source)
  const messageIndexes = all.flatMap((token, index) => token.name.startsWith('message_') ? [index] : [])
  if (messageIndexes.length === 0) {
    return all.map((token, index) => ({
      id: index, level: 0, title: token.name, detail: t('templateSpecialToken'), range: token.range, payloadRange: null,
    }))
  }
  const result: RenderedOutputItem[] = []
  messageIndexes.forEach((tokenIndex, position) => {
    const token = all[tokenIndex]
    const nextMessageStart = position + 1 < messageIndexes.length ? all[messageIndexes[position + 1]].range.start : source.length
    const later = all.slice(tokenIndex + 1)
    const endToken = later.find(item => item.range.start < nextMessageStart && item.name === 'end_message')
    const messageEnd = endToken?.range.end ?? nextMessageStart
    const contentTokens = later.filter(item => item.range.start < messageEnd && item.name.startsWith('content_'))
    result.push({
      id: result.length,
      level: 0,
      title: token.name.slice('message_'.length).toUpperCase(),
      detail: messageDetail(source, token.range.end, contentTokens[0]?.range.start ?? messageEnd),
      range: { start: token.range.start, end: messageEnd },
      payloadRange: null,
    })
    for (const content of contentTokens) {
      const contentEnd = all.find(item => item.range.start > content.range.start && item.range.start <= messageEnd
        && (item.name.startsWith('content_') || item.name === 'end_message' || item.name.startsWith('message_')))?.range.start ?? messageEnd
      result.push({
        id: result.length,
        level: 1,
        title: content.name,
        detail: null,
        range: { start: content.range.start, end: contentEnd },
        payloadRange: { start: content.range.end, end: contentEnd },
      })
    }
    if (contentTokens.length === 0 && token.name === 'message_model') {
      result.push({ id: result.length, level: 1, title: 'generation prompt', detail: null, range: token.range, payloadRange: null })
    }
  })
  return result
}

// JSONSerialization pretty + sorted keys + unescaped slashes. Only arrays and objects qualify: native would
// crash on a scalar fragment, the web simply shows no inspector.
export function prettyPrintedJSON(item: RenderedOutputItem, source: string): string | null {
  const range = item.payloadRange
  if (range === null || range.end <= range.start || range.end > source.length) return null
  const node = parseJsonNode(source.slice(range.start, range.end).trim())
  return node === null || (node.kind !== 'array' && node.kind !== 'object') ? null : nativePretty(node, 0, false)
}

function tokens(source: string): Token[] {
  return [...source.matchAll(/<\|([^|\r\n]+)\|>/g)].map(match => ({
    name: match[1], range: { start: match.index, end: match.index + match[0].length },
  }))
}

function messageDetail(source: string, start: number, end: number): string | null {
  if (end <= start) return null
  const text = source.slice(start, end).trim()
  if (text === '') return null
  const characters = Array.from(text)
  return characters.length > 40 ? `${characters.slice(0, 39).join('')}…` : text
}
