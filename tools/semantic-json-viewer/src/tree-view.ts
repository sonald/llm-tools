import { invoke } from "@tauri-apps/api/core";
import type { ContentTarget } from "./content-viewer";

import { t } from "./i18n";
import { ProjectionBudget } from "./projection-budget";

export type TreeMode = "document" | "collection" | "entry" | "nested";

export type NodeDto = {
  id: number;
  kind: string;
  spanStart: number;
  spanEnd: number;
  label: string;
  labelHasMore: boolean;
  valuePreview: string | null;
  valueHasMore: boolean;
  childCount: number;
};

type NodePageDto = {
  nodes: NodeDto[];
  hasMore: boolean;
  nextCursor: number | null;
};

export type TreeSession = {
  mode: TreeMode;
  sessionRevision: number;
  scopeId: number | null;
  sourceSize: number;
  ariaLabel: string;
  scopeLabel?: string;
};

type NodeRecord = {
  node: NodeDto;
  previewLoaded: boolean;
  previewLoading: boolean;
  previewError: string | null;
  parentId: number | null;
  children: number[];
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  nextCursor: number | null;
  error: string | null;
};

type TreeRow =
  | {
    kind: "node";
    key: number;
    id: number;
    level: number;
    position: number;
    setSize: number;
  }
  | {
    kind: "load" | "retry" | "loading";
    key: `load:${number}` | `retry:${number}` | `loading:${number}`;
    parentId: number;
    level: number;
    position: number;
    setSize: number;
  };

export type TreeCopyElements = {
  raw: HTMLButtonElement;
  subtree: HTMLButtonElement;
  decoded: HTMLButtonElement;
  path: HTMLButtonElement;
  status: HTMLElement;
};

type TreeViewOptions = {
  panel: HTMLElement;
  viewport?: HTMLElement;
  tab: HTMLButtonElement;
  inspector: HTMLElement | null;
  fields: {
    id: HTMLElement;
    label: HTMLElement;
    kind: HTMLElement;
    span: HTMLElement;
    children: HTMLElement;
    value: HTMLElement;
  } | null;
  onSelection: (node: NodeDto) => void;
  onStringSelection: (target: ContentTarget | null) => void;
  onStringOpen: (target: ContentTarget, opener: HTMLElement) => void;
  onError: (error: unknown) => void;
  invoke?: typeof invoke;
  copy?: TreeCopyElements;
  projectionBudget?: ProjectionBudget;
};

export type FocusKey = number | `load:${number}` | `retry:${number}` | null;

export type TreeViewSnapshot = {
  session: TreeSession;
  rootId: number | null;
  rootError: string | null;
  selectedId: number | null;
  focusKey: FocusKey;
  scrollTop: number;
  scrollLeft: number;
  navigationBytes: number;
  records: Array<{
    id: number;
    node: NodeDto;
    previewLoaded: boolean;
    parentId: number | null;
    children: number[];
    expanded: boolean;
    loaded: boolean;
    hasMore: boolean;
    nextCursor: number | null;
    error: string | null;
  }>;
};

const CHILD_PAGE_SIZE = 200;
const TREE_ROW_HEIGHT = 35;
const TREE_OVERSCAN_ROWS = 10;
const TREE_TOP_PADDING = 18;

export class TreeView {
  private readonly panel: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly inspector: HTMLElement | null;
  private readonly fields: TreeViewOptions["fields"];
  private readonly onSelection: (node: NodeDto) => void;
  private readonly onStringSelection: (target: ContentTarget | null) => void;
  private readonly onStringOpen: (target: ContentTarget, opener: HTMLElement) => void;
  private readonly onError: (error: unknown) => void;
  private readonly invokeRequest: typeof invoke;
  private readonly copy: TreeViewOptions["copy"];
  private readonly projectionBudget: ProjectionBudget;
  private readonly cachedValues = new Set<NodeRecord>();
  private activeValues = new Set<NodeRecord>();
  private readonly pendingValues = new Set<NodeRecord>();
  private session: TreeSession | null = null;
  private generation = 0;
  private rootId: number | null = null;
  private rootLoading = false;
  private rootError: string | null = null;
  private selectedId: number | null = null;
  private focusKey: FocusKey = null;
  private readonly records = new Map<number, NodeRecord>();
  private logicalRows: TreeRow[] = [];
  private logicalRowsDirty = true;
  private treeRoot: HTMLElement | null = null;
  private programmaticScroll: { top: number; left: number } | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private narrowRestoreSnapshot: TreeViewSnapshot | null = null;
  private copyGeneration = 0;
  private copyBusy = false;

  constructor(options: TreeViewOptions) {
    this.panel = options.panel;
    const requestedViewport = options.viewport ?? options.panel;
    this.viewport = requestedViewport === options.panel || requestedViewport.contains(options.panel)
      ? requestedViewport
      : options.panel;
    this.tab = options.tab;
    this.inspector = options.inspector;
    this.fields = options.fields;
    this.onSelection = options.onSelection;
    this.onStringSelection = options.onStringSelection;
    this.onStringOpen = options.onStringOpen;
    this.onError = options.onError;
    this.invokeRequest = options.invoke ?? invoke;
    this.copy = options.copy;
    this.projectionBudget = options.projectionBudget ?? new ProjectionBudget();
    this.viewport.classList.add("tree-viewport");
    this.viewport.addEventListener("scroll", () => this.handleViewportScroll(), { passive: true });
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => this.renderWindow());
    this.resizeObserver?.observe(this.viewport);
    this.panel.addEventListener("click", (event) => this.handleClick(event));
    this.panel.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.copy?.raw.addEventListener("click", () => void this.copySelected("raw", t("tree.copiedRaw")));
    this.copy?.subtree.addEventListener("click", () => void this.copySelected("raw", t("tree.copiedJsonSubtree")));
    this.copy?.decoded.addEventListener("click", () => void this.copySelected("decoded", t("tree.copiedDecodedValue")));
    this.copy?.path.addEventListener("click", () => void this.copySelected("path", t("tree.copiedPath")));
    this.clear();
  }

  setSession(session: TreeSession, seededRoot?: unknown | null): void {
    this.generation += 1;
    this.copyGeneration += 1;
    this.copyBusy = false;
    if (this.copy) this.copy.status.textContent = "";
    this.narrowRestoreSnapshot = null;
    this.programmaticScroll = null;
    this.session = session;
    const root = seededRoot === undefined || seededRoot === null
      ? null
      : validateNodeDto(seededRoot, session.sourceSize);
    this.rootId = root?.id ?? null;
    this.rootLoading = false;
    this.rootError = seededRoot !== undefined && seededRoot !== null && root === undefined
      ? t("tree.rootResponseInvalid")
      : null;
    this.selectedId = null;
    this.focusKey = root?.id ?? null;
    this.clearRecords();
    this.logicalRowsDirty = true;
    if (root) this.records.set(root.id, this.newRecord(root, null));
    this.viewport.scrollTop = 0;
    this.viewport.scrollLeft = 0;
    this.onStringSelection(null);
    const enabled = session.mode !== "entry" || seededRoot !== undefined && seededRoot !== null;
    this.tab.disabled = !enabled;
    this.tab.setAttribute("aria-disabled", String(!enabled));
    this.clearInspector();
    if (root) this.renderTree();
    else if (this.rootError !== null) this.renderRootError();
    else this.renderPlaceholder(enabled ? t("tree.openDocumentRoot") : t("tree.selectValidEntry"));
  }

  snapshot(): TreeViewSnapshot | null {
    if (!this.session) return null;
    return {
      session: { ...this.session },
      rootId: this.rootId,
      rootError: this.rootError,
      selectedId: this.selectedId,
      focusKey: this.focusKey,
      scrollTop: this.viewport.scrollTop,
      scrollLeft: this.viewport.scrollLeft,
      navigationBytes: this.memoryUsage.currentNavigationBytes,
      records: Array.from(this.records.entries()).map(([id, record]) => ({
        id,
        node: { ...record.node, valuePreview: null },
        previewLoaded: record.previewLoaded && record.node.valuePreview === null,
        parentId: record.parentId,
        children: record.children.slice(),
        expanded: record.expanded,
        loaded: record.loaded,
        hasMore: record.hasMore,
        nextCursor: record.nextCursor,
        error: record.error
      }))
    };
  }

  restore(snapshot: TreeViewSnapshot | null): void {
    if (!snapshot) return;
    const shouldRestoreFocus = this.panel.contains(document.activeElement);
    this.narrowRestoreSnapshot = null;
    this.programmaticScroll = null;
    this.generation += 1;
    this.copyGeneration += 1;
    this.copyBusy = false;
    if (this.copy) this.copy.status.textContent = "";
    this.session = { ...snapshot.session };
    this.rootId = snapshot.rootId;
    this.rootLoading = false;
    this.rootError = snapshot.rootError;
    this.selectedId = snapshot.selectedId;
    this.focusKey = snapshot.focusKey;
    const restoreScrollTop = Math.max(0, snapshot.scrollTop ?? 0);
    const restoreScrollLeft = Math.max(0, snapshot.scrollLeft ?? 0);
    this.clearRecords();
    this.logicalRowsDirty = true;
    for (const saved of snapshot.records) {
      this.records.set(saved.id, {
        node: { ...saved.node },
        previewLoaded: saved.previewLoaded,
        previewLoading: false,
        previewError: null,
        parentId: saved.parentId,
        children: saved.children.slice(),
        expanded: saved.expanded,
        loaded: saved.loaded,
        loading: false,
        hasMore: saved.hasMore,
        nextCursor: saved.nextCursor,
        error: saved.error
      });
    }
    this.tab.disabled = this.session.mode === "entry" && this.rootId === null;
    this.tab.setAttribute("aria-disabled", String(this.tab.disabled));
    this.onStringSelection(this.selectedId === null ? null : this.records.get(this.selectedId)?.node.kind === "string"
      ? this.contentTarget(this.records.get(this.selectedId)!)
      : null);
    if (this.rootId !== null && this.records.has(this.rootId)) {
      this.renderTree();
      this.restoreViewportScroll(restoreScrollTop, restoreScrollLeft);
    }
    else if (this.rootError !== null) this.renderRootError();
    else this.renderPlaceholder(this.session.mode === "entry" ? t("tree.selectValidEntry") : t("tree.openDocumentRoot"));
    if (shouldRestoreFocus) this.restoreFocus();
  }

  clear(message = t("tree.openDocumentOrCollection")): void {
    this.generation += 1;
    this.copyGeneration += 1;
    this.copyBusy = false;
    this.narrowRestoreSnapshot = null;
    this.programmaticScroll = null;
    if (this.copy) this.copy.status.textContent = "";
    this.session = null;
    this.rootId = null;
    this.rootLoading = false;
    this.rootError = null;
    this.selectedId = null;
    this.focusKey = null;
    this.clearRecords();
    this.logicalRowsDirty = true;
    this.onStringSelection(null);
    this.tab.disabled = true;
    this.tab.setAttribute("aria-disabled", "true");
    this.clearInspector();
    this.renderPlaceholder(message);
  }

  activate(): void {
    if (!this.session || this.session.mode === "entry" && this.rootId === null) {
      this.renderPlaceholder(t("tree.selectValidEntry"));
      return;
    }
    if (this.rootId !== null) {
      return;
    }
    if (this.rootError !== null) {
      this.renderRootError();
      return;
    }
    if (this.rootLoading) {
      this.renderLoading();
      return;
    }
    void this.loadRoot();
  }

  /**
   * Open a source-referenced node as a narrow, real Tree root when its
   * ancestors are not loaded in the lazy outline yet. The session and scope
   * identity stay unchanged; expanding this root still uses the normal
   * bounded get_children path.
   */
  async focusNode(nodeId: number, expectedSpanStart?: number, expectedSpanEnd?: number): Promise<boolean> {
    const session = this.session;
    if (!session || !Number.isSafeInteger(nodeId) || nodeId < 0) return false;
    const known = this.records.get(nodeId);
    if (known
      && (expectedSpanStart === undefined || known.node.spanStart === expectedSpanStart)
      && (expectedSpanEnd === undefined || known.node.spanEnd === expectedSpanEnd)) {
      const ancestors: NodeRecord[] = [];
      let current = known;
      while (current.parentId !== null) {
        const parent = this.records.get(current.parentId);
        if (!parent) break;
        ancestors.push(parent);
        current = parent;
      }
      if (current.parentId === null && (current.node.id === this.rootId || this.rootId === null)) {
        for (const ancestor of ancestors) ancestor.expanded = true;
        this.logicalRowsDirty = true;
        this.select(known);
        this.focusLogicalKey(nodeId);
        return true;
      }
    }
    if (!this.narrowRestoreSnapshot) this.narrowRestoreSnapshot = this.snapshot();
    this.programmaticScroll = null;
    const generation = ++this.generation;
    this.rootLoading = true;
    this.rootError = null;
    this.selectedId = null;
    this.focusKey = null;
    this.clearRecords();
    this.logicalRowsDirty = true;
    this.renderLoading();
    try {
      const value = await this.invokeRequest<unknown>("get_node_summary", {
        nodeId,
        sessionRevision: session.sessionRevision,
        scopeId: session.scopeId
      });
      if (!this.isCurrent(generation, session)) return false;
      const node = validateNodeDto(value, session.sourceSize);
      if (!node || node.id !== nodeId
        || expectedSpanStart !== undefined && node.spanStart !== expectedSpanStart
        || expectedSpanEnd !== undefined && node.spanEnd !== expectedSpanEnd) {
        this.rootLoading = false;
        this.rootError = t("tree.requestedNodeInvalid");
        this.renderRootError();
        return false;
      }
      this.rootLoading = false;
      this.rootId = node.id;
      this.focusKey = node.id;
      const record = this.newRecord(node, null);
      this.records.set(node.id, record);
      this.logicalRowsDirty = true;
      this.select(record);
      return true;
    } catch (error) {
      if (!this.isCurrent(generation, session)) return false;
      this.rootLoading = false;
      if (this.isGlobalError(error)) {
        this.clear();
        this.onError(error);
        return false;
      }
      this.rootError = errorMessage(error);
      this.renderRootError();
      return false;
    }
  }

  private restoreNarrowScope(): void {
    const snapshot = this.narrowRestoreSnapshot;
    if (!snapshot) return;
    this.narrowRestoreSnapshot = null;
    this.restore(snapshot);
    if (snapshot.rootId === null && this.session) this.activate();
  }

  private async loadRoot(): Promise<void> {
    const session = this.session;
    if (!session || this.rootLoading) return;
    const generation = this.generation;
    this.rootLoading = true;
    this.rootError = null;
    this.renderLoading();
    try {
      const value = await this.invokeRequest<unknown>("get_root_node", {
        sessionRevision: session.sessionRevision,
        scopeId: session.scopeId
      });
      if (!this.isCurrent(generation, session)) return;
      const node = validateNodeDto(value, session.sourceSize);
      if (!node) throw new Error(t("tree.rootResponseInvalid"));
      this.rootLoading = false;
      this.rootId = node.id;
      this.records.set(node.id, this.newRecord(node, null));
      this.logicalRowsDirty = true;
      this.focusKey = node.id;
      this.renderTree();
    } catch (error) {
      if (!this.isCurrent(generation, session)) return;
      this.rootLoading = false;
      if (this.isGlobalError(error)) {
        this.clear();
        this.onError(error);
        return;
      }
      this.rootError = errorMessage(error);
      this.renderRootError();
    }
  }

  private async loadChildren(record: NodeRecord): Promise<void> {
    const session = this.session;
    if (!session || record.loading) return;
    const generation = this.generation;
    const cursor = record.nextCursor ?? 0;
    record.loading = true;
    record.error = null;
    this.logicalRowsDirty = true;
    this.renderTree();
    try {
      const value = await this.invokeRequest<unknown>("get_children", {
        nodeId: record.node.id,
        cursor,
        limit: CHILD_PAGE_SIZE,
        sessionRevision: session.sessionRevision,
        scopeId: session.scopeId
      });
      if (!this.isCurrent(generation, session)) return;
      const page = validateNodePage(value, cursor, record.node.childCount, session.sourceSize, record.children);
      if (!page) throw new Error(t("tree.childrenResponseInvalid"));
      record.loading = false;
      record.loaded = true;
      record.hasMore = page.hasMore;
      record.nextCursor = page.nextCursor;
      for (const node of page.nodes) {
        const child = this.records.get(node.id);
        if (child) {
          child.node = node;
          child.previewLoaded = true;
          child.previewError = null;
          this.pendingValues.add(child);
          child.parentId = record.node.id;
        } else {
          this.records.set(node.id, this.newRecord(node, record.node.id));
        }
        record.children.push(node.id);
      }
      this.logicalRowsDirty = true;
      if (!record.hasMore && this.focusKey === `load:${record.node.id}`) this.focusKey = record.node.id;
      this.renderTree();
    } catch (error) {
      if (!this.isCurrent(generation, session)) return;
      record.loading = false;
      if (this.isGlobalError(error)) {
        this.clear();
        this.onError(error);
        return;
      }
      record.error = errorMessage(error);
      this.logicalRowsDirty = true;
      this.renderTree();
    }
  }

  private toggle(record: NodeRecord): void {
    if (record.node.childCount === 0) return;
    record.expanded = !record.expanded;
    this.logicalRowsDirty = true;
    if (record.expanded && !record.loaded && !record.loading) {
      void this.loadChildren(record);
      return;
    }
    this.renderTree();
  }

  private select(record: NodeRecord): void {
    this.copyGeneration += 1;
    this.copyBusy = false;
    if (this.copy) this.copy.status.textContent = "";
    this.selectedId = record.node.id;
    this.focusKey = record.node.id;
    this.onSelection(record.node);
    this.onStringSelection(record.node.kind === "string" ? this.contentTarget(record) : null);
    this.renderInspector(record.node);
    this.renderTree();
  }

  private handleClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-return-scope-tree]")) {
      this.restoreNarrowScope();
      return;
    }
    const loadMore = target.closest<HTMLElement>("[data-load-parent]");
    if (loadMore) {
      const parentId = Number(loadMore.dataset.loadParent);
      const record = this.records.get(parentId);
      if (record) {
        this.focusKey = `load:${parentId}`;
        void this.loadChildren(record);
      }
      return;
    }
    const retry = target.closest<HTMLElement>("[data-retry-parent]");
    if (retry) {
      const parentId = Number(retry.dataset.retryParent);
      const record = this.records.get(parentId);
      if (record) {
        this.focusKey = parentId;
        void this.loadChildren(record);
      }
      return;
    }
    if (target.closest("[data-retry-root]")) {
      void this.loadRoot();
      return;
    }
    const item = target.closest<HTMLElement>("[data-node-id]");
    if (!item) return;
    const record = this.records.get(Number(item.dataset.nodeId));
    if (!record) return;
    if (record.previewError !== null) {
      record.previewError = null;
      void this.loadValue(record);
    }
    const doubleClick = event instanceof MouseEvent && event.detail === 2;
    if (!doubleClick && target.closest(".tree-disclosure") && record.node.childCount > 0) {
      this.focusKey = record.node.id;
      this.toggle(record);
    } else {
      const openString = record.node.kind === "string"
        && (doubleClick || record.node.valueHasMore && target.closest(".tree-value") !== null);
      this.select(record);
      if (openString) {
        const currentItem = this.panel.querySelector<HTMLElement>(`[data-node-id="${record.node.id}"]`);
        this.onStringOpen(this.contentTarget(record), currentItem ?? item);
      }
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest<HTMLElement>("[role=treeitem]");
    const key = item ? rowKey(item) : target === this.treeRoot ? this.focusKey : null;
    if (key === null) return;
    const index = this.logicalRows.findIndex((row) => row.key === key);
    if (index < 0) return;
    const row = this.logicalRows[index];
    if (row.kind !== "node") {
      const parent = this.records.get(row.parentId);
      if (!parent) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.focusLogicalIndex(index + 1, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.focusLogicalIndex(index - 1, -1);
      } else if (event.key === "Home") {
        event.preventDefault();
        this.focusLogicalIndex(0, 1);
      } else if (event.key === "End") {
        event.preventDefault();
        this.focusLogicalIndex(this.logicalRows.length - 1, -1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.focusItem(parent.node.id);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (row.kind === "retry") this.focusKey = parent.node.id;
        void this.loadChildren(parent);
      }
      return;
    }
    const record = this.records.get(row.id);
    if (!record) return;
    if (event.key === "Enter" && record.previewError !== null) {
      event.preventDefault();
      record.previewError = null;
      void this.loadValue(record);
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.focusLogicalIndex(index + 1, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.focusLogicalIndex(index - 1, -1);
        break;
      case "Home":
        event.preventDefault();
        this.focusLogicalIndex(0, 1);
        break;
      case "End":
        event.preventDefault();
        this.focusLogicalIndex(this.logicalRows.length - 1, -1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (record.node.childCount > 0 && !record.expanded) {
          this.toggle(record);
        } else if (record.expanded && record.children.length > 0) {
          this.focusLogicalKey(record.children[0]);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (record.expanded) {
          record.expanded = false;
          this.logicalRowsDirty = true;
          this.renderTree();
          this.focusItem(record.node.id);
        } else if (record.parentId !== null) {
          this.focusItem(record.parentId);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (record.error !== null) void this.loadChildren(record);
        else this.select(record);
        break;
      default:
        break;
    }
  }

  private focusItem(id: number): void {
    this.focusLogicalKey(id);
  }

  private focusLogicalIndex(index: number, direction: 1 | -1): void {
    let candidate = index;
    while (candidate >= 0 && candidate < this.logicalRows.length
      && this.logicalRows[candidate].kind === "loading") {
      candidate += direction;
    }
    const row = this.logicalRows[candidate];
    if (row && row.kind !== "loading") this.focusLogicalKey(row.key as FocusKey);
  }

  private focusLogicalKey(key: FocusKey): void {
    if (key === null) return;
    this.focusKey = key;
    const generation = this.generation;
    const session = this.session;
    const index = this.logicalRows.findIndex((row) => row.key === key);
    if (index >= 0) this.scrollToRow(index);
    this.renderWindow();
    queueMicrotask(() => {
      if (!session || !this.isCurrent(generation, session) || this.focusKey !== key) return;
      const item = this.rowElementForKey(key);
      if (item) this.focusDomElement(item);
    });
  }

  private renderTree(): void {
    const shouldRestoreFocus = this.panel.contains(document.activeElement);
    const scrollTop = this.viewport.scrollTop;
    const scrollLeft = this.viewport.scrollLeft;
    const shell = document.createElement("div");
    shell.className = "tree-scope-shell";
    if (this.narrowRestoreSnapshot) {
      const back = document.createElement("button");
      back.className = "secondary-button tree-return-scope";
      back.type = "button";
      back.dataset.returnScopeTree = "true";
      back.textContent = t("tree.returnToScope");
      shell.append(back);
    }
    const root = document.createElement("div");
    root.className = "tree-root";
    root.setAttribute("role", "tree");
    root.tabIndex = -1;
    root.setAttribute("aria-label", this.session?.ariaLabel ?? t("main.jsonStructure"));
    root.setAttribute("aria-busy", String(this.rootLoading));
    this.treeRoot = root;
    shell.append(root);
    this.panel.replaceChildren(shell);
    if (this.rootId === null) this.renderLoading(root);
    else {
      this.renderWindow();
      this.restoreViewportScroll(scrollTop, scrollLeft);
    }
    this.panel.setAttribute("aria-busy", String(this.rootLoading));
    this.renderInspector(this.selectedId === null ? null : this.records.get(this.selectedId)?.node ?? null);
    if (shouldRestoreFocus) this.restoreFocus();
  }

  private ensureLogicalRows(): void {
    if (!this.logicalRowsDirty) return;
    const rows: TreeRow[] = [];
    if (this.rootId !== null && this.records.has(this.rootId)) {
      type StackEntry =
        | { kind: "node"; id: number; level: number; position: number; setSize: number }
        | { kind: "after"; id: number; level: number };
      const stack: StackEntry[] = [{
        kind: "node",
        id: this.rootId,
        level: 1,
        position: 1,
        setSize: 1
      }];
      while (stack.length > 0) {
        const entry = stack.pop()!;
        const record = this.records.get(entry.id);
        if (!record) continue;
        if (entry.kind === "after") {
          const position = record.children.length + 1;
          if (record.loading) {
            rows.push({
              kind: "loading",
              key: `loading:${record.node.id}`,
              parentId: record.node.id,
              level: entry.level,
              position,
              setSize: record.node.childCount
            });
          } else if (record.error !== null) {
            rows.push({
              kind: "retry",
              key: `retry:${record.node.id}`,
              parentId: record.node.id,
              level: entry.level,
              position,
              setSize: record.node.childCount
            });
          } else if (record.hasMore && record.nextCursor !== null) {
            rows.push({
              kind: "load",
              key: `load:${record.node.id}`,
              parentId: record.node.id,
              level: entry.level,
              position,
              setSize: record.node.childCount
            });
          }
          continue;
        }

        rows.push({
          kind: "node",
          key: record.node.id,
          id: record.node.id,
          level: entry.level,
          position: entry.position,
          setSize: entry.setSize
        });
        if (!record.expanded) continue;
        stack.push({ kind: "after", id: record.node.id, level: entry.level + 1 });
        for (let index = record.children.length - 1; index >= 0; index -= 1) {
          const childId = record.children[index];
          if (!this.records.has(childId)) continue;
          stack.push({
            kind: "node",
            id: childId,
            level: entry.level + 1,
            position: index + 1,
            setSize: record.node.childCount
          });
        }
      }
    }
    this.logicalRows = rows;
    this.logicalRowsDirty = false;
  }

  private renderWindow(): void {
    const root = this.treeRoot;
    if (!root || this.rootId === null) return;
    const active = document.activeElement;
    const activeKey = active instanceof HTMLElement
      && this.panel.contains(active)
      && active.getAttribute("role") === "treeitem"
      ? rowKey(active)
      : null;
    this.ensureLogicalRows();
    const [start, end] = this.visibleRange(this.logicalRows.length);
    this.updateValueWindow(start, end);
    const top = document.createElement("div");
    top.className = "tree-virtual-spacer";
    top.setAttribute("aria-hidden", "true");
    top.style.height = `${start * TREE_ROW_HEIGHT}px`;
    const list = document.createElement("div");
    list.className = "tree-virtual-list";
    list.setAttribute("role", "presentation");
    for (let index = start; index < end; index += 1) {
      list.append(this.createRowElement(this.logicalRows[index]));
    }
    const bottom = document.createElement("div");
    bottom.className = "tree-virtual-spacer";
    bottom.setAttribute("aria-hidden", "true");
    bottom.style.height = `${(this.logicalRows.length - end) * TREE_ROW_HEIGHT}px`;
    root.replaceChildren(top, list, bottom);
    root.setAttribute("aria-busy", String(this.rootLoading));
    root.tabIndex = this.focusKey !== null && this.rowElementForKey(this.focusKey) === null ? 0 : -1;
    if (activeKey !== null && activeKey === this.focusKey) this.restoreFocus();
  }

  private visibleRange(rowCount: number): [number, number] {
    if (rowCount === 0) return [0, 0];
    const viewportHeight = this.viewport.clientHeight;
    const visible = viewportHeight > 0 ? Math.max(1, Math.ceil(viewportHeight / TREE_ROW_HEIGHT)) : 1;
    if (viewportHeight <= 0) return [0, Math.min(rowCount, visible + TREE_OVERSCAN_ROWS * 2)];
    const firstRowTop = this.firstRowTop();
    const relativeScrollTop = Math.max(0, this.viewport.scrollTop - firstRowTop);
    const first = Math.min(rowCount, Math.floor(relativeScrollTop / TREE_ROW_HEIGHT));
    return [
      Math.max(0, first - TREE_OVERSCAN_ROWS),
      Math.min(rowCount, first + visible + TREE_OVERSCAN_ROWS)
    ];
  }

  private firstRowTop(): number {
    if (!this.treeRoot) return TREE_TOP_PADDING;
    const viewportRect = this.viewport.getBoundingClientRect();
    const rootRect = this.treeRoot.getBoundingClientRect();
    return Math.max(0, rootRect.top - viewportRect.top + this.viewport.scrollTop + TREE_TOP_PADDING);
  }

  private createRowElement(row: TreeRow): HTMLElement {
    if (row.kind === "node") {
      const record = this.records.get(row.id);
      if (!record) throw new Error("Tree row record was not loaded.");
      return this.nodeElement(record, row);
    }
    const parent = this.records.get(row.parentId);
    if (!parent) throw new Error("Tree operation row parent was not loaded.");
    const position = row.position;
    if (row.kind === "loading") {
      const loading = document.createElement("div");
      loading.className = "tree-loading";
      loading.setAttribute("role", "treeitem");
      loading.setAttribute("aria-level", String(row.level));
      loading.setAttribute("aria-posinset", String(position));
      loading.setAttribute("aria-setsize", String(row.setSize));
      loading.setAttribute("aria-busy", "true");
      loading.style.setProperty("--tree-indent", `${(row.level - 1) * 20}px`);
      loading.textContent = t("tree.loadingChildren");
      return loading;
    }
    const operation = document.createElement("button");
    operation.className = row.kind === "retry" ? "tree-retry" : "tree-load-more";
    operation.type = "button";
    operation.setAttribute("role", "treeitem");
    operation.setAttribute("aria-level", String(row.level));
    operation.setAttribute("aria-posinset", String(position));
    operation.setAttribute("aria-setsize", String(row.setSize));
    operation.style.setProperty("--tree-indent", `${(row.level - 1) * 20}px`);
    operation.tabIndex = this.focusKey === row.key ? 0 : -1;
    if (row.kind === "retry") {
      operation.dataset.retryParent = String(row.parentId);
      operation.setAttribute("aria-label", t("tree.retryLoadingChildren"));
      operation.title = parent.error ?? t("tree.retryLoadingChildren");
      operation.textContent = t("tree.retryLoadingChildrenDetail", { message: parent.error ?? "" });
    } else {
      operation.dataset.loadParent = String(row.parentId);
      operation.setAttribute("aria-label", t("tree.loadMoreChildren", { cursor: parent.nextCursor ?? 0 }));
      operation.title = t("tree.loadMoreChildren", { cursor: parent.nextCursor ?? 0 });
      operation.textContent = t("tree.loadMoreChildren", { cursor: parent.nextCursor ?? 0 });
    }
    return operation;
  }

  private nodeElement(record: NodeRecord, row: Extract<TreeRow, { kind: "node" }>): HTMLButtonElement {
    const node = record.node;
    const item = document.createElement("button");
    item.className = "tree-item";
    item.type = "button";
    item.dataset.nodeId = String(node.id);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.level));
    item.setAttribute("aria-posinset", String(row.position));
    item.setAttribute("aria-setsize", String(row.setSize));
    item.setAttribute("aria-selected", String(this.selectedId === node.id));
    item.tabIndex = this.focusKey === node.id ? 0 : -1;
    item.style.setProperty("--tree-indent", `${(row.level - 1) * 20}px`);
    if (node.childCount > 0) item.setAttribute("aria-expanded", String(record.expanded));
    if (record.loading) item.setAttribute("aria-busy", "true");

    const disclosure = document.createElement("span");
    disclosure.className = "tree-disclosure";
    disclosure.textContent = node.childCount > 0 ? record.expanded ? "▾" : "▸" : "·";
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `#${node.id} · ${node.label}`;
    if (node.labelHasMore) label.textContent += ` · ${t("tree.truncated")}`;
    const kind = document.createElement("span");
    kind.className = "tree-kind";
    kind.textContent = kindLabel(node.kind);
    const span = document.createElement("span");
    span.className = "tree-span";
    span.textContent = `[${node.spanStart}, ${node.spanEnd})`;
    const children = document.createElement("span");
    children.className = "tree-children";
    children.textContent = t("tree.childrenCount", { count: node.childCount });
    const value = document.createElement("span");
    value.className = "tree-value";
    value.textContent = record.previewLoaded ? node.valuePreview ?? "—" : record.previewError ?? "…";
    if (record.previewError !== null) value.title = t("tree.retryValue");
    if (node.valueHasMore && record.previewLoaded) {
      value.textContent += ` · ${t("tree.truncated")}`;
      if (node.kind === "string") {
        value.classList.add("tree-value-openable");
        value.title = t("tree.openFullString");
      }
    }
    item.append(disclosure, label, kind, span, children, value);
    return item;
  }

  private handleViewportScroll(): void {
    const expected = this.programmaticScroll;
    const programmatic = expected !== null
      && expected.top === this.viewport.scrollTop
      && expected.left === this.viewport.scrollLeft;
    this.programmaticScroll = null;
    if (!programmatic) {
      const active = document.activeElement;
      if (active instanceof HTMLElement
        && this.panel.contains(active)
        && active.getAttribute("role") === "treeitem") {
        this.treeRoot?.focus({ preventScroll: true });
      }
    }
    this.renderWindow();
  }

  private scrollToRow(index: number): void {
    if (this.viewport.clientHeight <= 0) return;
    const firstRowTop = this.firstRowTop();
    const rowTop = index * TREE_ROW_HEIGHT;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    const viewportTop = this.viewport.scrollTop;
    const viewportBottom = viewportTop + this.viewport.clientHeight;
    const nextScrollTop = rowTop + firstRowTop < viewportTop
      ? rowTop
      : rowBottom + firstRowTop > viewportBottom
        ? rowBottom - this.viewport.clientHeight + firstRowTop
        : viewportTop;
    if (nextScrollTop === viewportTop) return;
    this.programmaticScroll = {
      top: Math.max(0, nextScrollTop),
      left: this.viewport.scrollLeft
    };
    this.viewport.scrollTop = Math.max(0, nextScrollTop);
    this.programmaticScroll = {
      top: this.viewport.scrollTop,
      left: this.viewport.scrollLeft
    };
  }

  private restoreViewportScroll(top: number, left: number): void {
    this.programmaticScroll = { top, left };
    this.viewport.scrollTop = top;
    this.viewport.scrollLeft = left;
    this.programmaticScroll = {
      top: this.viewport.scrollTop,
      left: this.viewport.scrollLeft
    };
    this.renderWindow();
  }

  private rowElementForKey(key: FocusKey): HTMLElement | null {
    if (key === null) return null;
    const selector = typeof key === "number"
      ? `[data-node-id="${key}"]`
      : key.startsWith("load:")
        ? `[data-load-parent="${key.slice(5)}"]`
        : `[data-retry-parent="${key.slice(6)}"]`;
    return this.panel.querySelector<HTMLElement>(selector);
  }

  private renderPlaceholder(message: string): void {
    this.treeRoot = null;
    const state = document.createElement("div");
    state.className = "tree-state";
    state.setAttribute("role", "status");
    const strong = document.createElement("strong");
    strong.textContent = t("tree.view");
    const copy = document.createElement("span");
    copy.textContent = message;
    state.append(strong, copy);
    this.panel.replaceChildren(state);
    this.panel.removeAttribute("aria-busy");
  }

  private renderLoading(container?: HTMLElement): void {
    if (!container) this.treeRoot = null;
    const state = document.createElement("div");
    state.className = "tree-state";
    state.setAttribute("role", "status");
    const strong = document.createElement("strong");
    strong.textContent = t("tree.loading");
    state.append(strong);
    if (container) container.replaceChildren(state);
    else this.panel.replaceChildren(state);
    this.panel.setAttribute("aria-busy", "true");
  }

  private renderRootError(): void {
    this.treeRoot = null;
    const state = document.createElement("div");
    state.className = "tree-state";
    state.setAttribute("role", "alert");
    const strong = document.createElement("strong");
    strong.textContent = t("tree.couldNotLoad");
    const copy = document.createElement("span");
    copy.textContent = this.rootError ?? t("tree.unknownError");
    const retry = document.createElement("button");
    retry.className = "tree-retry";
    retry.type = "button";
    retry.dataset.retryRoot = "true";
    retry.textContent = t("tree.retry");
    state.append(strong, copy, retry);
    this.panel.replaceChildren(state);
    this.panel.removeAttribute("aria-busy");
  }

  private renderInspector(node: NodeDto | null): void {
    if (this.inspector && this.fields) {
      this.inspector.hidden = node === null;
      if (!node) {
        this.clearInspector();
      } else {
        this.fields.id.textContent = String(node.id);
        this.fields.label.textContent = node.label + (node.labelHasMore ? ` · ${t("tree.truncated")}` : "");
        this.fields.kind.textContent = kindLabel(node.kind);
        this.fields.span.textContent = `[${node.spanStart}, ${node.spanEnd})`;
        this.fields.children.textContent = String(node.childCount);
        this.fields.value.textContent = node.valuePreview ?? "—";
        if (node.valueHasMore) this.fields.value.textContent += ` · ${t("tree.truncated")}`;
      }
    }
    this.renderCopyActions(node);
  }

  private clearInspector(): void {
    if (this.inspector && this.fields) {
      this.inspector.hidden = true;
      for (const field of Object.values(this.fields)) field.textContent = "—";
    }
    this.renderCopyActions(null);
  }

  private renderCopyActions(node: NodeDto | null): void {
    const copy = this.copy;
    if (!copy) return;
    const enabled = node !== null && this.session !== null && !this.copyBusy;
    copy.raw.hidden = node === null;
    copy.subtree.hidden = node === null;
    copy.path.hidden = node === null;
    copy.decoded.hidden = node === null || !isScalarKind(node.kind);
    for (const button of [copy.raw, copy.subtree, copy.decoded, copy.path]) {
      button.disabled = !enabled || button.hidden || this.copyBusy;
    }
  }

  private async copySelected(format: "raw" | "decoded" | "path", successLabel: string): Promise<void> {
    const copy = this.copy;
    const session = this.session;
    const node = this.selectedId === null ? null : this.records.get(this.selectedId)?.node ?? null;
    if (!copy || !session || !node || this.copyBusy || format === "decoded" && !isScalarKind(node.kind)) return;
    const generation = this.copyGeneration;
    const sessionRevision = session.sessionRevision;
    const nodeId = node.id;
    this.copyBusy = true;
    copy.status.textContent = t("tree.copying");
    this.renderCopyActions(node);
    try {
      await this.invokeRequest("copy_node", {
        nodeId,
        scopeId: session.scopeId,
        sessionRevision,
        format
      });
      if (!this.isCopyCurrent(generation, sessionRevision, nodeId)) return;
      copy.status.textContent = successLabel;
    } catch (error) {
      if (!this.isCopyCurrent(generation, sessionRevision, nodeId)) return;
      if (this.isGlobalError(error)) {
        this.onError(error);
      } else {
        copy.status.textContent = t("tree.copyFailed", { message: errorMessage(error) });
      }
    } finally {
      if (this.isCopyCurrent(generation, sessionRevision, nodeId)) {
        this.copyBusy = false;
        this.renderCopyActions(node);
      }
    }
  }

  private isCopyCurrent(generation: number, revision: number, nodeId: number): boolean {
    return this.copyGeneration === generation
      && this.session?.sessionRevision === revision
      && this.selectedId === nodeId;
  }

  private restoreFocus(): void {
    if (this.focusKey === null) return;
    const focusKey = this.focusKey;
    const generation = this.generation;
    const session = this.session;
    queueMicrotask(() => {
      if (!session || !this.isCurrent(generation, session) || this.focusKey !== focusKey) return;
      const item = this.rowElementForKey(focusKey);
      if (item) this.focusDomElement(item);
      else if (this.treeRoot) {
        this.treeRoot.tabIndex = 0;
        this.treeRoot.focus({ preventScroll: true });
      }
    });
  }

  private focusDomElement(item: HTMLElement): void {
    if (this.treeRoot) this.treeRoot.tabIndex = -1;
    for (const other of this.panel.querySelectorAll<HTMLElement>("[role=treeitem]")) {
      if ("tabIndex" in other) other.tabIndex = other === item ? 0 : -1;
    }
    item.focus({ preventScroll: true });
  }

  get memoryUsage(): { cachedValueBytes: number; activeValueBytes: number; currentNavigationBytes: number; navigationBytes: number } {
    // Conservative UTF-16/structure estimates, not JavaScript heap measurements.
    const valueBytes = (records: Iterable<NodeRecord>): number => {
      let bytes = 0;
      for (const record of records) bytes += this.valueBytes(record);
      return bytes;
    };
    let currentNavigationBytes = this.logicalRows.length * 64;
    for (const record of this.records.values()) {
      currentNavigationBytes += 256 + record.node.label.length * 2 + record.children.length * 8
        + (record.error?.length ?? 0) * 2 + (record.previewError?.length ?? 0) * 2;
    }
    return {
      cachedValueBytes: valueBytes(this.cachedValues),
      activeValueBytes: valueBytes(this.activeValues),
      currentNavigationBytes,
      navigationBytes: currentNavigationBytes + (this.narrowRestoreSnapshot?.navigationBytes ?? 0)
    };
  }

  private valueBytes(record: NodeRecord): number {
    return record.node.valuePreview === null ? 0 : record.node.valuePreview.length * 2 + 64;
  }

  private clearRecords(): void {
    for (const record of this.cachedValues) this.projectionBudget.release(record);
    this.cachedValues.clear();
    this.activeValues.clear();
    this.pendingValues.clear();
    this.records.clear();
    this.logicalRows = [];
    this.logicalRowsDirty = true;
  }

  private cacheValue(record: NodeRecord): void {
    if (this.activeValues.has(record) || this.valueBytes(record) === 0) return;
    const evict = (): void => {
      this.cachedValues.delete(record);
      record.node = { ...record.node, valuePreview: null };
      record.previewLoaded = false;
      if (this.records.get(record.node.id) === record) {
        const value = this.panel.querySelector<HTMLElement>(`[data-node-id="${record.node.id}"] .tree-value`);
        if (value) value.textContent = "…";
        if (this.selectedId === record.node.id) this.renderInspector(record.node);
      }
    };
    const admitted = this.projectionBudget.admit(record, this.valueBytes(record), evict);
    if (this.records.get(record.node.id) !== record) {
      this.projectionBudget.release(record);
      return;
    }
    if (admitted) this.cachedValues.add(record);
    else evict();
  }

  private updateValueWindow(start: number, end: number): void {
    const next = new Set<NodeRecord>();
    if (this.viewport.getClientRects().length > 0 && !this.panel.closest("[hidden]")) {
      for (let index = start; index < end; index += 1) {
        const row = this.logicalRows[index];
        if (row.kind === "node") next.add(this.records.get(row.id)!);
      }
      const selected = this.selectedId === null ? undefined : this.records.get(this.selectedId);
      if (selected) next.add(selected);
    }
    for (const record of this.activeValues) if (!next.has(record)) this.pendingValues.add(record);
    this.activeValues = next;
    for (const record of next) {
      this.projectionBudget.release(record);
      this.cachedValues.delete(record);
      this.pendingValues.delete(record);
    }
    const pending = Array.from(this.pendingValues);
    this.pendingValues.clear();
    for (const record of pending) this.cacheValue(record);
    for (const record of next) void this.loadValue(record);
  }

  private async loadValue(record: NodeRecord): Promise<void> {
    const session = this.session;
    if (!session || record.previewLoaded || record.previewLoading || record.previewError !== null) return;
    const generation = this.generation;
    record.previewLoading = true;
    try {
      const value = await this.invokeRequest<unknown>("get_node_summary", {
        nodeId: record.node.id, sessionRevision: session.sessionRevision, scopeId: session.scopeId
      });
      if (!this.isCurrent(generation, session) || this.records.get(record.node.id) !== record) return;
      const node = validateNodeDto(value, session.sourceSize);
      if (!node || node.id !== record.node.id || node.spanStart !== record.node.spanStart
        || node.spanEnd !== record.node.spanEnd || node.kind !== record.node.kind
        || node.childCount !== record.node.childCount || node.label !== record.node.label
        || node.labelHasMore !== record.node.labelHasMore) throw new Error(t("tree.requestedNodeInvalid"));
      record.node = node;
      record.previewLoaded = true;
      record.previewLoading = false;
      this.cacheValue(record);
    } catch (error) {
      if (!this.isCurrent(generation, session) || this.records.get(record.node.id) !== record) return;
      record.previewLoading = false;
      if (this.isGlobalError(error)) {
        this.clear();
        this.onError(error);
        return;
      }
      record.previewError = errorMessage(error);
    }
    if (this.activeValues.has(record)) {
      this.renderWindow();
      if (this.selectedId === record.node.id) this.renderInspector(record.node);
    }
  }

  private newRecord(node: NodeDto, parentId: number | null): NodeRecord {
    const record: NodeRecord = {
      node,
      previewLoaded: true,
      previewLoading: false,
      previewError: null,
      parentId,
      children: [],
      expanded: false,
      loaded: false,
      loading: false,
      hasMore: false,
      nextCursor: null,
      error: null
    };
    if (node.valuePreview !== null) this.pendingValues.add(record);
    return record;
  }

  private contentTarget(record: NodeRecord): ContentTarget {
    const session = this.session;
    if (!session) throw new Error(t("tree.contentViewerSessionRequired"));
    const pathSegments: string[] = [];
    let current: NodeRecord | undefined = record;
    let pathTruncated = this.narrowRestoreSnapshot !== null;
    while (current) {
      pathSegments.unshift(current.node.label);
      pathTruncated ||= current.node.labelHasMore;
      current = current.parentId === null ? undefined : this.records.get(current.parentId);
    }
    return {
      revision: session.sessionRevision,
      nodeId: record.node.id,
      spanStart: record.node.spanStart,
      spanEnd: record.node.spanEnd,
      scopeId: session.scopeId,
      scopeLabel: session.scopeLabel ?? session.ariaLabel,
      pathSegments,
      pathTruncated
    };
  }

  private isCurrent(generation: number, session: TreeSession): boolean {
    return this.generation === generation
      && this.session?.sessionRevision === session.sessionRevision
      && this.session.scopeId === session.scopeId;
  }

  private isGlobalError(error: unknown): boolean {
    const code = errorCode(error);
    return code === "stale_session" || code === "file_changed";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function rowKey(item: HTMLElement): FocusKey {
  if (item.dataset.nodeId) return safeRowId(item.dataset.nodeId);
  if (item.dataset.loadParent) {
    const parentId = safeRowId(item.dataset.loadParent);
    return parentId === null ? null : `load:${parentId}`;
  }
  if (item.dataset.retryParent) {
    const parentId = safeRowId(item.dataset.retryParent);
    return parentId === null ? null : `retry:${parentId}`;
  }
  return null;
}

function safeRowId(value: string): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return message;
  }
  if (error instanceof Error) return error.message;
  return t("tree.requestFailed");
}

function kindLabel(kind: string): string {
  if (kind === "object") return t("jsonKind.object");
  if (kind === "array") return t("jsonKind.array");
  if (kind === "string") return t("jsonKind.string");
  if (kind === "number") return t("jsonKind.number");
  if (kind === "true") return t("jsonKind.true");
  if (kind === "false") return t("jsonKind.false");
  if (kind === "null") return t("jsonKind.null");
  return kind;
}

function isScalarKind(kind: string): boolean {
  return kind === "string" || kind === "number" || kind === "true" || kind === "false" || kind === "null";
}

const TREE_KINDS = new Set(["object", "array", "string", "number", "true", "false", "null"]);

export function validateNodeDto(value: unknown, sourceSize: number): NodeDto | undefined {
  if (!isRecord(value) || !safeNonNegative(sourceSize)) return undefined;
  const id = safeNonNegative(value.id);
  const spanStart = safeNonNegative(value.spanStart);
  const spanEnd = safeNonNegative(value.spanEnd);
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const label = typeof value.label === "string" ? value.label : undefined;
  const labelHasMore = typeof value.labelHasMore === "boolean" ? value.labelHasMore : undefined;
  const valuePreview = value.valuePreview === null
    ? null
    : typeof value.valuePreview === "string" ? value.valuePreview : undefined;
  const valueHasMore = typeof value.valueHasMore === "boolean" ? value.valueHasMore : undefined;
  const childCount = safeNonNegative(value.childCount);
  if (id === undefined || spanStart === undefined || spanEnd === undefined || spanStart >= spanEnd
    || spanEnd > sourceSize || kind === undefined || !TREE_KINDS.has(kind) || label === undefined
    || labelHasMore === undefined || valuePreview === undefined || valueHasMore === undefined || childCount === undefined) {
    return undefined;
  }
  return { id, kind, spanStart, spanEnd, label, labelHasMore, valuePreview, valueHasMore, childCount };
}

export function validateNodePage(
  value: unknown,
  cursor: number,
  childCount: number,
  sourceSize: number,
  loadedChildren: number[]
): NodePageDto | undefined {
  if (!isRecord(value) || safeNonNegative(cursor) === undefined || safeNonNegative(childCount) === undefined
    || cursor > childCount || !Array.isArray(value.nodes) || value.nodes.length > CHILD_PAGE_SIZE
    || typeof value.hasMore !== "boolean") return undefined;
  const nodes: NodeDto[] = [];
  const pageIds = new Set<number>();
  for (const item of value.nodes) {
    const node = validateNodeDto(item, sourceSize);
    if (!node || pageIds.has(node.id) || loadedChildren.includes(node.id)) return undefined;
    pageIds.add(node.id);
    nodes.push(node);
  }
  const nextCursor = value.nextCursor === null ? null : safeNonNegative(value.nextCursor);
  if (nextCursor === undefined) return undefined;
  if (value.hasMore) {
    if (nodes.length === 0 || nextCursor !== cursor + nodes.length || nextCursor >= childCount) return undefined;
  } else if (nextCursor !== null || cursor + nodes.length !== childCount) {
    return undefined;
  }
  return { nodes, hasMore: value.hasMore, nextCursor };
}

function safeNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
