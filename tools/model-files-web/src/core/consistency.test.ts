import assert from 'node:assert/strict'
import test from 'node:test'
import { activeChatTemplate } from './chatTemplates.ts'
import type { ChatTemplateSource } from './chatTemplates.ts'
import type { AddedTokenSummary, TokenizerStructure } from './tokenizer.ts'
import {
  analyzeRepositoryConsistency,
  type ConsistencyMaterial,
  type RepositoryConsistencyMaterials,
} from './consistency.ts'

const available = <T>(value: T): ConsistencyMaterial<T> => ({ state: 'available', value })

const materials = (
  overrides: Partial<RepositoryConsistencyMaterials> = {},
): RepositoryConsistencyMaterials => ({
  config: { state: 'missing' },
  generationConfig: { state: 'missing' },
  tokenizerConfig: { state: 'missing' },
  tokenizer: { state: 'missing' },
  adapterConfig: { state: 'missing' },
  processorConfig: { state: 'missing' },
  chatTemplates: { state: 'missing' },
  gguf: { state: 'missing' },
  ...overrides,
})

const tokenizer = (
  vocabCount: number | null = null,
  addedTokens: AddedTokenSummary[] = [],
): TokenizerStructure => ({
  version: null,
  modelType: null,
  vocabCount,
  mergeCount: null,
  addedTokenCount: addedTokens.length,
  addedTokens,
  fields: [],
  vocabulary: null,
  vocabularyError: null,
  chatTemplates: { entries: [], activeId: null, conflict: false },
})

const catalog = (activeId: string | null = null) => ({
  entries: activeId === null ? [] : [{
    id: activeId,
    name: 'default',
    source: 'jinjaFile' as ChatTemplateSource,
    body: '{{ messages }}',
    usable: true,
  }],
  activeId,
  conflict: false,
})

test('builds identity fields with fixed order, aliases, adapters, and processor sizes', () => {
  const report = analyzeRepositoryConsistency(materials({
    config: available({
      architectures: ['QwenForCausalLM'],
      num_hidden_layers: 32,
      n_layer: 99,
      hidden_size: 4096,
      d_model: 99,
      vocab_size: 100,
      max_position_embeddings: 8192,
      max_sequence_length: 99,
      num_experts: 64,
      num_experts_per_tok: 8,
    }),
    adapterConfig: available({
      peft_type: 'LORA',
      base_model_name_or_path: 'Qwen/Base',
    }),
    processorConfig: available({
      image_size: 448,
      size: { width: 224, height: 256 },
      crop_size: 'center',
      processor_class: '   ',
      image_processor_type: 'CLIPImageProcessor',
    }),
  }))

  assert.deepEqual(report.identityFields.map(field => [field.key, field.value]), [
    ['architecture', 'QwenForCausalLM'],
    ['layers', '32'],
    ['hidden_size', '4096'],
    ['vocab_size', '100'],
    ['context', '8192'],
    ['num_experts', '64'],
    ['num_experts_per_tok', '8'],
    ['peft_type', 'LORA'],
    ['base_model_name_or_path', 'Qwen/Base'],
    ['image_size', '448'],
    ['size', '224×256'],
    ['crop_size', 'center'],
    ['image_processor_type', 'CLIPImageProcessor'],
  ])
  assert.ok(report.identityFields.every(field => field.origin === 'embedded'))
})

test('rejects non-safe non-negative integers in identity aliases', () => {
  const report = analyzeRepositoryConsistency(materials({
    config: available({
      architectures: 'not-an-array-first',
      model_type: ' llama ',
      num_hidden_layers: true,
      hidden_size: 1.5,
      vocab_size: -1,
      max_position_embeddings: Number.MAX_SAFE_INTEGER + 1,
      num_experts: 2,
    }),
  }))

  assert.deepEqual(report.identityFields.map(field => [field.key, field.type, field.value]), [
    ['architecture', 'string', 'llama'],
    ['num_experts', 'count', '2'],
  ])
})

test('keeps an empty-string architecture before model_type', () => {
  const report = analyzeRepositoryConsistency(materials({
    config: available({
      architectures: [''],
      model_type: 'llama',
    }),
  }))

  assert.deepEqual(report.identityFields.map(field => [field.key, field.type, field.value]), [
    ['architecture', 'string', ''],
  ])
})

test('reports vocabulary mismatch only for valid counts and derives fallback count', () => {
  const mismatch = analyzeRepositoryConsistency(materials({
    config: available({ vocab_size: 100 }),
    tokenizer: available(tokenizer(99)),
  }))
  const finding = mismatch.findings.find(item => item.id === 'vocab-mismatch')

  assert.equal(finding?.severity, 'warning')
  assert.deepEqual(finding?.left, {
    key: 'config.vocab_size',
    type: 'count',
    value: '100',
    origin: 'embedded',
  })
  assert.deepEqual(finding?.right, {
    key: 'tokenizer.vocab_count',
    type: 'count',
    value: '99',
    origin: 'derived',
  })

  const fallback = analyzeRepositoryConsistency(materials({
    config: available({ vocab_size: 100 }),
    tokenizer: available({
      ...tokenizer(null),
      vocabulary: {
        tokenCount: 99,
        averageScalarLength: 1,
        p50ScalarLength: 1,
        p90ScalarLength: 1,
        p95ScalarLength: 1,
        p99ScalarLength: 1,
        maximumScalarLength: 1,
        buckets: [],
        longestTokens: [],
      },
    }),
  }))
  assert.equal(fallback.findings.find(item => item.id === 'vocab-mismatch')?.right.value, '99')

  const matching = analyzeRepositoryConsistency(materials({
    config: available({ vocab_size: 100 }),
    tokenizer: available(tokenizer(100)),
  }))
  assert.equal(matching.findings.some(item => item.id === 'vocab-mismatch'), false)

  const negativeVocabCount = analyzeRepositoryConsistency(materials({
    config: available({ vocab_size: 100 }),
    tokenizer: available(tokenizer(-1)),
  }))
  assert.equal(negativeVocabCount.findings.some(item => item.id === 'vocab-mismatch'), false)

  const unsafeFallback = analyzeRepositoryConsistency(materials({
    config: available({ vocab_size: 100 }),
    tokenizer: available({
      ...tokenizer(null),
      vocabulary: {
        tokenCount: Number.MAX_SAFE_INTEGER + 1,
        averageScalarLength: 1,
        p50ScalarLength: 1,
        p90ScalarLength: 1,
        p95ScalarLength: 1,
        p99ScalarLength: 1,
        maximumScalarLength: 1,
        buckets: [],
        longestTokens: [],
      },
    }),
  }))
  assert.equal(unsafeFallback.findings.some(item => item.id === 'vocab-mismatch'), false)
})

test('flags a missing tokenizer class only after a successful object root', () => {
  const missing = analyzeRepositoryConsistency(materials({
    config: available({ model_type: 'llama' }),
    tokenizerConfig: available({ tokenizer_class: ' \n\t ' }),
  }))
  assert.equal(missing.findings.find(item => item.id === 'missing-tokenizer-class')?.severity, 'warning')

  const present = analyzeRepositoryConsistency(materials({
    tokenizerConfig: available({ tokenizer_class: ' LlamaTokenizer ' }),
  }))
  assert.equal(present.findings.some(item => item.id === 'missing-tokenizer-class'), false)

  const badRoot = analyzeRepositoryConsistency(materials({
    tokenizerConfig: available([]),
  }))
  assert.equal(badRoot.findings.some(item => item.id === 'missing-tokenizer-class'), false)
  assert.deepEqual(badRoot.coverage.find(item => item.material === 'tokenizerConfig')?.status, {
    state: 'failed',
    message: 'JSON 根节点不是对象。',
  })
})

test('reuses catalog availability for the chat template finding', () => {
  const emptyCatalog = catalog()
  assert.equal(activeChatTemplate(emptyCatalog), null)
  const missing = analyzeRepositoryConsistency(materials({ chatTemplates: available(emptyCatalog) }))
  assert.equal(missing.findings.find(item => item.id === 'missing-chat-template')?.severity, 'info')

  const usable = catalog('jinjaFile:default')
  assert.notEqual(activeChatTemplate(usable), null)
  const present = analyzeRepositoryConsistency(materials({ chatTemplates: available(usable) }))
  assert.equal(present.findings.some(item => item.id === 'missing-chat-template'), false)
})

test('compares EOS IDs safely and uses only one reliable added-token fallback', () => {
  const explicit = analyzeRepositoryConsistency(materials({
    generationConfig: available({ eos_token_id: 3 }),
    tokenizerConfig: available({ eos_token_id: 2 }),
  }))
  const finding = explicit.findings.find(item => item.id === 'eos-mismatch')
  assert.equal(finding?.left.value, '3')
  assert.equal(finding?.right.value, '2')
  assert.equal(finding?.right.origin, 'embedded')

  const sameArrays = analyzeRepositoryConsistency(materials({
    generationConfig: available({ eos_token_id: [3, 2, 2] }),
    tokenizerConfig: available({ eos_token_id: [2, 3] }),
  }))
  assert.equal(sameArrays.findings.some(item => item.id === 'eos-mismatch'), false)

  const fallback = analyzeRepositoryConsistency(materials({
    generationConfig: available({ eos_token_id: [2, 3] }),
    tokenizerConfig: available({ eos_token: { content: '</s>' } }),
    tokenizer: available(tokenizer(10, [{ id: 2, content: '</s>', special: true }])),
  }))
  const fallbackFinding = fallback.findings.find(item => item.id === 'eos-mismatch')
  assert.equal(fallbackFinding?.right.key, 'tokenizer.added_tokens.eos_token_id')
  assert.equal(fallbackFinding?.right.value, '2')
  assert.equal(fallbackFinding?.right.origin, 'derived')

  const noFindings = [
    materials({
      generationConfig: available({ eos_token_id: [2] }),
      tokenizerConfig: available({ eos_token_id: 'bad', eos_token: '</s>' }),
      tokenizer: available(tokenizer(10, [{ id: 2, content: '</s>', special: true }])),
    }),
    materials({
      generationConfig: available({ eos_token_id: [] }),
      tokenizerConfig: available({ eos_token_id: 2 }),
    }),
    materials({
      generationConfig: available({ eos_token_id: [2, 'bad'] }),
      tokenizerConfig: available({ eos_token_id: 2 }),
    }),
    materials({
      generationConfig: available({ eos_token_id: 2 }),
      tokenizerConfig: available({ eos_token: '</s>' }),
      tokenizer: available(tokenizer(10, [
        { id: 2, content: '</s>', special: true },
        { id: 3, content: '</s>', special: true },
      ])),
    }),
  ]
  for (const caseMaterials of noFindings) {
    const report = analyzeRepositoryConsistency(caseMaterials)
    assert.equal(report.findings.some(item => item.id === 'eos-mismatch'), false)
  }
})

test('uses context alias priority and reports semantic length differences as info', () => {
  const mismatch = analyzeRepositoryConsistency(materials({
    config: available({
      max_position_embeddings: 4096,
      max_sequence_length: 999,
      n_positions: 888,
    }),
    tokenizerConfig: available({ model_max_length: 8192 }),
  }))
  const finding = mismatch.findings.find(item => item.id === 'context-info')
  assert.equal(finding?.severity, 'info')
  assert.equal(finding?.left.value, '4096')

  const matching = analyzeRepositoryConsistency(materials({
    config: available({ n_positions: 4096 }),
    tokenizerConfig: available({ model_max_length: 4096 }),
  }))
  assert.equal(matching.findings.some(item => item.id === 'context-info'), false)
})

test('reports missing config only when the material itself is missing', () => {
  const cases = [
    materials(),
    materials({ config: { state: 'skipped', reason: '未选择' } }),
    materials({ config: { state: 'failed', message: '读取失败' } }),
    materials({ config: available([]) }),
  ]
  const expected = [true, false, false, false]
  cases.forEach((caseMaterials, index) => {
    assert.equal(
      analyzeRepositoryConsistency(caseMaterials).findings.some(item => item.id === 'missing-config'),
      expected[index],
    )
  })
})

test('produces exactly eight coverage rows in fixed material order with all four states', () => {
  const report = analyzeRepositoryConsistency(materials({
    config: available({}),
    generationConfig: { state: 'failed', message: '读取失败' },
    tokenizerConfig: { state: 'skipped', reason: '未选择' },
    tokenizer: available(tokenizer()),
    adapterConfig: available([]),
    processorConfig: { state: 'missing' },
    chatTemplates: { state: 'skipped', reason: '未启用' },
    gguf: { state: 'skipped', reason: '未在当前会话打开' },
  }))

  assert.deepEqual(report.coverage.map(item => item.material), [
    'config',
    'generationConfig',
    'tokenizerConfig',
    'tokenizer',
    'adapterConfig',
    'processorConfig',
    'chatTemplates',
    'gguf',
  ])
  assert.deepEqual(report.coverage.map(item => item.status), [
    { state: 'checked' },
    { state: 'failed', message: '读取失败' },
    { state: 'skipped', reason: '未选择' },
    { state: 'checked' },
    { state: 'failed', message: 'JSON 根节点不是对象。' },
    { state: 'missing' },
    { state: 'skipped', reason: '未启用' },
    { state: 'skipped', reason: '未在当前会话打开' },
  ])
})

test('never checks GGUF or emits GGUF findings', () => {
  for (const gguf of [{ state: 'missing' }, { state: 'skipped', reason: 'GGUF 暂不检查' }] as const) {
    const report = analyzeRepositoryConsistency(materials({
      config: available({ vocab_size: 1, max_position_embeddings: 2 }),
      tokenizer: available(tokenizer(2)),
      gguf,
    }))
    assert.equal(report.coverage.at(-1)?.material, 'gguf')
    assert.deepEqual(report.coverage.at(-1)?.status, gguf)
    assert.equal(report.findings.some(item => item.id.startsWith('gguf-')), false)
  }
})

test('skips runtime-available GGUF without emitting findings', () => {
  const report = analyzeRepositoryConsistency(materials({
    config: available({ vocab_size: 1 }),
    gguf: available(undefined as never),
  }))

  assert.deepEqual(report.coverage.at(-1)?.status, {
    state: 'skipped',
    reason: 'Web 仅读取 24-byte prefix，缺少 metadata/tensor directory。',
  })
  assert.equal(report.findings.some(item => item.id.startsWith('gguf-')), false)
})

test('continues other findings when one JSON material has a bad root', () => {
  const report = analyzeRepositoryConsistency(materials({
    config: available({ vocab_size: 100, max_position_embeddings: 4096 }),
    generationConfig: available({ eos_token_id: 3 }),
    tokenizerConfig: available({ eos_token_id: 2, model_max_length: 8192 }),
    tokenizer: available(tokenizer(99)),
    adapterConfig: available('{'),
  }))

  assert.deepEqual(report.findings.map(item => item.id), [
    'vocab-mismatch',
    'missing-tokenizer-class',
    'eos-mismatch',
    'context-info',
  ])
  assert.deepEqual(report.coverage.find(item => item.material === 'adapterConfig')?.status, {
    state: 'failed',
    message: 'JSON 根节点不是对象。',
  })
})

test('publishes findings in the stable native-derived order', () => {
  const report = analyzeRepositoryConsistency(materials({
    config: available({
      vocab_size: 100,
      max_position_embeddings: 4096,
    }),
    generationConfig: available({ eos_token_id: 3 }),
    tokenizerConfig: available({
      tokenizer_class: '',
      eos_token_id: 2,
      model_max_length: 8192,
    }),
    tokenizer: available(tokenizer(99)),
    chatTemplates: available(catalog()),
  }))

  assert.deepEqual(report.findings.map(item => item.id), [
    'vocab-mismatch',
    'missing-tokenizer-class',
    'missing-chat-template',
    'eos-mismatch',
    'context-info',
  ])
})
