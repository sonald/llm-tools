import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatBytes, type RepositorySnapshot } from './core/huggingface.ts'
import { jsonRows, repositoryMarkdownUrl, summarizeJson, textLines, visibleRows } from './core/readers.ts'

type Props = {
  snapshot: RepositorySnapshot
  path: string
  content: string
  parsed: unknown
  json: boolean
  bytesRead: number
}

export function TextInspection(props: Props) {
  const lower = props.path.toLocaleLowerCase()
  if (lower.endsWith('.md')) return <MarkdownInspection {...props} />
  if (props.json) return <JsonInspection {...props} />
  return <LineInspection {...props} />
}

function JsonInspection({ path, content, parsed, bytesRead }: Props) {
  const [perspective, setPerspective] = useState<'overview' | 'fields' | 'raw'>('overview')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(1000)
  const summary = useMemo(() => summarizeJson(path, parsed), [parsed, path])
  const rows = useMemo(() => jsonRows(path, parsed), [parsed, path])
  // ponytail: bounded linear scan stays dependency-free; move it to a Worker only if the 100k-row browser gate regresses.
  const matching = useMemo(() => visibleRows(rows, query, Number.MAX_SAFE_INTEGER), [query, rows])
  useEffect(() => setLimit(1000), [query])

  return (
    <div className="reader-canvas">
      <ReaderHeader bytesRead={bytesRead} result="JSON 有效" />
      <Perspective<'overview' | 'fields' | 'raw'> value={perspective} onChange={setPerspective} values={[
        ['overview', '概览'], ['fields', '全部字段'], ['raw', '原文'],
      ]} />
      {perspective === 'overview' ? (
        <section className="reader-section">
          <h2>{summary.title}</h2>
          <dl className="reader-facts">
            {summary.facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
      ) : null}
      {perspective === 'fields' ? (
        <ProgressiveRows rows={matching} query={query} setQuery={setQuery} limit={limit} setLimit={setLimit} />
      ) : null}
      {perspective === 'raw' ? <pre className="source-reader standalone" data-language="json">{content}</pre> : null}
    </div>
  )
}

function LineInspection({ content, bytesRead }: Props) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(1000)
  const lines = useMemo(() => textLines(content).map((line, index): [string, string] => [String(index + 1), line]), [content])
  const matching = useMemo(() => visibleRows(lines, query, Number.MAX_SAFE_INTEGER), [lines, query])
  useEffect(() => setLimit(1000), [query])
  return (
    <div className="reader-canvas">
      <ReaderHeader bytesRead={bytesRead} result="UTF-8 有效" />
      <ProgressiveRows rows={matching} query={query} setQuery={setQuery} limit={limit} setLimit={setLimit} firstColumn="行" secondColumn="内容" />
    </div>
  )
}

function MarkdownInspection(props: Props) {
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered')
  const [theme, setTheme] = useState<'github' | 'default' | 'compact'>('github')
  const embeddedPrefix = props.snapshot.source === 'huggingface'
    ? `https://huggingface.co/${props.snapshot.modelId.split('/').map(encodeURIComponent).join('/')}/resolve/${props.snapshot.revision}/`
    : ''
  return (
    <div className="reader-canvas">
      <ReaderHeader bytesRead={props.bytesRead} result="Markdown · raw HTML 已禁用" />
      <div className="reader-controls">
        <Perspective<'rendered' | 'raw'> value={mode} onChange={setMode} values={[["rendered", '渲染'], ['raw', '原文']]} />
        {mode === 'rendered' ? (
          <label>排版
            <select value={theme} onChange={event => setTheme(event.target.value as typeof theme)}>
              <option value="github">GitHub</option>
              <option value="default">默认</option>
              <option value="compact">紧凑</option>
            </select>
          </label>
        ) : null}
      </div>
      {mode === 'raw' ? <pre className="source-reader standalone">{props.content}</pre> : (
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
                : <span className="external-image">图片：{alt ?? '无说明'}{src === undefined ? null : <> · <a href={src} target="_blank" rel="noreferrer">打开链接</a></>}</span>,
            }}
          >{props.content}</ReactMarkdown>
        </article>
      )}
    </div>
  )
}

export function PdfInspection({ data, bytesRead }: { data: ArrayBuffer; bytesRead: number }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const nextUrl = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
    setUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
  }, [data])

  return (
    <div className="reader-canvas pdf-reader">
      <ReaderHeader bytesRead={bytesRead} result="PDF 签名有效" />
      {url !== '' ? <iframe className="pdf-frame" title="PDF 文档" src={url} /> : null}
      {url !== ''
        ? <a className="pdf-open" href={url} target="_blank" rel="noreferrer">在新标签页打开 PDF</a>
        : null}
    </div>
  )
}

type SourceSegment = { text: string; className: string }

function validateReply(reply: unknown, expectedContent: string) {
  if (typeof reply !== 'object' || reply === null || !('ok' in reply) || reply.ok !== true) return null
  const segments = (reply as { segments?: unknown }).segments
  if (!Array.isArray(segments)) return null
  let content = ''
  const validSegments: SourceSegment[] = []
  for (const segment of segments) {
    if (typeof segment !== 'object' || segment === null) return null
    const { text, className } = segment as Record<string, unknown>
    if (typeof text !== 'string' || typeof className !== 'string') return null
    content += text
    validSegments.push({ text, className })
  }
  return content === expectedContent ? { segments: validSegments } : null
}

export function SourceInspection({
  content,
  language,
  bytesRead,
}: {
  content: string
  language: string
  bytesRead: number
}) {
  const [segments, setSegments] = useState<SourceSegment[] | null>(null)
  useEffect(() => {
    setSegments(null)
    let active = true
    let worker: Worker | null = new Worker(new URL('./sourceHighlight.worker.ts', import.meta.url), { type: 'module' })
    const terminate = () => {
      worker?.terminate()
      worker = null
    }
    worker.onmessage = (event: MessageEvent<unknown>) => {
      terminate()
      const reply = validateReply(event.data, content)
      if (!active || reply === null) return
      setSegments(reply.segments)
    }
    worker.onerror = event => {
      event.preventDefault()
      terminate()
      if (active) setSegments(null)
    }
    worker.postMessage({ content, language })
    return () => {
      active = false
      terminate()
    }
  }, [content, language])
  return (
    <div className="reader-layout">
      <ReaderHeader bytesRead={bytesRead} result="UTF-8 有效" />
      <pre
        className="source-reader standalone"
        data-language={language}
        data-highlighted={segments !== null}
      >{segments?.map((segment, index) => (
        <span key={index} className={segment.className}>{segment.text}</span>
      )) ?? content}</pre>
    </div>
  )
}


function ReaderHeader({ bytesRead, result }: { bytesRead: number; result: string }) {
  return (
    <dl className="validation-strip">
      <div><dt>读取方式</dt><dd>受限全文</dd></div>
      <div><dt>实际读取</dt><dd>{formatBytes(bytesRead)}</dd></div>
      <div><dt>解析结果</dt><dd>{result}</dd></div>
    </dl>
  )
}

function Perspective<T extends string>({
  value,
  onChange,
  values,
}: {
  value: T
  onChange(value: T): void
  values: Array<[T, string]>
}) {
  return (
    <div className="perspective" role="group" aria-label="阅读视图">
      {values.map(([item, label]) => (
        <button type="button" aria-pressed={value === item} onClick={() => onChange(item)} key={item}>{label}</button>
      ))}
    </div>
  )
}

function ProgressiveRows({
  rows,
  query,
  setQuery,
  limit,
  setLimit,
  firstColumn = '字段',
  secondColumn = '值',
}: {
  rows: Array<[string, string]>
  query: string
  setQuery(value: string): void
  limit: number
  setLimit(value: number): void
  firstColumn?: string
  secondColumn?: string
}) {
  const visible = rows.slice(0, limit)
  return (
    <section className="reader-section">
      <div className="inspection-toolbar">
        <label><span>搜索</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="字段或内容包含…" /></label>
        <span>显示 {visible.length.toLocaleString()} / {rows.length.toLocaleString()}</span>
      </div>
      <div className="table-scroll">
        <table aria-label={`${firstColumn}列表`}>
          <thead><tr><th>{firstColumn}</th><th>{secondColumn}</th></tr></thead>
          <tbody>{visible.map(([key, value]) => <tr key={key}><td>{key}</td><td title={value}>{value}</td></tr>)}</tbody>
        </table>
      </div>
      {visible.length < rows.length ? (
        <button className="load-more" type="button" onClick={() => setLimit(Math.min(limit + 1000, rows.length))}>再显示 1,000 项</button>
      ) : null}
    </section>
  )
}
