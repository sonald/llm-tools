// Tokens retain their original spelling: parsing/stringifying rounds large JSON numbers.
const tokens = /"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]|\s+|./g

export function formatJsonSource(source: string): string {
  let depth = 0
  let previous = ''
  const output: string[] = []
  for (const match of source.matchAll(tokens)) {
    const token = match[0]
    if (/^\s+$/.test(token)) continue
    if (token === '}' || token === ']') depth = Math.max(0, depth - 1)
    if (previous === ',' || ((previous === '{' || previous === '[') && token !== '}' && token !== ']')
      || ((token === '}' || token === ']') && previous !== '{' && previous !== '[')) {
      output.push('\n', '  '.repeat(Math.min(depth, 100)))
    }
    output.push(token === ':' ? ': ' : token)
    if (token === '{' || token === '[') depth += 1
    previous = token
  }
  return output.join('')
}

export function jsonFieldSources(source: string): Map<string, string> {
  const fields = new Map<string, string>()
  if (!source.trimStart().startsWith('{')) return fields.set('$', source)
  let depth = 0
  let key = ''
  let valueStart = -1
  for (const match of source.matchAll(tokens)) {
    const token = match[0]
    if (depth === 1 && valueStart === -1 && token.startsWith('"')) key = JSON.parse(token) as string
    if (depth === 1 && token === ':' && valueStart === -1) valueStart = match.index + 1
    if (depth === 1 && (token === ',' || token === '}') && valueStart !== -1) {
      fields.set(key, source.slice(valueStart, match.index).trim())
      valueStart = -1
    }
    if (token === '{' || token === '[') depth += 1
    if (token === '}' || token === ']') depth -= 1
  }
  return fields
}

export function highlightJsonWindow(source: string, start = 0, end = source.length) {
  const segments: Array<{ text: string; className: string }> = []
  for (const match of source.matchAll(tokens)) {
    if (match.index >= end) break
    const token = match[0]
    if (match.index + token.length <= start) continue
    const text = token.slice(Math.max(0, start - match.index), end - match.index)
    const category = token.startsWith('"')
      ? /^\s*:/.test(source.slice(match.index + token.length)) ? 'name' : 'string'
      : /^[-\d]|^(true|false|null)$/.test(token) ? 'literal'
      : /^[{}[\],:]$/.test(token) ? 'operator' : ''
    segments.push({ text, className: category === '' ? '' : `token source-${category}` })
  }
  return segments
}

// Keep raw-source pages contiguous without splitting a Unicode code point or CRLF.
export function sourceBoundary(source: string, offset: number): number {
  return (source[offset] === '\n' && source[offset - 1] === '\r')
    || (/[\uDC00-\uDFFF]/.test(source[offset] ?? '') && /[\uD800-\uDBFF]/.test(source[offset - 1] ?? ''))
    ? offset + 1 : offset
}
