import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatBytes, type RepositorySnapshot } from './core/huggingface.ts'
import { foldRanges, type FoldRange } from './core/sourceFolding.ts'
import {
  forEachTextMatch,
  jsonRows,
  navigateTextMatches,
  repositoryMarkdownUrl,
  summarizeJson,
  textLineAtOffset,
  textLines,
  visibleRows,
  type TextFindNavigation,
} from './core/readers.ts'

type Props = {
  snapshot: RepositorySnapshot
  path: string
  content: string
  parsed: unknown
  json: boolean
  bytesRead: number
}

type LineFind = { open: boolean; query: string; current: number }

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
      {perspective === 'raw' ? <SourceCode content={content} language="json" bytesRead={bytesRead} /> : null}
    </div>
  )
}

function LineInspection({ content, bytesRead }: Props) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(1000)
  const [find, setFind] = useState<LineFind>(closedFind)
  const lines = useMemo(() => textLines(content).map((line, index): [string, string] => [String(index + 1), line]), [content])
  const matching = useMemo(() => visibleRows(lines, query, Number.MAX_SAFE_INTEGER), [lines, query])
  useEffect(() => setLimit(1000), [query])
  useEffect(() => setFind(closedFind), [content])

  const result = useMemo(
    () => navigateTextMatches(
      content,
      find.open ? find.query : '',
      'next',
      Math.max(find.current, 1) - 1,
    ),
    [content, find.current, find.open, find.query],
  )
  const activeKey = result.total === 0 ? '' : String(textLineAtOffset(content, result.start))
  const activeOffsetInLine = result.total === 0 ? -1 : result.start - lineStartAt(content, result.start)

  const navigateFind = (navigation: TextFindNavigation) => setFind(state => ({
    ...state,
    current: navigateTextMatches(content, state.query, navigation, Math.max(state.current, 1)).current,
  }))

  return (
    <div className="reader-canvas">
      <ReaderHeader bytesRead={bytesRead} result="UTF-8 有效" />
      <ProgressiveRows
        rows={matching}
        query={query}
        setQuery={setQuery}
        limit={limit}
        setLimit={setLimit}
        firstColumn="行"
        secondColumn="内容"
        find={{ open: find.open, query: find.query, total: result.total, current: result.current }}
        onNavigate={navigateFind}
        onFindChange={(open, nextQuery) => setFind(state => {
          if (!open) return closedFind
          if (state.open && nextQuery === undefined) return state
          return { ...closedFind, open: true, query: nextQuery ?? '' }
        })}
        activeKey={activeKey}
        activeOffset={activeOffsetInLine}
        activeRow={result.total === 0 ? undefined : lines[Number(activeKey) - 1]}
      />
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
      {mode === 'raw' ? <SourceCode content={props.content} language="markdown" bytesRead={props.bytesRead} /> : (
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

type SourceMatch = { start: number; end: number }
type SourceFind = { open: boolean; query: string; current: number }

const richLimitBytes = 128 * 1024
const closedFind: SourceFind = { open: false, query: '', current: 0 }

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
  return (
    <div className="reader-layout">
      <ReaderHeader bytesRead={bytesRead} result="UTF-8 有效" />
      <SourceCode content={content} language={language} bytesRead={bytesRead} />
    </div>
  )
}

function SourceCode({
  content,
  language,
  bytesRead,
}: {
  content: string
  language: string
  bytesRead: number
}) {
  const [segments, setSegments] = useState<SourceSegment[] | null>(null)
  const rich = bytesRead <= richLimitBytes
  const sourceRef = useRef<HTMLPreElement>(null)
  const [find, setFind] = useState<SourceFind>(closedFind)
  const ranges = useMemo(() => (rich ? foldRanges(content, language) : []), [content, language, rich])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!rich) return
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
  }, [content, language, rich])
  useEffect(() => setCollapsed(new Set()), [content, language])

  const matches = useMemo(() => {
    if (!rich || !find.open || find.query === '') return []
    const found: SourceMatch[] = []
    forEachTextMatch(content, find.query, start => found.push({ start, end: start + find.query.length }))
    return found
  }, [content, find.open, find.query, rich])
  useEffect(() => setFind(closedFind), [content, language])

  const current = matches.length === 0
    ? 0
    : find.current <= 0
      ? 1
    : Math.min(find.current, matches.length)
  const activeMatch = current === 0 ? null : matches[current - 1]
  const activeLine = activeMatch === null ? 0 : textLineAtOffset(content, activeMatch.start)

  const hiddenLines = useMemo(() => {
    const hidden = new Set<number>()
    for (const range of ranges) {
      if (!collapsed.has(foldKey(range))) continue
      for (let line = range.startLine + 1; line <= range.endLine; line += 1) hidden.add(line)
    }
    return hidden
  }, [collapsed, ranges])

  const markersByLine = useMemo(() => {
    const markers = new Map<number, FoldRange[]>()
    for (const range of ranges) {
      const current = markers.get(range.startLine)
      markers.set(range.startLine, current === undefined ? [range] : [...current, range])
    }
    return markers
  }, [ranges])

  const navigateFind = (navigation: 'next' | 'previous') => setFind(state => ({
    ...state,
    current: navigateTextMatches(content, state.query, navigation, current).current,
  }))
  const lines = useMemo(
    () => splitSourceLines(content, segments, matches, activeMatch),
    [activeMatch, content, matches, segments],
  )

  useEffect(() => {
    if (activeMatch === null) return
    let frame = 0
    setCollapsed(current => {
      const hiddenAncestors = [...collapsed]
        .filter(key => ranges.some(range => (
          foldKey(range) === key && range.startLine <= activeLine && activeLine <= range.endLine
        )))
      if (hiddenAncestors.length === 0) return current
      const next = new Set(current)
      for (const key of hiddenAncestors) next.delete(key)
      return next
    })
    frame = requestAnimationFrame(() => {
      sourceRef.current?.querySelector('mark.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeLine, activeMatch, collapsed, content, ranges])
  const showToolbar = ranges.length > 0

  if (!rich) {
    return (
      <div className="source-code-panel">
        <pre className="source-reader standalone" data-language={language} data-highlighted="false">{content}</pre>
      </div>
    )
  }

  return (
    <div className="source-code-panel">
      {showToolbar ? (
        <div className="fold-toolbar">
          <button type="button" onClick={() => setCollapsed(new Set())}>全部展开</button>
        </div>
      ) : null}
      {find.open ? (
        <section aria-label="当前文件查找" className="source-find" role="search">
          <input
            aria-label="当前文件查找"
            autoFocus
            onChange={event => setFind({ ...closedFind, open: true, query: event.target.value })}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                navigateFind(event.shiftKey ? 'previous' : 'next')
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setFind(closedFind)
              }
            }}
            value={find.query}
          />
          <span>{current.toLocaleString()} / {matches.length.toLocaleString()}</span>
          <button disabled={matches.length === 0} onClick={() => navigateFind('previous')} type="button">上一个命中</button>
          <button disabled={matches.length === 0} onClick={() => navigateFind('next')} type="button">下一个命中</button>
        </section>
      ) : null}
      <pre
        onKeyDown={event => {
          if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return
          if (event.key.toLowerCase() !== 'f') return
          event.preventDefault()
          setFind(state => state.open ? state : { ...closedFind, open: true })
        }}
        ref={sourceRef}
        tabIndex={0}
        className="source-reader standalone"
        data-language={language}
        data-highlighted={segments !== null}
      >
        {lines.map((line, index) => {
          const lineNumber = index + 1
          const markers = markersByLine.get(lineNumber)
          return (
            <span className="source-line" data-line={lineNumber} hidden={hiddenLines.has(lineNumber)} key={lineNumber}>
              {markers !== undefined ? (
                <span className="fold-markers">
                  {markers.map(range => {
                    const key = foldKey(range)
                    const isCollapsed = collapsed.has(key)
                    return (
                      <button
                        aria-label={`${isCollapsed ? '展开' : '折叠'}第 ${range.startLine} 行结构`}
                        className={`fold-marker${isCollapsed ? ' collapsed' : ''}`}
                        data-collapsed={isCollapsed || undefined}
                        data-hidden-lines={range.endLine - range.startLine}
                        key={key}
                        onClick={() => toggleFold(setCollapsed, range)}
                        title={`${isCollapsed ? '展开' : '折叠'}第 ${range.startLine} 行结构`}
                        type="button"
                      />
                    )
                  })}
                </span>
              ) : null}
              {line.map((piece, pieceIndex) => piece.match ? (
                <mark
                  aria-current={piece.current ? 'true' : undefined}
                  className={`find-match${piece.current ? ' current' : ''}`}
                  key={pieceIndex}
                >{piece.className === ''
                  ? piece.text
                  : <span className={piece.className}>{piece.text}</span>}
                </mark>
              ) : piece.className === ''
                ? <span key={pieceIndex}>{piece.text}</span>
                : <span className={piece.className} key={pieceIndex}>{piece.text}</span>)}
            </span>
          )
        })}
      </pre>
    </div>
  )
}

type SourcePiece = { text: string; className: string; match: boolean; current: boolean }

function foldKey(range: FoldRange) {
  return `${range.startLine}:${range.endLine}`
}

function toggleFold(
  setCollapsed: (update: (current: Set<string>) => Set<string>) => void,
  range: FoldRange,
) {
  setCollapsed(current => {
    const next = new Set(current)
    const key = foldKey(range)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
}

function splitSourceLines(
  content: string,
  segments: SourceSegment[] | null,
  matches: SourceMatch[],
  activeMatch: SourceMatch | null,
): Array<Array<SourcePiece>> {
  const pieces = segments ?? [{ text: content, className: '' }]
  const lines: Array<Array<SourcePiece>> = [[]]

  const appendPiece = (text: string, className: string, match: boolean, current: boolean) => {
    const currentLine = lines[lines.length - 1]
    const lastPiece = currentLine[currentLine.length - 1]
    if (lastPiece && lastPiece.className === className && lastPiece.match === match
      && lastPiece.current === current) lastPiece.text += text
    else currentLine.push({ text, className, match, current })
  }

  let segmentStart = 0
  for (const segment of pieces) {
    const renderSegment = (text: string, className: string, match = false, current = false) => {
      let start = 0
      while (start < text.length) {
        const newlineIndex = text.indexOf('\n', start)
        if (newlineIndex === -1) {
          appendPiece(text.slice(start), className, match, current)
          break
        }
        appendPiece(text.slice(start, newlineIndex + 1), className, match, current)
        lines.push([])
        start = newlineIndex + 1
      }
    }

    let cursor = segmentStart
    for (const match of matches) {
      const start = Math.max(cursor, match.start)
      const end = Math.min(segmentStart + segment.text.length, match.end)
      if (end <= cursor || start >= end) continue
      if (start > cursor) {
        renderSegment(segment.text.slice(cursor - segmentStart, start - segmentStart), segment.className)
      }
      renderSegment(
        segment.text.slice(start - segmentStart, end - segmentStart),
        segment.className,
        true,
        activeMatch?.start === match.start && activeMatch?.end === match.end,
      )
      cursor = end
    }
    if (cursor < segmentStart + segment.text.length) {
      renderSegment(segment.text.slice(cursor - segmentStart), segment.className)
    }
    segmentStart += segment.text.length
  }

  return lines
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
  find,
  onNavigate,
  onFindChange,
  activeKey = '',
  activeOffset = -1,
  activeRow,
}: {
  rows: Array<[string, string]>
  query: string
  setQuery(value: string): void
  limit: number
  setLimit(value: number): void
  firstColumn?: string
  secondColumn?: string
  find?: { open: boolean; query: string; total: number; current: number }
  onNavigate?(navigation: TextFindNavigation): void
  onFindChange?(open: boolean, query?: string): void
  activeKey?: string
  activeOffset?: number
  activeRow?: [string, string]
}) {
  const tableRef = useRef<HTMLDivElement>(null)
  let visible = rows.slice(0, limit)
  const canFind = find !== undefined && onNavigate !== undefined && onFindChange !== undefined
  if (canFind && find!.total > 0) {
    if (activeRow !== undefined && !visible.some(([key]) => key === activeKey)) {
      visible = [...visible, activeRow].toSorted(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    }
  }
  useEffect(() => {
    if (!find?.open || find.total === 0 || activeRow === undefined) return
    const frame = requestAnimationFrame(() => {
      tableRef.current?.querySelector('mark.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeKey, activeOffset, activeRow, find?.open, find?.query, find?.total])
  return (
    <section className="reader-section">
      {canFind && find!.open ? (
        <section aria-label="当前文件查找" className="source-find" role="search">
          <input
            aria-label="当前文件查找"
            autoFocus
            onChange={event => onFindChange!(true, event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onNavigate!(event.shiftKey ? 'previous' : 'next')
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onFindChange!(false)
              }
            }}
            value={find!.query}
          />
          <span>{find!.current.toLocaleString()} / {find!.total.toLocaleString()}</span>
          <button disabled={find!.total === 0} onClick={() => onNavigate!('previous')} type="button">上一个命中</button>
          <button disabled={find!.total === 0} onClick={() => onNavigate!('next')} type="button">下一个命中</button>
        </section>
      ) : null}
      <div className="inspection-toolbar">
        <label><span>搜索</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="字段或内容包含…" /></label>
        <span>显示 {visible.length.toLocaleString()} / {rows.length.toLocaleString()}</span>
      </div>
      <div
        ref={tableRef}
        className="table-scroll"
        onKeyDown={event => {
          if (!canFind || event.metaKey === event.ctrlKey || event.altKey || event.shiftKey) return
          if (event.key.toLowerCase() !== 'f') return
          event.preventDefault()
          onFindChange!(true)
        }}
        tabIndex={canFind ? 0 : undefined}
      >
        <table aria-label={`${firstColumn}列表`}>
          <thead><tr><th>{firstColumn}</th><th>{secondColumn}</th></tr></thead>
          <tbody>{visible.map(([key, value]) => (
            <tr key={key}>
              <td>{key}</td>
              <td title={value}>
                {canFind && find!.open && find!.query !== '' ? splitCellMatches(
                  value,
                  find!.query,
                  key === activeKey ? activeOffset : -1,
                ).map((piece, index) => piece.match ? (
                  <mark
                    aria-current={piece.current ? 'true' : undefined}
                    className={`find-match${piece.current ? ' current' : ''}`}
                    key={index}
                  >{piece.text}</mark>
                ) : <span key={index}>{piece.text}</span>) : value}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {visible.length < rows.length ? (
        <button className="load-more" type="button" onClick={() => setLimit(Math.min(limit + 1000, rows.length))}>再显示 1,000 项</button>
      ) : null}
    </section>
  )
}

function lineStartAt(content: string, offset: number): number {
  if (offset <= 0) return 0
  return Math.max(
    content.lastIndexOf('\n', offset - 1),
    content.lastIndexOf('\r', offset - 1),
  ) + 1
}

function splitCellMatches(value: string, query: string, activeOffset: number): Array<SourcePiece> {
  if (query === '') return [{ text: value, className: '', match: false, current: false }]
  const pieces: Array<SourcePiece> = []
  let cursor = 0
  forEachTextMatch(value, query, start => {
    const end = start + query.length
    if (start > cursor) pieces.push({ text: value.slice(cursor, start), className: '', match: false, current: false })
    pieces.push({ text: value.slice(start, end), className: '', match: true, current: start === activeOffset })
    cursor = end
  })
  if (cursor < value.length) pieces.push({ text: value.slice(cursor), className: '', match: false, current: false })
  return pieces
}
