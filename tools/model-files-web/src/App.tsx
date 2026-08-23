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
  syntaxLanguage,
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
import { decodeStrictText, validatePdfData } from './core/readers.ts'
import {
  activeChatTemplate,
  mergeChatTemplates,
  selectChatTemplate,
  type ChatTemplateEntry,
} from './core/chatTemplates.ts'
import {
  analyzeRepositoryConsistency,
  chatTemplateMaterial,
  consistencyBadgeState,
  selectConsistencyFiles,
  type ConsistencyMaterial,
  type RepositoryConsistencyMaterials,
  type RepositoryConsistencyReport,
} from './core/consistency.ts'
import {
  cancelTokenizerRequests,
  createComparisonTokenizerSession,
  inspectTokenizerData,
  mainTokenizerSession,
  type TokenizerSession,
} from './tokenizerClient.ts'
import {
  buildChatContext,
  type ChatAttributionMessage,
  type ChatTokenRole,
} from './core/tokenAttribution.ts'
import {
  compareTokenizerTokenizations,
  parseTokenIds,
  selectTokenizerComparisonTargets,
  type Tokenization,
  type TokenizerStructure,
  type TokenizerVocabularyEntry,
  type VocabularyDiffScope,
} from './core/tokenizer.ts'
import { PdfInspection, SourceInspection, TextInspection } from './Readers.tsx'
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
  | { kind: 'pdf'; file: RepositoryFile; data: ArrayBuffer; bytesRead: number }
  | { kind: 'source'; file: RepositoryFile; content: string; language: string; bytesRead: number }
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
const comparisonDiffScopes: VocabularyDiffScope[] = ['leftOnly', 'rightOnly', 'shared']

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
  const consistencyAbort = useRef<AbortController | null>(null)
  const consistencyGeneration = useRef(0)
  const consistencySnapshotIdentity = useRef<string | null>(null)
  const baseMaterials = useRef<RepositoryConsistencyMaterials | null>(null)
  const consistencyInspectStarted = useRef(false)
  const [consistencyReport, setConsistencyReport] = useState<RepositoryConsistencyReport | null>(null)
  const [consistencyConfigPath, setConsistencyConfigPath] = useState<string | null>(null)
  const [consistencyOpen, setConsistencyOpen] = useState(false)

  useEffect(() => () => {
    repositoryAbort.current?.abort()
    inspectionAbort.current?.abort()
    resetConsistency()
  }, [])
  useEffect(() => setConsistencyOpen(false), [selectedPath, snapshot])

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
    resetConsistency()
    inspectionGeneration.current += 1
    setIsLoadingRepository(false)
    setRepositoryError(null)
    setSnapshot(null)
    setSelectedPath(null)
    setInspection({ kind: 'empty' })
    inspectionCache.current.clear()
    try {
      const next = loadLocalDirectory(selection)
      consistencySnapshotIdentity.current = snapshotIdentity(next)
      setSnapshot(next)
      const preferred = next.files.find(file => file.path === 'config.json') ?? next.files.find(file => !isBlocked(file))
      if (preferred !== undefined) {
        setSelectedPath(preferred.path)
        void (async () => {
          await inspectFile(next, preferred)
          if (consistencySnapshotIdentity.current === snapshotIdentity(next)) startConsistency(next)
        })()
      } else {
        startConsistency(next)
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
    resetConsistency()
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
      consistencySnapshotIdentity.current = snapshotIdentity(next)
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
        startConsistency(next)
        return
      }
      if (preferred !== undefined) {
        setSelectedPath(preferred.path)
        await inspectFile(next, preferred)
        if (consistencySnapshotIdentity.current !== snapshotIdentity(next)) return
        startConsistency(next)
        if (replaceRoute) writeRoute(next.modelId, preferred.path, 'replace')
      } else {
        startConsistency(next)
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
    resetConsistency()
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
      } else if (lower.endsWith('.pdf')) {
        const data = await readWholeFile(activeSnapshot, file, controller.signal)
        validatePdfData(data)
        next = { kind: 'pdf', file, data, bytesRead: data.byteLength }
      } else if (lower.endsWith('.jinja')) {
        const data = await readWholeFile(activeSnapshot, file, controller.signal, 64 * 1024)
        next = {
          kind: 'template', file, source: decodeStrictText(data),
          sourceOrigin: file.path, bytesRead: data.byteLength, config: null,
        }
      } else if (file.path.split('/').at(-1)?.toLocaleLowerCase() === 'tokenizer_config.json') {
        const data = await readWholeFile(activeSnapshot, file, controller.signal)
        const decoded = decodeStrictText(data)
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
            source: templateData === null ? embedded ?? '' : decodeStrictText(templateData),
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
      } else {
        const language = syntaxLanguage(file.path)
        if (file.size !== null && file.size <= 128 * 1024 && language !== null && language !== 'json') {
          const data = await readWholeFile(activeSnapshot, file, controller.signal)
          next = {
            kind: 'source', file, content: decodeStrictText(data),
            language, bytesRead: data.byteLength,
          }
        } else if (isBlocked(file)) {
          next = { kind: 'locked', file }
        } else {
          const data = await readWholeFile(activeSnapshot, file, controller.signal)
          const decoded = decodeStrictText(data)
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
      }
      if (!controller.signal.aborted && inspectionGeneration.current === generation) {
        inspectionCache.current.set(cacheKey, next)
        setInspection(next)
        if (next.kind === 'gguf') refreshConsistencyGGUF(activeSnapshot)
      }
    } catch (error) {
      if (!controller.signal.aborted && inspectionGeneration.current === generation) {
        setInspection({ kind: 'error', file, message: errorMessage(error) })
      }
    } finally {
      if (inspectionAbort.current === controller) inspectionAbort.current = null
    }
  }

  function startConsistency(activeSnapshot: RepositorySnapshot) {
    const controller = new AbortController()
    consistencyAbort.current = controller
    const generation = ++consistencyGeneration.current
    void loadConsistency(activeSnapshot, controller, generation)
  }

  function resetConsistency() {
    consistencyAbort.current?.abort()
    consistencyAbort.current = null
    consistencyGeneration.current += 1
    consistencySnapshotIdentity.current = null
    baseMaterials.current = null
    setConsistencyReport(null)
    setConsistencyConfigPath(null)
    setConsistencyOpen(false)
    if (consistencyInspectStarted.current) cancelTokenizerRequests()
    consistencyInspectStarted.current = false
  }

  async function loadConsistency(
    activeSnapshot: RepositorySnapshot,
    controller: AbortController,
    generation: number,
  ) {
    try {
      const selected = selectConsistencyFiles(activeSnapshot.files)
      setConsistencyConfigPath(selected.config?.path ?? null)
      const json = async (file?: RepositoryFile) => {
        if (file === undefined) return { state: 'missing' } as ConsistencyMaterial<unknown>
        try {
          const data = await readWholeFile(activeSnapshot, file, controller.signal)
          return available(JSON.parse(decodeStrictText(data)) as unknown)
        } catch (error) {
          if (controller.signal.aborted) throw error
          return failed(error)
        }
      }
      const jinja = async (): Promise<ConsistencyMaterial<string>> => {
        if (selected.chatTemplate === undefined) return { state: 'missing' }
        try {
          const data = await readWholeFile(activeSnapshot, selected.chatTemplate, controller.signal, 64 * 1024)
          return available(decodeStrictText(data))
        } catch (error) {
          if (controller.signal.aborted) throw error
          return failed(error)
        }
      }
      const inspectOnlyTokenizer = async (): Promise<ConsistencyMaterial<TokenizerStructure>> => {
        if (selected.tokenizer === undefined) return { state: 'missing' }
        try {
          const data = await readWholeFile(activeSnapshot, selected.tokenizer, controller.signal)
          return available(await inspectTokenizerData(
            data,
            controller.signal,
            () => { consistencyInspectStarted.current = true },
          ))
        } catch (error) {
          if (controller.signal.aborted) throw error
          return failed(error)
        }
      }

      const [config, generationConfig, tokenizerConfig, tokenizer, adapterConfig, processorConfig, chatTemplates]
        = await Promise.all([
          json(selected.config),
          json(selected.generationConfig),
          json(selected.tokenizerConfig),
          inspectOnlyTokenizer(),
          json(selected.adapterConfig),
          json(selected.processorConfig),
          jinja(),
        ])
      publishConsistency(activeSnapshot, controller, generation, {
        config,
        generationConfig,
        tokenizerConfig,
        tokenizer,
        adapterConfig,
        processorConfig,
        chatTemplates: chatTemplateMaterial(tokenizerConfig, chatTemplates),
        gguf: { state: 'missing' },
      })
    } catch {
      // Cancellation is the only condition that escapes per-material failure capture.
    }
  }

  function publishConsistency(
    activeSnapshot: RepositorySnapshot,
    controller: AbortController,
    generation: number,
    materials: RepositoryConsistencyMaterials,
  ) {
    if (controller.signal.aborted || consistencyGeneration.current !== generation
      || consistencySnapshotIdentity.current !== snapshotIdentity(activeSnapshot)) return
    baseMaterials.current = materials
    setConsistencyReport(analyzeRepositoryConsistency({
      ...materials,
      gguf: ggufMaterial(activeSnapshot),
    }))
  }

  function refreshConsistencyGGUF(activeSnapshot: RepositorySnapshot) {
    const materials = baseMaterials.current
    if (materials === null || consistencyAbort.current?.signal.aborted
      || consistencySnapshotIdentity.current !== snapshotIdentity(activeSnapshot)) return
    setConsistencyReport(analyzeRepositoryConsistency({
      ...materials,
      gguf: ggufMaterial(activeSnapshot),
    }))
  }

  function ggufMaterial(activeSnapshot: RepositorySnapshot): ConsistencyMaterial<never> {
    const ggufFiles = activeSnapshot.files.filter(isGGUF)
    if (ggufFiles.length === 0) return { state: 'missing' }
    const opened = ggufFiles.some(file => inspectionCache.current
      .get(`${snapshotIdentity(activeSnapshot)}/${file.path}`)?.kind === 'gguf')
    return opened
      ? { state: 'skipped', reason: 'Web 仅读取 24-byte prefix，缺少 metadata/tensor directory。' }
      : { state: 'skipped', reason: '未在当前会话打开' }
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
                      aria-current={selectedPath === file.path}
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
        <Detail
          inspection={inspection}
          snapshot={snapshot}
          report={consistencyReport}
          reportOpen={consistencyOpen}
          configPath={consistencyConfigPath}
          onToggleConsistency={() => setConsistencyOpen(open => !open)}
          onRetry={() => {
          if (snapshot !== null && inspection.kind !== 'empty') void inspectFile(snapshot, inspection.file)
        }} />
      </div>
    </main>
  )
}

function Detail({
  inspection,
  snapshot,
  report,
  reportOpen,
  configPath,
  onRetry,
  onToggleConsistency,
}: {
  inspection: Inspection
  snapshot: RepositorySnapshot | null
  report: RepositoryConsistencyReport | null
  reportOpen: boolean
  configPath: string | null
  onRetry(): void
  onToggleConsistency(): void
}) {
  const [copyLabel, setCopyLabel] = useState('复制路径')
  const badgeRef = useRef<HTMLButtonElement>(null)
  const activePath = inspection.kind === 'empty' ? null : inspection.file.path
  useEffect(() => setCopyLabel('复制路径'), [activePath])

  function closeReport() {
    onToggleConsistency()
    badgeRef.current?.focus()
  }

  if (inspection.kind === 'empty') {
    return (
      <section className="detail">
        <header className="detail-header">
          <div><h1>{snapshot === null ? '打开模型仓库' : '选择文件'}</h1></div>
          {snapshot !== null ? (
            <ConsistencyBadge ref={badgeRef} report={report} open={reportOpen} onToggle={onToggleConsistency} />
          ) : null}
        </header>
        {reportOpen ? <ConsistencyDialog report={report} onClose={closeReport} /> : null}
        <div className="detail-body">
          {snapshot === null
            ? <EmptyState title="打开模型仓库" message="输入公开 Hugging Face 仓库，验证清单、Range 与 tokenizer 的纯 Web 数据链路。" />
            : <EmptyState title="选择文件" message="从左侧选择当前 revision 中的文件。" />}
        </div>
      </section>
    )
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
        <ConsistencyBadge ref={badgeRef} report={report} open={reportOpen} onToggle={onToggleConsistency} />
      </header>
      {reportOpen ? <ConsistencyDialog report={report} onClose={closeReport} /> : null}
      <div className="detail-body" aria-live="polite" aria-busy={inspection.kind === 'loading'}>
        {inspection.kind === 'loading' ? <LoadingState file={file} /> : null}
        {inspection.kind === 'text' && snapshot !== null && report !== null
          && configPath !== null && file.path === configPath ? (
            <div className="detail-reader-stack">
              <section className="inspection-section consistency-embedded" aria-label="Config 一致性报告">
                <h2>Config 一致性报告</h2>
                <ConsistencyReportBody report={report} />
              </section>
              <TextInspection
                key={`${snapshotIdentity(snapshot)}/${file.path}`}
                snapshot={snapshot}
                path={file.path}
                content={inspection.content}
                parsed={inspection.parsed}
                json={inspection.json}
                bytesRead={inspection.bytesRead}
              />
            </div>
          ) : null}
        {inspection.kind === 'error' ? (
          <EmptyState title="无法读取文件" message={inspection.message} action="重试" onAction={onRetry} tone="error" />
        ) : null}
        {inspection.kind === 'locked' ? (
          <EmptyState title="权重文件已锁定" message="该格式不在 Web 纵向验证范围内，不会请求文件内容。" />
        ) : null}
        {inspection.kind === 'text' && snapshot !== null && !(
          report !== null && configPath !== null && file.path === configPath
        ) ? (
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
        {inspection.kind === 'pdf' ? <PdfInspection data={inspection.data} bytesRead={inspection.bytesRead} /> : null}
        {inspection.kind === 'source' && snapshot !== null ? (
          <SourceInspection
            key={`${snapshotIdentity(snapshot)}/${file.path}`}
            content={inspection.content}
            language={inspection.language}
            bytesRead={inspection.bytesRead}
          />
        ) : null}
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

function ConsistencyBadge({
  ref,
  report,
  open,
  onToggle,
}: {
  ref: React.RefObject<HTMLButtonElement | null>
  report: RepositoryConsistencyReport | null
  open: boolean
  onToggle(): void
}) {
  const state = consistencyBadgeState(report)
  return (
    <button
      className="consistency-badge"
      type="button"
      aria-label="查看仓库一致性报告"
      aria-expanded={open}
      data-consistency-state={state.state}
      ref={ref}
      onClick={onToggle}
    >{state.label}</button>
  )
}

function ConsistencyDialog({ report, onClose }: {
  report: RepositoryConsistencyReport | null
  onClose(): void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => closeButtonRef.current?.focus(), [])

  return (
    <div className="consistency-dialog" role="dialog" aria-label="仓库一致性报告"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <header>
        <h2>仓库一致性报告</h2>
        <button ref={closeButtonRef} type="button" onClick={onClose}>关闭</button>
      </header>
      <ConsistencyReportBody report={report} />
    </div>
  )
}

function ConsistencyReportBody({ report }: { report: RepositoryConsistencyReport | null }) {
  if (report === null) return <p>正在检查仓库材料…</p>
  return (
    <>
      <dl aria-label="仓库身份" className="consistency-identity">
        {report.identityFields.map(item => (
          <div key={item.key} data-identity-key={item.key}>
            <dt>{item.key}</dt>
            <dd>{`${item.type} · ${item.value}`}</dd>
          </div>
        ))}
      </dl>
      {report.findings.map(finding => (
        <article key={finding.id} data-finding-id={finding.id}>
          <h3>{finding.title}</h3>
          <p>{finding.detail}</p>
          <dl>
            <div><dt>{finding.left.key}</dt><dd>{finding.left.value}</dd></div>
            <div><dt>{finding.right.key}</dt><dd>{finding.right.value}</dd></div>
          </dl>
        </article>
      ))}
      <div className="table-scroll">
        <table aria-label="一致性 Coverage">
          <thead><tr><th>Material</th><th>Status</th></tr></thead>
          <tbody>
            {report.coverage.map(item => (
              <tr key={item.material} data-material={item.material} data-coverage-status={item.status.state}>
                <td>{item.material}</td>
                <td>{consistencyCoverageText(item.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
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
  const [view, setView] = useState<'structure' | 'raw' | 'decode' | 'chat'>('structure')
  const [rawInput, setRawInput] = useState('Hello，世界 👋')
  const [tokenIdInput, setTokenIdInput] = useState('[1, 3, 2]')
  const [chatMessages, setChatMessages] = useState(JSON.stringify([
    { role: 'system', content: 'You are concise.' }, { role: 'user', content: 'Hello' },
  ], null, 2))
  const [addGenerationPrompt, setAddGenerationPrompt] = useState(true)
  const [chatTools, setChatTools] = useState(JSON.stringify([], null, 2))
  const [chatVariables, setChatVariables] = useState(JSON.stringify({
    enable_thinking: false,
    mode: 'chat',
  }, null, 2))
  const [includeTools, setIncludeTools] = useState(false)
  const [chatPreview, setChatPreview] = useState('')
  const [result, setResult] = useState<Tokenization | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [structure, setStructure] = useState<TokenizerStructure | null>(null)
  const [structureError, setStructureError] = useState<string | null>(null)
  const [independentTemplate, setIndependentTemplate] = useState<string | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [showWhitespace, setShowWhitespace] = useState(true)
  const [inputCopyLabel, setInputCopyLabel] = useState('复制输入')
  const [comparisonRepositoryInput, setComparisonRepositoryInput] = useState('')
  const [comparisonExternalSnapshot, setComparisonExternalSnapshot] = useState<RepositorySnapshot | null>(null)
  const [comparisonManifestLoading, setComparisonManifestLoading] = useState(false)
  const [comparisonSourceError, setComparisonSourceError] = useState<string | null>(null)
  const activeRightSnapshot = comparisonExternalSnapshot ?? snapshot
  const activeRightSnapshotIdentity = snapshotIdentity(activeRightSnapshot)
  const comparisonTargets = useMemo(
    () => activeRightSnapshot === null ? [] : selectTokenizerComparisonTargets(activeRightSnapshot),
    [activeRightSnapshot],
  )
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const [comparisonTargetPath, setComparisonTargetPath] = useState<string | null>(null)
  const selectedComparisonTarget = comparisonOpen && activeRightSnapshot !== null
    ? comparisonTargets.find(target => target.file.path === comparisonTargetPath) ?? null
    : null
  const [rightStructure, setRightStructure] = useState<TokenizerStructure | null>(null)
  const [rightStructureError, setRightStructureError] = useState<string | null>(null)
  const [rightIndependentTemplate, setRightIndependentTemplate] = useState<string | null>(null)
  const [selectedRightTemplateId, setSelectedRightTemplateId] = useState<string | null>(null)
  const [rightResult, setRightResult] = useState<Tokenization | null>(null)
  const [rightPhase, setRightPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [rightError, setRightError] = useState<string | null>(null)
  const [rightChatPreview, setRightChatPreview] = useState('')
  type ComparisonDiffCounts = Awaited<ReturnType<TokenizerSession['prepareVocabularyDiff']>>
  const [diffCounts, setDiffCounts] = useState<ComparisonDiffCounts | null>(null)
  const [diffStatus, setDiffStatus] = useState<'waiting' | 'preparing' | 'searching' | 'ready' | 'error'>('waiting')
  const [diffScope, setDiffScope] = useState<VocabularyDiffScope>('shared')
  const [diffQuery, setDiffQuery] = useState('')
  const [diffPage, setDiffPage] = useState<string[]>([])
  const [diffTotal, setDiffTotal] = useState(0)
  const [diffError, setDiffError] = useState<string | null>(null)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const cancelWorker = useRef<(() => void) | null>(null)
  const rawTimer = useRef<number | null>(null)
  const comparisonSession = useRef<TokenizerSession | null>(null)
  const comparisonManifestController = useRef<AbortController | null>(null)
  const comparisonLoadController = useRef<AbortController | null>(null)
  const comparisonRequestController = useRef<AbortController | null>(null)
  const diffSearchController = useRef<AbortController | null>(null)
  const comparisonGeneration = useRef(0)
  const rightRequestGeneration = useRef(0)
  const lastDecodedIds = useRef<number[] | null>(null)
  const lastChatContext = useRef<{
    context: Record<string, unknown>
    attribution: ChatAttributionMessage[]
  } | null>(null)
  const directory = file.path.split('/').slice(0, -1).join('/')
  const configPath = directory === '' ? 'tokenizer_config.json' : `${directory}/tokenizer_config.json`
  const templatePath = directory === '' ? 'chat_template.jinja' : `${directory}/chat_template.jinja`
  const config = snapshot.files.find(candidate => candidate.path === configPath)
  const templateFile = snapshot.files.find(candidate => candidate.path === templatePath)
  const templateLoading = templateFile !== undefined && independentTemplate === null
  const chatCatalog = templateLoading ? null : selectChatTemplate(mergeChatTemplates(
    structure?.chatTemplates ?? { entries: [], activeId: null, conflict: false },
    templateFile === undefined ? null : independentTemplate,
  ), selectedTemplateId)
  const activeTemplate = chatCatalog === null ? null : activeChatTemplate(chatCatalog)
  const rightTemplateLoading = rightStructure !== null && selectedComparisonTarget?.templateFile !== undefined
    && rightIndependentTemplate === null
  const comparisonLoaded = rightStructure !== null && !rightTemplateLoading
  const rightCatalog = comparisonLoaded && rightStructure !== null
    ? selectChatTemplate(mergeChatTemplates(
      rightStructure.chatTemplates,
      selectedComparisonTarget?.templateFile === undefined ? null : rightIndependentTemplate,
    ), selectedRightTemplateId)
    : null
  const activeRightTemplate = rightCatalog === null ? null : activeChatTemplate(rightCatalog)
  const comparisonSourceLabel = selectedComparisonTarget === null ? null : comparisonExternalSnapshot === null
    ? `当前仓库 · ${selectedComparisonTarget.file.path}`
    : comparisonExternalSnapshot.source === 'huggingface'
      ? `${comparisonExternalSnapshot.modelId} · SHA ${comparisonExternalSnapshot.revision.slice(0, 7)} · ${selectedComparisonTarget.file.path}`
      : `本地目录 · ${comparisonExternalSnapshot.revision} · ${comparisonExternalSnapshot.name} · ${selectedComparisonTarget.file.path}`
  const comparisonSummary = comparisonLoaded && result !== null && rightResult !== null
    ? compareTokenizerTokenizations(result, rightResult)
    : null

  useEffect(() => () => {
    generation.current += 1
    if (rawTimer.current !== null) window.clearTimeout(rawTimer.current)
    controller.current?.abort()
    cancelWorker.current?.()
    releaseComparison()
    comparisonManifestController.current?.abort()
    comparisonManifestController.current = null
  }, [])

  useEffect(() => {
    if (!comparisonOpen || activeRightSnapshot === null || selectedComparisonTarget === null) return
    let active = true
    const loadController = new AbortController()
    const generationAtStart = ++comparisonGeneration.current
    let session: TokenizerSession
    try {
      session = createComparisonTokenizerSession()
      comparisonSession.current = session
    } catch (failure) {
      setRightStructureError(errorMessage(failure))
      return
    }
    comparisonLoadController.current = loadController
    setRightStructure(null)
    setRightStructureError(null)
    setRightIndependentTemplate(null)
    setSelectedRightTemplateId(null)
    clearRightResult()
    clearDiff()
    setDiffStatus('preparing')

    void (async () => {
      try {
        const structure = await session.inspectTokenizer(
          activeRightSnapshot,
          selectedComparisonTarget.file,
          selectedComparisonTarget.config,
          loadController.signal,
        )
        const templateData = selectedComparisonTarget.templateFile === undefined ? null : await readWholeFile(
          activeRightSnapshot,
          selectedComparisonTarget.templateFile,
          loadController.signal,
          64 * 1024,
        )
        if (!active || loadController.signal.aborted || comparisonGeneration.current !== generationAtStart) return
        const independent = templateData === null ? null : decodeStrictText(templateData)
        setRightStructure(structure)
        setRightIndependentTemplate(independent)
        try {
          const counts = await session.prepareVocabularyDiff(
            activeRightSnapshot,
            selectedComparisonTarget.file,
            selectedComparisonTarget.config,
            snapshot,
            file,
            loadController.signal,
          )
          if (!active || loadController.signal.aborted || comparisonGeneration.current !== generationAtStart) return
          setDiffCounts(counts)
          setDiffStatus('ready')
        } catch (diffFailure) {
          if (!active || loadController.signal.aborted || comparisonGeneration.current !== generationAtStart) return
          setDiffCounts(null)
          setDiffPage([])
          setDiffTotal(0)
          setDiffError(errorMessage(diffFailure))
          setDiffStatus('error')
        }
      } catch (failure) {
        if (!active || loadController.signal.aborted || comparisonGeneration.current !== generationAtStart) return
        setRightStructure(null)
        setRightIndependentTemplate(null)
        setRightStructureError(errorMessage(failure))
        disposeComparisonSlot()
      }
    })()

    return () => {
      active = false
      releaseComparison()
    }
  }, [comparisonOpen, activeRightSnapshotIdentity, selectedComparisonTarget?.file.path])

  useEffect(() => {
    if (!comparisonLoaded || result === null || rightStructure === null) return
    if (view === 'raw') void runRightRaw(rawInput)
    else if (view === 'decode' && lastDecodedIds.current !== null) {
      void runRightDecode(lastDecodedIds.current, tokenIdInput)
    } else if (view === 'chat' && lastChatContext.current !== null) {
      void runRightChat(lastChatContext.current.context, lastChatContext.current.attribution)
    }
  }, [
    activeRightTemplate?.id,
    comparisonLoaded,
    rawInput,
    result,
    rightStructure,
    tokenIdInput,
    view,
  ])

  useEffect(() => {
    if (!comparisonLoaded || diffCounts === null) return
    let active = true
    const searchController = new AbortController()
    diffSearchController.current?.abort()
    diffSearchController.current = searchController
    setDiffStatus('searching')
    setDiffError(null)
    void comparisonSession.current?.searchVocabularyDiff(diffScope, diffQuery, searchController.signal).then(search => {
      if (!active || searchController.signal.aborted) return
      setDiffPage(search.pieces.slice(0, 1000))
      setDiffTotal(search.total)
      setDiffStatus('ready')
    }).catch(failure => {
      if (!active || searchController.signal.aborted) return
      setDiffPage([])
      setDiffTotal(0)
      setDiffError(errorMessage(failure))
      setDiffStatus('error')
    })
    return () => {
      active = false
      searchController.abort()
      if (diffSearchController.current === searchController) diffSearchController.current = null
    }
  }, [comparisonLoaded, diffCounts, diffQuery, diffScope])

  useEffect(() => {
    const activeController = new AbortController()
    setStructure(null)
    setStructureError(null)
    setSelectedTemplateId(null)
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
      setSelectedTemplateId(null)
      return
    }
    const activeController = new AbortController()
    setIndependentTemplate(null)
    setSelectedTemplateId(null)
    void readWholeFile(snapshot, templateFile, activeController.signal, 64 * 1024).then(data => {
      if (!activeController.signal.aborted) setIndependentTemplate(decodeStrictText(data))
    }).catch(failure => {
      if (!activeController.signal.aborted) setError(errorMessage(failure))
    })
    return () => activeController.abort()
  }, [snapshot, templateFile])

  useEffect(() => {
    if (view !== 'raw') return
    if (rawInput.length === 0) {
      generation.current += 1
      controller.current?.abort()
      setResult({
        direction: 'encode', input: '', ids: [], pieces: [], decoded: '', segments: [], mapping: 'Exact', flags: [],
        overhead: null,
        roles: null,
      })
      setError(null)
      setPhase('ready')
      clearRightResult()
      return
    }
    rawTimer.current = window.setTimeout(() => {
      rawTimer.current = null
      void runRaw(rawInput)
    }, 225)
    return () => {
      if (rawTimer.current !== null) window.clearTimeout(rawTimer.current)
      rawTimer.current = null
    }
  }, [rawInput, view])

  function resetResult() {
    generation.current += 1
    controller.current?.abort()
    setResult(null)
    setChatPreview('')
    setError(null)
    setPhase('idle')
    lastDecodedIds.current = null
    lastChatContext.current = null
    clearRightResult()
  }

  function disposeComparisonSlot() {
    comparisonLoadController.current?.abort()
    comparisonLoadController.current = null
    comparisonRequestController.current?.abort()
    comparisonRequestController.current = null
    diffSearchController.current?.abort()
    diffSearchController.current = null
    const session = comparisonSession.current
    comparisonSession.current = null
    session?.dispose()
  }

  function clearRightResult() {
    rightRequestGeneration.current += 1
    comparisonRequestController.current?.abort()
    comparisonRequestController.current = null
    setRightResult(null)
    setRightPhase('idle')
    setRightError(null)
    setRightChatPreview('')
  }

  function clearDiff() {
    diffSearchController.current?.abort()
    diffSearchController.current = null
    setDiffCounts(null)
    setDiffStatus('waiting')
    setDiffScope('shared')
    setDiffQuery('')
    setDiffPage([])
    setDiffTotal(0)
    setDiffError(null)
  }

  function closeExternalSource() {
    comparisonManifestController.current?.abort()
    comparisonManifestController.current = null
    releaseComparison()
    setComparisonRepositoryInput('')
    setComparisonExternalSnapshot(null)
    setComparisonManifestLoading(false)
    setComparisonSourceError(null)
    setComparisonOpen(false)
    setComparisonTargetPath(null)
  }

  async function loadComparisonRepository(event: React.FormEvent) {
    event.preventDefault()
    const input = comparisonRepositoryInput.trim()
    if (input.length === 0) return
    comparisonManifestController.current?.abort()
    const manifestController = new AbortController()
    comparisonManifestController.current = manifestController
    releaseComparison()
    setComparisonExternalSnapshot(null)
    setComparisonSourceError(null)
    setComparisonManifestLoading(true)
    setComparisonOpen(true)
    setComparisonTargetPath(null)
    try {
      const next = await loadRepository(input, manifestController.signal)
      if (manifestController.signal.aborted || comparisonManifestController.current !== manifestController) return
      const targets = selectTokenizerComparisonTargets(next)
      if (targets.length === 0) throw new Error('对照仓库没有可用 tokenizer.json。')
      setComparisonExternalSnapshot(next)
      setComparisonTargetPath(targets.find(target => target.file.path === 'tokenizer.json')?.file.path
        ?? targets[0]?.file.path ?? null)
      setComparisonOpen(true)
    } catch (failure) {
      if (!manifestController.signal.aborted && comparisonManifestController.current === manifestController) {
        setComparisonSourceError(errorMessage(failure))
        setComparisonOpen(false)
        setComparisonTargetPath(null)
      }
    } finally {
      if (comparisonManifestController.current === manifestController) {
        comparisonManifestController.current = null
        setComparisonManifestLoading(false)
      }
    }
  }

  function releaseComparison() {
    disposeComparisonSlot()
    comparisonGeneration.current += 1
    setRightStructure(null)
    setRightStructureError(null)
    setRightIndependentTemplate(null)
    setSelectedRightTemplateId(null)
    clearRightResult()
    clearDiff()
  }

  function loadComparisonLocalDirectory(event: React.ChangeEvent<HTMLInputElement>) {
    const selection = event.currentTarget.files
    if (selection === null || selection.length === 0) return

    try {
      const next = loadLocalDirectory(selection)
      const targets = selectTokenizerComparisonTargets(next)
      if (targets.length === 0) throw new Error('对照本地目录没有可用 tokenizer.json。')
      closeExternalSource()
      setComparisonExternalSnapshot(next)
      setComparisonSourceError(null)
      setComparisonTargetPath(targets.find(target => target.file.path === 'tokenizer.json')?.file.path ?? targets[0].file.path)
      setComparisonOpen(true)
    } catch (failure) {
      setComparisonSourceError(errorMessage(failure))
    } finally {
      event.currentTarget.value = ''
    }
  }

  function openComparison() {
    setComparisonTargetPath(current => current ?? comparisonTargets[0]?.file.path ?? null)
    setComparisonOpen(true)
  }

  function closeComparison() {
    if (comparisonExternalSnapshot !== null || comparisonManifestLoading) closeExternalSource()
    else {
      releaseComparison()
      setComparisonOpen(false)
      setComparisonTargetPath(null)
    }
  }

  function changeComparisonTemplate(id: string) {
    setSelectedRightTemplateId(id)
    clearRightResult()
  }

  async function runRightRaw(text: string) {
    const session = comparisonSession.current
    if (session === null || text.length === 0) return
    if (activeRightSnapshot === null || selectedComparisonTarget === null) {
      rightRequestGeneration.current += 1
      comparisonRequestController.current?.abort()
      comparisonRequestController.current = null
      clearRightResult()
      setRightError('对照来源不可用。')
      setRightPhase('error')
      return
    }
    comparisonRequestController.current?.abort()
    const requestController = new AbortController()
    comparisonRequestController.current = requestController
    const requestGeneration = ++rightRequestGeneration.current
    setRightPhase('loading')
    setRightError(null)
    try {
      const next = await session.tokenize(
        activeRightSnapshot,
        selectedComparisonTarget.file,
        selectedComparisonTarget.config,
        text,
        requestController.signal,
      )
      if (requestController.signal.aborted || rightRequestGeneration.current !== requestGeneration) return
      setRightResult(next)
      setRightChatPreview(next.input)
      setRightPhase('ready')
    } catch (failure) {
      if (requestController.signal.aborted || rightRequestGeneration.current !== requestGeneration) return
      setRightResult(null)
      setRightChatPreview('')
      setRightError(errorMessage(failure))
      setRightPhase('error')
    } finally {
      if (comparisonRequestController.current === requestController) comparisonRequestController.current = null
    }
  }

  async function runRightDecode(ids: number[], originalInput: string) {
    const session = comparisonSession.current
    if (session === null) return
    if (activeRightSnapshot === null || selectedComparisonTarget === null) {
      rightRequestGeneration.current += 1
      comparisonRequestController.current?.abort()
      comparisonRequestController.current = null
      clearRightResult()
      setRightError('对照来源不可用。')
      setRightPhase('error')
      return
    }
    comparisonRequestController.current?.abort()
    const requestController = new AbortController()
    comparisonRequestController.current = requestController
    const requestGeneration = ++rightRequestGeneration.current
    setRightPhase('loading')
    setRightError(null)
    try {
      const next = await session.decodeTokenIdArray(
        activeRightSnapshot,
        selectedComparisonTarget.file,
        selectedComparisonTarget.config,
        ids,
        originalInput,
        requestController.signal,
      )
      if (requestController.signal.aborted || rightRequestGeneration.current !== requestGeneration) return
      setRightResult(next)
      setRightChatPreview(next.input)
      setRightPhase('ready')
    } catch (failure) {
      if (requestController.signal.aborted || rightRequestGeneration.current !== requestGeneration) return
      setRightResult(null)
      setRightChatPreview('')
      setRightError(errorMessage(failure))
      setRightPhase('error')
    } finally {
      if (comparisonRequestController.current === requestController) comparisonRequestController.current = null
    }
  }

  async function runRightChat(
    context: Record<string, unknown>,
    attribution: ChatAttributionMessage[],
  ) {
    const session = comparisonSession.current
    if (session === null) return
    if (activeRightSnapshot === null || selectedComparisonTarget === null) {
      rightRequestGeneration.current += 1
      comparisonRequestController.current?.abort()
      comparisonRequestController.current = null
      clearRightResult()
      setRightError('对照来源不可用。')
      setRightPhase('error')
      return
    }
    if (view === 'chat' && activeRightTemplate === null) {
      rightRequestGeneration.current += 1
      comparisonRequestController.current?.abort()
      comparisonRequestController.current = null
      setRightResult(null)
      setRightChatPreview('')
      setRightError('对照 Tokenizer 没有可用的 Chat Template。')
      setRightPhase('error')
      return
    }
    const template = activeRightTemplate!
    comparisonRequestController.current?.abort()
    const requestController = new AbortController()
    comparisonRequestController.current = requestController
    const requestGeneration = ++rightRequestGeneration.current
    setRightPhase('loading')
    setRightError(null)
    try {
      const next = await session.chatTokenize(
        activeRightSnapshot,
        selectedComparisonTarget.file,
        selectedComparisonTarget.config,
        template.body,
        context,
        attribution,
        requestController.signal,
      )
      if (requestController.signal.aborted || rightRequestGeneration.current !== requestGeneration) return
      setRightResult(next)
      setRightChatPreview(next.input)
      setRightPhase('ready')
    } catch (failure) {
      if (requestController.signal.aborted || rightRequestGeneration.current !== requestGeneration) return
      setRightResult(null)
      setRightChatPreview('')
      setRightError(errorMessage(failure))
      setRightPhase('error')
    } finally {
      if (comparisonRequestController.current === requestController) comparisonRequestController.current = null
    }
  }

  function changeView(next: typeof view) {
    resetResult()
    setView(next)
  }

  function changeRawInput(value: string) {
    resetResult()
    setRawInput(value)
    setInputCopyLabel('复制输入')
  }

  function changeTokenIdInput(value: string) {
    resetResult()
    setTokenIdInput(value)
  }

  function changeChatTemplate(id: string) {
    resetResult()
    setSelectedTemplateId(id)
  }

  async function runRaw(authoritativeInput = rawInput) {
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
      if (activeTemplate === null) throw new Error(templateLoading ? '正在读取独立 Chat Template。' : '模板不可用。')
      const chatContext = buildChatContext(
        JSON.parse(chatMessages),
        JSON.parse(chatTools),
        JSON.parse(chatVariables),
        includeTools,
        addGenerationPrompt,
      )
      const module = await import('./tokenizerClient.ts')
      cancelWorker.current = module.cancelTokenizerRequests
      lastChatContext.current = chatContext
      const next = await module.chatTokenize(
        snapshot, file, config, activeTemplate.body, chatContext.context, chatContext.attribution, activeController.signal,
      )
      if (activeController.signal.aborted || generation.current !== activeGeneration) return
      setChatPreview(next.input)
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

  async function runDecode() {
    controller.current?.abort()
    const activeController = new AbortController()
    controller.current = activeController
    const activeGeneration = ++generation.current
    setPhase('loading')
    setError(null)
    setResult(null)
    try {
      const ids = parseTokenIds(tokenIdInput)
      const module = await import('./tokenizerClient.ts')
      cancelWorker.current = module.cancelTokenizerRequests
      lastDecodedIds.current = ids
      const next = await mainTokenizerSession.decodeTokenIdArray(snapshot, file, config, ids, tokenIdInput, activeController.signal)
      if (activeController.signal.aborted || generation.current !== activeGeneration) return
      setResult(next)
      setPhase('ready')
    } catch (failure) {
      if (activeController.signal.aborted || generation.current !== activeGeneration) return
      setError(errorMessage(failure))
      setResult(null)
      setPhase('error')
    } finally {
      if (controller.current === activeController) controller.current = null
    }
  }

  const comparisonPanel = comparisonOpen ? (
    <aside className="comparison-side">
      <header>
        <h2>对照</h2>
        {rightCatalog !== null ? (
          <select
            aria-label="对照 Chat Template"
            value={rightCatalog.activeId ?? ''}
            onChange={event => changeComparisonTemplate(event.target.value)}
          >
            {rightCatalog.entries.map(entry => (
              <option key={entry.id} value={entry.id} disabled={!entry.usable}>{templateLabel(entry)}</option>
            ))}
          </select>
        ) : null}
      </header>
      <div className="comparison-status" aria-live="polite">
        {rightStructure === null && rightStructureError === null ? '正在加载对照 Tokenizer…' : null}
        {rightTemplateLoading ? '正在读取对照 chat_template.jinja…' : null}
        {comparisonSummary !== null ? (
          <section className="inspection-section" aria-label="Tokenizer 对照摘要">
            <h2>对照摘要</h2>
            <dl>
              <div><dt>Left / Right Count</dt><dd>{comparisonSummary.leftCount.toLocaleString()} / {comparisonSummary.rightCount.toLocaleString()}</dd></div>
              <div><dt>Delta</dt><dd>{comparisonSummary.countDelta >= 0 ? '+' : ''}{comparisonSummary.countDelta.toLocaleString()}</dd></div>
              <div><dt>ID 序列</dt><dd>{comparisonSummary.idsMatch ? '相同' : '不同'}</dd></div>
              <div><dt>First Difference（zero-based）</dt><dd>{comparisonSummary.firstDifference === null ? '—' : `#${comparisonSummary.firstDifference.index} · ${comparisonSummary.firstDifference.leftId ?? '—'} / ${comparisonSummary.firstDifference.rightId ?? '—'}`}</dd></div>
              {comparisonSummary.leftTemplateOverhead !== null && comparisonSummary.rightTemplateOverhead !== null ? (
                <div><dt>模板开销（左 / 右）</dt><dd>{formatTemplateOverhead(comparisonSummary.leftTemplateOverhead)} / {formatTemplateOverhead(comparisonSummary.rightTemplateOverhead)}</dd></div>
              ) : null}
            </dl>
          </section>
        ) : null}
        <section className="inspection-section" aria-label="Tokenizer 词表差集统计">
          <h2>词表差集</h2>
          <div role="group" aria-label="词表差集范围">
            {comparisonDiffScopes.map(scope => (
              <button
                key={scope}
                type="button"
                aria-pressed={diffScope === scope}
                disabled={diffCounts === null}
                onClick={() => setDiffScope(scope)}
              >{scope} · {diffCounts?.[`${scope}Count` as const].toLocaleString() ?? '—'}</button>
            ))}
          </div>
          <label className="comparison-search">
            <span>搜索</span>
            <input
              aria-label="对照词表搜索"
              value={diffQuery}
              onChange={event => setDiffQuery(event.target.value)}
              placeholder="包含匹配…"
            />
          </label>
          <span aria-live="polite">
            {diffStatus === 'waiting' || diffStatus === 'preparing' ? '正在准备差集索引…'
              : diffStatus === 'searching' ? '正在搜索…'
              : diffStatus === 'error' ? '差集不可用'
              : `显示 ${diffPage.length.toLocaleString()} / ${diffTotal.toLocaleString()}`}
          </span>
          {diffError !== null ? <InlineError>{diffError}</InlineError> : null}
          {diffStatus === 'ready' ? (
            <div className="table-scroll comparison-diff-table">
              <table aria-label="Tokenizer 词表差集">
                <thead><tr><th>Token Piece</th></tr></thead>
                <tbody>{diffPage.map(piece => <tr key={piece}><td>{piece}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
      {rightStructureError !== null ? <InlineError>{rightStructureError}</InlineError> : null}
      <TokenizerResultView
        heading="对照 Tokenizer 结果"
        phase={rightPhase}
        error={rightError}
        result={rightResult}
        authoritativeInput={rightChatPreview}
        showWhitespace={showWhitespace}
        setShowWhitespace={setShowWhitespace}
        tableLabel="对照 Tokenizer Tokens"
      />
    </aside>
  ) : null

  return (
    <div className={`tokenizer-workspace ${comparisonOpen ? 'comparison-open' : ''}`}>
      <div className="comparison-toolbar">
        {comparisonOpen ? null : (
          <button className="primary-button" type="button" onClick={openComparison} disabled={comparisonTargets.length === 0}>
            打开对照
          </button>
        )}
        <label className="comparison-target">
          <span>对照 Tokenizer</span>
          <select
            aria-label="对照 Tokenizer"
            value={selectedComparisonTarget?.file.path ?? ''}
            disabled={comparisonManifestLoading || comparisonTargets.length === 0}
            onChange={event => setComparisonTargetPath(event.target.value)}
          >
            {comparisonTargets.map(target => (
              <option key={target.file.path} value={target.file.path}>{target.file.path}</option>
            ))}
          </select>
        </label>
        {comparisonSourceLabel !== null ? (
          <span className="comparison-source">{comparisonSourceLabel}</span>
        ) : null}
        <details className="comparison-repository">
          <summary>另一公开 Hugging Face…</summary>
          <form onSubmit={loadComparisonRepository}>
            <label>
              <span>对照 Hugging Face 仓库</span>
              <input
                value={comparisonRepositoryInput}
                placeholder="owner/model 或 Hugging Face URL"
                onChange={event => setComparisonRepositoryInput(event.target.value)}
              />
            </label>
            <div className="comparison-source-actions">
              <button className="primary-button" type="submit">加载对照</button>
              {comparisonManifestLoading ? (
                <>
                  <span aria-live="polite">正在读取对照仓库清单…</span>
                  <button type="button" onClick={closeComparison}>取消加载</button>
                </>
              ) : null}
            </div>
            {comparisonSourceError !== null ? <InlineError>{comparisonSourceError}</InlineError> : null}
          </form>
          <label className="comparison-directory-label">
            <span>选择第二个本地目录</span>
            <input type="file" multiple onChange={loadComparisonLocalDirectory} {...{ webkitdirectory: '' }} />
          </label>
        </details>
        {comparisonOpen ? (
          <button type="button" aria-label="关闭 Tokenizer 对照" onClick={closeComparison}>关闭对照</button>
        ) : null}
        {comparisonTargets.length === 0 ? <span>当前快照没有可用 tokenizer.json 对照目标。</span> : null}
      </div>
      <div className="tokenizer-tabs" role="tablist" aria-label="Tokenizer 视图">
        <button type="button" role="tab" aria-selected={view === 'structure'} onClick={() => changeView('structure')}>结构与词表</button>
        <button type="button" role="tab" aria-selected={view === 'raw'} onClick={() => changeView('raw')}>Raw 工作台</button>
        <button type="button" role="tab" aria-selected={view === 'decode'} onClick={() => changeView('decode')}>Token IDs 工作台</button>
        <button type="button" role="tab" aria-selected={view === 'chat'} onClick={() => changeView('chat')}>Chat 工作台</button>
      </div>
      {view === 'structure' ? (
        <TokenizerStructureInspection
          structure={structure}
          error={structureError}
          configPresent={config !== undefined}
          snapshot={snapshot}
          file={file}
          config={config}
        />
      ) : null}
      {view === 'decode' ? (
        <div className={`tokenizer-layout ${comparisonOpen ? 'comparison-open' : ''}`}>
          <section className="input-panel">
            <header><h2>Token IDs</h2><span>最多 64 KiB</span></header>
            <textarea
              value={tokenIdInput}
              onChange={event => changeTokenIdInput(event.target.value)}
              aria-label="Token IDs"
              placeholder="逗号、空白、换行或 JSON 数组，例如 [1,3,2]"
            />
            <footer>
              <span>{new TextEncoder().encode(tokenIdInput).byteLength.toLocaleString()} bytes · 解析失败不会请求 Worker</span>
              <button className="primary-button" type="button" onClick={() => void runDecode()} disabled={phase === 'loading'}>解码 ID</button>
            </footer>
          </section>
          <TokenizerResultView
            heading={comparisonOpen ? '主 Tokenizer 结果' : undefined}
            phase={phase}
            error={error}
            result={result}
            authoritativeInput={tokenIdInput}
            showWhitespace={showWhitespace}
            setShowWhitespace={setShowWhitespace}
            tableLabel={comparisonOpen ? '主 Tokenizer Tokens' : undefined}
          />
          {comparisonPanel}
        </div>
      ) : null}
      {view === 'raw' ? (
        <div className={`tokenizer-layout ${comparisonOpen ? 'comparison-open' : ''}`}>
          <section className="input-panel">
            <header><h2>Raw 输入</h2><button type="button" onClick={async () => {
              try { await navigator.clipboard.writeText(rawInput); setInputCopyLabel('已复制') } catch { setInputCopyLabel('复制失败') }
            }}>{inputCopyLabel}</button><button type="button" onClick={() => changeRawInput('')}>清空</button><span>最多 64 KiB</span></header>
            <textarea value={rawInput} onChange={event => changeRawInput(event.target.value)} aria-label="Raw 输入" />
            <footer>
              <span>{new TextEncoder().encode(rawInput).byteLength.toLocaleString()} bytes · 自动等待 225 ms</span>
              <button className="primary-button" type="button" onClick={() => void runRaw()} disabled={phase === 'loading' || rawInput.length === 0}>立即分词</button>
            </footer>
          </section>
          <TokenizerResultView
            heading={comparisonOpen ? '主 Tokenizer 结果' : undefined}
            phase={phase}
            error={error}
            result={result}
            authoritativeInput={rawInput}
            showWhitespace={showWhitespace}
            setShowWhitespace={setShowWhitespace}
            tableLabel={comparisonOpen ? '主 Tokenizer Tokens' : undefined}
          />
          {comparisonPanel}
        </div>
      ) : null}
      {view === 'chat' ? (
        <div className={`tokenizer-layout ${comparisonOpen ? 'comparison-open' : ''}`}>
          <section className="input-panel chat-panel">
            <header>
              <h2>Chat Messages</h2>
              {chatCatalog !== null && chatCatalog.entries.length > 1 ? (
                <select
                  aria-label="Chat Template"
                  value={chatCatalog.activeId ?? ''}
                  onChange={event => changeChatTemplate(event.target.value)}
                >
                  {chatCatalog.entries.map(entry => (
                    <option key={entry.id} value={entry.id} disabled={!entry.usable}>{templateLabel(entry)}</option>
                  ))}
                </select>
              ) : null}
              {templateLoading
                ? <span>正在读取 chat_template.jinja</span>
                : activeTemplate === null ? <span>模板不可用</span> : null}
              {!templateLoading && chatCatalog !== null && chatCatalog.entries.length === 1 ? (
                <span className="chat-template-badge">{templateLabel(chatCatalog.entries[0])}</span>
              ) : null}
            </header>
            <textarea value={chatMessages} onChange={event => {
              resetResult()
              setChatMessages(event.target.value)
            }} aria-label="Chat Messages" />
            <details className="chat-context-details">
              <summary>Tools 与 Variables</summary>
              <label>Tools<textarea aria-label="Chat Tools" value={chatTools} onChange={event => {
                resetResult()
                setChatTools(event.target.value)
              }} /></label>
              <label>Typed Variables<textarea aria-label="Chat Typed Variables" value={chatVariables} onChange={event => {
                resetResult()
                setChatVariables(event.target.value)
              }} /></label>
            </details>
            <pre className="chat-preview" aria-label="Chat 权威输入">{chatPreview || '渲染后，这里显示唯一权威编码输入。'}</pre>
            <footer>
              <label><input type="checkbox" checked={includeTools} onChange={event => {
                resetResult()
                setIncludeTools(event.target.checked)
              }} />include_tools</label>
              <label><input type="checkbox" checked={addGenerationPrompt} onChange={event => {
                resetResult()
                setAddGenerationPrompt(event.target.checked)
              }} />add_generation_prompt</label>
              <button className="primary-button" type="button" onClick={() => void runChat()} disabled={phase === 'loading' || activeTemplate === null}>渲染并分词</button>
            </footer>
          </section>
          <TokenizerResultView
            heading={comparisonOpen ? '主 Tokenizer 结果' : undefined}
            phase={phase}
            error={error}
            result={result}
            authoritativeInput={chatPreview}
            showWhitespace={showWhitespace}
            setShowWhitespace={setShowWhitespace}
            tableLabel={comparisonOpen ? '主 Tokenizer Tokens' : undefined}
          />
          {comparisonPanel}
        </div>
      ) : null}
    </div>
  )
}

function TokenizerStructureInspection({
  structure,
  error,
  configPresent,
  snapshot,
  file,
  config,
}: {
  structure: TokenizerStructure | null
  error: string | null
  configPresent: boolean
  snapshot: RepositorySnapshot
  file: RepositoryFile
  config: RepositoryFile | undefined
}) {
  const [showsTop50, setShowsTop50] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<TokenizerVocabularyEntry[]>([])
  const [searchStatus, setSearchStatus] = useState<'empty' | 'searching' | 'ready' | 'error'>('empty')
  const [searchError, setSearchError] = useState<string | null>(null)
  const searchGeneration = useRef(0)
  const searchController = useRef<AbortController | null>(null)

  useEffect(() => () => {
    searchGeneration.current += 1
    searchController.current?.abort()
  }, [])

  async function searchVocabulary(query: string) {
    setSearchQuery(query)
    const term = query.trim()
    searchGeneration.current += 1
    searchController.current?.abort()
    if (term === '') {
      setSearchResults([])
      setSearchError(null)
      setSearchStatus('empty')
      return
    }

    const controller = new AbortController()
    searchController.current = controller
    const generation = ++searchGeneration.current
    setSearchStatus('searching')
    setSearchError(null)
    try {
      const { searchTokenizerVocabulary } = await import('./tokenizerClient.ts')
      const results = await searchTokenizerVocabulary(snapshot, file, config, term, controller.signal)
      if (controller.signal.aborted || searchGeneration.current !== generation) return
      setSearchResults(results.slice(0, 1000))
      setSearchStatus('ready')
    } catch (failure) {
      if (controller.signal.aborted || searchGeneration.current !== generation) return
      setSearchResults([])
      setSearchError(errorMessage(failure))
      setSearchStatus('error')
    } finally {
      if (searchController.current === controller) searchController.current = null
    }
  }

  if (error !== null) return <div className="inspection-canvas"><InlineError>{error}</InlineError></div>
  if (structure === null) return <div className="loading-state" role="status"><span className="spinner" /><h2>正在 Worker 中分析 Tokenizer…</h2></div>
  const vocabulary = structure.vocabulary
  const longest = vocabulary?.longestTokens.slice(0, showsTop50 ? 50 : 20) ?? []
  const specialTokens = structure.addedTokens.filter(token => token.special)
  return (
    <div className="inspection-canvas tokenizer-structure">
      <ValidationStrip items={[
        ['运行位置', 'Web Worker'],
        ['Tokenizer Config', configPresent ? '同目录' : '缺失 · Raw 不支持'],
        ['Added Token', (structure.addedTokenCount ?? 0).toLocaleString()],
      ]} />
      {specialTokens.length > 0 ? (
        <section className="inspection-section">
          <h2>Special Added Tokens</h2>
          <DataTable
            label="Special Added Tokens"
            columns={['ID', 'Token']}
            rows={specialTokens.map(token => [token.id === null ? '—' : token.id.toLocaleString(), token.content])}
          />
        </section>
      ) : null}
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
      {vocabulary === null && !(structure.vocabCount === 0 && structure.vocabularyError === null)
        ? <InlineError>{structure.vocabularyError ?? '词表不可分析。'}</InlineError>
        : (
        <>
          {vocabulary === null ? <p className="scope-note">model.vocab 为空，没有可分析的 Token。</p> : (
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
          <div className="inspection-toolbar">
            <label>
              <span>词表搜索</span>
              <input
                value={searchQuery}
                onChange={event => void searchVocabulary(event.target.value)}
                aria-label="词表搜索"
                placeholder="搜索 token 或十进制 ID"
              />
            </label>
            <span aria-live="polite">
              {searchStatus === 'empty' ? '输入 token 或十进制 ID 开始搜索'
                : searchStatus === 'searching' ? '正在准备词表索引'
                : searchStatus === 'ready' ? `匹配 ${searchResults.length.toLocaleString()} 条`
                : '词表搜索失败'}
            </span>
          </div>
          {searchStatus === 'error' && searchError !== null ? <InlineError>{searchError}</InlineError> : null}
          {searchStatus === 'ready' ? (
            <DataTable
              label="词表搜索结果"
              columns={['ID', 'Token', 'Unicode 标量']}
              rows={searchResults.map(entry => [
                entry.tokenId.toLocaleString(), visiblePiece(entry.token), Array.from(entry.token).length.toLocaleString(),
              ])}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function formatTemplateOverhead(value: number): string {
  return value < 0 ? '无法拆分' : value.toLocaleString()
}

function TokenizerResultView({
  phase,
  error,
  result,
  authoritativeInput,
  showWhitespace,
  setShowWhitespace,
  heading,
  tableLabel,
}: {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  result: Tokenization | null
  authoritativeInput: string
  showWhitespace: boolean
  setShowWhitespace(value: boolean): void
  heading?: string
  tableLabel?: string
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [limit, setLimit] = useState(1000)
  const [copyLabel, setCopyLabel] = useState('复制 ID')
  useEffect(() => {
    setSelectedIndex(null)
    setLimit(1000)
    setCopyLabel('复制 ID')
  }, [result])
  const decoded = useMemo(() => {
    const values = new Map<number, string>()
    for (const segment of result?.segments ?? []) {
      const display = segment.ids.length > 100
        ? `合并片段（${segment.ids.length.toLocaleString()} tokens，完整 Decoded 见下方）`
        : segment.text
      for (let index = segment.start; index < segment.end; index++) values.set(index, display)
    }
    return values
  }, [result])
  const selectedId = selectedIndex === null ? undefined : result?.ids[selectedIndex]
  const selectedRole = selectedIndex !== null ? result?.roles?.[selectedIndex] ?? null : null
  const inputBytes = new TextEncoder().encode(authoritativeInput).byteLength
  return (
    <section className="result-panel" aria-live="polite">
      <header><h2>{heading ?? (result?.direction === 'decode' ? '由 Token ID 解码' : 'Token 结果')}</h2><label><input type="checkbox" checked={showWhitespace} onChange={event => setShowWhitespace(event.target.checked)} />显示空白符</label></header>
      {phase === 'idle' ? <div className="result-empty">等待输入或点击运行。</div> : null}
      {phase === 'loading' ? <div className="result-empty"><span className="spinner" />Web Worker 正在处理 latest-only 请求…</div> : null}
      {phase === 'error' ? <InlineError>{error}</InlineError> : null}
      {result !== null ? (
        <>
          <ValidationStrip items={[
            ['运行位置', 'Web Worker'],
            ['方向', result.direction === 'decode' ? 'decode' : 'encode'],
            ['Token 数', result.ids.length.toLocaleString()],
            ...(result.overhead === null ? [] : [
              ['正文 Token', result.overhead.contentCount.toLocaleString()],
              ['模板开销（近似）', result.overhead.templateCount < 0
                ? '无法拆分'
                : result.overhead.templateCount.toLocaleString()],
            ] as Array<[string, string]>),
            ['Bytes / Token', result.ids.length === 0 ? '0' : (inputBytes / result.ids.length).toLocaleString('zh-CN', { maximumFractionDigits: 2 })],
            ['映射', result.mapping],
          ]} />
          {result.overhead !== null && result.mapping === 'Decoded only' ? (
            <p className="decoded-text">当前映射是 Decoded only，不能按原文划分角色</p>
          ) : null}
          <h3 className="result-label">Grapheme-safe 片段</h3>
          <div className="token-pieces">
            {result.segments.map((segment, index) => {
              const role = segmentRole(result, segment)
              return (
              <button
                type="button"
                className={selectedIndex !== null && selectedIndex >= segment.start && selectedIndex < segment.end ? 'selected' : ''}
                aria-pressed={selectedIndex !== null && selectedIndex >= segment.start && selectedIndex < segment.end}
                key={`${segment.start}-${index}`}
                title={`Token #${segment.start + 1}–${segment.end} · ${segment.ids.length > 100 ? `${segment.ids.length.toLocaleString()} IDs` : `IDs ${segment.ids.join(', ')}`}`}
                onClick={() => setSelectedIndex(current => current === segment.start ? null : segment.start)}
              >{role !== null ? (
                <span className={`token-role-badge ${chatRoleClass(role)}`}>
                  {chatRoleLabel(role)}
                </span>
              ) : null}{segment.ids.length > 100
                ? `合并片段 · ${segment.ids.length.toLocaleString()} tokens（完整 Decoded 见下方）`
                : visiblePiece(segment.text, showWhitespace)}</button>
            )})}
          </div>
          {selectedId !== undefined && selectedIndex !== null ? (
            <dl className="selected-token">
              <div><dt>选中 Token</dt><dd>#{selectedIndex + 1}</dd></div>
              <div><dt>ID</dt><dd>{selectedId}</dd></div>
              <div><dt>Role</dt><dd>{chatRoleLabel(selectedRole)}</dd></div>
              <div><dt>Piece</dt><dd>{visiblePiece(result.pieces[selectedIndex] ?? '', showWhitespace)}</dd></div>
              <button type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(String(selectedId)); setCopyLabel('已复制') } catch { setCopyLabel('复制失败') }
              }}>{copyLabel}</button>
            </dl>
          ) : null}
          <div className="token-id-chips" aria-label="Token ID 选择">
            {result.ids.slice(0, limit).map((id, index) => (
              <button
                type="button"
                key={`${index}-${id}`}
                aria-label={`Token ID ${id}，index ${index}`}
                aria-pressed={selectedIndex === index}
                onClick={() => setSelectedIndex(current => current === index ? null : index)}
              >{id}</button>
            ))}
          </div>
          <div className="table-scroll">
            <table aria-label={tableLabel ?? 'Tokenizer Tokens'}>
              <thead><tr><th>#</th><th>ID</th><th>Special</th><th>Role</th><th>Token Piece</th><th>Decoded</th><th>Mapping</th></tr></thead>
              <tbody>{result.ids.slice(0, limit).map((id, index) => (
                <tr className={selectedIndex === index ? 'selected-token-row' : ''} key={`${index}-${id}`}>
                  <td><button className="table-link" type="button" aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(current => current === index ? null : index)}>{index + 1}</button></td>
                  <td><button className="table-link" type="button" aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(current => current === index ? null : index)}>{id}</button></td>
                  <td>{result.flags[index]?.specialName ?? '—'}</td>
                  <td>{chatRoleLabel(result.roles?.[index] ?? null)}</td>
                  <td>{visiblePiece(result.pieces[index] ?? '', showWhitespace)}</td>
                  <td>{visiblePiece(decoded.get(index) ?? '', showWhitespace)}</td><td>{result.mapping}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {limit < result.ids.length ? <button className="load-more" type="button" onClick={() => setLimit(Math.min(limit + 1000, result.ids.length))}>再显示 1,000 个 Token</button> : null}
          <p className="decoded-text">{result.direction === 'decode' ? `Token IDs：${result.input}` : `权威输入：${authoritativeInput}`}</p>
          <p className="decoded-text">{result.direction === 'decode' ? '解码文本：' : 'Decoded：'}{result.decoded}</p>
        </>
      ) : null}
    </section>
  )
}

function segmentRole(result: Tokenization, segment: { start: number; end: number }): ChatTokenRole | null {
  const roles = result.roles?.slice(segment.start, segment.end) ?? []
  if (roles.length !== segment.end - segment.start || roles.some(role => JSON.stringify(role) !== JSON.stringify(roles[0]))) return null
  return roles[0] ?? null
}

function chatRoleLabel(role: ChatTokenRole | null): string {
  if (role === null) return '—'
  return role.kind === 'template' ? 'template' : role.role
}

function chatRoleClass(role: ChatTokenRole | null): string {
  if (role === null) return ''
  if (role.kind === 'template') return 'role-template'
  return ['system', 'user', 'assistant', 'tool'].includes(role.role) ? `role-${role.role}` : 'role-custom'
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
  return (showWhitespace
    ? piece.replaceAll('\r\n', '↵').replaceAll('\r', '↵').replaceAll('\n', '↵').replaceAll('\t', '␉').replaceAll(' ', '␠')
    : piece.replaceAll('\r\n', ' ').replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('\t', ' ')) || '∅'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function templateLabel(entry: ChatTemplateEntry): string {
  return entry.source === 'jinjaFile'
    ? 'chat_template.jinja'
    : `tokenizer_config.json · ${entry.name}`
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function available<T>(value: T): ConsistencyMaterial<T> {
  return { state: 'available', value }
}

function failed(error: unknown): ConsistencyMaterial<never> {
  return { state: 'failed', message: errorMessage(error) }
}

function isGGUF(file: RepositoryFile): boolean {
  const name = file.path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  return name.endsWith('.gguf') || name.endsWith('.gguf_file')
}

function consistencyCoverageText(status: RepositoryConsistencyReport['coverage'][number]['status']): string {
  if (status.state === 'checked') return '已检查'
  if (status.state === 'missing') return '缺失'
  if (status.state === 'skipped') return `跳过：${status.reason}`
  return `失败：${status.message}`
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
