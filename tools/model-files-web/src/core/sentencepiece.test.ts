import assert from 'node:assert/strict'
import test from 'node:test'
import { SentencePieceWasm } from '../sentencepieceWasm.ts'

const fixtureDir = new URL('./fixtures/sentencepiece/', import.meta.url)

async function loadFixture(name: string): Promise<SentencePieceWasm> {
  const bytes = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL(name, fixtureDir)),
  )
  return SentencePieceWasm.load(new Uint8Array(bytes))
}

test('rejects an invalid serialized model', async () => {
  const invalidModel = new TextEncoder().encode('__NOT_A_PROTO__')
  await assert.rejects(() => SentencePieceWasm.load(invalidModel), /SentencePiece 模型无效/)
})

test('loads the official BPE model and round-trips fixed gold', async () => {
  const tokenizer = await loadFixture('test_bpe_model.model')
  assert.deepEqual(tokenizer.encodeAsIds('Hello world.'), [285, 35, 934, 178, 54, 951])
  assert.deepEqual(tokenizer.encodeAsPieces('Hello world.'), [
    '▁He',
    'll',
    'o',
    '▁wor',
    'ld',
    '.',
  ])
  assert.equal(tokenizer.idToPiece(285), '▁He')
  assert.equal(
    tokenizer.decodeIds([285, 35, 934, 178, 54, 951]),
    'Hello world.',
  )
  tokenizer.dispose()
})

test('loads the official Unigram model and round-trips fixed gold', async () => {
  const tokenizer = await loadFixture('test_model.model')
  assert.deepEqual(tokenizer.encodeAsIds('I saw a girl with a telescope.'), [
    9,
    459,
    11,
    939,
    44,
    11,
    4,
    142,
    82,
    8,
    28,
    21,
    132,
    6,
  ])
  assert.deepEqual(tokenizer.encodeAsPieces('I saw a girl with a telescope.'), [
    '▁I',
    '▁saw',
    '▁a',
    '▁girl',
    '▁with',
    '▁a',
    '▁',
    'te',
    'le',
    's',
    'c',
    'o',
    'pe',
    '.',
  ])
  assert.equal(
    tokenizer.decodeIds([
      9, 459, 11, 939, 44, 11, 4, 142, 82, 8, 28, 21, 132, 6,
    ]),
    'I saw a girl with a telescope.',
  )
  tokenizer.dispose()
})

test('reports invalid ids and remains reusable after failure', async () => {
  const tokenizer = await loadFixture('test_model.model')
  assert.throws(() => tokenizer.idToPiece(-1), /Invalid id/)
  assert.throws(() => tokenizer.decodeIds([999999]), /Invalid id/)
  assert.equal(tokenizer.idToPiece(0), '<unk>')
  tokenizer.dispose()
})

test('rejects non-integer and out-of-int32 ids at the boundary', async () => {
  const tokenizer = await loadFixture('test_model.model')
  assert.throws(() => tokenizer.decodeIds([1.5]), TypeError)
  assert.throws(() => tokenizer.decodeIds([2147483648]), TypeError)
  tokenizer.dispose()
})

test('dispose is idempotent and subsequent calls fail', async () => {
  const tokenizer = await loadFixture('test_model.model')
  tokenizer.dispose()
  tokenizer.dispose()
  assert.throws(() => tokenizer.idToPiece(0), /已释放/)
  assert.throws(() => tokenizer.decodeIds([0]), /已释放/)
})
