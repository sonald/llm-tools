import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { ContentViewer, type ContentTarget } from "./content-viewer";
import { CollectionList } from "./collection-list";
import { ConversationView, type ConversationContext, type ConversationPresentation } from "./conversation-view";
import { DocumentOutline } from "./document-outline";
import { GenericReader } from "./generic-reader";
import { EntryList, type EntrySelectionDto } from "./entry-list";
import { MAX_ENTRY_BYTES, RawView } from "./raw-view";
import { SearchView, type SearchMatch, type SearchScope } from "./search-view";
import { TreeView, type NodeDto } from "./tree-view";
import { applyStaticTranslations, locale, t } from "./i18n";
import { parseErrorMessage } from "./parse-error-message";
import { ProjectionBudget } from "./projection-budget";
import { NavigationSearch } from "./navigation-search";

applyStaticTranslations();

type FileMode = "document" | "collection" | "entry";

type ParseErrorDto = {
  code?: string;
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
  eventStreamHint: boolean | null;
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
  fileGeneration: number;
};

type IpcErrorPayload = {
  code: string;
  message: string;
  parseError?: ParseErrorDto;
};

type ReadingSnapshot = {
  view: "semantic" | "tree" | "raw";
  recordOrdinal: number | null;
  subtree: NodeDto | null;
  subtreePath: string;
  focusNode: NodeDto | null;
  focusPath: string;
  expanded: number[];
  anchor: string | null;
  scrollTop: number;
};

type AppState = {
  summary: FileSummary | null;
  selectedEntry: EntrySelectionDto["entry"] | null;
  selectedEntryRoot: NodeDto | null;
  selectedItem: { node: NodeDto; ordinal: number } | null;
  selectionBusy: boolean;
  error: IpcErrorPayload | null;
  opening: boolean;
  generation: number;
  pendingChoicePath: string | null;
  pendingChoicePreviousError: IpcErrorPayload | null;
  mobileDrawer: "navigation" | "inspector" | null;
  navigationOpen: boolean;
  detailOpen: boolean;
  findScope: "file" | "record" | "field";
  textSize: "sm" | "md" | "lg";
  focusNode: NodeDto | null;
  focusPath: string;
  subtree: NodeDto | null;
  subtreePath: string;
  backStack: ReadingSnapshot[];
  forwardStack: ReadingSnapshot[];
  pendingHistory: { snapshot: ReadingSnapshot; generation: number; ordinal: number; direction: "back" | "forward" } | null;
  readingScrollTop: number;
  locateNote: string;
  userLockedView: boolean;
  conversationMode: ConversationPresentation;
  scanInFlight: { generation: number; sessionRevision: number } | null;
  scanQueued: { generation: number; sessionRevision: number } | null;
  scanStoppedRevision: number | null;
  invalidatedRevision: number | null;
};

const state: AppState = {
  summary: null,
  selectedEntry: null,
  selectedEntryRoot: null,
  selectedItem: null,
  selectionBusy: false,
  error: null,
  opening: false,
  generation: 0,
  pendingChoicePath: null,
  pendingChoicePreviousError: null,
  mobileDrawer: null,
  navigationOpen: true,
  detailOpen: false,
  findScope: "record",
  textSize: "md",
  focusNode: null,
  focusPath: "",
  subtree: null,
  subtreePath: "",
  backStack: [],
  forwardStack: [],
  pendingHistory: null,
  readingScrollTop: 0,
  locateNote: "",
  userLockedView: false,
  conversationMode: "hidden",
  scanInFlight: null,
  scanQueued: null,
  scanStoppedRevision: null,
  invalidatedRevision: null
};

const projectionBudget = new ProjectionBudget();

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
const navigationSearchPanel = required<HTMLElement>("navigation-search-panel");
const navigationSearchForm = required<HTMLFormElement>("navigation-search-form");
const navigationSearchQuery = required<HTMLInputElement>("navigation-search-query");
const navigationSearchSyntax = required<HTMLSelectElement>("navigation-search-syntax");
const navigationSearchRepresentation = required<HTMLSelectElement>("navigation-search-representation");
const navigationSearchClear = required<HTMLButtonElement>("navigation-search-clear");
const navigationSearchStop = required<HTMLButtonElement>("navigation-search-stop");
const navigationSearchPrevious = required<HTMLButtonElement>("navigation-search-prev");
const navigationSearchNext = required<HTMLButtonElement>("navigation-search-next");
const navigationSearchStatus = required<HTMLElement>("navigation-search-status");
const navigationSearchDescription = required<HTMLElement>("navigation-search-description");
const navigationSearchDisplayModes = navigationSearchPanel.querySelectorAll<HTMLInputElement>("input[name=navigation-search-display]");
const navigationSearchResultsPanel = required<HTMLElement>("navigation-search-results-panel");
const navigationSearchResults = required<HTMLElement>("navigation-search-results");
const navigationSearchResultsPrevious = required<HTMLButtonElement>("navigation-search-results-prev");
const navigationSearchResultsNext = required<HTMLButtonElement>("navigation-search-results-next");
const collectionNavigation = required<HTMLElement>("collection-navigation");
const collectionRootButton = required<HTMLButtonElement>("collection-root");
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
const conversationPanel = required<HTMLElement>("conversation-view");
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
const readerBack = required<HTMLButtonElement>("reader-back");
const readerForward = required<HTMLButtonElement>("reader-forward");
const readerBreadcrumb = required<HTMLElement>("reader-breadcrumb");
const findScopeLabel = required<HTMLElement>("find-scope-label");
const findScopeSelect = required<HTMLSelectElement>("find-scope");
const locateNoteElement = required<HTMLElement>("locate-note");
const textSizeSelect = required<HTMLSelectElement>("text-size");
const genericReaderHost = required<HTMLElement>("generic-reader");
const outlineHost = required<HTMLElement>("document-outline");
const fieldDetail = required<HTMLElement>("field-detail");
const fieldDetailTitle = required<HTMLElement>("field-detail-title");
const fieldDetailNote = required<HTMLElement>("field-detail-note");
const fieldDetailRaw = required<HTMLElement>("field-detail-raw");
const fieldCopyText = required<HTMLButtonElement>("field-copy-text");
const fieldCopyRaw = required<HTMLButtonElement>("field-copy-raw");
const fieldReadAlone = required<HTMLButtonElement>("field-read-alone");
const fieldCopyStatus = required<HTMLElement>("field-copy-status");
const fieldTechnicalBody = required<HTMLElement>("field-technical-body");
const errorReload = required<HTMLButtonElement>("error-reload");
const errorRetry = required<HTMLButtonElement>("error-retry");
const errorViewSource = required<HTMLButtonElement>("error-view-source");
const errorLocate = required<HTMLButtonElement>("error-locate");
const conversationOffer = required<HTMLButtonElement>("conversation-offer");
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
const contentViewerWrap = required<HTMLButtonElement>("content-viewer-wrap");
const contentViewerNoWrap = required<HTMLButtonElement>("content-viewer-no-wrap");
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
const parsedSearchPeek = {
  panel: required<HTMLElement>("content-viewer-parsed-search-peek"),
  field: required<HTMLElement>("content-viewer-parsed-search-peek-field"),
  node: required<HTMLElement>("content-viewer-parsed-search-peek-node"),
  path: required<HTMLElement>("content-viewer-parsed-search-peek-path"),
  sourceSpan: required<HTMLElement>("content-viewer-parsed-search-peek-source-span"),
  displayedRange: required<HTMLElement>("content-viewer-parsed-search-peek-displayed-range"),
  decodedRange: required<HTMLElement>("content-viewer-parsed-search-peek-decoded-range"),
  source: required<HTMLElement>("content-viewer-parsed-search-peek-source"),
  note: required<HTMLElement>("content-viewer-parsed-search-peek-note")
};
const sharedTextPanel = required<HTMLElement>("content-viewer-text-panel");
const stringRepresentations = required<HTMLElement>("content-viewer-string-representations");
const stringRenderedTab = required<HTMLButtonElement>("content-viewer-rendered-tab");
const stringDecodedTab = required<HTMLButtonElement>("content-viewer-decoded-source-tab");
const stringRawTab = required<HTMLButtonElement>("content-viewer-string-raw-lexeme-tab");
const htmlRepresentations = required<HTMLElement>("content-viewer-html-representations");
const htmlPreviewTab = required<HTMLButtonElement>("content-viewer-html-preview-tab");
const htmlSourceTab = required<HTMLButtonElement>("content-viewer-html-source-tab");
const htmlRawTab = required<HTMLButtonElement>("content-viewer-html-raw-lexeme-tab");
const htmlPreviewPanel = required<HTMLElement>("content-viewer-html-preview-panel");
const htmlPreviewFrame = required<HTMLIFrameElement>("content-viewer-html-preview-frame");
const contentViewerSearchForm = required<HTMLFormElement>("content-viewer-search");
const contentViewerSearchQuery = required<HTMLInputElement>("content-viewer-search-query");
const contentViewerSearchDecoded = required<HTMLInputElement>("content-viewer-search-decoded");
const contentViewerSearchRaw = required<HTMLInputElement>("content-viewer-search-raw");
const contentViewerSearchSubmit = required<HTMLButtonElement>("content-viewer-search-submit");
const contentViewerSearchDescription = required<HTMLElement>("content-viewer-search-description");
const contentViewerSearchPanel = required<HTMLElement>("content-viewer-search-panel");
const contentViewerSearchResultsPanel = required<HTMLElement>("content-viewer-search-results-panel");
const contentViewerSearchStatus = required<HTMLElement>("content-viewer-search-status");
const contentViewerSearchResults = required<HTMLElement>("content-viewer-search-results");
const contentViewerSearchPrevious = required<HTMLButtonElement>("content-viewer-search-prev");
const contentViewerSearchNext = required<HTMLButtonElement>("content-viewer-search-next");

const PREVIEW_ARIA_LABEL = t("shell.previewSelectedString");
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
    wrap: { wrap: contentViewerWrap, noWrap: contentViewerNoWrap },
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
      sharedTextPanel,
      parsedSearchPeek
    },
    string: {
      representations: stringRepresentations,
      renderedTab: stringRenderedTab,
      decodedTab: stringDecodedTab,
      rawTab: stringRawTab
    },
    html: {
      representations: htmlRepresentations,
      previewTab: htmlPreviewTab,
      sourceTab: htmlSourceTab,
      rawTab: htmlRawTab,
      previewPanel: htmlPreviewPanel,
      previewFrame: htmlPreviewFrame
    },
    search: {
      form: contentViewerSearchForm,
      query: contentViewerSearchQuery,
      decoded: contentViewerSearchDecoded,
      rawSource: contentViewerSearchRaw,
      submit: contentViewerSearchSubmit,
      description: contentViewerSearchDescription,
      panel: contentViewerSearchPanel,
      resultsPanel: contentViewerSearchResultsPanel,
      status: contentViewerSearchStatus,
      results: contentViewerSearchResults,
      previous: contentViewerSearchPrevious,
      next: contentViewerSearchNext
    }
  },
  invoke,
  projectionBudget,
  onSessionError: (error) => handleCurrentSessionAsyncError(ipcError(error)),
  onClose: (restoreFocus) => {
    if (restoreFocus) focusContentViewerFallback();
  }
});

const treeView = new TreeView({
  projectionBudget,
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
  projectionBudget,
  onReveal: handleSearchReveal,
  onFileSearch: (query, representation) => {
    navigationSearchQuery.value = query;
    navigationSearchQuery.dispatchEvent(new Event("input", { bubbles: true }));
    navigationSearchSyntax.value = "literal";
    navigationSearchRepresentation.value = representation;
    navigationSearchForm.requestSubmit();
    navigationSearchDisplayModes.forEach((radio) => {
      if (radio.value === "filtered") radio.click();
    });
  },
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
  projectionBudget,
  section: collectionNavigation,
  goInput: collectionGoInput,
  goButton: collectionGoButton,
  goError: collectionGoError,
  list: collectionListPanel,
  status: collectionListStatus,
  retry: collectionListRetry,
  invoke,
  onSelection: handleCollectionSelection,
  onError: (error) => {
    if (state.pendingHistory && !["file_changed", "stale_session"].includes(ipcError(error).code)) cancelPendingHistory();
    handleCurrentSessionAsyncError(ipcError(error));
  }
});

const navigationSearch = new NavigationSearch({
  panel: navigationSearchPanel,
  form: navigationSearchForm,
  query: navigationSearchQuery,
  syntax: navigationSearchSyntax,
  representation: navigationSearchRepresentation,
  clear: navigationSearchClear,
  stop: navigationSearchStop,
  previous: navigationSearchPrevious,
  next: navigationSearchNext,
  status: navigationSearchStatus,
  description: navigationSearchDescription,
  displayModes: navigationSearchDisplayModes,
  resultsPanel: navigationSearchResultsPanel,
  results: navigationSearchResults,
  resultsPrevious: navigationSearchResultsPrevious,
  resultsNext: navigationSearchResultsNext
}, (ordinal) => {
  const current = state.summary?.mode === "entry"
    ? state.selectedEntry?.location.entryOrdinal
    : state.selectedItem?.ordinal;
  if (current !== ordinal) state.locateNote = t("reader.enteredRecord", { ordinal: ordinal + 1 });
  if (state.summary?.mode === "entry") entryList.navigateToOrdinal(ordinal);
  else if (state.summary?.mode === "collection") collectionList.navigateToOrdinal(ordinal);
  render();
}, (mode) => {
  entryList.setSearchFiltered(mode === "filtered");
  collectionList.setSearchFiltered(mode === "filtered");
}, (progress) => {
  entryList.setNavigationSearch(state.summary?.mode === "entry" ? progress : null);
  collectionList.setNavigationSearch(state.summary?.mode === "collection" ? progress : null);
}, () => {
  if (state.summary?.mode === "entry") entryList.showSelected();
  else if (state.summary?.mode === "collection") collectionList.showSelected();
});

for (const button of [entryGoButton, collectionGoButton]) {
  button.addEventListener("click", () => navigationSearch.setDisplayMode("highlight"), { capture: true });
}
for (const input of [entryGoInput, collectionGoInput]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") navigationSearch.setDisplayMode("highlight");
  }, { capture: true });
}

const conversationView = new ConversationView({
  panel: conversationPanel,
  invoke,
  projectionBudget,
  onError: (error) => handleCurrentSessionAsyncError(ipcError(error)),
  onRaw: handleConversationRaw,
  onTree: handleConversationTree,
  onContent: handleConversationContent,
  onPresentation: (mode) => handleConversationPresentation(mode)
});

const genericReader = new GenericReader({
  host: genericReaderHost,
  invoke,
  onFocus: (node, path) => rememberFocus(node, path),
  onReadAlone: (node, path) => readFieldAlone(node, path),
  onViewRaw: (node, path) => void viewFieldRaw(node, path),
  onExpand: (node, path, opener) => expandReading(node, path, opener),
  onCopy: (node, path, format) => copyField(node, path, format),
  onReadMessages: (node) => void conversationView.useMessageArray(node),
  onError: (error) => handleCurrentSessionAsyncError(ipcError(error))
});

const documentOutline = new DocumentOutline(
  outlineHost,
  invoke,
  (node, path) => rememberFocus(node, path),
  (error) => handleCurrentSessionAsyncError(ipcError(error))
);

function required<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(t("main.missingUiElement", { id }));
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
  const hasCode = Object.prototype.hasOwnProperty.call(value, "code");
  const code = hasCode ? typeof value.code === "string" ? value.code : undefined : undefined;
  const message = typeof value.message === "string" ? value.message : undefined;
  const byteOffset = numberValue(value.byteOffset);
  const line = numberValue(value.line);
  const column = numberValue(value.column);
  if ((hasCode && code === undefined) || message === undefined || byteOffset === undefined || line === undefined || column === undefined
    || line < 1 || column < 1 || maxByteOffset !== undefined && byteOffset > maxByteOffset) {
    return undefined;
  }
  return { code, message, byteOffset, line, column };
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
    const message = typeof value.message === "string" ? value.message : t("main.fileCouldNotBeOpened");
    const parseError = parseErrorValue(value.parseError);
    return parseError ? { code, message, parseError } : { code, message };
  }
  if (value instanceof Error) {
    return { code: "open_failed", message: value.message };
  }
  return { code: "open_failed", message: t("main.fileCouldNotBeOpened") };
}

function handleEntryProgress(progress: JsonlProgressDto): void {
  const summary = state.summary;
  if (!summary || summary.mode !== "entry") return;
  const validated = jsonlProgressValue(progress);
  if (!validated) {
    state.error = { code: "internal", message: t("main.invalidJsonlProgress") };
    state.scanStoppedRevision = summary.sessionRevision;
    render();
    return;
  }
  state.summary = { ...summary, progress: validated };
  render();
}

function handleEntrySelectionBusy(busy: boolean): void {
  if (state.selectionBusy === busy) return;
  state.selectionBusy = busy;
  render();
}

function canUseSource(): boolean {
  return state.summary !== null && !summaryIsInvalidated(state.summary);
}

function rangeRoot(): NodeDto | null {
  const summary = state.summary;
  if (!summary || summary.documentError) return null;
  if (summary.mode === "entry") return state.selectedEntry?.status === "valid" ? state.selectedEntryRoot : null;
  if (summary.mode === "collection") return state.selectedItem?.node ?? summary.root;
  return summary.root;
}

function currentScopeRoot(): NodeDto | null {
  return state.subtree ?? rangeRoot();
}

function sourceKind(): "document" | "collection" | "entry" {
  if (state.summary?.mode === "entry") return "entry";
  if (state.summary?.mode === "collection") return "collection";
  return "document";
}

function sourceSizeForRange(): number {
  const summary = state.summary;
  if (!summary) return 0;
  if (summary.mode === "entry" && state.selectedEntry) return entrySourceSize(state.selectedEntry);
  return summary.size;
}

function readerSession(): { revision: number; sourceSize: number; scopeId: null } | null {
  const summary = state.summary;
  const root = currentScopeRoot();
  if (!summary || !root || summaryIsInvalidated(summary)) return null;
  return { revision: summary.sessionRevision, sourceSize: sourceSizeForRange(), scopeId: null };
}

function captureSnapshot(): ReadingSnapshot {
  return {
    view: activeView,
    recordOrdinal: state.summary?.mode === "entry" ? state.selectedEntry?.location.entryOrdinal ?? null
      : state.summary?.mode === "collection" ? state.selectedItem?.ordinal ?? null : null,
    subtree: state.subtree,
    subtreePath: state.subtreePath,
    focusNode: state.focusNode,
    focusPath: state.focusPath,
    expanded: genericReader.expandedIds(),
    anchor: genericReader.scrollAnchor(),
    scrollTop: activeView === "semantic" ? semanticPanel.scrollTop : state.readingScrollTop
  };
}

function rememberFocus(node: NodeDto, path: string): void {
  state.focusNode = node;
  state.focusPath = path;
  documentOutline.focus(node.id);
  genericReader.focus(node.id);
  if (!canUseSource()) {
    state.locateNote = t("reader.locateBlocked");
    render();
    return;
  }
  rawView.revealRange(node.spanStart, node.spanEnd, path, "bytes");
  if (state.detailOpen) void viewFieldRaw(node, path);
  else render();
}

function handleTreeSelection(node: NodeDto, path: string): void {
  rememberFocus(node, path);
}

async function copyField(node: NodeDto, path: string, format: "raw" | "decoded"): Promise<void> {
  if (!canUseSource() || !state.summary) {
    state.locateNote = t("reader.locateBlocked");
    fieldCopyStatus.textContent = t("reader.locateBlocked");
    render();
    return;
  }
  const revision = state.summary.sessionRevision;
  const requestGeneration = state.generation;
  const requestPath = state.summary.path;
  try {
    await invoke("copy_node", {
      nodeId: node.id,
      scopeId: null,
      sessionRevision: revision,
      format
    });
    if (requestGeneration !== state.generation || state.summary?.sessionRevision !== revision || state.summary.path !== requestPath || !canUseSource()) return;
    const message = t(
      format === "decoded"
        ? node.valueHasMore ? "reader.copyTextFull" : "reader.copyTextDone"
        : node.valueHasMore ? "reader.copyRawFull" : "reader.copyRawDone",
      { path }
    );
    fieldCopyStatus.textContent = message;
    genericReader.setStatus(message);
  } catch (error) {
    if (requestGeneration !== state.generation || state.summary?.sessionRevision !== revision || state.summary.path !== requestPath) return;
    const parsed = ipcError(error);
    if (parsed.code === "file_changed" || parsed.code === "stale_session") {
      handleCurrentSessionAsyncError(parsed);
      return;
    }
    const message = t("reader.copyFailed", { path, message: parsed.message });
    fieldCopyStatus.textContent = message;
    genericReader.setStatus(message);
  }
}

function expandReading(node: NodeDto, path: string, opener: HTMLElement): void {
  const summary = state.summary;
  if (!summary || !canUseSource()) return;
  const target: ContentTarget = {
    revision: summary.sessionRevision,
    nodeId: node.id,
    spanStart: node.spanStart,
    spanEnd: node.spanEnd,
    scopeId: null,
    scopeLabel: path,
    pathSegments: path.split(/\.|(?=\[)/).filter((segment) => segment.length > 0 && segment !== "$"),
    pathTruncated: node.labelHasMore
  };
  void contentViewer.open(target, opener);
}

async function viewFieldRaw(node: NodeDto, path: string): Promise<void> {
  state.focusNode = node;
  state.focusPath = path;
  state.detailOpen = true;
  fieldDetail.hidden = false;
  fieldDetailTitle.textContent = t("reader.fieldDetailTitle", { path });
  fieldDetailNote.textContent = t("reader.localRaw", { path });
  fieldTechnicalBody.textContent = t("reader.technicalBody", {
    id: node.id,
    start: node.spanStart,
    end: node.spanEnd,
    coordinate: t("reader.fileCoordinates")
  });
  if (!canUseSource() || !state.summary) {
    state.locateNote = t("reader.locateBlocked");
    fieldDetailRaw.textContent = "";
    render();
    return;
  }
  fieldDetailRaw.textContent = t("reader.loadingFields");
  render();
  const revision = state.summary.sessionRevision;
  const requestGeneration = state.generation;
  try {
    const chunk = await invoke<{ text?: string; hasMore?: boolean }>("read_raw_slice", {
      sourceStart: node.spanStart,
      length: Math.min(128 * 1024, Math.max(1, node.spanEnd - node.spanStart)),
      sessionRevision: revision
    });
    if (requestGeneration !== state.generation || state.summary?.sessionRevision !== revision || state.focusNode?.id !== node.id || !canUseSource()) return;
    fieldDetailRaw.textContent = typeof chunk?.text === "string" ? chunk.text : "";
    if (chunk?.hasMore) fieldDetailRaw.append(document.createTextNode(`\n${t("reader.previewTruncated")}`));
  } catch (error) {
    if (requestGeneration !== state.generation || state.summary?.sessionRevision !== revision) return;
    const parsed = ipcError(error);
    if (parsed.code === "file_changed" || parsed.code === "stale_session") handleCurrentSessionAsyncError(parsed);
    else fieldDetailRaw.textContent = parsed.message;
  }
}

function readFieldAlone(node: NodeDto, path: string): void {
  const summary = state.summary;
  if (!summary || !canUseSource()) {
    state.locateNote = t("reader.locateBlocked");
    render();
    return;
  }
  state.pendingHistory = null;
  state.backStack.push(captureSnapshot());
  state.forwardStack = [];
  state.subtree = node;
  state.subtreePath = path;
  state.focusNode = node;
  state.focusPath = path;
  state.locateNote = t("reader.rangeNow", { path });
  rawView.setItemSession(summary.sessionRevision, node, sourceSizeForRange(), sourceKind());
  render();
}

function recordOrdinal(): number | null {
  return state.summary?.mode === "entry" ? state.selectedEntry?.location.entryOrdinal ?? null
    : state.summary?.mode === "collection" ? state.selectedItem?.ordinal ?? null : null;
}

function recordLocationChanged(nextOrdinal: number | null): void {
  if (recordOrdinal() === nextOrdinal) return;
  if (state.pendingHistory) {
    if (state.pendingHistory.ordinal === (nextOrdinal ?? -1) && state.pendingHistory.generation + 1 === state.generation) return;
    state.pendingHistory = null;
  }
  if (state.summary && rangeRoot()) state.backStack.push(captureSnapshot());
  state.forwardStack = [];
}

function restoreRange(snapshot: ReadingSnapshot, direction: "back" | "forward"): void {
  const summary = state.summary;
  if (!summary || !canUseSource()) return;
  if (snapshot.recordOrdinal !== recordOrdinal()) {
    state.pendingHistory = { snapshot, generation: state.generation, ordinal: snapshot.recordOrdinal ?? -1, direction };
    if (summary.mode === "entry" && snapshot.recordOrdinal !== null) entryList.navigateToOrdinal(snapshot.recordOrdinal);
    else if (summary.mode === "collection") {
      if (snapshot.recordOrdinal === null) selectCollectionRoot();
      else collectionList.navigateToOrdinal(snapshot.recordOrdinal);
    }
    render();
    return;
  }
  state.readingScrollTop = snapshot.scrollTop;
  state.subtree = snapshot.subtree;
  state.subtreePath = snapshot.subtreePath;
  state.focusNode = snapshot.focusNode;
  state.focusPath = snapshot.focusPath;
  const root = snapshot.subtree ?? rangeRoot();
  if (snapshot.subtree) rawView.setItemSession(summary.sessionRevision, snapshot.subtree, sourceSizeForRange(), sourceKind());
  else if (root) rawView.setSession(summary.sessionRevision, root, sourceSizeForRange(), sourceKind());
  const session = readerSession();
  if (session && root) {
    const generation = state.generation;
    void genericReader.restore(session, root, snapshot.subtree ? snapshot.subtreePath : "$", snapshot.expanded, snapshot.anchor)
      .then(() => { if (generation === state.generation && state.subtree === snapshot.subtree && state.summary?.sessionRevision === session.revision) semanticPanel.scrollTop = snapshot.scrollTop; });
  }
  if (snapshot.focusNode) {
    documentOutline.focus(snapshot.focusNode.id);
    rawView.revealRange(snapshot.focusNode.spanStart, snapshot.focusNode.spanEnd, snapshot.focusPath, "bytes");
  }
  if (!state.userLockedView) state.userLockedView = true;
  setActiveView(snapshot.view);
}

function cancelPendingHistory(): void {
  const pending = state.pendingHistory;
  if (!pending) return;
  state.pendingHistory = null;
  if (pending.direction === "back") {
    const current = state.forwardStack.pop();
    if (current) state.backStack.push(pending.snapshot);
  } else {
    const current = state.backStack.pop();
    if (current) state.forwardStack.push(pending.snapshot);
  }
  render();
}

function goBack(): void {
  if (state.pendingHistory) return;
  if (!canUseSource()) {
    state.locateNote = t("reader.locateBlocked");
    render();
    return;
  }
  const snapshot = state.backStack.pop();
  if (!snapshot) return;
  state.forwardStack.push(captureSnapshot());
  restoreRange(snapshot, "back");
  render();
}

function goForward(): void {
  if (state.pendingHistory) return;
  if (!canUseSource()) {
    state.locateNote = t("reader.locateBlocked");
    render();
    return;
  }
  const snapshot = state.forwardStack.pop();
  if (!snapshot) return;
  state.backStack.push(captureSnapshot());
  restoreRange(snapshot, "forward");
  render();
}

function handleConversationPresentation(mode: ConversationPresentation): void {
  if (state.conversationMode === mode) return;
  state.conversationMode = mode;
  if (mode === "reading" && state.userLockedView && activeView !== "semantic") {
    state.locateNote = t("reader.conversationOffer");
  }
  render();
}

async function reloadCurrentFile(): Promise<void> {
  const path = state.summary?.path;
  if (!path || state.opening) return;
  const generation = ++state.generation;
  state.opening = true;
  state.invalidatedRevision = null;
  state.locateNote = "";
  render();
  await openPath(path, null, generation);
}

function retryCurrentRange(): void {
  const summary = state.summary;
  if (!summary || state.opening) return;
  if (summary.documentError) {
    rawView.setRawDocument(summary.sessionRevision, summary.size, summary.documentError);
    setActiveView("raw");
    render();
    return;
  }
  const root = state.subtree ?? rangeRoot();
  if (!root) return;
  if (state.subtree) rawView.setItemSession(summary.sessionRevision, state.subtree, sourceSizeForRange(), sourceKind());
  else rawView.setSession(summary.sessionRevision, root, sourceSizeForRange(), sourceKind());
  const session = readerSession();
  if (session) genericReader.setRoot(null, null, "");
  if (session) genericReader.setRoot(session, root, state.subtree ? state.subtreePath : "$");
  render();
}

function locateCurrentError(): void {
  if (!canUseSource()) {
    state.locateNote = t("reader.locateBlocked");
    render();
    return;
  }
  const parse = state.error?.parseError ?? state.summary?.documentError?.parseError ?? state.selectedEntry?.parseError ?? null;
  state.userLockedView = true;
  setActiveView("raw");
  if (!parse) return;
  const size = state.summary?.mode === "entry" && state.selectedEntry
    ? entrySourceSize(state.selectedEntry)
    : state.summary?.size ?? 0;
  if (parse.byteOffset === size) {
    rawView.revealEnd(t("shell.errorAtEnd"));
    state.locateNote = t("shell.errorAtEnd");
    render();
    return;
  }
  const start = Math.max(0, Math.min(parse.byteOffset, Math.max(0, size - 1)));
  const end = Math.min(size, start + 1);
  if (end > start) rawView.revealRange(start, end, t("shell.locateError"), "bytes");
}

function findScopeText(): string {
  const name = state.findScope === "file"
    ? t("shell.findScopeFile")
    : state.findScope === "field"
      ? t("shell.findScopeField")
      : t("shell.findScopeRecord");
  const base = t("shell.findScopeActive", { scope: name });
  const widened = state.findScope === "file" && state.summary !== null && state.summary.mode !== "document" && (state.selectedEntry !== null || state.selectedItem !== null);
  return widened ? `${base} ${t("shell.searchWidened")}` : base;
}

function renderBreadcrumb(): void {
  const parts: string[] = [];
  if (state.summary) parts.push(fileLabel(state.summary.path));
  if (state.summary?.mode === "entry" && state.selectedEntry) {
    parts.push(t("navigationSearch.entryResult", { ordinal: state.selectedEntry.location.entryOrdinal + 1 }));
  }
  if (state.subtree) parts.push(state.subtreePath);
  readerBreadcrumb.replaceChildren(...parts.map((part) => {
    const span = document.createElement("span");
    span.textContent = part;
    return span;
  }));
}

function syncReadingSurface(): void {
  const root = currentScopeRoot();
  const session = readerSession();
  genericReader.setRoot(session, root, state.subtree ? state.subtreePath : "$");
  documentOutline.setRoot(session, root);
  genericReaderHost.hidden = root === null || state.conversationMode === "reading";
  outlineHost.hidden = root === null;
  renderBreadcrumb();
  if (findScopeSelect.value !== state.findScope) findScopeSelect.value = state.findScope;
  findScopeLabel.textContent = state.summary ? findScopeText() : "";
  locateNoteElement.textContent = state.locateNote;
  readerBack.disabled = state.pendingHistory !== null || state.backStack.length === 0;
  readerForward.disabled = state.pendingHistory !== null || state.forwardStack.length === 0;
  conversationOffer.hidden = !(state.userLockedView && activeView !== "semantic" && state.conversationMode === "reading");
  document.documentElement.dataset.textSize = state.textSize;
  fieldDetail.hidden = !state.detailOpen || state.focusNode === null;
  if (state.focusNode && state.detailOpen) {
    fieldDetailTitle.textContent = t("reader.fieldDetailTitle", { path: state.focusPath || state.focusNode.label });
  }
}

function handleConversationRaw(target: { ref: { nodeId: number; spanStart: number; spanEnd: number }; label: string }): void {
  if (rawTab.disabled) return;
  rawView.revealRange(target.ref.spanStart, target.ref.spanEnd, `${target.label} · Node ${target.ref.nodeId}`);
  setActiveView("raw");
}

async function handleConversationTree(target: { ref: { nodeId: number; spanStart: number; spanEnd: number }; label: string }): Promise<void> {
  if (treeTab.disabled) return;
  const requestGeneration = state.generation;
  const requestRevision = state.summary?.sessionRevision ?? null;
  const requestInvalidatedRevision = state.invalidatedRevision;
  const requestMode = state.summary?.mode ?? null;
  const requestScopeNodeId = requestMode === "collection"
    ? state.selectedItem?.node.id ?? null
    : requestMode === "entry"
      ? state.selectedEntryRoot?.id ?? null
      : state.summary?.root?.id ?? null;
  setActiveView("tree");
  const item = treePanel.querySelector<HTMLElement>(`[data-node-id="${target.ref.nodeId}"]`);
  if (item) {
    item.scrollIntoView({ block: "center" });
    item.click();
    item.focus();
    return;
  }
  const focused = await treeView.focusNode(target.ref.nodeId, target.ref.spanStart, target.ref.spanEnd);
  const sameScope = state.generation === requestGeneration
    && state.summary?.sessionRevision === requestRevision
    && state.invalidatedRevision === requestInvalidatedRevision
    && state.summary?.mode === requestMode
    && (requestMode === "collection"
      ? state.selectedItem?.node.id ?? null
      : requestMode === "entry"
        ? state.selectedEntryRoot?.id ?? null
        : state.summary?.root?.id ?? null) === requestScopeNodeId;
  if (!sameScope) return;
  if (!focused) {
    setText(statusReady, t("main.treeNodeUnavailable", { nodeId: target.ref.nodeId }));
    setActiveView("tree");
  }
}

function handleConversationContent(target: ContentTarget, opener: HTMLElement): void {
  void contentViewer.open(target, opener);
}

function handleSearchReveal(match: SearchMatch): void {
  if (rawTab.disabled || !canUseSource()) {
    state.locateNote = t("reader.locateBlocked");
    render();
    return;
  }
  if (match.field === "rawSource") {
    rawView.revealRange(match.matchStart, match.matchEnd, t("main.rawSourceSearchMatch"), "bytes");
    if (activeView !== "raw" && match.nodeId !== null) {
      genericReader.focus(match.nodeId);
      documentOutline.focus(match.nodeId);
    }
    render();
    return;
  }
  state.locateNote = t("reader.decodedWholeField");
  rawView.revealRange(match.sourceSpanStart, match.sourceSpanEnd, t("reader.decodedWholeField"), "field");
  if (match.nodeId !== null) {
    genericReader.focus(match.nodeId);
    documentOutline.focus(match.nodeId);
  }
  if (activeView === "semantic" && (genericReaderHost.hidden
    || !genericReaderHost.querySelector(`[data-field-id="${match.nodeId}"]`))) {
    setActiveView("raw");
  }
  render();
}

function handleEntryError(error: unknown): void {
  cancelPendingHistory();
  handleCurrentSessionAsyncError(ipcError(error));
}

function handleCollectionSelection(node: NodeDto, ordinal: number): void {
  const summary = state.summary;
  if (!summary || summary.mode !== "collection" || summary.documentError !== null) return;
  const previousView = activeView;
  state.generation += 1;
  recordLocationChanged(ordinal);
  state.readingScrollTop = 0;
  state.selectedItem = { node, ordinal };
  state.subtree = null;
  state.subtreePath = "";
  state.selectedEntry = null;
  state.selectedEntryRoot = null;
  state.error = null;
  state.invalidatedRevision = null;
  searchView.clear();
  if (contentViewer.isOpen) contentViewer.clear(false);
  treeView.setSession({
    mode: "collection",
    sessionRevision: summary.sessionRevision,
    scopeId: null,
    sourceSize: summary.size,
    ariaLabel: t("main.jsonItemStructure", { ordinal }),
    scopeLabel: t("main.itemLabel", { ordinal })
  }, node);
  rawView.setItemSession(summary.sessionRevision, node, summary.size, "collection");
  if (previousView === "tree") setActiveView("tree");
  else if (previousView === "raw") setActiveView("raw");
  else setActiveView("semantic");
  render();
  const pending = state.pendingHistory;
  if (pending && pending.ordinal === ordinal && pending.generation + 1 === state.generation && summary === state.summary && canUseSource()) {
    state.pendingHistory = null;
    restoreRange(pending.snapshot, pending.direction);
    render();
  } else if (pending) {
    state.pendingHistory = null;
    render();
  }
}

function selectCollectionRoot(): void {
  const summary = state.summary;
  if (!summary || summary.mode !== "collection" || !summary.root || summary.documentError
    || summaryIsInvalidated(summary) || state.opening || state.selectionBusy) return;
  state.generation += 1;
  recordLocationChanged(null);
  state.readingScrollTop = 0;
  state.selectedItem = null;
  collectionList.clearSelection();
  searchView.clear();
  contentViewer.clear(false);
  treeView.setSession({
    mode: "collection",
    sessionRevision: summary.sessionRevision,
    scopeId: null,
    sourceSize: summary.size,
    ariaLabel: t("main.jsonStructure"),
    scopeLabel: t("main.collectionRoot")
  }, summary.root);
  rawView.setSession(summary.sessionRevision, summary.root, summary.size, "collection");
  state.subtree = null;
  state.subtreePath = "";
  render();
  const pending = state.pendingHistory;
  if (pending && pending.ordinal === -1 && pending.generation + 1 === state.generation && summary === state.summary && canUseSource()) {
    state.pendingHistory = null;
    restoreRange(pending.snapshot, pending.direction);
    render();
  } else if (pending) {
    state.pendingHistory = null;
    render();
  }
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
    state.pendingHistory = null;
    state.backStack = [];
    state.forwardStack = [];
    if (summary) state.invalidatedRevision = summary.sessionRevision;
    contentViewer.clearOverridesForRevision(summary?.sessionRevision);
    if (contentViewer.isOpen) contentViewer.clear(false);
    searchView.invalidate();
    rawView.clear();
    treeView.clear();
    state.locateNote = t("reader.locateBlocked");
    state.subtree = null;
    state.subtreePath = "";
    state.focusNode = null;
    if (summary?.mode === "entry") state.scanStoppedRevision = summary.sessionRevision;
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
    state.error = { code: "internal", message: t("main.entrySelectionUnexpectedRevision") };
    render();
    return;
  }

  const previousView = activeView;
  state.generation += 1;
  recordLocationChanged(selection.entry.location.entryOrdinal);
  state.readingScrollTop = 0;
  state.summary = { ...summary, sessionRevision: selection.sessionRevision };
  state.selectedEntry = selection.entry;
  state.selectedEntryRoot = selection.root;
  state.subtree = null;
  state.subtreePath = "";
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
    state.error = { code: "internal", message: t("main.entrySelectionInconsistentRoot") };
    treeView.setSession({
      mode: "entry",
      sessionRevision: selection.sessionRevision,
      scopeId: null,
      sourceSize: entrySourceSize(selection.entry),
      ariaLabel: t("main.jsonEntryStructure"),
      scopeLabel: entryScopeLabel(selection.entry.location.entryOrdinal)
    }, null);
    rawView.clear(t("main.rawTreeUnavailable"));
    setActiveView("semantic");
  } else {
    treeView.setSession(
      {
        mode: "entry",
        sessionRevision: selection.sessionRevision,
        scopeId: null,
        sourceSize: entrySourceSize(selection.entry),
    ariaLabel: t("main.jsonEntryStructure"),
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
      rawView.clear(t("main.selectValidEntryRaw"));
    }
    if ((invalidJson || invalidUtf8 || oversized) && !rawAvailable) {
      state.error = { code: "internal", message: t("main.invalidEntryRawUnavailable") };
      setActiveView("semantic");
    } else if (invalidJson || invalidUtf8 || oversized) {
      const parseError = selection.entry.parseError ?? undefined;
      state.error = invalidJson && parseError
        ? { code: "invalid_json", message: parseError.message, parseError }
        : { code: invalidUtf8 ? "unsupported_encoding" : "invalid_json", message: t("reader.fallbackSource") };
      state.locateNote = t("reader.fallbackSource");
      setActiveView("raw");
    } else if (previousView === "raw" && state.userLockedView) {
      setActiveView("raw");
    } else if (previousView === "tree" && state.userLockedView) {
      setActiveView("tree");
    } else {
      setActiveView(previousView);
    }
  }
  render();
  const pending = state.pendingHistory;
  if (pending && pending.ordinal === selection.entry.location.entryOrdinal && pending.generation + 1 === state.generation && canUseSource()) {
    state.pendingHistory = null;
    restoreRange(pending.snapshot, pending.direction);
    render();
  } else if (pending) {
    state.pendingHistory = null;
    render();
  }
  if (state.summary.progress && !state.summary.progress.complete) {
    resumeExistingScan();
  }
}

function handleEntryRevisionUnknown(value: unknown): void {
  const next = entrySummaryValue(value);
  if (!next || next.mode !== "entry" || !next.progress) {
    state.error = { code: "internal", message: t("main.refreshedJsonlInvalidShape") };
    render();
    return;
  }
  const generation = ++state.generation;
  state.backStack = [];
  state.forwardStack = [];
  state.pendingHistory = null;
  state.readingScrollTop = 0;
  searchView.clear();
  contentViewer.clearOverridesForRevision(next.sessionRevision);
  contentViewer.clear(false);
  state.summary = next;
  state.selectedEntry = null;
  state.selectedEntryRoot = null;
  state.error = null;
  state.invalidatedRevision = null;
  state.scanQueued = null;
  state.scanStoppedRevision = null;
  rawView.clear(t("main.selectValidEntryRaw"));
  entryList.resync(next.sessionRevision, next.progress);
  treeView.setSession({
    mode: "entry",
    sessionRevision: next.sessionRevision,
    scopeId: null,
    sourceSize: 1,
        ariaLabel: t("main.jsonEntryStructure"),
    scopeLabel: t("main.entryMode")
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
  const fileGeneration = numberValue(value.fileGeneration);
  const warning = typeof value.manyInvalidUtf8Warning === "boolean" ? value.manyInvalidUtf8Warning : undefined;
  if (path === undefined || size === undefined || sessionRevision === undefined || fileGeneration === undefined || warning === undefined) return undefined;
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
    sessionRevision,
    fileGeneration
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
  const totalEntries = value.totalEntries === null || value.totalEntries === undefined ? null : numberValue(value.totalEntries);
  const eventStreamHint = value.eventStreamHint === null || value.eventStreamHint === undefined
    ? null
    : typeof value.eventStreamHint === "boolean" ? value.eventStreamHint : undefined;
  if (indexedEntries === undefined || indexedSourceLines === undefined || stride === undefined || complete === undefined
    || totalEntries === undefined || eventStreamHint === undefined) {
    return undefined;
  }
  return { indexedEntries, indexedSourceLines, complete, stride, totalEntries, eventStreamHint };
}

function modeLabel(mode: FileMode): string {
  if (mode === "document") return t("main.modeDocument");
  if (mode === "collection") return t("main.modeCollection");
  return t("main.modeEntry");
}

function entryScopeLabel(ordinal: number): string {
  return t("main.entryLabel", { ordinal: ordinal + 1 });
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
  if (size < 1024) return t("main.bytesB", { value: size });
  if (size < 1024 * 1024) return t("main.bytesKiB", { value: (size / 1024).toFixed(1) });
  if (size < 1024 * 1024 * 1024) return t("main.bytesMiB", { value: (size / (1024 * 1024)).toFixed(1) });
  return t("main.bytesGiB", { value: (size / (1024 * 1024 * 1024)).toFixed(2) });
}

function progressLabel(progress: JsonlProgressDto): string {
  if (progress.complete && progress.totalEntries !== null) {
    return t("main.progressComplete", {
      indexed: progress.indexedEntries.toLocaleString(locale),
      total: progress.totalEntries.toLocaleString(locale)
    });
  }
  return t("main.progressIndexed", {
    indexed: progress.indexedEntries.toLocaleString(locale),
    line: progress.indexedSourceLines.toLocaleString(locale)
  });
}

function setText(node: HTMLElement, value: string): void {
  node.textContent = value;
}

function currentConversationContext(): ConversationContext | null {
  const summary = state.summary;
  if (!summary || summary.documentError !== null || summaryIsInvalidated(summary)) return null;
  if (summary.mode === "document" || (summary.mode === "collection" && !state.selectedItem)) {
    return summary.root ? {
      mode: summary.mode,
      sessionRevision: summary.sessionRevision,
      sourceSize: summary.size,
      scopeRoot: summary.root,
      scopeLabel: t(summary.mode === "collection" ? "main.collectionRoot" : "main.documentRoot")
    } : null;
  }
  if (summary.mode === "collection") {
    const item = state.selectedItem;
    return item ? {
      mode: summary.mode,
      sessionRevision: summary.sessionRevision,
      sourceSize: summary.size,
      scopeRoot: item.node,
      scopeLabel: t("main.itemLabel", { ordinal: item.ordinal })
    } : null;
  }
  if (!state.selectedEntry || state.selectedEntry.status !== "valid" || !state.selectedEntryRoot) return null;
  return {
    mode: summary.mode,
    sessionRevision: summary.sessionRevision,
    sourceSize: entrySourceSize(state.selectedEntry),
    scopeRoot: state.selectedEntryRoot,
    scopeLabel: entryScopeLabel(state.selectedEntry.location.entryOrdinal)
  };
}

function renderError(): void {
  const error = state.error;
  errorRegion.hidden = error === null;
  if (!error) {
    setText(errorTitle, t("shell.openFailed"));
    setText(errorMessage, "");
    setText(errorDetails, "");
    return;
  }

  const titles: Record<string, string> = {
    no_session: t("main.errorNoSessionTitle"),
    invalid_json: t("main.invalidJson"),
    unsupported_encoding: t("main.unsupportedEncoding"),
    unsupported_framing: t("main.unsupportedFraming"),
    unsupported_format: t("main.unsupportedFormat"),
    mode_choice_required: t("main.chooseFileMode"),
    file_changed: t("main.fileChangedOnDisk"),
    stale_session: t("main.errorStaleSessionTitle"),
    invalid_request: t("main.errorInvalidRequestTitle"),
    not_found: t("main.errorNotFoundTitle"),
    open_failed: t("shell.openFailed"),
    internal: t("main.errorInternalTitle"),
    clipboard_failed: t("main.errorClipboardTitle")
  };
  const localizedTitle = Object.prototype.hasOwnProperty.call(titles, error.code) ? titles[error.code] : t("shell.openFailed");
  setText(errorTitle, localizedTitle);
  setText(errorMessage, error.message);
  if (error.parseError) {
    const parse = error.parseError;
    const parseDetails = t("main.parseErrorDetails", {
      line: parse.line,
      column: parse.column,
      byteOffset: parse.byteOffset,
      message: parseErrorMessage(parse)
    });
    const guidance = errorGuidance(error.code);
    setText(errorDetails, guidance ? t("main.errorGuidanceWithDiagnostic", { guidance, diagnostic: parseDetails }) : parseDetails);
  } else {
    const guidance = errorGuidance(error.code);
    setText(errorDetails, guidance ? t("main.errorGuidanceWithDiagnostic", { guidance, diagnostic: error.message }) : "");
  }
}

function errorGuidance(code: string): string | null {
  switch (code) {
    case "no_session": return t("main.errorNoSession");
    case "file_changed": return t("main.errorFileChanged");
    case "stale_session": return t("main.errorStaleSession");
    case "invalid_request": return t("main.errorInvalidRequest");
    case "not_found": return t("main.errorNotFound");
    case "open_failed": return t("main.errorOpenFailed");
    case "invalid_json": return t("main.errorInvalidJson");
    case "unsupported_encoding": return t("main.errorUnsupportedEncoding");
    case "unsupported_framing": return t("main.errorUnsupportedFraming");
    case "unsupported_format": return t("main.errorUnsupportedFormat");
    case "mode_choice_required": return t("main.errorModeChoiceRequired");
    case "internal": return t("main.errorInternal");
    case "clipboard_failed": return t("main.errorClipboard");
    default: return null;
  }
}

function renderSummary(): void {
  const summary = state.summary;
  if (!summary) {
    conversationView.setContext(null);
    readerState.hidden = false;
    setText(fileName, t("main.noFileOpenLabel"));
    setText(filePath, "—");
    setText(fileMode, "—");
    setText(navigationMode, "—");
    setText(navigationState.querySelector("strong") as HTMLElement, t("shell.noFileOpen"));
    setText(navigationState.querySelector("span:last-child") as HTMLElement, t("shell.openLocalFile"));
    setText(readerState.querySelector("h3") as HTMLElement, state.opening ? t("main.openingFile") : t("shell.readerReady"));
    setText(readerState.querySelector("p") as HTMLElement, state.opening ? t("main.previousViewStays") : t("shell.semanticAfterOpen"));
    setText(inspectorPath, "—");
    setText(inspectorSize, "—");
    setText(inspectorMode, "—");
    setText(inspectorRevision, "—");
    setText(inspectorProgress, "—");
    inspectorEmpty.hidden = false;
    inspectorWarning.hidden = true;
    setText(statusMode, "—");
    setText(statusSize, "—");
    setText(statusProgress, state.opening ? t("main.opening") : t("shell.ready"));
    statusWarning.hidden = true;
    return;
  }

  const invalidated = summaryIsInvalidated(summary);
  const rawOnly = summary.documentError !== null;
  const mode = invalidated ? t("main.unavailable") : rawOnly ? t("main.rawOnlyDocument") : modeLabel(summary.mode);
  setText(fileName, fileLabel(summary.path));
  setText(filePath, summary.path);
  setText(fileMode, invalidated ? t("main.unavailable") : rawOnly ? mode : t("main.modeSuffix", { mode }));
  setText(navigationMode, mode);
  setText(
    navigationState.querySelector("strong") as HTMLElement,
    invalidated ? t("main.unavailable") : rawOnly ? t("main.rawOnlyDocumentLower") : summary.mode === "entry" ? t("main.entryIndex") : t("main.modeOutline", { mode })
  );
  setText(navigationState.querySelector("span:last-child") as HTMLElement, navigationCopy(summary));
  setText(readerState.querySelector("h3") as HTMLElement, readerTitle(summary));
  setText(readerState.querySelector("p") as HTMLElement, readerCopy(summary));
  setText(inspectorPath, summary.path);
  setText(inspectorSize, t("main.sizeBytes", {
    size: formatBytes(summary.size),
    bytes: summary.size.toLocaleString(locale)
  }));
  setText(inspectorMode, invalidated ? t("main.unavailable") : rawOnly ? mode : t("main.modeSuffix", { mode }));
  setText(inspectorRevision, String(summary.sessionRevision));
  const stopped = state.scanStoppedRevision === summary.sessionRevision;
  setText(
    inspectorProgress,
    invalidated ? t("main.fileChangedRawUnavailable") : rawOnly ? t("main.rawBytesAvailable") : summary.progress ? stopped ? t("main.indexingStoppedProgress", { progress: progressLabel(summary.progress) }) : progressLabel(summary.progress) : t("main.structureLoaded")
  );
  inspectorEmpty.hidden = true;
  inspectorWarning.hidden = !summary.manyInvalidUtf8Warning;
  setText(inspectorWarning, t("main.warningInvalidUtf8"));
  setText(statusMode, invalidated ? t("main.unavailable") : rawOnly ? mode : t("main.modeSuffix", { mode }));
  setText(statusSize, formatBytes(summary.size));
  setText(statusProgress, invalidated ? t("main.fileChangedRawUnavailable") : rawOnly ? t("main.rawBytesAvailable") : statusProgressLabel(summary));
  statusWarning.hidden = !summary.manyInvalidUtf8Warning;
  setText(statusReady, invalidated ? t("main.unavailable") : state.opening ? t("main.opening") : stopped ? t("main.indexingStopped") : summary.progress && !summary.progress.complete ? t("main.indexing") : t("shell.ready"));
  const conversationContext = currentConversationContext();
  conversationView.setContext(conversationContext);
  readerState.hidden = currentScopeRoot() !== null
    || state.conversationMode === "reading"
    || state.conversationMode === "chooser"
    || state.conversationMode === "scanning";
}

function navigationCopy(summary: FileSummary): string {
  if (summaryIsInvalidated(summary)) return t("main.fileChangedRawUnavailable");
  if (summary.documentError) return t("main.rawBytesAvailablePeriod");
  if (summary.mode === "entry" && summary.progress) {
    if (state.scanStoppedRevision === summary.sessionRevision) {
      return t("main.indexingStoppedEntries", { entries: summary.progress.indexedEntries.toLocaleString(locale) });
    }
    return summary.progress.complete
      ? t("main.indexedEntriesReady")
      : t("reader.indexedUnknownTotal", { entries: summary.progress.indexedEntries.toLocaleString(locale) });
  }
  return summary.mode === "collection" ? t("main.itemsOnDemand") : t("reader.outlineTitle");
}

function readerTitle(summary: FileSummary): string {
  if (summaryIsInvalidated(summary)) return t("main.unavailable");
  if (summary.documentError) {
    return summary.documentError.code === "invalid_json" ? t("main.invalidJson") : t("main.unsupportedEncoding");
  }
  if (state.scanStoppedRevision === summary.sessionRevision) return t("main.indexingStopped");
  if (summary.mode === "entry" && summary.progress && !summary.progress.complete) return t("main.indexingBackground");
  return t("main.readerReadyForMode", { mode: modeLabel(summary.mode) });
}

function readerCopy(summary: FileSummary): string {
  if (summaryIsInvalidated(summary)) return t("main.fileChangedRawUnavailable");
  if (summary.documentError) {
    return summary.documentError.code === "invalid_json"
      ? t("main.documentParseUnavailable")
      : t("main.encodingTreeUnavailable");
  }
  if (summary.mode === "entry" && summary.progress) {
    if (state.scanStoppedRevision === summary.sessionRevision) {
      return t("main.indexingStoppedAtEntries", { entries: summary.progress.indexedEntries.toLocaleString(locale) });
    }
    if (state.selectedEntry?.status === "invalidJson") return t("main.entryTreeUnavailable");
    if (state.selectedEntry?.status === "invalidUtf8") return t("main.invalidUtf8EntrySelected");
    if (state.selectedEntry?.status === "oversized") {
      const { byteStart, byteEnd } = state.selectedEntry.location;
      const length = byteEnd - byteStart;
      if (Number.isSafeInteger(byteStart) && Number.isSafeInteger(byteEnd) && byteStart >= 0 && byteEnd > byteStart && Number.isSafeInteger(length) && length > MAX_ENTRY_BYTES) {
        return t("main.oversizedEntrySelected");
      }
    }
    if (state.selectedEntry) {
      const entry = state.selectedEntry;
      return entry.status === "valid"
        ? t("main.entrySelectedTree", { ordinal: entry.location.entryOrdinal + 1 })
        : t("main.entrySelectedNoTree", {
          ordinal: entry.location.entryOrdinal + 1,
          status: entryStatusLabel(entry.status)
        });
    }
    return t("main.selectValidEntry");
  }
  if (summary.mode === "collection") {
    return state.selectedItem
      ? t("main.itemSelected", { ordinal: state.selectedItem.ordinal })
      : t("main.selectItem");
  }
  return t("main.semanticProjection");
}

function statusProgressLabel(summary: FileSummary): string {
  if (summaryIsInvalidated(summary)) return t("main.fileChangedRawUnavailable");
  if (!summary.progress) return t("main.structureReady");
  const progress = state.scanStoppedRevision === summary.sessionRevision
    ? t("main.indexingStoppedIndexed", { entries: summary.progress.indexedEntries.toLocaleString(locale) })
    : summary.progress.complete && summary.progress.totalEntries !== null
      ? t("main.entriesCount", { entries: summary.progress.totalEntries.toLocaleString(locale) })
      : t("reader.indexedUnknownTotal", { entries: summary.progress.indexedEntries.toLocaleString(locale) });
  if (summary.mode !== "entry") return progress;
  const selected = state.selectedEntry;
  if (!selected) return t("main.indexedThroughLine", {
    line: summary.progress.indexedSourceLines.toLocaleString(locale),
    progress
  });
  const { entryOrdinal, sourceLine, byteStart, byteEnd } = selected.location;
  return t("main.entryProgress", {
    entry: entryOrdinal + 1,
    line: sourceLine,
    start: byteStart,
    end: byteEnd,
    progress
  });
}

function entryStatusLabel(status: string): string {
  if (status === "invalidJson") return t("main.invalidJson");
  if (status === "invalidUtf8") return t("main.invalidUtf8");
  if (status === "oversized") return t("main.oversizedEntry");
  return status === "valid" ? t("main.valid") : status;
}

function setActiveView(view: "semantic" | "tree" | "raw"): void {
  if (view === "tree" && treeTab.disabled) return;
  if (view === "raw" && rawTab.disabled) return;
  if (activeView === "semantic" && view !== "semantic") state.readingScrollTop = semanticPanel.scrollTop;
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
  setText(treeReaderTitle, view === "semantic" ? t("shell.semantic") : view === "tree" ? t("shell.tree") : t("shell.raw"));
  if (view === "tree") treeView.activate();
  if (view === "raw") rawView.activate();
  else rawView.deactivate();
  if (view === "semantic" && state.summary && !summaryIsInvalidated(state.summary)) conversationView.onSemanticVisible();
  if (view === "semantic") semanticPanel.scrollTop = state.readingScrollTop;
}

function currentSearchScope(): SearchScope | null {
  const scope = baseSearchScope();
  if (!scope || !state.summary) return scope;
  const scopeName = state.findScope === "file"
    ? t("shell.findScopeFile")
    : state.findScope === "field"
      ? t("shell.findScopeField")
      : t("shell.findScopeRecord");
  if (state.findScope !== "record") {
    scope.label = scopeName;
    scope.description = findScopeText();
  }
  if (state.findScope === "file") {
    if (state.summary.mode === "entry") {
      scope.fileSearch = true;
      scope.enabled = !state.opening && !state.selectionBusy;
      scope.decodedEnabled = true;
    }
    scope.scopeStart = 0;
    scope.scopeEnd = state.summary.size;
    scope.targetNodeId = null;
  } else if (state.findScope === "field") {
    if (!state.focusNode) scope.enabled = false;
    else {
      scope.scopeStart = state.focusNode.spanStart;
      scope.scopeEnd = state.focusNode.spanEnd;
      scope.targetNodeId = state.focusNode.id;
    }
  }
  return scope;
}

function baseSearchScope(): SearchScope | null {
  const summary = state.summary;
  if (!summary || summaryIsInvalidated(summary)) return null;
  const enabled = !state.opening && !state.selectionBusy;
  if (summary.documentError) {
    return {
      label: t("main.rawOnlySearchLabel"),
      description: enabled
        ? t("main.currentScopeDocumentBytes")
        : t("main.rawOnlySearchUnavailable"),
      enabled,
      decodedEnabled: false,
      scopeStart: 0,
      scopeEnd: summary.size,
      sessionRevision: summary.sessionRevision,
      scopeId: null,
      targetNodeId: null
    };
  }
  if (summary.mode === "document" || (summary.mode === "collection" && !state.selectedItem)) {
    return {
      label: t(summary.mode === "collection" ? "main.collectionRoot" : "main.documentRoot"),
      description: enabled
        ? t(summary.mode === "collection" ? "main.currentScopeCollectionRoot" : "main.currentScopeDocumentRoot")
        : t("main.currentScopeDocumentSearchUnavailable"),
      enabled,
      decodedEnabled: true,
      scopeStart: 0,
      scopeEnd: summary.size,
      sessionRevision: summary.sessionRevision,
      scopeId: null,
      targetNodeId: null
    };
  }
  if (summary.mode === "collection") {
    const item = state.selectedItem;
    if (!item) {
      return {
        label: t("main.selectedItemLabel"),
        description: t("main.selectItemSearch"),
        enabled: false,
        decodedEnabled: true,
        scopeStart: 0,
        scopeEnd: 0,
        sessionRevision: summary.sessionRevision,
        scopeId: null,
        targetNodeId: null
      };
    }
    return {
      label: t("main.itemLabel", { ordinal: item.ordinal }),
      description: enabled
        ? t("main.currentScopeSelectedItem", { ordinal: item.ordinal })
        : t("main.currentScopeSelectedItemUnavailable", { ordinal: item.ordinal }),
      enabled,
      decodedEnabled: true,
      scopeStart: item.node.spanStart,
      scopeEnd: item.node.spanEnd,
      sessionRevision: summary.sessionRevision,
      scopeId: null,
      targetNodeId: item.node.id
    };
  }
  const entry = state.selectedEntry;
  if (!entry) {
    return {
      label: t("main.selectedEntryLabel"),
      description: t("main.selectEntrySearch"),
      enabled: false,
      decodedEnabled: true,
      scopeStart: 0,
      scopeEnd: 0,
      sessionRevision: summary.sessionRevision,
      scopeId: null,
      targetNodeId: null
    };
  }
  const scopeEnd = entrySourceSize(entry);
  const decodedEnabled = entry.status === "valid";
  const status = entryStatusLabel(entry.status);
  return {
    label: t("main.entryLabel", { ordinal: entry.location.entryOrdinal + 1 }),
    description: enabled
      ? decodedEnabled
        ? t("main.currentScopeSelectedEntry", { ordinal: entry.location.entryOrdinal + 1 })
        : t("main.currentScopeSelectedEntryRaw", { ordinal: entry.location.entryOrdinal + 1, status })
      : t("main.currentScopeSelectedEntryUnavailable", { ordinal: entry.location.entryOrdinal + 1 }),
    enabled,
    decodedEnabled,
    scopeStart: 0,
    scopeEnd,
    sessionRevision: summary.sessionRevision,
    scopeId: null,
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
  const busy = state.opening || state.selectionBusy;
  appShell.setAttribute("aria-busy", String(busy));
  openButton.disabled = busy;
  readerOpenButton.disabled = busy;
  navigationToggle.setAttribute("aria-expanded", String(mobile ? state.mobileDrawer === "navigation" : state.navigationOpen));
  inspectorToggle.setAttribute("aria-expanded", String(mobile ? state.mobileDrawer === "inspector" : state.detailOpen));
  appShell.dataset.mobileDrawer = state.mobileDrawer ?? "";
  appShell.dataset.navigationOpen = String(!mobile && state.navigationOpen);
  appShell.dataset.inspectorOpen = String(!mobile && state.detailOpen);
  entryList.setOpening(state.opening);
  collectionList.setOpening(state.opening);
  const navSummary = state.summary;
  navigationSearch.setContext(navSummary && !summaryIsInvalidated(navSummary)
    && (navSummary.mode === "entry" || navSummary.mode === "collection")
    ? { fileGeneration: navSummary.fileGeneration, mode: navSummary.mode }
    : null);
  const collectionSummary = state.summary;
  const collectionActive = collectionSummary !== null
    && collectionSummary.mode === "collection"
    && collectionSummary.documentError === null
    && !summaryIsInvalidated(collectionSummary);
  collectionNavigation.hidden = !collectionActive;
  collectionRootButton.disabled = busy || !collectionActive;
  collectionRootButton.setAttribute("aria-pressed", String(collectionActive && state.selectedItem === null));
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
  syncReadingSurface();
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

if (isTauri()) {
  void getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type !== "drop" || state.opening || state.selectionBusy || modeDialog.open) return;
    const path = event.payload.paths[0];
    if (!path) return;
    const generation = ++state.generation;
    state.pendingChoicePreviousError = state.error;
    state.opening = true;
    render();
    void openPath(path, null, generation);
  }).catch((error) => {
    state.error = ipcError(error);
    render();
  });
}

function failClosedSummary(generation: number): void {
  if (generation !== state.generation) return;
  contentViewer.clear(false);
  state.generation += 1;
  state.summary = null;
  state.backStack = [];
  state.forwardStack = [];
  state.pendingHistory = null;
  state.selectedEntry = null;
  state.selectedEntryRoot = null;
  state.selectedItem = null;
  state.error = { code: "internal", message: t("main.invalidFileSummary") };
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
  navigationSearch.setContext(null);
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
    searchView.setRepresentation(summary.documentError ? "rawSource" : "decoded");
    state.subtree = null;
    state.subtreePath = "";
    state.focusNode = null;
    state.focusPath = "";
    state.backStack = [];
    state.forwardStack = [];
    state.pendingHistory = null;
    state.readingScrollTop = 0;
    state.userLockedView = false;
    state.findScope = "record";
    state.locateNote = "";
    state.conversationMode = "hidden";
    state.detailOpen = false;
    state.error = summary.documentError;
    state.invalidatedRevision = null;
    state.pendingChoicePath = null;
    state.pendingChoicePreviousError = null;
    state.scanQueued = null;
    state.scanStoppedRevision = null;
    state.opening = false;
    entryList.setOpening(false);
    state.selectedEntry = null;
    state.selectedEntryRoot = null;
    state.selectedItem = null;
    if (summary.documentError) {
      state.selectedEntry = null;
      state.selectedEntryRoot = null;
      entryList.setSession(null);
      collectionList.setSession(null);
      treeView.clear();
      if (!rawView.setRawDocument(summary.sessionRevision, summary.size, summary.documentError)) {
        failClosedSummary(generation);
        return;
      }
      setActiveView("raw");
      render();
      return;
    }
    state.error = null;
    collectionList.setSession(summary.mode === "collection" && summary.root
      ? { revision: summary.sessionRevision, root: summary.root, sourceSize: summary.size }
      : null);
    if (summary.mode === "collection") {
      selectCollectionRoot();
    } else {
      treeView.setSession({
        mode: summary.mode,
        sessionRevision: summary.sessionRevision,
        scopeId: null,
        sourceSize: summary.size,
        ariaLabel: t("main.jsonStructure"),
        scopeLabel: modeLabel(summary.mode)
      });
      if (summary.root) rawView.setSession(summary.sessionRevision, summary.root, summary.size, summary.mode);
      else rawView.clear(t("main.selectValidEntryRaw"));
    }
    entryList.setSession(summary.mode === "entry" && summary.progress ? {
      revision: summary.sessionRevision,
      progress: summary.progress
    } : null);
    if (summary.mode === "entry") entryList.armInitialRecord();
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
        const value = await invoke<unknown>("scan_entries", { sessionRevision });
        if (generation !== state.generation || state.summary?.sessionRevision !== sessionRevision) return;
        state.scanStoppedRevision = null;
        const progress = jsonlProgressValue(value);
        if (!progress) {
          state.error = { code: "internal", message: t("main.invalidJsonlProgress") };
          state.scanStoppedRevision = sessionRevision;
          render();
          return;
        }
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
  } else {
    state.navigationOpen = !state.navigationOpen;
  }
  render();
}

function toggleInspector(): void {
  if (window.innerWidth <= 767) {
    state.mobileDrawer = state.mobileDrawer === "inspector" ? null : "inspector";
  } else {
    state.detailOpen = !state.detailOpen;
  }
  render();
}

openButton.addEventListener("click", () => void chooseFile());
collectionRootButton.addEventListener("click", selectCollectionRoot);
readerOpenButton.addEventListener("click", () => void chooseFile());
previewButton.addEventListener("click", () => {
  const target = selectedStringTarget;
  if (target) void contentViewer.open(target, previewButton);
});
navigationToggle.addEventListener("click", toggleNavigation);
inspectorToggle.addEventListener("click", toggleInspector);
semanticTab.addEventListener("click", () => { state.userLockedView = true; setActiveView("semantic"); });
treeTab.addEventListener("click", () => { state.userLockedView = true; setActiveView("tree"); });
rawTab.addEventListener("click", () => { state.userLockedView = true; setActiveView("raw"); });
readerBack.addEventListener("click", () => goBack());
readerForward.addEventListener("click", () => goForward());
errorReload.addEventListener("click", () => void reloadCurrentFile());
errorRetry.addEventListener("click", () => retryCurrentRange());
errorViewSource.addEventListener("click", () => { state.userLockedView = true; setActiveView("raw"); });
errorLocate.addEventListener("click", () => locateCurrentError());
conversationOffer.addEventListener("click", () => { state.userLockedView = true; setActiveView("semantic"); });
fieldCopyText.addEventListener("click", () => { if (state.focusNode) void copyField(state.focusNode, state.focusPath || state.focusNode.label, "decoded"); });
fieldCopyRaw.addEventListener("click", () => { if (state.focusNode) void copyField(state.focusNode, state.focusPath || state.focusNode.label, "raw"); });
fieldReadAlone.addEventListener("click", () => { if (state.focusNode) readFieldAlone(state.focusNode, state.focusPath || state.focusNode.label); });
findScopeSelect.addEventListener("change", () => {
  const value = findScopeSelect.value;
  if (value !== "file" && value !== "record" && value !== "field") return;
  state.findScope = value;
  if (value === "file") state.locateNote = t("shell.searchWidened");
  render();
});
textSizeSelect.addEventListener("change", () => {
  const value = textSizeSelect.value;
  if (value === "sm" || value === "md" || value === "lg") state.textSize = value;
  render();
});
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
  if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    goBack();
    return;
  }
  if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    goForward();
    return;
  }
  if (event.key === "Escape" && !modeDialog.open) {
    if (searchView.handleEscape(event)) return;
    if (state.mobileDrawer !== null || state.detailOpen) {
      state.mobileDrawer = null;
      state.detailOpen = false;
      render();
      openButton.focus();
    }
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 767) state.mobileDrawer = null;
  render();
});

render();
