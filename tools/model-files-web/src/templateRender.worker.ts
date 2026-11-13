import { Template } from '@huggingface/jinja'

// Renders one Chat Template request off the main thread. The client terminates this Worker when a newer
// request arrives mid-render, so a runaway template never blocks typing or the tokenizer Worker.
self.onmessage = (event: MessageEvent<{ id: number; template: string; context: Record<string, unknown> }>) => {
  const { id, template, context } = event.data
  try {
    self.postMessage({ id, output: new Template(template).render(context), error: null })
  } catch (failure) {
    self.postMessage({ id, output: '', error: failure instanceof Error ? failure.message : String(failure) })
  }
}
