import { expect, test, type Page } from '@playwright/test'
import {
  expandWeights,
  expectRepository,
  fixtureModelId,
  installFixtureRoutes,
  writeFixtureDirectory,
} from './fixtures.ts'

// Batch 6: native window toolbar (ContentView), sidebar (SidebarView) and launch behaviour (ModelFilesStore).

const repository = (page: Page) => page.getByRole('combobox', { name: 'Hugging Face 仓库' })
const open = (page: Page) => page.getByRole('button', { name: '打开', exact: true })

test('D-3 launch reopens the last input, defaults to Qwen/Qwen3-4B, and ?repo= wins', async ({ page }) => {
  // launchInput: null leaves storage alone, so the app sees a first launch.
  await installFixtureRoutes(page, { launchInput: null })
  const manifest = page.waitForRequest(request => request.url().includes('/api/models/Qwen/Qwen3-4B'))
  await page.goto('/')
  await manifest
  await expectRepository(page, 'Hugging Face · main', 13)
  await expect(repository(page)).toHaveValue('Qwen/Qwen3-4B')

  await repository(page).fill(fixtureModelId)
  await repository(page).press('Enter')
  // The route is pushed at submit; file= is written only once the repository has opened and been remembered.
  await expect(page).toHaveURL(url => url.searchParams.get('repo') === fixtureModelId && url.searchParams.get('file') === 'config.json')
  await page.goto('/')
  await expectRepository(page, 'Hugging Face · main', 13)
  await expect(repository(page)).toHaveValue(fixtureModelId)
  await expect(page).toHaveURL(url => url.searchParams.get('repo') === fixtureModelId)

  await page.goto('/?repo=fixture%2Fempty')
  await expectRepository(page, 'Hugging Face · main', 1)
  await expect(repository(page)).toHaveValue('fixture/empty')
})

test('D-3 launch opens nothing after a local directory, like native shouldOpenOnLaunch', async ({ page }, testInfo) => {
  const manifests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/models/')) manifests.push(request.url()) })
  await installFixtureRoutes(page, { launchInput: null })
  await page.goto(`/?repo=${encodeURIComponent(fixtureModelId)}`)
  await expectRepository(page, 'Hugging Face · main', 13)
  const directory = testInfo.outputPath('launch-local-fixture')
  await writeFixtureDirectory(directory)
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  await expectRepository(page, '本地 · 实时目录', 23)

  manifests.length = 0
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 2, name: '尚未打开模型' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(manifests).toEqual([])
})

test('S-1..S-4, S-9 toolbar copy, guidance, history-only list and icon folder button', async ({ page }) => {
  await installFixtureRoutes(page)
  await page.goto('/')
  await expect(page.locator('.brand')).toHaveText('Model Files')
  await expect(repository(page)).toHaveAttribute('placeholder', '模型 ID 或仓库 URL…')
  await expect(repository(page)).toHaveAttribute('title', '输入模型 ID 或仓库 URL')

  const guidance = page.getByRole('tooltip')
  await expect(guidance).toHaveCount(0)
  await repository(page).focus()
  await expect(guidance).toHaveText('模型仓库— Qwen/Qwen3-4B 或仓库 URL')
  await expect(repository(page)).toHaveAttribute('aria-describedby', 'repository-guidance')
  await repository(page).press('Escape')
  await expect(guidance).toHaveCount(0)
  await repository(page).pressSequentially('f')
  await expect(guidance).toBeVisible()
  await page.locator('.sidebar').click()
  await expect(guidance).toHaveCount(0)

  // Native NSComboBox lists history only; nothing is hard-coded.
  await expect(page.locator('#repository-history option')).toHaveCount(0)

  const folder = page.locator('label.directory-button')
  await expect(folder).toHaveText('')
  await expect(folder).toHaveAttribute('title', '选择本地模型目录')
  await expect(page.getByLabel('选择文件夹')).toHaveCount(1)
})

test('D-2 keeps every history entry; S-7 accepts http, www and any host case', async ({ page }) => {
  await installFixtureRoutes(page)
  await page.addInitScript(() => {
    if (localStorage.getItem('model-files.repository-history') !== null) return
    localStorage.setItem('model-files.repository-history',
      JSON.stringify(Array.from({ length: 12 }, (_, index) => `owner/model-${index}`)))
  })
  await page.goto('/')
  await expect(page.locator('#repository-history option')).toHaveCount(12)

  await repository(page).fill(`http://WWW.HuggingFace.co/${fixtureModelId}/tree/main`)
  await open(page).click()
  await expectRepository(page, 'Hugging Face · main', 13)
  await expect(repository(page)).toHaveValue(fixtureModelId)
  await expect(page.locator('#repository-history option')).toHaveCount(13)
  await expect(page.locator('#repository-history option').first()).toHaveAttribute('value', fixtureModelId)
})

test('S-5 Open is disabled while the manifest loads and Command/Ctrl+Return opens from anywhere', async ({ page }) => {
  await installFixtureRoutes(page, { manifestDelayMs: 400 })
  await page.goto('/')
  await repository(page).fill(fixtureModelId)
  await page.getByPlaceholder('筛选文件').focus()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(open(page)).toBeDisabled()
  await expect(open(page)).toHaveText('打开')
  await expectRepository(page, 'Hugging Face · main', 13)
  await expect(open(page)).toBeEnabled()
})

test('B-7 sidebar is 292 px, resizes within 255–360 and collapses', async ({ page }) => {
  await installFixtureRoutes(page)
  await page.goto('/')
  const sidebar = page.locator('.sidebar')
  const width = async () => (await sidebar.boundingBox())!.width
  expect(Math.round(await width())).toBe(292)

  const handle = page.locator('.workspace > .resize-x')
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + 200
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 200, y, { steps: 4 })
  await page.mouse.up()
  expect(Math.round(await width())).toBe(360)
  const moved = (await handle.boundingBox())!
  await page.mouse.move(moved.x + moved.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(moved.x - 300, y, { steps: 4 })
  await page.mouse.up()
  expect(Math.round(await width())).toBe(255)

  await page.getByRole('button', { name: '隐藏边栏' }).click()
  await expect(sidebar).toBeHidden()
  await expect(handle).toHaveCount(0)
  await page.getByRole('button', { name: '显示边栏' }).click()
  await expect(sidebar).toBeVisible()
})

test('B-8 local context menu opens the original file and keeps Copy Full Path disabled', async ({ page, context }, testInfo) => {
  await installFixtureRoutes(page)
  const directory = testInfo.outputPath('context-menu-fixture')
  await writeFixtureDirectory(directory)
  await page.goto('/')
  await page.getByLabel('选择文件夹').setInputFiles(directory)
  await expectRepository(page, '本地 · 实时目录', 23)

  await page.getByRole('button', { name: /^config\.json/ }).click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['打开原始文件', '复制全路径', '复制相对路径'])
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await expect(menu.getByRole('menuitem', { name: '复制全路径' })).toBeDisabled()
  // A real tab: blob URL + noopener + the inherited CSP, rendered as inert plain text.
  const popup = context.waitForEvent('page')
  await menu.getByRole('menuitem', { name: '打开原始文件' }).click()
  await expect(menu).toHaveCount(0)
  const tab = await popup
  expect(tab.url()).toMatch(/^blob:/)
  await expect(tab.locator('body')).toContainText('"model_type"')
  await tab.close()

  // Weights download (as their Hub resolve URL does) instead of rendering gigabytes as text.
  await expandWeights(page)
  // The menu closes on scroll, so let the sidebar settle before the right-click.
  const weightsRow = page.getByRole('button', { name: /^model\.safetensors\s/ })
  await weightsRow.scrollIntoViewIfNeeded()
  await expect.poll(() => weightsRow.evaluate(element => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.getBoundingClientRect().top)))))).toBeGreaterThan(0)
  await weightsRow.click({ button: 'right' })
  await expect(menu).toBeVisible()
  const download = page.waitForEvent('download')
  await menu.getByRole('menuitem', { name: '打开原始文件' }).click()
  expect((await download).suggestedFilename()).toBe('model.safetensors')

  // Hugging Face rows keep both items enabled and open the resolve URL.
  await page.evaluate(() => { window.open = url => { (window as unknown as { __openedUrl?: string }).__openedUrl = String(url); return null } })
  await repository(page).fill(fixtureModelId)
  await open(page).click()
  await expectRepository(page, 'Hugging Face · main', 13)
  await page.getByRole('button', { name: /^config\.json/ }).click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: '复制全路径' })).toBeEnabled()
  await menu.getByRole('menuitem', { name: '打开原始文件' }).click()
  expect(await page.evaluate(() => (window as unknown as { __openedUrl?: string }).__openedUrl))
    .toContain(`https://huggingface.co/${fixtureModelId}/resolve/`)
})
