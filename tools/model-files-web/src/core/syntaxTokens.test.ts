import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { highlightJsonWindow } from './jsonSource.ts'
import { syntaxClassName, syntaxGroup, syntaxStrong } from './syntaxTokens.ts'

describe('syntaxGroup (native Palette.syntax)', () => {
  it('maps the Prism types native names, and everything else to the label colour', () => {
    const cases: Array<[string, string]> = [
      ['comment', 'comment'], ['comment-block', 'comment'], ['doc-comment', 'comment'],
      ['string', 'string'], ['char', 'string'], ['attr-value', 'string'], ['template-variable', 'string'], ['regex', 'string'],
      ['inserted', 'string'],
      ['number', 'literal'], ['boolean', 'literal'], ['null', 'literal'], ['constant', 'literal'], ['builtin', 'literal'],
      ['symbol', 'literal'], ['literal', 'literal'],
      ['keyword', 'keyword'],
      ['atrule', 'structure'], ['tag', 'structure'], ['important', 'structure'], ['selector', 'structure'],
      ['directive', 'structure'], ['preprocessor', 'structure'], ['deleted', 'structure'],
      ['function', 'name'], ['function-name', 'name'], ['function-definition', 'name'], ['class-name', 'name'],
      ['maybe-class-name', 'name'], ['property', 'name'], ['attr-name', 'name'], ['attribute', 'name'], ['variable', 'name'],
      ['operator', 'operator'], ['punctuation', 'operator'], ['namespace', 'operator'], ['url', 'operator'], ['entity', 'operator'],
      ['plain', 'other'], ['parameter', 'other'], ['key', 'other'],
    ]
    for (const [type, group] of cases) assert.equal(syntaxGroup(type), group, type)
  })

  it('bolds keyword, boolean and literal only (native semibold)', () => {
    assert.deepEqual(['keyword', 'boolean', 'literal'].map(syntaxStrong), [true, true, true])
    assert.deepEqual(['number', 'null', 'constant', 'builtin', 'string'].map(syntaxStrong), [false, false, false, false, false])
    assert.equal(syntaxClassName('boolean'), 'source-syntax-literal source-syntax-strong')
    assert.equal(syntaxClassName('null'), 'source-syntax-literal')
  })

  it('gives JSON the Prism json types: booleans bold, null and numbers not', () => {
    const classes = highlightJsonWindow('{"a": true, "b": null, "c": 1}').map(segment => `${segment.text}=${segment.className}`)
    assert.ok(classes.includes('"a"=token source-syntax-name'))
    assert.ok(classes.includes('true=token source-syntax-literal source-syntax-strong'))
    assert.ok(classes.includes('null=token source-syntax-literal'))
    assert.ok(classes.includes('1=token source-syntax-literal'))
    assert.ok(classes.includes(':=token source-syntax-operator'))
  })
})
