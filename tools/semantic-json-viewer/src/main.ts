import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ContentViewer, type ContentTarget } from "./content-viewer";
import { CollectionList } from "./collection-list";
import { EntryList, type EntrySelectionDto } from "./entry-list";
import { MAX_ENTRY_BYTES, RawView } from "./raw-view";
import { SearchView, type SearchMatch, type SearchScope } from "./search-view";
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
  documentError: IpcErrorPayload | null;
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
  selectedItem: { node: NodeDto; ordinal: number } | null;
  selectionBusy: boolean;
  error: IpcErrorPayload | null;
  opening: boolean;
  generation: number;
  pendingChoicePath: string | null;
  pendingChoicePreviousError: IpcErrorPayload | null;
  mobileDrawer: "navigation" | "inspector" | null;
  tabletInspectorOpen: boolean;
  scanInFlight: { generation: number; sessionRevision: number } | null;
  scanQueued: { generation: number; sessionRevision: number } | null;
  scanStoppedRevision: number | null;
  invalidatedRevision: number | null;
};

const state: AppState = {
  summary: null,
  selectedEntry: null,
  selectedItem: null,
  selectionBusy: false,
  error: null,
  opening: false,
  generation: 0,
  pendingChoicePath: null,
  pendingChoicePreviousError: null,
  mobileDrawer: null,
  tabletInspectorOpen: false,
  scanInFlight: null,
  scanQueued: null,
  scanStoppedRevision: null,
  invalidatedRevision: null
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
const collectionNavigation = required<HTMLElement>("collection-navigation");
const collectionGoInput = required<HTMLInputElement>("collection-go-input");
const collectionGoButton = required<HTMLButtonElement>("collection-go-button");
const collectionGoError = required<HTMLElement>("collection-go-error");
const collectionListPanel = required<HTMLElement>("collection-list");
const collectionListStatus = required<HTMLElement>("collection-list-status");
const collectionListRetry = required<HTMLButtonElement>("collection-list-retry");
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
const searchPanel = required<HTMLElement>("scope-search-panel");
const searchForm = required<HTMLFormElement>("scope-search");
const searchQuery = required<HTMLInputElement>("scope-search-query");
const searchDecoded = required<HTMLInputElement>("scope-search-representation-decoded");
const searchRawSource = required<HTMLInputElement>("scope-search-representation-raw");
const searchSubmit = required<HTMLButtonElement>("scope-search-submit");
const searchDescription = required<HTMLElement>("scope-search-description");
const searchResultsPanel = required<HTMLElement>("scope-search-results-panel");
const searchStatus = required<HTMLElement>("scope-search-status");
const searchResults = required<HTMLElement>("scope-search-results");
const searchPrevious = required<HTMLButtonElement>("scope-search-prev");
const searchNext = required<HTMLButtonElement>("scope-search-next");
const nodeInspector = required<HTMLElement>("node-inspector");
const treeReaderTitle = required<HTMLElement>("reader-title");
const nodeId = required<HTMLElement>("node-id");
const nodeLabel = required<HTMLElement>("node-label");
const nodeKind = required<HTMLElement>("node-kind");
const nodeSpan = required<HTMLElement>("node-span");
const nodeChildren = required<HTMLElement>("node-children");
const nodeValue = required<HTMLElement>("node-value");
const nodeCopyRaw = required<HTMLButtonElement>("node-copy-raw");
const nodeCopySubtree = required<HTMLButtonElement>("node-copy-subtree");
const nodeCopyDecoded = required<HTMLButtonElement>("node-copy-decoded");
const nodeCopyPath = required<HTMLButtonElement>("node-copy-path");
const nodeCopyStatus = required<HTMLElement>("node-copy-status");
const entryInspector = required<HTMLElement>("entry-inspector");
const entryInspectorOrdinal = required<HTMLElement>("entry-inspector-ordinal");
const entryInspectorStatus = required<HTMLElement>("entry-inspector-status");
const entryInspectorSourceLine = required<HTMLElement>("entry-inspector-source-line");
const entryInspectorBytes = required<HTMLElement>("entry-inspector-bytes");
const entryInspectorParseMessage = required<HTMLElement>("entry-inspector-parse-message");
const entryInspectorParseByteOffset = required<HTMLElement>("entry-inspector-parse-byte-offset");
const entryInspectorParseLine = required<HTMLElement>("entry-inspector-parse-line");
const entryInspectorParseColumn = required<HTMLElement>("entry-inspector-parse-column");
const contentViewerDialog = required<HTMLDialogElement>("content-viewer-dialog");
const contentViewerClose = required<HTMLButtonElement>("content-viewer-close");
const contentViewerTitle = required<HTMLElement>("content-viewer-title");
const contentViewerScope = required<HTMLElement>("content-viewer-scope");
const contentViewerPath = required<HTMLElement>("content-viewer-path");
const contentViewerNode = required<HTMLElement>("content-viewer-node");
const contentViewerSpanLabel = required<HTMLElement>("content-viewer-span-label");
const contentViewerSpan = required<HTMLElement>("content-viewer-span");
const contentViewerSemanticType = required<HTMLElement>("content-viewer-semantic-type");
const contentViewerDetectionSource = required<HTMLElement>("content-viewer-detection-source");
const contentViewerPlainReason = required<HTMLElement>("content-viewer-plain-reason");
const contentViewerRepresentation = required<HTMLElement>("content-viewer-representation");
const contentViewerRendererNote = required<HTMLElement>("content-viewer-renderer-note");
const contentViewerRange = required<HTMLElement>("content-viewer-range");
const contentViewerStatus = required<HTMLElement>("content-viewer-status");
const contentViewerAlert = required<HTMLElement>("content-viewer-alert");
const contentViewerContent = required<HTMLElement>("content-viewer-content");
const contentViewerCopyRaw = required<HTMLButtonElement>("content-viewer-copy-raw");
const contentViewerCopyDecoded = required<HTMLButtonElement>("content-viewer-copy-decoded");
const contentViewerCopyMarkdown = required<HTMLButtonElement>("content-viewer-copy-markdown");
const contentViewerCopyParsed = required<HTMLButtonElement>("content-viewer-copy-parsed");
const contentViewerCopyStatus = required<HTMLElement>("content-viewer-copy-status");
const contentViewerRenderAs = required<HTMLSelectElement>("content-viewer-render-as");
const contentViewerMarkdownAnyway = required<HTMLButtonElement>("content-viewer-markdown-anyway");
const contentViewerPrevious = required<HTMLButtonElement>("content-viewer-previous");
const contentViewerNext = required<HTMLButtonElement>("content-viewer-next");
const nestedNavigation = required<HTMLElement>("content-viewer-nested-navigation");
const nestedBack = required<HTMLButtonElement>("content-viewer-nested-back");
const nestedBreadcrumb = required<HTMLOListElement>("content-viewer-nested-breadcrumbs");
const nestedRepresentations = required<HTMLElement>("content-viewer-representations");
const parsedTab = required<HTMLButtonElement>("content-viewer-parsed-tab");
const decodedTab = required<HTMLButtonElement>("content-viewer-decoded-tab");
const nestedRawTab = required<HTMLButtonElement>("content-viewer-raw-lexeme-tab");
const parsedPanel = required<HTMLElement>("content-viewer-parsed-panel");
const parsedTree = required<HTMLElement>("content-viewer-parsed-tree");
const sharedTextPanel = required<HTMLElement>("content-viewer-text-panel");
const htmlRepresentations = required<HTMLElement>("content-viewer-html-representations");
const htmlPreviewTab = required<HTMLButtonElement>("content-viewer-html-preview-tab");
const htmlSourceTab = required<HTMLButtonElement>("content-viewer-html-source-tab");
const htmlPreviewPanel = required<HTMLElement>("content-viewer-html-preview-panel");
const htmlPreviewFrame = required<HTMLIFrameElement>("content-viewer-html-preview-frame");

const PREVIEW_ARIA_LABEL = "Preview selected string in Content Viewer";
const previewButton = required<HTMLButtonElement>("content-viewer-preview");
let selectedStringTarget: ContentTarget | null = null;

let activeView: "semantic" | "tree" | "raw" = "semantic";

const contentViewer = new ContentViewer({
  elements: {
    dialog: contentViewerDialog,
    close: contentViewerClose,
    title: contentViewerTitle,
    scope: contentViewerScope,
    path: contentViewerPath,
    node: contentViewerNode,
    spanLabel: contentViewerSpanLabel,
    span: contentViewerSpan,
    semanticType: contentViewerSemanticType,
    detectionSource: contentViewerDetectionSource,
    plainReason: contentViewerPlainReason,
    representation: contentViewerRepresentation,
    rendererNote: contentViewerRendererNote,
    range: contentViewerRange,
    status: contentViewerStatus,
    alert: contentViewerAlert,
    content: contentViewerContent,
    copy: {
      raw: contentViewerCopyRaw,
      decoded: contentViewerCopyDecoded,
      markdown: contentViewerCopyMarkdown,
      parsed: contentViewerCopyParsed,
      status: contentViewerCopyStatus
    },
    renderAs: contentViewerRenderAs,
    markdownAnyway: contentViewerMarkdownAnyway,
    previous: contentViewerPrevious,
    next: contentViewerNext,
    nested: {
      navigation: nestedNavigation,
      back: nestedBack,
      breadcrumb: nestedBreadcrumb,
      representations: nestedRepresentations,
      parsedTab,
      decodedTab,
      rawTab: nestedRawTab,
      parsedPanel,
      parsedTree,
      sharedTextPanel
    },
    html: {
      representations: htmlRepresentations,
      previewTab: htmlPreviewTab,
      sourceTab: htmlSourceTab,
      previewPanel: htmlPreviewPanel,
      previewFrame: htmlPreviewFrame
    }
  },
  invoke,
  onSessionError: (error) => handleCurrentSessionAsyncError(ipcError(error)),
  onClose: (restoreFocus) => {
    if (restoreFocus) focusContentViewerFallback();
  }
});

const treeView = new TreeView({
  panel: treePanel,
  tab: treeTab,
  inspector: nodeInspector,
  fields: { id: nodeId, label: nodeLabel, kind: nodeKind, span: nodeSpan, children: nodeChildren, value: nodeValue },
  onSelection: handleTreeSelection,
    onStringSelection: handleStringSelection,
    onStringOpen: handleStringOpen,
  onError: (error) => handleCurrentSessionAsyncError(ipcError(error)),
  copy: {
    raw: nodeCopyRaw,
    subtree: nodeCopySubtree,
    decoded: nodeCopyDecoded,
    path: nodeCopyPath,
    status: nodeCopyStatus
  }
});

const rawView = new RawView({
  panel: rawPanel,
  tab: rawTab,
  onError: (error) => handleCurrentSessionAsyncError(ipcError(error))
});

const searchView = new SearchView({
  form: searchForm,
  query: searchQuery,
  decoded: searchDecoded,
  rawSource: searchRawSource,
  submit: searchSubmit,
  description: searchDescription,
  panel: searchPanel,
  resultsPanel: searchResultsPanel,
  status: searchStatus,
  results: searchResults,
  previous: searchPrevious,
  next: searchNext,
  invoke,
  onReveal: handleSearchReveal,
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

const collectionList = new CollectionList({
  section: collectionNavigation,
  goInput: collectionGoInput,
  goButton: collectionGoButton,
  goError: collectionGoError,
  list: collectionListPanel,
  status: collectionListStatus,
  retry: collectionListRetry,
  invoke,
  onSelection: handleCollectionSelection,
  onError: (error) => handleCurrentSessionAsyncError(ipcError(error))
});

function required<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return node as unknown as T;
}

function renderPreviewButton(): void {
  previewButton.disabled = selectedStringTarget === null || state.opening || state.selectionBusy;
  previewButton.setAttribute("aria-label", PREVIEW_ARIA_LABEL);
}

function handleStringSelection(target: ContentTarget | null): void {
  selectedStringTarget = target;
  renderPreviewButton();
}

function handleStringOpen(target: ContentTarget, opener: HTMLElement): void {
  selectedStringTarget = target;
  renderPreviewButton();
  void contentViewer.open(target, opener);
}

function focusContentViewerFallback(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && document.contains(active)) return;
  const fallback = activeView === "tree" && !treeTab.disabled
    ? treeTab
    : state.summary ? semanticTab : openButton;
  if (!fallback.disabled) fallback.focus();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseErrorValue(value: unknown, maxByteOffset?: number): ParseErrorDto | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const message = typeof value.message === "string" ? value.message : undefined;
  const byteOffset = numberValue(value.byteOffset);
  const line = numberValue(value.line);
  const column = numberValue(value.column);
  if (message === undefined || byteOffset === undefined || line === undefined || column === undefined
    || line < 1 || column < 1 || maxByteOffset !== undefined && byteOffset > maxByteOffset) {
    return undefined;
  }
  return { message, byteOffset, line, column };
}

function nodeDtoValue(value: unknown, size: number): NodeDto | undefined {
  if (!isRecord(value)) return undefined;
  const id = numberValue(value.id);
  const spanStart = numberValue(value.spanStart);
  const spanEnd = numberValue(value.spanEnd);
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const label = typeof value.label === "string" ? value.label : undefined;
  const labelHasMore = typeof value.labelHasMore === "boolean" ? value.labelHasMore : undefined;
  const valuePreview = value.valuePreview === null
    ? null
    : typeof value.valuePreview === "string" ? value.valuePreview : undefined;
  const valueHasMore = typeof value.valueHasMore === "boolean" ? value.valueHasMore : undefined;
  const childCount = numberValue(value.childCount);
  const supportedKind = kind === "object" || kind === "array" || kind === "string" || kind === "number"
    || kind === "true" || kind === "false" || kind === "null";
  if (id === undefined || spanStart === undefined || spanEnd === undefined || spanStart >= spanEnd || spanEnd > size
    || !supportedKind || label === undefined || labelHasMore === undefined || valuePreview === undefined
    || valueHasMore === undefined || childCount === undefined) return undefined;
  return { id, kind, spanStart, spanEnd, label, labelHasMore, valuePreview, valueHasMore, childCount };
}

function documentErrorValue(value: unknown, size: number): IpcErrorPayload | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  if (value.code === "invalid_json") {
    const parseError = parseErrorValue(value.parseError, size);
    return parseError ? { code: value.code, message: value.message, parseError } : undefined;
  }
  if (value.code === "unsupported_encoding" && !("parseError" in value)) {
    return { code: value.code, message: value.message };
  }
  return undefined;
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

function handleSearchReveal(match: SearchMatch): void {
  if (rawTab.disabled) return;
  const revealStart = match.field === "rawSource" ? match.matchStart : match.sourceSpanStart;
  const revealEnd = match.field === "rawSource" ? match.matchEnd : match.sourceSpanEnd;
  rawView.revealRange(
    revealStart,
    revealEnd,
    `${match.field === "rawSource" ? "Raw Source" : match.field === "key" ? "Key" : "Value"} search match`
  );
  setActiveView("raw");
}

function handleEntryError(error: unknown): void {
  handleCurrentSessionAsyncError(ipcError(error));
}

function handleCollectionSelection(node: NodeDto, ordinal: number): void {
  const summary = state.summary;
  if (!summary || summary.mode !== "collection" || summary.documentError !== null) return;
  const previousView = activeView;
  state.generation += 1;
  state.selectedItem = { node, ordinal };
  state.selectedEntry = null;
  state.error = null;
  state.invalidatedRevision = null;
  searchView.clear();
  if (contentViewer.isOpen) contentViewer.clear(false);
  treeView.setSession({
    mode: "collection",
    sessionRevision: summary.sessionRevision,
    scopeId: null,
    sourceSize: summary.size,
    ariaLabel: `JSON Item ${ordinal} structure`,
    scopeLabel: `Item ${ordinal}`
  }, node);
  rawView.setItemSession(summary.sessionRevision, node, summary.size, "collection");
  if (previousView === "tree") setActiveView("tree");
  else if (previousView === "raw") setActiveView("raw");
  else setActiveView("semantic");
  render();
}

function summaryIsInvalidated(summary: FileSummary): boolean {
  return state.invalidatedRevision === summary.sessionRevision;
}

function handleCurrentSessionAsyncError(parsed: IpcErrorPayload, stopEntryIndex = false): void {
  state.error = parsed;
  const summary = state.summary;
  if (stopEntryIndex && summary?.mode === "entry") {
    state.scanStoppedRevision = summary.sessionRevision;
  }
  if (parsed.code === "file_changed" || parsed.code === "stale_session") {
    if (summary) state.invalidatedRevision = summary.sessionRevision;
    contentViewer.clearOverridesForRevision(summary?.sessionRevision);
    if (contentViewer.isOpen) contentViewer.clear(false);
    searchView.invalidate();
    rawView.clear();
    treeView.clear();
    if (summary?.mode === "entry") {
      state.scanStoppedRevision = summary.sessionRevision;
      state.selectedEntry = null;
      entryList.clear();
      setActiveView("semantic");
    } else if (summary?.mode === "collection") {
      state.selectedItem = null;
      collectionList.clear();
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
  searchView.clear();
  contentViewer.clearOverridesForRevision(selection.sessionRevision);
  contentViewer.clear(false);
  if (selection.sessionRevision !== summary.sessionRevision + 1) {
    state.error = { code: "internal", message: "Entry selection returned an unexpected session revision." };
    render();
    return;
  }

  const previousView = activeView;
  state.generation += 1;
  state.summary = { ...summary, sessionRevision: selection.sessionRevision };
  state.selectedEntry = selection.entry;
  state.selectedItem = null;
  state.error = null;
  state.invalidatedRevision = null;
  state.scanQueued = null;
  state.scanStoppedRevision = null;
  entryList.adoptSelection(selection, selection.sessionRevision);

  const valid = selection.entry.status === "valid";
  const invalidJson = selection.entry.status === "invalidJson";
  const invalidUtf8 = selection.entry.status === "invalidUtf8";
  const oversized = selection.entry.status === "oversized";
  const rootMatchesStatus = valid ? selection.root !== null : selection.root === null;
  if (!rootMatchesStatus) {
    state.error = { code: "internal", message: "Entry selection returned an inconsistent Tree root." };
    treeView.setSession({
      mode: "entry",
      sessionRevision: selection.sessionRevision,
      scopeId: null,
      sourceSize: entrySourceSize(selection.entry),
      ariaLabel: "JSON Entry structure",
      scopeLabel: entryScopeLabel(selection.entry.location.entryOrdinal)
    }, null);
    rawView.clear("Tree is unavailable because the Entry selection was inconsistent.");
    setActiveView("semantic");
  } else {
    treeView.setSession(
      {
        mode: "entry",
        sessionRevision: selection.sessionRevision,
        scopeId: null,
        sourceSize: entrySourceSize(selection.entry),
        ariaLabel: "JSON Entry structure",
        scopeLabel: entryScopeLabel(selection.entry.location.entryOrdinal)
      },
      valid ? selection.root : null
    );
    let rawAvailable = false;
    if (valid && selection.root) {
      rawView.setSession(selection.sessionRevision, selection.root, entrySourceSize(selection.entry), "entry");
      rawAvailable = true;
    } else if (invalidJson || invalidUtf8 || oversized) {
      rawAvailable = rawView.setNonValidEntry(selection.sessionRevision, selection.entry);
    } else {
      rawView.clear("Select a valid Entry to open Raw bytes.");
    }
    if ((invalidJson || invalidUtf8 || oversized) && !rawAvailable) {
      state.error = { code: "internal", message: "Invalid Entry Raw bytes could not be opened." };
      setActiveView("semantic");
    } else if ((valid || invalidJson || invalidUtf8 || oversized) && previousView === "raw") {
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
  searchView.clear();
  contentViewer.clearOverridesForRevision(next.sessionRevision);
  contentViewer.clear(false);
  state.summary = next;
  state.selectedEntry = null;
  state.error = null;
  state.invalidatedRevision = null;
  state.scanQueued = null;
  state.scanStoppedRevision = null;
  rawView.clear("Select a valid Entry to open Raw bytes.");
  entryList.resync(next.sessionRevision, next.progress);
  treeView.setSession({
    mode: "entry",
    sessionRevision: next.sessionRevision,
    scopeId: null,
    sourceSize: 1,
    ariaLabel: "JSON Entry structure",
    scopeLabel: "Entry"
  }, null);
  setActiveView("semantic");
  render();
  if (!next.progress.complete) void scanEntries(generation, next.sessionRevision);
}

function fileSummaryValue(value: unknown): FileSummary | undefined {
  if (!isRecord(value)) return undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  const size = numberValue(value.size);
  const sessionRevision = numberValue(value.sessionRevision);
  const warning = typeof value.manyInvalidUtf8Warning === "boolean" ? value.manyInvalidUtf8Warning : undefined;
  if (path === undefined || size === undefined || sessionRevision === undefined || warning === undefined) return undefined;
  const rootValue = value.root;
  const root = rootValue === null ? null : nodeDtoValue(rootValue, size);
  const progressValue = value.progress;
  const progress = progressValue === null ? null : jsonlProgressValue(progressValue);
  const documentError = documentErrorValue(value.documentError, size);
  if (rootValue !== null && root === undefined || progressValue !== null && progress === undefined
    || documentError === undefined) return undefined;
  const parsedRoot = root ?? null;

  if (value.mode === "entry") {
    if (parsedRoot !== null || progress === null || documentError !== null) return undefined;
  } else if (value.mode === "collection") {
    if (parsedRoot === null || parsedRoot.kind !== "array" || progress !== null || warning || documentError !== null) return undefined;
  } else if (value.mode === "document") {
    if (progress !== null || warning) return undefined;
    if (documentError === null && (parsedRoot === null || parsedRoot.kind === "array")) return undefined;
    if (documentError !== null && parsedRoot !== null) return undefined;
  } else {
    return undefined;
  }
  return {
    path,
    size,
    mode: value.mode,
    root: parsedRoot,
    progress: progress ?? null,
    manyInvalidUtf8Warning: warning,
    documentError,
    sessionRevision
  };
}

function entrySummaryValue(value: unknown): FileSummary | undefined {
  const summary = fileSummaryValue(value);
  return summary?.mode === "entry" ? summary : undefined;
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

function entryScopeLabel(ordinal: number): string {
  return `Entry ${ordinal + 1}`;
}

function entrySourceSize(entry: EntrySelectionDto["entry"]): number {
  const { byteStart, byteEnd } = entry.location;
  return byteEnd >= byteStart ? byteEnd - byteStart : 0;
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

  const invalidated = summaryIsInvalidated(summary);
  const rawOnly = summary.documentError !== null;
  const mode = invalidated ? "Unavailable" : rawOnly ? "Raw-only Document" : modeLabel(summary.mode);
  setText(fileName, fileLabel(summary.path));
  setText(filePath, summary.path);
  setText(fileMode, invalidated ? "Unavailable" : rawOnly ? mode : `${mode} Mode`);
  setText(navigationMode, mode);
  setText(
    navigationState.querySelector("strong") as HTMLElement,
    invalidated ? "Unavailable" : rawOnly ? "Raw-only document" : mode === "Entry" ? "Entry index" : `${mode} outline`
  );
  setText(navigationState.querySelector("span:last-child") as HTMLElement, navigationCopy(summary));
  setText(readerState.querySelector("h3") as HTMLElement, readerTitle(summary));
  setText(readerState.querySelector("p") as HTMLElement, readerCopy(summary));
  setText(inspectorPath, summary.path);
  setText(inspectorSize, `${formatBytes(summary.size)} (${summary.size.toLocaleString()} bytes)`);
  setText(inspectorMode, invalidated ? "Unavailable" : rawOnly ? mode : `${mode} Mode`);
  setText(inspectorRevision, String(summary.sessionRevision));
  const stopped = state.scanStoppedRevision === summary.sessionRevision;
  setText(
    inspectorProgress,
    invalidated ? "File changed · Raw unavailable" : rawOnly ? "Raw bytes available" : summary.progress ? stopped ? `Indexing stopped · ${progressLabel(summary.progress)}` : progressLabel(summary.progress) : "Structure loaded"
  );
  inspectorEmpty.hidden = true;
  inspectorWarning.hidden = !summary.manyInvalidUtf8Warning;
  setText(inspectorWarning, "Many entries are not valid UTF-8. The file remains open in byte-safe mode.");
  setText(statusMode, invalidated ? "Unavailable" : rawOnly ? mode : `${mode} Mode`);
  setText(statusSize, formatBytes(summary.size));
  setText(statusProgress, invalidated ? "File changed · Raw unavailable" : rawOnly ? "Raw bytes available" : statusProgressLabel(summary));
  statusWarning.hidden = !summary.manyInvalidUtf8Warning;
  setText(statusReady, invalidated ? "Unavailable" : state.opening ? "Opening…" : stopped ? "Indexing stopped" : summary.progress && !summary.progress.complete ? "Indexing…" : "Ready");
}

function navigationCopy(summary: FileSummary): string {
  if (summaryIsInvalidated(summary)) return "File changed · Raw unavailable";
  if (summary.documentError) return "Raw bytes available.";
  if (summary.mode === "entry" && summary.progress) {
    if (state.scanStoppedRevision === summary.sessionRevision) return `Indexing stopped · ${summary.progress.indexedEntries.toLocaleString()} entries indexed.`;
    return summary.progress.complete ? "Indexed entries are ready." : `${summary.progress.indexedEntries.toLocaleString()} entries indexed so far.`;
  }
  return summary.mode === "collection" ? "Items load on demand." : "Outline loads on demand.";
}

function readerTitle(summary: FileSummary): string {
  if (summaryIsInvalidated(summary)) return "Unavailable";
  if (summary.documentError) {
    return summary.documentError.code === "invalid_json" ? "Invalid JSON" : "Unsupported encoding";
  }
  if (state.scanStoppedRevision === summary.sessionRevision) return "Indexing stopped";
  if (summary.mode === "entry" && summary.progress && !summary.progress.complete) return "Indexing in the background";
  return `${modeLabel(summary.mode)} reader ready`;
}

function readerCopy(summary: FileSummary): string {
  if (summaryIsInvalidated(summary)) return "File changed · Raw unavailable";
  if (summary.documentError) {
    return summary.documentError.code === "invalid_json"
      ? "Tree and Semantic are unavailable because this document could not be parsed. Original Raw bytes remain available."
      : "Tree and Semantic are unavailable. Raw provides Lossy Text and Hex; source bytes are unchanged.";
  }
  if (summary.mode === "entry" && summary.progress) {
    if (state.scanStoppedRevision === summary.sessionRevision) return `Indexing stopped at ${summary.progress.indexedEntries.toLocaleString()} entries. The partial index remains available.`;
    if (state.selectedEntry?.status === "invalidJson") return "Tree is unavailable. Original Raw bytes are available.";
    if (state.selectedEntry?.status === "invalidUtf8") return "Invalid UTF-8 Entry selected. Raw provides Lossy Text and Hex. Source bytes are unchanged.";
    if (state.selectedEntry?.status === "oversized") {
      const { byteStart, byteEnd } = state.selectedEntry.location;
      const length = byteEnd - byteStart;
      if (Number.isSafeInteger(byteStart) && Number.isSafeInteger(byteEnd) && byteStart >= 0 && byteEnd > byteStart && Number.isSafeInteger(length) && length > MAX_ENTRY_BYTES) {
        return `Oversized Entry selected. Raw shows bounded 128 KiB windows; use Previous and Next to page through the Entry.`;
      }
    }
    if (state.selectedEntry) {
      const entry = state.selectedEntry;
      return entry.status === "valid"
        ? `Entry ${entry.location.entryOrdinal + 1} is selected. Tree is available.`
        : `Entry ${entry.location.entryOrdinal + 1} is selected. Tree is unavailable for ${entryStatusLabel(entry.status)}.`;
    }
    return "Select a valid Entry to enable Tree.";
  }
  if (summary.mode === "collection") {
    return state.selectedItem
      ? `Item ${state.selectedItem.ordinal} is selected. Tree and Raw are available.`
      : "Select an Item to enable Tree, Raw, and current-scope search.";
  }
  return "The semantic projection for this document will appear here.";
}

function statusProgressLabel(summary: FileSummary): string {
  if (summaryIsInvalidated(summary)) return "File changed · Raw unavailable";
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

function currentSearchScope(): SearchScope | null {
  const summary = state.summary;
  if (!summary || summaryIsInvalidated(summary)) return null;
  const enabled = !state.opening && !state.selectionBusy;
  if (summary.documentError) {
    return {
      label: "Raw-only Document",
      description: enabled
        ? "Current scope: Document bytes. Decoded search is unavailable; Raw Source searches the original bytes."
        : "Current scope: Raw-only Document. Search is temporarily unavailable.",
      enabled,
      decodedEnabled: false,
      scopeStart: 0,
      scopeEnd: summary.size,
      sessionRevision: summary.sessionRevision,
      targetNodeId: null
    };
  }
  if (summary.mode === "document") {
    return {
      label: "Document root",
      description: enabled ? "Current scope: Document root." : "Current scope: Document root. Search is temporarily unavailable.",
      enabled,
      decodedEnabled: true,
      scopeStart: 0,
      scopeEnd: summary.size,
      sessionRevision: summary.sessionRevision,
      targetNodeId: null
    };
  }
  if (summary.mode === "collection") {
    const item = state.selectedItem;
    if (!item) {
      return {
        label: "Selected Item",
        description: "Current scope: selected Item. Select an Item to enable search.",
        enabled: false,
        decodedEnabled: true,
        scopeStart: 0,
        scopeEnd: 0,
        sessionRevision: summary.sessionRevision,
        targetNodeId: null
      };
    }
    return {
      label: `Item ${item.ordinal}`,
      description: enabled ? `Current scope: selected Item ${item.ordinal}.` : `Current scope: selected Item ${item.ordinal}. Search is temporarily unavailable.`,
      enabled,
      decodedEnabled: true,
      scopeStart: item.node.spanStart,
      scopeEnd: item.node.spanEnd,
      sessionRevision: summary.sessionRevision,
      targetNodeId: item.node.id
    };
  }
  const entry = state.selectedEntry;
  if (!entry) {
    return {
      label: "Selected Entry",
      description: "Current scope: selected Entry. Select an Entry to enable search.",
      enabled: false,
      decodedEnabled: true,
      scopeStart: 0,
      scopeEnd: 0,
      sessionRevision: summary.sessionRevision,
      targetNodeId: null
    };
  }
  const scopeEnd = entrySourceSize(entry);
  const decodedEnabled = entry.status === "valid";
  const status = entryStatusLabel(entry.status);
  return {
    label: `Entry ${entry.location.entryOrdinal + 1}`,
    description: enabled
      ? decodedEnabled
        ? `Current scope: selected Entry ${entry.location.entryOrdinal + 1}.`
        : `Current scope: selected Entry ${entry.location.entryOrdinal + 1} (${status}). Raw Source only.`
      : `Current scope: selected Entry ${entry.location.entryOrdinal + 1}. Search is temporarily unavailable.`,
    enabled,
    decodedEnabled,
    scopeStart: 0,
    scopeEnd,
    sessionRevision: summary.sessionRevision,
    targetNodeId: null
  };
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
  collectionList.setOpening(state.opening);
  const collectionSummary = state.summary;
  const collectionActive = collectionSummary !== null
    && collectionSummary.mode === "collection"
    && collectionSummary.documentError === null
    && !summaryIsInvalidated(collectionSummary);
  collectionNavigation.hidden = !collectionActive;
  if (collectionActive) {
    navigationState.hidden = true;
    entryNavigation.hidden = true;
  } else {
    collectionNavigation.hidden = true;
  }
  rawView.setBusy(state.opening || state.selectionBusy);
  searchView.setScope(currentSearchScope());
  renderPreviewButton();
  renderSummary();
  renderError();
}

async function chooseFile(): Promise<void> {
  if (state.opening || state.selectionBusy) return;
  contentViewer.clear(false);
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
    state.pendingChoicePreviousError = state.error;
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

function failClosedSummary(generation: number): void {
  if (generation !== state.generation) return;
  contentViewer.clear(false);
  state.generation += 1;
  state.summary = null;
  state.selectedEntry = null;
  state.selectedItem = null;
  state.error = { code: "internal", message: "The file summary returned by the backend was invalid." };
  state.invalidatedRevision = null;
  state.opening = false;
  state.selectionBusy = false;
  state.pendingChoicePath = null;
  state.pendingChoicePreviousError = null;
  state.scanQueued = null;
  state.scanStoppedRevision = null;
  entryList.clear();
  collectionList.clear();
  treeView.clear();
  rawView.clear();
  setActiveView("semantic");
  render();
  openButton.focus();
}

async function openPath(path: string, openAs: "json" | "jsonl" | null, generation: number): Promise<void> {
  searchView.clear();
  contentViewer.clear(false);
  try {
    const value = await invoke<unknown>("open_file", { path, openAs });
    if (generation !== state.generation) return;
    const summary = fileSummaryValue(value);
    if (!summary) {
      failClosedSummary(generation);
      return;
    }
    state.summary = summary;
    state.error = summary.documentError;
    state.invalidatedRevision = null;
    state.pendingChoicePath = null;
    state.pendingChoicePreviousError = null;
    state.scanQueued = null;
    state.scanStoppedRevision = null;
    state.opening = false;
    entryList.setOpening(false);
    state.selectedEntry = null;
    state.selectedItem = null;
    if (summary.documentError) {
      state.selectedEntry = null;
      entryList.setSession(null);
      collectionList.setSession(null);
      treeView.clear();
      if (!rawView.setRawDocument(summary.sessionRevision, summary.size, summary.documentError)) {
        failClosedSummary(generation);
        return;
      }
      setActiveView("semantic");
      render();
      return;
    }
    state.error = null;
    collectionList.setSession(summary.mode === "collection" && summary.root
      ? { revision: summary.sessionRevision, root: summary.root, sourceSize: summary.size }
      : null);
    if (summary.mode === "collection") {
      treeView.clear("Select an Item to enable Tree.");
      rawView.clear("Select an Item to open Raw bytes.");
    } else {
      treeView.setSession({
        mode: summary.mode,
        sessionRevision: summary.sessionRevision,
        scopeId: null,
        sourceSize: summary.size,
        ariaLabel: "JSON structure",
        scopeLabel: modeLabel(summary.mode)
      });
      if (summary.root) rawView.setSession(summary.sessionRevision, summary.root, summary.size, summary.mode);
      else rawView.clear("Select a valid Entry to open Raw bytes.");
    }
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
      state.pendingChoicePath = null;
      state.pendingChoicePreviousError = null;
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
previewButton.addEventListener("click", () => {
  const target = selectedStringTarget;
  if (target) void contentViewer.open(target, previewButton);
});
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
    if (state.error?.code === "mode_choice_required") {
      state.error = state.pendingChoicePreviousError ?? state.summary?.documentError ?? null;
    }
    state.pendingChoicePreviousError = null;
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
    if (modeDialog.open || contentViewer.isOpen) return;
    void chooseFile();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    if (modeDialog.open || contentViewer.isOpen) return;
    event.preventDefault();
    searchView.focusQuery();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g") {
    event.preventDefault();
    if (modeDialog.open || contentViewer.isOpen || state.opening || state.summary?.mode !== "entry") return;
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
    if (searchView.handleEscape(event)) return;
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
