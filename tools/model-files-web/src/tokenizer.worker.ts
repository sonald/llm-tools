/// <reference lib="webworker" />

import { Tokenizer } from '@huggingface/tokenizers'
import { Template } from '@huggingface/jinja'
import {
  buildSpecialTokenIndex,
  buildTokenization,
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

let tokenizer: Tokenizer | null = null
let specialIndex: SpecialTokenIndex | null = null
let tokenizerError = 'Tokenizer 尚未加载。'

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.type === 'render-template') {
      self.postMessage({ id: request.id, ok: true, value: new Template(request.source).render(request.context) })
      return
    }
    if (request.type === 'load') {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const parsedTokenizer: unknown = JSON.parse(decoder.decode(request.tokenizerData))
      if (!isRecord(parsedTokenizer)) throw new Error('tokenizer.json 根节点不是对象。')
      const structure = inspectTokenizerStructure(parsedTokenizer)
      tokenizer = null
      specialIndex = null
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
