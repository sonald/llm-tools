import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.E2E_PORT ?? 5173)

export default defineConfig({
  testDir: './e2e',
  timeout: process.env.CI ? 60000 : 30000,
  retries: process.env.CI ? 2 : 0,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? join(tmpdir(), 'model-files-web-playwright'),
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', locale: 'zh-CN' } },
    { name: 'firefox', use: { browserName: 'firefox', locale: 'zh-CN' } },
    { name: 'webkit', use: { browserName: 'webkit', locale: 'zh-CN' } },
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
})
