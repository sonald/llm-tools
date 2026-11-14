import { normalizeModelId } from './huggingface.ts'

export function parseRepositoryHistory(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const history: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') continue
      try {
        const canonical = normalizeModelId(item)
        if (!history.some(existing => existing.toLocaleLowerCase() === canonical.toLocaleLowerCase())) history.push(canonical)
      } catch {
        // Ignore corrupt entries without discarding valid history.
      }
    }
    return history
  } catch {
    return []
  }
}

export function addRepositoryHistory(history: string[], modelId: string): string[] {
  const canonical = normalizeModelId(modelId)
  // Native updatedHistory: newest first, case-insensitive dedupe, no cap (D-2).
  return [canonical, ...history.filter(item => item.toLocaleLowerCase() !== canonical.toLocaleLowerCase())]
}
