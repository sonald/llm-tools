import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import logoDark from './assets/model-files-dark.png'
import logoLight from './assets/model-files-light.png'
import {
  formatBytes,
  fullSourcePath,
  imageMimeType,
  isImagePath,
  isImatrixPath,
  loadLocalDirectory,
  loadHttpsSource,
  contentUrl,
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
import {
  autoExpandMatchingPaths,
  buildTensorHierarchy,
  filterTensorSummaries,
  flattenTensorHierarchy,
} from './core/tensorHierarchy.ts'
import {
  decodeStrictText,
  inspectionPerspectives,
  perspectiveLabel,
  validatePdfData,
  type Perspective,
  type PerspectiveDocument,
} from './core/readers.ts'
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
  type ConsistencyAnchor,
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
  isSentencePieceFile,
  parseTokenIds,
  selectTokenizerComparisonTargets,
  type Tokenization,
  type TokenizerStructure,
  type TokenizerVocabularyEntry,
  type VocabularyDiffScope,
} from './core/tokenizer.ts'
import { ImageInspection, PdfInspection, SourceInspection, TextInspection, type FileDiagnostic } from './Readers.tsx'
import { ResizeHandle } from './ResizeHandle.tsx'
import { EmbeddedTemplatePlayground, TemplateWorkbench } from './TemplateWorkbench.tsx'
import { formatNumber, translate as t, type MessageKey } from './i18n.ts'

const categoryLabels: Record<FileCategory, MessageKey> = {
  configuration: 'appCategoryConfiguration',
  tokenizer: 'tokenizer',
  templates: 'appCategoryTemplates',
  weightMetadata: 'appCategoryWeightMetadata',
  documentation: 'appCategoryDocumentation',
  other: 'appCategoryOther',
  weights: 'appCategoryWeights',
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
  | { kind: 'image'; file: RepositoryFile; data: ArrayBuffer; mimeType: string; isSvg: boolean; textContent?: string; bytesRead: number }
  | { kind: 'source'; file: RepositoryFile; content: string; language: string; bytesRead: number }
  | { kind: 'tokenizer'; file: RepositoryFile }
  | {
    kind: 'template'
    file: RepositoryFile
    source: string
  }

type SourceMode = 'huggingface' | 'file' | 'manifest'

type RepositoryError = { message: string; retryable: boolean }
const comparisonDiffScopes: VocabularyDiffScope[] = ['leftOnly', 'rightOnly', 'shared']

export default function App() {
  const [sourceMode, setSourceMode] = useState<SourceMode>('huggingface')
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
  const [consistencyPaths, setConsistencyPaths] = useState<ConsistencyPaths>({})
  const fileDiagnostics = useMemo(() => diagnosticsByPath(consistencyReport, consistencyPaths), [consistencyReport, consistencyPaths])
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<PanelTabId>('problems')
  const badgeRef = useRef<HTMLButtonElement>(null)
  // Native: the inspector starts open and closes (never reopens) once the window drops below 1100 pt.
  const [inspectorOpen, setInspectorOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1100)
  const isNarrow = useMediaQuery('(max-width: 1099px)')
  useEffect(() => { if (isNarrow) setInspectorOpen(false) }, [isNarrow])
  // A JS fact, not CSS: when the inspector is hidden its slot is null and details render inline instead.
  const isPhone = useMediaQuery('(max-width: 640px)')
  const inspectorShown = inspectorOpen && !isPhone
  const problemsOpen = panelOpen && panelTab === 'problems'

  function toggleProblems() {
    if (problemsOpen) {
      setPanelOpen(false)
      return
    }
    flushSync(() => {
      setPanelOpen(true)
      setPanelTab('problems')
    })
    document.getElementById('panel-tab-problems')?.focus()
  }

  function closePanel() {
    // Focus goes back to the badge only when it was in the Problems panel the badge opened.
    const restoreFocus = panelTab === 'problems' && document.activeElement?.closest('.bottom-panel') != null
    setPanelOpen(false)
    if (restoreFocus) badgeRef.current?.focus()
  }
  // Native: Esc closes the panel from any tab, anywhere in the window, unless something closer used it.
  const closePanelRef = useRef(closePanel)
  closePanelRef.current = closePanel
  useEffect(() => {
    if (!panelOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc that ends an IME composition belongs to the input method.
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      closePanelRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [panelOpen])
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null)
  // Native ModelFilesStore.perspective: one header switch for every file kind, reset whenever a file is picked.
  const [perspective, setPerspective] = useState<Perspective>('overview')
  const perspectives = inspectionPerspectivesFor(inspection)
  const shownPerspective = perspectives.includes(perspective) ? perspective : perspectives[0]
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; file: RepositoryFile } | null>(null)

  useEffect(() => {
    if (fileMenu === null) return
    const close = () => setFileMenu(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setFileMenu(null)
    }
    document.addEventListener('click', close)
    document.addEventListener('contextmenu', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('resize', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('contextmenu', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [fileMenu])

  useEffect(() => () => {
    repositoryAbort.current?.abort()
    inspectionAbort.current?.abort()
    resetConsistency()
  }, [])
  useEffect(() => setSelectedFindingId(null), [snapshot])

  useEffect(() => {
    let active = true
    const restore = () => {
      const route = readRoute()
      if (route.repo === null) {
        clearRepository()
      } else {
        setSourceMode('huggingface')
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
          setSourceMode('huggingface')
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

  function openFileMenu(event: React.MouseEvent, file: RepositoryFile) {
    if (snapshot === null) return
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ x: event.clientX, y: event.clientY, file })
  }
  const visibleFiles = useMemo(() => {
    const term = filter.trim().toLocaleLowerCase()
    return snapshot?.files.filter(file => term === '' || file.path.toLocaleLowerCase().includes(term)) ?? []
  }, [filter, snapshot])
  const visibleWeights = visibleFiles.filter(file => file.category === 'weights')

  async function openRepository(event: React.FormEvent) {
    event.preventDefault()
    if (sourceMode === 'huggingface') writeRoute(repositoryInput, null, 'push')
    else clearRoute('push')
    await loadRoute(repositoryInput, null, true, sourceMode)
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
        setPerspective('overview')
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

  async function loadRoute(input: string, requestedPath: string | null, replaceRoute: boolean, mode: SourceMode = 'huggingface') {
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
      const next = mode === 'huggingface'
        ? await loadRepository(input, controller.signal)
        : await loadHttpsSource(input, mode, controller.signal)
      if (controller.signal.aborted || repositoryAbort.current !== controller) return
      consistencySnapshotIdentity.current = snapshotIdentity(next)
      setSnapshot(next)
      if (next.source === 'huggingface') {
        setRepositoryInput(next.modelId)
        setRepositoryHistory(current => {
          const updated = addRepositoryHistory(current, next.modelId)
          saveRepositoryHistory(updated)
          return updated
        })
      }
      const preferred = requestedPath === null
        ? next.files.find(file => file.path === 'config.json') ?? next.files.find(file => !isBlocked(file))
        : next.files.find(file => file.path === requestedPath)
      if (requestedPath !== null && preferred === undefined) {
        setRepositoryError({ message: t('appDeepLinkFileMissing', { path: requestedPath }), retryable: false })
        if (replaceRoute && next.source === 'huggingface') writeRoute(next.modelId, requestedPath, 'replace')
        startConsistency(next)
        return
      }
      if (preferred !== undefined) {
        setPerspective('overview')
        setSelectedPath(preferred.path)
        await inspectFile(next, preferred)
        if (consistencySnapshotIdentity.current !== snapshotIdentity(next)) return
        startConsistency(next)
        if (replaceRoute && next.source === 'huggingface') writeRoute(next.modelId, preferred.path, 'replace')
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
    setPerspective('overview')
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
        if (file.size === null) throw new Error(t('appSafeTensorsSizeUnavailable'))
        const prefix = await readExactRange(activeSnapshot, file, 0, 7, controller.signal)
        const headerLength = safeTensorsHeaderLength(prefix)
        if (headerLength + 8 > file.size) throw new Error(t('appSafeTensorsHeaderTooLarge'))
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
      } else if (file.path.split('/').at(-1)?.toLocaleLowerCase() === 'tokenizer.json'
        || isSentencePieceFile(file)) {
        next = { kind: 'tokenizer', file }
      } else if (lower.endsWith('.pdf')) {
        const data = await readWholeFile(activeSnapshot, file, controller.signal)
        validatePdfData(data)
        next = { kind: 'pdf', file, data, bytesRead: data.byteLength }
      } else if (isImagePath(file.path)) {
        const data = await readWholeFile(activeSnapshot, file, controller.signal)
        const isSvg = lower.endsWith('.svg')
        let textContent: string | undefined
        if (isSvg) {
          try { textContent = decodeStrictText(data) } catch { /* ignore */ }
        }
        next = {
          kind: 'image',
          file,
          data,
          mimeType: imageMimeType(file.path),
          isSvg,
          textContent,
          bytesRead: data.byteLength,
        }
      } else if (lower.endsWith('.jinja')) {
        // D-8: native reads .jinja like any readable file, without a template-specific 64 KiB cap.
        next = { kind: 'template', file, source: decodeStrictText(await readWholeFile(activeSnapshot, file, controller.signal)) }
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
            parsed: json ? parseDisplayJSON(decoded) : null,
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
    setConsistencyPaths({})
    setPanelOpen(false)
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
      setConsistencyPaths({
        config: selected.config?.path,
        generationConfig: selected.generationConfig?.path,
        tokenizerConfig: selected.tokenizerConfig?.path,
      })
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
      ? { state: 'skipped', reason: t('ggufWebSkippedReason') }
      : { state: 'skipped', reason: t('appGgufNotOpenedThisSession') }
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
          <SourceSelect value={sourceMode} onChange={mode => {
            clearRepository()
            clearRoute('push')
            setSourceMode(mode)
            setRepositoryInput('')
          }} />
          <label className="sr-only" htmlFor="repository">{t(sourceMode === 'huggingface' ? 'appHuggingFaceRepositoryLabel' : 'appHttpsUrlLabel')}</label>
          <input
            id="repository"
            list={sourceMode === 'huggingface' ? 'repository-examples' : undefined}
            autoComplete="off"
            value={repositoryInput}
            onChange={event => setRepositoryInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={sourceMode === 'huggingface' ? t('appRepositoryPlaceholder') : 'https://…'}
            spellCheck={false}
          />
          <datalist id="repository-examples">
            {repositoryHistory.map(modelId => <option value={modelId} key={modelId.toLocaleLowerCase()} />)}
            <option value="Qwen/Qwen3-0.6B" />
            <option value="bartowski/Qwen_Qwen3-0.6B-GGUF" />
          </datalist>
          <button className="primary-button" type="submit">
            {isLoadingRepository ? t('appRepositoryOpeningAction') : t('appRepositoryOpenAction')}
          </button>
          <label className="directory-button">
            {t('appSelectLocalDirectory')}
            <input
              type="file"
              multiple
              aria-label={t('appSelectLocalDirectory')}
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
            }}>{t('appClearHistoryAction')}</button>
          ) : null}
        </form>
        <div className="toolbar-end">
          <div className="repository-status" aria-live="polite">
            {snapshot !== null
              ? <><CheckCircleIcon />{sourceStatus(snapshot, inspection.kind === 'empty' ? null : inspection.file)}</>
              : isLoadingRepository ? <span className="spinner" role="status" aria-label={t('appLoadingManifestStatus')} /> : null}
          </div>
          <button className="icon-button panel-toggle" type="button" aria-label={t('appTogglePanelAction')}
            title={t('appTogglePanelAction')} aria-pressed={panelOpen} disabled={snapshot === null}
            onClick={() => setPanelOpen(open => !open)}>
            <PanelIcon />
          </button>
          {!isPhone ? (
            <button className="icon-button inspector-toggle" type="button" aria-label={t('appToggleInspectorAction')}
              title={t('appToggleInspectorAction')} aria-pressed={inspectorShown} onClick={() => setInspectorOpen(open => !open)}>
              <InspectorIcon />
            </button>
          ) : null}
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          {sourceMode !== 'huggingface' ? <details className="https-help" open>
            <summary>{t('appHttpsHelp')}</summary>
            <p>{t('appHttpsHint')}</p>
            <p>{t(sourceMode === 'file' ? 'appHttpsFileHint' : 'appHttpsManifestHint')}</p>
            {sourceMode === 'manifest' ? <pre>{JSON.stringify({ files: [{ path: 'config.json', url: './config.json', size: 2 }] }, null, 2)}</pre> : null}
          </details> : null}
          <label className="search-field">
            <SearchIcon />
            <span className="sr-only">{t('appFilterFilesLabel')}</span>
            <input value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('appFilterFilesLabel')} />
          </label>
          {isLoadingRepository && snapshot === null ? (
            <div className="sidebar-loading" role="status"><span className="spinner" />{t('appLoadingManifestStatus')}</div>
          ) : snapshot === null ? (
            <EmptyState icon="box" title={t('appNoModelOpenTitle')} message={t('appNoModelOpenMessage')} />
          ) : filter.trim() !== '' && visibleFiles.length === 0 ? (
            <EmptyState icon="search" title={t('appNoMatchingFilesTitle')} message={t('appNoMatchingFilesMessage')}
              action={t('appClearFilterAction')} onAction={() => setFilter('')} />
          ) : null}
          <nav aria-label={t('appRepositoryFilesAriaLabel')}>
            {(Object.keys(categoryLabels) as FileCategory[]).filter(category => category !== 'weights').map(category => {
              const files = visibleFiles.filter(file => file.category === category)
              if (files.length === 0) return null
              return (
                <section className="file-group" key={category}>
                  <h2>{t(categoryLabels[category])}</h2>
                  {files.map(file => <FileRow key={file.path} file={file} selected={selectedPath === file.path}
                    diagnostics={fileDiagnostics.get(file.path)} onSelect={() => selectFile(file)} onContextMenu={openFileMenu} />)}
                </section>
              )
            })}
            {visibleWeights.length > 0 ? (
              // Native: a collapsed disclosure; locked rows dimmed and unselectable, no problem counts (B-11).
              <details className="file-group weights-group">
                <summary>
                  <LockIcon />
                  <span>{t('appCategoryWeights')}</span>
                  <small>{t('appWeightsPreviewable', {
                    count: formatNumber(visibleWeights.filter(file => !isBlocked(file)).length),
                    total: formatNumber(visibleWeights.length),
                  })}</small>
                </summary>
                {visibleWeights.map(file => <FileRow key={file.path} file={file} selected={selectedPath === file.path}
                  onSelect={() => selectFile(file)} onContextMenu={openFileMenu} />)}
              </details>
            ) : null}
          </nav>
        </aside>
        <Detail
          header={<FileHeader
            inspection={inspection}
            perspectives={perspectives}
            perspective={shownPerspective}
            onPerspectiveChange={setPerspective}
            snapshot={snapshot}
            report={consistencyReport}
            reportOpen={problemsOpen}
            badgeRef={badgeRef}
            onToggleConsistency={toggleProblems}
          />}
          inspection={inspection}
          snapshot={snapshot}
          report={consistencyReport}
          panelOpen={panelOpen}
          panelTab={panelTab}
          onSelectPanelTab={setPanelTab}
          onOpenToolPanel={() => {
            // Never pull an open panel away from the tab the user is reading; phones lack the height to auto-open.
            if (panelOpen || isPhone) return
            setPanelOpen(true)
            setPanelTab(current => current === 'problems' ? 'tokens' : current)
          }}
          onClosePanel={closePanel}
          perspective={shownPerspective}
          onPerspectiveChange={setPerspective}
          diagnostics={(selectedPath === null ? undefined : fileDiagnostics.get(selectedPath)) ?? noDiagnostics}
          inspectorOpen={inspectorShown}
          selectedFindingId={selectedFindingId}
          onSelectFinding={id => {
            setSelectedFindingId(id)
            setInspectorOpen(true)
          }}
          repositoryError={repositoryError}
          onRetryRepository={() => void loadRoute(repositoryInput, readRoute().file, true, sourceMode)}
          onRetry={() => {
          if (snapshot !== null && inspection.kind !== 'empty') void inspectFile(snapshot, inspection.file)
        }} />
      </div>
      {fileMenu !== null && snapshot !== null ? (() => {
        const url = fullSourcePath(snapshot, fileMenu.file)
        return (
          <div
            className="file-context-menu"
            role="menu"
            aria-label={t('appFileActionsMenuAriaLabel')}
            style={{
              left: Math.max(8, Math.min(fileMenu.x, window.innerWidth - 216)),
              top: Math.max(8, Math.min(fileMenu.y, window.innerHeight - 148)),
            }}
          >
            {url !== null ? (
              <button type="button" role="menuitem" onClick={() => {
                window.open(url, '_blank', 'noopener,noreferrer')
                setFileMenu(null)
              }}>{t('appOpenOriginalFileAction')}</button>
            ) : null}
            {url !== null ? (
              <button type="button" role="menuitem" onClick={() => {
                void navigator.clipboard.writeText(url).catch(() => {})
                setFileMenu(null)
              }}>{t('appCopyFullPathAction')}</button>
            ) : null}
            <button type="button" role="menuitem" onClick={() => {
              void navigator.clipboard.writeText(fileMenu.file.path).catch(() => {})
              setFileMenu(null)
            }}>{t('appCopyRelativePathAction')}</button>
          </div>
        )
      })() : null}
    </main>
  )
}

// The file half of the unified toolbar: breadcrumb, path actions and the consistency badge.
function FileHeader({
  inspection,
  perspectives,
  perspective,
  onPerspectiveChange,
  snapshot,
  report,
  reportOpen,
  badgeRef,
  onToggleConsistency,
}: {
  inspection: Inspection
  perspectives: Perspective[]
  perspective: Perspective
  onPerspectiveChange(perspective: Perspective): void
  snapshot: RepositorySnapshot | null
  report: RepositoryConsistencyReport | null
  reportOpen: boolean
  badgeRef: React.RefObject<HTMLButtonElement | null>
  onToggleConsistency(): void
}) {
  const [copyLabel, setCopyLabel] = useState(() => t('appCopyPathAction'))
  const [fullCopyLabel, setFullCopyLabel] = useState(() => t('appCopyFullPathAction'))
  const file = inspection.kind === 'empty' ? null : inspection.file
  useEffect(() => setCopyLabel(t('appCopyPathAction')), [file?.path])
  useEffect(() => setFullCopyLabel(t('appCopyFullPathAction')), [file?.path])
  const fullUrl = file === null || snapshot === null ? null : fullSourcePath(snapshot, file)
  const sourceHref = file === null || snapshot === null ? undefined
    : snapshot.source === 'huggingface' ? `https://huggingface.co/${snapshot.modelId}/blob/${snapshot.revision}/${file.path}`
      : snapshot.source === 'https' ? contentUrl(snapshot, file) : undefined

  async function copy(text: string, setLabel: (label: string) => void) {
    try {
      await navigator.clipboard.writeText(text)
      setLabel(t('templateCopiedState'))
    } catch {
      setLabel(t('templateCopyFailedState'))
    }
  }

  if (file === null) return null
  const chip = formatChip(inspection)
  // Native DetailHeader order: title and subtitle, consistency badge, format chip, perspective switch, path actions.
  return (
    <header className="detail-header">
      <div className="file-title">
        <h1 title={file.path}>{file.path.split('/').at(-1)}</h1>
        <p>{[filePurpose(file), file.size === null ? null : formatBytes(file.size), snapshot === null ? null : sourceStatus(snapshot, file)]
          .filter(part => part !== null).join(' · ')}</p>
      </div>
      {snapshot !== null ? (
        <ConsistencyBadge ref={badgeRef} report={report} open={reportOpen} onToggle={onToggleConsistency} />
      ) : null}
      {chip !== null ? <span className="format-chip">{chip}</span> : null}
      <div className="perspective header-perspective" role="group" aria-label={t('readerReadingView')}>
        {perspectives.map(item => (
          <button type="button" aria-pressed={perspective === item} key={item}
            disabled={!perspectiveReady(inspection)} onClick={() => onPerspectiveChange(item)}>
            {perspectiveLabel(item, perspectiveDocument(inspection), file.path)}
          </button>
        ))}
      </div>
      <div className="header-actions">
        <button className="icon-button path-copy" type="button" aria-label={copyLabel} title={t('appHeaderCopyPathHelp')}
          onClick={() => void copy(file.path, setCopyLabel)}>
          {copyLabel === t('templateCopiedState') ? <CheckIcon /> : <CopyIcon />}
        </button>
        {/* Native disables what the source cannot do; local files have no browser-visible full path (P-4). */}
        <button className="icon-button path-copy" type="button" aria-label={fullCopyLabel} title={t('appHeaderCopyFullPathHelp')}
          disabled={fullUrl === null} onClick={() => { if (fullUrl !== null) void copy(fullUrl, setFullCopyLabel) }}>
          {fullCopyLabel === t('templateCopiedState') ? <CheckIcon /> : <LinkIcon />}
        </button>
        {sourceHref !== undefined ? (
          <a className="icon-button source-link" href={sourceHref} target="_blank" rel="noreferrer"
            aria-label={t('appSourceLinkAction')} title={t('appHeaderOpenSourceHelp')}>
            <ExternalIcon />
          </a>
        ) : (
          <button className="icon-button source-link" type="button" aria-label={t('appSourceLinkAction')}
            title={t('appHeaderOpenSourceHelp')} disabled>
            <ExternalIcon />
          </button>
        )}
      </div>
    </header>
  )
}

function SourceSelect({ value, onChange }: { value: SourceMode; onChange(value: SourceMode): void }) {
  return <select className="source-select" aria-label={t('appSourceLabel')} value={value}
    onChange={event => onChange(event.target.value as SourceMode)}>
    <option value="huggingface">Hugging Face</option>
    <option value="file">{t('appHttpsFile')}</option>
    <option value="manifest">{t('appHttpsManifest')}</option>
  </select>
}

function Detail({
  header,
  inspection,
  perspective,
  onPerspectiveChange,
  snapshot,
  report,
  panelOpen,
  panelTab,
  onSelectPanelTab,
  onOpenToolPanel,
  onClosePanel,
  diagnostics,
  inspectorOpen,
  selectedFindingId,
  onSelectFinding,
  onRetry,
  repositoryError,
  onRetryRepository,
}: {
  repositoryError: RepositoryError | null
  onRetryRepository(): void
  header: React.ReactNode
  inspection: Inspection
  perspective: Perspective
  onPerspectiveChange(perspective: Perspective): void
  snapshot: RepositorySnapshot | null
  report: RepositoryConsistencyReport | null
  panelOpen: boolean
  panelTab: PanelTabId
  onSelectPanelTab(id: PanelTabId): void
  onOpenToolPanel(): void
  onClosePanel(): void
  diagnostics: FileDiagnostic[]
  inspectorOpen: boolean
  selectedFindingId: string | null
  onSelectFinding(id: string): void
  onRetry(): void
}) {
  const [toolTabs, setToolTabs] = useState<ToolTab[]>([])
  // Native: panel 110–600 pt tall (240 default), inspector 220–380 pt wide (260 ideal).
  const [panelHeight, setPanelHeight] = useState(240)
  const [inspectorWidth, setInspectorWidth] = useState(260)
  const [panelBody, setPanelBody] = useState<HTMLElement | null>(null)
  const [inspectorSlot, setInspectorSlot] = useState<HTMLElement | null>(null)
  const activeTab: PanelTabId = toolTabs.some(tab => tab.id === panelTab) ? panelTab : 'problems'
  // When the docked result goes away (comparison opened, file left), its open tab closes with it
  // instead of falling back to Problems the user never asked for.
  const hadToolTabs = useRef(false)
  useEffect(() => {
    if (hadToolTabs.current && toolTabs.length === 0 && panelTab !== 'problems') {
      if (panelOpen) onClosePanel()
      onSelectPanelTab('problems')
    }
    hadToolTabs.current = toolTabs.length > 0
  }, [toolTabs.length, panelOpen, panelTab, onClosePanel, onSelectPanelTab])
  const slots = useMemo<WorkspaceSlots>(() => ({
    panelBody: panelOpen && activeTab !== 'problems' ? panelBody : null,
    activeTab,
    inspector: inspectorOpen ? inspectorSlot : null,
    registerTabs: setToolTabs,
    openToolPanel: onOpenToolPanel,
  }), [panelOpen, activeTab, panelBody, inspectorOpen, inspectorSlot, onOpenToolPanel])

  // Shared frame: content on top, the bottom panel below it, the inspector on the right.
  return (
    <WorkspaceSlotsContext.Provider value={slots}>
      <section className="detail">
        <div className="detail-main">
          {header}
          <DetailBody inspection={inspection} perspective={perspective} onPerspectiveChange={onPerspectiveChange}
            snapshot={snapshot} diagnostics={diagnostics}
            selectedFindingId={selectedFindingId} onSelectFinding={onSelectFinding} onRetry={onRetry}
            repositoryError={repositoryError} onRetryRepository={onRetryRepository} />
          {panelOpen ? <ResizeHandle axis="y" value={panelHeight} min={110} max={600} onChange={setPanelHeight} /> : null}
          {panelOpen ? (
            <BottomPanel
              height={panelHeight}
              tabs={toolTabs}
              activeTab={activeTab}
              onSelectTab={onSelectPanelTab}
              report={report}
              selectedFindingId={selectedFindingId}
              onSelectFinding={onSelectFinding}
              onClose={onClosePanel}
              bodyRef={setPanelBody}
            />
          ) : null}
        </div>
        {inspectorOpen ? (
          <div className="inspector-column" style={{ '--inspector-width': `${inspectorWidth}px` } as React.CSSProperties}>
            <ResizeHandle axis="x" value={inspectorWidth} min={220} max={380} onChange={setInspectorWidth} />
            <Inspector inspection={inspection} report={report} selectedFindingId={selectedFindingId} slotRef={setInspectorSlot} />
          </div>
        ) : null}
      </section>
    </WorkspaceSlotsContext.Provider>
  )
}

type PanelTabId = 'problems' | 'tokens' | 'ids'
type ToolTab = { id: Exclude<PanelTabId, 'problems'>; label: string; count?: number }
type WorkspaceSlots = {
  panelBody: HTMLElement | null
  activeTab: PanelTabId
  inspector: HTMLElement | null
  registerTabs(tabs: ToolTab[]): void
  openToolPanel(): void
}
// Views portal their panel tabs and inspector details into these slots; null means "render inline".
const WorkspaceSlotsContext = createContext<WorkspaceSlots | null>(null)

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

function DetailBody({
  inspection, perspective, onPerspectiveChange, snapshot, diagnostics, selectedFindingId, onSelectFinding, onRetry,
  repositoryError, onRetryRepository,
}: {
  repositoryError: RepositoryError | null
  onRetryRepository(): void
  inspection: Inspection
  perspective: Perspective
  onPerspectiveChange(perspective: Perspective): void
  snapshot: RepositorySnapshot | null
  diagnostics: FileDiagnostic[]
  selectedFindingId: string | null
  onSelectFinding(id: string): void
  onRetry(): void
}) {
  if (inspection.kind === 'empty') {
    return (
      <div className="detail-body">
        {repositoryError !== null
          ? <EmptyState icon="warning" title={t('appUnableToOpenLocationTitle')} message={repositoryError.message} tone="error"
            action={repositoryError.retryable ? t('appRetryAction') : undefined} onAction={onRetryRepository} />
          : <EmptyState icon="document" title={t('appSelectFileTitle')} message={t('appSelectFileMessage')} />}
      </div>
    )
  }
  const file = inspection.file
  return (
      <div className="detail-body" aria-live="polite" aria-busy={inspection.kind === 'loading'}>
        {inspection.kind === 'loading' ? <LoadingState file={file} snapshot={snapshot} /> : null}
        {inspection.kind === 'error' ? (
          <EmptyState icon="offline" title={t('appUnableToReadFileTitle')} message={inspection.message} action={t('appRetryAction')} onAction={onRetry} tone="error" />
        ) : null}
        {inspection.kind === 'locked' ? (
          <EmptyState icon="lock" title={t('appLockedWeightsTitle')} message={t('appLockedWeightsMessage')} />
        ) : null}
        {inspection.kind === 'text' && snapshot !== null ? (
          <TextInspection
            key={`${snapshotIdentity(snapshot)}/${file.path}`}
            snapshot={snapshot}
            path={file.path}
            category={file.category}
            content={inspection.content}
            parsed={inspection.parsed}
            json={inspection.json}
            diagnostics={diagnostics}
            selectedDiagnosticId={selectedFindingId}
            onSelectDiagnostic={onSelectFinding}
            perspective={perspective}
            onPerspectiveChange={onPerspectiveChange}
            overviewExtra={embeddedChatTemplate(file, inspection.parsed)}
          />
        ) : null}
        {inspection.kind === 'safetensors' && snapshot !== null
          ? <SafeTensorsInspection key={file.path} inspection={inspection} snapshot={snapshot} perspective={perspective} />
          : null}
        {inspection.kind === 'gguf' && snapshot !== null ? <GGUFInspection inspection={inspection} snapshot={snapshot} /> : null}
        {inspection.kind === 'imatrix' ? <ImatrixInspection inspection={inspection} perspective={perspective} /> : null}
        {inspection.kind === 'pdf' ? <PdfInspection data={inspection.data} /> : null}
        {inspection.kind === 'image' ? (
          <ImageInspection
            key={file.path}
            file={file}
            data={inspection.data}
            mimeType={inspection.mimeType}
            isSvg={inspection.isSvg}
            textContent={inspection.textContent}
            bytesRead={inspection.bytesRead}
            perspective={perspective}
          />
        ) : null}
        {inspection.kind === 'source' && snapshot !== null ? (
          <SourceInspection
            key={`${snapshotIdentity(snapshot)}/${file.path}`}
            content={inspection.content}
            language={inspection.language}
            label={file.path}
            perspective={perspective}
          />
        ) : null}
        {inspection.kind === 'template' && snapshot !== null ? (
          <TemplateWorkbench
            key={`${snapshotIdentity(snapshot)}/${file.path}`}
            initialSource={inspection.source}
            perspective={perspective === 'source' || perspective === 'playground' ? perspective : 'overview'}
            onPerspectiveChange={onPerspectiveChange}
          />
        ) : null}
        {inspection.kind === 'tokenizer' && snapshot !== null ? (
          <TokenizerInspection
            key={`${snapshot.source === 'huggingface' ? `${snapshot.modelId}@${snapshot.revision}` : snapshot.selectionId}/${file.path}`}
            snapshot={snapshot}
            file={file}
            perspective={perspective}
          />
        ) : null}
        <SafetyNotice inspection={inspection} />
      </div>
  )
}

function perspectiveDocument(inspection: Inspection): PerspectiveDocument {
  switch (inspection.kind) {
    case 'safetensors': case 'gguf': case 'imatrix': case 'pdf': case 'image': return inspection.kind
    case 'template': return 'jinja'
    default: return 'generic'
  }
}

// Native disables the switch until the document is read; it still lists only 概览 then.
function perspectiveReady(inspection: Inspection): boolean {
  return inspection.kind !== 'empty' && inspection.kind !== 'loading' && inspection.kind !== 'error' && inspection.kind !== 'locked'
}

function inspectionPerspectivesFor(inspection: Inspection): Perspective[] {
  if (inspection.kind === 'empty') return ['overview']
  // A SentencePiece .model opens straight into 试验台 even while loading, like native availablePerspectives.
  const listed = inspectionPerspectives(perspectiveDocument(inspection), inspection.file.path)
  return perspectiveReady(inspection) || listed[0] === 'playground' ? listed : ['overview']
}

// Native TokenizerSummaryView: the config's own chat_template, collapsed, with live inputs once expanded.
function embeddedChatTemplate(file: RepositoryFile, parsed: unknown): React.ReactNode {
  if (file.path.split('/').at(-1)?.toLocaleLowerCase() !== 'tokenizer_config.json') return null
  if (!isUnknownRecord(parsed) || typeof parsed.chat_template !== 'string' || parsed.chat_template === '') return null
  return (
    <EmbeddedTemplatePlayground key={file.path} template={parsed.chat_template} tokenizerConfig={parsed} />
  )
}

function SafeTensorsInspection({
  inspection,
  snapshot,
  perspective,
}: {
  inspection: Extract<Inspection, { kind: 'safetensors' }>
  snapshot: RepositorySnapshot
  perspective: Perspective
}) {
  const { summary } = inspection
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(100)
  const [selectedName, setSelectedName] = useState(summary.tensors[0]?.name ?? '')
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(() => new Set())
  const [searchAutoExpand, setSearchAutoExpand] = useState(false)
  const [showsInspector, setShowsInspector] = useState(true)
  useEffect(() => {
    setFilter('')
    setLimit(100)
    setSearchAutoExpand(false)
  }, [perspective])
  const term = filter.trim().toLocaleLowerCase()
  const metadata = Object.entries(summary.metadata).sort(([left], [right]) => left.localeCompare(right))
  const matchingMetadata = metadata.filter(([key, value]) => term === '' || key.toLocaleLowerCase().includes(term)
    || value.toLocaleLowerCase().includes(term))
  const matchingTensors = useMemo(() => filterTensorSummaries(summary.tensors, filter), [summary.tensors, filter])
  const hierarchy = useMemo(() => buildTensorHierarchy(matchingTensors), [matchingTensors])
  const autoExpanded = useMemo(() => searchAutoExpand && term !== ''
    ? autoExpandMatchingPaths(hierarchy, filter)
    : new Set<string>(), [filter, hierarchy, searchAutoExpand, term])
  const expanded = useMemo(() => new Set([...manualExpanded, ...autoExpanded]), [autoExpanded, manualExpanded])
  const rows = useMemo(() => flattenTensorHierarchy(hierarchy, expanded), [expanded, hierarchy])
  const visibleRows = rows.slice(0, limit)
  const selected = summary.tensors.find(tensor => tensor.name === selectedName) ?? null
  const breadcrumb = selected === null
    ? ''
    : (selected.name.split('.').filter(Boolean).length > 0
      ? selected.name.split('.').filter(Boolean)
      : selected.name ? [selected.name] : []).join(' › ')

  const toggleGroup = (id: string) => {
    setManualExpanded(current => {
      const next = new Set(expanded)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (term !== '') setSearchAutoExpand(false)
  }

  return (
    <div className="inspection-canvas">
      {perspective === 'overview' ? (
        <>
          <MetricGrid items={[
            [t('appTensorCountLabel'), formatNumber(summary.tensors.length)],
            [t('appParameterTotalLabel'), formatNumber(summary.parameterCount)],
            [t('appDataRegionSizeLabel'), formatBigBytes(summary.dataBytes)],
            [t('metadataFieldCountLabel'), formatNumber(metadata.length)],
          ]} />
          <p className="scope-note">{t('appSafeTensorsScopeNote')}</p>
        </>
      ) : null}
      {perspective !== 'overview' ? (
        <div className="inspection-toolbar">
          <label>
            <span>{perspective === 'metadata' ? t('appFilterMetadataLabel') : t('appFilterTensorLabel')}</span>
            <input value={filter} onChange={event => {
              const nextFilter = event.target.value
              setFilter(nextFilter)
              setLimit(100)
              if (perspective === 'tensors') setSearchAutoExpand(nextFilter.trim() !== '')
            }} placeholder={perspective === 'metadata' ? t('appKeyOrValueContainsPlaceholder') : t('appNameOrDtypeContainsPlaceholder')} />
          </label>
          <span>{perspective === 'metadata'
            ? t('readerShowingCount', {
              visible: formatNumber(matchingMetadata.length),
              total: formatNumber(metadata.length),
            })
            : t('appShowingTensorCount', {
              visible: formatNumber(visibleRows.length),
              matching: formatNumber(matchingTensors.length),
              total: formatNumber(summary.tensors.length),
            })}</span>
        </div>
      ) : null}
      {perspective === 'metadata' ? (
        <section className="inspection-section">
          <h2>{t('appMetadataTab')}</h2>
          <DataTable
            label={t('appSafeTensorsMetadataTableAriaLabel')}
            columns={[t('appKeyColumn'), t('appValueColumn')]}
            rows={matchingMetadata}
          />
        </section>
      ) : null}
      {perspective === 'tensors' ? (
        <>
          <div className="tensor-toolbar-actions">
            <button className="tensor-action" type="button" onClick={() => {
              setManualExpanded(new Set())
              setSearchAutoExpand(false)
            }}>{t('appCollapseAllAction')}</button>
            <button className="tensor-action" type="button" onClick={() => setShowsInspector(current => !current)}>
              {showsInspector ? t('appHideTensorDetailsAction') : t('appShowTensorDetailsAction')}
            </button>
          </div>
          <div className={`tensor-layout${showsInspector ? '' : ' tensor-layout-inspector-hidden'}`}>
            <section className="tensor-outline">
              <div className="table-scroll tensor-table-scroll">
                <table aria-label={t('appSafeTensorsTensorsTableAriaLabel')}>
                  <thead><tr>
                    <th>{t('appTensorColumn')}</th><th>{t('appDTypeColumn')}</th><th>{t('appShapeColumn')}</th>
                    <th>{t('appParametersColumn')}</th><th>{t('appBytesColumn')}</th>
                  </tr></thead>
                  <tbody>{visibleRows.map(row => {
                    const isGroup = row.children.length > 0 || row.tensor === undefined
                    if (isGroup) {
                      const isExpanded = expanded.has(row.id)
                      return (
                        <tr key={row.id} className="tensor-group-row">
                          <td colSpan={5}>
                            <button
                              className="tensor-group-toggle"
                              type="button"
                              aria-expanded={isExpanded}
                              aria-label={t(isExpanded ? 'appCollapseGroupAction' : 'appExpandGroupAction', {
                                label: row.label,
                                count: formatNumber(row.descendantCount),
                              })}
                              style={{ paddingLeft: `${8 + row.depth * 16}px` }}
                              onClick={() => toggleGroup(row.id)}
                            >
                              <span aria-hidden="true" className={`tensor-disclosure${isExpanded ? ' expanded' : ''}`} />
                              <span>{row.label}</span>
                              <span className="tensor-group-count">{t('appTensorGroupCount', { count: formatNumber(row.descendantCount) })}</span>
                            </button>
                          </td>
                        </tr>
                      )
                    }
                    const tensor = row.tensor
                    if (tensor === undefined) return null
                    return (
                      <tr key={row.id} className={selectedName === tensor.name ? 'tensor-leaf-row selected' : 'tensor-leaf-row'}>
                        <td>
                          <button
                            className="table-link tensor-leaf-link"
                            type="button"
                            aria-label={tensor.name}
                            aria-pressed={selectedName === tensor.name}
                            title={tensor.name}
                            style={{ paddingLeft: `${8 + row.depth * 16}px` }}
                            onClick={() => setSelectedName(tensor.name)}
                          >{row.label}</button>
                        </td>
                        <td>{tensor.dtype}</td><td>{`[${tensor.shape.join(', ')}]`}</td>
                        <td>{formatNumber(tensor.parameters)}</td><td>{formatNumber(tensor.bytes)}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
              {visibleRows.length < rows.length ? (
                <button className="load-more" type="button" onClick={() => setLimit(Math.min(limit + 100, rows.length))}>{t('appShowMoreTensorRowsAction')}</button>
              ) : null}
            </section>
            {showsInspector && selected !== null ? (
              <aside className="tensor-inspector inspection-section">
                <h2>{t('appSelectedTensorTitle', { name: selected.name })}</h2>
                <p className="tensor-breadcrumb" aria-label={t('appTensorBreadcrumbAriaLabel', { path: breadcrumb })}>{breadcrumb}</p>
                <MetricGrid items={[
                  [t('appDTypeColumn'), selected.dtype], [t('appShapeColumn'), `[${selected.shape.join(', ')}]`],
                  [t('appDataOffsetsLabel'), `${selected.dataStart}–${selected.dataEnd}`],
                  [t('appBytesColumn'), formatNumber(selected.bytes)],
                ]} />
              </aside>
            ) : null}
          </div>
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
      aria-label={t('appViewConsistencyReportAriaLabel')}
      aria-expanded={open}
      data-consistency-state={state.state}
      title={t('appViewConsistencyReportAriaLabel')}
      ref={ref}
      onClick={onToggle}
    ><BadgeIcon state={state.state} />{state.label}</button>
  )
}

function BottomPanel({ height, tabs, activeTab, onSelectTab, report, selectedFindingId, onSelectFinding, onClose, bodyRef }: {
  height: number
  tabs: ToolTab[]
  activeTab: PanelTabId
  onSelectTab(id: PanelTabId): void
  report: RepositoryConsistencyReport | null
  selectedFindingId: string | null
  onSelectFinding(id: string): void
  onClose(): void
  bodyRef(element: HTMLElement | null): void
}) {
  // Native order: Problems first, then the docked tool tabs; a count pill only where there is a count.
  const allTabs: Array<{ id: PanelTabId; label: string; count?: number }> = [
    { id: 'problems', label: t('appProblemsTab'), count: report?.findings.length },
    ...tabs,
  ]
  return (
    <section className="bottom-panel" aria-label={t('appBottomPanelAriaLabel')}
      style={{ '--panel-height': `${height}px` } as React.CSSProperties}>
      <div className="panel-tabs">
        <div role="tablist" aria-label={t('appBottomPanelAriaLabel')}>
          {allTabs.map(tab => (
            <button key={tab.id} className="panel-tab" type="button" role="tab" id={`panel-tab-${tab.id}`}
              aria-selected={activeTab === tab.id} aria-controls={`panel-${tab.id}`} onClick={() => onSelectTab(tab.id)}>
              {tab.label}
              {tab.count !== undefined ? <> <span className="panel-tab-count">{formatNumber(tab.count)}</span></> : null}
            </button>
          ))}
        </div>
        {activeTab === 'problems' ? <span className="panel-state">{consistencyBadgeState(report).label}</span> : null}
        <button className="icon-button" type="button" aria-label={t('appCloseAction')} title={t('appCloseAction')} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {activeTab === 'problems' ? (
        <div className="panel-body" role="tabpanel" id="panel-problems" aria-label={t('appRepositoryConsistencyReportAriaLabel')}>
          <ConsistencyReportBody report={report} selectedId={selectedFindingId} onSelect={onSelectFinding} />
        </div>
      ) : (
        <div className="panel-body" role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`panel-tab-${activeTab}`} ref={bodyRef} />
      )}
    </section>
  )
}

// Native draws these splits by hand too; dragging the bottom panel's top edge or the inspector's left edge.
function Inspector({ inspection, report, selectedFindingId, slotRef }: {
  inspection: Inspection
  report: RepositoryConsistencyReport | null
  selectedFindingId: string | null
  slotRef(element: HTMLElement | null): void
}) {
  const finding = report?.findings.find(item => item.id === selectedFindingId) ?? null
  const file = inspection.kind === 'empty' ? null : inspection.file
  // ponytail: path and size only; format and bytes read already sit in the content's own strip and the status bar.
  return (
    <aside className="inspector" aria-label={t('appInspectorAriaLabel')}>
      <div className="inspector-slot" ref={slotRef} />
      {finding !== null ? (
        <section className="inspector-section" data-severity={finding.severity}>
          <h2>{t('appInspectorSelectedProblem')}</h2>
          <h3><SeverityMark severity={finding.severity} />{finding.title}</h3>
          <FindingComparison finding={finding} />
          <p>{finding.detail}</p>
        </section>
      ) : null}
      {file !== null ? (
        <section className="inspector-section">
          <h2>{t('appInspectorFileSection')}</h2>
          <dl className="inspector-facts">
            <div><dt>{t('appInspectorPathLabel')}</dt><dd>{file.path}</dd></div>
            <div><dt>{t('appInspectorSizeLabel')}</dt><dd>{file.size === null ? t('appUnknownSize') : formatBytes(file.size)}</dd></div>
          </dl>
        </section>
      ) : null}
      {finding === null && file === null ? <p className="inspector-empty">{t('appInspectorEmpty')}</p> : null}
    </aside>
  )
}

function FindingComparison({ finding }: { finding: RepositoryConsistencyReport['findings'][number] }) {
  return (
    <dl className="finding-comparison">
      <div><dt>{finding.left.key}</dt><dd>{finding.left.value}</dd></div>
      <div><dt>{finding.right.key}</dt><dd>{finding.right.value}</dd></div>
    </dl>
  )
}

type ConsistencyPaths = Partial<Record<ConsistencyAnchor['material'], string>>
const noDiagnostics: FileDiagnostic[] = []

// Findings grouped by the file their anchor names; the note shows the other side of the comparison.
function diagnosticsByPath(report: RepositoryConsistencyReport | null, paths: ConsistencyPaths) {
  const byPath = new Map<string, FileDiagnostic[]>()
  for (const finding of report?.findings ?? []) {
    for (const anchor of finding.anchors) {
      const path = paths[anchor.material]
      if (path === undefined) continue
      const other = anchor.side === 'left' ? finding.right : finding.left
      byPath.set(path, [...(byPath.get(path) ?? []), {
        id: finding.id, severity: finding.severity, title: finding.title, key: anchor.key, note: `≠ ${other.key} ${other.value}`,
      }])
    }
  }
  return byPath
}

function FileProblemCount({ diagnostics }: { diagnostics: FileDiagnostic[] | undefined }) {
  if (diagnostics === undefined) return null
  const count = formatNumber(diagnostics.length)
  return (
    <span className="file-problems" data-severity={diagnostics.some(item => item.severity === 'warning') ? 'warning' : 'info'}>
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t('appFileProblemCount', { count })}</span>
    </span>
  )
}

function SeverityMark({ severity }: { severity: 'warning' | 'info' }) {
  return (
    <span className="severity-mark" data-severity={severity}>
      <span aria-hidden="true">{severity === 'warning' ? '▲' : '●'}</span>
      <span className="sr-only">{t(severity === 'warning' ? 'appSeverityWarning' : 'appSeverityInfo')}</span>
    </span>
  )
}

function ConsistencyReportBody({ report, selectedId, onSelect }: {
  report: RepositoryConsistencyReport | null
  selectedId: string | null
  onSelect(id: string): void
}) {
  if (report === null) return <p>{t('appCheckingRepositoryMaterials')}</p>
  return (
    <>
      {report.findings.map(finding => (
        <button
          className="finding-row"
          type="button"
          key={finding.id}
          data-finding-id={finding.id}
          data-severity={finding.severity}
          aria-pressed={selectedId === finding.id}
          onClick={event => {
            // Safari does not focus buttons on click; keep focus in the panel so Escape still closes it.
            event.currentTarget.focus()
            onSelect(finding.id)
          }}
        >
          <SeverityMark severity={finding.severity} />
          <span className="finding-title">{finding.title}</span>
          <span className="finding-compare">{`${finding.left.key} = ${finding.left.value} · ${finding.right.key} = ${finding.right.value}`}</span>
        </button>
      ))}
      <dl aria-label={t('appRepositoryIdentityAriaLabel')} className="consistency-identity">
        {report.identityFields.map(item => (
          <div key={item.key} data-identity-key={item.key}>
            <dt>{item.key}</dt>
            <dd>{`${item.type} · ${item.value}`}</dd>
          </div>
        ))}
      </dl>
      <div className="table-scroll">
        <table aria-label={t('appConsistencyCoverageAriaLabel')}>
          <thead><tr><th>{t('appMaterialColumn')}</th><th>{t('appStatusColumn')}</th></tr></thead>
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
      <MetricGrid items={[
        [t('appGgufVersionLabel'), `v${summary.version}`],
        [t('appTensorCountLabel'), formatNumber(summary.tensorCount)],
        [t('appGgufMetadataCountLabel'), formatNumber(summary.metadataCount)],
        [t('appEndiannessLabel'), summary.endianness === 'little' ? t('appLittleEndianValue') : t('appBigEndianValue')],
      ]} />
      <p className="scope-note">{t('appGgufScopeNote')}</p>
    </div>
  )
}

function ImatrixInspection({ inspection, perspective }: {
  inspection: Extract<Inspection, { kind: 'imatrix' }>
  perspective: Perspective
}) {
  const [filter, setFilter] = useState('')
  const [selectedName, setSelectedName] = useState(inspection.summary.entries[0]?.name ?? '')
  const term = filter.trim().toLocaleLowerCase()
  const entries = inspection.summary.entries.filter(entry => term === '' || entry.name.toLocaleLowerCase().includes(term))
  const selected = inspection.summary.entries.find(entry => entry.name === selectedName) ?? null
  return (
    <div className="inspection-canvas">
      {perspective === 'overview' ? <MetricGrid items={[
        [t('appEntryCountLabel'), formatNumber(inspection.summary.entries.length)],
        [t('appChunkCountLabel'), inspection.summary.chunkCount === null ? t('appNoneValue') : formatNumber(inspection.summary.chunkCount)],
        [t('appDatasetLabel'), inspection.summary.dataset ?? t('appNoneValue')],
        [t('appFileSizeLabel'), formatBytes(inspection.summary.byteCount)],
      ]} /> : <>
      <div className="inspection-toolbar">
        <label>
          <span>{t('appFilterEntryLabel')}</span>
          <input value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('appTensorNameContainsPlaceholder')} />
        </label>
        <span>{t('readerShowingCount', {
          visible: formatNumber(entries.length),
          total: formatNumber(inspection.summary.entries.length),
        })}</span>
      </div>
      <div className="table-scroll">
        <table aria-label={t('appImatrixEntriesTableAriaLabel')}>
          <thead><tr>
            <th>{t('appTensorColumn')}</th><th>{t('appCallsColumn')}</th><th>{t('appValuesColumn')}</th>
            <th>{t('appMinColumn')}</th><th>{t('appMaxColumn')}</th><th>{t('appMeanColumn')}</th>
          </tr></thead>
          <tbody>{entries.map(entry => (
            <tr key={entry.name}>
              <td><button className="table-link" type="button" onClick={() => setSelectedName(entry.name)}>{entry.name}</button></td>
              <td>{formatNumber(entry.callCount)}</td><td>{formatNumber(entry.valueCount)}</td>
              <td>{formatFloat(entry.minimum)}</td><td>{formatFloat(entry.maximum)}</td><td>{formatFloat(entry.mean)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {selected !== null ? (
        <section className="inspection-section">
          <h2>{t('appSelectedItemTitle', { name: selected.name })}</h2>
          <MetricGrid items={[
            [t('appCallCountLabel'), formatNumber(selected.callCount)],
            [t('appValueCountLabel'), formatNumber(selected.valueCount)],
            [t('appMinMaxLabel'), `${formatFloat(selected.minimum)} / ${formatFloat(selected.maximum)}`],
            [t('appMeanLabel'), formatFloat(selected.mean)],
          ]} />
        </section>
      ) : null}
      </>}
    </div>
  )
}

function TokenizerInspection({ snapshot, file, perspective }: {
  snapshot: RepositorySnapshot
  file: RepositoryFile
  perspective: Perspective
}) {
  // Native: 概览 / 全部字段 / 原文 come from the header; Raw / IDs / Chat is a mode inside 试验台.
  const [mode, setMode] = useState<'raw' | 'decode' | 'chat'>('raw')
  const view = perspective === 'overview' ? 'structure' : perspective === 'playground' ? mode : 'json'
  const shownView = useRef(view)
  useEffect(() => {
    if (shownView.current === view) return
    shownView.current = view
    resetResult()
  })
  const [rawInput, setRawInput] = useState(() => t('appTokenizerRawSample'))
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
  const [inputCopyLabel, setInputCopyLabel] = useState(() => t('appCopyInputAction'))
  const [comparisonSourceMode, setComparisonSourceMode] = useState<SourceMode>('huggingface')
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
    ? t('appComparisonCurrentRepositorySource', { path: selectedComparisonTarget.file.path })
    : comparisonExternalSnapshot.source === 'huggingface'
      ? `${comparisonExternalSnapshot.modelId} · SHA ${comparisonExternalSnapshot.revision.slice(0, 7)} · ${selectedComparisonTarget.file.path}`
      : comparisonExternalSnapshot.source === 'https'
        ? `HTTPS · ${comparisonExternalSnapshot.name} · live · ${selectedComparisonTarget.file.path}`
      : t('appComparisonLocalDirectorySource', {
        revision: comparisonExternalSnapshot.revision,
        name: comparisonExternalSnapshot.name,
        path: selectedComparisonTarget.file.path,
      })
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

  const comparisonPopover = useRef<HTMLDetailsElement>(null)
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
      const next = comparisonSourceMode === 'huggingface'
        ? await loadRepository(input, manifestController.signal)
        : await loadHttpsSource(input, comparisonSourceMode, manifestController.signal)
      if (manifestController.signal.aborted || comparisonManifestController.current !== manifestController) return
      const targets = selectTokenizerComparisonTargets(next)
      if (targets.length === 0) throw new Error(t('appComparisonRepositoryNoTokenizer'))
      setComparisonExternalSnapshot(next)
      setComparisonTargetPath(targets.find(target =>
        target.file.path.toLocaleLowerCase() === 'tokenizer.json')?.file.path
        ?? targets[0]?.file.path ?? null)
      setComparisonOpen(true)
      comparisonPopover.current?.removeAttribute('open')
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
      if (targets.length === 0) throw new Error(t('appComparisonLocalDirectoryNoTokenizer'))
      closeExternalSource()
      comparisonPopover.current?.removeAttribute('open')
      setComparisonExternalSnapshot(next)
      setComparisonSourceError(null)
      setComparisonTargetPath(targets.find(target =>
        target.file.path.toLocaleLowerCase() === 'tokenizer.json')?.file.path ?? targets[0].file.path)
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
      setRightError(t('appComparisonSourceUnavailable'))
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
      setRightError(t('appComparisonSourceUnavailable'))
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
      setRightError(t('appComparisonSourceUnavailable'))
      setRightPhase('error')
      return
    }
    if (view === 'chat' && activeRightTemplate === null) {
      rightRequestGeneration.current += 1
      comparisonRequestController.current?.abort()
      comparisonRequestController.current = null
      setRightResult(null)
      setRightChatPreview('')
      setRightError(t('appComparisonMissingChatTemplate'))
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

  function changeMode(next: typeof mode) {
    resetResult()
    shownView.current = next
    setMode(next)
  }

  function changeRawInput(value: string) {
    resetResult()
    setRawInput(value)
    setInputCopyLabel(t('appCopyInputAction'))
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
      if (activeTemplate === null) throw new Error(templateLoading ? t('appChatTemplateLoading') : t('appChatTemplateUnavailable'))
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
        <h2>{t('comparisonTitle')}</h2>
        {rightCatalog !== null ? (
          <select
            aria-label={t('comparisonChatTemplateAria')}
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
        {rightStructure === null && rightStructureError === null ? t('comparisonLoadingTokenizer') : null}
        {rightTemplateLoading ? t('comparisonLoadingTemplate') : null}
        {comparisonSummary !== null ? (
          <section className="inspection-section" aria-label={t('comparisonSummaryAria')}>
            <h2>{t('comparisonSummaryTitle')}</h2>
            <dl>
              <div><dt>{t('comparisonLeftRightCountLabel')}</dt><dd>{formatNumber(comparisonSummary.leftCount)} / {formatNumber(comparisonSummary.rightCount)}</dd></div>
              <div><dt>{t('comparisonDeltaLabel')}</dt><dd>{formatNumber(comparisonSummary.countDelta, { signDisplay: 'always' })}</dd></div>
              <div><dt>{t('comparisonIdSequenceLabel')}</dt><dd>{comparisonSummary.idsMatch ? t('comparisonIdsSame') : t('comparisonIdsDifferent')}</dd></div>
              <div><dt>{t('comparisonFirstDifferenceLabel')}</dt><dd>{comparisonSummary.firstDifference === null ? t('comparisonEmDashValue') : `#${formatNumber(comparisonSummary.firstDifference.index)} · ${comparisonSummary.firstDifference.leftId ?? t('comparisonEmDashValue')} / ${comparisonSummary.firstDifference.rightId ?? t('comparisonEmDashValue')}`}</dd></div>
              {comparisonSummary.leftTemplateOverhead !== null && comparisonSummary.rightTemplateOverhead !== null ? (
                <div><dt>{t('comparisonTemplateOverheadLabel')}</dt><dd>{formatTemplateOverhead(comparisonSummary.leftTemplateOverhead)} / {formatTemplateOverhead(comparisonSummary.rightTemplateOverhead)}</dd></div>
              ) : null}
            </dl>
          </section>
        ) : null}
        <section className="inspection-section" aria-label={t('comparisonVocabularyDiffStatsAria')}>
          <h2>{t('comparisonVocabularyDiffTitle')}</h2>
          <div role="group" aria-label={t('comparisonVocabularyDiffScopeAria')}>
            {comparisonDiffScopes.map(scope => (
              <button
                key={scope}
                type="button"
                aria-pressed={diffScope === scope}
                disabled={diffCounts === null}
                onClick={() => setDiffScope(scope)}
              >{t('comparisonVocabularyDiffScopeButton', { scope, count: diffCounts === null ? t('comparisonEmDashValue') : formatNumber(diffCounts[`${scope}Count` as const]) })}</button>
            ))}
          </div>
          <label className="comparison-search">
            <span>{t('readerSearchFieldsAndContent')}</span>
            <input
              aria-label={t('comparisonVocabularySearchAria')}
              value={diffQuery}
              onChange={event => setDiffQuery(event.target.value)}
              placeholder={t('comparisonVocabularySearchPlaceholder')}
            />
          </label>
          <span aria-live="polite">
            {diffStatus === 'waiting' || diffStatus === 'preparing' ? t('comparisonPreparingDiffIndex')
              : diffStatus === 'searching' ? t('comparisonSearchingDiff')
              : diffStatus === 'error' ? t('comparisonDiffUnavailable')
              : t('readerShowingCount', { visible: formatNumber(diffPage.length), total: formatNumber(diffTotal) })}
          </span>
          {diffError !== null ? <InlineError>{diffError}</InlineError> : null}
          {diffStatus === 'ready' ? (
            <div className="table-scroll comparison-diff-table">
              <table aria-label={t('comparisonVocabularyDiffTableAria')}>
                <thead><tr><th>{t('comparisonTokenPieceColumn')}</th></tr></thead>
                <tbody>{diffPage.map(piece => <tr key={piece}><td>{piece}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
      {rightStructureError !== null ? <InlineError>{rightStructureError}</InlineError> : null}
      <TokenizerResultView
        heading={t('comparisonTokenizerResultHeading')}
        phase={rightPhase}
        error={rightError}
        result={rightResult}
        authoritativeInput={rightChatPreview}
        showWhitespace={showWhitespace}
        setShowWhitespace={setShowWhitespace}
        tableLabel={t('comparisonTokenizerTokensTableLabel')}
      />
    </aside>
  ) : null

  return (
    <div className={`tokenizer-workspace ${comparisonOpen ? 'comparison-open' : ''}`}>
      {perspective === 'playground' ? <div className="tokenizer-header">
      <div className="perspective" role="group" aria-label={t('tokenizerViewsAriaLabel')}>
        <button type="button" aria-pressed={mode === 'raw'} onClick={() => changeMode('raw')}>{t('tokenizerRawTab')}</button>
        <button type="button" aria-pressed={mode === 'chat'} onClick={() => changeMode('chat')}>{t('tokenizerChatTab')}</button>
        <button type="button" aria-pressed={mode === 'decode'} onClick={() => changeMode('decode')}>{t('tokenizerDecodeTab')}</button>
      </div>
      <div className="comparison-toolbar">
        {comparisonOpen ? null : (
          <button className="primary-button" type="button" onClick={openComparison} disabled={comparisonTargets.length === 0}>
            {t('comparisonOpenAction')}
          </button>
        )}
        <label className="comparison-target">
          <span>{t('comparisonTokenizerLabel')}</span>
          <select
            aria-label={t('comparisonTokenizerLabel')}
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
        <details className="comparison-repository" ref={comparisonPopover}>
          <summary>{t('comparisonOtherPublicRepositoryAction')}</summary>
          <div className="comparison-repository-popover">
          <form onSubmit={loadComparisonRepository}>
            <SourceSelect value={comparisonSourceMode} onChange={mode => {
              closeExternalSource()
              setComparisonSourceMode(mode)
            }} />
            <label>
              <span>{t(comparisonSourceMode === 'huggingface' ? 'comparisonRepositoryLabel' : 'appHttpsUrlLabel')}</span>
              <input
                value={comparisonRepositoryInput}
                placeholder={comparisonSourceMode === 'huggingface' ? t('appRepositoryPlaceholder') : 'https://…'}
                autoComplete="off"
                onChange={event => setComparisonRepositoryInput(event.target.value)}
              />
            </label>
            <div className="comparison-source-actions">
              <button className="primary-button" type="submit">{t('comparisonLoadAction')}</button>
              {comparisonManifestLoading ? (
                <>
                  <span aria-live="polite">{t('comparisonRepositoryLoadingStatus')}</span>
                  <button type="button" onClick={closeComparison}>{t('comparisonCancelLoadAction')}</button>
                </>
              ) : null}
            </div>
            {comparisonSourceError !== null ? <InlineError>{comparisonSourceError}</InlineError> : null}
          </form>
          <label className="comparison-directory-label">
            <span>{t('comparisonSecondLocalDirectoryLabel')}</span>
            <input type="file" multiple onChange={loadComparisonLocalDirectory} {...{ webkitdirectory: '' }} />
          </label>
          </div>
        </details>
        {comparisonOpen ? (
          <button type="button" aria-label={t('comparisonCloseAriaLabel')} onClick={closeComparison}>{t('comparisonCloseAction')}</button>
        ) : null}
        {comparisonTargets.length === 0 ? <span>{t('comparisonNoTargetsStatus')}</span> : null}
      </div>
      </div> : null}
      {view === 'structure' ? (
        <TokenizerStructureInspection
          structure={structure}
          error={structureError}
          configPresent={config !== undefined}
          sentencePieceModel={isSentencePieceFile(file)}
          snapshot={snapshot}
          file={file}
          config={config}
        />
      ) : null}
      {view === 'json' ? <TokenizerJSONInspection snapshot={snapshot} file={file} perspective={perspective} /> : null}
      {view === 'decode' ? (
        <div className={`tokenizer-layout ${comparisonOpen ? 'comparison-open' : ''}`}>
          <section className="input-panel">
            <header><h2>{t('tokenIdsLabel')}</h2><span>{t('inputMaxSizeStatus')}</span></header>
            <textarea
              value={tokenIdInput}
              onChange={event => changeTokenIdInput(event.target.value)}
              aria-label={t('tokenIdsLabel')}
              placeholder={t('tokenIdsInputPlaceholder')}
            />
            <footer>
              <span>{t('tokenIdsByteStatus', { count: formatNumber(new TextEncoder().encode(tokenIdInput).byteLength) })}</span>
              <button className="primary-button" type="button" onClick={() => void runDecode()} disabled={phase === 'loading'}>{t('tokenIdsDecodeAction')}</button>
            </footer>
          </section>
          <TokenizerResultView
            heading={comparisonOpen ? t('mainTokenizerResultHeading') : undefined}
            phase={phase}
            error={error}
            result={result}
            authoritativeInput={tokenIdInput}
            showWhitespace={showWhitespace}
            setShowWhitespace={setShowWhitespace}
            tableLabel={comparisonOpen ? t('mainTokenizerTokensTableLabel') : undefined}
            docked={!comparisonOpen}
          />
          {comparisonPanel}
        </div>
      ) : null}
      {view === 'raw' ? (
        <div className={`tokenizer-layout ${comparisonOpen ? 'comparison-open' : ''}`}>
          <section className="input-panel">
            <header><h2>{t('rawInputLabel')}</h2><button type="button" onClick={async () => {
              try { await navigator.clipboard.writeText(rawInput); setInputCopyLabel(t('templateCopiedState')) } catch { setInputCopyLabel(t('templateCopyFailedState')) }
            }}>{inputCopyLabel}</button><button type="button" onClick={() => changeRawInput('')}>{t('rawInputClearAction')}</button><span>{t('inputMaxSizeStatus')}</span></header>
            <textarea value={rawInput} onChange={event => changeRawInput(event.target.value)} aria-label={t('rawInputLabel')} />
            <footer>
              <span>{t('rawInputByteStatus', { count: formatNumber(new TextEncoder().encode(rawInput).byteLength) })}</span>
              <button className="primary-button" type="button" onClick={() => void runRaw()} disabled={phase === 'loading' || rawInput.length === 0}>{t('rawInputTokenizeAction')}</button>
            </footer>
          </section>
          <TokenizerResultView
            heading={comparisonOpen ? t('mainTokenizerResultHeading') : undefined}
            phase={phase}
            error={error}
            result={result}
            authoritativeInput={rawInput}
            showWhitespace={showWhitespace}
            setShowWhitespace={setShowWhitespace}
            tableLabel={comparisonOpen ? t('mainTokenizerTokensTableLabel') : undefined}
            docked={!comparisonOpen}
          />
          {comparisonPanel}
        </div>
      ) : null}
      {view === 'chat' ? (
        <div className={`tokenizer-layout ${comparisonOpen ? 'comparison-open' : ''}`}>
          <section className="input-panel chat-panel">
            <header>
              <h2>{t('chatMessagesLabel')}</h2>
              {chatCatalog !== null && chatCatalog.entries.length > 1 ? (
                <select
                  aria-label={t('chatTemplateLabel')}
                  value={chatCatalog.activeId ?? ''}
                  onChange={event => changeChatTemplate(event.target.value)}
                >
                  {chatCatalog.entries.map(entry => (
                    <option key={entry.id} value={entry.id} disabled={!entry.usable}>{templateLabel(entry)}</option>
                  ))}
                </select>
              ) : null}
              {templateLoading
                ? <span>{t('chatTemplateLoadingStatus')}</span>
                : activeTemplate === null ? <span>{t('chatTemplateUnavailableStatus')}</span> : null}
              {!templateLoading && chatCatalog !== null && chatCatalog.entries.length === 1 ? (
                <span className="chat-template-badge">{templateLabel(chatCatalog.entries[0])}</span>
              ) : null}
            </header>
            <textarea value={chatMessages} onChange={event => {
              resetResult()
              setChatMessages(event.target.value)
            }} aria-label={t('chatMessagesLabel')} />
            <details className="chat-context-details">
              <summary>{t('chatToolsAndVariablesLabel')}</summary>
              <label>{t('templateToolsLabel')}<textarea aria-label={t('chatToolsInputAriaLabel')} value={chatTools} onChange={event => {
                resetResult()
                setChatTools(event.target.value)
              }} /></label>
              <label>{t('templateVariablesLabel')}<textarea aria-label={t('chatVariablesInputAriaLabel')} value={chatVariables} onChange={event => {
                resetResult()
                setChatVariables(event.target.value)
              }} /></label>
            </details>
            <pre className="chat-preview" aria-label={t('chatAuthoritativeInputLabel')}>{chatPreview || t('chatPreviewEmptyStatus')}</pre>
            <footer>
              <label><input type="checkbox" checked={includeTools} onChange={event => {
                resetResult()
                setIncludeTools(event.target.checked)
              }} />include_tools</label>
              <label><input type="checkbox" checked={addGenerationPrompt} onChange={event => {
                resetResult()
                setAddGenerationPrompt(event.target.checked)
              }} />add_generation_prompt</label>
              <button className="primary-button" type="button" onClick={() => void runChat()} disabled={phase === 'loading' || activeTemplate === null}>{t('chatRenderAndTokenizeAction')}</button>
            </footer>
          </section>
          <TokenizerResultView
            heading={comparisonOpen ? t('mainTokenizerResultHeading') : undefined}
            phase={phase}
            error={error}
            result={result}
            authoritativeInput={chatPreview}
            showWhitespace={showWhitespace}
            setShowWhitespace={setShowWhitespace}
            tableLabel={comparisonOpen ? t('mainTokenizerTokensTableLabel') : undefined}
            docked={!comparisonOpen}
          />
          {comparisonPanel}
        </div>
      ) : null}
    </div>
  )
}

// Invalid JSON is still useful source to inspect; runtime/config validation stays strict.
function parseDisplayJSON(content: string): unknown {
  try { return JSON.parse(content) } catch { return undefined }
}

function TokenizerJSONInspection({ snapshot, file, perspective }: {
  snapshot: RepositorySnapshot
  file: RepositoryFile
  perspective: Perspective
}) {
  const [document, setDocument] = useState<{ content: string; parsed: unknown; bytesRead: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setDocument(null)
    setError(null)
    void readWholeFile(snapshot, file, controller.signal).then(data => {
      const content = decodeStrictText(data)
      const parsed = parseDisplayJSON(content)
      if (!controller.signal.aborted) setDocument({ content, parsed, bytesRead: data.byteLength })
    }).catch(failure => {
      if (!controller.signal.aborted) setError(errorMessage(failure))
    })
    return () => controller.abort()
  }, [snapshot, file])
  if (error !== null) return <InlineError>{error}</InlineError>
  if (document === null) return <LoadingState file={file} snapshot={snapshot} />
  return <TextInspection snapshot={snapshot} path={file.path} category={file.category} content={document.content}
    parsed={document.parsed} json perspective={perspective} />
}

function TokenizerStructureInspection({
  structure,
  error,
  configPresent,
  sentencePieceModel,
  snapshot,
  file,
  config,
}: {
  structure: TokenizerStructure | null
  error: string | null
  configPresent: boolean
  sentencePieceModel: boolean
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
  if (structure === null) return <div className="loading-state" role="status"><span className="spinner" /><h2>{t('tokenizerStructureLoadingStatus')}</h2></div>
  const vocabulary = structure.vocabulary
  const longest = vocabulary?.longestTokens.slice(0, showsTop50 ? 50 : 20) ?? []
  const specialTokens = structure.addedTokens.filter(token => token.special)
  return (
    <div className="inspection-canvas tokenizer-structure">
      <ValidationStrip items={[
        [t('tokenizerStructureRunLocationLabel'), t('tokenizerStructureWebWorkerValue')],
        [t('tokenizerStructureConfigLabel'), configPresent
          ? t('tokenizerStructureConfigSameDirectoryValue')
          : sentencePieceModel ? t('tokenizerStructureConfigMissingValue') : t('tokenizerStructureConfigMissingRawUnsupportedValue')],
        [t('tokenizerStructureAddedTokenLabel'), formatNumber(structure.addedTokenCount ?? 0)],
      ]} />
      {specialTokens.length > 0 ? (
        <section className="inspection-section">
          <h2>{t('tokenizerStructureSpecialAddedTokensLabel')}</h2>
          <DataTable
            label={t('tokenizerStructureSpecialAddedTokensLabel')}
            columns={[t('tokenizerStructureIdColumn'), t('tokenizerStructureTokenColumn')]}
            rows={specialTokens.map(token => [token.id === null ? t('comparisonEmDashValue') : formatNumber(token.id), token.content])}
          />
        </section>
      ) : null}
      <MetricGrid items={[
        [t('tokenizerStructureFormatVersionLabel'), structure.version ?? t('tokenizerStructureUnknownValue')],
        [t('tokenizerStructureModelTypeLabel'), structure.modelType ?? t('tokenizerStructureUnknownValue')],
        [t('tokenizerStructureBaseVocabularyLabel'), structure.vocabCount === null ? t('tokenizerStructureUnknownValue') : formatNumber(structure.vocabCount)],
        [t('tokenizerStructureMergeCountLabel'), structure.mergeCount === null ? t('tokenizerStructureNotApplicableValue') : formatNumber(structure.mergeCount)],
      ]} />
      <section className="inspection-section">
        <h2>{t('jsonRootFieldCount')}</h2>
        <DataTable label={t('tokenizerStructureRootFieldsTableLabel')} columns={[t('readerFieldColumn'), t('tokenizerStructureDetailColumn')]} rows={structure.fields.map(field => [field.name, field.detail])} />
      </section>
      {vocabulary === null && !(structure.vocabCount === 0 && structure.vocabularyError === null)
        ? <InlineError>{structure.vocabularyError ?? t('tokenizerStructureVocabularyUnavailable')}</InlineError>
        : (
        <>
          {vocabulary === null ? <p className="scope-note">{t('tokenizerStructureVocabularyEmpty')}</p> : (
            <>
          <MetricGrid items={[
            [t('tokenizerStructureAverageScalarLengthLabel'), formatNumber(vocabulary.averageScalarLength, { maximumFractionDigits: 2 })],
            [t('tokenizerStructureP50P90Label'), `${vocabulary.p50ScalarLength} / ${vocabulary.p90ScalarLength}`],
            [t('tokenizerStructureP95P99Label'), `${vocabulary.p95ScalarLength} / ${vocabulary.p99ScalarLength}`],
            [t('tokenizerStructureMaximumScalarLengthLabel'), formatNumber(vocabulary.maximumScalarLength)],
          ]} />
          <section className="inspection-section">
            <h2>{t('tokenizerStructureLengthDistributionLabel')}</h2>
            <DataTable label={t('tokenizerStructureLengthDistributionTableLabel')} columns={[t('tokenizerStructureLengthColumn'), t('tokenizerStructureTokenCountColumn')]} rows={vocabulary.buckets.map(bucket => [bucket.label, formatNumber(bucket.count)])} />
          </section>
          <section className="inspection-section">
            <h2>{t('tokenizerStructureLongestTokensLabel')}</h2>
            <DataTable label={t('tokenizerStructureLongestTokensLabel')} columns={[t('tokenizerStructureIdColumn'), t('tokenizerStructureTokenColumn'), t('tokenizerStructureUnicodeScalarColumn')]} rows={longest.map(entry => [
              formatNumber(entry.tokenId), visiblePiece(entry.token), formatNumber(entry.scalarLength),
            ])} />
            {vocabulary.longestTokens.length > 20 ? (
              <button className="load-more" type="button" onClick={() => setShowsTop50(!showsTop50)}>
                {showsTop50 ? t('tokenizerStructureCollapseTop20Action') : t('tokenizerStructureExpandTopAction', { count: formatNumber(vocabulary.longestTokens.length) })}
              </button>
            ) : null}
          </section>
            </>
          )}
          <div className="inspection-toolbar">
            <label>
              <span>{t('tokenizerStructureSearchLabel')}</span>
              <input
                value={searchQuery}
                onChange={event => void searchVocabulary(event.target.value)}
                aria-label={t('tokenizerStructureSearchLabel')}
                placeholder={t('tokenizerStructureSearchPlaceholder')}
              />
            </label>
            <span aria-live="polite">
              {searchStatus === 'empty' ? t('tokenizerStructureSearchEmptyStatus')
                : searchStatus === 'searching' ? t('tokenizerStructureSearchPreparingStatus')
                : searchStatus === 'ready' ? t('tokenizerStructureSearchMatchCountStatus', { count: formatNumber(searchResults.length) })
                : t('tokenizerStructureSearchFailedStatus')}
            </span>
          </div>
          {searchStatus === 'error' && searchError !== null ? <InlineError>{searchError}</InlineError> : null}
          {searchStatus === 'ready' ? (
            <DataTable
              label={t('tokenizerStructureSearchResultsTableLabel')}
              columns={[t('tokenizerStructureIdColumn'), t('tokenizerStructureTokenColumn'), t('tokenizerStructureUnicodeScalarColumn')]}
              rows={searchResults.map(entry => [
                formatNumber(entry.tokenId), visiblePiece(entry.token), formatNumber(Array.from(entry.token).length),
              ])}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function formatTemplateOverhead(value: number): string {
  return value < 0 ? t('tokenizerResultUnableToSplitValue') : formatNumber(value)
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
  docked = false,
}: {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  result: Tokenization | null
  authoritativeInput: string
  showWhitespace: boolean
  setShowWhitespace(value: boolean): void
  heading?: string
  tableLabel?: string
  docked?: boolean
}) {
  // Docked: the table, IDs and text go to the bottom panel and the selection to the inspector.
  // Comparison views pass docked=false, since one panel cannot hold two results.
  const slots = useContext(WorkspaceSlotsContext)
  const dock = docked ? slots : null
  const registerTabs = dock?.registerTabs
  const tokenCount = result?.ids.length
  useEffect(() => {
    if (registerTabs === undefined) return
    registerTabs([
      { id: 'tokens', label: t('appPanelTokensTab') },
      { id: 'ids', label: t('appPanelTokenIdsTab'), count: tokenCount },
    ])
  }, [registerTabs, tokenCount])
  useEffect(() => {
    if (registerTabs === undefined) return
    return () => registerTabs([])
  }, [registerTabs])
  const openToolPanel = useRef(dock?.openToolPanel)
  openToolPanel.current = dock?.openToolPanel
  // Open the panel for the first docked result only: Raw re-tokenizes on every keystroke,
  // and a panel the user closed must stay closed while they type.
  const docking = dock !== null
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!docking) { autoOpened.current = false; return }
    if (result !== null && !autoOpened.current) {
      autoOpened.current = true
      openToolPanel.current?.()
    }
  }, [result, docking])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [limit, setLimit] = useState(1000)
  const [copyLabel, setCopyLabel] = useState(() => t('tokenizerResultCopyIdAction'))
  useEffect(() => {
    setSelectedIndex(null)
    setLimit(1000)
    setCopyLabel(t('tokenizerResultCopyIdAction'))
  }, [result])
  const decoded = useMemo(() => {
    const values = new Map<number, string>()
    for (const segment of result?.segments ?? []) {
      const display = segment.ids.length > 100
        ? t('tokenizerResultMergedSegmentDecodedSummary', { count: formatNumber(segment.ids.length) })
        : segment.text
      for (let index = segment.start; index < segment.end; index++) values.set(index, display)
    }
    return values
  }, [result])
  // Lines end after a segment whose text ends in a newline; merged (>100 ID) segments never split a line.
  const lines = useMemo(() => {
    const out: Array<{ items: Array<{ segment: Tokenization['segments'][number]; index: number }>; count: number }> = []
    let current: (typeof out)[number] = { items: [], count: 0 }
    for (const [index, segment] of (result?.segments ?? []).entries()) {
      current.items.push({ segment, index })
      current.count += segment.end - segment.start
      if (segment.ids.length <= 100 && segment.text.endsWith('\n')) {
        out.push(current)
        current = { items: [], count: 0 }
      }
    }
    if (current.items.length > 0) out.push(current)
    return out
  }, [result])
  const selectedId = selectedIndex === null ? undefined : result?.ids[selectedIndex]
  const selectedRole = selectedIndex !== null ? result?.roles?.[selectedIndex] ?? null : null
  const inputBytes = new TextEncoder().encode(authoritativeInput).byteLength
  const selectedDetail = result === null ? null : selectedId !== undefined && selectedIndex !== null ? (
            <dl className="selected-token">
              <div><dt>{t('tokenizerResultSelectedTokenLabel')}</dt><dd>#{selectedIndex + 1}</dd></div>
              <div><dt>{t('tokenizerStructureIdColumn')}</dt><dd>{selectedId}</dd></div>
              <div><dt>{t('tokenizerResultSelectedRoleLabel')}</dt><dd>{chatRoleLabel(selectedRole)}</dd></div>
              <div><dt>{t('tokenizerResultSelectedPieceLabel')}</dt><dd>{visiblePiece(result.pieces[selectedIndex] ?? '', showWhitespace)}</dd></div>
              <button type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(String(selectedId)); setCopyLabel(t('templateCopiedState')) } catch { setCopyLabel(t('templateCopyFailedState')) }
              }}>{copyLabel}</button>
            </dl>
          ) : null
  const idsBlock = result === null ? null : (
    <>
          <div className="token-id-chips" aria-label={t('tokenizerResultTokenIdChipsAria')}>
            {result.ids.slice(0, limit).map((id, index) => (
              <button
                type="button"
                key={`${index}-${id}`}
                aria-label={t('tokenizerResultTokenIdChipAria', { id, index })}
                aria-pressed={selectedIndex === index}
                onClick={() => setSelectedIndex(current => current === index ? null : index)}
              >{id}</button>
            ))}
          </div>
    </>
  )
  const tableBlock = result === null ? null : (
    <>
          <div className="table-scroll">
            <table aria-label={tableLabel ?? t('tokenizerResultTokensTableLabel')}>
              <thead><tr><th>{t('tokenizerResultPositionColumn')}</th><th>{t('tokenizerStructureIdColumn')}</th><th>{t('tokenizerResultSpecialColumn')}</th><th>{t('tokenizerResultSelectedRoleLabel')}</th><th>{t('comparisonTokenPieceColumn')}</th><th>{t('tokenizerResultDecodedColumn')}</th><th>{t('tokenizerResultMappingColumn')}</th></tr></thead>
              <tbody>{result.ids.slice(0, limit).map((id, index) => (
                <tr className={selectedIndex === index ? 'selected-token-row' : ''} key={`${index}-${id}`}>
                  <td><button className="table-link" type="button" aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(current => current === index ? null : index)}>{index + 1}</button></td>
                  <td><button className="table-link" type="button" aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(current => current === index ? null : index)}>{id}</button></td>
                  <td>{result.flags[index]?.specialName ?? t('comparisonEmDashValue')}</td>
                  <td>{chatRoleLabel(result.roles?.[index] ?? null)}</td>
                  <td>{visiblePiece(result.pieces[index] ?? '', showWhitespace)}</td>
                  <td>{visiblePiece(decoded.get(index) ?? '', showWhitespace)}</td><td>{result.mapping}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {limit < result.ids.length ? <button className="load-more" type="button" onClick={() => setLimit(Math.min(limit + 1000, result.ids.length))}>{t('tokenizerResultLoadMoreAction', { count: formatNumber(1000) })}</button> : null}
    </>
  )
  const textBlock = result === null ? null : (
    <>
          <p className="decoded-text">{result.direction === 'decode' ? t('tokenizerResultTokenIdsPrefix') + result.input : t('tokenizerResultAuthoritativeInputPrefix') + authoritativeInput}</p>
          <p className="decoded-text">{result.direction === 'decode' ? t('tokenizerResultDecodedTextPrefix') : t('tokenizerResultDecodedPrefix')}{result.decoded}</p>
    </>
  )
  const panelContent = dock?.panelBody == null ? null : createPortal(
    result === null ? <div className="result-empty">{t('tokenizerResultIdleStatus')}</div>
      : dock.activeTab === 'ids' ? idsBlock : tableBlock,
    dock.panelBody,
  )
  return (
    <section className="result-panel" aria-live="polite">
      <header><h2>{heading ?? (result?.direction === 'decode' ? t('tokenizerResultDecodeHeading') : t('tokenizerResultHeading'))}</h2><label><input type="checkbox" checked={showWhitespace} onChange={event => setShowWhitespace(event.target.checked)} />{t('tokenizerResultShowWhitespaceAction')}</label></header>
      {phase === 'idle' ? <div className="result-empty">{t('tokenizerResultIdleStatus')}</div> : null}
      {phase === 'loading' ? <div className="result-empty"><span className="spinner" />{t('tokenizerResultLoadingStatus')}</div> : null}
      {phase === 'error' ? <InlineError>{error}</InlineError> : null}
      {result !== null ? (
        <>
          <dl className="token-metrics">
            <div className="token-metric-primary"><dt>{t('tokenizerStructureTokenCountColumn')}</dt><dd>{formatNumber(result.ids.length)}</dd></div>
            {result.overhead !== null ? (
              <>
                <div data-metric="content"><dt>{t('tokenizerResultContentTokenLabel')}</dt><dd>{formatNumber(result.overhead.contentCount)}</dd></div>
                <div data-metric="template"><dt>{t('tokenizerResultApproximateTemplateOverheadLabel')}</dt><dd>{formatTemplateOverhead(result.overhead.templateCount)}</dd></div>
              </>
            ) : null}
            <div><dt>{t('tokenizerResultBytesPerTokenLabel')}</dt><dd>{formatNumber(result.ids.length === 0 ? 0 : inputBytes / result.ids.length, { maximumFractionDigits: 2 })}</dd></div>
            <div><dt>{t('tokenizerResultMappingLabel')}</dt><dd className="mapping-badge" data-mapping={result.mapping}>{result.mapping}</dd></div>
          </dl>
          {result.overhead !== null && result.overhead.templateCount >= 0 && result.ids.length > 0 ? (
            <div className="token-ratio" aria-hidden="true">
              <span data-metric="content" style={{ flexGrow: result.overhead.contentCount }} />
              <span data-metric="template" style={{ flexGrow: result.overhead.templateCount }} />
            </div>
          ) : null}
          {result.overhead !== null && result.mapping === 'Decoded only' ? (
            <p className="decoded-text">{t('tokenizerResultDecodedOnlyWarning', { mapping: result.mapping })}</p>
          ) : null}
          <h3 className="result-label">{t('tokenizerResultGraphemeHeading')}</h3>
          <div className="token-pieces">
            {lines.map((line, lineIndex) => (
              <div className="token-line" key={line.items[0]?.segment.start ?? lineIndex}>
                <span className="token-line-number" aria-hidden="true">{lineIndex + 1}</span>
                <div className="token-line-pieces">
            {line.items.map(({ segment, index }) => {
              const role = segmentRole(result, segment)
              return (
              <button
                data-tone={index % 5}
                type="button"
                className={selectedIndex !== null && selectedIndex >= segment.start && selectedIndex < segment.end ? 'selected' : ''}
                aria-pressed={selectedIndex !== null && selectedIndex >= segment.start && selectedIndex < segment.end}
                key={`${segment.start}-${index}`}
                title={segment.ids.length > 100
                  ? t('tokenizerResultSegmentTitleCount', {
                    count: formatNumber(segment.ids.length),
                    end: segment.end,
                    start: segment.start + 1,
                  })
                  : t('tokenizerResultSegmentTitleIds', {
                    end: segment.end,
                    ids: segment.ids.join(', '),
                    start: segment.start + 1,
                  })}
                onClick={() => setSelectedIndex(current => current === segment.start ? null : segment.start)}
              >{role !== null ? (
                <span className={`token-role-badge ${chatRoleClass(role)}`}>
                  {chatRoleLabel(role)}
                </span>
              ) : null}{segment.ids.length > 100
                ? t('tokenizerResultMergedSegmentChip', { count: formatNumber(segment.ids.length) })
                : visiblePiece(segment.text, showWhitespace)}</button>
            )})}
                </div>
                <span className="token-line-count" aria-hidden="true">{formatNumber(line.count)}</span>
              </div>
            ))}
          </div>
          {textBlock}
          {dock === null ? <>{selectedDetail}{idsBlock}{tableBlock}</> : null}
          {dock !== null ? (dock.inspector !== null && selectedDetail !== null
            ? createPortal(
              <section className="inspector-section"><h2>{t('appInspectorSelectedToken')}</h2>{selectedDetail}</section>,
              dock.inspector,
            )
            : selectedDetail) : null}
        </>
      ) : null}
      {panelContent}
    </section>
  )
}

function segmentRole(result: Tokenization, segment: { start: number; end: number }): ChatTokenRole | null {
  const roles = result.roles?.slice(segment.start, segment.end) ?? []
  if (roles.length !== segment.end - segment.start || roles.some(role => JSON.stringify(role) !== JSON.stringify(roles[0]))) return null
  return roles[0] ?? null
}

function chatRoleLabel(role: ChatTokenRole | null): string {
  if (role === null) return t('comparisonEmDashValue')
  return role.kind === 'template' ? 'template' : role.role
}

function chatRoleClass(role: ChatTokenRole | null): string {
  if (role === null) return ''
  if (role.kind === 'template') return 'role-template'
  return ['system', 'user', 'assistant', 'tool'].includes(role.role) ? `role-${role.role}` : 'role-custom'
}

// Native DetailView bottom inset: what was read, and what was deliberately not requested.
function SafetyNotice({ inspection }: { inspection: Inspection }) {
  const notice = safetyNotice(inspection)
  if (notice === null) return null
  return <div className="safety-notice"><LockIcon /><span>{notice}</span></div>
}

function safetyNotice(inspection: Inspection): string | null {
  switch (inspection.kind) {
    case 'safetensors': return t('noticeSafeTensors', { size: formatBytes(inspection.bytesRead) })
    case 'gguf': return t('noticeGguf', { size: formatBytes(inspection.bytesRead) })
    case 'imatrix': return t('noticeImatrix', { size: formatBytes(inspection.bytesRead) })
    case 'pdf': return t('noticePdf', { size: formatBytes(inspection.bytesRead) })
    case 'image': return t('noticeImage', { size: formatBytes(inspection.bytesRead) })
    // Native shows the fallback only for a loaded document, not while loading, failed or locked.
    case 'text': return inspection.file.category === 'weightMetadata' ? t('noticeWeightIndex') : null
    default: return null
  }
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

const loadingDescriptions: Record<StructuredFormat, MessageKey> = {
  safetensors: 'appLoadingSafeTensors', gguf: 'appLoadingGGUF', imatrix: 'appLoadingImatrix',
  jinja: 'appLoadingJinja', pdf: 'appLoadingPdf', image: 'appLoadingImage',
}

// Native DetailView loading page: format-specific line, then size · source · how to cancel.
function LoadingState({ file, snapshot }: { file: RepositoryFile; snapshot: RepositorySnapshot | null }) {
  const format = structuredFormat(file)
  const details = [file.size === null ? null : formatBytes(file.size), snapshot === null ? t('appSourceGeneric') : sourceTitle(snapshot)]
    .filter(part => part !== null).join(' · ')
  return (
    <div className="loading-state" role="status">
      <span className="spinner" />
      <p>{format === null ? t('appLoadingFileTitle', { name: file.path.split('/').at(-1) }) : t(loadingDescriptions[format])}</p>
      <small>{details} · {t('appLoadingSwitchHint')}</small>
    </div>
  )
}

type StateIconName = 'document' | 'warning' | 'lock' | 'offline' | 'box' | 'search'

// Line drawings standing in for the native SF Symbols (doc.text, exclamationmark.triangle, lock.shield,
// wifi.exclamationmark, shippingbox, doc.text.magnifyingglass).
function StateIcon({ name }: { name: StateIconName }) {
  return (
    <svg className="state-icon" viewBox="0 0 32 32" aria-hidden="true">
      {name === 'document' ? <><path d="M9 4h10l6 6v18H9z" /><path d="M19 4v6h6M13 16h8M13 20h8M13 24h5" /></> : null}
      {name === 'warning' ? <><path d="M16 4 29 27H3z" /><path d="M16 12v8M16 23.5v.5" /></> : null}
      {name === 'lock' ? <><path d="M16 3 26 7v8c0 7-4.5 11.5-10 14C10.5 26.5 6 22 6 15V7z" /><rect x="11.5" y="14" width="9" height="7" rx="1.5" /><path d="M13.5 14v-2a2.5 2.5 0 0 1 5 0v2" /></> : null}
      {name === 'offline' ? <><path d="M4 12a17 17 0 0 1 20 0M8 16.5a11 11 0 0 1 12 0M12 21a5 5 0 0 1 4-1" /><path d="M26 15v7M26 25.5v.5" /></> : null}
      {name === 'box' ? <><path d="M4 10 16 4l12 6v12l-12 6-12-6z" /><path d="M4 10l12 6 12-6M16 16v12M10 7l12 6" /></> : null}
      {name === 'search' ? <><path d="M7 4h9l5 5v5M7 4v24h8" /><circle cx="21" cy="21" r="4.5" /><path d="m24.5 24.5 3.5 3.5" /></> : null}
    </svg>
  )
}

function EmptyState({
  icon,
  title,
  message,
  action,
  onAction,
  tone = 'neutral',
}: {
  icon: StateIconName
  title: string
  message: string
  action?: string
  onAction?: () => void
  tone?: 'neutral' | 'error'
}) {
  return (
    <div className={`empty-state ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <StateIcon name={icon} />
      <h2>{title}</h2>
      <p>{message}</p>
      {action !== undefined ? <button className="primary-button" type="button" onClick={onAction}>{action}</button> : null}
    </div>
  )
}

function InlineError({ children }: { children: React.ReactNode }) {
  return <p className="inline-error" role="alert">{children}</p>
}

function SearchIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
}

// Native SidebarFileRow: icon, name with an optional note below, problem count, size; the path is the tooltip.
function FileRow({ file, selected, diagnostics, onSelect, onContextMenu }: {
  file: RepositoryFile
  selected: boolean
  diagnostics?: FileDiagnostic[]
  onSelect(): void
  onContextMenu(event: React.MouseEvent, file: RepositoryFile): void
}) {
  const locked = isBlocked(file)
  const note = fileNote(file)
  const size = file.size === null ? null : formatBytes(file.size)
  // The accessible name leads with the full path so nested files stay distinguishable.
  const label = [file.path, note === file.path ? null : note,
    diagnostics === undefined ? null : t('appFileProblemCount', { count: formatNumber(diagnostics.length) }), size]
    .filter(part => part !== null).join(' ')
  return (
    <button className={`file-row${selected ? ' selected' : ''}`} type="button" aria-current={selected}
      aria-disabled={locked || undefined} aria-label={label} title={file.path}
      onClick={locked ? undefined : onSelect} onContextMenu={event => onContextMenu(event, file)}>
      <FileIcon file={file} locked={locked} />
      <span className="file-row-text">
        <span>{file.path.split('/').at(-1)}</span>
        {note !== null ? <small>{note}</small> : null}
      </span>
      <FileProblemCount diagnostics={diagnostics} />
      {size !== null ? <small className="file-size">{size}</small> : null}
    </button>
  )
}

function fileNote(file: RepositoryFile): string | null {
  const name = file.path.split('/').at(-1) ?? file.path
  const format = structuredFormat(file)
  if (name === 'tokenizer_config.json') return t('appNoteEmbeddedChatTemplate')
  if (format === 'safetensors') return t('appNoteSafeTensors')
  if (format === 'gguf') return t('appNoteGGUF')
  if (format === 'imatrix') return 'legacy importance matrix'
  if (isBlocked(file)) return t('appNoteLocked')
  return file.path === name ? null : file.path
}

// Line drawings standing in for the native SF Symbols, tinted with Palette.glyph; locked rows stay grey.
function FileIcon({ file, locked }: { file: RepositoryFile; locked: boolean }) {
  const shape = locked ? 'locked' : file.category === 'weights' ? 'previewable' : file.category
  return (
    <svg className="file-icon" data-category={locked ? undefined : file.category} viewBox="0 0 16 16" aria-hidden="true">
      {shape === 'configuration' ? <><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /><circle className="knob" cx="5.5" cy="4.5" r="1.4" /><circle className="knob" cx="10.5" cy="8" r="1.4" /><circle className="knob" cx="7" cy="11.5" r="1.4" /></> : null}
      {shape === 'tokenizer' ? <text x="8" y="11" textAnchor="middle">abc</text> : null}
      {shape === 'templates' ? <><rect x="1.5" y="1.5" width="13" height="13" rx="3" /><path d="M6.5 4.5c-1.2 0-1.5.5-1.5 1.5v.8c0 .8-.4 1.2-1 1.2.6 0 1 .4 1 1.2v.8c0 1 .3 1.5 1.5 1.5M9.5 4.5c1.2 0 1.5.5 1.5 1.5v.8c0 .8.4 1.2 1 1.2-.6 0-1 .4-1 1.2v.8c0 1-.3 1.5-1.5 1.5" /></> : null}
      {shape === 'weightMetadata' ? <><path d="M8 2 14 5 8 8 2 5z" /><path d="m2 8 6 3 6-3M2 11l6 3 6-3" /></> : null}
      {shape === 'documentation' ? <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 13h3" /></> : null}
      {shape === 'other' ? <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3" /></> : null}
      {shape === 'previewable' ? <><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M6 5.5h6M6 8h6M6 10.5h6" /><circle className="knob" cx="4" cy="5.5" r=".6" /><circle className="knob" cx="4" cy="8" r=".6" /><circle className="knob" cx="4" cy="10.5" r=".6" /></> : null}
      {shape === 'locked' ? <><rect className="knob" x="3" y="7" width="10" height="7.5" rx="1.6" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></> : null}
    </svg>
  )
}

function LockIcon() {
  return <svg className="file-icon" viewBox="0 0 16 16" aria-hidden="true"><rect className="knob" x="3" y="7" width="10" height="7.5" rx="1.6" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></svg>
}

function CopyIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>
}

function LinkIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5" /><path d="M7 4.5 8.3 3.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2" /><path d="M9 11.5 7.7 12.8A2.6 2.6 0 0 1 4 9.1l1.3-1.3" /></svg>
}

function ExternalIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5 7.5 8.5" /><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>
}

function CloseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
}

function PanelIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2 9.5h12" /></svg>
}

function InspectorIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></svg>
}

function CheckCircleIcon() {
  return <svg className="status-ok" viewBox="0 0 16 16" aria-hidden="true"><circle className="filled" cx="8" cy="8" r="6.5" /><path className="cut" d="m5.2 8.2 2 2 3.6-4.2" /></svg>
}

// Native badge symbols: clock, exclamationmark.triangle.fill, questionmark.circle, checkmark.circle.fill.
function BadgeIcon({ state }: { state: 'checking' | 'warnings' | 'insufficient' | 'consistent' }) {
  return <svg className="badge-icon" viewBox="0 0 16 16" aria-hidden="true">
    {state === 'checking' ? <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.3 1.5" /></> : null}
    {state === 'warnings' ? <><path className="filled" d="M8 1.8 15 14H1z" /><path className="cut" d="M8 6v3.6M8 11.3v.4" /></> : null}
    {state === 'insufficient' ? <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.2v.3" /></> : null}
    {state === 'consistent' ? <><circle className="filled" cx="8" cy="8" r="6.5" /><path className="cut" d="m5.2 8.2 2 2 3.6-4.2" /></> : null}
  </svg>
}

function CheckIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
}

function AppMark() {
  return <picture className="app-mark" aria-hidden="true">
    <source srcSet={logoDark} media="(prefers-color-scheme: dark)" />
    <img src={logoLight} alt="" />
  </picture>
}

function isBlocked(file: RepositoryFile): boolean {
  const lower = file.path.toLocaleLowerCase()
  return file.category === 'weights' && !lower.endsWith('.safetensors')
    && !lower.endsWith('.gguf') && !lower.endsWith('.gguf_file')
}

type StructuredFormat = 'safetensors' | 'gguf' | 'imatrix' | 'jinja' | 'pdf' | 'image'

// Native RepositoryFile.structuredInspectionFormat.
function structuredFormat(file: RepositoryFile): StructuredFormat | null {
  const name = file.path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  if (name.endsWith('.safetensors')) return 'safetensors'
  if (isGGUF(file)) return 'gguf'
  if (isImatrixPath(file.path)) return 'imatrix'
  if (name.endsWith('.pdf')) return 'pdf'
  if (isImagePath(file.path)) return 'image'
  if (syntaxLanguage(file.path) !== null) return null
  return file.category === 'templates' ? 'jinja' : null
}

const structuredFormatTitles: Record<StructuredFormat, string> = {
  safetensors: 'SafeTensors', gguf: 'GGUF', imatrix: 'Imatrix', jinja: 'Jinja', pdf: 'PDF', image: 'Image',
}

// Native: the loaded document's format title, else the file's structured format; JSON, text and tokenizers get none.
function formatChip(inspection: Inspection): string | null {
  switch (inspection.kind) {
    case 'empty': return null
    case 'safetensors': return 'SafeTensors'
    case 'gguf': return `GGUF v${inspection.summary.version}`
    case 'imatrix': return 'Imatrix DAT'
    case 'template': return 'Jinja'
    case 'pdf': return 'PDF'
    case 'image': return inspection.isSvg ? 'SVG' : 'Image'
    default: {
      const format = structuredFormat(inspection.file)
      return format === null ? null : structuredFormatTitles[format]
    }
  }
}

function filePurpose(file: RepositoryFile): string {
  const format = structuredFormat(file)
  switch (file.category) {
    case 'configuration': return t('appPurposeConfiguration')
    case 'tokenizer': return t('appPurposeTokenizer')
    case 'templates': return t('appPurposeTemplates')
    case 'weightMetadata': return format === 'imatrix' ? 'Importance Matrix' : t('appPurposeWeightIndex')
    case 'documentation': return t('appPurposeDocumentation')
    case 'other': return t('appPurposeOther')
    case 'weights':
      return format === 'safetensors' ? t('appPurposeSafeTensors')
        : format === 'gguf' ? t('appPurposeGGUF')
          : format === 'imatrix' ? 'Importance Matrix' : t('appPurposeLockedWeights')
  }
}

function sourceTitle(snapshot: RepositorySnapshot): string {
  return snapshot.source === 'huggingface' ? 'Hugging Face' : snapshot.source === 'https' ? 'HTTPS' : t('appSourceLocal')
}

// Native statusText: source · branch · SHA of the open file (else the commit), or source · live.
function sourceStatus(snapshot: RepositorySnapshot, file: RepositoryFile | null): string {
  if (snapshot.source !== 'huggingface') {
    return `${sourceTitle(snapshot)} · ${t(snapshot.source === 'https' ? 'appLiveSourceStatus' : 'appLiveDirectoryStatus')}`
  }
  return `Hugging Face · main · SHA ${(file?.hash ?? snapshot.revision).slice(0, 7)}`
}

function formatBigBytes(bytes: bigint): string {
  const value = Number(bytes)
  return Number.isSafeInteger(value) ? formatBytes(value) : t('appActualReadBytesValue', { count: formatNumber(bytes) })
}

function formatFloat(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 6 })
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
  if (status.state === 'checked') return t('consistencyCoverageChecked')
  if (status.state === 'missing') return t('statusMissing')
  if (status.state === 'skipped') return t('consistencyCoverageSkipped', { reason: status.reason })
  return t('consistencyCoverageFailed', { message: status.message })
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
    : `${snapshot.source}:${snapshot.selectionId}`
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
