import {
  parseSearchPageValue,
  type SearchPage,
  type SearchMatch,
  type SearchScope,
  type SearchViewElements
} from "./search-view";

export type RenderedSearchTarget = {
  nodeId: number;
  scopeId: number | null;
  sessionRevision: number;
  scopeStart: number;
  scopeEnd: number;
};

export type RenderedProjectionSegment = {
  textStart: number;
  textEnd: number;
  sourceStart: number;
  sourceEnd: number;
  node: Text;
  nodeStart: number;
  nodeEnd: number;
};

export type RenderedProjection = {
  root: HTMLElement;
  text: string;
  segments: RenderedProjectionSegment[];
};

type RenderedBackendMatch = {
  nodeId: number;
  field: "key" | "value";
  pathSegments: string[];
  pathTruncated: boolean;
  sourceSpanStart: number;
  sourceSpanEnd: number;
  matchStart: number;
  matchEnd: number;
};

export type RenderedMatch = {
  kind: "dom" | "backend";
  start: number;
  end: number;
  label: string;
  backend?: RenderedBackendMatch;
};

type RenderedSearchOptions = SearchViewElements & {
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  onReveal: (match: RenderedMatch) => void;
  onIntentChange: () => void;
  onError: (error: unknown) => void;
  onProjectionUnavailable?: (error: unknown) => void;
};

type Page = { matches: RenderedMatch[]; hasMore: boolean; nextCursor: unknown | null };

type TextRestore = {
  original: Text;
  parent: Node | null;
  originalData: string;
  parts: Set<Text>;
};

const PAGE_SIZE = 50;
const MAX_QUERY_BYTES = 4096;
const MAX_PROJECTION_BYTES = 32 * 1024 * 1024;
const PROJECTION_SEGMENT_BYTES = 128;
const PROJECTION_TEXT_CHUNK_BYTES = 64 * 1024;
const BLOCK_ELEMENTS = new Set(["BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "P", "TABLE", "TR", "TD", "TH", "PRE"]);
const ASCII_WHITESPACE_RUN = /[ \t\r\n\f\v]+/g;

export type RenderedProjectionOptions = {
  signal?: AbortSignal;
};

export async function projectRenderedText(root: HTMLElement, options: RenderedProjectionOptions = {}): Promise<RenderedProjection> {
  const text: string[] = [];
  let pendingText: string[] = [];
  let pendingTextLength = 0;
  const segments: RenderedProjectionSegment[] = [];
  let textLength = 0;
  let sourceLength = 0;
  let processedSourceLength = 0;
  let lastWasBoundary = true;
  let lastWasSpace = false;
  let lastYieldSourceLength = 0;

  const checkCancelled = (): void => {
    if (options.signal?.aborted) throw new DOMException("Rendered projection cancelled.", "AbortError");
  };

  const yieldProjection = async (): Promise<void> => {
    checkCancelled();
    if (processedSourceLength - lastYieldSourceLength < PROJECTION_TEXT_CHUNK_BYTES) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    checkCancelled();
    lastYieldSourceLength = processedSourceLength;
  };

  const appendBoundary = (): void => {
    trimTrailingCollapsedSpace();
    if ((text.length > 0 || pendingTextLength > 0) && !lastWasBoundary) {
      if (textLength + 1 > MAX_PROJECTION_BYTES) throw new Error("Rendered text exceeds the 32 MiB search projection budget.");
      flushText();
      text.push("\n");
      textLength += 1;
      lastWasBoundary = true;
      lastWasSpace = false;
    }
  };

  const flushText = (): void => {
    if (pendingTextLength === 0) return;
    text.push(pendingText.join(""));
    pendingText = [];
    pendingTextLength = 0;
  };

  const appendSegment = (node: Text, nodeStart: number, nodeEnd: number, sourceStart: number, value: string, collapsedSpace = false): void => {
    if (!value) return;
    if (textLength + value.length > MAX_PROJECTION_BYTES) throw new Error("Rendered text exceeds the 32 MiB search projection budget.");
    const textStart = textLength;
    pendingText.push(value);
    pendingTextLength += value.length;
    if (pendingTextLength >= PROJECTION_TEXT_CHUNK_BYTES) flushText();
    textLength += value.length;
    const sourceEnd = sourceStart + (nodeEnd - nodeStart);
    const previous = segments.at(-1);
    const previousIsLinear = previous && previous.node === node && previous.nodeEnd === nodeStart
      && previous.textEnd === textStart && previous.sourceEnd === sourceStart
      && previous.sourceEnd - previous.sourceStart === previous.textEnd - previous.textStart;
    if (previousIsLinear && sourceEnd - sourceStart === value.length) {
      if ((textLength * 2) + (segments.length * PROJECTION_SEGMENT_BYTES) > MAX_PROJECTION_BYTES) {
        throw new Error("Rendered text exceeds the 32 MiB search projection budget.");
      }
      previous.textEnd = textLength;
      previous.sourceEnd = sourceEnd;
      previous.nodeEnd = nodeEnd;
    } else {
      if ((textLength * 2) + ((segments.length + 1) * PROJECTION_SEGMENT_BYTES) > MAX_PROJECTION_BYTES) {
        throw new Error("Rendered text exceeds the 32 MiB search projection budget.");
      }
      segments.push({ textStart, textEnd: textLength, sourceStart, sourceEnd, node, nodeStart, nodeEnd });
    }
    lastWasBoundary = false;
    lastWasSpace = collapsedSpace;
  };

  const trimTrailingCollapsedSpace = (): void => {
    if (!lastWasSpace || textLength === 0) return;
    if (pendingTextLength > 0) {
      const last = pendingText.at(-1);
      if (last?.endsWith(" ")) {
        pendingText[pendingText.length - 1] = last.slice(0, -1);
        pendingTextLength -= 1;
        if (pendingText.at(-1) === "") pendingText.pop();
      }
    } else {
      const last = text.at(-1);
      if (last?.endsWith(" ")) text[text.length - 1] = last.slice(0, -1);
    }
    const segment = segments.at(-1);
    if (segment && segment.textEnd === textLength) {
      const projectedLength = segment.textEnd - segment.textStart;
      const sourceLength = segment.sourceEnd - segment.sourceStart;
      if (projectedLength === 1 || sourceLength === projectedLength) {
        segment.textEnd -= 1;
        if (sourceLength === projectedLength) {
          segment.sourceEnd -= 1;
          segment.nodeEnd -= 1;
        } else {
          segments.pop();
        }
      }
    }
    textLength -= 1;
    lastWasSpace = false;
  };

  const appendText = async (node: Text, preserveWhitespace: boolean): Promise<void> => {
    checkCancelled();
    const value = node.data;
    const sourceStart = sourceLength;
    sourceLength += value.length;
    if (preserveWhitespace) {
      appendSegment(node, 0, value.length, sourceStart, value);
      processedSourceLength = sourceStart + value.length;
      await yieldProjection();
      return;
    }
    let index = 0;
    for (const whitespace of value.matchAll(ASCII_WHITESPACE_RUN)) {
      checkCancelled();
      const start = whitespace.index ?? 0;
      if (start > index) appendSegment(node, index, start, sourceStart + index, value.slice(index, start));
      const end = start + whitespace[0].length;
      if (!lastWasBoundary && !lastWasSpace) appendSegment(node, start, end, sourceStart + start, " ", true);
      index = end;
      processedSourceLength = sourceStart + end;
      await yieldProjection();
    }
    if (index < value.length) appendSegment(node, index, value.length, sourceStart + index, value.slice(index));
    processedSourceLength = sourceStart + value.length;
    await yieldProjection();
  };
  const visit = async (node: Node, preserveWhitespace = false): Promise<void> => {
    checkCancelled();
    if (node.nodeType === Node.TEXT_NODE) {
      await appendText(node as Text, preserveWhitespace);
      return;
    }
    if (!(node instanceof HTMLElement) || node.hidden || node.getAttribute("aria-hidden") === "true") return;
    const tag = node.tagName;
    if (tag === "BR") { appendBoundary(); return; }
    const block = BLOCK_ELEMENTS.has(tag);
    if (block) appendBoundary();
    const nextPreserve = preserveWhitespace || preservesWhitespace(node);
    for (const child of Array.from(node.childNodes)) await visit(child, nextPreserve);
    if (block) appendBoundary();
  };
  const rootPreservesWhitespace = preservesWhitespace(root);
  for (const child of Array.from(root.childNodes)) await visit(child, rootPreservesWhitespace);
  trimTrailingCollapsedSpace();
  checkCancelled();
  flushText();
  while (text.at(-1) === "\n") {
    text.pop();
    textLength -= 1;
  }
  const projectedText = text.join("");
  return {
    root,
    text: projectedText,
    segments
  };
}

function preservesWhitespace(element: HTMLElement): boolean {
  const whiteSpace = getComputedStyle(element).whiteSpace;
  return whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces";
}

export class RenderedSearch {
  private readonly elements: SearchViewElements;
  private readonly invoke: RenderedSearchOptions["invoke"];
  private readonly onReveal: (match: RenderedMatch) => void;
  private readonly onIntentChange: () => void;
  private readonly onError: (error: unknown) => void;
  private readonly onProjectionUnavailable: (error: unknown) => void;
  private projection: RenderedProjection | null = null;
  private target: RenderedSearchTarget | null = null;
  private mode: "dom" | "backend" | null = null;
  private history: Page[] = [];
  private currentIndex = -1;
  private requestEpoch = 0;
  private busy = false;
  private marks: HTMLElement[] = [];
  private domRoot: HTMLElement | null = null;
  private domSnapshot: Node[] = [];
  private projectionEpoch = 0;
  private projectionAbort: AbortController | null = null;
  private projectionPending = false;
  private textRestores: TextRestore[] = [];

  constructor(options: RenderedSearchOptions) {
    this.elements = options;
    this.invoke = options.invoke;
    this.onReveal = options.onReveal;
    this.onIntentChange = options.onIntentChange;
    this.onError = options.onError;
    this.onProjectionUnavailable = options.onProjectionUnavailable ?? (() => undefined);
    this.elements.form.addEventListener("submit", (event) => { event.preventDefault(); if (this.isOwner()) void this.submit(); });
    this.elements.query.addEventListener("input", () => { if (this.isOwner()) this.invalidate(); });
    this.elements.previous.addEventListener("click", () => { if (this.isOwner()) this.showPrevious(); });
    this.elements.next.addEventListener("click", () => { if (this.isOwner()) void this.showNext(); });
    this.clear();
  }

  get active(): boolean { return this.mode !== null; }

  get activeMode(): "dom" | "backend" | null { return this.mode; }

  get query(): string { return this.elements.query.value; }

  activate(mode: "dom" | "backend", target: RenderedSearchTarget | null, projection: RenderedProjection | null, description: string): void {
    const sameTarget = this.target?.nodeId === target?.nodeId && this.target?.scopeId === target?.scopeId
      && this.target?.sessionRevision === target?.sessionRevision && this.target?.scopeStart === target?.scopeStart
      && this.target?.scopeEnd === target?.scopeEnd;
    if (this.mode === mode && sameTarget) {
      this.target = target;
      if (projection) {
        this.projection = projection;
        this.domRoot = projection.root;
        this.domSnapshot = Array.from(projection.root.childNodes);
        this.projectionPending = false;
      }
      this.setOwner("rendered");
      this.elements.description.textContent = description;
      this.elements.panel.hidden = false;
      this.render();
      return;
    }
    this.clear(true);
    this.mode = mode;
    this.target = target;
    this.projection = projection;
    this.domRoot = projection?.root ?? null;
    this.domSnapshot = projection ? Array.from(projection.root.childNodes) : [];
    this.projectionPending = false;
    this.elements.panel.hidden = false;
    this.setOwner("rendered");
    this.elements.description.textContent = description;
    this.elements.query.disabled = false;
    this.elements.submit.disabled = false;
    this.elements.decoded.checked = true;
    this.elements.decoded.disabled = true;
    this.elements.rawSource.checked = false;
    this.elements.rawSource.disabled = true;
    this.elements.form.setAttribute("aria-busy", "false");
    this.render();
  }

  activateDom(target: RenderedSearchTarget, root: HTMLElement, description: string): void {
    const sameTarget = this.mode === "dom" && this.sameTarget(target);
    const snapshot = Array.from(root.childNodes);
    if (sameTarget && this.domRoot === root && sameNodes(snapshot, this.domSnapshot)
      && (this.projection !== null || this.projectionPending)) {
      this.elements.description.textContent = description;
      this.elements.panel.hidden = false;
      this.setOwner("rendered");
      this.render();
      return;
    }
    this.cancelProjection();
    if (!sameTarget) {
      this.activate("dom", target, null, description);
    } else {
      this.requestEpoch += 1;
      this.busy = true;
      this.history = [];
      this.currentIndex = -1;
      this.clearHighlights();
      this.mode = "dom";
      this.target = target;
      this.projection = null;
      this.domRoot = root;
      this.domSnapshot = snapshot;
      this.elements.description.textContent = description;
      this.elements.panel.hidden = false;
      this.setOwner("rendered");
      this.setStatus("Preparing rendered search…");
      this.render();
    }
    this.domRoot = root;
    this.domSnapshot = snapshot;
    this.projection = null;
    this.projectionPending = true;
    this.busy = true;
    this.setStatus("Preparing rendered search…");
    this.render();
    const epoch = ++this.projectionEpoch;
    const controller = new AbortController();
    this.projectionAbort = controller;
    void projectRenderedText(root, { signal: controller.signal }).then((projection) => {
      if (epoch !== this.projectionEpoch || controller.signal.aborted || this.mode !== "dom" || this.domRoot !== root || !this.isOwner()) return;
      this.projection = projection;
      this.domSnapshot = Array.from(root.childNodes);
      this.projectionPending = false;
      this.projectionAbort = null;
      this.busy = false;
      this.setStatus("");
      this.render();
    }).catch((error: unknown) => {
      if (epoch !== this.projectionEpoch || controller.signal.aborted) return;
      this.projectionPending = false;
      this.projectionAbort = null;
      this.busy = false;
      this.clear();
      this.onProjectionUnavailable(error);
    });
  }

  async reprojectDom(root: HTMLElement): Promise<void> {
    if (!this.isOwner() || (this.mode !== "dom" && this.mode !== "backend")) return;
    this.cancelProjection();
    this.projection = null;
    this.projectionPending = true;
    this.busy = true;
    this.render();
    const epoch = ++this.projectionEpoch;
    const controller = new AbortController();
    this.projectionAbort = controller;
    try {
      const projection = await projectRenderedText(root, { signal: controller.signal });
      if (epoch !== this.projectionEpoch || controller.signal.aborted || !this.isOwner() || (this.mode !== "dom" && this.mode !== "backend")) return;
      this.clearHighlights();
      this.projection = projection;
      this.domRoot = root;
      this.domSnapshot = Array.from(root.childNodes);
      this.projectionPending = false;
      this.projectionAbort = null;
      this.busy = false;
      this.render();
    } catch (error) {
      if (epoch !== this.projectionEpoch || controller.signal.aborted) return;
      this.projectionPending = false;
      this.projectionAbort = null;
      this.busy = false;
      this.clear();
      this.onProjectionUnavailable(error);
    }
  }

  refresh(projection: RenderedProjection | null): void {
    if (!this.isOwner()) return;
    this.clearHighlights();
    this.projection = projection;
    this.domRoot = projection?.root ?? null;
    this.domSnapshot = projection ? Array.from(projection.root.childNodes) : [];
    this.projectionPending = false;
    if (this.mode === "dom" && !this.busy) this.render();
  }

  highlightRange(start: number, end: number): void {
    if (!this.isOwner() || !this.projection) return;
    this.highlight({ kind: "dom", start, end, label: `Rendered · visible [${start}, ${end})` });
  }

  highlightSourceRange(start: number, end: number): void {
    if (!this.isOwner() || !this.projection || start >= end) return;
    let projectedStart: number | null = null;
    let projectedEnd: number | null = null;
    for (const segment of this.projection.segments) {
      if (segment.sourceEnd <= start || segment.sourceStart >= end) continue;
      const sourceLength = segment.sourceEnd - segment.sourceStart;
      const projectedLength = segment.textEnd - segment.textStart;
      const overlapStart = Math.max(start, segment.sourceStart);
      const overlapEnd = Math.min(end, segment.sourceEnd);
      const rangeStart = sourceLength === projectedLength
        ? segment.textStart + (overlapStart - segment.sourceStart)
        : segment.textStart;
      const rangeEnd = sourceLength === projectedLength
        ? segment.textStart + (overlapEnd - segment.sourceStart)
        : segment.textEnd;
      projectedStart = projectedStart === null ? rangeStart : Math.min(projectedStart, rangeStart);
      projectedEnd = projectedEnd === null ? rangeEnd : Math.max(projectedEnd, rangeEnd);
    }
    if (projectedStart !== null && projectedEnd !== null) {
      this.highlight({ kind: "dom", start: projectedStart, end: projectedEnd, label: `Rendered · visible [${projectedStart}, ${projectedEnd})` });
    }
  }

  clear(keepQuery = true): void {
    this.cancelProjection();
    const ownsForm = this.isOwner();
    this.requestEpoch += 1;
    this.busy = false;
    this.mode = null;
    this.target = null;
    this.projection = null;
    this.history = [];
    this.currentIndex = -1;
    if (!ownsForm) return;
    this.clearHighlights();
    this.elements.results.replaceChildren();
    this.elements.resultsPanel.hidden = true;
    this.setStatus("");
    if (!keepQuery) this.elements.query.value = "";
    this.elements.panel.hidden = true;
    this.elements.query.disabled = true;
    this.elements.submit.disabled = true;
    this.elements.previous.disabled = true;
    this.elements.next.disabled = true;
    this.elements.form.setAttribute("aria-busy", "false");
    this.setOwner(null);
  }

  invalidate(): void {
    if (!this.isOwner()) return;
    this.requestEpoch += 1;
    this.busy = false;
    this.history = [];
    this.currentIndex = -1;
    this.clearHighlights();
    this.elements.results.replaceChildren();
    this.elements.resultsPanel.hidden = true;
    this.setStatus("");
    this.render();
    this.onIntentChange();
  }

  focusQuery(): void {
    if (!this.isOwner()) return;
    this.elements.query.focus();
    this.elements.query.select();
  }

  handleEscape(event: KeyboardEvent): boolean {
    if (!this.isOwner() || this.elements.resultsPanel.hidden) return false;
    event.preventDefault();
    event.stopPropagation();
    this.invalidate();
    this.focusQuery();
    return true;
  }

  highlight(match: RenderedMatch): void {
    if (!this.isOwner() || match.kind !== "dom" || !this.projection) return;
    this.clearHighlights();
    const ranges = new Map<Text, Array<{ start: number; end: number }>>();
    for (const segment of this.projection.segments) {
      const overlapStart = Math.max(match.start, segment.textStart);
      const overlapEnd = Math.min(match.end, segment.textEnd);
      if (overlapStart >= overlapEnd || !segment.node.isConnected) continue;
      const projectedLength = segment.textEnd - segment.textStart;
      const sourceLength = segment.nodeEnd - segment.nodeStart;
      const sourceStart = sourceLength === projectedLength
        ? segment.nodeStart + (overlapStart - segment.textStart)
        : segment.nodeStart;
      const sourceEnd = sourceLength === projectedLength
        ? segment.nodeStart + (overlapEnd - segment.textStart)
        : segment.nodeEnd;
      if (sourceStart >= sourceEnd) continue;
      const nodeRanges = ranges.get(segment.node) ?? [];
      nodeRanges.push({ start: sourceStart, end: sourceEnd });
      ranges.set(segment.node, nodeRanges);
    }
    this.textRestores = [];
    for (const [node, nodeRanges] of ranges) {
      nodeRanges.sort((left, right) => right.start - left.start);
      const restore: TextRestore = {
        original: node,
        parent: node.parentNode,
        originalData: node.data,
        parts: new Set([node])
      };
      this.textRestores.push(restore);
      for (const range of nodeRanges) this.wrapTextRange(restore, range.start, range.end);
    }
  }

  private async submit(): Promise<void> {
    if (!this.isOwner() || this.mode === null || this.busy) return;
    const query = this.elements.query.value;
    const queryBytes = new TextEncoder().encode(query).byteLength;
    if (query.length === 0 || queryBytes > MAX_QUERY_BYTES) {
      this.showLocalError(query.length === 0 ? "Enter a search query." : "Search query exceeds the 4096-byte limit.");
      return;
    }
    this.requestEpoch += 1;
    const epoch = this.requestEpoch;
    this.onIntentChange();
    this.history = [];
    this.currentIndex = -1;
    this.busy = true;
    this.elements.resultsPanel.hidden = false;
    this.setStatus("Searching rendered text…");
    this.render();
    try {
      const page = this.mode === "dom"
        ? findDomPage(this.projection, query, 0)
        : await this.searchBackend(query, null);
      if (epoch !== this.requestEpoch) return;
      this.history = [page];
      this.currentIndex = 0;
      this.setStatus(pageStatus(page));
      this.renderPage();
    } catch (error) {
      if (epoch !== this.requestEpoch) return;
      this.setStatus(error instanceof Error ? error.message : "Rendered search failed.", true);
      this.elements.results.replaceChildren();
      if (isGlobalError(error)) this.onError(error);
    } finally {
      if (epoch === this.requestEpoch) {
        this.busy = false;
        this.render();
      }
    }
  }

  private async showNext(): Promise<void> {
    if (!this.isOwner()) return;
    const page = this.history[this.currentIndex];
    if (this.mode === null || this.busy || !page?.hasMore || page.nextCursor === null) return;
    if (this.currentIndex + 1 < this.history.length) {
      this.currentIndex += 1;
      this.setStatus(pageStatus(this.history[this.currentIndex]));
      this.renderPage();
      return;
    }
    if (this.mode === "dom") {
      const next = findDomPage(this.projection, this.elements.query.value, page.nextCursor);
      this.history.push(next);
      this.currentIndex += 1;
      this.setStatus(pageStatus(next));
      this.renderPage();
      return;
    }
    const query = this.elements.query.value;
    const epoch = ++this.requestEpoch;
    this.onIntentChange();
    this.busy = true;
    this.setStatus("Searching rendered text…");
    this.render();
    try {
      const next = await this.searchBackend(query, page.nextCursor);
      if (epoch !== this.requestEpoch) return;
      this.history.push(next);
      this.currentIndex += 1;
      this.setStatus(pageStatus(next));
      this.renderPage();
    } catch (error) {
      if (epoch !== this.requestEpoch) return;
      this.setStatus(error instanceof Error ? error.message : "Rendered search failed.", true);
      if (isGlobalError(error)) this.onError(error);
    } finally {
      if (epoch === this.requestEpoch) { this.busy = false; this.render(); }
    }
  }

  private showPrevious(): void {
    if (!this.isOwner() || this.busy || this.currentIndex <= 0) return;
    this.currentIndex -= 1;
    this.setStatus(pageStatus(this.history[this.currentIndex]));
    this.renderPage();
  }

  private async searchBackend(query: string, cursor: unknown | null): Promise<Page> {
    const target = this.target;
    if (!target) throw new Error("Rendered search target is unavailable.");
    const value = await this.invoke<unknown>("search_current", {
      query,
      representation: "decoded",
      scopeId: target.scopeId,
      nodeId: target.nodeId,
      cursor,
      limit: PAGE_SIZE,
      sessionRevision: target.sessionRevision
    });
    const scope: SearchScope = {
      label: "Rendered",
      description: "Search visible rendered text.",
      enabled: true,
      decodedEnabled: true,
      scopeStart: target.scopeStart,
      scopeEnd: target.scopeEnd,
      sessionRevision: target.sessionRevision,
      scopeId: target.scopeId,
      targetNodeId: target.nodeId
    };
    const parsed = parseSearchPageValue(value, "decoded", query, scope, cursor as SearchPage["nextCursor"]);
    if (parsed.matches.some((match) => match.field !== "value")) {
      throw new Error("The rendered search response contained a non-value match.");
    }
    const valueMatches = parsed.matches.filter((match): match is SearchMatch & { field: "value" } => match.field === "value");
    return {
      matches: valueMatches.map((match) => ({
        kind: "backend" as const,
        start: match.matchStart,
        end: match.matchEnd,
        backend: {
          nodeId: match.nodeId!,
          field: match.field,
          pathSegments: match.pathSegments,
          pathTruncated: match.pathTruncated,
          sourceSpanStart: match.sourceSpanStart,
          sourceSpanEnd: match.sourceSpanEnd,
          matchStart: match.matchStart,
          matchEnd: match.matchEnd
        },
        label: `Rendered · Value · ${match.pathSegments.join(".")} · source [${match.sourceSpanStart}, ${match.sourceSpanEnd})`
      })),
      hasMore: parsed.hasMore,
      nextCursor: parsed.nextCursor
    };
  }

  private renderPage(): void {
    if (!this.isOwner()) return;
    const page = this.history[this.currentIndex];
    if (!page) { this.elements.results.replaceChildren(); this.render(); return; }
    const fragment = document.createDocumentFragment();
    page.matches.forEach((match, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result-button";
      button.textContent = match.label;
      button.title = match.label;
      button.addEventListener("click", () => {
        if (!this.isOwner() || this.history[this.currentIndex]?.matches[index] !== match) return;
        if (match.kind === "dom") this.highlight(match);
        this.onReveal(match);
      });
      fragment.append(button);
    });
    this.elements.results.replaceChildren(fragment);
    this.elements.resultsPanel.hidden = false;
    this.render();
  }

  private clearHighlights(): void {
    for (const mark of this.marks) {
      if (mark.parentNode) mark.replaceWith(...Array.from(mark.childNodes));
    }
    this.marks = [];
    for (const restore of this.textRestores) {
      const parent = restore.parent;
      if (!parent) continue;
      const firstPart = Array.from(parent.childNodes).find((child): child is Text => restore.parts.has(child as Text));
      if (!firstPart) continue;
      if (restore.original.parentNode !== parent) parent.insertBefore(restore.original, firstPart);
      else if (restore.original !== firstPart) parent.insertBefore(restore.original, firstPart);
      restore.original.data = restore.originalData;
      for (const part of restore.parts) {
        if (part !== restore.original && part.parentNode) part.remove();
      }
    }
    this.textRestores = [];
  }

  private wrapTextRange(restore: TextRestore, start: number, end: number): void {
    const node = restore.original;
    if (!node.isConnected || start < 0 || end <= start || end > node.data.length) return;
    let target = node;
    if (start > 0) {
      target = node.splitText(start);
      restore.parts.add(target);
    }
    if (end - start < target.data.length) {
      const after = target.splitText(end - start);
      restore.parts.add(after);
    }
    const mark = document.createElement("mark");
    mark.dataset.renderedSearch = "true";
    target.parentNode?.insertBefore(mark, target);
    mark.append(target);
    this.marks.push(mark);
  }

  private showLocalError(message: string): void {
    this.requestEpoch += 1;
    this.history = [];
    this.currentIndex = -1;
    this.setStatus(message, true);
    this.elements.results.replaceChildren();
    this.elements.resultsPanel.hidden = false;
    this.render();
  }

  private setStatus(message: string, alert = false): void {
    this.elements.status.textContent = message;
    this.elements.status.setAttribute("role", alert ? "alert" : "status");
  }

  private render(): void {
    if (!this.isOwner()) return;
    this.elements.query.disabled = this.mode === null || this.busy;
    this.elements.submit.disabled = this.mode === null || this.busy;
    this.elements.previous.disabled = this.busy || this.currentIndex <= 0;
    this.elements.next.disabled = this.busy || !this.history[this.currentIndex]?.hasMore;
    this.elements.form.setAttribute("aria-busy", String(this.busy));
  }

  private sameTarget(target: RenderedSearchTarget | null): boolean {
    return this.target?.nodeId === target?.nodeId && this.target?.scopeId === target?.scopeId
      && this.target?.sessionRevision === target?.sessionRevision && this.target?.scopeStart === target?.scopeStart
      && this.target?.scopeEnd === target?.scopeEnd;
  }

  private cancelProjection(): void {
    this.projectionEpoch += 1;
    this.projectionAbort?.abort();
    this.projectionAbort = null;
    this.projectionPending = false;
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
    return this.owner() === "rendered";
  }
}

function sameNodes(left: Node[], right: Node[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

function findDomPage(projection: RenderedProjection | null, query: string, cursor: unknown): Page {
  if (!projection || !query) return { matches: [], hasMore: false, nextCursor: null };
  const startOffset = typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  const matches: RenderedMatch[] = [];
  let from = startOffset;
  let nextCursor: number | null = null;
  while (true) {
    const start = projection.text.indexOf(query, from);
    if (start < 0) break;
    const end = start + query.length;
    if (matches.length === PAGE_SIZE) {
      nextCursor = start;
      break;
    }
    matches.push({ kind: "dom", start, end, label: `Rendered · visible [${start}, ${end})` });
    from = Math.max(end, start + 1);
  }
  return { matches, hasMore: nextCursor !== null, nextCursor };
}

function pageStatus(page: Page): string {
  return `Rendered · ${page.matches.length} match${page.matches.length === 1 ? "" : "es"}${page.hasMore ? " · more results available" : ""}`;
}

function isGlobalError(error: unknown): boolean {
  return isRecord(error) && (error.code === "file_changed" || error.code === "stale_session");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
