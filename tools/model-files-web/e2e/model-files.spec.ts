import { expect, test, type Page } from '@playwright/test'
import { fixtureModelId, fixtureRevision, installFixtureRoutes, writeFixtureDirectory } from './fixtures.ts'

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
  await expect(page.getByRole('table', { name: 'Tokenizer Tokens' }).getByRole('columnheader', { name: 'Decoded' })).toBeVisible()
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
  await expect(page.getByLabel('Chat 权威输入')).toContainText('mode=chat')
  await expect(page.getByText('特殊 Token').locator('..')).toContainText('add_special_tokens:false')
  const authoritative = await page.getByLabel('Chat 权威输入').textContent()
  await expect(page.locator('.decoded-text').filter({ hasText: '权威输入：' })).toHaveText(`权威输入：${authoritative}`)
  expect(requests.filter(request => request.path.startsWith('tokenizer'))).toHaveLength(2)
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

  await expect(page.getByText('本地目录 · live · 13 个文件')).toBeVisible()
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
  await expect(page.getByRole('table', { name: 'Template 输出结构' })).toContainText('mode=basic')

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
  await expect(page.getByRole('heading', { name: '打开模型仓库' })).toBeVisible()
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

async function openFixture(page: Page) {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: '打开' }).click()
  await expect(page.getByText(/公开仓库 · SHA 0123456 · 13 个文件/)).toBeVisible()
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
