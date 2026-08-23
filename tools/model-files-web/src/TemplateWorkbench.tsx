import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatBytes, type RepositorySnapshot } from './core/huggingface.ts'
import { forEachTextMatch, navigateTextMatches } from './core/readers.ts'
import { formatNumber, translate as t } from './i18n.ts'
import { TextInspection } from './Readers.tsx'

type ConfigView = { path: string; content: string; parsed: unknown; bytesRead: number }

export function TemplateWorkbench({
  snapshot,
  filePath,
  sourceOrigin,
  initialSource,
  bytesRead,
  config,
}: {
  snapshot: RepositorySnapshot
  filePath: string
  sourceOrigin: string
  initialSource: string
  bytesRead: number
  config: ConfigView | null
}) {
  const [view, setView] = useState<'config' | 'overview' | 'source' | 'playground'>(config === null ? 'overview' : 'config')
  const [source, setSource] = useState(initialSource)
  const [preset, setPreset] = useState<keyof typeof presets>('basic')
  const [messages, setMessages] = useState(JSON.stringify(presets.basic.messages, null, 2))
  const [tools, setTools] = useState(JSON.stringify(presets.basic.tools, null, 2))
  const [variables, setVariables] = useState(JSON.stringify(presets.basic.variables, null, 2))
  const [addGenerationPrompt, setAddGenerationPrompt] = useState(true)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [outputView, setOutputView] = useState<'structure' | 'raw'>('structure')
  const [selectedLine, setSelectedLine] = useState(0)
  const [copyLabel, setCopyLabel] = useState(() => t('templateCopyOutputAction'))
  const [find, setFind] = useState({ open: false, query: '', current: 0 })
  const generation = useRef(0)
  const sourceRef = useRef<HTMLTextAreaElement | null>(null)
  const sourceBytes = new TextEncoder().encode(source).byteLength
  const outputLines = useMemo(() => output.split('\n'), [output])
  const activeMatch = useMemo(
    () => navigateTextMatches(source, find.open ? find.query : '', 'next', Math.max(find.current, 1) - 1),
    [find.current, find.open, find.query, source],
  )

  useEffect(() => {
    if (!find.open || activeMatch.total === 0) return
    sourceRef.current?.setSelectionRange(activeMatch.start, activeMatch.end)
  }, [activeMatch.end, activeMatch.start, activeMatch.total, find.open])

  function navigateFind(navigation: 'next' | 'previous') {
    setFind(state => ({
      ...state,
      current: navigateTextMatches(source, state.query, navigation, Math.max(state.current, 1)).current,
    }))
  }

  function changeSource(value: string) {
    generation.current += 1
    setSource(value)
    setFind(state => state.open
      ? { ...state, current: navigateTextMatches(value, state.query, 'next', Math.max(state.current, 1) - 1).current }
      : state)
    setOutput('')
    setError(null)
    setPhase('idle')
  }

  function choosePreset(value: keyof typeof presets) {
    const selected = presets[value]
    generation.current += 1
    setPreset(value)
    setMessages(JSON.stringify(selected.messages, null, 2))
    setTools(JSON.stringify(selected.tools, null, 2))
    setVariables(JSON.stringify(selected.variables, null, 2))
    setOutput('')
    setError(null)
    setPhase('idle')
  }

  function changePlaygroundInput(update: () => void) {
    generation.current += 1
    update()
    setOutput('')
    setError(null)
    setPhase('idle')
  }

  async function render() {
    const activeGeneration = ++generation.current
    setPhase('loading')
    setOutput('')
    setError(null)
    try {
      const parsedMessages: unknown = JSON.parse(messages)
      const parsedTools: unknown = JSON.parse(tools)
      const parsedVariables: unknown = JSON.parse(variables)
      if (!Array.isArray(parsedMessages)) throw new Error(t('messagesMustBeJsonArray'))
      if (!Array.isArray(parsedTools)) throw new Error(t('toolsMustBeJsonArray'))
      if (!isRecord(parsedVariables)) throw new Error(t('typedVariablesMustBeJsonObject'))
      const module = await import('./tokenizerClient.ts')
      const rendered = await module.renderTemplate(source, {
        ...parsedVariables,
        messages: parsedMessages,
        tools: parsedTools,
        add_generation_prompt: addGenerationPrompt,
      })
      if (generation.current !== activeGeneration) return
      setOutput(rendered)
      setSelectedLine(0)
      setCopyLabel(t('templateCopyOutputAction'))
      setPhase('ready')
    } catch (failure) {
      if (generation.current !== activeGeneration) return
      setError(failure instanceof Error ? failure.message : String(failure))
      setOutput('')
      setPhase('error')
    }
  }

  const views: Array<[typeof view, string]> = config === null
    ? [['overview', t('templateOverviewTab')], ['source', t('templateSourceTab')], ['playground', t('templatePlaygroundTab')]]
    : [['config', t('templateConfigTab')], ['overview', t('templateOverviewTabWithConfig')], ['source', t('templateSourceTab')], ['playground', t('templatePlaygroundTab')]]
  return (
    <div className="template-workspace">
      <div className="tokenizer-tabs" role="tablist" aria-label={t('templateViewsAriaLabel')}>
        {views.map(([value, label]) => <button type="button" role="tab" aria-selected={view === value} onClick={() => setView(value)} key={value}>{label}</button>)}
      </div>
      {view === 'config' && config !== null ? (
        <TextInspection snapshot={snapshot} path={config.path} content={config.content} parsed={config.parsed} json bytesRead={config.bytesRead} />
      ) : null}
      {view === 'overview' ? (
        <div className="inspection-canvas">
          <dl className="validation-strip">
            <div><dt>{t('templateOriginLabel')}</dt><dd>{sourceOrigin}</dd></div>
            <div><dt>{t('templateSourceSizeLabel')}</dt><dd>{formatBytes(sourceBytes)}</dd></div>
            <div><dt>{t('templateBytesReadLabel')}</dt><dd>{formatBytes(bytesRead)}</dd></div>
          </dl>
          <dl className="metric-grid">
            <div><dt>{t('templateLineCountLabel')}</dt><dd>{formatNumber(source.split('\n').length)}</dd></div>
            <div><dt>{t('templateJinjaExpressionsLabel')}</dt><dd>{formatNumber((source.match(/{{/g) ?? []).length)}</dd></div>
            <div><dt>{t('templateJinjaStatementsLabel')}</dt><dd>{formatNumber((source.match(/{%/g) ?? []).length)}</dd></div>
            <div><dt>{t('templateModificationStatusLabel')}</dt><dd>{source === initialSource ? t('templateOriginalSourceState') : t('templateTemporaryChangesState')}</dd></div>
          </dl>
          <p className="scope-note">{t('templateScopeNote')}</p>
        </div>
      ) : null}
      {view === 'source' ? (
        <div className="template-source">
          <header><span>{sourceOrigin} · {t('templateLineCountSuffix', { count: formatNumber(source.split('\n').length) })} · {formatBytes(sourceBytes)} · {source === initialSource ? t('templateOriginalSourceState') : t('templateModifiedState')}</span><button type="button" onClick={() => changeSource(initialSource)} disabled={source === initialSource}>{t('templateRestoreSourceAction')}</button></header>
          <textarea
            aria-label={t('templateJinjaSourceAriaLabel')}
            value={source}
            onChange={event => changeSource(event.target.value)}
            onKeyDown={event => {
              if (event.metaKey === event.ctrlKey || event.altKey || event.shiftKey) return
              if (event.key.toLowerCase() !== 'f') return
              event.preventDefault()
              setFind(state => state.open ? state : { open: true, query: '', current: 0 })
            }}
            ref={sourceRef}
            spellCheck={false}
          />
          {find.open ? (
            <section aria-label={t('readerCurrentFileFind')} className="source-find" role="search">
              <input
                aria-label={t('readerCurrentFileFind')}
                autoFocus
                onChange={event => setFind({ open: true, query: event.target.value, current: 0 })}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    navigateFind(event.shiftKey ? 'previous' : 'next')
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setFind({ open: false, query: '', current: 0 })
                  }
                }}
                value={find.query}
              />
              <span>{formatNumber(activeMatch.current)} / {formatNumber(activeMatch.total)}</span>
              <button disabled={activeMatch.total === 0} onClick={() => navigateFind('previous')} type="button">{t('readerPreviousMatch')}</button>
              <button disabled={activeMatch.total === 0} onClick={() => navigateFind('next')} type="button">{t('readerNextMatch')}</button>
            </section>
          ) : null}
          <pre className="jinja-highlight" aria-label={t('templateJinjaHighlightAriaLabel')}>
            <HighlightedJinja
              activeEnd={activeMatch.end}
              activeStart={activeMatch.start}
              query={find.open ? find.query : ''}
              source={source}
            />
          </pre>
        </div>
      ) : null}
      {view === 'playground' ? (
        <div className="template-playground">
          <section className="template-inputs">
            <label>{t('templatePresetLabel')}<select value={preset} onChange={event => choosePreset(event.target.value as keyof typeof presets)}>
              <option value="basic">{t('templateBasicConversationOption')}</option><option value="tools">{t('templateToolsLabel')}</option><option value="multimodal">{t('templateMultimodalOption')}</option>
            </select></label>
            <label>{t('templateMessagesLabel')}<textarea aria-label={t('templateMessagesInputAriaLabel')} value={messages} onChange={event => changePlaygroundInput(() => setMessages(event.target.value))} /></label>
            <label>{t('templateToolsLabel')}<textarea aria-label={t('templateToolsInputAriaLabel')} value={tools} onChange={event => changePlaygroundInput(() => setTools(event.target.value))} /></label>
            <label>{t('templateVariablesLabel')}<textarea aria-label={t('templateVariablesInputAriaLabel')} value={variables} onChange={event => changePlaygroundInput(() => setVariables(event.target.value))} /></label>
            <footer><label className="checkbox"><input type="checkbox" checked={addGenerationPrompt} onChange={event => changePlaygroundInput(() => setAddGenerationPrompt(event.target.checked))} />add_generation_prompt</label><button className="primary-button" type="button" onClick={render} disabled={phase === 'loading'}>{phase === 'loading' ? t('templateRenderingState') : t('templateRenderAction')}</button></footer>
          </section>
          <section className="template-output" aria-live="polite">
            <header>
              <h2>{t('templateOutputTitle')}</h2>
              <button type="button" aria-pressed={outputView === 'structure'} onClick={() => setOutputView('structure')}>{t('templateStructureIndexAction')}</button>
              <button type="button" aria-pressed={outputView === 'raw'} onClick={() => setOutputView('raw')}>{t('templateRawOutputAction')}</button>
              <button type="button" disabled={phase !== 'ready'} onClick={async () => {
                try { await navigator.clipboard.writeText(output); setCopyLabel(t('templateCopiedState')) } catch { setCopyLabel(t('templateCopyFailedState')) }
              }}>{copyLabel}</button>
            </header>
            {phase === 'idle' ? <div className="result-empty">{t('templateEditJsonHint')}</div> : null}
            {phase === 'loading' ? <div className="result-empty"><span className="spinner" />{t('templateWorkerRenderingState')}</div> : null}
            {phase === 'error' ? <p className="inline-error" role="alert">{error}</p> : null}
            {phase === 'ready' && outputView === 'raw' ? <pre className="source-reader standalone">{output}</pre> : null}
            {phase === 'ready' && outputView === 'structure' ? (
              <div className="template-structure">
                <div className="table-scroll"><table aria-label={t('templateOutputStructureTableAriaLabel')}><thead><tr><th>#</th><th>{t('readerContentColumn')}</th></tr></thead><tbody>{outputLines.map((line, index) => <tr key={index}><td>{formatNumber(index + 1)}</td><td><button className="table-link" type="button" onClick={() => setSelectedLine(index)}>{line || '∅'}</button></td></tr>)}</tbody></table></div>
                <dl className="reader-facts"><div><dt>{t('templateSelectedRowFact')}</dt><dd>{formatNumber(selectedLine + 1)}</dd></div><div><dt>{t('templateCharacterCountFact')}</dt><dd>{formatNumber(Array.from(outputLines[selectedLine] ?? '').length)}</dd></div><div><dt>{t('templateUtf8BytesFact')}</dt><dd>{formatNumber(new TextEncoder().encode(outputLines[selectedLine] ?? '').byteLength)}</dd></div></dl>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  )
}

function HighlightedJinja({
  source,
  query,
  activeStart,
  activeEnd,
}: {
  source: string
  query: string
  activeStart: number
  activeEnd: number
}) {
  let segmentStart = 0
  return source.split(/({{[\s\S]*?}}|{%[\s\S]*?%}|{#[\s\S]*?#})/g).map((part, index) => {
    const start = segmentStart
    segmentStart += part.length
    const className = part.startsWith('{{') ? 'jinja-expression'
      : part.startsWith('{%') ? 'jinja-statement'
        : part.startsWith('{#') ? 'jinja-comment' : ''
    const nodes = renderHighlightedSegment(part, start, className, query, activeStart, activeEnd, source)
    return className === '' ? <Fragment key={index}>{nodes}</Fragment> : <span className={className} key={index}>{nodes}</span>
  })
}

function renderHighlightedSegment(
  text: string,
  segmentStart: number,
  className: string,
  query: string,
  activeStart: number,
  activeEnd: number,
  source: string,
) {
  if (query === '') return text
  // ponytail: rescans source per Jinja segment; use one coordinated match walk if large-template profiling shows a cost.
  const nodes: Array<ReactNode> = []
  let cursor = 0
  forEachTextMatch(source, query, start => {
    const end = start + query.length
    const markStart = Math.max(start, segmentStart)
    const markEnd = Math.min(end, segmentStart + text.length)
    if (markStart >= markEnd) return
    if (markStart > segmentStart + cursor) {
      nodes.push(text.slice(cursor, markStart - segmentStart))
      cursor = markStart - segmentStart
    }
    const current = start === activeStart && end === activeEnd
    nodes.push(
      <mark
        aria-current={current ? 'true' : undefined}
        className={current ? 'find-match current' : 'find-match'}
        key={start}
      >{className === ''
        ? text.slice(cursor, markEnd - segmentStart)
        : <span className={className}>{text.slice(cursor, markEnd - segmentStart)}</span>}
      </mark>,
    )
    cursor = markEnd - segmentStart
  })
  return cursor < text.length ? [...nodes, text.slice(cursor)] : nodes
}

const presets = {
  basic: {
    messages: [{ role: 'system', content: 'You are concise.' }, { role: 'user', content: 'Hello' }],
    tools: [],
    variables: { enable_thinking: false, mode: 'basic' },
  },
  tools: {
    messages: [{ role: 'user', content: 'Search for a model.' }],
    tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
    variables: { enable_thinking: true, mode: 'tools' },
  },
  multimodal: {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this.' }, { type: 'image', url: 'fixture://image' }] }],
    tools: [],
    variables: { enable_thinking: false, mode: 'multimodal' },
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
