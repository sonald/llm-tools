import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { highlightJsonWindow } from './core/jsonSource.ts'
import { forEachTextMatch, navigateTextMatches, sourceChunks, textLineAtOffset, type SourceChunk } from './core/readers.ts'
import { foldRanges, type FoldRange } from './core/sourceFolding.ts'
import { formatNumber, translate as t } from './i18n.ts'

export type SourceMark = { line: number; severity: 'warning' | 'info' }
// A new nonce re-jumps to the same line (native CodeReaderJump).
export type SourceJump = { line: number; nonce: number }

type Segment = { text: string; className: string }
type Piece = { text: string; className: string; match: boolean; current: boolean }
type Range = { start: number; end: number }
type Find = { open: boolean; query: string; current: number }

const closedFind: Find = { open: false, query: '', current: 0 }
const lineHeight = 19

/**
 * Native CodeReaderView / PlainTextReaderView: the whole document, never paged.
 * Every chunk stays in the DOM as plain text (so the text is complete and the browser skips offscreen layout);
 * chunks near the viewport, or holding a find hit, a jump target, a mark or a fold, render line by line.
 * `language === null` is the wrapped plain-text reader: no highlighting, no folding.
 */
export function CodeReader({ content, language, label, marks = [], jump = null }: {
  content: string
  language: string | null
  label: string
  marks?: SourceMark[]
  jump?: SourceJump | null
}) {
  const plain = language === null
  const chunks = useMemo(() => sourceChunks(content), [content])
  const ranges = useMemo(() => (plain ? [] : foldRanges(content, language)), [content, language, plain])
  const prism = usePrismSegments(content, language)
  // JSON highlights per chunk; a chunk that starts mid-line re-scans from the top, so keep each result.
  const jsonSegments = useMemo(() => new Map<number, Segment[]>(), [content])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [seen, setSeen] = useState<Set<number>>(() => new Set([0]))
  const [find, setFind] = useState<Find>(closedFind)
  const preRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    setCollapsed(new Set())
    setSeen(new Set([0]))
    setFind(closedFind)
  }, [content, language])

  const result = useMemo(() => navigateTextMatches(content, find.open ? find.query : '', 'next', Math.max(find.current, 1) - 1),
    [content, find.current, find.open, find.query])
  const activeMatch: Range | null = result.total === 0 ? null : { start: result.start, end: result.end }
  const activeLine = activeMatch === null ? 0 : textLineAtOffset(content, activeMatch.start)

  const collapsedRanges = useMemo(() => ranges.filter(range => collapsed.has(foldKey(range))), [collapsed, ranges])
  const hiddenLines = useMemo(() => {
    const hidden = new Set<number>()
    for (const range of collapsedRanges) for (let line = range.startLine + 1; line <= range.endLine; line += 1) hidden.add(line)
    return hidden
  }, [collapsedRanges])
  const foldsByLine = useMemo(() => {
    const byLine = new Map<number, FoldRange[]>()
    for (const range of ranges) byLine.set(range.startLine, [...(byLine.get(range.startLine) ?? []), range])
    return byLine
  }, [ranges])
  const marksByLine = useMemo(() => {
    const byLine = new Map<number, SourceMark['severity']>()
    for (const mark of marks) if (byLine.get(mark.line) !== 'warning') byLine.set(mark.line, mark.severity)
    return byLine
  }, [marks])

  // Chunks that must render line by line regardless of scroll position: a fold's two ends may cut a chunk,
  // while a pending chunk wholly inside a fold is hidden as a block.
  const forced = useMemo(() => {
    const lines = [jump?.line ?? 0, ...marksByLine.keys(), ...collapsedRanges.flatMap(range => [range.startLine, range.endLine])]
    const indexes = lines.filter(line => line > 0).map(line => chunkOfLine(chunks, content, line))
    // A find hit may sit deep inside one long line, so locate its chunk by offset.
    if (activeMatch !== null) indexes.push(chunks.findLastIndex(chunk => chunk.start <= activeMatch.start))
    return new Set(indexes)
  }, [activeMatch?.start, chunks, collapsedRanges, content, jump?.line, marksByLine])

  // Reveal what the current find hit sits inside.
  useEffect(() => {
    if (activeMatch === null) return
    setCollapsed(current => unfoldAround(current, ranges, activeLine))
    const frame = requestAnimationFrame(() => {
      preRef.current?.querySelector('mark.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeLine, activeMatch?.start, ranges]) // eslint-disable-line react-hooks/exhaustive-deps

  // Native jump: unfold, put the line a third of the way down, place the caret there and flash it.
  useEffect(() => {
    if (jump === null) return
    setCollapsed(current => unfoldAround(current, ranges, jump.line))
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const pre = preRef.current
        const line = pre?.querySelector<HTMLElement>(`[data-line="${jump.line}"]`)
        if (pre === null || pre === undefined || line === null || line === undefined) return
        pre.scrollTop = Math.max(0, line.getBoundingClientRect().top - pre.getBoundingClientRect().top + pre.scrollTop - pre.clientHeight / 3)
        pre.focus({ preventScroll: true })
        const text = line.querySelector('.line-text')
        if (text !== null) {
          getSelection()?.collapse(text, 0)
          text.classList.remove('flash')
          void (text as HTMLElement).offsetWidth
          text.classList.add('flash')
        }
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [jump]) // only a new jump re-runs it

  // Track chunks as they come near the viewport; they stay rendered afterwards.
  useEffect(() => {
    const pre = preRef.current
    if (pre === null) return
    const observer = new IntersectionObserver(entries => {
      const reached = entries.filter(entry => entry.isIntersecting).map(entry => Number((entry.target as HTMLElement).dataset.chunk))
        // ponytail: pieces of an over-long (minified) line stay plain text when scrolled to; dozens of 64K-character
        // rows sit on screen at once and highlighting them all costs seconds. Find, jump and marks still render them.
        .filter(index => !partOfLongLine(content, chunks[index]))
      if (reached.length > 0) setSeen(current => reached.every(index => current.has(index)) ? current : new Set([...current, ...reached]))
    }, { root: pre, rootMargin: '800px 0px' })
    pre.querySelectorAll('.source-chunk').forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [chunks, content])

  const navigateFind = (navigation: 'next' | 'previous') => setFind(state => ({
    ...state, current: navigateTextMatches(content, state.query, navigation, result.current).current,
  }))
  const highlighted = plain ? false : language === 'json' || prism !== null

  return (
    <div className="source-code-panel">
      {ranges.length > 0 ? (
        <div className="fold-toolbar">
          <button type="button" onClick={() => setCollapsed(new Set())}>{t('readerExpandAllFolds')}</button>
        </div>
      ) : null}
      {find.open ? (
        <FindBar query={find.query} current={result.current} total={result.total}
          onQuery={query => setFind({ ...closedFind, open: true, query })} onNavigate={navigateFind}
          onClose={() => {
            setFind(closedFind)
            preRef.current?.focus()
          }} />
      ) : null}
      <pre
        ref={preRef}
        aria-label={label}
        className={`source-reader standalone code-reader${plain ? ' plain-text' : ''}`}
        data-language={language ?? 'text'}
        data-highlighted={highlighted}
        tabIndex={0}
        onKeyDown={event => {
          if (!isFindShortcut(event)) return
          event.preventDefault()
          setFind(state => state.open ? state : { ...closedFind, open: true })
        }}
      >
        {chunks.map((chunk, index) => {
          const text = content.slice(chunk.start, chunk.end)
          if (!seen.has(index) && !forced.has(index)) {
            return (
              <div className="source-chunk pending" data-chunk={index} key={index}
                hidden={collapsedRanges.some(range => range.startLine < chunk.firstLine && chunk.firstLine + chunk.lineCount - 1 <= range.endLine)}
                style={{ containIntrinsicBlockSize: `auto ${estimateHeight(chunk, plain)}px` }}>{text}</div>
            )
          }
          const segments = plain ? null
            : language === 'json' ? cached(jsonSegments, index, () => highlightJsonWindow(content, chunk.start, chunk.end))
              : prism === null ? null : sliceSegments(prism, chunk.start, chunk.end)
          const matches: Range[] = []
          if (find.open && find.query !== '') {
            forEachTextMatch(text, find.query, start => { matches.push({ start, end: start + find.query.length }) })
          }
          const current = activeMatch !== null && activeMatch.start >= chunk.start && activeMatch.start < chunk.end
            ? { start: activeMatch.start - chunk.start, end: activeMatch.end - chunk.start } : null
          const lines = splitLines(text, segments, matches, current)
          if (index < chunks.length - 1 && lines.length > chunk.lineCount) lines.pop()
          const continued = continues(content, chunk)
          return (
            // A forced chunk is laid out even off screen, so jump and find measure real positions.
            <div className={`source-chunk${forced.has(index) ? ' forced' : ''}`} data-chunk={index} key={index}
              style={{ containIntrinsicBlockSize: `auto ${estimateHeight(chunk, plain)}px` }}>
              {lines.map((line, lineIndex) => {
                const lineNumber = chunk.firstLine + lineIndex
                const folds = lineIndex === 0 && continued ? undefined : foldsByLine.get(lineNumber)
                const severity = marksByLine.get(lineNumber)
                return (
                  <span className="source-line" data-line={lineNumber} hidden={hiddenLines.has(lineNumber)} key={lineNumber}>
                    {folds !== undefined ? (
                      <span className="fold-markers">
                        {folds.map(range => {
                          const isCollapsed = collapsed.has(foldKey(range))
                          const action = t('readerFoldStructureLine', {
                            action: isCollapsed ? t('readerExpandAction') : t('readerCollapseAction'),
                            line: formatNumber(range.startLine),
                          })
                          return (
                            <button aria-label={action} title={action} type="button" key={foldKey(range)}
                              className={`fold-marker${isCollapsed ? ' collapsed' : ''}`}
                              data-collapsed={isCollapsed || undefined} data-hidden-lines={range.endLine - range.startLine}
                              onClick={() => setCollapsed(state => {
                                const next = new Set(state)
                                if (!next.delete(foldKey(range))) next.add(foldKey(range))
                                return next
                              })} />
                          )
                        })}
                      </span>
                    ) : null}
                    <span className="line-text" data-severity={severity}>
                      {line.map((piece, pieceIndex) => {
                        const body = piece.className === '' ? piece.text : <span className={piece.className}>{piece.text}</span>
                        return piece.match
                          ? <mark key={pieceIndex} aria-current={piece.current ? 'true' : undefined}
                            className={`find-match${piece.current ? ' current' : ''}`}>{body}</mark>
                          : piece.className === '' ? <span key={pieceIndex}>{piece.text}</span> : <span key={pieceIndex} className={piece.className}>{piece.text}</span>
                      })}
                    </span>
                  </span>
                )
              })}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

// The in-file find bar shared by every reader (Enter / Shift+Enter navigate, Escape closes).
export function FindBar({ query, current, total, onQuery, onNavigate, onClose }: {
  query: string
  current: number
  total: number
  onQuery(query: string): void
  onNavigate(navigation: 'next' | 'previous'): void
  onClose(): void
}) {
  return (
    <section aria-label={t('readerCurrentFileFind')} className="source-find" role="search">
      <input
        aria-label={t('readerCurrentFileFind')}
        autoFocus
        onChange={event => onQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onNavigate(event.shiftKey ? 'previous' : 'next')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        value={query}
      />
      <span>{formatNumber(current)} / {formatNumber(total)}</span>
      <button disabled={total === 0} onClick={() => onNavigate('previous')} type="button">{t('readerPreviousMatch')}</button>
      <button disabled={total === 0} onClick={() => onNavigate('next')} type="button">{t('readerNextMatch')}</button>
    </section>
  )
}

// Opens the find bar on ⌘F / Ctrl+F.
export function isFindShortcut(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string }) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f'
}

// Prism runs in a Worker over the whole file; the caller only routes ≤128 KB sources here (native rule).
function usePrismSegments(content: string, language: string | null): Segment[] | null {
  const [state, setState] = useState<{ content: string; language: string; segments: Segment[] } | null>(null)
  useLayoutEffect(() => {
    if (language === null || language === 'json') return
    let active = true
    const worker = new Worker(new URL('./sourceHighlight.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<unknown>) => {
      worker.terminate()
      const segments = validateSegments(event.data, content)
      if (active && segments !== null) setState({ content, language, segments })
    }
    worker.onerror = event => {
      event.preventDefault()
      worker.terminate()
    }
    worker.postMessage({ content, language })
    return () => {
      active = false
      worker.terminate()
    }
  }, [content, language])
  return state !== null && state.content === content && state.language === language ? state.segments : null
}

function validateSegments(reply: unknown, expected: string): Segment[] | null {
  if (typeof reply !== 'object' || reply === null || (reply as { ok?: unknown }).ok !== true) return null
  const segments = (reply as { segments?: unknown }).segments
  if (!Array.isArray(segments)) return null
  let joined = ''
  for (const segment of segments) {
    if (typeof segment?.text !== 'string' || typeof segment?.className !== 'string') return null
    joined += segment.text
  }
  return joined === expected ? segments as Segment[] : null
}

function sliceSegments(segments: Segment[], start: number, end: number): Segment[] {
  const sliced: Segment[] = []
  let offset = 0
  for (const segment of segments) {
    const segmentEnd = offset + segment.text.length
    if (segmentEnd > start && offset < end) {
      sliced.push({ text: segment.text.slice(Math.max(0, start - offset), end - offset), className: segment.className })
    }
    if (segmentEnd >= end) break
    offset = segmentEnd
  }
  return sliced
}

function splitLines(content: string, segments: Segment[] | null, matches: Range[], current: Range | null): Piece[][] {
  const lines: Piece[][] = [[]]
  const append = (text: string, className: string, match: boolean, isCurrent: boolean) => {
    const breaks = /\r\n|\r|\n/g
    let start = 0
    for (let found = breaks.exec(text); found !== null; found = breaks.exec(text)) {
      push(text.slice(start, found.index + found[0].length))
      lines.push([])
      start = found.index + found[0].length
    }
    if (start < text.length) push(text.slice(start))
    function push(part: string) {
      const line = lines[lines.length - 1]
      const last = line.at(-1)
      if (last !== undefined && last.className === className && last.match === match && last.current === isCurrent) last.text += part
      else line.push({ text: part, className, match, current: isCurrent })
    }
  }
  let offset = 0
  let matchIndex = 0
  for (const segment of segments ?? [{ text: content, className: '' }]) {
    const segmentEnd = offset + segment.text.length
    let cursor = offset
    while (matchIndex < matches.length && matches[matchIndex].end <= offset) matchIndex += 1
    for (let index = matchIndex; index < matches.length && matches[index].start < segmentEnd; index += 1) {
      const start = Math.max(cursor, matches[index].start)
      const end = Math.min(segmentEnd, matches[index].end)
      if (end <= start) continue
      if (start > cursor) append(segment.text.slice(cursor - offset, start - offset), segment.className, false, false)
      append(segment.text.slice(start - offset, end - offset), segment.className, true,
        current !== null && current.start === matches[index].start)
      cursor = end
    }
    if (cursor < segmentEnd) append(segment.text.slice(cursor - offset), segment.className, false, false)
    offset = segmentEnd
  }
  return lines
}

function cached<T>(cache: Map<number, T>, key: number, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make())
  return cache.get(key)!
}

// The chunk where `line` starts (a long line may continue into later chunks).
function chunkOfLine(chunks: SourceChunk[], content: string, line: number): number {
  let low = 0
  let high = chunks.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (chunks[middle].firstLine <= line) low = middle
    else high = middle - 1
  }
  while (low > 0 && chunks[low].firstLine === line && continues(content, chunks[low])) low -= 1
  return low
}

function partOfLongLine(content: string, chunk: SourceChunk): boolean {
  const last = content[chunk.end - 1]
  return continues(content, chunk) || (chunk.end < content.length && last !== '\n' && last !== '\r')
}

// True when the chunk starts mid-line, continuing the previous chunk's last line.
function continues(content: string, chunk: SourceChunk): boolean {
  return chunk.start > 0 && content[chunk.start - 1] !== '\n' && content[chunk.start - 1] !== '\r'
}

function unfoldAround(current: Set<string>, ranges: FoldRange[], line: number): Set<string> {
  const next = new Set([...current].filter(key => !ranges.some(range => (
    foldKey(range) === key && range.startLine < line && line <= range.endLine
  ))))
  return next.size === current.size ? current : next
}

function foldKey(range: FoldRange) {
  return `${range.startLine}:${range.endLine}`
}

// Reserved height for a chunk the browser has not laid out yet; wrapped text guesses ~100 characters a row.
function estimateHeight(chunk: SourceChunk, plain: boolean): number {
  const rows = plain ? Math.max(chunk.lineCount, Math.ceil((chunk.end - chunk.start) / 100)) : chunk.lineCount
  return rows * lineHeight
}
