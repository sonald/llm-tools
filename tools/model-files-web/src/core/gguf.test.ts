import assert from 'node:assert/strict'
import test from 'node:test'
import { ggufFacts, inspectGGUF, readGGUFDirectory, swiftFloatDescription, type GGUFOverview } from './gguf.ts'

// Goldens: `String(Float(bitPattern:))` / `String(Double(bitPattern:))` printed by swift on macOS.
const swiftDescriptions: Array<[32 | 64, bigint, string]> = [
  [32, 1036831949n, '0.1'], [32, 897988541n, '1e-06'], [32, 925353388n, '1e-05'], [32, 953267854n, '9.9999e-05'],
  [32, 953267991n, '0.0001'], [32, 956016770n, '0.00012'], [32, 981668463n, '0.001'], [32, 1065353216n, '1.0'],
  [32, 1176256512n, '10000.0'], [32, 1259902592n, '10000000.0'], [32, 1266679807n, '16777215.0'], [32, 1266679808n, '16777216.0'],
  [32, 1266679809n, '1.6777218e+07'], [32, 1268291200n, '2e+07'], [32, 1287568416n, '1e+08'], [32, 2139095039n, '3.4028235e+38'],
  [32, 2147483648n, '-0.0'], [32, 1051372203n, '0.33333334'], [32, 3223322624n, '-2.5'], [32, 1206984794n, '123456.7'],
  [32, 1n, '1e-45'], [32, 944879383n, '5e-05'], [32, 7136238n, '1e-38'], [32, 8388608n, '1.1754944e-38'],
  [32, 1199562752n, '65504.0'], [32, 930850946n, '1.5e-05'], [32, 1088421888n, '7.0'], [32, 1120403456n, '100.0'],
  [32, 2143289344n, 'nan'], [32, 2139095040n, 'inf'],
  [64, 4591870180066957722n, '0.1'], [64, 4517329193108106637n, '1e-06'], [64, 4532020583610935537n, '1e-05'],
  [64, 4547007114640246159n, '9.99999e-05'], [64, 4547007122018943789n, '0.0001'], [64, 4548482861544840553n, '0.00012'],
  [64, 4607182418800017408n, '1.0'], [64, 4831355200913801216n, '1000000000000000.0'], [64, 4845873199050653695n, '9007199254740991.0'],
  [64, 4845873199050653696n, '9007199254740992.0'], [64, 4845873199050653697n, '9.007199254740994e+15'], [64, 4846369599423283200n, '1e+16'],
  [64, 4861130398305394688n, '1e+17'], [64, 4728057454355411894n, '123456789.123'], [64, 9223372036854775808n, '-0.0'],
  [64, 4599676419421066581n, '0.3333333333333333'], [64, 1n, '5e-324'], [64, 9094988921128908188n, '1e+300'],
  [64, 4551510721646314285n, '0.0002'], [64, 13728134904377344886n, '-1.5e-07'], [64, 4936209963552724370n, '1e+22'],
  [64, 4950912855330343670n, '1e+23'], [64, 4892433759222981601n, '1.2345678901234567e+19'], [64, 18442240474082181120n, '-inf'],
]

test('formats GGUF float metadata like Swift String(Float) and String(Double)', () => {
  for (const [bits, pattern, expected] of swiftDescriptions) {
    const view = new DataView(new ArrayBuffer(8))
    if (bits === 32) view.setUint32(0, Number(pattern))
    else view.setBigUint64(0, pattern)
    assert.equal(swiftFloatDescription(bits === 32 ? view.getFloat32(0) : view.getFloat64(0), bits), expected, `${bits}:${pattern}`)
  }
  const data = header(3, 0n, 1n, true)
  appendString(data, 'llama.attention.layer_norm_rms_epsilon', 3, true)
  appendInteger(data, 6n, 4, true)
  appendInteger(data, 897988541n, 4, true)
  const result = inspectGGUF(Uint8Array.from(data).buffer)
  assert.equal(result.kind === 'complete' && result.overview.metadata[0].display, '1e-06')
})

test('skips uncaptured array strings without decoding them, like native', () => {
  const data = header(3, 0n, 1n, true)
  appendString(data, 'tokenizer.ggml.tokens', 3, true)
  appendInteger(data, 9n, 4, true)
  appendInteger(data, 8n, 4, true)
  appendInteger(data, 17n, 8, true)
  for (let index = 0; index < 16; index += 1) appendString(data, `t${index}`, 3, true)
  appendInteger(data, 2n, 8, true)
  data.push(0xff, 0xfe)
  const result = inspectGGUF(Uint8Array.from(data).buffer)
  assert.equal(result.kind, 'complete')
  if (result.kind === 'complete') assert.match(result.overview.metadata[0].display, /^\[t0, t1, .*t15, …\] · 17 项$/)
})

test('reads the GGUF directory in sequential exact chunks within the budget', async () => {
  const file = new Uint8Array(300)
  const directory = makeV3()
  file.set(directory)
  const ranges: string[] = []
  const reader = (start: number, end: number) => {
    ranges.push(`${start}-${end}`)
    return Promise.resolve(file.slice(start, end + 1).buffer)
  }
  const result = await readGGUFDirectory(file.byteLength, reader, 100, 1024)
  assert.deepEqual(ranges, ['0-99', '100-199', '200-299'])
  assert.ok(directory.byteLength > 200 && directory.byteLength <= 300, `fixture is ${directory.byteLength} bytes`)
  assert.equal(result.bytesRead, 300)
  assert.equal(result.overview.tensors[0].name, 'blk.0.weight')

  // The last chunk stops at the file end; a short file that never completes is invalid, not over budget.
  ranges.length = 0
  const truncated = directory.slice(0, 150)
  await assert.rejects(readGGUFDirectory(truncated.byteLength, (start, end) => {
    ranges.push(`${start}-${end}`)
    return Promise.resolve(truncated.slice(start, end + 1).buffer)
  }, 100, 1024), /^Error: GGUF 无效：文件在 metadata 与 tensor 目录完成前结束。$/)
  assert.deepEqual(ranges, ['0-99', '100-149'])

  ranges.length = 0
  await assert.rejects(readGGUFDirectory(10_000, reader, 100, 200), /^Error: GGUF metadata 与 tensor 目录超过 32 MB 安全上限。$/)
  assert.deepEqual(ranges, ['0-99', '100-199'])
  await assert.rejects(readGGUFDirectory(null, reader), /^Error: 来源未提供文件大小，无法安全读取 GGUF 前缀。$/)
  await assert.rejects(readGGUFDirectory(0, reader), /来源未提供文件大小/)
  const bad = new TextEncoder().encode('GGUX0000').buffer
  await assert.rejects(readGGUFDirectory(8, () => Promise.resolve(bad)), /^Error: GGUF 无效：GGUF magic 无效。$/)
})

test('orders GGUF overview facts like native ggufFacts', () => {
  const result = inspectGGUF(makeV3().buffer)
  assert.equal(result.kind, 'complete')
  const overview = (result as { overview: GGUFOverview }).overview
  assert.deepEqual(ggufFacts(overview, 1_048_576).map(field => `${field.key}=${field.value}:${field.type}:${field.origin}`), [
    '架构=llama:string:embedded',
    '主要数据类型=Q6_K:dtype:derived',
    '上下文长度=4,096:count:embedded',
    'Tensor 数量=1:count:derived',
    '参数总数=32:count:derived',
    'Metadata 数量=3:count:derived',
    '数据区对齐=32 字节:bytes:embedded',
    `Tensor 数据起点=${overview.tensorDataOffset}:offset:derived`,
    '已读取前缀=1 MB:bytes:runtime',
  ])
  const imatrix: GGUFOverview = {
    ...overview,
    metadata: [{ key: 'general.type', type: 'string', display: 'imatrix', stringValue: 'imatrix', unsignedValue: null },
      { key: 'imatrix.chunk_count', type: 'uint32', display: '12', stringValue: null, unsignedValue: 12n }],
    tensors: ['a.in_sum2', 'a.counts', 'b.in_sum2'].map(name => ({ ...overview.tensors[0], name })),
  }
  assert.deepEqual(ggufFacts(imatrix, 10).map(field => field.key).slice(0, 2), ['Imatrix 条目', 'Tensor 数量'])
  assert.equal(ggufFacts(imatrix, 10)[0].value, '1')
  assert.equal(ggufFacts(imatrix, 10).at(-1)?.key, 'Chunk 数')
})

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
