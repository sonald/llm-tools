import { expect, test, type Page, type TestInfo } from '@playwright/test'

test.skip(process.env.LIVE_HF !== '1', '真实 Hugging Face smoke 不进入确定性 CI。')

test('Chat: Qwen config, README, SafeTensors, Tokenizer Raw, Chat and cross-repository comparison work from fixed revisions', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const errors = collectErrors(page)
  const requests = collectRequests(page)
  const manifest = page.waitForResponse(response => response.url().includes('/api/models/Qwen/Qwen3-0.6B'))
  await page.goto('/?repo=Qwen%2FQwen3-0.6B&file=config.json')
  const identity = await (await manifest).json() as { sha: string }
  await expect(page.getByRole('heading', { name: 'Model Config' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('模型类型').locator('..')).toContainText('qwen3')

  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.locator('.markdown-body')).toContainText('Qwen3', { timeout: 30_000 })
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByText('Tensor 数据').locator('..').getByText('0 bytes', { exact: true })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await expect(page.getByText('Model Type').locator('..')).toContainText('BPE', { timeout: 60_000 })
  const search = page.getByRole('textbox', { name: '词表搜索' })
  const vocabularyRequestsBefore = requests.length
  const firstSearchStarted = Date.now()
  await search.fill('1')
  await expect(page.getByText('匹配 1,000 条')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('table', { name: '词表搜索结果' }).locator('tbody tr')).toHaveCount(1000)
  const firstVocabularyQueryMs = Date.now() - firstSearchStarted
  expect(firstVocabularyQueryMs).toBeLessThan(10_000)

  const cachedSearchStarted = Date.now()
  await search.fill('0')
  await expect(page.getByText('匹配 1,000 条')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('table', { name: '词表搜索结果' }).locator('tbody tr')).toHaveCount(1000)
  const cachedVocabularyQueryMs = Date.now() - cachedSearchStarted
  expect(cachedVocabularyQueryMs).toBeLessThan(10_000)
  const vocabularyRequestsAfter = requests.length
  expect(vocabularyRequestsAfter).toBe(vocabularyRequestsBefore)

  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  await page.getByRole('textbox', { name: 'Raw 输入' }).fill('Hello，世界 👋')
  await page.getByRole('button', { name: '立即分词' }).click()
  await expect(page.getByText(/Decoded：/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('映射').locator('..')).toContainText('Exact')

  const initialState = {
    url: page.url(),
    historyLength: await page.evaluate(() => history.length),
    repositoryInput: await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).inputValue(),
    status: await page.locator('.repository-status').innerText(),
    detailHeader: await page.locator('.detail-header').innerText(),
    localStorageHistory: await page.evaluate(() => localStorage.getItem('model-files.repository-history')),
  }

  const comparisonManifest = page.waitForResponse(response => response.url()
    .includes('/api/models/google-t5/t5-small'))
  await page.getByText('另一公开 Hugging Face…').click()
  await page.getByLabel('对照 Hugging Face 仓库').fill('google-t5/t5-small')
  await page.getByRole('button', { name: '加载对照' }).click()
  const comparisonIdentity = await (await comparisonManifest).json() as { sha: string }
  await expect(page.locator('.comparison-source')).toHaveText(
    `google-t5/t5-small · SHA ${comparisonIdentity.sha.slice(0, 7)} · tokenizer.json`,
  )
  await expect(page.getByRole('region', { name: 'Tokenizer 对照摘要' })).toContainText(
    /#0 · \d+(?:,\d{3})* \/ \d+(?:,\d{3})*/,
    { timeout: 60_000 },
  )
  await expect(page.getByRole('region', { name: 'Tokenizer 词表差集统计' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('table', { name: '主 Tokenizer Tokens' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('table', { name: '对照 Tokenizer Tokens' })).toBeVisible({ timeout: 60_000 })

  await page.getByRole('button', { name: '关闭 Tokenizer 对照' }).click()
  await expect(page.locator('.comparison-source')).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Tokenizer Tokens' })).toBeVisible()

  expect({
    url: page.url(),
    historyLength: await page.evaluate(() => history.length),
    repositoryInput: await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).inputValue(),
    status: await page.locator('.repository-status').innerText(),
    detailHeader: await page.locator('.detail-header').innerText(),
    localStorageHistory: await page.evaluate(() => localStorage.getItem('model-files.repository-history')),
  }).toEqual(initialState)

  await page.getByRole('tab', { name: 'Chat 工作台' }).click()
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).not.toContainText('渲染后，这里显示唯一权威编码输入。', { timeout: 60_000 })
  await expect(page.getByText('Token 数').locator('..')).toBeVisible()

  const qwenRequests = requests.filter(request => request.modelId === qwenModelId)
  const comparisonRequests = requests.filter(request => request.modelId === comparisonModelId)
  expect(qwenRequests.length).toBeGreaterThan(0)
  expect(comparisonRequests.length).toBeGreaterThan(0)
  for (const request of qwenRequests) {
    expect(request.revision).toBe(identity.sha)
  }
  for (const request of comparisonRequests) {
    expect(request.revision).toBe(comparisonIdentity.sha)
  }
  expect(requests.filter(request =>
    request.modelId !== qwenModelId && request.modelId !== comparisonModelId)).toEqual([])
  expect(qwenRequests.filter(request => request.path === 'model.safetensors').map(request => request.range))
    .toEqual([
      'bytes=0-7',
      expect.stringMatching(/^bytes=8-/),
    ])
  expect(comparisonRequests.some(request =>
    request.path.endsWith('.safetensors') || request.path.endsWith('.gguf'))).toBe(false)
  expect(requests.some(request => request.path.endsWith('.bin'))).toBe(false)
  expect(errors).toEqual([])
  await attachEvidence(testInfo, 'qwen-live.json', {
    qwenRevision: identity.sha,
    comparisonRevision: comparisonIdentity.sha,
    requests,
    vocabularyRequestsBefore,
    firstVocabularyQueryMs,
    cachedVocabularyQueryMs,
    vocabularyRequestsAfter,
  })
  console.log(`LIVE Qwen revision=${identity.sha} comparison revision=${comparisonIdentity.sha} ranges=${JSON.stringify(requests.filter(request => request.range !== null))}`)
})

test('T5 Raw reports normalization as Decoded only', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const errors = collectErrors(page)
  const requests = collectRequests(page)
  const manifest = page.waitForResponse(response => response.url().includes('/api/models/google-t5/t5-small'))
  await page.goto('/?repo=google-t5%2Ft5-small&file=tokenizer.json')
  const identity = await (await manifest).json() as { sha: string }
  await expect(page.getByText('Model Type').locator('..')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  const input = ' Hello   world '
  await page.getByRole('textbox', { name: 'Raw 输入' }).fill(input)
  await page.getByRole('button', { name: '立即分词' }).click()
  await expect(page.getByText('映射').locator('..')).toContainText('Decoded only', { timeout: 60_000 })
  await expect(page.getByText(`Decoded：${input}`)).toHaveCount(0)
  const t5Requests = requests.filter(request => request.modelId === comparisonModelId)
  expect(t5Requests.length).toBeGreaterThan(0)
  for (const request of t5Requests) {
    expect(request.revision).toBe(identity.sha)
  }
  expect(requests.filter(request => request.modelId !== comparisonModelId)).toEqual([])
  expect(errors).toEqual([])
  await attachEvidence(testInfo, 't5-live.json', { revision: identity.sha, requests })
  console.log(`LIVE T5 revision=${identity.sha}`)
})

test('GGUF public path reads only the 24-byte basic prefix', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const errors = collectErrors(page)
  const requests = collectRequests(page)
  const manifest = page.waitForResponse(response => response.url().includes('/api/models/bartowski/Qwen_Qwen3-0.6B-GGUF'))
  await page.goto('/?repo=bartowski%2FQwen_Qwen3-0.6B-GGUF&file=Qwen_Qwen3-0.6B-IQ2_M.gguf')
  const identity = await (await manifest).json() as { sha: string }
  await expect(page.getByText('实际读取').locator('..').getByText('24 bytes')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('模型数据').locator('..').getByText('0 bytes')).toBeVisible()
  const ggufRequests = requests.filter(request => request.modelId === ggufModelId)
  expect(ggufRequests.length).toBeGreaterThan(0)
  for (const request of ggufRequests) {
    expect(request.revision).toBe(identity.sha)
  }
  expect(requests.filter(request => request.modelId !== ggufModelId)).toEqual([])
  expect(ggufRequests.filter(request => request.path.endsWith('.gguf')).map(request => request.range)).toEqual(['bytes=0-23'])
  expect(errors).toEqual([])
  await attachEvidence(testInfo, 'gguf-live.json', { revision: identity.sha, requests })
  console.log(`LIVE GGUF revision=${identity.sha} ranges=${JSON.stringify(requests.filter(request => request.range !== null))}`)
})

type RequestEvidence = { modelId: string; revision: string; path: string; range: string | null }
const qwenModelId = 'Qwen/Qwen3-0.6B'
const comparisonModelId = 'google-t5/t5-small'
const ggufModelId = 'bartowski/Qwen_Qwen3-0.6B-GGUF'

function collectRequests(page: Page): RequestEvidence[] {
  const requests: RequestEvidence[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname === 'huggingface.co' && url.pathname.includes('/resolve/')) {
      const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/)
      if (match === null) {
        requests.push({ modelId: '<unauditable>', revision: '<invalid>', path: url.pathname, range: request.headers().range ?? null })
        return
      }
      requests.push({
        modelId: `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`,
        revision: match[3],
        path: decodeURIComponent(match[4]),
        range: request.headers().range ?? null,
      })
    }
  })
  return requests
}

async function attachEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' })
}

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}
