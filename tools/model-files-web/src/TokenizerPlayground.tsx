import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  activeChatTemplate, mergeChatTemplates, selectChatTemplate, type ChatTemplateCatalog, type ChatTemplateEntry,
} from './core/chatTemplates.ts'
import {
  formatBytes, loadHttpsSource, loadLocalDirectory, loadRepository, readWholeFile, type RepositoryFile, type RepositorySnapshot,
} from './core/huggingface.ts'
import { decodeStrictText, decodeUtf8Text } from './core/readers.ts'
import type { ChatAttributionMessage, ChatTokenRole } from './core/tokenAttribution.ts'
import {
  compareTokenizerTokenizations, InputTooLargeError, isSentencePieceFile, parseTokenIds, selectTokenizerComparisonTargets,
  type Tokenization, type TokenizerStructure, type TokenizerVocabularyAnalysis, type TokenizerVocabularyEntry,
} from './core/tokenizer.ts'
import { emptyTool, initialVariables, message, templateContext, type TemplateRequest } from './core/templateRequest.ts'
import { formatNumber, translate as t } from './i18n.ts'
import { RequestEditor } from './TemplatePlayground.tsx'
import { TemplateRenderClient } from './templateRender.ts'
import {
  createComparisonTokenizerSession, mainTokenizerSession, searchTokenizerVocabulary, type TokenizerSession,
} from './tokenizerClient.ts'
import { WorkspaceSlotsContext } from './workspaceSlots.ts'

// Native ModelFilesStore.maximumTokenizerInputByteCount.
const inputLimit = 64 * 1024
const rowHeight = 30

export type SourceMode = 'huggingface' | 'file' | 'manifest'

export function SourceSelect({ value, onChange }: { value: SourceMode; onChange(value: SourceMode): void }) {
  return <select className="source-select" aria-label={t('appSourceLabel')} value={value}
    onChange={event => onChange(event.target.value as SourceMode)}>
    <option value="huggingface">Hugging Face</option>
    <option value="file">{t('appHttpsFile')}</option>
    <option value="manifest">{t('appHttpsManifest')}</option>
  </select>
}

// Native file.isBlocked: weights the app never reads.
export function isBlocked(file: RepositoryFile): boolean {
  const lower = file.path.toLocaleLowerCase()
  return file.category === 'weights' && !lower.endsWith('.safetensors')
    && !lower.endsWith('.gguf') && !lower.endsWith('.gguf_file')
}

export function templateLabel(entry: ChatTemplateEntry): string {
  return entry.source === 'jinjaFile' ? 'chat_template.jinja' : `tokenizer_config.json · ${entry.name}`
}

// Native visibleTokenizerText.
export function visibleTokenizerText(text: string, showWhitespace: boolean): string {
  if (!showWhitespace) return text.replace(/\r\n|\r|\n/g, ' ')
  return text.replaceAll(' ', '·').replaceAll('\t', '→').replace(/\r\n|\r|\n/g, '↵')
}

type Mode = 'raw' | 'chat' | 'ids'
type Phase =
  | { kind: 'loading' } | { kind: 'tokenizing' } | { kind: 'ready' }
  | { kind: 'inputTooLarge'; limit: number } | { kind: 'failed'; message: string }
type Bundle = { structure: TokenizerStructure; template: string | null; config: Record<string, unknown> }
type ChatSeed = { template: string; context: Record<string, unknown>; attribution: ChatAttributionMessage[] }
type ComparisonSource =
  | { kind: 'path'; path: string }
  | { kind: 'repository'; input: string; mode: SourceMode }
  | { kind: 'local'; files: File[] }
type ComparisonTarget = { snapshot: RepositorySnapshot; file: RepositoryFile; config: RepositoryFile | undefined }
type Vocabulary = { skipped: string } | { counts: { leftOnlyCount: number; rightOnlyCount: number; sharedCount: number } }
type ComparisonLoad = {
  source: ComparisonSource
  title: string
  status: 'loading' | 'failed' | 'ready'
  message: string
  target: ComparisonTarget | null
  catalog: ChatTemplateCatalog | null
  vocabulary: Vocabulary | null
}
type RightRun = { status: 'loading' | 'failed' | 'ready'; right: Tokenization | null; message: string }

const emptyEncode: Tokenization = {
  direction: 'encode', input: '', ids: [], pieces: [], decoded: '', segments: [], mapping: 'Exact', flags: [],
  overhead: null, roles: null,
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function companion(snapshot: RepositorySnapshot, file: RepositoryFile, basename: string) {
  const directory = file.path.split('/').slice(0, -1).join('/')
  const path = directory === '' ? basename : `${directory}/${basename}`
  return snapshot.files.find(candidate => candidate.path === path)
}

function entryFiles(snapshot: RepositorySnapshot): RepositoryFile[] {
  return selectTokenizerComparisonTargets(snapshot).map(target => target.file).filter(file => !isBlocked(file))
}

// Native ModelFilesStore.comparisonEntry: the root tokenizer.json, else the first entry point.
function comparisonEntry(snapshot: RepositorySnapshot): RepositoryFile | undefined {
  return snapshot.files.find(file => file.path === 'tokenizer.json' && !isBlocked(file)) ?? entryFiles(snapshot)[0]
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => {})
}

function roleTitle(role: ChatTokenRole): string {
  return role.kind === 'template' ? 'template' : role.role
}

// Native roleColor: fixed slots for the known roles, a code-point hash for custom ones.
function roleTone(role: ChatTokenRole): number {
  if (role.kind === 'template') return 9
  const known: Record<string, number> = { system: 6, user: 2, assistant: 3, tool: 4 }
  if (role.role in known) return known[role.role]
  let sum = 0
  for (const character of role.role) sum = (sum + character.codePointAt(0)!) % 10
  return sum
}

function segmentRole(result: Tokenization, start: number, end: number): ChatTokenRole | null {
  const roles = result.roles
  if (roles === null || roles.length !== result.ids.length || start >= roles.length) return null
  const first = JSON.stringify(roles[start])
  for (let index = start + 1; index < end; index += 1) if (JSON.stringify(roles[index]) !== first) return null
  return roles[start]
}

function graphemeCount(text: string): number {
  let count = 0
  for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) count += 1
  return count
}

function overheadText(count: number): string {
  return count < 0 ? t('tkpCannotSplit') : formatNumber(count)
}

function snapshotName(snapshot: RepositorySnapshot): string {
  return snapshot.source === 'huggingface' ? snapshot.modelId : snapshot.name
}

// Native TokenizerPlaygroundView: input on the left, metrics and the token stream on the right; the token table,
// IDs and selection dock into the bottom panel and inspector unless a comparison is open.
export function TokenizerPlayground({ snapshot, file }: { snapshot: RepositorySnapshot; file: RepositoryFile }) {
  const slots = useContext(WorkspaceSlotsContext)
  const showWhitespace = slots?.showWhitespace ?? false
  const visible = (text: string) => visibleTokenizerText(text, showWhitespace)
  const config = companion(snapshot, file, 'tokenizer_config.json')
  const templateFile = companion(snapshot, file, 'chat_template.jinja')

  const [mode, setMode] = useState<Mode>('chat')
  const [rawText, setRawText] = useState('ModelFiles 让 tokenizer 的行为变得可见。 👩‍💻\nWhitespace matters.')
  const [idsText, setIdsText] = useState('')
  const [request, setRequest] = useState<TemplateRequest>(() => ({
    messages: [message('system', 'You are a concise assistant.'), message('user', '解释一下：分词为什么会影响上下文长度？')],
    includeTools: false,
    tools: [{
      ...emptyTool(), name: 'get_weather', description: 'Get the current weather for a city.',
      parametersJSON: '{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}',
    }],
    variables: [],
    addGenerationPrompt: true,
  }))
  const [rendered, setRendered] = useState({ text: '', error: null as string | null, rendering: false })
  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [bundleError, setBundleError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [result, setResult] = useState<Tokenization | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const chatSeed = useRef<ChatSeed | null>(null)
  const renderClient = useRef<TemplateRenderClient | null>(null)
  const didInitializeVariables = useRef(false)

  const catalog = bundle === null ? null
    : selectChatTemplate(mergeChatTemplates(bundle.structure.chatTemplates, bundle.template), selectedTemplateId)
  const activeTemplate = catalog === null ? null : activeChatTemplate(catalog)
  const loaded = bundle !== null || bundleError !== null
  const chatIsAvailable = activeTemplate !== null || !loaded

  useEffect(() => {
    renderClient.current = new TemplateRenderClient()
    return () => renderClient.current?.dispose()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setBundle(null)
    setBundleError(null)
    void (async () => {
      const readConfig = async () => {
        if (config === undefined) return {}
        try {
          const value: unknown = JSON.parse(decodeStrictText(await readWholeFile(snapshot, config, controller.signal)))
          return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
        } catch { return {} }
      }
      try {
        // The tokenizer load reads tokenizer_config.json first; reading it afterwards hits the whole-file cache.
        const structure = await mainTokenizerSession.inspectTokenizer(snapshot, file, config, controller.signal)
        const [template, configObject] = await Promise.all([
          templateFile === undefined ? null
            : readWholeFile(snapshot, templateFile, controller.signal).then(data => decodeUtf8Text(data, t('chatTemplateJinjaNotUtf8'))),
          readConfig(),
        ])
        if (!controller.signal.aborted) setBundle({ structure, template, config: configObject })
      } catch (failure) {
        if (!controller.signal.aborted) setBundleError(errorMessage(failure))
      }
    })()
    return () => controller.abort()
  }, [snapshot, file, config, templateFile, reloadKey])

  // Native: once the bundle has loaded without a usable template, Chat falls back to Raw.
  useEffect(() => {
    if (loaded && activeTemplate === null && mode === 'chat') setMode('raw')
  }, [loaded, activeTemplate === null])

  useEffect(() => {
    if (didInitializeVariables.current || activeTemplate === null || bundle === null) return
    didInitializeVariables.current = true
    setRequest(current => ({ ...current, variables: initialVariables(activeTemplate.body, bundle.config) }))
  }, [activeTemplate, bundle])

  useEffect(() => setSelectedIndex(null), [result])

  // Native updateAuthoritativeInput + ModelFilesStore.tokenize/decodeTokenIDs: every request clears the result,
  // encode waits 225 ms, Chat renders first.
  const ready = bundle !== null
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timers: number[] = []
    const sleep = () => new Promise<void>(resolve => { timers.push(window.setTimeout(resolve, 225)) })
    const notReady = () => setPhase(bundleError !== null ? { kind: 'failed', message: bundleError } : { kind: 'loading' })
    const clear = () => {
      chatSeed.current = null
      setResult(null)
      if (ready) setPhase({ kind: 'ready' })
      else notReady()
    }
    const publish = async (work: () => Promise<Tokenization>) => {
      setPhase({ kind: 'tokenizing' })
      try {
        const next = await work()
        if (cancelled) return
        setResult(next)
        setPhase({ kind: 'ready' })
      } catch (failure) {
        if (!cancelled) setPhase({ kind: 'failed', message: errorMessage(failure) })
      }
    }
    const encode = async (text: string, seed: ChatSeed | null) => {
      chatSeed.current = seed
      setResult(null)
      if (bytes(text) > inputLimit) { setPhase({ kind: 'inputTooLarge', limit: inputLimit }); return }
      if (!ready) { notReady(); return }
      if (text === '' && seed === null) { setResult(emptyEncode); setPhase({ kind: 'ready' }); return }
      setPhase({ kind: 'tokenizing' })
      await sleep()
      if (cancelled) return
      await publish(() => seed === null
        ? mainTokenizerSession.tokenize(snapshot, file, config, text, controller.signal)
        : mainTokenizerSession.chatTokenize(snapshot, file, config, seed.template, seed.context, seed.attribution, controller.signal))
    }
    void (async () => {
      if (mode === 'raw') {
        setRendered({ text: '', error: null, rendering: false })
        await encode(rawText, null)
      } else if (mode === 'ids') {
        setRendered({ text: '', error: null, rendering: false })
        await sleep()
        if (cancelled) return
        chatSeed.current = null
        setResult(null)
        let ids: number[]
        try {
          ids = parseTokenIds(idsText)
        } catch (failure) {
          setPhase(failure instanceof InputTooLargeError
            ? { kind: 'inputTooLarge', limit: failure.limit }
            : { kind: 'failed', message: errorMessage(failure) })
          return
        }
        if (!ready) { notReady(); return }
        await publish(() => mainTokenizerSession.decodeTokenIdArray(snapshot, file, config, ids, idsText, controller.signal))
      } else if (activeTemplate === null) {
        setRendered({ text: '', error: null, rendering: false })
        clear()
      } else {
        setRendered(current => ({ ...current, rendering: true }))
        let context: Record<string, unknown> = {}
        let outcome
        try {
          context = templateContext(request)
          outcome = await renderClient.current?.render(activeTemplate.body, context) ?? null
        } catch (failure) {
          outcome = { output: '', error: errorMessage(failure) }
        }
        if (cancelled || outcome === null) return
        setRendered({ text: outcome.output, error: outcome.error, rendering: false })
        if (outcome.error !== null) { clear(); return }
        await encode(outcome.output, {
          template: activeTemplate.body,
          context,
          attribution: request.messages.map(item => ({ role: item.role, content: item.content, contentKind: item.contentKind })),
        })
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [mode, rawText, idsText, request, activeTemplate?.body, ready, bundleError, snapshot, file, config])

  const comparison = useComparison(snapshot, file, ready, result, chatSeed)
  const docks = comparison.load === null

  // Native docksTokenizerResults: the tabs exist whenever the docked playground shows, independent of the result.
  const registerTabs = slots?.registerTabs
  const tokenCount = result?.ids.length
  useEffect(() => {
    if (registerTabs === undefined || !docks) return
    registerTabs([
      { id: 'tokens', label: t('appPanelTokensTab') },
      { id: 'ids', label: t('appPanelTokenIdsTab'), count: tokenCount },
    ])
  }, [registerTabs, docks, tokenCount])
  useEffect(() => {
    if (registerTabs === undefined || !docks) return
    return () => registerTabs([])
  }, [registerTabs, docks])
  // Native: the first docked non-empty result opens the panel on the Token table; a closed panel stays closed after.
  const openToolPanel = useRef(slots?.openToolPanel)
  openToolPanel.current = slots?.openToolPanel
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || !docks || result === null || result.ids.length === 0) return
    autoOpened.current = true
    openToolPanel.current?.()
  }, [result, docks])

  const authoritativeText = mode === 'ids' ? result?.decoded ?? '' : mode === 'raw' ? rawText : rendered.text
  const graphemes = useMemo(() => graphemeCount(authoritativeText), [authoritativeText])
  const inputStatus = rendered.rendering ? t('tkpStatusRendering') : rendered.error !== null ? t('tkpStatusTemplateError')
    : mode === 'ids' ? t('tkpStatusDecoded') : t('tkpStatusLive')
  const authoritativeDetail = mode === 'ids'
    ? t('tkpDecodedDetail', { count: formatNumber(bytes(authoritativeText)) })
    : t('tkpSourceDetail', {
      source: mode === 'chat' ? t('tkpSourceRendered') : t('tkpModeRaw'),
      count: formatNumber(bytes(mode === 'raw' ? rawText : rendered.text)),
    })
  const resultStatus = mode === 'ids' ? t('tkpResultStatusIds', { path: file.path })
    : t('tkpResultStatus', { path: file.path, mapping: result?.mapping ?? t('tkpWaitingResult') })
  const tokenTotal = result?.ids.length
  const metrics = (
    <div className={`tkp-metrics ${mode === 'chat' ? 'chat' : ''}`}>
      <div className="tkp-metric-row">
        <Metric title={t('tkpTokenCount')} value={tokenTotal === undefined ? '—' : formatNumber(tokenTotal)} />
        <Metric title={t('tkpUnicodeCharacters')} value={formatNumber(graphemes)} />
        <Metric title={t('tkpBytesPerToken')}
          value={tokenTotal === undefined || tokenTotal === 0 ? '—' : (bytes(authoritativeText) / tokenTotal).toFixed(1)} />
      </div>
      {mode === 'chat' ? (
        <div className="tkp-metric-row">
          <Metric compact title={t('tkpContentTokens')}
            value={result?.overhead == null ? '—' : formatNumber(result.overhead.contentCount)} />
          <Metric compact title={t('tkpTemplateOverhead')}
            value={result?.overhead == null ? '—' : overheadText(result.overhead.templateCount)} />
        </div>
      ) : null}
    </div>
  )

  const modes: Array<[Mode, string]> = [['raw', t('tkpModeRaw')], ['chat', t('tkpModeChat')], ['ids', 'Token IDs']]
  const comparisonMenu = (
    <ComparisonMenu snapshot={snapshot} open={comparison.load !== null} onOpen={comparison.open}
      onClose={() => comparison.open(null)} showWhitespace={showWhitespace} setShowWhitespace={slots?.setShowWhitespace} />
  )

  return (
    <div className="tkp">
      <div className="tkp-grid">
      <div className="tkp-left">
        <Panel title={t('tkpInput')} detail={inputStatus} className="tkp-input" trailing={
          <div className="tkp-input-controls" title={chatIsAvailable ? t('tkpModeHelp') : t('tkpModeHelpNoTemplate')}>
            {mode === 'chat' && catalog !== null && activeTemplate !== null ? (
              catalog.entries.length > 1 ? (
                <select className="tkp-badge" aria-label="Chat Template" value={activeTemplate.id}
                  onChange={event => setSelectedTemplateId(event.target.value)}>
                  {catalog.entries.map(entry => (
                    <option key={entry.id} value={entry.id} disabled={!entry.usable}>{templateLabel(entry)}</option>
                  ))}
                </select>
              ) : <span className="tkp-badge">{templateLabel(activeTemplate)}</span>
            ) : null}
            <div className="tkp-segmented" role="group" aria-label={t('tkpModeAria')}>
              {modes.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={mode === value} disabled={value === 'chat' && !chatIsAvailable}
                  onClick={() => setMode(value)}>{label}</button>
              ))}
            </div>
          </div>
        }>
          {mode === 'chat' ? (
            <div className="tkp-chat-editor"><RequestEditor compact request={request} onChange={setRequest} /></div>
          ) : (
            <div className="tkp-text-input">
              <textarea spellCheck={false} aria-label={mode === 'raw' ? t('tkpModeRaw') : 'Token IDs'}
                value={mode === 'raw' ? rawText : idsText}
                onChange={event => (mode === 'raw' ? setRawText : setIdsText)(event.target.value)} />
              <footer>
                <span>{mode === 'raw' ? t('tkpBytes', { count: formatNumber(bytes(rawText)) }) : t('tkpIdsHint')}</span>
                <button type="button" onClick={() => (mode === 'raw' ? setRawText : setIdsText)('')}>{t('tkpClear')}</button>
              </footer>
            </div>
          )}
        </Panel>
        <Panel title={mode === 'ids' ? t('tkpDecodedText') : t('tkpTokenizerText')} detail={authoritativeDetail}
          className="tkp-authoritative" trailing={
            <button type="button" disabled={authoritativeText === ''} onClick={() => copy(authoritativeText)}>{t('tkpCopy')}</button>
          }>
          {rendered.error !== null ? <p className="tkp-render-error" role="alert">⚠︎ {rendered.error}</p>
            : authoritativeText === '' ? <p className="tkp-placeholder">{mode === 'ids' ? t('tkpDecodedEmpty') : t('tkpTextEmpty')}</p>
            : <pre className="tkp-authoritative-text">{authoritativeText}</pre>}
        </Panel>
      </div>
      <div className="tkp-right">
        {metrics}
        {comparison.load !== null ? (
          <Panel title={t('tkpComparison')} detail={resultStatus} className="tkp-result" trailing={comparisonMenu}>
            <ComparisonView key={comparison.load.target === null ? '' : `${comparison.load.title}`} load={comparison.load}
              run={comparison.run} left={result} showWhitespace={showWhitespace} session={comparison.session}
              onSelectTemplate={comparison.selectTemplate} />
          </Panel>
        ) : (
          <Panel title={t('tkpResult')} detail={resultStatus} className="tkp-result" trailing={
            <div className="tkp-result-controls">
              {comparisonMenu}
              <button type="button" disabled={result === null || result.ids.length === 0}
                onClick={() => copy(result?.ids.join(', ') ?? '')}>{t('tkpCopyIds')}</button>
              <WhitespaceToggle value={showWhitespace} onChange={slots?.setShowWhitespace} />
            </div>
          }>
            <ResultBody phase={phase} mode={mode} result={result} selectedIndex={selectedIndex} onSelect={setSelectedIndex}
              showWhitespace={showWhitespace} onRetry={() => setReloadKey(key => key + 1)} />
          </Panel>
        )}
      </div>
      </div>
      {docks && slots?.panelBody != null ? createPortal(
        result === null || result.ids.length === 0 ? <div className="result-empty">{t('tkpEmptyResult')}</div>
          : slots.activeTab === 'ids'
            ? <TokenIdChips result={result} selectedIndex={selectedIndex} onSelect={setSelectedIndex} visible={visible} />
            : <TokenTable result={result} visible={visible} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />,
        slots.panelBody,
      ) : null}
      {docks && slots?.inspector != null && result !== null && selectedIndex !== null && selectedIndex < result.ids.length
        ? createPortal(<SelectedToken result={result} index={selectedIndex} visible={visible} />, slots.inspector) : null}
    </div>
  )
}

function Panel({ title, detail, trailing, className, children }: {
  title: string
  detail: string
  trailing?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`tkp-panel ${className ?? ''}`} aria-label={title}>
      <header className="tkp-panel-header">
        <h2>{title}</h2>
        <span className="tkp-panel-detail">{detail}</span>
        {trailing}
      </header>
      {children}
    </section>
  )
}

function Metric({ title, value, compact = false }: { title: string; value: string; compact?: boolean }) {
  return <div className={`tkp-metric ${compact ? 'compact' : ''}`}><span>{title}</span><strong>{value}</strong></div>
}

function WhitespaceToggle({ value, onChange }: { value: boolean; onChange?(value: boolean): void }) {
  return (
    <label className="tkp-check">
      <input type="checkbox" checked={value} onChange={event => onChange?.(event.target.checked)} />
      {t('tkpShowWhitespace')}
    </label>
  )
}

function StateView({ title, icon, progress = false, children }: {
  title: string
  icon?: string
  progress?: boolean
  children?: ReactNode
}) {
  return (
    <div className="tkp-state" role="status">
      {progress ? <span className="spinner" /> : icon !== undefined ? <span className="tkp-state-icon" aria-hidden="true">{icon}</span> : null}
      <p>{title}</p>
      {children}
    </div>
  )
}

function ResultBody({ phase, mode, result, selectedIndex, onSelect, showWhitespace, onRetry }: {
  phase: Phase
  mode: Mode
  result: Tokenization | null
  selectedIndex: number | null
  onSelect(index: number | null): void
  showWhitespace: boolean
  onRetry(): void
}) {
  if (phase.kind === 'loading') return <StateView title={t('tkpLoading')} progress />
  if (phase.kind === 'tokenizing') return <StateView title={t('tkpTokenizing')} progress />
  if (phase.kind === 'inputTooLarge') return <StateView title={t('tkpInputTooLarge', { limit: formatBytes(phase.limit) })} icon="⚠︎" />
  if (phase.kind === 'failed') {
    return (
      <StateView title={phase.message} icon="⊗">
        {mode === 'ids' ? null : <button type="button" onClick={onRetry}>{t('tkpRetry')}</button>}
      </StateView>
    )
  }
  if (result === null || result.ids.length === 0) return <StateView title={t('tkpEmptyResult')} icon="␣" />
  return (
    <div className="tkp-stream-wrap">
      {mode === 'chat' && result.mapping === 'Decoded only' ? <p className="tkp-banner">{t('tkpDecodedOnly')}</p> : null}
      <TokenStream result={result} selectedIndex={selectedIndex} onSelect={onSelect} showWhitespace={showWhitespace} />
    </div>
  )
}

type StreamItem = { start: number; tone: number; roleTone: number | null; text: string; label: string }

// 64 KiB of input is ~18k segments: build them once per result, and on a click re-render only the two
// segments whose selection changed. Native dims the rest to 0.28 opacity; restyling 18k elements takes seconds in
// WebKit, so a veil over the content does the dimming and the selected segment sits above it.
function TokenStream({ result, selectedIndex, onSelect, showWhitespace }: {
  result: Tokenization
  selectedIndex: number | null
  onSelect(index: number | null): void
  showWhitespace: boolean
}) {
  const items = useMemo(() => result.segments.map((segment, index): StreamItem => {
    const role = segmentRole(result, segment.start, segment.end)
    const text = visibleTokenizerText(segment.text, showWhitespace)
    return {
      start: segment.start,
      tone: index % 10,
      roleTone: role === null ? null : roleTone(role),
      text,
      label: t('tkpSegmentAria', {
        start: formatNumber(segment.start), end: formatNumber(segment.end - 1), ids: segment.ids.join(', '), text,
        role: role === null ? t('tkpNone') : roleTitle(role),
      }),
    }
  }), [result, showWhitespace])
  const current = useRef(selectedIndex)
  current.current = selectedIndex
  const toggle = useCallback((start: number) => onSelect(current.current === start ? null : start), [onSelect])
  const selectedSegment = selectedIndex === null ? -1
    : result.segments.findIndex(segment => selectedIndex >= segment.start && selectedIndex < segment.end)
  return (
    <div className="tkp-stream">
      <div className="tkp-stream-content" data-selecting={selectedIndex !== null}>
        {items.map((item, index) => <Segment key={item.start} item={item} selected={index === selectedSegment} onToggle={toggle} />)}
      </div>
    </div>
  )
}

const Segment = memo(function Segment({ item, selected, onToggle }: { item: StreamItem; selected: boolean; onToggle(start: number): void }) {
  return (
    <button type="button" className="tkp-segment" data-tone={item.tone} aria-pressed={selected} aria-label={item.label}
      onClick={() => onToggle(item.start)}>
      {item.roleTone !== null ? <span className="tkp-role-bar" data-tone={item.roleTone} /> : null}
      <span>{item.text}</span>
    </button>
  )
})

type Row = {
  index: number
  id: number
  piece: string | null
  decoded: string
  role: ChatTokenRole | null
  special: string | null
  colorIndex: number
}

// Native TokenizerTokenTableView.makeRows: decoded text is the containing segment's, coloured by segment.
function tableRows(result: Tokenization): Row[] {
  const rows: Row[] = []
  let segment = 0
  for (let index = 0; index < result.ids.length; index += 1) {
    while (segment + 1 < result.segments.length && !(index >= result.segments[segment].start && index < result.segments[segment].end)) {
      segment += 1
    }
    const flag = result.flags[index]
    rows.push({
      index,
      id: result.ids[index],
      piece: result.pieces[index] ?? null,
      decoded: result.segments[segment]?.text ?? '',
      role: result.roles?.[index] ?? null,
      special: flag?.isSpecial ? flag.specialName : null,
      colorIndex: segment,
    })
  }
  return rows
}

const columns: Array<[string, number]> = [
  ['#', 52], ['ID', 86], ['Token Piece', 152], ['Decoded', 220], ['Role', 96], ['Special', 112], ['Mapping', 112],
]

// Native TokenizerTokenTableView: 30 pt rows rendered lazily, 850 pt minimum width, copy actions on right-click.
export function TokenTable({ result, visible, selectedIndex, onSelect }: {
  result: Tokenization
  visible(text: string): string
  selectedIndex: number | null
  onSelect(index: number | null): void
}) {
  const rows = useMemo(() => tableRows(result), [result])
  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 600 })
  const [menu, setMenu] = useState<{ x: number; y: number; items: Array<[string, string]> } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null) return
    const observer = new ResizeObserver(() => setView(current => ({ ...current, height: element.clientHeight })))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const first = Math.max(0, Math.floor(view.top / rowHeight) - 10)
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / rowHeight) + 10)
  return (
    <div className="token-table" ref={scroller} role="table" aria-label={t('tkpTableAria', { count: formatNumber(rows.length) })}
      aria-rowcount={rows.length + 1} onScroll={event => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <div className="token-table-body" style={{ height: 29 + rows.length * rowHeight }}>
        <div className="token-table-header" role="row">
          {columns.map(([title, width]) => <span role="columnheader" key={title} style={{ width }}>{title}</span>)}
        </div>
        <div style={{ transform: `translateY(${first * rowHeight}px)` }}>
          {rows.slice(first, last).map(row => {
            const selected = selectedIndex === row.index
            const cells = [
              formatNumber(row.id), visible(row.piece ?? '—'), visible(row.decoded), row.role === null ? '—' : roleTitle(row.role),
              row.special ?? '—', result.mapping,
            ]
            return (
              <div key={row.index} role="row" tabIndex={0} aria-rowindex={row.index + 2} aria-selected={selected}
                className={`token-table-row ${selected ? 'selected' : ''}`}
                aria-label={t('tkpRowAria', {
                  index: formatNumber(row.index), id: formatNumber(row.id), piece: visible(row.piece ?? t('tkpNone')), decoded: visible(row.decoded),
                  role: row.role === null ? t('tkpNone') : roleTitle(row.role), special: row.special ?? t('tkpNone'), mapping: result.mapping,
                })}
                onClick={() => onSelect(selected ? null : row.index)}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(selected ? null : row.index)
                }}
                onContextMenu={event => {
                  event.preventDefault()
                  setMenu({
                    x: event.clientX, y: event.clientY, items: [
                      // ponytail: native copies the grouped ID ("1,234"); the plain value is what a user pastes.
                      [t('tkpCopyId'), String(row.id)],
                      ...(row.piece === null ? [] : [[t('tkpCopyPiece'), row.piece] as [string, string]]),
                      [t('tkpCopyDecoded'), row.decoded],
                    ],
                  })
                }}>
                <span role="cell" style={{ width: 52 }}><i className="token-swatch" data-tone={row.colorIndex % 10} />{formatNumber(row.index)}</span>
                {cells.map((text, column) => (
                  <span role="cell" key={column} style={{ width: columns[column + 1][1] }} title={text}>{text}</span>
                ))}
              </div>
            )
          })}
        </div>
      </div>
      {menu !== null ? <CopyMenu menu={menu} onClose={closeMenu} /> : null}
    </div>
  )
}

// Right-click copy actions, closed by any outside press or Escape.
function CopyMenu({ menu, onClose }: { menu: { x: number; y: number; items: Array<[string, string]> }; onClose(): void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onClose)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', onClose)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  return createPortal(
    <div className="file-context-menu" role="menu" style={{
      left: Math.max(8, Math.min(menu.x, window.innerWidth - 216)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 120)),
    }}>
      {menu.items.map(([label, text]) => (
        <button key={label} type="button" role="menuitem" onPointerDown={event => event.stopPropagation()}
          onClick={() => { copy(text); onClose() }}>{label}</button>
      ))}
    </div>,
    document.body,
  )
}

function containingSegment(result: Tokenization, index: number) {
  return result.segments.find(segment => index >= segment.start && index < segment.end)
}

// Native TokenIDChipsView.
function TokenIdChips({ result, selectedIndex, onSelect, visible }: {
  result: Tokenization
  selectedIndex: number | null
  onSelect(index: number | null): void
  visible(text: string): string
}) {
  return (
    <div className="token-id-chips" data-selecting={selectedIndex !== null}>
      {result.ids.map((id, index) => (
        <button type="button" key={index} aria-pressed={selectedIndex === index}
          aria-label={t('tkpChipAria', {
            index: formatNumber(index), id: formatNumber(id), text: visible(result.pieces[index] ?? containingSegment(result, index)?.text ?? t('tkpNone')),
          })}
          onClick={() => onSelect(selectedIndex === index ? null : index)}>{formatNumber(id)}</button>
      ))}
    </div>
  )
}

function SelectedToken({ result, index, visible }: { result: Tokenization; index: number; visible(text: string): string }) {
  const piece = result.pieces[index]
  const role = result.roles?.[index] ?? null
  const flag = result.flags[index]
  const rows: Array<[string, string]> = [
    [t('tkpIndex'), formatNumber(index)],
    ['ID', formatNumber(result.ids[index])],
    ...(piece == null ? [] : [['Token Piece', visible(piece)] as [string, string]]),
    [t('tkpDecodedFragment'), visible(containingSegment(result, index)?.text ?? '')],
    ...(result.roles === null ? [] : [[t('tkpRole'), role === null ? '—' : roleTitle(role)] as [string, string]]),
    ...(flag?.isSpecial ? [['Special', flag.specialName ?? '—'] as [string, string]] : []),
  ]
  return (
    <section className="inspector-section">
      <h2>{t('appInspectorSelectedToken')}</h2>
      <dl className="inspector-facts">
        {rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
      </dl>
      <button type="button" className="inspector-button" onClick={() => copy(String(result.ids[index]))}>{t('tkpCopyId')}</button>
    </section>
  )
}

function ComparisonMenu({ snapshot, open, onOpen, onClose, showWhitespace, setShowWhitespace }: {
  snapshot: RepositorySnapshot
  open: boolean
  onOpen(source: ComparisonSource | null): void
  onClose(): void
  showWhitespace: boolean
  setShowWhitespace?(value: boolean): void
}) {
  const [shown, setShown] = useState<'menu' | 'repository' | null>(null)
  const [sourceMode, setSourceMode] = useState<SourceMode>('huggingface')
  const [input, setInput] = useState('')
  const anchor = useRef<HTMLDivElement>(null)
  const floating = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ top: number; right: number; maxWidth: number; anchorTop: number }>({ top: 0, right: 0, maxWidth: 0, anchorTop: 0 })
  // Flip above the button (or clamp) when the floating box would run past the bottom of the viewport.
  useLayoutEffect(() => {
    const height = floating.current?.offsetHeight
    if (height === undefined || place.top + height <= window.innerHeight - 8) return
    const above = place.anchorTop - 4 - height
    const top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - height)
    if (top !== place.top) setPlace({ ...place, top })
  }, [shown, place])
  useEffect(() => {
    if (shown === null) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (!anchor.current?.contains(target) && !floating.current?.contains(target)) setShown(null)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setShown(null) }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', key)
    }
  }, [shown])
  if (open) {
    return (
      <div className="tkp-result-controls">
        <WhitespaceToggle value={showWhitespace} onChange={setShowWhitespace} />
        <button type="button" onClick={onClose}>{t('tkpCloseComparison')}</button>
      </div>
    )
  }
  const files = entryFiles(snapshot)
  if (files.length === 0) return null
  const choose = (source: ComparisonSource) => {
    setShown(null)
    onOpen(source)
  }
  // Portalled with fixed placement so the panel's clipping never cuts the menu or the popover.
  const show = (next: 'menu' | 'repository' | null) => {
    const rect = anchor.current?.getBoundingClientRect()
    if (rect !== undefined) {
      // Right-aligned to the button, shifted left only as far as the viewport needs.
      const width = Math.min(next === 'repository' ? 352 : 220, window.innerWidth - 16)
      const right = Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - width - 8))
      setPlace({ top: rect.bottom + 4, right, maxWidth: window.innerWidth - right - 8, anchorTop: rect.top })
    }
    setShown(next)
  }
  return (
    <div className="tkp-menu-anchor" ref={anchor}>
      <button type="button" className="tkp-menu-button" aria-haspopup="menu" aria-expanded={shown === 'menu'}
        onClick={() => show(shown === 'menu' ? null : 'menu')}>{t('tkpComparison')}</button>
      {shown !== null ? createPortal(<div ref={floating} className="tkp-floating"
        style={{ top: place.top, right: place.right, maxWidth: place.maxWidth }}>
      {shown === 'menu' ? (
        <div className="tkp-menu-items" role="menu" aria-label={t('tkpComparison')}>
          {files.map(entry => (
            <button type="button" role="menuitem" key={entry.path} onClick={() => choose({ kind: 'path', path: entry.path })}>{entry.path}</button>
          ))}
          <hr />
          <button type="button" role="menuitem" onClick={() => show('repository')}>{t('tkpOtherRepositoryMenu')}</button>
        </div>
      ) : null}
      {shown === 'repository' ? (
        <form className="tkp-popover" aria-label={t('tkpOtherRepository')} onSubmit={event => {
          event.preventDefault()
          if (input.trim() === '') return
          choose({ kind: 'repository', input: input.trim(), mode: sourceMode })
        }}>
          <h3>{t('tkpOtherRepository')}</h3>
          {/* Web extras kept per D-9: the HTTPS sources and a second local directory. */}
          <SourceSelect value={sourceMode} onChange={setSourceMode} />
          <input value={input} autoFocus autoComplete="off" aria-label={t('tkpOtherRepository')}
            placeholder={sourceMode === 'huggingface' ? t('appRepositoryPlaceholder') : 'https://…'}
            onChange={event => setInput(event.target.value)} />
          <label className="comparison-directory-label">
            <span>{t('comparisonSecondLocalDirectoryLabel')}</span>
            <input type="file" multiple {...{ webkitdirectory: '' }} onChange={event => {
              const selection = event.currentTarget.files
              if (selection !== null && selection.length > 0) choose({ kind: 'local', files: [...selection] })
            }} />
          </label>
          <div className="tkp-popover-actions">
            <button type="submit" className="primary-button" disabled={input.trim() === ''}>{t('tkpLoadComparison')}</button>
          </div>
        </form>
      ) : null}
      </div>, document.body) : null}
    </div>
  )
}

// Native ModelFilesStore.setComparisonSource/updateComparison: a second tokenizer that follows the primary result.
function useComparison(
  snapshot: RepositorySnapshot,
  file: RepositoryFile,
  primaryReady: boolean,
  left: Tokenization | null,
  chatSeed: { current: ChatSeed | null },
) {
  const [source, setSource] = useState<ComparisonSource | null>(null)
  const [load, setLoad] = useState<ComparisonLoad | null>(null)
  const [run, setRun] = useState<RightRun>({ status: 'ready', right: null, message: '' })
  const session = useRef<TokenizerSession | null>(null)
  const renderClient = useRef<TemplateRenderClient | null>(null)
  useEffect(() => {
    renderClient.current = new TemplateRenderClient()
    return () => renderClient.current?.dispose()
  }, [])
  const primaryReadyRef = useRef(primaryReady)
  primaryReadyRef.current = primaryReady

  useEffect(() => {
    if (source === null) { setLoad(null); return }
    const controller = new AbortController()
    const signal = controller.signal
    const rightSession = createComparisonTokenizerSession()
    session.current = rightSession
    const initialTitle = source.kind === 'path' ? source.path : source.kind === 'repository' ? `${source.input} · tokenizer.json` : ''
    const base: ComparisonLoad = {
      source, title: initialTitle, status: 'loading', message: '', target: null, catalog: null, vocabulary: null,
    }
    setLoad(base)
    void (async () => {
      let vocabulary: Vocabulary | null = null
      let title = initialTitle
      try {
        let target: RepositorySnapshot
        let entry: RepositoryFile | undefined
        if (source.kind === 'path') {
          target = snapshot
          entry = entryFiles(snapshot).find(candidate => candidate.path === source.path)
          if (entry === undefined) throw new Error(t('tokenizerComparisonMissingEntry', { path: source.path }))
        } else {
          target = source.kind === 'local' ? loadLocalDirectory(source.files)
            : source.mode === 'huggingface' ? await loadRepository(source.input, signal)
            : await loadHttpsSource(source.input, source.mode, signal)
          entry = comparisonEntry(target)
          if (entry === undefined) throw new Error(t('cmpNoEntry'))
          title = `${snapshotName(target)} · ${entry.path}`
        }
        const config = companion(target, entry, 'tokenizer_config.json')
        const templateFile = companion(target, entry, 'chat_template.jinja')
        const structure = await rightSession.inspectTokenizer(target, entry, config, signal)
        const template = templateFile === undefined ? null : decodeUtf8Text(await readWholeFile(target, templateFile, signal), t('chatTemplateJinjaNotUtf8'))
        if (isSentencePieceFile(file) || isSentencePieceFile(entry)) vocabulary = { skipped: t('cmpSkipSentencePiece') }
        // Native ModelFilesStore:477: a primary without a loaded bundle skips the diff, it does not wait.
        else if (!primaryReadyRef.current) vocabulary = { skipped: t('cmpSkipPrimaryNotReady') }
        else {
          try {
            vocabulary = { counts: await rightSession.prepareVocabularyDiff(target, entry, config, snapshot, file, signal) }
          } catch (failure) {
            if (signal.aborted) return
            vocabulary = { skipped: t('cmpSkipUnparseable') }
          }
        }
        if (signal.aborted) return
        setLoad({
          ...base, title, status: 'ready', target: { snapshot: target, file: entry, config }, vocabulary,
          catalog: selectChatTemplate(mergeChatTemplates(structure.chatTemplates, template)),
        })
      } catch (failure) {
        if (!signal.aborted) setLoad({ ...base, title, status: 'failed', message: errorMessage(failure), vocabulary })
      }
    })()
    return () => {
      controller.abort()
      rightSession.dispose()
      if (session.current === rightSession) session.current = null
    }
  }, [source])

  useEffect(() => {
    const target = load?.target
    const rightSession = session.current
    if (load?.status !== 'ready' || target == null || rightSession === null) return
    if (left === null) { setRun({ status: 'ready', right: null, message: '' }); return }
    const controller = new AbortController()
    setRun({ status: 'loading', right: null, message: '' })
    const seed = chatSeed.current
    void (async () => {
      try {
        let right: Tokenization
        if (left.direction === 'decode') {
          right = await rightSession.decodeTokenIdArray(target.snapshot, target.file, target.config, left.ids, left.input, controller.signal)
        } else if (seed === null) {
          right = await rightSession.tokenize(target.snapshot, target.file, target.config, left.input, controller.signal)
        } else {
          const template = load.catalog === null ? null : activeChatTemplate(load.catalog)
          if (template === null) throw new Error(t('cmpMissingTemplate'))
          // Native renders the comparison template first so a template error reads as one, not as a tokenizer error.
          const outcome = await renderClient.current?.render(template.body, seed.context)
          if (outcome == null || controller.signal.aborted) return
          if (outcome.error !== null) throw new Error(t('cmpRenderFailed', { message: outcome.error }))
          right = await rightSession.chatTokenize(target.snapshot, target.file, target.config, template.body, seed.context,
            seed.attribution, controller.signal)
        }
        if (!controller.signal.aborted) setRun({ status: 'ready', right, message: '' })
      } catch (failure) {
        if (!controller.signal.aborted) setRun({ status: 'failed', right: null, message: errorMessage(failure) })
      }
    })()
    return () => controller.abort()
  }, [load, left])

  return {
    load,
    run,
    session: session.current,
    open(next: ComparisonSource | null) { setSource(next) },
    selectTemplate(id: string) {
      setLoad(current => current?.catalog == null ? current : { ...current, catalog: selectChatTemplate(current.catalog, id) })
    },
  }
}

// Native TokenizerComparisonView.
function ComparisonView({ load, run, left, showWhitespace, session, onSelectTemplate }: {
  load: ComparisonLoad
  run: RightRun
  left: Tokenization | null
  showWhitespace: boolean
  session: TokenizerSession | null
  onSelectTemplate(id: string): void
}) {
  const visible = (text: string) => visibleTokenizerText(text, showWhitespace)
  const [leftSelected, setLeftSelected] = useState<number | null>(null)
  const [rightSelected, setRightSelected] = useState<number | null>(null)
  // Native keeps the diff side and query on the comparison view; they reset only for a new right-hand target.
  const [primaryOnly, setPrimaryOnly] = useState(true)
  const [query, setQuery] = useState('')
  useEffect(() => { setLeftSelected(null); setRightSelected(null) }, [left, run.right])
  if (load.status === 'loading' || (load.status === 'ready' && run.status === 'loading')) {
    return <StateView title={t('cmpLoading')} progress />
  }
  if (load.status === 'failed' || run.status === 'failed') {
    return <StateView title={load.status === 'failed' ? load.message : run.message} icon="⊗" />
  }
  const right = run.right
  const summary = left !== null && right !== null ? compareTokenizerTokenizations(left, right) : null
  const active = load.catalog === null ? null : activeChatTemplate(load.catalog)
  const templateControl = left?.overhead != null && load.catalog !== null && active !== null ? (
    load.catalog.entries.length > 1 ? (
      <select className="tkp-badge" aria-label="Chat Template" value={active.id} onChange={event => onSelectTemplate(event.target.value)}>
        {load.catalog.entries.map(entry => <option key={entry.id} value={entry.id} disabled={!entry.usable}>{templateLabel(entry)}</option>)}
      </select>
    ) : <span className="tkp-badge">{templateLabel(active)}</span>
  ) : null
  return (
    <div className="tkp-comparison">
      {summary !== null && left !== null && right !== null ? (
        <>
          <div className="tkp-card tkp-summary" aria-label={t('tkpComparison')}>
            <p className="tkp-summary-counts">
              <span>{t('cmpLeftCount', { count: formatNumber(summary.leftCount) })}</span>
              <span>{t('cmpRightCount', { count: formatNumber(summary.rightCount) })}</span>
              <span>{t('cmpDelta', { delta: summary.countDelta > 0 ? `+${formatNumber(summary.countDelta)}` : formatNumber(summary.countDelta) })}</span>
              <span>{summary.idsMatch ? t('cmpIdsSame') : t('cmpIdsDifferent')}</span>
            </p>
            <p>{summary.firstDifference === null ? t('cmpFirstDifferenceNone') : t('cmpFirstDifference', {
              index: formatNumber(summary.firstDifference.index),
              left: summary.firstDifference.leftId ?? '—',
              right: summary.firstDifference.rightId ?? '—',
            })}</p>
            {left.overhead !== null && right.overhead !== null ? (
              <p>{t('cmpOverhead', { left: overheadText(left.overhead.templateCount), right: overheadText(right.overhead.templateCount) })}</p>
            ) : null}
          </div>
          <div className="tkp-comparison-columns">
            <section aria-label={t('cmpPrimary')}>
              <h3>{t('cmpPrimary')}</h3>
              <TokenTable result={left} visible={visible} selectedIndex={leftSelected} onSelect={setLeftSelected} />
            </section>
            <section aria-label={load.title}>
              <h3>{load.title}{templateControl}</h3>
              <TokenTable result={right} visible={visible} selectedIndex={rightSelected} onSelect={setRightSelected} />
            </section>
          </div>
        </>
      ) : <p className="tkp-placeholder">{t('cmpEmpty')}</p>}
      {load.vocabulary !== null ? <VocabularyDiff vocabulary={load.vocabulary} session={session} primaryOnly={primaryOnly}
        setPrimaryOnly={setPrimaryOnly} query={query} setQuery={setQuery} /> : null}
    </div>
  )
}

function VocabularyDiff({ vocabulary, session, primaryOnly, setPrimaryOnly, query, setQuery }: {
  vocabulary: Vocabulary
  session: TokenizerSession | null
  primaryOnly: boolean
  setPrimaryOnly(value: boolean): void
  query: string
  setQuery(value: string): void
}) {
  const [pieces, setPieces] = useState<string[]>([])
  const counts = 'counts' in vocabulary ? vocabulary.counts : null
  useEffect(() => {
    if (counts === null || session === null) return
    const controller = new AbortController()
    session.searchVocabularyDiff(primaryOnly ? 'leftOnly' : 'rightOnly', query, controller.signal)
      .then(found => { if (!controller.signal.aborted) setPieces(found.pieces.slice(0, 1000)) })
      .catch(() => { if (!controller.signal.aborted) setPieces([]) })
    return () => controller.abort()
  }, [counts, session, primaryOnly, query])
  if (counts === null) {
    return (
      <div className="tkp-card tkp-vocabulary">
        <h3>{t('cmpVocabulary')}</h3>
        <p className="tkp-note">ⓘ {'skipped' in vocabulary ? vocabulary.skipped : ''}</p>
      </div>
    )
  }
  return (
    <div className="tkp-card tkp-vocabulary">
      <h3>{t('cmpVocabulary')}</h3>
      <p className="tkp-summary-counts">
        <span>{t('cmpPrimaryOnlyCount', { count: formatNumber(counts.leftOnlyCount) })}</span>
        <span>{t('cmpComparisonOnlyCount', { count: formatNumber(counts.rightOnlyCount) })}</span>
        <span>{t('cmpSharedCount', { count: formatNumber(counts.sharedCount) })}</span>
      </p>
      <div className="tkp-segmented" role="group" aria-label={t('cmpDiffSide')}>
        <button type="button" aria-pressed={primaryOnly} onClick={() => setPrimaryOnly(true)}>{t('cmpPrimaryOnly')}</button>
        <button type="button" aria-pressed={!primaryOnly} onClick={() => setPrimaryOnly(false)}>{t('cmpComparisonOnly')}</button>
      </div>
      <input className="tkp-search" value={query} placeholder={t('cmpSearch')} aria-label={t('cmpSearch')}
        onChange={event => setQuery(event.target.value)} />
      <p className="tkp-note">{t('cmpShowing', { count: formatNumber(pieces.length), limit: formatNumber(1000) })}</p>
      <ul className="tkp-vocabulary-list">
        {pieces.map((piece, index) => <li key={index}>{piece === '' ? t('cmpEmptyToken') : piece}</li>)}
      </ul>
    </div>
  )
}

// Native DetailView.TokenizerJSONView summary (DV:1192-1293): the tokenizer.json overview.
export function TokenizerOverview({ snapshot, file }: { snapshot: RepositorySnapshot; file: RepositoryFile }) {
  const config = companion(snapshot, file, 'tokenizer_config.json')
  const [structure, setStructure] = useState<TokenizerStructure | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setStructure(null)
    setError(null)
    mainTokenizerSession.inspectTokenizer(snapshot, file, config, controller.signal).then(next => {
      if (!controller.signal.aborted) setStructure(next)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(errorMessage(failure))
    })
    return () => controller.abort()
  }, [snapshot, file, config])
  if (error !== null) return <div className="reader-summary"><p className="tjv-error" role="alert">⚠︎ {error}</p></div>
  if (structure === null) {
    return <div className="reader-summary"><p className="tjv-progress" role="status"><span className="spinner" />{t('tjvParsing')}</p></div>
  }
  const rows = ([
    [t('tjvVersion'), structure.version],
    [t('tjvModelType'), structure.modelType],
    [t('tjvVocabEntries'), structure.vocabCount === null ? null : formatNumber(structure.vocabCount)],
    [t('tjvMerges'), structure.mergeCount === null ? null : formatNumber(structure.mergeCount)],
    [t('tjvAddedTokens'), structure.addedTokenCount === null ? null : formatNumber(structure.addedTokenCount)],
  ] as Array<[string, string | null]>).filter((row): row is [string, string] => row[1] !== null)
  const special = structure.addedTokens.filter(token => token.special)
  return (
    <div className="reader-summary tjv">
      <header className="reader-title">
        <h2>{structure.modelType ?? 'Tokenizer'}</h2>
        <p>{t('tjvSubtitle')}</p>
      </header>
      {rows.length > 0 ? (
        <section className="property-group">
          <h3>{t('tjvStructure')}</h3>
          <dl>{rows.map(([key, value]) => <div className="key-value-row" key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
        </section>
      ) : null}
      {special.length > 0 ? (
        <section className="tjv-card" aria-label="Special added_tokens">
          <h3>Special added_tokens</h3>
          <ul className="tjv-pairs">
            {special.map((token, index) => (
              <li key={index}><span>{token.content === '' ? t('cmpEmptyToken') : token.content}</span>
                {token.id === null ? null : <span>{formatNumber(token.id)}</span>}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {structure.vocabulary !== null
        ? <VocabularyAnalysis analysis={structure.vocabulary} addedTokenCount={structure.addedTokenCount} />
        : structure.vocabCount !== null
          ? <p className="tjv-note">{structure.vocabCount === 0 ? t('tjvVocabEmpty') : t('tjvVocabUnsupported')}</p> : null}
      <VocabularySearch snapshot={snapshot} file={file} config={config} />
      <p className="tjv-note">{t('tjvFooter')}</p>
    </div>
  )
}

// Native vocabularySearch: the index is built on the first nonempty query; at most 1,000 matches.
function VocabularySearch({ snapshot, file, config }: {
  snapshot: RepositorySnapshot
  file: RepositoryFile
  config: RepositoryFile | undefined
}) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<{ status: 'idle' | 'preparing' | 'ready' | 'error'; matches: TokenizerVocabularyEntry[] }>(
    { status: 'idle', matches: [] })
  const term = query.trim()
  useEffect(() => {
    if (term === '') return
    const controller = new AbortController()
    setState(current => current.status === 'ready' ? current : { status: 'preparing', matches: [] })
    searchTokenizerVocabulary(snapshot, file, config, term, controller.signal).then(matches => {
      if (!controller.signal.aborted) setState({ status: 'ready', matches: matches.slice(0, 1000) })
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error', matches: [] })
    })
    return () => controller.abort()
  }, [snapshot, file, config, term])
  return (
    <section className="tjv-card" aria-label={t('tjvSearchTitle')}>
      <header className="reader-title">
        <h2>{t('tjvSearchTitle')}</h2>
        <p>{t('tjvSearchSubtitle')}</p>
      </header>
      <input className="vocab-search" value={query} placeholder={t('tjvSearchPlaceholder')} aria-label={t('tjvSearchPlaceholder')}
        onChange={event => setQuery(event.target.value)} />
      {state.status === 'preparing' ? <p className="tjv-progress" role="status"><span className="spinner" />{t('tjvSearchPreparing')}</p>
        : state.status === 'error' ? <p className="tjv-note">{t('tjvSearchUnsupported')}</p>
        : term === '' ? <p className="tjv-note">{t('tjvSearchPrompt')}</p>
        : (
          <>
            <p className="tjv-caption">{t('tjvSearchCount', { count: formatNumber(state.matches.length) })}</p>
            <ul className="tjv-pairs" aria-label={t('tjvSearchTitle')}>
              {state.matches.map(entry => (
                <li key={entry.tokenId}>
                  <span>{entry.token === '' ? t('cmpEmptyToken') : entry.token}</span><span>{formatNumber(entry.tokenId)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
    </section>
  )
}

// Native TokenizerVocabularyAnalysisView.visible: names for invisible pieces, long runs collapsed to "x × N".
export function readablePiece(token: string): string {
  if (token === '') return t('tjvEmptyToken')
  const scalars = [...token]
  if (scalars.length > 8 && scalars.every(scalar => scalar === scalars[0])) return `${readableScalar(scalars[0])} × ${scalars.length}`
  return scalars.map(readableScalar).join('')
}

function readableScalar(scalar: string): string {
  if (scalar === '\t') return 'Tab'
  if (scalar === '\n') return t('tjvNewline')
  if (scalar === '\r') return t('tjvReturn')
  if (scalar === ' ') return t('tjvSpace')
  // Foundation's CharacterSet.controlCharacters is Cc plus Cf.
  return /^[\p{Cc}\p{Cf}]$/u.test(scalar) ? `\\u{${scalar.codePointAt(0)!.toString(16).toUpperCase()}}` : scalar
}

function VocabularyAnalysis({ analysis, addedTokenCount }: { analysis: TokenizerVocabularyAnalysis; addedTokenCount: number | null }) {
  const [showsTop50, setShowsTop50] = useState(false)
  const [bucketLabel, setBucketLabel] = useState<string | null>(null)
  const [tokenId, setTokenId] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: Array<[string, string]> } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  // Native max(by:) keeps the first of equal maxima.
  const largest = analysis.buckets.reduce<TokenizerVocabularyAnalysis['buckets'][number] | undefined>(
    (best, bucket) => best === undefined || bucket.count > best.count ? bucket : best, undefined)
  const bucket = analysis.buckets.find(candidate => candidate.label === bucketLabel) ?? largest
  const token = analysis.longestTokens.find(entry => entry.tokenId === tokenId) ?? analysis.longestTokens[0]
  const maximum = Math.max(1, ...analysis.buckets.map(candidate => candidate.count))
  const percent = (count: number) => `${(count / analysis.tokenCount * 100).toFixed(2)}%`
  const utf8 = (text: string) => new TextEncoder().encode(text).byteLength
  const metrics: Array<[string, string]> = [
    [t('tjvAverage'), formatNumber(analysis.averageScalarLength, { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
    ['P50', formatNumber(analysis.p50ScalarLength)], ['P90', formatNumber(analysis.p90ScalarLength)],
    ['P95', formatNumber(analysis.p95ScalarLength)], ['P99', formatNumber(analysis.p99ScalarLength)],
    [t('tjvLongest'), formatNumber(analysis.maximumScalarLength)],
  ]
  return (
    <section className="tjv-analysis" aria-label={t('tjvLengthTitle')}>
      <header className="tjv-analysis-header">
        <div>
          <h3>{t('tjvLengthTitle')}</h3>
          <p>{t('tjvLengthSubtitle', { count: formatNumber(analysis.tokenCount) })}</p>
        </div>
        <span className="tjv-pill emphasized">Base vocab</span>
        {addedTokenCount === null ? null : <span className="tjv-pill">Added Token · {formatNumber(addedTokenCount)}</span>}
      </header>
      <dl className="tjv-metrics">
        {metrics.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
      </dl>
      <div className="tjv-split">
        {bucket !== undefined ? (
          <section className="tjv-card tjv-distribution">
            <h3>{t('tjvDistribution')}</h3>
            <div className="tjv-bars">
              {analysis.buckets.map(candidate => (
                <button key={candidate.label} type="button" aria-pressed={candidate.label === bucket.label}
                  aria-label={t('tjvBucketAria', { label: candidate.label, count: formatNumber(candidate.count), percent: percent(candidate.count) })}
                  onClick={() => setBucketLabel(candidate.label)}>
                  <span>{formatNumber(candidate.count)}</span>
                  <i style={{ height: Math.max(3, candidate.count / maximum * 92) }} />
                  <span>{candidate.label}</span>
                  <span className="tjv-muted">{percent(candidate.count)}</span>
                </button>
              ))}
            </div>
            <p className="tjv-caption">{t('tjvBucketSummary', { label: bucket.label, count: formatNumber(bucket.count), percent: percent(bucket.count) })}</p>
          </section>
        ) : null}
        <section className="tjv-card tjv-basis">
          <h3>{t('tjvBasis')}</h3>
          <p>{t('tjvBasisPieces')}</p>
          <p>{t('tjvBasisAdded')}</p>
        </section>
      </div>
      {token !== undefined ? (
        <section className="tjv-card tjv-longest" aria-label={t('tjvLongestTitle')}>
          <header>
            <h3>{t('tjvLongestTitle')}</h3>
            <span className="tjv-muted">{t('tjvLongestOrder')}</span>
            {analysis.longestTokens.length > 20 ? (
              <button type="button" onClick={() => setShowsTop50(!showsTop50)}>
                {showsTop50 ? t('tjvCollapse') : t('tjvExpand', { count: formatNumber(analysis.longestTokens.length) })}
              </button>
            ) : null}
          </header>
          <div className="tjv-longest-row tjv-longest-head" aria-hidden="true">
            <span>#</span><span>ID</span><span>Token Piece</span><span>{t('tjvScalars')}</span><span>UTF-8 bytes</span>
          </div>
          {analysis.longestTokens.slice(0, showsTop50 ? 50 : 20).map((entry, index) => (
            <button key={entry.tokenId} type="button" className="tjv-longest-row" aria-pressed={entry.tokenId === token.tokenId}
              aria-label={t('tjvRowAria', { rank: formatNumber(index + 1), id: formatNumber(entry.tokenId), piece: readablePiece(entry.token), count: formatNumber(entry.scalarLength) })}
              onClick={() => setTokenId(entry.tokenId)}
              onContextMenu={event => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, items: [[t('tkpCopyPiece'), entry.token]] })
              }}>
              <span>{formatNumber(index + 1)}</span><span>{formatNumber(entry.tokenId)}</span>
              <span title={entry.token}>{readablePiece(entry.token)}</span>
              <span>{formatNumber(entry.scalarLength)}</span><span>{formatNumber(utf8(entry.token))}</span>
            </button>
          ))}
          <div className="tjv-token-detail">
            <header><h4>Token #{token.tokenId}</h4><button type="button" onClick={() => copy(token.token)}>{t('tjvCopyRaw')}</button></header>
            <pre>{token.token === '' ? t('tjvEmptyString') : token.token}</pre>
            <p className="tjv-caption">
              {t('tjvTokenDetail', { piece: readablePiece(token.token), scalars: formatNumber(token.scalarLength), bytes: formatNumber(utf8(token.token)) })}
            </p>
          </div>
        </section>
      ) : null}
      {menu !== null ? <CopyMenu menu={menu} onClose={closeMenu} /> : null}
    </section>
  )
}
