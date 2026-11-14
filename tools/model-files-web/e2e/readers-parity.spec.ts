import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { openPerspective } from './fixtures.ts'

// Batch 5 reader parity: C-4 highlighting, C-5 find bar, C-6/C-7 Markdown, C-8 theme picker, C-9 image reader, D-7 CSP.

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

async function openReadersFixture(page: Page, testInfo: TestInfo) {
  const dir = testInfo.outputPath('readers-parity')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sample.py'), [
    '# comment line',
    'def run(flag=True, count=1):',
    '    return None',
  ].join('\n'))
  await writeFile(join(dir, 'sample.sh'), 'name=1\necho $name\n')
  await writeFile(join(dir, 'notes.txt'), 'alpha beta alphabet\nAlpha gamma alp\nbeta alpha\n')
  await writeFile(join(dir, 'README.md'), [
    '---',
    'license: apache-2.0',
    'tags: [front-matter-marker]',
    '---',
    '# Readers Fixture',
    '```python',
    `model = AutoModelForCausalLM.from_pretrained(${'"x", '.repeat(80)}device_map="auto")`,
    '```',
    '<p align="center"><img src="https://example.com/logo.png" alt="Logo" width="50"></p>',
    '<a href="https://example.com/docs">Docs link</a><br>next line',
    '<img src="https://example.com/x.png" alt="Evil" onerror="window.__pwned = 1">',
    '<a href="javascript:window.__pwned = 2">Script link</a>',
    '<img alt="x](javascript:alert(1))" src="https://example.com/y.png">',
    '<div onclick="window.__pwned = 3"><script>window.__pwned = 4</script>stripped</div>',
    '![Local](images/local.png)',
    '```html',
    '<b>kept in code</b>',
    '```',
  ].join('\n'))
  await writeFile(join(dir, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#3478f6"/></svg>')
  await page.route('https://example.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: onePixelPng }))
  await page.goto('/')
  await page.getByLabel('选择本地目录').setInputFiles(dir)
}

test('C-4 source tokens use native groups, bold only keyword/boolean/literal, comments upright', async ({ page }, testInfo) => {
  await openReadersFixture(page, testInfo)
  await page.getByRole('button', { name: /^sample\.py/ }).click()
  const reader = page.locator('.source-reader[data-highlighted="true"]')
  await expect(reader.locator('.token.keyword').first()).toBeVisible()
  const style = (selector: string) => reader.locator(selector).first().evaluate(element => {
    const computed = getComputedStyle(element)
    return { weight: Number(computed.fontWeight), italic: computed.fontStyle === 'italic', color: computed.color }
  })
  expect((await style('.token.keyword')).weight).toBeGreaterThanOrEqual(600)
  expect((await style('.token.boolean')).weight).toBeGreaterThanOrEqual(600)
  expect((await style('.token.number')).weight).toBeLessThan(600)
  expect((await style('.token.comment')).italic).toBe(false)
  // The literal group colour is shared by boolean and number; only the weight differs.
  expect((await style('.token.boolean')).color).toBe((await style('.token.number')).color)

  await page.getByRole('button', { name: /^sample\.sh/ }).click()
  // Prism bash "variable" is in native's name group (was "other" before).
  await expect(reader.locator('.token.variable.source-syntax-name').first()).toBeVisible()
})

test('C-5 find bar: native layout, options menu, count, ⌘G and no focus needed', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const log: Array<{ key: string; prevented: boolean; cancelable: boolean }> = []
    ;(window as unknown as { __keys: typeof log }).__keys = log
    window.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey) log.push({ key: event.key, prevented: event.defaultPrevented, cancelable: event.cancelable })
    })
  })
  await openReadersFixture(page, testInfo)
  const row = page.getByRole('button', { name: /^notes\.txt/ })
  await row.click()
  const reader = page.locator('.source-reader.plain-text')
  await expect(reader).toContainText('alphabet')
  // Focus stays on the sidebar row: native's find bar opens through performKeyEquivalent without focus.
  await row.focus()
  await page.keyboard.press('ControlOrMeta+f')
  const search = page.getByRole('search', { name: '当前文件查找' })
  const field = search.getByRole('textbox', { name: '当前文件查找' })
  await expect(field).toBeFocused()
  await expect(field).toHaveAttribute('placeholder', '查找')
  await expect(search.getByRole('button', { name: '完成' })).toBeVisible()
  const box = await search.boundingBox()
  expect(box?.height).toBeLessThanOrEqual(40)

  await field.fill('alpha')
  const count = search.locator('.find-count')
  await expect(count).toHaveText('4')
  const current = reader.locator('mark.current')
  await expect(current).toHaveText('alpha')

  // ⌘G / ⇧⌘G step through hits from anywhere in the page.
  await row.focus()
  await page.keyboard.press('ControlOrMeta+g')
  await expect(current).toHaveText('alpha')
  await expect(reader.locator('mark.find-match').nth(1)).toHaveClass(/current/)
  await page.keyboard.press('ControlOrMeta+Shift+g')
  await expect(reader.locator('mark.find-match').nth(0)).toHaveClass(/current/)

  const menuButton = search.getByRole('button', { name: '查找菜单' })
  const choose = async (name: string) => {
    await menuButton.click()
    await page.getByRole('menu', { name: '查找菜单' }).getByRole(/^(整个词|开头是|包含)$/.test(name) ? 'menuitemradio' : 'menuitemcheckbox', { name }).click()
  }
  await menuButton.click()
  const menu = page.getByRole('menu', { name: '查找菜单' })
  await expect(menu.getByRole('menuitemcheckbox', { name: '忽略大小写' })).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('menuitemcheckbox', { name: '循环查找' })).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('menuitemradio', { name: '包含' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(search).toBeVisible()

  await choose('整个词')
  await expect(count).toHaveText('3')
  await field.fill('alp')
  await expect(count).toHaveText('1')
  await choose('开头是')
  await expect(count).toHaveText('5')
  await field.fill('pha')
  await expect(count).toHaveText('0')
  await choose('包含')
  await expect(count).toHaveText('4')
  await field.fill('alpha')
  await choose('忽略大小写')
  await expect(count).toHaveText('3')

  // 循环查找 off: the last hit stays current.
  await choose('循环查找')
  const next = search.getByRole('button', { name: '查找文本出现的下一个位置' })
  await expect(next).toHaveAttribute('title', '查找文本出现的下一个位置')
  for (let index = 0; index < 4; index += 1) await next.click()
  await expect(reader.locator('mark.find-match').nth(2)).toHaveClass(/current/)

  await search.getByRole('button', { name: '完成' }).click()
  await expect(search).toHaveCount(0)

  // Engine evidence: the page sees ⌘F/⌘G as cancelable keydowns and cancels them (Playwright input skips browser chrome).
  const keys = await page.evaluate(() => (window as unknown as { __keys: Array<{ key: string; prevented: boolean; cancelable: boolean }> }).__keys)
  const handled = keys.filter(entry => ['f', 'g', 'G'].includes(entry.key))
  testInfo.annotations.push({ type: 'find-shortcuts', description: JSON.stringify(handled) })
  expect(handled.length).toBeGreaterThanOrEqual(3)
  for (const entry of handled) expect(entry).toMatchObject({ cancelable: true, prevented: true })
})

test('C-6/C-7/C-8/D-7 Markdown: front matter, inline HTML as native, segmented theme, HTTPS images', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openReadersFixture(page, testInfo)
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("img-src 'self' data: blob: https:;")
  expect(csp).toContain("script-src 'self' https://static.cloudflareinsights.com;")

  await page.getByRole('button', { name: /^README\.md/ }).click()
  const body = page.locator('.markdown-body')
  await expect(page.getByRole('heading', { name: 'Readers Fixture' })).toBeVisible()
  await expect(body).not.toContainText('front-matter-marker')
  await expect(body).not.toContainText('license')

  const logo = body.locator('img[alt="Logo"]')
  await expect(logo).toHaveAttribute('src', 'https://example.com/logo.png#model-files-width=50px')
  await expect.poll(() => logo.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  expect(await logo.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(50, 0)
  await expect(body.getByRole('link', { name: 'Docs link' })).toHaveAttribute('href', 'https://example.com/docs')
  await expect(body).toContainText('next line')
  await expect(body.getByRole('link', { name: 'Script link' })).toHaveCount(0)
  expect(await body.evaluate(element => [...element.querySelectorAll('[onerror], [onclick], script, iframe, div[align], p[align]')]
    .map(match => match.outerHTML))).toEqual([])
  await expect(body).toContainText('stripped')
  // Alt text cannot smuggle a javascript: URL into an image or link.
  await expect(body.locator('img[src^="javascript"], a[href^="javascript"]')).toHaveCount(0)
  // Not HTTPS (a local relative image): native leaves the alt text.
  await expect(body.locator('img[alt="Local"]')).toHaveCount(0)
  await expect(body).toContainText('Local')
  await expect(body.locator('pre').last()).toContainText('<b>kept in code</b>')
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()

  // Native MarkdownReaderView header: "Markdown", visible 排版主题 and a segmented control (not a select).
  await expect(page.locator('.markdown-card select')).toHaveCount(0)
  const header = page.locator('.markdown-header')
  await expect(header).toContainText('Markdown')
  await expect(header).toContainText('排版主题')
  const theme = page.getByRole('group', { name: 'Markdown 排版主题' })
  await expect(theme.getByRole('button')).toHaveText(['GitHub', '默认', '紧凑'])
  await expect(theme.getByRole('button', { name: 'GitHub' })).toHaveAttribute('aria-pressed', 'true')
  await theme.getByRole('button', { name: '默认' }).click()
  await expect(theme.getByRole('button', { name: '默认' })).toHaveAttribute('aria-pressed', 'true')
  await expect(body).toHaveClass(/markdown-default/)

  // 全部字段 / 原文 stay plain text with the front matter (DV plainTextSurface).
  await openPerspective(page, '原文')
  await expect(page.locator('.source-reader.plain-text')).toContainText('front-matter-marker')
  expect(errors).toEqual([])
})

test('C-9 image reader: native toolbar, 1:1, 0.25 steps within 25–500%, real-size scrolling', async ({ page }, testInfo) => {
  await openReadersFixture(page, testInfo)
  await page.getByRole('button', { name: /^wide\.svg/ }).click()
  const stats = page.locator('.image-stats')
  await expect(stats).toHaveText(/^400 × 300 px·SVG·\d+ 字节$/)
  const fit = page.getByRole('button', { name: '适应窗口' })
  const actual = page.getByRole('button', { name: '1:1' })
  const zoomIn = page.getByRole('button', { name: '放大' })
  const zoomOut = page.getByRole('button', { name: '缩小' })
  const percent = page.locator('.zoom-percentage')
  const image = page.locator('.inspected-image')
  const viewport = page.locator('.image-viewport')
  await expect(fit).toHaveAttribute('aria-pressed', 'true')
  await expect(percent).toHaveText('100%')
  await expect(zoomIn).toHaveAttribute('title', '放大')

  await actual.click()
  await expect(actual).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(400, 0)
  await zoomIn.click()
  await expect(percent).toHaveText('125%')
  await expect(actual).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(500, 0)
  for (let index = 0; index < 20; index += 1) await zoomIn.click()
  await expect(percent).toHaveText('500%')
  await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(2000, 0)
  // Real layout size, not a transform: the viewport scrolls and its top-left corner is reachable.
  const reach = await viewport.evaluate(element => {
    element.scrollTo(0, 0)
    const img = element.querySelector('img')!.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    return {
      scrolls: element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight,
      left: img.left - box.left, top: img.top - box.top,
      transform: getComputedStyle(element.querySelector('img')!).transform,
    }
  })
  expect(reach.scrolls).toBe(true)
  expect(reach.left).toBeGreaterThanOrEqual(0)
  expect(reach.top).toBeGreaterThanOrEqual(0)
  expect(reach.transform).toBe('none')
  for (let index = 0; index < 25; index += 1) await zoomOut.click()
  await expect(percent).toHaveText('25%')
  await fit.click()
  await expect(percent).toHaveText('100%')
  await expect(fit).toHaveAttribute('aria-pressed', 'true')
})

for (const width of [1440, 1280, 1024, 390]) {
  test(`reader toolbars fit a ${width} px window`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 })
    await openReadersFixture(page, testInfo)
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    await page.getByRole('button', { name: /^notes\.txt/ }).click()
    await expect(page.locator('.source-reader')).toContainText('alphabet')
    await page.keyboard.press('ControlOrMeta+f')
    await expect(page.getByRole('search', { name: '当前文件查找' })).toBeVisible()
    await page.getByRole('button', { name: '查找菜单' }).click()
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^wide\.svg/ }).click()
    await expect(page.locator('.image-toolbar')).toBeVisible()
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: /^README\.md/ }).click()
    await expect(page.locator('.markdown-header')).toBeVisible()
    expect(await overflow()).toBeLessThanOrEqual(0)
    // The card's grid column must not grow to the content's 920 px cap inside a narrower reader.
    expect(await page.locator('.reader-canvas').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
  })
}
