// Native JSONFormatter.inline / pretty, applied to source lexemes so big numbers keep their digits.
// Pinned against JSONSerialization + NSNumber output on macOS (see jsonValue.test.ts).
export type JsonNode =
  | { kind: 'string'; value: string }
  | { kind: 'number'; lexeme: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'array'; items: JsonNode[] }
  | { kind: 'object'; entries: Array<[string, JsonNode]> }

const tokens = /"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g

// Expects valid JSON (the caller has already run JSON.parse); returns null otherwise.
export function parseJsonNode(source: string): JsonNode | null {
  const list = [...source.matchAll(tokens)].map(match => match[0])
  let index = 0
  const read = (): JsonNode => {
    const token = list[index++]
    if (token === undefined) throw new Error('end')
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' }
    if (token === 'null') return { kind: 'null' }
    if (token === '[') {
      const items: JsonNode[] = []
      if (list[index] === ']') { index += 1; return { kind: 'array', items } }
      for (;;) {
        items.push(read())
        const next = list[index++]
        if (next === ']') return { kind: 'array', items }
        if (next !== ',') throw new Error('array')
      }
    }
    if (token === '{') {
      const entries = new Map<string, JsonNode>()
      if (list[index] === '}') { index += 1; return { kind: 'object', entries: [] } }
      for (;;) {
        const key = list[index++]
        if (key === undefined || !key.startsWith('"') || list[index++] !== ':') throw new Error('object')
        entries.set(JSON.parse(key) as string, read())
        const next = list[index++]
        if (next === '}') return { kind: 'object', entries: [...entries] }
        if (next !== ',') throw new Error('object')
      }
    }
    if (/^-?\d/.test(token)) return { kind: 'number', lexeme: token }
    throw new Error('token')
  }
  try {
    const node = read()
    return index === list.length ? node : null
  } catch {
    return null
  }
}

// NSNumber.stringValue: integers keep every digit; doubles print as %.16g.
export function nativeNumberString(lexeme: string): string {
  return /^-?\d+$/.test(lexeme) ? integerString(lexeme) : formatG(Number(lexeme), 16)
}

export function nativeInline(node: JsonNode): string {
  switch (node.kind) {
    case 'string': return node.value
    case 'number': return nativeNumberString(node.lexeme)
    case 'boolean': return String(node.value)
    case 'null': return 'null'
    default: return nativePretty(node).replaceAll('\n', ' ')
  }
}

// JSONSerialization .prettyPrinted + .sortedKeys: two-space indent, `"key" : value`, doubles as %.17g.
// `escapeSlash: false` is .withoutEscapingSlashes.
export function nativePretty(node: JsonNode, depth = 0, escapeSlash = true): string {
  const indent = '  '.repeat(depth)
  const inner = '  '.repeat(depth + 1)
  switch (node.kind) {
    case 'string': return escapeString(node.value, escapeSlash)
    case 'number': return /^-?\d+$/.test(node.lexeme) ? integerString(node.lexeme) : formatG(Number(node.lexeme), 17)
    case 'boolean': return String(node.value)
    case 'null': return 'null'
    case 'array':
      if (node.items.length === 0) return `[\n\n${indent}]`
      return `[\n${node.items.map(item => inner + nativePretty(item, depth + 1, escapeSlash)).join(',\n')}\n${indent}]`
    case 'object': {
      if (node.entries.length === 0) return `{\n\n${indent}}`
      const sorted = node.entries.toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      return `{\n${sorted.map(([key, value]) => `${inner}${escapeString(key, escapeSlash)} : ${nativePretty(value, depth + 1, escapeSlash)}`).join(',\n')}\n${indent}}`
    }
  }
}

function integerString(lexeme: string): string {
  return lexeme === '-0' ? '0' : lexeme
}

// printf %.<precision>g: shortest of fixed or exponent form, trailing zeros removed, two-digit exponent.
export function formatG(value: number, precision: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'
  const [mantissa, exponentText] = value.toExponential(precision - 1).split('e')
  const exponent = Number(exponentText)
  const trim = (text: string) => text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
  if (exponent < -4 || exponent >= precision) {
    return `${trim(mantissa)}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`
  }
  return trim(value.toFixed(Math.max(0, precision - 1 - exponent)))
}

function escapeString(value: string, escapeSlash = true): string {
  let result = '"'
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (character === '"') result += '\\"'
    else if (character === '\\') result += '\\\\'
    else if (character === '/') result += escapeSlash ? '\\/' : '/'
    else if (character === '\n') result += '\\n'
    else if (character === '\r') result += '\\r'
    else if (character === '\t') result += '\\t'
    else if (character === '\b') result += '\\b'
    else if (character === '\f') result += '\\f'
    else if (code < 0x20) result += `\\u${code.toString(16).padStart(4, '0')}`
    else result += character
  }
  return result + '"'
}
