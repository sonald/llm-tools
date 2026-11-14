import { translate as t } from '../i18n.ts'

// Native TemplateRenderer.swift: the playground's structured input and the context it hands the template.
export type TemplateValueKind = 'string' | 'integer' | 'decimal' | 'boolean' | 'json' | 'null'
export type MessageContentKind = 'text' | 'json'
export type TemplateMessage = { id: string; role: string; contentKind: MessageContentKind; content: string }
export type TemplateTool = { id: string; name: string; description: string; parametersJSON: string }
export type TemplateVariable = { id: string; name: string; kind: TemplateValueKind; value: string }
export type TemplateRequest = {
  messages: TemplateMessage[]
  includeTools: boolean
  tools: TemplateTool[]
  variables: TemplateVariable[]
  addGenerationPrompt: boolean
}

export const templateValueKinds: TemplateValueKind[] = ['string', 'integer', 'decimal', 'boolean', 'json', 'null']
export const messageRoles = ['system', 'user', 'assistant', 'tool']

let nextId = 0
export const newId = () => `t${(nextId += 1)}`

export function message(role: string, content: string, contentKind: MessageContentKind = 'text'): TemplateMessage {
  return { id: newId(), role, contentKind, content }
}

export function variable(name: string, kind: TemplateValueKind, value = ''): TemplateVariable {
  return { id: newId(), name, kind, value }
}

export const basicMessages = () => [message('system', 'You are a helpful assistant.'), message('user', 'Hello!')]
export const toolMessages = () => [message('system', 'You are a helpful assistant.'), message('user', 'What is the weather in Shanghai?')]
export const multimodalMessages = () => [message('user', `[
  {"type": "image", "url": "image://sample"},
  {"type": "text", "text": "Describe this image."}
]`, 'json')]

export const weatherTool = (): TemplateTool => ({
  id: newId(),
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parametersJSON: `{
  "type": "object",
  "properties": {
    "city": {"type": "string", "description": "City name"}
  },
  "required": ["city"]
}`,
})

export const emptyTool = (): TemplateTool => ({
  id: newId(),
  name: 'new_tool',
  description: '',
  parametersJSON: `{
  "type": "object",
  "properties": {}
}`,
})

// Native initialVariables: string or explicit-null special tokens from the config (object-form tokens are skipped),
// plus enable_thinking / documents when the original template mentions them.
export function initialVariables(template: string, tokenizerConfig: Record<string, unknown>): TemplateVariable[] {
  const result: TemplateVariable[] = []
  for (const name of ['bos_token', 'eos_token', 'pad_token', 'unk_token']) {
    const value = tokenizerConfig[name]
    if (typeof value === 'string') result.push(variable(name, 'string', value))
    else if (value === null) result.push(variable(name, 'null'))
  }
  if (template.includes('enable_thinking')) result.push(variable('enable_thinking', 'boolean', 'true'))
  if (template.includes('documents')) result.push(variable('documents', 'json', '[]'))
  return result
}

// Native TemplateRenderer.context: messages first, then tools (absent, not [], when off), then typed variables.
export function templateContext(request: TemplateRequest): Record<string, unknown> {
  const context: Record<string, unknown> = {
    messages: request.messages.map(item => ({
      role: item.role,
      content: item.contentKind === 'text' ? item.content : parseJSON(item.content, `${item.role} message content`),
    })),
    add_generation_prompt: request.addGenerationPrompt,
  }
  if (request.includeTools) context.tools = request.tools.map(toolValue)
  const reserved = new Set([...Object.keys(context), 'tools'])
  const seen = new Set<string>()
  for (const item of request.variables) {
    const name = item.name.trim()
    if (name === '') throw new Error(t('templateVariableNameRequired'))
    if (reserved.has(name)) throw new Error(t('templateVariableReserved', { name }))
    if (seen.has(name)) throw new Error(t('templateVariableDuplicate', { name }))
    seen.add(name)
    context[name] = variableValue(item)
  }
  return context
}

function toolValue(tool: TemplateTool) {
  const name = tool.name.trim()
  if (name === '') throw new Error(t('templateToolNameRequired'))
  const parameters = parseJSON(tool.parametersJSON, `Tool ${name} parameters`)
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error(t('templateToolParametersObject', { name }))
  }
  return { type: 'function', function: { name, description: tool.description, parameters } }
}

function variableValue(item: TemplateVariable): unknown {
  switch (item.kind) {
    case 'string': return item.value
    case 'integer': {
      const value = swiftInt(item.value)
      if (value === null) throw new Error(t('templateVariableInteger', { name: item.name }))
      return value
    }
    case 'decimal': {
      const value = swiftDouble(item.value)
      if (value === null) throw new Error(t('templateVariableNumber', { name: item.name }))
      return value
    }
    case 'boolean': return item.value !== 'false'
    case 'json': return parseJSON(item.value, t('templateVariableLabel', { name: item.name }))
    case 'null': return null
  }
}

function parseJSON(source: string, label: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    // Native: JSONSerialization's localizedDescription, never the parser's position detail.
    throw new Error(t('templateJsonInvalid', { label, message: t('jsonDataCorrupted') }))
  }
}

// Swift Int(String): optional sign and ASCII digits only, within Int64.
// ponytail: JS numbers lose precision past 2^53; values beyond that keep their nearest double.
export function swiftInt(text: string): number | null {
  if (!/^[+-]?\d+$/.test(text)) return null
  const value = BigInt(text)
  return value < -(2n ** 63n) || value >= 2n ** 63n ? null : Number(value)
}

// Swift Double(String) (strtod): decimal with optional exponent, inf/infinity/nan, hexadecimal; no whitespace.
export function swiftDouble(text: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text)
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(text)
  if (special !== null) return special[2].toLowerCase() === 'nan' ? Number.NaN : (special[1] === '-' ? -Infinity : Infinity)
  const hex = /^([+-]?)0x([0-9a-f]+)$/i.exec(text)
  if (hex !== null) return (hex[1] === '-' ? -1 : 1) * Number.parseInt(hex[2], 16)
  return null
}
