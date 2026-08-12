import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectGGUF } from './gguf.ts'

test('parses GGUF v3 scalar, array metadata, and tensor directory', () => {
  const data = makeV3()
  const result = inspectGGUF(data.buffer)
  assert.equal(result.kind, 'complete')
  if (result.kind !== 'complete') return
  assert.equal(result.overview.version, 3)
  assert.equal(result.overview.endianness, 'little')
  assert.equal(result.overview.metadata.find(entry => entry.key === 'general.architecture')?.stringValue, 'llama')
  assert.equal(result.overview.metadata.find(entry => entry.key === 'llama.context_length')?.unsignedValue, 4096n)
  assert.equal(result.overview.metadata.find(entry => entry.key === 'general.tags')?.display, '[chat, test] · 2 项')
  assert.equal(result.overview.parameterCount, 32n)
  assert.deepEqual(result.overview.tensors[0], {
    name: 'blk.0.weight',
    type: 'Q6_K',
    shape: [4n, 8n],
    parameters: 32n,
    offset: 0n,
  })
  assert.equal(result.overview.tensorDataOffset % 32, 0)
})

test('returns needs-more-data for a truncated GGUF directory', () => {
  const data = makeV3()
  assert.deepEqual(inspectGGUF(data.slice(0, -1).buffer), { kind: 'needs-more-data' })
})

test('parses v1 counts and big-endian v3', () => {
  const v1 = header(1, 1n, 0n, true)
  appendString(v1, 'weight', 1, true)
  appendInteger(v1, 1n, 4, true)
  appendInteger(v1, 7n, 4, true)
  appendInteger(v1, 1n, 4, true)
  appendInteger(v1, 0n, 8, true)
  const v1Result = inspectGGUF(Uint8Array.from(v1).buffer)
  assert.equal(v1Result.kind, 'complete')
  if (v1Result.kind === 'complete') assert.deepEqual(v1Result.overview.tensors[0].shape, [7n])

  const big = inspectGGUF(Uint8Array.from(header(3, 0n, 0n, false)).buffer)
  assert.equal(big.kind, 'complete')
  if (big.kind === 'complete') assert.equal(big.overview.endianness, 'big')
})

test('rejects GGUF shape overflow and unsafe counts', () => {
  const overflow = header(3, 1n, 0n, true)
  appendString(overflow, 'overflow', 3, true)
  appendInteger(overflow, 2n, 4, true)
  appendInteger(overflow, (1n << 64n) - 1n, 8, true)
  appendInteger(overflow, 2n, 8, true)
  appendInteger(overflow, 0n, 4, true)
  appendInteger(overflow, 0n, 8, true)
  const overflowResult = inspectGGUF(Uint8Array.from(overflow).buffer)
  assert.equal(overflowResult.kind, 'invalid')
  if (overflowResult.kind === 'invalid') assert.match(overflowResult.message, /shape 溢出/)

  const tooMany = inspectGGUF(Uint8Array.from(header(3, 1_000_001n, 0n, true)).buffer)
  assert.deepEqual(tooMany, { kind: 'invalid', message: 'GGUF tensor 数量超过安全上限。' })
})

test('rejects invalid bools, duplicate keys, and oversized arrays', () => {
  const invalidBool = header(3, 0n, 1n, true)
  appendString(invalidBool, 'general.flag', 3, true)
  appendInteger(invalidBool, 7n, 4, true)
  appendInteger(invalidBool, 2n, 1, true)
  assert.equal(inspectGGUF(Uint8Array.from(invalidBool).buffer).kind, 'invalid')

  const duplicate = header(3, 0n, 2n, true)
  appendMetadataUInt32(duplicate, 'general.alignment', 32)
  appendMetadataUInt32(duplicate, 'general.alignment', 32)
  const duplicateResult = inspectGGUF(Uint8Array.from(duplicate).buffer)
  assert.equal(duplicateResult.kind, 'invalid')
  if (duplicateResult.kind === 'invalid') assert.match(duplicateResult.message, /key 无效或重复/)

  const oversizedArray = header(3, 0n, 1n, true)
  appendString(oversizedArray, 'general.values', 3, true)
  appendInteger(oversizedArray, 9n, 4, true)
  appendInteger(oversizedArray, 4n, 4, true)
  appendInteger(oversizedArray, 1_000_001n, 8, true)
  const arrayResult = inspectGGUF(Uint8Array.from(oversizedArray).buffer)
  assert.equal(arrayResult.kind, 'invalid')
  if (arrayResult.kind === 'invalid') assert.match(arrayResult.message, /array 元素数量/)
})

function makeV3(): Uint8Array {
  const data = header(3, 1n, 3n, true)
  appendMetadataString(data, 'general.architecture', 'llama')
  appendMetadataUInt32(data, 'llama.context_length', 4096)
  appendString(data, 'general.tags', 3, true)
  appendInteger(data, 9n, 4, true)
  appendInteger(data, 8n, 4, true)
  appendInteger(data, 2n, 8, true)
  appendString(data, 'chat', 3, true)
  appendString(data, 'test', 3, true)
  appendString(data, 'blk.0.weight', 3, true)
  appendInteger(data, 2n, 4, true)
  appendInteger(data, 4n, 8, true)
  appendInteger(data, 8n, 8, true)
  appendInteger(data, 14n, 4, true)
  appendInteger(data, 0n, 8, true)
  return Uint8Array.from(data)
}

function header(version: number, tensors: bigint, metadata: bigint, little: boolean): number[] {
  const data = [...new TextEncoder().encode('GGUF')]
  appendInteger(data, BigInt(version), 4, little)
  const countBytes = version === 1 ? 4 : 8
  appendInteger(data, tensors, countBytes, little)
  appendInteger(data, metadata, countBytes, little)
  return data
}

function appendMetadataString(data: number[], key: string, value: string) {
  appendString(data, key, 3, true)
  appendInteger(data, 8n, 4, true)
  appendString(data, value, 3, true)
}

function appendMetadataUInt32(data: number[], key: string, value: number) {
  appendString(data, key, 3, true)
  appendInteger(data, 4n, 4, true)
  appendInteger(data, BigInt(value), 4, true)
}

function appendString(data: number[], value: string, version: number, little: boolean) {
  const encoded = new TextEncoder().encode(value)
  appendInteger(data, BigInt(encoded.byteLength), version === 1 ? 4 : 8, little)
  data.push(...encoded)
}

function appendInteger(data: number[], value: bigint, bytes: number, little: boolean) {
  for (let index = 0; index < bytes; index += 1) {
    const shift = BigInt((little ? index : bytes - index - 1) * 8)
    data.push(Number((value >> shift) & 0xffn))
  }
}
