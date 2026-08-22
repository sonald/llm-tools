export type RepositoryFile = {
  path: string
  size: number | null
  hash: string | null
  category: FileCategory
}

export type HuggingFaceSnapshot = {
  source: 'huggingface'
  modelId: string
  revision: string
  files: RepositoryFile[]
}

export type LocalDirectorySnapshot = {
  source: 'local'
  name: string
  revision: 'live'
  selectionId: string
  files: RepositoryFile[]
  localFiles: ReadonlyMap<string, File>
}

export type RepositorySnapshot = HuggingFaceSnapshot | LocalDirectorySnapshot

export type FileCategory =
  | 'configuration'
  | 'tokenizer'
  | 'templates'
  | 'weightMetadata'
  | 'documentation'
  | 'other'
  | 'weights'

type HubResponse = {
  id: string
  sha: string
  siblings: Array<{
    rfilename: string
    blobId?: string
    size?: number
    lfs?: { sha256?: string; size?: number }
  }>
}

const blockedExtensions = new Set([
  'safetensors', 'bin', 'pt', 'pth', 'ckpt', 'onnx', 'h5', 'msgpack', 'tflite', 'pb',
])

const revisionPattern = /^[0-9a-f]{40}$/i
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

export function normalizeModelId(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('https://huggingface.co/')) {
    const parts = new URL(trimmed).pathname.split('/').filter(Boolean)
    const modelId = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : ''
    if (modelIdPattern.test(modelId)) return modelId
  }
  if (modelIdPattern.test(trimmed)) return trimmed
  throw new Error('请输入 owner/model 或公开 Hugging Face 仓库 URL。')
}

export function classifyFile(path: string): FileCategory {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  const lowerPath = path.toLocaleLowerCase()
  const ext = name.split('.').at(-1) ?? ''
  if (isImatrixPath(path)) return 'weightMetadata'
  if (name.endsWith('.gguf') || name.endsWith('.gguf_file')) return 'weights'
  if (name.endsWith('.index.json') && (name.includes('safetensors') || name.includes('pytorch_model'))) {
    return 'weightMetadata'
  }
  if (blockedExtensions.has(ext)) return 'weights'
  if (name.endsWith('.pdf')) return 'documentation'
  if (name === 'config.json' || name === 'configuration.json' || name === 'generation_config.json'
    || name.endsWith('_config.json') && !name.includes('tokenizer')
      && !name.includes('processor') && !name.includes('preprocessor')) return 'configuration'
  if (name.includes('tokenizer') || name === 'vocab.json' || name === 'merges.txt'
    || name === 'special_tokens_map.json' || name.startsWith('added_tokens') || name.endsWith('.model')) return 'tokenizer'
  if (name.includes('template') || name.endsWith('.jinja') || lowerPath.includes('template')) return 'templates'
  if (name === 'readme.md' || name === 'license' || name.startsWith('license.')
    || name === 'notice' || name.endsWith('.md') || name.endsWith('.rst')) return 'documentation'
  return 'other'
}

const syntaxLanguages: Readonly<Record<string, string>> = {
  py: 'python',
  pyw: 'python',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  swift: 'swift',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  toml: 'toml',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
}

export function syntaxLanguage(path: string): string | null {
  const basename = path.split('/').at(-1) ?? ''
  const extensionStart = basename.lastIndexOf('.')
  if (extensionStart === -1) return null
  const extension = basename.slice(extensionStart + 1).toLocaleLowerCase()
  return syntaxLanguages[extension] ?? null
}

export function isImatrixPath(path: string): boolean {
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  return name.includes('imatrix') && (name.endsWith('.dat') || name.includes('.dat.at_'))
}

export async function loadRepository(input: string, signal?: AbortSignal): Promise<HuggingFaceSnapshot> {
  const modelId = normalizeModelId(input)
  const response = await fetch(`https://huggingface.co/api/models/${encodePath(modelId)}?blobs=true`, requestOptions(signal))
  if (!response.ok) throw new Error(`Hugging Face 清单请求失败：HTTP ${response.status}`)
  const payload = await response.json() as HubResponse
  if (typeof payload.id !== 'string' || normalizeModelId(payload.id).toLocaleLowerCase() !== modelId.toLocaleLowerCase()
    || typeof payload.sha !== 'string' || !revisionPattern.test(payload.sha) || !Array.isArray(payload.siblings)) {
    throw new Error('Hugging Face 清单格式无效。')
  }
  const files = payload.siblings.map((file): RepositoryFile => ({
    path: safeRepositoryPath(file.rfilename),
    size: safeSize(file.size ?? file.lfs?.size),
    hash: file.lfs?.sha256 ?? file.blobId ?? null,
    category: classifyFile(file.rfilename),
  }))
  return { source: 'huggingface', modelId: payload.id, revision: payload.sha, files: files.toSorted(compareFiles) }
}

export function loadLocalDirectory(selection: Iterable<File>): LocalDirectorySnapshot {
  const selected = []
  for (const file of selection) {
    if (selected.length === 100_000) throw new Error('本地目录超过 100,000 个文件上限。')
    selected.push(file)
  }
  if (selected.length === 0) throw new Error('没有选择本地目录。')

  const relativePaths = selected.map(file => safeRepositoryPath(file.webkitRelativePath))
  const name = relativePaths[0].split('/')[0]
  if (relativePaths.some(path => !path.startsWith(`${name}/`))) throw new Error('本地目录清单包含多个根目录。')

  const localFiles = new Map<string, File>()
  const files = selected.map((blob, index): RepositoryFile => {
    const path = safeRepositoryPath(relativePaths[index].slice(name.length + 1))
    if (new TextEncoder().encode(path).byteLength > 4096) throw new Error('本地文件路径超过 4 KiB 上限。')
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw new Error('本地文件大小无效。')
    if (localFiles.has(path)) throw new Error(`本地目录包含重复路径：${path}`)
    localFiles.set(path, blob)
    return { path, size: blob.size, hash: null, category: classifyFile(path) }
  })

  return {
    source: 'local',
    name,
    revision: 'live',
    selectionId: crypto.randomUUID(),
    files: files.toSorted(compareFiles),
    localFiles,
  }
}

export async function readWholeFile(
  snapshot: RepositorySnapshot,
  file: RepositoryFile,
  signal?: AbortSignal,
  maximumBytes = 32 * 1024 * 1024,
): Promise<ArrayBuffer> {
  if (file.size === null) throw new Error('来源没有提供文件大小，已拒绝全文读取。')
  if (file.size > maximumBytes) throw new Error(`文件超过 ${formatBytes(maximumBytes)} 阅读上限。`)
  if (snapshot.source === 'local') {
    const blob = localFile(snapshot, file)
    signal?.throwIfAborted()
    const data = await blob.arrayBuffer()
    signal?.throwIfAborted()
    if (data.byteLength !== file.size) throw new Error('本地文件已变化，请重新选择目录。')
    return data
  }
  const response = await fetch(contentUrl(snapshot, file), requestOptions(signal))
  if (!response.ok) throw new Error(`文件请求失败：HTTP ${response.status}`)
  const data = await readBounded(response, maximumBytes)
  if (data.byteLength !== file.size) throw new Error(`文件响应字节数为 ${data.byteLength}，与声明的 ${file.size} 不一致。`)
  return data
}

export async function readExactRange(
  snapshot: RepositorySnapshot,
  file: RepositoryFile,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error('Range 无效。')
  }
  if (file.size === null) throw new Error('来源没有提供文件大小，已拒绝 Range 读取。')
  if (end >= file.size) throw new Error('Range 超过来源声明的文件大小。')
  const expected = end - start + 1
  if (snapshot.source === 'local') {
    const blob = localFile(snapshot, file)
    signal?.throwIfAborted()
    const data = await blob.slice(start, end + 1).arrayBuffer()
    signal?.throwIfAborted()
    if (data.byteLength !== expected) throw new Error(`Range 短读：期望 ${expected}，收到 ${data.byteLength} bytes。`)
    return data
  }
  const response = await fetch(contentUrl(snapshot, file), {
    headers: { Range: `bytes=${start}-${end}` },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  })
  if (response.status !== 206) {
    throw new Error(`源站未确认 Range（HTTP ${response.status}），已停止以避免完整下载。`)
  }
  const contentRange = response.headers.get('Content-Range')
  if (contentRange !== `bytes ${start}-${end}/${file.size}`) {
    throw new Error(`源站 Content-Range 无效：${contentRange ?? '缺失'}。`)
  }
  const data = await readBounded(response, expected)
  if (data.byteLength !== expected) throw new Error(`Range 短读：期望 ${expected}，收到 ${data.byteLength} bytes。`)
  return data
}

export function contentUrl(snapshot: HuggingFaceSnapshot, file: RepositoryFile): string {
  const modelId = normalizeModelId(snapshot.modelId)
  if (!revisionPattern.test(snapshot.revision)) throw new Error('仓库 revision 无效。')
  return `https://huggingface.co/${encodePath(modelId)}/resolve/${snapshot.revision}/${encodePath(safeRepositoryPath(file.path))}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} bytes`
  const units = bytes < 1024 ** 2 ? ['KiB', 1024] : bytes < 1024 ** 3 ? ['MiB', 1024 ** 2] : ['GiB', 1024 ** 3]
  return `${(bytes / Number(units[1])).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${units[0]}`
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function requestOptions(signal?: AbortSignal): RequestInit {
  return { credentials: 'omit', referrerPolicy: 'no-referrer', signal }
}

function safeRepositoryPath(path: unknown): string {
  if (typeof path !== 'string' || path === '' || path.includes('\\')) throw new Error('仓库文件路径无效。')
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error('仓库文件路径无效。')
  return path
}

function safeSize(value: unknown): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('仓库文件大小无效。')
  return Number(value)
}

function localFile(snapshot: LocalDirectorySnapshot, file: RepositoryFile): File {
  const blob = snapshot.localFiles.get(file.path)
  if (blob === undefined || blob.size !== file.size) throw new Error('本地文件已变化，请重新选择目录。')
  return blob
}

async function readBounded(response: Response, maximumBytes: number): Promise<ArrayBuffer> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new Error(`响应超过 ${formatBytes(maximumBytes)} 阅读上限。`)
  }
  if (response.body === null) {
    const data = await response.arrayBuffer()
    if (data.byteLength > maximumBytes) throw new Error(`响应超过 ${formatBytes(maximumBytes)} 阅读上限。`)
    return data
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new Error(`响应超过 ${formatBytes(maximumBytes)} 阅读上限。`)
    }
    chunks.push(value)
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data.buffer
}

function compareFiles(left: RepositoryFile, right: RepositoryFile): number {
  const order: FileCategory[] = [
    'configuration', 'tokenizer', 'templates', 'weightMetadata', 'documentation', 'other', 'weights',
  ]
  return order.indexOf(left.category) - order.indexOf(right.category)
    || sortPriority(left.path) - sortPriority(right.path)
    || left.path.localeCompare(right.path, undefined, { numeric: true })
}

function sortPriority(path: string): number {
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  const preferred = [
    'config.json', 'configuration.json', 'generation_config.json',
    'tokenizer_config.json', 'tokenizer.json', 'vocab.json', 'merges.txt',
    'special_tokens_map.json', 'model.safetensors.index.json',
    'pytorch_model.bin.index.json', 'readme.md', 'license',
  ]
  const index = preferred.indexOf(name)
  return index === -1 ? preferred.length : index
}
