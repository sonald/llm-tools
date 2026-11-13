import assert from 'node:assert/strict'
import test from 'node:test'
import { jinjaRuns } from './jinjaHighlight.ts'
import { prettyPrintedJSON, renderedOutputItems, type RenderedOutputItem } from './renderedOutput.ts'
import {
  initialVariables, message, swiftDouble, swiftInt, templateContext, variable, weatherTool, type TemplateRequest,
} from './templateRequest.ts'

const request = (overrides: Partial<TemplateRequest> = {}): TemplateRequest => ({
  messages: [message('user', 'hi')], includeTools: false, tools: [], variables: [], addGenerationPrompt: true, ...overrides,
})

// Error copy and context shape captured from native TemplateRenderer.render (2026-11-13 goldens).
test('template context matches native validation, reserved names and tools toggle', () => {
  assert.deepEqual(templateContext(request()), { messages: [{ role: 'user', content: 'hi' }], add_generation_prompt: true })
  assert.equal('tools' in templateContext(request({ tools: [weatherTool()] })), false)
  const tools = templateContext(request({ includeTools: true, tools: [weatherTool()] })).tools as Array<{ function: { name: string } }>
  assert.equal(tools[0].function.name, 'get_weather')
  assert.deepEqual(templateContext(request({ messages: [message('user', '[{"type":"text","text":"a"}]', 'json')] })).messages,
    [{ role: 'user', content: [{ type: 'text', text: 'a' }] }])
  const failure = (overrides: Partial<TemplateRequest>) => {
    try { templateContext(request(overrides)); return 'OK' } catch (error) { return (error as Error).message }
  }
  assert.equal(failure({ variables: [variable('messages', 'string')] }), '“messages”由专用编辑器管理。')
  assert.equal(failure({ variables: [variable('tools', 'string')] }), '“tools”由专用编辑器管理。')
  assert.equal(failure({ variables: [variable('  ', 'string')] }), '变量名不能为空。')
  assert.equal(failure({ variables: [variable('a', 'string'), variable(' a', 'string')] }), '变量“a”重复。')
  assert.equal(failure({ variables: [variable('a', 'integer', '1.5')] }), '变量“a”需要整数。')
  assert.equal(failure({ variables: [variable('a', 'decimal', 'abc')] }), '变量“a”需要数字。')
  assert.match(failure({ variables: [variable('a', 'json', '{bad')] }), /^变量 a JSON 无效：/)
  assert.match(failure({ messages: [message('user', '[1,', 'json')] }), /^user message content JSON 无效：/)
  assert.equal(failure({ includeTools: true, tools: [{ ...weatherTool(), name: ' ' }] }), 'Tool 名称不能为空。')
  assert.equal(failure({ includeTools: true, tools: [{ ...weatherTool(), name: 't', parametersJSON: '[]' }] }), 'Tool t 的 parameters 必须是 JSON 对象。')
  assert.match(failure({ includeTools: true, tools: [{ ...weatherTool(), name: 't', parametersJSON: '{' }] }), /^Tool t parameters JSON 无效：/)
  assert.deepEqual(templateContext(request({ variables: [
    variable('i', 'integer', '42'), variable('b', 'boolean', 'yes'), variable('f', 'boolean', 'false'), variable('n', 'null', 'x'),
  ] })), { messages: [{ role: 'user', content: 'hi' }], add_generation_prompt: true, i: 42, b: true, f: false, n: null })
})

test('number parsing follows Swift Int() and Double()', () => {
  const ints = { '5': 5, '+5': 5, '-5': -5, ' 5': null, '5 ': null, '05': 5, '': null, '1e3': null,
    '9223372036854775808': null, '٣': null }
  for (const [text, expected] of Object.entries(ints)) assert.equal(swiftInt(text), expected, text)
  assert.equal(swiftInt('9223372036854775807'), 9223372036854775807)
  const doubles = { '5': 5, '+5': 5, '.5': 0.5, '5.': 5, '1e3': 1000, '1E-2': 0.01, 'inf': Infinity, '-Infinity': -Infinity,
    ' 5': null, '': null, '0x10': 16, '1_0': null, '١': null }
  for (const [text, expected] of Object.entries(doubles)) assert.equal(swiftDouble(text), expected, text)
  assert.ok(Number.isNaN(swiftDouble('NaN')))
})

test('prefills special tokens and template switches like native', () => {
  const variables = initialVariables('{{ enable_thinking }} {{ documents }}', {
    bos_token: '<s>', eos_token: { content: '</s>' }, pad_token: null, unk_token: 3,
  })
  assert.deepEqual(variables.map(({ name, kind, value }) => [name, kind, value]), [
    ['bos_token', 'string', '<s>'], ['pad_token', 'null', ''], ['enable_thinking', 'boolean', 'true'], ['documents', 'json', '[]'],
  ])
  assert.deepEqual(initialVariables('plain', {}), [])
})

const shape = (source: string) => renderedOutputItems(source).map(item => [
  item.id, item.level, item.title, item.detail, `${item.range.start},${item.range.end - item.range.start}`,
  item.payloadRange === null ? null : `${item.payloadRange.start},${item.payloadRange.end - item.payloadRange.start}`,
  prettyPrintedJSON(item, source),
])

// Rows are native RenderedOutputInspector output (id, level, title, detail, NSRange, payload NSRange, pretty JSON).
test('output structure index matches native RenderedOutputInspector', () => {
  assert.deepEqual(shape('plain text only'), [])
  assert.deepEqual(shape('<|im_start|>user\nHi<|im_end|>\n<|im_start|>assistant\n'), [
    [0, 0, 'im_start', '特殊 token', '0,12', null, null],
    [1, 0, 'im_end', '特殊 token', '19,10', null, null],
    [2, 0, 'im_start', '特殊 token', '30,12', null, null],
  ])
  assert.deepEqual(shape('<|message_user|><|content_text|>Hi<|end_message|><|message_model|>'), [
    [0, 0, 'USER', null, '0,49', null, null],
    [1, 1, 'content_text', null, '16,18', '32,2', null],
    [2, 0, 'MODEL', null, '49,17', null, null],
    [3, 1, 'generation prompt', null, '49,17', null, null],
  ])
  assert.deepEqual(shape('<|message_system|>sys detail<|content_json|>{"a":[1,{}],"b":"/é"}<|message_user|><|content_text|>x'), [
    [0, 0, 'SYSTEM', 'sys detail', '0,65', null, null],
    [1, 1, 'content_json', null, '28,37', '44,21', '{\n  "a" : [\n    1,\n    {\n\n    }\n  ],\n  "b" : "/é"\n}'],
    [2, 0, 'USER', null, '65,33', null, null],
    [3, 1, 'content_text', null, '81,17', '97,1', null],
  ])
  assert.deepEqual(shape(`<|message_tool|>${'长'.repeat(45)}<|content_text|>ok<|end_message|>`).slice(0, 1), [
    [0, 0, 'TOOL', `${'长'.repeat(39)}…`, '0,94', null, null],
  ])
  assert.deepEqual(shape('<|message_user|>  \n  <|content_json|>[]<|content_json|>{"k":[]}<|end_message|>'), [
    [0, 0, 'USER', null, '0,78', null, null],
    [1, 1, 'content_json', null, '21,18', '37,2', '[\n\n]'],
    [2, 1, 'content_json', null, '39,24', '55,8', '{\n  "k" : [\n\n  ]\n}'],
  ])
  assert.deepEqual(shape('<|message_user|><|content_b|>{}<|content_c|>["a/b","中",1.5,true,null]<|end_message|>').slice(1), [
    [1, 1, 'content_b', null, '16,15', '29,2', '{\n\n}'],
    [2, 1, 'content_c', null, '31,38', '44,25', '[\n  "a/b",\n  "中",\n  1.5,\n  true,\n  null\n]'],
  ])
  // Native crashes on a scalar payload; the web shows no inspector.
  const scalar = renderedOutputItems('<|message_user|><|content_a|>123<|end_message|>')[1] as RenderedOutputItem
  assert.equal(prettyPrintedJSON(scalar, '<|message_user|><|content_a|>123<|end_message|>'), null)
})

test('Jinja highlight layers tags, strings, keywords and delimiters like native', () => {
  const runs = jinjaRuns(`a{% if x == 'y' %}{{ name }}{# c #}`).map(run => [run.text, run.kind])
  assert.deepEqual(runs, [
    ['a', null], ['{%', 'delimiter'], [' ', 'statement'], ['if', 'keyword'], [' x == ', 'statement'], ["'y'", 'string'],
    [' ', 'statement'], ['%}{{', 'delimiter'], [' name ', 'expression'], ['}}{#', 'delimiter'], [' c ', 'comment'], ['#}', 'delimiter'],
  ])
  assert.equal(jinjaRuns('').length, 0)
})
