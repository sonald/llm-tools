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
  buildTokenizerVocabularyDiff,
  filterTokenizerVocabularyDiff,
  type VocabularyDiff,
  type TokenizerStructure,
} from './core/tokenizer.ts'
import {
  chatContentProbe,
  chatTokenOverhead,
  chatTokenRoles,
  type ChatAttributionMessage,
} from './core/tokenAttribution.ts'
import { parseChatTemplates } from './core/chatTemplates.ts'
import { initializeLocalization, translate as t } from './i18n.ts'
import { isTokenizerRequest, type TokenizerReply, type TokenizerRequest } from './tokenizerProtocol.ts'
import { SentencePieceWasm } from './sentencepieceWasm.ts'

const workerLocale = self.name
initializeLocalization(workerLocale === 'zh-Hans' || workerLocale === 'en' ? [workerLocale] : undefined)

let tokenizer: Tokenizer | null = null
let sentencePiece: SentencePieceWasm | null = null
let specialIndex: SpecialTokenIndex = buildSpecialTokenIndex({}, [], () => [])
let tokenizerError = t('tokenizerNotLoaded')
let vocabularySource: unknown = null
let vocabularyAvailable = false
let vocabularyIndex: ReturnType<typeof buildTokenizerVocabularyIndex> | null = null
let loadedTokenizerIdentity = ''
let vocabularyDiff: VocabularyDiff | null = null

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
      if (!isRecord(parsedTokenizer)) throw new Error(t('tokenizerRootNotObject'))
      self.postMessage(reply(request, true, inspectTokenizerStructure(parsedTokenizer)))
      return
    }
    if (request.operation === 'load') {
      tokenizer = null
      sentencePiece?.dispose()
      sentencePiece = null
      specialIndex = buildSpecialTokenIndex({}, [], () => [])
      tokenizerError = t('tokenizerNotLoaded')
      vocabularySource = null
      vocabularyAvailable = false
      vocabularyIndex = null
      vocabularyDiff = null
      loadedTokenizerIdentity = ''
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let structure: TokenizerStructure
      if (request.format === 'sentencepiece') {
        const loadedSentencePiece = await SentencePieceWasm.load(new Uint8Array(request.tokenizerData))
        structure = {
          version: null,
          modelType: 'SentencePiece',
          vocabCount: null,
          mergeCount: null,
          addedTokenCount: 0,
          addedTokens: [],
          fields: [],
          vocabulary: null,
          vocabularyError: t('sentencepieceVocabularyUnavailable'),
          chatTemplates: { entries: [], activeId: null, conflict: false },
        }
        if (request.configData !== null) {
          try {
            const parsedConfig: unknown = JSON.parse(decoder.decode(request.configData))
            if (!isRecord(parsedConfig)) throw new Error(t('tokenizerConfigRootNotObject'))
            structure.chatTemplates = parseChatTemplates(parsedConfig.chat_template)
            specialIndex = buildSpecialTokenIndex(parsedConfig, [], piece => loadedSentencePiece.encodeAsIds(piece))
          } catch (error) {
            loadedSentencePiece.dispose()
            throw error
          }
        }
        sentencePiece = loadedSentencePiece
        tokenizerError = t('sentencepieceVocabularyUnavailable')
      } else {
        const parsedTokenizer: unknown = JSON.parse(decoder.decode(request.tokenizerData))
        if (!isRecord(parsedTokenizer)) throw new Error(t('tokenizerRootNotObject'))
        structure = inspectTokenizerStructure(parsedTokenizer)
        const model = isRecord(parsedTokenizer.model) ? parsedTokenizer.model : null
        vocabularySource = model?.vocab ?? null
        vocabularyAvailable = true
        if (request.configData === null) {
          tokenizerError = t('missingTokenizerConfigRuntime')
        } else {
          const parsedConfig: unknown = JSON.parse(decoder.decode(request.configData))
          if (!isRecord(parsedConfig)) throw new Error(t('tokenizerConfigRootNotObject'))
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
      }
      self.postMessage(reply(request, true, structure))
      loadedTokenizerIdentity = request.tokenizerIdentity
      return
    }
    if (request.operation === 'search-vocabulary') {
      if (request.tokenizerIdentity !== loadedTokenizerIdentity) throw new Error(t('tokenizerIdentityChanged'))
      if (request.query.trim().length === 0) {
        self.postMessage(reply(request, true, []))
        return
      }
      if (!vocabularyAvailable) throw new Error(tokenizerError)
      vocabularyIndex ??= buildTokenizerVocabularyIndex(vocabularySource)
      if (vocabularyIndex.entries === null) {
        throw new Error(t('vocabularySearchUnsupported', { reason: vocabularyIndex.error }))
      }
      self.postMessage(reply(request, true, filterTokenizerVocabulary(vocabularyIndex.entries, request.query)))
      return
    }
    if (request.operation === 'prepare-vocabulary-diff') {
      if (request.tokenizerIdentity !== loadedTokenizerIdentity) throw new Error(t('tokenizerIdentityChanged'))
      if (request.leftFormat === 'sentencepiece' || sentencePiece !== null) {
        throw new Error(t('sentencepieceVocabularyUnavailable'))
      }
      const leftParsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.tokenizerData))
      if (!isRecord(leftParsed)) throw new Error(t('leftTokenizerRootNotObject'))
      const leftModel = isRecord(leftParsed.model) ? leftParsed.model : null
      if (leftModel === null) throw new Error(t('leftTokenizerMissingModel'))
      const leftIndex = buildTokenizerVocabularyIndex(leftModel.vocab)
      if (leftIndex.entries === null) throw new Error(t('leftVocabularyCompareUnsupported', { reason: leftIndex.error }))
      if (!vocabularyAvailable) throw new Error(tokenizerError)
      vocabularyIndex ??= buildTokenizerVocabularyIndex(vocabularySource)
      if (vocabularyIndex.entries === null) throw new Error(t('rightVocabularyCompareUnsupported', { reason: vocabularyIndex.error }))
      vocabularyDiff = buildTokenizerVocabularyDiff(leftIndex.entries, vocabularyIndex.entries)
      self.postMessage(reply(request, true, {
        leftOnlyCount: vocabularyDiff.leftOnly.length,
        rightOnlyCount: vocabularyDiff.rightOnly.length,
        sharedCount: vocabularyDiff.shared.length,
      }))
      return
    }
    if (request.operation === 'search-vocabulary-diff') {
      if (request.tokenizerIdentity !== loadedTokenizerIdentity || vocabularyDiff === null) {
        throw new Error(t('vocabularyDiffNotPrepared'))
      }
      self.postMessage(reply(request, true, filterTokenizerVocabularyDiff(vocabularyDiff, request.scope, request.query)))
      return
    }
    if (tokenizer === null && sentencePiece === null) throw new Error(tokenizerError)
    if (request.tokenizerIdentity !== loadedTokenizerIdentity) throw new Error(t('tokenizerIdentityChanged'))
    const activeTokenizer = sentencePiece ?? tokenizer!
    const activeSpecialIndex = specialIndex
    if (request.operation === 'chat-tokenize') {
      const rendered = new Template(request.template).render(request.context)
      const probe = chatContentProbe(request.attribution)
      const encoding = encodeText(activeTokenizer, rendered, t('chatRenderedInputLabel'))
      const probeEncoding = encodeText(activeTokenizer, probe, t('chatProbeInputLabel'))
      const decoded = decodeIds(activeTokenizer, encoding.ids)
      const baseResult = buildTokenization(
        rendered,
        encoding.ids,
        encoding.tokens,
        decoded,
        ids => decodeIds(activeTokenizer, ids),
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
      const pieces = request.ids.map(id => idToPiece(activeTokenizer, id))
      const decoded = decodeIds(activeTokenizer, request.ids)
      const result = buildTokenization(
        request.originalInput,
        request.ids,
        pieces,
        decoded,
        ids => decodeIds(activeTokenizer, ids),
        request.ids.map((id, index) => tokenFlag(id, pieces[index], activeSpecialIndex, pieces[index] ? undefined : () => decodeIds(activeTokenizer, [id]))),
        'decode',
      )
      self.postMessage(reply(request, true, result))
      return
    }
    const encoding = encodeText(activeTokenizer, request.text, t('inputLabel'))
    const decoded = decodeIds(activeTokenizer, encoding.ids)
    const result = buildTokenization(
      request.text,
      encoding.ids,
      encoding.tokens,
      decoded,
      ids => decodeIds(activeTokenizer, ids),
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

function encodeText(tokenizer: Tokenizer | SentencePieceWasm, text: string, label: string) {
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error(t('encodedInputTooLarge', { label }))
  if (tokenizer instanceof SentencePieceWasm) {
    return { ids: tokenizer.encodeAsIds(text), tokens: tokenizer.encodeAsPieces(text) }
  }
  return tokenizer.encode(text, { add_special_tokens: false })
}

function decodeIds(tokenizer: Tokenizer | SentencePieceWasm, ids: number[]): string {
  if (tokenizer instanceof SentencePieceWasm) return ids.length === 0 ? '' : tokenizer.decodeIds(ids)
  return tokenizer.decode(ids, { skip_special_tokens: false })
}

function idToPiece(tokenizer: Tokenizer | SentencePieceWasm, id: number): string | null {
  if (tokenizer instanceof SentencePieceWasm) return tokenizer.idToPiece(id)
  return tokenizer.id_to_token(id) ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
