import { invoke } from "@tauri-apps/api/core";
import type { EntryDto } from "./entry-list";
import type { NodeDto } from "./tree-view";
import { t } from "./i18n";

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
  private readonly copyRaw: HTMLButtonElement;
  private readonly copyHex: HTMLButtonElement;
  private readonly copyLossy: HTMLButtonElement;
  private readonly copyStatus: HTMLElement;
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
  private statusMessage = t("raw.selectNodeOriginalBytes");
  private busy = false;
  private active = false;
  private representation: Representation = "lossy";
  private epoch = 0;
  private copyEpoch = 0;
  private copyBusy = false;

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
    this.previous.textContent = t("raw.previous");
    this.next = document.createElement("button");
    this.next.className = "secondary-button";
    this.next.type = "button";
    this.next.textContent = t("raw.next");
    this.retry = document.createElement("button");
    this.retry.className = "secondary-button";
    this.retry.type = "button";
    this.retry.textContent = t("raw.retry");
    controls.append(this.previous, this.next, this.retry);
    this.copyRaw = document.createElement("button");
    this.copyRaw.className = "secondary-button";
    this.copyRaw.type = "button";
    this.copyRaw.textContent = t("raw.copyRaw");
    this.copyHex = document.createElement("button");
    this.copyHex.className = "secondary-button";
    this.copyHex.type = "button";
    this.copyHex.textContent = t("raw.copyHex");
    this.copyLossy = document.createElement("button");
    this.copyLossy.className = "secondary-button";
    this.copyLossy.type = "button";
    this.copyLossy.textContent = t("raw.copyLossy");
    controls.append(this.copyRaw, this.copyHex, this.copyLossy);
    header.append(controls);
    this.copyStatus = document.createElement("span");
    this.copyStatus.className = "copy-status";
    this.copyStatus.setAttribute("role", "status");
    this.copyStatus.setAttribute("aria-live", "polite");

    this.representationTabs = document.createElement("div");
    this.representationTabs.className = "view-tabs raw-representation-tabs";
    this.representationTabs.setAttribute("role", "tablist");
    this.representationTabs.setAttribute("aria-label", t("raw.invalidUtf8Representation"));
    this.lossyTab = document.createElement("button");
    this.lossyTab.className = "view-tab";
    this.lossyTab.type = "button";
    this.lossyTab.setAttribute("role", "tab");
    this.lossyTab.id = "raw-lossy-tab";
    this.lossyTab.setAttribute("aria-controls", "raw-chunk");
    this.lossyTab.textContent = t("raw.lossyText");
    this.hexTab = document.createElement("button");
    this.hexTab.className = "view-tab";
    this.hexTab.type = "button";
    this.hexTab.setAttribute("role", "tab");
    this.hexTab.id = "raw-hex-tab";
    this.hexTab.setAttribute("aria-controls", "raw-chunk");
    this.hexTab.textContent = t("raw.hex");
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

    this.panel.replaceChildren(header, this.copyStatus, this.representationTabs, this.representationNote, this.pageLabel, this.status, this.pre);
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
    this.copyRaw.addEventListener("click", () => void this.copyNodeRaw());
    this.copyHex.addEventListener("click", () => void this.copyCurrentBytes("hex"));
    this.copyLossy.addEventListener("click", () => void this.copyCurrentBytes("lossy"));
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
    this.copyEpoch += 1;
    this.copyBusy = false;
    this.copyStatus.textContent = "";
    this.session = root ? { revision } : null;
    const size = sourceSize !== undefined && safeNonNegativeInteger(sourceSize) ? sourceSize : root?.spanEnd ?? 0;
    this.baseScope = root ? { kind: "source", source: sourceKind, size } : null;
    this.scope = root ? { kind: "node", node: root, source: sourceKind } : null;
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages(root ? t("raw.selectRawOriginalBytes") : t("raw.selectValidNode"));
    this.render();
    if (root && this.active) this.requestPage(root.spanStart, 0);
  }

  setItemSession(revision: number, item: NodeDto, sourceSize: number, sourceKind: RawSourceKind = "collection"): void {
    if (!safeNonNegativeInteger(sourceSize) || item.spanEnd > sourceSize) {
      this.clear(t("raw.selectedItemSpanInvalid"));
      return;
    }
    this.epoch += 1;
    this.copyEpoch += 1;
    this.copyBusy = false;
    this.copyStatus.textContent = "";
    this.session = { revision };
    this.baseScope = { kind: "node", node: item, source: sourceKind };
    this.scope = this.baseScope;
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages(t("raw.selectItemOriginalBytes"));
    this.render();
    if (this.active) this.requestPage(item.spanStart, 0);
  }

  setNonValidEntry(revision: number, entry: EntryDto): boolean {
    const scope = entryBytesScope(entry);
    if (!scope) {
      this.clear(t("raw.entryLocationInvalid"));
      return false;
    }
    this.epoch += 1;
    this.copyEpoch += 1;
    this.copyBusy = false;
    this.copyStatus.textContent = "";
    this.session = { revision };
    this.baseScope = scope;
    this.scope = this.baseScope;
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages(t("raw.selectEntryOriginalBytes"));
    this.render();
    if (this.active) this.requestPage(0, 0);
    return true;
  }

  setRawDocument(revision: number, size: unknown, documentError: unknown): boolean {
    const scope = rawDocumentScope(size, documentError);
    if (!scope) {
      this.clear(t("raw.rawOnlyMetadataInvalid"));
      return false;
    }
    this.epoch += 1;
    this.copyEpoch += 1;
    this.copyBusy = false;
    this.copyStatus.textContent = "";
    this.session = { revision };
    this.baseScope = scope;
    this.scope = this.baseScope;
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages(t("raw.selectFileOriginalBytes"));
    if (scope.size === 0) {
      this.pageStarts = [0];
      this.currentIndex = 0;
      this.pageStart = 0;
      this.pageEnd = 0;
      this.text = "";
      this.statusMessage = t("raw.emptyRawOnlyDocument");
    }
    this.render();
    if (scope.size > 0 && this.active) this.requestPage(0, 0);
    return true;
  }

  clear(reason?: string): void {
    this.epoch += 1;
    this.copyEpoch += 1;
    this.copyBusy = false;
    this.copyStatus.textContent = "";
    this.session = null;
    this.baseScope = null;
    this.scope = null;
    this.reveal = null;
    this.resetPages(reason ?? t("raw.selectNodeOriginalBytes"));
    this.render();
  }

  setScope(node: NodeDto): void {
    if (!this.session) return;
    this.epoch += 1;
    this.copyEpoch += 1;
    this.copyBusy = false;
    this.copyStatus.textContent = "";
    this.scope = { kind: "node", node, source: rawSourceKind(this.baseScope) ?? "document" };
    this.reveal = null;
    this.representation = "lossy";
    this.resetPages(t("raw.selectRawOriginalBytes"));
    this.render();
    if (this.active) this.requestPage(node.spanStart, 0);
  }

  revealRange(start: number, end: number, label: string): void {
    const base = this.baseScope;
    if (!base || !safeNonNegativeInteger(start) || !safeNonNegativeInteger(end)
      || start >= end || start < scopeStart(base) || end > scopeEnd(base)) {
      this.statusMessage = t("raw.requestedMatchOutside");
      this.render();
      return;
    }
    this.epoch += 1;
    this.copyEpoch += 1;
    this.copyBusy = false;
    this.copyStatus.textContent = "";
    this.scope = base;
    this.reveal = { start, end, label };
    this.resetPages(t("raw.seeking", { label }));
    this.render();
    if (this.active) this.requestPage(start, 0);
  }

  private async copyNodeRaw(): Promise<void> {
    const session = this.session;
    const scope = this.scope;
    if (!session || !scope || scope.kind !== "node" || this.copyBusy) return;
    const copyEpoch = this.copyEpoch;
    const revision = session.revision;
    const nodeId = scope.node.id;
    this.copyBusy = true;
    this.copyStatus.textContent = t("raw.copying");
    this.render();
    try {
      await this.invoke("copy_node", {
        nodeId,
        scopeId: null,
        sessionRevision: revision,
        format: "raw"
      });
      if (!this.isCopyCurrent(copyEpoch, revision, scope)) return;
      this.copyStatus.textContent = t("raw.copiedRaw");
    } catch (error) {
      if (!this.isCopyCurrent(copyEpoch, revision, scope)) return;
      if (isGlobalError(error)) this.onError(error);
      else this.copyStatus.textContent = t("raw.copyFailed", { message: errorMessage(error) });
    } finally {
      if (this.isCopyCurrent(copyEpoch, revision, scope)) {
        this.copyBusy = false;
        this.render();
      }
    }
  }

  private async copyCurrentBytes(format: "hex" | "lossy"): Promise<void> {
    const session = this.session;
    const scope = this.scope;
    if (!session || !scope || scope.kind !== "entryBytes" && scope.kind !== "rawDocument" || this.copyBusy) return;
    const copyEpoch = this.copyEpoch;
    const revision = session.revision;
    this.copyBusy = true;
    this.copyStatus.textContent = t("raw.copying");
    this.render();
    try {
      await this.invoke("copy_current_bytes", { format, sessionRevision: revision });
      if (!this.isCopyCurrent(copyEpoch, revision, scope)) return;
      this.copyStatus.textContent = format === "hex" ? t("raw.copiedHex") : t("raw.copiedLossy");
    } catch (error) {
      if (!this.isCopyCurrent(copyEpoch, revision, scope)) return;
      if (isGlobalError(error)) this.onError(error);
      else this.copyStatus.textContent = t("raw.copyFailed", { message: errorMessage(error) });
    } finally {
      if (this.isCopyCurrent(copyEpoch, revision, scope)) {
        this.copyBusy = false;
        this.render();
      }
    }
  }

  private isCopyCurrent(copyEpoch: number, revision: number, scope: RawScope): boolean {
    const current = this.scope;
    if (this.copyEpoch !== copyEpoch || this.session?.revision !== revision || !current || current.kind !== scope.kind) return false;
    if (current.kind === "node" && scope.kind === "node") return current.node.id === scope.node.id;
    return scopeStart(current) === scopeStart(scope) && scopeEnd(current) === scopeEnd(scope);
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
      this.failPage(t("raw.requestedPageOutside"));
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
    this.statusMessage = t("raw.loading");
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
        this.failPage(t("raw.rawResponseOffset"));
        return;
      }
      const encodedLength = new TextEncoder().encode(chunk.text).byteLength;
      if (encodedLength <= 0 || encodedLength > requestedLength) {
        this.failPage(t("raw.rawResponseLength"));
        return;
      }
      if (chunk.nextOffset !== null && (!Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= request.offset)) {
        this.failPage(t("raw.rawResponseNextOffset"));
        return;
      }
      if (chunk.nextOffset !== null && chunk.nextOffset > request.scopeEnd) {
        this.failPage(t("raw.rawResponseScope"));
        return;
      }
      if (!chunk.hasMore && chunk.nextOffset !== null) {
        this.failPage(t("raw.rawResponseUnexpectedNextOffset"));
        return;
      }
      if (chunk.hasMore && chunk.nextOffset === null) {
        this.failPage(t("raw.rawResponseMissingNextOffset"));
        return;
      }
      const pageEnd = Math.min(chunk.nextOffset ?? request.scopeEnd, request.scopeEnd);
      if (request.offset > Number.MAX_SAFE_INTEGER - encodedLength || request.offset + encodedLength !== pageEnd) {
        this.failPage(t("raw.rawResponseReportedOffset"));
        return;
      }
      if (pageEnd <= request.offset && request.scopeEnd > request.offset) {
        this.failPage(t("raw.rawResponseNoAdvance"));
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
      this.failPage(t("raw.rawPageHistoryNoncontiguous"));
      return;
    }
    if (request.historyIndex === this.pageStarts.length) this.pageStarts.push(request.offset);
    else if (this.pageStarts[request.historyIndex] !== request.offset) {
      this.failPage(t("raw.rawPageHistoryChanged"));
      return;
    }
    const knownNext = this.pageStarts[request.historyIndex + 1];
    if (knownNext !== undefined && knownNext !== result.pageEnd) {
      this.failPage(t("raw.rawPageBoundaryChanged"));
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
        ? t("raw.originalBytesRepresentation")
        : this.scope.status === "oversized"
          ? t("raw.rawPreviewLoaded")
          : t("raw.originalUtf8Entry")
      : request.scopeKind === "rawDocument" && this.scope?.kind === "rawDocument"
        ? this.scope.encoding === "invalidUtf8"
          ? t("raw.originalBytesRepresentation")
          : t("raw.originalFile")
      : request.scopeKind === "source" && this.scope?.kind === "source" && this.scope.source === "entry"
        ? t("raw.originalUtf8Entry")
        : result.pageEnd < request.scopeEnd ? t("raw.rawBytesLoaded") : t("raw.endRawScope");
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
      : t("raw.noRawChunk");
    this.status.textContent = this.statusMessage;
    const nodeCopyAvailable = scope?.kind === "node" && this.session !== null;
    const byteCopyAvailable = (scope?.kind === "entryBytes" || scope?.kind === "rawDocument") && this.session !== null;
    this.copyRaw.hidden = !nodeCopyAvailable;
    this.copyHex.hidden = !byteCopyAvailable;
    this.copyLossy.hidden = !byteCopyAvailable;
    for (const button of [this.copyRaw, this.copyHex, this.copyLossy]) {
      button.disabled = this.copyBusy || busy || button.hidden;
    }
    this.copyStatus.hidden = this.copyStatus.textContent === "";
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
        ? t("raw.lossyPreviewNote")
        : t("raw.originalBytes16")
      : oversized
        ? t("raw.oversizedWindow")
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
  if (!isRecord(value)) return { error: t("raw.rawResponseObject") };
  const start = value.start;
  const rawBytes = value.bytes;
  const hasMore = value.hasMore;
  const nextOffset = value.nextOffset;
  if (!safeNonNegativeInteger(start) || start !== request.offset) {
    return { error: t("raw.rawResponseOffset") };
  }
  if (!Array.isArray(rawBytes)) return { error: t("raw.rawResponseBytesArray") };
  const requestedLength = Math.min(PAGE_BYTES, request.scopeEnd - request.offset);
  if (rawBytes.length <= 0 || rawBytes.length > requestedLength) {
    return { error: t("raw.rawResponseLength") };
  }
  const bytes = new Uint8Array(rawBytes.length);
  for (let index = 0; index < rawBytes.length; index += 1) {
    const byte = rawBytes[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return { error: t("raw.rawResponseInvalidByte") };
    }
    bytes[index] = byte;
  }
  if (typeof hasMore !== "boolean") return { error: t("raw.rawResponseHasMore") };
  if (nextOffset !== null && !safeNonNegativeInteger(nextOffset)) {
    return { error: t("raw.rawResponseNextOffset") };
  }
  if (request.offset > Number.MAX_SAFE_INTEGER - bytes.length) {
    return { error: t("raw.rawResponseOverflow") };
  }
  const backendEnd = request.offset + bytes.length;
  if (backendEnd > request.scopeEnd) return { error: t("raw.rawResponseScope") };
  const expectedHasMore = backendEnd < request.scopeEnd;
  if (hasMore !== expectedHasMore) return { error: t("raw.rawResponseHasMoreRange") };
  const expectedNextOffset = expectedHasMore ? backendEnd : null;
  if (nextOffset !== expectedNextOffset) return { error: t("raw.rawResponseNextOffsetRange") };

  if (status === "invalidUtf8") {
    const prefixLength = hasMore ? lossyBoundaryPrefix(bytes) : null;
    if (prefixLength === 0) return { error: t("raw.rawResponseAdvanceBoundary") };
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
    if (!hasMore) return { error: t("raw.rawResponseEndInvalidScalar") };
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
    return { error: t("raw.rawResponseBoundary") };
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
  if (!scope) return t("raw.scopeRawBytes");
  if (scope.kind === "node") {
    return t("raw.nodeRawBytes", { id: scope.node.id, start: scope.node.spanStart, end: scope.node.spanEnd });
  }
  if (scope.kind === "source") {
    const label = sourceLabel(scope.source);
    return t("raw.sourceLabel", { label, size: scope.size });
  }
  if (scope.kind === "rawDocument") {
    return t("raw.rawOnlyLabel", {
      status: statusLabel(scope.encoding === "invalidUtf8" ? "invalidUtf8" : "invalidJson"),
      size: scope.size
    });
  }
  return t("raw.entryScopeLabel", {
    entry: scope.entryOrdinal + 1,
    status: statusLabel(scope.status),
    size: scopeEnd(scope)
  });
}

function pageLabel(scope: RawScope, start: number, end: number): string {
  if (scope.kind === "node") {
    return t("raw.pageNode", {
      start,
      end,
      nodeStart: scope.node.spanStart,
      nodeEnd: scope.node.spanEnd
    });
  }
  if (scope.kind === "source" && scope.source !== "entry") return t("raw.pageFile", { start, end, size: scope.size });
  if (scope.kind === "source") return t("raw.pageEntry", { start, end, size: scope.size });
  if (scope.kind === "rawDocument") return t("raw.pageFile", { start, end, size: scope.size });
  return t("raw.pageEntry", { start, end, size: scopeEnd(scope) });
}

function preLabel(scope: RawScope | null, representation: Representation): string {
  if (!scope) return t("raw.preUtf8");
  if (scope.kind === "node") return t("raw.preNode", { id: scope.node.id });
  if (scope.kind === "source") return scope.source === "entry"
    ? t("raw.preSelectedEntry")
    : t("raw.preSource", { source: sourceLabel(scope.source) });
  if (scope.kind === "rawDocument") {
    return scope.encoding === "invalidUtf8"
      ? scopeStatusRepresentation(scope, representation)
      : t("raw.preInvalidJson");
  }
  if (scope.status === "invalidUtf8") return scopeStatusRepresentation(scope, representation);
  if (scope.status === "oversized") return t("raw.preOversized", { entry: scope.entryOrdinal + 1 });
  return t("raw.preEntry", { entry: scope.entryOrdinal + 1 });
}

function scopeStatusRepresentation(scope: EntryBytesScope | RawDocumentScope, representation: Representation): string {
  const subject = scope.kind === "rawDocument"
    ? t("raw.rawOnlySubject")
    : t("raw.entrySubject", { entry: scope.entryOrdinal + 1 });
  return representation === "hex"
    ? t("raw.repHex", { subject })
    : t("raw.repLossy", { subject });
}

function sourceLabel(source: RawSourceKind): string {
  if (source === "entry") return t("raw.sourceEntry");
  if (source === "collection") return t("raw.sourceCollection");
  return t("raw.sourceDocument");
}

function statusLabel(status: EntryBytesScope["status"]): string {
  if (status === "invalidJson") return t("jsonStatus.invalidJson");
  if (status === "invalidUtf8") return t("jsonStatus.invalidUtf8");
  return t("jsonStatus.oversized");
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
  return t("raw.requestFailed");
}
