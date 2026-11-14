import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isFindShortcut } from './CodeReader.tsx'
import { MiddleTruncated } from './MiddleTruncated.tsx'
import { ggufFacts, ggufIsIMatrix, ggufModelName, ggufTensorSummaries, type GGUFOverview } from './core/gguf.ts'
import { formatBytes } from './core/huggingface.ts'
import { formatImatrixValue, type ImatrixSummary } from './core/imatrix.ts'
import {
  safeTensorsFacts,
  safeTensorsMetadata,
  type FieldOrigin,
  type InspectionField,
  type SafeTensorsSummary,
  type TensorSummary,
} from './core/inspectors.ts'
import type { Perspective } from './core/readers.ts'
import { buildTensorHierarchy, filterTensorSummaries, flattenTensorHierarchy } from './core/tensorHierarchy.ts'
import { formatNumber, translate as t } from './i18n.ts'
import { ResizeHandle } from './ResizeHandle.tsx'

type WorkspaceProps = { perspective: Perspective; onPerspectiveChange(perspective: Perspective): void }

export function SafeTensorsReader({ summary, headerBytes, ...props }: WorkspaceProps & { summary: SafeTensorsSummary; headerBytes: number }) {
  const facts = useMemo(() => safeTensorsFacts(summary, headerBytes), [summary, headerBytes])
  const metadata = useMemo(() => safeTensorsMetadata(summary), [summary])
  return <WeightWorkspace title={t('wtSafeTensorsTitle')} subtitle={t('wtSafeTensorsSubtitle')} facts={facts}
    metadata={metadata} tensors={summary.tensors} {...props} />
}

export function GGUFReader({ overview, bytesRead, ...props }: WorkspaceProps & { overview: GGUFOverview; bytesRead: number }) {
  const imatrix = ggufIsIMatrix(overview)
  const facts = useMemo(() => ggufFacts(overview, bytesRead), [overview, bytesRead])
  const metadata = useMemo(() => overview.metadata.map((entry): InspectionField => ({
    key: entry.key, type: entry.type, value: entry.display, origin: 'embedded',
  })), [overview])
  const tensors = useMemo(() => ggufTensorSummaries(overview), [overview])
  return (
    <WeightWorkspace
      title={imatrix ? 'GGUF Imatrix' : ggufModelName(overview) ?? t('wtGgufModelTitle')}
      subtitle={imatrix
        ? t('wtGgufImatrixSubtitle', { version: overview.version })
        : t('wtGgufSubtitle', { version: overview.version, endianness: overview.endianness === 'little' ? 'little-endian' : 'big-endian' })}
      facts={facts} metadata={metadata} tensors={tensors} {...props} />
  )
}

// Native InspectionField.Origin.title.
function originTitle(origin: FieldOrigin): string {
  switch (origin) {
    case 'embedded': return t('wtOriginEmbedded')
    case 'derived': return t('wtOriginDerived')
    case 'repository': return t('wtOriginRepository')
    case 'runtime': return t('wtOriginRuntime')
  }
}
const rowHeight = 28

// Native WeightWorkspaceView: 概览 facts, a Metadata table with a detail pane, and the Tensor outline with its own pane.
function WeightWorkspace({ title, subtitle, facts, metadata, tensors, perspective, onPerspectiveChange }: WorkspaceProps & {
  title: string
  subtitle: string
  facts: InspectionField[]
  metadata: InspectionField[]
  tensors: TensorSummary[]
}) {
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selectedTensor, setSelectedTensor] = useState<string | null>(null)
  const [showsTensorInspector, setShowsTensorInspector] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [paneWidth, setPaneWidth] = useState(310)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => setQuery(''), [perspective])
  // Native binds ⌘F to the search field of the open table.
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (!isFindShortcut(event) || search.current === null) return
      event.preventDefault()
      search.current.focus()
      search.current.select()
    }
    window.addEventListener('keydown', focus)
    return () => window.removeEventListener('keydown', focus)
  }, [])

  const filteredMetadata = useMemo(() => {
    if (query === '') return metadata
    const needle = query.toLocaleLowerCase()
    return metadata.filter(field => field.key.toLocaleLowerCase().includes(needle) || field.value.toLocaleLowerCase().includes(needle))
  }, [metadata, query])
  const filteredTensors = useMemo(() => filterTensorSummaries(tensors, query), [tensors, query])
  const hierarchy = useMemo(() => buildTensorHierarchy(filteredTensors), [filteredTensors])
  const tensorRows = useMemo(() => flattenTensorHierarchy(hierarchy, expanded), [hierarchy, expanded])

  if (perspective === 'metadata') {
    const field = metadata.find(item => item.key === selectedKey) ?? null
    const detail = <MetadataDetail field={field} />
    return (
      <div className="wt-workspace"><div className="wt-split">
        <section className="wt-main">
          <TableBar title="Metadata" count={filteredMetadata.length}>
            <input ref={search} className="wt-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
              placeholder={t('wtSearchMetadata')} aria-label={t('wtSearchMetadata')} />
          </TableBar>
          <VirtualTable label="Metadata" className="wt-metadata-table" count={filteredMetadata.length}
            columns={[t('wtFieldColumn'), t('wtTypeColumn'), t('wtValueColumn'), t('wtSourceColumn')]}
            isSelected={index => filteredMetadata[index].key === selectedKey}
            onSelect={index => setSelectedKey(filteredMetadata[index].key)}
            row={index => {
              const item = filteredMetadata[index]
              return [item.key, item.type, <span className="wt-mono">{item.value}</span>, <span className="wt-muted">{originTitle(item.origin)}</span>]
            }} />
        </section>
        {/* Native HSplitView: the metadata inspector is an in-view pane, like the tensor one. */}
        <ResizeHandle axis="x" value={paneWidth} min={260} max={390} onChange={setPaneWidth} />
        <aside className="wt-pane" style={{ '--wt-pane-width': `${paneWidth}px` } as React.CSSProperties}>{detail}</aside>
      </div></div>
    )
  }

  if (perspective === 'tensors') {
    const tensor = tensors.find(item => item.name === selectedTensor) ?? null
    const detailsLabel = showsTensorInspector ? t('wtHideDetails') : t('wtShowDetails')
    return (
      <div className="wt-workspace"><div className="wt-split">
        <section className="wt-main">
          <TableBar title="Tensors" count={filteredTensors.length}>
            <button type="button" className="wt-plain-button" title={t('wtCollapseAll')} onClick={() => setExpanded(new Set())}>
              <ChevronIcon direction="up" />{t('wtCollapseAll')}
            </button>
            <input ref={search} className="wt-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
              placeholder={t('wtSearchTensors')} aria-label={t('wtSearchTensors')} />
            <button type="button" className="wt-icon-button" aria-label={detailsLabel}
              title={showsTensorInspector ? t('wtHideDetailsHelp') : t('wtShowDetailsHelp')}
              onClick={() => setShowsTensorInspector(shown => !shown)}><PaneIcon open={showsTensorInspector} /></button>
          </TableBar>
          {selectedTensor !== null ? (
            <div className="wt-breadcrumb">
              <ChevronIcon direction="right" /><MiddleTruncated text={selectedTensor.split('.').filter(Boolean).join(' › ')} />
            </div>
          ) : null}
          <VirtualTable label="Tensors" className="wt-tensor-table" count={tensorRows.length}
            columns={[t('wtNameColumn'), 'Shape', t('wtTypeColumn'), t('wtParametersColumn')]}
            isSelected={index => rowSelectionId(tensorRows[index]) === selectedTensor}
            onSelect={index => setSelectedTensor(rowSelectionId(tensorRows[index]))}
            row={index => {
              const row = tensorRows[index]
              const indent = { paddingLeft: `${row.depth * 16}px` }
              if (row.children.length > 0 || row.tensor === undefined) {
                const open = expanded.has(row.id)
                return [
                  <span className="wt-group" style={indent}>
                    <button type="button" className="wt-disclosure" aria-expanded={open}
                      aria-label={open ? t('wtCollapseGroup', { label: row.path }) : t('wtExpandGroup', { label: row.path })}
                      onClick={event => {
                        event.stopPropagation()
                        setExpanded(current => {
                          const next = new Set(current)
                          if (!next.delete(row.id)) next.add(row.id)
                          return next
                        })
                      }}><ChevronIcon direction={open ? 'down' : 'right'} /></button>
                    <FolderIcon />{row.label}<span className="wt-muted">{t('wtTensorGroupCount', { count: formatNumber(row.descendantCount) })}</span>
                  </span>,
                ]
              }
              const leaf = row.tensor
              return [
                <span className="wt-leaf" style={indent} title={leaf.name}>{row.label}</span>,
                shapeText(leaf.shape), leaf.dtype, formatNumber(leaf.parameters),
              ]
            }} />
        </section>
        {showsTensorInspector ? (
          <>
            <ResizeHandle axis="x" value={paneWidth} min={260} max={390} onChange={setPaneWidth} />
            <aside className="wt-pane" style={{ '--wt-pane-width': `${paneWidth}px` } as React.CSSProperties}>
              <TensorDetail tensor={tensor} onHide={() => setShowsTensorInspector(false)} />
            </aside>
          </>
        ) : null}
      </div></div>
    )
  }

  return (
    <div className="reader-summary wt-overview">
      <header className="reader-title">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </header>
      <FactsTable fields={facts} />
      {metadata.length > 0 ? (
        <button type="button" className="wt-button" onClick={() => onPerspectiveChange('metadata')}>
          {metadata.length === 1
            ? t('wtViewAllMetadataOne', { count: formatNumber(metadata.length) })
            : t('wtViewAllMetadata', { count: formatNumber(metadata.length) })}
        </button>
      ) : null}
      <button type="button" className="wt-button" onClick={() => onPerspectiveChange('tensors')}>
        {tensors.length === 1
          ? t('wtViewAllTensorsOne', { count: formatNumber(tensors.length) })
          : t('wtViewAllTensors', { count: formatNumber(tensors.length) })}
      </button>
    </div>
  )
}

// Native List selection id: the tensor's name for a leaf, the dotted path for a group.
function rowSelectionId(row: { path: string; tensor?: TensorSummary }): string {
  return row.tensor?.name ?? row.path
}

function shapeText(shape: readonly bigint[]): string {
  return `[${shape.map(String).join(', ')}]`
}

function FactsTable({ fields }: { fields: InspectionField[] }) {
  return (
    <section className="inspection-facts">
      <h3>{t('summaryOverview')}</h3>
      <dl>
        {fields.map(field => (
          <div key={field.key}><dt>{field.key}</dt><dd>{field.value}</dd><span>{originTitle(field.origin)}</span></div>
        ))}
      </dl>
    </section>
  )
}

function TableBar({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <header className="wt-bar">
      <h2>{title}</h2>
      <span className="wt-count">{count === 1 ? t('wtItemCountOne', { count: formatNumber(count) }) : t('wtItemCount', { count: formatNumber(count) })}</span>
      <span className="wt-spacer" />
      {children}
    </header>
  )
}

function MetadataDetail({ field }: { field: InspectionField | null }) {
  if (field === null) {
    return <PaneEmpty icon={<ListIcon />} title={t('wtSelectMetadata')} message={t('wtSelectMetadataMessage')} />
  }
  return (
    <div className="wt-detail">
      <h2>{t('wtFieldDetails')}</h2>
      <PropertyRows rows={[['Key', field.key], [t('wtTypeColumn'), field.type], [t('wtSourceColumn'), originTitle(field.origin)]]} />
      <hr />
      <h2>{t('wtFullValue')}</h2>
      <p className="wt-full-value">{field.value}</p>
    </div>
  )
}

function TensorDetail({ tensor, onHide }: { tensor: TensorSummary | null; onHide(): void }) {
  if (tensor === null) {
    return <PaneEmpty icon={<StackIcon />} title={t('wtSelectTensor')} message={t('wtSelectTensorMessage')} />
  }
  const maximumInt64 = (1n << 63n) - 1n
  const rows: Array<[string, string]> = [
    ['Shape', shapeText(tensor.shape)],
    [t('wtTypeColumn'), tensor.dtype],
    [t('wtParametersColumn'), formatNumber(tensor.parameters)],
  ]
  if (tensor.bytes !== null) rows.push([t('wtDataSize'), formatBytes(Number(tensor.bytes > maximumInt64 ? maximumInt64 : tensor.bytes))])
  if (tensor.offset !== null) rows.push([t('wtDataOffset'), formatNumber(tensor.offset)])
  return (
    <div className="wt-detail">
      <div className="wt-detail-header">
        <h2>{t('wtTensorDetails')}</h2>
        <button type="button" className="wt-icon-button" aria-label={t('wtHide')} title={t('wtHideDetailsHelp')} onClick={onHide}>
          <PaneIcon open />
        </button>
      </div>
      <p className="wt-full-value">{tensor.name}</p>
      <PropertyRows rows={rows} />
      <p className="wt-note">{t('wtTensorNote')}</p>
    </div>
  )
}

function PropertyRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="property-group">
      {rows.map(([key, value]) => <div className="key-value-row" key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
    </dl>
  )
}

function PaneEmpty({ icon, title, message }: { icon: ReactNode; title: string; message: string }) {
  return (
    <div className="empty-state wt-empty">
      {icon}
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  )
}

// Native IMatrixWorkspaceView: 概览 facts and the Entries table.
export function ImatrixReader({ summary, perspective }: { summary: ImatrixSummary; perspective: Perspective }) {
  const [query, setQuery] = useState('')
  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle === '' ? summary.entries : summary.entries.filter(entry => entry.name.toLocaleLowerCase().includes(needle))
  }, [query, summary.entries])
  if (perspective === 'entries') {
    return (
      <div className="wt-main wt-imatrix-entries">
        <header className="wt-filter-bar">
          <SearchIcon />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder={t('wtFilterTensors')} aria-label={t('wtFilterTensors')} />
          <span className="wt-count">{`${formatNumber(entries.length)} / ${formatNumber(summary.entries.length)}`}</span>
        </header>
        <VirtualTable label="Entries" className="wt-imatrix-table" count={entries.length}
          columns={['Tensor', 'Calls', 'Values', 'Mean', 'Min', 'Max']}
          row={index => {
            const entry = entries[index]
            return [entry.name, formatNumber(entry.callCount), formatNumber(entry.valueCount),
              formatImatrixValue(entry.mean), formatImatrixValue(entry.minimum), formatImatrixValue(entry.maximum)]
          }} />
      </div>
    )
  }
  const notRecorded = t('wtNotRecorded')
  const facts: Array<[string, string]> = [
    [t('wtEntryCount'), formatNumber(summary.entries.length)],
    [t('wtChunkCount'), summary.chunkCount === null ? notRecorded : formatNumber(summary.chunkCount)],
    [t('wtDataset'), summary.dataset ?? notRecorded],
    [t('wtFileSize'), formatBytes(summary.byteCount)],
  ]
  return (
    <div className="wt-imatrix-overview">
      <header className="reader-title prominent">
        <h2>Importance Matrix</h2>
        <p>{t('wtImatrixSubtitle')}</p>
      </header>
      <dl className="wt-fact-grid">
        {facts.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
      </dl>
    </div>
  )
}

// Every row exists in the model; only the rows in view (plus a margin) are in the DOM (rulings D-4/D-5/D-6).
function VirtualTable({ label, className, columns, count, row, isSelected, onSelect }: {
  label: string
  className: string
  columns: string[]
  count: number
  row(index: number): ReactNode[]
  isSelected?(index: number): boolean
  onSelect?(index: number): void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 600 })
  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null) return
    const observer = new ResizeObserver(() => setView({ top: element.scrollTop, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // Native Table: ↑/↓ move the selection; the focused row follows it through the virtual window.
  const pendingFocus = useRef<number | null>(null)
  useLayoutEffect(() => {
    const index = pendingFocus.current
    if (index === null) return
    const element = scroller.current?.querySelector<HTMLElement>(`[role="row"][aria-rowindex="${index + 2}"]`)
    if (element) { pendingFocus.current = null; element.focus({ preventScroll: true }) }
  })
  const first = Math.max(0, Math.floor(view.top / rowHeight) - 10)
  const last = Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + 10)
  const rows: ReactNode[] = []
  for (let index = first; index < last; index += 1) {
    const selected = isSelected?.(index) ?? false
    rows.push(
      <div key={index} role="row" aria-rowindex={index + 2} aria-selected={onSelect === undefined ? undefined : selected}
        tabIndex={onSelect === undefined ? undefined : 0} className={`wt-row${selected ? ' selected' : ''}`}
        onClick={() => onSelect?.(index)}
        onKeyDown={event => {
          if (onSelect === undefined || event.target !== event.currentTarget) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const next = index + (event.key === 'ArrowDown' ? 1 : -1)
            event.preventDefault()
            if (next < 0 || next >= count) return
            const element = scroller.current!
            const top = rowHeight + next * rowHeight
            if (top < element.scrollTop + rowHeight) element.scrollTop = top - rowHeight
            else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight
            pendingFocus.current = next
            onSelect(next)
            return
          }
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onSelect(index)
        }}>
        {row(index).map((cell, column) => <span role="cell" key={column}>{cell}</span>)}
      </div>,
    )
  }
  return (
    <div className={`wt-table ${className}`} ref={scroller} role="table" aria-label={label} aria-rowcount={count + 1}
      onScroll={event => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <div className="wt-table-body" style={{ height: rowHeight + count * rowHeight }}>
        <div className="wt-table-header" role="row" aria-rowindex={1}>
          {columns.map(column => <span role="columnheader" key={column}>{column}</span>)}
        </div>
        <div style={{ transform: `translateY(${first * rowHeight}px)` }}>{rows}</div>
      </div>
    </div>
  )
}

// Line drawings for the native SF Symbols used here.
function ChevronIcon({ direction }: { direction: 'up' | 'down' | 'right' }) {
  const d = { up: 'M3 10 8 5l5 5', down: 'M3 6l5 5 5-5', right: 'M6 3l5 5-5 5' }[direction]
  return <svg className="wt-icon" viewBox="0 0 16 16" aria-hidden="true"><path d={d} /></svg>
}

function PaneIcon({ open }: { open: boolean }) {
  return (
    <svg className="wt-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d={open ? 'M10 2.5v11M4 8h4M6 6l2 2-2 2' : 'M6 2.5v11M12 8H8M10 6 8 8l2 2'} />
    </svg>
  )
}

function FolderIcon() {
  return <svg className="wt-icon wt-folder" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5v8h13v-7H7.5L6 4H1.5z" /></svg>
}

function SearchIcon() {
  return <svg className="wt-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
}

function ListIcon() {
  return (
    <svg className="state-icon" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="6" width="24" height="20" rx="3" /><path d="M9 12h1M9 16h1M9 20h1M13 12h10M13 16h10M13 20h10" />
    </svg>
  )
}

function StackIcon() {
  return (
    <svg className="state-icon" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 4 28 10 16 16 4 10z" /><path d="M4 16l12 6 12-6M4 22l12 6 12-6" />
    </svg>
  )
}
