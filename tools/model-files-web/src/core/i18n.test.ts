import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  currentLocale,
  formatNumber,
  initializeLocalization,
  messageCatalog,
  resolveLocale,
  translate,
} from '../i18n.ts'

describe('resolveLocale', () => {
  it('uses the first language and normalizes supported prefixes', () => {
    assert.equal(resolveLocale(['EN-us', 'zh-Hans']), 'en')
    assert.equal(resolveLocale(['en']), 'en')
    assert.equal(resolveLocale(['zh-TW', 'en-US']), 'zh-Hans')
    assert.equal(resolveLocale(['fr-FR', 'en-US']), 'zh-Hans')
    assert.equal(resolveLocale([]), 'zh-Hans')
    assert.equal(resolveLocale(undefined), 'zh-Hans')
  })

  it('defaults to zh-Hans without browser globals', () => {
    assert.equal(currentLocale(), 'zh-Hans')
  })
})

describe('messageCatalog', () => {
  it('has exact keys and placeholder parity', () => {
    for (const [key, messages] of Object.entries(messageCatalog)) {
      const zhHansPlaceholders = (
        messages['zh-Hans'].match(/\{[^}]+\}/g) ?? []
      ).sort()
      const enPlaceholders = (
        messages.en.match(/\{[^}]+\}/g) ?? []
      ).sort()

      assert.deepEqual(enPlaceholders, zhHansPlaceholders, key)
    }
  })

  it('translates values as text in both locales', () => {
    initializeLocalization(['en-US'])
    assert.equal(translate('greeting', { name: '<Sian>' }), 'Hello, <Sian>')
    assert.equal(translate('fileCount', { count: '1,024' }), '1,024 files')
    initializeLocalization(['zh-CN'])
    assert.equal(translate('greeting', { name: '<Sian>' }), '你好，<Sian>')
    assert.equal(translate('fileCount', { count: '1,024' }), '1,024 个文件')
  })

  it('rejects missing and extra values', () => {
    assert.throws(() => translate('greeting'), /missing/)
    assert.throws(() => translate('greeting', { name: 'A', count: 2 }), /extra/)
  })

  it('formats numbers for en and zh-Hans', () => {
    initializeLocalization(['en-US'])
    assert.equal(formatNumber(1234567.89), '1,234,567.89')
    initializeLocalization(['zh-CN'])
    assert.equal(formatNumber(1234567.89), '1,234,567.89')
  })

  it('initializes a fake root language', () => {
    const root = { lang: '' }
    initializeLocalization(['EN-us'], root)
    assert.equal(root.lang, 'en')
    assert.equal(currentLocale(), 'en')
  })
})
