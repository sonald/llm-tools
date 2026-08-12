import { useMemo, useRef, useState } from 'react'
import { formatBytes, type RepositorySnapshot } from './core/huggingface.ts'
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
  const [copyLabel, setCopyLabel] = useState('复制输出')
  const generation = useRef(0)
  const sourceBytes = new TextEncoder().encode(source).byteLength
  const outputLines = useMemo(() => output.split('\n'), [output])

  function changeSource(value: string) {
    generation.current += 1
    setSource(value)
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
      if (!Array.isArray(parsedMessages)) throw new Error('Messages 必须是 JSON 数组。')
      if (!Array.isArray(parsedTools)) throw new Error('Tools 必须是 JSON 数组。')
      if (!isRecord(parsedVariables)) throw new Error('Typed Variables 必须是 JSON 对象。')
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
      setCopyLabel('复制输出')
      setPhase('ready')
    } catch (failure) {
      if (generation.current !== activeGeneration) return
      setError(failure instanceof Error ? failure.message : String(failure))
      setOutput('')
      setPhase('error')
    }
  }

  const views: Array<[typeof view, string]> = config === null
    ? [['overview', '概览'], ['source', '源码'], ['playground', '试验台']]
    : [['config', '配置'], ['overview', '模板概览'], ['source', '源码'], ['playground', '试验台']]
  return (
    <div className="template-workspace">
      <div className="tokenizer-tabs" role="tablist" aria-label="Template 视图">
        {views.map(([value, label]) => <button type="button" role="tab" aria-selected={view === value} onClick={() => setView(value)} key={value}>{label}</button>)}
      </div>
      {view === 'config' && config !== null ? (
        <TextInspection snapshot={snapshot} path={config.path} content={config.content} parsed={config.parsed} json bytesRead={config.bytesRead} />
      ) : null}
      {view === 'overview' ? (
        <div className="inspection-canvas">
          <dl className="validation-strip">
            <div><dt>模板来源</dt><dd>{sourceOrigin}</dd></div>
            <div><dt>源码大小</dt><dd>{formatBytes(sourceBytes)}</dd></div>
            <div><dt>读取总量</dt><dd>{formatBytes(bytesRead)}</dd></div>
          </dl>
          <dl className="metric-grid">
            <div><dt>行数</dt><dd>{source.split('\n').length.toLocaleString()}</dd></div>
            <div><dt>Jinja 表达式</dt><dd>{(source.match(/{{/g) ?? []).length.toLocaleString()}</dd></div>
            <div><dt>Jinja 语句</dt><dd>{(source.match(/{%/g) ?? []).length.toLocaleString()}</dd></div>
            <div><dt>修改状态</dt><dd>{source === initialSource ? '来源原文' : '临时修改'}</dd></div>
          </dl>
          <p className="scope-note">模板只在 Web Worker 中执行；不支持 include，不执行 JavaScript，不写回仓库。</p>
        </div>
      ) : null}
      {view === 'source' ? (
        <div className="template-source">
          <header><span>{sourceOrigin} · {source.split('\n').length} 行 · {formatBytes(sourceBytes)} · {source === initialSource ? '来源原文' : '已修改'}</span><button type="button" onClick={() => changeSource(initialSource)} disabled={source === initialSource}>恢复来源</button></header>
          <textarea aria-label="Jinja 源码" value={source} onChange={event => changeSource(event.target.value)} spellCheck={false} />
          <pre className="jinja-highlight" aria-label="Jinja 高亮预览"><HighlightedJinja source={source} /></pre>
        </div>
      ) : null}
      {view === 'playground' ? (
        <div className="template-playground">
          <section className="template-inputs">
            <label>Preset<select value={preset} onChange={event => choosePreset(event.target.value as keyof typeof presets)}>
              <option value="basic">基础对话</option><option value="tools">Tools</option><option value="multimodal">多模态</option>
            </select></label>
            <label>Messages<textarea aria-label="Template Messages" value={messages} onChange={event => changePlaygroundInput(() => setMessages(event.target.value))} /></label>
            <label>Tools<textarea aria-label="Template Tools" value={tools} onChange={event => changePlaygroundInput(() => setTools(event.target.value))} /></label>
            <label>Typed Variables<textarea aria-label="Template Variables" value={variables} onChange={event => changePlaygroundInput(() => setVariables(event.target.value))} /></label>
            <footer><label className="checkbox"><input type="checkbox" checked={addGenerationPrompt} onChange={event => changePlaygroundInput(() => setAddGenerationPrompt(event.target.checked))} />add_generation_prompt</label><button className="primary-button" type="button" onClick={render} disabled={phase === 'loading'}>{phase === 'loading' ? '渲染中…' : '渲染'}</button></footer>
          </section>
          <section className="template-output" aria-live="polite">
            <header>
              <h2>渲染输出</h2>
              <button type="button" aria-pressed={outputView === 'structure'} onClick={() => setOutputView('structure')}>结构索引</button>
              <button type="button" aria-pressed={outputView === 'raw'} onClick={() => setOutputView('raw')}>原始输出</button>
              <button type="button" disabled={phase !== 'ready'} onClick={async () => {
                try { await navigator.clipboard.writeText(output); setCopyLabel('已复制') } catch { setCopyLabel('复制失败') }
              }}>{copyLabel}</button>
            </header>
            {phase === 'idle' ? <div className="result-empty">编辑 JSON 后点击“渲染”。</div> : null}
            {phase === 'loading' ? <div className="result-empty"><span className="spinner" />Worker 正在渲染…</div> : null}
            {phase === 'error' ? <p className="inline-error" role="alert">{error}</p> : null}
            {phase === 'ready' && outputView === 'raw' ? <pre className="source-reader standalone">{output}</pre> : null}
            {phase === 'ready' && outputView === 'structure' ? (
              <div className="template-structure">
                <div className="table-scroll"><table aria-label="Template 输出结构"><thead><tr><th>#</th><th>内容</th></tr></thead><tbody>{outputLines.map((line, index) => <tr key={index}><td>{index + 1}</td><td><button className="table-link" type="button" onClick={() => setSelectedLine(index)}>{line || '∅'}</button></td></tr>)}</tbody></table></div>
                <dl className="reader-facts"><div><dt>选中行</dt><dd>{selectedLine + 1}</dd></div><div><dt>字符</dt><dd>{Array.from(outputLines[selectedLine] ?? '').length}</dd></div><div><dt>UTF-8 Bytes</dt><dd>{new TextEncoder().encode(outputLines[selectedLine] ?? '').byteLength}</dd></div></dl>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  )
}

function HighlightedJinja({ source }: { source: string }) {
  return source.split(/({{[\s\S]*?}}|{%[\s\S]*?%}|{#[\s\S]*?#})/g).map((part, index) => (
    part.startsWith('{{') ? <span className="jinja-expression" key={index}>{part}</span>
      : part.startsWith('{%') ? <span className="jinja-statement" key={index}>{part}</span>
        : part.startsWith('{#') ? <span className="jinja-comment" key={index}>{part}</span>
          : part
  ))
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
