import type { TokenSegment, Tokenization } from './tokenizer.ts'

export type ChatAttributionMessage = {
  role: string
  content: string
  contentKind: 'text' | 'json'
}

export type ChatTokenOverhead = {
  totalCount: number
  contentCount: number
  templateCount: number
  isApproximate: true
  contentProbe: string
}

export type ChatTokenRole =
  | { kind: 'template' }
  | { kind: 'message'; role: string }

export function parseChatMessages(value: unknown): {
  messages: unknown[]
  attribution: ChatAttributionMessage[]
} {
  if (!Array.isArray(value)) throw new Error('Messages 必须是 JSON 数组。')
  const attribution = value.map((item, index): ChatAttributionMessage => {
    if (!isRecord(item) || typeof item.role !== 'string' || !('content' in item)) {
      throw new Error(`第 ${index + 1} 项必须是非数组对象，且 role 是字符串、content 存在。`)
    }
    if (typeof item.content === 'string') return { role: item.role, content: item.content, contentKind: 'text' }
    let content: string | undefined
    try {
      content = JSON.stringify(item.content)
    } catch {
      throw new Error(`第 ${index + 1} 项 content 不可序列化为 JSON。`)
    }
    if (content === undefined) throw new Error(`第 ${index + 1} 项 content 不可序列化为 JSON。`)
    return { role: item.role, content, contentKind: 'json' }
  })
  return { messages: value, attribution }
}

export function buildChatContext(
  messages: unknown,
  tools: unknown,
  variables: unknown,
  includeTools: boolean,
  addGenerationPrompt: boolean,
): {
  context: Record<string, unknown>
  attribution: ChatAttributionMessage[]
} {
  const parsedMessages = parseChatMessages(messages)
  if (!Array.isArray(tools)) throw new Error('Tools 必须是 JSON 数组。')
  if (!isRecord(variables)) throw new Error('Typed Variables 必须是 JSON 对象。')
  for (const key of ['messages', 'tools', 'add_generation_prompt']) {
    if (key in variables) throw new Error(`Typed Variables 不能使用保留键：${key}。`)
  }
  const context: Record<string, unknown> = { ...variables, messages: parsedMessages.messages, add_generation_prompt: addGenerationPrompt }
  if (includeTools) context.tools = tools
  return { context, attribution: parsedMessages.attribution }
}

export function chatContentProbe(messages: readonly ChatAttributionMessage[]): string {
  return messages
    .filter(message => message.contentKind === 'text' && message.content !== '')
    .map(message => message.content)
    .join('\n')
}

export function chatTokenOverhead(
  totalCount: number,
  contentCount: number,
  contentProbe: string,
): ChatTokenOverhead {
  for (const count of [totalCount, contentCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Token overhead count 必须是非负安全整数。')
  }
  return { totalCount, contentCount, templateCount: totalCount - contentCount, isApproximate: true, contentProbe }
}

export function chatTokenRoles(
  rendered: string,
  messages: readonly ChatAttributionMessage[],
  result: Pick<Tokenization, 'ids' | 'segments' | 'mapping'>,
): ChatTokenRole[] | null {
  if (result.mapping !== 'Exact' || !Array.isArray(result.ids) || !Array.isArray(result.segments)) return null
  if (result.ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)) return null

  const roles: ChatTokenRole[] = Array.from({ length: result.ids.length }, () => ({ kind: 'template' as const }))
  const locations = validSegments(result.ids, result.segments)
  if (locations === null || locations.map(({ start, end }) => rendered.slice(start, end)).join('') !== rendered) {
    return null
  }

  let cursor = 0
  for (const message of messages) {
    if (message.contentKind !== 'text' || message.content === '') continue
    const start = rendered.indexOf(message.content, cursor)
    if (start < 0) continue
    const end = start + message.content.length
    const role = typeof message.role === 'string' ? message.role : 'template'
    for (const location of locations) {
      if (location.start >= start && location.end <= end) roles.fill({ kind: 'message', role }, location.segment.start, location.segment.end)
    }
    cursor = end
  }
  return roles
}

function validSegments(
  ids: number[],
  segments: TokenSegment[],
): Array<{ segment: TokenSegment; start: number; end: number }> | null {
  let expectedStart = 0
  let textStart = 0
  const locations: Array<{ segment: TokenSegment; start: number; end: number }> = []
  for (const segment of segments) {
    const { start: segmentStart, end: segmentEnd, ids: segmentIds, text } = segment
    if (!Number.isSafeInteger(segmentStart) || !Number.isSafeInteger(segmentEnd)
      || segmentStart !== expectedStart || segmentStart >= segmentEnd || segmentEnd > ids.length
      || !Array.isArray(segmentIds) || segmentIds.length !== segmentEnd - segmentStart
      || segmentIds.some((id, index) => id !== ids[segmentStart + index])
      || typeof text !== 'string') return null
    expectedStart = segmentEnd
    const textEnd = textStart + text.length
    locations.push({ segment, start: textStart, end: textEnd })
    textStart = textEnd
  }
  if (expectedStart !== ids.length) return null
  return locations
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
