import { formatNumber, translate as t } from '../i18n.ts'

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
  throw new Error(t('huggingfaceModelIdRequired'))
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
    || name.endsWith('_config.json') && !name.includes('tokenizer')) return 'configuration'
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
  if (!response.ok) throw new Error(t('huggingfaceManifestRequestFailed', { status: response.status }))
  const payload = await response.json() as HubResponse
  if (typeof payload.id !== 'string' || normalizeModelId(payload.id).toLocaleLowerCase() !== modelId.toLocaleLowerCase()
    || typeof payload.sha !== 'string' || !revisionPattern.test(payload.sha) || !Array.isArray(payload.siblings)) {
    throw new Error(t('huggingfaceManifestInvalid'))
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
    if (selected.length === 100_000) throw new Error(t('localDirectoryFileLimitExceeded', { limit: "100,000" }))
    selected.push(file)
  }
  if (selected.length === 0) throw new Error(t('localDirectoryNotSelected'))

  const relativePaths = selected.map(file => safeRepositoryPath(file.webkitRelativePath))
  const name = relativePaths[0].split('/')[0]
  if (relativePaths.some(path => !path.startsWith(`${name}/`))) throw new Error(t('localDirectoryMultipleRoots'))

  const localFiles = new Map<string, File>()
  const files = selected.map((blob, index): RepositoryFile => {
    const path = safeRepositoryPath(relativePaths[index].slice(name.length + 1))
    if (new TextEncoder().encode(path).byteLength > 4096) throw new Error(t('localFilePathTooLarge', { limit: '4 KiB' }))
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw new Error(t('localFileSizeInvalid'))
    if (localFiles.has(path)) throw new Error(t('duplicateRepositoryPath', { path }))
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

const wholeFileCache = new WeakMap<RepositorySnapshot, Map<string, ArrayBuffer>>()

export async function readWholeFile(
  snapshot: RepositorySnapshot,
  file: RepositoryFile,
  signal?: AbortSignal,
  maximumBytes = 32 * 1024 * 1024,
): Promise<ArrayBuffer> {
  if (file.size === null) throw new Error(t('fileSizeUnavailableForWholeRead'))
  if (file.size > maximumBytes) throw new Error(t('wholeFileLimitExceeded', { limit: formatBytes(maximumBytes) }))
  signal?.throwIfAborted()
  const cached = wholeFileCache.get(snapshot)?.get(file.path)
  if (cached !== undefined) {
    signal?.throwIfAborted()
    return cached.slice(0)
  }
  const data = await readUncachedWholeFile(snapshot, file, maximumBytes, signal)
  signal?.throwIfAborted()
  if (data.byteLength !== file.size) {
    throw new Error(t('wholeFileSizeMismatch', { actual: data.byteLength, expected: file.size }))
  }
  const cache = wholeFileCache.get(snapshot) ?? new Map()
  cache.set(file.path, data)
  wholeFileCache.set(snapshot, cache)
  return data.slice(0)
}

async function readUncachedWholeFile(
  snapshot: RepositorySnapshot,
  file: RepositoryFile,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (snapshot.source === 'local') {
    const blob = localFile(snapshot, file)
    signal?.throwIfAborted()
    const data = await blob.arrayBuffer()
    signal?.throwIfAborted()
    if (data.byteLength !== file.size) throw new Error(t('changedLocalFile'))
    return data
  }
  const response = await fetch(contentUrl(snapshot, file), requestOptions(signal))
  if (!response.ok) throw new Error(t('fileRequestFailed', { status: response.status }))
  return await readBounded(response, maximumBytes)
}

export async function readExactRange(
  snapshot: RepositorySnapshot,
  file: RepositoryFile,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error(t('rangeInvalid'))
  }
  if (file.size === null) throw new Error(t('fileSizeUnavailableForRangeRead'))
  if (end >= file.size) throw new Error(t('rangeExceedsDeclaredSize'))
  const expected = end - start + 1
  if (snapshot.source === 'local') {
    const blob = localFile(snapshot, file)
    signal?.throwIfAborted()
    const data = await blob.slice(start, end + 1).arrayBuffer()
    signal?.throwIfAborted()
    if (data.byteLength !== expected) throw new Error(t('rangeShortRead', { actual: data.byteLength, expected }))
    return data
  }
  const response = await fetch(contentUrl(snapshot, file), {
    headers: { Range: `bytes=${start}-${end}` },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  })
  if (response.status !== 206) {
    throw new Error(t('rangeNotConfirmed', { status: response.status }))
  }
  const contentRange = response.headers.get('Content-Range')
  if (contentRange !== `bytes ${start}-${end}/${file.size}`) {
    throw new Error(t('contentRangeInvalid', { contentRange: contentRange ?? t('statusMissing') }))
  }
  const data = await readBounded(response, expected)
  if (data.byteLength !== expected) throw new Error(t('rangeShortRead', { actual: data.byteLength, expected }))
  return data
}

export function contentUrl(snapshot: HuggingFaceSnapshot, file: RepositoryFile): string {
  const modelId = normalizeModelId(snapshot.modelId)
  if (!revisionPattern.test(snapshot.revision)) throw new Error(t('repositoryRevisionInvalid'))
  return `https://huggingface.co/${encodePath(modelId)}/resolve/${snapshot.revision}/${encodePath(safeRepositoryPath(file.path))}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} bytes`
  const units = bytes < 1024 ** 2 ? ['KiB', 1024] : bytes < 1024 ** 3 ? ['MiB', 1024 ** 2] : ['GiB', 1024 ** 3]
  return `${formatNumber(bytes / Number(units[1]), { maximumFractionDigits: 1 })} ${units[0]}`
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function requestOptions(signal?: AbortSignal): RequestInit {
  return { credentials: 'omit', referrerPolicy: 'no-referrer', signal }
}

function safeRepositoryPath(path: unknown): string {
  if (typeof path !== 'string' || path === '' || path.includes('\\')) throw new Error(t('invalidRepositoryPath'))
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(t('invalidRepositoryPath'))
  return path
}

function safeSize(value: unknown): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(t('repositoryFileSizeInvalid'))
  return Number(value)
}

function localFile(snapshot: LocalDirectorySnapshot, file: RepositoryFile): File {
  const blob = snapshot.localFiles.get(file.path)
  if (blob === undefined || blob.size !== file.size) throw new Error(t('changedLocalFile'))
  return blob
}

async function readBounded(response: Response, maximumBytes: number): Promise<ArrayBuffer> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new Error(t('responseOverLimit', { limit: formatBytes(maximumBytes) }))
  }
  if (response.body === null) {
    const data = await response.arrayBuffer()
    if (data.byteLength > maximumBytes) throw new Error(t('responseOverLimit', { limit: formatBytes(maximumBytes) }))
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
      throw new Error(t('responseOverLimit', { limit: formatBytes(maximumBytes) }))
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
