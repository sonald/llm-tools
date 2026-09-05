import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { EntryList, type EntrySelectionDto } from "./entry-list";
import { RawView } from "./raw-view";
import { TreeView, type NodeDto } from "./tree-view";

type FileMode = "document" | "collection" | "entry";

type ParseErrorDto = {
  message: string;
  byteOffset: number;
  line: number;
  column: number;
};

type JsonlProgressDto = {
  indexedEntries: number;
  indexedSourceLines: number;
  complete: boolean;
  stride: number;
  totalEntries: number | null;
};

type FileSummary = {
  path: string;
  size: number;
  mode: FileMode;
  root: NodeDto | null;
  progress: JsonlProgressDto | null;
  manyInvalidUtf8Warning: boolean;
  sessionRevision: number;
};

type IpcErrorPayload = {
  code: string;
  message: string;
  parseError?: ParseErrorDto;
};

type AppState = {
  summary: FileSummary | null;
  selectedEntry: EntrySelectionDto["entry"] | null;
  selectionBusy: boolean;
  error: IpcErrorPayload | null;
  opening: boolean;
  generation: number;
  pendingChoicePath: string | null;
  mobileDrawer: "navigation" | "inspector" | null;
  tabletInspectorOpen: boolean;
  scanInFlight: { generation: number; sessionRevision: number } | null;
  scanQueued: { generation: number; sessionRevision: number } | null;
  scanStoppedRevision: number | null;
};

const state: AppState = {
  summary: null,
  selectedEntry: null,
  selectionBusy: false,
  error: null,
  opening: false,
  generation: 0,
  pendingChoicePath: null,
  mobileDrawer: null,
  tabletInspectorOpen: false,
  scanInFlight: null,
  scanQueued: null,
  scanStoppedRevision: null
};

const appShell = required<HTMLElement>("app-shell");
const openButton = required<HTMLButtonElement>("open-file");
const readerOpenButton = required<HTMLButtonElement>("reader-open");
const fileName = required<HTMLElement>("file-name");
const filePath = required<HTMLElement>("file-path");
const fileMode = required<HTMLElement>("file-mode");
const navigationMode = required<HTMLElement>("navigation-mode");
const navigationState = required<HTMLElement>("navigation-state");
const entryNavigation = required<HTMLElement>("entry-navigation");
const entryGoInput = required<HTMLInputElement>("entry-go-input");
const entryGoButton = required<HTMLButtonElement>("entry-go-button");
const entryGoError = required<HTMLElement>("entry-go-error");
const entryListPanel = required<HTMLElement>("entry-list");
const entryPrevious = required<HTMLButtonElement>("entry-prev");
const entryNext = required<HTMLButtonElement>("entry-next");
const entryListStatus = required<HTMLElement>("entry-list-status");
const entryListRetry = required<HTMLButtonElement>("entry-list-retry");
const readerState = required<HTMLElement>("reader-state");
const inspectorPath = required<HTMLElement>("inspector-path");
const inspectorSize = required<HTMLElement>("inspector-size");
const inspectorMode = required<HTMLElement>("inspector-mode");
const inspectorRevision = required<HTMLElement>("inspector-revision");
const inspectorProgress = required<HTMLElement>("inspector-progress");
const inspectorWarning = required<HTMLElement>("inspector-warning");
const inspectorEmpty = required<HTMLElement>("inspector-empty");
const statusMode = required<HTMLElement>("status-mode");
const statusSize = required<HTMLElement>("status-size");
const statusProgress = required<HTMLElement>("status-progress");
const statusWarning = required<HTMLElement>("status-warning");
const statusReady = required<HTMLElement>("status-ready");
const errorRegion = required<HTMLElement>("error-region");
const errorTitle = required<HTMLElement>("error-title");
const errorMessage = required<HTMLElement>("error-message");
const errorDetails = required<HTMLElement>("error-details");
const navigationToggle = required<HTMLButtonElement>("navigation-toggle");
const inspectorToggle = required<HTMLButtonElement>("inspector-toggle");
const modeDialog = required<HTMLDialogElement>("mode-dialog");
const semanticTab = required<HTMLButtonElement>("semantic-tab");
const treeTab = required<HTMLButtonElement>("tree-tab");
const rawTab = required<HTMLButtonElement>("raw-tab");
const semanticPanel = required<HTMLElement>("semantic-panel");
const treePanel = required<HTMLElement>("tree-panel");
const rawPanel = required<HTMLElement>("raw-panel");
const nodeInspector = required<HTMLElement>("node-inspector");
const treeReaderTitle = required<HTMLElement>("reader-title");
const nodeId = required<HTMLElement>("node-id");
const nodeLabel = required<HTMLElement>("node-label");
const nodeKind = required<HTMLElement>("node-kind");
const nodeSpan = required<HTMLElement>("node-span");
const nodeChildren = required<HTMLElement>("node-children");
const nodeValue = required<HTMLElement>("node-value");
const entryInspector = required<HTMLElement>("entry-inspector");
const entryInspectorOrdinal = required<HTMLElement>("entry-inspector-ordinal");
const entryInspectorStatus = required<HTMLElement>("entry-inspector-status");
const entryInspectorSourceLine = required<HTMLElement>("entry-inspector-source-line");
const entryInspectorBytes = required<HTMLElement>("entry-inspector-bytes");
const entryInspectorParseMessage = required<HTMLElement>("entry-inspector-parse-message");
const entryInspectorParseByteOffset = required<HTMLElement>("entry-inspector-parse-byte-offset");
const entryInspectorParseLine = required<HTMLElement>("entry-inspector-parse-line");
const entryInspectorParseColumn = required<HTMLElement>("entry-inspector-parse-column");

let activeView: "semantic" | "tree" | "raw" = "semantic";

const treeView = new TreeView({
  panel: treePanel,
  tab: treeTab,
  inspector: nodeInspector,
  fields: { id: nodeId, label: nodeLabel, kind: nodeKind, span: nodeSpan, children: nodeChildren, value: nodeValue },
  onSelection: handleTreeSelection,
  onError: (error) => handleCurrentSessionAsyncError(ipcError(error))
});

const rawView = new RawView({
  panel: rawPanel,
  tab: rawTab,
  onError: (error) => handleCurrentSessionAsyncError(ipcError(error))
});

const entryList = new EntryList({
  navigation: entryNavigation,
  navigationState,
  goInput: entryGoInput,
  goButton: entryGoButton,
  goError: entryGoError,
  list: entryListPanel,
  previous: entryPrevious,
  next: entryNext,
  status: entryListStatus,
  retry: entryListRetry,
  inspector: entryInspector,
  inspectorOrdinal: entryInspectorOrdinal,
  inspectorStatus: entryInspectorStatus,
  inspectorSourceLine: entryInspectorSourceLine,
  inspectorBytes: entryInspectorBytes,
  inspectorParseMessage: entryInspectorParseMessage,
  inspectorParseByteOffset: entryInspectorParseByteOffset,
  inspectorParseLine: entryInspectorParseLine,
  inspectorParseColumn: entryInspectorParseColumn,
  onSelection: handleEntrySelection,
  onSelectionBusy: handleEntrySelectionBusy,
  onProgress: handleEntryProgress,
  onError: handleEntryError,
  onRevisionUnknown: handleEntryRevisionUnknown
});

function required<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return node as unknown as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseErrorValue(value: unknown): ParseErrorDto | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const message = typeof value.message === "string" ? value.message : undefined;
  const byteOffset = numberValue(value.byteOffset);
  const line = numberValue(value.line);
  const column = numberValue(value.column);
  if (message === undefined || byteOffset === undefined || line === undefined || column === undefined) {
    return undefined;
  }
  return { message, byteOffset, line, column };
}

function ipcError(value: unknown): IpcErrorPayload {
  if (isRecord(value)) {
    const code = typeof value.code === "string" ? value.code : "open_failed";
    const message = typeof value.message === "string" ? value.message : "The file could not be opened.";
    const parseError = parseErrorValue(value.parseError);
    return parseError ? { code, message, parseError } : { code, message };
  }
  if (value instanceof Error) {
    return { code: "open_failed", message: value.message };
  }
  return { code: "open_failed", message: "The file could not be opened." };
}

function handleEntryProgress(progress: JsonlProgressDto): void {
  const summary = state.summary;
  if (!summary || summary.mode !== "entry") return;
  state.summary = { ...summary, progress };
  render();
}

function handleEntrySelectionBusy(busy: boolean): void {
  if (state.selectionBusy === busy) return;
  state.selectionBusy = busy;
  render();
}

function handleTreeSelection(node: NodeDto): void {
  rawView.setScope(node);
}

function handleEntryError(error: unknown): void {
  handleCurrentSessionAsyncError(ipcError(error));
}

function handleCurrentSessionAsyncError(parsed: IpcErrorPayload, stopEntryIndex = false): void {
  state.error = parsed;
  const summary = state.summary;
  if (stopEntryIndex && summary?.mode === "entry") {
    state.scanStoppedRevision = summary.sessionRevision;
  }
  if (parsed.code === "file_changed" || parsed.code === "stale_session") {
    rawView.clear();
    treeView.clear();
    if (summary?.mode === "entry") {
      state.scanStoppedRevision = summary.sessionRevision;
      state.selectedEntry = null;
      entryList.clear();
      setActiveView("semantic");
    } else {
      setActiveView("semantic");
    }
  }
  render();
}

function handleEntrySelection(selection: EntrySelectionDto): void {
  const summary = state.summary;
  if (!summary || summary.mode !== "entry") return;
  if (selection.sessionRevision !== summary.sessionRevision + 1) {
    state.error = { code: "internal", message: "Entry selection returned an unexpected session revision." };
    render();
    return;
  }

  const previousView = activeView;
  state.generation += 1;
  state.summary = { ...summary, sessionRevision: selection.sessionRevision };
  state.selectedEntry = selection.entry;
  state.error = null;
  state.scanQueued = null;
  state.scanStoppedRevision = null;
  entryList.adoptSelection(selection, selection.sessionRevision);

  const valid = selection.entry.status === "valid";
  const invalidJson = selection.entry.status === "invalidJson";
  const rootMatchesStatus = valid ? selection.root !== null : selection.root === null;
  if (!rootMatchesStatus) {
    state.error = { code: "internal", message: "Entry selection returned an inconsistent Tree root." };
    treeView.setSession({ mode: "entry", sessionRevision: selection.sessionRevision }, null);
    rawView.clear("Tree is unavailable because the Entry selection was inconsistent.");
    setActiveView("semantic");
  } else {
    treeView.setSession(
      { mode: "entry", sessionRevision: selection.sessionRevision },
      valid ? selection.root : null
    );
    let rawAvailable = false;
    if (valid && selection.root) {
      rawView.setSession(selection.sessionRevision, selection.root);
      rawAvailable = true;
    } else if (invalidJson) {
      rawAvailable = rawView.setInvalidJsonEntry(selection.sessionRevision, selection.entry);
    } else {
      rawView.clear("Select a valid Entry to open Raw bytes.");
    }
    if (invalidJson && !rawAvailable) {
      state.error = { code: "internal", message: "Invalid JSON Entry Raw bytes could not be opened." };
      setActiveView("semantic");
    } else if ((valid || invalidJson) && previousView === "raw") {
      setActiveView("raw");
    } else if (valid && previousView === "tree") {
      setActiveView("tree");
    } else {
      setActiveView("semantic");
    }
  }
  render();
  if (state.summary.progress && !state.summary.progress.complete) {
    resumeExistingScan();
  }
}

function handleEntryRevisionUnknown(value: unknown): void {
  const next = entrySummaryValue(value);
  if (!next || next.mode !== "entry" || !next.progress) {
    state.error = { code: "internal", message: "The refreshed JSONL session has an invalid shape." };
    render();
    return;
  }
  const generation = ++state.generation;
  state.summary = next;
  state.selectedEntry = null;
  state.error = null;
  state.scanQueued = null;
  state.scanStoppedRevision = null;
  rawView.clear("Select a valid Entry to open Raw bytes.");
  entryList.resync(next.sessionRevision, next.progress);
  treeView.setSession({ mode: "entry", sessionRevision: next.sessionRevision }, null);
  setActiveView("semantic");
  render();
  if (!next.progress.complete) void scanEntries(generation, next.sessionRevision);
}

function entrySummaryValue(value: unknown): FileSummary | undefined {
  if (!isRecord(value)) return undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  const size = numberValue(value.size);
  const sessionRevision = numberValue(value.sessionRevision);
  const warning = typeof value.manyInvalidUtf8Warning === "boolean" ? value.manyInvalidUtf8Warning : undefined;
  const progress = jsonlProgressValue(value.progress);
  if (path === undefined || size === undefined || sessionRevision === undefined || warning === undefined || progress === undefined || value.mode !== "entry") {
    return undefined;
  }
  return {
    path,
    size,
    mode: "entry",
    root: null,
    progress,
    manyInvalidUtf8Warning: warning,
    sessionRevision
  };
}

function jsonlProgressValue(value: unknown): JsonlProgressDto | undefined {
  if (!isRecord(value)) return undefined;
  const indexedEntries = numberValue(value.indexedEntries);
  const indexedSourceLines = numberValue(value.indexedSourceLines);
  const stride = numberValue(value.stride);
  const complete = typeof value.complete === "boolean" ? value.complete : undefined;
  const totalEntries = value.totalEntries === null ? null : numberValue(value.totalEntries);
  if (indexedEntries === undefined || indexedSourceLines === undefined || stride === undefined || complete === undefined || totalEntries === undefined) {
    return undefined;
  }
  return { indexedEntries, indexedSourceLines, complete, stride, totalEntries };
}

function modeLabel(mode: FileMode): string {
  if (mode === "document") return "Document";
  if (mode === "collection") return "Collection";
  return "Entry";
}

function fileLabel(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function progressLabel(progress: JsonlProgressDto): string {
  if (progress.complete && progress.totalEntries !== null) {
    return `${progress.indexedEntries.toLocaleString()} / ${progress.totalEntries.toLocaleString()}`;
  }
  return `${progress.indexedEntries.toLocaleString()} indexed · through line ${progress.indexedSourceLines.toLocaleString()}`;
}

function setText(node: HTMLElement, value: string): void {
  node.textContent = value;
}

function renderError(): void {
  const error = state.error;
  errorRegion.hidden = error === null;
  if (!error) {
    setText(errorTitle, "Open failed");
    setText(errorMessage, "");
    setText(errorDetails, "");
    return;
  }

  const titles: Record<string, string> = {
    invalid_json: "Invalid JSON",
    unsupported_encoding: "Unsupported encoding",
    unsupported_framing: "Unsupported framing",
    unsupported_format: "Unsupported format",
    mode_choice_required: "Choose a file mode",
    file_changed: "File changed on disk"
  };
  setText(errorTitle, titles[error.code] ?? "Open failed");
  setText(errorMessage, error.message);
  if (error.parseError) {
    const parse = error.parseError;
    setText(errorDetails, `Line ${parse.line} · Column ${parse.column} · Byte offset ${parse.byteOffset}: ${parse.message}`);
  } else {
    setText(errorDetails, "");
  }
}

function renderSummary(): void {
  const summary = state.summary;
  if (!summary) {
    setText(fileName, "No file open");
    setText(filePath, "—");
    setText(fileMode, "—");
    setText(navigationMode, "—");
    setText(navigationState.querySelector("strong") as HTMLElement, "No file is open.");
    setText(navigationState.querySelector("span:last-child") as HTMLElement, "Open a local JSON or JSONL file to begin.");
    setText(readerState.querySelector("h3") as HTMLElement, state.opening ? "Opening file…" : "Reader ready");
    setText(readerState.querySelector("p") as HTMLElement, state.opening ? "The previous view stays available while the new file opens." : "Semantic view will appear here after a file is opened.");
    setText(inspectorPath, "—");
    setText(inspectorSize, "—");
    setText(inspectorMode, "—");
    setText(inspectorRevision, "—");
    setText(inspectorProgress, "—");
    inspectorEmpty.hidden = false;
    inspectorWarning.hidden = true;
    setText(statusMode, "—");
    setText(statusSize, "—");
    setText(statusProgress, state.opening ? "Opening…" : "Ready");
    statusWarning.hidden = true;
    return;
  }

  const mode = modeLabel(summary.mode);
  setText(fileName, fileLabel(summary.path));
  setText(filePath, summary.path);
  setText(fileMode, `${mode} Mode`);
  setText(navigationMode, mode);
  setText(navigationState.querySelector("strong") as HTMLElement, mode === "Entry" ? "Entry index" : `${mode} outline`);
  setText(navigationState.querySelector("span:last-child") as HTMLElement, navigationCopy(summary));
  setText(readerState.querySelector("h3") as HTMLElement, readerTitle(summary));
  setText(readerState.querySelector("p") as HTMLElement, readerCopy(summary));
  setText(inspectorPath, summary.path);
  setText(inspectorSize, `${formatBytes(summary.size)} (${summary.size.toLocaleString()} bytes)`);
  setText(inspectorMode, `${mode} Mode`);
  setText(inspectorRevision, String(summary.sessionRevision));
  const stopped = state.scanStoppedRevision === summary.sessionRevision;
  setText(inspectorProgress, summary.progress ? stopped ? `Indexing stopped · ${progressLabel(summary.progress)}` : progressLabel(summary.progress) : "Structure loaded");
  inspectorEmpty.hidden = true;
  inspectorWarning.hidden = !summary.manyInvalidUtf8Warning;
  setText(inspectorWarning, "Many entries are not valid UTF-8. The file remains open in byte-safe mode.");
  setText(statusMode, `${mode} Mode`);
  setText(statusSize, formatBytes(summary.size));
  setText(statusProgress, statusProgressLabel(summary));
  statusWarning.hidden = !summary.manyInvalidUtf8Warning;
  setText(statusReady, state.opening ? "Opening…" : stopped ? "Indexing stopped" : summary.progress && !summary.progress.complete ? "Indexing…" : "Ready");
}

function navigationCopy(summary: FileSummary): string {
  if (summary.mode === "entry" && summary.progress) {
    if (state.scanStoppedRevision === summary.sessionRevision) return `Indexing stopped · ${summary.progress.indexedEntries.toLocaleString()} entries indexed.`;
    return summary.progress.complete ? "Indexed entries are ready." : `${summary.progress.indexedEntries.toLocaleString()} entries indexed so far.`;
  }
  return summary.mode === "collection" ? "Items load on demand." : "Outline loads on demand.";
}

function readerTitle(summary: FileSummary): string {
  if (state.scanStoppedRevision === summary.sessionRevision) return "Indexing stopped";
  if (summary.mode === "entry" && summary.progress && !summary.progress.complete) return "Indexing in the background";
  return `${modeLabel(summary.mode)} reader ready`;
}

function readerCopy(summary: FileSummary): string {
  if (summary.mode === "entry" && summary.progress) {
    if (state.scanStoppedRevision === summary.sessionRevision) return `Indexing stopped at ${summary.progress.indexedEntries.toLocaleString()} entries. The partial index remains available.`;
    if (state.selectedEntry?.status === "invalidJson") return "Tree is unavailable. Original Raw bytes are available.";
    if (state.selectedEntry) {
      const entry = state.selectedEntry;
      return entry.status === "valid"
        ? `Entry ${entry.location.entryOrdinal + 1} is selected. Tree is available.`
        : `Entry ${entry.location.entryOrdinal + 1} is selected. Tree is unavailable for ${entryStatusLabel(entry.status)}.`;
    }
    return "Select a valid Entry to enable Tree.";
  }
  return summary.mode === "collection" ? "The selected array item will be projected here." : "The semantic projection for this document will appear here.";
}

function statusProgressLabel(summary: FileSummary): string {
  if (!summary.progress) return "Structure ready";
  const progress = state.scanStoppedRevision === summary.sessionRevision
    ? `Indexing stopped · ${summary.progress.indexedEntries.toLocaleString()} indexed`
    : summary.progress.complete && summary.progress.totalEntries !== null
      ? `${summary.progress.totalEntries.toLocaleString()} entries`
      : `Indexing · ${summary.progress.indexedEntries.toLocaleString()} indexed`;
  if (summary.mode !== "entry") return progress;
  const selected = state.selectedEntry;
  if (!selected) return `Indexed through line ${summary.progress.indexedSourceLines.toLocaleString()} · ${progress}`;
  const { entryOrdinal, sourceLine, byteStart, byteEnd } = selected.location;
  return `Entry ${entryOrdinal + 1} · source line ${sourceLine} · bytes [${byteStart}, ${byteEnd}) · ${progress}`;
}

function entryStatusLabel(status: string): string {
  if (status === "invalidJson") return "Invalid JSON";
  if (status === "invalidUtf8") return "Invalid UTF-8";
  if (status === "oversized") return "Oversized Entry";
  return status === "valid" ? "Valid" : status;
}

function setActiveView(view: "semantic" | "tree" | "raw"): void {
  if (view === "tree" && treeTab.disabled) return;
  if (view === "raw" && rawTab.disabled) return;
  activeView = view;
  const tabs: Array<[HTMLButtonElement, HTMLElement]> = [
    [semanticTab, semanticPanel],
    [treeTab, treePanel],
    [rawTab, rawPanel]
  ];
  for (const [tab, panel] of tabs) {
    const active = tab === (view === "semantic" ? semanticTab : view === "tree" ? treeTab : rawTab);
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  setText(treeReaderTitle, view[0].toUpperCase() + view.slice(1));
  if (view === "tree") treeView.activate();
  if (view === "raw") rawView.activate();
  else rawView.deactivate();
}

function moveViewFocus(direction: 1 | -1): void {
  const tabs = [semanticTab, treeTab, rawTab].filter((tab) => !tab.disabled);
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  const next = current < 0 ? 0 : (current + direction + tabs.length) % tabs.length;
  focusViewTab(tabs[next]);
}

function focusViewTab(tab: HTMLButtonElement | undefined): void {
  if (!tab) return;
  for (const candidate of [semanticTab, treeTab, rawTab]) candidate.tabIndex = candidate === tab ? 0 : -1;
  tab.focus();
}

function render(): void {
  const width = window.innerWidth;
  const mobile = width <= 767;
  const tablet = width >= 768 && width <= 1050;
  const busy = state.opening || state.selectionBusy;
  appShell.setAttribute("aria-busy", String(busy));
  openButton.disabled = busy;
  readerOpenButton.disabled = busy;
  navigationToggle.setAttribute("aria-expanded", String(mobile ? state.mobileDrawer === "navigation" : true));
  inspectorToggle.setAttribute("aria-expanded", String(mobile ? state.mobileDrawer === "inspector" : tablet ? state.tabletInspectorOpen : true));
  appShell.dataset.mobileDrawer = state.mobileDrawer ?? "";
  appShell.dataset.inspectorOpen = tablet ? String(state.tabletInspectorOpen) : "false";
  entryList.setOpening(state.opening);
  rawView.setBusy(state.opening || state.selectionBusy);
  renderSummary();
  renderError();
}

async function chooseFile(): Promise<void> {
  if (state.opening || state.selectionBusy) return;
  const pickerGeneration = state.generation;
  state.opening = true;
  render();
  try {
    const selected = await open({ multiple: false, directory: false });
    if (pickerGeneration !== state.generation) return;
    if (typeof selected !== "string") {
      state.opening = false;
      render();
      openButton.focus();
      return;
    }
    const generation = ++state.generation;
    await openPath(selected, null, generation);
  } catch (error) {
    if (pickerGeneration === state.generation) {
      state.error = ipcError(error);
      state.opening = false;
      render();
      openButton.focus();
    }
  }
}

async function openPath(path: string, openAs: "json" | "jsonl" | null, generation: number): Promise<void> {
  try {
    const summary = await invoke<FileSummary>("open_file", { path, openAs });
    if (generation !== state.generation) return;
    state.summary = summary;
    state.error = null;
    state.pendingChoicePath = null;
    state.scanQueued = null;
    state.scanStoppedRevision = null;
    state.opening = false;
    entryList.setOpening(false);
    state.selectedEntry = null;
    const rootShapeValid = summary.mode === "entry" ? summary.root === null : summary.root !== null;
    if (!rootShapeValid) {
      state.error = { code: "internal", message: "The file summary has an inconsistent Tree root." };
      treeView.clear();
      rawView.clear("Raw bytes are unavailable for this inconsistent file summary.");
      entryList.setSession(null);
      setActiveView("semantic");
      render();
      return;
    }
    treeView.setSession({ mode: summary.mode, sessionRevision: summary.sessionRevision });
    if (summary.root) rawView.setSession(summary.sessionRevision, summary.root);
    else rawView.clear("Select a valid Entry to open Raw bytes.");
    entryList.setSession(summary.mode === "entry" && summary.progress ? {
      revision: summary.sessionRevision,
      progress: summary.progress
    } : null);
    setActiveView("semantic");
    render();
    if (summary.mode === "entry" && summary.progress && !summary.progress.complete) {
      void scanEntries(generation, summary.sessionRevision);
    }
  } catch (error) {
    if (generation !== state.generation) return;
    const parsed = ipcError(error);
    state.error = parsed;
    state.opening = false;
    if (parsed.code === "mode_choice_required" || openAs !== null) {
      state.pendingChoicePath = path;
      resumeExistingScan();
      render();
      showModeChoice();
    } else {
      render();
      resumeExistingScan();
      openButton.focus();
    }
  }
}

function resumeExistingScan(): void {
  const summary = state.summary;
  if (summary?.mode !== "entry" || !summary.progress || summary.progress.complete) {
    return;
  }
  if (state.scanStoppedRevision === summary.sessionRevision) return;
  const request = { generation: state.generation, sessionRevision: summary.sessionRevision };
  if (state.scanInFlight) {
    state.scanQueued = request;
    return;
  }
  void scanEntries(request.generation, request.sessionRevision);
}

async function scanEntries(generation: number, sessionRevision: number): Promise<void> {
  if (state.scanInFlight) {
    state.scanQueued = { generation, sessionRevision };
    return;
  }
  state.scanInFlight = { generation, sessionRevision };
  let failed = false;
  try {
    while (generation === state.generation && state.summary?.sessionRevision === sessionRevision) {
      try {
        const progress = await invoke<JsonlProgressDto>("scan_entries", { sessionRevision });
        if (generation !== state.generation || state.summary?.sessionRevision !== sessionRevision) return;
        state.scanStoppedRevision = null;
        entryList.updateProgress(progress, sessionRevision);
        if (progress.complete) return;
      } catch (error) {
        if (generation !== state.generation || state.summary?.sessionRevision !== sessionRevision) return;
        failed = true;
        handleCurrentSessionAsyncError(ipcError(error), true);
        return;
      }
    }
  } finally {
    const sameRequest = state.scanInFlight?.generation === generation && state.scanInFlight.sessionRevision === sessionRevision;
    if (sameRequest) state.scanInFlight = null;
    const queued = state.scanQueued;
    state.scanQueued = null;
    if (queued && (!failed || queued.generation !== generation) && queued.generation === state.generation && state.summary?.sessionRevision === queued.sessionRevision && state.summary.progress && !state.summary.progress.complete) {
      void scanEntries(queued.generation, queued.sessionRevision);
    }
  }
}

function showModeChoice(): void {
  modeDialog.returnValue = "";
  if (!modeDialog.open) modeDialog.showModal();
}

function toggleNavigation(): void {
  if (window.innerWidth <= 767) {
    state.mobileDrawer = state.mobileDrawer === "navigation" ? null : "navigation";
  }
  render();
}

function toggleInspector(): void {
  if (window.innerWidth <= 767) {
    state.mobileDrawer = state.mobileDrawer === "inspector" ? null : "inspector";
  } else if (window.innerWidth <= 1050) {
    state.tabletInspectorOpen = !state.tabletInspectorOpen;
  }
  render();
}

openButton.addEventListener("click", () => void chooseFile());
readerOpenButton.addEventListener("click", () => void chooseFile());
navigationToggle.addEventListener("click", toggleNavigation);
inspectorToggle.addEventListener("click", toggleInspector);
semanticTab.addEventListener("click", () => setActiveView("semantic"));
treeTab.addEventListener("click", () => setActiveView("tree"));
rawTab.addEventListener("click", () => setActiveView("raw"));
document.querySelector<HTMLElement>(".view-tabs")?.addEventListener("keydown", (event) => {
  if (!(event instanceof KeyboardEvent)) return;
  if (event.key === "ArrowRight") {
    event.preventDefault();
    moveViewFocus(1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveViewFocus(-1);
  } else if (event.key === "Home") {
    event.preventDefault();
    focusViewTab([semanticTab, treeTab, rawTab].find((tab) => !tab.disabled));
  } else if (event.key === "End") {
    event.preventDefault();
    focusViewTab([semanticTab, treeTab, rawTab].reverse().find((tab) => !tab.disabled));
  } else if (event.key === "Enter" || event.key === " ") {
    const target = event.target;
    if (target instanceof HTMLButtonElement) {
      event.preventDefault();
      setActiveView(target === semanticTab ? "semantic" : target === treeTab ? "tree" : "raw");
    }
  }
});

modeDialog.addEventListener("close", () => {
  const choice = modeDialog.returnValue;
  const path = state.pendingChoicePath;
  if ((choice !== "json" && choice !== "jsonl") || !path) {
    state.pendingChoicePath = null;
    if (state.error?.code === "mode_choice_required") state.error = null;
    render();
    resumeExistingScan();
    openButton.focus();
    return;
  }
  const generation = ++state.generation;
  state.opening = true;
  render();
  void openPath(path, choice, generation);
});

modeDialog.addEventListener("cancel", () => {
  modeDialog.returnValue = "cancel";
  window.setTimeout(() => openButton.focus(), 0);
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    if (modeDialog.open) return;
    void chooseFile();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g") {
    if (modeDialog.open || state.opening || state.summary?.mode !== "entry") return;
    event.preventDefault();
    if (window.innerWidth <= 767) {
      state.mobileDrawer = "navigation";
      render();
      window.requestAnimationFrame(() => entryList.focusGoTo());
    } else {
      entryList.focusGoTo();
    }
    return;
  }
  if (event.key === "Escape" && !modeDialog.open) {
    if (state.mobileDrawer !== null || state.tabletInspectorOpen) {
      state.mobileDrawer = null;
      state.tabletInspectorOpen = false;
      render();
      openButton.focus();
    }
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth <= 767) {
    state.tabletInspectorOpen = false;
  }
  if (window.innerWidth > 767) {
    state.mobileDrawer = null;
  }
  if (window.innerWidth > 1050) {
    state.tabletInspectorOpen = false;
  }
  render();
});

render();
