import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CodeReader, FindBar, isFindShortcut } from './CodeReader.tsx'
import { jinjaRuns } from './core/jinjaHighlight.ts'
import { forEachTextMatch, navigateTextMatches } from './core/readers.ts'
import { outputTokenRanges, prettyPrintedJSON, renderedOutputItems, type OutputRange } from './core/renderedOutput.ts'
import {
  basicMessages, emptyTool, initialVariables, message, messageRoles, multimodalMessages, templateContext, templateValueKinds,
  toolMessages, variable, weatherTool, type TemplateMessage, type TemplateRequest, type TemplateTool, type TemplateValueKind,
  type TemplateVariable,
} from './core/templateRequest.ts'
import { formatNumber, translate as t } from './i18n.ts'
import { ResizeHandle } from './ResizeHandle.tsx'
import { TemplateRenderClient, type TemplateRenderOutcome } from './templateRender.ts'

type Run = { start: number; end: number; className: string }

// Find state for a read-only or editable text: ⌘F opens the bar, the query survives edits.
function useFind(content: string) {
  const [find, setFind] = useState({ open: false, query: '', current: 0 })
  const match = useMemo(
    () => navigateTextMatches(content, find.open ? find.query : '', 'next', Math.max(find.current, 1) - 1),
    [content, find],
  )
  const bar = find.open ? (
    <FindBar
      query={find.query}
      current={match.current}
      total={match.total}
      onQuery={query => setFind({ open: true, query, current: 0 })}
      onNavigate={navigation => setFind(state => ({
        ...state, current: navigateTextMatches(content, state.query, navigation, Math.max(state.current, 1)).current,
      }))}
      onClose={() => setFind({ open: false, query: '', current: 0 })}
    />
  ) : null
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isFindShortcut(event)) return
    event.preventDefault()
    setFind(state => state.open ? state : { open: true, query: '', current: 0 })
  }
  return { query: find.open ? find.query : '', open: find.open, match, bar, onKeyDown }
}

// Styled runs wrapped in find marks. Runs must cover the source; marks never change layout, only background.
function painted(source: string, runs: Run[], query: string, activeStart: number): ReactNode[] {
  const nodes: ReactNode[] = []
  let run = 0
  const pieces = (from: number, to: number) => {
    const result: ReactNode[] = []
    while (run < runs.length && runs[run].end <= from) run += 1
    for (let index = run; index < runs.length && runs[index].start < to; index += 1) {
      const start = Math.max(from, runs[index].start)
      const text = source.slice(start, Math.min(to, runs[index].end))
      result.push(runs[index].className === '' ? text : <span className={runs[index].className} key={start}>{text}</span>)
    }
    return result
  }
  let cursor = 0
  if (query !== '') {
    forEachTextMatch(source, query, start => {
      if (start < cursor) return
      nodes.push(...pieces(cursor, start))
      const current = start === activeStart
      nodes.push(
        <mark className={current ? 'find-match current' : 'find-match'} aria-current={current ? 'true' : undefined} key={`m${start}`}>
          {pieces(start, start + query.length)}
        </mark>,
      )
      cursor = start + query.length
    })
  }
  nodes.push(...pieces(cursor, source.length))
  return nodes
}

// Scrolls only `container`, never the page, so the element is visible (native scrollRangeToVisible).
function reveal(container: HTMLElement | null, selector: string) {
  const element = container?.querySelector(selector)
  if (container == null || element == null) return
  const box = container.getBoundingClientRect()
  const target = element.getBoundingClientRect()
  if (target.top < box.top) container.scrollTop -= box.top - target.top + 8
  else if (target.bottom > box.bottom) container.scrollTop += target.bottom - box.bottom + 8
}

// Native JinjaTextEditor: an editable wrapping text view highlighted in place. The web lays a transparent textarea
// over an identically laid out highlighted <pre>; the textarea scrolls (so the caret is always followed) and the
// <pre> mirrors its scroll position.
export function JinjaEditor({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) {
  const find = useFind(value)
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const highlight = useRef<HTMLPreElement | null>(null)
  const runs = useMemo(() => jinjaRuns(value).map(run => ({
    start: run.start, end: run.start + run.text.length, className: run.kind === null ? '' : `jinja-${run.kind}`,
  })), [value])
  const { match } = find
  useEffect(() => {
    const area = textarea.current
    if (!find.open || match.total === 0 || area === null) return
    area.setSelectionRange(match.start, match.end)
    const mark = highlight.current?.querySelector<HTMLElement>('mark.find-match.current')
    if (mark != null && (mark.offsetTop < area.scrollTop || mark.offsetTop + mark.offsetHeight > area.scrollTop + area.clientHeight)) {
      area.scrollTop = mark.offsetTop - area.clientHeight / 3
    }
    // Navigating moves the selection; typing with the bar open must not steal the caret.
  }, [find.open, find.query, match.current])
  useLayoutEffect(() => {
    if (highlight.current !== null && textarea.current !== null) highlight.current.scrollTop = textarea.current.scrollTop
  })
  return (
    <div className="jinja-editor" onKeyDown={find.onKeyDown}>
      {find.bar}
      <div className="jinja-editor-layers">
        <pre className="jinja-highlight" aria-hidden="true" ref={highlight}>
          {painted(value, runs, find.query, match.total === 0 ? -1 : match.start)}
          {/* A trailing newline needs a glyph after it to take up a line, as it does in the textarea. */}
          {value === '' || value.endsWith('\n') ? ' ' : null}
        </pre>
        <textarea aria-label={label} value={value} spellCheck={false} ref={textarea}
          onScroll={event => { if (highlight.current !== null) highlight.current.scrollTop = event.currentTarget.scrollTop }}
          onChange={event => onChange(event.target.value)} />
      </div>
    </div>
  )
}

const kindTitle = (kind: TemplateValueKind) => ({
  string: t('templateKindString'), integer: t('templateKindInteger'), decimal: t('templateKindDecimal'),
  boolean: t('templateKindBoolean'), json: 'JSON', null: 'null',
})[kind]

// Native TemplatePlaygroundView: live 220 ms debounced render of the shared template with structured inputs.
export function TemplatePlayground({ template, onTemplateChange, originalTemplate, tokenizerConfig }: {
  template: string
  onTemplateChange(value: string): void
  originalTemplate: string
  tokenizerConfig: Record<string, unknown>
}) {
  const [request, setRequest] = useState<TemplateRequest>(() => ({
    messages: basicMessages(),
    includeTools: false,
    tools: [weatherTool()],
    variables: initialVariables(originalTemplate, tokenizerConfig),
    addGenerationPrompt: true,
  }))
  const [result, setResult] = useState<TemplateRenderOutcome>({ output: '', error: null })
  const [rendering, setRendering] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [inputWidth, setInputWidth] = useState(310)
  // Null until dragged: template and preview split the height evenly, like a fresh VSplitView.
  const [previewHeight, setPreviewHeight] = useState<number | null>(null)
  const [structureWidth, setStructureWidth] = useState(220)
  const client = useRef<TemplateRenderClient | null>(null)
  const main = useRef<HTMLDivElement | null>(null)
  const preview = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const created = new TemplateRenderClient()
    client.current = created
    return () => created.dispose()
  }, [])

  useEffect(() => {
    setRendering(true)
    let cancelled = false
    const timer = window.setTimeout(async () => {
      let outcome: TemplateRenderOutcome | null
      try {
        outcome = await client.current?.render(template, templateContext(request)) ?? null
      } catch (failure) {
        outcome = { output: '', error: failure instanceof Error ? failure.message : String(failure) }
      }
      if (cancelled || outcome === null) return
      const items = renderedOutputItems(outcome.output)
      setResult(outcome)
      setSelectedId((items.find(item => prettyPrintedJSON(item, outcome.output) !== null) ?? items[0])?.id ?? null)
      setRendering(false)
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [template, request])

  const update = (change: Partial<TemplateRequest>) => setRequest(current => ({ ...current, ...change }))
  const presets = {
    basic: () => update({ messages: basicMessages(), includeTools: false, addGenerationPrompt: true }),
    tools: () => update({ messages: toolMessages(), tools: [weatherTool()], includeTools: true, addGenerationPrompt: true }),
    multimodal: () => update({ messages: multimodalMessages(), includeTools: false, addGenerationPrompt: true }),
  }
  const lineCount = template.split(/\r\n|[\n\r\u2028\u2029\u0085\v\f]/).filter(line => line !== '').length

  return (
    <div className="template-playground">
      <header className="playground-header">
        <h2><span className="playground-icon" aria-hidden="true">{'{}'}</span>{t('templateEmbeddedPlaygroundTitle')}</h2>
        <span className="playground-status" role="status">
          {rendering
            ? <><span className="spinner" aria-hidden="true" />{t('templateStatusRendering')}</>
            : result.error !== null
              ? <><span className="status-icon error" aria-hidden="true">✕</span>{t('templateStatusError')}</>
              : <><span className="status-icon ok" aria-hidden="true">✓</span>{t('templateStatusLive')}</>}
        </span>
        <select className="playground-menu" aria-label={t('templateLoadExample')} value=""
          onChange={event => presets[event.target.value as keyof typeof presets]?.()}>
          <option value="" disabled hidden>{t('templateLoadExample')}</option>
          <option value="basic">{t('templateExampleBasic')}</option>
          <option value="tools">{t('templateExampleTools')}</option>
          <option value="multimodal">{t('templateExampleMultimodal')}</option>
        </select>
        <button type="button" onClick={() => onTemplateChange(originalTemplate)}>{t('templateRestoreTemplate')}</button>
      </header>
      <div className="playground-body">
        <div className="playground-main" ref={main}>
          <section className="playground-pane playground-template">
            <PaneHeader title={t('templateTemplatePane')} detail={t('templateLines', { count: formatNumber(lineCount) })} />
            <JinjaEditor value={template} onChange={onTemplateChange} label={t('templateTemplatePane')} />
          </section>
          {/* ponytail: start and max are read from the last render's layout, which the first live render refreshes. */}
          <ResizeHandle axis="y" value={previewHeight ?? preview.current?.offsetHeight ?? 260} min={260}
            max={Math.max(260, (main.current?.clientHeight ?? 2000) - 227)} onChange={setPreviewHeight} />
          <section className="playground-pane playground-preview" ref={preview} style={previewHeight === null ? undefined : { height: previewHeight }}>
            <PreviewPane result={result} selectedId={selectedId} onSelect={setSelectedId}
              structureWidth={structureWidth} onStructureWidth={setStructureWidth} />
          </section>
        </div>
        <ResizeHandle axis="x" value={inputWidth} min={280} max={360} onChange={setInputWidth} />
        <div className="playground-inputs" style={{ width: inputWidth }}>
          <RequestEditor request={request} onChange={setRequest} />
        </div>
      </div>
    </div>
  )
}

function PaneHeader({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <header className="pane-header">
      <h3>{title}</h3>
      <span>{detail}</span>
      {children}
    </header>
  )
}

function PreviewPane({ result, selectedId, onSelect, structureWidth, onStructureWidth }: {
  result: TemplateRenderOutcome
  selectedId: number | null
  onSelect(id: number): void
  structureWidth: number
  onStructureWidth(width: number): void
}) {
  const { output, error } = result
  const items = useMemo(() => renderedOutputItems(output), [output])
  const selected = items.find(item => item.id === selectedId) ?? null
  const json = selected === null ? null : prettyPrintedJSON(selected, output)
  return (
    <>
      <PaneHeader title={t('templateOutputPane')}
        detail={error === null ? t('templateBytes', { count: formatNumber(new TextEncoder().encode(output).byteLength) }) : t('templateNotGenerated')}>
        <button type="button" className="pane-link" disabled={output === ''}
          onClick={() => void navigator.clipboard?.writeText(output).catch(() => undefined)}>
          <span aria-hidden="true">⧉</span> {t('templateCopyRaw')}
        </button>
      </PaneHeader>
      {error !== null ? (
        <div className="playground-error" role="alert"><span aria-hidden="true">⚠︎</span> {error}</div>
      ) : output === '' ? (
        <p className="playground-empty">{t('templateEmptyOutput')}</p>
      ) : (
        <div className="playground-preview-split">
          <aside className="output-structure" style={{ width: structureWidth }}>
            <h4>{t('templateStructureTitle')}</h4>
            {items.length === 0 ? <p className="output-structure-empty">{t('templateNoBoundaries')}</p> : (
              <ul aria-label={t('templateStructureTitle')}>
                {items.map(item => (
                  <li key={item.id}>
                    <button type="button" data-level={item.level} aria-pressed={item.id === selectedId} onClick={() => onSelect(item.id)}>
                      {item.level > 0 ? <span className="output-dot" aria-hidden="true" /> : null}
                      <span className="output-title">{item.title}</span>
                      {item.detail === null ? null : <span className="output-detail">{item.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {json !== null ? (
              <section className="content-inspector">
                <h4>{t('templateContentInspector')} <span>{t('templateContentInspectorNote')}</span></h4>
                <CodeReader content={json} language="json" label={t('templateContentInspector')} />
              </section>
            ) : null}
            <footer>{t('templateStructureFooter')}</footer>
          </aside>
          <ResizeHandle axis="x" before value={structureWidth} min={190} max={280} onChange={onStructureWidth} />
          <RawOutput output={output} highlighted={selected?.range ?? null} />
        </div>
      )}
    </>
  )
}

// Native RenderedOutputTextView: character-wrapped authoritative output, `<|…|>` tokens emphasised, the selected
// structure item's range highlighted and scrolled into view.
function RawOutput({ output, highlighted }: { output: string; highlighted: OutputRange | null }) {
  const find = useFind(output)
  const text = useRef<HTMLPreElement | null>(null)
  const runs = useMemo(() => {
    const classes: string[] = new Array(output.length).fill('')
    for (const range of outputTokenRanges(output)) classes.fill('output-token', range.start, range.end)
    if (highlighted !== null) {
      for (let index = highlighted.start; index < Math.min(highlighted.end, output.length); index += 1) {
        classes[index] = classes[index] === '' ? 'output-selected' : `${classes[index]} output-selected`
      }
    }
    const result: Run[] = []
    classes.forEach((className, index) => {
      const last = result.at(-1)
      if (last !== undefined && last.className === className) last.end = index + 1
      else result.push({ start: index, end: index + 1, className })
    })
    return result
  }, [output, highlighted])
  useEffect(() => reveal(text.current, '.output-selected'), [highlighted])
  useEffect(() => {
    if (find.open && find.match.total > 0) reveal(text.current, 'mark.find-match.current')
  }, [find.open, find.match])
  return (
    <section className="raw-output" onKeyDown={find.onKeyDown}>
      <h4>{t('templateRawTitle')} <span>{t('templateRawNote')}</span></h4>
      {find.bar}
      <pre tabIndex={0} ref={text} aria-label={t('templateRawTitle')}>
        {painted(output, runs, find.query, find.match.total === 0 ? -1 : find.match.start)}
      </pre>
    </section>
  )
}

// Native TemplateRequestEditor (detailed): run options, message cards, optional tools, typed variables.
// Native TemplateRequestEditor; compact is the tokenizer playground's form (message rows + 高级选项).
export function RequestEditor({ request, onChange, compact = false }: {
  request: TemplateRequest
  onChange(request: TemplateRequest): void
  compact?: boolean
}) {
  const set = (change: Partial<TemplateRequest>) => onChange({ ...request, ...change })
  const replace = <T extends { id: string }>(list: T[], item: T) => list.map(entry => entry.id === item.id ? item : entry)
  const tools = (
    <section>
      <label className="request-check">
        <input type="checkbox" checked={request.includeTools} onChange={event => set({ includeTools: event.target.checked })} />
        <h3>Tools</h3>
      </label>
      {request.includeTools ? (
        <>
          {request.tools.map(item => (
            <ToolCard key={item.id} tool={item}
              onChange={next => set({ tools: replace(request.tools, next) })}
              onDelete={() => set({ tools: request.tools.filter(entry => entry.id !== item.id) })} />
          ))}
          <button type="button" className="request-add" onClick={() => set({ tools: [...request.tools, emptyTool()] })}>＋ {t('templateAddTool')}</button>
        </>
      ) : null}
    </section>
  )
  const variables = (
    <section>
      <div className="request-heading">
        <h3>{t('templateOtherVariables')}</h3>
        <button type="button" onClick={() => set({ variables: [...request.variables, variable('custom_arg', 'string')] })}>＋ {t('templateAdd')}</button>
      </div>
      <p className="request-hint">{t('templateVariablesHint')}</p>
      {request.variables.map(item => (
        <VariableRow key={item.id} variable={item}
          onChange={next => set({ variables: replace(request.variables, next) })}
          onDelete={() => set({ variables: request.variables.filter(entry => entry.id !== item.id) })} />
      ))}
    </section>
  )
  if (compact) {
    const nextRole = request.messages.at(-1)?.role === 'user' ? 'assistant' : 'user'
    return (
      <div className="request-editor compact">
        <div className="compact-messages">
          {request.messages.map(item => (
            <div className="compact-message" key={item.id}>
              <select aria-label={t('templateMessageRole')} className="role-select" value={item.role}
                onChange={event => set({ messages: replace(request.messages, { ...item, role: event.target.value }) })}>
                {messageRoles.map(role => <option key={role} value={role}>{role}</option>)}
              </select>
              <textarea aria-label={t('templateMessageAria', { role: item.role })} className="request-text" spellCheck={false}
                value={item.content} onChange={event => set({ messages: replace(request.messages, { ...item, content: event.target.value }) })} />
              <button type="button" className="request-delete" aria-label={t('templateDeleteMessage')} title={t('templateDeleteMessage')}
                onClick={() => set({ messages: request.messages.filter(entry => entry.id !== item.id) })}>✕</button>
            </div>
          ))}
          <button type="button" className="compact-add" onClick={() => set({ messages: [...request.messages, message(nextRole, '')] })}>
            ＋ {t('templateAddMessage')}
          </button>
        </div>
        <details className="compact-advanced">
          <summary>{t('templateAdvancedOptions')}</summary>
          <label className="request-check mono">
            <input type="checkbox" checked={request.addGenerationPrompt} onChange={event => set({ addGenerationPrompt: event.target.checked })} />
            add_generation_prompt
          </label>
          {tools}
          {variables}
        </details>
      </div>
    )
  }
  return (
    <div className="request-editor">
      <section>
        <h3>{t('templateRunOptions')}</h3>
        <label className="request-check mono">
          <input type="checkbox" checked={request.addGenerationPrompt} onChange={event => set({ addGenerationPrompt: event.target.checked })} />
          add_generation_prompt
        </label>
      </section>
      <section>
        <div className="request-heading">
          <h3>Messages</h3>
          <button type="button" onClick={() => set({ messages: [...request.messages, message('user', '')] })}>＋ {t('templateAdd')}</button>
        </div>
        {request.messages.map(item => (
          <MessageCard key={item.id} message={item}
            onChange={next => set({ messages: replace(request.messages, next) })}
            onDelete={() => set({ messages: request.messages.filter(entry => entry.id !== item.id) })} />
        ))}
      </section>
      {tools}
      {variables}
    </div>
  )
}

function DeleteButton({ label, onClick }: { label: string; onClick(): void }) {
  return <button type="button" className="request-delete" aria-label={label} title={label} onClick={onClick}>🗑︎</button>
}

function MessageCard({ message: item, onChange, onDelete }: {
  message: TemplateMessage
  onChange(message: TemplateMessage): void
  onDelete(): void
}) {
  return (
    <div className="request-card">
      <div className="request-row">
        <select aria-label="Role" className="role-select" value={item.role} onChange={event => onChange({ ...item, role: event.target.value })}>
          {messageRoles.map(role => <option key={role} value={role}>{role}</option>)}
        </select>
        <select aria-label={t('templateContentKind')} className="kind-select" value={item.contentKind}
          onChange={event => onChange({ ...item, contentKind: event.target.value as TemplateMessage['contentKind'] })}>
          <option value="text">{t('templateContentText')}</option>
          <option value="json">JSON</option>
        </select>
        <DeleteButton label={t('templateDeleteMessage')} onClick={onDelete} />
      </div>
      <textarea aria-label={t('templateMessageAria', { role: item.role })} className="request-text" style={{ minHeight: 64 }}
        spellCheck={false} value={item.content} onChange={event => onChange({ ...item, content: event.target.value })} />
    </div>
  )
}

function ToolCard({ tool, onChange, onDelete }: { tool: TemplateTool; onChange(tool: TemplateTool): void; onDelete(): void }) {
  return (
    <div className="request-card">
      <div className="request-row">
        <input className="mono" aria-label={t('templateFunctionName')} placeholder={t('templateFunctionName')} value={tool.name}
          onChange={event => onChange({ ...tool, name: event.target.value })} />
        <DeleteButton label={t('templateDeleteTool')} onClick={onDelete} />
      </div>
      <input aria-label={t('templateDescription')} placeholder={t('templateDescription')} value={tool.description}
        onChange={event => onChange({ ...tool, description: event.target.value })} />
      <span className="request-hint">Parameters JSON</span>
      <textarea aria-label="Parameters JSON" className="request-text" style={{ minHeight: 130 }} spellCheck={false}
        value={tool.parametersJSON} onChange={event => onChange({ ...tool, parametersJSON: event.target.value })} />
    </div>
  )
}

function VariableRow({ variable: item, onChange, onDelete }: {
  variable: TemplateVariable
  onChange(variable: TemplateVariable): void
  onDelete(): void
}) {
  return (
    <div className="request-card variable">
      <div className="request-row">
        <input className="mono" aria-label={t('templateVariableName')} placeholder={t('templateVariableName')} value={item.name}
          onChange={event => onChange({ ...item, name: event.target.value })} />
        <select aria-label={t('templateType')} className="variable-kind" value={item.kind}
          onChange={event => onChange({ ...item, kind: event.target.value as TemplateValueKind })}>
          {templateValueKinds.map(kind => <option key={kind} value={kind}>{kindTitle(kind)}</option>)}
        </select>
        <DeleteButton label={t('templateDeleteVariable')} onClick={onDelete} />
      </div>
      {item.kind === 'boolean' ? (
        <label className="request-check">
          <input type="checkbox" checked={item.value !== 'false'} onChange={event => onChange({ ...item, value: event.target.checked ? 'true' : 'false' })} />
          {t('templateValue')}
        </label>
      ) : item.kind === 'null' ? (
        <span className="mono request-null">null</span>
      ) : item.kind === 'json' ? (
        <textarea aria-label={item.name} className="request-text" style={{ minHeight: 72 }} spellCheck={false}
          value={item.value} onChange={event => onChange({ ...item, value: event.target.value })} />
      ) : (
        <input aria-label={t('templateValue')} placeholder={t('templateValue')} value={item.value}
          onChange={event => onChange({ ...item, value: event.target.value })} />
      )}
    </div>
  )
}
