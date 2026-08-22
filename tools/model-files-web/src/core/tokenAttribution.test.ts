import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chatContentProbe,
  chatTokenOverhead,
  chatTokenRoles,
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
