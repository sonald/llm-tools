import { useState } from 'react'
import { formatBytes } from './core/huggingface.ts'
import type { Perspective } from './core/readers.ts'
import { formatNumber, translate as t } from './i18n.ts'
import { ResizeHandle } from './ResizeHandle.tsx'
import { JinjaEditor, TemplatePlayground } from './TemplatePlayground.tsx'

// Native JinjaWorkspaceView: one temporary source shared by 概览, 源码 and 试验台; nothing is written back.
export function TemplateWorkbench({ initialSource, perspective, onPerspectiveChange }: {
  initialSource: string
  perspective: 'overview' | 'source' | 'playground'
  onPerspectiveChange(perspective: Perspective): void
}) {
  const [source, setSource] = useState(initialSource)
  const [detailsWidth, setDetailsWidth] = useState(310)
  const modified = source !== initialSource
  const size = formatBytes(new TextEncoder().encode(source).byteLength)
  // Native counts every line, empty ones included; an empty template has none.
  const lines = formatNumber(source === '' ? 0 : source.split(/\r\n|[\n\r\u2028\u2029\u0085\v\f]/).length)

  if (perspective === 'playground') {
    return (
      <div className="jinja-playground">
        <TemplatePlayground template={source} onTemplateChange={setSource} originalTemplate={initialSource} tokenizerConfig={{}} />
      </div>
    )
  }
  if (perspective === 'source') {
    return (
      <div className="jinja-source">
        <section className="jinja-source-main">
          <header>
            <h2>{t('jinjaSourceTitle')}</h2>
            {modified ? <span className="jinja-modified">{t('jinjaModified')}</span> : null}
            <button type="button" disabled={!modified} onClick={() => setSource(initialSource)}>{t('jinjaRestoreSource')}</button>
          </header>
          <JinjaEditor value={source} onChange={setSource} label={t('jinjaSourceTitle')} />
        </section>
        <ResizeHandle axis="x" value={detailsWidth} min={260} max={390} onChange={setDetailsWidth} />
        <aside className="jinja-source-details" style={{ width: detailsWidth }}>
          <h2>{t('jinjaSourceDetails')}</h2>
          <dl className="property-group">
            {[[t('jinjaFormat'), 'Jinja'], [t('jinjaUtf8Size'), size], [t('jinjaLines'), lines],
              [t('jinjaStatus'), modified ? t('jinjaModified') : t('jinjaSourceOriginal')]].map(([key, value]) => (
              <div className="key-value-row" key={key}><dt>{key}</dt><dd>{value}</dd></div>
            ))}
          </dl>
          <p>{t('jinjaChangesNote')}</p>
        </aside>
      </div>
    )
  }
  const facts = [
    [t('jinjaUtf8Size'), size, modified ? t('jinjaOriginRuntime') : t('jinjaOriginRepository')],
    [t('jinjaLines'), lines, t('jinjaOriginDerived')],
    [t('jinjaSourceLabel'), t('jinjaModelFiles'), t('jinjaOriginRepository')],
    [t('jinjaCurrentState'), modified ? t('jinjaModified') : t('jinjaUnmodified'), t('jinjaOriginRuntime')],
  ]
  return (
    <div className="reader-summary jinja-overview">
      <header className="reader-title">
        <h2>Jinja Chat Template</h2>
        <p>{t('jinjaOverviewSubtitle')}</p>
      </header>
      <section className="inspection-facts">
        <h3>{t('summaryOverview')}</h3>
        <dl>
          {facts.map(([key, value, origin]) => (
            <div key={key}><dt>{key}</dt><dd>{value}</dd><span>{origin}</span></div>
          ))}
        </dl>
      </section>
      <div className="jinja-actions">
        <button type="button" onClick={() => onPerspectiveChange('source')}>{t('jinjaViewSource')}</button>
        <button type="button" className="primary-button" onClick={() => onPerspectiveChange('playground')}>{t('jinjaOpenPlayground')}</button>
      </div>
    </div>
  )
}

// Native EmbeddedTemplatePlaygroundView inside the tokenizer_config.json overview: its own template copy. Like
// SwiftUI DisclosureGroup content, it is built when opened and its edits are discarded when collapsed.
export function EmbeddedTemplatePlayground({ template, tokenizerConfig }: { template: string; tokenizerConfig: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="embedded-playground" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <strong>{t('templateEmbeddedPlaygroundTitle')}</strong>
        <span>{t('templateEmbeddedPlaygroundHint')}</span>
      </summary>
      {open ? <div className="embedded-playground-body"><EmbeddedTemplate template={template} tokenizerConfig={tokenizerConfig} /></div> : null}
    </details>
  )
}

function EmbeddedTemplate({ template, tokenizerConfig }: { template: string; tokenizerConfig: Record<string, unknown> }) {
  const [source, setSource] = useState(template)
  return <TemplatePlayground template={source} onTemplateChange={setSource} originalTemplate={template} tokenizerConfig={tokenizerConfig} />
}
