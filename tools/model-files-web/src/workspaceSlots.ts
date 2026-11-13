import { createContext } from 'react'

export type PanelTabId = 'problems' | 'tokens' | 'ids'
export type ToolTab = { id: Exclude<PanelTabId, 'problems'>; label: string; count?: number }
export type WorkspaceSlots = {
  panelBody: HTMLElement | null
  activeTab: PanelTabId
  inspector: HTMLElement | null
  registerTabs(tabs: ToolTab[]): void
  openToolPanel(): void
  // Native ModelFilesStore.showsTokenWhitespace: one switch for every tokenizer view, off by default.
  showWhitespace: boolean
  setShowWhitespace(value: boolean): void
}
// Views portal their panel tabs and inspector details into these slots; null means "render inline".
export const WorkspaceSlotsContext = createContext<WorkspaceSlots | null>(null)
