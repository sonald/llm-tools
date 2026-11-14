import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
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
import { readSafeTensors, type SafeTensorsSummary } from './core/inspectors.ts'
import { ggufIsIMatrix, loadGGUF, type GGUFOverview } from './core/gguf.ts'
import {
  decodeStrictText,
  inspectionPerspectives,
  perspectiveLabel,
  validatePdfData,
  type Perspective,
  type PerspectiveDocument,
} from './core/readers.ts'
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
  inspectTokenizerData,
} from './tokenizerClient.ts'
import {
  isSentencePieceFile,
  type TokenizerStructure,
} from './core/tokenizer.ts'
import { ImageInspection, PdfInspection, SourceInspection, TextInspection, type FileDiagnostic } from './Readers.tsx'
import { ResizeHandle } from './ResizeHandle.tsx'
import { GGUFReader, ImatrixReader, SafeTensorsReader } from './WeightsReaders.tsx'
import { MiddleTruncated } from './MiddleTruncated.tsx'
import { EmbeddedTemplatePlayground, TemplateWorkbench } from './TemplateWorkbench.tsx'
import { isBlocked, SourceSelect, TokenizerOverview, TokenizerPlayground, type SourceMode } from './TokenizerPlayground.tsx'
import { formatNumber, translate as t, type MessageKey } from './i18n.ts'
import { WorkspaceSlotsContext, type PanelTabId, type ToolTab, type WorkspaceSlots } from './workspaceSlots.ts'

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
// Native ModelFiles.lastRepositoryInput, reopened on launch (D-3). Native skips the launch open when the last
// input was a directory (shouldOpenOnLaunch); a local or HTTPS open stores '' here for the same effect.
const lastInputKey = 'model-files.last-repository-input'
const defaultRepositoryInput = 'Qwen/Qwen3-4B'

type Inspection =
  | { kind: 'empty' }
  | { kind: 'loading'; file: RepositoryFile }
  | { kind: 'error'; file: RepositoryFile; message: string }
  | { kind: 'locked'; file: RepositoryFile }
  | { kind: 'text'; file: RepositoryFile; content: string; parsed: unknown; bytesRead: number; json: boolean }
  | { kind: 'safetensors'; file: RepositoryFile; summary: SafeTensorsSummary; headerBytes: number }
  | { kind: 'gguf'; file: RepositoryFile; overview: GGUFOverview; bytesRead: number }
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


type RepositoryError = { message: string; retryable: boolean }

export default function App() {
  const [sourceMode, setSourceMode] = useState<SourceMode>('huggingface')
  const [repositoryInput, setRepositoryInput] = useState(readLastRepositoryInput)
  const [guidanceOpen, setGuidanceOpen] = useState(false)
  // Native NavigationSplitView sidebar: min 255, ideal 292, max 360, collapsible.
  const [sidebarWidth, setSidebarWidth] = useState(292)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const repositoryFormRef = useRef<HTMLFormElement>(null)
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
  const [showWhitespace, setShowWhitespace] = useState(false)
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
  // Native: ⌘Return opens from anywhere in the window (Ctrl+Enter off macOS); disabled while loading.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey
        || event.isComposing || event.defaultPrevented) return
      event.preventDefault()
      setGuidanceOpen(false)
      // click() on the disabled button is a no-op, which is native's disabled keyboardShortcut.
      repositoryFormRef.current?.querySelector<HTMLButtonElement>('.primary-button')?.click()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
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
        } else {
          // Native ContentView .task: reopen the last input on launch; ?repo= takes priority.
          const last = readLastRepositoryInput()
          if (last !== '') void loadRoute(last, null, true)
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
      saveLastRepositoryInput('')
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
      // Native: loading ends with the manifest; the first file loads on its own.
      setIsLoadingRepository(false)
      saveLastRepositoryInput(next.source === 'huggingface' ? next.modelId : '')
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
        next = { kind: 'safetensors', file, ...await readSafeTensors(activeSnapshot, file, controller.signal) }
      } else if (lower.endsWith('.gguf') || lower.endsWith('.gguf_file')) {
        next = { kind: 'gguf', file, ...await loadGGUF(activeSnapshot, file, controller.signal) }
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
          const data = await readWholeFile(activeSnapshot, selected.chatTemplate, controller.signal)
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

  // Native consistencyGGUF: the first GGUF by path opened in this session; others are skipped, not read.
  function ggufMaterial(activeSnapshot: RepositorySnapshot): ConsistencyMaterial<GGUFOverview> {
    const ggufFiles = activeSnapshot.files.filter(isGGUF)
    if (ggufFiles.length === 0) return { state: 'missing' }
    for (const file of [...ggufFiles].sort((l, r) => (l.path < r.path ? -1 : l.path > r.path ? 1 : 0))) {
      const cached = inspectionCache.current.get(`${snapshotIdentity(activeSnapshot)}/${file.path}`)
      if (cached?.kind === 'gguf') return { state: 'available', value: cached.overview }
    }
    return { state: 'skipped', reason: t('appGgufNotOpenedThisSession') }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="icon-button sidebar-toggle" type="button" aria-expanded={sidebarOpen} aria-controls="file-sidebar"
          aria-label={t(sidebarOpen ? 'appHideSidebarAction' : 'appShowSidebarAction')}
          title={t(sidebarOpen ? 'appHideSidebarAction' : 'appShowSidebarAction')} onClick={() => setSidebarOpen(open => !open)}>
          <SidebarIcon />
        </button>
        <div className="brand">
          <AppMark />
          <span>Model Files</span>
        </div>
        <form className="repository-form" onSubmit={openRepository} ref={repositoryFormRef}>
          <SourceSelect value={sourceMode} onChange={mode => {
            clearRepository()
            clearRoute('push')
            setSourceMode(mode)
            setRepositoryInput('')
          }} />
          <label className="sr-only" htmlFor="repository">{t(sourceMode === 'huggingface' ? 'appHuggingFaceRepositoryLabel' : 'appHttpsUrlLabel')}</label>
          <div className="repository-field">
            <input
              id="repository"
              list={sourceMode === 'huggingface' ? 'repository-history' : undefined}
              autoComplete="off"
              value={repositoryInput}
              onChange={event => {
                setRepositoryInput(event.target.value)
                // Native closes the guidance when a history item is picked; picking from a datalist is not typing.
                const inputType = (event.nativeEvent as InputEvent).inputType
                setGuidanceOpen(inputType !== undefined && inputType !== 'insertReplacementText')
              }}
              onFocus={() => setGuidanceOpen(true)}
              onBlur={() => setGuidanceOpen(false)}
              onKeyDown={event => {
                if (event.key === 'Escape' && guidanceOpen) {
                  event.preventDefault()
                  setGuidanceOpen(false)
                } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault()
                  setGuidanceOpen(false)
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder={sourceMode === 'huggingface' ? t('appRepositoryPlaceholder') : 'https://…'}
              title={sourceMode === 'huggingface' ? t('appRepositoryHelp') : undefined}
              aria-describedby={sourceMode === 'huggingface' && guidanceOpen ? 'repository-guidance' : undefined}
              spellCheck={false}
            />
            {sourceMode === 'huggingface' && guidanceOpen ? (
              // Native RepositoryInputGuidanceView; local paths and ssh:// cannot be typed on the web, so one row.
              <div className="repository-guidance" id="repository-guidance" role="tooltip">
                <div className="repository-guidance-row">
                  <BoxIcon />
                  <strong>{t('appGuidanceModelRepository')}</strong>
                  <span>— {t('appGuidanceModelRepositoryExample')}</span>
                </div>
              </div>
            ) : null}
          </div>
          <datalist id="repository-history">
            {repositoryHistory.map(modelId => <option value={modelId} key={modelId.toLocaleLowerCase()} />)}
          </datalist>
          <label className="directory-button" title={t('appSelectLocalDirectoryHelp')}>
            <FolderIcon />
            <input
              type="file"
              multiple
              aria-label={t('appSelectFolderAction')}
              onChange={openLocalDirectory}
              {...{ webkitdirectory: '' }}
            />
          </label>
          <button className="primary-button" type="submit" disabled={isLoadingRepository}>
            {t('appRepositoryOpenAction')}
          </button>
          {repositoryHistory.length > 0 ? (
            <button className="history-button" type="button" onClick={() => {
              try {
                localStorage.removeItem(historyKey)
                localStorage.removeItem(lastInputKey)
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

      <div className="workspace" data-sidebar={sidebarOpen ? 'open' : 'closed'}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
        <aside className="sidebar" id="file-sidebar" hidden={!sidebarOpen}>
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
        {sidebarOpen ? <ResizeHandle axis="x" before value={sidebarWidth} min={255} max={360} onChange={setSidebarWidth} /> : null}
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
            // Native: the first docked result opens the panel on the Token table, even over Problems.
            // ponytail: phones lack the height to auto-open the panel.
            if (isPhone) return
            setPanelOpen(true)
            setPanelTab('tokens')
          }}
          onClosePanel={closePanel}
          showWhitespace={showWhitespace}
          onShowWhitespace={setShowWhitespace}
          perspective={shownPerspective}
          onPerspectiveChange={setPerspective}
          diagnostics={(selectedPath === null ? undefined : fileDiagnostics.get(selectedPath)) ?? noDiagnostics}
          inspectorOpen={inspectorShown}
          selectedFindingId={selectedFindingId}
          onSelectFinding={id => {
            // Native: selecting a problem never opens the inspector by itself.
            setSelectedFindingId(id)
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
            {/* Native: local files open too (here as a blob URL); a separator follows. */}
            {url !== null || snapshot.source === 'local' ? <>
              <button type="button" role="menuitem" onClick={() => {
                openOriginalFile(snapshot, fileMenu.file, url)
                setFileMenu(null)
              }}>{t('appOpenOriginalFileAction')}</button>
              <hr role="separator" />
            </> : null}
            {/* ponytail: a browser never sees a local file's absolute path, so the item stays but is disabled. */}
            <button type="button" role="menuitem" disabled={url === null} onClick={() => {
              if (url !== null) void navigator.clipboard.writeText(url).catch(() => {})
              setFileMenu(null)
            }}>{t('appCopyFullPathAction')}</button>
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
  showWhitespace,
  onShowWhitespace,
}: {
  showWhitespace: boolean
  onShowWhitespace(value: boolean): void
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
    showWhitespace,
    setShowWhitespace: onShowWhitespace,
  }), [panelOpen, activeTab, panelBody, inspectorOpen, inspectorSlot, onOpenToolPanel, showWhitespace, onShowWhitespace])

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
        {inspection.kind === 'safetensors' ? <SafeTensorsReader key={file.path} summary={inspection.summary}
          headerBytes={inspection.headerBytes} perspective={perspective} onPerspectiveChange={onPerspectiveChange} /> : null}
        {inspection.kind === 'gguf' ? <GGUFReader key={file.path} overview={inspection.overview}
          bytesRead={inspection.bytesRead} perspective={perspective} onPerspectiveChange={onPerspectiveChange} /> : null}
        {inspection.kind === 'imatrix' ? <ImatrixReader key={file.path} summary={inspection.summary} perspective={perspective} /> : null}
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
          <h3><SeverityIcon severity={finding.severity} />{finding.title}</h3>
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
      {[finding.left, finding.right].map((field, index) => (
        <div key={index}><dt>{field.key}</dt><dd>{field.value}</dd><span className="field-origin">{originTitle(field.origin)}</span></div>
      ))}
    </dl>
  )
}

// Native InspectionField.Origin.title.
function originTitle(origin: RepositoryConsistencyReport['findings'][number]['left']['origin'] | 'runtime'): string {
  return t(origin === 'embedded' ? 'fieldOriginEmbedded' : origin === 'derived' ? 'jinjaOriginDerived'
    : origin === 'repository' ? 'jinjaOriginRepository' : 'jinjaOriginRuntime')
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

// Native SeverityIcon: SF Symbols exclamationmark.triangle.fill / info.circle.fill in the palette colours.
function SeverityIcon({ severity }: { severity: 'warning' | 'info' }) {
  return (
    <span className="severity-mark" data-severity={severity} role="img" aria-label={t(severity === 'warning' ? 'appSeverityWarning' : 'appSeverityInfo')}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {severity === 'warning'
          ? <><path d="M7.13 1.9a1 1 0 0 1 1.74 0l6.2 10.9a1 1 0 0 1-.87 1.5H1.8a1 1 0 0 1-.87-1.5Z" fill="currentColor" /><path d="M8 5.6v3.6M8 11.1v.2" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" /></>
          : <><circle cx="8" cy="8" r="6.8" fill="currentColor" /><path d="M8 7.2v4M8 4.8v.2" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" /></>}
      </svg>
    </span>
  )
}

// Native coverageIcon: checkmark.circle.fill / minus.circle / forward.circle / xmark.octagon.fill.
function CoverageIcon({ state }: { state: RepositoryConsistencyReport['coverage'][number]['status']['state'] }) {
  return (
    <svg className="coverage-icon" data-coverage-icon={state} viewBox="0 0 16 16" aria-hidden="true">
      {state === 'checked' ? <><circle cx="8" cy="8" r="6.8" fill="currentColor" /><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>
        : state === 'missing' ? <><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M5 8h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>
        : state === 'skipped' ? <><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M4.8 5.6 7.4 8l-2.6 2.4M8.2 5.6 10.8 8l-2.6 2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></>
        : <><path d="M5.3 1.5h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5.3Z" fill="currentColor" /><path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" stroke="var(--panel)" strokeWidth="1.5" strokeLinecap="round" /></>}
    </svg>
  )
}

// Native materialTitle: raw lowercase names, not localized.
const materialTitles: Record<RepositoryConsistencyReport['coverage'][number]['material'], string> = {
  config: 'config', generationConfig: 'generation_config', tokenizerConfig: 'tokenizer_config', tokenizer: 'tokenizer',
  adapterConfig: 'adapter_config', processorConfig: 'processor_config', chatTemplates: 'chat template', gguf: 'GGUF',
}

function ConsistencyReportBody({ report, selectedId, onSelect }: {
  report: RepositoryConsistencyReport | null
  selectedId: string | null
  onSelect(id: string): void
}) {
  if (report === null) return <p className="consistency-loading"><span className="spinner" aria-hidden="true" />{t('appCheckingRepositoryMaterials')}</p>
  return (
    <div className="consistency-details">
      {consistencyBadgeState(report).state === 'insufficient'
        ? <p className="consistency-note"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.2v.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>{t('consistencyInsufficientNote')}</p> : null}
      {report.findings.length === 0 ? <p className="consistency-note">{t('consistencyNoFindings')}</p> : (
        <div className="finding-rows">
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
              <SeverityIcon severity={finding.severity} />
              <span className="finding-title">{finding.title}</span>
              <MiddleTruncated className="finding-compare"
                text={`${finding.left.key} = ${finding.left.value} · ${finding.right.key} = ${finding.right.value}`} />
            </button>
          ))}
        </div>
      )}
      <div className="consistency-columns">
        {report.identityFields.length > 0 ? (
          <section aria-label={t('consistencyIdentityTitle')}>
            <h3>{t('consistencyIdentityTitle')}</h3>
            <dl className="consistency-identity">
              {report.identityFields.map(item => (
                <div key={item.key} data-identity-key={item.key}>
                  <dt>{item.key}</dt>
                  <dd>{item.value}</dd>
                  <span className="field-origin">{originTitle(item.origin)}</span>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        <section aria-label="Coverage">
          <h3>Coverage</h3>
          <ul className="consistency-coverage">
            {report.coverage.map(item => (
              <li key={item.material} data-material={item.material} data-coverage-status={item.status.state}>
                <CoverageIcon state={item.status.state} />
                <span>{materialTitles[item.material]}</span>
                <span className="coverage-status">{consistencyCoverageText(item.status)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

function TokenizerInspection({ snapshot, file, perspective }: {
  snapshot: RepositorySnapshot
  file: RepositoryFile
  perspective: Perspective
}) {
  // Native: 概览 / 全部字段 / 原文 come from the header; 试验台 is the tokenizer playground.
  if (perspective === 'playground') return <TokenizerPlayground snapshot={snapshot} file={file} />
  if (perspective !== 'overview') return <TokenizerJSONInspection snapshot={snapshot} file={file} perspective={perspective} />
  return <TokenizerOverview snapshot={snapshot} file={file} />
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

// Native DetailView bottom inset: what was read, and what was deliberately not requested.
function SafetyNotice({ inspection }: { inspection: Inspection }) {
  const notice = safetyNotice(inspection)
  if (notice === null) return null
  return <div className="safety-notice"><LockIcon /><span>{notice}</span></div>
}

function safetyNotice(inspection: Inspection): string | null {
  switch (inspection.kind) {
    case 'safetensors': return t('wtSafeTensorsNotice', { size: formatBytes(inspection.headerBytes) })
    case 'gguf': return t('wtGgufNotice', { size: formatBytes(inspection.bytesRead) })
    case 'imatrix': return t('noticeImatrix', { size: formatBytes(inspection.bytesRead) })
    case 'pdf': return t('noticePdf', { size: formatBytes(inspection.bytesRead) })
    case 'image': return t('noticeImage', { size: formatBytes(inspection.bytesRead) })
    // Native shows the fallback only for a loaded document, not while loading, failed or locked.
    case 'text': return inspection.file.category === 'weightMetadata' ? t('noticeWeightIndex') : null
    default: return null
  }
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

// SF Symbols sidebar.left / folder / shippingbox.
function SidebarIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M6 3v10" /></svg>
}

function FolderIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4v8.5h13V5.5H7.3L5.8 4z" /></svg>
}

function BoxIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 14 4.8v6.4L8 14.2 2 11.2V4.8zM2 4.8l6 3 6-3M8 7.8v6.4M5 3.3l6 3" /></svg>
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
    case 'gguf': return ggufIsIMatrix(inspection.overview) ? 'GGUF Imatrix' : `GGUF v${inspection.overview.version}`
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


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function openOriginalFile(snapshot: RepositorySnapshot, file: RepositoryFile, url: string | null): void {
  if (url !== null) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  const blob = snapshot.source === 'local' ? snapshot.localFiles.get(file.path) : undefined
  if (blob === undefined) return
  // A blob: page runs in this origin, so only inert types keep theirs. Weights download, like their Hub
  // resolve URL; every other file (HTML, SVG, JSON, code…) opens as plain text.
  if (isBlocked(file) || file.category === 'weights') {
    const blobUrl = URL.createObjectURL(blob)
    const link = Object.assign(document.createElement('a'), { href: blobUrl, download: file.path.split('/').at(-1) ?? file.path })
    link.click()
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    return
  }
  const inert = /^(image\/(png|jpeg|gif|webp|bmp|avif|tiff|x-icon|vnd\.microsoft\.icon)|application\/pdf|text\/plain)$/.test(blob.type)
  const blobUrl = URL.createObjectURL(inert ? blob : new Blob([blob], { type: 'text/plain;charset=utf-8' }))
  window.open(blobUrl, '_blank', 'noopener,noreferrer')
  // ponytail: the new tab has already resolved the URL by then; revoke so the File isn't pinned for the session.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
}

function readLastRepositoryInput(): string {
  try {
    return localStorage.getItem(lastInputKey) ?? defaultRepositoryInput
  } catch {
    return defaultRepositoryInput
  }
}

function saveLastRepositoryInput(modelId: string): void {
  try {
    localStorage.setItem(lastInputKey, modelId)
  } catch {
    // Launch falls back to the default repository when storage is unavailable.
  }
}

function saveRepositoryHistory(history: string[]): void {
  try {
    localStorage.setItem(historyKey, JSON.stringify(history))
  } catch {
    // History is optional when storage is unavailable.
  }
}
