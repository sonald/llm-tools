import { validateNodePage, type NodeDto } from "./tree-view";
import { t } from "./i18n";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

type Session = {
  revision: number;
  sourceSize: number;
  scopeId: number | null;
};

export type GenericReaderOptions = {
  host: HTMLElement;
  invoke: Invoke;
  onFocus: (node: NodeDto, path: string) => void;
  onReadAlone: (node: NodeDto, path: string) => void;
  onViewRaw: (node: NodeDto, path: string) => void;
  onExpand: (node: NodeDto, path: string, opener: HTMLElement) => void;
  onCopy: (node: NodeDto, path: string, format: "raw" | "decoded") => Promise<void>;
  onReadMessages: (node: NodeDto, path: string) => void;
  onError: (error: unknown) => void;
};

type ChildState = {
  nodes: NodeDto[];
  expanded: boolean;
  nextCursor: number | null;
  loading: boolean;
};

export class GenericReader {
  private session: Session | null = null;
  private root: NodeDto | null = null;
  private rootPath = "$";
  private generation = 0;
  private readonly children = new Map<number, ChildState>();
  private focusId: number | null = null;
  private status = "";
  private readonly loaded = new Set<number>();

  constructor(private readonly options: GenericReaderOptions) {
    options.host.addEventListener("click", (event) => this.handleClick(event));
    options.host.addEventListener("keydown", (event) => this.handleKeydown(event));
  }

  setRoot(session: Session | null, root: NodeDto | null, path: string): void {
    const key = session && root ? `${session.revision}:${session.sourceSize}:${root.id}:${root.kind}:${root.spanStart}:${root.spanEnd}:${root.childCount}:${path}` : "";
    const current = this.session && this.root
      ? `${this.session.revision}:${this.session.sourceSize}:${this.root.id}:${this.root.kind}:${this.root.spanStart}:${this.root.spanEnd}:${this.root.childCount}:${this.rootPath}`
      : "";
    if (key === current) return;
    this.generation += 1;
    this.session = session;
    this.root = root;
    this.rootPath = path || "$";
    this.children.clear();
    this.loaded.clear();
    this.focusId = root?.id ?? null;
    this.status = "";
    this.render();
    if (root && (root.kind === "object" || root.kind === "array") && root.childCount > 0) {
      void this.loadChildren(root, this.generation);
    }
  }

  focus(nodeId: number): void {
    this.focusId = nodeId;
    this.render();
    this.options.host.querySelector<HTMLElement>(`[data-field-id="${nodeId}"]`)?.focus();
  }

  expandedIds(): number[] {
    return [...this.children.entries()].filter(([, state]) => state.expanded).map(([id]) => id);
  }

  scrollAnchor(): string | null {
    return this.focusId === null ? null : String(this.focusId);
  }

  async restore(session: Session, root: NodeDto, path: string, expanded: number[], anchor: string | null): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.session = session;
    this.root = root;
    this.rootPath = path || "$";
    this.children.clear();
    this.loaded.clear();
    this.focusId = anchor && /^\d+$/.test(anchor) ? Number(anchor) : root.id;
    this.status = "";
    this.render();
    if (root.kind === "object" || root.kind === "array") await this.loadChildren(root, generation);
    for (const id of expanded) {
      if (generation !== this.generation) return;
      const node = this.findLoaded(id);
      if (node && (node.kind === "object" || node.kind === "array")) {
        const state = this.children.get(id);
        if (state) state.expanded = true;
        else this.children.set(id, { nodes: [], expanded: true, nextCursor: null, loading: false });
        await this.loadChildren(node, generation);
      }
    }
    if (generation !== this.generation) return;
    this.render();
    if (this.focusId !== null) this.options.host.querySelector<HTMLElement>(`[data-field-id="${this.focusId}"]`)?.focus();
  }

  setStatus(message: string): void {
    this.status = message;
    const slot = this.options.host.querySelector<HTMLElement>("[data-reader-status]");
    if (slot) slot.textContent = message;
  }

  private findLoaded(id: number): NodeDto | null {
    if (this.root?.id === id) return this.root;
    for (const state of this.children.values()) {
      const found = state.nodes.find((node) => node.id === id);
      if (found) return found;
    }
    return null;
  }

  private async loadChildren(node: NodeDto, generation: number, cursor = 0): Promise<void> {
    const session = this.session;
    const previous = this.children.get(node.id);
    if (!session || cursor === 0 && this.loaded.has(node.id) || previous?.loading) return;
    if (cursor === 0) this.loaded.add(node.id);
    if (previous) previous.loading = true;
    try {
      const value = await this.options.invoke<unknown>("get_children", {
        nodeId: node.id,
        cursor,
        limit: 200,
        sessionRevision: session.revision,
        scopeId: session.scopeId
      });
      if (generation !== this.generation) return;
      const page = validateNodePage(value, cursor, node.childCount, session.sourceSize, previous?.nodes.map((child) => child.id) ?? []);
      if (!page) throw new Error(t("reader.childrenInvalid"));
      this.children.set(node.id, {
        nodes: [...(previous?.nodes ?? []), ...page.nodes],
        expanded: previous?.expanded ?? node.id === this.root?.id,
        nextCursor: page.nextCursor,
        loading: false
      });
      this.render();
    } catch (error) {
      if (generation !== this.generation) return;
      if (previous) previous.loading = false;
      else this.loaded.delete(node.id);
      this.options.onError(error);
    }
  }

  private render(): void {
    const host = this.options.host;
    const root = this.root;
    if (!root || !this.session) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    host.hidden = false;
    const shell = document.createElement("div");
    shell.className = "generic-reader";
    shell.dataset.readingRoot = String(root.id);
    const status = document.createElement("p");
    status.className = "generic-reader-status";
    status.dataset.readerStatus = "true";
    status.setAttribute("role", "status");
    status.textContent = this.status;
    shell.append(status);
    shell.append(this.renderNode(root, this.rootPath, 0));
    host.replaceChildren(shell);
  }

  private renderNode(node: NodeDto, path: string, depth: number): HTMLElement {
    const article = document.createElement("article");
    article.className = "generic-node";
    article.dataset.path = path;
    article.style.setProperty("--reader-depth", String(depth));
    if (node.kind === "object" || node.kind === "array") {
      article.append(this.containerBody(node, path, depth));
    } else {
      article.append(this.scalarBody(node, path));
    }
    return article;
  }

  private containerBody(node: NodeDto, path: string, depth: number): HTMLElement {
    const block = document.createElement("div");
    block.className = "generic-container";
    const heading = this.fieldButton(node, path, containerHeading(node));
    block.append(heading);
    if (node.childCount === 0) {
      const empty = document.createElement("p");
      empty.className = "generic-empty";
      empty.textContent = node.kind === "array" ? t("reader.emptyArray") : t("reader.emptyObject");
      block.append(empty);
    } else {
      const state = this.children.get(node.id);
      const list = document.createElement("div");
      list.className = "generic-children";
      if (!state) {
        const waiting = document.createElement("p");
        waiting.className = "generic-meta";
        waiting.textContent = t("reader.loadingFields");
        list.append(waiting);
      } else if (state.expanded) {
        for (const child of state.nodes) {
          list.append(this.renderNode(child, childPath(path, child.label), depth + 1));
        }
        if (state.nextCursor !== null) {
          const more = this.action(t("tree.loadMoreChildren", { cursor: state.nextCursor }), "load-more", node, path);
          more.disabled = state.loading;
          list.append(more);
        }
      }
      block.append(list);
    }
    block.append(this.actions(node, path, depth));
    return block;
  }

  private scalarBody(node: NodeDto, path: string): HTMLElement {
    const block = document.createElement("div");
    block.className = "generic-scalar";
    block.append(this.fieldButton(node, path, node.label === "$" ? t("reader.rootValueName") : node.label));
    const value = document.createElement("p");
    value.className = "generic-value";
    value.dataset.kind = node.kind;
    value.textContent = scalarText(node);
    block.append(value);
    if (node.kind === "string" && node.valueHasMore) {
      const limit = document.createElement("p");
      limit.className = "generic-meta";
      limit.textContent = t("reader.previewTruncated");
      block.append(limit);
    }
    block.append(this.actions(node, path, 1));
    return block;
  }

  private fieldButton(node: NodeDto, path: string, label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "generic-field-name";
    button.dataset.fieldId = String(node.id);
    button.dataset.action = "focus";
    button.dataset.path = path;
    button.tabIndex = this.focusId === node.id || this.focusId === null && node.id === this.root?.id ? 0 : -1;
    button.setAttribute("aria-current", this.focusId === node.id ? "true" : "false");
    const name = document.createElement("span");
    name.textContent = label;
    const meta = document.createElement("span");
    meta.className = "generic-meta";
    meta.textContent = node.kind === "object" || node.kind === "array"
      ? t(node.kind === "array" ? "reader.arrayCount" : "reader.objectCount", { count: node.childCount })
      : kindName(node.kind);
    button.append(name, meta);
    return button;
  }

  private actions(node: NodeDto, path: string, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "generic-actions";
    if (depth > 0 && (node.kind === "object" || node.kind === "array") && node.childCount > 0) {
      const open = this.children.get(node.id)?.expanded === true;
      row.append(this.action(open ? t("reader.outlineCollapse") : t("reader.outlineDeeper"), "expand-node", node, path));
    }
    if (offersExpand(node)) row.append(this.action(t("reader.expandReading"), "expand", node, path));
    row.append(this.action(node.kind === "string" ? t("reader.copyTextAction") : t("reader.copyRawAction"), "copy-default", node, path));
    const more = document.createElement("details");
    more.className = "generic-more";
    const summary = document.createElement("summary");
    summary.textContent = t("reader.moreActions");
    more.append(summary);
    if (node.kind === "string") more.append(this.action(t("reader.copyRawAction"), "copy-raw", node, path));
    else if (node.kind !== "object" && node.kind !== "array") more.append(this.action(t("reader.copyTextAction"), "copy-text", node, path));
    more.append(this.action(t("reader.readFieldRaw"), "view-raw", node, path));
    more.append(this.action(t("reader.readFieldAlone"), "read-alone", node, path));
    if (node.kind === "array") more.append(this.action(t("reader.readAsMessages"), "messages", node, path));
    row.append(more);
    return row;
  }

  private action(label: string, action: string, node: NodeDto, path: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button generic-action";
    button.dataset.action = action;
    button.dataset.fieldId = String(node.id);
    button.dataset.path = path;
    button.textContent = label;
    return button;
  }

  private handleClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-action]");
    if (!button || !this.options.host.contains(button)) return;
    const node = this.findLoaded(Number(button.dataset.fieldId));
    const path = button.dataset.path ?? this.rootPath;
    if (!node) return;
    const action = button.dataset.action;
    if (action === "focus") {
      this.focusId = node.id;
      this.render();
      this.options.onFocus(node, path);
      return;
    }
    if (action === "expand-node") {
      const current = this.children.get(node.id) ?? { nodes: [], expanded: false, nextCursor: null, loading: false };
      current.expanded = !current.expanded;
      this.children.set(node.id, current);
      this.render();
      if (current.expanded) void this.loadChildren(node, this.generation);
      return;
    }
    if (action === "load-more") {
      const cursor = this.children.get(node.id)?.nextCursor;
      if (cursor !== null && cursor !== undefined) void this.loadChildren(node, this.generation, cursor);
      return;
    }
    if (action === "expand") this.options.onExpand(node, path, button);
    else if (action === "copy-default") void this.options.onCopy(node, path, node.kind === "string" ? "decoded" : "raw");
    else if (action === "copy-text") void this.options.onCopy(node, path, "decoded");
    else if (action === "copy-raw") void this.options.onCopy(node, path, "raw");
    else if (action === "view-raw") this.options.onViewRaw(node, path);
    else if (action === "read-alone") this.options.onReadAlone(node, path);
    else if (action === "messages") this.options.onReadMessages(node, path);
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const names = [...this.options.host.querySelectorAll<HTMLButtonElement>(".generic-field-name")];
    const index = names.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = names[index + (event.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
    next?.click();
  }
}

function containerHeading(node: NodeDto): string {
  if (node.label === "$") return node.kind === "array" ? t("reader.rootArray") : t("reader.rootObject");
  return node.label;
}

function scalarText(node: NodeDto): string {
  if (node.kind === "string") {
    return node.valuePreview && node.valuePreview.length > 0 ? node.valuePreview : t("reader.emptyString");
  }
  if (node.kind === "null") return t("reader.valueNull");
  if (node.kind === "false") return t("reader.valueFalse");
  if (node.kind === "true") return t("reader.valueTrue");
  if (node.kind === "number") return node.valuePreview ?? t("reader.valueNumber");
  return node.valuePreview ?? "";
}

function kindName(kind: string): string {
  if (kind === "string") return t("jsonKind.string");
  if (kind === "number") return t("jsonKind.number");
  if (kind === "true") return t("jsonKind.true");
  if (kind === "false") return t("jsonKind.false");
  if (kind === "null") return t("jsonKind.null");
  return kind;
}

function offersExpand(node: NodeDto): boolean {
  if (node.kind !== "string") return false;
  const preview = node.valuePreview ?? "";
  return node.valueHasMore || preview.length >= 80 || preview.includes("\n") || preview.includes("```") || preview.startsWith("#") || /^\s*</.test(preview);
}

function childPath(parent: string, label: string): string {
  if (label.startsWith("[")) return `${parent}${label}`;
  return parent === "$" ? `$.${label}` : `${parent}.${label}`;
}
