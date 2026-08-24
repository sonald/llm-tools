import { expect, test } from '@playwright/test'
import { installFixtureRoutes, fixtureModelId } from './fixtures.ts'

test.use({ locale: 'en-US' })

test('runs the core repository and tokenizer entry points in English', async ({ page }) => {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  const requests = await installFixtureRoutes(page)
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('combobox', { name: 'Hugging Face repository' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open' })).toBeVisible()

  await page.getByRole('combobox', { name: 'Hugging Face repository' }).fill(fixtureModelId)
  await page.getByRole('button', { name: 'Open' }).click()
  await expect(page.getByText(/Public repository · SHA 0123456 · 13 files/)).toBeVisible()
  await page.getByRole('button', { name: /^tokenizer\.json/ }).click()
  await expect(page.getByText('Model Type').locator('..')).toContainText('WordPiece')
  await expect(page.getByRole('tab', { name: 'Raw workbench' })).toBeVisible()
  await page.getByRole('tab', { name: 'Raw workbench' }).click()
  await expect(page.getByRole('textbox', { name: 'Raw input' })).toBeVisible()

  expect(requests.filter(request => request.path === 'config.json')).toHaveLength(1)
  expect(errors).toEqual([])
})
