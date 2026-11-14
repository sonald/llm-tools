import { useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeReader, type SourceJump } from './CodeReader.tsx'
import { formatBytes, type FileCategory, type RepositoryFile, type RepositorySnapshot } from './core/huggingface.ts'
import { formatJsonSource, jsonTopLevelKeyRanges } from './core/jsonSource.ts'
import { modelCardImageWidth, modelCardRenderable } from './core/modelCardMarkdown.ts'
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
    // Native JSONFormatter.formattedSource: "JSON: " + JSONSerialization's localizedDescription.
    try { JSON.parse(content) } catch { return `JSON: ${t('jsonDataCorrupted')}` }
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

const markdownThemes = ['github', 'default', 'compact'] as const

function MarkdownInspection(props: Props) {
  // Native: only documentation Markdown renders, and only in 概览; everything else is the plain-text reader.
  const mode = (props.perspective ?? 'overview') === 'overview' && props.category === 'documentation' ? 'rendered' : 'raw'
  const [theme, setTheme] = useState<typeof markdownThemes[number]>('github')
  const markdown = useMemo(() => modelCardRenderable(props.content), [props.content])
  if (mode === 'raw') return <div className="reader-stack"><CodeReader content={props.content} language={null} label={props.path} /></div>
  return (
    <div className="reader-canvas">
      {/* Native MarkdownReaderView: "Markdown" heading, the 排版主题 segmented picker, a divider, then the card. */}
      <section className="markdown-card">
        <header className="markdown-header">
          <span className="markdown-heading"><DocumentIcon />Markdown</span>
          <span className="markdown-theme">
            <span aria-hidden="true">{t('readerMarkdownTheme')}</span>
            <span className="perspective" role="group" aria-label={t('readerMarkdownThemeLabel')}>
              {markdownThemes.map(value => (
                <button aria-pressed={theme === value} key={value} onClick={() => setTheme(value)} type="button">
                  {value === 'github' ? 'GitHub' : t(value === 'default' ? 'readerDefaultLayout' : 'readerCompactLayout')}
                </button>
              ))}
            </span>
          </span>
        </header>
        <article className={`markdown-body markdown-${theme}`}>
          {/* Raw HTML stays off: native turns <img>/<a>/<br> into Markdown and strips the rest before rendering. */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            urlTransform={(url, key) => repositoryMarkdownUrl(props.snapshot, props.path, url, key === 'src' ? 'src' : 'href')}
            components={{
              a: ({ href, children }) => href === undefined
                ? <span>{children}</span>
                : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
              img: ({ src, alt }) => <ModelCardImage src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />,
            }}
          >{markdown}</ReactMarkdown>
        </article>
      </section>
    </div>
  )
}

// Native ModelCardImageLoader: HTTPS only, width capped by the converted <img> width; a failed load leaves the alt text.
function ModelCardImage({ src, alt }: { src: string | undefined; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (src === undefined || !src.startsWith('https:') || failed) return <>{alt}</>
  const width = modelCardImageWidth(src)
  return (
    <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}
      style={width === null ? undefined : { width: `min(100%, ${width}px)` }} />
  )
}

function DocumentIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 1.75V5.3h3.5M6 8h4.5M6 10.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
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

// Native ImageReaderView: toolbar「W × H px · EXT · size」with 适应窗口 / 1:1 / − 100% +, steps of 0.25 within
// 0.25–5; scaled images take their real size in a scroll view (centred when smaller) over a checkerboard.
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

  const name = file.path.split('/').at(-1) ?? file.path
  const extension = name.toUpperCase().split('.').filter(part => part !== '').at(-1) ?? 'IMAGE'
  // An SVG without an intrinsic size reports 0 × 0: native sizes its SVG web view at 400 pt per zoom step.
  const base = dimensions !== null && dimensions.width > 0 && dimensions.height > 0 ? dimensions : { width: 400, height: 400 }

  return (
    <div className="reader-canvas image-reader">
      {isSvg && perspective === 'source' && textContent !== undefined ? (
        <CodeReader content={textContent} language={bytesRead <= 128 * 1024 ? 'markup' : null} label={file.path} />
      ) : (
        <div className="image-workspace">
          <div className="image-toolbar">
            <div className="image-stats">
              {dimensions !== null && dimensions.width > 0 ? (
                <>
                  <span className="image-dimensions">{formatNumber(dimensions.width)} × {formatNumber(dimensions.height)} px</span>
                  <span className="image-dot" aria-hidden="true">·</span>
                </>
              ) : null}
              <span className="image-extension">{extension}</span>
              <span className="image-dot" aria-hidden="true">·</span>
              <span>{formatBytes(bytesRead)}</span>
            </div>
            <div className="image-actions">
              <button type="button" className={`zoom-btn ${fit ? 'active' : ''}`} aria-pressed={fit}
                onClick={() => { setFit(true); setZoom(1.0) }}>
                {t('readerImageFit')}
              </button>
              <button type="button" className={`zoom-btn ${!fit && zoom === 1.0 ? 'active' : ''}`} aria-pressed={!fit && zoom === 1.0}
                onClick={() => { setFit(false); setZoom(1.0) }}>
                1:1
              </button>
              <button type="button" className="zoom-icon" title={t('readerZoomOut')} aria-label={t('readerZoomOut')}
                onClick={() => { setFit(false); setZoom(z => Math.max(0.25, z - 0.25)) }}>
                <ZoomIcon sign="minus" />
              </button>
              <span className="zoom-percentage">{formatNumber(Math.trunc(zoom * 100))}%</span>
              <button type="button" className="zoom-icon" title={t('readerZoomIn')} aria-label={t('readerZoomIn')}
                onClick={() => { setFit(false); setZoom(z => Math.min(5.0, z + 0.25)) }}>
                <ZoomIcon sign="plus" />
              </button>
            </div>
          </div>

          <div className={`image-viewport${fit ? ' fit' : ''}`}>
            {hasError ? (
              <div className="empty-state image-error">
                <h2>{t('readerImageCannotDisplay')}</h2>
                <p>{t('readerImageCannotDecode')}</p>
              </div>
            ) : url !== '' ? (
              <img
                src={url}
                alt={file.path}
                className={`inspected-image ${fit ? 'fit' : 'scaled'}`}
                style={fit ? undefined : { width: Math.max(base.width * zoom, 10), height: Math.max(base.height * zoom, 10) }}
                onLoad={(event) => {
                  const img = event.currentTarget
                  setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
                }}
                onError={() => setHasError(true)}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

function ZoomIcon({ sign }: { sign: 'minus' | 'plus' }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <circle cx="6.75" cy="6.75" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d={`M14.5 14.5l-4.2-4.2M4.5 6.75h4.5${sign === 'plus' ? 'M6.75 4.5v4.5' : ''}`} stroke="currentColor" strokeWidth="1.4"
        strokeLinecap="round" />
    </svg>
  )
}
