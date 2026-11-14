import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installFixtureRoutes,
  setLaunchInput,
  writeFixtureDirectory,
  openPlaygroundMode,
  expectRepository,
} from './fixtures.ts'

// A real cross-origin HTTPS server exercises browser CORS and exposed headers.
// The generated certificate is trusted only by these test browser contexts.
test.use({ ignoreHTTPSErrors: true })
let server: Server
let directory: string
let origin: string
let bodies: Map<string, Buffer>
let requests: Array<{ path: string; method: string; range?: string }>

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'model-files-https-'))
  const key = join(directory, 'key.pem')
  const cert = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  await writeFixtureDirectory(directory)
  const paths = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors', 'README.md']
  bodies = new Map(await Promise.all(paths.map(async path => [path, await readFile(join(directory, path))] as const)))
  bodies.set('README.md', Buffer.from('[Config](./config.json)'))
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    const url = new URL(req.url!, 'https://localhost')
    const path = url.pathname.slice(1)
    requests.push({ path, method: req.method!, range: req.headers.range })
    if (!url.searchParams.has('no-cors')) res.setHeader('Access-Control-Allow-Origin', '*')
    if (!url.searchParams.has('hidden-range')) res.setHeader('Access-Control-Expose-Headers', 'Content-Range')
    let body = bodies.get(path)
    if (path === 'files.json') body = Buffer.from(JSON.stringify({ files: [...bodies].map(([path, bytes]) => ({
      path, url: `./${path}`, size: bytes.length,
    })) }))
    if (body === undefined) { res.writeHead(404).end(); return }
    if (req.method === 'HEAD') {
      if (!url.searchParams.has('no-size')) res.setHeader('Content-Length', body.length)
      res.writeHead(200).end()
      return
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    if (match && !url.searchParams.has('ignore-range')) {
      const start = Number(match[1]); const end = Number(match[2])
      res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`)
      res.writeHead(206).end(body.subarray(start, end + 1))
      return
    }
    res.setHeader('Content-Length', body.length)
    res.writeHead(200).end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing HTTPS test port')
  origin = `https://127.0.0.1:${address.port}`
})

test.beforeEach(() => { requests = [] })
test.afterAll(async () => {
  server?.closeAllConnections()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function openHttps(page: Page, mode: 'file' | 'manifest', path: string) {
  await page.locator('.repository-form').getByRole('combobox', { name: '加载方式' }).selectOption(mode)
  await page.getByRole('textbox', { name: 'HTTPS 地址', exact: true }).fill(`${origin}/${path}`)
  await page.getByRole('button', { name: '打开', exact: true }).click()
}

test('HTTPS file opens exact SafeTensors header and keeps signed URL out of history', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await setLaunchInput(page)
  await page.goto('/')
  await expect(page).toHaveTitle('Model Files Web')
  await openHttps(page, 'file', 'model.safetensors?signature=session-only')
  await expect(page.getByText(/^只读取了 .+ JSON Header；没有请求 tensor 数据。$/)).toBeVisible()
  const headerEnd = 7 + Number(bodies.get('model.safetensors')!.readBigUInt64LE(0))
  expect(requests.filter(item => item.path === 'model.safetensors')).toEqual([
    { path: 'model.safetensors', method: 'HEAD', range: undefined },
    { path: 'model.safetensors', method: 'GET', range: 'bytes=0-7' },
    { path: 'model.safetensors', method: 'GET', range: `bytes=8-${headerEnd}` },
  ])
  expect(new URL(page.url()).search).toBe('')
  expect(await page.evaluate(() => localStorage.getItem('model-files.repository-history'))).toBeNull()
  // WebKit's screenshot preparation injects inline CSS blocked by the production CSP.
  if (testInfo.project.name === 'chromium') await page.screenshot({ caret: 'initial', path: join(tmpdir(), `model-files-https-${testInfo.project.name}.png`) })
  await page.setViewportSize({ width: 390, height: 844 })
  const submit = page.getByRole('button', { name: '打开', exact: true })
  await expect(submit).toBeInViewport()
  await expect(page.getByRole('textbox', { name: 'HTTPS 地址', exact: true })).toBeInViewport()
  // WebKit's screenshot preparation injects inline CSS blocked by the production CSP.
  if (testInfo.project.name === 'chromium') await page.screenshot({ caret: 'initial', path: join(tmpdir(), `model-files-https-mobile-${testInfo.project.name}.png`) })
  expect(errors).toEqual([])
})

test('HTTPS manifest reads related tokenizer files, Markdown links and a comparison source', async ({ page }) => {
  await setLaunchInput(page)
  await page.goto('/')
  await openHttps(page, 'manifest', 'files.json')
  await expectRepository(page, 'HTTPS · 实时来源', 5)
  await page.getByRole('button', { name: /^README\.md/ }).click()
  await expect(page.getByRole('link', { name: 'Config', exact: true })).toHaveAttribute('href', `${origin}/config.json`)
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await openPlaygroundMode(page, '原始文本')
  await page.getByRole('textbox', { name: '原始文本' }).fill('hello worlds')
  const result = page.getByRole('region', { name: '分词结果' })
  await expect(result.getByRole('button', { name: /文本 hello worlds，/ })).toBeVisible()
  await expect(result).toContainText('tokenizer.json · Exact')
  await page.getByRole('button', { name: '对照', exact: true }).click()
  await page.getByRole('menuitem', { name: '选择另一仓库…' }).click()
  const form = page.getByRole('form', { name: '另一仓库' })
  await form.getByRole('combobox', { name: '加载方式' }).selectOption('manifest')
  await form.getByRole('textbox', { name: '另一仓库' }).fill(`${origin}/files.json`)
  await form.getByRole('button', { name: '加载对照' }).click()
  const comparison = page.getByRole('region', { name: '对照', exact: true })
  const right = comparison.locator('.tkp-comparison-columns > section').nth(1)
  await expect(right.getByRole('heading')).toHaveText(/ · tokenizer\.json$/)
  await expect(right.getByRole('table', { name: 'Token 表，共 3 行' })).toBeVisible()
  await expect(comparison).toContainText('ID 序列相同')
  expect(requests.some(item => item.path === 'tokenizer_config.json')).toBe(true)
  expect(requests.some(item => item.path === 'model.safetensors')).toBe(false)
})

test('HTTPS explains missing CORS and size, rejects invalid ranges, then switches back to HF', async ({ page }) => {
  await setLaunchInput(page)
  await page.goto('/')
  await openHttps(page, 'file', 'config.json?no-cors')
  await expect(page.locator('.detail-body .empty-state')).toContainText('CORS')
  await openHttps(page, 'file', 'config.json?no-size')
  await expect(page.locator('.detail-body .empty-state')).toContainText('HEAD')
  for (const query of ['ignore-range', 'hidden-range']) {
    await openHttps(page, 'file', `model.safetensors?${query}`)
    await expect(page.getByRole('heading', { name: '无法读取文件' })).toBeVisible()
    await expect(page.locator('.detail-body')).toContainText(query === 'ignore-range' ? 'HTTP 200' : 'Content-Range')
  }
  expect(requests.filter(item => item.path === 'model.safetensors' && item.method === 'GET')).toEqual([
    { path: 'model.safetensors', method: 'GET', range: 'bytes=0-7' },
    { path: 'model.safetensors', method: 'GET', range: 'bytes=0-7' },
  ])
  await installFixtureRoutes(page)
  await page.locator('.repository-form').getByRole('combobox', { name: '加载方式' }).selectOption('huggingface')
  await page.getByRole('combobox', { name: 'Hugging Face 仓库' }).fill('fixture/model')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expectRepository(page, 'Hugging Face · main', 13)
})
