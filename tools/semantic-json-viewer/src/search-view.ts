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
  onIntentChange?: () => void;
  onRepresentationChange?: (representation: SearchRepresentation) => void;
};

type SearchHistoryPage = {
  requestCursor: SearchCursor | null;
  page: SearchPage;
};

type SearchRequestToken = {
  epoch: number;
  serial: number;
};

const PAGE_SIZE = 50;
const MAX_PATH_BYTES = 2048;
const MAX_QUERY_BYTES = 4096;
const UTF8 = new TextEncoder();

export class SearchView {
  private readonly elements: SearchViewElements;
  private readonly invoke: Invoke;
  private readonly onReveal: (match: SearchMatch) => void;
  private readonly onError: (error: unknown) => void;
  private readonly onIntentChange: () => void;
  private readonly onRepresentationChange: ((representation: SearchRepresentation) => void) | undefined;
  private rawEnabled = true;
  private scope: SearchScope | null = null;
  private history: SearchHistoryPage[] = [];
  private currentIndex = -1;
  private epoch = 0;
  private serial = 0;
  private request: SearchRequestToken | null = null;
  private busy = false;

  constructor(options: SearchViewOptions) {
    this.elements = options;
    this.invoke = options.invoke;
    this.onReveal = options.onReveal;
    this.onError = options.onError;
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
    const changed = scopeKey(this.scope) !== scopeKey(scope);
    this.scope = scope;
    if (scope?.enabled && this.owner() !== "rendered") this.setOwner("source");
    else if (!scope?.enabled && this.owner() === "source") this.setOwner(null);
    if (changed) this.resetResults(true, true);
    else this.render();
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
    this.history = [];
    this.currentIndex = -1;
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
      this.showLocalError(query.length === 0 ? "Enter a search query." : "Search query exceeds the 4096-byte limit.");
      return;
    }
    const representation = this.selectedRepresentation(scope);
    const requestCursor = null;
    this.epoch += 1;
    this.onIntentChange();
    this.history = [];
    this.currentIndex = -1;
    const token = { epoch: this.epoch, serial: ++this.serial };
    this.request = token;
    this.busy = true;
    this.elements.resultsPanel.hidden = false;
    this.setStatus("Searching…");
    this.render();
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
      this.history = [{ requestCursor, page }];
      this.currentIndex = 0;
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
    const current = this.history[this.currentIndex];
    const scope = this.scope;
    if (!scope || this.busy || !current || !current.page.hasMore) return;
    if (this.currentIndex + 1 < this.history.length) {
      this.currentIndex += 1;
      this.setStatus(pageStatus(this.history[this.currentIndex].page, this.selectedRepresentation(scope)));
      this.renderPage();
      return;
    }
    const cursor = current.page.nextCursor;
    if (!cursor) return;
    const query = this.elements.query.value;
    const representation = this.selectedRepresentation(scope);
    this.epoch += 1;
    this.onIntentChange();
    const token = { epoch: this.epoch, serial: ++this.serial };
    this.request = token;
    this.busy = true;
    this.elements.resultsPanel.hidden = false;
    this.setStatus("Searching…");
    this.render();
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
      this.history.push({ requestCursor: cursor, page });
      this.currentIndex += 1;
      this.setStatus(pageStatus(page, representation));
      this.renderPage();
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.setStatus(errorMessage(error), true);
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
    if (!this.isOwner() || this.busy || this.currentIndex <= 0) return;
    this.currentIndex -= 1;
    const scope = this.scope;
    if (scope) this.elements.status.textContent = pageStatus(this.history[this.currentIndex].page, this.selectedRepresentation(scope));
    this.renderPage();
  }

  private renderPage(): void {
    const current = this.history[this.currentIndex];
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
        if (this.isOwner() && this.epoch === resultEpoch && this.history[this.currentIndex]?.page.matches[index] === match) this.onReveal(match);
      });
      fragment.append(button);
    });
    this.elements.results.replaceChildren(fragment);
    this.elements.resultsPanel.hidden = false;
    this.render();
  }

  private showLocalError(message: string): void {
    this.epoch += 1;
    this.request = null;
    this.busy = false;
    if (this.owner() === "rendered") return;
    this.elements.resultsPanel.hidden = false;
    this.setStatus(message, true);
    this.elements.results.replaceChildren();
    this.history = [];
    this.currentIndex = -1;
    this.onIntentChange();
    this.render();
  }

  private setStatus(message: string, alert = false): void {
    this.elements.status.textContent = message;
    this.elements.status.setAttribute("role", alert ? "alert" : "status");
  }

  private render(): void {
    if (this.owner() === "rendered") return;
    const scope = this.scope;
    const enabled = Boolean(scope?.enabled) && !this.busy;
    this.elements.panel.hidden = scope === null;
    this.elements.description.textContent = scope?.description ?? "Open a file to search its current scope.";
    this.elements.query.disabled = !enabled;
    this.elements.decoded.disabled = !enabled || scope?.decodedEnabled === false;
    this.elements.rawSource.disabled = !enabled || !this.rawEnabled;
    this.elements.submit.disabled = !enabled;
    if (scope && !scope.decodedEnabled && this.elements.decoded.checked) this.elements.rawSource.checked = true;
    this.elements.previous.disabled = this.busy || this.currentIndex <= 0;
    const current = this.history[this.currentIndex];
    this.elements.next.disabled = this.busy || !current?.page.hasMore;
    this.elements.form.setAttribute("aria-busy", String(this.busy));
  }

  private selectedRepresentation(scope: SearchScope): SearchRepresentation {
    return scope.decodedEnabled && this.elements.decoded.checked ? "decoded" : "rawSource";
  }

  private isCurrent(token: SearchRequestToken): boolean {
    return this.owner() === "source" && this.request === token && token.epoch === this.epoch;
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
  if (!recordWithKeys(value, ["matches", "hasMore", "nextCursor"])) throw new Error("The search response is invalid.");
  if (!Array.isArray(value.matches) || value.matches.length > PAGE_SIZE || typeof value.hasMore !== "boolean") {
    throw new Error("The search response page is invalid.");
  }
  const matches = value.matches.map((match) => searchMatchValue(match, representation, query, scope));
  const nextCursor = value.nextCursor === null
    ? null
    : searchCursorValue(value.nextCursor, representation, query, scope.sessionRevision, scope.scopeId, requestCursor, scope.scopeEnd, scope.targetNodeId);
  if (value.hasMore !== (nextCursor !== null)) throw new Error("The search response cursor state is invalid.");
  return { matches, hasMore: value.hasMore, nextCursor };
}

function searchMatchValue(value: unknown, representation: SearchRepresentation, query: string, scope: SearchScope): SearchMatch {
  if (!recordWithKeys(value, ["nodeId", "field", "pathSegments", "pathTruncated", "sourceSpanStart", "sourceSpanEnd", "matchStart", "matchEnd"])) {
    throw new Error("The search result is invalid.");
  }
  const nodeId = value.nodeId === null ? null : safeInteger(value.nodeId);
  const field = value.field;
  const pathSegments = value.pathSegments;
  const sourceSpanStart = safeInteger(value.sourceSpanStart);
  const sourceSpanEnd = safeInteger(value.sourceSpanEnd);
  const matchStart = safeInteger(value.matchStart);
  const matchEnd = safeInteger(value.matchEnd);
  const queryBytes = UTF8.encode(query).byteLength;
  if (nodeId === undefined) throw new Error("The search result node ID is invalid.");
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
    throw new Error("The search result fields are invalid.");
  }
  let pathBytes = 0;
  const safePath: string[] = [];
  for (const segment of pathSegments) {
    if (typeof segment !== "string") throw new Error("The search result path is invalid.");
    if (safePath.length > 0 && segment.length === 0) throw new Error("The search result path is invalid.");
    pathBytes += UTF8.encode(segment).byteLength;
    if (pathBytes > MAX_PATH_BYTES) throw new Error("The search result path is too long.");
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
    throw new Error("The search cursor is invalid.");
  }
  if (value.kind === "rawSource") {
    if (!recordWithKeys(value, ["kind", "byteOffset", "query", "sessionRevision", "scopeId", "targetNodeId"])) throw new Error("The search cursor is invalid.");
    const byteOffset = safeInteger(value.byteOffset);
    if (byteOffset === undefined || byteOffset < 0 || byteOffset > scopeEnd || representation !== "rawSource") throw new Error("The raw search cursor is invalid.");
    const cursor: SearchCursor = { kind: "rawSource", byteOffset, query, sessionRevision, scopeId, targetNodeId: scopeTargetNodeId };
    if (previous && (previous.kind !== cursor.kind || cursor.byteOffset <= previous.byteOffset)) throw new Error("The search cursor did not advance.");
    return cursor;
  }
  if (value.kind !== "decoded" || !recordWithKeys(value, ["kind", "nodeId", "field", "byteOffset", "query", "sessionRevision", "scopeId", "targetNodeId"])) {
    throw new Error("The decoded search cursor is invalid.");
  }
  const nodeId = safeInteger(value.nodeId);
  const byteOffset = safeInteger(value.byteOffset);
  if (nodeId === undefined || byteOffset === undefined || (value.field !== "key" && value.field !== "value") || representation !== "decoded") {
    throw new Error("The decoded search cursor is invalid.");
  }
  const cursor: SearchCursor = { kind: "decoded", nodeId, field: value.field, byteOffset, query, sessionRevision, scopeId, targetNodeId: scopeTargetNodeId };
  if (previous && (previous.kind !== cursor.kind || !decodedCursorAdvanced(previous, cursor))) throw new Error("The search cursor did not advance.");
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
  const field = match.field === "rawSource" ? "Raw Source" : match.field === "key" ? "Key" : "Value";
  return match.field === "rawSource"
    ? `${field} · ${path} · match [${match.matchStart}, ${match.matchEnd}) · source [${match.sourceSpanStart}, ${match.sourceSpanEnd})`
    : `${field} · ${path} · source [${match.sourceSpanStart}, ${match.sourceSpanEnd})`;
}

function pageStatus(page: SearchPage, representation: SearchRepresentation): string {
  const mode = representation === "decoded" ? "Decoded" : "Raw Source";
  if (page.matches.length === 0) return `${mode} · No matches${page.hasMore ? " · more results available" : ""}`;
  return `${mode} · ${page.matches.length} match${page.matches.length === 1 ? "" : "es"}${page.hasMore ? " · more results available" : ""}`;
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (error instanceof Error) return error.message;
  return "Search failed.";
}

function isGlobalError(error: unknown): boolean {
  return isRecord(error) && (error.code === "file_changed" || error.code === "stale_session");
}
