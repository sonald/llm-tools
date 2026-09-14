export type TextLineHighlight = {
  start: number;
  end: number;
  marker?: "searchMatch" | "renderedSearch";
};

type TextLine = {
  start: number;
  contentEnd: number;
  end: number;
};

type Anchor = {
  index: number;
  offset: number;
};

type TextSelection = {
  anchor: number;
  focus: number;
  anchorNode: Node;
  focusNode: Node;
};

const OVERSCAN_LINES = 20;
const DEFAULT_LINE_HEIGHT = 16;

export class TextLineView {
  private readonly host: HTMLElement;
  private readonly scrollElement: HTMLElement;
  private readonly onScroll = (): void => this.render();
  private readonly onCopy = (event: ClipboardEvent): void => this.handleCopy(event);
  private readonly onSelectionChange = (): void => this.handleSelectionChange();
  private readonly onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event);
  private readonly onFocusIn = (event: FocusEvent): void => this.handleFocusIn(event);
  private readonly resizeObserver: ResizeObserver | null;
  private text = "";
  private lines: TextLine[] = [];
  private heights: number[] = [];
  private offsets: number[] = [0];
  private wrap = true;
  private highlight: TextLineHighlight | null = null;
  private lastWidth: number | null = null;
  private readonly observedRows = new Set<HTMLElement>();
  private renderedFirst: number | null = null;
  private renderedLast: number | null = null;
  private savedSelection: TextSelection | null = null;

  constructor(host: HTMLElement, scrollElement: HTMLElement) {
    this.host = host;
    this.scrollElement = scrollElement;
    this.scrollElement.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("copy", this.onCopy);
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerdown", this.onPointerDown);
    document.addEventListener("focusin", this.onFocusIn);
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => this.handleResize(entries));
    this.resizeObserver?.observe(this.scrollElement);
  }

  setText(
    text: string,
    wrap: boolean,
    highlight: TextLineHighlight | null = null,
    previousWasCR = false,
    hasMore = false
  ): void {
    this.text = text;
    this.lines = splitLines(text, previousWasCR, hasMore);
    this.wrap = wrap;
    this.highlight = normalizeHighlight(highlight, text.length);
    this.renderedFirst = null;
    this.renderedLast = null;
    this.savedSelection = null;
    const selection = window.getSelection();
    if (selection && (this.host.contains(selection.anchorNode) || this.host.contains(selection.focusNode))) {
      selection.removeAllRanges();
    }
    const lineHeight = this.lineHeight();
    this.heights = this.lines.map(() => lineHeight);
    this.rebuildOffsets();
    this.scrollElement.scrollTop = 0;
    this.render();
    if (this.highlight) {
      const line = this.lineForTextOffset(this.highlight.start);
      this.scrollElement.scrollTop = this.offsets[line] ?? 0;
      this.render();
    }
  }

  setWrap(wrap: boolean): void {
    if (this.wrap === wrap) return;
    const anchor = this.captureAnchor();
    this.wrap = wrap;
    const lineHeight = this.lineHeight();
    this.heights = this.lines.map(() => lineHeight);
    this.rebuildOffsets();
    this.render(anchor);
  }

  setHighlight(highlight: TextLineHighlight | null): void {
    this.highlight = normalizeHighlight(highlight, this.text.length);
    this.renderedFirst = null;
    this.renderedLast = null;
    this.render();
  }

  dispose(): void {
    this.scrollElement.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("copy", this.onCopy);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("focusin", this.onFocusIn);
    this.resizeObserver?.disconnect();
    this.observedRows.clear();
    this.host.replaceChildren();
    this.host.classList.remove("is-text-lines");
    this.text = "";
    this.lines = [];
    this.heights = [];
    this.offsets = [0];
    this.highlight = null;
    this.lastWidth = null;
    this.renderedFirst = null;
    this.renderedLast = null;
    this.savedSelection = null;
  }

  private render(anchor: Anchor | null = null): void {
    const viewportHeight = this.scrollElement.clientHeight || this.host.clientHeight || 320;
    if (this.lines.length === 0) {
      for (const row of this.observedRows) this.resizeObserver?.unobserve(row);
      this.observedRows.clear();
      this.host.classList.add("is-text-lines");
      this.host.replaceChildren();
      this.renderedFirst = 0;
      this.renderedLast = 0;
      return;
    }
    const scrollTop = anchor ? (this.offsets[anchor.index] ?? 0) + anchor.offset : this.scrollElement.scrollTop;
    const firstVisible = this.lineForOffset(Math.max(0, scrollTop));
    const lastVisible = this.lineForOffset(Math.max(0, scrollTop + viewportHeight)) + 1;
    const first = Math.max(0, firstVisible - OVERSCAN_LINES);
    const last = Math.min(this.lines.length, lastVisible + OVERSCAN_LINES);
    const sameWindow = this.renderedFirst === first && this.renderedLast === last && this.host.childElementCount > 0;
    if (sameWindow) {
      this.updateSpacers(first, last);
      for (const row of this.observedRows) row.style.height = this.wrap ? "" : String(this.heights[Number(row.dataset.lineIndex)] ?? DEFAULT_LINE_HEIGHT) + "px";
      if (anchor) this.restoreAnchor(anchor, viewportHeight);
      return;
    }
    const selection = this.captureSelection();
    if (selection) {
      this.savedSelection = selection;
    }
    else if (!this.savedSelection || this.savedSelection.anchorNode.isConnected || this.savedSelection.focusNode.isConnected) {
      this.savedSelection = null;
    }
    for (const row of this.observedRows) this.resizeObserver?.unobserve(row);
    this.observedRows.clear();
    const top = document.createElement("div");
    top.className = "text-line-view-spacer";
    top.dataset.position = "top";
    top.setAttribute("aria-hidden", "true");
    top.style.height = String(this.offsets[first] ?? 0) + "px";
    const rows = document.createDocumentFragment();
    for (let index = first; index < last; index += 1) {
      const row = this.renderLine(index);
      rows.append(row);
      if (this.resizeObserver) {
        this.resizeObserver.observe(row);
        this.observedRows.add(row);
      }
    }
    const bottom = document.createElement("div");
    bottom.className = "text-line-view-spacer";
    bottom.dataset.position = "bottom";
    bottom.setAttribute("aria-hidden", "true");
    bottom.style.height = String(Math.max(0, (this.offsets.at(-1) ?? 0) - (this.offsets[last] ?? 0))) + "px";
    this.host.classList.add("is-text-lines");
    this.host.replaceChildren(top, rows, bottom);
    this.renderedFirst = first;
    this.renderedLast = last;
    if (anchor) {
      this.restoreAnchor(anchor, viewportHeight);
    }
    this.restoreSelection();
  }

  private updateSpacers(first: number, last: number): void {
    const top = this.host.querySelector<HTMLElement>('.text-line-view-spacer[data-position="top"]');
    const bottom = this.host.querySelector<HTMLElement>('.text-line-view-spacer[data-position="bottom"]');
    if (top) top.style.height = String(this.offsets[first] ?? 0) + "px";
    if (bottom) bottom.style.height = String(Math.max(0, (this.offsets.at(-1) ?? 0) - (this.offsets[last] ?? 0))) + "px";
  }

  private restoreAnchor(anchor: Anchor, viewportHeight: number): void {
    const maxScrollTop = Math.max(0, (this.offsets.at(-1) ?? 0) - viewportHeight);
    this.scrollElement.scrollTop = Math.min(maxScrollTop, Math.max(0, (this.offsets[anchor.index] ?? 0) + anchor.offset));
  }

  private renderLine(index: number): HTMLElement {
    const line = this.lines[index];
    const row = document.createElement("div");
    row.className = "text-line-view-row";
    row.dataset.lineIndex = String(index);
    row.dataset.utf16Start = String(line.start);
    row.dataset.utf16End = String(line.contentEnd);
    if (!this.wrap) row.style.height = String(this.heights[index] ?? DEFAULT_LINE_HEIGHT) + "px";
    const highlight = this.highlight;
    if (!highlight || highlight.end <= line.start || highlight.start >= line.contentEnd) {
      this.appendLineText(row, line.start, line.contentEnd, line.end);
      return row;
    }
    const start = Math.max(line.start, highlight.start);
    const end = Math.min(line.contentEnd, highlight.end);
    if (start > line.start) row.append(document.createTextNode(this.text.slice(line.start, start)));
    const mark = document.createElement("mark");
    if (highlight.marker === "renderedSearch") mark.dataset.renderedSearch = "true";
    else mark.dataset.searchMatch = "true";
    mark.textContent = this.text.slice(start, end);
    row.append(mark);
    if (end < line.contentEnd) row.append(document.createTextNode(this.text.slice(end, line.contentEnd)));
    this.appendLineBreak(row, line.contentEnd, line.end);
    return row;
  }

  private appendLineText(row: HTMLElement, start: number, contentEnd: number, end: number): void {
    row.textContent = this.text.slice(start, contentEnd);
    this.appendLineBreak(row, contentEnd, end);
  }

  private appendLineBreak(row: HTMLElement, contentEnd: number, end: number): void {
    if (end <= contentEnd) return;
    const lineBreak = document.createElement("span");
    lineBreak.className = "text-line-view-break";
    lineBreak.setAttribute("aria-hidden", "true");
    lineBreak.textContent = this.text.slice(contentEnd, end);
    row.append(lineBreak);
  }

  private handleResize(entries: ResizeObserverEntry[]): void {
    if (!this.wrap || this.lines.length === 0) return;
    const widthEntry = entries.find((entry) => entry.target === this.scrollElement);
    const width = widthEntry?.contentRect.width ?? null;
    const widthChanged = width !== null && width !== this.lastWidth;
    if (width !== null) this.lastWidth = width;
    let changed = widthChanged;
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.lineIndex);
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.heights.length) continue;
      const height = entry.contentRect.height;
      if (height > 0 && Math.abs(height - this.heights[index]) > 0.5) {
        this.heights[index] = height;
        changed = true;
      }
    }
    if (!changed) return;
    const anchor = this.captureAnchor();
    this.rebuildOffsets();
    this.render(anchor);
  }

  private captureAnchor(): Anchor {
    const index = this.lineForOffset(this.scrollElement.scrollTop);
    return { index, offset: this.scrollElement.scrollTop - (this.offsets[index] ?? 0) };
  }

  private lineForOffset(offset: number): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.offsets[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private lineForTextOffset(offset: number): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lines[middle].start <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private captureSelection(): TextSelection | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const anchorInside = this.host.contains(selection.anchorNode);
    const focusInside = this.host.contains(selection.focusNode);
    if (!anchorInside && !focusInside) return null;
    const anchor = this.domOffset(selection.anchorNode, selection.anchorOffset);
    const focus = this.domOffset(selection.focusNode, selection.focusOffset);
    return anchor === null || focus === null
      ? null
      : { anchor, focus, anchorNode: selection.anchorNode!, focusNode: selection.focusNode! };
  }

  private domOffset(node: Node | null, offset: number): number | null {
    if (!node) return null;
    const row = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".text-line-view-row");
    if (!row) return null;
    const start = Number(row.dataset.utf16Start);
    if (!Number.isSafeInteger(start)) return null;
    const range = document.createRange();
    try {
      range.selectNodeContents(row);
      range.setEnd(node, Math.min(offset, node.nodeType === Node.TEXT_NODE ? node.nodeValue?.length ?? 0 : node.childNodes.length));
    } catch {
      return start;
    }
    return start + range.toString().length;
  }

  private restoreSelection(): void {
    const selection = this.savedSelection;
    if (!selection) return;
    const anchor = this.textPoint(selection.anchor);
    const focus = this.textPoint(selection.focus);
    if (!anchor || !focus) return;
    const current = window.getSelection();
    if (!current) return;
    current.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    this.savedSelection = {
      anchor: selection.anchor,
      focus: selection.focus,
      anchorNode: anchor.node,
      focusNode: focus.node
    };
  }

  private handleCopy(event: ClipboardEvent): void {
    const saved = this.savedSelection;
    if (!saved) return;
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const current = this.captureSelection();
      if (current) {
        this.savedSelection = current;
        return;
      }
      const inside = this.host.contains(selection.anchorNode) || this.host.contains(selection.focusNode);
      if (inside) {
        if (selection.isCollapsed && (!saved.anchorNode.isConnected || !saved.focusNode.isConnected)) {
          // The browser collapsed Selection to the host after recycling its rows.
        } else {
          this.savedSelection = null;
          return;
        }
      } else {
        this.savedSelection = null;
        return;
      }
    }
    if (saved.anchorNode.isConnected || saved.focusNode.isConnected) {
      this.savedSelection = null;
      return;
    }
    const start = Math.min(saved.anchor, saved.focus);
    const end = Math.max(saved.anchor, saved.focus);
    if (!event.clipboardData || start === end) return;
    event.clipboardData.setData("text/plain", this.text.slice(start, end));
    event.preventDefault();
  }

  private handleSelectionChange(): void {
    const saved = this.savedSelection;
    if (!saved) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      this.savedSelection = null;
      return;
    }
    const current = this.captureSelection();
    if (current) {
      this.savedSelection = current;
      return;
    }
    if ((this.host.contains(selection.anchorNode) || this.host.contains(selection.focusNode))
      && selection.isCollapsed && (!saved.anchorNode.isConnected || !saved.focusNode.isConnected)) {
      return;
    }
    this.savedSelection = null;
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.savedSelection && !(event.target instanceof Node && this.host.contains(event.target))) {
      this.savedSelection = null;
    }
  }

  private handleFocusIn(event: FocusEvent): void {
    if (this.savedSelection && !(event.target instanceof Node && this.host.contains(event.target))) {
      this.savedSelection = null;
    }
  }

  private textPoint(offset: number): { node: Text; offset: number } | null {
    const rows = Array.from(this.host.querySelectorAll<HTMLElement>(".text-line-view-row"));
    for (const row of rows) {
      const start = Number(row.dataset.utf16Start);
      const end = Number(row.dataset.utf16End);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || offset < start || offset > end) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let cursor = start;
      let last: Text | null = null;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const length = node.data.length;
        last = node;
        if (offset <= cursor + length) return { node, offset: Math.max(0, offset - cursor) };
        cursor += length;
      }
      if (last) return { node: last, offset: last.data.length };
      const empty = document.createTextNode("");
      row.append(empty);
      return { node: empty, offset: 0 };
    }
    return null;
  }

  private rebuildOffsets(): void {
    this.offsets = new Array(this.heights.length + 1);
    this.offsets[0] = 0;
    for (let index = 0; index < this.heights.length; index += 1) {
      this.offsets[index + 1] = this.offsets[index] + this.heights[index];
    }
  }

  private lineHeight(): number {
    const value = Number.parseFloat(getComputedStyle(this.host).lineHeight);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_LINE_HEIGHT;
  }
}

function splitLines(text: string, previousWasCR: boolean, hasMore: boolean): TextLine[] {
  const lines: TextLine[] = [];
  let start = previousWasCR && text[0] === "\n" ? 1 : 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\r" || character === "\n") {
      const end = character === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
      lines.push({ start, contentEnd: index, end });
      index = end - 1;
      start = end;
    }
  }
  if (start < text.length || !hasMore) lines.push({ start, contentEnd: text.length, end: text.length });
  return lines;
}

function normalizeHighlight(highlight: TextLineHighlight | null, length: number): TextLineHighlight | null {
  if (!highlight) return null;
  const start = Math.max(0, Math.min(length, highlight.start));
  const end = Math.max(start, Math.min(length, highlight.end));
  return end > start ? { start, end, marker: highlight.marker } : null;
}
