export type FoldRange = { startLine: number; endLine: number }

export function foldRanges(source: string, language: string): FoldRange[] {
  switch (language.toLowerCase()) {
    case 'python':
    case 'py':
    case 'pyw':
      return indentFolds(source, isPythonHeader)
    case 'yaml':
    case 'yml':
      return indentFolds(source, isYAMLHeader)
    case 'json':
      return jsonFolds(source)
    default:
      return []
  }
}

type HeaderPredicate = (line: string) => boolean

function indentFolds(source: string, isHeader: HeaderPredicate): FoldRange[] {
  const lines = splitLines(source)
  if (lines.length === 0) return []

  const ranges: FoldRange[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const indent = leadingWhitespaceWidth(line)
    if (indent === null || !isHeader(line)) continue

    let end = index
    let sawDeeper = false
    let cursor = index + 1
    while (cursor < lines.length) {
      const next = lines[cursor]
      if (next === '' || isAllWhitespace(next)) {
        cursor += 1
        continue
      }
      const nextIndent = leadingWhitespaceWidth(next)
      if (nextIndent === null) break
      if (nextIndent > indent) {
        sawDeeper = true
        end = cursor
        cursor += 1
        continue
      }
      break
    }
    if (sawDeeper && end > index) {
      ranges.push({ startLine: index + 1, endLine: end + 1 })
    }
  }
  return ranges
}

function jsonFolds(source: string): FoldRange[] {
  const ranges: FoldRange[] = []
  const stack: Array<{ closer: string; startLine: number }> = []
  let line = 1
  let inString = false
  let escaped = false
  let mismatched = false

  for (const ch of source) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      if (ch === '\n') line += 1
      continue
    }

    switch (ch) {
      case '"':
        inString = true
        break
      case '{':
        stack.push({ closer: '}', startLine: line })
        break
      case '[':
        stack.push({ closer: ']', startLine: line })
        break
      case '}':
      case ']': {
        const last = stack[stack.length - 1]
        if (last !== undefined && last.closer === ch) {
          stack.pop()
          if (line > last.startLine) {
            ranges.push({ startLine: last.startLine, endLine: line })
          }
        } else {
          mismatched = true
        }
        break
      }
      case '\n':
        line += 1
        break
      default:
        break
    }
  }

  if (mismatched || inString || stack.length !== 0) return []

  ranges.sort((lhs, rhs) => {
    if (lhs.startLine !== rhs.startLine) return lhs.startLine - rhs.startLine
    return rhs.endLine - lhs.endLine
  })
  return ranges
}

function isPythonHeader(line: string): boolean {
  const code = trimWhitespace(pythonCodeWithoutComment(line))
  if (code === '') return false
  if (code.includes('"""') || code.includes("'''")) return false
  return code.endsWith(':')
}

function pythonCodeWithoutComment(line: string): string {
  let result = ''
  let quote: string | undefined
  let escaped = false

  for (const ch of line) {
    if (quote !== undefined) {
      result += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        quote = undefined
      }
      continue
    }
    if (ch === '#') break
    result += ch
    if (ch === '"' || ch === "'") quote = ch
  }
  return result
}

function isYAMLHeader(line: string): boolean {
  const trimmed = trimWhitespace(line)
  if (trimmed === '' || trimmed.startsWith('#')) return false
  if (trimmed === '-') return true
  if (trimmed.startsWith('- ')) {
    const item = trimWhitespace(trimmed.slice(2))
    return item === '' || yamlKeyColon(item) !== null
  }

  const colon = yamlKeyColon(trimmed)
  if (colon === null) return false
  const rest = trimWhitespace(trimmed.slice(colon + 1))
  if (rest === '' || rest.startsWith('#')) return true
  return yamlIsBlockScalarIndicator(rest)
}

function yamlIsBlockScalarIndicator(rest: string): boolean {
  const first = rest[0]
  if (first !== '|' && first !== '>') return false
  const marker = rest.slice(1)
  if (marker === '' || marker.startsWith('#')) return true
  if (marker[0] === '-' || marker[0] === '+') {
    const after = marker.slice(1)
    return after === '' || isWhitespace(firstCharacter(after)) || after.startsWith('#')
  }
  return false
}

function yamlKeyColon(text: string): number | null {
  let quote: string | undefined
  let escaped = false
  let index = 0

  for (const ch of text) {
    if (quote !== undefined) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        quote = undefined
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ':') {
      const nextIndex = index + ch.length
      if (nextIndex === text.length || isWhitespace(text[nextIndex])) return index
    }
    index += ch.length
  }
  return null
}

function splitLines(source: string): string[] {
  if (source === '') return []
  const lines = source.split('\n')
  if (source.endsWith('\n')) lines.pop()
  return lines
}

function leadingWhitespaceWidth(line: string): number | null {
  let width = 0
  for (const ch of line) {
    if (ch === ' ' || ch === '\t') {
      width += 1
    } else if (isWhitespace(ch) || ch === '\r') {
      continue
    } else {
      return width
    }
  }
  return null
}

function isAllWhitespace(line: string): boolean {
  for (const ch of line) {
    if (!isWhitespace(ch)) return false
  }
  return true
}

function trimWhitespace(value: string): string {
  return value.replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, '')
}

function firstCharacter(value: string): string {
  for (const ch of value) return ch
  return ''
}

function isWhitespace(ch: string): boolean {
  return ch !== '' && /\p{White_Space}/u.test(ch)
}
