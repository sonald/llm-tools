import { invoke } from "@tauri-apps/api/core";
import { renderCode, type CodeRenderReason } from "./code-renderer";
import { renderSafeMarkdown } from "./markdown-renderer";
import { TreeView, type NodeDto, type TreeViewSnapshot } from "./tree-view";

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
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  nested?: NestedViewerElements;
  html?: HtmlViewerElements;
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
};

export type HtmlViewerElements = {
  representations: HTMLElement;
  previewTab: HTMLButtonElement;
  sourceTab: HTMLButtonElement;
  previewPanel: HTMLElement;
  previewFrame: HTMLIFrameElement;
};

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
};

type SemanticType = "markdown" | "code";

type CollectedText = {
  first: TextChunk;
  text: string | null;
  overLimit: boolean;
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
};

const TEXT_CHUNK_BYTES = 128 * 1024;
const DECODED_PAGE_CACHE_BYTES = 32 * 1024 * 1024;
const MARKDOWN_AUTO_RENDER_LIMIT_BYTES = 2 * 1024 * 1024;
const CODE_AUTO_RENDER_LIMIT_BYTES = 1 * 1024 * 1024;
const HTML_INPUT_LIMIT_BYTES = 512 * 1024;
const HTML_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MARKDOWN_OVER_LIMIT_NOTE = "Markdown rendering skipped because content exceeds 2 MiB.";
const MARKDOWN_OVER_LIMIT_STATUS = "Markdown source exceeds 2 MiB; showing decoded source.";
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
  private readonly nestedElements: NestedViewerElements | null;
  private readonly nestedTree: TreeView | null;
  private readonly htmlElements: HtmlViewerElements | null;
  private nestedFrames: NestedFrame[] = [];
  private nestedRepresentation: "parsed" | "decoded" | "raw" | null = null;
  private htmlRepresentation: "preview" | "source" | null = null;
  private htmlPreview: string | null = null;
  private htmlPreviewUnavailable = false;
  private htmlNote = "";
  private readonly decodedPages = new Map<number, TextChunk>();
  private decodedPageCacheBytes = 0;
  private readonly closedScopeIds = new Set<string>();
  private readonly closingScopes = new Map<string, Promise<void>>();
  private readonly rootCloseAttempts = new Map<string, number>();
  private nestedBusy = false;

  constructor(options: ContentViewerOptions) {
    this.elements = options.elements;
    this.invokeRequest = options.invoke ?? invoke;
    this.onSessionError = options.onSessionError ?? (() => undefined);
    this.onClose = options.onClose;
    this.nestedElements = options.elements.nested ?? null;
    this.htmlElements = options.elements.html ?? null;
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
        invoke: this.invokeRequest
      })
      : null;
    this.elements.close.addEventListener("click", () => this.close());
    this.elements.previous.addEventListener("click", () => void this.readPrevious());
    this.elements.next.addEventListener("click", () => void this.readNext());
    this.nestedElements?.back.addEventListener("click", () => void this.backNested());
    this.nestedElements?.parsedTab.addEventListener("click", () => this.activateNestedRepresentation("parsed"));
    this.nestedElements?.decodedTab.addEventListener("click", () => this.activateNestedRepresentation("decoded"));
    this.nestedElements?.rawTab.addEventListener("click", () => this.activateNestedRepresentation("raw"));
    this.nestedElements?.representations.addEventListener("keydown", (event) => this.handleNestedTabKeydown(event));
    this.htmlElements?.previewTab.addEventListener("click", () => this.activateHtmlRepresentation("preview"));
    this.htmlElements?.sourceTab.addEventListener("click", () => this.activateHtmlRepresentation("source"));
    this.htmlElements?.representations.addEventListener("keydown", (event) => this.handleHtmlTabKeydown(event));
    this.elements.dialog.addEventListener("cancel", () => {
      // Let the platform close the dialog and let the close event restore focus.
      this.restoreFocusOnClose = true;
    });
    this.elements.dialog.addEventListener("close", () => this.finishClose());
    this.resetDom();
  }

  get isOpen(): boolean {
    return this.elements.dialog.open;
  }

  async open(target: ContentTarget, opener: HTMLElement | null = null): Promise<void> {
    this.releaseNestedScopes();
    this.clearHtmlPreviewFrame();
    this.generation += 1;
    const generation = this.generation;
    this.restoreFocusOnClose = null;
    this.target = cloneTarget(target);
    this.detection = null;
    this.opener = opener;
    this.busy = true;
    this.offsets = [0];
    this.offsetIndex = 0;
    this.nextOffset = null;
    this.clearContent();
    this.elements.range.textContent = "—";
    this.representation = null;
    this.semanticLimit = null;
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    this.nestedRepresentation = null;
    this.nestedBusy = false;
    this.htmlRepresentation = null;
    this.htmlPreview = null;
    this.htmlPreviewUnavailable = false;
    this.htmlNote = "";
    this.clearDecodedPages();
    this.setNestedVisible(false);
    this.setHtmlVisible(false);
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

      if (detection.semanticType === "nestedJson") {
        await this.openNestedRoot(target, generation);
        return;
      }

      if (detection.semanticType === "html") {
        await this.openHtml(target, generation);
        return;
      }

      if (detection.semanticType === "markdown" || detection.semanticType === "code") {
        await this.openSemantic(target, generation, detection.semanticType);
        return;
      }

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
    } catch (error) {
      if (!this.isCurrent(generation, target)) return;
      this.handleFailure(error);
    }
  }

  clear(restoreFocus = true): void {
    this.releaseNestedScopes();
    this.clearHtmlPreviewFrame();
    this.restoreFocusOnClose = restoreFocus;
    this.generation += 1;
    this.target = null;
    this.detection = null;
    this.busy = false;
    this.offsets = [];
    this.offsetIndex = -1;
    this.nextOffset = null;
    this.clearContent();
    this.representation = null;
    this.semanticLimit = null;
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    this.nestedRepresentation = null;
    this.nestedBusy = false;
    this.htmlRepresentation = null;
    this.htmlPreview = null;
    this.htmlPreviewUnavailable = false;
    this.htmlNote = "";
    this.clearDecodedPages();
    this.setNestedVisible(false);
    this.setHtmlVisible(false);
    this.elements.alert.hidden = true;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.setStatus("");
    this.renderMetadata();
    this.renderPaging();
    if (this.elements.dialog.open) this.elements.dialog.close();
    else this.finishClose();
  }

  close(): void {
    this.restoreFocusOnClose = true;
    this.releaseNestedScopes();
    this.clearHtmlPreviewFrame();
    if (this.elements.dialog.open) {
      this.elements.dialog.close();
    } else {
      this.finishClose();
    }
  }

  private async readNext(): Promise<void> {
    if (this.nestedRepresentation === "decoded" || this.nestedRepresentation === "raw") {
      await this.readNestedPage("next");
      return;
    }
    if (this.htmlRepresentation === "preview") return;
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
    if (this.busy || !this.target || this.offsetIndex <= 0) return;
    await this.readPage(this.offsets[this.offsetIndex - 1], "previous", this.offsets[this.offsetIndex]);
  }

  private async readPage(offset: number, direction: "next" | "previous", expectedNextOffset?: number): Promise<void> {
    const target = this.target;
    if (!target) return;
    const cached = this.decodedPages.get(offset);
    if (cached) {
      if (direction === "next") {
        this.offsets = this.offsets.slice(0, this.offsetIndex + 1);
        this.offsets.push(offset);
        this.offsetIndex += 1;
      } else {
        this.offsetIndex -= 1;
      }
      this.installChunk(cached);
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.setStatus("Loading decoded source…");
    this.renderPaging();
    try {
      const value = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset,
        length: TEXT_CHUNK_BYTES,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isCurrent(generation, target)) return;
      const chunk = validateChunk(value, offset, rawSpanLength(target), expectedNextOffset);
      if (!chunk) throw new Error("The decoded text response was invalid.");
      if (direction === "next") {
        this.offsets = this.offsets.slice(0, this.offsetIndex + 1);
        this.offsets.push(offset);
        this.offsetIndex += 1;
      } else {
        this.offsetIndex -= 1;
      }
      this.installChunk(chunk);
    } catch (error) {
      if (!this.isCurrent(generation, target)) return;
      this.handleFailure(error);
    }
  }

  private async openSemantic(target: ContentTarget, generation: number, semanticType: SemanticType): Promise<void> {
    const limit = semanticType === "markdown"
      ? MARKDOWN_AUTO_RENDER_LIMIT_BYTES
      : CODE_AUTO_RENDER_LIMIT_BYTES;
    const collected = await this.collectSemanticSource(target, generation, limit);
    if (!collected) return;
    this.semanticLimit = collected.overLimit ? semanticType : null;
    const chunk = collected.overLimit
      ? collected.first
      : { start: 0, text: collected.text ?? "", hasMore: false, nextOffset: null };
    this.installChunk(chunk, true, collected.overLimit ? null : collected.first);
  }

  private async collectSemanticSource(
    target: ContentTarget,
    generation: number,
    limit: number
  ): Promise<CollectedText | null> {
    const parts: string[] = [];
    let totalBytes = 0;
    let offset = 0;
    let first: TextChunk | undefined;
    while (true) {
      const value = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset,
        length: TEXT_CHUNK_BYTES,
        sessionRevision: target.revision,
        scopeId: target.scopeId
      });
      if (!this.isCurrent(generation, target)) return null;
      const chunk = validateChunk(value, offset, rawSpanLength(target));
      if (!chunk) throw new Error("The decoded text response was invalid.");
      const firstChunk = first ?? chunk;
      first = firstChunk;
      const byteLength = utf8ByteLength(chunk.text);
      if (byteLength > limit - totalBytes) {
        return { first: firstChunk, text: null, overLimit: true };
      }
      parts.push(chunk.text);
      totalBytes += byteLength;
      if (totalBytes === limit && chunk.hasMore) {
        return { first: firstChunk, text: null, overLimit: true };
      }
      if (!chunk.hasMore) {
        return { first: firstChunk, text: parts.join(""), overLimit: false };
      }
      if (chunk.nextOffset === null) throw new Error("The decoded text response was invalid.");
      offset = chunk.nextOffset;
    }
  }

  private installChunk(chunk: TextChunk, initial = false, sourceFallback: TextChunk | null = null): void {
    this.busy = false;
    this.elements.content.classList.remove("is-markdown");
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    const canRenderSemantic = initial && !chunk.hasMore && this.semanticLimit === null
      && (this.detection?.semanticType === "markdown" || this.detection?.semanticType === "code");
    let sourceChunk = chunk;
    let cacheChunk: TextChunk | null = canRenderSemantic ? null : chunk;
    if (canRenderSemantic && this.detection?.semanticType === "markdown") {
      const fragment = renderSafeMarkdown(chunk.text);
      if (fragment) {
        this.elements.content.replaceChildren(fragment);
        this.elements.content.classList.add("is-markdown");
        this.representation = "rendered";
      } else {
        sourceChunk = sourceFallback ?? chunk;
        cacheChunk = sourceChunk;
        this.elements.content.textContent = sourceChunk.text;
        this.representation = "decoded";
        this.markdownRenderFailed = true;
      }
    } else if (canRenderSemantic && this.detection?.semanticType === "code") {
      const result = renderCode(chunk.text);
      this.elements.content.replaceChildren(result.fragment);
      this.representation = "rendered";
      this.codeRenderReason = result.reason;
    } else {
      this.elements.content.textContent = chunk.text;
      this.representation = "decoded";
    }
    if (cacheChunk) this.cacheDecodedPage(cacheChunk);
    this.nextOffset = sourceChunk.nextOffset;
    if (this.detection?.semanticType === "html") {
      this.htmlRepresentation = "source";
      this.setHtmlVisible(true);
    }
    this.renderMetadata();
    this.elements.alert.hidden = true;
    if (this.semanticLimit === "markdown") {
      this.setStatus(MARKDOWN_OVER_LIMIT_STATUS);
    } else if (this.representation === "rendered") {
      this.setStatus(this.detection?.semanticType === "code" ? "Rendered Code ready" : "Rendered Markdown ready");
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

  private async openNestedRoot(target: ContentTarget, generation: number): Promise<void> {
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
      if (!this.isCurrent(generation, target)) return;
      const chunk = validateChunk(value, 0, rawSpanLength(target));
      if (!chunk) throw new Error("The decoded text response was invalid.");
      this.installChunk(chunk, true);
      return;
    }
    this.nestedBusy = true;
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
        return;
      }
      const scope = validateNestedScope(value, target, null);
      if (!scope) {
        this.bestEffortCloseScope(value, target.revision);
        throw new Error("The nested JSON scope response was invalid.");
      }
      const frame: NestedFrame = {
        scope,
        source: cloneTarget(target),
        parentSnapshot: null,
        decoded: newTextState(),
        raw: newTextState()
      };
      this.nestedFrames = [frame];
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
    } catch (error) {
      if (!this.isCurrent(generation, target)) return;
      this.nestedBusy = false;
      this.handleFailure(error);
    }
  }

  private async openHtml(target: ContentTarget, generation: number): Promise<void> {
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
      if (!this.isCurrent(generation, target) || this.htmlRepresentation !== "source") return;
      const chunk = validateChunk(value, 0, rawSpanLength(target));
      if (!chunk) throw new Error("The decoded text response was invalid.");
      this.installChunk(chunk, true);
    } catch (error) {
      if (!this.isCurrent(generation, target)) return;
      this.handleFailure(error);
    }
  }

  private activateHtmlRepresentation(representation: "preview" | "source"): void {
    if (this.detection?.semanticType !== "html" || this.busy) return;
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
      return;
    }
    this.htmlRepresentation = "source";
    this.htmlNote = "";
    this.setHtmlVisible(true);
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
    const tabs = [this.htmlElements.previewTab, this.htmlElements.sourceTab];
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      tabs[(current + direction + tabs.length) % tabs.length].focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? tabs[0] : tabs[1]).focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.activateHtmlRepresentation(current === 0 ? "preview" : "source");
    }
  }

  private writeHtmlPreview(html: string, generation: number, target: ContentTarget | null): void {
    if (!this.htmlElements || !target || this.detection?.semanticType !== "html" || this.htmlRepresentation !== "preview") return;
    if (generation !== this.generation || this.target?.nodeId !== target.nodeId || this.target.scopeId !== target.scopeId
      || this.target.revision !== target.revision) return;
    this.htmlElements.previewFrame.srcdoc = htmlPreviewDocument(html);
  }

  private async openNestedChild(target: ContentTarget): Promise<void> {
    const parent = this.nestedFrames.at(-1);
    const tree = this.nestedTree;
    if (!parent || !tree || this.nestedBusy || target.scopeId !== parent.scope.scopeId) return;
    const generation = this.generation;
    const parentSnapshot = tree.snapshot();
    this.nestedBusy = true;
    this.elements.range.textContent = "—";
    this.setStatus("Loading parsed nested JSON…");
    this.renderPaging();
    try {
      const value = await this.invokeRequest<unknown>("open_nested_json", {
        parentScopeId: parent.scope.scopeId,
        nodeId: target.nodeId,
        maxDepth: null,
        sessionRevision: parent.scope.sessionRevision
      });
      if (generation !== this.generation || this.nestedFrames.at(-1)?.scope.scopeId !== parent.scope.scopeId) {
        this.bestEffortCloseScope(value, parent.scope.sessionRevision);
        return;
      }
      const source = cloneTarget({
        ...target,
        scopeLabel: parent.source.scopeLabel,
        pathSegments: [...parent.source.pathSegments, ...target.pathSegments.slice(1)]
      });
      const scope = validateNestedScope(value, source, parent.scope);
      if (!scope) {
        this.bestEffortCloseScope(value, parent.scope.sessionRevision);
        throw new Error("The nested JSON scope response was invalid.");
      }
      this.nestedFrames.push({ scope, source, parentSnapshot, decoded: newTextState(), raw: newTextState() });
      this.target = source;
      this.detection = { semanticType: "nestedJson", detectionSource: "contentDetected", plainReason: null };
      this.nestedRepresentation = "parsed";
      this.nestedBusy = false;
      tree.setSession({
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
    } catch (error) {
      if (generation !== this.generation) return;
      this.nestedBusy = false;
      if (errorCode(error) === "file_changed" || errorCode(error) === "stale_session") {
        this.handleFailure(error);
        return;
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

  private async backNested(): Promise<void> {
    const frame = this.nestedFrames.at(-1);
    if (!frame || this.nestedBusy) return;
    const generation = ++this.generation;
    this.nestedBusy = true;
    this.elements.range.textContent = "—";
    this.setStatus("Closing nested JSON…");
    this.renderPaging();
    try {
      await this.closeScope(frame.scope.scopeId, frame.scope.sessionRevision);
      if (generation !== this.generation) return;
      this.elements.alert.hidden = true;
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
      this.target = parent.source;
      this.detection = { semanticType: "nestedJson", detectionSource: "contentDetected", plainReason: null };
      this.nestedRepresentation = "parsed";
      this.nestedTree?.restore(frame.parentSnapshot);
      if (!frame.parentSnapshot) this.setNestedTreeSession(parent);
      this.setNestedVisible(true);
      this.setStatus("Parsed nested JSON ready");
      this.renderMetadata();
      this.renderPaging();
      focusNestedBackOrParsed(this.nestedElements, this.nestedFrames.length);
    } catch (error) {
      if (generation !== this.generation) return;
      if (errorCode(error) === "not_found") {
        this.nestedFrames.pop();
        this.nestedBusy = false;
        if (this.nestedFrames.length === 0) this.close();
        else {
          this.backToParentAfterCleanup(frame.parentSnapshot);
        }
        return;
      }
      this.nestedBusy = false;
      this.handleFailure(error);
    }
  }

  private backToParentAfterCleanup(snapshot: TreeViewSnapshot | null): void {
    const parent = this.nestedFrames.at(-1);
    if (!parent) return;
    this.elements.alert.hidden = true;
    this.target = parent.source;
    this.nestedRepresentation = "parsed";
    this.nestedTree?.restore(snapshot);
    if (!snapshot) this.setNestedTreeSession(parent);
    this.setNestedVisible(true);
    this.renderMetadata();
    this.renderPaging();
    focusNestedBackOrParsed(this.nestedElements, this.nestedFrames.length);
  }

  private activateNestedRepresentation(representation: "parsed" | "decoded" | "raw"): void {
    if (!this.nestedFrames.length || this.nestedBusy) return;
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
    this.nestedBusy = true;
    this.elements.dialog.setAttribute("aria-busy", "true");
    this.elements.content.setAttribute("aria-busy", "true");
    this.renderNestedRange();
    this.setStatus(representation === "decoded" ? "Loading decoded nested string…" : "Loading raw nested lexeme…");
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
      if (generation !== this.generation || this.nestedFrames.at(-1) !== frame || this.nestedRepresentation !== representation) return;
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
      state.pages.set(chunk.start, chunk);
      this.installNestedChunk(frame, representation, chunk);
    } catch (error) {
      if (generation !== this.generation) return;
      this.nestedBusy = false;
      this.elements.alert.hidden = false;
      this.elements.alert.textContent = `Content could not be opened: ${errorMessage(error)}`;
      if (errorCode(error) === "file_changed" || errorCode(error) === "stale_session") {
        this.handleFailure(error);
      } else {
        this.setStatus("Unable to load nested text");
        this.renderPaging();
      }
    }
  }

  private installNestedChunk(frame: NestedFrame, representation: "decoded" | "raw", chunk: TextChunk): void {
    const state = textState(frame, representation);
    state.current = chunk;
    state.pages.set(chunk.start, chunk);
    state.nextOffset = chunk.nextOffset;
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

  private setNestedVisible(active: boolean): void {
    const nested = this.nestedElements;
    if (!nested) return;
    nested.navigation.hidden = !active;
    nested.representations.hidden = !active;
    nested.back.hidden = !active || this.nestedFrames.length <= 1;
    nested.back.setAttribute("aria-controls", "content-viewer-parsed-panel");
    nested.parsedPanel.hidden = !active || this.nestedRepresentation !== "parsed";
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
    if (html && this.detection?.semanticType === "html" && this.htmlRepresentation === "source") {
      this.elements.content.setAttribute("aria-label", "HTML Source");
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
    const visible = active && this.detection?.semanticType === "html" && this.htmlRepresentation !== null;
    html.representations.hidden = !visible;
    html.previewPanel.hidden = !visible || this.htmlRepresentation !== "preview";
    html.previewTab.disabled = !visible || this.htmlPreviewUnavailable || this.htmlPreview === null;
    html.sourceTab.disabled = !visible;
    const tabs = [html.previewTab, html.sourceTab];
    const activeTab = this.htmlRepresentation === "preview" ? html.previewTab : html.sourceTab;
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

  private cacheDecodedPage(chunk: TextChunk): void {
    const previous = this.decodedPages.get(chunk.start);
    if (previous) {
      this.decodedPageCacheBytes -= utf8ByteLength(previous.text);
      this.decodedPages.delete(chunk.start);
    }
    this.decodedPages.set(chunk.start, chunk);
    this.decodedPageCacheBytes += utf8ByteLength(chunk.text);
    while (this.decodedPageCacheBytes > DECODED_PAGE_CACHE_BYTES && this.decodedPages.size > 1) {
      const oldestOffset = this.decodedPages.keys().next().value;
      if (typeof oldestOffset !== "number") break;
      const oldest = this.decodedPages.get(oldestOffset);
      this.decodedPages.delete(oldestOffset);
      if (oldest) this.decodedPageCacheBytes -= utf8ByteLength(oldest.text);
    }
  }

  private clearDecodedPages(): void {
    this.decodedPages.clear();
    this.decodedPageCacheBytes = 0;
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
      },
      (error: unknown) => {
        if (errorCode(error) === "not_found" || errorCode(error) === "stale_session") {
          this.closedScopeIds.add(key);
        }
        throw error;
      }
    ).finally(() => this.closingScopes.delete(key));
    this.closingScopes.set(key, request);
    return request;
  }

  private bestEffortCloseScope(value: unknown, sessionRevision: number): void {
    const candidate = nestedScopeCandidate(value, sessionRevision);
    if (!candidate) return;
    const key = scopeKey(candidate.sessionRevision, candidate.scopeId);
    if ((this.rootCloseAttempts.get(key) ?? 0) >= 2) return;
    void this.closeScope(candidate.scopeId, candidate.sessionRevision).catch(() => undefined);
  }

  private releaseNestedScopes(): void {
    const root = this.nestedFrames[0];
    if (root) {
      const revision = root.scope.sessionRevision;
      const key = scopeKey(revision, root.scope.scopeId);
      if (!this.rootCloseAttempts.has(key)) {
        this.rootCloseAttempts.set(key, 1);
        void this.closeRootScope(root.scope.scopeId, revision, key);
      }
    }
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
    this.busy = false;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    const code = errorCode(error);
    if (code === "file_changed" || code === "stale_session") {
      this.clear(false);
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
    this.target = null;
    this.detection = null;
    this.busy = false;
    this.offsets = [];
    this.offsetIndex = -1;
    this.nextOffset = null;
    this.clearContent();
    this.representation = null;
    this.semanticLimit = null;
    this.markdownRenderFailed = false;
    this.codeRenderReason = null;
    this.nestedRepresentation = null;
    this.nestedBusy = false;
    this.htmlRepresentation = null;
    this.htmlPreview = null;
    this.htmlPreviewUnavailable = false;
    this.htmlNote = "";
    this.clearDecodedPages();
    this.elements.range.textContent = "—";
    this.setNestedVisible(false);
    this.setHtmlVisible(false);
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
      return;
    }
    this.elements.semanticType.textContent = semanticTypeLabel(detection.semanticType);
    this.elements.detectionSource.textContent = "Content-detected";
    this.elements.plainReason.textContent = detection.plainReason === null ? "—" : plainReasonLabel(detection.plainReason);
    this.elements.representation.textContent = this.nestedRepresentation !== null
      ? nestedRepresentationLabel(this.nestedRepresentation)
      : detection.semanticType === "html"
      ? this.htmlRepresentation === "preview" ? "Preview" : this.htmlRepresentation === "source" ? "Source" : "Loading…"
      : detection.semanticType === "plainText"
      ? "Plain Text"
      : this.representation === "rendered" ? "Rendered" : "Decoded Source";
    if (this.nestedRepresentation !== null) {
      this.elements.rendererNote.textContent = this.nestedRepresentation === "parsed"
        ? "Parsed nested JSON tree."
        : this.nestedRepresentation === "decoded" ? "Decoded nested JSON string."
          : "Raw nested JSON lexeme.";
      this.renderNestedRange();
      return;
    }
    if (detection.semanticType === "html") {
      this.elements.rendererNote.textContent = this.htmlNote;
    } else if (detection.semanticType === "plainText") {
      this.elements.rendererNote.textContent = "";
    } else if (detection.semanticType === "markdown" && this.semanticLimit === "markdown") {
      this.elements.rendererNote.textContent = MARKDOWN_OVER_LIMIT_NOTE;
    } else if (detection.semanticType === "code" && this.semanticLimit === "code") {
      this.elements.rendererNote.textContent = "Syntax highlighting disabled for large content.";
    } else if (detection.semanticType === "code" && this.representation === "rendered") {
      this.elements.rendererNote.textContent = codeRendererNote(this.codeRenderReason);
    } else if (this.representation === "rendered") {
      this.elements.rendererNote.textContent = "Safe Markdown";
    } else if (this.markdownRenderFailed) {
      this.elements.rendererNote.textContent = "Semantic rendering failed.\nShowing plain text instead.";
    } else if (detection.semanticType === "markdown") {
      this.elements.rendererNote.textContent = "Markdown rendering requires a complete source page; showing decoded source.";
    } else if (detection.semanticType === "code") {
      this.elements.rendererNote.textContent = "Code rendering requires a complete source page; showing decoded source.";
    } else {
      this.elements.rendererNote.textContent = "Renderer is not available yet; showing decoded source.";
    }
  }

  private renderPaging(): void {
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
  requireTerminalEnd = false
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
  return { start, text, hasMore, nextOffset };
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
    nextOffset: hasMore ? end - spanStart : null
  };
}

function safeOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function rawSpanLength(target: ContentTarget): number {
  return target.spanEnd - target.spanStart;
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

function isTerminalCloseError(error: unknown): boolean {
  return errorCode(error) === "not_found" || errorCode(error) === "stale_session";
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (error instanceof Error) return error.message;
  return "The decoded text request failed.";
}
