import './prismWorkerBootstrap.ts'
// @ts-expect-error The upstream @types/prismjs package does not declare this component entry.
import Prism from 'prismjs/components/prism-core'
import 'prismjs/components/prism-markup'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-clike'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-swift'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-kotlin'
import 'prismjs/components/prism-ruby'
import 'prismjs/components/prism-markup-templating'
import 'prismjs/components/prism-php'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-lua'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-scss'
import 'prismjs/components/prism-sass'
import 'prismjs/components/prism-less'

type SourceSegment = { text: string; className: string }

type Reply = {
  ok: true
  segments: Array<SourceSegment>
} | { ok: false }

self.onmessage = (event: MessageEvent<{ content: string; language: string }>) => {
  try {
    const grammar = Prism.languages[event.data.language]
    if (!grammar) {
      self.postMessage({ ok: false } satisfies Reply)
      return
    }
    const segments: Array<SourceSegment> = []
    const append = (value: string, nextClassName: string) => {
      if (value === '') return

      const last = segments[segments.length - 1]
      if (last && last.className === nextClassName) {
        last.text += value
        return
      }
      segments.push({ text: value, className: nextClassName })
    }
    const flatten = (
      tokens: ReadonlyArray<string | Prism.Token>,
      inheritedTypes: ReadonlyArray<string> = [],
      inheritedCategory = 'other',
    ) => {
      tokens.forEach(token => {
        if (typeof token === 'string') {
          append(token, inheritedTypes.length === 0 ? '' : [
            'token',
            ...inheritedTypes,
            `source-${inheritedCategory}`,
          ].join(' '))
          return
        }
        const aliases = Array.isArray(token.alias)
          ? token.alias
          : token.alias === undefined ? [] : [token.alias]
        flatten(
          Array.isArray(token.content) ? token.content : [token.content],
          [...inheritedTypes, token.type, ...aliases],
          tokenClassName(token.type),
        )
      })
    }
    flatten(Prism.tokenize(event.data.content, grammar))
    self.postMessage({ ok: true, segments } satisfies Reply)
  } catch {
    self.postMessage({ ok: false } satisfies Reply)
  }
}

function tokenClassName(type: string): string {
  if (type.startsWith('comment')) return 'comment'
  if (['string', 'char', 'attr-value', 'template-variable', 'regex'].includes(type)) return 'string'
  if (['number', 'boolean', 'constant', 'builtin', 'symbol'].includes(type)) return 'literal'
  if (type === 'keyword') return 'keyword'
  if (['atrule', 'tag', 'important', 'selector'].includes(type)) return 'structure'
  if (['function', 'class-name', 'maybe-class-name', 'property', 'attr-name'].includes(type)) return 'name'
  if (['operator', 'punctuation', 'namespace', 'url', 'entity'].includes(type)) return 'operator'
  return 'other'
}
