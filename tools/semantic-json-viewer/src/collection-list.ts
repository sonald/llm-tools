import { invoke } from "@tauri-apps/api/core";
import { validateNodePage, type NodeDto } from "./tree-view";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

type CollectionListElements = {
  section: HTMLElement;
  goInput: HTMLInputElement;
  goButton: HTMLButtonElement;
  goError: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  retry: HTMLButtonElement;
};

type CollectionListOptions = CollectionListElements & {
  invoke?: Invoke;
  onSelection: (node: NodeDto, ordinal: number) => void;
  onError: (error: unknown) => void;
};

type CollectionSession = {
  revision: number;
  root: NodeDto;
  sourceSize: number;
};

type ItemPage = {
  start: number;
  nodes: NodeDto[];
  hasMore: boolean;
  nextCursor: number | null;
};

type PageRequest = {
  epoch: number;
  revision: number;
  rootId: number;
  start: number;
};

const PAGE_SIZE = 200;
const ROW_HEIGHT = 24;
// Chromium clamps scrollHeight near 33.5M. One million items therefore fit at 24px.
const MAX_SCROLL_HEIGHT = 30_000_000;
const MAX_PHYSICAL_ROWS = Math.floor(MAX_SCROLL_HEIGHT / ROW_HEIGHT);

export class CollectionList {
  private readonly elements: CollectionListElements;
  private readonly invokeRequest: Invoke;
  private readonly onSelection: (node: NodeDto, ordinal: number) => void;
  private readonly onError: (error: unknown) => void;
  private session: CollectionSession | null = null;
  private pages = new Map<number, ItemPage>();
  private prefetchRequests = new Map<number, PageRequest>();
  private pageRequest: PageRequest | null = null;
  private pendingFocus: number | null = null;
  private selectedOrdinal: number | null = null;
  private focusedOrdinal: number | null = null;
  private windowStart = 0;
  private segmentStart = 0;
  private wantedStart: number | null = null;
  private pendingScrollTop: number | null = null;
  private rendering = false;
  private listError: string | null = null;
  private goError: string | null = null;
  private epoch = 0;
  private opening = false;
  private rowHeight = ROW_HEIGHT;

  constructor(options: CollectionListOptions) {
    this.elements = options;
    this.invokeRequest = options.invoke ?? invoke;
    this.onSelection = options.onSelection;
    this.onError = options.onError;
    this.elements.list.addEventListener("scroll", () => this.handleScroll(), { passive: true });
    this.elements.list.addEventListener("click", (event) => this.handleClick(event));
    this.elements.list.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.elements.goButton.addEventListener("click", () => this.goToItem());
    this.elements.goInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.goToItem();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.goError = null;
        this.render();
        if (this.focusedOrdinal !== null) queueMicrotask(() => this.focusOrdinal(this.focusedOrdinal!));
      }
    });
    this.elements.retry.addEventListener("click", () => this.retryPage());
    this.clear();
  }

  setSession(session: CollectionSession | null): void {
    this.epoch += 1;
    this.session = session;
    this.pages.clear();
    this.prefetchRequests.clear();
    this.pageRequest = null;
    this.pendingFocus = null;
    this.selectedOrdinal = null;
    this.focusedOrdinal = null;
    this.windowStart = 0;
    this.segmentStart = 0;
    this.wantedStart = null;
    this.pendingScrollTop = 0;
    this.listError = null;
    this.goError = null;
    this.rowHeight = ROW_HEIGHT;
    this.elements.section.hidden = session === null;
    this.render();
    if (session && session.root.childCount > 0) this.requestPage(0, null);
  }

  clear(): void {
    this.epoch += 1;
    this.session = null;
    this.pages.clear();
    this.prefetchRequests.clear();
    this.pageRequest = null;
    this.pendingFocus = null;
    this.selectedOrdinal = null;
    this.focusedOrdinal = null;
    this.windowStart = 0;
    this.segmentStart = 0;
    this.wantedStart = null;
    this.pendingScrollTop = 0;
    this.listError = null;
    this.goError = null;
    this.elements.section.hidden = true;
    this.render();
  }

  setOpening(opening: boolean): void {
    if (this.opening === opening) return;
    this.opening = opening;
    this.render();
    if (!opening && this.session && this.session.root.childCount > 0 && this.pages.size === 0 && !this.pageRequest) {
      this.requestPage(this.windowStart, null);
    }
  }

  private handleScroll(): void {
    const session = this.session;
    if (this.rendering || !session || session.root.childCount === 0) return;
    const total = session.root.childCount;
    const desiredOrdinal = this.segmentStart + Math.floor(this.elements.list.scrollTop / this.rowHeight);
    this.recenterSegment(total, desiredOrdinal);
    const ordinal = Math.min(total - 1, Math.max(0, this.segmentStart + Math.floor(this.elements.list.scrollTop / this.rowHeight)));
    const start = Math.floor(ordinal / PAGE_SIZE) * PAGE_SIZE;
    if (this.pageRequest) {
      this.wantedStart = start;
      return;
    }
    if (start !== this.windowStart) {
      this.requestPage(start, null);
    }
  }

  private recenterSegment(total: number, desiredOrdinal: number): void {
    if (total <= MAX_PHYSICAL_ROWS) return;
    const maxStart = total - MAX_PHYSICAL_ROWS;
    const nearTop = this.elements.list.scrollTop <= this.rowHeight * 4;
    const nearBottom = this.elements.list.scrollTop >= this.elements.list.scrollHeight - this.elements.list.clientHeight - this.rowHeight * 4;
    if (!nearTop && !nearBottom) return;
    const oldStart = this.segmentStart;
    const nextStart = nearBottom
      ? Math.min(maxStart, oldStart + Math.floor(MAX_PHYSICAL_ROWS / 2))
      : Math.max(0, oldStart - Math.floor(MAX_PHYSICAL_ROWS / 2));
    if (nextStart === oldStart) return;
    this.segmentStart = nextStart;
    this.elements.list.scrollTop = Math.max(0, (desiredOrdinal - nextStart) * this.rowHeight);
    this.render();
  }

  private handleClick(event: Event): void {
    if (this.opening) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest<HTMLElement>("[role=option]");
    if (!item) return;
    const ordinal = Number(item.dataset.itemOrdinal);
    if (Number.isSafeInteger(ordinal)) this.selectOrdinal(ordinal);
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (this.opening) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest<HTMLElement>("[role=option]");
    if (!item || !this.session) return;
    const ordinal = Number(item.dataset.itemOrdinal);
    if (!Number.isSafeInteger(ordinal)) return;
    const total = this.session.root.childCount;
    const visible = Math.max(1, Math.floor(this.elements.list.clientHeight / this.rowHeight));
    let next: number | null = null;
    switch (event.key) {
      case "ArrowDown": next = Math.min(total - 1, ordinal + 1); break;
      case "ArrowUp": next = Math.max(0, ordinal - 1); break;
      case "PageDown": next = Math.min(total - 1, ordinal + visible); break;
      case "PageUp": next = Math.max(0, ordinal - visible); break;
      case "Home": next = 0; break;
      case "End": next = total - 1; break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.selectOrdinal(ordinal);
        return;
      default: return;
    }
    event.preventDefault();
    if (next !== null) this.ensureOrdinal(next, true);
  }

  private ensureOrdinal(ordinal: number, focus: boolean): void {
    const session = this.session;
    if (!session || ordinal < 0 || ordinal >= session.root.childCount) return;
    this.focusedOrdinal = ordinal;
    if (session.root.childCount > MAX_PHYSICAL_ROWS) {
      const maxStart = session.root.childCount - MAX_PHYSICAL_ROWS;
      if (ordinal < this.segmentStart || ordinal >= this.segmentStart + MAX_PHYSICAL_ROWS) {
        this.segmentStart = Math.min(maxStart, Math.max(0, ordinal - Math.floor(MAX_PHYSICAL_ROWS / 2)));
      }
    }
    this.elements.list.scrollTop = (ordinal - this.segmentStart) * this.rowHeight;
    this.pendingScrollTop = (ordinal - this.segmentStart) * this.rowHeight;
    const start = Math.floor(ordinal / PAGE_SIZE) * PAGE_SIZE;
    const page = this.pages.get(start);
    if (page) {
      this.windowStart = start;
      this.render();
      if (focus) queueMicrotask(() => this.focusOrdinal(ordinal));
    } else {
      this.pendingFocus = focus ? ordinal : null;
      this.requestPage(start, this.pendingFocus);
    }
  }

  private requestPage(start: number, focusOrdinal: number | null): void {
    const session = this.session;
    if (!session || this.opening) return;
    const normalized = Math.max(0, Math.floor(start / PAGE_SIZE) * PAGE_SIZE);
    if (this.pageRequest) {
      this.wantedStart = normalized;
      if (focusOrdinal !== null) this.pendingFocus = focusOrdinal;
      return;
    }
    const cached = this.pages.get(normalized);
    if (cached) {
      this.windowStart = normalized;
      this.pendingFocus = focusOrdinal;
      this.render();
      if (cached.hasMore && cached.nextCursor !== null) this.prefetchPage(cached.nextCursor);
      if (focusOrdinal !== null) queueMicrotask(() => this.focusOrdinal(focusOrdinal));
      return;
    }
    this.windowStart = normalized;
    this.wantedStart = null;
    this.pendingFocus = focusOrdinal;
    this.listError = null;
    const request: PageRequest = { epoch: this.epoch, revision: session.revision, rootId: session.root.id, start: normalized };
    this.pageRequest = request;
    this.render();
    void this.loadPage(request);
  }

  private async loadPage(request: PageRequest): Promise<void> {
    try {
      const value = await this.invokeRequest<unknown>("get_children", {
        nodeId: request.rootId,
        cursor: request.start,
        limit: PAGE_SIZE,
        scopeId: null,
        sessionRevision: request.revision
      });
      if (!this.isCurrent(request)) return;
      const session = this.session!;
      const page = validateNodePage(value, request.start, session.root.childCount, session.sourceSize, []);
      if (!page) throw new Error("The Collection Item page response was invalid.");
      const expected = Math.min(PAGE_SIZE, session.root.childCount - request.start);
      if (page.nodes.length !== expected || page.hasMore !== request.start + expected < session.root.childCount) {
        throw new Error("The Collection Item page was incomplete.");
      }
      this.pages.set(request.start, { start: request.start, ...page });
      this.prunePages(request.start);
      this.pageRequest = null;
      this.listError = null;
      const focus = this.pendingFocus;
      this.pendingFocus = null;
      this.render();
      if (page.hasMore && page.nextCursor !== null) this.prefetchPage(page.nextCursor);
      const wanted = this.wantedStart;
      this.wantedStart = null;
      if (wanted !== null && wanted !== request.start) {
        this.requestPage(wanted, focus);
        return;
      }
      if (focus !== null) queueMicrotask(() => this.focusOrdinal(focus));
    } catch (error) {
      if (!this.isCurrent(request)) return;
      this.pageRequest = null;
      this.listError = errorMessage(error);
      this.render();
      if (isGlobalError(error)) this.onError(error);
    }
  }

  private prunePages(current: number): void {
    const starts = Array.from(this.pages.keys()).sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
    for (const start of starts.slice(3)) this.pages.delete(start);
  }

  private prefetchPage(start: number): void {
    const session = this.session;
    if (!session || this.opening || start >= session.root.childCount || this.pages.has(start) || this.prefetchRequests.has(start)) return;
    const request: PageRequest = { epoch: this.epoch, revision: session.revision, rootId: session.root.id, start };
    this.prefetchRequests.set(start, request);
    void this.invokeRequest<unknown>("get_children", {
      nodeId: request.rootId,
      cursor: request.start,
      limit: PAGE_SIZE,
      scopeId: null,
      sessionRevision: request.revision
    }).then((value) => {
      if (!this.isSessionCurrent(request)) return;
      const page = validateNodePage(value, request.start, session.root.childCount, session.sourceSize, []);
      const expected = Math.min(PAGE_SIZE, session.root.childCount - request.start);
      if (!page || page.nodes.length !== expected || page.hasMore !== request.start + expected < session.root.childCount) return;
      this.pages.set(request.start, { start: request.start, ...page });
      this.prunePages(this.windowStart);
      if (this.windowStart === request.start - PAGE_SIZE) this.render();
    }).catch((error) => {
      if (this.isSessionCurrent(request) && isGlobalError(error)) this.onError(error);
    }).finally(() => {
      this.prefetchRequests.delete(start);
    });
  }

  private retryPage(): void {
    if (this.pageRequest || !this.session) return;
    this.requestPage(this.windowStart, this.pendingFocus);
  }

  private selectOrdinal(ordinal: number): void {
    const page = this.pages.get(Math.floor(ordinal / PAGE_SIZE) * PAGE_SIZE);
    const node = page?.nodes[ordinal - page.start];
    if (!node) {
      this.ensureOrdinal(ordinal, true);
      return;
    }
    this.selectedOrdinal = ordinal;
    this.focusedOrdinal = ordinal;
    this.render();
    this.onSelection(node, ordinal);
  }

  private goToItem(): void {
    const session = this.session;
    if (!session || this.opening) return;
    const value = this.elements.goInput.value.trim();
    if (!/^\d+$/.test(value)) {
      this.setGoError("Enter a non-negative decimal Item number.");
      return;
    }
    const ordinal = Number(value);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= session.root.childCount) {
      this.setGoError(`Item ${value} is outside the collection (total ${session.root.childCount.toLocaleString()}).`);
      return;
    }
    this.goError = null;
    this.ensureOrdinal(ordinal, true);
    this.render();
  }

  private setGoError(message: string): void {
    this.goError = message;
    this.render();
    this.elements.goInput.focus();
    this.elements.goInput.select();
  }

  private focusOrdinal(ordinal: number): void {
    const item = this.elements.list.querySelector<HTMLElement>(`[data-item-ordinal="${ordinal}"]`);
    if (!item) return;
    this.focusedOrdinal = ordinal;
    for (const option of this.elements.list.querySelectorAll<HTMLElement>("[role=option]")) option.tabIndex = option === item ? 0 : -1;
    item.focus();
    item.scrollIntoView({ block: "nearest" });
  }

  private isCurrent(request: PageRequest): boolean {
    return this.pageRequest === request && this.isSessionCurrent(request);
  }

  private isSessionCurrent(request: PageRequest): boolean {
    return request.epoch === this.epoch
      && this.session?.revision === request.revision
      && this.session.root.id === request.rootId;
  }

  private render(): void {
    this.rendering = true;
    const active = document.activeElement instanceof HTMLElement ? Number(document.activeElement.dataset.itemOrdinal) : NaN;
    const restoreOrdinal = Number.isSafeInteger(active) ? active : null;
    const scrollTop = this.elements.list.scrollTop;
    const session = this.session;
    const total = session?.root.childCount ?? 0;
    const busy = this.opening || this.pageRequest !== null;
    this.elements.section.hidden = session === null;
    this.elements.goInput.disabled = busy;
    this.elements.goButton.disabled = busy;
    this.elements.retry.hidden = this.listError === null;
    this.elements.retry.disabled = busy;
    this.elements.goError.textContent = this.goError ?? "";
    this.elements.status.textContent = this.listStatus(total);
    this.elements.list.setAttribute("aria-busy", String(this.pageRequest !== null));
    this.elements.list.style.setProperty("--collection-row-height", `${this.rowHeight}px`);
    this.elements.list.replaceChildren();
    if (!session) {
      this.rendering = false;
      return;
    }
    if (total === 0) {
      const empty = document.createElement("div");
      empty.className = "collection-list-empty";
      empty.textContent = "No items found.";
      this.elements.list.append(empty);
      this.rendering = false;
      return;
    }
    const spacer = document.createElement("div");
    spacer.className = "collection-list-spacer";
    spacer.style.height = `${Math.min(total, MAX_PHYSICAL_ROWS) * this.rowHeight}px`;
    const visiblePages = [this.pages.get(this.windowStart), this.pages.get(this.windowStart + PAGE_SIZE)].filter((page): page is ItemPage => page !== undefined);
    for (const page of visiblePages) {
      const windowElement = document.createElement("div");
      windowElement.className = "collection-list-window";
      windowElement.style.top = `${(page.start - this.segmentStart) * this.rowHeight}px`;
      for (let index = 0; index < page.nodes.length; index += 1) {
        windowElement.append(this.itemElement(page.nodes[index], page.start + index, busy));
      }
      spacer.append(windowElement);
    }
    this.elements.list.append(spacer);
    const restoreScrollTop = this.pendingScrollTop ?? scrollTop;
    this.elements.list.scrollTop = restoreScrollTop;
    this.pendingScrollTop = null;
    if (restoreScrollTop > 0) {
      window.setTimeout(() => {
        if (this.elements.list.scrollTop !== restoreScrollTop) this.elements.list.scrollTop = restoreScrollTop;
      }, 0);
    }
    if (restoreOrdinal !== null) queueMicrotask(() => this.focusOrdinal(restoreOrdinal));
    window.setTimeout(() => { this.rendering = false; }, 0);
  }

  private itemElement(node: NodeDto, ordinal: number, busy: boolean): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "collection-option";
    item.setAttribute("role", "option");
    item.dataset.itemOrdinal = String(ordinal);
    item.tabIndex = this.focusedOrdinal === ordinal || this.focusedOrdinal === null && ordinal === this.windowStart ? 0 : -1;
    item.setAttribute("aria-selected", String(this.selectedOrdinal === ordinal));
    item.setAttribute("aria-setsize", String(this.session?.root.childCount ?? 0));
    item.setAttribute("aria-posinset", String(ordinal + 1));
    item.setAttribute("aria-disabled", String(busy));
    item.setAttribute("aria-label", `Item ${ordinal}, ${node.kind}, source bytes ${node.spanStart} to ${node.spanEnd}`);
    const title = document.createElement("span");
    title.className = "collection-option-title";
    title.textContent = `Item ${ordinal}`;
    const meta = document.createElement("span");
    meta.className = "collection-option-meta";
    meta.textContent = `${node.kind} · [${node.spanStart}, ${node.spanEnd})`;
    item.append(title, meta);
    return item;
  }

  private listStatus(total: number): string {
    if (this.listError) return "Items could not be loaded. Retry to continue.";
    if (!total) return "Empty collection.";
    if (this.pageRequest) return `Loading Items ${this.windowStart.toLocaleString()}–${Math.min(total, this.windowStart + PAGE_SIZE).toLocaleString()}…`;
    const selected = this.selectedOrdinal === null ? "No Item selected" : `Item ${this.selectedOrdinal} selected`;
    return `${selected} · ${total.toLocaleString()} items · virtual list`;
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string") {
    return Reflect.get(error, "message") as string;
  }
  if (error instanceof Error) return error.message;
  return "The Collection Items could not be loaded.";
}

function isGlobalError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return code === "file_changed" || code === "stale_session";
}
