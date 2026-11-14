import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  expandWeights, expectRepository, fixtureModelId, ggufFixtureTokenCount, installFixtureRoutes, openPerspective, writeFixtureDirectory,
  setLaunchInput,
} from './fixtures.ts'

// Batch 5: native WeightWorkspaceView / IMatrixWorkspaceView (DetailView.swift:332-362,687-1007; IMatrixWorkspaceView.swift).

test('SafeTensors workspace follows native overview, metadata and tensor outline', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()

  // W-1: title, facts with an origin column, two 查看全部 buttons.
  await expect(page.getByRole('heading', { name: 'SafeTensors 权重结构' })).toBeVisible()
  await expect(page.getByText('Header 描述 tensor 目录；权重数据区未读取。')).toBeVisible()
  const header = requests.find(request => request.path === 'model.safetensors' && request.range?.startsWith('bytes=8-'))
  const headerBytes = header === undefined ? 0 : header.responseBytes
  expect(await factRows(page)).toEqual([
    ['Tensor 数量', '106', '应用推导'],
    ['参数总数', '2', '应用推导'],
    ['权重数据大小', '8 字节', '应用推导'],
    ['主要数据类型', 'F32 × 106', '应用推导'],
    ['Header 大小', `${(headerBytes / 1000).toFixed(0)} KB`, '运行结果'],
  ])
  await expect(page.getByText(`只读取了 ${(headerBytes / 1000).toFixed(0)} KB JSON Header；没有请求 tensor 数据。`)).toBeVisible()
  await expect(page.getByRole('button', { name: '查看全部 106 个 Tensors' })).toBeVisible()
  await page.getByRole('button', { name: '查看全部 1 条 Metadata' }).click()

  // W-2: 字段 / 类型 / 值 / 来源, details in the native in-view pane, ⌘F focuses the search.
  const metadata = page.getByRole('table', { name: 'Metadata' })
  await expect(metadata.getByRole('columnheader')).toHaveText(['字段', '类型', '值', '来源'])
  await expect(metadata.getByRole('row').nth(1).getByRole('cell')).toHaveText(['format', 'string', 'pt', '文件内嵌'])
  const inspector = page.locator('.wt-pane')
  await expect(inspector).toContainText('选择 Metadata')
  await metadata.getByRole('row').nth(1).click()
  await expect(metadata.getByRole('row').nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(inspector.getByRole('heading', { name: '字段详情' })).toBeVisible()
  await expect(inspector.locator('.key-value-row')).toHaveText(['Keyformat', '类型string', '来源文件内嵌'])
  await expect(inspector.getByRole('heading', { name: '完整值' })).toBeVisible()
  await expect(inspector.locator('.wt-full-value')).toHaveText('pt')
  await page.keyboard.press('ControlOrMeta+f')
  const metadataSearch = page.getByRole('searchbox', { name: '搜索 key 或值' })
  await expect(metadataSearch).toBeFocused()
  await page.keyboard.type('PT')
  await expect(page.locator('.wt-bar .wt-count')).toHaveText('1 项')
  await metadataSearch.fill('zzz')
  await expect(page.locator('.wt-bar .wt-count')).toHaveText('0 项')

  // W-3: switching perspective clears the query; name / Shape / 类型 / 参数; nothing selected.
  await openPerspective(page, 'Tensors')
  const search = page.getByRole('searchbox', { name: '搜索名称或 dtype' })
  await expect(search).toHaveValue('')
  await expect(page.locator('.wt-bar .wt-count')).toHaveText('106 项')
  const tensors = page.getByRole('table', { name: 'Tensors' })
  await expect(tensors.getByRole('columnheader')).toHaveText(['名称', 'Shape', '类型', '参数'])
  await expect(page.locator('.wt-breadcrumb')).toHaveCount(0)
  await expect(tensors.getByRole('row', { selected: true })).toHaveCount(0)
  await expect(page.locator('.wt-pane')).toContainText('选择 Tensor')
  await expect(page.locator('.wt-pane')).toContainText('选择一行查看 shape、类型和 offset。')
  await expect(tensors.getByRole('row').nth(1)).toHaveText(/^model105 个 Tensors$/)
  await expect(tensors.getByRole('row').nth(2).getByRole('cell')).toHaveText(['weight', '[2]', 'F32', '2'])
  await expect(tensors.getByRole('button', { name: '展开 model', exact: true })).toHaveAttribute('aria-expanded', 'false')

  // D-6: every tensor, rendered lazily; no paging button.
  await tensors.getByRole('button', { name: '展开 model', exact: true }).click()
  await tensors.getByRole('button', { name: '展开 model.layer', exact: true }).click()
  await expect(tensors).toHaveAttribute('aria-rowcount', String(108 + 1))
  expect(await tensors.getByRole('row').count()).toBeLessThan(80)
  await expect(page.getByRole('button', { name: /再显示/ })).toHaveCount(0)
  await tensors.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(tensors.getByRole('button', { name: '展开 model.layer.104', exact: true })).toBeVisible()
  await tensors.evaluate(element => { element.scrollTop = 0 })

  // Native keeps the user's expansion while searching and never auto-expands a match.
  await search.fill(' layer.104 ')
  await expect(page.locator('.wt-bar .wt-count')).toHaveText('1 项')
  await expect(tensors.getByRole('row')).toHaveCount(4)
  await tensors.getByRole('button', { name: '展开 model.layer.104', exact: true }).click()
  const leaf = tensors.locator('[title="model.layer.104.weight"]')
  await leaf.click()
  await expect(page.locator('.wt-breadcrumb')).toHaveText('model › layer › 104 › weight')
  const pane = page.locator('.wt-pane')
  await expect(pane.getByRole('heading', { name: 'Tensor 详情' })).toBeVisible()
  await expect(pane.locator('.wt-full-value')).toHaveText('model.layer.104.weight')
  await expect(pane.locator('.key-value-row')).toHaveText(['Shape[0]', '类型F32', '参数0', '数据大小0 KB', '数据 offset0'])
  await expect(pane).toContainText('这里只展示目录信息，不读取 tensor 数据。')

  // A group row is selectable too: breadcrumb shows its path, the pane has no tensor.
  await tensors.getByRole('row').filter({ hasText: /^104/ }).click()
  await expect(page.locator('.wt-breadcrumb')).toHaveText('model › layer › 104')
  await expect(pane).toContainText('选择 Tensor')
  // Native Table: ↓ / ↑ move the selection and focus between rows.
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.wt-breadcrumb')).toHaveText('model › layer › 104 › weight')
  await expect(tensors.locator('[role="row"]:focus')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(page.locator('.wt-breadcrumb')).toHaveText('model › layer › 104')
  await leaf.click()
  await page.getByRole('button', { name: '全部收起' }).click()
  await expect(leaf).toHaveCount(0)
  await expect(page.locator('.wt-breadcrumb')).toHaveText('model › layer › 104 › weight')

  // Toolbar icon toggles the pane; the pane's own icon hides it.
  await page.getByRole('button', { name: '隐藏详情' }).click()
  await expect(pane).toHaveCount(0)
  await expect(page.getByRole('button', { name: '显示详情' })).toHaveAttribute('title', '显示右侧 Tensor 详情')
  await page.getByRole('button', { name: '显示详情' }).click()
  await expect(pane.locator('.wt-full-value')).toHaveText('model.layer.104.weight')
  await pane.getByRole('button', { name: '隐藏', exact: true }).click()
  await expect(pane).toHaveCount(0)
  await expect(page.getByRole('button', { name: '显示详情' })).toBeVisible()

  // Two exact ranges, no tensor data, nothing reread on reopen.
  await page.getByRole('button', { name: /^config\.json/ }).click()
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByRole('heading', { name: 'SafeTensors 权重结构' })).toBeVisible()
  expect(requests.filter(request => request.path === 'model.safetensors')).toEqual([
    expect.objectContaining({ range: 'bytes=0-7', responseBytes: 8, status: 206 }),
    expect.objectContaining({ range: `bytes=8-${7 + headerBytes}`, status: 206 }),
  ])
  expect(errors).toEqual([])
})

test('GGUF reads its directory in native 1 MiB ranges and opens the full workspace', async ({ page }) => {
  const errors = collectErrors(page)
  const requests = await installFixtureRoutes(page)
  await openFixture(page)
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.gguf/ }).click()

  await expect(page.getByRole('heading', { name: 'Fixture GGUF' })).toBeVisible()
  await expect(page.getByText('GGUF v3 · little-endian · 只解析 metadata 与 tensor 目录。')).toBeVisible()
  await expect(page.locator('.detail-header .format-chip')).toHaveText('GGUF v3')
  const ranges = requests.filter(request => request.path === 'model.gguf')
  expect(ranges).toHaveLength(2)
  expect(ranges[0]).toEqual(expect.objectContaining({ range: 'bytes=0-1048575', responseBytes: 1048576, status: 206 }))
  const fileSize = 1048576 + ranges[1].responseBytes
  expect(ranges[1]).toEqual(expect.objectContaining({ range: `bytes=1048576-${fileSize - 1}`, status: 206 }))
  const facts = await factRows(page)
  const dataStart = Number((facts.find(row => row[0] === 'Tensor 数据起点')?.[1] ?? '').replaceAll(',', ''))
  // The last range runs into the tensor data; native accepts that over-read (ruling D-1).
  expect(dataStart).toBeGreaterThan(1048576)
  expect(dataStart).toBeLessThan(fileSize)
  expect(facts).toEqual([
    ['架构', 'llama', '文件内嵌'],
    ['主要数据类型', 'Q4_K', '应用推导'],
    ['上下文长度', '4,096', '文件内嵌'],
    ['Tensor 数量', '4', '应用推导'],
    ['参数总数', '168', '应用推导'],
    ['Metadata 数量', '6', '应用推导'],
    ['数据区对齐', '32 字节', '文件内嵌'],
    ['Tensor 数据起点', dataStart.toLocaleString('en-US'), '应用推导'],
    ['已读取前缀', `${(fileSize / 1e6).toFixed(1)} MB`, '运行结果'],
  ])
  await expect(page.getByText(`只读取了 ${(fileSize / 1e6).toFixed(1)} MB GGUF 文件前缀；最后一个 Range 可能包含少量首个 tensor 数据。`)).toBeVisible()

  await page.getByRole('button', { name: '查看全部 6 条 Metadata' }).click()
  const metadata = page.getByRole('table', { name: 'Metadata' })
  // File order, native types, Swift float text, array preview.
  await expect(metadata.getByRole('row').nth(1).getByRole('cell')).toHaveText(['general.architecture', 'string', 'llama', '文件内嵌'])
  await expect(metadata.getByRole('row').nth(4).getByRole('cell')).toHaveText(['llama.attention.layer_norm_rms_epsilon', 'float32', '1e-06', '文件内嵌'])
  await expect(metadata.getByRole('row').nth(6).getByRole('cell').nth(2))
    .toHaveText(`[${Array.from({ length: 16 }, (_, index) => `token-${index}`).join(', ')}, …] · ${ggufFixtureTokenCount.toLocaleString('en-US')} 项`)

  await openPerspective(page, 'Tensors')
  const tensors = page.getByRole('table', { name: 'Tensors' })
  await expect(tensors.getByRole('row').filter({ hasText: /个 Tensors$/ })).toHaveText(['blk2 个 Tensors', 'output_norm1 个 Tensors', 'token_embd1 个 Tensors'])
  await tensors.getByRole('button', { name: '展开 token_embd', exact: true }).click()
  await tensors.locator('[title="token_embd.weight"]').click()
  // GGUF has an offset but no per-tensor byte size, so 数据大小 is left out.
  await expect(page.locator('.wt-pane .key-value-row')).toHaveText(['Shape[8, 4]', '类型F16', '参数32', '数据 offset0'])

  await page.getByRole('button', { name: /^config\.json/ }).click()
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.gguf/ }).click()
  await expect(page.getByRole('heading', { name: 'Fixture GGUF' })).toBeVisible()
  expect(requests.filter(request => request.path === 'model.gguf')).toHaveLength(2)
  expect(errors).toEqual([])
})

test('GGUF fails closed when a source answers a range with HTTP 200', async ({ page }) => {
  await installFixtureRoutes(page, { rangeBehavior: 'http200' })
  await openFixture(page)
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.gguf/ }).click()
  await expect(page.getByRole('heading', { name: '无法读取文件' })).toBeVisible()
  await expect(page.getByText(/源站未确认 HTTP Range（状态码 200），已取消以避免下载完整权重。/)).toBeVisible()
})

test('Imatrix overview and Entries follow native IMatrixWorkspaceView', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  await openFixture(page)
  await page.getByRole('button', { name: /^imatrix-fixture\.dat/ }).click()
  await expect(page.getByRole('heading', { name: 'Importance Matrix' })).toBeVisible()
  await expect(page.getByText('llama.cpp legacy imatrix.dat · 每个条目记录 tensor 激活的重要性统计。')).toBeVisible()
  await expect(page.locator('.wt-fact-grid > div')).toHaveText(['条目数2', 'Chunk 数12', '数据集calibration.txt', /^文件大小\d+ 字节$/])

  await openPerspective(page, 'Entries')
  const entries = page.getByRole('table', { name: 'Entries' })
  await expect(entries.getByRole('columnheader')).toHaveText(['Tensor', 'Calls', 'Values', 'Mean', 'Min', 'Max'])
  // Five significant digits, half to even on exact ties, like ICU behind native `.significantDigits(5)`.
  await expect(entries.getByRole('row').nth(1).getByRole('cell')).toHaveText(['blk.0.attn.weight', '8', '2', '6,172.8', '1.0312', '12,344'])
  await expect(entries.getByRole('row').nth(2).getByRole('cell')).toHaveText(['blk.0.ffn.weight', '4', '2', '1.0000', '0.50000', '1.5000'])
  await expect(page.locator('.wt-filter-bar .wt-count')).toHaveText('2 / 2')
  await page.getByPlaceholder('筛选 tensor').fill('  FFN ')
  await expect(page.locator('.wt-filter-bar .wt-count')).toHaveText('1 / 2')

  // A file without the chunk/dataset trailer shows 未记录.
  const directory = testInfo.outputPath('imatrix-without-trailer')
  await mkdir(directory, { recursive: true })
  const output: number[] = []
  const int32 = (value: number) => output.push(...new Uint8Array(new Int32Array([value]).buffer))
  int32(1)
  const name = new TextEncoder().encode('blk.0.w')
  int32(name.length)
  output.push(...name)
  int32(1)
  int32(1)
  output.push(...new Uint8Array(new Float32Array([0.25]).buffer))
  await writeFile(join(directory, 'imatrix.dat'), Uint8Array.from(output))
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  await page.getByRole('button', { name: /^imatrix\.dat/ }).click()
  await expect(page.locator('.wt-fact-grid > div')).toHaveText(['条目数1', 'Chunk 数未记录', '数据集未记录', '文件大小27 字节'])
  expect(errors).toEqual([])
})

test('local directories open SafeTensors, GGUF and Imatrix workspaces without network requests', async ({ page }, testInfo) => {
  const errors = collectErrors(page)
  const external: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url())
  })
  const directory = testInfo.outputPath('weights-local-fixture')
  await writeFixtureDirectory(directory)
  await setLaunchInput(page)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  await expect(page.getByRole('heading', { name: 'FixtureModel' })).toBeVisible()
  await page.getByRole('button', { name: /^imatrix-fixture\.dat/ }).click()
  await expect(page.getByRole('heading', { name: 'Importance Matrix' })).toBeVisible()
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByRole('heading', { name: 'SafeTensors 权重结构' })).toBeVisible()
  await expect(page.locator('.inspection-facts dl > div').first()).toHaveText('Tensor 数量106应用推导')
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.gguf/ }).click()
  await expect(page.getByRole('heading', { name: 'Fixture GGUF' })).toBeVisible()
  await openPerspective(page, 'Metadata')
  await expect(page.locator('.wt-bar .wt-count')).toHaveText('6 项')
  expect(external).toEqual([])
  expect(errors).toEqual([])
})

test('weights workspaces fit 1440, 1280, 1024 and 390 px in light and dark', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Layout evidence is collected once in Chromium; the other engines run the behaviour tests.')
  const errors = collectErrors(page)
  await installFixtureRoutes(page)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const width of [1440, 1280, 1024, 390]) {
      await page.setViewportSize({ width, height: 860 })
      await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}&file=model.safetensors`)
      await expect(page.getByRole('heading', { name: 'SafeTensors 权重结构' })).toBeVisible()
      await expectNoOverflow(page)
      await screenshot(page, testInfo, `weights-overview-${colorScheme}-${width}`)
      await openPerspective(page, 'Tensors')
      const tensors = page.getByRole('table', { name: 'Tensors' })
      await tensors.getByRole('row').nth(2).click()
      // Every column fits inside the table, 参数 included.
      const table = await box(tensors)
      const lastColumn = await box(tensors.getByRole('columnheader', { name: '参数' }))
      expect(lastColumn.x + lastColumn.width).toBeLessThanOrEqual(table.x + table.width + 1)
      // Native HSplitView needs 520 + 260 pt; narrower content stacks the pane under the outline.
      const contentWidth = (await box(page.locator('.wt-workspace'))).width
      const paneHeading = page.locator('.wt-pane').getByRole('heading', { name: 'Tensor 详情' })
      await paneHeading.scrollIntoViewIfNeeded()
      await expect(paneHeading).toBeInViewport()
      await expect(page.locator('.wt-pane').getByRole('button', { name: '隐藏', exact: true })).toBeInViewport()
      const pane = await box(page.locator('.wt-pane'))
      const tableNow = await box(tensors)
      if (contentWidth >= 780) expect(pane.x).toBeGreaterThanOrEqual(tableNow.x + tableNow.width - 1)
      else expect(pane.y).toBeGreaterThanOrEqual(tableNow.y + tableNow.height - 1)
      await expect(page.locator('.wt-pane .wt-full-value')).toHaveText('weight')
      await expectNoOverflow(page)
      await screenshot(page, testInfo, `weights-tensors-${colorScheme}-${width}`)

      await openPerspective(page, 'Metadata')
      await page.getByRole('table', { name: 'Metadata' }).getByRole('row').nth(1).click()
      const detail = page.locator('.wt-pane')
      await expect(detail.locator('.wt-full-value')).toHaveText('pt')
      await expectNoOverflow(page)
      await screenshot(page, testInfo, `weights-metadata-${colorScheme}-${width}`)

      await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}&file=imatrix-fixture.dat`)
      await openPerspective(page, 'Entries')
      const entries = page.getByRole('table', { name: 'Entries' })
      await expect(entries.getByRole('row')).toHaveCount(3)
      const entriesBox = await box(entries)
      const maxColumn = await box(entries.getByRole('columnheader', { name: 'Max' }))
      expect(maxColumn.x + maxColumn.width).toBeLessThanOrEqual(entriesBox.x + entriesBox.width + 1)
      await expectNoOverflow(page)
      await screenshot(page, testInfo, `weights-imatrix-${colorScheme}-${width}`)
      await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}&file=model.gguf`)
      await expect(page.getByRole('heading', { name: 'Fixture GGUF' })).toBeVisible()
      await expectNoOverflow(page)
      await screenshot(page, testInfo, `weights-gguf-${colorScheme}-${width}`)
    }
  }
  expect(errors).toEqual([])
})

async function openFixture(page: Page) {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill(fixtureModelId)
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expectRepository(page, 'Hugging Face · main · SHA', 13)
}

async function factRows(page: Page): Promise<string[][]> {
  return page.locator('.inspection-facts dl > div').evaluateAll(rows => rows.map(row =>
    [...row.children].map(cell => cell.textContent ?? '')))
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (value === null) throw new Error('element is not rendered')
  return value
}

async function screenshot(page: Page, testInfo: import('@playwright/test').TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
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
