import assert from 'node:assert/strict'
import test from 'node:test'
import { dtypeSummary, inspectSafeTensorsHeader, safeTensorsFacts, safeTensorsHeaderLength, safeTensorsMetadata } from './inspectors.ts'

// Goldens from running native Support/SafetensorsInspector.swift on the same JSON (W-6).
const accepted: Array<[string, string, string]> = [
  ['valid', '{"__metadata__":{"format":"pt"},"b":{"dtype":"F32","shape":[2],"data_offsets":[0,8]},"a":{"dtype":"BF16","shape":[2,2],"data_offsets":[8,16]}}',
    'params=6 bytes=16 a:BF16:[2,2]:4:8:8,b:F32:[2]:2:8:0'],
  ['unknownDtype', '{"w":{"dtype":"WEIRD","shape":[3],"data_offsets":[0,5]}}', 'params=3 bytes=5 w:WEIRD:[3]:3:5:0'],
  ['layoutMismatch', '{"w":{"dtype":"F32","shape":[3],"data_offsets":[0,5]}}', 'params=3 bytes=5 w:F32:[3]:3:5:0'],
  ['nonContiguous', '{"w":{"dtype":"F32","shape":[1],"data_offsets":[100,104]}}', 'params=1 bytes=4 w:F32:[1]:1:4:100'],
  ['overlap', '{"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]},"b":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}',
    'params=2 bytes=8 a:F32:[1]:1:4:0,b:F32:[1]:1:4:0'],
  ['floatShape', '{"w":{"dtype":"F32","shape":[2.7],"data_offsets":[0,8]}}', 'params=2 bytes=8 w:F32:[2]:2:8:0'],
  ['boolShape', '{"w":{"dtype":"F32","shape":[true],"data_offsets":[0,4]}}', 'params=1 bytes=4 w:F32:[1]:1:4:0'],
  ['negHalfOffset', '{"w":{"dtype":"F32","shape":[1],"data_offsets":[-0.5,4]}}', 'params=1 bytes=4 w:F32:[1]:1:4:0'],
  ['emptyObject', '{}', 'params=0 bytes=0 '],
  ['extraFields', '{"w":{"dtype":"F32","shape":[2],"data_offsets":[0,8],"extra":true}}', 'params=2 bytes=8 w:F32:[2]:2:8:0'],
  ['emptyShape', '{"w":{"dtype":"F32","shape":[],"data_offsets":[0,4]}}', 'params=1 bytes=4 w:F32:[]:1:4:0'],
  ['expOffset', '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,1e3]}}', 'params=1 bytes=1000 w:F32:[1]:1:1000:0'],
  ['bigOffset', '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,9007199254740993]}}', 'params=1 bytes=9007199254740993 w:F32:[1]:1:9007199254740993:0'],
  ['offsetIntMax', '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,9223372036854775807]}}',
    'params=1 bytes=9223372036854775807 w:F32:[1]:1:9223372036854775807:0'],
  // A double past Int64 saturates in NSNumber.int64Value.
  ['shape1e20', '{"w":{"dtype":"F32","shape":[1e20],"data_offsets":[0,4]}}',
    'params=9223372036854775807 bytes=4 w:F32:[9223372036854775807]:9223372036854775807:4:0'],
  ['trailingSpaces', '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}     ', 'params=1 bytes=4 w:F32:[1]:1:4:0'],
  ['sortOrder', '{"l.10.w":{"dtype":"F32","shape":[0],"data_offsets":[0,0]},"l.2.w":{"dtype":"F32","shape":[0],"data_offsets":[0,0]},"L.1.w":{"dtype":"F32","shape":[0],"data_offsets":[0,0]},"a_b":{"dtype":"F32","shape":[0],"data_offsets":[0,0]},"a.b":{"dtype":"F32","shape":[0],"data_offsets":[0,0]}}',
    'params=0 bytes=0 a_b:F32:[0]:0:0:0,a.b:F32:[0]:0:0:0,L.1.w:F32:[0]:0:0:0,l.2.w:F32:[0]:0:0:0,l.10.w:F32:[0]:0:0:0'],
]

const rejected: Array<[string, string, RegExp]> = [
  ['negativeShape', '{"w":{"dtype":"F32","shape":[-1],"data_offsets":[0,4]}}', /SafeTensors tensor w 的结构无效。/],
  ['stringShape', '{"w":{"dtype":"F32","shape":["2"],"data_offsets":[0,8]}}', /SafeTensors tensor w 的结构无效。/],
  ['threeOffsets', '{"w":{"dtype":"F32","shape":[2],"data_offsets":[0,4,8]}}', /SafeTensors tensor w 的结构无效。/],
  ['endBeforeStart', '{"w":{"dtype":"F32","shape":[2],"data_offsets":[8,0]}}', /SafeTensors tensor w 的 data_offsets 无效。/],
  ['dtypeNumber', '{"w":{"dtype":1,"shape":[2],"data_offsets":[0,8]}}', /SafeTensors tensor w 的结构无效。/],
  ['metadataNumber', '{"__metadata__":{"x":1},"w":{"dtype":"F32","shape":[2],"data_offsets":[0,8]}}', /__metadata__ 必须是字符串字典。/],
  ['metadataNull', '{"__metadata__":null}', /__metadata__ 必须是字符串字典。/],
  ['hugeShape', '{"w":{"dtype":"F32","shape":[4294967296,4294967296],"data_offsets":[0,8]}}', /SafeTensors tensor w 的 shape 溢出。/],
  ['uint64Offset', '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,18446744073709551615]}}', /SafeTensors tensor w 的结构无效。/],
  // The inspector alone says 根节点不是对象; native's loader rejects the non-`{` first byte before it gets there.
  ['offsetPastInt64', '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,9300000000000000000]}}', /SafeTensors tensor w 的结构无效。/],
  ['rootArray', '[1]', /SafeTensors header 无效。/],
  // Native loader: the first byte must be `{` and the bytes must parse as JSON.
  ['leadingSpace', ' {}', /SafeTensors header 无效。/],
  ['leadingNewline', '\n{}', /SafeTensors header 无效。/],
  ['bom', '﻿{}', /SafeTensors header 无效。/],
  ['trailingNul', '{}\u0000\u0000', /JSON/],
]

function describe(json: string): string {
  const summary = inspectSafeTensorsHeader(new TextEncoder().encode(json).buffer)
  const tensors = summary.tensors
    .map(tensor => `${tensor.name}:${tensor.dtype}:[${tensor.shape.join(',')}]:${tensor.parameters}:${tensor.bytes}:${tensor.offset}`)
  return `params=${summary.parameterCount} bytes=${summary.dataBytes} ${tensors.join(',')}`
}

test('accepts exactly what native SafetensorsInspector accepts', () => {
  for (const [name, json, expected] of accepted) assert.equal(describe(json), expected, name)
})

test('rejects exactly what native SafetensorsInspector rejects', () => {
  for (const [name, json, message] of rejected) {
    assert.throws(() => describe(json), (error: Error) => message.test(error.message), name)
  }
})

test('header length follows the native loader limits', () => {
  const prefix = (length: bigint) => {
    const buffer = new ArrayBuffer(8)
    new DataView(buffer).setBigUint64(0, length, true)
    return buffer
  }
  assert.equal(safeTensorsHeaderLength(prefix(32n), 40), 32)
  assert.equal(safeTensorsHeaderLength(prefix(2n), null), 2)
  assert.throws(() => safeTensorsHeaderLength(prefix(1n), 100), /^Error: SafeTensors header 无效。$/)
  assert.throws(() => safeTensorsHeaderLength(prefix(33n), 40), /^Error: SafeTensors header 无效。$/)
  assert.throws(() => safeTensorsHeaderLength(prefix(25_000_001n), null), /^Error: SafeTensors header 为 25,000,001 字节，超过安全上限。$/)
  assert.equal(safeTensorsHeaderLength(prefix(25_000_000n), null), 25_000_000)
})

test('builds native overview facts and String-ordered metadata', () => {
  const summary = inspectSafeTensorsHeader(new TextEncoder().encode(JSON.stringify({
    __metadata__: { b: '2', B: '1', a: '3' },
    x: { dtype: 'F32', shape: [1000, 1000], data_offsets: [0, 4_000_000] },
    y: { dtype: 'BF16', shape: [3], data_offsets: [4_000_000, 4_000_006] },
    z: { dtype: 'F32', shape: [1], data_offsets: [4_000_006, 4_000_010] },
  })).buffer)
  assert.deepEqual(safeTensorsFacts(summary, 1234).map(field => [field.key, field.value, field.origin]), [
    ['Tensor 数量', '3', 'derived'],
    ['参数总数', '1,000,004', 'derived'],
    ['权重数据大小', '4 MB', 'derived'],
    ['主要数据类型', 'BF16 × 1 · F32 × 2', 'derived'],
    ['Header 大小', '1 KB', 'runtime'],
  ])
  assert.deepEqual(safeTensorsMetadata(summary).map(field => `${field.key}=${field.value}:${field.type}:${field.origin}`),
    ['B=1:string:embedded', 'a=3:string:embedded', 'b=2:string:embedded'])
  assert.equal(dtypeSummary({ F16: 1200, BF16: 3 }), 'BF16 × 3 · F16 × 1,200')
})
