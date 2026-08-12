import { inspectGGUF } from '../src/core/gguf.ts'

const model = process.argv[2] ?? 'bartowski/Qwen_Qwen3-0.6B-GGUF'
const requestedFile = process.argv[3] ?? 'Qwen_Qwen3-0.6B-IQ2_M.gguf'
const chunkBytes = 1024 * 1024
const budgetBytes = 32 * 1024 * 1024

const started = performance.now()
const manifestResponse = await fetch(`https://huggingface.co/api/models/${model}?blobs=true`, {
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
})
if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`)
const manifest = await manifestResponse.json()
const revision = manifest.sha
const file = manifest.siblings?.find(entry => entry.rfilename === requestedFile)
if (!/^[0-9a-f]{40}$/i.test(revision) || !file || !Number.isSafeInteger(file.size) || file.size <= 0) {
  throw new Error('manifest 缺少固定 revision 或目标文件大小')
}

const parts = []
const responseOrigins = new Set([new URL(manifestResponse.url).origin])
let bytesRead = 0
let rangeRequests = 0
let parseMilliseconds = 0
let inspection = { kind: 'needs-more-data' }
const contentURL = `https://huggingface.co/${model}/resolve/${revision}/${requestedFile.split('/').map(encodeURIComponent).join('/')}`

while (inspection.kind === 'needs-more-data' && bytesRead < Math.min(file.size, budgetBytes)) {
  const start = bytesRead
  const end = Math.min(start + chunkBytes, file.size, budgetBytes) - 1
  const response = await fetch(contentURL, {
    headers: { Range: `bytes=${start}-${end}` },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  const expectedRange = `bytes ${start}-${end}/${file.size}`
  responseOrigins.add(new URL(response.url).origin)
  if (response.status !== 206 || response.headers.get('content-range') !== expectedRange) {
    throw new Error(`Range 失败：HTTP ${response.status}, Content-Range ${response.headers.get('content-range')}`)
  }
  const part = new Uint8Array(await response.arrayBuffer())
  if (part.byteLength !== end - start + 1) throw new Error('Range 响应长度不符')
  parts.push(part)
  bytesRead += part.byteLength
  rangeRequests += 1

  const prefix = new Uint8Array(bytesRead)
  let offset = 0
  for (const item of parts) {
    prefix.set(item, offset)
    offset += item.byteLength
  }
  const parseStarted = performance.now()
  inspection = inspectGGUF(prefix.buffer)
  parseMilliseconds += performance.now() - parseStarted
}

const overview = inspection.kind === 'complete' ? inspection.overview : null
const tensorDataBytesRead = overview ? Math.max(0, bytesRead - overview.tensorDataOffset) : null
const gatePassed = overview !== null
  && bytesRead <= budgetBytes
  && tensorDataBytesRead === 0
  && parseMilliseconds <= 2_000
const evidence = {
  decision: gatePassed ? 'GO' : 'NO-GO',
  model,
  file: requestedFile,
  revision,
  fileBytes: file.size,
  chunkBytes,
  budgetBytes,
  bytesRead,
  rangeRequests,
  responseOrigins: [...responseOrigins],
  parseMilliseconds: Number(parseMilliseconds.toFixed(2)),
  totalElapsedMilliseconds: Number((performance.now() - started).toFixed(2)),
  parseStatus: inspection.kind,
  tensorDataOffset: overview?.tensorDataOffset ?? null,
  tensorDataBytesRead,
  metadataCount: overview?.metadata.length ?? null,
  tensorCount: overview?.tensors.length ?? null,
  parameterCount: overview?.parameterCount.toString() ?? null,
  reason: gatePassed
    ? '32 MiB 内完成解析，未读取 tensor 数据，解析耗时不超过 2 秒。'
    : inspection.kind === 'invalid'
      ? inspection.message
      : overview === null
        ? '32 MiB 预算内未完成 metadata 与 tensor directory 解析。'
        : tensorDataBytesRead !== 0
          ? '顺序 Range 的最后一个分块越过 tensor data offset，无法证明 0 bytes tensor 数据。'
          : '解析耗时超过 2 秒。',
}

console.log(JSON.stringify(evidence, null, 2))
