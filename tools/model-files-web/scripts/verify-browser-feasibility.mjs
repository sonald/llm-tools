import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit } from 'playwright'

const modelId = 'Qwen/Qwen3-0.6B'
const listingURL = `https://modelscope.cn/api/v1/models/${modelId}/repo/files?Revision=master&Recursive=true`
const localFixture = fileURLToPath(new URL('../../model-files/Tests/ModelFilesTests/Fixtures/Tokenizers', import.meta.url))

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>ModelFiles feasibility probe</title>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('无法启动本地浏览器探针。')
const origin = `http://127.0.0.1:${address.port}`

try {
  const engines = [chromium, firefox, webkit]
  const localDirectory = []
  for (const engine of engines) localDirectory.push(await probeLocalDirectory(engine))
  const modelScope = await probeModelScope(chromium)
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), modelScope, localDirectory }, null, 2))
} finally {
  server.close()
}

async function probeLocalDirectory(engine) {
  const browser = await engine.launch()
  try {
    const page = await browser.newPage()
    await page.setContent('<input id="directory" type="file" webkitdirectory multiple>')
    const input = page.locator('#directory')
    await input.setInputFiles(localFixture)
    const result = await input.evaluate(async element => {
      const files = [...(element.files ?? [])]
      const tokenizer = files.find(file => file.webkitRelativePath.endsWith('/bpe/tokenizer.json'))
      if (tokenizer === undefined) throw new Error('目录清单缺少 bpe/tokenizer.json。')
      const prefix = [...new Uint8Array(await tokenizer.slice(0, 8).arrayBuffer())]
      return {
        fileCount: files.length,
        directoryAttribute: element.hasAttribute('webkitdirectory'),
        relativePaths: files.map(file => file.webkitRelativePath).toSorted(),
        tokenizerSize: tokenizer.size,
        sliceBytes: prefix,
      }
    })
    return { engine: engine.name(), ok: true, ...result }
  } catch (error) {
    return { engine: engine.name(), ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await browser.close()
  }
}

async function probeModelScope(engine) {
  const browser = await engine.launch()
  try {
    const page = await browser.newPage()
    const consoleMessages = []
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleMessages.push(`${message.type()}: ${message.text()}`)
      }
    })
    await page.goto(origin)
    const result = await page.evaluate(async ({ listingURL, modelId }) => {
      const listingResponse = await fetch(listingURL, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (!listingResponse.ok) throw new Error(`清单 HTTP ${listingResponse.status}`)
      const root = await listingResponse.json()
      const payload = root.Data ?? root.data
      const files = payload?.Files ?? payload?.files
      if (!Array.isArray(files)) throw new Error('清单缺少 Files。')
      const config = files.find(file => (file.Path ?? file.path) === 'config.json')
      if (config === undefined) throw new Error('清单缺少 config.json。')
      const revision = config.Revision ?? config.revision
      const size = Number(config.Size ?? config.size)
      if (typeof revision !== 'string' || revision.length === 0 || !Number.isSafeInteger(size) || size <= 8) {
        throw new Error('config.json 的 revision 或 size 无效。')
      }
      const encodedModel = modelId.split('/').map(encodeURIComponent).join('/')
      const contentURL = `https://modelscope.cn/models/${encodedModel}/resolve/${encodeURIComponent(revision)}/config.json`
      const wholeResponse = await fetch(contentURL, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      const wholeText = wholeResponse.ok ? await wholeResponse.text() : ''
      const wholeJSON = wholeResponse.ok ? JSON.parse(wholeText) : null
      const rangeResponse = await fetch(contentURL, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Range: 'bytes=0-7' },
      })
      const contentRange = rangeResponse.headers.get('Content-Range')
      const rangeBytes = rangeResponse.status === 206 ? [...new Uint8Array(await rangeResponse.arrayBuffer())] : []
      return {
        listingStatus: listingResponse.status,
        revision,
        immutableRevision: /^[0-9a-f]{40}$/i.test(revision),
        declaredSize: size,
        wholeStatus: wholeResponse.status,
        wholeBytes: new TextEncoder().encode(wholeText).length,
        wholeJSON: wholeJSON !== null && typeof wholeJSON === 'object',
        rangeStatus: rangeResponse.status,
        contentRange,
        rangeBytes,
        contentURL,
      }
    }, { listingURL, modelId })
    return {
      engine: engine.name(),
      ok: result.immutableRevision
        && result.wholeStatus === 200
        && result.wholeJSON
        && result.rangeStatus === 206
        && result.contentRange === `bytes 0-7/${result.declaredSize}`
        && result.rangeBytes.length === 8,
      ...result,
      consoleMessages,
    }
  } catch (error) {
    return {
      engine: engine.name(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await browser.close()
  }
}
