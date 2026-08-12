import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTokenization, inspectTokenizerStructure, tokenizerBundleBytes } from './tokenizer.ts'
import type { RepositoryFile } from './huggingface.ts'

test('groups partial byte decoding without losing token IDs', () => {
  const result = buildTokenization('😀!', [10, 11, 12], ['<a>', '<b>', '!'], '😀!', ids => ({
    '10': '\uFFFD',
    '10,11': '😀',
    '12': '!',
  })[ids.join(',')] ?? '')

  assert.deepEqual(result.segments, [
    { start: 0, end: 2, ids: [10, 11], text: '😀' },
    { start: 2, end: 3, ids: [12], text: '!' },
  ])
  assert.equal(result.mapping, 'Exact')
})

test('keeps combining marks and ZWJ emoji inside grapheme-safe groups', () => {
  const decoded = ['e', '\u0301', '👩', '\u200D', '💻', '👩', '\u200D', '💻', '\n', ' ', ' ', '中'].join('')
  const ids = decoded === '' ? [] : Array.from({ length: 12 }, (_, index) => index)
  const pieces = ['e', '\u0301', '👩', '\u200D', '💻', '👩', '\u200D', '💻', '\n', ' ', ' ', '中']
  const result = buildTokenization(decoded, ids, pieces, decoded, group => group.map(id => pieces[id]).join(''))

  assert.deepEqual(result.segments.map(segment => segment.text), ['e\u0301', '👩‍💻', '👩‍💻', '\n', ' ', ' ', '中'])
  assert.deepEqual(result.segments.flatMap(segment => segment.ids), ids)
  assert.equal(result.mapping, 'Exact')
})

test('falls back to one authoritative decoded group', () => {
  const result = buildTokenization('hello world', [1, 2], ['hello', 'world'], 'hello world', ids => ids[0] === 1 ? 'hello' : 'world')

  assert.deepEqual(result.segments, [{ start: 0, end: 2, ids: [1, 2], text: 'hello world' }])
  assert.equal(result.mapping, 'Exact')
})

test('marks normalization differences as Decoded only', () => {
  const result = buildTokenization('Hello', [1], ['hello'], 'hello', () => 'hello')
  assert.equal(result.mapping, 'Decoded only')
})

test('keeps large tokenizations bounded without per-token decode', () => {
  const ids = Array.from({ length: 2_001 }, (_, index) => index)
  const result = buildTokenization('authoritative', ids, ids.map(String), 'authoritative', () => {
    throw new Error('large tokenizations must not decode each token')
  })

  assert.deepEqual(result.segments, [{ start: 0, end: ids.length, ids, text: 'authoritative' }])
  assert.equal(result.mapping, 'Exact')
})

test('rejects token piece arrays that lose ID positions', () => {
  assert.throws(() => buildTokenization('x', [1], [], 'x', () => 'x'), /piece 数量/)
})

test('accepts only bounded same-directory tokenizer bundles', () => {
  const tokenizer = file('nested/tokenizer.json', 30 * 1024 * 1024)
  assert.equal(tokenizerBundleBytes(tokenizer, file('nested/tokenizer_config.json', 2 * 1024 * 1024)), 32 * 1024 * 1024)
  assert.throws(() => tokenizerBundleBytes(tokenizer, file('tokenizer_config.json', 1)), /同目录/)
  assert.throws(() => tokenizerBundleBytes(tokenizer, file('nested/tokenizer_config.json', 2 * 1024 * 1024 + 1)), /32 MiB/)
  assert.throws(() => tokenizerBundleBytes({ ...tokenizer, size: null }, file('nested/tokenizer_config.json', 1)), /资源大小/)
  assert.equal(tokenizerBundleBytes(file('tokenizer.json', 10)), 10)
})

test('analyzes BPE and WordPiece vocabularies by Unicode scalar length', () => {
  const structure = inspectTokenizerStructure({
    version: '1.0',
    added_tokens: [{ id: 99, content: '<added>' }],
    model: { type: 'BPE', vocab: { a: 1, '👩‍💻': 2, longest: 3 }, merges: ['a b'] },
  })
  assert.equal(structure.vocabCount, 3)
  assert.equal(structure.mergeCount, 1)
  assert.equal(structure.addedTokenCount, 1)
  assert.equal(structure.vocabulary?.tokenCount, 3)
  assert.deepEqual(structure.vocabulary?.longestTokens.map(item => [item.tokenId, item.scalarLength]), [[3, 7], [2, 3], [1, 1]])
  assert.equal(structure.vocabulary?.p50ScalarLength, 3)
})

test('analyzes Unigram vocabularies and rejects ambiguous IDs or unknown structures', () => {
  const unigram = inspectTokenizerStructure({ model: { type: 'Unigram', vocab: [['a', -1], ['中文', -2]] } })
  assert.equal(unigram.vocabulary?.maximumScalarLength, 2)
  assert.match(inspectTokenizerStructure({ model: { vocab: { a: 1, b: 1 } } }).vocabularyError ?? '', /重复/)
  assert.match(inspectTokenizerStructure({ model: { type: 'Unknown' } }).vocabularyError ?? '', /未识别/)
})

function file(path: string, size: number): RepositoryFile {
  return { path, size, hash: null, category: 'tokenizer' }
}
