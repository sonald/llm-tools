import { expect, test } from '@playwright/test'
import {
  installFixtureRoutes,
  fixtureModelId,
  openPlaygroundMode,
  expectRepository,
} from './fixtures.ts'

test.use({ locale: 'en-US' })

test('runs the core repository and tokenizer entry points in English', async ({ page }) => {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = message.text()
      if (text.includes('chrome://juggler') || text.includes('NS_BINDING_ABORTED')) return
      errors.push(text)
    }
  })
  page.on('pageerror', error => errors.push(error.message))
  const requests = await installFixtureRoutes(page)
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('combobox', { name: 'Hugging Face repository' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible()

  await page.getByRole('combobox', { name: 'Hugging Face repository' }).fill(fixtureModelId)
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await expectRepository(page, 'Hugging Face · main · SHA', 13)
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await expect(page.locator('.key-value-row').filter({ hasText: 'Model type' })).toContainText('WordPiece')
  await expect(page.getByRole('region', { name: 'Vocabulary search' }).getByText('Enter a token or decimal ID to search.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Reading view' }).getByRole('button', { name: 'Playground', exact: true })).toBeVisible()
  await openPlaygroundMode(page, 'Raw text', 'Playground')
  const modes = page.getByRole('group', { name: 'Input mode' })
  await expect(modes.getByRole('button')).toHaveText(['Raw text', 'Chat conversation', 'Token IDs'])
  await page.getByRole('textbox', { name: 'Raw text' }).fill('hello worlds')
  const result = page.getByRole('region', { name: 'Tokenization result' })
  await expect(result.getByRole('button', { name: 'Token 0 through 2, IDs 3, 4, 5, text hello worlds, role None' })).toBeVisible()
  await expect(page.locator('.tkp-metric').filter({ hasText: 'Token count' }).locator('strong')).toHaveText('3')
  await expect(result.getByRole('checkbox', { name: 'Show whitespace' })).not.toBeChecked()
  await expect(page.getByRole('table', { name: /^Token table, 3 rows$/ })).toBeVisible()

  expect(requests.filter(request => request.path === 'config.json')).toHaveLength(1)
  expect(errors).toEqual([])
})
