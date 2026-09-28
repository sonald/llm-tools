import { validateNodePage, type NodeDto } from "./tree-view";
import { t } from "./i18n";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

type Session = {
  revision: number;
  sourceSize: number;
  scopeId: number | null;
};

export class DocumentOutline {
  private session: Session | null = null;
  private root: NodeDto | null = null;
  private generation = 0;
  private readonly children = new Map<number, { nodes: NodeDto[]; nextCursor: number | null; loading: boolean }>();
  private readonly expanded = new Set<number>();
  private focusId: number | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly invoke: Invoke,
    private readonly onFocus: (node: NodeDto, path: string) => void,
    private readonly onError: (error: unknown) => void
  ) {
    host.addEventListener("click", (event) => this.handleClick(event));
  }

  setRoot(session: Session | null, root: NodeDto | null): void {
    const key = session && root ? `${session.revision}:${session.sourceSize}:${root.id}:${root.kind}:${root.spanStart}:${root.spanEnd}:${root.childCount}` : "";
    const current = this.session && this.root
      ? `${this.session.revision}:${this.session.sourceSize}:${this.root.id}:${this.root.kind}:${this.root.spanStart}:${this.root.spanEnd}:${this.root.childCount}`
      : "";
    if (key === current) return;
    this.generation += 1;
    this.session = session;
    this.root = root;
    this.children.clear();
    this.expanded.clear();
    this.focusId = root?.id ?? null;
    if (root) this.expanded.add(root.id);
    this.render();
    if (root && (root.kind === "object" || root.kind === "array") && root.childCount > 0) {
      void this.load(root, this.generation);
    }
  }

  focus(nodeId: number): void {
    this.focusId = nodeId;
    this.render();
  }

  private async load(node: NodeDto, generation: number, cursor = 0): Promise<void> {
    const session = this.session;
    const previous = this.children.get(node.id);
    if (!session || cursor === 0 && previous || previous?.loading) return;
    if (previous) previous.loading = true;
    try {
      const value = await this.invoke<unknown>("get_children", {
        nodeId: node.id,
        cursor,
        limit: 200,
        sessionRevision: session.revision,
        scopeId: session.scopeId
      });
      if (generation !== this.generation) return;
      const page = validateNodePage(value, cursor, node.childCount, session.sourceSize, previous?.nodes.map((child) => child.id) ?? []);
      if (!page) throw new Error(t("reader.childrenInvalid"));
      this.children.set(node.id, { nodes: [...(previous?.nodes ?? []), ...page.nodes], nextCursor: page.nextCursor, loading: false });
      this.render();
    } catch (error) {
      if (generation !== this.generation) return;
      if (previous) previous.loading = false;
      this.onError(error);
    }
  }

  private render(): void {
    const root = this.root;
    if (!root) {
      this.host.hidden = true;
      this.host.replaceChildren();
      return;
    }
    this.host.hidden = false;
    const bodyId = "document-outline-body";
    let body = this.host.querySelector<HTMLElement>(`#${bodyId}`);
    if (!body) {
      const title = document.createElement("h3");
      title.id = "document-outline-title";
      title.textContent = t("reader.outlineTitle");
      body = document.createElement("div");
      body.id = bodyId;
      this.host.replaceChildren(title, body);
    }
    body.replaceChildren(this.row(root, "$", 0));
  }

  private row(node: NodeDto, path: string, depth: number): HTMLElement {
    const item = document.createElement("div");
    item.className = "outline-row";
    item.style.setProperty("--outline-depth", String(depth));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "outline-node";
    button.dataset.outlineId = String(node.id);
    button.dataset.path = path;
    button.setAttribute("aria-current", this.focusId === node.id ? "true" : "false");
    const name = node.label === "$" ? (node.kind === "array" ? t("reader.rootArray") : node.kind === "object" ? t("reader.rootObject") : scalarOutline(node)) : node.label;
    button.textContent = node.kind === "object" || node.kind === "array"
      ? `${name} · ${t(node.kind === "array" ? "reader.arrayCount" : "reader.objectCount", { count: node.childCount })}`
      : `${name} · ${scalarOutline(node)}`;
    item.append(button);
    if ((node.kind === "object" || node.kind === "array") && node.childCount > 0) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "outline-expand";
      toggle.dataset.outlineExpand = String(node.id);
      toggle.textContent = this.expanded.has(node.id) ? t("reader.outlineCollapse") : t("reader.outlineDeeper");
      item.append(toggle);
      if (this.expanded.has(node.id)) {
        const kids = this.children.get(node.id);
        if (kids) {
          for (const child of kids.nodes) item.append(this.row(child, childPath(path, child.label), depth + 1));
          if (kids.nextCursor !== null) {
            const more = document.createElement("button");
            more.type = "button";
            more.dataset.outlineMore = String(node.id);
            more.textContent = t("tree.loadMoreChildren", { cursor: kids.nextCursor });
            more.disabled = kids.loading;
            item.append(more);
          }
        }
      }
    }
    return item;
  }

  private handleClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const more = target.closest<HTMLButtonElement>("[data-outline-more]");
    if (more) {
      const id = Number(more.dataset.outlineMore);
      const node = this.find(id);
      const cursor = this.children.get(id)?.nextCursor;
      if (node && cursor !== null && cursor !== undefined) void this.load(node, this.generation, cursor);
      return;
    }
    const expand = target.closest<HTMLButtonElement>("[data-outline-expand]");
    if (expand) {
      const id = Number(expand.dataset.outlineExpand);
      const node = this.find(id);
      if (!node) return;
      if (this.expanded.has(id)) this.expanded.delete(id);
      else {
        this.expanded.add(id);
        void this.load(node, this.generation);
      }
      this.render();
      return;
    }
    const button = target.closest<HTMLButtonElement>("[data-outline-id]");
    if (!button) return;
    const node = this.find(Number(button.dataset.outlineId));
    if (!node) return;
    this.focusId = node.id;
    this.render();
    this.onFocus(node, button.dataset.path ?? "$");
  }

  private find(id: number): NodeDto | null {
    if (this.root?.id === id) return this.root;
    for (const page of this.children.values()) {
      const found = page.nodes.find((node) => node.id === id);
      if (found) return found;
    }
    return null;
  }
}

function scalarOutline(node: NodeDto): string {
  if (node.kind === "string") return node.valuePreview && node.valuePreview.length > 0 ? node.valuePreview : t("reader.emptyString");
  if (node.kind === "null") return t("reader.valueNull");
  if (node.kind === "false") return t("reader.valueFalse");
  if (node.kind === "true") return t("reader.valueTrue");
  if (node.kind === "number") return node.valuePreview ?? "0";
  return node.kind;
}

function childPath(parent: string, label: string): string {
  if (label.startsWith("[")) return `${parent}${label}`;
  return parent === "$" ? `$.${label}` : `${parent}.${label}`;
}
