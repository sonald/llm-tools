import { invoke } from "@tauri-apps/api/core";
import type { NodeDto } from "./tree-view";

export type ParseErrorDto = {
  message: string;
  byteOffset: number;
  line: number;
  column: number;
};

export type JsonlProgressDto = {
  indexedEntries: number;
  indexedSourceLines: number;
  complete: boolean;
  stride: number;
  totalEntries: number | null;
};

export type EntryLocationDto = {
  entryOrdinal: number;
  sourceLine: number;
  byteStart: number;
  byteEnd: number;
};

export type EntryDto = {
  location: EntryLocationDto;
  status: string;
  parseError?: ParseErrorDto | null;
};

export type EntryPageDto = {
  entries: EntryDto[];
  hasMore: boolean;
  nextCursor: number | null;
  progress: JsonlProgressDto;
};

export type EntrySelectionDto = {
  entry: EntryDto;
  root: NodeDto | null;
  sessionRevision: number;
};

export type EntryListSession = {
  revision: number;
  progress: JsonlProgressDto;
};

type EntryListElements = {
  navigation: HTMLElement;
  navigationState: HTMLElement;
  goInput: HTMLInputElement;
  goButton: HTMLButtonElement;
  goError: HTMLElement;
  list: HTMLElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  status: HTMLElement;
  retry: HTMLButtonElement;
  inspector: HTMLElement;
  inspectorOrdinal: HTMLElement;
  inspectorStatus: HTMLElement;
  inspectorSourceLine: HTMLElement;
  inspectorBytes: HTMLElement;
  inspectorParseMessage: HTMLElement;
  inspectorParseByteOffset: HTMLElement;
  inspectorParseLine: HTMLElement;
  inspectorParseColumn: HTMLElement;
};

type EntryListOptions = EntryListElements & {
  onSelection: (selection: EntrySelectionDto) => void;
  onSelectionBusy: (busy: boolean) => void;
  onError: (error: unknown) => void;
  onRevisionUnknown: (summary: unknown) => void;
  onProgress: (progress: JsonlProgressDto) => void;
};

type PageRequest = {
  epoch: number;
  revision: number;
  start: number;
};

type SelectionRequest = {
  epoch: number;
  revision: number;
  ordinal: number;
};

type PendingAction = {
  ordinal: number;
  select: boolean;
};

type FailedPageRequest = {
  start: number;
  action: PendingAction | null;
};

const PAGE_SIZE = 50;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export class EntryList {
  private readonly elements: EntryListElements;
  private readonly onSelection: (selection: EntrySelectionDto) => void;
  private readonly onSelectionBusy: (busy: boolean) => void;
  private readonly onError: (error: unknown) => void;
  private readonly onRevisionUnknown: (summary: unknown) => void;
  private readonly onProgress: (progress: JsonlProgressDto) => void;
  private session: EntryListSession | null = null;
  private entries: EntryDto[] = [];
  private selectedEntry: EntryDto | null = null;
  private focusedOrdinal: number | null = null;
  private progress: JsonlProgressDto | null = null;
  private windowStart = 0;
  private pageHasMore = false;
  private pageRequest: PageRequest | null = null;
  private failedPageRequest: FailedPageRequest | null = null;
  private selectionRequest: SelectionRequest | null = null;
  private pendingAction: PendingAction | null = null;
  private tailRefreshPending = false;
  private listError: string | null = null;
  private goError: string | null = null;
  private epoch = 0;
  private opening = false;

  constructor(options: EntryListOptions) {
    this.elements = options;
    this.onSelection = options.onSelection;
    this.onSelectionBusy = options.onSelectionBusy;
    this.onError = options.onError;
    this.onRevisionUnknown = options.onRevisionUnknown;
    this.onProgress = options.onProgress;
    this.elements.goButton.addEventListener("click", () => this.goToEntry());
    this.elements.goInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.goToEntry();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.goError = null;
        this.render();
        const target = this.selectedEntry?.location.entryOrdinal ?? this.focusedOrdinal;
        if (target === null) this.focusGoTo();
        else queueMicrotask(() => this.focusOrdinal(target));
      }
    });
    this.elements.list.addEventListener("click", (event) => this.handleListClick(event));
    this.elements.list.addEventListener("keydown", (event) => this.handleListKeydown(event));
    this.elements.previous.addEventListener("click", () => this.changeWindow(-1));
    this.elements.next.addEventListener("click", () => this.changeWindow(1));
    this.elements.retry.addEventListener("click", () => this.retryWindow());
    this.clear();
  }

  setSession(session: EntryListSession | null): void {
    this.epoch += 1;
    this.pageRequest = null;
    this.failedPageRequest = null;
    this.finishSelectionRequest();
    this.pendingAction = null;
    this.tailRefreshPending = false;
    this.session = session;
    this.progress = session?.progress ?? null;
    this.entries = [];
    this.selectedEntry = null;
    this.focusedOrdinal = null;
    this.windowStart = 0;
    this.pageHasMore = false;
    this.listError = null;
    this.goError = null;
    this.elements.navigation.hidden = session === null;
    this.elements.navigationState.hidden = session !== null;
    this.render();
    if (session) this.requestWindow(0, null, true);
  }

  clear(): void {
    this.epoch += 1;
    this.session = null;
    this.progress = null;
    this.pageRequest = null;
    this.failedPageRequest = null;
    this.finishSelectionRequest();
    this.pendingAction = null;
    this.tailRefreshPending = false;
    this.entries = [];
    this.selectedEntry = null;
    this.focusedOrdinal = null;
    this.windowStart = 0;
    this.pageHasMore = false;
    this.listError = null;
    this.goError = null;
    this.elements.navigation.hidden = true;
    this.elements.navigationState.hidden = false;
    this.render();
  }

  setOpening(opening: boolean): void {
    if (this.opening === opening) return;
    this.opening = opening;
    this.render();
    if (!opening) this.flushTailRefresh();
  }

  updateProgress(progress: JsonlProgressDto, revision: number): void {
    if (!this.session || this.session.revision !== revision) return;
    const previousIndexed = this.progress?.indexedEntries ?? 0;
    const atTail = this.entries.length === 0 || this.windowStart + this.entries.length >= previousIndexed;
    this.mergeProgressAndNotify(progress);
    const indexed = this.progress?.indexedEntries ?? previousIndexed;
    if (indexed > previousIndexed && atTail && this.needsTailRefresh()) {
      this.tailRefreshPending = true;
    } else if (!this.needsTailRefresh()) {
      this.tailRefreshPending = false;
    }
    this.render();
    this.flushTailRefresh();
  }

  adoptSelection(selection: EntrySelectionDto, revision: number): void {
    if (!this.session) return;
    this.epoch += 1;
    this.pageRequest = null;
    this.pendingAction = null;
    this.failedPageRequest = null;
    this.finishSelectionRequest();
    this.session = { ...this.session, revision, progress: this.progress ?? this.session.progress };
    this.selectedEntry = selection.entry;
    this.focusedOrdinal = selection.entry.location.entryOrdinal;
    this.entries = this.entries.map((entry) => (
      entry.location.entryOrdinal === selection.entry.location.entryOrdinal ? selection.entry : entry
    ));
    this.goError = null;
    this.render();
    this.flushTailRefresh();
  }

  resync(revision: number, progress: JsonlProgressDto): void {
    if (!this.session) return;
    this.epoch += 1;
    this.pageRequest = null;
    this.failedPageRequest = null;
    this.finishSelectionRequest();
    this.pendingAction = null;
    this.tailRefreshPending = false;
    this.session = { revision, progress };
    this.progress = progress;
    this.entries = [];
    this.selectedEntry = null;
    this.focusedOrdinal = null;
    this.pageHasMore = false;
    this.goError = null;
    this.listError = null;
    this.render();
    this.requestWindow(this.windowStart, null, true);
  }

  focusGoTo(): void {
    this.elements.goInput.focus();
    this.elements.goInput.select();
  }

  private requestWindow(start: number, action: PendingAction | null, force: boolean): void {
    const session = this.session;
    if (!session || this.opening || this.selectionRequest) return;
    const normalizedStart = Math.max(0, Math.floor(start / PAGE_SIZE) * PAGE_SIZE);
    if (this.pageRequest) {
      if (this.pageRequest.start === normalizedStart && action) this.pendingAction = action;
      return;
    }
    if (!force && this.entries.length > 0 && this.windowStart === normalizedStart) {
      if (action) this.applyAction(action);
      return;
    }
    this.pendingAction = action;
    this.failedPageRequest = null;
    this.tailRefreshPending = false;
    const request: PageRequest = { epoch: this.epoch, revision: session.revision, start: normalizedStart };
    this.pageRequest = request;
    this.listError = null;
    this.render();
    void this.loadWindow(request);
  }

  private async loadWindow(request: PageRequest): Promise<void> {
    try {
      const page = await invoke<EntryPageDto>("list_entries", {
        start: request.start,
        limit: PAGE_SIZE,
        sessionRevision: request.revision
      });
      if (!this.isCurrentPageRequest(request)) return;
      this.pageRequest = null;
      this.windowStart = request.start;
      this.entries = page.entries.slice(0, PAGE_SIZE);
      this.pageHasMore = page.hasMore;
      this.mergeProgressAndNotify(page.progress);
      this.listError = null;
      const action = this.pendingAction;
      this.pendingAction = null;
      this.failedPageRequest = null;
      this.tailRefreshPending = this.needsTailRefresh();
      if (action && this.entries.some((entry) => entry.location.entryOrdinal === action.ordinal)) {
        this.focusedOrdinal = action.ordinal;
      }
      this.render();
      if (action) this.applyAction(action);
      this.flushTailRefresh();
    } catch (error) {
      if (!this.isCurrentPageRequest(request)) return;
      this.pageRequest = null;
      const action = this.pendingAction;
      this.pendingAction = null;
      this.failedPageRequest = { start: request.start, action };
      this.tailRefreshPending = false;
      this.listError = errorMessage(error);
      this.render();
      if (isGlobalError(error)) this.onError(error);
    }
  }

  private retryWindow(): void {
    if (this.opening || this.pageRequest || this.selectionRequest) return;
    const failed = this.failedPageRequest;
    if (failed) {
      this.failedPageRequest = null;
      this.requestWindow(failed.start, failed.action, true);
    } else {
      this.requestWindow(this.windowStart, null, true);
    }
  }

  private applyAction(action: PendingAction): void {
    if (!this.entries.some((entry) => entry.location.entryOrdinal === action.ordinal)) {
      if (action.select && this.progress && !this.progress.complete) {
        this.goError = "Indexing has not reached this entry yet.";
        this.render();
      }
      return;
    }
    this.focusOrdinal(action.ordinal);
    if (action.select) void this.selectOrdinal(action.ordinal);
  }

  private changeWindow(direction: -1 | 1): void {
    if (this.opening || this.pageRequest || this.selectionRequest) return;
    const target = this.windowStart + direction * PAGE_SIZE;
    if (target < 0 || (direction > 0 && !this.hasNext())) return;
    const action = { ordinal: direction > 0 ? target : target + PAGE_SIZE - 1, select: false };
    this.requestWindow(target, action, true);
  }

  private handleListClick(event: Event): void {
    if (this.opening || this.pageRequest || this.selectionRequest) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest<HTMLElement>("[role=option]");
    if (!option) return;
    const ordinal = Number(option.dataset.entryOrdinal);
    if (!Number.isSafeInteger(ordinal)) return;
    this.focusedOrdinal = ordinal;
    void this.selectOrdinal(ordinal);
  }

  private handleListKeydown(event: KeyboardEvent): void {
    if (this.opening || this.pageRequest || this.selectionRequest) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const option = target.closest<HTMLElement>("[role=option]");
    if (!option) return;
    const ordinal = Number(option.dataset.entryOrdinal);
    const index = this.entries.findIndex((entry) => entry.location.entryOrdinal === ordinal);
    if (index < 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (index + 1 < this.entries.length) this.focusIndex(index + 1);
        else if (this.hasNext()) this.requestWindow(this.windowStart + PAGE_SIZE, { ordinal: this.windowStart + PAGE_SIZE, select: false }, true);
        else this.focusIndex(index);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (index > 0) this.focusIndex(index - 1);
        else if (this.windowStart > 0) this.requestWindow(this.windowStart - PAGE_SIZE, { ordinal: this.windowStart - 1, select: false }, true);
        else this.focusIndex(index);
        break;
      case "PageDown":
        event.preventDefault();
        if (this.hasNext()) {
          this.requestWindow(this.windowStart + PAGE_SIZE, { ordinal: this.windowStart + PAGE_SIZE, select: false }, true);
        } else {
          this.focusIndex(this.entries.length - 1);
        }
        break;
      case "PageUp":
        event.preventDefault();
        if (this.windowStart > 0) {
          this.requestWindow(this.windowStart - PAGE_SIZE, { ordinal: this.windowStart - PAGE_SIZE + PAGE_SIZE - 1, select: false }, true);
        } else {
          this.focusIndex(0);
        }
        break;
      case "Home":
        event.preventDefault();
        this.requestWindow(0, { ordinal: 0, select: false }, this.windowStart !== 0);
        break;
      case "End":
        event.preventDefault();
        this.focusEnd();
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        void this.selectOrdinal(ordinal);
        break;
      default:
        break;
    }
  }

  private focusIndex(index: number): void {
    if (index >= 0 && index < this.entries.length) this.focusOrdinal(this.entries[index].location.entryOrdinal);
  }

  private focusEnd(): void {
    const progress = this.progress;
    if (!progress) return;
    const last = progress.complete && progress.totalEntries !== null
      ? progress.totalEntries - 1
      : progress.indexedEntries - 1;
    if (last < 0) return;
    const start = Math.floor(last / PAGE_SIZE) * PAGE_SIZE;
    const targetLoaded = this.entries.some((entry) => entry.location.entryOrdinal === last);
    this.requestWindow(start, { ordinal: last, select: false }, start !== this.windowStart || !targetLoaded);
  }

  private async selectOrdinal(ordinal: number): Promise<void> {
    const session = this.session;
    if (!session || this.opening || this.pageRequest || this.selectionRequest) return;
    const entry = this.entries.find((candidate) => candidate.location.entryOrdinal === ordinal);
    if (!entry) return;
    const request: SelectionRequest = { epoch: this.epoch, revision: session.revision, ordinal };
    this.selectionRequest = request;
    this.onSelectionBusy(true);
    this.goError = null;
    this.render();
    try {
      const selection = await invoke<EntrySelectionDto>("select_entry", {
        ordinal,
        sessionRevision: request.revision
      });
      if (!this.isCurrentSelectionRequest(request)) return;
      this.finishSelectionRequest();
      this.onSelection(selection);
      this.flushTailRefresh();
    } catch (error) {
      if (!this.isCurrentSelectionRequest(request)) return;
      if (errorCode(error) === "invalid_request") {
        this.render();
        await this.refreshUnknownRevision(request);
      } else {
        this.finishSelectionRequest();
        this.render();
        this.flushTailRefresh();
        this.onError(error);
      }
    }
  }

  private async refreshUnknownRevision(request: SelectionRequest): Promise<void> {
    try {
      const summary = await invoke<unknown>("get_file_summary");
      if (!this.isCurrentSelectionRequest(request)) return;
      this.onRevisionUnknown(summary);
      if (this.isCurrentSelectionRequest(request)) {
        this.finishSelectionRequest();
        this.render();
        this.onError({ code: "internal", message: "The JSONL session revision could not be refreshed." });
      }
    } catch (error) {
      if (this.isCurrentSelectionRequest(request)) {
        this.finishSelectionRequest();
        this.render();
        this.onError(error);
      }
    }
  }

  private goToEntry(): void {
    if (this.opening || this.pageRequest || this.selectionRequest || !this.session) return;
    const value = this.elements.goInput.value.trim();
    if (!/^\d+$/.test(value)) {
      this.setGoError("Enter a positive decimal Entry number.");
      return;
    }
    const displayOrdinal = Number(value);
    if (!Number.isSafeInteger(displayOrdinal) || displayOrdinal < 1 || displayOrdinal > MAX_SAFE_INTEGER) {
      this.setGoError("Enter a positive decimal Entry number.");
      return;
    }
    const ordinal = displayOrdinal - 1;
    const progress = this.progress;
    if (!progress) {
      this.setGoError("Entry indexing is not ready yet.");
      return;
    }
    if (ordinal >= progress.indexedEntries) {
      if (!progress.complete) {
        this.setGoError("Indexing has not reached this entry yet.");
      } else {
        const total = progress.totalEntries ?? progress.indexedEntries;
        this.setGoError(`Entry ${displayOrdinal.toLocaleString()} is outside the file (total ${total.toLocaleString()}).`);
      }
      return;
    }
    this.goError = null;
    const start = Math.floor(ordinal / PAGE_SIZE) * PAGE_SIZE;
    if (this.windowStart === start && this.entries.some((entry) => entry.location.entryOrdinal === ordinal)) {
      this.applyAction({ ordinal, select: true });
    } else {
      this.requestWindow(start, { ordinal, select: true }, true);
    }
    this.render();
  }

  private setGoError(message: string): void {
    this.goError = message;
    this.render();
    this.focusGoTo();
  }

  private mergeProgressAndNotify(next: JsonlProgressDto): void {
    const merged = mergeProgress(this.progress, next);
    if (progressEqual(this.progress, merged)) return;
    this.progress = merged;
    if (this.session) this.session = { ...this.session, progress: merged };
    this.onProgress(merged);
  }

  private focusOrdinal(ordinal: number): void {
    const item = this.elements.list.querySelector<HTMLElement>(`[data-entry-ordinal="${ordinal}"]`);
    if (!item) return;
    this.focusedOrdinal = ordinal;
    for (const option of this.optionElements()) option.tabIndex = option === item ? 0 : -1;
    item.focus();
  }

  private finishSelectionRequest(): void {
    if (this.selectionRequest === null) return;
    this.selectionRequest = null;
    this.onSelectionBusy(false);
  }

  private render(): void {
    const shouldRestoreFocus = this.elements.list.contains(document.activeElement);
    const focusedBefore = this.focusedOrdinal ?? this.entries[0]?.location.entryOrdinal ?? null;
    const busy = this.opening || this.pageRequest !== null || this.selectionRequest !== null;
    this.elements.navigation.hidden = this.session === null;
    this.elements.navigationState.hidden = this.session !== null;
    this.elements.goInput.disabled = busy;
    this.elements.goButton.disabled = busy;
    this.elements.previous.disabled = busy || this.pageRequest !== null || this.windowStart === 0;
    this.elements.next.disabled = busy || this.pageRequest !== null || !this.hasNext();
    this.elements.list.setAttribute("aria-busy", String(this.pageRequest !== null || busy));
    this.elements.retry.disabled = busy || this.pageRequest !== null;
    this.elements.list.replaceChildren();
    if (this.entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "entry-list-empty";
      empty.textContent = this.listError ?? (this.progress?.complete ? "No entries found." : "Indexing entries…");
      this.elements.list.append(empty);
    } else {
      for (const entry of this.entries) this.elements.list.append(this.optionElement(entry, busy));
    }
    this.elements.retry.hidden = this.listError === null;
    this.elements.goError.textContent = this.goError ?? "";
    this.elements.status.textContent = this.listStatus();
    this.renderInspector();
    if (shouldRestoreFocus && focusedBefore !== null) {
      queueMicrotask(() => this.focusOrdinal(focusedBefore));
    }
  }

  private optionElement(entry: EntryDto, busy: boolean): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "entry-option";
    item.setAttribute("role", "option");
    item.dataset.entryOrdinal = String(entry.location.entryOrdinal);
    item.dataset.status = entry.status;
    item.tabIndex = this.focusedOrdinal === entry.location.entryOrdinal || this.focusedOrdinal === null && this.entries[0] === entry ? 0 : -1;
    item.setAttribute("aria-disabled", String(busy));
    item.setAttribute("aria-selected", String(this.selectedEntry?.location.entryOrdinal === entry.location.entryOrdinal));
    item.setAttribute(
      "aria-label",
      `Entry ${entry.location.entryOrdinal + 1}, source line ${entry.location.sourceLine}, ${statusLabel(entry.status)}, bytes ${entry.location.byteStart} to ${entry.location.byteEnd}`
    );

    const marker = document.createElement("span");
    marker.className = "entry-option-status";
    marker.setAttribute("aria-hidden", "true");
    const body = document.createElement("span");
    body.className = "entry-option-body";
    const title = document.createElement("span");
    title.className = "entry-option-title";
    title.textContent = `Entry ${entry.location.entryOrdinal + 1} · ${statusLabel(entry.status)}`;
    const meta = document.createElement("span");
    meta.className = "entry-option-meta";
    meta.textContent = `line ${entry.location.sourceLine} · [${entry.location.byteStart}, ${entry.location.byteEnd})`;
    body.append(title, meta);
    item.append(marker, body);
    return item;
  }

  private renderInspector(): void {
    this.elements.inspector.hidden = this.session === null;
    if (!this.session) return;
    const entry = this.selectedEntry;
    this.elements.inspectorOrdinal.textContent = entry ? String(entry.location.entryOrdinal + 1) : "—";
    this.elements.inspectorStatus.textContent = entry ? statusLabel(entry.status) : "No Entry selected";
    this.elements.inspectorSourceLine.textContent = entry
      ? String(entry.location.sourceLine)
      : this.progress ? `Indexed through line ${this.progress.indexedSourceLines}` : "—";
    this.elements.inspectorBytes.textContent = entry
      ? `[${entry.location.byteStart}, ${entry.location.byteEnd})`
      : "—";
    const parse = entry?.parseError ?? null;
    this.elements.inspectorParseMessage.textContent = parse?.message ?? "—";
    this.elements.inspectorParseByteOffset.textContent = parse ? String(parse.byteOffset) : "—";
    this.elements.inspectorParseLine.textContent = parse ? String(parse.line) : "—";
    this.elements.inspectorParseColumn.textContent = parse ? String(parse.column) : "—";
  }

  private listStatus(): string {
    if (this.listError) return "Entries could not be loaded. Retry to continue.";
    if (!this.entries.length) return this.progress?.complete ? "End of entries." : "Indexing…";
    if (this.hasNext()) return this.progress && !this.progress.complete && !this.pageHasMore ? "Indexing…" : "More entries available.";
    return this.progress && !this.progress.complete ? "Indexing…" : "End of entries.";
  }

  private hasNext(): boolean {
    if (this.tailRefreshPending) return false;
    return this.pageHasMore || Boolean(this.progress && this.progress.indexedEntries > this.windowStart + this.entries.length);
  }

  private needsTailRefresh(): boolean {
    return Boolean(
      this.progress &&
      this.entries.length < PAGE_SIZE &&
      this.progress.indexedEntries > this.windowStart + this.entries.length
    );
  }

  private flushTailRefresh(): void {
    if (!this.tailRefreshPending) return;
    if (!this.needsTailRefresh()) {
      this.tailRefreshPending = false;
      return;
    }
    if (this.opening || this.pageRequest || this.selectionRequest) return;
    this.tailRefreshPending = false;
    this.requestWindow(this.windowStart, null, true);
  }

  private optionElements(): HTMLElement[] {
    return Array.from(this.elements.list.querySelectorAll<HTMLElement>("[role=option]"));
  }

  private isCurrentPageRequest(request: PageRequest): boolean {
    return this.pageRequest === request && this.session?.revision === request.revision && this.epoch === request.epoch;
  }

  private isCurrentSelectionRequest(request: SelectionRequest): boolean {
    return this.selectionRequest === request && this.session?.revision === request.revision && this.epoch === request.epoch;
  }
}

function mergeProgress(previous: JsonlProgressDto | null, next: JsonlProgressDto): JsonlProgressDto {
  if (!previous) return next;
  return {
    indexedEntries: Math.max(previous.indexedEntries, next.indexedEntries),
    indexedSourceLines: Math.max(previous.indexedSourceLines, next.indexedSourceLines),
    complete: previous.complete || next.complete,
    stride: Math.max(previous.stride, next.stride),
    totalEntries: next.complete ? next.totalEntries : previous.totalEntries
  };
}

function progressEqual(left: JsonlProgressDto | null, right: JsonlProgressDto): boolean {
  return left !== null &&
    left.indexedEntries === right.indexedEntries &&
    left.indexedSourceLines === right.indexedSourceLines &&
    left.complete === right.complete &&
    left.stride === right.stride &&
    left.totalEntries === right.totalEntries;
}

function statusLabel(status: string): string {
  if (status === "valid") return "Valid";
  if (status === "invalidJson") return "Invalid JSON";
  if (status === "invalidUtf8") return "Invalid UTF-8";
  if (status === "oversized") return "Oversized Entry";
  return status;
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
  return "The entry list request failed.";
}
