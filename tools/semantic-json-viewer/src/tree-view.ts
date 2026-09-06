import { invoke } from "@tauri-apps/api/core";
import type { ContentTarget } from "./content-viewer";

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
  parentId: number | null;
  children: number[];
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  nextCursor: number | null;
  error: string | null;
};

type TreeViewOptions = {
  panel: HTMLElement;
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
};

export type FocusKey = number | `load:${number}` | `retry:${number}` | null;

export type TreeViewSnapshot = {
  session: TreeSession;
  rootId: number | null;
  rootError: string | null;
  selectedId: number | null;
  focusKey: FocusKey;
  records: Array<{
    id: number;
    node: NodeDto;
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

export class TreeView {
  private readonly panel: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly inspector: HTMLElement | null;
  private readonly fields: TreeViewOptions["fields"];
  private readonly onSelection: (node: NodeDto) => void;
  private readonly onStringSelection: (target: ContentTarget | null) => void;
  private readonly onStringOpen: (target: ContentTarget, opener: HTMLElement) => void;
  private readonly onError: (error: unknown) => void;
  private readonly invokeRequest: typeof invoke;
  private session: TreeSession | null = null;
  private generation = 0;
  private rootId: number | null = null;
  private rootLoading = false;
  private rootError: string | null = null;
  private selectedId: number | null = null;
  private focusKey: FocusKey = null;
  private readonly records = new Map<number, NodeRecord>();

  constructor(options: TreeViewOptions) {
    this.panel = options.panel;
    this.tab = options.tab;
    this.inspector = options.inspector;
    this.fields = options.fields;
    this.onSelection = options.onSelection;
    this.onStringSelection = options.onStringSelection;
    this.onStringOpen = options.onStringOpen;
    this.onError = options.onError;
    this.invokeRequest = options.invoke ?? invoke;
    this.panel.addEventListener("click", (event) => this.handleClick(event));
    this.panel.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.clear();
  }

  setSession(session: TreeSession, seededRoot?: unknown | null): void {
    this.generation += 1;
    this.session = session;
    const root = seededRoot === undefined || seededRoot === null
      ? null
      : validateNodeDto(seededRoot, session.sourceSize);
    this.rootId = root?.id ?? null;
    this.rootLoading = false;
    this.rootError = seededRoot !== undefined && seededRoot !== null && root === undefined
      ? "The tree root response was invalid."
      : null;
    this.selectedId = null;
    this.focusKey = root?.id ?? null;
    this.records.clear();
    if (root) this.records.set(root.id, this.newRecord(root, null));
    this.onStringSelection(null);
    const enabled = session.mode !== "entry" || seededRoot !== undefined && seededRoot !== null;
    this.tab.disabled = !enabled;
    this.tab.setAttribute("aria-disabled", String(!enabled));
    this.clearInspector();
    if (root) this.renderTree();
    else if (this.rootError !== null) this.renderRootError();
    else this.renderPlaceholder(enabled ? "Open Tree to load the document root." : "Select a valid Entry to enable Tree.");
  }

  snapshot(): TreeViewSnapshot | null {
    if (!this.session) return null;
    return {
      session: { ...this.session },
      rootId: this.rootId,
      rootError: this.rootError,
      selectedId: this.selectedId,
      focusKey: this.focusKey,
      records: Array.from(this.records.entries()).map(([id, record]) => ({
        id,
        node: { ...record.node },
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
    this.generation += 1;
    this.session = { ...snapshot.session };
    this.rootId = snapshot.rootId;
    this.rootLoading = false;
    this.rootError = snapshot.rootError;
    this.selectedId = snapshot.selectedId;
    this.focusKey = snapshot.focusKey;
    this.records.clear();
    for (const saved of snapshot.records) {
      this.records.set(saved.id, {
        node: { ...saved.node },
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
    if (this.rootId !== null && this.records.has(this.rootId)) this.renderTree();
    else if (this.rootError !== null) this.renderRootError();
    else this.renderPlaceholder(this.session.mode === "entry" ? "Select a valid Entry to enable Tree." : "Open Tree to load the document root.");
    this.restoreFocus();
  }

  clear(): void {
    this.generation += 1;
    this.session = null;
    this.rootId = null;
    this.rootLoading = false;
    this.rootError = null;
    this.selectedId = null;
    this.focusKey = null;
    this.records.clear();
    this.onStringSelection(null);
    this.tab.disabled = true;
    this.tab.setAttribute("aria-disabled", "true");
    this.clearInspector();
    this.renderPlaceholder("Open a Document or Collection to load its Tree.");
  }

  activate(): void {
    if (!this.session || this.session.mode === "entry" && this.rootId === null) {
      this.renderPlaceholder("Select a valid Entry to enable Tree.");
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
      if (!node) throw new Error("The tree root response was invalid.");
      this.rootLoading = false;
      this.rootId = node.id;
      this.records.set(node.id, this.newRecord(node, null));
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
      if (!page) throw new Error("The tree children response was invalid.");
      record.loading = false;
      record.loaded = true;
      record.hasMore = page.hasMore;
      record.nextCursor = page.nextCursor;
      for (const node of page.nodes) {
        const child = this.records.get(node.id);
        if (child) {
          child.node = node;
          child.parentId = record.node.id;
        } else {
          this.records.set(node.id, this.newRecord(node, record.node.id));
        }
        record.children.push(node.id);
      }
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
      this.renderTree();
    }
  }

  private toggle(record: NodeRecord): void {
    if (record.node.childCount === 0) return;
    record.expanded = !record.expanded;
    if (record.expanded && !record.loaded && !record.loading) {
      void this.loadChildren(record);
      return;
    }
    this.renderTree();
  }

  private select(record: NodeRecord): void {
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
    const doubleClick = event instanceof MouseEvent && event.detail === 2;
    if (!doubleClick && target.closest(".tree-disclosure") && record.node.childCount > 0) {
      this.focusKey = record.node.id;
      this.toggle(record);
    } else {
      this.select(record);
      if (doubleClick && record.node.kind === "string") {
        const currentItem = this.panel.querySelector<HTMLElement>(`[data-node-id="${record.node.id}"]`);
        this.onStringOpen(this.contentTarget(record), currentItem ?? item);
      }
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest<HTMLElement>("[role=treeitem]");
    if (!item) return;
    if (item.dataset.loadParent || item.dataset.retryParent) {
      const parentId = Number(item.dataset.loadParent ?? item.dataset.retryParent);
      const parent = this.records.get(parentId);
      if (!parent) return;
      const visible = this.visibleItems();
      const index = visible.indexOf(item);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.focusItemKey(visible[index + 1]);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.focusItemKey(visible[index - 1]);
      } else if (event.key === "Home") {
        event.preventDefault();
        this.focusItemKey(visible[0]);
      } else if (event.key === "End") {
        event.preventDefault();
        this.focusItemKey(visible[visible.length - 1]);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.focusItem(parent.node.id);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (item.dataset.retryParent) this.focusKey = parent.node.id;
        void this.loadChildren(parent);
      }
      return;
    }
    const record = this.records.get(Number(item.dataset.nodeId));
    if (!record) return;
    const visible = this.visibleItems();
    const index = visible.indexOf(item);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.focusItemKey(visible[index + 1]);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.focusItemKey(visible[index - 1]);
        break;
      case "Home":
        event.preventDefault();
        this.focusItemKey(visible[0]);
        break;
      case "End":
        event.preventDefault();
        this.focusItemKey(visible[visible.length - 1]);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (record.node.childCount > 0 && !record.expanded) {
          this.toggle(record);
        } else if (record.expanded && record.children.length > 0) {
          this.focusItem(record.children[0]);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (record.expanded) {
          record.expanded = false;
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

  private visibleItems(): HTMLElement[] {
    return Array.from(this.panel.querySelectorAll<HTMLElement>("[role=treeitem]"));
  }

  private focusItem(id: number): void {
    this.focusKey = id;
    this.focusDom(`[data-node-id="${id}"]`);
  }

  private focusItemKey(item: HTMLElement | undefined): void {
    if (!item) return;
    if (item.dataset.nodeId) this.focusKey = Number(item.dataset.nodeId);
    else if (item.dataset.loadParent) this.focusKey = `load:${Number(item.dataset.loadParent)}`;
    else if (item.dataset.retryParent) this.focusKey = `retry:${Number(item.dataset.retryParent)}`;
    else return;
    this.focusDomElement(item);
  }

  private renderTree(): void {
    const shouldRestoreFocus = this.panel.contains(document.activeElement);
    const root = document.createElement("div");
    root.className = "tree-root";
    root.setAttribute("role", "tree");
    root.setAttribute("aria-label", this.session?.ariaLabel ?? "JSON structure");
    root.setAttribute("aria-busy", String(this.rootLoading));
    if (this.rootId === null) {
      this.renderLoading(root);
    } else {
      const record = this.records.get(this.rootId);
      if (record) this.appendRecord(root, record, 1);
    }
    this.panel.replaceChildren(root);
    this.panel.setAttribute("aria-busy", String(this.rootLoading));
    this.renderInspector(this.selectedId === null ? null : this.records.get(this.selectedId)?.node ?? null);
    if (shouldRestoreFocus) this.restoreFocus();
  }

  private appendRecord(parent: HTMLElement, record: NodeRecord, level: number): void {
    parent.append(this.nodeElement(record, level));
    if (!record.expanded) return;
    const group = document.createElement("div");
    group.className = "tree-group";
    group.setAttribute("role", "group");
    for (const childId of record.children) {
      const child = this.records.get(childId);
      if (child) this.appendRecord(group, child, level + 1);
    }
    if (record.loading) {
      const loading = document.createElement("div");
      loading.className = "tree-loading";
      loading.setAttribute("role", "status");
      loading.textContent = "Loading children…";
      group.append(loading);
    }
    if (record.error !== null) {
      const retry = document.createElement("button");
      retry.className = "tree-retry";
      retry.type = "button";
      retry.dataset.retryParent = String(record.node.id);
      retry.setAttribute("role", "treeitem");
      retry.setAttribute("aria-level", String(level + 1));
      retry.tabIndex = this.focusKey === `retry:${record.node.id}` ? 0 : -1;
      retry.setAttribute("aria-label", "Retry loading children");
      retry.textContent = `Retry loading children · ${record.error}`;
      group.append(retry);
    }
    if (record.hasMore && record.nextCursor !== null) {
      const load = document.createElement("button");
      load.className = "tree-load-more";
      load.type = "button";
      load.dataset.loadParent = String(record.node.id);
      load.setAttribute("role", "treeitem");
      load.setAttribute("aria-level", String(level + 1));
      load.tabIndex = this.focusKey === `load:${record.node.id}` ? 0 : -1;
      load.textContent = `Load more children · from ${record.nextCursor}`;
      group.append(load);
    }
    parent.append(group);
  }

  private nodeElement(record: NodeRecord, level: number): HTMLButtonElement {
    const node = record.node;
    const item = document.createElement("button");
    item.className = "tree-item";
    item.type = "button";
    item.dataset.nodeId = String(node.id);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(level));
    item.setAttribute("aria-selected", String(this.selectedId === node.id));
    item.tabIndex = this.focusKey === node.id ? 0 : -1;
    if (node.childCount > 0) item.setAttribute("aria-expanded", String(record.expanded));
    if (record.loading) item.setAttribute("aria-busy", "true");

    const disclosure = document.createElement("span");
    disclosure.className = "tree-disclosure";
    disclosure.textContent = node.childCount > 0 ? record.expanded ? "▾" : "▸" : "·";
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `#${node.id} · ${node.label}`;
    if (node.labelHasMore) label.textContent += " · truncated";
    const kind = document.createElement("span");
    kind.className = "tree-kind";
    kind.textContent = node.kind;
    const span = document.createElement("span");
    span.className = "tree-span";
    span.textContent = `[${node.spanStart}, ${node.spanEnd})`;
    const children = document.createElement("span");
    children.className = "tree-children";
    children.textContent = `children: ${node.childCount}`;
    const value = document.createElement("span");
    value.className = "tree-value";
    value.textContent = node.valuePreview ?? "—";
    if (node.valueHasMore) value.textContent += " · truncated";
    item.append(disclosure, label, kind, span, children, value);
    return item;
  }

  private renderPlaceholder(message: string): void {
    const state = document.createElement("div");
    state.className = "tree-state";
    state.setAttribute("role", "status");
    const strong = document.createElement("strong");
    strong.textContent = "Tree view";
    const copy = document.createElement("span");
    copy.textContent = message;
    state.append(strong, copy);
    this.panel.replaceChildren(state);
    this.panel.removeAttribute("aria-busy");
  }

  private renderLoading(container?: HTMLElement): void {
    const state = document.createElement("div");
    state.className = "tree-state";
    state.setAttribute("role", "status");
    const strong = document.createElement("strong");
    strong.textContent = "Loading tree…";
    state.append(strong);
    if (container) container.replaceChildren(state);
    else this.panel.replaceChildren(state);
    this.panel.setAttribute("aria-busy", "true");
  }

  private renderRootError(): void {
    const state = document.createElement("div");
    state.className = "tree-state";
    state.setAttribute("role", "alert");
    const strong = document.createElement("strong");
    strong.textContent = "Tree could not be loaded";
    const copy = document.createElement("span");
    copy.textContent = this.rootError ?? "Unknown error";
    const retry = document.createElement("button");
    retry.className = "tree-retry";
    retry.type = "button";
    retry.dataset.retryRoot = "true";
    retry.textContent = "Retry";
    state.append(strong, copy, retry);
    this.panel.replaceChildren(state);
    this.panel.removeAttribute("aria-busy");
  }

  private renderInspector(node: NodeDto | null): void {
    if (!this.inspector || !this.fields) return;
    this.inspector.hidden = node === null;
    if (!node) {
      this.clearInspector();
      return;
    }
    this.fields.id.textContent = String(node.id);
    this.fields.label.textContent = node.label + (node.labelHasMore ? " · truncated" : "");
    this.fields.kind.textContent = node.kind;
    this.fields.span.textContent = `[${node.spanStart}, ${node.spanEnd})`;
    this.fields.children.textContent = String(node.childCount);
    this.fields.value.textContent = node.valuePreview ?? "—";
    if (node.valueHasMore) this.fields.value.textContent += " · truncated";
  }

  private clearInspector(): void {
    if (!this.inspector || !this.fields) return;
    this.inspector.hidden = true;
    for (const field of Object.values(this.fields)) field.textContent = "—";
  }

  private restoreFocus(): void {
    if (this.focusKey === null) return;
    const focusKey = this.focusKey;
    queueMicrotask(() => {
      const selector = typeof focusKey === "number"
        ? `[data-node-id="${focusKey}"]`
        : focusKey.startsWith("load:")
          ? `[data-load-parent="${focusKey.slice(5)}"]`
          : `[data-retry-parent="${focusKey.slice(6)}"]`;
      this.panel.querySelector<HTMLElement>(selector)?.focus();
    });
  }

  private focusDom(selector: string): void {
    const item = this.panel.querySelector<HTMLElement>(selector);
    if (item) this.focusDomElement(item);
  }

  private focusDomElement(item: HTMLElement): void {
    for (const other of this.visibleItems()) other.tabIndex = other === item ? 0 : -1;
    item.focus();
  }

  private newRecord(node: NodeDto, parentId: number | null): NodeRecord {
    return {
      node,
      parentId,
      children: [],
      expanded: false,
      loaded: false,
      loading: false,
      hasMore: false,
      nextCursor: null,
      error: null
    };
  }

  private contentTarget(record: NodeRecord): ContentTarget {
    const session = this.session;
    if (!session) throw new Error("Cannot build a Content Viewer target without a Tree session.");
    const pathSegments: string[] = [];
    let current: NodeRecord | undefined = record;
    let pathTruncated = false;
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

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return message;
  }
  if (error instanceof Error) return error.message;
  return "The tree request failed.";
}

const TREE_KINDS = new Set(["object", "array", "string", "number", "true", "false", "null"]);

function validateNodeDto(value: unknown, sourceSize: number): NodeDto | undefined {
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

function validateNodePage(
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
