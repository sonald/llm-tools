import { useEffect, useMemo, useRef, useState } from 'react'
import {
  formatBytes,
  isImatrixPath,
  loadLocalDirectory,
  loadRepository,
  readExactRange,
  readWholeFile,
  type FileCategory,
  type RepositoryFile,
  type RepositorySnapshot,
} from './core/huggingface.ts'
import { addRepositoryHistory, parseRepositoryHistory } from './core/history.ts'
import { inspectImatrix, type ImatrixSummary } from './core/imatrix.ts'
import {
  inspectGGUFPrefix,
  inspectSafeTensorsHeader,
  safeTensorsHeaderLength,
  type GGUFPrefix,
  type SafeTensorsSummary,
} from './core/inspectors.ts'
import type { Tokenization, TokenizerStructure } from './core/tokenizer.ts'
import { TextInspection } from './Readers.tsx'
import { TemplateWorkbench } from './TemplateWorkbench.tsx'

const categoryLabels: Record<FileCategory, string> = {
  configuration: '配置',
  tokenizer: 'Tokenizer',
  templates: '模板',
  weightMetadata: '权重元数据',
  documentation: '文档',
  other: '其他',
  weights: '权重文件',
}

const historyKey = 'model-files.repository-history'

type Inspection =
  | { kind: 'empty' }
  | { kind: 'loading'; file: RepositoryFile }
  | { kind: 'error'; file: RepositoryFile; message: string }
  | { kind: 'locked'; file: RepositoryFile }
  | { kind: 'text'; file: RepositoryFile; content: string; parsed: unknown; bytesRead: number; json: boolean }
  | { kind: 'safetensors'; file: RepositoryFile; summary: SafeTensorsSummary; bytesRead: number }
  | { kind: 'gguf'; file: RepositoryFile; summary: GGUFPrefix; bytesRead: number }
  | { kind: 'imatrix'; file: RepositoryFile; summary: ImatrixSummary; bytesRead: number }
  | { kind: 'tokenizer'; file: RepositoryFile }
  | {
    kind: 'template'
    file: RepositoryFile
    source: string
    sourceOrigin: string
    bytesRead: number
    config: { content: string; parsed: unknown; bytesRead: number } | null
  }

type RepositoryError = { message: string; retryable: boolean }

export default function App() {
  const [repositoryInput, setRepositoryInput] = useState('Qwen/Qwen3-0.6B')
  const [repositoryHistory, setRepositoryHistory] = useState(readRepositoryHistory)
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [isLoadingRepository, setIsLoadingRepository] = useState(false)
  const [repositoryError, setRepositoryError] = useState<RepositoryError | null>(null)
  const [inspection, setInspection] = useState<Inspection>({ kind: 'empty' })
  const inspectionGeneration = useRef(0)
  const repositoryAbort = useRef<AbortController | null>(null)
  const inspectionAbort = useRef<AbortController | null>(null)
  const inspectionCache = useRef(new Map<string, Inspection>())
  const initialRouteApplied = useRef(false)

  useEffect(() => () => {
    repositoryAbort.current?.abort()
    inspectionAbort.current?.abort()
  }, [])

  useEffect(() => {
    let active = true
    const restore = () => {
      const route = readRoute()
      if (route.repo === null) {
        clearRepository()
      } else {
        setRepositoryInput(route.repo)
        void loadRoute(route.repo, route.file, false)
      }
    }
    window.addEventListener('popstate', restore)
    queueMicrotask(() => {
      if (active && !initialRouteApplied.current) {
        initialRouteApplied.current = true
        const route = readRoute()
        if (route.repo !== null) {
          setRepositoryInput(route.repo)
          void loadRoute(route.repo, route.file, true)
        }
      }
    })
    return () => {
      active = false
      window.removeEventListener('popstate', restore)
    }
  }, [])

  const visibleFiles = useMemo(() => {
    const term = filter.trim().toLocaleLowerCase()
    return snapshot?.files.filter(file => term === '' || file.path.toLocaleLowerCase().includes(term)) ?? []
  }, [filter, snapshot])

  async function openRepository(event: React.FormEvent) {
    event.preventDefault()
    writeRoute(repositoryInput, null, 'push')
    await loadRoute(repositoryInput, null, true)
  }

  function openLocalDirectory(event: React.ChangeEvent<HTMLInputElement>) {
    const selection = event.currentTarget.files
    if (selection === null || selection.length === 0) return
    repositoryAbort.current?.abort()
    inspectionAbort.current?.abort()
    inspectionGeneration.current += 1
    setIsLoadingRepository(false)
    setRepositoryError(null)
    setSnapshot(null)
    setSelectedPath(null)
    setInspection({ kind: 'empty' })
    inspectionCache.current.clear()
    try {
      const next = loadLocalDirectory(selection)
      setSnapshot(next)
      const preferred = next.files.find(file => file.path === 'config.json') ?? next.files.find(file => !isBlocked(file))
      if (preferred !== undefined) {
        setSelectedPath(preferred.path)
        void inspectFile(next, preferred)
      }
      clearRoute('push')
    } catch (error) {
      setRepositoryError({ message: errorMessage(error), retryable: false })
    } finally {
      event.currentTarget.value = ''
    }
  }

  async function loadRoute(input: string, requestedPath: string | null, replaceRoute: boolean) {
    repositoryAbort.current?.abort()
    inspectionAbort.current?.abort()
    const controller = new AbortController()
    repositoryAbort.current = controller
    setIsLoadingRepository(true)
    setRepositoryError(null)
    setSnapshot(null)
    setSelectedPath(null)
    setInspection({ kind: 'empty' })
    inspectionCache.current.clear()
    inspectionGeneration.current += 1
    try {
      const next = await loadRepository(input, controller.signal)
      if (controller.signal.aborted || repositoryAbort.current !== controller) return
      setSnapshot(next)
      setRepositoryInput(next.modelId)
      setRepositoryHistory(current => {
        const updated = addRepositoryHistory(current, next.modelId)
        saveRepositoryHistory(updated)
        return updated
      })
      const preferred = requestedPath === null
        ? next.files.find(file => file.path === 'config.json') ?? next.files.find(file => !isBlocked(file))
        : next.files.find(file => file.path === requestedPath)
      if (requestedPath !== null && preferred === undefined) {
        setRepositoryError({ message: `深链接文件不存在：${requestedPath}`, retryable: false })
        if (replaceRoute) writeRoute(next.modelId, requestedPath, 'replace')
        return
      }
      if (preferred !== undefined) {
        setSelectedPath(preferred.path)
        void inspectFile(next, preferred)
        if (replaceRoute) writeRoute(next.modelId, preferred.path, 'replace')
      }
    } catch (error) {
      if (!controller.signal.aborted && repositoryAbort.current === controller) {
        setRepositoryError({ message: errorMessage(error), retryable: true })
      }
    } finally {
      if (repositoryAbort.current === controller) {
        repositoryAbort.current = null
        setIsLoadingRepository(false)
      }
    }
  }

  function selectFile(file: RepositoryFile) {
    if (snapshot === null || selectedPath === file.path) return
    setSelectedPath(file.path)
    if (snapshot.source === 'huggingface') writeRoute(snapshot.modelId, file.path, 'push')
    void inspectFile(snapshot, file)
  }

  function clearRepository() {
    repositoryAbort.current?.abort()
    inspectionAbort.current?.abort()
    inspectionGeneration.current += 1
    setSnapshot(null)
    setSelectedPath(null)
    setRepositoryError(null)
    setInspection({ kind: 'empty' })
    inspectionCache.current.clear()
    setIsLoadingRepository(false)
  }

  async function inspectFile(activeSnapshot: RepositorySnapshot, file: RepositoryFile) {
    inspectionAbort.current?.abort()
    const cacheKey = `${snapshotIdentity(activeSnapshot)}/${file.path}`
    const cached = inspectionCache.current.get(cacheKey)
    if (cached !== undefined) {
      inspectionGeneration.current += 1
      setInspection(cached)
      return
    }
    const controller = new AbortController()
    inspectionAbort.current = controller
    const generation = ++inspectionGeneration.current
    setInspection({ kind: 'loading', file })
    try {
      const lower = file.path.toLocaleLowerCase()
      let next: Inspection
      if (lower.endsWith('.safetensors')) {
        if (file.size === null) throw new Error('仓库没有提供文件大小，已拒绝 SafeTensors 检查。')
        const prefix = await readExactRange(activeSnapshot, file, 0, 7, controller.signal)
        const headerLength = safeTensorsHeaderLength(prefix)
        if (headerLength + 8 > file.size) throw new Error('SafeTensors Header 超过文件大小。')
        const header = await readExactRange(activeSnapshot, file, 8, 7 + headerLength, controller.signal)
        next = {
          kind: 'safetensors',
          file,
          summary: inspectSafeTensorsHeader(header, BigInt(file.size - 8 - headerLength)),
          bytesRead: prefix.byteLength + header.byteLength,
        }
      } else if (lower.endsWith('.gguf') || lower.endsWith('.gguf_file')) {
        const prefix = await readExactRange(activeSnapshot, file, 0, 23, controller.signal)
        next = { kind: 'gguf', file, summary: inspectGGUFPrefix(prefix), bytesRead: prefix.byteLength }
      } else if (file.path.split('/').at(-1)?.toLocaleLowerCase() === 'tokenizer.json') {
        next = { kind: 'tokenizer', file }
      } else if (lower.endsWith('.jinja')) {
        const data = await readWholeFile(activeSnapshot, file, controller.signal, 64 * 1024)
        next = {
          kind: 'template', file, source: new TextDecoder('utf-8', { fatal: true }).decode(data),
          sourceOrigin: file.path, bytesRead: data.byteLength, config: null,
        }
      } else if (file.path.split('/').at(-1)?.toLocaleLowerCase() === 'tokenizer_config.json') {
        const data = await readWholeFile(activeSnapshot, file, controller.signal)
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data)
        const parsed: unknown = JSON.parse(decoded)
        const directory = file.path.split('/').slice(0, -1).join('/')
        const templatePath = directory === '' ? 'chat_template.jinja' : `${directory}/chat_template.jinja`
        const independent = activeSnapshot.files.find(candidate => candidate.path === templatePath)
        const embedded = isUnknownRecord(parsed) && typeof parsed.chat_template === 'string' ? parsed.chat_template : null
        if (independent !== undefined || embedded !== null) {
          const templateData = independent === undefined
            ? null
            : await readWholeFile(activeSnapshot, independent, controller.signal, 64 * 1024)
          next = {
            kind: 'template',
            file,
            source: templateData === null ? embedded ?? '' : new TextDecoder('utf-8', { fatal: true }).decode(templateData),
            sourceOrigin: independent?.path ?? `${file.path} · chat_template`,
            bytesRead: data.byteLength + (templateData?.byteLength ?? 0),
            config: { content: decoded, parsed, bytesRead: data.byteLength },
          }
        } else {
          next = { kind: 'text', file, content: decoded, parsed, bytesRead: data.byteLength, json: true }
        }
      } else if (isImatrixPath(file.path)) {
        const data = await readWholeFile(activeSnapshot, file, controller.signal)
        next = { kind: 'imatrix', file, summary: inspectImatrix(data), bytesRead: data.byteLength }
      } else if (isBlocked(file)) {
        next = { kind: 'locked', file }
      } else {
        const data = await readWholeFile(activeSnapshot, file, controller.signal)
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data)
        const json = lower.endsWith('.json')
        next = {
          kind: 'text',
          file,
          content: decoded,
          parsed: json ? JSON.parse(decoded) : null,
          bytesRead: data.byteLength,
          json,
        }
      }
      if (!controller.signal.aborted && inspectionGeneration.current === generation) {
        inspectionCache.current.set(cacheKey, next)
        setInspection(next)
      }
    } catch (error) {
      if (!controller.signal.aborted && inspectionGeneration.current === generation) {
        setInspection({ kind: 'error', file, message: errorMessage(error) })
      }
    } finally {
      if (inspectionAbort.current === controller) inspectionAbort.current = null
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Model Files Web">
          <AppMark />
          <span>Model Files</span>
          <span className="web-label">Web</span>
        </div>
        <form className="repository-form" onSubmit={openRepository}>
          <label className="sr-only" htmlFor="repository">Hugging Face 仓库</label>
          <input
            id="repository"
            list="repository-examples"
            value={repositoryInput}
            onChange={event => setRepositoryInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="owner/model 或 Hugging Face URL"
            spellCheck={false}
          />
          <datalist id="repository-examples">
            {repositoryHistory.map(modelId => <option value={modelId} key={modelId.toLocaleLowerCase()} />)}
            <option value="Qwen/Qwen3-0.6B" />
            <option value="bartowski/Qwen_Qwen3-0.6B-GGUF" />
          </datalist>
          <button className="primary-button" type="submit">
            {isLoadingRepository ? '打开中…' : '打开'}
          </button>
          <label className="directory-button">
            选择本地目录
            <input
              type="file"
              multiple
              aria-label="选择本地目录"
              onChange={openLocalDirectory}
              {...{ webkitdirectory: '' }}
            />
          </label>
          {repositoryHistory.length > 0 ? (
            <button className="history-button" type="button" onClick={() => {
              try {
                localStorage.removeItem(historyKey)
              } catch {
                // History remains cleared for this session when storage is unavailable.
              }
              setRepositoryHistory([])
            }}>清除历史</button>
          ) : null}
        </form>
        <div className="repository-status" aria-live="polite">
          {snapshot !== null ? (
            snapshot.source === 'huggingface'
              ? <><i />公开仓库 · SHA {snapshot.revision.slice(0, 7)} · {snapshot.files.length} 个文件</>
              : <><i />本地目录 · live · {snapshot.files.length} 个文件</>
          ) : isLoadingRepository ? '正在读取清单…' : '纯浏览器 · 只读'
          }
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <label className="search-field">
            <SearchIcon />
            <span className="sr-only">筛选文件</span>
            <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选文件" />
          </label>
          {repositoryError !== null ? (
            <div className="repository-error">
              <InlineError>{repositoryError.message}</InlineError>
              {repositoryError.retryable
                ? <button type="button" onClick={() => void loadRoute(repositoryInput, readRoute().file, true)}>重试</button>
                : null}
            </div>
          ) : null}
          {snapshot === null && repositoryError === null ? (
            <div className="sidebar-empty">打开公开仓库或选择本地目录后，这里显示真实文件清单。</div>
          ) : null}
          <nav aria-label="仓库文件">
            {Object.entries(categoryLabels).map(([category, label]) => {
              const files = visibleFiles.filter(file => file.category === category)
              if (files.length === 0) return null
              return (
                <section className="file-group" key={category}>
                  <h2>{label}</h2>
                  {files.map(file => (
                    <button
                      className={`file-row ${selectedPath === file.path ? 'selected' : ''}`}
                      type="button"
                      key={file.path}
                      onClick={() => selectFile(file)}
                      title={file.path}
                    >
                      <FileIcon locked={isBlocked(file)} />
                      <span>{file.path}</span>
                      {file.size !== null ? <small>{formatBytes(file.size)}</small> : null}
                    </button>
                  ))}
                </section>
              )
            })}
          </nav>
        </aside>
        <Detail inspection={inspection} snapshot={snapshot} onRetry={() => {
          if (snapshot !== null && inspection.kind !== 'empty') void inspectFile(snapshot, inspection.file)
        }} />
      </div>
    </main>
  )
}

function Detail({
  inspection,
  snapshot,
  onRetry,
}: {
  inspection: Inspection
  snapshot: RepositorySnapshot | null
  onRetry(): void
}) {
  const [copyLabel, setCopyLabel] = useState('复制路径')
  const activePath = inspection.kind === 'empty' ? null : inspection.file.path
  useEffect(() => setCopyLabel('复制路径'), [activePath])

  if (inspection.kind === 'empty') {
    return snapshot === null
      ? <EmptyState title="打开模型仓库" message="输入公开 Hugging Face 仓库，验证清单、Range 与 tokenizer 的纯 Web 数据链路。" />
      : <EmptyState title="选择文件" message="从左侧选择当前 revision 中的文件。" />
  }
  const file = inspection.file
  return (
    <section className="detail">
      <header className="detail-header">
        <div>
          <h1>{file.path.split('/').at(-1)}</h1>
          <p>{categoryLabels[file.category]} · {file.size === null ? '未知大小' : formatBytes(file.size)}</p>
        </div>
        <span className="format-chip">{formatName(file)}</span>
        <button className="path-copy" type="button" onClick={async () => {
          try {
            await navigator.clipboard.writeText(file.path)
            setCopyLabel('已复制')
          } catch {
            setCopyLabel('复制失败')
          }
        }}>{copyLabel}</button>
        <a
          className="source-link"
          href={snapshot?.source === 'huggingface' ? `https://huggingface.co/${snapshot.modelId}/blob/${snapshot.revision}/${file.path}` : undefined}
          target="_blank"
          rel="noreferrer"
          hidden={snapshot?.source !== 'huggingface'}
        >源站</a>
      </header>
      <div className="detail-body" aria-live="polite" aria-busy={inspection.kind === 'loading'}>
        {inspection.kind === 'loading' ? <LoadingState file={file} /> : null}
        {inspection.kind === 'error' ? (
          <EmptyState title="无法读取文件" message={inspection.message} action="重试" onAction={onRetry} tone="error" />
        ) : null}
        {inspection.kind === 'locked' ? (
          <EmptyState title="权重文件已锁定" message="该格式不在 Web 纵向验证范围内，不会请求文件内容。" />
        ) : null}
        {inspection.kind === 'text' && snapshot !== null ? (
          <TextInspection
            key={`${snapshotIdentity(snapshot)}/${file.path}`}
            snapshot={snapshot}
            path={file.path}
            content={inspection.content}
            parsed={inspection.parsed}
            json={inspection.json}
            bytesRead={inspection.bytesRead}
          />
        ) : null}
        {inspection.kind === 'safetensors' && snapshot !== null
          ? <SafeTensorsInspection key={file.path} inspection={inspection} snapshot={snapshot} />
          : null}
        {inspection.kind === 'gguf' && snapshot !== null ? <GGUFInspection inspection={inspection} snapshot={snapshot} /> : null}
        {inspection.kind === 'imatrix' ? <ImatrixInspection inspection={inspection} /> : null}
        {inspection.kind === 'template' && snapshot !== null ? (
          <TemplateWorkbench
            key={`${snapshotIdentity(snapshot)}/${file.path}`}
            snapshot={snapshot}
            filePath={file.path}
            sourceOrigin={inspection.sourceOrigin}
            initialSource={inspection.source}
            bytesRead={inspection.bytesRead}
            config={inspection.config === null ? null : { path: file.path, ...inspection.config }}
          />
        ) : null}
        {inspection.kind === 'tokenizer' && snapshot !== null ? (
          <TokenizerInspection
            key={`${snapshot.source === 'huggingface' ? `${snapshot.modelId}@${snapshot.revision}` : snapshot.selectionId}/${file.path}`}
            snapshot={snapshot}
            file={file}
          />
        ) : null}
      </div>
    </section>
  )
}

function SafeTensorsInspection({
  inspection,
  snapshot,
}: {
  inspection: Extract<Inspection, { kind: 'safetensors' }>
  snapshot: RepositorySnapshot
}) {
  const { summary } = inspection
  const [perspective, setPerspective] = useState<'overview' | 'metadata' | 'tensors'>('overview')
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(100)
  const [selectedName, setSelectedName] = useState(summary.tensors[0]?.name ?? '')
  const term = filter.trim().toLocaleLowerCase()
  const metadata = Object.entries(summary.metadata).sort(([left], [right]) => left.localeCompare(right))
  const matchingMetadata = metadata.filter(([key, value]) => term === '' || key.toLocaleLowerCase().includes(term)
    || value.toLocaleLowerCase().includes(term))
  const matchingTensors = summary.tensors.filter(tensor => term === '' || tensor.name.toLocaleLowerCase().includes(term)
    || tensor.dtype.toLocaleLowerCase().includes(term))
  const visible = matchingTensors.slice(0, limit)
  const selected = summary.tensors.find(tensor => tensor.name === selectedName) ?? null
  return (
    <div className="inspection-canvas">
      <ValidationStrip items={[
        ['读取方式', snapshot.source === 'local' ? '2 次 File.slice()' : '2 次 HTTP 206 Range'],
        ['实际读取', formatBytes(inspection.bytesRead)],
        ['Tensor 数据', '0 bytes'],
      ]} />
      <div className="perspective" role="group" aria-label="SafeTensors 视图">
        {([['overview', '概览'], ['metadata', 'Metadata'], ['tensors', 'Tensors']] as const).map(([value, label]) => (
          <button type="button" aria-pressed={perspective === value} onClick={() => {
            setPerspective(value)
            setFilter('')
            setLimit(100)
          }} key={value}>{label}</button>
        ))}
      </div>
      {perspective === 'overview' ? (
        <>
          <MetricGrid items={[
            ['Tensor 数量', summary.tensors.length.toLocaleString()],
            ['参数总数', summary.parameterCount.toLocaleString()],
            ['数据区大小', formatBigBytes(summary.dataBytes)],
            ['Metadata 字段', metadata.length.toLocaleString()],
          ]} />
          <p className="scope-note">名称、dtype、shape、offset 与 Metadata 来自 Header；参数量和字节数为浏览器推导。Tensor 数据保持 0 bytes。</p>
        </>
      ) : null}
      {perspective !== 'overview' ? (
        <div className="inspection-toolbar">
          <label>
            <span>{perspective === 'metadata' ? '筛选 Metadata' : '筛选 Tensor'}</span>
            <input value={filter} onChange={event => {
              setFilter(event.target.value)
              setLimit(100)
            }} placeholder={perspective === 'metadata' ? 'Key 或 Value 包含…' : '名称或 dtype 包含…'} />
          </label>
          <span>{perspective === 'metadata'
            ? `显示 ${matchingMetadata.length} / ${metadata.length}`
            : `显示 ${visible.length} / ${matchingTensors.length}（总计 ${summary.tensors.length}）`}</span>
        </div>
      ) : null}
      {perspective === 'metadata' ? (
        <section className="inspection-section">
          <h2>Metadata</h2>
          <DataTable
            label="SafeTensors Metadata"
            columns={['Key', 'Value']}
            rows={matchingMetadata}
          />
        </section>
      ) : null}
      {perspective === 'tensors' ? (
        <>
          <div className="table-scroll">
            <table aria-label="SafeTensors Tensors">
              <thead><tr><th>Tensor</th><th>DType</th><th>Shape</th><th>参数</th><th>Bytes</th></tr></thead>
              <tbody>{visible.map(tensor => (
                <tr key={tensor.name}>
                  <td><button className="table-link" type="button" onClick={() => setSelectedName(tensor.name)}>{tensor.name}</button></td>
                  <td>{tensor.dtype}</td><td>{`[${tensor.shape.join(', ')}]`}</td>
                  <td>{tensor.parameters.toLocaleString()}</td><td>{tensor.bytes.toLocaleString()}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {visible.length < matchingTensors.length ? (
            <button className="load-more" type="button" onClick={() => setLimit(Math.min(limit + 100, matchingTensors.length))}>再显示 100 个 Tensor</button>
          ) : null}
          {selected !== null ? (
            <section className="inspection-section">
              <h2>选中 Tensor · {selected.name}</h2>
              <MetricGrid items={[
                ['DType', selected.dtype], ['Shape', `[${selected.shape.join(', ')}]`],
                ['Data Offsets', `${selected.dataStart}–${selected.dataEnd}`], ['Bytes', selected.bytes.toLocaleString()],
              ]} />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function GGUFInspection({
  inspection,
  snapshot,
}: {
  inspection: Extract<Inspection, { kind: 'gguf' }>
  snapshot: RepositorySnapshot
}) {
  const { summary } = inspection
  return (
    <div className="inspection-canvas">
      <ValidationStrip items={[
        ['读取方式', snapshot.source === 'local' ? '1 次 File.slice()' : '1 次 HTTP 206 Range'],
        ['实际读取', `${inspection.bytesRead} bytes`],
        ['模型数据', '0 bytes'],
      ]} />
      <MetricGrid items={[
        ['GGUF 版本', `v${summary.version}`],
        ['Tensor 数量', summary.tensorCount.toLocaleString()],
        ['Metadata 数量', summary.metadataCount.toLocaleString()],
        ['字节序', summary.endianness === 'little' ? 'Little-endian' : 'Big-endian'],
      ]} />
      <p className="scope-note">v0.1 仅提供 GGUF 基础摘要。完整 metadata/tensor directory 因无法保证 0 bytes tensor 数据而未启用。</p>
    </div>
  )
}

function ImatrixInspection({ inspection }: { inspection: Extract<Inspection, { kind: 'imatrix' }> }) {
  const [filter, setFilter] = useState('')
  const [selectedName, setSelectedName] = useState(inspection.summary.entries[0]?.name ?? '')
  const term = filter.trim().toLocaleLowerCase()
  const entries = inspection.summary.entries.filter(entry => term === '' || entry.name.toLocaleLowerCase().includes(term))
  const selected = inspection.summary.entries.find(entry => entry.name === selectedName) ?? null
  return (
    <div className="inspection-canvas">
      <ValidationStrip items={[
        ['读取方式', '受限全文'],
        ['实际读取', formatBytes(inspection.bytesRead)],
        ['格式', 'llama.cpp legacy imatrix'],
      ]} />
      <MetricGrid items={[
        ['Entry 数量', inspection.summary.entries.length.toLocaleString()],
        ['Chunk 数量', inspection.summary.chunkCount?.toLocaleString() ?? '无'],
        ['数据集', inspection.summary.dataset ?? '无'],
        ['文件大小', formatBytes(inspection.summary.byteCount)],
      ]} />
      <div className="inspection-toolbar">
        <label><span>筛选 Entry</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Tensor 名称包含…" /></label>
        <span>显示 {entries.length.toLocaleString()} / {inspection.summary.entries.length.toLocaleString()}</span>
      </div>
      <div className="table-scroll">
        <table aria-label="Imatrix Entries">
          <thead><tr><th>Tensor</th><th>Calls</th><th>Values</th><th>Min</th><th>Max</th><th>Mean</th></tr></thead>
          <tbody>{entries.map(entry => (
            <tr key={entry.name}>
              <td><button className="table-link" type="button" onClick={() => setSelectedName(entry.name)}>{entry.name}</button></td>
              <td>{entry.callCount.toLocaleString()}</td><td>{entry.valueCount.toLocaleString()}</td>
              <td>{formatFloat(entry.minimum)}</td><td>{formatFloat(entry.maximum)}</td><td>{formatFloat(entry.mean)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {selected !== null ? (
        <section className="inspection-section">
          <h2>选中项 · {selected.name}</h2>
          <MetricGrid items={[
            ['Call Count', selected.callCount.toLocaleString()], ['Value Count', selected.valueCount.toLocaleString()],
            ['Min / Max', `${formatFloat(selected.minimum)} / ${formatFloat(selected.maximum)}`], ['Mean', formatFloat(selected.mean)],
          ]} />
        </section>
      ) : null}
    </div>
  )
}

function TokenizerInspection({ snapshot, file }: { snapshot: RepositorySnapshot; file: RepositoryFile }) {
  const [view, setView] = useState<'structure' | 'raw' | 'chat'>('structure')
  const [input, setInput] = useState('Hello，世界 👋')
  const [chatMessages, setChatMessages] = useState(JSON.stringify([
    { role: 'system', content: 'You are concise.' }, { role: 'user', content: 'Hello' },
  ], null, 2))
  const [addGenerationPrompt, setAddGenerationPrompt] = useState(true)
  const [chatPreview, setChatPreview] = useState('')
  const [result, setResult] = useState<Tokenization | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [structure, setStructure] = useState<TokenizerStructure | null>(null)
  const [structureError, setStructureError] = useState<string | null>(null)
  const [independentTemplate, setIndependentTemplate] = useState<string | null>(null)
  const [showWhitespace, setShowWhitespace] = useState(true)
  const [inputCopyLabel, setInputCopyLabel] = useState('复制输入')
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const cancelWorker = useRef<(() => void) | null>(null)
  const rawTimer = useRef<number | null>(null)
  const directory = file.path.split('/').slice(0, -1).join('/')
  const configPath = directory === '' ? 'tokenizer_config.json' : `${directory}/tokenizer_config.json`
  const templatePath = directory === '' ? 'chat_template.jinja' : `${directory}/chat_template.jinja`
  const config = snapshot.files.find(candidate => candidate.path === configPath)
  const templateFile = snapshot.files.find(candidate => candidate.path === templatePath)
  const chatTemplate = templateFile === undefined ? structure?.chatTemplate ?? null : independentTemplate

  useEffect(() => () => {
    generation.current += 1
    if (rawTimer.current !== null) window.clearTimeout(rawTimer.current)
    controller.current?.abort()
    cancelWorker.current?.()
  }, [])

  useEffect(() => {
    const activeController = new AbortController()
    setStructure(null)
    setStructureError(null)
    void import('./tokenizerClient.ts').then(async module => {
      cancelWorker.current = module.cancelTokenizerRequests
      return await module.inspectTokenizer(snapshot, file, config, activeController.signal)
    }).then(next => {
      if (!activeController.signal.aborted) setStructure(next)
    }).catch(failure => {
      if (!activeController.signal.aborted) setStructureError(errorMessage(failure))
    })
    return () => activeController.abort()
  }, [config, file, snapshot])

  useEffect(() => {
    if (templateFile === undefined) {
      setIndependentTemplate(null)
      return
    }
    const activeController = new AbortController()
    setIndependentTemplate(null)
    void readWholeFile(snapshot, templateFile, activeController.signal, 64 * 1024).then(data => {
      if (!activeController.signal.aborted) setIndependentTemplate(new TextDecoder('utf-8', { fatal: true }).decode(data))
    }).catch(failure => {
      if (!activeController.signal.aborted) setError(errorMessage(failure))
    })
    return () => activeController.abort()
  }, [snapshot, templateFile])

  useEffect(() => {
    if (view !== 'raw') return
    if (input.length === 0) {
      generation.current += 1
      controller.current?.abort()
      setResult({ ids: [], pieces: [], decoded: '', segments: [], mapping: 'Exact' })
      setError(null)
      setPhase('ready')
      return
    }
    rawTimer.current = window.setTimeout(() => {
      rawTimer.current = null
      void runRaw(input)
    }, 225)
    return () => {
      if (rawTimer.current !== null) window.clearTimeout(rawTimer.current)
      rawTimer.current = null
    }
  }, [input, view])

  function resetResult() {
    generation.current += 1
    controller.current?.abort()
    setResult(null)
    setChatPreview('')
    setError(null)
    setPhase('idle')
  }

  function changeView(next: typeof view) {
    resetResult()
    setView(next)
  }

  function changeInput(value: string) {
    resetResult()
    setInput(value)
    setInputCopyLabel('复制输入')
  }

  async function runRaw(authoritativeInput = input) {
    if (authoritativeInput.length === 0) return
    if (rawTimer.current !== null) window.clearTimeout(rawTimer.current)
    rawTimer.current = null
    await tokenizeAuthoritative(authoritativeInput)
  }

  async function runChat() {
    controller.current?.abort()
    const activeController = new AbortController()
    controller.current = activeController
    const activeGeneration = ++generation.current
    setPhase('loading')
    setResult(null)
    setChatPreview('')
    setError(null)
    try {
      if (chatTemplate === null) throw new Error(templateFile === undefined ? '当前 tokenizer 没有可用 Chat Template。' : '正在读取独立 Chat Template。')
      const messages: unknown = JSON.parse(chatMessages)
      if (!Array.isArray(messages)) throw new Error('Messages 必须是 JSON 数组。')
      const module = await import('./tokenizerClient.ts')
      cancelWorker.current = module.cancelTokenizerRequests
      const rendered = await module.renderTemplate(chatTemplate, {
        messages, tools: [], enable_thinking: false, mode: 'chat', add_generation_prompt: addGenerationPrompt,
      })
      if (activeController.signal.aborted || generation.current !== activeGeneration) return
      setChatPreview(rendered)
      const next = await module.tokenize(snapshot, file, config, rendered, activeController.signal)
      if (activeController.signal.aborted || generation.current !== activeGeneration) return
      setResult(next)
      setPhase('ready')
    } catch (failure) {
      if (activeController.signal.aborted || generation.current !== activeGeneration) return
      setError(errorMessage(failure))
      setResult(null)
      setChatPreview('')
      setPhase('error')
    } finally {
      if (controller.current === activeController) controller.current = null
    }
  }

  async function tokenizeAuthoritative(authoritativeInput: string) {
    controller.current?.abort()
    const activeController = new AbortController()
    controller.current = activeController
    const activeGeneration = ++generation.current
    setPhase('loading')
    setError(null)
    setResult(null)
    try {
      const module = await import('./tokenizerClient.ts')
      cancelWorker.current = module.cancelTokenizerRequests
      const next = await module.tokenize(snapshot, file, config, authoritativeInput, activeController.signal)
      if (activeController.signal.aborted || generation.current !== activeGeneration) return
      setResult(next)
      setPhase('ready')
    } catch (failure) {
      if (activeController.signal.aborted || generation.current !== activeGeneration) return
      setError(errorMessage(failure))
      setPhase('error')
    } finally {
      if (controller.current === activeController) controller.current = null
    }
  }

  return (
    <div className="tokenizer-workspace">
      <div className="tokenizer-tabs" role="tablist" aria-label="Tokenizer 视图">
        <button type="button" role="tab" aria-selected={view === 'structure'} onClick={() => changeView('structure')}>结构与词表</button>
        <button type="button" role="tab" aria-selected={view === 'raw'} onClick={() => changeView('raw')}>Raw 工作台</button>
        <button type="button" role="tab" aria-selected={view === 'chat'} onClick={() => changeView('chat')}>Chat 工作台</button>
      </div>
      {view === 'structure' ? (
        <TokenizerStructureInspection structure={structure} error={structureError} configPresent={config !== undefined} />
      ) : null}
      {view === 'raw' ? (
        <div className="tokenizer-layout">
          <section className="input-panel">
            <header><h2>Raw 输入</h2><button type="button" onClick={async () => {
              try { await navigator.clipboard.writeText(input); setInputCopyLabel('已复制') } catch { setInputCopyLabel('复制失败') }
            }}>{inputCopyLabel}</button><button type="button" onClick={() => changeInput('')}>清空</button><span>最多 64 KiB</span></header>
            <textarea value={input} onChange={event => changeInput(event.target.value)} aria-label="Raw 输入" />
            <footer>
              <span>{new TextEncoder().encode(input).byteLength.toLocaleString()} bytes · 自动等待 225 ms</span>
              <button className="primary-button" type="button" onClick={() => void runRaw()} disabled={phase === 'loading' || input.length === 0}>立即分词</button>
            </footer>
          </section>
          <TokenizerResultView phase={phase} error={error} result={result} authoritativeInput={input} showWhitespace={showWhitespace} setShowWhitespace={setShowWhitespace} />
        </div>
      ) : null}
      {view === 'chat' ? (
        <div className="tokenizer-layout">
          <section className="input-panel chat-panel">
            <header><h2>Chat Messages</h2><span>{chatTemplate === null ? '模板不可用' : templateFile?.path ?? 'tokenizer_config.json · chat_template'}</span></header>
            <textarea value={chatMessages} onChange={event => {
              resetResult()
              setChatMessages(event.target.value)
            }} aria-label="Chat Messages" />
            <pre className="chat-preview" aria-label="Chat 权威输入">{chatPreview || '渲染后，这里显示唯一权威编码输入。'}</pre>
            <footer>
              <label><input type="checkbox" checked={addGenerationPrompt} onChange={event => {
                resetResult()
                setAddGenerationPrompt(event.target.checked)
              }} />add_generation_prompt</label>
              <button className="primary-button" type="button" onClick={() => void runChat()} disabled={phase === 'loading'}>渲染并分词</button>
            </footer>
          </section>
          <TokenizerResultView phase={phase} error={error} result={result} authoritativeInput={chatPreview} showWhitespace={showWhitespace} setShowWhitespace={setShowWhitespace} />
        </div>
      ) : null}
    </div>
  )
}

function TokenizerStructureInspection({
  structure,
  error,
  configPresent,
}: {
  structure: TokenizerStructure | null
  error: string | null
  configPresent: boolean
}) {
  const [showsTop50, setShowsTop50] = useState(false)
  if (error !== null) return <div className="inspection-canvas"><InlineError>{error}</InlineError></div>
  if (structure === null) return <div className="loading-state" role="status"><span className="spinner" /><h2>正在 Worker 中分析 Tokenizer…</h2></div>
  const vocabulary = structure.vocabulary
  const longest = vocabulary?.longestTokens.slice(0, showsTop50 ? 50 : 20) ?? []
  return (
    <div className="inspection-canvas tokenizer-structure">
      <ValidationStrip items={[
        ['运行位置', 'Web Worker'],
        ['Tokenizer Config', configPresent ? '同目录' : '缺失 · Raw 不支持'],
        ['Added Token', (structure.addedTokenCount ?? 0).toLocaleString()],
      ]} />
      <MetricGrid items={[
        ['格式版本', structure.version ?? '未知'],
        ['Model Type', structure.modelType ?? '未知'],
        ['基础词表', structure.vocabCount?.toLocaleString() ?? '未知'],
        ['Merge 数量', structure.mergeCount?.toLocaleString() ?? '不适用'],
      ]} />
      <section className="inspection-section">
        <h2>根字段</h2>
        <DataTable label="Tokenizer 根字段" columns={['Field', 'Detail']} rows={structure.fields.map(field => [field.name, field.detail])} />
      </section>
      {vocabulary === null ? <InlineError>{structure.vocabularyError ?? '词表不可分析。'}</InlineError> : (
        <>
          <MetricGrid items={[
            ['平均标量长度', vocabulary.averageScalarLength.toLocaleString('zh-CN', { maximumFractionDigits: 2 })],
            ['P50 / P90', `${vocabulary.p50ScalarLength} / ${vocabulary.p90ScalarLength}`],
            ['P95 / P99', `${vocabulary.p95ScalarLength} / ${vocabulary.p99ScalarLength}`],
            ['最大标量长度', vocabulary.maximumScalarLength.toLocaleString()],
          ]} />
          <section className="inspection-section">
            <h2>长度分布（Unicode 标量）</h2>
            <DataTable label="Tokenizer 长度分布" columns={['长度', 'Token 数']} rows={vocabulary.buckets.map(bucket => [bucket.label, bucket.count.toLocaleString()])} />
          </section>
          <section className="inspection-section">
            <h2>最长 Token</h2>
            <DataTable label="最长 Token" columns={['ID', 'Token', 'Unicode 标量']} rows={longest.map(entry => [
              entry.tokenId.toLocaleString(), visiblePiece(entry.token), entry.scalarLength.toLocaleString(),
            ])} />
            {vocabulary.longestTokens.length > 20 ? (
              <button className="load-more" type="button" onClick={() => setShowsTop50(!showsTop50)}>
                {showsTop50 ? '收起到 Top 20' : `展开 Top ${vocabulary.longestTokens.length}`}
              </button>
            ) : null}
          </section>
        </>
      )}
    </div>
  )
}

function TokenizerResultView({
  phase,
  error,
  result,
  authoritativeInput,
  showWhitespace,
  setShowWhitespace,
}: {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  result: Tokenization | null
  authoritativeInput: string
  showWhitespace: boolean
  setShowWhitespace(value: boolean): void
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [limit, setLimit] = useState(1000)
  const [copyLabel, setCopyLabel] = useState('复制 ID')
  useEffect(() => {
    setSelectedIndex(0)
    setLimit(1000)
    setCopyLabel('复制 ID')
  }, [result])
  const decoded = useMemo(() => {
    const values = new Map<number, string>()
    for (const segment of result?.segments ?? []) {
      values.set(segment.start, segment.ids.length > 100
        ? `合并片段（${segment.ids.length.toLocaleString()} tokens，完整 Decoded 见下方）`
        : segment.text)
    }
    return values
  }, [result])
  const selectedId = result?.ids[selectedIndex]
  const inputBytes = new TextEncoder().encode(authoritativeInput).byteLength
  return (
    <section className="result-panel" aria-live="polite">
      <header><h2>Token 结果</h2><label><input type="checkbox" checked={showWhitespace} onChange={event => setShowWhitespace(event.target.checked)} />显示空白符</label></header>
      {phase === 'idle' ? <div className="result-empty">等待输入或点击运行。</div> : null}
      {phase === 'loading' ? <div className="result-empty"><span className="spinner" />Web Worker 正在处理 latest-only 请求…</div> : null}
      {phase === 'error' ? <InlineError>{error}</InlineError> : null}
      {result !== null ? (
        <>
          <ValidationStrip items={[
            ['运行位置', 'Web Worker'],
            ['特殊 Token', 'add_special_tokens:false'],
            ['Token 数', result.ids.length.toLocaleString()],
            ['Bytes / Token', result.ids.length === 0 ? '0' : (inputBytes / result.ids.length).toLocaleString('zh-CN', { maximumFractionDigits: 2 })],
            ['映射', result.mapping],
          ]} />
          <h3 className="result-label">Grapheme-safe 片段</h3>
          <div className="token-pieces">
            {result.segments.map((segment, index) => (
              <button
                type="button"
                className={selectedIndex >= segment.start && selectedIndex < segment.end ? 'selected' : ''}
                key={`${segment.start}-${index}`}
                title={`Token #${segment.start + 1}–${segment.end} · ${segment.ids.length > 100 ? `${segment.ids.length.toLocaleString()} IDs` : `IDs ${segment.ids.join(', ')}`}`}
                onClick={() => setSelectedIndex(segment.start)}
              >{segment.ids.length > 100
                ? `合并片段 · ${segment.ids.length.toLocaleString()} tokens（完整 Decoded 见下方）`
                : visiblePiece(segment.text, showWhitespace)}</button>
            ))}
          </div>
          {selectedId !== undefined ? (
            <dl className="selected-token">
              <div><dt>选中 Token</dt><dd>#{selectedIndex + 1}</dd></div>
              <div><dt>ID</dt><dd>{selectedId}</dd></div>
              <div><dt>Piece</dt><dd>{visiblePiece(result.pieces[selectedIndex] ?? '', showWhitespace)}</dd></div>
              <button type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(String(selectedId)); setCopyLabel('已复制') } catch { setCopyLabel('复制失败') }
              }}>{copyLabel}</button>
            </dl>
          ) : null}
          <div className="table-scroll">
            <table aria-label="Tokenizer Tokens">
              <thead><tr><th>#</th><th>ID</th><th>Token Piece</th><th>Decoded</th><th>Mapping</th></tr></thead>
              <tbody>{result.ids.slice(0, limit).map((id, index) => (
                <tr className={selectedIndex === index ? 'selected-token-row' : ''} key={`${index}-${id}`} onMouseEnter={() => setSelectedIndex(index)}>
                  <td><button className="table-link" type="button" onClick={() => setSelectedIndex(index)}>{index + 1}</button></td>
                  <td>{id}</td><td>{visiblePiece(result.pieces[index] ?? '', showWhitespace)}</td>
                  <td>{visiblePiece(decoded.get(index) ?? '', showWhitespace)}</td><td>{result.mapping}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {limit < result.ids.length ? <button className="load-more" type="button" onClick={() => setLimit(Math.min(limit + 1000, result.ids.length))}>再显示 1,000 个 Token</button> : null}
          <p className="decoded-text">权威输入：{authoritativeInput}</p>
          <p className="decoded-text">Decoded：{result.decoded}</p>
        </>
      ) : null}
    </section>
  )
}

function ValidationStrip({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="validation-strip">
      {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  )
}

function MetricGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="metric-grid">
      {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  )
}

function DataTable({ columns, rows, label }: { columns: string[]; rows: string[][]; label?: string }) {
  return (
    <div className="table-scroll">
      <table aria-label={label}>
        <thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function LoadingState({ file }: { file: RepositoryFile }) {
  return <div className="loading-state" role="status"><span className="spinner" /><h2>正在读取 {file.path.split('/').at(-1)}…</h2><p>切换文件会取消并丢弃旧结果。</p></div>
}

function EmptyState({
  title,
  message,
  action,
  onAction,
  tone = 'neutral',
}: {
  title: string
  message: string
  action?: string
  onAction?: () => void
  tone?: 'neutral' | 'error'
}) {
  return (
    <div className={`empty-state ${tone}`}>
      <AppMark />
      <h2>{title}</h2>
      <p>{message}</p>
      {action !== undefined ? <button type="button" onClick={onAction}>{action}</button> : null}
    </div>
  )
}

function InlineError({ children }: { children: React.ReactNode }) {
  return <p className="inline-error" role="alert">{children}</p>
}

function SearchIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
}

function FileIcon({ locked }: { locked: boolean }) {
  return locked
    ? <svg className="file-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
    : <svg className="file-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h6l4 4v9H3z" /><path d="M9 1.5v4h4" /></svg>
}

function AppMark() {
  return <svg className="app-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5M8 13h8M8 17h6" /></svg>
}

function isBlocked(file: RepositoryFile): boolean {
  const lower = file.path.toLocaleLowerCase()
  return file.category === 'weights' && !lower.endsWith('.safetensors')
    && !lower.endsWith('.gguf') && !lower.endsWith('.gguf_file')
}

function formatName(file: RepositoryFile): string {
  const lower = file.path.toLocaleLowerCase()
  if (lower.endsWith('.safetensors')) return 'SafeTensors'
  if (lower.endsWith('.gguf') || lower.endsWith('.gguf_file')) return 'GGUF'
  if (file.path.split('/').at(-1)?.toLocaleLowerCase() === 'tokenizer.json') return 'Tokenizer'
  if (lower.endsWith('.json')) return 'JSON'
  if (lower.endsWith('.md')) return 'Markdown'
  if (isImatrixPath(file.path)) return 'Imatrix'
  return 'Text'
}

function formatBigBytes(bytes: bigint): string {
  const value = Number(bytes)
  return Number.isSafeInteger(value) ? formatBytes(value) : `${bytes.toLocaleString()} bytes`
}

function formatFloat(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
}

function visiblePiece(piece: string, showWhitespace = true): string {
  return (showWhitespace ? piece.replaceAll(' ', '␠').replaceAll('\n', '↵') : piece) || '∅'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRoute(): { repo: string | null; file: string | null } {
  const parameters = new URLSearchParams(window.location.search)
  return { repo: parameters.get('repo'), file: parameters.get('file') }
}

function writeRoute(repo: string, file: string | null, mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href)
  url.search = ''
  url.searchParams.set('repo', repo)
  if (file !== null) url.searchParams.set('file', file)
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url)
}

function clearRoute(mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href)
  url.search = ''
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url)
}

function snapshotIdentity(snapshot: RepositorySnapshot): string {
  return snapshot.source === 'huggingface'
    ? `huggingface:${snapshot.modelId}@${snapshot.revision}`
    : `local:${snapshot.selectionId}`
}

function readRepositoryHistory(): string[] {
  try {
    return parseRepositoryHistory(localStorage.getItem(historyKey))
  } catch {
    return []
  }
}

function saveRepositoryHistory(history: string[]): void {
  try {
    localStorage.setItem(historyKey, JSON.stringify(history))
  } catch {
    // History is optional when storage is unavailable.
  }
}
