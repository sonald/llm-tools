import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildChatContext,
  chatContentProbe,
  chatTokenOverhead,
  chatTokenRoles,
  parseChatMessages,
} from './tokenAttribution.ts'
import type { TokenSegment } from './tokenizer.ts'

const messages = [
  { role: 'system', content: 'shell', contentKind: 'text' },
  { role: 'user', content: 'question', contentKind: 'text' },
] as const

function tokenization(rendered: string, chunks: string[], mapping: 'Exact' | 'Decoded only' = 'Exact', mutate?: (segments: TokenSegment[]) => void) {
  const ids = Array.from(chunks, (_, index) => index + 1)
  const segments = chunks.map((text, index) => {
    return { start: index, end: index + 1, ids: [ids[index]], text }
  })
  mutate?.(segments)
  return { ids, segments, mapping }
}

test('reports zero chat token overhead for one exact body', () => {
  assert.deepEqual(chatContentProbe(messages), 'shell\nquestion')
  const probe = chatContentProbe([{ role: 'user', content: 'hello', contentKind: 'text' }])
  assert.deepEqual(chatTokenOverhead(5, 5, probe), {
    totalCount: 5, contentCount: 5, templateCount: 0, isApproximate: true, contentProbe: 'hello',
  })
})

test('ignores JSON and empty bodies and keeps positive overhead approximate', () => {
  const mixed = [
    ...messages,
    { role: 'tool', content: '{"value":42}', contentKind: 'json' },
    { role: 'assistant', content: '', contentKind: 'text' },
  ] as const
  assert.equal(chatContentProbe(mixed), 'shell\nquestion')
  assert.deepEqual(chatTokenOverhead(9, 6, 'shell\nquestion'), {
    totalCount: 9, contentCount: 6, templateCount: 3, isApproximate: true, contentProbe: 'shell\nquestion',
  })
})

test('keeps a negative template count when counts disagree', () => {
  assert.equal(chatTokenOverhead(2, 5, '').templateCount, -3)
})

test('assigns shell, user, and template roles by monotonic UTF-16 ranges', () => {
  const rendered = '<s>shell<sep>question</s>'
  const result = tokenization(rendered, ['<s>', 'shell', '<sep>', 'question', '</s>'])
  assert.deepEqual(chatTokenRoles(rendered, messages, result), [
    { kind: 'template' }, { kind: 'message', role: 'system' }, { kind: 'template' },
    { kind: 'message', role: 'user' }, { kind: 'template' },
  ])
})

test('allocates repeated bodies monotonically instead of matching the first occurrence twice', () => {
  const repeated = [
    { role: 'user', content: 'A', contentKind: 'text' },
    { role: 'assistant', content: 'A', contentKind: 'text' },
  ] as const
  const rendered = 'xAyA'
  assert.deepEqual(
    chatTokenRoles(rendered, repeated, tokenization(rendered, ['x', 'A', 'y', 'A'])),
    [{ kind: 'template' }, { kind: 'message', role: 'user' }, { kind: 'template' }, { kind: 'message', role: 'assistant' }],
  )
})

test('leaves a segment that crosses a body boundary as template', () => {
  const rendered = 'xhello'
  const crossing = [{ role: 'user', content: 'hello', contentKind: 'text' }] as const
  assert.deepEqual(
    chatTokenRoles(rendered, crossing, tokenization(rendered, ['xh', 'ello'])),
    [{ kind: 'template' }, { kind: 'message', role: 'user' }],
  )
})

test('returns null for decoded-only mapping', () => {
  const rendered = 'hello'
  const result = tokenization(rendered, ['hello'], 'Decoded only')
  assert.equal(chatTokenRoles(rendered, [{ role: 'user', content: 'hello', contentKind: 'text' }], result), null)
})

test('uses custom roles and ignores empty, JSON, and missing bodies', () => {
  const custom = [
    { role: 'reviewer', content: 'ok', contentKind: 'text' },
    { role: '', content: '', contentKind: 'text' },
    { role: 'tool', content: '{}', contentKind: 'json' },
    { role: 'ghost', content: 'missing', contentKind: 'text' },
    { role: 'template', content: 'done', contentKind: 'text' },
  ] as const
  const rendered = '[ok|done]'
  assert.deepEqual(
    chatTokenRoles(rendered, custom, tokenization(rendered, ['[', 'ok', '|', 'done', ']'])),
    [{ kind: 'template' }, { kind: 'message', role: 'reviewer' }, { kind: 'template' }, { kind: 'message', role: 'template' }, { kind: 'template' }],
  )
})

test('returns null when segment texts cannot reconstruct the rendering', () => {
  const rendered = 'hello'
  assert.equal(
    chatTokenRoles(rendered, [{ role: 'user', content: 'hello', contentKind: 'text' }], tokenization('help', ['help'])),
    null,
  )
})

test('returns null when segment boundaries leave the ID range', () => {
  const rendered = 'hello'
  assert.equal(
    chatTokenRoles(rendered, [], tokenization(rendered, ['hello'], 'Exact', segments => {
      segments.push({ start: 5, end: 6, ids: [99], text: '' })
    })),
    null,
  )
})

test('rejects invalid overhead counts', () => {
  assert.throws(() => chatTokenOverhead(-1, 0, ''), /非负安全整数/)
  assert.throws(() => chatTokenOverhead(1.5, 1, ''), /非负安全整数/)
  assert.throws(() => chatTokenOverhead(Number.MAX_SAFE_INTEGER + 1, 0, ''), /非负安全整数/)
})

test('parses Chat message boundaries once and classifies content', () => {
  const messages = [
    { role: 'system', content: 'shell' },
    { role: 'user', content: { question: 'why?' } },
    { role: 'assistant', content: '' },
  ]
  const parsed = parseChatMessages(messages)
  assert.equal(parsed.messages, messages)
  assert.deepEqual(parsed.attribution, [
    { role: 'system', content: 'shell', contentKind: 'text' },
    { role: 'user', content: '{"question":"why?"}', contentKind: 'json' },
    { role: 'assistant', content: '', contentKind: 'text' },
  ])
})

test('rejects invalid Chat message roles and content values', () => {
  assert.throws(() => parseChatMessages({}), /Messages 必须是 JSON 数组。/)
  assert.throws(() => parseChatMessages([{ role: 'user' }]), /第 1 项必须是非数组对象，且 role 是字符串、content 存在。/)
  assert.throws(() => parseChatMessages([{ role: 1, content: 'ok' }]), /第 1 项必须是非数组对象，且 role 是字符串、content 存在。/)
  assert.throws(() => parseChatMessages([[1]]), /第 1 项必须是非数组对象，且 role 是字符串、content 存在。/)
  assert.throws(() => parseChatMessages([{ role: 'user', content: undefined }]), /第 1 项 content 不可序列化为 JSON。/)
  assert.throws(() => parseChatMessages([{ role: 'user', content: () => 'x' }]), /第 1 项 content 不可序列化为 JSON。/)
})

test('rejects circular or otherwise unserializable Chat content', () => {
  const cyclic: Record<string, unknown> = { role: 'user' }
  cyclic.content = cyclic
  assert.throws(() => parseChatMessages([cyclic]), /第 1 项 content 不可序列化为 JSON。/)
  assert.throws(() => parseChatMessages([{ role: 'user', content: 1n }]), /第 1 项 content 不可序列化为 JSON。/)
})

test('builds Chat context with optional tools and typed variables', () => {
  const messages = [{ role: 'user', content: 'hello' }]
  const tools = [{ type: 'function', function: { name: 'search' } }]
  const included = buildChatContext(
    messages,
    tools,
    { enable_thinking: true, mode: 'chat-plus' },
    true,
    true,
  )
  assert.deepEqual(included.attribution, [{ role: 'user', content: 'hello', contentKind: 'text' }])
  assert.deepEqual(included.context, {
    enable_thinking: true,
    mode: 'chat-plus',
    messages,
    add_generation_prompt: true,
    tools,
  })

  const omitted = buildChatContext(
    messages,
    [],
    { enable_thinking: false, mode: 'chat' },
    false,
    false,
  )
  assert.deepEqual(omitted.context, {
    enable_thinking: false,
    mode: 'chat',
    messages,
    add_generation_prompt: false,
  })
  assert.equal('tools' in omitted.context, false)
})

test('rejects invalid Chat context boundaries and reserved keys', () => {
  assert.throws(() => parseChatMessages({}), /Messages 必须是 JSON 数组。/)
  assert.throws(() => buildChatContext([], {}, {}, true, true), /Tools 必须是 JSON 数组。/)
  assert.throws(() => buildChatContext([], [], [], true, true), /Typed Variables 必须是 JSON 对象。/)
  for (const key of ['messages', 'tools', 'add_generation_prompt']) {
    assert.throws(
      () => buildChatContext([], [], { [key]: null }, true, true),
      new RegExp(`Typed Variables 不能使用保留键：${key}。`),
    )
  }
})
