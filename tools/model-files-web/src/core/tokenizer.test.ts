import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTokenizerVocabularyIndex,
  buildTokenization,
  buildSpecialTokenIndex,
  filterTokenizerVocabulary,
  inspectTokenizerStructure,
  parseTokenIds,
  tokenFlag,
  tokenizerBundleBytes,
} from './tokenizer.ts'
import { validateTokenizerStructure, validateTokenizerVocabularySearch } from '../tokenizerClient.ts'
import { parseChatTemplates } from './chatTemplates.ts'
import { chatTokenOverhead } from './tokenAttribution.ts'
import type { RepositoryFile } from './huggingface.ts'

test('groups partial byte decoding without losing token IDs', () => {
  const ids = [10, 11, 12]
  const result = buildTokenization('😀!', ids, ['<a>', '<b>', '!'], '😀!', values => ({
    '10': '\uFFFD',
    '10,11': '😀',
    '12': '!',
  })[values.join(',')] ?? '', ids.map(() => ({ isSpecial: false, specialName: null })))

  assert.deepEqual(result.segments, [
    { start: 0, end: 2, ids: [10, 11], text: '😀' },
    { start: 2, end: 3, ids: [12], text: '!' },
  ])
  assert.equal(result.mapping, 'Exact')
  assert.equal(result.direction, 'encode')
  assert.equal(result.input, '😀!')
  assert.equal(result.overhead, null)
  assert.equal(result.roles, null)
})

test('keeps combining marks and ZWJ emoji inside grapheme-safe groups', () => {
  const decoded = ['e', '\u0301', '👩', '\u200D', '💻', '👩', '\u200D', '💻', '\n', ' ', ' ', '中'].join('')
  const ids = decoded === '' ? [] : Array.from({ length: 12 }, (_, index) => index)
  const pieces = ['e', '\u0301', '👩', '\u200D', '💻', '👩', '\u200D', '💻', '\n', ' ', ' ', '中']
  const result = buildTokenization(decoded, ids, pieces, decoded, group => group.map(id => pieces[id]).join(''), pieces.map(() => ({ isSpecial: false, specialName: null })))

  assert.deepEqual(result.segments.map(segment => segment.text), ['e\u0301', '👩‍💻', '👩‍💻', '\n', ' ', ' ', '中'])
  assert.deepEqual(result.segments.flatMap(segment => segment.ids), ids)
  assert.equal(result.mapping, 'Exact')
})

test('falls back to one authoritative decoded group', () => {
  const result = buildTokenization('hello world', [1, 2], ['hello', 'world'], 'hello world', ids => ids[0] === 1 ? 'hello' : 'world', [1, 2].map(() => ({ isSpecial: false, specialName: null })))

  assert.deepEqual(result.segments, [{ start: 0, end: 2, ids: [1, 2], text: 'hello world' }])
  assert.equal(result.mapping, 'Exact')
})

test('marks normalization differences as Decoded only', () => {
  const result = buildTokenization('Hello', [1], ['hello'], 'hello', () => 'hello', [{ isSpecial: false, specialName: null }])
  assert.equal(result.mapping, 'Decoded only')
})

test('decode direction never claims Exact', () => {
  const result = buildTokenization('same', [1], ['same'], 'same', () => 'same', [{ isSpecial: false, specialName: null }], 'decode')
  assert.equal(result.direction, 'decode')
  assert.equal(result.mapping, 'Decoded only')
})

test('parses delimited and JSON Token IDs at the input boundary', () => {
  assert.deepEqual(parseTokenIds('1, 3\n\t4 5'), [1, 3, 4, 5])
  assert.deepEqual(parseTokenIds('[3,4, 5]'), [3, 4, 5])
  assert.throws(() => parseTokenIds(' \n\t '), /空/)
})

test('rejects malformed Token IDs with the failing position and token', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /空/],
    ['[]', /空/],
    ['[1,-2]', /第 2 个.*index 1.*-2/s],
    ['1 2.5', /第 2 个.*index 1.*2\.5/s],
    ['true,false', /第 1 个.*index 0.*true/s],
    ['9007199254740992', /第 1 个.*index 0.*9007199254740992/s],
  ]
  for (const [input, pattern] of cases) assert.throws(() => parseTokenIds(input), pattern)
  assert.throws(() => parseTokenIds('[1,'), /Token ID JSON.*解析失败/s)
  assert.throws(() => parseTokenIds(`${'0,'.repeat(33_000)}1`), /64 KiB/)
})

test('keeps decode mappings and positions aligned with null unknown pieces', () => {
  const flags = [
    { isSpecial: true, specialName: '[CLS]' },
    { isSpecial: false, specialName: null },
    { isSpecial: true, specialName: '[SEP]' },
  ]
  const result = buildTokenization('1,999,2', [1, 999, 2], [null, null, null], 'CLS ? SEP', () => 'CLS ? SEP', flags)

  assert.equal(result.mapping, 'Decoded only')
  assert.deepEqual(result.pieces, [null, null, null])
  assert.deepEqual(result.flags, flags)
  assert.throws(() => buildTokenization('1', [1], [null], '', () => '', [...flags.slice(0, 2)]), /flags 数量/)
})

test('indexes only configured or explicitly added special tokens', () => {
  const config = {
    bos_token: '<bos>',
    eos_token: { content: '<eos>', id: 99 },
    pad_token: '',
    additional_special_tokens: ['<extra>', { content: '<multi>', id: 88 }, '<extra>'],
  }
  const resolvedPieces: string[] = []
  const pieceIds: Record<string, number[]> = { '<bos>': [5], '<eos>': [7], '<extra>': [6], '<multi>': [8, 9] }
  const resolvePieceIds = (piece: string) => {
    resolvedPieces.push(piece)
    return pieceIds[piece] ?? [12]
  }
  const index = buildSpecialTokenIndex(config, [
    { id: 0, content: '[UNK]', special: true },
    { id: -1, content: '<bad>', special: true },
    { id: 5, content: '<bos>', special: true },
    { id: 11, content: '<ordinary>', special: false },
  ], resolvePieceIds)
  assert.deepEqual(resolvedPieces, ['<bos>', '<eos>', '<extra>', '<multi>'])
  assert.deepEqual([...index.byPiece], [['<bos>', 'bos_token'], ['<eos>', 'eos_token'], ['<extra>', '<extra>'], ['<multi>', '<multi>'], ['[UNK]', '[UNK]']])
  assert.deepEqual([...index.byId], [[5, 'bos_token'], [7, 'eos_token'], [6, '<extra>'], [0, '[UNK]']])
  assert.equal(index.byId.has(8), false)
  assert.equal(index.byId.has(9), false)
  assert.equal(index.byId.has(11), false)
})

test('cold-decodes only missing pieces for special flags', () => {
  const index = { byId: new Map([[5, 'bos_token']]), byPiece: new Map([['<multi>', '<multi>']]) }
  let fallbackCount = 0
  const fallback = (value: string) => () => {
    fallbackCount += 1
    return value
  }

  assert.deepEqual(tokenFlag(5, null, index, fallback('ignored')), { isSpecial: true, specialName: 'bos_token' })
  assert.equal(fallbackCount, 0)
  assert.deepEqual(tokenFlag(3, 'hello', index, fallback('ignored')), { isSpecial: false, specialName: null })
  assert.equal(fallbackCount, 0)
  assert.deepEqual(tokenFlag(100, null, index, fallback('<multi>')), { isSpecial: true, specialName: '<multi>' })
  assert.equal(fallbackCount, 1)
  assert.deepEqual(tokenFlag(101, '', index, fallback('hello')), { isSpecial: false, specialName: null })
  assert.equal(fallbackCount, 2)
  assert.equal(index.byPiece.has('hello'), false)
})

test('keeps large tokenizations bounded without per-token decode', () => {
  const ids = Array.from({ length: 2_001 }, (_, index) => index)
  const flags = ids.map(() => ({ isSpecial: false, specialName: null }))
  const overhead = chatTokenOverhead(ids.length, 0, '')
  const result = buildTokenization('authoritative', ids, ids.map(String), 'authoritative', () => {
    throw new Error('large tokenizations must not decode each token')
  }, flags, 'encode', overhead)

  assert.deepEqual(result.segments, [{ start: 0, end: ids.length, ids, text: 'authoritative' }])
  assert.equal(result.mapping, 'Exact')
  assert.deepEqual(result.flags, flags)
  assert.equal(result.overhead, overhead)
  assert.equal(result.roles, null)
})

test('rejects token piece arrays that lose ID positions', () => {
  assert.throws(() => buildTokenization('x', [1], [], 'x', () => 'x', []), /piece 数量/)
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
    added_tokens: [
      { id: 99, content: '<added>', special: true },
      { id: null, content: '<null-id>', special: false },
      { content: '<missing-id>', special: false },
      { id: -1, content: '<bad>' },
      { id: 1.2, content: '<unsafe>' },
      { id: '2', content: '<wrong-type>' },
    ],
    model: { type: 'BPE', vocab: { a: 1, '👩‍💻': 2, longest: 3 }, merges: ['a b'] },
  })
  assert.equal(structure.vocabCount, 3)
  assert.equal(structure.mergeCount, 1)
  assert.equal(structure.addedTokenCount, 6)
  assert.deepEqual(structure.addedTokens, [
    { id: 99, content: '<added>', special: true },
    { id: null, content: '<null-id>', special: false },
  ])
  assert.ok(structure.vocabulary!.longestTokens.length <= 50)
  assert.equal(structure.vocabulary?.tokenCount, 3)
  assert.deepEqual(structure.vocabulary?.longestTokens.map(item => [item.tokenId, item.scalarLength]), [[3, 7], [2, 3], [1, 1]])
  assert.equal(structure.vocabulary?.p50ScalarLength, 3)
})

test('analyzes Unigram vocabularies and rejects ambiguous IDs or unknown structures', () => {
  const unigram = inspectTokenizerStructure({ model: { type: 'Unigram', vocab: [['a', -1], ['中文', -2]] } })
  assert.equal(unigram.vocabulary?.maximumScalarLength, 2)
  assert.match(inspectTokenizerStructure({ model: { vocab: { a: 1, b: 1 } } }).vocabularyError ?? '', /重复/)
  assert.match(inspectTokenizerStructure({ model: { type: 'Unknown' } }).vocabularyError ?? '', /未识别/)
  assert.deepEqual(unigram.chatTemplates, parseChatTemplates(undefined))
})

test('keeps empty vocabulary summaries bounded and free of full entries', () => {
  const structure = inspectTokenizerStructure({ version: '1.0', model: { type: 'BPE', vocab: {} } })

  assert.deepEqual(new Set(Object.keys(structure)), new Set([
    'addedTokenCount', 'addedTokens', 'chatTemplates', 'fields', 'mergeCount', 'modelType',
    'vocabCount', 'version', 'vocabulary', 'vocabularyError',
  ]))
  assert.equal(structure.vocabCount, 0)
  assert.equal(structure.vocabulary, null)
  assert.equal(structure.vocabularyError, null)
})

test('builds searchable vocabulary indexes for object, array, and empty vocabularies', () => {
  const object = buildTokenizerVocabularyIndex({ zeta: 2, Alpha: 10, middle: 4 })
  assert.deepEqual(object.entries?.map(entry => [entry.tokenId, entry.token, entry.scalarLength]), [
    [2, 'zeta', 4],
    [4, 'middle', 6],
    [10, 'Alpha', 5],
  ])

  const unigram = buildTokenizerVocabularyIndex([['中文', -1], ['a', 0.5]])
  assert.deepEqual(unigram.entries?.map(entry => [entry.tokenId, entry.token, entry.scalarLength]), [
    [0, '中文', 2],
    [1, 'a', 1],
  ])

  assert.deepEqual(buildTokenizerVocabularyIndex({}).entries, [])
  assert.deepEqual(buildTokenizerVocabularyIndex([]).entries, [])
})

test('rejects vocabulary indexes with invalid IDs or unknown structures', () => {
  const invalidCases: unknown[] = [
    { one: 1, two: 1 },
    { negative: -1 },
    { unsafe: 9007199254740992 },
    undefined,
    ['token'],
  ]
  for (const value of invalidCases) {
    assert.equal(buildTokenizerVocabularyIndex(value).entries, null)
  }
})

test('filters vocabulary by case-insensitive piece or decimal ID before capping', () => {
  const built = buildTokenizerVocabularyIndex(Object.fromEntries([
    ['skip-a', 0], ['skip-b', 1], ['skip-c', 2], ['skip-d', 3],
    ...Array.from({ length: 1_005 }, (_, index) => [`match-${index}`, index + 4]),
  ]))
  const entries = built.entries ?? []
  assert.equal(entries.length, 1_009)
  const matches = filterTokenizerVocabulary(entries, ' MATCH ')
  assert.equal(matches.length, 1_000)
  assert.equal(matches[0].tokenId, 4)
  assert.equal(matches.at(-1)?.tokenId, 1_003)

  const small = buildTokenizerVocabularyIndex({ zeta: 2, Alpha: 10, middle: 4 }).entries ?? []
  assert.deepEqual(filterTokenizerVocabulary(small, 'alp').map(entry => entry.tokenId), [10])
  assert.deepEqual(filterTokenizerVocabulary(small, '10').map(entry => entry.tokenId), [10])
  assert.deepEqual(filterTokenizerVocabulary(small, ' \n\t '), [])
})

test('validates worker structure and vocabulary replies at the client boundary', () => {
  const structure = inspectTokenizerStructure({ model: { type: 'BPE', vocab: { a: 0, b: 1 } } })
  assert.deepEqual(validateTokenizerStructure(structure).vocabulary?.longestTokens.map(item => item.tokenId), [0, 1])
  assert.throws(() => validateTokenizerStructure({ ...structure, entries: [{ tokenId: 99 }] }), /结构无效/s)
  assert.throws(() => validateTokenizerStructure({
    ...structure,
    vocabulary: {
      ...structure.vocabulary!,
      longestTokens: Array.from({ length: 51 }, (_, id) => ({ tokenId: id, token: String(id), scalarLength: 1 })),
    },
  }), /最长 Token/)

  const search = [{ tokenId: 1, token: 'a', scalarLength: 1 }]
  assert.deepEqual(validateTokenizerVocabularySearch(search), search)
  const invalidReplies: unknown[] = [
    null,
    Array.from({ length: 1_001 }, (_, id) => ({ tokenId: id, token: String(id), scalarLength: 1 })),
    [{ tokenId: 1, token: 'a', scalarLength: 1, extra: true }],
    [{ tokenId: -1, token: 'a', scalarLength: 1 }],
    [{ tokenId: 2, token: 'a', scalarLength: 1 }, { tokenId: 2, token: 'b', scalarLength: 1 }],
    [{ tokenId: 1, token: 2, scalarLength: 1 }],
    [{ tokenId: 1, token: '中文', scalarLength: 1 }],
  ]
  for (const reply of invalidReplies) assert.throws(() => validateTokenizerVocabularySearch(reply), /搜索结果/)
})

function file(path: string, size: number): RepositoryFile {
  return { path, size, hash: null, category: 'tokenizer' }
}
