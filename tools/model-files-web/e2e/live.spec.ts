import { expect, test, type Page, type TestInfo } from '@playwright/test'

test.skip(process.env.LIVE_HF !== '1', '真实 Hugging Face smoke 不进入确定性 CI。')

test('Qwen config, README, SafeTensors, Tokenizer Raw and Chat work from a fixed revision', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
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
  expect(requests.length).toBe(vocabularyRequestsBefore)

  await page.getByRole('tab', { name: 'Raw 工作台' }).click()
  await page.getByRole('textbox', { name: 'Raw 输入' }).fill('Hello，世界 👋')
  await page.getByRole('button', { name: '立即分词' }).click()
  await expect(page.getByText(/Decoded：/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('映射').locator('..')).toContainText('Exact')

  await page.getByRole('tab', { name: 'Chat 工作台' }).click()
  await page.getByRole('button', { name: '渲染并分词' }).click()
  await expect(page.getByLabel('Chat 权威输入')).not.toContainText('渲染后，这里显示唯一权威编码输入。', { timeout: 60_000 })
  await expect(page.getByText('Token 数').locator('..')).toBeVisible()
  expect(errors).toEqual([])
  await attachEvidence(testInfo, 'qwen-live.json', {
    revision: identity.sha,
    requests,
    vocabularyRequestsBefore,
    firstVocabularyQueryMs,
    cachedVocabularyQueryMs,
    vocabularyRequestsAfter: requests.length,
  })
  console.log(`LIVE Qwen revision=${identity.sha} ranges=${JSON.stringify(requests.filter(request => request.range !== null))}`)
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
  expect(requests.filter(request => request.path.endsWith('.gguf')).map(request => request.range)).toEqual(['bytes=0-23'])
  expect(errors).toEqual([])
  await attachEvidence(testInfo, 'gguf-live.json', { revision: identity.sha, requests })
  console.log(`LIVE GGUF revision=${identity.sha} ranges=${JSON.stringify(requests.filter(request => request.range !== null))}`)
})

type RequestEvidence = { path: string; range: string | null }

function collectRequests(page: Page): RequestEvidence[] {
  const requests: RequestEvidence[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname === 'huggingface.co' && url.pathname.includes('/resolve/')) {
      requests.push({ path: decodeURIComponent(url.pathname.split('/').at(-1) ?? ''), range: request.headers().range ?? null })
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
