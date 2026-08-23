import type { VocabularyDiffScope } from './core/tokenizer.ts'

export type TokenizerOperation =
  | 'load'
  | 'inspect-structure'
  | 'tokenize'
  | 'chat-tokenize'
  | 'decode-token-ids'
  | 'render-template'
  | 'search-vocabulary'
  | 'prepare-vocabulary-diff'
  | 'search-vocabulary-diff'

type TokenizerEnvelope = {
  kind: 'request'
  sessionId: string
  generation: number
}

export type TokenizerRequest =
  & TokenizerEnvelope
  & (
    | { operation: 'load'; requestId: number; tokenizerIdentity: string; tokenizerData: ArrayBuffer; configData: ArrayBuffer | null }
    | { operation: 'inspect-structure'; requestId: number; tokenizerIdentity: ''; tokenizerData: ArrayBuffer }
    | { operation: 'tokenize'; requestId: number; tokenizerIdentity: string; text: string }
    | { operation: 'chat-tokenize'; requestId: number; tokenizerIdentity: string; template: string; context: Record<string, unknown>; attribution: ChatAttributionMessage[] }
  | { operation: 'decode-token-ids'; requestId: number; tokenizerIdentity: string; ids: number[]; originalInput: string }
  | { operation: 'render-template'; requestId: number; tokenizerIdentity: ''; source: string; context: Record<string, unknown> }
  | { operation: 'search-vocabulary'; requestId: number; tokenizerIdentity: string; query: string }
  | { operation: 'prepare-vocabulary-diff'; requestId: number; tokenizerIdentity: string; tokenizerData: ArrayBuffer }
  | { operation: 'search-vocabulary-diff'; requestId: number; tokenizerIdentity: string; scope: VocabularyDiffScope; query: string }
)

type ChatAttributionMessage = import('./core/tokenAttribution.ts').ChatAttributionMessage

export function isTokenizerRequest(value: unknown): value is TokenizerRequest {
  if (!isRecord(value) || value.kind !== 'request'
    || typeof value.sessionId !== 'string' || value.sessionId.length === 0
    || !isSafeNonNegativeInteger(value.requestId)
    || !isSafeNonNegativeInteger(value.generation)
    || typeof value.tokenizerIdentity !== 'string') {
    return false
  }
  switch (value.operation) {
    case 'load':
      return value.tokenizerData instanceof ArrayBuffer
        && (value.configData === null || value.configData instanceof ArrayBuffer)
    case 'inspect-structure':
      return value.tokenizerData instanceof ArrayBuffer
    case 'tokenize':
      return typeof value.text === 'string'
    case 'chat-tokenize':
      return typeof value.template === 'string' && isRecord(value.context) && Array.isArray(value.attribution)
        && value.attribution.every(isChatAttributionMessage)
    case 'decode-token-ids':
      return Array.isArray(value.ids) && value.ids.every(isSafeNonNegativeInteger)
        && typeof value.originalInput === 'string'
    case 'render-template':
      return typeof value.source === 'string' && isRecord(value.context)
    case 'search-vocabulary':
      return typeof value.query === 'string'
    case 'prepare-vocabulary-diff':
      return value.tokenizerData instanceof ArrayBuffer
    case 'search-vocabulary-diff':
      return (value.scope === 'leftOnly' || value.scope === 'rightOnly' || value.scope === 'shared')
        && typeof value.query === 'string'
    default:
      return false
  }
}

function isChatAttributionMessage(value: unknown): boolean {
  return isRecord(value)
    && typeof value.role === 'string'
    && typeof value.content === 'string'
    && (value.contentKind === 'text' || value.contentKind === 'json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export type TokenizerReply = {
  kind: 'reply'
  operation: TokenizerOperation
  requestId: number
  sessionId: string
  generation: number
  tokenizerIdentity: string
} & ({ ok: true; value: unknown } | { ok: false; error: string })
