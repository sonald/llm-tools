import { expect, test, type Page } from '@playwright/test'
import {
  fixtureModelId,
  fixtureRevision,
  installFixtureRoutes,
  pythonReaderSource,
  writeFixtureDirectory,
} from './fixtures.ts'

test('inspects SafeTensors through two exact ranges without tensor data', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()

  await expect(page.getByText('2 次 HTTP 206 Range')).toBeVisible()
  await expect(page.getByText('Tensor 数据').locator('..').getByText('0 bytes', { exact: true })).toBeVisible()
  await expect(page.getByText('参数总数').locator('..').getByText('2')).toBeVisible()
  await page.getByRole('button', { name: 'Metadata', exact: true }).click()
  await expect(page.getByRole('table', { name: 'SafeTensors Metadata' }).getByText('format')).toBeVisible()
  await page.getByPlaceholder('Key 或 Value 包含…').fill('pt')
  await expect(page.getByText('显示 1 / 1')).toBeVisible()
  await page.getByRole('button', { name: 'Tensors', exact: true }).click()
  await expect(page.getByText('显示 100 / 106（总计 106）')).toBeVisible()
  await page.getByPlaceholder('名称或 dtype 包含…').fill('layer.104')
  await expect(page.getByRole('row', { name: /layer\.104/ })).toBeVisible()
  await page.getByRole('button', { name: 'layer.104' }).click()
  await expect(page.getByRole('heading', { name: '选中 Tensor · layer.104' })).toBeVisible()
  await expect(page.getByText('Data Offsets').locator('..')).toContainText('0–0')
  await page.getByPlaceholder('名称或 dtype 包含…').fill('')
  await page.getByRole('button', { name: '再显示 100 个 Tensor' }).click()
  await expect(page.getByText('显示 106 / 106（总计 106）')).toBeVisible()
  await page.getByRole('button', { name: '概览' }).click()
  await page.getByRole('button', { name: /^config\.json/ }).click()
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByText('参数总数').locator('..').getByText('2')).toBeVisible()
  expect(requests.filter(request => request.path === 'model.safetensors')).toEqual([
    expect.objectContaining({ range: 'bytes=0-7', responseBytes: 8, status: 206 }),
    expect.objectContaining({ range: expect.stringMatching(/^bytes=8-/), status: 206 }),
  ])
  expect(errors).toEqual([])
})

test('inspects only the 24-byte GGUF basic prefix', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /model\.gguf/ }).click()

  await expect(page.getByText('实际读取').locator('..').getByText('24 bytes')).toBeVisible()
  await expect(page.getByText('模型数据').locator('..').getByText('0 bytes')).toBeVisible()
  await expect(page.getByText(/完整 metadata\/tensor directory.*未启用/)).toBeVisible()
  expect(requests.filter(request => request.path === 'model.gguf')).toEqual([
    expect.objectContaining({ range: 'bytes=0-23', responseBytes: 24, status: 206 }),
  ])
  expect(errors).toEqual([])
})

test('Tokenizer Worker tokenizes and decodes back to the input', async ({ page }) => {
  const errors = collectErrors(page)
  await page.addInitScript("Object.defineProperty(navigator, 'clipboard', { value: { writeText: value => { window.__copiedToken = value; return Promise.resolve() } } })")
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await expect(page.getByText('Model Type').locator('..')).toContainText('WordPiece')
  await expect(page.getByText('基础词表').locator('..')).toContainText('6')
  await expect(page.getByRole('table', { name: 'Tokenizer 长度分布' })).toBeVisible()
  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  await page.getByRole('textbox', { name: 'Raw 输入' }).fill('hello worlds')
  await page.getByRole('button', { name: '立即分词' }).click()

  await expect(page.getByText('Decoded：hello worlds')).toBeVisible()
  await expect(page.getByText('Token 数').locator('..').getByText('3')).toBeVisible()
  await expect(page.getByText('映射').locator('..').getByText('Exact')).toBeVisible()
  await expect(page.getByText('Bytes / Token').locator('..')).toContainText('4')
  await expect(page.getByText('正文 Token')).toHaveCount(0)
  await expect(page.getByText('模板开销（近似）')).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Tokenizer Tokens' }).getByRole('columnheader', { name: 'Decoded' })).toBeVisible()
  await page.getByRole('button', { name: 'Token ID 3，index 0', exact: true }).click()
  await page.getByRole('button', { name: '复制 ID' }).click()
  expect(await page.evaluate('window.__copiedToken')).toBe('3')
  await page.getByRole('checkbox', { name: '显示空白符' }).uncheck()
  await expect(page.getByRole('button', { name: 'hello worlds' })).toBeVisible()
  expect(requests.filter(request => request.path.startsWith('tokenizer'))
    .map(request => request.path).toSorted()).toEqual(['tokenizer.json', 'tokenizer_config.json'])

  await page.getByRole('textbox', { name: 'Raw 输入' }).fill('')
  await expect(page.getByText('Decoded：hello worlds')).not.toBeVisible()
  await expect(page.getByText('Token 数').locator('..').getByText('0')).toBeVisible()
  await expect(page.getByRole('button', { name: '立即分词' })).toBeDisabled()

  await page.getByRole('tab', { name: 'Chat 工作台' }).click()
  await page.getByRole('button', { name: '渲染并分词' }).click()
  const expectedAuthoritative = 'system=You are concise.;user=Hello;thinking=false;mode=chat;assistant='
  await expect(page.getByLabel('Chat 权威输入')).toHaveText(expectedAuthoritative)
  await expect(page.getByText('当前映射是 Decoded only，不能按原文划分角色')).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Special' })).toBeVisible()
  await expect(page.getByText('Token 数').locator('..').getByText('21')).toBeVisible()
  await expect(page.getByText('正文 Token').locator('..').getByText('5')).toBeVisible()
  await expect(page.getByText('模板开销（近似）').locator('..').getByText('16')).toBeVisible()
  const authoritative = await page.getByLabel('Chat 权威输入').textContent()
  await expect(page.locator('.decoded-text').filter({ hasText: '权威输入：' })).toHaveText(`权威输入：${authoritative}`)
  const defaultChatRows = page.getByRole('table', { name: 'Tokenizer Tokens' }).locator('tbody tr')
  for (let i = 0; i < await defaultChatRows.count(); i++) {
    await expect(defaultChatRows.nth(i).locator('td').nth(3)).toHaveText('—')
  }
  expect(requests.filter(request => request.path.startsWith('tokenizer'))).toHaveLength(2)

  await page.getByText('Tools 与 Variables').click()
  await page.getByRole('textbox', { name: 'Chat Tools' })
    .fill('[{"type":"function","function":{"name":"search","parameters":{"type":"object"}}}]')
  await page.getByRole('textbox', { name: 'Chat Typed Variables' })
    .fill('{"enable_thinking":true,"mode":"chat-plus"}')
  await page.getByRole('checkbox', { name: 'include_tools' }).check()
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).toContainText('tools=[{"type": "function"')
  await expect(page.getByLabel('Chat 权威输入')).toContainText('"name": "search"')
  await expect(page.getByLabel('Chat 权威输入')).toContainText('thinking=true;mode=chat-plus;assistant=')

  await page.getByRole('checkbox', { name: 'include_tools' }).uncheck()
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).toHaveText(
    'system=You are concise.;user=Hello;thinking=true;mode=chat-plus;assistant=',
  )
  expect(requests.filter(request => request.path.startsWith('tokenizer'))).toHaveLength(2)

  await page.getByRole('textbox', { name: 'Chat Messages' }).fill('[{"role":"user","content":"{{ 7 * 7 }}"}]')
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).toContainText('{{ 7 * 7 }}')
  await expect(page.getByLabel('Chat 权威输入')).not.toContainText('49')
  expect(errors).toEqual([])
})

test('attributes Exact Chat tokens to custom message roles', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page, { omitIndependentChatTemplate: true })
  await openFixture(page, 12)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await page.getByRole('tab', { name: 'Chat 工作台' }).click()
  await page.getByRole('textbox', { name: 'Chat Messages' })
    .fill('[{"role":"critic","content":"hello worlds"}]')
  await page.getByRole('button', { name: '渲染并分词' }).click()

  await expect(page.getByLabel('Chat 权威输入')).toHaveText('hello worlds')
  await expect(page.getByText('Token 数').locator('..').getByText('3')).toBeVisible()
  await expect(page.getByText('映射').locator('..')).toContainText('Exact')
  const rows = page.getByRole('table', { name: 'Tokenizer Tokens' }).locator('tbody tr')
  await expect(rows).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await expect(rows.nth(i).locator('td').nth(3)).toHaveText('critic')
  }
  const badges = page.locator('.token-role-badge')
  await expect(badges).toHaveCount(1)
  await expect(badges).toHaveText(['critic'])
  await expect(badges).toHaveClass(/role-custom/)
  await page.locator('.token-pieces button').first().click()
  await expect(page.locator('.selected-token')).toContainText('critic')
  expect(errors).toEqual([])
})

test('searches vocabulary latest-only without rereading tokenizer resources', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  const search = page.getByRole('textbox', { name: '词表搜索' })

  await expect(search).toHaveAttribute('placeholder', '搜索 token 或十进制 ID')
  await expect(page.getByText('输入 token 或十进制 ID 开始搜索')).toBeVisible()
  await expect(page.getByRole('table', { name: 'Special Added Tokens' }).locator('tbody tr')).toHaveCount(3)

  await search.fill('HEL')
  await expect(page.getByText('匹配 1 条')).toBeVisible()
  const caseRows = page.getByRole('table', { name: '词表搜索结果' }).locator('tbody tr')
  await expect(caseRows).toHaveCount(1)
  await expect(caseRows.nth(0)).toContainText('hello')

  await search.fill('4')
  await expect(page.getByText('匹配 1 条')).toBeVisible()
  const idRows = page.getByRole('table', { name: '词表搜索结果' }).locator('tbody tr')
  await expect(idRows).toHaveCount(1)
  await expect(idRows.nth(0)).toContainText('world')

  await search.fill('hello')
  await search.fill('world')
  await expect(page.getByText('匹配 1 条')).toBeVisible()
  const latestRows = page.getByRole('table', { name: '词表搜索结果' }).locator('tbody tr')
  await expect(latestRows).toHaveCount(1)
  await expect(latestRows.nth(0)).toContainText('world')

  await search.fill('')
  await expect(page.getByText('输入 token 或十进制 ID 开始搜索')).toBeVisible()
  await expect(page.getByRole('table', { name: '词表搜索结果' })).toHaveCount(0)

  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  await page.getByRole('tab', { name: '结构与词表' }).click()
  await expect(page.getByRole('textbox', { name: '词表搜索' })).toHaveValue('')
  await expect(page.getByText('输入 token 或十进制 ID 开始搜索')).toBeVisible()
  expect(requests.filter(request => request.path === 'tokenizer.json')).toHaveLength(1)
  expect(requests.filter(request => request.path === 'tokenizer_config.json')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('selects between independent and tokenizer config chat templates', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await page.getByRole('tab', { name: 'Chat 工作台' }).click()
  const selector = page.getByRole('combobox', { name: 'Chat Template' })

  await expect(selector).toHaveValue('jinjaFile:default')
  await expect(selector.locator('option')).toHaveText([
    'chat_template.jinja',
    'tokenizer_config.json · default',
  ])
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).toContainText('system=You are concise.')
  await selector.selectOption('tokenizerConfig:default')
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).toHaveText('You are concise.')
  await selector.selectOption('jinjaFile:default')
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).toContainText('system=You are concise.')

  expect(requests.filter(request => request.path === 'chat_template.jinja')).toHaveLength(1)
  expect(requests.filter(request => request.path === 'tokenizer_config.json')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('sorts named object templates and switches without rereading the config', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, {
    omitIndependentChatTemplate: true,
    configChatTemplate: { tool_use: 'TOOL', first: ' ', default: 'CONFIG_DEFAULT' },
  })
  await openFixture(page, 12)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await page.getByRole('tab', { name: 'Chat 工作台' }).click()
  const selector = page.getByRole('combobox', { name: 'Chat Template' })

  await expect(selector).toHaveValue('tokenizerConfig:default')
  const options = selector.locator('option')
  await expect(options).toHaveText([
    'tokenizer_config.json · default',
    'tokenizer_config.json · first',
    'tokenizer_config.json · tool_use',
  ])
  await expect(options.nth(1)).toBeDisabled()
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).toHaveText('CONFIG_DEFAULT')
  await selector.selectOption('tokenizerConfig:tool_use')
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).toHaveText('TOOL')

  expect(requests.filter(request => request.path === 'tokenizer_config.json')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('disables chat rendering when every config template is blank', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, {
    omitIndependentChatTemplate: true,
    configChatTemplate: { tool_use: ' ', default: '\n\t' },
  })
  await openFixture(page, 12)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await page.getByRole('tab', { name: 'Chat 工作台' }).click()
  const selector = page.getByRole('combobox', { name: 'Chat Template' })

  await expect(selector.locator('option')).toHaveCount(2)
  await expect(selector.locator('option').nth(0)).toBeDisabled()
  await expect(selector.locator('option').nth(1)).toBeDisabled()
  await expect(page.getByText('模板不可用')).toBeVisible()
  await expect(page.getByRole('button', { name: '渲染并分词' })).toBeDisabled()

  expect(requests.filter(request => request.path === 'tokenizer_config.json')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('keeps 10k-token Raw results progressive and latest-only', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Performance gate is recorded once in Chromium.')
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  const input = page.getByRole('textbox', { name: 'Raw 输入' })
  await input.fill('hello')
  await input.fill('worlds')
  await expect(page.getByText('Decoded：worlds')).toBeVisible()

  const started = Date.now()
  await input.fill('hello '.repeat(10_000))
  await expect(page.getByText('Token 数').locator('..').getByText('10,000')).toBeVisible({ timeout: 10_000 })
  expect(Date.now() - started).toBeLessThan(10_000)
  await expect(page.getByRole('table', { name: 'Tokenizer Tokens' }).locator('tbody tr')).toHaveCount(1000)
  await page.getByRole('button', { name: '再显示 1,000 个 Token' }).click()
  await expect(page.getByRole('table', { name: 'Tokenizer Tokens' }).locator('tbody tr')).toHaveCount(2000)
})

test('caps large vocabulary search results at one thousand without config', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Performance gate is recorded once in Chromium.')
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, { largeVocabularyWithoutConfig: true })
  await openFixture(page, 12)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  const search = page.getByRole('textbox', { name: '词表搜索' })

  await expect(page.getByText('Tokenizer Config').locator('..')).toContainText('缺失 · Raw 不支持')
  const started = Date.now()
  await search.fill('needle')
  await expect(page.getByText('匹配 1,000 条')).toBeVisible({ timeout: 10_000 })
  expect(Date.now() - started).toBeLessThan(10_000)
  const rows = page.getByRole('table', { name: '词表搜索结果' }).locator('tbody tr')
  await expect(rows).toHaveCount(1000)

  await search.fill('needle-1004')
  await expect(page.getByText('匹配 1 条')).toBeVisible()
  const uniqueRows = page.getByRole('table', { name: '词表搜索结果' }).locator('tbody tr')
  await expect(uniqueRows).toHaveCount(1)
  await expect(uniqueRows.nth(0)).toContainText('needle-1004')
  await expect(uniqueRows.nth(0)).toContainText('1,010')

  expect(requests.filter(request => request.path === 'tokenizer.json')).toHaveLength(1)
  expect(requests.filter(request => request.path === 'tokenizer_config.json')).toHaveLength(0)
  expect(errors).toEqual([])
})

test('decodes shared Token IDs with special flags and linked selection', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await page.getByRole('tab', { name: 'Token IDs 工作台' }).click()
  const ids = page.getByRole('textbox', { name: 'Token IDs' })

  await expect(ids).toHaveAttribute('placeholder', /逗号、空白、换行或 JSON/)
  await ids.fill('1,3,2')
  await page.getByRole('button', { name: '解码 ID' }).click()
  await expect(page.getByText('映射').locator('..')).toContainText('Decoded only')
  await expect(page.locator('p').filter({ hasText: '解码文本：' })).toContainText('hello')
  await expect(page.getByText('由 Token ID 解码')).toBeVisible()
  const table = page.getByRole('table', { name: 'Tokenizer Tokens' })
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0).locator('td').nth(2)).toHaveText('[CLS]')
  await expect(rows.nth(1).locator('td').nth(2)).toHaveText('—')
  await expect(rows.nth(2).locator('td').nth(2)).toHaveText('[SEP]')

  const segment = page.locator('.token-pieces button').first()
  const rowButton = rows.nth(0).locator('td').nth(1).getByRole('button')
  const idChip = page.getByRole('button', { name: 'Token ID 1，index 0', exact: true })
  const detail = page.locator('.selected-token')
  await segment.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'true')
  await expect(rowButton).toHaveAttribute('aria-pressed', 'true')
  await expect(idChip).toHaveAttribute('aria-pressed', 'true')
  await expect(detail).toBeVisible()
  await segment.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'false')
  await expect(rowButton).toHaveAttribute('aria-pressed', 'false')
  await expect(idChip).toHaveAttribute('aria-pressed', 'false')
  await expect(detail).toHaveCount(0)
  await idChip.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'true')
  await expect(rowButton).toHaveAttribute('aria-pressed', 'true')
  await expect(idChip).toHaveAttribute('aria-pressed', 'true')
  await idChip.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'false')
  await expect(rowButton).toHaveAttribute('aria-pressed', 'false')
  await expect(idChip).toHaveAttribute('aria-pressed', 'false')
  await rowButton.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'true')
  await expect(rowButton).toHaveAttribute('aria-pressed', 'true')
  await expect(idChip).toHaveAttribute('aria-pressed', 'true')
  await rowButton.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'false')
  await expect(rowButton).toHaveAttribute('aria-pressed', 'false')
  await expect(idChip).toHaveAttribute('aria-pressed', 'false')
  await expect(detail).toHaveCount(0)

  await idChip.click()
  await expect(detail).toBeVisible()

  await ids.fill('[3]')
  await page.getByRole('button', { name: '解码 ID' }).click()
  await ids.fill('[4,5]')
  await page.getByRole('button', { name: '解码 ID' }).click()
  await expect(page.getByText('Token IDs：[4,5]')).toBeVisible()
  await expect(rows).toHaveCount(2)
  await expect(detail).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Token ID 4，index 0', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Token ID 5，index 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Token ID 3，index 0', exact: true })).toHaveCount(0)

  await ids.fill('3,nope')
  await page.getByRole('button', { name: '解码 ID' }).click()
  await expect(page.getByRole('alert')).toContainText(/第 2 个.*index 1.*nope/s)
  await expect(rows).toHaveCount(0)
  await expect(detail).toHaveCount(0)
  await expect(page.getByText('Token IDs：[4,5]')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  const rawInput = page.getByRole('textbox', { name: 'Raw 输入' })
  await rawInput.fill('[CLS] hello')
  await page.getByRole('button', { name: '立即分词' }).click()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).locator('td').nth(2)).toHaveText('[CLS]')
  await expect(rows.nth(1).locator('td').nth(2)).toHaveText('—')
  await rawInput.fill('hello worlds')
  await page.getByRole('button', { name: '立即分词' }).click()
  await expect(page.getByText('Decoded：hello worlds')).toBeVisible()
  await expect(page.getByText('映射').locator('..')).toContainText('Exact')
  await expect(rows).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await expect(rows.nth(i).locator('td').nth(2)).toHaveText('—')
  }
  await page.getByRole('checkbox', { name: '显示空白符' }).uncheck()
  await expect(page.getByRole('button', { name: 'hello worlds' })).toBeVisible()
  await expect(errors).toEqual([])
})

test('renders CR and LF as visible single-line tokens', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  await page.getByRole('textbox', { name: 'Raw 输入' }).fill('hello\r\nworlds')
  await page.getByRole('button', { name: '立即分词' }).click()
  await page.getByRole('checkbox', { name: '显示空白符' }).uncheck()
  const table = page.getByRole('table', { name: 'Tokenizer Tokens' })
  const pieces = await table.locator('tbody tr td:nth-child(4)').allTextContents()
  expect(pieces.length).toBeGreaterThan(0)
  for (const piece of pieces) {
    expect(piece).not.toMatch(/[\r\n]/)
  }
  expect(errors).toEqual([])
})

test('opens every supported local directory reader without network upload', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const externalRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname !== '127.0.0.1') externalRequests.push(request.url())
  })
  const localFixture = testInfo.outputPath('complete-local-fixture')
  await writeFixtureDirectory(localFixture)
  await page.goto('/')
  const picker = page.getByLabel('选择本地目录')
  await picker.setInputFiles(localFixture)

  await expect(page.getByText('本地目录 · live · 23 个文件')).toBeVisible()
  await expect(page).toHaveURL('http://127.0.0.1:5173/')
  await expect(page.getByRole('link', { name: '源站' })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Model Config' })).toBeVisible()

  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.getByRole('heading', { name: 'Fixture Model' })).toBeVisible()
  await page.getByRole('button', { name: /^vocab\.json/ }).click()
  await page.getByRole('button', { name: '全部字段' }).click()
  await expect(page.getByText('显示 1,000 / 10,005')).toBeVisible()
  await page.getByRole('button', { name: /^merges\.txt/ }).click()
  await expect(page.getByText('显示 1,000 / 100,002')).toBeVisible()
  await page.getByRole('button', { name: /^model\.safetensors\.index\.json/ }).click()
  await expect(page.getByText('分片数量').locator('..')).toContainText('2')
  await page.getByRole('button', { name: /^imatrix-fixture\.dat/ }).click()
  await expect(page.getByText('Entry 数量').locator('..')).toContainText('2')
  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await page.getByRole('tab', { name: '试验台' }).click()
  await page.getByRole('button', { name: '渲染', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Template 输出结构' })).toContainText('You are concise.')

  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await expect(page.getByText('Model Type').locator('..')).toContainText('WordPiece')
  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  await page.getByRole('textbox', { name: 'Raw 输入' }).fill('hello worlds')
  await page.getByRole('button', { name: '立即分词' }).click()
  await expect(page.getByText('Decoded：hello worlds')).toBeVisible()

  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByText('读取方式').locator('..')).toContainText('2 次 File.slice()')
  await expect(page.getByText('Tensor 数据').locator('..').getByText('0 bytes', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^model\.gguf/ }).click()
  await expect(page.getByText('读取方式').locator('..')).toContainText('1 次 File.slice()')
  await expect(page.getByText('模型数据').locator('..').getByText('0 bytes', { exact: true })).toBeVisible()

  await picker.setInputFiles(localFixture)
  await expect(page.getByRole('heading', { name: 'Model Config' })).toBeVisible()
  expect(externalRequests).toEqual([])
  expect(errors).toEqual([])
})

test('dispatches local Python and PDF readers safely', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const localFixture = testInfo.outputPath("reader-local-fixture")
  await writeFixtureDirectory(localFixture)
  await page.goto('/')
  await page.evaluate(() => {
    const states: Record<string, { revoked?: boolean }> = {}
    const createObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = object => {
      const url = createObjectURL(object)
      states[url] = {}
      return url
    }
    const revokeObjectURL = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = url => {
      states[url] ??= {}
      states[url].revoked = true
      return revokeObjectURL(url)
    }
    ;(window as unknown as { __objectUrls: Record<string, { revoked?: boolean }> }).__objectUrls = states
  })
  await page.getByLabel('选择本地目录').setInputFiles(localFixture)

  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain('frame-src blob:')

  await page.getByRole('button', { name: /^reader\.py/ }).click()
  const sourceReader = page.locator('.source-reader')
  await expect(sourceReader).toHaveAttribute('data-language', 'python')
  expect(await sourceReader.textContent()).toBe(pythonReaderSource)
  await expect(sourceReader).toHaveAttribute('data-highlighted', 'true')
  await expect(sourceReader.locator('.token.keyword').filter({ hasText: /^def$/ })).toHaveText('def')
  await expect(sourceReader.locator('.token.function')).toHaveText('greet')

  const scssStarted = Date.now()
  await page.getByRole('button', { name: /^reader\.scss/ }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.getByRole('heading', { name: 'Fixture Model' })).toBeVisible()
  expect(Date.now() - scssStarted).toBeLessThan(1000)
  await expect(page.locator('.source-reader[data-language="scss"]')).toHaveCount(0)

  await page.getByRole('button', { name: /^valid\.pdf/ }).click()
  const pdfFrame = page.locator('iframe[title="PDF 文档"]')
  const blobUrl = await pdfFrame.getAttribute('src')
  if (blobUrl === null) throw new Error('PDF blob URL is missing')
  expect(blobUrl).toMatch(/^blob:http:\/\/127\.0\.0\.1:5173\//)
  const openPdf = page.getByRole('link', { name: '在新标签页打开 PDF' })
  await expect(openPdf).toBeVisible()
  await expect(openPdf).toHaveAttribute('href', blobUrl)

  await page.getByRole('button', { name: /^README\.md/ }).click()
  expect(await page.evaluate(
    (url: string) => (window as unknown as { __objectUrls: Record<string, { revoked?: boolean }> }).__objectUrls[url]?.revoked,
    blobUrl,
  )).toBe(true)

  await page.getByRole('button', { name: /^invalid\.pdf/ }).click()
  const invalidError = page.getByRole('heading', { name: '无法读取文件' })
  await expect(invalidError).toBeVisible()
  await expect(invalidError.locator('..')).toContainText(/PDF/)

  await page.getByRole('button', { name: /^unknown\.dat/ }).click()
  const binaryError = page.getByRole('heading', { name: '无法读取文件' })
  await expect(binaryError).toBeVisible()
  await expect(binaryError.locator('..')).toContainText(/NUL|二进制/)
  await expect(page.locator('.source-reader')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('folds Python YAML and JSON while preserving the full source', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const localFixture = testInfo.outputPath('folding-local-fixture')
  await writeFixtureDirectory(localFixture)
  await page.goto('/')
  await page.getByLabel('选择本地目录').setInputFiles(localFixture)

  await page.getByRole('button', { name: /^reader\.py/ }).click()
  await expect(page.getByRole('button', { name: '折叠第 1 行结构' })).toBeVisible()
  await expect(page.getByRole('button', { name: '折叠第 2 行结构' })).toBeVisible()
  await expect(page.getByRole('button', { name: '折叠第 3 行结构' })).toBeVisible()
  await expect(page.getByRole('button', { name: '全部展开' })).toBeVisible()
  await page.getByRole('button', { name: '折叠第 1 行结构' }).click()
  await expect(page.getByRole('button', { name: '展开第 1 行结构' })).toHaveAttribute(
    'data-hidden-lines',
    '4',
  )
  await expect(page.locator('.source-reader .source-line[hidden]')).toHaveCount(4)
  await expect(page.getByRole('button', { name: '折叠第 2 行结构' })).toBeHidden()
  const sourceReader = page.locator('.source-reader')
  expect(await sourceReader.textContent()).toBe(pythonReaderSource)

  await page.getByRole('button', { name: '全部展开' }).click()
  await expect(page.locator('.source-reader .source-line[hidden]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '折叠第 2 行结构' })).toBeVisible()

  await page.getByRole('button', { name: /^reader\.yaml/ }).click()
  await expect(page.getByRole('button', { name: '折叠第 1 行结构' })).toBeVisible()
  await expect(page.getByRole('button', { name: '折叠第 3 行结构' })).toBeVisible()
  await page.getByRole('button', { name: '折叠第 3 行结构' }).click()
  await expect(page.getByRole('button', { name: '展开第 3 行结构' })).toHaveAttribute(
    'data-hidden-lines',
    '2',
  )

  await page.getByRole('button', { name: /^folding\.json/ }).click()
  await page.getByRole('button', { name: '原文' }).click()
  await expect(page.locator('.source-reader')).toHaveAttribute('data-language', 'json')
  await expect(page.getByRole('button', { name: '折叠第 1 行结构' })).toBeVisible()
  await expect(page.getByRole('button', { name: '折叠第 2 行结构' })).toBeVisible()

  await page.getByRole('button', { name: /^boundary\.py/ }).click()
  await expect(page.getByRole('button', { name: '折叠第 1 行结构' })).toBeVisible()
  await page.getByRole('button', { name: /^boundary-large\.py/ }).click()
  await expect(page.getByRole('button', { name: /第 \d+ 行结构/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '全部展开' })).toHaveCount(0)
  await expect(page.getByRole('table', { name: '行列表' })).toBeVisible()
  expect(errors).toEqual([])
})

test('source find navigates matches and reveals collapsed ancestors', async ({ page }, testInfo) => {
  const localFixture = testInfo.outputPath('source-find-local-fixture')
  await writeFixtureDirectory(localFixture)
  await page.goto('/')
  await page.getByLabel('选择本地目录').setInputFiles(localFixture)
  const filter = page.getByPlaceholder('筛选文件')
  await filter.fill('reader')
  await page.getByRole('button', { name: /^reader\.py/ }).click()

  await page.getByRole('button', { name: '折叠第 2 行结构' }).click()
  await page.getByRole('button', { name: '折叠第 1 行结构' }).click()
  await page.getByRole('button', { name: '折叠第 10 行结构' }).click()
  const source = page.locator('.source-reader')
  await source.focus()
  await page.keyboard.press('Meta+F')

  const search = page.getByRole('search', { name: '当前文件查找' })
  const searchInput = search.getByRole('textbox', { name: '当前文件查找' })
  await expect(search).toBeVisible()
  await expect(searchInput).toBeVisible()
  await expect(filter).toHaveValue('reader')

  await searchInput.fill('needle')
  const current = page.locator('.source-reader mark.current')
  await expect(search.getByText('1 / 3', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark.find-match')).toHaveCount(3)
  await expect(current).toHaveCount(1)
  await expect(current).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('button', { name: '折叠第 1 行结构' })).toBeVisible()
  await expect(page.getByRole('button', { name: '折叠第 2 行结构' })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开第 10 行结构' })).toHaveAttribute(
    'data-hidden-lines',
    '1',
  )
  await expect(page.locator('.source-reader .source-line[hidden]')).toHaveCount(1)
  expect(await current.evaluate(element => {
    const container = element.closest('.source-reader')
    if (!(container instanceof HTMLElement)) return false
    const mark = element.getBoundingClientRect()
    const viewport = container.getBoundingClientRect()
    return mark.bottom >= viewport.top && mark.top <= viewport.bottom
      && mark.right >= viewport.left && mark.left <= viewport.right
  })).toBe(true)

  await searchInput.press('Enter')
  await expect(current).toHaveText('needle')
  await searchInput.press('Enter')
  await expect(current).toHaveText('needle')
  await searchInput.press('Enter')
  await expect(current).toHaveText('NEEDLE')
  await searchInput.press('Shift+Enter')
  await expect(current).toHaveText('needle')

  await search.getByRole('button', { name: '下一个命中' }).click()
  await expect(current).toHaveText('NEEDLE')
  await search.getByRole('button', { name: '上一个命中' }).click()
  await expect(current).toHaveText('needle')
  await expect(search.getByText('3 / 3', { exact: true })).toBeVisible()

  await searchInput.fill('中文')
  await expect(search.getByText('1 / 2', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark.find-match')).toHaveCount(2)
  await searchInput.fill('🚩')
  await expect(search.getByText('1 / 1', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark.find-match')).toHaveCount(1)
  await searchInput.fill('missing-query')
  await expect(search.getByText('0 / 0', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark')).toHaveCount(0)

  await page.getByRole('button', { name: /^reader-copy\.py/ }).click()
  await expect(search).toBeHidden()
  await expect(page.locator('.source-reader mark')).toHaveCount(0)

  await page.getByRole('button', { name: /^reader\.py/ }).click()
  await source.focus()
  await page.keyboard.press('Control+F')
  await expect(search).toBeVisible()
  await searchInput.fill('')
  await expect(page.locator('.source-reader mark')).toHaveCount(0)

  await searchInput.press('Escape')
  await expect(search).toBeHidden()
  await expect(page.locator('.source-reader mark')).toHaveCount(0)
  await source.focus()
  await page.keyboard.press('Control+F')
  await expect(search).toBeVisible()

  await page.getByRole('button', { name: /^reader\.yaml/ }).click()
  await expect(search).toBeHidden()
  await expect(page.locator('.source-reader mark')).toHaveCount(0)
})

test('find works in JSON Markdown and full progressive text', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)

  await page.getByRole('button', { name: /^config\.json/ }).click()
  await page.getByRole('button', { name: '原文' }).click()
  const source = page.locator('.source-reader')
  await source.focus()
  await page.keyboard.press('Meta+F')
  let search = page.getByRole('search', { name: '当前文件查找' })
  let searchInput = search.getByRole('textbox', { name: '当前文件查找' })
  await searchInput.fill('hidden_size')
  await expect(search).toBeVisible()
  await expect(search.getByText('1 / 1', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark.find-match')).toHaveCount(1)
  await expect(page.locator('.source-reader mark.current')).toHaveAttribute('aria-current', 'true')

  await page.getByRole('button', { name: '概览' }).click()
  await expect(search).toBeHidden()
  await expect(page.locator('.source-reader mark')).toHaveCount(0)
  await page.getByRole('button', { name: '原文' }).click()
  await source.focus()
  await page.keyboard.press('Meta+F')
  await expect(searchInput).toHaveValue('')
  await searchInput.press('Escape')

  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.getByRole('heading', { name: 'Fixture Model' })).toBeVisible()
  await expect(page.getByRole('search', { name: '当前文件查找' })).toHaveCount(0)
  await page.getByRole('button', { name: '原文' }).click()
  await source.focus()
  await page.keyboard.press('Meta+F')
  search = page.getByRole('search', { name: '当前文件查找' })
  searchInput = search.getByRole('textbox', { name: '当前文件查找' })
  await searchInput.fill('Fixture')
  await expect(search.getByText('1 / 1', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark.find-match')).toHaveCount(1)
  await page.getByRole('button', { name: '渲染' }).click()
  await expect(search).toBeHidden()

  await page.getByRole('button', { name: /^merges\.txt/ }).click()
  await expect(page.getByText('显示 1,000 / 100,002')).toBeVisible({ timeout: 3_000 })
  const filter = page.getByPlaceholder('字段或内容包含…')
  await expect(filter).toHaveValue('')
  const rowsViewport = page.locator('.table-scroll')
  await rowsViewport.focus()
  await page.keyboard.press('Meta+F')
  search = page.getByRole('search', { name: '当前文件查找' })
  searchInput = search.getByRole('textbox', { name: '当前文件查找' })
  const query = 'token-100001 token-100002'
  const findStarted = Date.now()
  await searchInput.fill(query)
  await expect(search.getByText('1 / 1', { exact: true })).toBeVisible({ timeout: 3_000 })
  expect(Date.now() - findStarted).toBeLessThan(3_000)
  const row = page.getByRole('row', { name: new RegExp(query.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')) })
  const currentMark = row.locator('mark.current')
  await expect(row).toBeVisible()
  await expect(currentMark).toHaveCount(1)
  await expect(currentMark).toHaveAttribute('aria-current', 'true')
  expect(await currentMark.evaluate((element, selector) => {
    const viewport = document.querySelector(selector)
    if (!(element instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return false
    const mark = element.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    return mark.bottom >= bounds.top && mark.top <= bounds.bottom
      && mark.right >= bounds.left && mark.left <= bounds.right
  }, '.table-scroll')).toBe(true)

  await searchInput.press('Escape')
  await expect(search).toBeHidden()
  await expect(filter).toHaveValue('')
  await filter.fill(query)
  await expect(filter).toHaveValue(query)
  await expect(page.getByText('显示 1 / 1', { exact: true })).toBeVisible()
  await expect(row).toContainText(query)
  expect(errors).toEqual([])
})

test('Jinja source find preserves query while editing and resets on file switch', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)

  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await page.getByRole('tab', { name: '源码' }).click()
  const jinjaSource = page.getByLabel('Jinja 源码')
  await jinjaSource.focus()
  await page.keyboard.press('Meta+F')
  const search = page.getByRole('search', { name: '当前文件查找' })
  const searchInput = search.getByRole('textbox', { name: '当前文件查找' })
  await searchInput.fill('thinking')
  await expect(search.getByText('1 / 2', { exact: true })).toBeVisible()
  await expect(page.locator('.jinja-highlight mark.find-match')).toHaveCount(2)
  const firstMatchStart = await jinjaSource.evaluate(element =>
    (element as HTMLTextAreaElement).value.indexOf('thinking'))
  expect(await jinjaSource.evaluate(element => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }))).toEqual({ start: firstMatchStart, end: firstMatchStart + 'thinking'.length })
  const currentMark = page.locator('.jinja-highlight mark.find-match.current')
  await expect(currentMark).toHaveCount(1)
  await expect(currentMark).toHaveAttribute('aria-current', 'true')

  await searchInput.press('Enter')
  await expect(search.getByText('2 / 2', { exact: true })).toBeVisible()
  const secondMatchStart = await jinjaSource.evaluate(element =>
    (element as HTMLTextAreaElement).value.lastIndexOf('thinking'))
  expect(await jinjaSource.evaluate(element => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }))).toEqual({ start: secondMatchStart, end: secondMatchStart + 'thinking'.length })

  await searchInput.press('Shift+Enter')
  await expect(search.getByText('1 / 2', { exact: true })).toBeVisible()
  expect(await jinjaSource.evaluate(element => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }))).toEqual({ start: firstMatchStart, end: firstMatchStart + 'thinking'.length })

  const originalSource = await jinjaSource.inputValue()
  await jinjaSource.fill(`${originalSource}\nthinking`)
  await expect(searchInput).toHaveValue('thinking')
  await expect(search.getByText('1 / 3', { exact: true })).toBeVisible()
  await expect(page.locator('.jinja-highlight mark.find-match')).toHaveCount(3)
  expect(await jinjaSource.evaluate(element => {
    const source = element as HTMLTextAreaElement
    return {
      selected: source.value.slice(source.selectionStart ?? 0, source.selectionEnd ?? 0),
      length: (source.selectionEnd ?? 0) - (source.selectionStart ?? 0),
    }
  })).toEqual({ selected: 'thinking', length: 'thinking'.length })

  await page.getByRole('button', { name: /^config\.json/ }).click()
  await expect(search).toBeHidden()
  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await page.getByRole('tab', { name: '源码' }).click()
  await expect(search).toBeHidden()
  await expect(page.locator('.jinja-highlight mark')).toHaveCount(0)
  await jinjaSource.focus()
  await page.keyboard.press('Meta+F')
  await expect(searchInput).toHaveValue('')
  await searchInput.press('Escape')
  expect(errors).toEqual([])
})

test('reads semantic JSON, progressive text, and safe Markdown views', async ({ page }) => {
  const errors = collectErrors(page)
  const thirdPartyRequests: string[] = []
  page.on('request', request => {
    if (request.url().startsWith('https://example.com/')) thirdPartyRequests.push(request.url())
  })
  await installFixtureRoutes(page)
  await openFixture(page)

  await expect(page.getByRole('heading', { name: 'Model Config' })).toBeVisible()
  await expect(page.getByText('模型类型').locator('..')).toContainText('fixture')
  await page.getByRole('button', { name: '全部字段' }).click()
  await page.getByPlaceholder('字段或内容包含…').fill('hidden_size')
  await expect(page.getByRole('row', { name: /hidden_size.*8/ })).toBeVisible()
  await page.getByRole('button', { name: '原文' }).click()
  await expect(page.locator('.source-reader')).toContainText('"model_type":"fixture"')

  await page.getByRole('button', { name: /^generation_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'Generation Config' })).toBeVisible()
  await expect(page.getByText('最大长度').locator('..')).toContainText('64')

  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'Tokenizer Config' })).toBeVisible()
  await expect(page.getByText('Tokenizer Class').locator('..')).toContainText('BertTokenizer')

  await page.getByRole('button', { name: /^metadata\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'JSON', exact: true })).toBeVisible()
  await expect(page.getByText('根字段').locator('..')).toContainText('2')

  await page.getByRole('button', { name: /^vocab\.json/ }).click()
  await page.getByRole('button', { name: '全部字段' }).click()
  await expect(page.getByText('显示 1,000 / 10,005')).toBeVisible()
  await page.getByRole('button', { name: '再显示 1,000 项' }).click()
  await expect(page.getByText('显示 2,000 / 10,005')).toBeVisible()
  await page.getByPlaceholder('字段或内容包含…').fill('token-10004')
  await expect(page.getByRole('row', { name: /token-10004.*10004/ })).toBeVisible()

  const largeTextStarted = Date.now()
  await page.getByRole('button', { name: /^merges\.txt/ }).click()
  await expect(page.getByText('显示 1,000 / 100,002')).toBeVisible()
  expect(Date.now() - largeTextStarted).toBeLessThan(3000)
  await page.getByPlaceholder('字段或内容包含…').fill('token-100001')
  await expect(page.getByRole('row', { name: /token-100001 token-100002/ })).toBeVisible()

  await page.getByRole('button', { name: /^model\.safetensors\.index\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'Weight Index' })).toBeVisible()
  await expect(page.getByText('分片数量').locator('..')).toContainText('2')

  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.getByRole('heading', { name: 'Fixture Model' })).toBeVisible()
  await expect(page.getByRole('table')).toContainText('Markdown')
  await expect(page.locator('.markdown-body script')).toHaveCount(0)
  await expect(page.locator('.markdown-body img')).toHaveCount(0)
  await expect(page.getByText('图片：Third-party image')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Config' })).toHaveAttribute(
    'href',
    `https://huggingface.co/${fixtureModelId}/blob/${fixtureRevision}/config.json`,
  )
  await expect(page.getByText('Unsafe').locator('a')).toHaveCount(0)
  await page.getByLabel('排版').selectOption('compact')
  await expect(page.locator('.markdown-body')).toHaveClass(/markdown-compact/)
  await page.getByRole('button', { name: '原文' }).click()
  await expect(page.locator('.source-reader')).toContainText('<script>window.__markdownExecuted = true</script>')
  expect(await page.evaluate('window.__markdownExecuted')).toBeUndefined()
  expect(thirdPartyRequests).toEqual([])
  expect(errors).toEqual([])
})

test('parses bounded legacy Imatrix files and exposes searchable entry details', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /^imatrix-fixture\.dat/ }).click()

  await expect(page.getByText('格式').locator('..')).toContainText('llama.cpp legacy imatrix')
  await expect(page.getByText('Entry 数量').locator('..')).toContainText('2')
  await expect(page.getByText('数据集').locator('..')).toContainText('calibration.txt')
  await page.getByPlaceholder('Tensor 名称包含…').fill('ffn')
  await page.getByRole('button', { name: 'blk.0.ffn.weight' }).click()
  await expect(page.getByRole('heading', { name: '选中项 · blk.0.ffn.weight' })).toBeVisible()
  await expect(page.getByText('Call Count').locator('..')).toContainText('4')
  expect(requests.filter(request => request.path === 'imatrix-fixture.dat')).toEqual([
    expect.objectContaining({ range: null, status: 200 }),
  ])
  expect(errors).toEqual([])
})

test('edits and renders the authoritative Jinja source in a Worker', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)

  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'Tokenizer Config' })).toBeVisible()
  await page.getByRole('tab', { name: '源码' }).click()
  await expect(page.locator('.template-source > header')).toContainText('chat_template.jinja')
  await expect(page.getByLabel('Jinja 源码')).toContainText('mode={{ mode }}')
  await expect(page.getByLabel('Jinja 源码')).not.toContainText('embedded=')

  await page.getByRole('tab', { name: '试验台' }).click()
  await page.getByLabel('Preset').selectOption('tools')
  await page.getByRole('button', { name: '渲染', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Template 输出结构' })).toContainText('mode=tools')
  await expect(page.getByRole('table', { name: 'Template 输出结构' })).toContainText('search')
  await page.getByRole('button', { name: '原始输出' }).click()
  await expect(page.locator('.template-output .source-reader')).toContainText('assistant=')

  await page.getByRole('tab', { name: '源码' }).click()
  await page.getByLabel('Jinja 源码').fill('{% include "remote.jinja" %}')
  await expect(page.locator('.jinja-statement')).toContainText('include')
  await page.getByRole('tab', { name: '试验台' }).click()
  await page.getByRole('button', { name: '渲染', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('include')
  await expect(page.locator('.template-output .source-reader')).toHaveCount(0)
  await page.getByRole('tab', { name: '源码' }).click()
  await page.getByRole('button', { name: '恢复来源' }).click()
  await expect(page.getByLabel('Jinja 源码')).toContainText('mode={{ mode }}')
  expect(errors).toEqual([])
})

test('fails closed when a source returns HTTP 200 for a range', async ({ page }) => {
  await installFixtureRoutes(page, { rangeBehavior: 'http200' })
  await openFixture(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()

  await expect(page.getByRole('heading', { name: '无法读取文件' })).toBeVisible()
  await expect(page.getByText(/未确认 Range/)).toBeVisible()
})

test('consistency background acquires materials once and reports repository warnings', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  const badge = page.getByRole('button', { name: '查看仓库一致性报告' })

  await expect(badge).toHaveText('2 项警告')
  await expect(badge).toHaveAttribute('data-consistency-state', 'warnings')
  await expect(badge).toHaveAttribute('aria-expanded', 'false')
  await badge.click()
  await expect(badge).toHaveAttribute('aria-expanded', 'true')
  const report = page.getByRole('dialog', { name: '仓库一致性报告' })
  await expect(report).toBeVisible()
  await expect(report).toContainText('词表大小不一致')
  await expect(report).toContainText('EOS Token 不一致')
  await expect(report).toContainText('上下文长度声明不同')
  const embedded = page.getByRole('region', { name: 'Config 一致性报告' })
  await expect(embedded).toBeVisible()
  await expect(embedded.locator('[data-material]')).toHaveCount(8)
  const readerPerspective = page.locator('.detail-reader-stack').getByRole('group', { name: '阅读视图' })
  await expect(readerPerspective).toBeVisible()
  for (const button of ['概览', '全部字段', '原文']) {
    await expect(readerPerspective.getByRole('button', { name: button, exact: true })).toBeVisible()
  }
  const closeButton = report.getByRole('button', { name: '关闭' })
  await expect(closeButton).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(badge).toHaveAttribute('aria-expanded', 'false')
  await expect(report).toHaveCount(0)
  await expect(badge).toBeFocused()
  await badge.click()

  await page.getByRole('button', { name: /^generation_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'Generation Config' })).toBeVisible()
  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'Tokenizer Config' })).toBeVisible()
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await expect(page.getByText('Model Type').locator('..')).toContainText('WordPiece')
  for (const path of ['config.json', 'generation_config.json', 'tokenizer_config.json', 'tokenizer.json', 'chat_template.jinja']) {
    expect(requests.filter(request => request.path === path)).toHaveLength(1)
  }
  expect(requests.some(request => request.path === 'model.safetensors')).toBe(false)
  expect(requests.some(request => request.path === 'model.gguf')).toBe(false)

  await badge.click()
  await expect(report).toContainText('未在当前会话打开')

  await page.getByRole('button', { name: /^model\.gguf/ }).click()
  await expect(page.getByText('实际读取').locator('..').getByText('24 bytes')).toBeVisible()
  expect(requests.filter(request => request.path === 'model.gguf')).toEqual([
    expect.objectContaining({ range: 'bytes=0-23', responseBytes: 24, status: 206 }),
  ])
  await badge.click()
  const reopened = page.getByRole('dialog', { name: '仓库一致性报告' })
  await expect(reopened).toContainText('Web 仅读取 24-byte prefix，缺少 metadata/tensor directory。')
  await expect(reopened.locator('[data-material="gguf"]')).toContainText('跳过：Web 仅读取 24-byte prefix，缺少 metadata/tensor directory。')
  await expect(reopened.locator('[data-finding-id^="gguf-"]')).toHaveCount(0)

  await page.getByRole('button', { name: /^generation_config\.json/ }).click()
  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await page.getByRole('button', { name: /^model\.gguf/ }).click()
  for (const path of ['config.json', 'generation_config.json', 'tokenizer_config.json', 'tokenizer.json', 'chat_template.jinja']) {
    expect(requests.filter(request => request.path === path)).toHaveLength(1)
  }
  expect(requests.filter(request => request.path === 'model.gguf')).toEqual([
    expect.objectContaining({ range: 'bytes=0-23', responseBytes: 24, status: 206 }),
  ])
  expect(errors).toEqual([])
})

test('rejects oversized readers and keeps unsupported weights locked without content requests', async ({ page }) => {
  const contentRequests: string[] = []
  page.on('request', request => {
    if (request.url().includes('/resolve/')) contentRequests.push(request.url())
  })
  await installFixtureRoutes(page, { includeBoundaryFiles: true })
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: '打开' }).click()
  await expect(page.getByText(/公开仓库 · SHA 0123456 · 15 个文件/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Model Config' })).toBeVisible()
  const baselineRequests = contentRequests.length

  await page.getByRole('button', { name: /^oversized\.json/ }).click()
  await expect(page.getByRole('heading', { name: '无法读取文件' })).toBeVisible()
  await expect(page.getByText('文件超过 32 MiB 阅读上限。')).toBeVisible()
  await page.getByRole('button', { name: /^pytorch_model\.bin/ }).click()
  await expect(page.getByRole('heading', { name: '权重文件已锁定' })).toBeVisible()
  expect(contentRequests).toHaveLength(baselineRequests)
})

test('a newer repository request cancels and wins over a slow request', async ({ page }) => {
  await installFixtureRoutes(page, { manifestDelayMs: 250 })
  await page.goto('/')
  const repository = page.getByRole('combobox', { name: 'Hugging Face 仓库' })
  const open = page.getByRole('button', { name: /打开/ })

  await repository.fill('fixture/slow')
  await open.click()
  await repository.fill(fixtureModelId)
  await expect(open).toBeEnabled()
  await open.click()

  await expect(page.getByText(/公开仓库 · SHA 0123456 · 13 个文件/)).toBeVisible()
  await expect(repository).toHaveValue(fixtureModelId)
})

test('latest empty repository replaces delayed full consistency inspection', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, {
    delayedContentModelId: fixtureModelId,
    contentDelayMs: 250,
  })
  await page.goto('/')
  const repository = page.getByRole('combobox', { name: 'Hugging Face 仓库' })
  const open = page.getByRole('button', { name: /打开/ })

  const configRequest = page.waitForRequest(request => new URL(request.url()).pathname
    === `/${fixtureModelId}/resolve/${fixtureRevision}/config.json`)
  await repository.fill(fixtureModelId)
  await open.click()
  await Promise.all([
    configRequest,
    expect(page.getByText(/公开仓库 · SHA 0123456 · 13 个文件/)).toBeVisible(),
  ])
  const initialConfig = page.getByRole('button', { name: /^config\.json/ })
  await expect(initialConfig).toBeVisible()
  await expect(initialConfig).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.detail-body')).toHaveAttribute('aria-busy', 'true')

  await repository.fill('fixture/empty')
  await open.click()

  await expect(page.getByText(/公开仓库 · SHA fffffff · 1 个文件/)).toBeVisible()
  await delay(300)
  await expect(page.getByText(/公开仓库 · SHA fffffff · 1 个文件/)).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Hugging Face 仓库' })).toHaveValue('fixture/empty')
  await expect(page).toHaveURL(url => url.pathname === '/'
    && url.searchParams.get('repo') === 'fixture/empty'
    && url.searchParams.get('file') === 'README.md')
  await expect(page.getByRole('button', { name: /^README\.md/ })).toHaveAttribute('aria-current', 'true')
  const badge = page.getByRole('button', { name: '查看仓库一致性报告' })
  await expect(badge).toHaveText('材料不足')
  await badge.click()
  const report = page.getByRole('dialog', { name: '仓库一致性报告' })
  await expect(report).toContainText('缺少模型配置')
  await expect(report.locator('[data-material="config"]')).toContainText('缺失')
  await expect(report).not.toContainText('词表大小不一致')
  await expect(report).not.toContainText('EOS Token 不一致')
  for (const path of ['generation_config.json', 'tokenizer_config.json', 'tokenizer.json', 'chat_template.jinja']) {
    expect(requests.filter(request => request.path === path)).toHaveLength(0)
  }
  expect(requests.filter(request => request.path === 'config.json'))
    .toEqual([expect.objectContaining({ status: 200 })])
  expect(errors).toEqual([])
})

test('external tokenizer cancellation still publishes partial consistency', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The shared Worker cleanup path is covered on Chromium.')
  const errors = collectErrors(page)
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(Target, args) {
          const worker = Reflect.construct(Target, args) as Worker
          const originalPostMessage = worker.postMessage.bind(worker)
          let terminated = false
          const pendingTimers = new Set<number>()

          worker.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
            if (!(typeof message === 'object' && message !== null
              && (message as { type?: unknown }).type === 'inspect-structure')) {
              if (Array.isArray(transfer)) originalPostMessage(message, transfer)
              else if (transfer === undefined) originalPostMessage(message)
              else originalPostMessage(message, transfer)
              return
            }

            document.documentElement.dataset.testInspectWorkerPending = 'true'
            const timer = window.setTimeout(() => {
              pendingTimers.delete(timer)
              if (terminated) return
              try {
                if (Array.isArray(transfer)) originalPostMessage(message, transfer)
                else if (transfer === undefined) originalPostMessage(message)
                else originalPostMessage(message, transfer)
              } catch {
                // The real Worker may have been terminated during the delay.
              }
            }, 300)
            pendingTimers.add(timer)
          }

          const originalTerminate = worker.terminate.bind(worker)
          worker.terminate = () => {
            terminated = true
            for (const timer of pendingTimers) clearTimeout(timer)
            pendingTimers.clear()
            return originalTerminate()
          }
          return worker
        },
      }),
    })
  })
  await installFixtureRoutes(page)
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: /打开/ }).click()

  await expect(page.locator('html')).toHaveAttribute('data-test-inspect-worker-pending', 'true')
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await page.getByRole('button', { name: /^config\.json/ }).click()
  const badge = page.getByRole('button', { name: '查看仓库一致性报告' })
  await expect(badge).toHaveText('1 项警告')
  await badge.click()
  const report = page.getByRole('dialog', { name: '仓库一致性报告' })
  await expect(report).not.toContainText('词表大小不一致')
  await expect(report).toContainText('EOS Token 不一致')
  await expect(report.locator('[data-material="tokenizer"]')).toContainText('失败：Tokenizer 请求已取消。')
  await expect(report.locator('[data-material="config"]')).toContainText('已检查')
  await expect(report.locator('[data-material="chatTemplates"]')).toContainText('已检查')
  expect(errors).toEqual([])
})

test('restores, refreshes, and navigates shareable repository URLs', async ({ page }) => {
  const errors = collectErrors(page)
  await page.addInitScript("Object.defineProperty(navigator, 'clipboard', { value: { writeText: value => { window.__copiedPath = value; return Promise.resolve() } } })")
  await installFixtureRoutes(page)
  await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}&file=model.gguf`)
  await expect(page.getByText('实际读取').locator('..').getByText('24 bytes')).toBeVisible()
  await page.reload()
  await expect(page.getByText('实际读取').locator('..').getByText('24 bytes')).toBeVisible()

  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByText('参数总数').locator('..').getByText('2')).toBeVisible()
  await page.goBack()
  await expect(page.getByText('实际读取').locator('..').getByText('24 bytes')).toBeVisible()
  await page.goForward()
  await expect(page.getByText('参数总数').locator('..').getByText('2')).toBeVisible()
  await page.getByRole('button', { name: '复制路径' }).click()
  expect(await page.evaluate('window.__copiedPath')).toBe('model.safetensors')
  await expect(page.getByRole('button', { name: '已复制' })).toBeVisible()
  await expect(page.getByRole('link', { name: '源站' })).toHaveAttribute(
    'href',
    `https://huggingface.co/${fixtureModelId}/blob/${fixtureRevision}/model.safetensors`,
  )
  expect(errors).toEqual([])
})

test('filters locally, avoids duplicate reads, and retries a failed manifest', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await installFixtureRoutes(page, { manifestFailures: 1 })
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: '打开' }).click()
  await expect(page.getByRole('alert')).toContainText('HTTP 503')
  await page.getByRole('button', { name: '重试' }).press('Enter')
  await expect(page.getByText(/公开仓库 · SHA 0123456 · 13 个文件/)).toBeVisible()
  await expect(page.locator(`datalist option[value="${fixtureModelId}"]`)).toHaveCount(1)
  await expect(page.getByRole('button', { name: '查看仓库一致性报告' })).toHaveText('2 项警告')

  const beforeFilter = requests.length
  await page.getByPlaceholder('筛选文件').fill('config')
  const selectedConfig = page.getByRole('button', { name: /^config\.json/ })
  await expect(selectedConfig).toBeVisible()
  expect(requests).toHaveLength(beforeFilter)
  await selectedConfig.click()
  expect(requests).toHaveLength(beforeFilter)
  await page.getByRole('button', { name: '清除历史' }).click()
  await expect(page.locator(`datalist option[value="${fixtureModelId}"]`)).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
})

test('fails safely for invalid deep-link parameters', async ({ page }) => {
  await installFixtureRoutes(page)
  await page.goto('/?repo=invalid&file=..%2Fsecret')
  await expect(page.getByRole('alert')).toContainText('owner/model')
  await expect(page.getByRole('heading', { level: 2, name: '打开模型仓库' })).toBeVisible()
})

test('keeps controls reachable across target viewports, keyboard, and dark mode', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const capturesScreenshots = testInfo.project.name === 'chromium'
  await installFixtureRoutes(page)
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}&file=model.gguf`)
    await expect(page.getByRole('heading', { name: 'model.gguf', exact: true })).toBeVisible()
    await expect(page.getByText('实际读取').locator('..').getByText('24 bytes')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (capturesScreenshots) {
      const screenshot = testInfo.outputPath(`${viewport.width}x${viewport.height}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`${viewport.width}x${viewport.height}`, { path: screenshot, contentType: 'image/png' })
    }
  }

  await page.goto('/')
  await page.keyboard.press('Tab')
  const repository = page.getByRole('combobox', { name: 'Hugging Face 仓库' })
  await expect(repository).toBeFocused()
  await repository.fill(fixtureModelId)
  await repository.press('Enter')
  await expect(page.getByText(/公开仓库 · SHA 0123456 · 13 个文件/)).toBeVisible()
  const open = page.getByRole('button', { name: '打开' })
  await open.focus()
  await expect(open).toBeFocused()
  expect(await open.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')

  const filter = page.getByPlaceholder('筛选文件')
  await filter.focus()
  await page.keyboard.type('safetensors')
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).press('Enter')
  await page.getByRole('button', { name: 'Tensors', exact: true }).press('Enter')
  await expect(page.getByRole('table', { name: 'SafeTensors Tensors' })).toBeVisible()

  await filter.press('Meta+A')
  await filter.press('Backspace')
  await page.keyboard.type('tokenizer_config')
  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).press('Enter')
  await page.getByRole('tab', { name: '源码' }).press('Enter')
  const source = page.getByLabel('Jinja 源码')
  await source.focus()
  await source.press('Meta+A')
  await page.keyboard.insertText('{{ messages | length }}')
  await page.getByRole('tab', { name: '试验台' }).press('Enter')
  await page.getByRole('button', { name: '渲染', exact: true }).press('Enter')
  await expect(page.getByRole('table', { name: 'Template 输出结构' })).toContainText('2')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}&file=model.gguf`)
  expect(await contrastRatio(page, 'body')).toBeGreaterThanOrEqual(4.5)
  expect(await contrastRatio(page, '.scope-note')).toBeGreaterThanOrEqual(4.5)
  if (capturesScreenshots) {
    const darkScreenshot = testInfo.outputPath('dark-mode.png')
    await page.screenshot({ path: darkScreenshot })
    await testInfo.attach('dark-mode', { path: darkScreenshot, contentType: 'image/png' })
  }
  expect(errors).toEqual([])
})

async function openFixture(page: Page, expectedFileCount = 13) {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: '打开' }).click()
  await expect(page.getByText(new RegExp(`公开仓库 · SHA 0123456 · ${expectedFileCount} 个文件`))).toBeVisible()
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function contrastRatio(page: Page, selector: string): Promise<number> {
  return await page.locator(selector).evaluate(element => {
    const style = getComputedStyle(element)
    const rgb = (value: string) => value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]
    const luminance = (value: number[]) => value.map(channel => {
      const normalized = channel / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
    const foreground = luminance(rgb(style.color))
    const background = luminance(rgb(style.backgroundColor))
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  })
}
