import { invoke } from "@tauri-apps/api/core";
import type { EntryDto } from "./entry-list";
import type { NodeDto } from "./tree-view";

type TextChunkDto = {
  start: number;
  text: string;
  hasMore: boolean;
  nextOffset: number | null;
};

type RawViewOptions = {
  panel: HTMLElement;
  tab: HTMLButtonElement;
  onError: (error: unknown) => void;
  invoke?: Invoke;
};

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

type RawSession = {
  revision: number;
};

type RawSourceKind = "document" | "collection" | "entry";

type NodeScope = {
  kind: "node";
  node: NodeDto;
  source: RawSourceKind;
};

type RawSourceScope = {
  kind: "source";
  source: RawSourceKind;
  size: number;
};

type EntryBytesScope = {
  kind: "entryBytes";
  status: "invalidJson" | "invalidUtf8" | "oversized";
  entryOrdinal: number;
  sourceLine: number;
  byteStart: number;
  byteEnd: number;
};

type RawDocumentScope = {
  kind: "rawDocument";
  size: number;
  encoding: "utf8" | "invalidUtf8";
};

type RawScope = NodeScope | RawSourceScope | EntryBytesScope | RawDocumentScope;

type PageRequest = {
  epoch: number;
  revision: number;
  offset: number;
  historyIndex: number;
  restoreControl: FocusControl;
  scopeKind: RawScope["kind"];
  scopeStart: number;
  scopeEnd: number;
};

type FailedPage = {
  offset: number;
  historyIndex: number;
};

type FocusControl = "previous" | "next" | "retry" | null;

type RawPageResult = {
  text: string;
  pageEnd: number;
  displayBytes?: Uint8Array;
};

type RevealRange = {
  start: number;
  end: number;
  label: string;
};

type Representation = "lossy" | "hex";

export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 128 * 1024;

export class RawView {
  private readonly panel: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly onError: (error: unknown) => void;
  private readonly invoke: Invoke;
  private readonly scopeLabel: HTMLElement;
  private readonly pageLabel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly representationTabs: HTMLElement;
  private readonly lossyTab: HTMLButtonElement;
  private readonly hexTab: HTMLButtonElement;
  private readonly representationNote: HTMLElement;
  private readonly pre: HTMLPreElement;
  private session: RawSession | null = null;
  private baseScope: RawScope | null = null;
  private scope: RawScope | null = null;
  private reveal: RevealRange | null = null;
  private text: string | null = null;
  private pageStart: number | null = null;
  private pageEnd: number | null = null;
  private displayBytes: Uint8Array | null = null;
  private pageStarts: number[] = [];
  private currentIndex = -1;
  private failedPage: FailedPage | null = null;
  private pageRequest: PageRequest | null = null;
  private statusMessage = "Select a node to open its original bytes.";
  private busy = false;
  private active = false;
  private representation: Representation = "lossy";
  private epoch = 0;

  constructor(options: RawViewOptions) {
    this.panel = options.panel;
    this.tab = options.tab;
    this.onError = options.onError;
    this.invoke = options.invoke ?? invoke;

    const header = document.createElement("div");
    header.className = "raw-header";
    this.scopeLabel = document.createElement("strong");
    this.scopeLabel.className = "raw-scope";
    header.append(this.scopeLabel);

    const controls = document.createElement("div");
    controls.className = "raw-controls";
    this.previous = document.createElement("button");
    this.previous.className = "secondary-button";
    this.previous.type = "button";
    this.previous.textContent = "Previous";
    this.next = document.createElement("button");
    this.next.className = "secondary-button";
    this.next.type = "button";
    this.next.textContent = "Next";
    this.retry = document.createElement("button");
    this.retry.className = "secondary-button";
    this.retry.type = "button";
    this.retry.textContent = "Retry";
    controls.append(this.previous, this.next, this.retry);
    header.append(controls);

    this.representationTabs = document.createElement("div");
    this.representationTabs.className = "view-tabs raw-representation-tabs";
    this.representationTabs.setAttribute("role", "tablist");
    this.representationTabs.setAttribute("aria-label", "Invalid UTF-8 representation");
    this.lossyTab = document.createElement("button");
    this.lossyTab.className = "view-tab";
    this.lossyTab.type = "button";
    this.lossyTab.setAttribute("role", "tab");
    this.lossyTab.id = "raw-lossy-tab";
    this.lossyTab.setAttribute("aria-controls", "raw-chunk");
    this.lossyTab.textContent = "Lossy Text";
    this.hexTab = document.createElement("button");
    this.hexTab.className = "view-tab";
    this.hexTab.type = "button";
    this.hexTab.setAttribute("role", "tab");
    this.hexTab.id = "raw-hex-tab";
    this.hexTab.setAttribute("aria-controls", "raw-chunk");
    this.hexTab.textContent = "Hex";
    this.representationTabs.append(this.lossyTab, this.hexTab);
    this.representationNote = document.createElement("div");
    this.representationNote.className = "raw-representation-note";
    this.representationNote.setAttribute("role", "note");

    this.pageLabel = document.createElement("div");
    this.pageLabel.className = "raw-page-label";
    this.status = document.createElement("div");
    this.status.className = "raw-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.pre = document.createElement("pre");
    this.pre.className = "raw-chunk";
    this.pre.id = "raw-chunk";
    this.pre.tabIndex = 0;

    this.panel.replaceChildren(header, this.representationTabs, this.representationNote, this.pageLabel, this.status, this.pre);
    this.previous.addEventListener("click", () => {
      this.previous.focus();
      this.previousPage();
    });
    this.next.addEventListener("click", () => {
      this.next.focus();
      this.nextPage();
    });
    this.retry.addEventListener("click", () => {
      this.retry.focus();
      this.retryPage();
    });
    this.lossyTab.addEventListener("click", () => {
      this.lossyTab.focus();
      this.setRepresentation("lossy");
    });
    this.hexTab.addEventListener("click", () => {
      this.hexTab.focus();
      this.setRepresentation("hex");
    });
    this.representationTabs.addEventListener("keydown", (event) => this.handleRepresentationKeydown(event));
    this.clear();
  }

  setSession(revision: number, root: NodeDto | null, sourceSize?: number, sourceKind: RawSourceKind = "document"): void {
    this.epoch += 1;
    this.session = root ? { revision } : null;
    const size = sourceSize !== undefined && safeNonNegativeInteger(sourceSize) ? sourceSize : root?.spanEnd ?? 0;
    this.baseScope = root ? { kind: "source", source: sourceKind, size } : null;
    this.scope = root ? { kind: "node", node: root, source: sourceKind } : null;
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages(root ? "Select Raw to load the original bytes." : "Select a valid node to open its original bytes.");
    this.render();
    if (root && this.active) this.requestPage(root.spanStart, 0);
  }

  setItemSession(revision: number, item: NodeDto, sourceSize: number, sourceKind: RawSourceKind = "collection"): void {
    if (!safeNonNegativeInteger(sourceSize) || item.spanEnd > sourceSize) {
      this.clear("The selected Item span is invalid.");
      return;
    }
    this.epoch += 1;
    this.session = { revision };
    this.baseScope = { kind: "node", node: item, source: sourceKind };
    this.scope = this.baseScope;
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages("Select Raw to load the original Item bytes.");
    this.render();
    if (this.active) this.requestPage(item.spanStart, 0);
  }

  setNonValidEntry(revision: number, entry: EntryDto): boolean {
    const scope = entryBytesScope(entry);
    if (!scope) {
      this.clear("Raw bytes are unavailable because the Entry location is invalid.");
      return false;
    }
    this.epoch += 1;
    this.session = { revision };
    this.baseScope = scope;
    this.scope = this.baseScope;
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages("Select Raw to load the original Entry bytes.");
    this.render();
    if (this.active) this.requestPage(0, 0);
    return true;
  }

  setRawDocument(revision: number, size: unknown, documentError: unknown): boolean {
    const scope = rawDocumentScope(size, documentError);
    if (!scope) {
      this.clear("Raw-only Document metadata is invalid.");
      return false;
    }
    this.epoch += 1;
    this.session = { revision };
    this.baseScope = scope;
    this.scope = this.baseScope;
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages("Select Raw to load the original file bytes.");
    if (scope.size === 0) {
      this.pageStarts = [0];
      this.currentIndex = 0;
      this.pageStart = 0;
      this.pageEnd = 0;
      this.text = "";
      this.statusMessage = "Empty raw-only Document.";
    }
    this.render();
    if (scope.size > 0 && this.active) this.requestPage(0, 0);
    return true;
  }

  clear(reason?: string): void {
    this.epoch += 1;
    this.session = null;
    this.baseScope = null;
    this.scope = null;
    this.reveal = null;
    this.resetPages(reason ?? "Select a node to open its original bytes.");
    this.render();
  }

  setScope(node: NodeDto): void {
    if (!this.session) return;
    this.epoch += 1;
    this.scope = { kind: "node", node, source: rawSourceKind(this.baseScope) ?? "document" };
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages("Select Raw to load the original bytes.");
    this.render();
    if (this.active) this.requestPage(node.spanStart, 0);
  }

  revealRange(start: number, end: number, label: string): void {
    const base = this.baseScope;
    if (!base || !safeNonNegativeInteger(start) || !safeNonNegativeInteger(end)
      || start >= end || start < scopeStart(base) || end > scopeEnd(base)) {
      this.statusMessage = "The requested Raw match is outside the current scope.";
      this.render();
      return;
    }
    this.epoch += 1;
    this.scope = base;
    this.reveal = { start, end, label };
    this.resetPages(`Seeking to ${label}…`);
    this.render();
    if (this.active) this.requestPage(start, 0);
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.render();
    if (!busy && this.active && this.session && this.scope && this.text === null && this.displayBytes === null && !this.pageRequest && !this.failedPage) {
      this.requestPage(this.reveal?.start ?? scopeStart(this.scope), 0);
    }
  }

  activate(): void {
    this.active = true;
    if (!this.session || !this.scope || this.pageRequest || this.text !== null || this.displayBytes !== null || this.failedPage) {
      this.render();
      return;
    }
    this.requestPage(this.reveal?.start ?? scopeStart(this.scope), 0);
  }

  deactivate(): void {
    this.active = false;
  }

  private setRepresentation(representation: Representation): void {
    const invalidUtf8 = this.scope?.kind === "entryBytes" && this.scope.status === "invalidUtf8"
      || this.scope?.kind === "rawDocument" && this.scope.encoding === "invalidUtf8";
    if (this.busy || !invalidUtf8) return;
    if (this.representation === representation) return;
    this.representation = representation;
    if (this.displayBytes) {
      this.text = representation === "hex"
        ? formatHex(this.pageStart ?? 0, this.displayBytes)
        : new TextDecoder("utf-8", { fatal: false }).decode(this.displayBytes);
    }
    this.render();
  }

  private handleRepresentationKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    let representation: Representation | null = null;
    if (event.key === "Home") representation = "lossy";
    if (event.key === "End") representation = "hex";
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      representation = this.representation === "lossy" ? "hex" : "lossy";
    }
    if (!representation) return;
    event.preventDefault();
    if (this.busy) return;
    this.setRepresentation(representation);
    (representation === "lossy" ? this.lossyTab : this.hexTab).focus();
  }

  private resetPages(statusMessage: string): void {
    this.text = null;
    this.pageStart = null;
    this.pageEnd = null;
    this.displayBytes = null;
    this.pageStarts = [];
    this.currentIndex = -1;
    this.failedPage = null;
    this.pageRequest = null;
    this.statusMessage = statusMessage;
  }

  private requestPage(offset: number, historyIndex: number): void {
    const session = this.session;
    const scope = this.scope;
    if (!session || !scope || this.busy || this.pageRequest) return;
    if (offset < scopeStart(scope) || offset >= scopeEnd(scope)) {
      this.failPage("The requested Raw page is outside the scope.");
      return;
    }
    this.failedPage = null;
    const request: PageRequest = {
      epoch: this.epoch,
      revision: session.revision,
      offset,
      historyIndex,
      restoreControl: this.focusedControl(),
      scopeKind: scope.kind,
      scopeStart: scopeStart(scope),
      scopeEnd: scopeEnd(scope)
    };
    this.pageRequest = request;
    this.statusMessage = "Loading raw bytes…";
    this.render();
    void this.loadPage(request);
  }

  private async loadPage(request: PageRequest): Promise<void> {
    const scope = this.scope;
    if (!scope) return;
    try {
      const remaining = request.scopeEnd - request.offset;
      const requestedLength = Math.min(PAGE_BYTES, remaining);
      const selectedEntryBytes = scope.kind === "entryBytes"
        || scope.kind === "source" && scope.source === "entry";
      const rawDocumentBytes = scope.kind === "rawDocument";
      if (selectedEntryBytes || rawDocumentBytes) {
        const value = selectedEntryBytes
          ? await this.invoke<unknown>("read_selected_entry_window", {
            offset: request.offset,
            length: requestedLength,
            sessionRevision: request.revision
          })
          : await this.invoke<unknown>("read_raw_document_bytes", {
            offset: request.offset,
            length: requestedLength,
            sessionRevision: request.revision
          });
        const byteStatus = scope.kind === "entryBytes"
          ? scope.status
          : scope.kind === "rawDocument" && scope.encoding === "invalidUtf8" ? "invalidUtf8" : "invalidJson";
        if (!this.isCurrent(request)) return;
        const result = decodeRawBytePage(
          value,
          request,
          byteStatus === "invalidUtf8" || byteStatus === "oversized" ? "invalidUtf8" : "invalidJson"
        );
        if ("error" in result) {
          this.failPage(result.error);
          return;
        }
        this.commitPage(request, result);
        return;
      }

      const chunk = await this.invoke<TextChunkDto>("read_raw_slice", {
        sourceStart: request.offset,
        length: requestedLength,
        sessionRevision: request.revision
      });
      if (!this.isCurrent(request)) return;
      if (!Number.isSafeInteger(chunk.start) || chunk.start !== request.offset || typeof chunk.text !== "string") {
        this.failPage("Raw response did not match the requested byte range.");
        return;
      }
      const encodedLength = new TextEncoder().encode(chunk.text).byteLength;
      if (encodedLength <= 0 || encodedLength > requestedLength) {
        this.failPage("Raw response length did not match the requested byte range.");
        return;
      }
      if (chunk.nextOffset !== null && (!Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= request.offset)) {
        this.failPage("Raw response returned a non-monotonic next offset.");
        return;
      }
      if (chunk.nextOffset !== null && chunk.nextOffset > request.scopeEnd) {
        this.failPage("Raw response exceeded the node span.");
        return;
      }
      if (!chunk.hasMore && chunk.nextOffset !== null) {
        this.failPage("Raw response returned an unexpected next offset.");
        return;
      }
      if (chunk.hasMore && chunk.nextOffset === null) {
        this.failPage("Raw response omitted the next offset for a paged chunk.");
        return;
      }
      const pageEnd = Math.min(chunk.nextOffset ?? request.scopeEnd, request.scopeEnd);
      if (request.offset > Number.MAX_SAFE_INTEGER - encodedLength || request.offset + encodedLength !== pageEnd) {
        this.failPage("Raw response bytes did not reach the reported next offset.");
        return;
      }
      if (pageEnd <= request.offset && request.scopeEnd > request.offset) {
        this.failPage("Raw response did not advance within the node span.");
        return;
      }
      this.commitPage(request, { text: chunk.text, pageEnd });
    } catch (error) {
      if (!this.isCurrent(request)) return;
      this.failPage(errorMessage(error), error);
    }
  }

  private commitPage(request: PageRequest, result: RawPageResult): void {
    if (request.historyIndex > this.pageStarts.length) {
      this.failPage("Raw page history is not contiguous.");
      return;
    }
    if (request.historyIndex === this.pageStarts.length) this.pageStarts.push(request.offset);
    else if (this.pageStarts[request.historyIndex] !== request.offset) {
      this.failPage("Raw page history changed unexpectedly.");
      return;
    }
    const knownNext = this.pageStarts[request.historyIndex + 1];
    if (knownNext !== undefined && knownNext !== result.pageEnd) {
      this.failPage("Raw page boundary changed unexpectedly.");
      return;
    }
    this.pageRequest = null;
    this.failedPage = null;
    this.currentIndex = request.historyIndex;
    this.pageStart = request.offset;
    this.pageEnd = result.pageEnd;
    this.displayBytes = result.displayBytes ?? null;
    this.text = this.displayBytes && this.representation === "hex"
      ? formatHex(request.offset, this.displayBytes)
      : result.text;
    this.statusMessage = request.scopeKind === "entryBytes" && this.scope?.kind === "entryBytes"
      ? this.scope.status === "invalidUtf8"
        ? "Original bytes · representation only"
        : this.scope.status === "oversized"
          ? "Raw preview loaded."
          : "Original UTF-8 Entry bytes · not reformatted"
      : request.scopeKind === "rawDocument" && this.scope?.kind === "rawDocument"
        ? this.scope.encoding === "invalidUtf8"
          ? "Original bytes · representation only"
          : "Original file bytes · not reformatted"
      : request.scopeKind === "source" && this.scope?.kind === "source" && this.scope.source === "entry"
        ? "Original UTF-8 Entry bytes · not reformatted"
        : result.pageEnd < request.scopeEnd ? "Raw bytes loaded." : "End of raw scope.";
    this.render();
    this.restoreControl(request, true);
    if (this.reveal && request.offset < this.reveal.end && result.pageEnd > this.reveal.start) {
      queueMicrotask(() => {
        if (this.active && this.pageStart === request.offset && this.pageEnd === result.pageEnd) this.pre.focus();
      });
    }
  }

  private previousPage(): void {
    if (this.busy || this.pageRequest || this.currentIndex <= 0) return;
    this.requestPage(this.pageStarts[this.currentIndex - 1], this.currentIndex - 1);
  }

  private nextPage(): void {
    const scope = this.scope;
    if (this.busy || this.pageRequest || !scope || this.pageEnd === null || this.pageEnd >= scopeEnd(scope)) return;
    const nextIndex = this.currentIndex + 1;
    const knownOffset = this.pageStarts[nextIndex];
    this.requestPage(knownOffset ?? this.pageEnd, nextIndex);
  }

  private retryPage(): void {
    if (this.busy || this.pageRequest || !this.failedPage) return;
    const failed = this.failedPage;
    this.requestPage(failed.offset, failed.historyIndex);
  }

  private failPage(message: string, error?: unknown): void {
    const request = this.pageRequest;
    if (request) this.failedPage = { offset: request.offset, historyIndex: request.historyIndex };
    this.pageRequest = null;
    this.statusMessage = message;
    this.render();
    if (!error || !isGlobalError(error)) this.restoreControl(request, false);
    if (error && isGlobalError(error)) this.onError(error);
  }

  private focusedControl(): FocusControl {
    const focused = document.activeElement;
    if (focused === this.previous) return "previous";
    if (focused === this.next) return "next";
    if (focused === this.retry) return "retry";
    return null;
  }

  private restoreControl(request: PageRequest | null, succeeded: boolean): void {
    if (!request?.restoreControl || !this.active) return;
    const originalControl = this.controlFor(request.restoreControl);
    if (document.activeElement !== document.body && document.activeElement !== document.documentElement && document.activeElement !== originalControl) return;
    let control = originalControl;
    if (succeeded && (control.disabled || control.hidden)) {
      control = [this.previous, this.next].find((candidate) => !candidate.disabled && !candidate.hidden) ?? this.tab;
    }
    if (control.disabled || control.hidden) return;
    queueMicrotask(() => {
      if (!this.active || (document.activeElement !== document.body && document.activeElement !== document.documentElement && document.activeElement !== originalControl)) return;
      control.focus();
    });
  }

  private controlFor(control: Exclude<FocusControl, null>): HTMLButtonElement {
    if (control === "previous") return this.previous;
    if (control === "next") return this.next;
    return this.retry;
  }

  private render(): void {
    const scope = this.scope;
    const busy = this.busy || this.pageRequest !== null;
    const invalidUtf8 = (scope?.kind === "entryBytes" && scope.status === "invalidUtf8")
      || (scope?.kind === "rawDocument" && scope.encoding === "invalidUtf8");
    const oversized = scope?.kind === "entryBytes" && scope.status === "oversized";
    this.tab.disabled = this.session === null || scope === null;
    this.tab.setAttribute("aria-disabled", String(this.tab.disabled));
    this.panel.setAttribute("aria-busy", String(busy));
    this.scopeLabel.textContent = scopeLabel(scope);
    this.pageLabel.textContent = this.pageStart !== null && this.pageEnd !== null && scope
      ? pageLabel(scope, this.pageStart, this.pageEnd)
      : "No raw chunk loaded.";
    this.status.textContent = this.statusMessage;
    this.representationTabs.hidden = !invalidUtf8;
    this.lossyTab.setAttribute("aria-selected", String(this.representation === "lossy"));
    this.hexTab.setAttribute("aria-selected", String(this.representation === "hex"));
    this.lossyTab.classList.toggle("is-active", this.representation === "lossy");
    this.hexTab.classList.toggle("is-active", this.representation === "hex");
    this.lossyTab.tabIndex = this.representation === "lossy" ? 0 : -1;
    this.hexTab.tabIndex = this.representation === "hex" ? 0 : -1;
    this.representationNote.hidden = !invalidUtf8 && !oversized;
    this.representationNote.textContent = invalidUtf8
      ? this.representation === "lossy"
        ? "This is a lossy preview. The source bytes have not been modified."
        : "Original bytes · 16 bytes per row"
      : oversized
        ? "Oversized Entry · showing one bounded 128 KiB raw window. Source bytes have not been modified."
        : "";
    this.pre.hidden = this.text === null && this.displayBytes === null;
    this.pre.replaceChildren();
    if (this.text !== null) {
      renderRawText(this.pre, this.text, this.pageStart, this.pageEnd, this.displayBytes, this.reveal, this.representation);
    }
    this.pre.setAttribute("aria-label", preLabel(scope, this.representation));
    if (invalidUtf8) {
      this.pre.setAttribute("role", "tabpanel");
      this.pre.setAttribute("aria-labelledby", this.representation === "lossy" ? this.lossyTab.id : this.hexTab.id);
    } else {
      this.pre.removeAttribute("role");
      this.pre.removeAttribute("aria-labelledby");
    }
    this.previous.hidden = false;
    this.next.hidden = false;
    this.previous.disabled = busy || this.currentIndex <= 0;
    this.next.disabled = busy || scope === null || this.pageEnd === null || this.pageEnd >= scopeEnd(scope);
    this.retry.hidden = this.failedPage === null;
    this.retry.disabled = busy || this.failedPage === null;
  }

  private isCurrent(request: PageRequest): boolean {
    const scope = this.scope;
    return this.pageRequest === request &&
      this.epoch === request.epoch &&
      this.session?.revision === request.revision &&
      scope?.kind === request.scopeKind &&
      scopeStart(scope) === request.scopeStart &&
      scopeEnd(scope) === request.scopeEnd;
  }
}

function rawDocumentScope(size: unknown, documentError: unknown): RawDocumentScope | null {
  if (!safeNonNegativeInteger(size) || !isRecord(documentError)) return null;
  const code = Reflect.get(documentError, "code");
  const message = Reflect.get(documentError, "message");
  if (typeof code !== "string" || typeof message !== "string") return null;
  const parseError = Reflect.get(documentError, "parseError");
  if (code === "invalid_json" && isRecord(parseError)) {
    return { kind: "rawDocument", size, encoding: "utf8" };
  }
  if (code === "unsupported_encoding" && (parseError === undefined || parseError === null)) {
    return { kind: "rawDocument", size, encoding: "invalidUtf8" };
  }
  return null;
}

function entryBytesScope(entry: unknown): EntryBytesScope | null {
  if (!isRecord(entry) || (entry.status !== "invalidJson" && entry.status !== "invalidUtf8" && entry.status !== "oversized") || !isRecord(entry.location)) return null;
  const entryOrdinal = entry.location.entryOrdinal;
  const sourceLine = entry.location.sourceLine;
  const byteStart = entry.location.byteStart;
  const byteEnd = entry.location.byteEnd;
  if (!safeNonNegativeInteger(entryOrdinal) || !safeNonNegativeInteger(sourceLine) || sourceLine < 1 || !safeNonNegativeInteger(byteStart) || !safeNonNegativeInteger(byteEnd) || byteEnd <= byteStart) {
    return null;
  }
  const length = byteEnd - byteStart;
  if (entry.status === "oversized" ? length <= MAX_ENTRY_BYTES : length > MAX_ENTRY_BYTES) return null;
  return { kind: "entryBytes", status: entry.status, entryOrdinal, sourceLine, byteStart, byteEnd };
}

function decodeRawBytePage(
  value: unknown,
  request: PageRequest,
  status: "invalidJson" | "invalidUtf8"
): RawPageResult | { error: string } {
  if (!isRecord(value)) return { error: "Raw byte response was not an object." };
  const start = value.start;
  const rawBytes = value.bytes;
  const hasMore = value.hasMore;
  const nextOffset = value.nextOffset;
  if (!safeNonNegativeInteger(start) || start !== request.offset) {
    return { error: "Raw byte response did not match the requested offset." };
  }
  if (!Array.isArray(rawBytes)) return { error: "Raw byte response bytes were not an array." };
  const requestedLength = Math.min(PAGE_BYTES, request.scopeEnd - request.offset);
  if (rawBytes.length <= 0 || rawBytes.length > requestedLength) {
    return { error: "Raw byte response length was outside the requested range." };
  }
  const bytes = new Uint8Array(rawBytes.length);
  for (let index = 0; index < rawBytes.length; index += 1) {
    const byte = rawBytes[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return { error: "Raw byte response contained an invalid byte." };
    }
    bytes[index] = byte;
  }
  if (typeof hasMore !== "boolean") return { error: "Raw byte response hasMore was invalid." };
  if (nextOffset !== null && !safeNonNegativeInteger(nextOffset)) {
    return { error: "Raw byte response nextOffset was invalid." };
  }
  if (request.offset > Number.MAX_SAFE_INTEGER - bytes.length) {
    return { error: "Raw byte response offset overflowed." };
  }
  const backendEnd = request.offset + bytes.length;
  if (backendEnd > request.scopeEnd) return { error: "Raw byte response exceeded the scope." };
  const expectedHasMore = backendEnd < request.scopeEnd;
  if (hasMore !== expectedHasMore) return { error: "Raw byte response hasMore did not match its range." };
  const expectedNextOffset = expectedHasMore ? backendEnd : null;
  if (nextOffset !== expectedNextOffset) return { error: "Raw byte response nextOffset did not match its range." };

  if (status === "invalidUtf8") {
    const prefixLength = hasMore ? lossyBoundaryPrefix(bytes) : null;
    if (prefixLength === 0) return { error: "Raw byte chunk cannot advance at a UTF-8 boundary." };
    const displayBytes = prefixLength === null ? bytes : bytes.slice(0, prefixLength);
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(displayBytes),
      pageEnd: prefixLength === null ? backendEnd : request.offset + prefixLength,
      displayBytes
    };
  }

  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), pageEnd: backendEnd };
  } catch {
    if (!hasMore) return { error: "Raw byte chunk ended inside an invalid UTF-8 scalar." };
    for (let trim = 1; trim <= 3; trim += 1) {
      const prefixLength = bytes.length - trim;
      if (prefixLength <= 0) break;
      try {
        const displayBytes = bytes.slice(0, prefixLength);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(displayBytes);
        return { text, pageEnd: request.offset + prefixLength };
      } catch {
        // Try the next possible UTF-8 suffix length.
      }
    }
    return { error: "Raw byte chunk could not be decoded at a UTF-8 boundary." };
  }
}

function lossyBoundaryPrefix(bytes: Uint8Array): number | null {
  for (let tailLength = 1; tailLength <= 3; tailLength += 1) {
    const prefixLength = bytes.length - tailLength;
    if (prefixLength < 0) continue;
    const lead = bytes[prefixLength];
    const width = utf8ScalarWidth(lead);
    if (width === 0 || tailLength >= width) continue;
    if (!utf8ScalarPrefix(bytes, prefixLength, tailLength, width)) continue;
    return prefixLength;
  }
  return null;
}

function utf8ScalarWidth(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

function utf8ScalarPrefix(bytes: Uint8Array, start: number, tailLength: number, width: number): boolean {
  if (tailLength >= width) return false;
  for (let index = start + 1; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte < 0x80 || byte > 0xbf) return false;
    if (index === start + 1) {
      const lead = bytes[start];
      if (lead === 0xe0 && byte < 0xa0) return false;
      if (lead === 0xed && byte > 0x9f) return false;
      if (lead === 0xf0 && byte < 0x90) return false;
      if (lead === 0xf4 && byte > 0x8f) return false;
    }
  }
  return bytes.length - start === tailLength;
}

function scopeStart(scope: RawScope): number {
  return scope.kind === "node" ? scope.node.spanStart : 0;
}

function rawSourceKind(scope: RawScope | null): RawSourceKind | null {
  if (scope?.kind === "node" || scope?.kind === "source") return scope.source;
  if (scope?.kind === "entryBytes") return "entry";
  return null;
}

function scopeEnd(scope: RawScope): number {
  if (scope.kind === "node") return scope.node.spanEnd;
  if (scope.kind === "source") return scope.size;
  return scope.kind === "rawDocument" ? scope.size : scope.byteEnd - scope.byteStart;
}

function scopeLabel(scope: RawScope | null): string {
  if (!scope) return "Raw bytes";
  if (scope.kind === "node") return `Node #${scope.node.id} · [${scope.node.spanStart}, ${scope.node.spanEnd})`;
  if (scope.kind === "source") {
    const label = scope.source === "entry" ? "Entry" : scope.source === "collection" ? "Collection" : "Document";
    return `${label} source · File bytes [0, ${scope.size})`;
  }
  if (scope.kind === "rawDocument") {
    return `Raw-only Document · ${scope.encoding === "invalidUtf8" ? "Invalid UTF-8" : "Invalid JSON"} · File bytes [0, ${scope.size})`;
  }
  return `Entry ${scope.entryOrdinal + 1} · ${scope.status === "invalidJson" ? "Invalid JSON" : scope.status === "invalidUtf8" ? "Invalid UTF-8" : "Oversized Entry"} · Entry bytes [0, ${scopeEnd(scope)})`;
}

function pageLabel(scope: RawScope, start: number, end: number): string {
  if (scope.kind === "node") return `Bytes [${start}, ${end}) of [${scope.node.spanStart}, ${scope.node.spanEnd})`;
  if (scope.kind === "source" && scope.source !== "entry") return `Bytes [${start}, ${end}) of File [0, ${scope.size})`;
  if (scope.kind === "source") return `Bytes [${start}, ${end}) of Entry [0, ${scope.size})`;
  if (scope.kind === "rawDocument") return `Bytes [${start}, ${end}) of File [0, ${scope.size})`;
  return `Bytes [${start}, ${end}) of Entry [0, ${scopeEnd(scope)})`;
}

function preLabel(scope: RawScope | null, representation: Representation): string {
  if (!scope) return "Raw UTF-8 bytes";
  if (scope.kind === "node") return `Raw UTF-8 bytes for Node #${scope.node.id}`;
  if (scope.kind === "source") return scope.source === "entry"
    ? "Raw UTF-8 bytes for selected Entry"
    : `Raw UTF-8 bytes for ${scope.source === "collection" ? "Collection" : "Document"}`;
  if (scope.kind === "rawDocument") {
    return scope.encoding === "invalidUtf8"
      ? scopeStatusRepresentation(scope, representation)
      : "Raw UTF-8 bytes for invalid JSON document";
  }
  if (scope.status === "invalidUtf8") return scopeStatusRepresentation(scope, representation);
  if (scope.status === "oversized") return `Raw bytes for oversized Entry ${scope.entryOrdinal + 1}`;
  return `Raw UTF-8 bytes for Entry ${scope.entryOrdinal + 1}`;
}

function scopeStatusRepresentation(scope: EntryBytesScope | RawDocumentScope, representation: Representation): string {
  const subject = scope.kind === "rawDocument" ? "Raw-only Document" : `Entry ${scope.entryOrdinal + 1}`;
  return representation === "hex"
    ? `Hex bytes for ${subject}`
    : `Lossy UTF-8 preview for ${subject}`;
}

function formatHex(start: number, bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, "0"));
    const ascii = Array.from(row, (byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${(start + offset).toString(16).padStart(8, "0")}  ${hex.join(" ").padEnd(16 * 3 - 1, " ")}  |${ascii.padEnd(16, " ")}|`);
  }
  return lines.join("\n");
}

function renderRawText(
  pre: HTMLPreElement,
  text: string,
  pageStart: number | null,
  pageEnd: number | null,
  displayBytes: Uint8Array | null,
  reveal: RevealRange | null,
  representation: Representation
): void {
  if (pageStart === null || pageEnd === null || reveal === null) {
    pre.textContent = text;
    return;
  }
  const start = Math.max(pageStart, reveal.start);
  const end = Math.min(pageEnd, reveal.end);
  if (start >= end) {
    pre.textContent = text;
    return;
  }
  if (displayBytes && representation === "hex") {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      const lineStart = pageStart + index * 16;
      const lineEnd = Math.min(pageEnd, lineStart + 16);
      appendMarkedPart(pre, line, lineStart < end && lineEnd > start, reveal.label);
      if (index + 1 < lines.length) pre.append(document.createTextNode("\n"));
    });
    return;
  }
  const encoded = new TextEncoder();
  const localStart = Math.max(0, start - pageStart);
  const localEnd = Math.max(localStart, Math.min(encoded.encode(text).byteLength, end - pageStart));
  let byteOffset = 0;
  let codeUnitOffset = 0;
  let markerStart: number | null = null;
  let markerEnd = 0;
  for (const character of text) {
    const byteLength = encoded.encode(character).byteLength;
    const nextByteOffset = byteOffset + byteLength;
    if (markerStart === null && nextByteOffset > localStart) markerStart = codeUnitOffset;
    if (markerStart !== null && byteOffset < localEnd) markerEnd = codeUnitOffset + character.length;
    byteOffset = nextByteOffset;
    codeUnitOffset += character.length;
  }
  if (markerStart === null || markerEnd <= markerStart) {
    appendMarkedPart(pre, text, true, reveal.label);
    return;
  }
  pre.append(document.createTextNode(text.slice(0, markerStart)));
  const marker = document.createElement("mark");
  marker.title = reveal.label;
  marker.textContent = text.slice(markerStart, markerEnd);
  pre.append(marker);
  pre.append(document.createTextNode(text.slice(markerEnd)));
}

function appendMarkedPart(parent: HTMLElement, text: string, marked: boolean, label: string): void {
  if (!marked) {
    parent.append(document.createTextNode(text));
    return;
  }
  const marker = document.createElement("mark");
  marker.title = label;
  marker.textContent = text;
  parent.append(marker);
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGlobalError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "stale_session" || code === "file_changed";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return message;
  }
  if (error instanceof Error) return error.message;
  return "Raw bytes could not be loaded.";
}
