// Native JinjaSyntaxHighlighter: tags first, then strings and keywords inside non-comment tags, then every
// delimiter in the source. Later layers win, so a run's class is the last range that covers it.
export type JinjaHighlightKind = 'comment' | 'expression' | 'statement' | 'string' | 'keyword' | 'delimiter'
export type JinjaRun = { text: string; kind: JinjaHighlightKind | null; start: number }

const tagPattern = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g
const delimiterPattern = /\{\{|\}\}|\{%|%\}|\{#|#\}/g
const stringPattern = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g
const keywordPattern = /\b(if|else|elif|endif|for|in|endfor|set|true|false|none|and|or|not|is|macro|endmacro|call|endcall|filter|endfilter)\b/g

export function jinjaRuns(source: string): JinjaRun[] {
  const kinds: Array<JinjaHighlightKind | null> = new Array(source.length).fill(null)
  const paint = (start: number, end: number, kind: JinjaHighlightKind) => kinds.fill(kind, start, end)
  const tags = [...source.matchAll(tagPattern)]
  const inner: Array<[number, number]> = []
  for (const tag of tags) {
    const kind = tag[0].startsWith('{#') ? 'comment' : tag[0].startsWith('{{') ? 'expression' : 'statement'
    paint(tag.index, tag.index + tag[0].length, kind)
    if (kind !== 'comment') inner.push([tag.index, tag.index + tag[0].length])
  }
  // Native matches strings, then keywords, per tag (NSRegularExpression over the tag's range).
  for (const [start, end] of inner) {
    const text = source.slice(start, end)
    for (const match of text.matchAll(stringPattern)) paint(start + match.index, start + match.index + match[0].length, 'string')
    for (const match of text.matchAll(keywordPattern)) paint(start + match.index, start + match.index + match[0].length, 'keyword')
  }
  for (const match of source.matchAll(delimiterPattern)) paint(match.index, match.index + match[0].length, 'delimiter')

  const runs: JinjaRun[] = []
  for (let index = 0; index < source.length; index += 1) {
    const last = runs.at(-1)
    if (last !== undefined && last.kind === kinds[index]) last.text += source[index]
    else runs.push({ text: source[index], kind: kinds[index], start: index })
  }
  return runs
}
