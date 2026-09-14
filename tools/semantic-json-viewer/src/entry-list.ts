import { invoke } from "@tauri-apps/api/core";
import { locale, t } from "./i18n";
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
  eventStreamHint: boolean | null;
};

export type EntryEventValueDto = {
  value: string;
  hasMore: boolean;
};

export type EntryEventSummaryDto = {
  eventType: EntryEventValueDto | null;
  timestamp: EntryEventValueDto | null;
  grouping: EntryEventValueDto | null;
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
  eventSummary?: EntryEventSummaryDto | null;
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

export type EntrySummaryMode = "auto" | "generic" | "event";

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
  private readonly summaryModeSelect: HTMLSelectElement;
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
  private summaryMode: EntrySummaryMode = "auto";

  constructor(options: EntryListOptions) {
    this.elements = options;
    this.onSelection = options.onSelection;
    this.onSelectionBusy = options.onSelectionBusy;
    this.onError = options.onError;
    this.onRevisionUnknown = options.onRevisionUnknown;
    this.onProgress = options.onProgress;
    const summaryModeControl = document.createElement("label");
    summaryModeControl.className = "conversation-style-control";
    const summaryModeLabel = document.createElement("span");
    summaryModeLabel.textContent = t("entryList.summaryMode");
    this.summaryModeSelect = document.createElement("select");
    this.summaryModeSelect.dataset.entrySummaryMode = "true";
    this.summaryModeSelect.setAttribute("aria-label", t("entryList.summaryMode"));
    for (const [value, label] of [
      ["auto", t("entryList.summaryAuto")],
      ["generic", t("entryList.summaryGeneric")],
      ["event", t("entryList.summaryEvent")]
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.summaryModeSelect.append(option);
    }
    this.summaryModeSelect.addEventListener("change", () => {
      const mode = this.summaryModeSelect.value;
      if (!isEntrySummaryMode(mode)) return;
      this.summaryMode = mode;
      this.render();
    });
    summaryModeControl.append(summaryModeLabel, this.summaryModeSelect);
    const go = this.elements.navigation.querySelector<HTMLElement>(".entry-go");
    if (go) this.elements.navigation.insertBefore(summaryModeControl, go);
    else this.elements.navigation.prepend(summaryModeControl);
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
    const progress = session ? progressValue(session.progress) : null;
    if (session && !progress) {
      this.clear();
      this.onError(new Error(t("entryList.progressResponseInvalid")));
      return;
    }
    this.epoch += 1;
    this.pageRequest = null;
    this.failedPageRequest = null;
    this.finishSelectionRequest();
    this.pendingAction = null;
    this.tailRefreshPending = false;
    this.summaryMode = "auto";
    this.summaryModeSelect.value = this.summaryMode;
    this.session = session && progress ? { ...session, progress } : null;
    this.progress = session && progress ? progress : null;
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
    this.summaryMode = "auto";
    this.summaryModeSelect.value = this.summaryMode;
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
    const next = progressValue(progress);
    if (!next) {
      this.listError = t("entryList.progressResponseInvalid");
      this.render();
      this.onError(new Error(this.listError));
      return;
    }
    const previousIndexed = this.progress?.indexedEntries ?? 0;
    const atTail = this.entries.length === 0 || this.windowStart + this.entries.length >= previousIndexed;
    this.mergeProgressAndNotify(next);
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
    const next = progressValue(progress);
    if (!next) {
      this.listError = t("entryList.progressResponseInvalid");
      this.render();
      this.onError(new Error(this.listError));
      return;
    }
    this.epoch += 1;
    this.pageRequest = null;
    this.failedPageRequest = null;
    this.finishSelectionRequest();
    this.pendingAction = null;
    this.tailRefreshPending = false;
    this.session = { revision, progress: next };
    this.progress = next;
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
      const value = await invoke<unknown>("list_entries", {
        start: request.start,
        limit: PAGE_SIZE,
        sessionRevision: request.revision
      });
      if (!this.isCurrentPageRequest(request)) return;
      const page = entryPageValue(value);
      if (!page) throw new Error(t("entryList.pageResponseInvalid"));
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
        this.goError = t("entryList.indexingNotReached");
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
      const value = await invoke<unknown>("select_entry", {
        ordinal,
        sessionRevision: request.revision
      });
      if (!this.isCurrentSelectionRequest(request)) return;
      const selection = entrySelectionValue(value);
      if (!selection) throw new Error(t("entryList.selectionResponseInvalid"));
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
        this.onError({ code: "internal", message: t("entryList.revisionRefreshFailed") });
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
      this.setGoError(t("entryList.invalidPositiveNumber"));
      return;
    }
    const displayOrdinal = Number(value);
    if (!Number.isSafeInteger(displayOrdinal) || displayOrdinal < 1 || displayOrdinal > MAX_SAFE_INTEGER) {
      this.setGoError(t("entryList.invalidPositiveNumber"));
      return;
    }
    const ordinal = displayOrdinal - 1;
    const progress = this.progress;
    if (!progress) {
      this.setGoError(t("entryList.indexingNotReady"));
      return;
    }
    if (ordinal >= progress.indexedEntries) {
      if (!progress.complete) {
        this.setGoError(t("entryList.indexingNotReached"));
      } else {
        const total = progress.totalEntries ?? progress.indexedEntries;
        this.setGoError(t("entryList.entryOutsideFile", {
          entry: displayOrdinal.toLocaleString(locale),
          total: total.toLocaleString(locale)
        }));
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
      empty.textContent = this.listError ?? (this.progress?.complete ? t("entryList.noEntries") : t("entryList.indexingEntries"));
      this.elements.list.append(empty);
    } else {
      for (const entry of this.entries) this.elements.list.append(this.optionElement(entry, busy));
    }
    this.elements.retry.hidden = this.listError === null;
    this.elements.goError.textContent = this.goError ?? "";
    this.elements.status.textContent = this.listStatus();
    this.summaryModeSelect.value = this.summaryMode;
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
    const eventSummary = this.eventSummaryText(entry);
    item.setAttribute(
      "aria-label",
      t("entryList.entryAria", {
        entry: (entry.location.entryOrdinal + 1).toLocaleString(locale),
        line: entry.location.sourceLine.toLocaleString(locale),
        status: statusLabel(entry.status),
        start: entry.location.byteStart,
        end: entry.location.byteEnd,
        summary: eventSummary ? ` · ${eventSummary}` : ""
      })
    );

    const marker = document.createElement("span");
    marker.className = "entry-option-status";
    marker.setAttribute("aria-hidden", "true");
    const body = document.createElement("span");
    body.className = "entry-option-body";
    const title = document.createElement("span");
    title.className = "entry-option-title";
    title.textContent = t("entryList.entryTitle", {
      entry: (entry.location.entryOrdinal + 1).toLocaleString(locale),
      status: statusLabel(entry.status)
    });
    const meta = document.createElement("span");
    meta.className = "entry-option-meta";
    meta.textContent = t("entryList.lineSpan", {
      line: entry.location.sourceLine.toLocaleString(locale),
      start: entry.location.byteStart,
      end: entry.location.byteEnd
    });
    body.append(title, meta);
    if (eventSummary !== null) {
      const summary = document.createElement("span");
      summary.className = "entry-option-meta";
      summary.textContent = eventSummary;
      body.append(summary);
    }
    item.append(marker, body);
    return item;
  }

  private eventSummaryText(entry: EntryDto): string | null {
    if (this.summaryMode === "generic") return null;
    if (this.summaryMode === "auto" && this.progress?.eventStreamHint !== true) return null;
    const summary = entry.eventSummary;
    if (!summary) return null;
    const fields: string[] = [];
    if (summary.timestamp) fields.push(eventField("entryList.eventTimestamp", summary.timestamp));
    if (summary.eventType) fields.push(eventField("entryList.eventType", summary.eventType));
    if (summary.grouping) fields.push(eventField("entryList.eventGrouping", summary.grouping));
    return fields.length > 0 ? t("entryList.eventSummary", { summary: fields.join(" · ") }) : null;
  }

  private renderInspector(): void {
    this.elements.inspector.hidden = this.session === null;
    if (!this.session) return;
    const entry = this.selectedEntry;
    this.elements.inspectorOrdinal.textContent = entry ? String(entry.location.entryOrdinal + 1) : "—";
    this.elements.inspectorStatus.textContent = entry ? statusLabel(entry.status) : t("entryList.noEntrySelected");
    this.elements.inspectorSourceLine.textContent = entry
      ? String(entry.location.sourceLine)
      : this.progress ? t("entryList.indexedThroughLine", { line: this.progress.indexedSourceLines.toLocaleString(locale) }) : "—";
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
    if (this.listError) return t("entryList.entriesLoadError");
    if (!this.entries.length) return this.progress?.complete ? t("entryList.endOfEntries") : t("entryList.indexing");
    if (this.hasNext()) return this.progress && !this.progress.complete && !this.pageHasMore ? t("entryList.indexing") : t("entryList.moreEntries");
    return this.progress && !this.progress.complete ? t("entryList.indexing") : t("entryList.endOfEntries");
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
    totalEntries: next.complete ? next.totalEntries : previous.totalEntries,
    eventStreamHint: next.eventStreamHint ?? previous.eventStreamHint
  };
}

function progressEqual(left: JsonlProgressDto | null, right: JsonlProgressDto): boolean {
  return left !== null &&
    left.indexedEntries === right.indexedEntries &&
    left.indexedSourceLines === right.indexedSourceLines &&
    left.complete === right.complete &&
    left.stride === right.stride &&
    left.totalEntries === right.totalEntries &&
    left.eventStreamHint === right.eventStreamHint;
}

function isEntrySummaryMode(value: string): value is EntrySummaryMode {
  return value === "auto" || value === "generic" || value === "event";
}

function eventField(key: "entryList.eventTimestamp" | "entryList.eventType" | "entryList.eventGrouping", value: EntryEventValueDto): string {
  return t(key, {
    value: value.value,
    suffix: value.hasMore ? t("entryList.eventTruncated") : ""
  });
}

function progressValue(value: unknown): JsonlProgressDto | undefined {
  if (!isRecord(value)) return undefined;
  const indexedEntries = nonNegativeInteger(value.indexedEntries);
  const indexedSourceLines = nonNegativeInteger(value.indexedSourceLines);
  const stride = nonNegativeInteger(value.stride);
  const complete = typeof value.complete === "boolean" ? value.complete : undefined;
  const totalEntries = value.totalEntries === null || value.totalEntries === undefined
    ? null
    : nonNegativeInteger(value.totalEntries);
  const eventStreamHint = value.eventStreamHint === undefined || value.eventStreamHint === null
    ? null
    : typeof value.eventStreamHint === "boolean" ? value.eventStreamHint : undefined;
  if (indexedEntries === undefined || indexedSourceLines === undefined || stride === undefined
    || complete === undefined || totalEntries === undefined || eventStreamHint === undefined) return undefined;
  return { indexedEntries, indexedSourceLines, complete, stride, totalEntries, eventStreamHint };
}

function entryPageValue(value: unknown): EntryPageDto | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries) || typeof value.hasMore !== "boolean") return undefined;
  const nextCursor = value.nextCursor === null || value.nextCursor === undefined
    ? null
    : nonNegativeInteger(value.nextCursor);
  const progress = progressValue(value.progress);
  if (nextCursor === undefined || !progress) return undefined;
  const entries: EntryDto[] = [];
  for (const candidate of value.entries) {
    const entry = entryValue(candidate);
    if (!entry) return undefined;
    entries.push(entry);
  }
  return { entries, hasMore: value.hasMore, nextCursor, progress };
}

function entrySelectionValue(value: unknown): EntrySelectionDto | undefined {
  if (!isRecord(value)) return undefined;
  const entry = entryValue(value.entry);
  const sessionRevision = nonNegativeInteger(value.sessionRevision);
  if (!entry || sessionRevision === undefined || !("root" in value)) return undefined;
  return { entry, root: value.root as NodeDto | null, sessionRevision };
}

function entryValue(value: unknown): EntryDto | undefined {
  if (Array.isArray(value) || !isRecord(value)) return undefined;
  const eventSummary = eventSummaryValue(value.eventSummary);
  if (eventSummary === undefined) return undefined;
  return { ...value, eventSummary } as EntryDto;
}

function eventSummaryValue(value: unknown): EntryEventSummaryDto | null | undefined {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || !isRecord(value)) return undefined;
  const eventType = eventValue(value.eventType);
  const timestamp = eventValue(value.timestamp);
  const grouping = eventValue(value.grouping);
  if (eventType === undefined || timestamp === undefined || grouping === undefined) return undefined;
  return { eventType, timestamp, grouping };
}

function eventValue(value: unknown): EntryEventValueDto | null | undefined {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || !isRecord(value) || typeof value.value !== "string" || typeof value.hasMore !== "boolean"
    || value.value.length > 512 || [...value.value].length > 256) return undefined;
  return { value: value.value, hasMore: value.hasMore };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusLabel(status: string): string {
  if (status === "valid") return t("jsonStatus.valid");
  if (status === "invalidJson") return t("jsonStatus.invalidJson");
  if (status === "invalidUtf8") return t("jsonStatus.invalidUtf8");
  if (status === "oversized") return t("jsonStatus.oversized");
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
  return t("entryList.requestFailed");
}
