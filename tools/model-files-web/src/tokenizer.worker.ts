/// <reference lib="webworker" />

import { Tokenizer } from '@huggingface/tokenizers'
import { Template } from '@huggingface/jinja'
import { buildTokenization, inspectTokenizerStructure } from './core/tokenizer.ts'

type Request =
  | { id: number; type: 'load'; tokenizerData: ArrayBuffer; configData: ArrayBuffer | null }
  | { id: number; type: 'tokenize'; text: string }
  | { id: number; type: 'render-template'; source: string; context: Record<string, unknown> }

let tokenizer: Tokenizer | null = null
let tokenizerError = 'Tokenizer 尚未加载。'

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.type === 'render-template') {
      self.postMessage({ id: request.id, ok: true, value: new Template(request.source).render(request.context) })
      return
    }
    if (request.type === 'load') {
      const decoder = new TextDecoder()
      const tokenizerData = JSON.parse(decoder.decode(request.tokenizerData))
      const structure = inspectTokenizerStructure(tokenizerData)
      tokenizer = null
      if (request.configData === null) {
        tokenizerError = '缺少 tokenizer_config.json，当前运行时无法严格构造 Tokenizer。'
      } else {
        const tokenizerConfig = JSON.parse(decoder.decode(request.configData))
        structure.chatTemplate = typeof tokenizerConfig.chat_template === 'string' ? tokenizerConfig.chat_template : null
        try {
          tokenizer = new Tokenizer(tokenizerData, tokenizerConfig)
          tokenizerError = ''
        } catch (error) {
          tokenizerError = error instanceof Error ? error.message : String(error)
        }
      }
      self.postMessage({ id: request.id, ok: true, value: structure })
      return
    }
    if (tokenizer === null) throw new Error(tokenizerError)
    const encoding = tokenizer.encode(request.text, { add_special_tokens: false })
    const decoded = encoding.ids.length === 0 ? '' : tokenizer.decode(encoding.ids, { skip_special_tokens: false })
    const result = buildTokenization(
      request.text,
      encoding.ids,
      encoding.tokens,
      decoded,
      ids => tokenizer?.decode(ids, { skip_special_tokens: false }) ?? '',
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
