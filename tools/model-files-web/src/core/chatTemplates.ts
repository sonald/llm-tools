export type ChatTemplateSource = 'tokenizerConfig' | 'jinjaFile'

export type ChatTemplateEntry = {
  id: string
  name: string
  source: ChatTemplateSource
  body: string
  usable: boolean
}

export type ChatTemplateCatalog = {
  entries: ChatTemplateEntry[]
  activeId: string | null
  conflict: boolean
}

export function parseChatTemplates(value: unknown): ChatTemplateCatalog {
  let entries: ChatTemplateEntry[] = []
  if (typeof value === 'string') {
    entries = [entry('tokenizerConfig', 'default', value)]
  }
  else if (isRecord(value)) {
    entries = Object.keys(value).toSorted().map(name => {
      const body = value[name]
      if (typeof body !== 'string') throw new Error('chat_template 不支持的形态：对象值必须是字符串。')
      return entry('tokenizerConfig', name, body)
    })
  }
  else if (Array.isArray(value)) {
    entries = value.map((item, index) => {
      if (!isRecord(item)) {
        throw new Error(`chat_template 的第 ${index} 个 named 条目无效：必须是包含 name 和 template 的对象。`)
      }
      if (typeof item.name !== 'string' || item.name === '') {
        throw new Error(`chat_template 的第 ${index} 个 named 条目无效：name 必须是非空字符串。`)
      }
      if (typeof item.template !== 'string') {
        throw new Error(`chat_template 的第 ${index} 个 named 条目无效：template 必须是字符串。`)
      }
      return entry('tokenizerConfig', item.name, item.template)
    })
  }
  else if (value !== undefined) {
    throw new Error('chat_template 不支持的形态：null、数字或布尔值。支持字符串、对象字典或 named 数组。')
  }
  return build(entries)
}

export function mergeChatTemplates(
  config: ChatTemplateCatalog,
  independentTemplate: string | null,
): ChatTemplateCatalog {
  const jinja = independentTemplate === null ? null : entry('jinjaFile', 'default', independentTemplate)
  const entries = [...(jinja === null ? [] : [jinja]), ...config.entries]
  const activeId = jinja?.usable === true ? jinja.id : config.activeId
  return build(entries, activeId, jinja?.usable === true && config.entries.some(item => item.usable))
}

export function selectChatTemplate(catalog: ChatTemplateCatalog, requestedId?: string | null): ChatTemplateCatalog {
  return build(catalog.entries, requestedId ?? null, catalog.conflict)
}

export function activeChatTemplate(catalog: ChatTemplateCatalog): ChatTemplateEntry | null {
  return catalog.entries.find(item => item.id === catalog.activeId && item.usable) ?? null
}

function build(entries: ChatTemplateEntry[], requestedId: string | null = null, conflict = false): ChatTemplateCatalog {
  return { entries, activeId: selectId(entries, requestedId), conflict }
}

function selectId(entries: ChatTemplateEntry[], requestedId: string | null): string | null {
  const index = requestedId === null ? -1 : entries.findIndex(item => item.id === requestedId)
  if (index !== -1) {
    if (entries[index].usable) return requestedId
    return entries.slice(index + 1).find(isUsable)?.id ?? entries.slice(0, index).find(isUsable)?.id ?? null
  }
  return entries.find(item => item.name === 'default' && item.usable)?.id ?? entries.find(isUsable)?.id ?? null
}

function entry(source: ChatTemplateSource, name: string, body: string): ChatTemplateEntry {
  return { id: `${source}:${name}`, name, source, body, usable: body.trim().length > 0 }
}

const isUsable = (item: ChatTemplateEntry) => item.usable

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
