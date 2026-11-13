export type TemplateRenderOutcome = { output: string; error: string | null }

// Latest-only renderer for one playground; a superseded render resolves to null.
export class TemplateRenderClient {
  private worker: Worker | null = null
  private pending: { id: number; resolve(outcome: TemplateRenderOutcome | null): void } | null = null
  private nextId = 0

  render(template: string, context: Record<string, unknown>): Promise<TemplateRenderOutcome | null> {
    if (this.pending !== null) this.reset()
    const worker = this.worker ??= this.spawn()
    const id = (this.nextId += 1)
    return new Promise(resolve => {
      this.pending = { id, resolve }
      worker.postMessage({ id, template, context })
    })
  }

  dispose(): void {
    this.reset()
  }

  private reset() {
    this.worker?.terminate()
    this.worker = null
    this.pending?.resolve(null)
    this.pending = null
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('./templateRender.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; output: string; error: string | null }>) => {
      if (this.pending?.id !== event.data.id) return
      this.pending.resolve({ output: event.data.output, error: event.data.error })
      this.pending = null
    }
    worker.onerror = event => {
      event.preventDefault()
      const pending = this.pending
      this.reset()
      pending?.resolve({ output: '', error: event.message || 'Worker error' })
    }
    return worker
  }
}
