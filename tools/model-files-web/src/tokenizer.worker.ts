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
import { isTokenizerRequest, type TokenizerReply, type TokenizerRequest } from './tokenizerProtocol.ts'

let tokenizer: Tokenizer | null = null
let specialIndex: SpecialTokenIndex | null = null
let tokenizerError = 'Tokenizer 尚未加载。'
let vocabularySource: unknown = null
let vocabularyAvailable = false
let vocabularyIndex: ReturnType<typeof buildTokenizerVocabularyIndex> | null = null
let loadedTokenizerIdentity = ''

self.onmessage = async (event: MessageEvent<unknown>) => {
  const request = event.data
  if (!isTokenizerRequest(request)) return
  try {
    if (request.operation === 'render-template') {
      self.postMessage(reply(request, true, new Template(request.source).render(request.context)))
      return
    }
    if (request.operation === 'inspect-structure') {
      const parsedTokenizer: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.tokenizerData))
      if (!isRecord(parsedTokenizer)) throw new Error('tokenizer.json 根节点不是对象。')
      self.postMessage(reply(request, true, inspectTokenizerStructure(parsedTokenizer)))
      return
    }
    if (request.operation === 'load') {
      tokenizer = null
      specialIndex = null
      tokenizerError = 'Tokenizer 尚未加载。'
      vocabularySource = null
      vocabularyAvailable = false
      vocabularyIndex = null
      loadedTokenizerIdentity = ''
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
      self.postMessage(reply(request, true, structure))
      loadedTokenizerIdentity = request.tokenizerIdentity
      return
    }
    if (request.operation === 'search-vocabulary') {
      if (request.tokenizerIdentity !== loadedTokenizerIdentity) throw new Error('Tokenizer 身份已变化，请重新加载。')
      if (request.query.trim().length === 0) {
        self.postMessage(reply(request, true, []))
        return
      }
      if (!vocabularyAvailable) throw new Error(tokenizerError)
      vocabularyIndex ??= buildTokenizerVocabularyIndex(vocabularySource)
      if (vocabularyIndex.entries === null) {
        throw new Error(`当前 vocab 结构无法搜索：${vocabularyIndex.error}`)
      }
      self.postMessage(reply(request, true, filterTokenizerVocabulary(vocabularyIndex.entries, request.query)))
      return
    }
    if (tokenizer === null || specialIndex === null) throw new Error(tokenizerError)
    if (request.tokenizerIdentity !== loadedTokenizerIdentity) throw new Error('Tokenizer 身份已变化，请重新加载。')
    const activeTokenizer = tokenizer
    const activeSpecialIndex = specialIndex
    if (request.operation === 'chat-tokenize') {
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
      self.postMessage(reply(request, true, result))
      return
    }
    if (request.operation === 'decode-token-ids') {
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
      self.postMessage(reply(request, true, result))
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
    self.postMessage(reply(request, true, result))
  } catch (error) {
    self.postMessage(reply(request, false, undefined, error instanceof Error ? error.message : String(error)))
  }
}

function reply(
  request: TokenizerRequest,
  ok: boolean,
  value?: unknown,
  error?: string,
): TokenizerReply {
  const metadata = {
    kind: 'reply' as const,
    operation: request.operation,
    requestId: request.requestId,
    sessionId: request.sessionId,
    generation: request.generation,
    tokenizerIdentity: request.tokenizerIdentity,
  }
  return ok ? { ...metadata, ok, value } : { ...metadata, ok, error: error ?? '' }
}

function encodeText(tokenizer: Tokenizer, text: string, label: string) {
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error(`${label}超过 64 KiB 上限。`)
  return tokenizer.encode(text, { add_special_tokens: false })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
