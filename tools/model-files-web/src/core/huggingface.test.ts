import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyFile,
  loadLocalDirectory,
  loadRepository,
  normalizeModelId,
  readExactRange,
  readWholeFile,
  syntaxLanguage,
  type RepositoryFile,
  type RepositorySnapshot,
} from './huggingface.ts'

const snapshot: RepositorySnapshot = {
  source: 'huggingface',
  modelId: 'owner/model',
  revision: '0123456789abcdef0123456789abcdef01234567',
  files: [],
}

test('builds a bounded local snapshot and reads exact local bytes', async () => {
  const config = localFile('Fixture/config.json', '{"ok":true}')
  const nested = localFile('Fixture/a/config.json', 'nested')
  const result = loadLocalDirectory([nested, config])

  assert.equal(result.source, 'local')
  assert.equal(result.name, 'Fixture')
  assert.deepEqual(result.files.map(item => item.path), ['a/config.json', 'config.json'])
  assert.equal(new TextDecoder().decode(await readWholeFile(result, result.files[1])), '{"ok":true}')
  assert.deepEqual([...new Uint8Array(await readExactRange(result, result.files[1], 2, 5))], [111, 107, 34, 58])
})

test('rejects unsafe, duplicate, multi-root, and oversized local paths', () => {
  assert.throws(() => loadLocalDirectory([localFile('Fixture/../secret', 'x')]), /路径无效/)
  assert.throws(() => loadLocalDirectory([
    localFile('Fixture/config.json', 'one'),
    localFile('Fixture/config.json', 'two'),
  ]), /重复路径/)
  assert.throws(() => loadLocalDirectory([
    localFile('One/config.json', 'one'),
    localFile('Two/config.json', 'two'),
  ]), /多个根目录/)
  assert.throws(() => loadLocalDirectory([localFile(`Fixture/${'a'.repeat(4097)}`, 'x')]), /4 KiB/)
})

const file: RepositoryFile = {
  path: 'weights/model.safetensors',
  size: 100,
  hash: null,
  category: 'weights',
}

test('normalizes only owner/model identifiers and Hugging Face model URLs', () => {
  assert.equal(normalizeModelId(' owner/model '), 'owner/model')
  assert.equal(normalizeModelId('https://huggingface.co/owner/model/tree/main'), 'owner/model')
  assert.throws(() => normalizeModelId('https://huggingface.co/owner/%E4%B8%AD%E6%96%87'), /owner\/model/)
  assert.throws(() => normalizeModelId('https://huggingface.co.evil/owner/model'), /owner\/model/)
  assert.throws(() => normalizeModelId('../owner/model'), /owner\/model/)
})

test('matches native file intent classification and reader-friendly ordering', async () => {
  assert.equal(classifyFile('tokenizer_config.json'), 'tokenizer')
  for (const path of [
    'adapter_config.json',
    'nested/adapter_config.json',
    'preprocessor_config.json',
    'nested/preprocessor_config.json',
    'processor_config.json',
    'nested/processor_config.json',
  ]) {
    assert.equal(classifyFile(path), 'configuration')
  }
  assert.equal(classifyFile('pytorch_model.bin.index.json'), 'weightMetadata')
  assert.equal(classifyFile('imatrix_unsloth.dat.at_00000'), 'weightMetadata')
  assert.equal(classifyFile('imatrix_unsloth.gguf_file'), 'weights')
  assert.equal(classifyFile('templates/default/value.txt'), 'templates')
  assert.equal(classifyFile('LICENSE.apache'), 'documentation')
  assert.equal(classifyFile('templates/guide.pdf'), 'documentation')

  const local = loadLocalDirectory([
    localFile('Fixture/merges.txt', ''),
    localFile('Fixture/tokenizer.json', '{}'),
    localFile('Fixture/tokenizer_config.json', '{}'),
  ])
  assert.deepEqual(local.files.map(item => item.path), ['tokenizer_config.json', 'tokenizer.json', 'merges.txt'])
})

test('maps exhaustive syntax extensions to exact Prism language IDs', () => {
  assert.deepEqual(
    ['py', 'pyw'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(2).fill('python'),
  )
  assert.deepEqual(
    ['js', 'javascript', 'mjs', 'cjs'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(4).fill('javascript'),
  )
  assert.equal(syntaxLanguage('example.jsx'), 'jsx')
  assert.deepEqual(
    ['ts', 'mts', 'cts'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(3).fill('typescript'),
  )
  assert.equal(syntaxLanguage('example.tsx'), 'tsx')
  assert.deepEqual(
    ['sh', 'bash', 'zsh'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(3).fill('bash'),
  )
  assert.equal(syntaxLanguage('example.swift'), 'swift')
  assert.equal(syntaxLanguage('example.rs'), 'rust')
  assert.equal(syntaxLanguage('example.go'), 'go')
  assert.deepEqual(
    ['c', 'h'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(2).fill('c'),
  )
  assert.deepEqual(
    ['cc', 'cpp', 'cxx', 'hpp'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(4).fill('cpp'),
  )
  assert.equal(syntaxLanguage('example.java'), 'java')
  assert.deepEqual(
    ['kt', 'kts'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(2).fill('kotlin'),
  )
  assert.equal(syntaxLanguage('example.rb'), 'ruby')
  assert.equal(syntaxLanguage('example.php'), 'php')
  assert.equal(syntaxLanguage('example.lua'), 'lua')
  assert.deepEqual(
    ['yaml', 'yml'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(2).fill('yaml'),
  )
  assert.equal(syntaxLanguage('example.json'), 'json')
  assert.equal(syntaxLanguage('example.toml'), 'toml')
  assert.equal(syntaxLanguage('example.sql'), 'sql')
  assert.equal(syntaxLanguage('example.css'), 'css')
  assert.equal(syntaxLanguage('example.scss'), 'scss')
  assert.equal(syntaxLanguage('example.sass'), 'sass')
  assert.equal(syntaxLanguage('example.less'), 'less')
  assert.deepEqual(
    ['html', 'htm', 'xml', 'svg'].map(extension => syntaxLanguage(`example.${extension}`)),
    Array<string>(4).fill('markup'),
  )
  assert.equal(syntaxLanguage('example.unknown'), null)
  assert.equal(syntaxLanguage('json'), null)
})

test('loads a public repository without credentials and pins safe files to its revision', async () => {
  const controller = new AbortController()
  await withFetch(async (input, init) => {
    assert.equal(String(input), 'https://huggingface.co/api/models/owner/model?blobs=true')
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.referrerPolicy, 'no-referrer')
    assert.equal(init?.signal, controller.signal)
    return Response.json({
      id: 'owner/model',
      sha: snapshot.revision,
      siblings: [{ rfilename: 'config.json', size: 12, blobId: 'blob' }],
    })
  }, async () => {
    const result = await loadRepository('owner/model', controller.signal)
    assert.equal(result.revision, snapshot.revision)
    assert.deepEqual(result.files.map(item => item.path), ['config.json'])
  })
})

test('rejects unsafe repository paths from the Hub manifest', async () => {
  await withFetch(async () => Response.json({
    id: 'owner/model',
    sha: snapshot.revision,
    siblings: [{ rfilename: '../secret', size: 1 }],
  }), async () => {
    await assert.rejects(loadRepository('owner/model'), /文件路径无效/)
  })
})

test('reads an exact confirmed range without credentials', async () => {
  const controller = new AbortController()
  await withFetch(async (input, init) => {
    assert.equal(String(input), `https://huggingface.co/owner/model/resolve/${snapshot.revision}/weights/model.safetensors`)
    assert.equal(new Headers(init?.headers).get('Range'), 'bytes=8-15')
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.referrerPolicy, 'no-referrer')
    assert.equal(init?.signal, controller.signal)
    return new Response(new Uint8Array(8), {
      status: 206,
      headers: { 'Content-Range': 'bytes 8-15/100' },
    })
  }, async () => {
    assert.equal((await readExactRange(snapshot, file, 8, 15, controller.signal)).byteLength, 8)
  })
})

test('rejects HTTP 200, wrong Content-Range, and short range responses', async () => {
  await withFetch(async () => new Response(new Uint8Array(8), { status: 200 }), async () => {
    await assert.rejects(readExactRange(snapshot, file, 8, 15), /未确认 Range/)
  })
  await withFetch(async () => new Response(new Uint8Array(8), {
    status: 206,
    headers: { 'Content-Range': 'bytes 0-7/100' },
  }), async () => {
    await assert.rejects(readExactRange(snapshot, file, 8, 15), /Content-Range/)
  })
  await withFetch(async () => new Response(new Uint8Array(7), {
    status: 206,
    headers: { 'Content-Range': 'bytes 8-15/100' },
  }), async () => {
    await assert.rejects(readExactRange(snapshot, file, 8, 15), /Range 短读/)
  })
})

test('refuses unknown or out-of-bounds ranges before fetching', async () => {
  const unknown = { ...file, size: null }
  await withFetch(async () => {
    assert.fail('fetch must not run')
  }, async () => {
    await assert.rejects(readExactRange(snapshot, unknown, 0, 7), /文件大小/)
    await assert.rejects(readExactRange(snapshot, file, 96, 103), /文件大小/)
  })
})

test('enforces whole-file limits before and after the response', async () => {
  await withFetch(async () => {
    assert.fail('fetch must not run')
  }, async () => {
    await assert.rejects(readWholeFile(snapshot, { ...file, size: 33 }, undefined, 32), /阅读上限/)
  })
  await withFetch(async (_input, init) => {
    assert.equal(init?.credentials, 'omit')
    return new Response(new Uint8Array(33))
  }, async () => {
    await assert.rejects(readWholeFile(snapshot, { ...file, size: 32 }, undefined, 32), /响应超过/)
  })
})

test('rejects a whole-file response whose byte length differs from its size', async () => {
  await withFetch(async () => new Response(new Uint8Array(99)), async () => {
    await assert.rejects(readWholeFile(snapshot, { ...file, size: 100 }), /字节/)
  })
})

async function withFetch(
  replacement: typeof fetch,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = replacement
  try {
    await body()
  } finally {
    globalThis.fetch = original
  }
}

function localFile(relativePath: string, content: string): File {
  const file = new File([content], relativePath.split('/').at(-1) ?? 'file')
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}
