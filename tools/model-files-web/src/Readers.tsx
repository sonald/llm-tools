import { useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeReader, type SourceJump } from './CodeReader.tsx'
import { formatBytes, type FileCategory, type RepositoryFile, type RepositorySnapshot } from './core/huggingface.ts'
import { formatJsonSource, jsonTopLevelKeyRanges } from './core/jsonSource.ts'
import { formatNumber, translate as t } from './i18n.ts'
import {
  jsonSummary,
  jsonSummaryKind,
  repositoryMarkdownUrl,
  textLineAtOffset,
  vocabEntries,
  type JsonSummary,
  type Perspective,
} from './core/readers.ts'

// A repository consistency finding anchored at a top-level key of this file.
export type FileDiagnostic = {
  id: string
  severity: 'warning' | 'info'
  title: string
  key: string
  note: string
}

type Props = {
  snapshot: RepositorySnapshot
  path: string
  category: FileCategory
  content: string
  parsed: unknown
  json: boolean
  diagnostics?: FileDiagnostic[]
  selectedDiagnosticId?: string | null
  onSelectDiagnostic?(id: string): void
  // Picked in the file header (native DetailHeader). Readers render it; they no longer own a tab row.
  perspective?: Perspective
  onPerspectiveChange?(perspective: Perspective): void
  overviewExtra?: ReactNode
}

// Native FileReaderView: the file's problem list on top, then one reader picked by perspective.
export function TextInspection(props: Props) {
  if (props.path.toLocaleLowerCase().endsWith('.md')) return <MarkdownInspection {...props} />
  if (props.json) return <JsonInspection {...props} />
  return <div className="reader-stack"><CodeReader content={props.content} language={null} label={props.path} /></div>
}

function JsonInspection({
  path, category, content, parsed, diagnostics = [], selectedDiagnosticId = null, onSelectDiagnostic,
  perspective = 'overview', onPerspectiveChange, overviewExtra,
}: Props) {
  const kind = jsonSummaryKind(path, category)
  // Scan only when there is something to anchor: this reader also opens multi-megabyte vocab JSON.
  const located = useMemo(() => {
    if (diagnostics.length === 0) return []
    const keyRanges = jsonTopLevelKeyRanges(content)
    return diagnostics.map(diagnostic => {
      const offset = keyRanges.get(diagnostic.key)?.start
      return { ...diagnostic, line: offset === undefined ? null : textLineAtOffset(content, offset) }
    })
  }, [content, diagnostics])
  const marks = useMemo(() => located.flatMap(item => item.line === null ? [] : [{ line: item.line, severity: item.severity }]), [located])
  const [jump, setJump] = useState<SourceJump | null>(null)

  let reader: ReactNode
  if (perspective === 'raw') reader = <CodeReader content={content} language="json" label={path} marks={marks} jump={jump} />
  else if (perspective === 'fields' || kind === null) reader = <FormattedJson content={content} valid={parsed !== undefined} label={path} />
  else if (kind === 'vocab') reader = <VocabSummary value={parsed} />
  else reader = <SummaryView summary={jsonSummary(kind, content)} extra={kind === 'tokenizerConfig' ? overviewExtra : null} />

  return (
    <div className="reader-stack">
      {located.length > 0 ? (
        <section className="reader-diagnostics" aria-label={t('readerFileProblems')}>
          {located.map(item => (
            <button
              className="reader-diagnostic"
              data-severity={item.severity}
              aria-pressed={selectedDiagnosticId === item.id}
              key={`${item.id}/${item.key}`}
              title={item.note}
              type="button"
              onClick={() => {
                onSelectDiagnostic?.(item.id)
                if (item.line === null) return
                onPerspectiveChange?.('raw')
                setJump(current => ({ line: item.line!, nonce: (current?.nonce ?? 0) + 1 }))
              }}
            >
              <span aria-hidden="true">{item.severity === 'warning' ? '▲' : '●'}</span>
              <span className="sr-only">{t(item.severity === 'warning' ? 'appSeverityWarning' : 'appSeverityInfo')}</span>
              <span className="reader-diagnostic-title">{item.title}</span>
              <code>{item.key}</code>
              <span className="reader-diagnostic-line">
                {item.line === null ? null : t('readerDiagnosticLine', { line: formatNumber(item.line) })}
              </span>
            </button>
          ))}
        </section>
      ) : null}
      {reader}
    </div>
  )
}

// Native JSONReaderView: lexeme-preserving formatted source; invalid JSON shows the error above the original text.
function FormattedJson({ content, valid, label }: { content: string; valid: boolean; label: string }) {
  // ponytail: formats on the main thread; move to a Worker if multi-megabyte vocab files stall the click.
  const source = useMemo(() => valid ? formatJsonSource(content) : content, [content, valid])
  const error = useMemo(() => {
    if (valid) return null
    try { JSON.parse(content) } catch (failure) { return `JSON: ${failure instanceof Error ? failure.message : String(failure)}` }
    return null
  }, [content, valid])
  return (
    <>
      {error !== null ? <p className="json-error" role="alert"><span aria-hidden="true">⚠︎</span> {error}</p> : null}
      <CodeReader content={source} language="json" label={label} />
    </>
  )
}

function SummaryView({ summary, extra }: { summary: JsonSummary; extra?: ReactNode }) {
  return (
    <div className="reader-summary">
      <header className={`reader-title${summary.prominent ? ' prominent' : ''}`}>
        <h2>{summary.title}</h2>
        <p>{summary.subtitle}</p>
      </header>
      {summary.groups.filter(group => group.rows.length > 0).map(group => (
        <section className="property-group" key={group.title}>
          <h3>{group.title}</h3>
          <dl>{group.rows.map(([key, value]) => <div className="key-value-row" key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
        </section>
      ))}
      {summary.mappings !== undefined ? (
        <section className="property-group plain">
          <h3>{t('summaryFirstMappings')}</h3>
          <dl>{summary.mappings.map(([key, value]) => <div className="key-value-row" key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
        </section>
      ) : null}
      {extra}
    </div>
  )
}

// Native VocabView: search token or ID, sorted by ID, the first 1,000 of the filtered list.
function VocabSummary({ value }: { value: unknown }) {
  const [query, setQuery] = useState('')
  const entries = useMemo(() => vocabEntries(value, query).slice(0, 1000), [value, query])
  const count = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0
  return (
    <div className="reader-summary">
      <header className="reader-title">
        <h2>{t('summaryVocabTitle')}</h2>
        <p>{t('summaryVocabSubtitle', { count: formatNumber(count) })}</p>
      </header>
      <input className="vocab-search" aria-label={t('summaryVocabSearch')} placeholder={t('summaryVocabSearch')}
        value={query} onChange={event => setQuery(event.target.value)} />
      <table className="vocab-table" aria-label={t('summaryVocabTitle')}>
        <thead><tr><th>Token</th><th>ID</th></tr></thead>
        <tbody>{entries.map(([token, id]) => <tr key={token}><td>{token}</td><td>{id}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

// Native rule: code ≤128 KB is highlighted in 概览/源码 and plain wrapped text in 全部字段/原文.
export function SourceInspection({ content, language, label, perspective = 'overview' }: {
  content: string
  language: string
  label: string
  perspective?: Perspective
}) {
  const highlighted = perspective === 'overview' || perspective === 'source'
  return <div className="reader-stack"><CodeReader content={content} language={highlighted ? language : null} label={label} /></div>
}

function MarkdownInspection(props: Props) {
  // Native: only documentation Markdown renders, and only in 概览; everything else is the plain-text reader.
  const mode = (props.perspective ?? 'overview') === 'overview' && props.category === 'documentation' ? 'rendered' : 'raw'
  const [theme, setTheme] = useState<'github' | 'default' | 'compact'>('github')
  const embeddedPrefix = props.snapshot.source === 'huggingface'
    ? `https://huggingface.co/${props.snapshot.modelId.split('/').map(encodeURIComponent).join('/')}/resolve/${props.snapshot.revision}/`
    : ''
  if (mode === 'raw') return <div className="reader-stack"><CodeReader content={props.content} language={null} label={props.path} /></div>
  return (
    <div className="reader-canvas">
      <div className="reader-controls">
          <label>{t('readerLayoutLabel')}
            <select value={theme} onChange={event => setTheme(event.target.value as typeof theme)}>
              <option value="github">GitHub</option>
              <option value="default">{t('readerDefaultLayout')}</option>
              <option value="compact">{t('readerCompactLayout')}</option>
            </select>
          </label>
      </div>
      <article className={`markdown-body markdown-${theme}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            urlTransform={(url, key) => repositoryMarkdownUrl(props.snapshot, props.path, url, key === 'src' ? 'src' : 'href')}
            components={{
              a: ({ href, children }) => href === undefined
                ? <span>{children}</span>
                : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
              img: ({ src, alt }) => src !== undefined && embeddedPrefix !== '' && src.startsWith(embeddedPrefix)
                ? <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
                : <span className="external-image">{t('readerExternalImage', { alt: alt ?? t('readerNoImageAlt') })}{src === undefined ? null : <> · <a href={src} target="_blank" rel="noreferrer">{t('readerOpenLink')}</a></>}</span>,
            }}
          >{props.content}</ReactMarkdown>
      </article>
    </div>
  )
}

export function PdfInspection({ data }: { data: ArrayBuffer }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const nextUrl = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
    setUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
  }, [data])

  return (
    <div className="reader-canvas pdf-reader">
      {url !== '' ? <iframe className="pdf-frame" title={t('readerPdfDocumentTitle')} src={url} /> : null}
      {url !== ''
        ? <a className="pdf-open" href={url} target="_blank" rel="noreferrer">{t('readerOpenPdfNewTab')}</a>
        : null}
    </div>
  )
}

export function ImageInspection({
  file,
  data,
  mimeType,
  isSvg,
  textContent,
  bytesRead,
  perspective,
}: {
  file: RepositoryFile
  data: ArrayBuffer
  mimeType: string
  isSvg: boolean
  textContent?: string
  bytesRead: number
  perspective: Perspective
}) {
  const [url, setUrl] = useState('')
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [fit, setFit] = useState(true)
  const [zoom, setZoom] = useState(1.0)
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    const blob = new Blob([data], { type: mimeType })
    const nextUrl = URL.createObjectURL(blob)
    setUrl(nextUrl)
    setHasError(false)
    setDimensions(null)
    setFit(true)
    setZoom(1.0)
    return () => URL.revokeObjectURL(nextUrl)
  }, [data, mimeType])

  return (
    <div className="reader-canvas image-reader">
      {isSvg && perspective === 'source' && textContent !== undefined ? (
        <CodeReader content={textContent} language={bytesRead <= 128 * 1024 ? 'markup' : null} label={file.path} />
      ) : (
        <div className="image-workspace">
          <div className="image-toolbar">
            <div className="image-stats">
              {dimensions ? <span>{dimensions.width} × {dimensions.height} px</span> : null}
              <span>{formatBytes(bytesRead)}</span>
            </div>
            <div className="image-actions">
              <button
                type="button"
                className={`zoom-btn ${fit ? 'active' : ''}`}
                onClick={() => { setFit(true); setZoom(1.0); }}
              >
                {t('readerImageFit')}
              </button>
              <button
                type="button"
                className={`zoom-btn ${!fit && zoom === 1.0 ? 'active' : ''}`}
                onClick={() => { setFit(false); setZoom(1.0); }}
              >
                {t('readerImageActual')}
              </button>
              <button
                type="button"
                className="zoom-btn"
                title={t('readerZoomOut')}
                aria-label={t('readerZoomOut')}
                onClick={() => { setFit(false); setZoom(z => Math.max(0.2, Number((z - 0.2).toFixed(1)))); }}
              >
                −
              </button>
              <span className="zoom-percentage">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                className="zoom-btn"
                title={t('readerZoomIn')}
                aria-label={t('readerZoomIn')}
                onClick={() => { setFit(false); setZoom(z => Math.min(5.0, Number((z + 0.2).toFixed(1)))); }}
              >
                +
              </button>
            </div>
          </div>

          <div className="image-viewport">
            <div className="image-checkerboard">
              {hasError ? (
                <div className="image-error">{t('readerImageFailed')}</div>
              ) : url !== '' ? (
                <img
                  src={url}
                  alt={file.path}
                  className={`inspected-image ${fit ? 'fit' : 'scaled'}`}
                  style={fit ? undefined : { transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                  onLoad={(event) => {
                    const img = event.currentTarget
                    setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
                  }}
                  onError={() => setHasError(true)}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
