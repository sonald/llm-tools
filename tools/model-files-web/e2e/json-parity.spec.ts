import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('tokenizer JSON remains readable without a usable tokenizer runtime', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('json-parity')
  await mkdir(directory, { recursive: true })
  const source = '{\n  "model": {\n    "type": "Unsupported",\n    "vocab": {"hello": 0}\n  },\n  "exact": 9007199254740993\n}'
  await writeFile(join(directory, 'tokenizer.json'), source)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByLabel('选择本地目录').setInputFiles(directory)
  await page.getByRole('tab', { name: 'JSON', exact: true }).click()
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
  await page.goto('/')
  await page.getByLabel('选择本地目录').setInputFiles(directory)
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
  await page.getByRole('tab', { name: 'JSON', exact: true }).click()
  await page.getByRole('button', { name: '原文', exact: true }).click()
  const reader = page.locator('.source-reader')
  await expect(reader).toHaveAttribute('data-highlighted', 'true')
  await page.getByRole('button', { name: '折叠第 2 行结构' }).click()
  await expect(page.getByRole('button', { name: '展开第 2 行结构' })).toBeVisible()
  await reader.focus()
  await page.keyboard.press('ControlOrMeta+f')
  await page.getByRole('textbox', { name: '当前文件查找' }).fill('END_OF_TOKENIZER')
  await expect(reader.locator('mark.current')).toHaveText('END_OF_TOKENIZER')
  await expect(reader.locator('mark.current')).toBeVisible()
  expect(errors).toEqual([])
})

test('JSON roots and malformed input remain inspectable, template JSON shares reader', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('json-roots')
  await mkdir(directory, { recursive: true })
  const contents = { 'null.json': 'null', 'array.json': '[\n  {"a": true}\n]', 'invalid.json': '{"broken":', 'chat_template.jinja': '{\n  "items": [\n    true, null\n  ]\n}' }
  for (const [path, source] of Object.entries(contents)) await writeFile(join(directory, path), source)
  await page.goto('/')
  await page.getByLabel('选择本地目录').setInputFiles(directory)
  for (const path of ['null.json', 'array.json', 'invalid.json'] as const) {
    await page.getByRole('button', { name: new RegExp(`^${path.replace('.', '\\.')}`) }).click()
    if (path !== 'invalid.json') await page.getByRole('button', { name: '原文', exact: true }).click()
    else await expect(page.getByText('JSON 格式无效 · 显示原文')).toBeVisible()
    const reader = page.locator('.source-reader')
    await expect(reader).toHaveAttribute('data-highlighted', 'true')
    expect(await reader.textContent()).toBe(contents[path])
  }
  await page.getByRole('button', { name: /^chat_template\.jinja/ }).click()
  await page.getByRole('tab', { name: '试验台' }).click()
  await page.getByRole('button', { name: '渲染', exact: true }).click()
  await page.getByRole('button', { name: '原始输出' }).click()
  await expect(page.locator('.template-output .source-reader')).toHaveAttribute('data-highlighted', 'true')
  await page.getByRole('button', { name: '折叠第 2 行结构' }).click()
  await expect(page.getByRole('button', { name: '展开第 2 行结构' })).toBeVisible()
})

test('nested JSON fields preserve full values and searchable numeric spelling', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('json-fields')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'metadata.json'), `{"nested":{"padding":"${'x'.repeat(600)}","needle":"LATE_FIELD","exact":9007199254740993},"one":1,"yes":true}`)
  await page.goto('/')
  await page.getByLabel('选择本地目录').setInputFiles(directory)
  await page.getByRole('button', { name: '全部字段' }).click()
  await page.getByPlaceholder('字段或内容包含…').fill('LATE_FIELD')
  const row = page.getByRole('row').filter({ has: page.locator('details') })
  await expect(row).toContainText('nested')
  await row.locator('summary').click()
  const reader = row.locator('.source-reader')
  await expect(reader).toHaveAttribute('data-highlighted', 'true')
  await expect(reader).toContainText('9007199254740993')
  await expect(reader).toContainText('LATE_FIELD')
  await row.getByRole('button', { name: '折叠第 1 行结构' }).click()
  await expect(row.getByRole('button', { name: '展开第 1 行结构' })).toBeVisible()
})
