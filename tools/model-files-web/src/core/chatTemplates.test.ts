import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeChatTemplate,
  mergeChatTemplates,
  parseChatTemplates,
  selectChatTemplate,
} from './chatTemplates.ts'

test('parses a config string as the default tokenizer template', () => {
  const catalog = parseChatTemplates('{{ messages }}')

  assert.deepEqual(catalog.entries, [{
    id: 'tokenizerConfig:default',
    name: 'default',
    source: 'tokenizerConfig',
    body: '{{ messages }}',
    usable: true,
  }])
  assert.equal(catalog.activeId, 'tokenizerConfig:default')
  assert.equal(activeChatTemplate(catalog)?.body, '{{ messages }}')
  assert.equal(catalog.conflict, false)
})

test('sorts named object templates deterministically', () => {
  const catalog = parseChatTemplates({ tool_use: 'tool', default: 'default', first: 'first' })

  assert.deepEqual(catalog.entries.map(entry => entry.name), ['default', 'first', 'tool_use'])
  assert.equal(catalog.activeId, 'tokenizerConfig:default')
  assert.equal(activeChatTemplate(catalog)?.body, 'default')
})

test('keeps named array order and falls back from an empty default', () => {
  const catalog = parseChatTemplates([
    { name: 'default', template: ' ' },
    { name: 'tool_use', template: 'tool' },
    { name: 'later', template: 'later' },
  ])

  assert.deepEqual(catalog.entries.map(entry => entry.name), ['default', 'tool_use', 'later'])
  assert.equal(catalog.activeId, 'tokenizerConfig:tool_use')
  assert.equal(activeChatTemplate(catalog)?.body, 'tool')
})

test('missing config templates produce an empty catalog', () => {
  assert.deepEqual(parseChatTemplates(undefined), { entries: [], activeId: null, conflict: false })
})

test('all-empty templates leave no active entry', () => {
  const catalog = parseChatTemplates([
    { name: 'default', template: '' },
    { name: 'tool_use', template: ' \n\t' },
  ])

  assert.equal(catalog.activeId, null)
  assert.equal(activeChatTemplate(catalog), null)
})

test('rejects unsupported and malformed template shapes', () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /不支持的形态.*null/s],
    [42, /不支持的形态.*数字/s],
    [true, /不支持的形态.*布尔/s],
    [{ default: 1 }, /对象值必须是字符串/],
    [[{ name: 'missing-template' }], /第 0 个 named 条目无效/],
    [[{ name: '', template: 'x' }], /name 必须是非空字符串/],
    [[{ name: 'bad', template: 1 }], /template 必须是字符串/],
    [[['bad']], /必须是包含 name 和 template 的对象/],
  ]
  for (const [value, pattern] of cases) assert.throws(() => parseChatTemplates(value), pattern)
})

test('a usable independent Jinja file wins and reports conflict with config templates', () => {
  const config = parseChatTemplates({ default: 'CONFIG', tool_use: 'TOOL' })
  const catalog = mergeChatTemplates(config, 'JINJA')

  assert.deepEqual(catalog.entries.map(entry => entry.id), [
    'jinjaFile:default',
    'tokenizerConfig:default',
    'tokenizerConfig:tool_use',
  ])
  assert.equal(catalog.activeId, 'jinjaFile:default')
  assert.equal(activeChatTemplate(catalog)?.body, 'JINJA')
  assert.equal(catalog.conflict, true)
})

test('an empty independent Jinja file is retained but falls back to config', () => {
  const config = parseChatTemplates({ default: 'CONFIG' })
  const catalog = mergeChatTemplates(config, '')

  assert.deepEqual(catalog.entries.map(entry => [entry.id, entry.usable]), [
    ['jinjaFile:default', false],
    ['tokenizerConfig:default', true],
  ])
  assert.equal(catalog.activeId, 'tokenizerConfig:default')
  assert.equal(catalog.conflict, false)
})

test('selection skips an empty entry forward and then backward', () => {
  const catalog = selectChatTemplate(parseChatTemplates([
    { name: 'before', template: 'before' },
    { name: 'chosen', template: ' ' },
    { name: 'later', template: 'later' },
  ]), 'tokenizerConfig:chosen')

  assert.equal(catalog.activeId, 'tokenizerConfig:later')
  assert.equal(selectChatTemplate(parseChatTemplates([
    { name: 'before', template: 'before' },
    { name: 'chosen', template: ' ' },
  ]), 'tokenizerConfig:chosen').activeId, 'tokenizerConfig:before')
})

test('selection falls back to usable default then first usable', () => {
  const entries = [
    { name: 'other', template: 'other' },
    { name: 'default', template: 'default' },
  ]

  assert.equal(selectChatTemplate(parseChatTemplates(entries), 'missing').activeId, 'tokenizerConfig:default')
  assert.equal(selectChatTemplate(parseChatTemplates([entries[0]]), 'missing').activeId, 'tokenizerConfig:other')
})
