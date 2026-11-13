// Tokens retain their original spelling: parsing/stringifying rounds large JSON numbers.
const tokens = /"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]|\s+|./g

// Native JSONFormatter.formattedSource: re-indent by characters, keeping every lexeme as written.
// Empty containers open onto an indented blank line, as native does.
export function formatJsonSource(source: string): string {
  const parts: string[] = []
  const indents: string[] = []
  const newline = (depth: number) => indents[depth] ??= '\n' + '  '.repeat(depth)
  let depth = 0
  let verbatim = 0 // start of the pending run copied as is (scalars and whole strings)
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code === 34) { // a string: jump to its closing quote, skipping escaped ones
      let end = index
      do {
        end = source.indexOf('"', end + 1)
        if (end === -1) end = source.length
        let slashes = 0
        while (source.charCodeAt(end - 1 - slashes) === 92) slashes += 1
        if (slashes % 2 === 0) break
      } while (end < source.length)
      index = end
      continue
    }
    if (code !== 123 && code !== 91 && code !== 125 && code !== 93 && code !== 44 && code !== 58
      && code !== 32 && code !== 9 && code !== 10 && code !== 13) continue
    if (index > verbatim) parts.push(source.slice(verbatim, index))
    verbatim = index + 1
    if (code === 123 || code === 91) parts.push(source[index], newline(++depth))
    else if (code === 125 || code === 93) parts.push(newline(depth = Math.max(0, depth - 1)), source[index])
    else if (code === 44) parts.push(',', newline(depth))
    else if (code === 58) parts.push(': ')
  }
  if (verbatim < source.length) parts.push(source.slice(verbatim))
  return parts.join('')
}

// Top-level object keys → source range of the key token. Later duplicates win, as in JSON.parse.
export function jsonTopLevelKeyRanges(source: string): Map<string, { start: number; end: number }> {
  const ranges = new Map<string, { start: number; end: number }>()
  let depth = 0
  let expectKey = false
  for (const match of source.matchAll(tokens)) {
    const token = match[0]
    if (token === '{' || token === '[') {
      depth += 1
      expectKey = depth === 1 && token === '{'
    } else if (token === '}' || token === ']') {
      depth -= 1
    } else if (depth === 1 && token === ',') {
      expectKey = true
    } else if (depth === 1 && expectKey && token.startsWith('"')) {
      expectKey = false
      try {
        ranges.set(JSON.parse(token) as string, { start: match.index, end: match.index + token.length })
      } catch {
        // Malformed key spelling: leave it unanchored.
      }
    }
  }
  return ranges
}

export function highlightJsonWindow(source: string, start = 0, end = source.length) {
  const segments: Array<{ text: string; className: string }> = []
  // Valid JSON never breaks a token across lines, so a window that starts a line can scan from there.
  const scanner = new RegExp(tokens.source, 'g')
  const colon = /\s*:/y // tested in place: slicing the rest of a multi-megabyte source per string is O(n²) in WebKit
  scanner.lastIndex = start === 0 || source[start - 1] === '\n' || source[start - 1] === '\r' ? start : 0
  for (let match = scanner.exec(source); match !== null; match = scanner.exec(source)) {
    if (match.index >= end) break
    const token = match[0]
    if (match.index + token.length <= start) continue
    const text = token.slice(Math.max(0, start - match.index), end - match.index)
    colon.lastIndex = match.index + token.length
    const category = token.startsWith('"')
      ? colon.test(source) ? 'name' : 'string'
      : /^[-\d]|^(true|false|null)$/.test(token) ? 'literal'
      : /^[{}[\],:]$/.test(token) ? 'operator' : ''
    segments.push({ text, className: category === '' ? '' : `token source-syntax-${category}` })
  }
  return segments
}
