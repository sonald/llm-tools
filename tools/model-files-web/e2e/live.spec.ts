import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { expandWeights, openPlaygroundMode, tokenizerMetric } from './fixtures.ts'

test.skip(process.env.LIVE_HF !== '1', '真实 Hugging Face smoke 不进入确定性 CI。')

test('Chat: Qwen config, README, SafeTensors, Tokenizer Raw, Chat and cross-repository comparison work from fixed revisions', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const errors = collectErrors(page)
  const requests = collectRequests(page)
  const manifest = page.waitForResponse(response => response.url().includes('/api/models/Qwen/Qwen3-0.6B'))
  await page.goto('/?repo=Qwen%2FQwen3-0.6B&file=config.json')
  const identity = await (await manifest).json() as { sha: string }
  await expect(page.getByRole('heading', { name: 'Qwen3ForCausalLM' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('qwen3 · bfloat16 · 28 layers')).toBeVisible()

  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.locator('.markdown-body')).toContainText('Qwen3', { timeout: 30_000 })
  await expandWeights(page)
  await page.getByRole('button', { name: /^model\.safetensors\s/ }).click()
  await expect(page.getByText(/^只读取了 .+ JSON Header；没有请求 tensor 数据。$/)).toBeVisible({ timeout: 30_000 })
  const tensorHierarchyStartedAt = Date.now()
  await page.getByRole('button', { name: 'Tensors', exact: true }).click()
  const tensorTable = page.getByRole('table', { name: 'SafeTensors Tensors' })
  await expect(tensorTable).toBeVisible({ timeout: 30_000 })
  await tensorTable.getByRole('button', { name: /^model/ }).click()
  await tensorTable.getByRole('button', { name: /^layers/ }).click()
  await page.getByPlaceholder('名称或 dtype 包含…').fill('q_proj')
  const qProjectionLeaf = tensorTable.getByRole('button', { name: /^model\.layers\.\d+\.self_attn\.q_proj\.weight$/ }).first()
  await expect(qProjectionLeaf).toBeVisible({ timeout: 30_000 })
  await qProjectionLeaf.click()
  const qProjectionName = await qProjectionLeaf.getAttribute('aria-label')
  if (qProjectionName === null) throw new Error('Qwen q_proj leaf did not expose its full tensor name')
  const tensorHierarchyMs = Date.now() - tensorHierarchyStartedAt
  await expect(page.getByText(qProjectionName.split('.').filter(Boolean).join(' › '))).toBeVisible()
  await expect(page.getByRole('heading', { name: `选中 Tensor · ${qProjectionName}` })).toBeVisible()

  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await expect(page.locator('.key-value-row').filter({ hasText: '模型类型' })).toContainText('BPE', { timeout: 60_000 })
  const searchCard = page.getByRole('region', { name: '词表搜索' })
  const search = searchCard.getByRole('textbox', { name: '搜索 token 或 ID' })
  const searchResults = searchCard.getByRole('list', { name: '词表搜索' }).getByRole('listitem')
  const vocabularyRequestsBefore = requests.length
  const firstSearchStarted = Date.now()
  await search.fill('1')
  await expect(searchCard.getByText('匹配 1,000 条')).toBeVisible({ timeout: 10_000 })
  await expect(searchResults).toHaveCount(1000)
  const firstVocabularyQueryMs = Date.now() - firstSearchStarted
  expect(firstVocabularyQueryMs).toBeLessThan(10_000)

  const cachedSearchStarted = Date.now()
  await search.fill('0')
  await expect(searchCard.getByText('匹配 1,000 条')).toBeVisible({ timeout: 10_000 })
  await expect(searchResults).toHaveCount(1000)
  const cachedVocabularyQueryMs = Date.now() - cachedSearchStarted
  expect(cachedVocabularyQueryMs).toBeLessThan(10_000)
  const vocabularyRequestsAfter = requests.length
  expect(vocabularyRequestsAfter).toBe(vocabularyRequestsBefore)

  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('Hello，世界 👋')
  const result = page.getByRole('region', { name: '分词结果' })
  await expect(result.locator('.tkp-stream-content')).toHaveText('Hello，世界 👋', { timeout: 60_000 })
  await expect(result).toContainText('tokenizer.json · Exact')

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
  await page.getByRole('button', { name: '对照', exact: true }).click()
  await page.getByRole('menuitem', { name: '选择另一仓库…' }).click()
  const form = page.getByRole('form', { name: '另一仓库' })
  await form.getByRole('textbox', { name: '另一仓库' }).fill('google-t5/t5-small')
  await form.getByRole('button', { name: '加载对照' }).click()
  const comparisonIdentity = await (await comparisonManifest).json() as { sha: string }
  const comparison = page.getByRole('region', { name: '对照', exact: true })
  const right = comparison.getByRole('region', { name: 'google-t5/t5-small · tokenizer.json' })
  await expect(comparison.getByText(/^第一处不同：/)).toBeVisible({ timeout: 60_000 })
  await expect(comparison.getByRole('heading', { name: '词表差集' })).toBeVisible({ timeout: 60_000 })
  const tokenTable = /^Token 表，共 [\d,]+ 行$/
  await expect(comparison.getByRole('region', { name: '主侧' }).getByRole('table', { name: tokenTable })).toBeVisible({ timeout: 60_000 })
  await expect(right.getByRole('table', { name: tokenTable })).toBeVisible({ timeout: 60_000 })

  await comparison.getByRole('button', { name: '关闭对照' }).click()
  await expect(comparison).toHaveCount(0)
  await expect(result.locator('.tkp-stream-content')).toHaveText('Hello，世界 👋')

  expect({
    url: page.url(),
    historyLength: await page.evaluate(() => history.length),
    repositoryInput: await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).inputValue(),
    status: await page.locator('.repository-status').innerText(),
    detailHeader: await page.locator('.detail-header').innerText(),
    localStorageHistory: await page.evaluate(() => localStorage.getItem('model-files.repository-history')),
  }).toEqual(initialState)

  await openPlaygroundMode(page, 'Chat 对话')
  await expect(page.getByRole('region', { name: '送入 tokenizer 的文本', exact: true }).locator('pre'))
    .toContainText('解释一下：分词为什么会影响上下文长度？', { timeout: 60_000 })
  await expect(tokenizerMetric(page, 'Token 数量')).not.toHaveText('—', { timeout: 60_000 })

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
    tensorHierarchyMs,
  })
  console.log(`LIVE Qwen revision=${identity.sha} comparison revision=${comparisonIdentity.sha} tensorHierarchyMs=${tensorHierarchyMs} firstVocabularyQueryMs=${firstVocabularyQueryMs} cachedVocabularyQueryMs=${cachedVocabularyQueryMs} ranges=${JSON.stringify(requests.filter(request => request.range !== null))}`)
})

test('T5 Raw reports normalization as Decoded only', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const errors = collectErrors(page)
  const requests = collectRequests(page)
  const manifest = page.waitForResponse(response => response.url().includes('/api/models/google-t5/t5-small'))
  await page.goto('/?repo=google-t5%2Ft5-small&file=tokenizer.json')
  const identity = await (await manifest).json() as { sha: string }
  await expect(page.locator('.key-value-row').filter({ hasText: '模型类型' })).toBeVisible({ timeout: 60_000 })
  await openPlaygroundMode(page, '原始文本')
  const input = ' Hello   world '
  await page.getByRole('textbox', { name: '原始文本' }).fill(input)
  const result = page.getByRole('region', { name: '分词结果' })
  await expect(result).toContainText('tokenizer.json · Decoded only', { timeout: 60_000 })
  await expect(result.locator('.tkp-stream-content')).not.toHaveText(input)
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
  await expect(page.getByText('只读取了 24 字节 GGUF 文件前缀。')).toBeVisible({ timeout: 30_000 })
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

test('HTTPS direct file reads a public config without the Hub manifest API', async ({ page }) => {
  test.setTimeout(60_000)
  const errors = collectErrors(page)
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await page.goto('/')
  await page.getByRole('combobox', { name: '加载方式' }).selectOption('file')
  await page.getByRole('textbox', { name: 'HTTPS 地址' }).fill(
    'https://huggingface.co/Qwen/Qwen3-0.6B/resolve/main/config.json',
  )
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Qwen3ForCausalLM' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('qwen3 · bfloat16 · 28 layers')).toBeVisible()
  expect(requests.some(url => url.includes('/api/models/'))).toBe(false)
  expect(new URL(page.url()).search).toBe('')
  expect(errors).toEqual([])
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
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = message.text()
      if (text.includes('chrome://juggler') || text.includes('NS_BINDING_ABORTED')) return
      errors.push(text)
    }
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}
