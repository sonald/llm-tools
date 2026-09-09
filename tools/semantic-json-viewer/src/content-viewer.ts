import { invoke } from "@tauri-apps/api/core";
import {
  renderCode,
  renderPlainCodePage,
  scanCodeLines,
  type CodeLanguage,
  type CodeLineState,
  type CodeRenderReason
} from "./code-renderer";
import { renderSafeMarkdown } from "./markdown-renderer";
import { TreeView, type NodeDto, type TreeCopyElements, type TreeViewSnapshot } from "./tree-view";
import { SearchView, type SearchMatch, type SearchViewElements } from "./search-view";
import { RenderedSearch, type RenderedMatch, type RenderedSearchTarget } from "./rendered-search";

export type ContentTarget = {
  revision: number;
  nodeId: number;
  spanStart: number;
  spanEnd: number;
  scopeId: number | null;
  scopeLabel: string;
  pathSegments: string[];
  pathTruncated: boolean;
};

export type ContentViewerElements = {
  dialog: HTMLDialogElement;
  close: HTMLButtonElement;
  title: HTMLElement;
  scope: HTMLElement;
  path: HTMLElement;
  node: HTMLElement;
  spanLabel: HTMLElement;
  span: HTMLElement;
  semanticType: HTMLElement;
  detectionSource: HTMLElement;
  plainReason: HTMLElement;
  representation: HTMLElement;
  rendererNote: HTMLElement;
  range: HTMLElement;
  status: HTMLElement;
  alert: HTMLElement;
  content: HTMLElement;
  copy?: {
    raw: HTMLButtonElement;
    decoded: HTMLButtonElement;
    markdown: HTMLButtonElement;
    parsed: HTMLButtonElement;
    status: HTMLElement;
  };
  renderAs?: HTMLSelectElement;
  markdownAnyway?: HTMLButtonElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  nested?: NestedViewerElements;
  html?: HtmlViewerElements;
  string?: StringViewerElements;
  search?: SearchViewElements;
};

export type StringViewerElements = {
  representations: HTMLElement;
  renderedTab: HTMLButtonElement;
  decodedTab: HTMLButtonElement;
  rawTab: HTMLButtonElement;
};

export type NestedViewerElements = {
  navigation: HTMLElement;
  back: HTMLButtonElement;
  breadcrumb: HTMLOListElement;
  representations: HTMLElement;
  parsedTab: HTMLButtonElement;
  decodedTab: HTMLButtonElement;
  rawTab: HTMLButtonElement;
  parsedPanel: HTMLElement;
  parsedTree: HTMLElement;
  sharedTextPanel: HTMLElement;
  parsedSearchPeek?: ParsedSearchPeekElements;
};

export type ParsedSearchPeekElements = {
  panel: HTMLElement;
  field: HTMLElement;
  node: HTMLElement;
  path: HTMLElement;
  sourceSpan: HTMLElement;
  displayedRange: HTMLElement;
  decodedRange: HTMLElement;
  source: HTMLElement;
  note: HTMLElement;
};

export type HtmlViewerElements = {
  representations: HTMLElement;
  previewTab: HTMLButtonElement;
  sourceTab: HTMLButtonElement;
  rawTab?: HTMLButtonElement;
  previewPanel: HTMLElement;
  previewFrame: HTMLIFrameElement;
};

function createCopyElements(): NonNullable<ContentViewerElements["copy"]> {
  const button = (): HTMLButtonElement => document.createElement("button");
  const status = document.createElement("span");
  return { raw: button(), decoded: button(), markdown: button(), parsed: button(), status };
}

function createNestedCopyElements(): { elements: TreeCopyElements; container: HTMLElement } {
  const container = document.createElement("div");
  container.className = "copy-actions nested-copy-actions";
  container.setAttribute("aria-label", "Copy selected nested node");
  const button = (label: string): HTMLButtonElement => {
    const value = document.createElement("button");
    value.className = "secondary-button";
    value.type = "button";
    value.textContent = label;
    container.append(value);
    return value;
  };
  const status = document.createElement("span");
  status.className = "copy-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  container.append(status);
  return {
    elements: {
      raw: button("Copy Raw"),
      subtree: button("Copy JSON Subtree"),
      decoded: button("Copy Decoded Value"),
      path: button("Copy Path"),
      status
    },
    container
  };
}

type StringDetection = {
  semanticType: "plainText" | "markdown" | "nestedJson" | "code" | "html";
  detectionSource: "contentDetected";
  plainReason: "fallback" | "jsonParseFailed" | "sizeLimit" | "depthLimit" | "cumulativeLimit" | null;
};

type TextChunk = {
  start: number;
  text: string;
  hasMore: boolean;
  nextOffset: number | null;
  lineState: CodeLineState;
};

type SemanticType = "markdown" | "code";

export type RenderAs = "auto" | "plainText" | "markdown" | "nestedJson" | "html" | "code" | CodeLanguage;

type CollectedText = {
  first: TextChunk;
  text: string | null;
  overLimit: boolean;
  overLimitReason: "sizeLimit" | "lineLimit" | null;
};

type ContentViewerOptions = {
  elements: ContentViewerElements;
  invoke?: typeof invoke;
  onSessionError?: (error: unknown) => void;
  onClose?: (restoreFocus: boolean) => void;
};

type NestedScope = {
  scopeId: number;
  parentScopeId: number | null;
  sourceNodeId: number;
  root: NodeDto;
  depth: number;
  maxDepth: number;
  parsedBytes: number;
  cumulativeBytes: number;
  sessionRevision: number;
};

type TextState = {
  offsets: number[];
  offsetIndex: number;
  nextOffset: number | null;
  current: TextChunk | null;
  pages: Map<number, TextChunk>;
};

type HtmlPreviewResult = {
  html: string | null;
  reason: "sizeLimit" | "renderLimit" | null;
};

type NestedFrame = {
  scope: NestedScope;
  source: ContentTarget;
  parentSnapshot: TreeViewSnapshot | null;
  decoded: TextState;
  raw: TextState;
  kind: "json" | "string";
  detection: StringDetection;
  renderOverride: RenderAs;
};

type ParsedSearchPeek = {
  match: SearchMatch;
  sourceStart: number;
  sourceEnd: number;
  text: string;
  truncated: boolean;
};

const TEXT_CHUNK_BYTES = 128 * 1024;
const TEXT_PAGE_CACHE_BYTES = 32 * 1024 * 1024;
const MARKDOWN_AUTO_RENDER_LIMIT_BYTES = 2 * 1024 * 1024;
const MARKDOWN_ANYWAY_LIMIT_BYTES = 32 * 1024 * 1024;
const CODE_AUTO_RENDER_LIMIT_BYTES = 1 * 1024 * 1024;
const CODE_AUTO_RENDER_LIMIT_LINES = 20_000;
const HTML_INPUT_LIMIT_BYTES = 512 * 1024;
const HTML_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MARKDOWN_OVER_LIMIT_NOTE = "Markdown rendering skipped because content exceeds 2 MiB.";
const MARKDOWN_OVER_LIMIT_STATUS = "Markdown source exceeds 2 MiB; showing decoded source.";
const MARKDOWN_HARD_LIMIT_NOTE = "Markdown rendering skipped because content exceeds 32 MiB.";
const MARKDOWN_HARD_LIMIT_STATUS = "Markdown source exceeds 32 MiB; showing decoded source.";
const HTML_PREVIEW_NOTE = "Isolated HTML Preview · Opaque origin · scripts, network, forms, navigation, file access and application IPC blocked.";
const HTML_RENDER_FAILURE_NOTE = "Semantic rendering failed. Showing plain text instead.";
const HTML_SIZE_LIMIT_NOTE = `HTML Preview disabled because content exceeds ${HTML_INPUT_LIMIT_BYTES / 1024} KiB.`;
const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline';";

export class ContentViewer {
  private readonly elements: ContentViewerElements;
  private readonly invokeRequest: typeof invoke;
  private readonly onSessionError: (error: unknown) => void;
  private readonly onClose: ((restoreFocus: boolean) => void) | undefined;
  private generation = 0;
  private ignoredDialogCloseEvents = 0;
  private target: ContentTarget | null = null;
  private detection: StringDetection | null = null;
  private opener: HTMLElement | null = null;
  private busy = false;
  private offsets: number[] = [];
  private offsetIndex = -1;
  private nextOffset: number | null = null;
  private restoreFocusOnClose: boolean | null = null;
  private representation: "rendered" | "decoded" | null = null;
  private semanticLimit: SemanticType | null = null;
  private markdownRenderFailed = false;
  private codeRenderReason: CodeRenderReason | null = null;
  private codeLimitReason: "sizeLimit" | "lineLimit" | null = null;
  private readonly nestedElements: NestedViewerElements | null;
  private readonly nestedTree: TreeView | null;
  private readonly htmlElements: HtmlViewerElements | null;
  private readonly stringElements: StringViewerElements | null;
  private readonly sourceSearch: SearchView | null;
  private readonly renderedSearch: RenderedSearch | null;
  private readonly parsedSearchPeekElements: ParsedSearchPeekElements | null;
  private readonly renderAs: HTMLSelectElement | null;
  private readonly markdownAnyway: HTMLButtonElement | null;
  private readonly copyRaw: HTMLButtonElement;
  private readonly copyDecoded: HTMLButtonElement;
  private readonly copyMarkdown: HTMLButtonElement;
  private readonly copyParsed: HTMLButtonElement;
  private readonly copyStatus: HTMLElement;
  private nestedFrames: NestedFrame[] = [];
  private nestedRepresentation: "parsed" | "decoded" | "raw" | null = null;
  private htmlRepresentation: "preview" | "source" | "raw" | null = null;
  private htmlPreview: string | null = null;
  private htmlPreviewUnavailable = false;
  private htmlNote = "";
  private ordinaryRepresentation: "rendered" | "decoded" | "raw" | null = null;
  private rawPages = new Map<number, TextChunk>();
  private rawPageOffsets: number[] = [];
  private rawPageIndex = -1;
  private rawNextOffset: number | null = null;
  private rawCacheBytes = 0;
  private nestedPageCacheBytes = 0;
  private sourceRevealEpoch = 0;
  private contentReadBusy = false;
  private renderMode: "plainText" | "markdown" | "code" | "html" | "nestedJson" | null = null;
  private codeLanguageHint: CodeLanguage | null = null;
  private renderOverride: RenderAs = "auto";
  private readonly overrides = new Map<string, RenderAs>();
  private overrideRevision: number | null = null;
  private semanticLimitBytes: number | null = null;
  private readonly decodedPages = new Map<number, TextChunk>();
  private decodedPageCacheBytes = 0;
  private readonly codeLineCheckpoints = new Map<number, CodeLineState>();
  private readonly closedScopeIds = new Set<string>();
  private readonly closingScopes = new Map<string, Promise<void>>();
  private readonly rootCloseAttempts = new Map<string, number>();
  private nestedBusy = false;
  private copyEpoch = 0;
  private copyBusy = false;
  private parsedSearchPeek: ParsedSearchPeek | null = null;
  private parsedSearchPeekBytes = 0;

  constructor(options: ContentViewerOptions) {
    this.elements = options.elements;
    this.invokeRequest = options.invoke ?? invoke;
    this.onSessionError = options.onSessionError ?? (() => undefined);
    this.onClose = options.onClose;
    this.nestedElements = options.elements.nested ?? null;
    this.htmlElements = options.elements.html ?? null;
    this.stringElements = options.elements.string ?? null;
    this.renderAs = options.elements.renderAs ?? null;
    this.markdownAnyway = options.elements.markdownAnyway ?? null;
    const copy = options.elements.copy ?? createCopyElements();
    this.copyRaw = copy.raw;
    this.copyDecoded = copy.decoded;
    this.copyMarkdown = copy.markdown;
    this.copyParsed = copy.parsed;
    this.copyStatus = copy.status;
    this.sourceSearch = options.elements.search
      ? new SearchView({
        ...options.elements.search,
        invoke: this.invokeRequest,
        onReveal: (match) => void this.revealSearchMatch(match),
        onError: (error) => this.handleSearchError(error),
        onIntentChange: () => this.cancelContentRead(),
        onRepresentationChange: (representation) => this.activateContentSearchRepresentation(representation)
      })
      : null;
    this.parsedSearchPeekElements = this.nestedElements?.parsedSearchPeek ?? null;
    this.renderedSearch = options.elements.search
      ? new RenderedSearch({
        ...options.elements.search,
        invoke: this.invokeRequest,
        onReveal: (match) => void this.revealRenderedMatch(match),
        onIntentChange: () => this.cancelContentRead(),
        onError: (error) => this.handleSearchError(error),
        onProjectionUnavailable: () => {
          this.sourceSearch?.refresh();
          this.setStatus("Rendered search is unavailable for this page; switch to Decoded Source.");
        }
      })
      : null;
    const nestedCopy = this.nestedElements ? createNestedCopyElements() : null;
    nestedCopy?.container && this.nestedElements?.parsedPanel.prepend(nestedCopy.container);
    this.nestedTree = this.nestedElements
      ? new TreeView({
        panel: this.nestedElements.parsedTree,
        tab: this.nestedElements.parsedTab,
        inspector: null,
        fields: null,
        onSelection: () => undefined,
        onStringSelection: () => undefined,
        onStringOpen: (target) => { void this.openNestedChild(target); },
        onError: (error) => this.handleFailure(error),
        invoke: this.invokeRequest,
        copy: nestedCopy?.elements
      })
      : null;
    this.elements.close.addEventListener("click", () => this.close());
    this.elements.dialog.addEventListener("keydown", (event) => this.handleDialogKeydown(event));
    this.copyRaw.addEventListener("click", () => void this.copyTarget("raw", "Copied Raw Lexeme"));
    this.copyDecoded.addEventListener("click", () => void this.copyTarget("decoded", "Copied Decoded Value"));
    this.copyMarkdown.addEventListener("click", () => void this.copyTarget("decoded", "Copied Markdown Source"));
    this.copyParsed.addEventListener("click", () => void this.copyParsedJson());
    this.renderAs?.addEventListener("change", () => void this.changeRenderAs());
    this.markdownAnyway?.addEventListener("click", () => void this.renderMarkdownAnyway());
    this.elements.previous.addEventListener("click", () => void this.readPrevious());
    this.elements.next.addEventListener("click", () => void this.readNext());
    this.nestedElements?.back.addEventListener("click", () => void this.backNested());
    this.nestedElements?.parsedTab.addEventListener("click", () => this.activateNestedRepresentation("parsed"));
    this.nestedElements?.decodedTab.addEventListener("click", () => this.activateNestedRepresentation("decoded"));
    this.nestedElements?.rawTab.addEventListener("click", () => this.activateNestedRepresentation("raw"));
    this.nestedElements?.representations.addEventListener("keydown", (event) => this.handleNestedTabKeydown(event));
    this.htmlElements?.previewTab.addEventListener("click", () => this.activateHtmlRepresentation("preview"));
    this.htmlElements?.sourceTab.addEventListener("click", () => this.activateHtmlRepresentation("source"));
    this.htmlElements?.rawTab?.addEventListener("click", () => this.activateHtmlRepresentation("raw"));
    this.htmlElements?.representations.addEventListener("keydown", (event) => this.handleHtmlTabKeydown(event));
    this.stringElements?.renderedTab.addEventListener("click", () => this.activateOrdinaryRepresentation("rendered"));
    this.stringElements?.decodedTab.addEventListener("click", () => this.activateOrdinaryRepresentation("decoded"));
    this.stringElements?.rawTab.addEventListener("click", () => this.activateOrdinaryRepresentation("raw"));
    this.stringElements?.representations.addEventListener("keydown", (event) => this.handleStringTabKeydown(event));
    this.elements.dialog.addEventListener("cancel", () => {
      // Let the platform close the dialog and let the close event restore focus.
      this.restoreFocusOnClose = true;
    });
    this.elements.dialog.addEventListener("close", () => {
      if (this.ignoredDialogCloseEvents > 0) {
        this.ignoredDialogCloseEvents -= 1;
        return;
      }
      this.finishClose();
    });
    this.resetDom();
  }

  get isOpen(): boolean {
    return this.elements.dialog.open;
  }

  clearOverridesForRevision(revision?: number): void {
    this.overrides.clear();
    if (revision !== undefined) this.overrideRevision = revision;
    this.renderOverride = "auto";
    this.syncRenderAsSelect();
  }

  async open(target: ContentTarget, opener: HTMLElement | null = null): Promise<void> {
    if (this.overrideRevision !== null && this.overrideRevision !== target.revision) this.overrides.clear();
    this.overrideRevision = target.revision;
    this.releaseNestedScopes();
    this.clearHtmlPreviewFrame();
    this.generation += 1;
    this.sourceRevealEpoch += 1;
    this.clearParsedSearchPeek();
    this.invalidateCopy();
    const generation = this.generation;
    this.restoreFocusOnClose = null;
    this.target = cloneTarget(target);
    this.renderOverride = this.overrides.get(renderOverrideKey(target)) ?? "auto";
    this.detection = null;
    this.opener = opener;
    this.contentReadBusy = false;
    this.busy = true;
    this.offsets = [0];
    this.offsetIndex = 0;
    this.nextOffset = null;
    this.clearContent();
    this.elements.range.textContent = "—";
    this.representation = null;
    this.semanticLimit = null;
    this.semanticLimitBytes = null;
    this.renderMode = null;
    this.codeLanguageHint = null;
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    this.codeLimitReason = null;
    this.nestedRepresentation = null;
    this.nestedBusy = false;
    this.htmlRepresentation = null;
    this.htmlPreview = null;
    this.htmlPreviewUnavailable = false;
    this.htmlNote = "";
    this.ordinaryRepresentation = null;
    this.clearDecodedPages();
    this.clearRawPages();
    this.clearCodeLineCheckpoints();
    this.setNestedVisible(false);
    this.setStringVisible(false);
    this.setHtmlVisible(false);
    this.sourceSearch?.clear();
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.elements.alert.hidden = true;
    this.setStatus("Loading decoded source…");
    this.renderMetadata();
    this.renderPaging();
    if (!this.elements.dialog.open) this.elements.dialog.showModal();
    this.elements.close.focus();
    queueMicrotask(() => {
      if (this.generation === generation && this.elements.dialog.open) this.elements.close.focus();
    });

    try {
      const detectionValue = await this.invokeRequest<unknown>("get_string_detection", {
        nodeId: target.nodeId,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isCurrent(generation, target)) return;
      const detection = validateDetection(detectionValue);
      if (!detection) throw new Error("The string detection response was invalid.");
      this.detection = detection;
      this.renderMetadata();

      await this.renderSelection(target, generation, this.renderOverride);
    } catch (error) {
      if (!this.isCurrent(generation, target)) return;
      this.handleFailure(error);
    }
  }

  clear(restoreFocus = true, clearOverrides = false): void {
    if (clearOverrides) this.overrides.clear();
    this.releaseNestedScopes();
    this.clearHtmlPreviewFrame();
    this.restoreFocusOnClose = restoreFocus;
    this.generation += 1;
    this.sourceRevealEpoch += 1;
    this.clearParsedSearchPeek();
    this.invalidateCopy();
    this.target = null;
    this.detection = null;
    this.contentReadBusy = false;
    this.busy = false;
    this.offsets = [];
    this.offsetIndex = -1;
    this.nextOffset = null;
    this.clearContent();
    this.representation = null;
    this.semanticLimit = null;
    this.semanticLimitBytes = null;
    this.renderMode = null;
    this.codeLanguageHint = null;
    this.renderOverride = "auto";
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    this.codeLimitReason = null;
    this.nestedRepresentation = null;
    this.nestedBusy = false;
    this.htmlRepresentation = null;
    this.htmlPreview = null;
    this.htmlPreviewUnavailable = false;
    this.htmlNote = "";
    this.ordinaryRepresentation = null;
    this.clearDecodedPages();
    this.clearRawPages();
    this.clearCodeLineCheckpoints();
    this.setNestedVisible(false);
    this.setStringVisible(false);
    this.setHtmlVisible(false);
    this.sourceSearch?.clear();
    this.elements.alert.hidden = true;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.setStatus("");
    this.renderMetadata();
    this.renderPaging();
    this.finishDialogClose();
  }

  private async copyTarget(format: "raw" | "decoded", successLabel: string): Promise<void> {
    const target = this.target;
    const detection = this.detection;
    if (!target || !detection || this.copyBusy) return;
    const copyEpoch = this.copyEpoch;
    const generation = this.generation;
    this.copyBusy = true;
    this.copyStatus.textContent = "Copying…";
    this.renderCopyControls();
    try {
      await this.invokeRequest("copy_node", {
        nodeId: target.nodeId,
        scopeId: target.scopeId,
        sessionRevision: target.revision,
        format
      });
      if (!this.isCopyCurrent(copyEpoch, generation, target)) return;
      this.copyStatus.textContent = successLabel;
    } catch (error) {
      if (!this.isCopyCurrent(copyEpoch, generation, target)) return;
      if (isGlobalError(error)) this.onSessionError(error);
      else this.copyStatus.textContent = `Copy failed: ${errorMessage(error)}`;
    } finally {
      if (this.isCopyCurrent(copyEpoch, generation, target)) {
        this.copyBusy = false;
        this.renderCopyControls();
      }
    }
  }

  private async copyParsedJson(): Promise<void> {
    const target = this.target;
    const frame = this.nestedFrames.at(-1);
    if (!target || !frame || frame.kind !== "json" || this.nestedRepresentation !== "parsed" || this.copyBusy) return;
    const copyEpoch = this.copyEpoch;
    const generation = this.generation;
    const scopeId = frame.scope.scopeId;
    const sessionRevision = frame.scope.sessionRevision;
    const nodeId = frame.scope.root.id;
    this.copyBusy = true;
    this.copyStatus.textContent = "Copying…";
    this.renderCopyControls();
    try {
      await this.invokeRequest("copy_node", {
        nodeId,
        scopeId,
        sessionRevision,
        format: "parsed"
      });
      if (!this.isCopyCurrent(copyEpoch, generation, target, scopeId, nodeId)) return;
      this.copyStatus.textContent = "Copied Parsed JSON";
    } catch (error) {
      if (!this.isCopyCurrent(copyEpoch, generation, target, scopeId, nodeId)) return;
      if (isGlobalError(error)) this.onSessionError(error);
      else this.copyStatus.textContent = `Copy failed: ${errorMessage(error)}`;
    } finally {
      if (this.isCopyCurrent(copyEpoch, generation, target, scopeId, nodeId)) {
        this.copyBusy = false;
        this.renderCopyControls();
      }
    }
  }

  private isCopyCurrent(
    copyEpoch: number,
    generation: number,
    target: ContentTarget,
    parsedScopeId?: number,
    parsedNodeId?: number
  ): boolean {
    const current = this.target;
    const frame = this.nestedFrames.at(-1);
    return this.copyEpoch === copyEpoch
      && this.generation === generation
      && current !== null
      && current.revision === target.revision
      && current.nodeId === target.nodeId
      && current.scopeId === target.scopeId
      && (parsedScopeId === undefined
        ? true
        : frame?.kind === "json" && frame.scope.scopeId === parsedScopeId && frame.scope.root.id === parsedNodeId);
  }

  private renderCopyControls(): void {
    const targetAvailable = this.target !== null && this.detection !== null;
    const parsedFrame = this.nestedFrames.at(-1);
    const parsedAvailable = parsedFrame?.kind === "json" && this.nestedRepresentation === "parsed";
    this.copyRaw.hidden = !targetAvailable;
    this.copyDecoded.hidden = !targetAvailable;
    this.copyMarkdown.hidden = !targetAvailable || this.renderMode !== "markdown";
    this.copyParsed.hidden = !parsedAvailable;
    const disabled = this.copyBusy || this.busy || this.nestedBusy || !targetAvailable;
    for (const button of [this.copyRaw, this.copyDecoded, this.copyMarkdown, this.copyParsed]) {
      button.disabled = disabled || button.hidden;
    }
    this.copyStatus.hidden = this.copyStatus.textContent === "";
  }

  private invalidateCopy(): void {
    this.copyEpoch += 1;
    this.copyBusy = false;
    this.copyStatus.textContent = "";
  }

  close(): void {
    this.restoreFocusOnClose = true;
    this.releaseNestedScopes();
    this.clearHtmlPreviewFrame();
    this.finishDialogClose();
  }

  private finishDialogClose(): void {
    if (this.elements.dialog.open) {
      this.ignoredDialogCloseEvents += 1;
      this.elements.dialog.close();
    }
    this.finishClose();
  }

  private async readNext(): Promise<void> {
    if (this.nestedRepresentation === "decoded" || this.nestedRepresentation === "raw") {
      await this.readNestedPage("next");
      return;
    }
    if (this.htmlRepresentation === "preview") return;
    if (this.ordinaryRepresentation === "raw" || this.htmlRepresentation === "raw") {
      await this.readRawPage("next");
      return;
    }
    if (this.busy || !this.target || this.nextOffset === null) return;
    const offset = this.nextOffset;
    await this.readPage(offset, "next");
  }

  private async readPrevious(): Promise<void> {
    if (this.nestedRepresentation === "decoded" || this.nestedRepresentation === "raw") {
      await this.readNestedPage("previous");
      return;
    }
    if (this.htmlRepresentation === "preview") return;
    if (this.ordinaryRepresentation === "raw" || this.htmlRepresentation === "raw") {
      await this.readRawPage("previous");
      return;
    }
    if (this.busy || !this.target || this.offsetIndex <= 0) return;
    await this.readPage(this.offsets[this.offsetIndex - 1], "previous", this.offsets[this.offsetIndex]);
  }

  private async readPage(offset: number, direction: "initial" | "next" | "previous", expectedNextOffset?: number): Promise<void> {
    const target = this.target;
    if (!target) return;
    const intent = ++this.sourceRevealEpoch;
    const cached = this.decodedPages.get(offset);
    if (cached) {
      if (direction === "next") {
        this.offsets = this.offsets.slice(0, this.offsetIndex + 1);
        this.offsets.push(offset);
        this.offsetIndex += 1;
      } else if (direction === "previous") {
        this.offsetIndex -= 1;
      } else {
        this.offsets = [offset];
        this.offsetIndex = 0;
      }
      this.installChunk(cached);
      return;
    }
    const generation = this.generation;
    this.contentReadBusy = true;
    this.busy = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.setStatus("Loading decoded source…");
    this.renderMetadata();
    this.renderPaging();
    try {
      const pageStartState = this.codeLineCheckpoints.get(offset) ?? { line: 1, previousWasCR: false };
      const value = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset,
        length: TEXT_CHUNK_BYTES,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isReadCurrent(generation, target, intent)) return;
      const chunk = validateChunk(value, offset, rawSpanLength(target), expectedNextOffset, false, pageStartState);
      if (!chunk) throw new Error("The decoded text response was invalid.");
      if (direction === "next") {
        this.offsets = this.offsets.slice(0, this.offsetIndex + 1);
        this.offsets.push(offset);
        this.offsetIndex += 1;
      } else if (direction === "previous") {
        this.offsetIndex -= 1;
      } else {
        this.offsets = [chunk.start];
        this.offsetIndex = 0;
      }
      this.installChunk(chunk);
    } catch (error) {
      if (!this.isReadCurrent(generation, target, intent)) return;
      this.handleFailure(error);
    }
  }

  private async readRawPage(direction: "initial" | "next" | "previous"): Promise<void> {
    const target = this.target;
    if (!target || this.busy || (this.nestedRepresentation !== null && this.nestedRepresentation !== "raw")) return;
    const intent = ++this.sourceRevealEpoch;
    const start = 0;
    const end = target.spanEnd - target.spanStart;
    const offset = direction === "initial" ? (this.rawPageOffsets[this.rawPageIndex] ?? start)
      : direction === "next" ? this.rawNextOffset ?? end
        : this.rawPageOffsets[this.rawPageIndex - 1] ?? start;
    if (offset < start || offset > end || direction !== "initial" && offset === end) return;
    const cached = this.rawPages.get(offset);
    if (cached) {
      if (direction === "next") {
        this.rawPageOffsets = this.rawPageOffsets.slice(0, this.rawPageIndex + 1);
        this.rawPageOffsets.push(offset);
        this.rawPageIndex += 1;
      } else if (direction === "previous") this.rawPageIndex -= 1;
      this.installRawChunk(cached);
      return;
    }
    const generation = this.generation;
    this.contentReadBusy = true;
    this.busy = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.setStatus("Loading raw lexeme…");
    this.renderMetadata();
    this.renderPaging();
    try {
      const value = await this.invokeRequest<unknown>("read_raw_slice", {
        sourceStart: target.spanStart + offset,
        length: Math.min(TEXT_CHUNK_BYTES, end - offset),
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isReadCurrent(generation, target, intent)) return;
      const chunk = normalizeRawChunk(value, target.spanStart + offset, target.spanStart, target.spanEnd, Math.min(TEXT_CHUNK_BYTES, end - offset));
      if (!chunk) throw new Error("The raw lexeme response was invalid.");
      if (direction === "next") {
        this.rawPageOffsets = this.rawPageOffsets.slice(0, this.rawPageIndex + 1);
        this.rawPageOffsets.push(chunk.start);
        this.rawPageIndex += 1;
      } else if (direction === "initial") {
        this.rawPageOffsets = [chunk.start];
        this.rawPageIndex = 0;
      } else {
        this.rawPageIndex = Math.max(0, this.rawPageIndex - 1);
      }
      this.cacheRawPage(chunk);
      this.installRawChunk(chunk);
    } catch (error) {
      if (!this.isReadCurrent(generation, target, intent)) return;
      this.handleFailure(error);
    }
  }

  private installRawChunk(chunk: TextChunk): void {
    this.contentReadBusy = false;
    this.busy = false;
    this.elements.content.classList.remove("is-markdown");
    this.elements.content.textContent = chunk.text;
    this.representation = "decoded";
    this.ordinaryRepresentation = "raw";
    this.rawNextOffset = chunk.nextOffset;
    const target = this.target;
    const absoluteStart = target ? target.spanStart + chunk.start : chunk.start;
    this.elements.range.textContent = `[${absoluteStart}, ${absoluteStart + utf8ByteLength(chunk.text)})`;
    this.setStatus("Raw lexeme ready");
    this.elements.alert.hidden = true;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.setStringVisible(true);
    this.renderMetadata();
    this.renderPaging();
  }

  private cacheRawPage(chunk: TextChunk): void {
    const previous = this.rawPages.get(chunk.start);
    if (previous) this.rawCacheBytes -= utf8ByteLength(previous.text);
    this.rawPages.set(chunk.start, chunk);
    this.rawCacheBytes += utf8ByteLength(chunk.text);
    this.trimTextCaches();
  }

  private cacheNestedPage(frame: NestedFrame, representation: "decoded" | "raw", chunk: TextChunk): void {
    const state = textState(frame, representation);
    const previous = state.pages.get(chunk.start);
    if (previous) this.nestedPageCacheBytes -= utf8ByteLength(previous.text);
    state.pages.set(chunk.start, chunk);
    this.nestedPageCacheBytes += utf8ByteLength(chunk.text);
    this.trimTextCaches();
  }

  private clearNestedPageCache(state: TextState): void {
    for (const chunk of state.pages.values()) this.nestedPageCacheBytes -= utf8ByteLength(chunk.text);
    state.pages.clear();
    this.nestedPageCacheBytes = Math.max(0, this.nestedPageCacheBytes);
  }

  private discardNestedFrame(frame: NestedFrame): void {
    this.clearNestedPageCache(frame.decoded);
    this.clearNestedPageCache(frame.raw);
  }

  private trimTextCaches(): void {
    while (this.decodedPageCacheBytes + this.rawCacheBytes + this.nestedPageCacheBytes + this.parsedSearchPeekBytes > TEXT_PAGE_CACHE_BYTES) {
      if (this.decodedPages.size > 1) {
        const oldest = this.decodedPages.keys().next().value;
        if (typeof oldest === "number") {
          const page = this.decodedPages.get(oldest);
          this.decodedPages.delete(oldest);
          if (page) this.decodedPageCacheBytes -= utf8ByteLength(page.text);
          continue;
        }
      }
      if (this.rawPages.size > 1) {
        const oldest = this.rawPages.keys().next().value;
        if (typeof oldest === "number") {
          const page = this.rawPages.get(oldest);
          this.rawPages.delete(oldest);
          if (page) this.rawCacheBytes -= utf8ByteLength(page.text);
          continue;
        }
      }
      let evicted = false;
      for (const frame of this.nestedFrames) {
        for (const state of [frame.decoded, frame.raw]) {
          if (state.pages.size <= 1) continue;
          const oldest = state.pages.keys().next().value;
          if (typeof oldest !== "number") continue;
          const page = state.pages.get(oldest);
          state.pages.delete(oldest);
          if (page) this.nestedPageCacheBytes -= utf8ByteLength(page.text);
          evicted = true;
          break;
        }
        if (evicted) break;
      }
      if (!evicted) break;
    }
  }

  private async renderSelection(target: ContentTarget, generation: number, selection: RenderAs): Promise<void> {
    this.renderOverride = selection;
    if (selection === "auto") {
      const semanticType = this.detection?.semanticType;
      if (semanticType === "nestedJson" && this.restoreExistingParsedFrame(target, selection)) {
        return;
      }
      if (semanticType === "nestedJson") {
        const parent = this.nestedFrames.at(-1);
        if (parent?.kind === "string" && target.scopeId === parent.scope.scopeId && this.detection) {
          const parentSnapshot = this.nestedTree?.snapshot() ?? parent.parentSnapshot;
          await this.openNestedJsonFrame(cloneTarget(target), parent, parentSnapshot, generation, this.detection, selection);
        } else if (!parent && target.scopeId === null) {
          await this.openNestedRoot(target, generation);
        } else {
          throw new Error("Nested JSON can only open from the current string scope.");
        }
      } else if (semanticType === "html") {
        await this.openHtml(target, generation);
      } else if (semanticType === "markdown" || semanticType === "code") {
        await this.openSemantic(target, generation, semanticType);
      } else {
        await this.openPlain(target, generation);
      }
      return;
    }
    if (selection === "plainText") {
      await this.openPlain(target, generation);
    } else if (selection === "markdown") {
      await this.openSemantic(target, generation, "markdown");
    } else if (selection === "nestedJson") {
      if (this.restoreExistingParsedFrame(target, selection)) {
        return;
      }
      const parent = this.nestedFrames.at(-1);
      if (parent?.kind === "string" && target.scopeId === parent.scope.scopeId && this.detection) {
        const parentSnapshot = this.nestedTree?.snapshot() ?? parent.parentSnapshot;
        const source = cloneTarget(target);
        await this.openNestedJsonFrame(source, parent, parentSnapshot, generation, this.detection, selection);
      } else if (!parent) {
        await this.openNestedRoot(target, generation);
      } else {
        throw new Error("Nested JSON can only open from the current string scope.");
      }
    } else if (selection === "html") {
      await this.openHtml(target, generation);
    } else if (selection === "code") {
      await this.openSemantic(target, generation, "code");
    } else {
      await this.openSemantic(target, generation, "code", selection);
    }
  }

  private async openPlain(target: ContentTarget, generation: number): Promise<void> {
    this.renderMode = "plainText";
    this.codeLanguageHint = null;
    this.semanticLimit = null;
    this.semanticLimitBytes = null;
    const chunkValue = await this.invokeRequest<unknown>("read_decoded_text", {
      nodeId: target.nodeId,
      offset: 0,
      length: TEXT_CHUNK_BYTES,
      sessionRevision: target.revision,
      scopeId: target.scopeId
    });
    if (!this.isCurrent(generation, target)) return;
    const chunk = validateChunk(chunkValue, 0, rawSpanLength(target));
    if (!chunk) throw new Error("The decoded text response was invalid.");
    this.installChunk(chunk, true);
    this.ordinaryRepresentation = "rendered";
    this.setStringVisible(true);
    this.renderMetadata();
  }

  private async openSemantic(
    target: ContentTarget,
    generation: number,
    semanticType: SemanticType,
    languageHint: CodeLanguage | null = null,
    allowMarkdownAnyway = false
  ): Promise<void> {
    this.renderMode = semanticType;
    this.codeLanguageHint = semanticType === "code" ? languageHint : null;
    const limit = semanticType === "markdown"
      ? allowMarkdownAnyway ? MARKDOWN_ANYWAY_LIMIT_BYTES : MARKDOWN_AUTO_RENDER_LIMIT_BYTES
      : CODE_AUTO_RENDER_LIMIT_BYTES;
    const collected = await this.collectSemanticSource(target, generation, limit, semanticType === "code");
    if (!collected) return;
    this.semanticLimit = collected.overLimit ? semanticType : null;
    this.semanticLimitBytes = collected.overLimit ? limit : null;
    this.codeLimitReason = semanticType === "code" && collected.overLimit
      ? collected.overLimitReason ?? "sizeLimit"
      : null;
    const chunk = collected.overLimit
      ? collected.first
      : {
        start: 0,
        text: collected.text ?? "",
        hasMore: false,
        nextOffset: null,
        lineState: { line: 1, previousWasCR: false }
      };
    this.installChunk(chunk, true, collected.overLimit ? null : collected.first);
  }

  private async changeRenderAs(): Promise<void> {
    const target = this.target;
    const select = this.renderAs;
    if (!target || !select || this.busy || !this.detection) return;
    const next = renderAsValue(select.value);
    if (next === undefined) {
      this.syncRenderAsSelect();
      return;
    }
    const previous = this.renderOverride;
    const key = renderOverrideKey(target);
    const previousMapValue = this.overrides.get(key);
    if (next === previous) return;
    const generation = ++this.generation;
    this.clearParsedSearchPeek();
    this.sourceRevealEpoch += 1;
    this.invalidateCopy();
    if (next === "nestedJson") {
      this.renderOverride = next;
      try {
        const opened = await this.openNestedOverride(target, generation);
        if (!opened || !this.isCurrent(generation, target)) return;
        this.overrides.set(key, next);
        this.renderOverride = next;
        this.updateCurrentFrameOverride(target, next);
        this.syncRenderAsSelect();
      } catch (error) {
        if (!this.isCurrent(generation, target)) return;
        this.nestedBusy = false;
        if (errorCode(error) === "file_changed" || errorCode(error) === "stale_session") {
          this.handleFailure(error);
          return;
        }
        if (previousMapValue === undefined) this.overrides.delete(key);
        else this.overrides.set(key, previousMapValue);
        this.renderOverride = previous;
        this.syncRenderAsSelect();
        this.elements.alert.hidden = false;
        this.elements.alert.textContent = `Content could not be opened: ${errorMessage(error)}`;
        this.setStatus("Nested JSON override failed");
        this.renderMetadata();
        this.renderPaging();
      }
      return;
    }
    if (next === "auto") this.overrides.delete(key);
    const inNestedScope = this.nestedFrames.length > 0;
    this.prepareRendererLoad(inNestedScope);
    try {
      await this.renderSelection(target, generation, next);
      if (!this.isCurrent(generation, target)) return;
      if (next === "auto") this.overrides.delete(key);
      else this.overrides.set(key, next);
      this.renderOverride = next;
      this.updateCurrentFrameOverride(target, next);
      if (inNestedScope) {
        this.setNestedVisible(true);
        this.renderNestedBreadcrumb();
      }
      this.syncRenderAsSelect();
    } catch (error) {
      if (!this.isCurrent(generation, target)) return;
      if (previousMapValue === undefined) this.overrides.delete(key);
      else this.overrides.set(key, previousMapValue);
      this.renderOverride = previous;
      this.syncRenderAsSelect();
      this.renderMetadata();
      this.handleFailure(error);
    }
  }

  private async renderMarkdownAnyway(): Promise<void> {
    const target = this.target;
    if (!target || this.busy || this.renderMode !== "markdown" || this.semanticLimitBytes !== MARKDOWN_AUTO_RENDER_LIMIT_BYTES) return;
    const generation = ++this.generation;
    this.invalidateCopy();
    this.prepareRendererLoad(this.nestedFrames.length > 0);
    try {
      await this.openSemantic(target, generation, "markdown", null, true);
      if (this.isCurrent(generation, target)) this.renderMarkdownAnywayButton();
    } catch (error) {
      if (this.isCurrent(generation, target)) this.handleFailure(error);
    }
  }

  private async openNestedOverride(target: ContentTarget, generation: number): Promise<boolean> {
    if (this.restoreExistingParsedFrame(target, "nestedJson")) return true;
    const parent = this.nestedFrames.at(-1);
    if (!parent && target.scopeId === null && this.detection) {
      return this.openNestedRoot(target, generation, true);
    }
    if (!parent || parent.kind !== "string" || target.scopeId !== parent.scope.scopeId || !this.detection) return false;
    this.nestedBusy = true;
    this.syncRenderAsSelect();
    this.setStatus("Loading parsed nested JSON…");
    this.renderPaging();
    const parentSnapshot = this.nestedTree?.snapshot() ?? parent.parentSnapshot;
    await this.openNestedJsonFrame(cloneTarget(target), parent, parentSnapshot, generation, this.detection, "nestedJson");
    return true;
  }

  private restoreExistingParsedFrame(target: ContentTarget, selection: RenderAs): boolean {
    const frame = this.nestedFrames.at(-1);
    if (!frame || frame.kind !== "json" || renderOverrideKey(frame.source) !== renderOverrideKey(target)) return false;
    this.target = cloneTarget(frame.source);
    this.detection = frame.detection;
    this.renderOverride = selection;
    frame.renderOverride = selection;
    this.renderMode = "nestedJson";
    this.nestedRepresentation = "parsed";
    this.nestedBusy = false;
    this.busy = false;
    this.cleanupParsedPresentation();
    this.setNestedTreeSession(frame);
    this.setNestedVisible(true);
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.setStatus("Parsed nested JSON ready");
    this.renderMetadata();
    this.renderPaging();
    focusNestedRoot(this.nestedElements?.parsedTree ?? null);
    return true;
  }

  private prepareRendererLoad(keepNestedNavigation = false): void {
    this.clearParsedSearchPeek();
    this.renderedSearch?.invalidate();
    this.contentReadBusy = false;
    this.busy = true;
    this.offsets = [0];
    this.offsetIndex = 0;
    this.nextOffset = null;
    this.clearContent();
    this.clearDecodedPages();
    this.clearCodeLineCheckpoints();
    this.representation = null;
    this.semanticLimit = null;
    this.semanticLimitBytes = null;
    this.nestedRepresentation = null;
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    this.codeLimitReason = null;
    this.htmlRepresentation = null;
    this.htmlPreview = null;
    this.htmlPreviewUnavailable = false;
    this.htmlNote = "";
    if (keepNestedNavigation) this.setNestedVisible(true);
    else this.setNestedVisible(false);
    this.clearHtmlPreviewFrame();
    this.setHtmlVisible(false);
    this.elements.alert.hidden = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.setStatus("Loading renderer…");
    this.renderMetadata();
    this.renderPaging();
  }

  private syncRenderAsSelect(): void {
    const select = this.renderAs;
    if (!select) return;
    select.value = renderAsOption(this.renderOverride);
    select.disabled = this.target === null || this.detection === null || this.busy || this.nestedBusy;
    this.renderMarkdownAnywayButton();
  }

  private renderMarkdownAnywayButton(): void {
    if (!this.markdownAnyway) return;
    const visible = this.renderMode === "markdown" && this.semanticLimitBytes === MARKDOWN_AUTO_RENDER_LIMIT_BYTES;
    this.markdownAnyway.hidden = !visible;
    this.markdownAnyway.disabled = this.busy;
  }

  private updateCurrentFrameOverride(target: ContentTarget, override: RenderAs): void {
    const frame = this.nestedFrames.at(-1);
    if (frame && renderOverrideKey(frame.source) === renderOverrideKey(target)) frame.renderOverride = override;
  }

  private async collectSemanticSource(
    target: ContentTarget,
    generation: number,
    limit: number,
    trackCodeLines = false
  ): Promise<CollectedText | null> {
    const parts: string[] = [];
    let totalBytes = 0;
    let offset = 0;
    let first: TextChunk | undefined;
    let lineState: CodeLineState = { line: 1, previousWasCR: false };
    while (true) {
      const value = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset,
        length: TEXT_CHUNK_BYTES,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isCurrent(generation, target)) return null;
      const chunk = validateChunk(value, offset, rawSpanLength(target), undefined, false, lineState);
      if (!chunk) throw new Error("The decoded text response was invalid.");
      const firstChunk = first ?? chunk;
      first = firstChunk;
      const byteLength = utf8ByteLength(chunk.text);
      const nextLineState = scanCodeLines(chunk.text, lineState);
      this.codeLineCheckpoints.set(chunk.start, lineState);
      if (chunk.nextOffset !== null) this.codeLineCheckpoints.set(chunk.nextOffset, nextLineState);
      if (trackCodeLines && nextLineState.line > CODE_AUTO_RENDER_LIMIT_LINES) {
        return { first: firstChunk, text: null, overLimit: true, overLimitReason: "lineLimit" };
      }
      if (byteLength > limit - totalBytes) {
        return { first: firstChunk, text: null, overLimit: true, overLimitReason: "sizeLimit" };
      }
      parts.push(chunk.text);
      totalBytes += byteLength;
      if (totalBytes === limit && chunk.hasMore) {
        return { first: firstChunk, text: null, overLimit: true, overLimitReason: "sizeLimit" };
      }
      if (!chunk.hasMore) {
        return { first: firstChunk, text: parts.join(""), overLimit: false, overLimitReason: null };
      }
      if (chunk.nextOffset === null) throw new Error("The decoded text response was invalid.");
      offset = chunk.nextOffset;
      lineState = nextLineState;
    }
  }

  private installChunk(chunk: TextChunk, initial = false, sourceFallback: TextChunk | null = null): void {
    this.contentReadBusy = false;
    this.busy = false;
    this.elements.content.classList.remove("is-markdown");
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    const canRenderSemantic = initial && !chunk.hasMore && this.semanticLimit === null
      && (this.renderMode === "markdown" || this.renderMode === "code");
    let sourceChunk = chunk;
    let cacheChunk: TextChunk | null = canRenderSemantic ? null : chunk;
    if (this.renderMode === "code" && this.semanticLimit === "code" && this.ordinaryRepresentation !== "decoded") {
      const result = renderPlainCodePage(
        chunk.text,
        this.codeLanguageHint,
        this.codeLimitReason ?? "sizeLimit",
        chunk.lineState
      );
      this.elements.content.replaceChildren(result.fragment);
      this.representation = "rendered";
      this.ordinaryRepresentation = "rendered";
      this.codeRenderReason = result.reason;
    } else if (canRenderSemantic && this.renderMode === "markdown") {
      const fragment = renderSafeMarkdown(chunk.text);
      if (fragment) {
        this.elements.content.replaceChildren(fragment);
        this.elements.content.classList.add("is-markdown");
        this.representation = "rendered";
        this.ordinaryRepresentation = "rendered";
      } else {
        sourceChunk = sourceFallback ?? chunk;
        cacheChunk = sourceChunk;
        this.elements.content.textContent = sourceChunk.text;
        this.representation = "decoded";
        this.ordinaryRepresentation = "decoded";
        this.markdownRenderFailed = true;
      }
    } else if (canRenderSemantic && this.renderMode === "code") {
      const result = renderCode(chunk.text, this.codeLanguageHint);
      this.elements.content.replaceChildren(result.fragment);
      this.representation = "rendered";
      this.ordinaryRepresentation = "rendered";
      this.codeRenderReason = result.reason;
    } else {
      this.elements.content.textContent = chunk.text;
      this.representation = "decoded";
      this.ordinaryRepresentation = "decoded";
    }
    if (cacheChunk) this.cacheDecodedPage(cacheChunk);
    this.rememberCodeChunk(sourceChunk);
    this.nextOffset = sourceChunk.nextOffset;
    if (this.renderMode === "html") {
      this.htmlRepresentation = "source";
      this.setHtmlVisible(true);
    } else {
      this.setStringVisible(true);
    }
    this.renderMetadata();
    this.elements.alert.hidden = true;
    if (this.semanticLimit === "markdown") {
      this.setStatus(this.semanticLimitBytes === MARKDOWN_ANYWAY_LIMIT_BYTES
        ? MARKDOWN_HARD_LIMIT_STATUS
        : MARKDOWN_OVER_LIMIT_STATUS);
    } else if (this.representation === "rendered") {
      this.setStatus(this.renderMode === "code" ? "Rendered Code ready" : "Rendered Markdown ready");
    } else if (sourceChunk.text.length === 0 && !sourceChunk.hasMore) {
      this.setStatus("Empty string");
    } else {
      this.setStatus("Decoded source ready");
    }
    this.elements.range.textContent = `[${sourceChunk.start}, ${sourceChunk.start + utf8ByteLength(sourceChunk.text)})`;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.renderPaging();
  }

  private async openNestedRoot(target: ContentTarget, generation: number, propagateFailure = false): Promise<boolean> {
    const nested = this.nestedElements;
    const tree = this.nestedTree;
    if (!nested || !tree) {
      const value = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset: 0,
        length: TEXT_CHUNK_BYTES,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isCurrent(generation, target)) return false;
      const chunk = validateChunk(value, 0, rawSpanLength(target));
      if (!chunk) throw new Error("The decoded text response was invalid.");
      this.installChunk(chunk, true);
      return true;
    }
    this.nestedBusy = true;
    this.syncRenderAsSelect();
    this.setStatus("Loading parsed nested JSON…");
    this.renderPaging();
    try {
      const value = await this.invokeRequest<unknown>("open_nested_json", {
        parentScopeId: target.scopeId,
        nodeId: target.nodeId,
        maxDepth: null,
        sessionRevision: target.revision
      });
      if (!this.isCurrent(generation, target)) {
        this.bestEffortCloseScope(value, target.revision);
        return false;
      }
      const scope = validateNestedScope(value, target, null);
      if (!scope) {
        this.bestEffortCloseScope(value, target.revision);
        throw new Error("The nested JSON scope response was invalid.");
      }
      this.cleanupParsedPresentation();
      const frame: NestedFrame = {
        scope,
        source: cloneTarget(target),
        parentSnapshot: null,
        decoded: newTextState(),
        raw: newTextState(),
        kind: "json",
        detection: this.detection ?? { semanticType: "nestedJson", detectionSource: "contentDetected", plainReason: null },
        renderOverride: this.renderOverride
      };
      this.nestedFrames = [frame];
      this.renderMode = "nestedJson";
      this.nestedRepresentation = "parsed";
      this.nestedBusy = false;
      this.busy = false;
      tree.setSession({
        mode: "nested",
        sessionRevision: scope.sessionRevision,
        scopeId: scope.scopeId,
        sourceSize: scope.parsedBytes,
        ariaLabel: "Parsed nested JSON structure",
        scopeLabel: target.scopeLabel
      }, scope.root);
      this.setNestedVisible(true);
      this.elements.dialog.removeAttribute("aria-busy");
      this.elements.content.removeAttribute("aria-busy");
      this.setStatus("Parsed nested JSON ready");
      this.renderMetadata();
      this.renderPaging();
      return true;
    } catch (error) {
      if (!this.isCurrent(generation, target)) return false;
      if (propagateFailure) {
        this.nestedBusy = false;
        throw error;
      }
      this.nestedBusy = false;
      this.handleFailure(error);
      return false;
    }
  }

  private async openHtml(target: ContentTarget, generation: number): Promise<void> {
    this.renderMode = "html";
    this.codeLanguageHint = null;
    this.semanticLimit = null;
    this.semanticLimitBytes = null;
    this.setStatus("Loading isolated HTML Preview…");
    this.renderPaging();
    try {
      const value = await this.invokeRequest<unknown>("get_html_preview", {
        nodeId: target.nodeId,
        scopeId: target.scopeId,
        sessionRevision: target.revision
      });
      if (!this.isCurrent(generation, target)) return;
      const preview = validateHtmlPreview(value);
      if (!preview) {
        this.htmlPreviewUnavailable = true;
        await this.openHtmlSource(target, generation, HTML_RENDER_FAILURE_NOTE);
        return;
      }
      if (preview.reason === "sizeLimit") {
        this.htmlPreviewUnavailable = true;
        await this.openHtmlSource(target, generation, HTML_SIZE_LIMIT_NOTE);
        return;
      }
      if (preview.reason === "renderLimit") {
        this.htmlPreviewUnavailable = true;
        await this.openHtmlSource(target, generation, HTML_RENDER_FAILURE_NOTE);
        return;
      }
      if (!this.htmlElements || preview.html === null) {
        await this.openHtmlSource(target, generation, HTML_RENDER_FAILURE_NOTE);
        return;
      }
      this.htmlPreview = preview.html;
      this.htmlPreviewUnavailable = false;
      this.htmlNote = HTML_PREVIEW_NOTE;
      this.htmlRepresentation = "preview";
      this.busy = false;
      this.setHtmlVisible(true);
      this.elements.dialog.removeAttribute("aria-busy");
      this.elements.content.removeAttribute("aria-busy");
      this.setStatus("HTML Preview ready");
      this.renderMetadata();
      this.renderPaging();
      this.writeHtmlPreview(preview.html, generation, target);
    } catch (error) {
      if (!this.isCurrent(generation, target)) return;
      const code = errorCode(error);
      if (code === "file_changed" || code === "stale_session") {
        this.handleFailure(error);
        return;
      }
      this.htmlPreviewUnavailable = true;
      await this.openHtmlSource(target, generation, HTML_RENDER_FAILURE_NOTE);
    }
  }

  private async openHtmlSource(target: ContentTarget, generation: number, note: string): Promise<void> {
    if (!this.isCurrent(generation, target)) return;
    const intent = ++this.sourceRevealEpoch;
    this.contentReadBusy = true;
    this.htmlRepresentation = "source";
    this.htmlNote = note;
    this.setHtmlVisible(true);
    this.busy = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.setStatus("Loading HTML Source…");
    this.renderMetadata();
    this.renderPaging();
    const cached = this.decodedPages.get(0);
    if (cached) {
      this.installChunk(cached, true);
      return;
    }
    try {
      const value = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset: 0,
        length: TEXT_CHUNK_BYTES,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isReadCurrent(generation, target, intent) || this.htmlRepresentation !== "source") return;
      const chunk = validateChunk(value, 0, rawSpanLength(target));
      if (!chunk) throw new Error("The decoded text response was invalid.");
      this.installChunk(chunk, true);
    } catch (error) {
      if (!this.isReadCurrent(generation, target, intent)) return;
      this.handleFailure(error);
    }
  }

  private activateHtmlRepresentation(representation: "preview" | "source" | "raw", preserveSearch = false): void {
    if (this.renderMode !== "html" || this.busy) return;
    if (!preserveSearch) this.sourceRevealEpoch += 1;
    if (representation === "preview") {
      if (this.htmlPreviewUnavailable || this.htmlPreview === null || !this.htmlElements) return;
      this.htmlRepresentation = "preview";
      this.htmlNote = HTML_PREVIEW_NOTE;
      this.elements.range.textContent = "—";
      this.setHtmlVisible(true);
      this.setStatus("HTML Preview ready");
      this.renderMetadata();
      this.renderPaging();
      this.writeHtmlPreview(this.htmlPreview, this.generation, this.target);
      if (!preserveSearch) this.sourceSearch?.invalidate();
      return;
    }
    if (representation === "raw") {
      this.htmlRepresentation = "raw";
      this.htmlNote = "";
      this.clearDecodedPages();
      this.setHtmlVisible(true);
      this.syncSourceSearch();
      if (!preserveSearch) this.sourceSearch?.invalidate();
      void this.readRawPage("initial");
      return;
    }
    this.htmlRepresentation = "source";
    this.htmlNote = "";
    this.setHtmlVisible(true);
    this.syncSourceSearch();
    if (!preserveSearch) this.sourceSearch?.invalidate();
    this.renderMetadata();
    this.renderPaging();
    const current = this.decodedPages.get(this.offsets[this.offsetIndex] ?? 0);
    if (current) {
      this.installChunk(current);
      return;
    }
    const target = this.target;
    if (target) void this.openHtmlSource(target, this.generation, "");
  }

  private handleHtmlTabKeydown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || !this.htmlElements) return;
    const tabs = [this.htmlElements.previewTab, this.htmlElements.sourceTab, ...(this.htmlElements.rawTab ? [this.htmlElements.rawTab] : [])];
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      tabs[(current + direction + tabs.length) % tabs.length].focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? tabs[0] : tabs.at(-1))?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.activateHtmlRepresentation(current === 0 ? "preview" : current === 1 ? "source" : "raw");
    }
  }

  private writeHtmlPreview(html: string, generation: number, target: ContentTarget | null): void {
    if (!this.htmlElements || !target || this.renderMode !== "html" || this.htmlRepresentation !== "preview") return;
    if (generation !== this.generation || this.target?.nodeId !== target.nodeId || this.target.scopeId !== target.scopeId
      || this.target.revision !== target.revision) return;
    this.htmlElements.previewFrame.srcdoc = htmlPreviewDocument(html);
  }

  private async openNestedChild(target: ContentTarget): Promise<void> {
    const parent = this.nestedFrames.at(-1);
    const tree = this.nestedTree;
    if (!parent || !tree || target.scopeId !== parent.scope.scopeId) return;
    if (this.nestedBusy && !(this.nestedRepresentation === "parsed" && this.contentReadBusy)) return;
    this.clearParsedSearchPeek();
    this.sourceRevealEpoch += 1;
    this.contentReadBusy = false;
    this.nestedBusy = false;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    const generation = ++this.generation;
    this.invalidateCopy();
    const parentSnapshot = tree.snapshot();
    this.nestedBusy = true;
    this.syncRenderAsSelect();
    this.elements.range.textContent = "—";
    this.setStatus("Detecting nested string…");
    this.renderPaging();
    let pushedFrame: NestedFrame | null = null;
    try {
      const detectionValue = await this.invokeRequest<unknown>("get_string_detection", {
        nodeId: target.nodeId,
        scopeId: parent.scope.scopeId,
        sessionRevision: parent.scope.sessionRevision
      });
      if (generation !== this.generation || this.nestedFrames.at(-1) !== parent) {
        return;
      }
      const source = cloneTarget({
        ...target,
        scopeLabel: parent.source.scopeLabel,
        pathSegments: [...parent.source.pathSegments, ...target.pathSegments.slice(1)]
      });
      const detection = validateDetection(detectionValue);
      if (!detection) throw new Error("The string detection response was invalid.");
      const selection = this.overrides.get(renderOverrideKey(source)) ?? "auto";
      if (selection === "nestedJson" || selection === "auto" && detection.semanticType === "nestedJson") {
        pushedFrame = await this.openNestedJsonFrame(source, parent, parentSnapshot, generation, detection, selection);
      } else {
        pushedFrame = {
          scope: parent.scope,
          source,
          parentSnapshot,
          decoded: newTextState(),
          raw: newTextState(),
          kind: "string",
          detection,
          renderOverride: selection
        };
        this.nestedFrames.push(pushedFrame);
        this.target = source;
        this.detection = detection;
        this.renderOverride = selection;
        this.nestedRepresentation = null;
        this.setNestedVisible(true);
        this.prepareRendererLoad(true);
        await this.renderSelection(source, generation, selection);
        if (!this.isCurrent(generation, source)) return;
        this.nestedBusy = false;
        this.setNestedVisible(true);
        this.renderNestedBreadcrumb();
        this.renderMetadata();
        this.renderPaging();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (errorCode(error) === "file_changed" || errorCode(error) === "stale_session") {
        this.nestedBusy = false;
        this.handleFailure(error);
        return;
      }
      if (pushedFrame && this.nestedFrames.at(-1) === pushedFrame) {
        this.discardNestedFrame(pushedFrame);
        this.nestedFrames.pop();
        await this.restoreNestedParent(parent, parentSnapshot, generation);
      } else {
        this.nestedBusy = false;
      }
      this.renderMetadata();
      this.elements.alert.hidden = false;
      this.elements.alert.textContent = `Content could not be opened: ${errorMessage(error)}`;
      this.setStatus(this.nestedRepresentation === "decoded"
        ? "Decoded nested string ready"
        : this.nestedRepresentation === "raw" ? "Raw nested lexeme ready" : "Parsed nested JSON ready");
      this.renderPaging();
    }
  }

  private async openNestedJsonFrame(
    source: ContentTarget,
    parent: NestedFrame,
    parentSnapshot: TreeViewSnapshot | null,
    generation: number,
    detection: StringDetection,
    selection: RenderAs
  ): Promise<NestedFrame> {
    this.setStatus("Loading parsed nested JSON…");
    const value = await this.invokeRequest<unknown>("open_nested_json", {
      parentScopeId: parent.scope.scopeId,
      nodeId: source.nodeId,
      maxDepth: null,
      sessionRevision: parent.scope.sessionRevision
    });
    if (generation !== this.generation || this.nestedFrames.at(-1) !== parent) {
      this.bestEffortCloseScope(value, parent.scope.sessionRevision);
      throw new Error("The nested JSON request became stale.");
    }
    const scope = validateNestedScope(value, source, parent.scope);
    if (!scope) {
      this.bestEffortCloseScope(value, parent.scope.sessionRevision);
      throw new Error("The nested JSON scope response was invalid.");
    }
    this.cleanupParsedPresentation();
    const frame: NestedFrame = {
      scope,
      source,
      parentSnapshot,
      decoded: newTextState(),
      raw: newTextState(),
      kind: "json",
      detection,
      renderOverride: selection
    };
    this.nestedFrames.push(frame);
    this.target = source;
    this.detection = detection;
    this.renderOverride = selection;
    this.renderMode = "nestedJson";
    this.nestedRepresentation = "parsed";
    this.nestedBusy = false;
    this.busy = false;
    this.nestedTree?.setSession({
      mode: "nested",
      sessionRevision: scope.sessionRevision,
      scopeId: scope.scopeId,
      sourceSize: scope.parsedBytes,
      ariaLabel: "Parsed nested JSON structure",
      scopeLabel: source.scopeLabel
    }, scope.root);
    this.renderNestedBreadcrumb();
    this.setNestedVisible(true);
    this.setStatus("Parsed nested JSON ready");
    this.renderMetadata();
    this.renderPaging();
    focusNestedRoot(this.nestedElements?.parsedTree ?? null);
    return frame;
  }

  private async backNested(): Promise<void> {
    const frame = this.nestedFrames.at(-1);
    if (!frame) return;
    if (this.nestedBusy && !(this.nestedRepresentation === "parsed" && this.contentReadBusy)) return;
    const generation = ++this.generation;
    this.clearParsedSearchPeek();
    this.sourceRevealEpoch += 1;
    this.contentReadBusy = false;
    this.nestedBusy = false;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.invalidateCopy();
    this.nestedBusy = true;
    this.syncRenderAsSelect();
    this.elements.range.textContent = "—";
    this.setStatus(frame.kind === "json" ? "Closing nested JSON…" : "Returning to parent…");
    this.renderPaging();
    if (frame.kind === "string") {
      this.discardNestedFrame(frame);
      this.nestedFrames.pop();
      const parent = this.nestedFrames.at(-1);
      if (!parent) {
        this.nestedBusy = false;
        this.close();
        return;
      }
      await this.restoreNestedParent(parent, frame.parentSnapshot, generation);
      this.nestedBusy = false;
      this.elements.alert.hidden = true;
      this.renderMetadata();
      this.renderPaging();
      focusNestedBackOrParsed(this.nestedElements, this.nestedFrames.length);
      return;
    }
    try {
      await this.closeScope(frame.scope.scopeId, frame.scope.sessionRevision);
      if (generation !== this.generation) return;
      this.elements.alert.hidden = true;
      this.discardNestedFrame(frame);
      this.nestedFrames.pop();
      this.nestedBusy = false;
      if (this.nestedFrames.length === 0) {
        this.nestedRepresentation = null;
        this.nestedTree?.clear();
        this.setNestedVisible(false);
        this.close();
        return;
      }
      const parent = this.nestedFrames.at(-1);
      if (!parent) return;
      await this.restoreNestedParent(parent, frame.parentSnapshot, generation);
      this.nestedBusy = false;
      this.elements.alert.hidden = true;
      this.renderMetadata();
      this.renderPaging();
      focusNestedBackOrParsed(this.nestedElements, this.nestedFrames.length);
    } catch (error) {
      if (generation !== this.generation) return;
      if (errorCode(error) === "not_found") {
        this.discardNestedFrame(frame);
        this.nestedFrames.pop();
        this.nestedBusy = false;
        if (this.nestedFrames.length === 0) this.close();
        else {
          await this.restoreNestedParent(this.nestedFrames.at(-1)!, frame.parentSnapshot, generation);
        }
        return;
      }
      this.nestedBusy = false;
      this.handleFailure(error);
    }
  }

  private async restoreNestedParent(parent: NestedFrame, snapshot: TreeViewSnapshot | null, generation: number): Promise<void> {
    this.target = cloneTarget(parent.source);
    this.detection = parent.detection;
    this.renderOverride = parent.renderOverride;
    this.nestedRepresentation = parent.kind === "json" ? "parsed" : null;
    if (parent.kind === "json") {
      this.renderMode = "nestedJson";
      this.busy = false;
      this.cleanupParsedPresentation();
      this.nestedTree?.restore(snapshot);
      if (!snapshot) this.setNestedTreeSession(parent);
      this.setNestedVisible(true);
      this.setStatus("Parsed nested JSON ready");
      return;
    }
    this.prepareRendererLoad(true);
    await this.renderSelection(parent.source, generation, parent.renderOverride);
    if (!this.isCurrent(generation, parent.source)) return;
    this.nestedBusy = false;
    this.setNestedVisible(true);
    this.renderNestedBreadcrumb();
  }

  private activateNestedRepresentation(representation: "parsed" | "decoded" | "raw"): void {
    if (!this.nestedFrames.length || this.nestedFrames.at(-1)?.kind !== "json") return;
    if (this.nestedBusy && !(this.nestedRepresentation === "parsed" && this.contentReadBusy)) return;
    this.clearParsedSearchPeek();
    this.sourceRevealEpoch += 1;
    this.contentReadBusy = false;
    this.nestedBusy = false;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.sourceSearch?.invalidate();
    this.nestedRepresentation = representation;
    this.setNestedVisible(true);
    this.renderMetadata();
    this.renderPaging();
    if (representation === "parsed") {
      this.setStatus("Parsed nested JSON ready");
    } else {
      const frame = this.nestedFrames.at(-1);
      const state = frame ? textState(frame, representation) : null;
      if (state?.current) this.installNestedChunk(frame!, representation, state.current);
      else void this.readNestedPage("initial");
    }
  }

  private handleNestedTabKeydown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || !this.nestedElements) return;
    const tabs = [this.nestedElements.parsedTab, this.nestedElements.decodedTab, this.nestedElements.rawTab];
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      tabs[(current + direction + tabs.length) % tabs.length].focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? tabs[0] : tabs.at(-1))?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.activateNestedRepresentation(current === 0 ? "parsed" : current === 1 ? "decoded" : "raw");
    }
  }

  private async readNestedPage(direction: "initial" | "next" | "previous"): Promise<void> {
    const frame = this.nestedFrames.at(-1);
    const representation = this.nestedRepresentation;
    if (!frame || (representation !== "decoded" && representation !== "raw") || this.nestedBusy) return;
    const state = textState(frame, representation);
    const intent = ++this.sourceRevealEpoch;
    let offset: number;
    if (direction === "initial") offset = state.offsets[state.offsetIndex] ?? 0;
    else if (direction === "next") {
      if (state.nextOffset === null) return;
      offset = state.nextOffset;
    } else {
      if (state.offsetIndex <= 0) return;
      offset = state.offsets[state.offsetIndex - 1];
    }
    const cached = state.pages.get(offset);
    if (cached) {
      if (direction === "next") {
        state.offsets = state.offsets.slice(0, state.offsetIndex + 1);
        state.offsets.push(offset);
        state.offsetIndex += 1;
      } else if (direction === "previous") state.offsetIndex -= 1;
      this.installNestedChunk(frame, representation, cached);
      return;
    }
    const generation = this.generation;
    this.contentReadBusy = true;
    this.nestedBusy = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.renderNestedRange();
    this.setStatus(representation === "decoded" ? "Loading decoded nested string…" : "Loading raw nested lexeme…");
    this.renderMetadata();
    this.renderPaging();
    try {
      const boundary = representation === "decoded" ? frame.scope.parsedBytes : rawSpanLength(frame.source);
      const rawStart = frame.source.spanStart + offset;
      const requestLength = representation === "raw"
        ? Math.min(TEXT_CHUNK_BYTES, frame.source.spanEnd - rawStart)
        : TEXT_CHUNK_BYTES;
      const value = await this.invokeRequest<unknown>(representation === "decoded" ? "read_decoded_text" : "read_raw_slice", representation === "decoded"
        ? { nodeId: frame.source.nodeId, offset, length: TEXT_CHUNK_BYTES, sessionRevision: frame.scope.sessionRevision, scopeId: frame.source.scopeId }
        : { sourceStart: rawStart, length: requestLength, sessionRevision: frame.scope.sessionRevision, scopeId: frame.source.scopeId });
      if (!this.isReadCurrent(generation, frame.source, intent) || this.nestedFrames.at(-1) !== frame || this.nestedRepresentation !== representation) return;
      const chunk = representation === "raw"
        ? normalizeRawChunk(value, rawStart, frame.source.spanStart, frame.source.spanEnd, requestLength)
        : validateChunk(value, offset, boundary, undefined, true);
      if (!chunk) throw new Error("The nested text response was invalid.");
      if (direction === "next") {
        state.offsets = state.offsets.slice(0, state.offsetIndex + 1);
        state.offsets.push(chunk.start);
        state.offsetIndex += 1;
      } else if (direction === "previous") state.offsetIndex -= 1;
      state.current = chunk;
      this.installNestedChunk(frame, representation, chunk);
    } catch (error) {
      if (!this.isReadCurrent(generation, frame.source, intent)) return;
      this.contentReadBusy = false;
      this.nestedBusy = false;
      this.elements.alert.hidden = false;
      this.elements.alert.textContent = `Content could not be opened: ${errorMessage(error)}`;
      if (errorCode(error) === "file_changed" || errorCode(error) === "stale_session") {
        this.handleFailure(error);
      } else {
        this.elements.dialog.removeAttribute("aria-busy");
        this.elements.content.removeAttribute("aria-busy");
        this.setStatus("Unable to load nested text");
        this.renderMetadata();
        this.renderPaging();
      }
    }
  }

  private installNestedChunk(frame: NestedFrame, representation: "decoded" | "raw", chunk: TextChunk): void {
    const state = textState(frame, representation);
    state.current = chunk;
    this.cacheNestedPage(frame, representation, chunk);
    state.nextOffset = chunk.nextOffset;
    this.contentReadBusy = false;
    this.nestedBusy = false;
    this.elements.content.classList.remove("is-markdown");
    this.elements.content.textContent = chunk.text;
    this.setStatus(representation === "decoded" ? "Decoded nested string ready" : "Raw nested lexeme ready");
    this.elements.alert.hidden = true;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.renderMetadata();
    this.renderPaging();
  }

  private activateOrdinaryRepresentation(representation: "rendered" | "decoded" | "raw", preserveSearch = false): void {
    if (!this.target || this.nestedRepresentation !== null || this.busy || this.renderMode === "html") return;
    this.ordinaryRepresentation = representation;
    if (!preserveSearch) this.sourceRevealEpoch += 1;
    if (representation === "raw") {
      this.clearDecodedPages();
      this.setStringVisible(true);
      this.syncSourceSearch();
      if (!preserveSearch) this.sourceSearch?.invalidate();
      void this.readRawPage("initial");
      return;
    }
    this.clearRawPages();
    this.setStringVisible(true);
    this.syncSourceSearch();
    if (!preserveSearch) this.sourceSearch?.invalidate();
    if (representation === "rendered") {
      const target = this.target;
      const override = this.renderOverride;
      const generation = ++this.generation;
      this.prepareRendererLoad(false);
      void this.renderSelection(target, generation, override).catch((error) => {
        if (this.isCurrent(generation, target)) this.handleFailure(error);
      });
      return;
    }
    const cached = this.decodedPages.get(this.offsets[this.offsetIndex] ?? 0);
    if (cached) {
      this.installChunk(cached);
      return;
    }
    void this.readPage(this.offsets[this.offsetIndex] ?? 0, "initial");
  }

  private handleStringTabKeydown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || !this.stringElements) return;
    const tabs = [this.stringElements.renderedTab, this.stringElements.decodedTab, this.stringElements.rawTab];
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      tabs[(current + direction + tabs.length) % tabs.length].focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? tabs[0] : tabs.at(-1))?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.activateOrdinaryRepresentation(current === 0 ? "rendered" : current === 1 ? "decoded" : "raw");
    }
  }

  private setStringVisible(active: boolean): void {
    const elements = this.stringElements;
    if (!elements) return;
    const visible = active && this.renderMode !== "html" && this.nestedRepresentation === null;
    elements.representations.hidden = !visible;
    const tabs = [elements.renderedTab, elements.decodedTab, elements.rawTab];
    const activeTab = this.ordinaryRepresentation === "raw" ? elements.rawTab
      : this.ordinaryRepresentation === "decoded" ? elements.decodedTab : elements.renderedTab;
    for (const tab of tabs) {
      const selected = visible && tab === activeTab;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
  }

  private syncSourceSearch(): void {
    const search = this.sourceSearch;
    if (!search) return;
    const target = this.searchTarget();
    if (!target || !this.detection) {
      search.clear();
      this.renderedSearch?.clear();
      return;
    }
    const frame = this.nestedFrames.at(-1);
    const parsed = frame?.kind === "json" && this.nestedRepresentation === "parsed";
    const representation = parsed ? "decoded" : this.currentSearchRepresentation();
    const preview = this.renderMode === "html" && this.htmlRepresentation === "preview";
    const available = parsed || representation !== null;
    const scopeStart = parsed ? frame.scope.root.spanStart : target.spanStart;
    const scopeEnd = parsed ? frame.scope.root.spanEnd : target.spanEnd;
    const sessionRevision = parsed ? frame.scope.sessionRevision : target.revision;
    const scopeId = parsed ? frame.scope.scopeId : target.scopeId;
    const targetNodeId = parsed ? frame.scope.root.id : target.nodeId;
    search.setRawEnabled(!parsed);
    search.setScope({
      label: parsed ? "Parsed JSON" : "Content Viewer",
      description: parsed ? "Search parsed JSON keys and values." : preview || !available ? "Rendered search is unavailable; switch to a source tab." : representation === "rawSource" ? "Search the raw lexeme." : "Search the decoded source.",
      enabled: available && !this.busy && !this.nestedBusy,
      decodedEnabled: true,
      scopeStart,
      scopeEnd,
      sessionRevision,
      scopeId,
      targetNodeId
    });
    search.setRepresentation(parsed ? "decoded" : representation === "rawSource" ? "rawSource" : "decoded");
    this.syncRenderedSearch();
  }

  private searchTarget(): ContentTarget | null {
    const frame = this.nestedFrames.at(-1);
    if (frame) return frame.source;
    return this.target;
  }

  private currentSearchRepresentation(): "decoded" | "rawSource" | null {
    if (this.nestedRepresentation === "parsed") return null;
    if (this.renderMode === "html") {
      if (this.htmlRepresentation === "raw") return "rawSource";
      if (this.htmlRepresentation === "source") return "decoded";
      return null;
    }
    if (this.nestedRepresentation === "raw" || this.ordinaryRepresentation === "raw") return "rawSource";
    if (this.nestedRepresentation === "decoded" || this.ordinaryRepresentation === "decoded") return "decoded";
    return null;
  }

  private syncRenderedSearch(): void {
    const rendered = this.renderedSearch;
    const target = this.target;
    if (!rendered || !target || !this.detection || this.nestedRepresentation !== null || this.renderMode === "html"
      || this.ordinaryRepresentation !== "rendered") {
      rendered?.clear();
      this.sourceSearch?.refresh();
      return;
    }
    const backend = this.renderMode === "plainText" || this.renderMode === "code" && this.semanticLimit === "code";
    const renderedTarget: RenderedSearchTarget = {
      nodeId: target.nodeId,
      scopeId: target.scopeId,
      sessionRevision: target.revision,
      scopeStart: target.spanStart,
      scopeEnd: target.spanEnd
    };
    if (backend) rendered.activate("backend", renderedTarget, null, "Search the visible rendered text.");
    else rendered.activateDom(renderedTarget, this.elements.content, "Search the visible rendered text.");
  }

  private activateContentSearchRepresentation(representation: "decoded" | "rawSource"): void {
    if (this.nestedFrames.at(-1)?.kind === "json") {
      this.activateNestedRepresentation(representation === "rawSource" ? "raw" : "decoded");
    } else if (this.renderMode === "html") {
      this.activateHtmlRepresentation(representation === "rawSource" ? "raw" : "source");
    } else {
      this.activateOrdinaryRepresentation(representation === "rawSource" ? "raw" : "decoded");
    }
  }

  private handleSearchError(error: unknown): void {
    if (isGlobalError(error)) this.handleFailure(error);
  }

  private handleDialogKeydown(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && this.sourceSearch) {
      event.preventDefault();
      event.stopPropagation();
      if (this.renderedSearch?.active) this.renderedSearch.focusQuery();
      else this.sourceSearch.focusQuery();
      return;
    }
    if (event.key === "Escape" && (this.sourceSearch?.handleEscape(event) || this.renderedSearch?.handleEscape(event))) return;
  }

  private async revealSearchMatch(match: SearchMatch): Promise<void> {
    const search = this.sourceSearch;
    const target = this.searchTarget();
    if (!search || !target) return;
    this.clearParsedSearchPeek();
    const query = search.query;
    const searchEpoch = search.intentEpoch;
    const revealEpoch = ++this.sourceRevealEpoch;
    const generation = this.generation;
    const frame = this.nestedFrames.at(-1);
    const representation = match.field === "rawSource" ? "raw" : "decoded";
    this.contentReadBusy = true;
    if (frame?.kind === "json") this.nestedBusy = true;
    else this.busy = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.setStatus("Loading search match…");
    this.renderMetadata();
    this.renderPaging();
    try {
      if (frame?.kind === "json") {
        if (this.nestedRepresentation === "parsed") {
          await this.revealParsedSearchMatch(frame, match, query, revealEpoch, searchEpoch, generation);
          return;
        }
        this.nestedRepresentation = representation === "raw" ? "raw" : "decoded";
        this.setNestedVisible(true);
        this.renderPaging();
        await this.revealNestedSearch(frame, match, query, representation, revealEpoch, searchEpoch, generation);
        return;
      }
      if (this.renderMode === "html") {
        this.htmlRepresentation = representation === "raw" ? "raw" : "source";
        this.setHtmlVisible(true);
      } else {
        this.ordinaryRepresentation = representation;
        if (representation === "raw") this.clearDecodedPages();
        else this.clearRawPages();
        this.setStringVisible(true);
      }
      this.renderPaging();
      if (representation === "raw") await this.revealRawSearch(target, match, query, frame ? frame.scope.sessionRevision : target.revision, revealEpoch, searchEpoch, generation);
      else await this.revealDecodedSearch(target, match, query, target.revision, revealEpoch, searchEpoch, generation);
    } catch (error) {
      const parsedReveal = frame?.kind === "json" && this.nestedRepresentation === "parsed";
      if (parsedReveal
        ? !this.isParsedRevealCurrent(frame, generation, revealEpoch, searchEpoch, query)
        : !this.isRevealCurrent(generation, target, revealEpoch, searchEpoch, query, representation)) return;
      if (isGlobalError(error)) this.handleFailure(error);
      else {
        if (parsedReveal) this.clearParsedSearchPeek();
        this.contentReadBusy = false;
        this.busy = false;
        this.nestedBusy = false;
        this.elements.dialog.removeAttribute("aria-busy");
        this.elements.content.removeAttribute("aria-busy");
        this.elements.alert.hidden = false;
        this.elements.alert.textContent = `Search match could not be loaded: ${errorMessage(error)}`;
        this.setStatus("Unable to load search match");
        this.renderMetadata();
        this.renderPaging();
      }
    }
  }

  private async revealRenderedMatch(match: RenderedMatch): Promise<void> {
    if (match.kind !== "backend" || !match.backend || !this.target) return;
    const target = this.target;
    const backend = match.backend;
    const query = this.renderedSearch?.query ?? "";
    const intent = ++this.sourceRevealEpoch;
    const generation = this.generation;
    this.contentReadBusy = true;
    this.busy = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.setStatus("Loading rendered search match…");
    this.renderMetadata();
    this.renderPaging();
    try {
      const offset = backend.matchStart;
      const value = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset,
        length: TEXT_CHUNK_BYTES,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isCurrent(generation, target) || this.sourceRevealEpoch !== intent) return;
      const lineState = this.renderMode === "code" && this.semanticLimit === "code"
        ? await this.codeLineStateAt(target, offset, generation, intent)
        : this.codeLineCheckpoints.get(offset) ?? { line: 1, previousWasCR: false };
      if (!lineState) return;
      const chunk = validateChunk(value, offset, rawSpanLength(target), undefined, false, lineState);
      if (!chunk) throw new Error("The rendered search source response was invalid.");
      this.offsets = [chunk.start];
      this.offsetIndex = 0;
      this.nextOffset = chunk.nextOffset;
      this.cacheDecodedPage(chunk);
      if (this.renderMode === "code" && this.semanticLimit === "code") {
        const result = renderPlainCodePage(chunk.text, this.codeLanguageHint, this.codeLimitReason ?? "sizeLimit", chunk.lineState);
        this.elements.content.replaceChildren(result.fragment);
        this.codeRenderReason = result.reason;
      } else {
        this.elements.content.textContent = chunk.text;
      }
      this.representation = "rendered";
      this.ordinaryRepresentation = "rendered";
      this.rememberCodeChunk(chunk);
      this.elements.range.textContent = `[${chunk.start}, ${chunk.start + utf8ByteLength(chunk.text)})`;
      this.contentReadBusy = false;
      this.busy = false;
      this.elements.dialog.removeAttribute("aria-busy");
      this.elements.content.removeAttribute("aria-busy");
      this.setStatus("Rendered search match ready");
      this.elements.alert.hidden = true;
      this.renderMetadata();
      this.renderPaging();
      await this.renderedSearch?.reprojectDom(this.elements.content);
      if (!this.isCurrent(generation, target) || this.sourceRevealEpoch !== intent) return;
      const relative = backend.matchStart - chunk.start;
      this.renderedSearch?.highlightSourceRange(
        utf8ByteOffsetToUtf16(chunk.text, relative),
        utf8ByteOffsetToUtf16(chunk.text, relative + utf8ByteLength(query))
      );
    } catch (error) {
      if (!this.isCurrent(generation, target) || this.sourceRevealEpoch !== intent) return;
      if (isGlobalError(error)) this.handleFailure(error);
      else {
        this.contentReadBusy = false;
        this.busy = false;
        this.elements.dialog.removeAttribute("aria-busy");
        this.elements.content.removeAttribute("aria-busy");
        this.elements.alert.hidden = false;
        this.elements.alert.textContent = `Rendered search match could not be loaded: ${errorMessage(error)}`;
        this.setStatus("Unable to load rendered search match");
        this.renderMetadata();
        this.renderPaging();
      }
    }
  }

  private async codeLineStateAt(target: ContentTarget, offset: number, generation: number, intent: number): Promise<CodeLineState | null> {
    let checkpointOffset = 0;
    let lineState: CodeLineState = { line: 1, previousWasCR: false };
    for (const [candidateOffset, candidateState] of this.codeLineCheckpoints) {
      if (candidateOffset <= offset && candidateOffset >= checkpointOffset) {
        checkpointOffset = candidateOffset;
        lineState = candidateState;
      }
    }
    let cursor = checkpointOffset;
    while (cursor < offset) {
      if (!this.isCurrent(generation, target) || this.sourceRevealEpoch !== intent) return null;
      const length = Math.min(TEXT_CHUNK_BYTES, offset - cursor);
      const value = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset: cursor,
        length,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isCurrent(generation, target) || this.sourceRevealEpoch !== intent) return null;
      const chunk = validateChunk(value, cursor, rawSpanLength(target), undefined, false, lineState);
      if (!chunk || utf8ByteLength(chunk.text) > length) throw new Error("The code line checkpoint response was invalid.");
      const next = chunk.nextOffset;
      if (next === null || next <= cursor || next > offset) throw new Error("The code line checkpoint response was invalid.");
      lineState = scanCodeLines(chunk.text, lineState);
      cursor = next;
      this.codeLineCheckpoints.set(cursor, lineState);
    }
    return cursor === offset ? lineState : null;
  }

  private async revealNestedSearch(frame: NestedFrame, match: SearchMatch, query: string, representation: "decoded" | "raw", revealEpoch: number, searchEpoch: number, generation: number): Promise<void> {
    const target = frame.source;
    if (representation === "raw") {
      await this.revealRawSearch(target, match, query, frame.scope.sessionRevision, revealEpoch, searchEpoch, generation);
      return;
    }
    await this.revealDecodedSearch(target, match, query, frame.scope.sessionRevision, revealEpoch, searchEpoch, generation);
  }

  private async revealParsedSearchMatch(frame: NestedFrame, match: SearchMatch, query: string, revealEpoch: number, searchEpoch: number, generation: number): Promise<void> {
    const scope = frame.scope;
    const sourceStart = match.sourceSpanStart;
    const sourceEnd = match.sourceSpanEnd;
    const requestLength = Math.min(TEXT_CHUNK_BYTES, sourceEnd - sourceStart);
    if (match.field === "rawSource" || sourceStart >= sourceEnd || requestLength <= 0) throw new Error("The parsed search result is invalid.");
    const value = await this.invokeRequest<unknown>("read_raw_slice", {
      sourceStart,
      length: requestLength,
      sessionRevision: scope.sessionRevision,
      scopeId: scope.scopeId
    });
    if (!this.isParsedRevealCurrent(frame, generation, revealEpoch, searchEpoch, query)) return;
    const peek = validateParsedSearchPeek(value, sourceStart, sourceEnd, requestLength);
    if (!peek) throw new Error("The parsed search source response was invalid.");
    this.parsedSearchPeek = { match, sourceStart: peek.start, sourceEnd: peek.end, text: peek.text, truncated: peek.end < sourceEnd };
    this.parsedSearchPeekBytes = utf8ByteLength(peek.text);
    this.trimTextCaches();
    this.contentReadBusy = false;
    this.nestedBusy = false;
    this.elements.alert.hidden = true;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.renderParsedSearchPeek();
    this.setStatus("Parsed source match ready");
    this.renderMetadata();
    this.renderPaging();
  }

  private isParsedRevealCurrent(frame: NestedFrame, generation: number, revealEpoch: number, searchEpoch: number, query: string): boolean {
    return this.isCurrent(generation, frame.source)
      && this.nestedFrames.at(-1) === frame
      && frame.kind === "json"
      && this.nestedRepresentation === "parsed"
      && this.sourceRevealEpoch === revealEpoch
      && this.sourceSearch?.intentEpoch === searchEpoch
      && this.sourceSearch?.query === query
      && frame.scope.sessionRevision === frame.source.revision
      && frame.scope.sourceNodeId === frame.source.nodeId;
  }

  private renderParsedSearchPeek(): void {
    const elements = this.parsedSearchPeekElements;
    const peek = this.parsedSearchPeek;
    if (!elements) return;
    if (!peek) {
      elements.panel.hidden = true;
      return;
    }
    elements.panel.hidden = false;
    elements.field.textContent = peek.match.field === "key" ? "Key" : "Value";
    elements.node.textContent = peek.match.nodeId === null ? "—" : `#${peek.match.nodeId}`;
    elements.path.textContent = formatPath(peek.match.pathSegments, peek.match.pathTruncated);
    elements.sourceSpan.textContent = `[${peek.match.sourceSpanStart}, ${peek.match.sourceSpanEnd})`;
    elements.displayedRange.textContent = `[${peek.sourceStart}, ${peek.sourceEnd})`;
    elements.decodedRange.textContent = `[${peek.match.matchStart}, ${peek.match.matchEnd})`;
    elements.source.textContent = peek.text;
    elements.note.textContent = peek.truncated
      ? "Only the first 128 KiB of this source token is shown; the decoded match range identifies the field text and does not infer escaped source bytes."
      : "The shown source token identifies the field; the decoded match range does not infer escaped source bytes.";
  }

  private clearParsedSearchPeek(): void {
    this.parsedSearchPeek = null;
    this.parsedSearchPeekBytes = 0;
    const elements = this.parsedSearchPeekElements;
    if (elements) {
      elements.field.textContent = "—";
      elements.node.textContent = "—";
      elements.path.textContent = "—";
      elements.sourceSpan.textContent = "—";
      elements.displayedRange.textContent = "—";
      elements.decodedRange.textContent = "—";
      elements.source.textContent = "";
      elements.note.textContent = "";
    }
    this.renderParsedSearchPeek();
    this.trimTextCaches();
  }

  private async revealDecodedSearch(target: ContentTarget, match: SearchMatch, query: string, sessionRevision = target.revision, revealEpoch = this.sourceRevealEpoch, searchEpoch = this.sourceSearch?.intentEpoch ?? 0, generation = this.generation): Promise<void> {
    const value = await this.invokeRequest<unknown>("read_decoded_text", {
      nodeId: target.nodeId,
      offset: match.matchStart,
      length: TEXT_CHUNK_BYTES,
      sessionRevision,
      scopeId: target.scopeId
    });
    if (!this.isRevealCurrent(generation, target, revealEpoch, searchEpoch, query, "decoded")) return;
    const chunk = validateChunk(value, match.matchStart, rawSpanLength(target));
    if (!chunk) throw new Error("The decoded search result could not be loaded.");
    this.installSearchChunk(chunk, query, match.matchStart, false, "decoded");
  }

  private async revealRawSearch(target: ContentTarget, match: SearchMatch, query: string, sessionRevision: number, revealEpoch = this.sourceRevealEpoch, searchEpoch = this.sourceSearch?.intentEpoch ?? 0, generation = this.generation): Promise<void> {
    const relativeStart = match.matchStart - target.spanStart;
    const sourceStart = target.spanStart + relativeStart;
    const sourceEnd = target.spanEnd;
    const requestLength = Math.min(TEXT_CHUNK_BYTES, sourceEnd - sourceStart);
    if (relativeStart < 0 || sourceStart >= sourceEnd) return;
    const value = await this.invokeRequest<unknown>("read_raw_slice", {
      sourceStart,
      length: requestLength,
      sessionRevision,
      scopeId: target.scopeId
    });
    if (!this.isRevealCurrent(generation, target, revealEpoch, searchEpoch, query, "raw")) return;
    const chunk = normalizeRawChunk(value, sourceStart, target.spanStart, sourceEnd, requestLength);
    if (!chunk) throw new Error("The raw search result could not be loaded.");
    this.installSearchChunk(chunk, query, relativeStart, true, "raw");
  }

  private installSearchChunk(chunk: TextChunk, query: string, matchStart: number, raw = false, representation: "decoded" | "raw" = raw ? "raw" : "decoded"): void {
    this.contentReadBusy = false;
    this.nestedBusy = false;
    this.busy = false;
    this.elements.content.classList.remove("is-markdown");
    const queryBytes = utf8ByteLength(query);
    const relative = Math.max(0, matchStart - chunk.start);
    const start = utf8ByteOffsetToUtf16(chunk.text, relative);
    const end = utf8ByteOffsetToUtf16(chunk.text, relative + queryBytes);
    const before = chunk.text.slice(0, start);
    const marked = chunk.text.slice(start, end);
    const after = chunk.text.slice(end);
    const fragment = document.createDocumentFragment();
    if (before) fragment.append(document.createTextNode(before));
    const mark = document.createElement("mark");
    mark.textContent = marked;
    mark.dataset.searchMatch = "true";
    fragment.append(mark);
    if (after) fragment.append(document.createTextNode(after));
    this.elements.content.replaceChildren(fragment);
    this.representation = "decoded";
    const frame = this.nestedFrames.at(-1);
    if (frame && this.nestedRepresentation === representation) {
      const state = textState(frame, representation);
      this.clearNestedPageCache(state);
      state.offsets = [chunk.start];
      state.offsetIndex = 0;
      state.nextOffset = chunk.nextOffset;
      state.current = chunk;
      this.cacheNestedPage(frame, representation, chunk);
    } else if (representation === "raw") {
      this.rawPageOffsets = [chunk.start];
      this.rawPageIndex = 0;
      this.rawNextOffset = chunk.nextOffset;
      this.cacheRawPage(chunk);
    } else {
      this.offsets = [chunk.start];
      this.offsetIndex = 0;
      this.nextOffset = chunk.nextOffset;
      this.cacheDecodedPage(chunk);
    }
    const target = this.searchTarget();
    const rangeStart = raw && target ? target.spanStart + chunk.start : chunk.start;
    this.elements.range.textContent = `[${rangeStart}, ${rangeStart + utf8ByteLength(chunk.text)})`;
    this.setStatus("Search match ready");
    this.elements.alert.hidden = true;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.renderMetadata();
    this.renderPaging();
  }

  private isRevealCurrent(generation: number, target: ContentTarget, revealEpoch: number, searchEpoch: number, query: string, representation: "decoded" | "raw"): boolean {
    if (!this.isCurrent(generation, target) || this.sourceRevealEpoch !== revealEpoch || this.sourceSearch?.intentEpoch !== searchEpoch || this.sourceSearch?.query !== query) return false;
    if (this.nestedRepresentation !== null) return this.nestedRepresentation === representation;
    if (this.renderMode === "html") return representation === "raw" ? this.htmlRepresentation === "raw" : this.htmlRepresentation === "source";
    return this.ordinaryRepresentation === representation;
  }

  private setNestedVisible(active: boolean): void {
    const nested = this.nestedElements;
    if (!nested) return;
    const frame = this.nestedFrames.at(-1);
    const parsedFrame = frame?.kind === "json";
    nested.navigation.hidden = !active;
    nested.representations.hidden = !active || !parsedFrame || this.nestedRepresentation === null;
    nested.back.hidden = !active || this.nestedFrames.length <= 1;
    nested.back.setAttribute("aria-controls", "content-viewer-parsed-panel");
    nested.parsedPanel.hidden = !active || !parsedFrame || this.nestedRepresentation !== "parsed";
    nested.sharedTextPanel.hidden = (active && this.nestedRepresentation === "parsed")
      || this.htmlRepresentation === "preview";
    if (active) {
      const tabs = [nested.parsedTab, nested.decodedTab, nested.rawTab];
      const activeTab = this.nestedRepresentation === "parsed" ? nested.parsedTab : this.nestedRepresentation === "decoded" ? nested.decodedTab : nested.rawTab;
      for (const tab of tabs) {
        const selected = tab === activeTab;
        tab.classList.toggle("is-active", selected);
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      this.renderNestedBreadcrumb();
    }
    this.setSharedTextPanelSemantics();
    this.renderNestedRange();
  }

  private renderNestedBreadcrumb(): void {
    const nested = this.nestedElements;
    if (!nested) return;
    nested.breadcrumb.replaceChildren();
    for (const [index, frame] of this.nestedFrames.entries()) {
      const item = document.createElement("li");
      const label = index === 0 ? formatPath(frame.source.pathSegments, frame.source.pathTruncated) : `Level ${frame.scope.depth}`;
      item.textContent = label;
      if (index === this.nestedFrames.length - 1) item.setAttribute("aria-current", "page");
      nested.breadcrumb.append(item);
    }
  }

  private setNestedTreeSession(frame: NestedFrame): void {
    this.nestedTree?.setSession({
      mode: "nested",
      sessionRevision: frame.scope.sessionRevision,
      scopeId: frame.scope.scopeId,
      sourceSize: frame.scope.parsedBytes,
      ariaLabel: "Parsed nested JSON structure",
      scopeLabel: frame.source.scopeLabel
    }, frame.scope.root);
  }

  private setSharedTextPanelSemantics(): void {
    const nested = this.nestedElements;
    const html = this.htmlElements;
    if (!nested && !html) return;
    if (html && this.renderMode === "html" && (this.htmlRepresentation === "source" || this.htmlRepresentation === "raw")) {
      this.elements.content.setAttribute("aria-label", this.htmlRepresentation === "source" ? "Decoded Source" : "Raw Lexeme");
      if (nested) {
        nested.sharedTextPanel.setAttribute("role", "tabpanel");
        nested.sharedTextPanel.setAttribute("aria-labelledby", html.sourceTab.id);
        nested.sharedTextPanel.removeAttribute("aria-label");
      }
      return;
    }
    const nestedText = this.nestedRepresentation === "decoded" || this.nestedRepresentation === "raw";
    const tab = nested && this.nestedRepresentation === "decoded" ? nested.decodedTab
      : nested && this.nestedRepresentation === "raw" ? nested.rawTab : null;
    if (nested && nestedText && tab) {
      nested.sharedTextPanel.setAttribute("role", "tabpanel");
      nested.sharedTextPanel.setAttribute("aria-labelledby", tab.id);
      nested.sharedTextPanel.removeAttribute("aria-label");
      this.elements.content.setAttribute("aria-label", this.nestedRepresentation === "decoded" ? "Decoded String" : "Raw Lexeme");
    } else if (nested) {
      nested.sharedTextPanel.setAttribute("role", "region");
      nested.sharedTextPanel.removeAttribute("aria-labelledby");
      nested.sharedTextPanel.setAttribute("aria-label", "Decoded source");
      this.elements.content.setAttribute("aria-label", "Decoded source");
    }
  }

  private setHtmlVisible(active: boolean): void {
    const html = this.htmlElements;
    if (!html) return;
    const visible = active && this.renderMode === "html" && this.htmlRepresentation !== null;
    html.representations.hidden = !visible;
    html.previewPanel.hidden = !visible || this.htmlRepresentation !== "preview";
    html.previewTab.disabled = !visible || this.htmlPreviewUnavailable || this.htmlPreview === null;
    html.sourceTab.disabled = !visible;
    const tabs = [html.previewTab, html.sourceTab, ...(html.rawTab ? [html.rawTab] : [])];
    const activeTab = this.htmlRepresentation === "preview" ? html.previewTab
      : this.htmlRepresentation === "raw" ? html.rawTab : html.sourceTab;
    for (const tab of tabs) {
      const selected = visible && tab === activeTab;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (this.nestedElements) {
      this.nestedElements.sharedTextPanel.hidden = (this.nestedRepresentation === "parsed")
        || (visible && this.htmlRepresentation === "preview");
    }
    this.setSharedTextPanelSemantics();
  }

  private clearHtmlPreviewFrame(): void {
    if (this.htmlElements) this.htmlElements.previewFrame.srcdoc = "";
  }

  private cleanupParsedPresentation(): void {
    this.htmlRepresentation = null;
    this.htmlPreview = null;
    this.htmlPreviewUnavailable = false;
    this.htmlNote = "";
    this.clearHtmlPreviewFrame();
    this.setHtmlVisible(false);
  }

  private cacheDecodedPage(chunk: TextChunk): void {
    const previous = this.decodedPages.get(chunk.start);
    if (previous) {
      this.decodedPageCacheBytes -= utf8ByteLength(previous.text);
      this.decodedPages.delete(chunk.start);
    }
    this.decodedPages.set(chunk.start, chunk);
    this.decodedPageCacheBytes += utf8ByteLength(chunk.text);
    this.trimTextCaches();
  }

  private rememberCodeChunk(chunk: TextChunk): void {
    if (this.renderMode !== "code") return;
    this.codeLineCheckpoints.set(chunk.start, chunk.lineState);
    if (chunk.nextOffset !== null) {
      this.codeLineCheckpoints.set(chunk.nextOffset, scanCodeLines(chunk.text, chunk.lineState));
    }
  }

  private clearDecodedPages(): void {
    this.decodedPages.clear();
    this.decodedPageCacheBytes = 0;
  }

  private clearRawPages(): void {
    this.rawPages.clear();
    this.rawPageOffsets = [];
    this.rawPageIndex = -1;
    this.rawNextOffset = null;
    this.rawCacheBytes = 0;
  }

  private clearCodeLineCheckpoints(): void {
    this.codeLineCheckpoints.clear();
    this.codeLineCheckpoints.set(0, { line: 1, previousWasCR: false });
  }

  private renderNestedRange(): void {
    const frame = this.nestedFrames.at(-1);
    const representation = this.nestedRepresentation;
    if (!frame || representation === null) return;
    if (representation === "parsed") {
      this.elements.range.textContent = `Parsed bytes [0, ${frame.scope.parsedBytes}) · depth ${frame.scope.depth}/${frame.scope.maxDepth}`;
      return;
    }
    const state = textState(frame, representation);
    const chunk = state.current;
    if (!chunk || this.nestedBusy) {
      this.elements.range.textContent = representation === "decoded"
        ? `Decoded bytes [0, 0) of [0, ${frame.scope.parsedBytes})`
        : `Parent scope bytes [${frame.source.spanStart}, ${frame.source.spanStart}) of [${frame.source.spanStart}, ${frame.source.spanEnd})`;
      return;
    }
    const end = chunk.start + utf8ByteLength(chunk.text);
    if (representation === "decoded") {
      this.elements.range.textContent = `Decoded bytes [${chunk.start}, ${end}) of [0, ${frame.scope.parsedBytes})`;
    } else {
      const absoluteStart = frame.source.spanStart + chunk.start;
      this.elements.range.textContent = `Parent scope bytes [${absoluteStart}, ${absoluteStart + utf8ByteLength(chunk.text)}) of [${frame.source.spanStart}, ${frame.source.spanEnd})`;
    }
  }

  private async closeScope(scopeId: number, sessionRevision: number): Promise<void> {
    const key = scopeKey(sessionRevision, scopeId);
    if (this.closedScopeIds.has(key)) return;
    const pending = this.closingScopes.get(key);
    if (pending) return pending;
    const request = this.invokeRequest<unknown>("close_nested_scope", { scopeId, sessionRevision }).then(
      () => {
        this.closedScopeIds.add(key);
        this.deleteOverridesForScope(sessionRevision, scopeId);
      },
      (error: unknown) => {
        if (errorCode(error) === "not_found" || errorCode(error) === "stale_session") {
          this.closedScopeIds.add(key);
          this.deleteOverridesForScope(sessionRevision, scopeId);
        }
        throw error;
      }
    ).finally(() => this.closingScopes.delete(key));
    this.closingScopes.set(key, request);
    return request;
  }

  private deleteOverridesForScope(sessionRevision: number, scopeId: number): void {
    const prefix = `${sessionRevision}:${scopeId}:`;
    for (const key of this.overrides.keys()) {
      if (key.startsWith(prefix)) this.overrides.delete(key);
    }
  }

  private bestEffortCloseScope(value: unknown, sessionRevision: number): void {
    const candidate = nestedScopeCandidate(value, sessionRevision);
    if (!candidate) return;
    const key = scopeKey(candidate.sessionRevision, candidate.scopeId);
    if ((this.rootCloseAttempts.get(key) ?? 0) >= 2) return;
    void this.closeScope(candidate.scopeId, candidate.sessionRevision).catch(() => undefined);
  }

  private releaseNestedScopes(): void {
    this.clearParsedSearchPeek();
    const root = this.nestedFrames[0];
    if (root) {
      const revision = root.scope.sessionRevision;
      const key = scopeKey(revision, root.scope.scopeId);
      if (!this.rootCloseAttempts.has(key)) {
        this.rootCloseAttempts.set(key, 1);
        void this.closeRootScope(root.scope.scopeId, revision, key);
      }
    }
    for (const frame of this.nestedFrames) this.discardNestedFrame(frame);
    this.nestedFrames = [];
    this.nestedTree?.clear();
    this.nestedRepresentation = null;
    this.nestedBusy = false;
    this.elements.range.textContent = "—";
    this.setNestedVisible(false);
  }

  private async closeRootScope(scopeId: number, sessionRevision: number, key: string): Promise<void> {
    try {
      await this.closeScope(scopeId, sessionRevision);
    } catch (error) {
      if (isTerminalCloseError(error)) return;
      this.rootCloseAttempts.set(key, 2);
      await this.closeScope(scopeId, sessionRevision).catch(() => undefined);
    }
  }

  private handleFailure(error: unknown): void {
    this.contentReadBusy = false;
    this.busy = false;
    this.nestedBusy = false;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    const code = errorCode(error);
    if (code === "file_changed" || code === "stale_session") {
      this.clear(false, true);
      this.onSessionError(error);
      return;
    }
    this.elements.alert.hidden = false;
    this.elements.alert.textContent = `Content could not be opened: ${errorMessage(error)}`;
    this.setStatus("Unable to load decoded source");
    this.renderPaging();
  }

  private finishClose(): void {
    this.releaseNestedScopes();
    this.clearHtmlPreviewFrame();
    const opener = this.opener;
    const restoreFocus = this.restoreFocusOnClose ?? true;
    const wasOpen = this.elements.dialog.open;
    const hadContent = wasOpen || this.target !== null || opener !== null;
    this.restoreFocusOnClose = null;
    this.generation += 1;
    this.contentReadBusy = false;
    this.invalidateCopy();
    this.target = null;
    this.detection = null;
    this.busy = false;
    this.offsets = [];
    this.offsetIndex = -1;
    this.nextOffset = null;
    this.clearContent();
    this.representation = null;
    this.semanticLimit = null;
    this.semanticLimitBytes = null;
    this.renderMode = null;
    this.codeLanguageHint = null;
    this.renderOverride = "auto";
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    this.codeLimitReason = null;
    this.nestedRepresentation = null;
    this.nestedBusy = false;
    this.htmlRepresentation = null;
    this.htmlPreview = null;
    this.htmlPreviewUnavailable = false;
    this.htmlNote = "";
    this.ordinaryRepresentation = null;
    this.clearDecodedPages();
    this.clearRawPages();
    this.clearCodeLineCheckpoints();
    this.elements.range.textContent = "—";
    this.setNestedVisible(false);
    this.setStringVisible(false);
    this.setHtmlVisible(false);
    this.sourceSearch?.clear();
    this.elements.alert.hidden = true;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.setStatus("");
    this.renderMetadata();
    this.renderPaging();
    this.opener = null;
    if (restoreFocus && canRestoreFocus(opener)) opener.focus();
    if (hadContent) this.onClose?.(restoreFocus);
  }

  private renderMetadata(): void {
    const target = this.target;
    const detection = this.detection;
    if (!target) {
      this.elements.title.textContent = "Content Viewer";
      this.elements.scope.textContent = "—";
      this.elements.path.textContent = "—";
      this.elements.node.textContent = "—";
      this.elements.spanLabel.textContent = "File-relative span";
      this.elements.span.textContent = "—";
      this.elements.semanticType.textContent = "—";
      this.elements.detectionSource.textContent = "—";
      this.elements.plainReason.textContent = "—";
      this.elements.representation.textContent = "—";
      this.elements.rendererNote.textContent = "";
      this.elements.range.textContent = "—";
      this.syncRenderAsSelect();
      return;
    }
    this.elements.title.textContent = "Content Viewer";
    this.elements.scope.textContent = target.scopeLabel;
    this.elements.path.textContent = formatPath(target.pathSegments, target.pathTruncated);
    this.elements.node.textContent = `#${target.nodeId}`;
    this.elements.spanLabel.textContent = target.scopeId !== null
      ? "Nested-relative span"
      : target.scopeLabel.startsWith("Entry") ? "Entry-relative span" : "File-relative span";
    this.elements.span.textContent = `[${target.spanStart}, ${target.spanEnd})`;
    if (!detection) {
      this.elements.semanticType.textContent = "Detecting…";
      this.elements.detectionSource.textContent = "—";
      this.elements.plainReason.textContent = "—";
      this.elements.representation.textContent = "Loading…";
      this.elements.rendererNote.textContent = "";
      this.syncRenderAsSelect();
      return;
    }
    this.elements.semanticType.textContent = semanticTypeLabel(detection.semanticType);
    this.elements.detectionSource.textContent = "Content-detected";
    this.elements.plainReason.textContent = detection.plainReason === null ? "—" : plainReasonLabel(detection.plainReason);
    this.elements.representation.textContent = this.nestedRepresentation !== null
      ? nestedRepresentationLabel(this.nestedRepresentation)
      : this.renderMode === "html"
      ? this.htmlRepresentation === "preview" ? "Preview" : this.htmlRepresentation === "source" ? "Source" : this.htmlRepresentation === "raw" ? "Raw Lexeme" : "Loading…"
      : this.ordinaryRepresentation === "raw"
      ? "Raw Lexeme"
      : this.ordinaryRepresentation === "decoded"
      ? "Decoded Source"
      : this.renderMode === "plainText"
      ? "Plain Text"
      : this.representation === "rendered" ? "Rendered" : "Decoded Source";
    if (this.nestedRepresentation !== null) {
      const note = this.nestedRepresentation === "parsed"
        ? "Parsed nested JSON tree."
        : this.nestedRepresentation === "decoded" ? "Decoded nested JSON string."
          : "Raw nested JSON lexeme.";
      const override = this.renderOverride === "auto" ? "" : `User override: ${renderAsLabel(this.renderOverride)}`;
      this.elements.rendererNote.textContent = override && note ? `${override}\n${note}` : override || note;
      this.renderNestedRange();
      this.syncRenderAsSelect();
      this.syncSourceSearch();
      return;
    }
    let note = "";
    if (this.renderMode === "html" && this.htmlRepresentation === "raw") {
      note = "Raw Lexeme.";
    } else if (this.renderMode === "html") {
      note = this.htmlNote;
    } else if (this.ordinaryRepresentation === "raw") {
      note = "Raw Lexeme.";
    } else if (this.ordinaryRepresentation === "decoded" && this.semanticLimit === null && !this.markdownRenderFailed) {
      note = "Decoded Source.";
    } else if (this.renderMode === "plainText") {
      note = "";
    } else if (this.renderMode === "markdown" && this.semanticLimit === "markdown") {
      note = this.semanticLimitBytes === MARKDOWN_ANYWAY_LIMIT_BYTES
        ? MARKDOWN_HARD_LIMIT_NOTE
        : MARKDOWN_OVER_LIMIT_NOTE;
    } else if (this.renderMode === "code" && this.semanticLimit === "code") {
      note = "Syntax highlighting disabled for large content.";
    } else if (this.renderMode === "code" && this.representation === "rendered") {
      note = codeRendererNote(this.codeRenderReason);
    } else if (this.renderMode === "markdown" && this.representation === "rendered") {
      note = "Safe Markdown";
    } else if (this.markdownRenderFailed) {
      note = "Semantic rendering failed.\nShowing plain text instead.";
    } else if (this.renderMode === "markdown") {
      note = "Markdown rendering requires a complete source page; showing decoded source.";
    } else if (this.renderMode === "code") {
      note = "Code rendering requires a complete source page; showing decoded source.";
    } else if (this.renderMode !== "nestedJson") {
      note = "Renderer is not available yet; showing decoded source.";
    }
    const override = this.renderOverride === "auto" ? "" : `User override: ${renderAsLabel(this.renderOverride)}`;
    this.elements.rendererNote.textContent = override && note ? `${override}\n${note}` : override || note;
    this.syncRenderAsSelect();
    this.syncSourceSearch();
  }

  private renderPaging(): void {
    this.renderCopyControls();
    this.syncRenderAsSelect();
    if (this.nestedRepresentation === "parsed") {
      this.elements.previous.disabled = true;
      this.elements.next.disabled = true;
      this.elements.close.disabled = false;
      return;
    }
    if (this.nestedRepresentation === "decoded" || this.nestedRepresentation === "raw") {
      const frame = this.nestedFrames.at(-1);
      const state = frame ? textState(frame, this.nestedRepresentation) : null;
      this.elements.previous.disabled = this.nestedBusy || !state || state.offsetIndex <= 0;
      this.elements.next.disabled = this.nestedBusy || !state || state.nextOffset === null;
      this.elements.close.disabled = false;
      return;
    }
    if (this.htmlRepresentation === "preview") {
      this.elements.previous.disabled = true;
      this.elements.next.disabled = true;
      this.elements.close.disabled = false;
      return;
    }
    if (this.ordinaryRepresentation === "raw" || this.htmlRepresentation === "raw") {
      this.elements.previous.disabled = this.busy || this.rawPageIndex <= 0;
      this.elements.next.disabled = this.busy || this.rawNextOffset === null;
      this.elements.close.disabled = false;
      return;
    }
    this.elements.previous.disabled = this.busy || this.offsetIndex <= 0;
    this.elements.next.disabled = this.busy || this.nextOffset === null;
    this.elements.close.disabled = false;
  }

  private resetDom(): void {
    this.elements.dialog.setAttribute("aria-busy", "false");
    this.elements.content.setAttribute("aria-busy", "false");
    this.elements.alert.hidden = true;
    this.setNestedVisible(false);
    this.setHtmlVisible(false);
    this.renderMetadata();
    this.renderPaging();
  }

  private setStatus(value: string): void {
    this.elements.status.textContent = value;
  }

  private clearContent(): void {
    this.elements.content.textContent = "";
    this.elements.content.classList.remove("is-markdown");
  }

  private isCurrent(generation: number, target: ContentTarget): boolean {
    return this.generation === generation
      && this.target?.revision === target.revision
      && this.target.nodeId === target.nodeId
      && this.target.scopeId === target.scopeId
      && this.target.spanStart === target.spanStart
      && this.target.spanEnd === target.spanEnd;
  }

  private isReadCurrent(generation: number, target: ContentTarget, intent: number): boolean {
    return this.isCurrent(generation, target) && this.sourceRevealEpoch === intent;
  }

  private cancelContentRead(): void {
    this.sourceRevealEpoch += 1;
    this.clearParsedSearchPeek();
    if (!this.contentReadBusy) return;
    this.contentReadBusy = false;
    this.busy = false;
    this.nestedBusy = false;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.renderMetadata();
    this.renderPaging();
  }
}

function cloneTarget(target: ContentTarget): ContentTarget {
  return {
    revision: target.revision,
    nodeId: target.nodeId,
    spanStart: target.spanStart,
    spanEnd: target.spanEnd,
    scopeId: target.scopeId,
    scopeLabel: target.scopeLabel,
    pathSegments: target.pathSegments.slice(),
    pathTruncated: target.pathTruncated
  };
}

function newTextState(): TextState {
  return { offsets: [0], offsetIndex: 0, nextOffset: null, current: null, pages: new Map() };
}

function textState(frame: NestedFrame, representation: "decoded" | "raw"): TextState {
  return representation === "decoded" ? frame.decoded : frame.raw;
}

function validateNestedScope(value: unknown, source: ContentTarget, parent: NestedScope | null): NestedScope | undefined {
  if (!isRecord(value)) return undefined;
  const scopeId = safeOffset(value.scopeId);
  const parentScopeId = value.parentScopeId === null ? null : safeOffset(value.parentScopeId);
  const sourceNodeId = safeOffset(value.sourceNodeId);
  const depth = safeOffset(value.depth);
  const maxDepth = safeOffset(value.maxDepth);
  const parsedBytes = safeOffset(value.parsedBytes);
  const cumulativeBytes = safeOffset(value.cumulativeBytes);
  const sessionRevision = safeOffset(value.sessionRevision);
  const maxInputBytes = 2 * 1024 * 1024;
  const maxCumulativeBytes = 8 * 1024 * 1024;
  if (scopeId === undefined || parentScopeId === undefined || sourceNodeId === undefined || depth === undefined
    || maxDepth === undefined || parsedBytes === undefined || cumulativeBytes === undefined || sessionRevision === undefined
    || sessionRevision !== source.revision || scopeId === 0 || depth < 1 || depth > 10 || maxDepth < 1 || maxDepth > 10
    || depth > maxDepth || parsedBytes === 0 || parsedBytes > maxInputBytes || cumulativeBytes === 0
    || cumulativeBytes > maxCumulativeBytes || sourceNodeId !== source.nodeId
    || parentScopeId !== (parent?.scopeId ?? source.scopeId)) return undefined;
  const root = validateNestedNode(value.root, parsedBytes);
  if (!root || (root.kind !== "object" && root.kind !== "array")) return undefined;
  if (parent && (depth !== parent.depth + 1 || cumulativeBytes !== parent.cumulativeBytes + parsedBytes || maxDepth !== parent.maxDepth)) return undefined;
  if (!parent && (depth !== 1 || cumulativeBytes !== parsedBytes)) return undefined;
  return { scopeId, parentScopeId, sourceNodeId, root, depth, maxDepth, parsedBytes, cumulativeBytes, sessionRevision };
}

function nestedScopeCandidate(value: unknown, sessionRevision: number): { scopeId: number; sessionRevision: number } | undefined {
  if (!isRecord(value)) return undefined;
  const scopeId = safeOffset(value.scopeId);
  const revision = safeOffset(value.sessionRevision);
  return scopeId !== undefined && scopeId > 0 && revision === sessionRevision
    ? { scopeId, sessionRevision: revision }
    : undefined;
}

function scopeKey(sessionRevision: number, scopeId: number): string {
  return `${sessionRevision}:${scopeId}`;
}

function validateNestedNode(value: unknown, sourceSize: number): NodeDto | undefined {
  if (!isRecord(value) || !safeOffset(sourceSize)) return undefined;
  const id = safeOffset(value.id);
  const spanStart = safeOffset(value.spanStart);
  const spanEnd = safeOffset(value.spanEnd);
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const label = typeof value.label === "string" ? value.label : undefined;
  const labelHasMore = typeof value.labelHasMore === "boolean" ? value.labelHasMore : undefined;
  const valuePreview = value.valuePreview === null ? null : typeof value.valuePreview === "string" ? value.valuePreview : undefined;
  const valueHasMore = typeof value.valueHasMore === "boolean" ? value.valueHasMore : undefined;
  const childCount = safeOffset(value.childCount);
  if (id === undefined || spanStart === undefined || spanEnd === undefined || spanStart >= spanEnd || spanEnd > sourceSize
    || !kind || !["object", "array", "string", "number", "true", "false", "null"].includes(kind)
    || label === undefined || labelHasMore === undefined || valuePreview === undefined || valueHasMore === undefined || childCount === undefined) return undefined;
  return { id, kind, spanStart, spanEnd, label, labelHasMore, valuePreview, valueHasMore, childCount };
}

function focusNestedRoot(panel: HTMLElement | null): void {
  if (!panel) return;
  queueMicrotask(() => panel.querySelector<HTMLElement>("[role=treeitem]")?.focus());
}

function focusNestedBackOrParsed(elements: NestedViewerElements | null, depth: number): void {
  if (!elements) return;
  queueMicrotask(() => (depth > 1 ? elements.back : elements.parsedTab).focus());
}

function nestedRepresentationLabel(value: "parsed" | "decoded" | "raw"): string {
  if (value === "parsed") return "Parsed";
  if (value === "decoded") return "Decoded String";
  return "Raw Lexeme";
}

function validateDetection(value: unknown): StringDetection | undefined {
  if (!isRecord(value)) return undefined;
  const semanticType = value.semanticType;
  const detectionSource = value.detectionSource;
  const plainReason = value.plainReason;
  const validType = semanticType === "plainText" || semanticType === "markdown" || semanticType === "nestedJson"
    || semanticType === "code" || semanticType === "html";
  if (!validType || detectionSource !== "contentDetected") return undefined;
  if (semanticType === "plainText") {
    return isPlainReason(plainReason) ? { semanticType, detectionSource, plainReason } : undefined;
  }
  return plainReason === null ? { semanticType, detectionSource, plainReason } : undefined;
}

function validateHtmlPreview(value: unknown): HtmlPreviewResult | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("html") || !keys.includes("reason")) return undefined;
  const html = value.html === null ? null : typeof value.html === "string" ? value.html : undefined;
  const reason = value.reason === null || value.reason === "sizeLimit" || value.reason === "renderLimit"
    ? value.reason : undefined;
  if (html === undefined || reason === undefined || html === null && reason === null || html !== null && reason !== null) {
    return undefined;
  }
  if (html !== null && utf8ByteLength(html) >= HTML_OUTPUT_LIMIT_BYTES) return undefined;
  return { html, reason };
}

function htmlPreviewDocument(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"></head><body>${html}</body></html>`;
}

function validateChunk(
  value: unknown,
  requestedOffset: number,
  rawSpanLength: number,
  expectedNextOffset?: number,
  requireTerminalEnd = false,
  pageStartState: CodeLineState = { line: 1, previousWasCR: false }
): TextChunk | undefined {
  if (!isRecord(value)) return undefined;
  if (!Number.isSafeInteger(rawSpanLength) || rawSpanLength < 0) return undefined;
  const start = safeOffset(value.start);
  const text = typeof value.text === "string" ? value.text : undefined;
  const hasMore = typeof value.hasMore === "boolean" ? value.hasMore : undefined;
  const nextOffset = value.nextOffset === null ? null : safeOffset(value.nextOffset);
  if (start === undefined || text === undefined || hasMore === undefined || nextOffset === undefined || start !== requestedOffset) {
    return undefined;
  }
  const byteLength = utf8ByteLength(text);
  if (byteLength > TEXT_CHUNK_BYTES) return undefined;
  if (start > rawSpanLength || byteLength > rawSpanLength - start) return undefined;
  if (start > Number.MAX_SAFE_INTEGER - byteLength) return undefined;
  if (hasMore) {
    if (nextOffset === null || nextOffset !== start + byteLength || nextOffset <= start || nextOffset > rawSpanLength) return undefined;
  } else if (nextOffset !== null || requireTerminalEnd && start + byteLength !== rawSpanLength) {
    return undefined;
  }
  if (expectedNextOffset !== undefined && nextOffset !== expectedNextOffset) return undefined;
  return { start, text, hasMore, nextOffset, lineState: pageStartState };
}

function normalizeRawChunk(
  value: unknown,
  requestedAbsoluteStart: number,
  spanStart: number,
  spanEnd: number,
  requestLength: number
): TextChunk | undefined {
  if (!isRecord(value) || typeof value.text !== "string" || typeof value.hasMore !== "boolean"
    || value.nextOffset !== null && safeOffset(value.nextOffset) === undefined) return undefined;
  const start = safeOffset(value.start);
  if (start === undefined || start !== requestedAbsoluteStart || start < spanStart || start > spanEnd) return undefined;
  const byteLength = utf8ByteLength(value.text);
  if (byteLength === 0 || byteLength > requestLength || byteLength > spanEnd - start) return undefined;
  const end = start + byteLength;
  const hasMore = end < spanEnd;
  return {
    start: start - spanStart,
    text: value.text,
    hasMore,
    nextOffset: hasMore ? end - spanStart : null,
    lineState: { line: 1, previousWasCR: false }
  };
}

function validateParsedSearchPeek(
  value: unknown,
  requestedStart: number,
  sourceSpanEnd: number,
  requestLength: number
): { start: number; end: number; text: string } | undefined {
  if (!isRecord(value) || typeof value.text !== "string" || typeof value.hasMore !== "boolean"
    || value.nextOffset !== null && safeOffset(value.nextOffset) === undefined) return undefined;
  const start = safeOffset(value.start);
  if (start === undefined || start !== requestedStart || start >= sourceSpanEnd) return undefined;
  const byteLength = utf8ByteLength(value.text);
  if (byteLength === 0 || byteLength > requestLength || byteLength > sourceSpanEnd - start) return undefined;
  return { start, end: start + byteLength, text: value.text };
}

function safeOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8ByteOffsetToUtf16(value: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  for (const character of value) {
    const size = utf8ByteLength(character);
    if (bytes + size > byteOffset) break;
    bytes += size;
    index += character.length;
  }
  return index;
}

function rawSpanLength(target: ContentTarget): number {
  return target.spanEnd - target.spanStart;
}

const CODE_LANGUAGES = new Set<CodeLanguage>([
  "python", "javascript", "typescript", "rust", "c", "cpp", "java", "go", "shell", "sql", "json", "yaml"
]);

function renderOverrideKey(target: ContentTarget): string {
  return `${target.revision}:${target.scopeId === null ? "root" : target.scopeId}:${target.nodeId}`;
}

function renderAsValue(value: string): RenderAs | undefined {
  if (value === "auto" || value === "plainText" || value === "markdown" || value === "nestedJson"
    || value === "html" || value === "code") return value;
  return CODE_LANGUAGES.has(value as CodeLanguage) ? value as CodeLanguage : undefined;
}

function renderAsOption(value: RenderAs): string {
  return value;
}

function renderAsLabel(value: RenderAs): string {
  if (value === "auto") return "Auto";
  if (value === "plainText") return "Plain Text";
  if (value === "nestedJson") return "Nested JSON";
  if (value === "html") return "HTML";
  if (value === "code") return "Code Auto";
  return value === "cpp" ? "C++" : value[0].toUpperCase() + value.slice(1);
}

function semanticTypeLabel(value: StringDetection["semanticType"]): string {
  if (value === "plainText") return "Plain Text";
  if (value === "nestedJson") return "Nested JSON";
  if (value === "markdown") return "Markdown";
  if (value === "html") return "HTML";
  return "Code";
}

function plainReasonLabel(value: Exclude<StringDetection["plainReason"], null>): string {
  if (value === "jsonParseFailed") return "Looks like JSON, but parsing failed.";
  if (value === "sizeLimit") return "Automatic detection skipped because content exceeds 2 MiB.";
  if (value === "depthLimit") return "Automatic nested JSON detection stopped at the maximum depth limit of 10.";
  if (value === "cumulativeLimit") return "Automatic nested JSON detection stopped at the cumulative limit of 8 MiB.";
  return "Plain Text fallback";
}

function codeRendererNote(reason: CodeRenderReason | null): string {
  if (reason === "sizeLimit" || reason === "lineLimit") {
    return "Syntax highlighting disabled for large content.";
  }
  if (reason === "timeLimit" || reason === "nodeLimit" || reason === "rendererError") {
    return "Syntax highlighting unavailable; showing plain code.";
  }
  if (reason === "generic") return "Generic Code";
  return "Code";
}

function formatPath(segments: string[], truncated: boolean): string {
  const path = segments.reduce((result, segment, index) => {
    if (index === 0) return segment;
    return /^\[\d+\]$/.test(segment) ? `${result}${segment}` : `${result}.${segment}`;
  }, "") || "$";
  return truncated ? `${path} · label truncated at end` : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlainReason(value: unknown): value is Exclude<StringDetection["plainReason"], null> {
  return value === "fallback" || value === "jsonParseFailed" || value === "sizeLimit"
    || value === "depthLimit" || value === "cumulativeLimit";
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element || !document.contains(element) || element.hidden) return false;
  return !(element instanceof HTMLButtonElement && element.disabled)
    && !(element instanceof HTMLInputElement && element.disabled)
    && !(element instanceof HTMLSelectElement && element.disabled)
    && !(element instanceof HTMLTextAreaElement && element.disabled);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isGlobalError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "file_changed" || code === "stale_session";
}

function isTerminalCloseError(error: unknown): boolean {
  return errorCode(error) === "not_found" || errorCode(error) === "stale_session";
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (error instanceof Error) return error.message;
  return "The decoded text request failed.";
}
