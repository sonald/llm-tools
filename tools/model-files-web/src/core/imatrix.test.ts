import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectImatrix } from './imatrix.ts'

test('parses legacy entries, statistics, chunk count, and dataset', () => {
  const fixture = makeImatrix()
  const result = inspectImatrix(fixture.buffer as ArrayBuffer)
  assert.equal(result.byteCount, fixture.byteLength)
  assert.equal(result.chunkCount, 12)
  assert.equal(result.dataset, 'calibration.txt')
  assert.deepEqual(result.entries, [
    { name: 'blk.0.attn.weight', callCount: 8, valueCount: 3, minimum: 1, maximum: 3, mean: 2 },
    { name: 'blk.0.ffn.weight', callCount: 4, valueCount: 2, minimum: 0.5, maximum: 1.5, mean: 1 },
  ])
})

test('rejects truncation, duplicate names, invalid UTF-8, and non-finite values', () => {
  const fixture = makeImatrix()
  const invalidUtf8 = makeImatrix([['name', 1, [1]]])
  invalidUtf8[8] = 0xff
  assert.throws(() => inspectImatrix(fixture.slice(0, -1).buffer as ArrayBuffer), /提前结束|dataset/)
  assert.throws(() => inspectImatrix(makeImatrix([['same', 1, [1]], ['same', 1, [2]]]).buffer as ArrayBuffer), /重复/)
  assert.throws(() => inspectImatrix(invalidUtf8.buffer as ArrayBuffer), /UTF-8/)
  assert.throws(() => inspectImatrix(makeImatrix([['bad', 1, [Number.NaN]]]).buffer as ArrayBuffer), /非有限/)
})

export function makeImatrix(entries: Array<[string, number, number[]]> = [
  ['blk.0.ffn.weight', 4, [0.5, 1.5]],
  ['blk.0.attn.weight', 8, [1, 2, 3]],
]): Uint8Array {
  const output: number[] = []
  int32(output, entries.length)
  for (const [name, calls, values] of entries) {
    const encoded = new TextEncoder().encode(name)
    int32(output, encoded.length)
    output.push(...encoded)
    int32(output, calls)
    int32(output, values.length)
    for (const value of values) float32(output, value)
  }
  int32(output, 12)
  const dataset = new TextEncoder().encode('calibration.txt')
  int32(output, dataset.length)
  output.push(...dataset)
  return Uint8Array.from(output)
}

function int32(output: number[], value: number): void {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setInt32(0, value, true)
  output.push(...bytes)
}

function float32(output: number[], value: number): void {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setFloat32(0, value, true)
  output.push(...bytes)
}
