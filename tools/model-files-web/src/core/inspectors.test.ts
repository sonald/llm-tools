import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectGGUFPrefix, inspectSafeTensorsHeader, safeTensorsHeaderLength } from './inspectors.ts'

test('reads and inspects a SafeTensors header without tensor data', () => {
  const prefix = new ArrayBuffer(8)
  new DataView(prefix).setBigUint64(0, 32n, true)
  assert.equal(safeTensorsHeaderLength(prefix), 32)

  const header = headerBytes({
    __metadata__: { format: 'pt' },
    weight: { dtype: 'BF16', shape: [4, 8], data_offsets: [0, 64] },
  })
  const result = inspectSafeTensorsHeader(header, 64n)
  assert.equal(result.parameterCount, 32n)
  assert.equal(result.dataBytes, 64n)
  assert.deepEqual(result.metadata, { format: 'pt' })
  assert.deepEqual(
    { start: result.tensors[0].dataStart, end: result.tensors[0].dataEnd, bytes: result.tensors[0].bytes },
    { start: 0n, end: 64n, bytes: 64n },
  )
})

test('rejects invalid SafeTensors metadata and root values', () => {
  assert.throws(() => inspectSafeTensorsHeader(headerBytes([])), /根节点不是对象/)
  assert.throws(() => inspectSafeTensorsHeader(headerBytes({ __metadata__: { format: 3 } })), /字符串字典/)
})

test('rejects unknown and byte-misaligned SafeTensors dtypes', () => {
  assert.throws(() => inspectSafeTensorsHeader(headerBytes({
    weight: { dtype: 'F128', shape: [1], data_offsets: [0, 16] },
  })), /weight.*dtype F128/)
  assert.throws(() => inspectSafeTensorsHeader(headerBytes({
    weight: { dtype: 'F4', shape: [1], data_offsets: [0, 1] },
  })), /weight.*字节对齐/)
})

test('rejects shape overflow and dtype byte-size mismatches', () => {
  assert.throws(() => inspectSafeTensorsHeader(headerBytes({
    huge: { dtype: 'U64', shape: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], data_offsets: [0, 0] },
  })), /huge.*shape 溢出/)
  assert.throws(() => inspectSafeTensorsHeader(headerBytes({
    weight: { dtype: 'F32', shape: [2], data_offsets: [0, 4] },
  })), /weight.*shape、dtype 与 data_offsets 不匹配/)
})

test('rejects gaps, overlaps, and incomplete SafeTensors data buffers', () => {
  assert.throws(() => inspectSafeTensorsHeader(headerBytes({
    weight: { dtype: 'F32', shape: [1], data_offsets: [4, 8] },
  })), /weight.*不连续/)
  assert.throws(() => inspectSafeTensorsHeader(headerBytes({
    first: { dtype: 'F32', shape: [1], data_offsets: [0, 4] },
    second: { dtype: 'F32', shape: [1], data_offsets: [2, 6] },
  })), /second.*不连续/)
  assert.throws(() => inspectSafeTensorsHeader(headerBytes({
    weight: { dtype: 'F32', shape: [1], data_offsets: [0, 4] },
  }), 8n), /数据区大小/)
})

test('reads a GGUF v3 prefix', () => {
  const prefix = new ArrayBuffer(24)
  const bytes = new Uint8Array(prefix)
  bytes.set(new TextEncoder().encode('GGUF'))
  const view = new DataView(prefix)
  view.setUint32(4, 3, true)
  view.setBigUint64(8, 42n, true)
  view.setBigUint64(16, 7n, true)
  assert.deepEqual(inspectGGUFPrefix(prefix), {
    version: 3,
    endianness: 'little',
    tensorCount: 42n,
    metadataCount: 7n,
  })
})

function headerBytes(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer
}
