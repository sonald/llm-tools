import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeStrictText,
  jsonRows,
  repositoryMarkdownUrl,
  summarizeJson,
  textLines,
  validatePdfData,
  visibleRows,
} from './readers.ts'
import type { RepositorySnapshot } from './huggingface.ts'

const snapshot: RepositorySnapshot = {
  source: 'huggingface',
  modelId: 'owner/model',
  revision: '0123456789abcdef0123456789abcdef01234567',
  files: [],
}

test('summarizes configs and sharded weight indexes without expanding collections', () => {
  assert.deepEqual(summarizeJson('config.json', {
    model_type: 'fixture', architectures: ['FixtureModel'], hidden_size: 8, num_hidden_layers: 2,
  }).facts, [
    ['模型类型', 'fixture'], ['架构', 'FixtureModel'], ['Hidden Size', '8'], ['层数', '2'],
  ])
  assert.deepEqual(summarizeJson('model.safetensors.index.json', {
    metadata: { total_size: 12 },
    weight_map: { a: 'one.safetensors', b: 'two.safetensors', c: 'one.safetensors' },
  }).facts, [
    ['Tensor 条目', '3'], ['分片数量', '2'], ['声明总大小', '12'], ['Metadata 字段', '1'],
  ])
})

test('searches stable JSON rows and text lines with explicit limits', () => {
  const rows = jsonRows('vocab.json', { beta: 2, alpha: 1, gamma: 3 })
  assert.deepEqual(rows, [['alpha', '1'], ['beta', '2'], ['gamma', '3']])
  assert.deepEqual(visibleRows(rows, 'TA', 1), [['beta', '2']])
  assert.deepEqual(textLines('first\r\n\r\nsecond'), ['first', '', 'second'])
})

test('pins repository-relative Markdown URLs and rejects active protocols', () => {
  assert.equal(
    repositoryMarkdownUrl(snapshot, 'docs/README.md', '../config.json#model', 'href'),
    `https://huggingface.co/owner/model/blob/${snapshot.revision}/config.json#model`,
  )
  assert.equal(
    repositoryMarkdownUrl(snapshot, 'docs/README.md', './image.png', 'src'),
    `https://huggingface.co/owner/model/resolve/${snapshot.revision}/docs/image.png`,
  )
  assert.equal(repositoryMarkdownUrl(snapshot, 'README.md', 'javascript:alert(1)', 'href'), null)
})

test('decodes fatal UTF-8 text and rejects invalid sequences', () => {
  assert.equal(decodeStrictText(new TextEncoder().encode('中文').buffer), '中文')
  assert.throws(() => decodeStrictText(Uint8Array.from([0xff]).buffer), /UTF-8/)
})

test('rejects NUL bytes in strict text', () => {
  assert.throws(() => decodeStrictText(Uint8Array.from([97, 0]).buffer), /NUL/)
})

test('validates PDF data by its first five signature bytes', () => {
  validatePdfData(new TextEncoder().encode('%PDF-1.7').buffer)
  assert.throws(() => validatePdfData(new TextEncoder().encode('not a pdf').buffer), /PDF/)
})
