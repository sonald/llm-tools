import { t } from "./i18n";
import { ProjectionBudget } from "./projection-budget";

export type SearchRepresentation = "decoded" | "rawSource";
export type SearchField = "key" | "value" | "rawSource";

export type SearchScope = {
  label: string;
  description: string;
  enabled: boolean;
  decodedEnabled: boolean;
  scopeStart: number;
  scopeEnd: number;
  sessionRevision: number;
  scopeId: number | null;
  targetNodeId: number | null;
};

export type SearchMatch = {
  nodeId: number | null;
  field: SearchField;
  pathSegments: string[];
  pathTruncated: boolean;
  sourceSpanStart: number;
  sourceSpanEnd: number;
  matchStart: number;
  matchEnd: number;
};

export type SearchCursor = {
  kind: "decoded" | "rawSource";
  nodeId?: number;
  field?: "key" | "value";
  byteOffset: number;
  query: string;
  sessionRevision: number;
  scopeId: number | null;
  targetNodeId: number | null;
};

export type SearchPage = {
  matches: SearchMatch[];
  hasMore: boolean;
  nextCursor: SearchCursor | null;
};

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type SearchViewElements = {
  form: HTMLFormElement;
  query: HTMLInputElement;
  decoded: HTMLInputElement;
  rawSource: HTMLInputElement;
  submit: HTMLButtonElement;
  description: HTMLElement;
  panel: HTMLElement;
  resultsPanel: HTMLElement;
  status: HTMLElement;
  results: HTMLElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
};

type SearchViewOptions = SearchViewElements & {
  invoke: Invoke;
  onReveal: (match: SearchMatch) => void;
  onError: (error: unknown) => void;
  projectionBudget?: ProjectionBudget;
  onIntentChange?: () => void;
  onRepresentationChange?: (representation: SearchRepresentation) => void;
};

type SearchHistoryPage = {
  requestCursor: SearchCursor | null;
  page: SearchPage;
  bytes: number;
};

type SearchRequestToken = {
  epoch: number;
  serial: number;
  query: string;
  representation: SearchRepresentation;
  scope: string;
};

const PAGE_SIZE = 50;
const MAX_PATH_BYTES = 2048;
const MAX_QUERY_BYTES = 4096;
const MAX_HISTORY_PAGES = 16;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const UTF8 = new TextEncoder();

export class SearchView {
  private readonly elements: SearchViewElements;
  private readonly invoke: Invoke;
  private readonly onReveal: (match: SearchMatch) => void;
  private readonly onError: (error: unknown) => void;
  private readonly projectionBudget: ProjectionBudget;
  private readonly onIntentChange: () => void;
  private readonly onRepresentationChange: ((representation: SearchRepresentation) => void) | undefined;
  private rawEnabled = true;
  private scope: SearchScope | null = null;
  private history = new Map<number, SearchHistoryPage>();
  private historyBytes = 0;
  private currentPageNumber = -1;
  private restoreAttemptedPageNumber: number | null = null;
  private epoch = 0;
  private serial = 0;
  private request: SearchRequestToken | null = null;
  private busy = false;

  constructor(options: SearchViewOptions) {
    this.elements = options;
    this.invoke = options.invoke;
    this.onReveal = options.onReveal;
    this.onError = options.onError;
    this.projectionBudget = options.projectionBudget ?? new ProjectionBudget();
    this.onIntentChange = options.onIntentChange ?? (() => undefined);
    this.onRepresentationChange = options.onRepresentationChange;
    this.elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.isOwner()) void this.submit();
    });
    this.elements.previous.addEventListener("click", () => { if (this.isOwner()) this.showPrevious(); });
    this.elements.next.addEventListener("click", () => { if (this.isOwner()) void this.showNext(); });
    this.elements.query.addEventListener("input", () => { if (this.isOwner()) this.criteriaChanged(); });
    this.elements.decoded.addEventListener("change", () => { if (this.isOwner()) this.representationChanged(); });
    this.elements.rawSource.addEventListener("change", () => { if (this.isOwner()) this.representationChanged(); });
    this.clear();
  }

  setScope(scope: SearchScope | null): void {
    const ownerBefore = this.owner();
    const changed = scopeKey(this.scope) !== scopeKey(scope);
    this.scope = scope;
    if (scope?.enabled && this.owner() !== "rendered") this.setOwner("source");
    else if (!scope?.enabled && this.owner() === "source") this.setOwner(null);
    if (ownerBefore !== "source" && this.owner() === "source") this.restoreAttemptedPageNumber = null;
    if (changed) this.resetResults(true, true);
    else {
      this.render();
      this.restoreMissingCurrentPage();
    }
  }

  clear(): void {
    this.scope = null;
    this.resetResults(true, false);
  }

  invalidate(): void {
    this.epoch += 1;
    this.request = null;
    this.resetResults(false, true);
  }

  focusQuery(): void {
    if (this.owner() === "rendered") return;
    this.elements.query.focus();
    this.elements.query.select();
  }

  get query(): string {
    return this.elements.query.value;
  }

  get intentEpoch(): number {
    return this.epoch;
  }

  get cachedPageCount(): number {
    return this.history.size;
  }

  get cachedHistoryBytes(): number {
    return this.historyBytes;
  }

  setRepresentation(representation: SearchRepresentation): void {
    if (this.owner() === "rendered") return;
    this.elements.decoded.checked = representation === "decoded";
    this.elements.rawSource.checked = representation === "rawSource";
    this.render();
  }

  setRawEnabled(enabled: boolean): void {
    this.rawEnabled = enabled;
    if (this.owner() === "rendered") return;
    if (!enabled) {
      this.elements.rawSource.checked = false;
      this.elements.decoded.checked = true;
    }
    this.render();
  }

  refresh(): void {
    if (this.owner() !== "rendered") {
      if (this.scope) this.setOwner("source");
      this.render();
      this.restoreAttemptedPageNumber = null;
      this.restoreMissingCurrentPage();
    }
  }

  handleEscape(event: KeyboardEvent): boolean {
    if (!this.isOwner()) return false;
    if (this.elements.resultsPanel.hidden) return false;
    event.preventDefault();
    event.stopPropagation();
    this.resetResults(false, true);
    this.focusQuery();
    return true;
  }

  private criteriaChanged(): void {
    this.resetResults(false, true);
  }

  private representationChanged(): void {
    const scope = this.scope;
    if (scope && this.onRepresentationChange) {
      this.onRepresentationChange(this.selectedRepresentation(scope));
      return;
    }
    this.criteriaChanged();
  }

  private resetResults(clearQuery: boolean, notify: boolean): void {
    const ownsForm = this.owner() !== "rendered";
    this.epoch += 1;
    this.request = null;
    this.clearHistory();
    this.busy = false;
    if (ownsForm) {
      if (clearQuery) this.elements.query.value = "";
      this.setStatus("");
      this.elements.results.replaceChildren();
      this.elements.resultsPanel.hidden = true;
      this.render();
    }
    if (notify && ownsForm) this.onIntentChange();
  }

  private async submit(): Promise<void> {
    if (!this.isOwner()) return;
    const scope = this.scope;
    if (!scope?.enabled || this.busy) return;
    const query = this.elements.query.value;
    const queryBytes = UTF8.encode(query).byteLength;
    if (query.length === 0 || queryBytes > MAX_QUERY_BYTES) {
      this.showLocalError(query.length === 0 ? t("search.emptyQuery") : t("search.queryTooLong"));
      return;
    }
    const representation = this.selectedRepresentation(scope);
    const requestCursor = null;
    this.clearHistory();
    const token = this.beginRequest(query, representation, scope, t("search.searching"));
    try {
      const value = await this.invoke<unknown>("search_current", {
        query,
        representation,
        scopeId: scope.scopeId,
        nodeId: scope.targetNodeId,
        cursor: requestCursor,
        limit: PAGE_SIZE,
        sessionRevision: scope.sessionRevision
      });
      if (!this.isCurrent(token)) return;
      const page = parseSearchPageValue(value, representation, query, scope);
      const cached = this.putHistoryPage(0, { requestCursor, page, bytes: estimateHistoryPageBytes(requestCursor, page) }, this.currentPageNumber, () => this.isCurrent(token));
      if (!this.isCurrent(token)) return;
      if (!cached) {
        this.setStatus(t("search.projectionBudgetExceeded"), true);
        this.elements.results.replaceChildren();
        this.elements.resultsPanel.hidden = false;
        return;
      }
      if (!this.isCurrent(token)) return;
      this.setCurrentPage(0);
      this.setStatus(pageStatus(page, representation));
      this.elements.resultsPanel.hidden = false;
      this.renderPage();
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.setStatus(errorMessage(error), true);
      this.elements.results.replaceChildren();
      this.elements.resultsPanel.hidden = false;
      if (isGlobalError(error)) this.onError(error);
    } finally {
      if (this.isCurrent(token)) {
        this.request = null;
        this.busy = false;
        this.render();
      }
    }
  }

  private async showNext(): Promise<void> {
    if (!this.isOwner()) return;
    const current = this.currentHistoryPage();
    const scope = this.scope;
    if (!scope || this.busy || this.currentPageNumber < 0 || !current || !current.page.hasMore) return;
    const cachedPageNumber = this.currentPageNumber + 1;
    if (this.history.has(cachedPageNumber)) {
      this.invalidatePageIntent();
      this.setCurrentPage(cachedPageNumber);
      const cached = this.currentHistoryPage();
      if (cached) this.setStatus(pageStatus(cached.page, this.selectedRepresentation(scope)));
      this.renderPage();
      return;
    }
    const cursor = current.page.nextCursor;
    if (!cursor) return;
    const query = this.elements.query.value;
    const representation = this.selectedRepresentation(scope);
    const token = this.beginRequest(query, representation, scope, t("search.searching"));
    try {
      const value = await this.invoke<unknown>("search_current", {
        query,
        representation,
        scopeId: scope.scopeId,
        nodeId: scope.targetNodeId,
        cursor,
        limit: PAGE_SIZE,
        sessionRevision: scope.sessionRevision
      });
      if (!this.isCurrent(token)) return;
      const page = parseSearchPageValue(value, representation, query, scope, cursor);
      const cached = this.putHistoryPage(cachedPageNumber, { requestCursor: cursor, page, bytes: estimateHistoryPageBytes(cursor, page) }, this.currentPageNumber, () => this.isCurrent(token));
      if (!this.isCurrent(token)) return;
      if (!cached) {
        this.setStatus(t("search.projectionBudgetExceeded"), true);
        this.renderPage();
        return;
      }
      if (!this.isCurrent(token)) return;
      this.setCurrentPage(cachedPageNumber);
      this.setStatus(pageStatus(page, representation));
      this.renderPage();
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.setStatus(errorMessage(error), true);
      this.renderPage();
      if (isGlobalError(error)) this.onError(error);
    } finally {
      if (this.isCurrent(token)) {
        this.request = null;
        this.busy = false;
        this.render();
      }
    }
  }

  private showPrevious(): void {
    if (!this.isOwner() || this.busy || this.currentPageNumber <= 0) return;
    const targetPageNumber = this.currentPageNumber - 1;
    const scope = this.scope;
    if (this.history.has(targetPageNumber)) {
      this.invalidatePageIntent();
      this.setCurrentPage(targetPageNumber);
      const current = this.currentHistoryPage();
      if (scope && current) this.elements.status.textContent = pageStatus(current.page, this.selectedRepresentation(scope));
      this.renderPage();
      return;
    }
    void this.replayPrevious(targetPageNumber);
  }

  private renderPage(): void {
    const current = this.currentHistoryPage();
    if (!current) {
      this.elements.results.replaceChildren();
      this.render();
      return;
    }
    const fragment = document.createDocumentFragment();
    current.page.matches.forEach((match, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result-button";
      button.dataset.resultIndex = String(index);
      button.textContent = resultLabel(match);
      button.title = resultLabel(match);
      const resultEpoch = this.epoch;
      button.addEventListener("click", () => {
        if (this.isOwner() && this.epoch === resultEpoch && this.currentHistoryPage()?.page.matches[index] === match) this.onReveal(match);
      });
      fragment.append(button);
    });
    this.elements.results.replaceChildren(fragment);
    this.elements.resultsPanel.hidden = false;
    this.render();
  }

  private async replayPrevious(targetPageNumber: number): Promise<void> {
    const scope = this.scope;
    if (!scope || this.currentPageNumber <= targetPageNumber || this.busy) return;
    const query = this.elements.query.value;
    const representation = this.selectedRepresentation(scope);
    const token = this.beginRequest(query, representation, scope, t("search.relocatingHistory"));
    const seed = this.replaySeed(targetPageNumber);
    let pageNumber = seed ? seed.pageNumber + 1 : 0;
    let cursor = seed ? seed.entry.page.nextCursor : null;
    try {
      while (pageNumber <= targetPageNumber) {
        if (!this.isCurrent(token)) return;
        const requestCursor = cursor;
        const value = await this.invoke<unknown>("search_current", {
          query,
          representation,
          scopeId: scope.scopeId,
          nodeId: scope.targetNodeId,
          cursor: requestCursor,
          limit: PAGE_SIZE,
          sessionRevision: scope.sessionRevision
        });
        if (!this.isCurrent(token)) return;
        const page = parseSearchPageValue(value, representation, query, scope, requestCursor);
        const cached = this.putHistoryPage(pageNumber, { requestCursor, page, bytes: estimateHistoryPageBytes(requestCursor, page) }, this.currentPageNumber, () => this.isCurrent(token));
        if (!this.isCurrent(token)) return;
        if (!cached) {
          throw new Error(t("search.projectionBudgetExceeded"));
        }
        if (!this.isCurrent(token)) return;
        if (pageNumber === targetPageNumber) {
          this.setCurrentPage(targetPageNumber);
          this.setStatus(pageStatus(page, representation));
          this.renderPage();
          return;
        }
        if (!page.hasMore || page.nextCursor === null) throw new Error(t("search.responseCursorStateInvalid"));
        cursor = page.nextCursor;
        pageNumber += 1;
      }
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.setStatus(errorMessage(error), true);
      this.renderPage();
      if (isGlobalError(error)) this.onError(error);
    } finally {
      if (this.isCurrent(token)) {
        this.request = null;
        this.busy = false;
        this.render();
      }
    }
  }

  private beginRequest(query: string, representation: SearchRepresentation, scope: SearchScope, status: string): SearchRequestToken {
    this.epoch += 1;
    this.onIntentChange();
    const token: SearchRequestToken = {
      epoch: this.epoch,
      serial: ++this.serial,
      query,
      representation,
      scope: scopeKey(scope)
    };
    this.request = token;
    this.busy = true;
    this.elements.resultsPanel.hidden = false;
    this.setStatus(status);
    this.render();
    return token;
  }

  private invalidatePageIntent(): void {
    this.epoch += 1;
    this.request = null;
    this.onIntentChange();
  }

  private currentHistoryPage(): SearchHistoryPage | null {
    return this.currentPageNumber < 0 ? null : this.history.get(this.currentPageNumber) ?? null;
  }

  private setCurrentPage(pageNumber: number): void {
    const entry = this.history.get(pageNumber);
    if (!entry) return;
    this.history.delete(pageNumber);
    this.history.set(pageNumber, entry);
    this.projectionBudget.touch(entry);
    this.currentPageNumber = pageNumber;
    this.trimHistory(pageNumber);
  }

  private putHistoryPage(pageNumber: number, entry: SearchHistoryPage, protectedPageNumber: number, stillCurrent?: () => boolean): boolean {
    const previous = this.history.get(pageNumber);
    let protectedEntry = previous ?? entry;
    if (!this.projectionBudget.admit(
      entry,
      entry.bytes,
      () => this.evictBudgetPage(entry),
      () => this.owner() !== "source" || this.currentHistoryPage() !== protectedEntry
    )) return false;
    if (stillCurrent && !stillCurrent()) {
      this.projectionBudget.release(entry);
      return false;
    }
    if (previous && this.history.get(pageNumber) === previous) {
      this.projectionBudget.release(previous);
      this.historyBytes -= previous.bytes;
      this.history.delete(pageNumber);
    }
    this.history.set(pageNumber, entry);
    protectedEntry = entry;
    this.historyBytes += entry.bytes;
    this.trimHistory(protectedPageNumber);
    return true;
  }

  private evictBudgetPage(entry: SearchHistoryPage): void {
    for (const [pageNumber, cached] of this.history) {
      if (cached !== entry) continue;
      this.history.delete(pageNumber);
      this.historyBytes -= entry.bytes;
      if (pageNumber === this.currentPageNumber && this.owner() !== "source") this.restoreAttemptedPageNumber = null;
      return;
    }
  }

  private trimHistory(protectedPageNumber: number): void {
    while (this.history.size > MAX_HISTORY_PAGES || this.historyBytes > MAX_HISTORY_BYTES) {
      let evictedPageNumber: number | undefined;
      for (const pageNumber of this.history.keys()) {
        if (pageNumber !== protectedPageNumber) {
          evictedPageNumber = pageNumber;
          break;
        }
      }
      if (evictedPageNumber === undefined) break;
      const entry = this.history.get(evictedPageNumber);
      this.history.delete(evictedPageNumber);
      if (entry) {
        this.projectionBudget.release(entry);
        this.historyBytes -= entry.bytes;
      }
    }
  }

  private replaySeed(targetPageNumber: number): { pageNumber: number; entry: SearchHistoryPage } | null {
    let seed: { pageNumber: number; entry: SearchHistoryPage } | null = null;
    for (const [pageNumber, entry] of this.history) {
      if (pageNumber < targetPageNumber && (!seed || pageNumber > seed.pageNumber)) seed = { pageNumber, entry };
    }
    return seed;
  }

  private restoreMissingCurrentPage(): void {
    if (!this.isOwner() || !this.scope?.enabled || this.busy || this.currentPageNumber < 0
      || this.currentHistoryPage() || this.restoreAttemptedPageNumber === this.currentPageNumber) return;
    this.restoreAttemptedPageNumber = this.currentPageNumber;
    void this.restoreCurrentPage();
  }

  private async restoreCurrentPage(): Promise<void> {
    const scope = this.scope;
    const targetPageNumber = this.currentPageNumber;
    if (!scope || targetPageNumber < 0 || this.currentHistoryPage() || this.busy) return;
    const query = this.elements.query.value;
    const representation = this.selectedRepresentation(scope);
    const token = this.beginRequest(query, representation, scope, t("search.relocatingHistory"));
    const seed = this.replaySeed(targetPageNumber);
    let pageNumber = seed ? seed.pageNumber + 1 : 0;
    let cursor = seed ? seed.entry.page.nextCursor : null;
    try {
      while (pageNumber <= targetPageNumber) {
        if (!this.isCurrent(token)) return;
        const requestCursor = cursor;
        const value = await this.invoke<unknown>("search_current", {
          query,
          representation,
          scopeId: scope.scopeId,
          nodeId: scope.targetNodeId,
          cursor: requestCursor,
          limit: PAGE_SIZE,
          sessionRevision: scope.sessionRevision
        });
        if (!this.isCurrent(token)) return;
        const page = parseSearchPageValue(value, representation, query, scope, requestCursor);
        const cached = this.putHistoryPage(pageNumber, { requestCursor, page, bytes: estimateHistoryPageBytes(requestCursor, page) }, targetPageNumber, () => this.isCurrent(token));
        if (!this.isCurrent(token)) return;
        if (!cached) throw new Error(t("search.projectionBudgetExceeded"));
        if (pageNumber === targetPageNumber) {
          this.setCurrentPage(targetPageNumber);
          this.restoreAttemptedPageNumber = null;
          this.setStatus(pageStatus(page, representation));
          this.renderPage();
          return;
        }
        if (!page.hasMore || page.nextCursor === null) throw new Error(t("search.responseCursorStateInvalid"));
        cursor = page.nextCursor;
        pageNumber += 1;
      }
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.setStatus(errorMessage(error), true);
      this.renderPage();
      if (isGlobalError(error)) this.onError(error);
    } finally {
      if (this.isCurrent(token)) {
        this.request = null;
        this.busy = false;
        this.render();
      }
    }
  }

  private showLocalError(message: string): void {
    this.epoch += 1;
    this.request = null;
    this.busy = false;
    if (this.owner() === "rendered") return;
    this.elements.resultsPanel.hidden = false;
    this.setStatus(message, true);
    this.elements.results.replaceChildren();
    this.clearHistory();
    this.onIntentChange();
    this.render();
  }

  private setStatus(message: string, alert = false): void {
    this.elements.status.textContent = message;
    this.elements.status.setAttribute("role", alert ? "alert" : "status");
  }

  private clearHistory(): void {
    for (const entry of this.history.values()) this.projectionBudget.release(entry);
    this.history.clear();
    this.historyBytes = 0;
    this.currentPageNumber = -1;
    this.restoreAttemptedPageNumber = null;
  }

  private render(): void {
    if (this.owner() === "rendered") return;
    const scope = this.scope;
    const enabled = Boolean(scope?.enabled) && !this.busy;
    this.elements.panel.hidden = scope === null;
    this.elements.description.textContent = scope?.description ?? t("search.openFileDescription");
    this.elements.query.disabled = !enabled;
    this.elements.decoded.disabled = !enabled || scope?.decodedEnabled === false;
    this.elements.rawSource.disabled = !enabled || !this.rawEnabled;
    this.elements.submit.disabled = !enabled;
    if (scope && !scope.decodedEnabled && this.elements.decoded.checked) this.elements.rawSource.checked = true;
    this.elements.previous.disabled = this.busy || this.currentPageNumber <= 0;
    const current = this.currentHistoryPage();
    this.elements.next.disabled = this.busy || !current?.page.hasMore;
    this.elements.form.setAttribute("aria-busy", String(this.busy));
  }

  private selectedRepresentation(scope: SearchScope): SearchRepresentation {
    return scope.decodedEnabled && this.elements.decoded.checked ? "decoded" : "rawSource";
  }

  private isCurrent(token: SearchRequestToken): boolean {
    return this.owner() === "source"
      && this.request === token
      && token.epoch === this.epoch
      && this.elements.query.value === token.query
      && this.scope !== null
      && scopeKey(this.scope) === token.scope
      && this.selectedRepresentation(this.scope) === token.representation;
  }

  private owner(): "source" | "rendered" | null {
    const owner = this.elements.form.dataset.searchOwner;
    return owner === "source" || owner === "rendered" ? owner : null;
  }

  private setOwner(owner: "source" | "rendered" | null): void {
    if (owner === null) delete this.elements.form.dataset.searchOwner;
    else this.elements.form.dataset.searchOwner = owner;
  }

  private isOwner(): boolean {
    return this.owner() === "source";
  }
}

export function parseSearchPageValue(
  value: unknown,
  representation: SearchRepresentation,
  query: string,
  scope: SearchScope,
  requestCursor: SearchCursor | null = null
): SearchPage {
  if (!recordWithKeys(value, ["matches", "hasMore", "nextCursor"])) throw new Error(t("search.responseInvalid"));
  if (!Array.isArray(value.matches) || value.matches.length > PAGE_SIZE || typeof value.hasMore !== "boolean") {
    throw new Error(t("search.responsePageInvalid"));
  }
  const matches = value.matches.map((match) => searchMatchValue(match, representation, query, scope));
  const nextCursor = value.nextCursor === null
    ? null
    : searchCursorValue(value.nextCursor, representation, query, scope.sessionRevision, scope.scopeId, requestCursor, scope.scopeEnd, scope.targetNodeId);
  if (value.hasMore !== (nextCursor !== null)) throw new Error(t("search.responseCursorStateInvalid"));
  return { matches, hasMore: value.hasMore, nextCursor };
}

function searchMatchValue(value: unknown, representation: SearchRepresentation, query: string, scope: SearchScope): SearchMatch {
  if (!recordWithKeys(value, ["nodeId", "field", "pathSegments", "pathTruncated", "sourceSpanStart", "sourceSpanEnd", "matchStart", "matchEnd"])) {
    throw new Error(t("search.resultInvalid"));
  }
  const nodeId = value.nodeId === null ? null : safeInteger(value.nodeId);
  const field = value.field;
  const pathSegments = value.pathSegments;
  const sourceSpanStart = safeInteger(value.sourceSpanStart);
  const sourceSpanEnd = safeInteger(value.sourceSpanEnd);
  const matchStart = safeInteger(value.matchStart);
  const matchEnd = safeInteger(value.matchEnd);
  const queryBytes = UTF8.encode(query).byteLength;
  if (nodeId === undefined) throw new Error(t("search.resultNodeInvalid"));
  if (!isSearchField(field) || !Array.isArray(pathSegments)
    || typeof value.pathTruncated !== "boolean" || sourceSpanStart === undefined || sourceSpanEnd === undefined
    || matchStart === undefined || matchEnd === undefined || sourceSpanStart < scope.scopeStart || sourceSpanStart >= sourceSpanEnd || sourceSpanEnd > scope.scopeEnd
    || matchStart >= matchEnd || matchEnd - matchStart !== queryBytes || pathSegments.length === 0
    || pathSegments.length > MAX_PATH_BYTES || pathSegments[0] !== "$"
    || (representation === "decoded" && matchEnd > sourceSpanEnd - sourceSpanStart) || (representation === "rawSource"
      ? nodeId !== scope.targetNodeId || field !== "rawSource" || matchStart < scope.scopeStart || matchEnd > scope.scopeEnd
        || scope.targetNodeId === null && (sourceSpanStart !== matchStart || sourceSpanEnd !== matchEnd)
        || scope.targetNodeId !== null && (sourceSpanStart !== scope.scopeStart || sourceSpanEnd !== scope.scopeEnd)
      : nodeId === null || (field !== "key" && field !== "value"))) {
    throw new Error(t("search.resultFieldsInvalid"));
  }
  let pathBytes = 0;
  const safePath: string[] = [];
  for (const segment of pathSegments) {
    if (typeof segment !== "string") throw new Error(t("search.resultPathInvalid"));
    if (safePath.length > 0 && segment.length === 0) throw new Error(t("search.resultPathInvalid"));
    pathBytes += UTF8.encode(segment).byteLength;
    if (pathBytes > MAX_PATH_BYTES) throw new Error(t("search.resultPathTooLong"));
    safePath.push(segment);
  }
  return { nodeId, field, pathSegments: safePath, pathTruncated: value.pathTruncated, sourceSpanStart, sourceSpanEnd, matchStart, matchEnd };
}

function searchCursorValue(
  value: unknown,
  representation: SearchRepresentation,
  query: string,
  sessionRevision: number,
  scopeId: number | null,
  previous: SearchCursor | null,
  scopeEnd: number,
  scopeTargetNodeId: number | null
): SearchCursor {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.query !== "string"
    || typeof value.sessionRevision !== "number" || value.scopeId !== scopeId || value.targetNodeId !== scopeTargetNodeId
    || value.query !== query || value.sessionRevision !== sessionRevision) {
    throw new Error(t("search.cursorInvalid"));
  }
  if (value.kind === "rawSource") {
    if (!recordWithKeys(value, ["kind", "byteOffset", "query", "sessionRevision", "scopeId", "targetNodeId"])) throw new Error(t("search.cursorInvalid"));
    const byteOffset = safeInteger(value.byteOffset);
    if (byteOffset === undefined || byteOffset < 0 || byteOffset > scopeEnd || representation !== "rawSource") throw new Error(t("search.rawCursorInvalid"));
    const cursor: SearchCursor = { kind: "rawSource", byteOffset, query, sessionRevision, scopeId, targetNodeId: scopeTargetNodeId };
    if (previous && (previous.kind !== cursor.kind || cursor.byteOffset <= previous.byteOffset)) throw new Error(t("search.cursorNotAdvanced"));
    return cursor;
  }
  if (value.kind !== "decoded" || !recordWithKeys(value, ["kind", "nodeId", "field", "byteOffset", "query", "sessionRevision", "scopeId", "targetNodeId"])) {
    throw new Error(t("search.decodedCursorInvalid"));
  }
  const nodeId = safeInteger(value.nodeId);
  const byteOffset = safeInteger(value.byteOffset);
  if (nodeId === undefined || byteOffset === undefined || (value.field !== "key" && value.field !== "value") || representation !== "decoded") {
    throw new Error(t("search.decodedCursorInvalid"));
  }
  const cursor: SearchCursor = { kind: "decoded", nodeId, field: value.field, byteOffset, query, sessionRevision, scopeId, targetNodeId: scopeTargetNodeId };
  if (previous && (previous.kind !== cursor.kind || !decodedCursorAdvanced(previous, cursor))) throw new Error(t("search.cursorNotAdvanced"));
  return cursor;
}

function decodedCursorAdvanced(previous: SearchCursor, next: SearchCursor): boolean {
  if (previous.kind !== "decoded" || next.kind !== "decoded" || next.nodeId! > previous.nodeId!) return true;
  if (next.nodeId !== previous.nodeId) return false;
  if (next.field === previous.field) return next.byteOffset > previous.byteOffset;
  return previous.field === "key" && next.field === "value";
}

function recordWithKeys(value: unknown, keys: string[]): value is Record<string, any> {
  if (!isRecord(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isSearchField(value: unknown): value is SearchField {
  return value === "key" || value === "value" || value === "rawSource";
}

function scopeKey(scope: SearchScope | null): string {
  if (!scope) return "none";
  return [scope.label, scope.decodedEnabled, scope.scopeStart, scope.scopeEnd, scope.sessionRevision, scope.scopeId, scope.targetNodeId].join("\u0000");
}

function resultLabel(match: SearchMatch): string {
  const path = match.pathSegments.join(".") || "$";
  const field = match.field === "rawSource" ? t("search.fieldRawSource") : match.field === "key" ? t("search.fieldKey") : t("search.fieldValue");
  return match.field === "rawSource"
    ? t("search.resultRaw", { field, path, matchStart: match.matchStart, matchEnd: match.matchEnd, sourceStart: match.sourceSpanStart, sourceEnd: match.sourceSpanEnd })
    : t("search.resultDecoded", { field, path, sourceStart: match.sourceSpanStart, sourceEnd: match.sourceSpanEnd });
}

function pageStatus(page: SearchPage, representation: SearchRepresentation): string {
  const mode = representation === "decoded" ? t("search.representationDecoded") : t("search.representationRawSource");
  const suffix = page.hasMore ? t("search.moreResults") : "";
  if (page.matches.length === 0) return t("search.noMatches", { representation: mode, suffix });
  if (page.matches.length === 1) return t("search.oneMatch", { representation: mode, suffix });
  return t("search.manyMatches", { representation: mode, count: page.matches.length, suffix });
}

function estimateHistoryPageBytes(requestCursor: SearchCursor | null, page: SearchPage): number {
  let bytes = 512 + estimateSearchCursorBytes(requestCursor) + estimateSearchCursorBytes(page.nextCursor);
  for (const match of page.matches) {
    bytes += 128;
    bytes += 8 * 6;
    bytes += match.pathTruncated ? 8 : 0;
    for (const segment of match.pathSegments) bytes += segment.length * 2 + 16;
  }
  return bytes;
}

function estimateSearchCursorBytes(cursor: SearchCursor | null): number {
  if (!cursor) return 8;
  return 128 + cursor.query.length * 2 + (cursor.field?.length ?? 0) * 2;
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (error instanceof Error) return error.message;
  return t("search.failed");
}

function isGlobalError(error: unknown): boolean {
  return isRecord(error) && (error.code === "file_changed" || error.code === "stale_session");
}
