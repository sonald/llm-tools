/// <reference lib="webworker" />

import { Tokenizer } from '@huggingface/tokenizers'
import { Template } from '@huggingface/jinja'
import {
  buildSpecialTokenIndex,
  buildTokenization,
  buildTokenizerVocabularyIndex,
  filterTokenizerVocabulary,
  inspectTokenizerStructure,
  tokenFlag,
  type SpecialTokenIndex,
} from './core/tokenizer.ts'
import {
  chatContentProbe,
  chatTokenOverhead,
  chatTokenRoles,
  type ChatAttributionMessage,
} from './core/tokenAttribution.ts'
import { parseChatTemplates } from './core/chatTemplates.ts'

type Request =
  | { id: number; type: 'load'; tokenizerData: ArrayBuffer; configData: ArrayBuffer | null }
  | { id: number; type: 'inspect-structure'; tokenizerData: ArrayBuffer }
  | { id: number; type: 'tokenize'; text: string }
  | {
    id: number
    type: 'chat-tokenize'
    template: string
    context: Record<string, unknown>
    attribution: ChatAttributionMessage[]
  }
  | { id: number; type: 'decode-token-ids'; ids: number[]; originalInput: string }
  | { id: number; type: 'render-template'; source: string; context: Record<string, unknown> }
  | { id: number; type: 'search-vocabulary'; query: string }

let tokenizer: Tokenizer | null = null
let specialIndex: SpecialTokenIndex | null = null
let tokenizerError = 'Tokenizer 尚未加载。'
let vocabularySource: unknown = null
let vocabularyAvailable = false
let vocabularyIndex: ReturnType<typeof buildTokenizerVocabularyIndex> | null = null

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.type === 'render-template') {
      self.postMessage({ id: request.id, ok: true, value: new Template(request.source).render(request.context) })
      return
    }
    if (request.type === 'inspect-structure') {
      const parsedTokenizer: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.tokenizerData))
      if (!isRecord(parsedTokenizer)) throw new Error('tokenizer.json 根节点不是对象。')
      self.postMessage({ id: request.id, ok: true, value: inspectTokenizerStructure(parsedTokenizer) })
      return
    }
    if (request.type === 'load') {
      tokenizer = null
      specialIndex = null
      tokenizerError = 'Tokenizer 尚未加载。'
      vocabularySource = null
      vocabularyAvailable = false
      vocabularyIndex = null
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const parsedTokenizer: unknown = JSON.parse(decoder.decode(request.tokenizerData))
      if (!isRecord(parsedTokenizer)) throw new Error('tokenizer.json 根节点不是对象。')
      const structure = inspectTokenizerStructure(parsedTokenizer)
      const model = isRecord(parsedTokenizer.model) ? parsedTokenizer.model : null
      vocabularySource = model?.vocab ?? null
      vocabularyAvailable = true
      if (request.configData === null) {
        tokenizerError = '缺少 tokenizer_config.json，当前运行时无法严格构造 Tokenizer。'
      } else {
        const parsedConfig: unknown = JSON.parse(decoder.decode(request.configData))
        if (!isRecord(parsedConfig)) throw new Error('tokenizer_config.json 根节点不是对象。')
        structure.chatTemplates = parseChatTemplates(parsedConfig.chat_template)
        try {
          tokenizer = new Tokenizer(parsedTokenizer, parsedConfig)
          specialIndex = buildSpecialTokenIndex(
            parsedConfig,
            Array.isArray(parsedTokenizer.added_tokens) ? parsedTokenizer.added_tokens : [],
            piece => [...new Set(tokenizer?.encode(piece, { add_special_tokens: false }).ids ?? [])],
          )
          tokenizerError = ''
        } catch (error) {
          tokenizerError = error instanceof Error ? error.message : String(error)
        }
      }
      self.postMessage({ id: request.id, ok: true, value: structure })
      return
    }
    if (request.type === 'search-vocabulary') {
      if (request.query.trim().length === 0) {
        self.postMessage({ id: request.id, ok: true, value: [] })
        return
      }
      if (!vocabularyAvailable) throw new Error(tokenizerError)
      vocabularyIndex ??= buildTokenizerVocabularyIndex(vocabularySource)
      if (vocabularyIndex.entries === null) {
        throw new Error(`当前 vocab 结构无法搜索：${vocabularyIndex.error}`)
      }
      self.postMessage({
        id: request.id,
        ok: true,
        value: filterTokenizerVocabulary(vocabularyIndex.entries, request.query),
      })
      return
    }
    if (tokenizer === null || specialIndex === null) throw new Error(tokenizerError)
    const activeTokenizer = tokenizer
    const activeSpecialIndex = specialIndex
    if (request.type === 'chat-tokenize') {
      const rendered = new Template(request.template).render(request.context)
      const probe = chatContentProbe(request.attribution)
      const encoding = encodeText(activeTokenizer, rendered, 'Chat 渲染输入')
      const probeEncoding = encodeText(activeTokenizer, probe, 'Chat 正文 probe')
      const decoded = encoding.ids.length === 0 ? '' : activeTokenizer.decode(encoding.ids, { skip_special_tokens: false })
      const baseResult = buildTokenization(
        rendered,
        encoding.ids,
        encoding.tokens,
        decoded,
        ids => activeTokenizer.decode(ids, { skip_special_tokens: false }),
        encoding.tokens.map((piece, index) => tokenFlag(encoding.ids[index], piece, activeSpecialIndex)),
        'encode',
        chatTokenOverhead(encoding.ids.length, probeEncoding.ids.length, probe),
      )
      const result = {
        ...baseResult,
        roles: chatTokenRoles(rendered, request.attribution, baseResult),
      }
      self.postMessage({ id: request.id, ok: true, value: result })
      return
    }
    if (request.type === 'decode-token-ids') {
      const pieces = request.ids.map(id => activeTokenizer.id_to_token(id) ?? null)
      const decoded = request.ids.length === 0 ? '' : activeTokenizer.decode(request.ids, { skip_special_tokens: false })
      const result = buildTokenization(
        request.originalInput,
        request.ids,
        pieces,
        decoded,
        ids => activeTokenizer.decode(ids, { skip_special_tokens: false }),
        request.ids.map((id, index) => tokenFlag(id, pieces[index], activeSpecialIndex, pieces[index] ? undefined : () => activeTokenizer.decode([id], { skip_special_tokens: false }))),
        'decode',
      )
      self.postMessage({ id: request.id, ok: true, value: result })
      return
    }
    const encoding = encodeText(activeTokenizer, request.text, '输入')
    const decoded = encoding.ids.length === 0 ? '' : activeTokenizer.decode(encoding.ids, { skip_special_tokens: false })
    const result = buildTokenization(
      request.text,
      encoding.ids,
      encoding.tokens,
      decoded,
      ids => activeTokenizer.decode(ids, { skip_special_tokens: false }),
      encoding.tokens.map((piece, index) => tokenFlag(encoding.ids[index], piece, activeSpecialIndex)),
      'encode',
    )
    self.postMessage({ id: request.id, ok: true, value: result })
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function encodeText(tokenizer: Tokenizer, text: string, label: string) {
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error(`${label}超过 64 KiB 上限。`)
  return tokenizer.encode(text, { add_special_tokens: false })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
