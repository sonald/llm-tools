import { invoke } from "@tauri-apps/api/core";

export type ContentTarget = {
  revision: number;
  nodeId: number;
  spanStart: number;
  spanEnd: number;
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
  content: HTMLPreElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
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

type ContentViewerOptions = {
  elements: ContentViewerElements;
  invoke?: typeof invoke;
  onSessionError?: (error: unknown) => void;
  onClose?: (restoreFocus: boolean) => void;
};

const TEXT_CHUNK_BYTES = 128 * 1024;

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

  constructor(options: ContentViewerOptions) {
    this.elements = options.elements;
    this.invokeRequest = options.invoke ?? invoke;
    this.onSessionError = options.onSessionError ?? (() => undefined);
    this.onClose = options.onClose;
    this.elements.close.addEventListener("click", () => this.close());
    this.elements.previous.addEventListener("click", () => void this.readPrevious());
    this.elements.next.addEventListener("click", () => void this.readNext());
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
    this.elements.content.textContent = "";
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
        sessionRevision: target.revision
      });
      if (!this.isCurrent(generation, target)) return;
      const detection = validateDetection(detectionValue);
      if (!detection) throw new Error("The string detection response was invalid.");
      this.detection = detection;
      this.renderMetadata();

      const chunkValue = await this.invokeRequest<unknown>("read_decoded_text", {
        nodeId: target.nodeId,
        offset: 0,
        length: TEXT_CHUNK_BYTES,
        sessionRevision: target.revision
      });
      if (!this.isCurrent(generation, target)) return;
      const chunk = validateChunk(chunkValue, 0, rawSpanLength(target));
      if (!chunk) throw new Error("The decoded text response was invalid.");
      this.installChunk(chunk);
    } catch (error) {
      if (!this.isCurrent(generation, target)) return;
      this.handleFailure(error);
    }
  }

  clear(restoreFocus = true): void {
    this.restoreFocusOnClose = restoreFocus;
    this.generation += 1;
    this.target = null;
    this.detection = null;
    this.busy = false;
    this.offsets = [];
    this.offsetIndex = -1;
    this.nextOffset = null;
    this.elements.content.textContent = "";
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
    if (this.elements.dialog.open) {
      this.elements.dialog.close();
    } else {
      this.finishClose();
    }
  }

  private async readNext(): Promise<void> {
    if (this.busy || !this.target || this.nextOffset === null) return;
    const offset = this.nextOffset;
    await this.readPage(offset, "next");
  }

  private async readPrevious(): Promise<void> {
    if (this.busy || !this.target || this.offsetIndex <= 0) return;
    await this.readPage(this.offsets[this.offsetIndex - 1], "previous", this.offsets[this.offsetIndex]);
  }

  private async readPage(offset: number, direction: "next" | "previous", expectedNextOffset?: number): Promise<void> {
    const target = this.target;
    if (!target) return;
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
        sessionRevision: target.revision
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

  private installChunk(chunk: TextChunk): void {
    this.busy = false;
    this.nextOffset = chunk.nextOffset;
    this.elements.content.textContent = chunk.text;
    this.elements.alert.hidden = true;
    if (chunk.text.length === 0 && !chunk.hasMore) {
      this.setStatus("Empty string");
    } else {
      this.setStatus("Decoded source ready");
    }
    this.elements.range.textContent = `[${chunk.start}, ${chunk.start + utf8ByteLength(chunk.text)})`;
    this.elements.dialog.removeAttribute("aria-busy");
    this.elements.content.removeAttribute("aria-busy");
    this.renderPaging();
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
    this.elements.content.textContent = "";
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
    this.elements.spanLabel.textContent = target.scopeLabel.startsWith("Entry") ? "Entry-relative span" : "File-relative span";
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
    this.elements.representation.textContent = detection.semanticType === "plainText" ? "Plain Text" : "Decoded Source";
    this.elements.rendererNote.textContent = detection.semanticType === "plainText"
      ? ""
      : "Renderer is not available yet; showing decoded source.";
  }

  private renderPaging(): void {
    this.elements.previous.disabled = this.busy || this.offsetIndex <= 0;
    this.elements.next.disabled = this.busy || this.nextOffset === null;
    this.elements.close.disabled = false;
  }

  private resetDom(): void {
    this.elements.dialog.setAttribute("aria-busy", "false");
    this.elements.content.setAttribute("aria-busy", "false");
    this.elements.alert.hidden = true;
    this.renderMetadata();
    this.renderPaging();
  }

  private setStatus(value: string): void {
    this.elements.status.textContent = value;
  }

  private isCurrent(generation: number, target: ContentTarget): boolean {
    return this.generation === generation && this.target?.revision === target.revision && this.target.nodeId === target.nodeId;
  }
}

function cloneTarget(target: ContentTarget): ContentTarget {
  return {
    revision: target.revision,
    nodeId: target.nodeId,
    spanStart: target.spanStart,
    spanEnd: target.spanEnd,
    scopeLabel: target.scopeLabel,
    pathSegments: target.pathSegments.slice(),
    pathTruncated: target.pathTruncated
  };
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

function validateChunk(value: unknown, requestedOffset: number, rawSpanLength: number, expectedNextOffset?: number): TextChunk | undefined {
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
  } else if (nextOffset !== null) {
    return undefined;
  }
  if (expectedNextOffset !== undefined && nextOffset !== expectedNextOffset) return undefined;
  return { start, text, hasMore, nextOffset };
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

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (error instanceof Error) return error.message;
  return "The decoded text request failed.";
}
