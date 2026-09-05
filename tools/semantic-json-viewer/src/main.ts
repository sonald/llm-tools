import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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

const treeView = new TreeView({
  panel: treePanel,
  tab: treeTab,
  inspector: nodeInspector,
  fields: { id: nodeId, label: nodeLabel, kind: nodeKind, span: nodeSpan, children: nodeChildren, value: nodeValue },
  onError: (error) => {
    const parsed = ipcError(error);
    state.error = parsed;
    if (parsed.code === "stale_session" || parsed.code === "file_changed") setActiveView("semantic");
    render();
  }
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
    return "Select a valid Entry to enable Tree.";
  }
  return summary.mode === "collection" ? "The selected array item will be projected here." : "The semantic projection for this document will appear here.";
}

function statusProgressLabel(summary: FileSummary): string {
  if (!summary.progress) return "Structure ready";
  if (state.scanStoppedRevision === summary.sessionRevision) return `Indexing stopped · ${summary.progress.indexedEntries.toLocaleString()} indexed`;
  return summary.progress.complete && summary.progress.totalEntries !== null
    ? `${summary.progress.totalEntries.toLocaleString()} entries`
    : `Indexing · ${summary.progress.indexedEntries.toLocaleString()} indexed`;
}

function setActiveView(view: "semantic" | "tree" | "raw"): void {
  if (view === "tree" && treeTab.disabled) return;
  if (view === "raw" && rawTab.disabled) return;
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
  appShell.setAttribute("aria-busy", String(state.opening));
  openButton.disabled = state.opening;
  readerOpenButton.disabled = state.opening;
  navigationToggle.setAttribute("aria-expanded", String(mobile ? state.mobileDrawer === "navigation" : true));
  inspectorToggle.setAttribute("aria-expanded", String(mobile ? state.mobileDrawer === "inspector" : tablet ? state.tabletInspectorOpen : true));
  appShell.dataset.mobileDrawer = state.mobileDrawer ?? "";
  appShell.dataset.inspectorOpen = tablet ? String(state.tabletInspectorOpen) : "false";
  renderSummary();
  renderError();
}

async function chooseFile(): Promise<void> {
  if (state.opening) return;
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
    treeView.setSession({ mode: summary.mode, sessionRevision: summary.sessionRevision });
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
        state.summary = { ...state.summary, progress };
        render();
        if (progress.complete) return;
      } catch (error) {
        if (generation !== state.generation || state.summary?.sessionRevision !== sessionRevision) return;
        failed = true;
        state.scanStoppedRevision = sessionRevision;
        state.error = ipcError(error);
        render();
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
