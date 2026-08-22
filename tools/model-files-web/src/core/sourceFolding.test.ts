import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { foldRanges } from './sourceFolding.ts'

const parsingCases = [
  {
    name: 'testPythonFoldsNestedBlocksByDeeperIndent',
    source:
      'class Model:\n    def forward(self, x):\n        if x:\n            return x\n        return None\n\nVALUE = 1',
    language: 'python',
    expected: [
      { startLine: 1, endLine: 5 },
      { startLine: 2, endLine: 5 },
      { startLine: 3, endLine: 4 },
    ],
  },
  {
    name: 'testPythonWUsesTheSameIndentScanner',
    source: 'def run():\n    return 1\n',
    language: 'pyw',
    expected: [{ startLine: 1, endLine: 2 }],
  },
  {
    name: 'testYAMLFoldsNestedMappingAndSequence',
    source: 'model:\n  name: demo\n  layers:\n    - conv\n    - linear\ncount: 2',
    language: 'yaml',
    expected: [
      { startLine: 1, endLine: 5 },
      { startLine: 3, endLine: 5 },
    ],
  },
  {
    name: 'testYMLUsesTheSameIndentScanner',
    source: 'root:\n  child: 1\n',
    language: 'yml',
    expected: [{ startLine: 1, endLine: 2 }],
  },
  {
    name: 'testJSONFoldsMultilineObjectsAndArrays',
    source:
      '{\n  "a": [\n    1,\n    2\n  ],\n  "b": { "ok": true }\n}',
    language: 'json',
    expected: [
      { startLine: 1, endLine: 7 },
      { startLine: 2, endLine: 5 },
    ],
  },
  {
    name: 'testJSONIgnoresBracketsInsideEscapedStrings',
    source:
      '{\n  "text": "not { a } [block]",\n  "escaped": "keep { me }",\n  "inner": {\n    "ok": true\n  }\n}',
    language: 'json',
    expected: [
      { startLine: 1, endLine: 7 },
      { startLine: 4, endLine: 6 },
    ],
  },
  {
    name: 'testJSONDoesNotFoldSameLineContainers',
    source: '{"a":[1,2],"b":{"ok":true}}',
    language: 'json',
    expected: [],
  },
  {
    name: 'testIncompleteJSONDoesNotCrashOrInventFolds',
    source: '{\n  "a": [1,\n  "text": "unterminated',
    language: 'json',
    expected: [],
  },
  {
    name: 'testBlankAndUnknownLanguageReturnNoFolds/blank',
    source: '',
    language: 'python',
    expected: [],
  },
  {
    name: 'testBlankAndUnknownLanguageReturnNoFolds/unknown-language',
    source: 'def run():\n    return 1\n',
    language: 'swift',
    expected: [],
  },
  {
    name: 'testPythonDoesNotFoldWhenNoDeeperLineFollows',
    source: 'def run(): pass\nVALUE = 1\n',
    language: 'python',
    expected: [],
  },
  {
    name: 'testJSONIgnoresEscapedQuotesAndBackslashes',
    source:
      '{\n  "quote": "he said \\"hi {there}\\"",\n  "slash": "\\\\[not-array\\\\]",\n  "ok": [\n    1\n  ]\n}',
    language: 'json',
    expected: [
      { startLine: 1, endLine: 7 },
      { startLine: 4, endLine: 6 },
    ],
  },
  {
    name: 'testPythonDoesNotFoldContinuationsOrComments',
    source:
      'values = [\n    1,\n    2\n]\n# note:\n    ignored = 1\nx = 1',
    language: 'python',
    expected: [],
  },
  {
    name: 'testYAMLFoldsBlockScalarsAndSequenceHeadersOnly',
    source:
      'prompt: |\n  hello\n  world\nitems:\n  - name: a\n    value: 1\n  -\n    lone: true\nnote: plain text\n  not a mapping\nfolded: >\n  one\n  two',
    language: 'yaml',
    expected: [
      { startLine: 1, endLine: 3 },
      { startLine: 4, endLine: 8 },
      { startLine: 5, endLine: 6 },
      { startLine: 7, endLine: 8 },
      { startLine: 11, endLine: 13 },
    ],
  },
  {
    name: 'testIncompleteJSONWithClosedInnerReturnsNoFolds',
    source: '{\n  "ok": {\n    "a": 1\n  }',
    language: 'json',
    expected: [],
  },
  {
    name: 'testYAMLDoesNotFoldPlainTextOrScalarItems',
    source:
      'title: demo\nitems:\n  - conv\n  - linear\nnote: this is not a header\n  because it is plain text',
    language: 'yaml',
    expected: [{ startLine: 2, endLine: 4 }],
  },
  {
    name: 'testPythonIgnoresInlineCommentColons',
    source: 'values = [  # note:\n    1\n]',
    language: 'python',
    expected: [],
  },
  {
    name: 'testPythonKeepsColonInsideQuotedHash',
    source: 'if name == "#note:":\n    return name',
    language: 'python',
    expected: [{ startLine: 1, endLine: 2 }],
  },
  {
    name: 'testYAMLFoldsQuotedAndSpacedKeysCommentsAndChomping',
    source:
      'model name:\n  size: 1\n"quoted:key":\n  ok: true\nurl: https://example.com\n  not-a-child: 1\nparent: # comment\n  child: 1\nkeep: |-\n  a\n  b\nplus: |+\n  c\nclip: >-\n  d\nkeepplus: >+\n  e',
    language: 'yaml',
    expected: [
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 },
      { startLine: 7, endLine: 8 },
      { startLine: 9, endLine: 11 },
      { startLine: 12, endLine: 13 },
      { startLine: 14, endLine: 15 },
      { startLine: 16, endLine: 17 },
    ],
  },
  {
    name: 'testPythonDoesNotFoldTripleQuotedLinesEndingWithColon',
    source:
      'text = \'\'\'note:\n    not a block\n\'\'\'\nother = """also:\n    still not a block\n"""\ndef run():\n    return 1',
    language: 'python',
    expected: [{ startLine: 7, endLine: 8 }],
  },
]

for (const fixture of parsingCases) {
  test(fixture.name, () =>
    assert.deepEqual(foldRanges(fixture.source, fixture.language), fixture.expected),
  )
}

test('testPythonFoldScanOn128KiBFixtureStaysUnder50ms', () => {
  let source = 'class Model:\n'

  while (new TextEncoder().encode(source).byteLength < 128 * 1024) {
    source += '    def method():\n        return 1\n'
  }

  const startedAt = performance.now()
  foldRanges(source, 'python')
  const elapsedMilliseconds = performance.now() - startedAt
  assert.ok(elapsedMilliseconds < 50, `foldRanges took ${elapsedMilliseconds} ms`)
})
