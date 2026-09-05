import { invoke } from "@tauri-apps/api/core";
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
};

type RawSession = {
  revision: number;
};

type PageRequest = {
  epoch: number;
  revision: number;
  offset: number;
  historyIndex: number;
  restoreControl: FocusControl;
};

type FailedPage = {
  offset: number;
  historyIndex: number;
};

type FocusControl = "previous" | "next" | "retry" | null;

const PAGE_BYTES = 128 * 1024;

export class RawView {
  private readonly panel: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly onError: (error: unknown) => void;
  private readonly scopeLabel: HTMLElement;
  private readonly pageLabel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly pre: HTMLPreElement;
  private session: RawSession | null = null;
  private scope: NodeDto | null = null;
  private text: string | null = null;
  private pageStart: number | null = null;
  private pageEnd: number | null = null;
  private pageStarts: number[] = [];
  private currentIndex = -1;
  private failedPage: FailedPage | null = null;
  private pageRequest: PageRequest | null = null;
  private statusMessage = "Select a node to open its original bytes.";
  private busy = false;
  private active = false;
  private epoch = 0;

  constructor(options: RawViewOptions) {
    this.panel = options.panel;
    this.tab = options.tab;
    this.onError = options.onError;

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

    this.pageLabel = document.createElement("div");
    this.pageLabel.className = "raw-page-label";
    this.status = document.createElement("div");
    this.status.className = "raw-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.pre = document.createElement("pre");
    this.pre.className = "raw-chunk";
    this.pre.tabIndex = 0;

    this.panel.replaceChildren(header, this.pageLabel, this.status, this.pre);
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
    this.clear();
  }

  setSession(revision: number, root: NodeDto | null): void {
    this.epoch += 1;
    this.session = root ? { revision } : null;
    this.scope = root;
    this.text = null;
    this.pageStart = null;
    this.pageEnd = null;
    this.pageStarts = [];
    this.currentIndex = -1;
    this.failedPage = null;
    this.pageRequest = null;
    this.statusMessage = root ? "Select Raw to load the original bytes." : "Select a valid node to open its original bytes.";
    this.render();
    if (root && this.active) this.requestPage(root.spanStart, 0);
  }

  clear(reason?: string): void {
    this.epoch += 1;
    this.session = null;
    this.scope = null;
    this.text = null;
    this.pageStart = null;
    this.pageEnd = null;
    this.pageStarts = [];
    this.currentIndex = -1;
    this.failedPage = null;
    this.pageRequest = null;
    this.statusMessage = reason ?? "Select a node to open its original bytes.";
    this.render();
  }

  setScope(node: NodeDto): void {
    if (!this.session) return;
    this.epoch += 1;
    this.scope = node;
    this.text = null;
    this.pageStart = null;
    this.pageEnd = null;
    this.pageStarts = [];
    this.currentIndex = -1;
    this.failedPage = null;
    this.pageRequest = null;
    this.statusMessage = "Select Raw to load the original bytes.";
    this.render();
    if (this.active) this.requestPage(node.spanStart, 0);
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.render();
    if (!busy && this.active && this.session && this.scope && this.text === null && !this.pageRequest && !this.failedPage) {
      this.requestPage(this.scope.spanStart, 0);
    }
  }

  activate(): void {
    this.active = true;
    if (!this.session || !this.scope || this.pageRequest || this.text !== null || this.failedPage) {
      this.render();
      return;
    }
    this.requestPage(this.scope.spanStart, 0);
  }

  deactivate(): void {
    this.active = false;
  }

  private requestPage(offset: number, historyIndex: number): void {
    const session = this.session;
    const scope = this.scope;
    if (!session || !scope || this.busy || this.pageRequest) return;
    if (offset < scope.spanStart || offset >= scope.spanEnd) {
      this.failPage("The requested Raw page is outside the node span.");
      return;
    }
    this.failedPage = null;
    const request: PageRequest = {
      epoch: this.epoch,
      revision: session.revision,
      offset,
      historyIndex,
      restoreControl: this.focusedControl()
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
      const remaining = scope.spanEnd - request.offset;
      const chunk = await invoke<TextChunkDto>("read_raw_slice", {
        sourceStart: request.offset,
        length: Math.min(PAGE_BYTES, remaining),
        sessionRevision: request.revision
      });
      if (!this.isCurrent(request)) return;
      if (!Number.isSafeInteger(chunk.start) || chunk.start !== request.offset || typeof chunk.text !== "string") {
        this.failPage("Raw response did not match the requested byte range.");
        return;
      }
      const requestedLength = Math.min(PAGE_BYTES, remaining);
      const encodedLength = new TextEncoder().encode(chunk.text).byteLength;
      if (encodedLength <= 0 || encodedLength > requestedLength) {
        this.failPage("Raw response length did not match the requested byte range.");
        return;
      }
      if (chunk.nextOffset !== null && (!Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= request.offset)) {
        this.failPage("Raw response returned a non-monotonic next offset.");
        return;
      }
      if (chunk.nextOffset !== null && chunk.nextOffset > scope.spanEnd) {
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
      const pageEnd = Math.min(chunk.nextOffset ?? scope.spanEnd, scope.spanEnd);
      if (request.offset > Number.MAX_SAFE_INTEGER - encodedLength || request.offset + encodedLength !== pageEnd) {
        this.failPage("Raw response bytes did not reach the reported next offset.");
        return;
      }
      if (pageEnd <= request.offset && scope.spanEnd > request.offset) {
        this.failPage("Raw response did not advance within the node span.");
        return;
      }
      if (request.historyIndex > this.pageStarts.length) {
        this.failPage("Raw page history is not contiguous.");
        return;
      }
      if (request.historyIndex === this.pageStarts.length) this.pageStarts.push(request.offset);
      else if (this.pageStarts[request.historyIndex] !== request.offset) {
        this.failPage("Raw page history changed unexpectedly.");
        return;
      }
      this.pageRequest = null;
      this.failedPage = null;
      this.currentIndex = request.historyIndex;
      this.pageStart = request.offset;
      this.pageEnd = pageEnd;
      this.text = chunk.text;
      this.statusMessage = pageEnd < scope.spanEnd ? "Raw bytes loaded." : "End of raw scope.";
      this.render();
      this.restoreControl(request, true);
    } catch (error) {
      if (!this.isCurrent(request)) return;
      this.failPage(errorMessage(error), error);
    }
  }

  private previousPage(): void {
    if (this.busy || this.pageRequest || this.currentIndex <= 0) return;
    this.requestPage(this.pageStarts[this.currentIndex - 1], this.currentIndex - 1);
  }

  private nextPage(): void {
    const scope = this.scope;
    if (this.busy || this.pageRequest || !scope || this.pageEnd === null || this.pageEnd >= scope.spanEnd) return;
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
      control = !this.previous.disabled ? this.previous : !this.next.disabled ? this.next : this.tab;
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
    this.tab.disabled = this.session === null || scope === null;
    this.tab.setAttribute("aria-disabled", String(this.tab.disabled));
    this.panel.setAttribute("aria-busy", String(busy));
    this.scopeLabel.textContent = scope ? `Node #${scope.id} · [${scope.spanStart}, ${scope.spanEnd})` : "Raw bytes";
    this.pageLabel.textContent = this.pageStart !== null && this.pageEnd !== null && scope
      ? `Bytes [${this.pageStart}, ${this.pageEnd}) of [${scope.spanStart}, ${scope.spanEnd})`
      : "No raw chunk loaded.";
    this.status.textContent = this.statusMessage;
    this.pre.hidden = this.text === null;
    this.pre.textContent = this.text ?? "";
    this.previous.disabled = busy || this.currentIndex <= 0;
    this.next.disabled = busy || scope === null || this.pageEnd === null || this.pageEnd >= scope.spanEnd;
    this.retry.hidden = this.failedPage === null;
    this.retry.disabled = busy || this.failedPage === null;
  }

  private isCurrent(request: PageRequest): boolean {
    return this.pageRequest === request &&
      this.epoch === request.epoch &&
      this.session?.revision === request.revision;
  }
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
