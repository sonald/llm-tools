import { activeChatTemplate } from './chatTemplates.ts'
import type { ChatTemplateCatalog } from './chatTemplates.ts'
import type { TokenizerStructure } from './tokenizer.ts'

export type ConsistencyMaterial<T> =
  | { state: 'missing' }
  | { state: 'available'; value: T }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; message: string }

export type ConsistencyMaterialKind =
  | 'config'
  | 'generationConfig'
  | 'tokenizerConfig'
  | 'tokenizer'
  | 'adapterConfig'
  | 'processorConfig'
  | 'chatTemplates'
  | 'gguf'

export type ConsistencyField = {
  key: string
  type: string
  value: string
  origin: 'embedded' | 'derived' | 'repository'
}

export type ConsistencyFinding = {
  id:
    | 'vocab-mismatch'
    | 'missing-tokenizer-class'
    | 'missing-chat-template'
    | 'eos-mismatch'
    | 'context-info'
    | 'missing-config'
  severity: 'warning' | 'info'
  title: string
  left: ConsistencyField
  right: ConsistencyField
  detail: string
}

export type ConsistencyCoverage = {
  material: ConsistencyMaterialKind
  status:
    | { state: 'checked' }
    | { state: 'missing' }
    | { state: 'skipped'; reason: string }
    | { state: 'failed'; message: string }
}

export type RepositoryConsistencyMaterials = {
  config: ConsistencyMaterial<unknown>
  generationConfig: ConsistencyMaterial<unknown>
  tokenizerConfig: ConsistencyMaterial<unknown>
  tokenizer: ConsistencyMaterial<TokenizerStructure>
  adapterConfig: ConsistencyMaterial<unknown>
  processorConfig: ConsistencyMaterial<unknown>
  chatTemplates: ConsistencyMaterial<ChatTemplateCatalog>
  gguf: ConsistencyMaterial<never>
}

export type RepositoryConsistencyReport = {
  identityFields: ConsistencyField[]
  findings: ConsistencyFinding[]
  coverage: ConsistencyCoverage[]
}

export function analyzeRepositoryConsistency(materials: RepositoryConsistencyMaterials): RepositoryConsistencyReport {
  const config = jsonObject(materials.config)
  const generation = jsonObject(materials.generationConfig)
  const tokenizerConfig = jsonObject(materials.tokenizerConfig)
  const adapter = jsonObject(materials.adapterConfig)
  const processor = jsonObject(materials.processorConfig)
  const tokenizer = materialValue(materials.tokenizer)
  const chatTemplates = materialValue(materials.chatTemplates)

  let identityFields: ConsistencyField[] = []
  if (config.object) {
    const first = Array.isArray(config.object.architectures)
      ? config.object.architectures[0]
      : undefined
    const architecture = typeof first === 'string'
      ? first
      : nonEmptyString(config.object.model_type)
    if (architecture !== null) identityFields.push(field('architecture', 'string', architecture, 'embedded'))
    identityFields = [
      ...identityFields,
      ...identity('layers', ['num_hidden_layers', 'n_layer', 'num_layers'], config.object),
      ...identity('hidden_size', ['hidden_size', 'n_embd', 'd_model'], config.object),
      ...identity('vocab_size', ['vocab_size'], config.object),
      ...identity('context', ['max_position_embeddings', 'max_sequence_length', 'n_positions'], config.object),
      ...identity('num_experts', ['num_experts'], config.object),
      ...identity('num_experts_per_tok', ['num_experts_per_tok'], config.object),
    ]
  }
  if (adapter.object) {
    for (const key of ['peft_type', 'base_model_name_or_path'] as const) {
      const value = nonEmptyString(adapter.object[key])
      if (value) identityFields.push(field(key, 'string', value, 'embedded'))
    }
  }
  if (processor.object) {
    for (const key of ['image_size', 'size', 'crop_size', 'processor_class', 'image_processor_type'] as const) {
      const value = displayValue(processor.object[key])
      if (value) identityFields.push(field(key, 'value', value, 'embedded'))
    }
  }

  const findings: ConsistencyFinding[] = []
  const configVocab = unsigned(config.object?.vocab_size)
  const rawTokenizerVocab = tokenizer === null || tokenizer.vocabCount === null
    ? tokenizer?.vocabulary?.tokenCount ?? null
    : tokenizer.vocabCount
  const tokenizerVocab = rawTokenizerVocab === null ? null : unsigned(rawTokenizerVocab)
  if (configVocab !== null && tokenizerVocab !== null && configVocab !== tokenizerVocab) {
    findings.push({
      id: 'vocab-mismatch',
      severity: 'warning',
      title: '词表大小不一致',
      left: field('config.vocab_size', 'count', String(configVocab), 'embedded'),
      right: field('tokenizer.vocab_count', 'count', String(tokenizerVocab), 'derived'),
      detail: 'config.json 与 tokenizer.json 的词表项数不同。',
    })
  }

  if (tokenizerConfig.checked && !nonEmptyString(tokenizerConfig.object.tokenizer_class)) {
    findings.push({
      id: 'missing-tokenizer-class',
      severity: 'warning',
      title: '缺少 tokenizer_class',
      left: field('tokenizer_config.json', 'file', '已读取', 'repository'),
      right: field('tokenizer_class', 'string', '缺失', 'embedded'),
      detail: '严格 tokenizer runtime 无法在未显式指定 class 时构造。',
    })
  }

  if (chatTemplates && activeChatTemplate(chatTemplates) === null) {
    findings.push({
      id: 'missing-chat-template',
      severity: 'info',
      title: '缺少可用 Chat Template',
      left: field('chat_template.jinja', 'template', '未发现', 'repository'),
      right: field('tokenizer_config.chat_template', 'template', '不可用', 'derived'),
      detail: '仓库中没有可用的独立或内嵌 Chat Template。',
    })
  }

  const generationEos = parsedTokenIds(generation.object?.eos_token_id)
  const tokenizerEos = tokenizerEOS(tokenizerConfig.object, tokenizer)
  if (generationEos && tokenizerEos && !sameIDs(generationEos, tokenizerEos.ids)) {
    findings.push({
      id: 'eos-mismatch',
      severity: 'warning',
      title: 'EOS Token 不一致',
      left: field('generation_config.eos_token_id', 'token IDs', tokenIDDisplay(generationEos), 'embedded'),
      right: tokenizerEos.field,
      detail: 'generation_config 与 tokenizer 的可靠 EOS ID 不同。',
    })
  }

  const configContext = contextValue(config.object)
  const tokenizerContext = unsigned(tokenizerConfig.object.model_max_length)
  if (configContext !== null && tokenizerContext !== null && configContext !== tokenizerContext) {
    findings.push({
      id: 'context-info',
      severity: 'info',
      title: '上下文长度声明不同',
      left: field('config.context', 'count', String(configContext), 'embedded'),
      right: field('tokenizer_config.model_max_length', 'count', String(tokenizerContext), 'embedded'),
      detail: '模型与 tokenizer 的长度上限经常承担不同语义，请人工确认。',
    })
  }

  if (materials.config.state === 'missing') {
    findings.push({
      id: 'missing-config',
      severity: 'info',
      title: '缺少模型配置',
      left: field('repository', 'source', '当前仓库', 'repository'),
      right: field('config.json', 'file', '缺失', 'repository'),
      detail: '仓库中没有 config.json 或 configuration.json。',
    })
  }

  return {
    identityFields,
    findings,
    coverage: [
      coverage('config', config.status),
      coverage('generationConfig', generation.status),
      coverage('tokenizerConfig', tokenizerConfig.status),
      coverage('tokenizer', materialStatus(materials.tokenizer)),
      coverage('adapterConfig', adapter.status),
      coverage('processorConfig', processor.status),
      coverage('chatTemplates', materialStatus(materials.chatTemplates)),
      coverage('gguf', ggufStatus(materials.gguf)),
    ],
  }
}

type ParsedJSON = {
  object: Record<string, unknown>
  checked: boolean
  status: ConsistencyCoverage['status']
}

function jsonObject(material: ConsistencyMaterial<unknown>): ParsedJSON {
  switch (material.state) {
    case 'missing':
      return { object: {}, checked: false, status: { state: 'missing' } }
    case 'skipped':
      return { object: {}, checked: false, status: material }
    case 'failed':
      return { object: {}, checked: false, status: material }
    case 'available':
      return isRecord(material.value)
        ? { object: material.value, checked: true, status: { state: 'checked' } }
        : { object: {}, checked: false, status: { state: 'failed', message: 'JSON 根节点不是对象。' } }
  }
}

function materialValue<T>(material: ConsistencyMaterial<T>): T | null {
  return material.state === 'available' ? material.value : null
}

function materialStatus(material: ConsistencyMaterial<unknown>): ConsistencyCoverage['status'] {
  switch (material.state) {
    case 'available':
      return { state: 'checked' }
    case 'missing':
    case 'skipped':
    case 'failed':
      return material
  }
}

// ponytail: GGUF is intentionally unavailable in this web slice; add a parser before widening this union.
function ggufStatus(material: ConsistencyMaterial<never>): ConsistencyCoverage['status'] {
  return material.state === 'available'
    ? { state: 'skipped', reason: 'Web 仅读取 24-byte prefix，缺少 metadata/tensor directory。' }
    : material
}

function identity(key: string, aliases: string[], object: Record<string, unknown>): ConsistencyField[] {
  for (const alias of aliases) {
    const value = unsigned(object[alias])
    if (value !== null) return [field(key, 'count', String(value), 'embedded')]
  }
  return []
}

function field(key: string, type: string, value: string, origin: ConsistencyField['origin']): ConsistencyField {
  return { key, type, value, origin }
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function unsigned(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function displayValue(value: unknown): string | null {
  const text = nonEmptyString(value)
  if (text !== null) return text
  const number = unsigned(value)
  if (number !== null) return String(number)
  if (!isRecord(value)) return null
  const width = unsigned(value.width)
  const height = unsigned(value.height)
  return width === null || height === null ? null : `${width}×${height}`
}

function contextValue(object: Record<string, unknown>): number | null {
  for (const alias of ['max_position_embeddings', 'max_sequence_length', 'n_positions']) {
    const value = unsigned(object[alias])
    if (value !== null) return value
  }
  return null
}

function parsedTokenIds(value: unknown): number[] | null {
  const scalar = unsigned(value)
  if (scalar !== null) return [scalar]
  if (!Array.isArray(value) || value.length === 0) return null
  const ids = value.map(item => unsigned(item))
  return ids.every((id): id is number => id !== null) ? ids : null
}

function tokenIDDisplay(ids: number[]): string {
  return ids.length === 1 ? String(ids[0]) : `[${ids.map(String).join(', ')}]`
}

function sameIDs(left: number[], right: number[]): boolean {
  return new Set(left).size === new Set(right).size
    && [...new Set(left)].every(id => new Set(right).has(id))
}

function tokenizerEOS(
  object: Record<string, unknown>,
  tokenizer: TokenizerStructure | null,
): { ids: number[]; field: ConsistencyField } | null {
  if ('eos_token_id' in object) {
    const ids = parsedTokenIds(object.eos_token_id)
    if (!ids) return null
    return { ids, field: field('tokenizer_config.eos_token_id', 'token IDs', tokenIDDisplay(ids), 'embedded') }
  }

  const content = typeof object.eos_token === 'string'
    ? object.eos_token
    : isRecord(object.eos_token) && typeof object.eos_token.content === 'string'
      ? object.eos_token.content
      : null
  if (content === null || !tokenizer) return null
  const ids = [...new Set(tokenizer.addedTokens.filter(token => token.content === content).map(token => token.id))]
  if (ids.length !== 1 || ids[0] === null) return null
  return {
    ids: [ids[0]],
    field: field('tokenizer.added_tokens.eos_token_id', 'token IDs', String(ids[0]), 'derived'),
  }
}

function coverage(material: ConsistencyMaterialKind, status: ConsistencyCoverage['status']): ConsistencyCoverage {
  return { material, status }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
