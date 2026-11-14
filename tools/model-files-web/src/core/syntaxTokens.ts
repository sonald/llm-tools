// Native Palette.syntax(_:) and CodeReaderView.highlightedString: a Prism token's own type (the innermost
// token's `type`, aliases ignored, as native flattenPrismTokens does) picks the colour group and the weight.
export type SyntaxGroup = 'comment' | 'string' | 'literal' | 'keyword' | 'structure' | 'name' | 'operator' | 'other'

export function syntaxGroup(type: string): SyntaxGroup {
  if (type.startsWith('comment') || type.endsWith('-comment')) return 'comment'
  switch (type) {
    case 'string': case 'char': case 'attr-value': case 'template-variable': case 'regex': case 'inserted':
      return 'string'
    case 'number': case 'boolean': case 'null': case 'constant': case 'builtin': case 'symbol': case 'literal':
      return 'literal'
    case 'keyword':
      return 'keyword'
    case 'atrule': case 'tag': case 'important': case 'selector': case 'directive': case 'preprocessor': case 'deleted':
      return 'structure'
    case 'function': case 'function-name': case 'function-definition': case 'class-name': case 'maybe-class-name':
    case 'property': case 'attr-name': case 'attribute': case 'variable':
      return 'name'
    case 'operator': case 'punctuation': case 'namespace': case 'url': case 'entity':
      return 'operator'
    default:
      return 'other'
  }
}

// Native sets the semibold face for these three types only (not for every literal-coloured type).
export function syntaxStrong(type: string): boolean {
  return type === 'keyword' || type === 'boolean' || type === 'literal'
}

export function syntaxClassName(type: string): string {
  return `source-syntax-${syntaxGroup(type)}${syntaxStrong(type) ? ' source-syntax-strong' : ''}`
}
