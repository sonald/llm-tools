import assert from 'node:assert/strict'
import test from 'node:test'
import { formatImatrixValue, inspectImatrix } from './imatrix.ts'
import { initializeLocalization } from '../i18n.ts'

// Goldens: `value.formatted(.number.precision(.significantDigits(5)))` printed by swift on macOS (zh-Hans and en agree).
const significantDigitGoldens: Array<[number, string]> = [
  [0, '0.0000'], [1, '1.0000'], [1.5, '1.5000'], [0.5, '0.50000'], [1 / 3, '0.33333'], [2 / 3, '0.66667'],
  [12345.678, '12,346'], [123456.789, '123,460'], [1234567, '1,234,600'], [99999.5, '100,000'], [99999.4, '99,999'],
  [0.000012345678, '0.000012346'], [0.00001, '0.000010000'], [1e-10, '0.00000000010000'], [1e20, '100,000,000,000,000,000,000'],
  [3.14159265, '3.1416'], [-2.718281828, '-2.7183'], [1.23456e-7, '0.00000012346'], [100, '100.00'], [10.00001, '10.000'],
  [0.1, '0.10000'], [9.99996, '10.000'], [Math.fround(0.1), '0.10000'], [5.4321e15, '5,432,100,000,000,000'], [-0, '-0.0000'],
  [7 / 6, '1.1667'], [0.000123455, '0.00012346'], [1.00005, '1.0000'], [1.00015, '1.0002'], [2.5e-8, '0.000000025000'],
  [123.4565, '123.46'], [1e-30, '0.0000000000000000000000000000010000'],
  // Exact binary ties: ICU rounds half to even, so a half-up fallback fails here.
  [12344.5, '12,344'], [12345.5, '12,346'], [1.03125, '1.0312'], [1.09375, '1.0938'], [0.15625, '0.15625'], [2.0000625, '2.0001'],
]

test('formats Imatrix statistics with exactly five significant digits like native', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    initializeLocalization([locale])
    for (const [value, expected] of significantDigitGoldens) assert.equal(formatImatrixValue(value), expected, `${locale} ${value}`)
  }
  initializeLocalization(['zh-CN'])
})

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
