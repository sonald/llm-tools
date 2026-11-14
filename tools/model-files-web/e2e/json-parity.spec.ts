import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openPerspective, setLaunchInput } from './fixtures.ts'

test('tokenizer JSON remains readable without a usable tokenizer runtime', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('json-parity')
  await mkdir(directory, { recursive: true })
  const source = '{\n  "model": {\n    "type": "Unsupported",\n    "vocab": {"hello": 0}\n  },\n  "exact": 9007199254740993\n}'
  await writeFile(join(directory, 'tokenizer.json'), source)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  await page.getByRole('button', { name: '原文', exact: true }).click()
  const reader = page.locator('.source-reader')
  await expect(reader).toHaveAttribute('data-highlighted', 'true')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    const colors = await reader.evaluate(element => ({
      plain: getComputedStyle(element).color,
      tokens: [...element.querySelectorAll('.token')].map(token => getComputedStyle(token).color),
    }))
    expect(new Set(colors.tokens).size).toBeGreaterThan(2)
    expect(colors.tokens.some(color => color !== colors.plain)).toBe(true)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await reader.textContent()).toBe(source)
  await page.getByRole('button', { name: '折叠第 2 行结构' }).click()
  await expect(page.getByRole('button', { name: '展开第 2 行结构' })).toBeVisible()
  await page.getByRole('button', { name: '全部展开' }).click()
  await expect(reader.locator('.source-line[hidden]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('tokenizer-json.png') })
  expect(errors).toEqual([])
})

test('all JSON file routes highlight and fold source, including large tokenizers', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('json-routes')
  await mkdir(directory, { recursive: true })
  const source = '{\r\n  "nested": {\r\n    "items": [true, null, "hello"]\r\n  }\r\n}'
  const paths = ['config.json', 'generation_config.json', 'tokenizer_config.json', 'vocab.json', 'model.safetensors.index.json', 'metadata.json']
  for (const path of paths) await writeFile(join(directory, path), source)
  const large = JSON.stringify({ model: { type: 'Unsupported', vocab: Object.fromEntries(Array.from({ length: 12000 }, (_, i) => [`token-${i}`, i])) }, end: 'END_OF_TOKENIZER' }, null, 2)
  await writeFile(join(directory, 'tokenizer.json'), large)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  for (const path of paths) {
    await page.getByRole('button', { name: new RegExp(`^${path.replaceAll('.', '\\.')}`) }).click()
    await page.getByRole('button', { name: '原文', exact: true }).click()
    const reader = page.locator('.source-reader')
    await expect(reader).toHaveAttribute('data-highlighted', 'true')
    expect(await reader.textContent()).toBe(source)
    await page.getByRole('button', { name: '折叠第 2 行结构' }).click()
    await expect(page.getByRole('button', { name: '展开第 2 行结构' })).toBeVisible()
  }
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await page.getByRole('button', { name: '原文', exact: true }).click()
  const reader = page.locator('.source-reader')
  await expect(reader).toHaveAttribute('data-highlighted', 'true')
  await page.getByRole('button', { name: '折叠第 2 行结构' }).click()
  await expect(page.getByRole('button', { name: '展开第 2 行结构' })).toBeVisible()
  // The fold spans ~30 lazy chunks: unrendered ones hide as blocks, the last one line by line.
  await expect(reader.getByText('"token-6000"')).toBeHidden()
  await expect(reader.getByText('"token-11999"')).toBeHidden()
  await expect(reader.getByText('END_OF_TOKENIZER')).toBeVisible()
  await reader.focus()
  await page.keyboard.press('ControlOrMeta+f')
  await page.getByRole('textbox', { name: '当前文件查找' }).fill('END_OF_TOKENIZER')
  await expect(reader.locator('mark.current')).toHaveText('END_OF_TOKENIZER')
  await expect(reader.locator('mark.current')).toBeVisible()
  expect(errors).toEqual([])
})

test('JSON roots and malformed input remain inspectable, template JSON renders verbatim', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('json-roots')
  await mkdir(directory, { recursive: true })
  const contents = { 'null.json': 'null', 'array.json': '[\n  {"a": true}\n]', 'invalid.json': '{"broken":', 'chat_template.jinja': '{\n  "items": [\n    true, null\n  ]\n}' }
  for (const [path, source] of Object.entries(contents)) await writeFile(join(directory, path), source)
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  for (const path of ['null.json', 'array.json', 'invalid.json'] as const) {
    await page.getByRole('button', { name: new RegExp(`^${path.replace('.', '\\.')}`) }).click()
    if (path !== 'invalid.json') await page.getByRole('button', { name: '原文', exact: true }).click()
    // Native JSONReaderView: the parser error above the original text.
    else {
      await expect(page.getByRole('alert')).toContainText('⚠︎ JSON: 未能读取数据，因为它的格式不正确。')
      // Native keeps every perspective for invalid JSON instead of forcing 原文.
      await expect(page.getByRole('button', { name: '全部字段', exact: true })).toHaveAttribute('aria-pressed', 'false')
      await expect(page.getByRole('button', { name: '原文', exact: true })).toBeVisible()
    }
    const reader = page.locator('.source-reader')
    await expect(reader).toHaveAttribute('data-highlighted', 'true')
    expect(await reader.textContent()).toBe(contents[path])
  }
  await page.getByRole('button', { name: /^chat_template\.jinja/ }).click()
  await openPerspective(page, '试验台')
  // Native RenderedOutputTextView shows the raw output verbatim; JSON is only parsed for indexed content payloads.
  await expect(page.getByLabel('原始输出 · 权威')).toHaveText(contents['chat_template.jinja'])
  await expect(page.getByText('未识别可索引的消息边界')).toBeVisible()
})

test('JSON fields show lexeme-preserving formatted source like native JSONReaderView', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('json-fields')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'metadata.json'), `{"nested":{"padding":"${'x'.repeat(600)}","needle":"LATE_FIELD","exact":9007199254740993},"one":1,"yes":true}`)
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  await page.getByRole('button', { name: '全部字段' }).click()
  const reader = page.locator('.source-reader')
  await expect(reader).toHaveAttribute('data-highlighted', 'true')
  await expect(reader).toContainText('"exact": 9007199254740993')
  expect(await reader.textContent()).toMatch(/^\{\n {2}"nested": \{\n {4}"padding": "x+",\n/)
  await reader.focus()
  await page.keyboard.press('ControlOrMeta+f')
  await page.getByRole('textbox', { name: '当前文件查找' }).fill('LATE_FIELD')
  await expect(reader.locator('mark.current')).toHaveText('LATE_FIELD')
  await page.getByRole('button', { name: '折叠第 2 行结构' }).click()
  await expect(page.getByRole('button', { name: '展开第 2 行结构' })).toBeVisible()
})

test('YAML null literals share the literal syntax color', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('yaml-null')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'reader.yaml'), 'count: 2\nempty: null\n')
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  await page.getByRole('button', { name: /^reader\.yaml/ }).click()
  const reader = page.locator('.source-reader')
  await expect(reader).toHaveAttribute('data-highlighted', 'true')
  const colors = await reader.evaluate(element => {
    const color = (text: string) => [...element.querySelectorAll('.token')]
      .filter(token => token.textContent === text).map(token => getComputedStyle(token).color)
    return { plain: getComputedStyle(element).color, literal: color('2'), null: color('null') }
  })
  expect(colors.literal).toHaveLength(1)
  expect(colors.null).toEqual(colors.literal)
  expect(colors.null[0]).not.toBe(colors.plain)
})

test('a minified multi-megabyte vocab stays highlighted, complete and searchable in 原文', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('minified-vocab')
  await mkdir(directory, { recursive: true })
  const source = JSON.stringify({ ...Object.fromEntries(Array.from({ length: 150_000 }, (_, i) => [`Ġtoken${i}`, i])), TAIL_NEEDLE: 150_000 })
  await writeFile(join(directory, 'vocab.json'), source)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  await expect(page.getByText('共 150,001 个 token；列表最多展示当前筛选结果的前 1,000 项。')).toBeVisible()
  const started = Date.now()
  await page.getByRole('button', { name: '原文', exact: true }).click()
  const reader = page.locator('.source-reader')
  // One 3 MB line is cut into 4K-character pieces; only the first renders tokens up front.
  await expect(reader.locator('.source-chunk')).toHaveCount(Math.ceil(source.length / 4096))
  await expect(reader.locator('.source-chunk').first().locator('.token').first()).toBeVisible()
  expect(Date.now() - started).toBeLessThan(3_000)
  expect(await reader.evaluate(element => element.textContent!.length)).toBe(source.length)
  await reader.focus()
  await page.keyboard.press('ControlOrMeta+f')
  await page.getByRole('textbox', { name: '当前文件查找' }).fill('TAIL_NEEDLE')
  await expect(reader.locator('mark.current')).toHaveText('TAIL_NEEDLE')
  await expect(reader.locator('mark.current')).toBeInViewport()
  await page.getByRole('button', { name: '全部字段', exact: true }).click()
  await expect(reader).toContainText('"TAIL_NEEDLE": 150000')
  expect(errors).toEqual([])
})
