import assert from 'node:assert/strict'
import test from 'node:test'
import { formatG, nativeInline, nativeNumberString, nativePretty, parseJsonNode, type JsonNode } from './jsonValue.ts'
import { formatJsonSource } from './jsonSource.ts'

// Expected strings are JSONSerialization / NSNumber output captured with swiftc on macOS.
test('inline values match native JSONFormatter.inline', () => {
  const source = '{"a":1,"b":1.0,"c":1e30,"d":123456789012345678901234567890,"e":0.1,"f":-2.5e-7,"g":true,"h":null,'
    + '"i":[1,2,{"x":"y"}],"j":{},"k":[],"l":"str","m":1000000000000000000000,"n":151645,"o":[151645,151643],'
    + '"p":{"z":1,"a":[true,null]},"q":10000.0,"r":1.5e+300,"s":0.0001}'
  const root = parseJsonNode(source) as Extract<JsonNode, { kind: 'object' }>
  const inline = Object.fromEntries(root.entries.map(([key, node]) => [key, nativeInline(node)]))
  assert.deepEqual(inline, {
    a: '1', b: '1', c: '1e+30', d: '123456789012345678901234567890', e: '0.1', f: '-2.5e-07', g: 'true', h: 'null',
    i: '[   1,   2,   {     "x" : "y"   } ]', j: '{  }', k: '[  ]', l: 'str', m: '1000000000000000000000', n: '151645',
    o: '[   151645,   151643 ]', p: '{   "a" : [     true,     null   ],   "z" : 1 }', q: '10000', r: '1.5e+300', s: '0.0001',
  })
})

test('number spelling follows NSNumber %.16g and JSONSerialization %.17g', () => {
  const cases: Array<[string, string, string]> = [
    ['1e15', '1000000000000000', '1000000000000000'], ['1e16', '1e+16', '10000000000000000'], ['1e17', '1e+17', '1e+17'],
    ['123456.789', '123456.789', '123456.789'], ['1e-5', '1e-05', '1.0000000000000001e-05'], ['0.00012', '0.00012', '0.00012'],
    ['2e15', '2000000000000000', '2000000000000000'], ['3.0e2', '300', '300'], ['0.30000000000000004', '0.3', '0.30000000000000004'],
    ['-0.0', '-0', '-0'], ['1E5', '100000', '100000'], ['5e-324', '4.940656458412465e-324', '4.9406564584124654e-324'],
    ['12345678901234567890', '12345678901234567890', '12345678901234567890'], ['-12', '-12', '-12'],
  ]
  for (const [lexeme, inline, pretty] of cases) {
    assert.equal(nativeNumberString(lexeme), inline, lexeme)
    assert.equal(nativePretty({ kind: 'number', lexeme }), pretty, lexeme)
  }
  assert.equal(formatG(1.25, 16), '1.25')
})

test('pretty printing sorts keys, expands empty containers and escapes like JSONSerialization', () => {
  assert.equal(nativePretty(parseJsonNode('{"p":{"z":1,"a":[true,null]}}')!), '{\n  "p" : {\n    "a" : [\n      true,\n      null\n    ],\n    "z" : 1\n  }\n}')
  assert.equal(nativePretty(parseJsonNode('{}')!), '{\n\n}')
  assert.equal(nativePretty(parseJsonNode('{"e":{},"a":[],"n":[{"x":[]}]}')!),
    '{\n  "a" : [\n\n  ],\n  "e" : {\n\n  },\n  "n" : [\n    {\n      "x" : [\n\n      ]\n    }\n  ]\n}')
  assert.equal(nativePretty(parseJsonNode('{"s":"a/b \\"q\\" é \\u0001"}')!), '{\n  "s" : "a\\/b \\"q\\" é \\u0001"\n}')
  assert.equal(parseJsonNode('{"a":'), null)
})

test('formatted source matches native formattedSource, including empty containers', () => {
  assert.equal(formatJsonSource('{"a":{},"b":[],"c":[1,{"d":"x,y"}],"e":"q\\"z"}'),
    '{\n  "a": {\n    \n  },\n  "b": [\n    \n  ],\n  "c": [\n    1,\n    {\n      "d": "x,y"\n    }\n  ],\n  "e": "q\\"z"\n}')
})
