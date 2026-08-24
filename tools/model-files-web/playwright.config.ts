import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? join(tmpdir(), 'model-files-web-playwright'),
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', locale: 'zh-CN' } },
    { name: 'firefox', use: { browserName: 'firefox', locale: 'zh-CN' } },
    { name: 'webkit', use: { browserName: 'webkit', locale: 'zh-CN' } },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
  },
})
