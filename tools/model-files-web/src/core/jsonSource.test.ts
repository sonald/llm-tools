import assert from 'node:assert/strict'
import test from 'node:test'
import { formatJsonSource, highlightJsonWindow, jsonFieldSources, jsonTopLevelKeyRanges, sourceBoundary } from './jsonSource.ts'

test('JSON fields and formatting preserve numeric spelling, strings and root fragments', () => {
  const source = '{"big":900719925474099312345,"nested":{"decimal":1.2300e+45,"s":"[, \\\"x\\\"]"},"empty":[]}'
  const formatted = formatJsonSource(source)
  assert.ok(formatted.includes('900719925474099312345'))
  assert.ok(formatted.includes('1.2300e+45'))
  assert.deepEqual(JSON.parse(formatted), JSON.parse(source))
  assert.equal(jsonFieldSources(source).get('big'), '900719925474099312345')
  assert.equal(jsonFieldSources(source).get('nested'), '{"decimal":1.2300e+45,"s":"[, \\\"x\\\"]"}')
  for (const root of ['null', 'true', '123', '"hi"', '[1,2]']) {
    assert.equal(jsonFieldSources(root).get('$'), root)
    assert.deepEqual(JSON.parse(formatJsonSource(root)), JSON.parse(root))
  }
})

test('JSON highlighting preserves exact paged source including token boundaries', () => {
  const source = '{"key":"long string", "big":12345678901234567890, "flag":null}'
  for (let start = 0; start < source.length; start += 7) {
    const segments = highlightJsonWindow(source, start, start + 7)
    assert.equal(segments.map(piece => piece.text).join(''), source.slice(start, start + 7))
  }
  assert.equal(highlightJsonWindow(source, 10, 13)[0].className, 'token source-syntax-string')
  assert.equal(highlightJsonWindow(source)[1].className, 'token source-syntax-name')
})

test('raw page boundaries retain Unicode code points and CRLF pairs', () => {
  assert.equal(sourceBoundary('a😀b', 2), 3)
  assert.equal(sourceBoundary('a\r\nb', 2), 3)
  assert.equal(sourceBoundary('abc', 2), 2)
})

test('top-level key ranges ignore nested keys and key-like string values', () => {
  const minified = '{"a":{"vocab_size":1},"note":"\\"vocab_size\\":2","vocab_size":3}'
  const ranges = jsonTopLevelKeyRanges(minified)
  const vocab = ranges.get('vocab_size')!
  assert.equal(minified.slice(vocab.start, vocab.end), '"vocab_size"')
  assert.equal(vocab.start, minified.lastIndexOf('"vocab_size"'))
  assert.deepEqual([...ranges.keys()], ['a', 'note', 'vocab_size'])
  assert.equal(ranges.get('missing'), undefined)

  const pretty = '{\r\n  "model_type": "x",\r\n  "eos_token_id": [1, 2]\r\n}'
  const eos = jsonTopLevelKeyRanges(pretty).get('eos_token_id')!
  assert.equal(pretty.slice(eos.start, eos.end), '"eos_token_id"')
  assert.deepEqual([...jsonTopLevelKeyRanges('[{"a":1}]').keys()], [])
  assert.equal(jsonTopLevelKeyRanges('{"a":1,"a":2}').get('a')!.start, 7)
})
