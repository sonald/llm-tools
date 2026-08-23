import type { Page, Route } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const fixtureModelId = 'fixture/model'
export const fixtureRevision = '0123456789abcdef0123456789abcdef01234567'
const emptyModelId = 'fixture/empty'
export const pythonReaderSource = `class Model:
    def greet(self, name):
        if name:
            return f"hello NEEDLE {name}"
        return "hello needle"
# needle
# 中文 alpha
# 中文 beta
# 🚩
if ready:
    pass
`
export const yamlReaderSource = `model:
  name: demo
  layers:
    - conv
    - linear
count: 2`
export const jsonFoldingSource = `{
  "a": [
    1,
    2
  ],
  "b": { "ok": true }
}`
export const scssReaderSource = `.${'a-b-'.repeat(8000)}`
const boundaryPrefix = `if ready:
    pass
`
const boundaryPythonSource = boundaryPrefix + '#'.repeat(128 * 1024 - new TextEncoder().encode(boundaryPrefix).byteLength)
const boundaryLargePythonSource = boundaryPythonSource + '#'

export type RequestRecord = {
  path: string
  range: string | null
  responseBytes: number
  status: number
}

type FixtureOptions = {
  manifestDelayMs?: number
  delayedContentModelId?: string
  contentDelayMs?: number
  manifestFailures?: number
  rangeBehavior?: 'valid' | 'http200'
  includeBoundaryFiles?: boolean
  includeComparisonTokenizers?: boolean
  omitIndependentChatTemplate?: boolean
  configChatTemplate?: unknown
  largeVocabularyWithoutConfig?: boolean
}

const tokenizer = JSON.stringify({
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: [
    { id: 0, content: '[UNK]', special: true },
    { id: 1, content: '[CLS]', special: true },
    { id: 2, content: '[SEP]', special: true },
  ],
  normalizer: {
    type: 'BertNormalizer',
    clean_text: true,
    handle_chinese_chars: true,
    strip_accents: null,
    lowercase: true,
  },
  pre_tokenizer: { type: 'BertPreTokenizer' },
  post_processor: null,
  decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
  model: {
    type: 'WordPiece',
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
    vocab: {
      '[UNK]': 0,
      '[CLS]': 1,
      '[SEP]': 2,
      hello: 3,
      world: 4,
      '##s': 5,
    },
  },
})

const tokenizerConfig = JSON.stringify({
  tokenizer_class: 'BertTokenizer',
  unk_token: '[UNK]',
  eos_token_id: 1,
  model_max_length: 128,
  chat_template: '{{ messages[0].content }}',
})

const chatTemplate = `{%- for message in messages -%}
{{ message.role }}={{ message.content if message.content is string else message.content | tojson }};
{%- endfor -%}
{%- if tools %}tools={{ tools | tojson }};{%- endif -%}
thinking={{ enable_thinking }};mode={{ mode }}
{%- if add_generation_prompt %};assistant={% endif -%}`

const files = new Map<string, Uint8Array>([
  ['config.json', bytes(JSON.stringify({
    model_type: 'fixture', architectures: ['FixtureModel'], hidden_size: 8, num_hidden_layers: 2,
    max_position_embeddings: 4096, vocab_size: 1005,
  }))],
  ['generation_config.json', bytes(JSON.stringify({ max_new_tokens: 64, do_sample: false, temperature: 1, eos_token_id: 2 }))],
  ['tokenizer.json', bytes(tokenizer)],
  ['tokenizer_config.json', bytes(tokenizerConfig)],
  ['chat_template.jinja', bytes(chatTemplate)],
  ['vocab.json', bytes(JSON.stringify(Object.fromEntries(Array.from({ length: 10_005 }, (_, index) => [`token-${index}`, index]))))],
  ['merges.txt', bytes(Array.from({ length: 100_002 }, (_, index) => `token-${index} token-${index + 1}`).join('\n'))],
  ['metadata.json', bytes(JSON.stringify({ format: 'fixture', nested: { ok: true } }))],
  ['model.safetensors.index.json', bytes(JSON.stringify({
    metadata: { total_size: 12 },
    weight_map: { 'layer.0': 'model-00001-of-00002.safetensors', 'layer.1': 'model-00002-of-00002.safetensors' },
  }))],
  ['README.md', bytes(`# Fixture Model

| Capability | Result |
| --- | --- |
| Markdown | PASS |

[Config](config.json)

<script>window.__markdownExecuted = true</script>

![Third-party image](https://example.com/tracker.png)

[Unsafe](javascript:alert(1))`)],
  ['imatrix-fixture.dat', imatrixFixture()],
  ['model.safetensors', safeTensorsFixture()],
  ['model.gguf', ggufFixture()],
])

const alternateTokenizer = JSON.stringify({
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: [
    { id: 0, content: '[UNK]', special: true },
    { id: 1, content: '[CLS]', special: true },
    { id: 2, content: '[SEP]', special: true },
  ],
  normalizer: {
    type: 'BertNormalizer',
    clean_text: true,
    handle_chinese_chars: true,
    strip_accents: null,
    lowercase: true,
  },
  pre_tokenizer: { type: 'BertPreTokenizer' },
  post_processor: null,
  decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
  model: {
    type: 'WordPiece',
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
    vocab: {
      '[UNK]': 0,
      '[CLS]': 1,
      '[SEP]': 2,
      hello: 4,
      world: 3,
      '##s': 5,
      'alt-token': 6,
    },
  },
})
const alternateTokenizerConfig = JSON.stringify({
  tokenizer_class: 'BertTokenizer',
  unk_token: '[UNK]',
  eos_token_id: 1,
  model_max_length: 256,
  chat_template: 'ALT-CONFIG {{ messages[0].content }}',
})
const alternateChatTemplate = 'ALT-JINJA {{ messages[0].content }}'

const comparisonFiles = new Map<string, Uint8Array>([
  ['alternate/tokenizer.json', bytes(alternateTokenizer)],
  ['alternate/tokenizer_config.json', bytes(alternateTokenizerConfig)],
  ['alternate/chat_template.jinja', bytes(alternateChatTemplate)],
  ['broken/tokenizer.json', bytes('{"version":"1.0"')],
  ['no-config/tokenizer.json', bytes(alternateTokenizer)],
])

const localReaderFiles = new Map<string, Uint8Array>([
  ['reader.py', bytes(pythonReaderSource)],
  ['reader-copy.py', bytes(pythonReaderSource)],
  ['reader.yaml', bytes(yamlReaderSource)],
  ['folding.json', bytes(jsonFoldingSource)],
  ['boundary.py', bytes(boundaryPythonSource)],
  ['boundary-large.py', bytes(boundaryLargePythonSource)],
  ['reader.scss', bytes(scssReaderSource)],
  ['valid.pdf', pdfFixture()],
  ['invalid.pdf', bytes('This file deliberately lacks a PDF signature.')],
  ['unknown.dat', Uint8Array.from([0x61, 0x00])],
])

export async function installFixtureRoutes(page: Page, options: FixtureOptions = {}): Promise<RequestRecord[]> {
  const requests: RequestRecord[] = []
  let manifestFailures = options.manifestFailures ?? 0
  await page.route('https://**', route => route.abort('blockedbyclient'))
  await page.route('https://huggingface.co/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/api/models/')) {
      if (options.manifestDelayMs !== undefined) await delay(options.manifestDelayMs)
      if (manifestFailures > 0) {
        manifestFailures -= 1
        await route.fulfill({ status: 503, body: 'retry fixture' })
        return
      }
      const modelId = decodeURIComponent(url.pathname.slice('/api/models/'.length))
      if (modelId === emptyModelId) {
        await route.fulfill({
          json: {
            id: modelId,
            sha: 'f'.repeat(40),
            siblings: [{ rfilename: 'README.md', size: files.get('README.md')?.byteLength ?? 0, blobId: 'readme' }],
          },
        })
        return
      }
      await route.fulfill({ json: manifest(
        modelId,
        options.includeBoundaryFiles ?? false,
        options.includeComparisonTokenizers ?? false,
        options.omitIndependentChatTemplate ?? false,
        options.configChatTemplate,
        options.largeVocabularyWithoutConfig ?? false,
      ) })
      return
    }
    await fulfillFile(route, requests, options.rangeBehavior ?? 'valid', options.configChatTemplate,
      options.largeVocabularyWithoutConfig ?? false, options.delayedContentModelId, options.contentDelayMs,
      options.includeComparisonTokenizers ?? false,
    )
  })
  return requests
}

function manifest(
  modelId: string,
  includeBoundaryFiles: boolean,
  includeComparisonTokenizers: boolean,
  omitChatTemplate: boolean,
  configChatTemplate?: unknown,
  largeVocabularyWithoutConfig = false,
) {
  const bodies = comparisonBodies(configChatTemplate, largeVocabularyWithoutConfig, includeComparisonTokenizers)
  return {
    id: modelId,
    sha: modelId === fixtureModelId ? fixtureRevision : 'f'.repeat(40),
    siblings: [
      ...[...bodies]
        .filter(([rfilename]) => !(omitChatTemplate && rfilename === 'chat_template.jinja'))
        .map(([rfilename, body]) => ({ rfilename, size: body.byteLength, blobId: rfilename })),
      ...(includeBoundaryFiles ? [
        { rfilename: 'oversized.json', size: 32 * 1024 * 1024 + 1, blobId: 'oversized' },
        { rfilename: 'pytorch_model.bin', size: 1, blobId: 'locked' },
      ] : []),
    ],
  }
}

export async function writeFixtureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await Promise.all([...files, ...localReaderFiles].map(([path, body]) => writeFile(join(directory, path), body)))
}

async function fulfillFile(
  route: Route,
  requests: RequestRecord[],
  rangeBehavior: NonNullable<FixtureOptions['rangeBehavior']>,
  configChatTemplate?: unknown,
  largeVocabularyWithoutConfig = false,
  delayedContentModelId?: string,
  contentDelayMs?: number,
  includeComparisonTokenizers = false,
) {
  const url = new URL(route.request().url())
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/)
  if (match === null || !/^[0-9a-f]{40}$/i.test(match[3])) {
    await route.fulfill({ status: 404, body: 'missing fixture' })
    return
  }
  const path = decodeURIComponent(match[4])
  const requestedModelId = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`
  if (delayedContentModelId === requestedModelId && contentDelayMs !== undefined) {
    await delay(contentDelayMs)
  }
  const body = comparisonBodies(configChatTemplate, largeVocabularyWithoutConfig, includeComparisonTokenizers).get(path)
  if (body === undefined) {
    await route.fulfill({ status: 404, body: 'missing fixture' })
    return
  }
  const range = route.request().headers().range ?? null
  if (range === null) {
    requests.push({ path, range, responseBytes: body.byteLength, status: 200 })
    await route.fulfill({ status: 200, body: Buffer.from(body) })
    return
  }
  if (rangeBehavior === 'http200') {
    requests.push({ path, range, responseBytes: body.byteLength, status: 200 })
    await route.fulfill({ status: 200, body: Buffer.from(body) })
    return
  }
  const rangeMatch = range.match(/^bytes=(\d+)-(\d+)$/)
  if (rangeMatch === null) throw new Error(`Unexpected Range: ${range}`)
  const start = Number(rangeMatch[1])
  const end = Number(rangeMatch[2])
  const slice = body.slice(start, end + 1)
  requests.push({ path, range, responseBytes: slice.byteLength, status: 206 })
  await route.fulfill({
    status: 206,
    body: Buffer.from(slice),
    headers: {
      'Access-Control-Expose-Headers': 'Content-Range',
      'Content-Length': String(slice.byteLength),
      'Content-Range': `bytes ${start}-${end}/${body.byteLength}`,
    },
  })
}

function comparisonBodies(
  configChatTemplate?: unknown,
  largeVocabularyWithoutConfig = false,
  includeComparisonTokenizers = false,
): Map<string, Uint8Array> {
  let bodies = configChatTemplate === undefined ? files : new Map(files).set('tokenizer_config.json', bytes(JSON.stringify({
    ...JSON.parse(tokenizerConfig),
    chat_template: configChatTemplate,
  })))
  if (largeVocabularyWithoutConfig) {
    const parsed = JSON.parse(tokenizer) as { model: { vocab: Record<string, number> } }
    parsed.model.vocab = Object.fromEntries([
      ...Object.entries(parsed.model.vocab),
      ...Array.from({ length: 1_005 }, (_, index) => [`needle-${index}`, 6 + index]),
    ])
    bodies = new Map(bodies)
    bodies.delete('tokenizer_config.json')
    bodies.set('tokenizer.json', bytes(JSON.stringify(parsed)))
  }
  if (includeComparisonTokenizers) bodies = new Map([...bodies, ...comparisonFiles])
  return bodies
}

function safeTensorsFixture(): Uint8Array {
  const tensors = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [
    `layer.${String(index).padStart(3, '0')}`,
    { dtype: 'F32', shape: [0], data_offsets: [0, 0] },
  ]))
  const rawHeader = bytes(JSON.stringify({
    __metadata__: { format: 'pt' },
    ...tensors,
    weight: { dtype: 'F32', shape: [2], data_offsets: [0, 8] },
  }))
  const header = new Uint8Array(Math.ceil(rawHeader.byteLength / 8) * 8).fill(0x20)
  header.set(rawHeader)
  const file = new Uint8Array(8 + header.byteLength + 8)
  new DataView(file.buffer).setBigUint64(0, BigInt(header.byteLength), true)
  file.set(header, 8)
  return file
}

function ggufFixture(): Uint8Array {
  const file = new Uint8Array(24)
  file.set(bytes('GGUF'))
  const view = new DataView(file.buffer)
  view.setUint32(4, 3, true)
  view.setBigUint64(8, 1n, true)
  view.setBigUint64(16, 0n, true)
  return file
}

function imatrixFixture(): Uint8Array {
  const output: number[] = []
  appendInt32(output, 2)
  appendImatrixEntry(output, 'blk.0.ffn.weight', 4, [0.5, 1.5])
  appendImatrixEntry(output, 'blk.0.attn.weight', 8, [1, 2, 3])
  appendInt32(output, 12)
  const dataset = bytes('calibration.txt')
  appendInt32(output, dataset.length)
  output.push(...dataset)
  return Uint8Array.from(output)
}

function pdfFixture(): Uint8Array {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    const offset = bytes(pdf).byteLength
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    offsets.push(offset)
  })
  const xrefStart = bytes(pdf).byteLength
  pdf += 'xref\n0 4\n0000000000 65535 f \n'
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`
  return bytes(pdf)
}

function appendImatrixEntry(output: number[], name: string, calls: number, values: number[]) {
  const encoded = bytes(name)
  appendInt32(output, encoded.length)
  output.push(...encoded)
  appendInt32(output, calls)
  appendInt32(output, values.length)
  for (const value of values) {
    const data = new Uint8Array(4)
    new DataView(data.buffer).setFloat32(0, value, true)
    output.push(...data)
  }
}

function appendInt32(output: number[], value: number) {
  const data = new Uint8Array(4)
  new DataView(data.buffer).setInt32(0, value, true)
  output.push(...data)
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
