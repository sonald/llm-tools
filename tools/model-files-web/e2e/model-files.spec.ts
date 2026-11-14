import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import {
  crossRepositoryModelId,
  crossRepositoryRevision,
  fixtureModelId,
  fixtureRevision,
  installFixtureRoutes,
  pythonReaderSource,
  writeNoTokenizerFixtureDirectory,
  writeComparisonFixtureDirectory,
  writeFixtureDirectory,
  writePerformanceFindFixture,
  openPerspective,
  openPlaygroundMode,
  tokenizerMetric,
  expectRepository,
  expandWeights,
  setLaunchInput,
} from './fixtures.ts'

test('workbench shell follows native header, sidebar and panel conventions', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)
  // Header: name, purpose · size · source · branch · SHA, a badge with help, no format chip for JSON.
  const header = page.locator('.detail-header')
  await expect(header.getByRole('heading', { level: 1 })).toHaveText('config.json')
  await expect(header.locator('.file-title p')).toHaveText(/^模型配置 · 144 字节 · Hugging Face · main · SHA \S{7}$/)
  await expect(page.getByRole('button', { name: '查看仓库一致性报告' })).toHaveAttribute('title', '查看仓库一致性报告')
  await expect(header.locator('.format-chip')).toHaveCount(0)
  // Sidebar: names with notes, weights collapsed behind "N/M 可预览".
  await expect(page.getByRole('button', { name: /^tokenizer_config\.json 含内嵌 Chat Template/ })).toBeVisible()
  const weights = page.locator('.weights-group')
  await expect(weights).not.toHaveAttribute('open', '')
  await expect(weights.locator('summary')).toContainText('2/2 可预览')
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(header.locator('.format-chip')).toHaveText('SafeTensors')
  await expect(header.locator('.file-title p')).toHaveText(/^SafeTensors 权重结构 · /)
  // Panel: Problems first, then the docked tokenizer tabs; the first result opens it on Token 表; Esc closes it.
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
  const panel = page.getByRole('region', { name: '底部面板' })
  await expect(panel.getByRole('tab')).toHaveText([/^问题 \d+$/, 'Token 表', 'Token IDs 3'])
  await expect(panel.getByRole('tab', { name: 'Token 表' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('textbox', { name: '原始文本' }).press('Escape')
  await expect(panel).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Tokenizer Worker tokenizes and decodes back to the input', async ({ page }) => {
  const errors = collectErrors(page)
  await page.addInitScript("Object.defineProperty(navigator, 'clipboard', { value: { writeText: value => { window.__copiedToken = value; return Promise.resolve() } } })")
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'WordPiece', exact: true })).toBeVisible()
  await expect(page.locator('.key-value-row').filter({ hasText: '模型类型' })).toContainText('WordPiece')
  await expect(page.locator('.key-value-row').filter({ hasText: '词表项' })).toContainText('6')
  await expect(page.getByRole('region', { name: '词表长度' })).toContainText('基础词表 6 项')
  await openPlaygroundMode(page, '原始文本')
  const raw = page.getByRole('textbox', { name: '原始文本' })
  await raw.fill('hello worlds')

  // Live encode: the single decoded segment rebuilds the input exactly.
  const segment = resultPanel(page).getByRole('button', { name: 'Token 0 到 2，ID 3, 4, 5，文本 hello worlds，角色 无' })
  await expect(segment).toBeVisible()
  await expect(resultPanel(page)).toContainText('tokenizer.json · Exact')
  await expect(tokenizerText(page)).toHaveText('hello worlds')
  await expect(page.getByText('12 字节', { exact: true })).toBeVisible()
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('3')
  await expect(tokenizerMetric(page, 'Unicode 字符')).toHaveText('12')
  await expect(tokenizerMetric(page, '字节 / Token')).toHaveText('4.0')
  await expect(tokenizerMetric(page, '正文 token')).toHaveCount(0)
  await expect(tokenizerMetric(page, '模板开销（近似）')).toHaveCount(0)
  await expect(tokenTable(page).getByRole('columnheader', { name: 'Decoded' })).toBeVisible()
  await showPanelTab(page, 'Token IDs')
  await page.getByRole('button', { name: 'Token 0，ID 3，文本 hello', exact: true }).click()
  const inspector = page.getByRole('complementary', { name: '检查器' })
  await expect(inspector.getByRole('heading', { name: '选中 Token' })).toBeVisible()
  await inspector.getByRole('button', { name: '复制 ID', exact: true }).click()
  expect(await page.evaluate('window.__copiedToken')).toBe('3')
  await showPanelTab(page, 'Token 表')
  // 显示空白符 is off by default; on, spaces render as ·.
  const whitespace = resultPanel(page).getByRole('checkbox', { name: '显示空白符' })
  await expect(whitespace).not.toBeChecked()
  await whitespace.check()
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello·worlds，/ })).toBeVisible()
  await whitespace.uncheck()
  await expect(segment).toBeVisible()
  expect(requests.filter(request => request.path.startsWith('tokenizer'))
    .map(request => request.path).toSorted()).toEqual(['tokenizer.json', 'tokenizer_config.json'])

  await page.getByRole('button', { name: '清空', exact: true }).click()
  await expect(raw).toHaveValue('')
  await expect(page.getByText('0 字节', { exact: true })).toBeVisible()
  await expect(segment).toHaveCount(0)
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('0')
  await expect(resultPanel(page).getByText('输入内容后显示 token。')).toBeVisible()
  await expect(page.getByText('输入内容后显示实际编码文本。')).toBeVisible()

  // Chat renders live; the compact editor replaces the JSON inputs.
  await openPlaygroundMode(page, 'Chat 对话')
  await expect(tokenizerText(page)).toHaveText(
    'system=You are a concise assistant.;user=解释一下：分词为什么会影响上下文长度？;thinking=true;mode=;assistant=',
  )
  await page.getByRole('textbox', { name: 'system 消息' }).fill('You are concise.')
  await page.getByRole('textbox', { name: 'user 消息' }).fill('Hello')
  await page.getByText('高级选项', { exact: true }).click()
  // Native prefills tokenizer_config special tokens and enable_thinking; add `mode` as a typed variable.
  const variables = page.locator('.request-card.variable')
  await expect(variables).toHaveCount(2)
  await expect(variables.nth(0).getByLabel('变量名')).toHaveValue('unk_token')
  await expect(variables.nth(0).getByRole('textbox', { name: '值' })).toHaveValue('[UNK]')
  await expect(variables.nth(1).getByLabel('变量名')).toHaveValue('enable_thinking')
  await expect(variables.nth(1).getByRole('checkbox', { name: '值' })).toBeChecked()
  await variables.nth(1).getByRole('checkbox', { name: '值' }).uncheck()
  await page.locator('.request-heading').filter({ hasText: '其他变量' }).getByRole('button', { name: '＋ 添加' }).click()
  await variables.nth(2).getByLabel('变量名').fill('mode')
  await variables.nth(2).getByRole('textbox', { name: '值' }).fill('chat')
  const expectedAuthoritative = 'system=You are concise.;user=Hello;thinking=false;mode=chat;assistant='
  await expect(tokenizerText(page)).toHaveText(expectedAuthoritative)
  await expect(resultPanel(page).getByText('当前映射是 Decoded only，不能按原文划分角色')).toBeVisible()
  await expect(resultPanel(page)).toContainText('tokenizer.json · Decoded only')
  await expect(tokenTable(page).getByRole('columnheader', { name: 'Special' })).toBeVisible()
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('21')
  await expect(tokenizerMetric(page, '正文 token')).toHaveText('5')
  await expect(tokenizerMetric(page, '模板开销（近似）')).toHaveText('16')
  await expect(tokenTable(page)).toHaveAttribute('aria-label', 'Token 表，共 21 行')
  const defaultChatRows = tokenRows(page)
  for (let i = 0; i < await defaultChatRows.count(); i++) {
    await expect(defaultChatRows.nth(i).getByRole('cell').nth(4)).toHaveText('—')
  }
  expect(requests.filter(request => request.path.startsWith('tokenizer'))).toHaveLength(2)

  await page.getByRole('checkbox', { name: 'Tools' }).check()
  await page.getByRole('textbox', { name: '函数名' }).fill('search')
  await variables.nth(1).getByRole('checkbox', { name: '值' }).check()
  await variables.nth(2).getByRole('textbox', { name: '值' }).fill('chat-plus')
  await expect(tokenizerText(page)).toContainText('tools=[{"type": "function"')
  await expect(tokenizerText(page)).toContainText('"name": "search"')
  await expect(tokenizerText(page)).toContainText('thinking=true;mode=chat-plus;assistant=')

  await page.getByRole('checkbox', { name: 'Tools' }).uncheck()
  await expect(tokenizerText(page)).toHaveText('system=You are concise.;user=Hello;thinking=true;mode=chat-plus;assistant=')
  expect(requests.filter(request => request.path.startsWith('tokenizer'))).toHaveLength(2)

  // Message content is data, never template source.
  await page.locator('.compact-message').first().getByRole('button', { name: '删除消息' }).click()
  await page.getByRole('textbox', { name: 'user 消息' }).fill('{{ 7 * 7 }}')
  await expect(tokenizerText(page)).toContainText('user={{ 7 * 7 }};')
  await expect(tokenizerText(page)).not.toContainText('49')
  expect(errors).toEqual([])
})

test('attributes Exact Chat tokens to the edited message role', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page, { omitIndependentChatTemplate: true })
  await openFixture(page, 12)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await openPlaygroundMode(page, 'Chat 对话')
  // The compact editor offers the native roles only (system / user / assistant / tool).
  const first = page.locator('.compact-message').first()
  await first.getByRole('combobox', { name: '消息角色' }).selectOption('assistant')
  await page.getByRole('textbox', { name: 'assistant 消息' }).fill('hello worlds')
  await page.locator('.compact-message').nth(1).getByRole('button', { name: '删除消息' }).click()
  await expect(page.locator('.compact-message')).toHaveCount(1)

  await expect(tokenizerText(page)).toHaveText('hello worlds')
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('3')
  await expect(resultPanel(page)).toContainText('tokenizer.json · Exact')
  await expect(resultPanel(page).getByText('当前映射是 Decoded only，不能按原文划分角色')).toHaveCount(0)
  const rows = tokenRows(page)
  await expect(rows).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await expect(rows.nth(i).getByRole('cell').nth(4)).toHaveText('assistant')
    await expect(rows.nth(i)).toHaveAttribute('aria-label', new RegExp(`^Token ${i}，.*，Role assistant，`))
  }
  const segment = resultPanel(page).getByRole('button', { name: 'Token 0 到 2，ID 3, 4, 5，文本 hello worlds，角色 assistant' })
  await expect(segment).toBeVisible()
  await expect(segment.locator('.tkp-role-bar')).toHaveAttribute('data-tone', '3')
  await segment.click()
  const inspector = page.getByRole('complementary', { name: '检查器' })
  await expect(inspector.getByRole('heading', { name: '选中 Token' })).toBeVisible()
  await expect(inspector.locator('.inspector-facts div').filter({ hasText: '角色' })).toContainText('assistant')
  expect(errors).toEqual([])
})

test('searches vocabulary latest-only without rereading tokenizer resources', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  const card = page.getByRole('region', { name: '词表搜索' })
  const search = card.getByRole('textbox', { name: '搜索 token 或 ID' })
  const results = card.getByRole('list', { name: '词表搜索' }).getByRole('listitem')

  await expect(search).toHaveAttribute('placeholder', '搜索 token 或 ID')
  await expect(card.getByText('输入 token 或十进制 ID 开始搜索。')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Special added_tokens' }).getByRole('listitem')).toHaveText([
    '[UNK]0', '[CLS]1', '[SEP]2',
  ])

  await search.fill('HEL')
  await expect(card.getByText('匹配 1 条')).toBeVisible()
  await expect(results).toHaveCount(1)
  await expect(results.nth(0)).toContainText('hello')

  await search.fill('4')
  await expect(card.getByText('匹配 1 条')).toBeVisible()
  await expect(results).toHaveCount(1)
  await expect(results.nth(0)).toContainText('world')

  await search.fill('hello')
  await search.fill('world')
  await expect(card.getByText('匹配 1 条')).toBeVisible()
  await expect(results).toHaveCount(1)
  await expect(results.nth(0)).toContainText('world')

  await search.fill('')
  await expect(card.getByText('输入 token 或十进制 ID 开始搜索。')).toBeVisible()
  await expect(card.getByRole('list', { name: '词表搜索' })).toHaveCount(0)

  await openPlaygroundMode(page, '原始文本')
  await openPerspective(page, '概览')
  await expect(page.getByRole('textbox', { name: '搜索 token 或 ID' })).toHaveValue('')
  await expect(page.getByText('输入 token 或十进制 ID 开始搜索。')).toBeVisible()
  expect(requests.filter(request => request.path === 'tokenizer.json')).toHaveLength(1)
  expect(requests.filter(request => request.path === 'tokenizer_config.json')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('selects between independent and tokenizer config chat templates', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await openPlaygroundMode(page, 'Chat 对话')
  const selector = page.getByRole('combobox', { name: 'Chat Template' })

  await expect(selector).toHaveValue('jinjaFile:default')
  await expect(selector.locator('option')).toHaveText([
    'chat_template.jinja',
    'tokenizer_config.json · default',
  ])
  await expect(tokenizerText(page)).toContainText('system=You are a concise assistant.')
  await selector.selectOption('tokenizerConfig:default')
  await expect(tokenizerText(page)).toHaveText('You are a concise assistant.')
  await selector.selectOption('jinjaFile:default')
  await expect(tokenizerText(page)).toContainText('system=You are a concise assistant.')

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
  await openPlaygroundMode(page, 'Chat 对话')
  const selector = page.getByRole('combobox', { name: 'Chat Template' })

  await expect(selector).toHaveValue('tokenizerConfig:default')
  const options = selector.locator('option')
  await expect(options).toHaveText([
    'tokenizer_config.json · default',
    'tokenizer_config.json · first',
    'tokenizer_config.json · tool_use',
  ])
  await expect(options.nth(1)).toBeDisabled()
  await expect(tokenizerText(page)).toHaveText('CONFIG_DEFAULT')
  await selector.selectOption('tokenizerConfig:tool_use')
  await expect(tokenizerText(page)).toHaveText('TOOL')

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
  await openPerspective(page, '试验台')
  // Native: with no usable template, Chat falls back to 原始文本 once loading finishes and stays disabled.
  const modes = page.getByRole('group', { name: '输入模式' })
  await expect(modes.getByRole('button', { name: '原始文本' })).toHaveAttribute('aria-pressed', 'true')
  await expect(modes.getByRole('button', { name: 'Chat 对话' })).toBeDisabled()
  await expect(modes.getByRole('button', { name: 'Token IDs' })).toBeEnabled()
  await expect(page.locator('.tkp-input-controls')).toHaveAttribute('title', '当前目录没有可用 Chat Template；Token IDs 仍可用')
  await expect(page.getByRole('combobox', { name: 'Chat Template' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '原始文本' })).toBeVisible()
  await expect(tokenizerMetric(page, 'Token 数量')).not.toHaveText('—')

  expect(requests.filter(request => request.path === 'tokenizer_config.json')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('keeps 10k-token Raw results progressive and latest-only', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Performance gate is recorded once in Chromium.')
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await openPlaygroundMode(page, '原始文本')
  const input = page.getByRole('textbox', { name: '原始文本' })
  await input.fill('hello')
  await input.fill('worlds')
  await expect(resultPanel(page).getByRole('button', { name: /^Token 0 到 1，ID 4, 5，文本 worlds，/ })).toBeVisible()
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('2')
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello，/ })).toHaveCount(0)

  const started = Date.now()
  await input.fill('hello '.repeat(10_000))
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('10,000', { timeout: 10_000 })
  const tokenizationMs = Date.now() - started
  expect(tokenizationMs).toBeLessThan(10_000)
  console.log(`PERF 10k-token tokenizationMs=${tokenizationMs}`)
  // Native virtualizes the table: every row is reachable by scrolling, only the visible window is in the DOM.
  const table = tokenTable(page)
  // Native String(localized: "Token 表，共 \(count) 行") groups digits in zh-Hans.
  await expect(table).toHaveAttribute('aria-label', 'Token 表，共 10,000 行')
  await expect(table).toHaveAttribute('aria-rowcount', '10001')
  expect(await tokenRows(page).count()).toBeLessThan(100)
  await expect(tokenRows(page).first()).toHaveAttribute('aria-label', /^Token 0，ID 3，/)
  await table.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(table.getByRole('row', { name: /^Token 9,999，ID 3，/ })).toBeVisible()
  expect(await tokenRows(page).count()).toBeLessThan(100)

  await input.fill('hello '.repeat(11_000))
  // 64 KiB limit, shown with decimal units like native ByteCountFormatter.
  await expect(resultPanel(page).getByRole('status')).toHaveText('⚠︎输入超过 66 KB 上限')
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('—')
})

test('caps large vocabulary search results at one thousand without config', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Performance gate is recorded once in Chromium.')
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, { largeVocabularyWithoutConfig: true })
  await openFixture(page, 12)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  const card = page.getByRole('region', { name: '词表搜索' })
  const search = card.getByRole('textbox', { name: '搜索 token 或 ID' })
  const results = card.getByRole('list', { name: '词表搜索' }).getByRole('listitem')

  await expect(page.locator('.key-value-row').filter({ hasText: '词表项' })).toContainText('1,011')
  const started = Date.now()
  await search.fill('needle')
  await expect(results).toHaveCount(1000, { timeout: 10_000 })
  expect(Date.now() - started).toBeLessThan(10_000)
  // Native String(localized: "匹配 \(count) 条") groups digits in zh-Hans.
  await expect(card.getByText('匹配 1,000 条')).toBeVisible()

  await search.fill('needle-1004')
  await expect(card.getByText('匹配 1 条')).toBeVisible()
  await expect(results).toHaveCount(1)
  await expect(results.nth(0)).toContainText('needle-1004')
  await expect(results.nth(0)).toContainText('1,010')

  expect(requests.filter(request => request.path === 'tokenizer.json')).toHaveLength(1)
  expect(requests.filter(request => request.path === 'tokenizer_config.json')).toHaveLength(0)
  expect(errors).toEqual([])
})

test('decodes shared Token IDs with special flags and linked selection', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await openPlaygroundMode(page, 'Token IDs')
  const ids = page.getByRole('textbox', { name: 'Token IDs' })

  // Empty by default, so the parser asks for input before anything is decoded.
  await expect(ids).toHaveValue('')
  await expect(page.getByText('支持逗号、空白或 JSON 数组')).toBeVisible()
  await expect(resultPanel(page).getByRole('status')).toHaveText(/请输入至少一个 Token ID。/)
  await expect(resultPanel(page).getByRole('button', { name: '重试' })).toHaveCount(0)
  await ids.fill('1,3,2')
  await expect(resultPanel(page)).toContainText('tokenizer.json · 由 Token ID 解码')
  await expect(page.getByRole('region', { name: '输入', exact: true })).toContainText('由 Token ID 解码')
  await expect(tokenizerText(page, '解码文本')).toContainText('hello')
  await expect(page.getByRole('region', { name: '解码文本' })).toContainText('由 Token ID 解码 ·')
  const rows = tokenRows(page)
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0).getByRole('cell').nth(5)).toHaveText('[CLS]')
  await expect(rows.nth(1).getByRole('cell').nth(5)).toHaveText('—')
  await expect(rows.nth(2).getByRole('cell').nth(5)).toHaveText('[SEP]')
  await expect(rows.nth(0).getByRole('cell').nth(6)).toHaveText('Decoded only')

  const segment = resultPanel(page).locator('.tkp-segment').first()
  const row = rows.nth(0)
  const idChip = page.getByRole('button', { name: 'Token 0，ID 1，文本 [CLS]', exact: true })
  const detail = page.getByRole('complementary', { name: '检查器' }).getByRole('heading', { name: '选中 Token' })
  // The table and the ID chips share the bottom panel, so each check shows its tab first.
  await segment.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'true')
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(detail).toBeVisible()
  await showPanelTab(page, 'Token IDs')
  await expect(idChip).toHaveAttribute('aria-pressed', 'true')
  await segment.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'false')
  await expect(idChip).toHaveAttribute('aria-pressed', 'false')
  await expect(detail).toHaveCount(0)
  await idChip.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'true')
  await expect(idChip).toHaveAttribute('aria-pressed', 'true')
  await showPanelTab(page, 'Token 表')
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await row.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'false')
  await expect(row).toHaveAttribute('aria-selected', 'false')
  await row.click()
  await expect(segment).toHaveAttribute('aria-pressed', 'true')
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await showPanelTab(page, 'Token IDs')
  await expect(idChip).toHaveAttribute('aria-pressed', 'true')
  await showPanelTab(page, 'Token 表')
  await row.press('Enter')
  await expect(segment).toHaveAttribute('aria-pressed', 'false')
  await expect(row).toHaveAttribute('aria-selected', 'false')
  await expect(detail).toHaveCount(0)

  await showPanelTab(page, 'Token IDs')
  await idChip.click()
  await expect(detail).toBeVisible()
  await showPanelTab(page, 'Token 表')

  // Live and latest-only: a superseded edit never publishes, and every edit clears the selection.
  await ids.fill('[3]')
  await ids.fill('[4,5]')
  await expect(tokenizerText(page, '解码文本')).toHaveText('worlds')
  await expect(rows).toHaveCount(2)
  await expect(detail).toHaveCount(0)
  await showPanelTab(page, 'Token IDs')
  await expect(page.getByRole('button', { name: 'Token 0，ID 4，文本 world', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Token 1，ID 5，文本 ##s', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Token 0，ID 3，/ })).toHaveCount(0)
  await showPanelTab(page, 'Token 表')

  await ids.fill('3,nope')
  await expect(resultPanel(page).getByRole('status')).toContainText('第 2 个 token（index 1）不是整数：nope')
  await expect(tokenTable(page)).toHaveCount(0)
  await expect(detail).toHaveCount(0)
  await expect(page.getByText('输入 Token ID 后显示解码文本。')).toBeVisible()

  await openPlaygroundMode(page, '原始文本')
  const rawInput = page.getByRole('textbox', { name: '原始文本' })
  await rawInput.fill('[CLS] hello')
  await expect(tokenTable(page)).toHaveAttribute('aria-label', 'Token 表，共 2 行')
  await expect(rows.nth(0).getByRole('cell').nth(5)).toHaveText('[CLS]')
  await expect(rows.nth(1).getByRole('cell').nth(5)).toHaveText('—')
  await rawInput.fill('hello worlds')
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello worlds，/ })).toBeVisible()
  await expect(resultPanel(page)).toContainText('tokenizer.json · Exact')
  await expect(rows).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await expect(rows.nth(i).getByRole('cell').nth(5)).toHaveText('—')
  }
  expect(errors).toEqual([])
})

test('compares same-snapshot Raw tokenizers and isolates a failed right target', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, { includeComparisonTokenizers: true })
  await openFixture(page, 18)
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('3')

  const menuButton = page.getByRole('button', { name: '对照', exact: true })
  await expect(menuButton).toHaveAttribute('aria-haspopup', 'menu')
  await menuButton.click()
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('menu', { name: '对照' }).getByRole('menuitem')).toHaveText([
    'alternate/tokenizer.json',
    'broken/tokenizer.json',
    'no-config/tokenizer.json',
    'tokenizer.json',
    '选择另一仓库…',
  ])
  await page.getByRole('menuitem', { name: 'alternate/tokenizer.json' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)

  const comparison = comparisonPanel(page)
  await expect(comparison).toContainText('主 3对照 3差值 0ID 序列不同')
  await expect(comparison.getByText('第一处不同：index 0，主 3，对照 4')).toBeVisible()
  await expect(comparison.getByText(/^模板开销（近似）/)).toHaveCount(0)
  await expect(resultPanel(page)).toHaveCount(0)
  await expect(page.getByRole('region', { name: '底部面板' })).toHaveCount(0)
  const primary = comparison.getByRole('region', { name: '主侧' })
  const right = comparison.getByRole('region', { name: 'alternate/tokenizer.json' })
  await expect(tokenRows(primary).nth(0)).toHaveAttribute('aria-label', /^Token 0，ID 3，Piece hello，/)
  await expect(tokenRows(right).nth(0)).toHaveAttribute('aria-label', /^Token 0，ID 4，Piece hello，/)
  await expect(comparison).toContainText('仅主 0仅对照 1共有 6')
  const side = comparison.getByRole('group', { name: '差集侧' })
  await expect(side.getByRole('button', { name: '仅主' })).toHaveAttribute('aria-pressed', 'true')
  await side.getByRole('button', { name: '仅对照' }).click()
  await comparison.getByRole('textbox', { name: '搜索 token piece' }).fill('alt')
  await expect(comparison.getByText('显示 1 条，最多 1,000 条')).toBeVisible()
  await expect(comparison.locator('.tkp-vocabulary-list')).toHaveText('alt-token')

  // A failing right target replaces only the comparison body; the primary result stays intact.
  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await openComparison(page, 'no-config/tokenizer.json')
  await expect(comparison.getByRole('status')).toContainText('缺少 tokenizer_config.json', { timeout: 5_000 })
  await expect(comparison.getByRole('region', { name: '主侧' })).toHaveCount(0)
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('3')
  await expect(tokenizerText(page)).toHaveText('hello worlds')
  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello worlds，/ })).toBeVisible()
  await openComparison(page, 'alternate/tokenizer.json')
  await expect(comparison.getByText('第一处不同：index 0，主 3，对照 4')).toBeVisible()

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await expect(comparison).toHaveCount(0)
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello worlds，/ })).toBeVisible()
  await showPanelTab(page, 'Token 表')
  await expect(tokenRows(page)).toHaveCount(3)
  await openComparison(page, 'alternate/tokenizer.json')
  await expect(comparison.getByRole('region', { name: 'alternate/tokenizer.json' })).toBeVisible()

  const comparisonPaths = requests.filter(request => /^(alternate|broken|no-config)\//.test(request.path))
  expect(comparisonPaths.map(request => `${request.path}:${request.range ?? 'whole'}`).toSorted())
    .toEqual([
      'alternate/chat_template.jinja:whole',
      'alternate/tokenizer.json:whole',
      'alternate/tokenizer_config.json:whole',
      'no-config/tokenizer.json:whole',
    ])
  expect(errors).toEqual([])
})

test('keeps the main tokenizer usable while shared workspaces compare both sides', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, { includeComparisonTokenizers: true })
  await openFixture(page, 18)
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await openPlaygroundMode(page, 'Token IDs')
  await openComparison(page, 'alternate/tokenizer.json')
  await page.getByRole('textbox', { name: 'Token IDs' }).fill('[1,3,2]')

  const comparison = comparisonPanel(page)
  const mainRows = tokenRows(comparison.getByRole('region', { name: '主侧' }))
  const right = comparison.getByRole('region', { name: 'alternate/tokenizer.json' })
  const rightRows = tokenRows(right)
  await expect(mainRows).toHaveCount(3)
  await expect(rightRows).toHaveCount(3)
  await expect(mainRows.nth(1)).toHaveAttribute('aria-label', /^Token 1，ID 3，Piece hello，/)
  await expect(rightRows.nth(1)).toHaveAttribute('aria-label', /^Token 1，ID 3，Piece world，/)
  await expect(comparison).toContainText('ID 序列相同')

  // The comparison follows the primary into Chat; each side renders its own template.
  await openPlaygroundMode(page, 'Chat 对话')
  const leftTemplate = tokenizerText(page)
  const rightTemplate = right.getByRole('combobox', { name: 'Chat Template' })
  await expect(leftTemplate).toContainText('system=You are a concise assistant.')
  await expect(rightTemplate).toHaveValue('jinjaFile:default')
  await expect(rightTemplate.locator('option')).toHaveText(['chat_template.jinja', 'tokenizer_config.json · default'])
  // ALT-JINJA renders 9 tokens; ALT-CONFIG adds one in-vocabulary word.
  await expect(comparison).toContainText('对照 9')
  await expect(comparison).toContainText('模板开销（近似）：主 15 · 对照 无法按差量拆分')
  await rightTemplate.selectOption('tokenizerConfig:default')
  await expect(comparison).toContainText('对照 10')
  await expect(tokenRows(right).nth(3)).toHaveAttribute('aria-label', /^Token 3，ID 4，Piece hello，/)
  await expect(leftTemplate).toContainText('system=You are a concise assistant.')
  await expect(page.getByRole('combobox', { name: 'Chat Template' }).first()).toHaveValue('jinjaFile:default')

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await openComparison(page, 'broken/tokenizer.json')
  await expect(comparison.getByRole('status')).toContainText('tokenizer.json 无效：未能读取数据，因为它的格式不正确。', { timeout: 5_000 })
  await expect(leftTemplate).toContainText('system=You are a concise assistant.')
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('40')

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await openComparison(page, 'alternate/tokenizer.json')
  await expect(right.getByRole('combobox', { name: 'Chat Template' })).toHaveValue('jinjaFile:default')
  await expect(comparison).toContainText('对照 9')
  await expect(leftTemplate).toContainText('system=You are a concise assistant.')

  expect(requests.filter(request => request.path.startsWith('alternate'))
    .map(request => request.path).toSorted()).toEqual([
    'alternate/chat_template.jinja',
    'alternate/tokenizer.json',
    'alternate/tokenizer_config.json',
  ])
  expect(requests.filter(request => request.path === 'broken/tokenizer.json')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('loads an isolated public Hugging Face comparison repository', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page, { includeComparisonTokenizers: true })
  const mainUrls: string[] = []
  const externalUrls: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.includes(fixtureModelId)) mainUrls.push(url.pathname)
    if (url.pathname.includes(crossRepositoryModelId)) externalUrls.push(url.pathname)
  })
  await openFixture(page, 18)
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello worlds，/ })).toBeVisible()

  const badge = page.getByRole('button', { name: '查看仓库一致性报告' })
  await expect(badge).toHaveAttribute('data-consistency-state', 'warnings')
  const snapshot = async () => ({
    url: page.url(),
    historyLength: await page.evaluate(() => history.length),
    repositoryInput: await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).inputValue(),
    status: await page.locator('.repository-status').innerText(),
    detailHeader: await page.locator('.detail-header').innerText(),
    localStorageHistory: await page.evaluate(() => localStorage.getItem('model-files.repository-history')),
    consistencyState: await badge.getAttribute('data-consistency-state'),
    consistencyExpanded: await badge.getAttribute('aria-expanded'),
    consistencyLabel: await badge.innerText(),
  })
  const initialState = await snapshot()
  const mainUrlCount = (path: string) => mainUrls.filter(url => url.endsWith(`/${path}`)).length

  const form = await openComparisonRepository(page)
  await expect(form.getByRole('button', { name: '加载对照' })).toBeDisabled()
  await form.getByRole('textbox', { name: '另一仓库' }).fill(crossRepositoryModelId)
  await form.getByRole('button', { name: '加载对照' }).click()
  await expect(form).toHaveCount(0)
  const comparison = comparisonPanel(page)
  const rightTitle = `${crossRepositoryModelId} · tokenizer.json`
  const right = comparison.getByRole('region', { name: rightTitle })
  await expect(right.getByRole('heading', { name: rightTitle })).toBeVisible()
  await expect(comparison.getByText('第一处不同：index 0，主 3，对照 4')).toBeVisible()
  await expect(tokenTable(comparison.getByRole('region', { name: '主侧' }))).toBeVisible()
  await expect(tokenTable(right)).toBeVisible()
  await comparison.getByRole('group', { name: '差集侧' }).getByRole('button', { name: '仅对照' }).click()
  await comparison.getByRole('textbox', { name: '搜索 token piece' }).fill('alt')
  await expect(comparison.getByText('显示 1 条，最多 1,000 条')).toBeVisible()
  await expect(comparison.locator('.tkp-vocabulary-list')).toHaveText('alt-token')

  await openPlaygroundMode(page, 'Chat 对话')
  await expect(tokenizerText(page)).toContainText('system=You are a concise assistant.')
  await expect(right.getByRole('combobox', { name: 'Chat Template' })).toHaveValue('jinjaFile:default')
  await expect(comparison).toContainText('对照 9')

  await openPlaygroundMode(page, 'Token IDs')
  await page.getByRole('textbox', { name: 'Token IDs' }).fill('[1,3,2]')
  await expect(comparison).toContainText('ID 序列相同')
  await expect(tokenRows(comparison.getByRole('region', { name: '主侧' })).nth(1)).toHaveAttribute('aria-label', /Piece hello，/)
  await expect(tokenRows(right).nth(1)).toHaveAttribute('aria-label', /Piece world，/)

  // A repository without a tokenizer fails inside the comparison only.
  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await loadComparisonRepository(page, 'fixture/empty')
  await expect(comparison.getByRole('status')).toHaveText(/对方仓库没有可用 tokenizer 入口。/)
  await expect(comparison.getByRole('region', { name: '主侧' })).toHaveCount(0)
  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await expect(tokenizerText(page, '解码文本')).toContainText('hello')

  await loadComparisonRepository(page, crossRepositoryModelId)
  await expect(tokenTable(right)).toBeVisible()

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await expect(comparison).toHaveCount(0)
  await openPlaygroundMode(page, '原始文本')
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello worlds，/ })).toBeVisible()
  expect(await snapshot()).toEqual(initialState)

  for (const path of ['config.json', 'generation_config.json', 'tokenizer_config.json', 'tokenizer.json', 'chat_template.jinja']) {
    expect(mainUrlCount(path)).toBe(1)
  }
  expect(externalUrls.filter(url => url.includes('/api/models/'))).toEqual([
    `/api/models/${crossRepositoryModelId}`,
    `/api/models/${crossRepositoryModelId}`,
  ])
  // Two explicit loads, each reading only the root tokenizer entry and its companions once.
  expect(externalUrls.filter(url => url.includes('/resolve/')).toSorted()).toEqual([
    `/${crossRepositoryModelId}/resolve/${crossRepositoryRevision}/chat_template.jinja`,
    `/${crossRepositoryModelId}/resolve/${crossRepositoryRevision}/chat_template.jinja`,
    `/${crossRepositoryModelId}/resolve/${crossRepositoryRevision}/tokenizer.json`,
    `/${crossRepositoryModelId}/resolve/${crossRepositoryRevision}/tokenizer.json`,
    `/${crossRepositoryModelId}/resolve/${crossRepositoryRevision}/tokenizer_config.json`,
    `/${crossRepositoryModelId}/resolve/${crossRepositoryRevision}/tokenizer_config.json`,
  ])
  expect(externalUrls.some(url => /\/(model\.safetensors|model\.gguf)$/.test(url))).toBe(false)
  expect(errors).toEqual([])
})

test('keeps the latest explicit comparison repository after a delayed manifest', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Latest-only timing evidence is recorded once in Chromium.')
  const errors = collectErrors(page)
  await installFixtureRoutes(page, {
    includeComparisonTokenizers: true,
    manifestDelayForModel: { modelId: 'fixture/slow-cross', delayMs: 500 },
  })
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await openPerspective(page, '试验台')

  // While the slow manifest is pending, replacing the source (close, then load another) must win.
  await loadComparisonRepository(page, 'fixture/slow-cross')
  const comparison = comparisonPanel(page)
  await expect(comparison.getByText('正在加载对照 tokenizer…')).toBeVisible()
  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await loadComparisonRepository(page, crossRepositoryModelId)
  await delay(650)
  await expect(comparison.getByRole('heading', { name: `${crossRepositoryModelId} · tokenizer.json` })).toBeVisible()
  await expect(comparison.getByText(/fixture\/slow-cross/)).toHaveCount(0)
  await expect(errors).toEqual([])
})

test('loads a second local comparison directory without external requests', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Directory picker behavior is covered once in Chromium.')
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, { includeComparisonTokenizers: true })
  const localFixture = testInfo.outputPath('comparison-local-fixture')
  await writeComparisonFixtureDirectory(localFixture)
  const noTokenizerFixture = testInfo.outputPath('comparison-local-no-tokenizer-fixture')
  await writeNoTokenizerFixtureDirectory(noTokenizerFixture)
  await openFixture(page, 18)
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello worlds，/ })).toBeVisible()

  const badge = page.getByRole('button', { name: '查看仓库一致性报告' })
  await expect(badge).toHaveAttribute('data-consistency-state', 'warnings')
  const externalRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname !== '127.0.0.1') externalRequests.push(request.url())
  })
  const snapshot = async () => ({
    url: page.url(),
    historyLength: await page.evaluate(() => history.length),
    repositoryInput: await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).inputValue(),
    status: await page.locator('.repository-status').innerText(),
    localStorageHistory: await page.evaluate(() => localStorage.getItem('model-files.repository-history')),
    consistencyState: await badge.getAttribute('data-consistency-state'),
    consistencyExpanded: await badge.getAttribute('aria-expanded'),
    consistencyLabel: await badge.innerText(),
  })
  const initialState = await snapshot()
  const comparison = comparisonPanel(page)
  const localRight = comparison.getByRole('region', { name: 'comparison-local-fixture · tokenizer.json' })

  await loadComparisonRepository(page, crossRepositoryModelId)
  await expect(comparison.getByRole('heading', { name: `${crossRepositoryModelId} · tokenizer.json` })).toBeVisible()
  await expect(comparison.getByText('第一处不同：index 0，主 3，对照 4')).toBeVisible()
  externalRequests.length = 0
  // Cancelling the directory picker changes nothing.
  await comparison.getByRole('button', { name: '关闭对照' }).click()
  const form = await openComparisonRepository(page)
  const picker = form.getByLabel('选择第二个本地目录')
  await expect(picker).toBeAttached()
  await picker.dispatchEvent('change')
  await expect(form).toBeVisible()
  await expect(comparison).toHaveCount(0)
  await picker.setInputFiles(localFixture)

  await expect(localRight.getByRole('heading', { name: 'comparison-local-fixture · tokenizer.json' })).toBeVisible()
  await expect(comparison.getByText('第一处不同：index 0，主 3，对照 4')).toBeVisible()
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
  await expect(tokenTable(comparison.getByRole('region', { name: '主侧' }))).toBeVisible()
  await expect(tokenTable(localRight)).toBeVisible()
  await comparison.getByRole('group', { name: '差集侧' }).getByRole('button', { name: '仅对照' }).click()
  await comparison.getByRole('textbox', { name: '搜索 token piece' }).fill('alt')
  await expect(comparison.getByText('显示 1 条，最多 1,000 条')).toBeVisible()
  await expect(comparison.locator('.tkp-vocabulary-list')).toHaveText('alt-token')

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await (await openComparisonRepository(page)).getByLabel('选择第二个本地目录').setInputFiles(noTokenizerFixture)
  await expect(comparison.getByRole('status')).toHaveText(/对方仓库没有可用 tokenizer 入口。/)
  await expect(comparison.getByRole('region', { name: '主侧' })).toHaveCount(0)
  await expect(tokenizerText(page)).toHaveText('hello worlds')
  expect(externalRequests).toEqual([])

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await (await openComparisonRepository(page)).getByLabel('选择第二个本地目录').setInputFiles(localFixture)
  await openPlaygroundMode(page, 'Chat 对话')
  await expect(tokenizerText(page)).toContainText('system=You are a concise assistant.')
  await expect(localRight.getByRole('combobox', { name: 'Chat Template' })).toHaveValue('jinjaFile:default')
  await expect(comparison).toContainText('对照 9')

  await openPlaygroundMode(page, 'Token IDs')
  await page.getByRole('textbox', { name: 'Token IDs' }).fill('[1,3,2]')
  await expect(comparison).toContainText('ID 序列相同')
  await expect(tokenRows(comparison.getByRole('region', { name: '主侧' })).nth(1)).toHaveAttribute('aria-label', /Piece hello，/)
  await expect(tokenRows(localRight).nth(1)).toHaveAttribute('aria-label', /Piece world，/)

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await expect(comparison).toHaveCount(0)
  await expect(resultPanel(page)).toBeVisible()
  await (await openComparisonRepository(page)).getByLabel('选择第二个本地目录').setInputFiles(localFixture)
  await expect(tokenTable(comparison.getByRole('region', { name: '主侧' }))).toBeVisible()
  await expect(tokenTable(localRight)).toBeVisible()
  expect(await snapshot()).toEqual(initialState)

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await openComparison(page, 'tokenizer.json')
  await expect(comparison.getByRole('heading', { name: 'tokenizer.json', exact: true })).toBeVisible()
  await expect(comparison).toContainText('ID 序列相同')
  expect(externalRequests).toEqual([])
  await comparison.getByRole('button', { name: '关闭对照' }).click()

  expect(requests.filter(request => request.path.startsWith('alternate') || request.path === 'no-config/tokenizer.json'))
    .toEqual([])
  expect(externalRequests).toEqual([])
  expect(errors).toEqual([])
})

test('keeps a valid local comparison after a delayed remote manifest', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Latest-only timing evidence is recorded once in Chromium.')
  const errors = collectErrors(page)
  const localFixture = testInfo.outputPath('latest-local-fixture')
  await writeComparisonFixtureDirectory(localFixture)
  await installFixtureRoutes(page, {
    includeComparisonTokenizers: true,
    manifestDelayForModel: { modelId: 'fixture/slow-cross', delayMs: 500 },
  })
  await openFixture(page, 18)
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await openPerspective(page, '试验台')
  await loadComparisonRepository(page, 'fixture/slow-cross')
  const comparison = comparisonPanel(page)
  await expect(comparison.getByText('正在加载对照 tokenizer…')).toBeVisible()
  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await (await openComparisonRepository(page)).getByLabel('选择第二个本地目录').setInputFiles(localFixture)
  const right = comparison.getByRole('region', { name: 'latest-local-fixture · tokenizer.json' })
  await expect(right).toBeVisible()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
  await delay(650)
  await expect(right).toBeVisible()
  await expect(tokenRows(right)).toHaveCount(3)
  await expect(comparison.getByText(/fixture\/slow-cross/)).toHaveCount(0)
  await expect(errors).toEqual([])
})

test('keeps comparison controls reachable without overflow at product viewports', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Responsive evidence is recorded once in Chromium.')
  const errors = collectErrors(page)
  await installFixtureRoutes(page, { includeComparisonTokenizers: true })
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
    const rootTokenizer = page.getByRole('button', { name: /^tokenizer\.json/ })
    await page.getByRole('button', { name: '打开', exact: true }).click()
    await expect(rootTokenizer).toBeVisible()
    await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
    await openPlaygroundMode(page, '原始文本')
    await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
    await openComparison(page, 'alternate/tokenizer.json')
    const comparison = comparisonPanel(page)
    const summary = comparison.getByText('第一处不同：index 0，主 3，对照 4')
    const diff = comparison.getByRole('heading', { name: '词表差集' })
    await expect(summary).toBeVisible()
    await expect(comparison.getByText('共有 6')).toBeVisible()
    await summary.scrollIntoViewIfNeeded()
    await expect(summary).toBeInViewport()
    await diff.scrollIntoViewIfNeeded()
    await expect(diff).toBeInViewport()
    await expect(tokenTable(comparison.getByRole('region', { name: '主侧' }))).toBeVisible()
    await expect(tokenTable(comparison.getByRole('region', { name: 'alternate/tokenizer.json' }))).toBeVisible()
    const close = comparison.getByRole('button', { name: '关闭对照' })
    await close.scrollIntoViewIfNeeded()
    await expect(close).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (testInfo.project.name === 'chromium') {
      const screenshot = testInfo.outputPath(`comparison-${viewport.width}x${viewport.height}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach(`${viewport.width}x${viewport.height}`, { path: screenshot, contentType: 'image/png' })
    }
    await close.click()
    // The portalled menu and popover stay inside the viewport.
    const menuButton = page.getByRole('button', { name: '对照', exact: true })
    await menuButton.scrollIntoViewIfNeeded()
    await menuButton.click()
    await expect(page.getByRole('menu', { name: '对照' })).toBeInViewport({ ratio: 1 })
    await page.getByRole('menuitem', { name: '选择另一仓库…' }).click()
    const form = page.getByRole('form', { name: '另一仓库' })
    const comparisonInput = form.getByRole('textbox', { name: '另一仓库' })
    const comparisonLoadButton = form.getByRole('button', { name: '加载对照' })
    await expect(comparisonInput).toBeVisible()
    await expect(comparisonLoadButton).toBeVisible()
    await expect(comparisonInput).toBeInViewport()
    await expect(comparisonLoadButton).toBeInViewport()
    await expect(form).toBeInViewport({ ratio: 1 })
    await expect(form.getByText('选择第二个本地目录')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect(errors).toEqual([])
})

test('renders CR and LF as visible single-line tokens', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /tokenizer\.json/ }).click()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello\r\nworlds')
  await expect.poll(() => tokenizerText(page).evaluate(element => element.textContent)).toMatch(/^hello\r?\nworlds$/)
  const whitespace = resultPanel(page).getByRole('checkbox', { name: '显示空白符' })
  for (const shown of [false, true]) {
    await whitespace.setChecked(shown)
    await expect(tokenRows(page).first()).toBeVisible()
    const cells = await tokenRows(page).getByRole('cell').allTextContents()
    const segments = await resultPanel(page).locator('.tkp-segment').allTextContents()
    expect(cells.length).toBeGreaterThan(0)
    expect(segments.length).toBeGreaterThan(0)
    for (const text of [...cells, ...segments]) expect(text).not.toMatch(/[\r\n]/)
  }
  expect(errors).toEqual([])
})

test('runs official SentencePiece models through Raw IDs Chat comparison and recovery', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page, { includeSentencePieceTokenizers: true })
  await openFixture(page, 20)

  const firstResultStarted = Date.now()
  await page.getByRole('button', { name: /^bpe\/tokenizer\.model/ }).click()
  // Native: a SentencePiece .model offers only 试验台.
  await expect(page.getByRole('group', { name: '阅读视图' }).getByRole('button')).toHaveText(['试验台'])
  await openPlaygroundMode(page, '原始文本')
  const rawInput = page.getByRole('textbox', { name: '原始文本' })
  await rawInput.fill('Hello world.')
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('6', { timeout: 10_000 })
  const firstResultMs = Date.now() - firstResultStarted
  const rows = tokenRows(page)
  await expect(rows).toHaveCount(6)
  await expect(rows.nth(0).getByRole('cell').nth(1)).toHaveText('285')
  await expect(rows.nth(0).getByRole('cell').nth(2)).toContainText('▁He')
  await expect(rows.nth(5).getByRole('cell').nth(2)).toContainText('.')
  const stream = resultPanel(page).locator('.tkp-stream-content')
  await expect(stream).toHaveText('Hello world.')

  await openPlaygroundMode(page, 'Token IDs')
  await page.getByRole('textbox', { name: 'Token IDs' }).fill('[285,35,934,178,54,951]')
  await expect(tokenizerText(page, '解码文本')).toHaveText('Hello world.')
  await expect(tokenTable(page)).toHaveAttribute('aria-label', 'Token 表，共 6 行')

  await openPlaygroundMode(page, 'Chat 对话')
  await expect(tokenizerText(page)).toHaveText('SP-JINJA You are a concise assistant.')
  await expect(rows.first()).toBeVisible()
  await expect(stream).toHaveText('SP-JINJA You are a concise assistant.')

  const dualSessionStarted = Date.now()
  await openComparison(page, 'unigram/tokenizer.model')
  await openPlaygroundMode(page, '原始文本')
  await rawInput.fill('I saw a girl with a telescope.')
  const comparison = comparisonPanel(page)
  await expect(comparison).toContainText('主 14对照 14', { timeout: 10_000 })
  const dualSessionFirstComparisonMs = Date.now() - dualSessionStarted
  await expect(comparison).toContainText('ID 序列不同', { timeout: 10_000 })
  await expect(comparison.getByText('第一处不同：index 0，主 16，对照 9')).toBeVisible({ timeout: 10_000 })
  await expect(comparison.getByRole('heading', { name: '词表差集' })).toBeVisible()
  await expect(comparison).toContainText('SentencePiece 不提供可解析的 tokenizer.json 词表；编码对照仍可用。')
  await expect(comparison.getByRole('textbox', { name: '搜索 token piece' })).toHaveCount(0)

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await openComparison(page, 'invalid-config/tokenizer.model')
  await expect(comparison.getByRole('status')).toBeVisible({ timeout: 10_000 })
  await expect(comparison.getByRole('status')).toHaveText(/\S/)
  await expect(comparison.getByText('正在加载对照 tokenizer…')).toHaveCount(0)
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('14')
  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await expect(resultPanel(page)).toBeVisible()
  await openComparison(page, 'bpe/tokenizer.model')
  await rawInput.fill('Hello world.')
  await expect(comparison).toContainText('ID 序列相同', { timeout: 10_000 })
  await comparison.getByRole('button', { name: '关闭对照' }).click()

  await page.getByRole('button', { name: /^unigram\/tokenizer\.model/ }).click()
  await expect(page.getByRole('group', { name: '阅读视图' }).getByRole('button')).toHaveText(['试验台'])
  // No chat template beside the unigram model: Chat falls back to 原始文本 and stays disabled.
  const modes = page.getByRole('group', { name: '输入模式' })
  await expect(modes.getByRole('button', { name: '原始文本' })).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 })
  await expect(modes.getByRole('button', { name: 'Chat 对话' })).toBeDisabled()
  await rawInput.fill('I saw a girl with a telescope.')
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('14', { timeout: 10_000 })
  await expect(stream).toHaveText('I saw a girl with a telescope.')
  await openPlaygroundMode(page, 'Token IDs')
  await page.getByRole('textbox', { name: 'Token IDs' })
    .fill('[9,459,11,939,44,11,4,142,82,8,28,21,132,6]')
  await expect(tokenizerText(page, '解码文本')).toHaveText('I saw a girl with a telescope.')
  await expect(tokenTable(page)).toHaveAttribute('aria-label', 'Token 表，共 14 行')
  await expect(modes.getByRole('button', { name: 'Chat 对话' })).toBeDisabled()

  const modelRequestCountBeforeOversize = requests.filter(request => request.path.endsWith('/tokenizer.model')).length
  await page.getByRole('button', { name: /^oversized\/tokenizer\.model/ }).click()
  const failure = resultPanel(page).getByRole('status')
  await expect(failure).toContainText('oversized/tokenizer.model 大小为 33.6 MB，超过分词器单文件上限 33.6 MB。', { timeout: 10_000 })
  await failure.getByRole('button', { name: '重试' }).click()
  await expect(failure).toContainText('oversized/tokenizer.model 大小为 33.6 MB，超过分词器单文件上限 33.6 MB。', { timeout: 10_000 })
  expect(requests.filter(request => request.path.endsWith('/tokenizer.model')))
    .toHaveLength(modelRequestCountBeforeOversize)
  expect(requests.filter(request => request.path === 'oversized/tokenizer.model')).toHaveLength(0)

  for (const path of ['bpe/tokenizer.model', 'bpe/tokenizer_config.json', 'bpe/chat_template.jinja']) {
    expect(requests.filter(request => request.path === path)).toHaveLength(1)
  }
  if (testInfo.project.name === 'chromium') {
    await testInfo.attach('sentencepiece-perf.json', {
      body: Buffer.from(JSON.stringify({ firstResultMs, dualSessionFirstComparisonMs }, null, 2)),
      contentType: 'application/json',
    })
    console.log(`PERF sentencepiece firstResultMs=${firstResultMs} dualSessionFirstComparisonMs=${dualSessionFirstComparisonMs}`)
  }
  expect(errors).toEqual([])
})

test('cancels a delayed SentencePiece load and keeps only the latest tokenizer session', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Shared Worker cancellation timing is covered once in Chromium.')
  const errors = collectErrors(page)
  await installFixtureRoutes(page, {
    includeSentencePieceTokenizers: true,
    delayedContentModelId: fixtureModelId,
    contentDelayMs: 250,
    delayedContentPath: 'bpe/tokenizer.model',
  })
  await openFixture(page, 20)
  const bpeRequest = page.waitForRequest(request => request.url().endsWith('/bpe/tokenizer.model'))
  await page.getByRole('button', { name: /^bpe\/tokenizer\.model/ }).click()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('Hello world.')
  await bpeRequest

  await page.getByRole('button', { name: /^unigram\/tokenizer\.model/ }).click()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('I saw a girl with a telescope.')
  await delay(350)
  const stream = resultPanel(page).locator('.tkp-stream-content')
  await expect(stream).toHaveText('I saw a girl with a telescope.', { timeout: 10_000 })
  await expect(tokenizerMetric(page, 'Token 数量')).toHaveText('14')
  await expect(resultPanel(page)).toContainText('unigram/tokenizer.model ·')
  await expect(resultPanel(page).getByText('Hello world.')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('opens every supported local directory reader without network upload', { timeout: 60_000 }, async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const externalRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname !== '127.0.0.1') externalRequests.push(request.url())
  })
  // D-7: the README's third-party HTTPS image is a GET, as native loads it; served locally, never the network.
  await page.route('https://example.com/**', route => route.fulfill({
    status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
  }))
  const localFixture = testInfo.outputPath('complete-local-fixture')
  await writeFixtureDirectory(localFixture)
  await setLaunchInput(page)
  await page.goto('/')
  const picker = page.getByLabel('选择文件夹')
  await picker.setInputFiles(localFixture)

  await expectRepository(page, '本地 · 实时目录', 23)
  await expect(page).toHaveURL(`http://127.0.0.1:${process.env.E2E_PORT ?? 5173}/`)
  await expect(page.getByRole('button', { name: '在源站打开' })).toBeDisabled()
  await expect(page.getByRole('heading', { name: 'FixtureModel' })).toBeVisible()

  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.getByRole('heading', { name: 'Fixture Model' })).toBeVisible()
  await page.getByRole('button', { name: /^vocab\.json/ }).click()
  await expect(page.getByText('共 10,005 个 token；列表最多展示当前筛选结果的前 1,000 项。')).toBeVisible()
  await expect(page.getByRole('table', { name: '词表' }).locator('tbody tr')).toHaveCount(1000)
  await page.getByRole('button', { name: /^merges\.txt/ }).click()
  await expect(page.locator('.source-reader.plain-text')).toBeVisible()
  expect(await page.locator('.source-reader').evaluate(element => element.textContent?.endsWith('token-100001 token-100002'))).toBe(true)
  await page.getByRole('button', { name: /^model\.safetensors\.index\.json/ }).click()
  await expect(page.getByText('分片数量').locator('..')).toContainText('2')
  await page.getByRole('button', { name: /^imatrix-fixture\.dat/ }).click()
  await expect(page.locator('.wt-fact-grid')).toContainText('条目数2')
  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await page.getByText('Chat Template 试验台').click()
  // Native prefills string special tokens from the config; the embedded playground renders live.
  await expect(page.getByLabel('变量名')).toHaveValue('unk_token')
  await expect(page.getByLabel('原始输出 · 权威')).toHaveText('You are a helpful assistant.')

  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await expect(page.locator('.key-value-row').filter({ hasText: '模型类型' })).toContainText('WordPiece')
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
  await expect(resultPanel(page).getByRole('button', { name: /文本 hello worlds，/ })).toBeVisible()
  await expect(resultPanel(page)).toContainText('tokenizer.json · Exact')

  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByText(/^只读取了 .+ JSON Header；没有请求 tensor 数据。$/)).toBeVisible()
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.gguf/ }).click()

  await picker.setInputFiles(localFixture)
  await expect(page.getByRole('heading', { name: 'FixtureModel' })).toBeVisible()
  expect(externalRequests).toEqual(['https://example.com/tracker.png'])
  expect(errors).toEqual([])
})

test('dispatches local Python and PDF readers safely', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const localFixture = testInfo.outputPath("reader-local-fixture")
  await writeFixtureDirectory(localFixture)
  await setLaunchInput(page)
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
  await page.getByLabel('选择文件夹').setInputFiles(localFixture)

  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain('frame-src blob:')
  expect(csp).toContain("img-src 'self' data: blob: https:;")

  await page.getByRole('button', { name: /^reader\.py/ }).click()
  const sourceReader = page.locator('.source-reader')
  await expect(sourceReader).toHaveAttribute('data-language', 'python')
  expect(await sourceReader.textContent()).toBe(pythonReaderSource)
  await expect(sourceReader).toHaveAttribute('data-highlighted', 'true')
  await expect(sourceReader.locator('.token.keyword').filter({ hasText: /^def$/ })).toHaveText('def')
  await expect(sourceReader.locator('.token.function')).toHaveText('greet')
  // Native: code under 128 KB is highlighted only in 概览; 原文 is the plain-text reader.
  await page.getByRole('button', { name: '原文', exact: true }).click()
  await expect(page.locator('.source-reader.plain-text')).toHaveAttribute('data-highlighted', 'false')
  await page.getByRole('button', { name: '概览', exact: true }).click()

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
  expect(blobUrl.startsWith(`blob:http://127.0.0.1:${process.env.E2E_PORT ?? 5173}/`)).toBe(true)
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
  await expect(binaryError.locator('..')).toContainText('该文件没有专用阅读器，且内容不是可安全显示的 UTF-8 文本。')
  await expect(page.locator('.source-reader')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('folds Python YAML and JSON while preserving the full source', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const localFixture = testInfo.outputPath('folding-local-fixture')
  await writeFixtureDirectory(localFixture)
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(localFixture)

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
  // Native rule: code over 128 KB is the plain-text reader.
  await expect(page.locator('.source-reader.plain-text')).toBeVisible()
  expect(errors).toEqual([])
})

test('source find navigates matches and reveals collapsed ancestors', async ({ page }, testInfo) => {
  const localFixture = testInfo.outputPath('source-find-local-fixture')
  await writeFixtureDirectory(localFixture)
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(localFixture)
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
  await expect(search.getByText('3', { exact: true })).toBeVisible()
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

  await search.getByRole('button', { name: '查找文本出现的下一个位置' }).click()
  await expect(current).toHaveText('NEEDLE')
  await search.getByRole('button', { name: '查找文本出现的上一个位置' }).click()
  await expect(current).toHaveText('needle')
  await expect(search.getByText('3', { exact: true })).toBeVisible()

  await searchInput.fill('中文')
  await expect(search.getByText('2', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark.find-match')).toHaveCount(2)
  await searchInput.fill('🚩')
  await expect(search.getByText('1', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark.find-match')).toHaveCount(1)
  await searchInput.fill('missing-query')
  await expect(search.getByText('0', { exact: true })).toBeVisible()
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
  await expect(search.getByText('1', { exact: true })).toBeVisible()
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
  await expect(search.getByText('1', { exact: true })).toBeVisible()
  await expect(page.locator('.source-reader mark.find-match')).toHaveCount(1)
  await page.getByRole('button', { name: '渲染' }).click()
  await expect(search).toBeHidden()

  await page.getByRole('button', { name: /^merges\.txt/ }).click()
  const plain = page.locator('.source-reader.plain-text')
  await expect(plain).toBeVisible({ timeout: 3_000 })
  await plain.focus()
  await page.keyboard.press('Meta+F')
  search = page.getByRole('search', { name: '当前文件查找' })
  searchInput = search.getByRole('textbox', { name: '当前文件查找' })
  const query = 'token-100001 token-100002'
  const findStarted = Date.now()
  await searchInput.fill(query)
  await expect(search.getByText('1', { exact: true })).toBeVisible({ timeout: 3_000 })
  expect(Date.now() - findStarted).toBeLessThan(3_000)
  const currentMark = plain.locator('mark.current')
  await expect(currentMark).toHaveText(query)
  await expect(currentMark).toHaveAttribute('aria-current', 'true')
  await expect(currentMark).toBeInViewport()
  await expect(currentMark.locator('xpath=ancestor::*[@data-line][1]')).toHaveAttribute('data-line', '100002')
  await searchInput.press('Escape')
  await expect(search).toBeHidden()
  expect(errors).toEqual([])
})

test('finds the tail of an almost 32 MiB progressive text within budget', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The near-cap text find gate is recorded once in Chromium.')
  const errors = collectErrors(page)
  const externalRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url())
  })
  const localFixture = testInfo.outputPath('performance-find-fixture')
  const exactBytes = await writePerformanceFindFixture(localFixture)
  const loadStarted = Date.now()
  await setLaunchInput(page)
  await page.goto('/')
  const picker = page.getByLabel('选择文件夹')
  await picker.setInputFiles(localFixture)

  const reader = page.locator('.source-reader.plain-text')
  await expect(reader).toBeVisible({ timeout: 10_000 })
  const loadMs = Date.now() - loadStarted
  expect(loadMs).toBeLessThan(10_000)
  expect(exactBytes).toBe(32 * 1024 * 1024 - 1)

  await reader.focus()
  const findStarted = Date.now()
  await page.keyboard.press('Meta+F')
  const searchInput = page.getByRole('textbox', { name: '当前文件查找' })
  await searchInput.fill('PERF_TAIL_NEEDLE')
  await expect(page.locator('.source-find .find-count')).toHaveText('1', { timeout: 3_000 })
  const findMs = Date.now() - findStarted
  expect(findMs).toBeLessThan(3_000)

  const currentMark = reader.locator('mark.current')
  await expect(currentMark).toHaveText('PERF_TAIL_NEEDLE')
  await expect(currentMark).toHaveAttribute('aria-current', 'true')
  await expect(currentMark).toBeInViewport()
  const hitLineNumber = Number(await currentMark.locator('xpath=ancestor::*[@data-line][1]').getAttribute('data-line'))
  expect(hitLineNumber).toBeGreaterThan(1001)

  const evidence = { exactBytes, loadMs, findMs, hitLineNumber, consoleErrorsAndWarnings: errors, externalRequests }
  await testInfo.attach('performance-find.json', {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json',
  })
  console.log(`PERF almost-32m-find exactBytes=${exactBytes} loadMs=${loadMs} findMs=${findMs} hitLineNumber=${hitLineNumber}`)
  expect(errors).toEqual([])
  expect(externalRequests).toEqual([])
})

test('Jinja source find preserves query while editing and resets on file switch', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)

  await page.getByRole('button', { name: /^chat_template\.jinja/ }).click()
  await openPerspective(page, '源码')
  const jinjaSource = page.getByLabel('Jinja 源码')
  await jinjaSource.focus()
  await page.keyboard.press('Meta+F')
  const search = page.getByRole('search', { name: '当前文件查找' })
  const searchInput = search.getByRole('textbox', { name: '当前文件查找' })
  await searchInput.fill('thinking')
  await expect(search.getByText('2', { exact: true })).toBeVisible()
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
  await expect(search.getByText('2', { exact: true })).toBeVisible()
  const secondMatchStart = await jinjaSource.evaluate(element =>
    (element as HTMLTextAreaElement).value.lastIndexOf('thinking'))
  expect(await jinjaSource.evaluate(element => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }))).toEqual({ start: secondMatchStart, end: secondMatchStart + 'thinking'.length })

  await searchInput.press('Shift+Enter')
  await expect(search.getByText('2', { exact: true })).toBeVisible()
  expect(await jinjaSource.evaluate(element => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }))).toEqual({ start: firstMatchStart, end: firstMatchStart + 'thinking'.length })

  const originalSource = await jinjaSource.inputValue()
  await jinjaSource.fill(`${originalSource}\nthinking`)
  await expect(searchInput).toHaveValue('thinking')
  await expect(search.getByText('3', { exact: true })).toBeVisible()
  await expect(page.locator('.jinja-highlight mark.find-match')).toHaveCount(3)
  // Typing with the find bar open keeps the caret where the user typed (native NSTextView find bar).
  expect(await jinjaSource.evaluate(element => {
    const source = element as HTMLTextAreaElement
    return source.selectionStart === source.value.length && source.selectionEnd === source.value.length
  })).toBe(true)

  await page.getByRole('button', { name: /^config\.json/ }).click()
  await expect(search).toBeHidden()
  await page.getByRole('button', { name: /^chat_template\.jinja/ }).click()
  await openPerspective(page, '源码')
  await expect(search).toBeHidden()
  await expect(page.locator('.jinja-highlight mark')).toHaveCount(0)
  await jinjaSource.focus()
  await page.keyboard.press('Meta+F')
  await expect(searchInput).toHaveValue('')
  await searchInput.press('Escape')
  expect(errors).toEqual([])
})

test('config diagnostics point at their line and the full source stays reachable', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  // vocab_size sits on line 61, END_OF_CONFIG on line 92; the body keeps the manifest's 144 bytes.
  const content = ('{' + '\n'.repeat(60) + '"vocab_size":1005,' + '\n'.repeat(31) + '"last_field":"END_OF_CONFIG"}').padEnd(144)
  await page.route('**/resolve/**/config.json', route => route.fulfill({
    contentType: 'application/json', body: content,
  }))
  await openFixture(page)
  const problems = page.getByRole('region', { name: '文件问题' })
  await expect(problems.getByRole('button')).toHaveCount(1)
  await expect(problems).toContainText('词表大小不一致')
  await expect(problems).toContainText('第 61 行')
  await expect(page.getByRole('button', { name: /^config\.json/ }).locator('.file-problems')).toContainText('1 个问题')
  await expect(page.getByRole('button', { name: /^generation_config\.json/ }).locator('.file-problems')).toContainText('1 个问题')
  // Native anchors tokenizer_config.json findings too; it opens in the JSON reader with its problem list.
  await expect(page.getByRole('button', { name: /^tokenizer_config\.json/ }).locator('.file-problems')).toHaveCount(1)

  await problems.getByRole('button').click()
  await expect(page.getByRole('button', { name: '原文', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(problems.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  await expect(problems.getByRole('button')).toHaveAttribute('title', /≠ tokenizer\.vocab_count 6/)
  const line = page.locator('.source-line[data-line="61"]')
  // Native CodeReaderView tints only the line's text; the note lives in the problem list and inspector.
  await expect(line.locator('.line-text')).toHaveAttribute('data-severity', 'warning')
  await expect(line.locator('.line-text')).toHaveClass(/flash/)
  await expect(line).toBeInViewport()
  await expect(page.getByRole('complementary', { name: '检查器' })).toContainText('词表大小不一致')

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const source = page.locator('.source-reader')
    await source.hover()
    await expect(async () => {
      await page.mouse.wheel(0, 10000)
      await expect(page.locator('.source-line[data-line="92"]')).toBeInViewport({ timeout: 200 })
    }).toPass()
  }
  expect(errors).toEqual([])
})

test('a far diagnostic jumps its line to the upper third of the reader', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const directory = testInfo.outputPath('far-diagnostic')
  await writeFixtureDirectory(directory)
  await writeFile(join(directory, 'config.json'), '{' + '\n'.repeat(900) + '"vocab_size":1005,' + '\n'.repeat(900) + '"model_type":"fixture"}')
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  const problems = page.getByRole('region', { name: '文件问题' })
  await expect(problems).toContainText('第 901 行')
  await problems.getByRole('button').click()
  const line = page.locator('.source-line[data-line="901"]')
  await expect(line).toBeInViewport()
  await expect(async () => {
    const ratio = await line.evaluate(element => {
      const pre = element.closest('pre')!
      return (element.getBoundingClientRect().top - pre.getBoundingClientRect().top) / pre.clientHeight
    })
    expect(ratio).toBeGreaterThan(0.25)
    expect(ratio).toBeLessThan(0.42)
  }).toPass({ timeout: 2_000 })
  expect(errors).toEqual([])
})

test('reads semantic JSON, progressive text, and safe Markdown views', async ({ page }) => {
  const errors = collectErrors(page)
  const thirdPartyRequests: string[] = []
  await installFixtureRoutes(page)
  // D-7: third-party HTTPS images load as native does (served locally here; no real network).
  // Registered after the fixture routes so it takes precedence over their default.
  await page.route('https://example.com/**', route => {
    thirdPartyRequests.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') })
  })
  await openFixture(page)

  await expect(page.getByRole('heading', { name: 'FixtureModel' })).toBeVisible()
  await expect(page.getByText('fixture · 2 layers', { exact: true })).toBeVisible()
  await expect(page.getByText('隐藏层维度（hidden_size）').locator('..')).toContainText('8')
  await expect(page.getByText('最大上下文长度（max_position_embeddings）').locator('..')).toContainText('4096')
  await page.getByRole('button', { name: '全部字段' }).click()
  await expect(page.locator('.source-reader')).toContainText('"hidden_size": 8')
  await page.getByRole('button', { name: '原文' }).click()
  await expect(page.locator('.source-reader')).toContainText('"model_type":"fixture"')

  await page.getByRole('button', { name: /^generation_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: '生成默认值' })).toBeVisible()
  await expect(page.getByText('最大新 token').locator('..')).toContainText('64')
  await expect(page.getByText('Do sample').locator('..')).toContainText('false')

  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'BertTokenizer' })).toBeVisible()
  await expect(page.getByText('最大长度', { exact: true }).locator('..')).toContainText('128')
  await expect(page.getByText('UNK token').locator('..')).toContainText('[UNK]')

  await page.getByRole('button', { name: /^metadata\.json/ }).click()
  // No specialized summary: native 概览 is the formatted JSON reader.
  await expect(page.locator('.source-reader')).toContainText('"format": "fixture"')

  await page.getByRole('button', { name: /^vocab\.json/ }).click()
  await page.getByRole('button', { name: '概览' }).click()
  await page.getByRole('textbox', { name: '搜索 token 或 ID' }).fill('token-10004')
  await expect(page.getByRole('table', { name: '词表' }).locator('tbody tr')).toHaveCount(1)
  await expect(page.getByRole('row', { name: /token-10004.*10004/ })).toBeVisible()

  const largeTextStarted = Date.now()
  await page.getByRole('button', { name: /^merges\.txt/ }).click()
  await expect(page.locator('.source-reader.plain-text')).toBeVisible()
  expect(Date.now() - largeTextStarted).toBeLessThan(3000)

  await page.getByRole('button', { name: /^model\.safetensors\.index\.json/ }).click()
  await expect(page.getByRole('heading', { name: '权重分片索引' })).toBeVisible()
  await expect(page.getByText('分片数量').locator('..')).toContainText('2')

  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.getByRole('heading', { name: 'Fixture Model' })).toBeVisible()
  await expect(page.getByRole('table')).toContainText('Markdown')
  await expect(page.locator('.markdown-body script')).toHaveCount(0)
  // Native strips the <script> tag and keeps its text; nothing runs.
  await expect(page.locator('.markdown-body')).toContainText('window.__markdownExecuted = true')
  const image = page.locator('.markdown-body img[alt="Third-party image"]')
  await expect(image).toHaveAttribute('src', 'https://example.com/tracker.png')
  await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByRole('link', { name: 'Config' })).toHaveAttribute(
    'href',
    `https://huggingface.co/${fixtureModelId}/blob/${fixtureRevision}/config.json`,
  )
  await expect(page.getByText('Unsafe').locator('a')).toHaveCount(0)
  const theme = page.getByRole('group', { name: 'Markdown 排版主题' })
  await expect(theme.getByRole('button', { name: 'GitHub' })).toHaveAttribute('aria-pressed', 'true')
  await theme.getByRole('button', { name: '紧凑' }).click()
  await expect(page.locator('.markdown-body')).toHaveClass(/markdown-compact/)
  await page.getByRole('button', { name: '原文' }).click()
  await expect(page.locator('.source-reader')).toContainText('<script>window.__markdownExecuted = true</script>')
  expect(await page.evaluate('window.__markdownExecuted')).toBeUndefined()
  expect(thirdPartyRequests).toEqual(['https://example.com/tracker.png'])
  expect(errors).toEqual([])
})

test('parses bounded legacy Imatrix files and exposes searchable entry details', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /^imatrix-fixture\.dat/ }).click()

  await expect(page.getByText(/^读取了完整的 .+ legacy imatrix 文件；只解析，不执行。$/)).toBeVisible()
  await expect(page.locator('.wt-fact-grid')).toContainText('条目数2')
  await expect(page.locator('.wt-fact-grid')).toContainText('数据集calibration.txt')
  await openPerspective(page, 'Entries')
  await page.getByPlaceholder('筛选 tensor').fill('ffn')
  await expect(page.getByRole('table', { name: 'Entries' }).getByRole('row').nth(1)).toContainText('blk.0.ffn.weight')
  await expect(page.getByRole('table', { name: 'Entries' }).getByRole('row').nth(1).getByRole('cell').nth(1)).toHaveText('4')
  expect(requests.filter(request => request.path === 'imatrix-fixture.dat')).toEqual([
    expect.objectContaining({ range: null, status: 200 }),
  ])
  expect(errors).toEqual([])
})

test('Jinja workspace shares one temporary source across overview, source and live playground', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)

  await page.getByRole('button', { name: /^chat_template\.jinja/ }).click()
  await expect(page.getByRole('heading', { name: 'Jinja Chat Template' })).toBeVisible()
  const facts = page.locator('.inspection-facts')
  await expect(facts).toContainText('行数6应用推导')
  await expect(facts).toContainText('当前状态未修改运行结果')
  await page.getByRole('button', { name: '查看源码' }).click()
  const source = page.getByLabel('Jinja 源码')
  await expect(source).toHaveValue(/mode=\{\{ mode \}\}/)
  await expect(page.locator('.jinja-keyword').first()).toHaveText('for')
  await expect(page.locator('.jinja-delimiter').first()).toHaveText('{%')
  await expect(page.locator('.jinja-source-details')).toContainText('状态来源原文')
  await expect(page.getByRole('button', { name: '恢复来源原文' })).toBeDisabled()

  // Native TemplatePlaygroundView renders live after 220 ms; there is no render button.
  await openPerspective(page, '试验台')
  const raw = page.getByLabel('原始输出 · 权威')
  const status = page.getByRole('status')
  await expect(raw).toHaveText('system=You are a helpful assistant.;user=Hello!;thinking=true;mode=;assistant=')
  await expect(status).toContainText('实时预览')
  await expect(page.getByText('未识别可索引的消息边界')).toBeVisible()
  await expect(page.getByRole('button', { name: '渲染', exact: true })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'Tools' })).not.toBeChecked()

  await page.getByLabel('载入示例').selectOption('tools')
  await expect(page.getByRole('checkbox', { name: 'Tools' })).toBeChecked()
  await expect(raw).toContainText('tools=[{"type": "function", "function": {"name": "get_weather"')
  await page.getByRole('checkbox', { name: 'Tools' }).uncheck()
  await expect(raw).not.toContainText('tools=')

  await page.locator('.request-editor section').filter({ hasText: '其他变量' }).getByRole('button', { name: /添加/ }).click()
  const name = page.getByLabel('变量名').last()
  await expect(name).toHaveValue('custom_arg')
  await name.fill('mode')
  await page.getByLabel('值', { exact: true }).last().fill('tools')
  await expect(raw).toContainText(';mode=tools;')
  await name.fill('messages')
  await expect(page.getByRole('alert')).toHaveText('⚠︎ “messages”由专用编辑器管理。')
  await expect(status).toContainText('输入或模板有错误')
  await expect(page.locator('.pane-header').filter({ hasText: '渲染结果' })).toContainText('未生成')
  await expect(page.getByRole('button', { name: '复制原始输出' })).toBeDisabled()
  await name.fill('mode')

  const template = page.getByLabel('Jinja 模板')
  await template.fill('{% include "remote.jinja" %}')
  await expect(page.getByRole('alert')).toContainText('include')
  await page.getByRole('button', { name: '恢复原模板' }).click()
  await expect(raw).toContainText(';mode=tools;')

  // The playground edits the same temporary source the 源码 perspective shows.
  await template.fill('changed {{ mode }}')
  await expect(raw).toHaveText('changed tools')
  await openPerspective(page, '源码')
  await expect(source).toHaveValue('changed {{ mode }}')
  await expect(page.locator('.jinja-modified')).toHaveText('临时修改')
  await page.getByRole('button', { name: '恢复来源原文' }).click()
  await expect(source).toHaveValue(/mode=\{\{ mode \}\}/)
  await expect(page.locator('.jinja-modified')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Chat Template playground indexes message boundaries and inspects JSON content', async ({ page }) => {
  const errors = collectErrors(page)
  // Wide enough that the playground keeps its native side-by-side splits beside the sidebar and inspector.
  await page.setViewportSize({ width: 1600, height: 1000 })
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /^chat_template\.jinja/ }).click()
  await openPerspective(page, '试验台')
  await page.getByLabel('Jinja 模板').fill(
    '{% for m in messages %}<|message_{{ m.role }}|>{% if m.content is string %}<|content_text|>{{ m.content }}'
    + '{% else %}<|content_json|>{{ m.content | tojson }}{% endif %}<|end_message|>{% endfor %}<|message_model|>')
  await page.getByLabel('载入示例').selectOption('multimodal')
  const structure = page.getByRole('list', { name: '结构索引 · 只读' })
  await expect(structure.getByRole('button')).toHaveText(['USER', 'content_json', 'MODEL', 'generation prompt'])
  // The first item with a JSON payload is selected and parsed in the content inspector.
  await expect(structure.getByRole('button', { name: 'content_json' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.content-inspector')).toContainText('"type" : "image"')
  await expect(page.locator('.output-selected').first()).toHaveText('<|content_json|>')
  await expect(page.locator('.output-token').first()).toHaveText('<|message_user|>')
  await structure.getByRole('button', { name: 'USER' }).click()
  await expect(page.locator('.content-inspector')).toHaveCount(0)
  await expect(page.locator('.raw-output')).toContainText('软换行仅用于显示，不属于输出')

  // ⌘F inside the authoritative output marks matches there only.
  const raw = page.getByLabel('原始输出 · 权威')
  await raw.focus()
  await page.keyboard.press('ControlOrMeta+f')
  await page.getByRole('textbox', { name: '当前文件查找' }).fill('content_json')
  await expect(page.locator('.raw-output mark.find-match')).toHaveCount(1)
  await page.getByRole('textbox', { name: '当前文件查找' }).press('Escape')

  // The three native split views drag within native bounds: inputs 280–360, structure 190–280, preview ≥ 260.
  const width = (selector: string) => page.locator(selector).evaluate(element => element.getBoundingClientRect().width)
  const drag = async (selector: string, dx: number, dy: number) => {
    const box = (await page.locator(selector).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 4 })
    await page.mouse.up()
  }
  await drag('.playground-body > .resize-x', -40, 0)
  expect(await width('.playground-inputs')).toBe(350)
  await drag('.playground-body > .resize-x', -100, 0)
  expect(await width('.playground-inputs')).toBe(360)
  await drag('.playground-preview-split > .resize-x', 30, 0)
  expect(await width('.output-structure')).toBe(250)
  const previewHeight = await page.locator('.playground-preview').evaluate(element => element.getBoundingClientRect().height)
  await drag('.playground-main > .resize-y', 0, -40)
  // The even split starts at a fractional height; the drag lands on whole pixels.
  expect(Math.abs(await page.locator('.playground-preview').evaluate(element => element.getBoundingClientRect().height) - previewHeight - 40)).toBeLessThanOrEqual(1)
  expect(errors).toEqual([])
})

test('Chat Template playground follows the selection in long output and drops superseded renders', async ({ page }) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /^chat_template\.jinja/ }).click()
  await openPerspective(page, '试验台')
  const template = page.getByLabel('Jinja 模板')
  const raw = page.getByLabel('原始输出 · 权威')
  // A runaway render is terminated when a newer request arrives.
  await template.fill('{% for i in range(100000000) %}{% endfor %}slow')
  await expect(page.getByRole('status')).toContainText('渲染中')
  await template.fill('{% for i in range(300) %}line {{ i }}\n{% endfor %}<|message_user|><|content_json|>[1]<|end_message|>')
  await expect(page.getByRole('status')).toContainText('实时预览')
  // The selected content item sits at the end of 300 lines, so the output scrolls to it.
  await expect(page.getByRole('button', { name: 'content_json' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => raw.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'USER' }).click()
  await expect(raw).not.toContainText('slow')

  // The editor itself scrolls, so arrow keys keep the caret in view; the highlight layer mirrors its offset.
  await template.fill(Array.from({ length: 200 }, (_, index) => `{{ value_${index} }}`).join('\n'))
  await template.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(0, 0); element.scrollTop = 0 })
  for (let index = 0; index < 60; index += 1) await template.press('ArrowDown')
  const offsets = await page.locator('.playground-template .jinja-editor-layers').evaluate(element => ({
    area: element.querySelector('textarea')!.scrollTop, highlight: element.querySelector('pre')!.scrollTop,
  }))
  expect(offsets.area).toBeGreaterThan(0)
  expect(offsets.highlight).toBe(offsets.area)
  expect(errors).toEqual([])
})

test('fails closed when a source returns HTTP 200 for a range', async ({ page }) => {
  await installFixtureRoutes(page, { rangeBehavior: 'http200' })
  await openFixture(page)
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()

  await expect(page.getByRole('heading', { name: '无法读取文件' })).toBeVisible()
  await expect(page.getByText(/源站未确认 HTTP Range（状态码 200），已取消以避免下载完整权重。/)).toBeVisible()
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
  const report = page.getByRole('tabpanel', { name: '仓库一致性报告' })
  await expect(report).toBeVisible()
  await expect(report).toContainText('词表大小不一致')
  await expect(report).toContainText('EOS Token 不一致')
  await expect(report).toContainText('上下文长度声明不同')
  await expect(report.locator('[data-material]')).toHaveCount(8)
  // Native ConsistencyReportView: 身份 with origins beside Coverage (raw material names, status icons).
  await expect(report.getByRole('region', { name: '身份' }).locator('[data-identity-key]').first()).toContainText('文件内嵌')
  const coverage = report.getByRole('region', { name: 'Coverage' })
  await expect(coverage.locator('[data-material="generationConfig"]')).toContainText('generation_config')
  await expect(coverage.locator('[data-material="config"] [data-coverage-icon="checked"]')).toHaveCount(1)
  await expect(report.getByRole('img', { name: '警告' }).first()).toBeVisible()
  await expect(page.getByRole('region', { name: '文件问题' })).toContainText('上下文长度声明不同')
  const readerPerspective = page.locator('.detail-header').getByRole('group', { name: '阅读视图' })
  await expect(readerPerspective).toBeVisible()
  for (const button of ['概览', '全部字段', '原文']) {
    await expect(readerPerspective.getByRole('button', { name: button, exact: true })).toBeVisible()
  }
  await expect(page.getByRole('tab', { name: /^问题/ })).toBeFocused()
  await report.locator('[data-finding-id="eos-mismatch"]').click()
  await expect(report.locator('[data-finding-id="eos-mismatch"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('complementary', { name: '检查器' })).toContainText('EOS Token 不一致')
  await expect(page.getByRole('complementary', { name: '检查器' })).toContainText('文件内嵌')
  // Native never opens a closed inspector for a selection.
  await page.getByRole('button', { name: '显示或隐藏检查器' }).click()
  await report.locator('[data-finding-id="vocab-mismatch"]').click()
  await expect(page.getByRole('complementary', { name: '检查器' })).toHaveCount(0)
  await page.getByRole('button', { name: '显示或隐藏检查器' }).click()
  await expect(page.getByRole('complementary', { name: '检查器' })).toContainText('词表大小不一致')
  await report.locator('[data-finding-id="eos-mismatch"]').click()
  await page.keyboard.press('Escape')
  await expect(badge).toHaveAttribute('aria-expanded', 'false')
  await expect(report).toHaveCount(0)
  await expect(badge).toBeFocused()
  await badge.click()

  await page.getByRole('button', { name: /^generation_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: '生成默认值' })).toBeVisible()
  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await expect(page.getByRole('heading', { name: 'BertTokenizer' })).toBeVisible()
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await expect(page.locator('.key-value-row').filter({ hasText: '模型类型' })).toContainText('WordPiece')
  for (const path of ['config.json', 'generation_config.json', 'tokenizer_config.json', 'tokenizer.json', 'chat_template.jinja']) {
    expect(requests.filter(request => request.path === path)).toHaveLength(1)
  }
  expect(requests.some(request => request.path === 'model.safetensors')).toBe(false)
  expect(requests.some(request => request.path === 'model.gguf')).toBe(false)

  await expect(badge).toHaveAttribute('aria-expanded', 'true')
  await expect(report).toContainText('未在当前会话打开')

  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.gguf/ }).click()
  await expect(page.getByText(/^只读取了 .+ GGUF 文件前缀；最后一个 Range 可能包含少量首个 tensor 数据。$/)).toBeVisible()
  expect(requests.filter(request => request.path === 'model.gguf')).toEqual([
    expect.objectContaining({ range: 'bytes=0-1048575', status: 206 }),
    expect.objectContaining({ range: expect.stringMatching(/^bytes=1048576-/), status: 206 }),
  ])
  const reopened = report
  // Native Q-9: an opened GGUF is checked; its token_embd.weight [8, 4] disagrees with the 6-token fixture vocabulary.
  await expect(reopened.locator('[data-material="gguf"]')).toContainText('已检查')
  await expect(reopened.locator('[data-finding-id="gguf-vocab-mismatch"]'))
    .toContainText('GGUF token_embd.weight[0] = 8 · tokenizer.vocab_count = 6')
  await expect(reopened.locator('[data-finding-id="gguf-context-mismatch"]')).toHaveCount(0)

  await page.getByRole('button', { name: /^generation_config\.json/ }).click()
  await page.getByRole('button', { name: /^tokenizer_config\.json/ }).click()
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.gguf/ }).click()
  for (const path of ['config.json', 'generation_config.json', 'tokenizer_config.json', 'tokenizer.json', 'chat_template.jinja']) {
    expect(requests.filter(request => request.path === path)).toHaveLength(1)
  }
  expect(requests.filter(request => request.path === 'model.gguf')).toEqual([
    expect.objectContaining({ range: 'bytes=0-1048575', status: 206 }),
    expect.objectContaining({ range: expect.stringMatching(/^bytes=1048576-/), status: 206 }),
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
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expectRepository(page, 'Hugging Face · main', 15)
  await expect(page.getByRole('heading', { name: 'FixtureModel' })).toBeVisible()
  const baselineRequests = contentRequests.length

  await page.getByRole('button', { name: /^oversized\.json/ }).click()
  await expect(page.getByRole('heading', { name: '无法读取文件' })).toBeVisible()
  await expect(page.getByText('文件大小为 33.6 MB，超过 32 MB 阅读上限。')).toBeVisible()
  // Native: locked rows are dimmed and unselectable; a deep link still lands on the locked page.
  await expandWeights(page)
  const locked = page.getByRole('button', { name: /^pytorch_model\.bin/ })
  await expect(locked).toHaveAttribute('aria-disabled', 'true')
  await expect(locked).toContainText('不可预览')
  await locked.dispatchEvent('click')
  await expect(page.getByRole('heading', { name: '无法读取文件' })).toBeVisible()
  expect(contentRequests).toHaveLength(baselineRequests)
  await page.goto(`/?repo=${fixtureModelId}&file=pytorch_model.bin`)
  await expect(page.getByRole('heading', { name: '权重文件已锁定' })).toBeVisible()
  expect(contentRequests.filter(url => url.includes('pytorch_model.bin'))).toEqual([])
})

test('a newer repository request cancels and wins over a slow request', async ({ page }) => {
  await installFixtureRoutes(page, { manifestDelayMs: 250 })
  await page.goto('/')
  const repository = page.getByRole('combobox', { name: 'Hugging Face 仓库' })
  const open = page.getByRole('button', { name: /打开/ })

  await repository.fill('fixture/slow')
  await open.click()
  await repository.fill(fixtureModelId)
  // Native: Open is disabled while the manifest loads, but Return in the field still restarts.
  await expect(open).toBeDisabled()
  await repository.press('Enter')

  await expectRepository(page, 'Hugging Face · main', 13)
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
    expectRepository(page, 'Hugging Face · main', 13),
  ])
  const initialConfig = page.getByRole('button', { name: /^config\.json/ })
  await expect(initialConfig).toBeVisible()
  await expect(initialConfig).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.detail-body')).toHaveAttribute('aria-busy', 'true')

  await repository.fill('fixture/empty')
  await open.click()

  await expectRepository(page, 'Hugging Face · main', 1)
  await delay(300)
  await expectRepository(page, 'Hugging Face · main', 1)
  await expect(page.getByRole('combobox', { name: 'Hugging Face 仓库' })).toHaveValue('fixture/empty')
  await expect(page).toHaveURL(url => url.pathname === '/'
    && url.searchParams.get('repo') === 'fixture/empty'
    && url.searchParams.get('file') === 'README.md')
  await expect(page.getByRole('button', { name: /^README\.md/ })).toHaveAttribute('aria-current', 'true')
  const badge = page.getByRole('button', { name: '查看仓库一致性报告' })
  await expect(badge).toHaveText('材料不足')
  await badge.click()
  const report = page.getByRole('tabpanel', { name: '仓库一致性报告' })
  await expect(report).toContainText('缺少模型配置')
  await expect(report).toContainText('核心材料不足；以下 coverage 显示缺失、跳过或失败项。')
  await expect(report.locator('[data-material="config"]')).toContainText('缺失')
  await expect(report.locator('[data-material="config"] [data-coverage-icon="missing"]')).toHaveCount(1)
  await expect(report).not.toContainText('词表大小不一致')
  await expect(report).not.toContainText('EOS Token 不一致')
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
              && (message as { operation?: unknown }).operation === 'inspect-structure')) {
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
  const report = page.getByRole('tabpanel', { name: '仓库一致性报告' })
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
  await page.addInitScript("window.open = (url) => { window.__openedUrl = String(url); return null }")
  await installFixtureRoutes(page)
  await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}&file=model.gguf`)
  await expect(page.getByText(/^只读取了 .+ GGUF 文件前缀；/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(/^只读取了 .+ GGUF 文件前缀；/)).toBeVisible()

  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByText('参数总数').locator('..').getByText('2')).toBeVisible()
  await page.goBack()
  await expect(page.getByText(/^只读取了 .+ GGUF 文件前缀；/)).toBeVisible()
  await page.goForward()
  await expect(page.getByText('参数总数').locator('..').getByText('2')).toBeVisible()
  await page.getByRole('button', { name: '复制路径' }).click()
  expect(await page.evaluate('window.__copiedPath')).toBe('model.safetensors')
  await expect(page.getByRole('button', { name: '已复制' })).toBeVisible()
  await page.getByRole('button', { name: '复制全路径' }).click()
  expect(await page.evaluate('window.__copiedPath')).toBe(
    `https://huggingface.co/${fixtureModelId}/resolve/${fixtureRevision}/model.safetensors`,
  )
  await expect(page.getByRole('link', { name: '在源站打开' })).toHaveAttribute(
    'href',
    `https://huggingface.co/${fixtureModelId}/blob/${fixtureRevision}/model.safetensors`,
  )

  await page.getByRole('button', { name: /^config\.json\s/ }).click({ button: 'right' })
  const fileMenu = page.getByRole('menu', { name: '文件操作' })
  await expect(fileMenu).toBeVisible()
  await fileMenu.getByRole('menuitem', { name: '复制全路径' }).click()
  expect(await page.evaluate('window.__copiedPath')).toBe(
    `https://huggingface.co/${fixtureModelId}/resolve/${fixtureRevision}/config.json`,
  )
  await page.getByRole('button', { name: /^config\.json\s/ }).click({ button: 'right' })
  await page.getByRole('menu', { name: '文件操作' }).getByRole('menuitem', { name: '复制相对路径' }).click()
  expect(await page.evaluate('window.__copiedPath')).toBe('config.json')
  await page.getByRole('button', { name: /^config\.json\s/ }).click({ button: 'right' })
  await page.getByRole('menu', { name: '文件操作' }).getByRole('menuitem', { name: '打开原始文件' }).click()
  expect(await page.evaluate('window.__openedUrl')).toBe(
    `https://huggingface.co/${fixtureModelId}/resolve/${fixtureRevision}/config.json`,
  )
  expect(errors).toEqual([])
})

test('filters locally, avoids duplicate reads, and retries a failed manifest', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await installFixtureRoutes(page, { manifestFailures: 1 })
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('HTTP 503')
  await page.getByRole('button', { name: '重试' }).press('Enter')
  await expectRepository(page, 'Hugging Face · main', 13)
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
  await expect(page.getByRole('alert')).toContainText('模型 ID 无效，请使用类似 Qwen/Qwen3-4B 的格式。')
  await expect(page.getByRole('heading', { level: 2, name: '无法打开位置' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: '尚未打开模型' })).toBeVisible()
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
    await expect(page.getByText(/^只读取了 .+ GGUF 文件前缀；/)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (capturesScreenshots) {
      const screenshot = testInfo.outputPath(`${viewport.width}x${viewport.height}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`${viewport.width}x${viewport.height}`, { path: screenshot, contentType: 'image/png' })
    }
  }

  await page.goto('/')
  // Native toolbar order: the split view's sidebar toggle comes first. WebKit's default Tab skips buttons.
  if (testInfo.project.name !== 'webkit') {
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: '隐藏边栏' })).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(page.getByRole('combobox', { name: '加载方式' })).toBeFocused()
  await page.keyboard.press('Tab')
  const repository = page.getByRole('combobox', { name: 'Hugging Face 仓库' })
  await expect(repository).toBeFocused()
  await repository.fill(fixtureModelId)
  await repository.press('Enter')
  await expectRepository(page, 'Hugging Face · main', 13)
  const open = page.getByRole('button', { name: '打开', exact: true })
  await open.focus()
  await expect(open).toBeFocused()
  expect(await open.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')

  const filter = page.getByPlaceholder('筛选文件')
  await filter.focus()
  await page.keyboard.type('safetensors')
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).press('Enter')
  await page.getByRole('button', { name: 'Tensors', exact: true }).press('Enter')
  await expect(page.getByRole('table', { name: 'Tensors' })).toBeVisible()

  await filter.press('ControlOrMeta+A')
  await filter.press('Backspace')
  await page.keyboard.type('chat_template')
  await page.getByRole('button', { name: /^chat_template\.jinja/ }).press('Enter')
  await page.getByRole('group', { name: '阅读视图' }).getByRole('button', { name: '源码', exact: true }).press('Enter')
  const source = page.getByLabel('Jinja 源码')
  await source.focus()
  await source.press('ControlOrMeta+A')
  await page.keyboard.insertText('{{ messages | length }}')
  await page.getByRole('group', { name: '阅读视图' }).getByRole('button', { name: '试验台', exact: true }).press('Enter')
  await expect(page.getByLabel('原始输出 · 权威')).toHaveText('2')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}&file=model.gguf`)
  expect(await contrastRatio(page, 'body')).toBeGreaterThanOrEqual(4.5)
  expect(await contrastRatio(page, '.reader-title p')).toBeGreaterThanOrEqual(4.5)
  expect(await contrastRatio(page, '.primary-button')).toBeGreaterThanOrEqual(4.5)
  expect(await contrastRatio(page, '.consistency-badge')).toBeGreaterThanOrEqual(4.5)
  if (capturesScreenshots) {
    const darkScreenshot = testInfo.outputPath('dark-mode.png')
    await page.screenshot({ path: darkScreenshot })
    await testInfo.attach('dark-mode', { path: darkScreenshot, contentType: 'image/png' })
  }
  expect(errors).toEqual([])
})

test('renders image files and verifies blob url within CSP without console errors', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const dir = testInfo.outputPath('image-test-fixture')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'logo.png'), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]))
  await writeFile(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>')
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(dir)
  await page.getByRole('button', { name: /^logo\.png/ }).click()
  await expect(page.locator('.inspected-image')).toBeVisible()
  await expect(page.getByText('1 × 1 px', { exact: true })).toBeVisible()
  await expect(page.locator('.image-stats')).toHaveText(/^1 × 1 px·PNG·\d+ 字节$/)
  await expect(page.getByText(/^读取了完整的 .+ 图片数据，在本地直接渲染。$/)).toBeVisible()
  await page.getByRole('button', { name: /^icon\.svg/ }).click()
  await expect(page.locator('.inspected-image')).toBeVisible()
  await openPerspective(page, '源码')
  await expect(page.locator('.source-reader')).toContainText('<svg')
  expect(errors).toEqual([])
})

async function showPanelTab(page: Page, name: string) {
  // Tabs may carry a count pill, as in native ("Token IDs 3"). The panel auto-opens only once per file.
  const panel = page.getByRole('region', { name: '底部面板' })
  if (await panel.count() === 0) await page.getByRole('button', { name: '显示或隐藏底部面板' }).click()
  const label = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( [\\d,]+)?$`)
  await panel.getByRole('tab', { name: label }).click()
}

// The docked token table; inside a comparison each side has its own (scope by the side's region).
function tokenTable(scope: Page | Locator) {
  return scope.getByRole('table', { name: /^Token 表，共 [\d,]+ 行$/ })
}

function tokenRows(scope: Page | Locator) {
  return tokenTable(scope).locator('.token-table-row')
}

function resultPanel(page: Page) {
  return page.getByRole('region', { name: '分词结果' })
}

function comparisonPanel(page: Page) {
  return page.getByRole('region', { name: '对照', exact: true })
}

// The text actually encoded (or, for Token IDs, the decoded text).
function tokenizerText(page: Page, title = '送入 tokenizer 的文本') {
  return page.getByRole('region', { name: title, exact: true }).locator('pre')
}

async function openComparison(page: Page, item: string) {
  await page.getByRole('button', { name: '对照', exact: true }).click()
  await page.getByRole('menu', { name: '对照' }).getByRole('menuitem', { name: item, exact: true }).click()
}

async function openComparisonRepository(page: Page) {
  await page.getByRole('button', { name: '对照', exact: true }).click()
  await page.getByRole('menuitem', { name: '选择另一仓库…' }).click()
  return page.getByRole('form', { name: '另一仓库' })
}

async function loadComparisonRepository(page: Page, repository: string) {
  const form = await openComparisonRepository(page)
  await form.getByRole('textbox', { name: '另一仓库' }).fill(repository)
  await form.getByRole('button', { name: '加载对照' }).click()
}

async function openFixture(page: Page, expectedFileCount = 13) {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expectRepository(page, 'Hugging Face · main · SHA', expectedFileCount)
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = message.text()
      if (text.includes('chrome://juggler') || text.includes('NS_BINDING_ABORTED')) return
      errors.push(text)
    }
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
