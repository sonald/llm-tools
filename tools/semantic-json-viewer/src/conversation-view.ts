import { invoke } from "@tauri-apps/api/core";
import type { ContentTarget } from "./content-viewer";
import type { NodeDto } from "./tree-view";

export type ConversationStyle = "generic" | "openai" | "anthropic";
export type ConversationFileMode = "document" | "collection" | "entry";

export type ConversationContext = {
  mode: ConversationFileMode;
  sessionRevision: number;
  sourceSize: number;
  scopeRoot: NodeDto;
  scopeLabel: string;
};

type ConversationCandidateKind = "none" | "possible" | "generic" | "openai" | "anthropic" | "mixed";

type Candidate = {
  node: NodeDto;
  kind: ConversationCandidateKind;
  messageCount: number;
};

type SourceRef = {
  nodeId: number;
  spanStart: number;
  spanEnd: number;
};

type OpenAiRefs = {
  block: SourceRef | null;
  text: SourceRef | null;
  image: SourceRef | null;
  callId: SourceRef | null;
  function: SourceRef | null;
  name: SourceRef | null;
  arguments: SourceRef | null;
};

type AnthropicRefs = {
  block: SourceRef | null;
  text: SourceRef | null;
  thinking: SourceRef | null;
  data: SourceRef | null;
  id: SourceRef | null;
  name: SourceRef | null;
  input: SourceRef | null;
  toolUseId: SourceRef | null;
  content: SourceRef | null;
};

type ConversationBlock = {
  kind: "message" | "source" | "system";
  message: SourceRef | null;
  source: SourceRef | null;
  field: SourceRef | null;
  category: string;
  role: string;
  roleSource: SourceRef | null;
  openaiRefs: OpenAiRefs | null;
  anthropicRefs: AnthropicRefs | null;
};

type Cursor = {
  kind: "genericConversation";
  style: ConversationStyle;
  scopeRootId: number;
  candidateNodeId: number;
  messageIndex: number;
  phase: "message" | "fields" | "systemHeader" | "systemContent";
  fieldIndex: number;
  elementIndex: number;
  sessionRevision: number;
};

type WrapperRef = {
  scopeRootId: number;
  scopeRootSpanStart: number;
  scopeRootSpanEnd: number;
  candidateNodeId: number;
  candidateSpanStart: number;
  candidateSpanEnd: number;
};

type Page = {
  blocks: ConversationBlock[];
  hasMore: boolean;
  nextCursor: Cursor | null;
  wrapperRef: WrapperRef;
  pageStart: Cursor | null;
};

type ConversationSourceTarget = {
  ref: SourceRef;
  label: string;
};

type ConversationViewOptions = {
  panel: HTMLElement;
  invoke?: typeof invoke;
  onError: (error: unknown) => void;
  onRaw: (target: ConversationSourceTarget, opener: HTMLElement) => void;
  onTree: (target: ConversationSourceTarget, opener: HTMLElement) => void;
  onContent: (target: ContentTarget, opener: HTMLElement) => void;
};

type FocusIntent = {
  kind: "block" | "action" | "style" | "candidate";
  blockIndex?: number;
  action?: string;
  refKey?: string;
  candidateId?: number;
};

const CANDIDATE_FIELDS = new Set(["messages", "conversation", "conversations"]);
const BLOCK_KINDS = new Set(["message", "source", "system"]);
const MAX_CHILD_PAGES = 16;
const PAGE_LIMIT = 100;
// Cards use a fixed height in CSS so the spacer math remains stable while
// only the visible window plus 20 rows on each side is materialized.
const ROW_HEIGHT = 136;

export class ConversationView {
  private readonly panel: HTMLElement;
  private readonly invokeRequest: typeof invoke;
  private readonly onError: (error: unknown) => void;
  private readonly onRaw: (target: ConversationSourceTarget, opener: HTMLElement) => void;
  private readonly onTree: (target: ConversationSourceTarget, opener: HTMLElement) => void;
  private readonly onContent: (target: ContentTarget, opener: HTMLElement) => void;
  private context: ConversationContext | null = null;
  private contextKey: string | null = null;
  private candidates: Candidate[] = [];
  private candidateScanCursor: number | null = null;
  private selectedCandidate: Candidate | null = null;
  private style: ConversationStyle = "generic";
  private possibleConfirmed = false;
  private page: Page | null = null;
  private previousPages: Array<Cursor | null> = [];
  private loading = false;
  private statusMessage = "";
  private generation = 0;
  private requestGeneration = 0;
  private blockViewport: HTMLElement | null = null;
  private windowPageIdentity: string | null = null;
  private windowStart = -1;
  private windowEnd = -1;
  private windowTopSpacer: HTMLElement | null = null;
  private windowList: HTMLElement | null = null;
  private windowBottomSpacer: HTMLElement | null = null;
  private readonly blockSummaries = new Map<number, string>();
  private readonly summaryRequests = new Set<string>();

  constructor(options: ConversationViewOptions) {
    this.panel = options.panel;
    this.invokeRequest = options.invoke ?? invoke;
    this.onError = options.onError;
    this.onRaw = options.onRaw;
    this.onTree = options.onTree;
    this.onContent = options.onContent;
    this.panel.addEventListener("click", (event) => this.handleClick(event));
    this.panel.addEventListener("change", (event) => this.handleChange(event));
    this.panel.addEventListener("scroll", (event) => {
      if (event.target === this.blockViewport) this.renderBlocks();
    }, true);
    this.clear();
  }

  hasScope(): boolean {
    return this.context !== null && !this.panel.hidden;
  }

  setContext(context: ConversationContext | null): void {
    const nextKey = context ? contextKey(context) : null;
    if (nextKey === this.contextKey) return;
    this.context = context;
    this.contextKey = nextKey;
    this.generation += 1;
    this.requestGeneration += 1;
    this.candidates = [];
    this.candidateScanCursor = context?.scopeRoot.kind === "object" ? 0 : null;
    this.selectedCandidate = null;
    this.style = "generic";
    this.possibleConfirmed = false;
    this.page = null;
    this.previousPages = [];
    this.loading = context !== null;
    this.statusMessage = context ? "Finding direct conversation candidates…" : "";
    this.blockViewport = null;
    this.resetWindowElements();
    this.blockSummaries.clear();
    this.summaryRequests.clear();
    this.render();
    if (context) void this.discoverCandidates(context, this.generation);
  }

  clear(): void {
    this.context = null;
    this.contextKey = null;
    this.generation += 1;
    this.requestGeneration += 1;
    this.candidates = [];
    this.candidateScanCursor = null;
    this.selectedCandidate = null;
    this.page = null;
    this.previousPages = [];
    this.loading = false;
    this.statusMessage = "";
    this.blockViewport = null;
    this.resetWindowElements();
    this.blockSummaries.clear();
    this.summaryRequests.clear();
    this.panel.hidden = true;
    this.panel.replaceChildren();
  }

  private async discoverCandidates(context: ConversationContext, generation: number, startCursor = 0): Promise<void> {
    try {
      this.loading = true;
      this.statusMessage = startCursor > 0 ? "Scanning more direct Conversation fields…" : "Finding direct conversation candidates…";
      this.render();
      const scan = context.scopeRoot.kind === "array"
        ? { nodes: [context.scopeRoot], nextCursor: null }
        : context.scopeRoot.kind === "object"
          ? await this.directCandidateNodes(context, generation, startCursor)
          : { nodes: [], nextCursor: null };
      if (!this.isCurrent(context, generation)) return;
      const candidates = this.candidates.slice();
      for (const node of scan.nodes) {
        if (candidates.some((candidate) => candidate.node.id === node.id)) continue;
        const candidate = await this.readCandidate(context, node, generation);
        if (candidate && candidate.kind !== "none") candidates.push(candidate);
      }
      if (!this.isCurrent(context, generation)) return;
      this.loading = false;
      this.candidateScanCursor = scan.nextCursor;
      this.candidates = candidates;
      this.statusMessage = scan.nextCursor !== null
        ? "More direct fields are available; scan them before automatic selection."
        : candidates.length === 0
          ? "No supported direct Conversation candidate in this scope. Tree remains available."
          : "";
      if (scan.nextCursor === null && candidates.length === 1 && candidates[0].kind !== "possible") {
        this.selectCandidate(candidates[0], false);
      } else {
        this.render();
      }
    } catch (error) {
      if (!this.isCurrent(context, generation)) return;
      this.loading = false;
      if (isSessionError(error)) {
        this.onError(error);
      } else {
        this.statusMessage = errorMessage(error);
        this.render();
      }
    }
  }

  private async directCandidateNodes(context: ConversationContext, generation: number, startCursor: number): Promise<{ nodes: NodeDto[]; nextCursor: number | null }> {
    const nodes: NodeDto[] = [];
    let cursor = startCursor;
    for (let pageIndex = 0; pageIndex < MAX_CHILD_PAGES; pageIndex += 1) {
      const value = await this.invokeRequest<unknown>("get_children", {
        nodeId: context.scopeRoot.id,
        cursor,
        limit: 200,
        sessionRevision: context.sessionRevision,
        scopeId: null
      });
      if (!this.isCurrent(context, generation)) return { nodes: [], nextCursor: null };
      const page = validateChildrenPage(value, cursor, context.sourceSize);
      if (!page) throw new Error("The direct Conversation candidate response was invalid.");
      for (const node of page.nodes) {
        if (node.kind === "array" && isCandidateField(node.label)) nodes.push(node);
      }
      if (!page.hasMore) return { nodes, nextCursor: null };
      if (page.nextCursor === null || page.nextCursor <= cursor) return { nodes, nextCursor: null };
      cursor = page.nextCursor;
    }
    return { nodes, nextCursor: cursor };
  }

  private async readCandidate(context: ConversationContext, node: NodeDto, generation: number): Promise<Candidate | null> {
    let value: unknown;
    try {
      value = await this.invokeRequest<unknown>("get_conversation_candidate", {
        scopeRootId: context.scopeRoot.id,
        candidateNodeId: node.id,
        scopeId: null,
        sessionRevision: context.sessionRevision
      });
    } catch (error) {
      // A literal key such as "messages#2" may be a non-candidate key. Let
      // the backend reject only that occurrence while keeping other direct
      // candidates discoverable.
      if (isInvalidRequest(error)) return null;
      throw error;
    }
    if (!this.isCurrent(context, generation)) return null;
    const candidate = validateCandidate(value, node, context);
    if (!candidate) throw new Error("The Conversation candidate response was invalid.");
    return candidate;
  }

  private selectCandidate(candidate: Candidate, confirmPossible: boolean): void {
    this.selectedCandidate = candidate;
    this.possibleConfirmed = confirmPossible;
    this.style = candidate.kind === "openai" ? "openai" : candidate.kind === "anthropic" ? "anthropic" : "generic";
    this.page = null;
    this.previousPages = [];
    this.requestGeneration += 1;
    this.loading = false;
    this.statusMessage = candidate.kind === "possible" && !confirmPossible
      ? "This is a Possible Conversation. Confirm before rendering blocks."
      : "";
    this.render();
    if (candidate.kind !== "possible" || confirmPossible) void this.loadPage(null, "initial");
  }

  private async loadPage(cursor: Cursor | null, direction: "initial" | "next" | "previous"): Promise<void> {
    const context = this.context;
    const candidate = this.selectedCandidate;
    if (!context || !candidate || candidate.kind === "none" || candidate.kind === "possible" && !this.possibleConfirmed || this.loading) return;
    const requestGeneration = ++this.requestGeneration;
    const generation = this.generation;
    this.loading = true;
    this.statusMessage = cursor ? "Loading Conversation blocks…" : "Loading Conversation blocks…";
    this.render();
    try {
      const value = await this.invokeRequest<unknown>("get_conversation_blocks", {
        scopeRootId: context.scopeRoot.id,
        candidateNodeId: candidate.node.id,
        style: this.style,
        cursor,
        limit: PAGE_LIMIT,
        sessionRevision: context.sessionRevision,
        scopeId: null
      });
      if (!this.isCurrentRequest(context, generation, requestGeneration)) return;
      const page = validatePage(value, context, candidate, this.style, cursor);
      if (!page) throw new Error("The Conversation blocks response was invalid.");
      if (direction === "previous") {
        this.previousPages = this.previousPages.slice(0, -1);
      } else if (direction === "next") {
        this.previousPages.push(this.page?.pageStart ?? null);
      }
      this.page = { ...page, pageStart: cursor };
      this.blockSummaries.clear();
      this.summaryRequests.clear();
      this.loading = false;
      this.statusMessage = page.blocks.length === 0 && page.hasMore
        ? "This page contains no blocks; continue to scan the wrapper."
        : page.blocks.length === 0
          ? "No Conversation blocks were found."
          : "";
      this.render();
    } catch (error) {
      if (!this.isCurrentRequest(context, generation, requestGeneration)) return;
      this.loading = false;
      if (isSessionError(error)) {
        this.onError(error);
      } else {
        this.statusMessage = errorMessage(error);
        this.render();
      }
    }
  }

  private handleClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const candidateButton = target.closest<HTMLButtonElement>("[data-conversation-candidate]");
    if (candidateButton) {
      const candidate = this.candidates.find((item) => item.node.id === Number(candidateButton.dataset.conversationCandidate));
      if (candidate) {
        this.selectCandidate(candidate, false);
        candidateButton.focus();
      }
      return;
    }
    const actionElement = target.closest<HTMLElement>("[data-conversation-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.conversationAction;
    if (action === "confirm") {
      if (this.selectedCandidate?.kind === "possible") this.selectCandidate(this.selectedCandidate, true);
      return;
    }
    if (action === "scan-more" && this.context && this.candidateScanCursor !== null && !this.loading) {
      void this.discoverCandidates(this.context, this.generation, this.candidateScanCursor);
      return;
    }
    if (action === "choose-candidate") {
      this.selectedCandidate = null;
      this.page = null;
      this.previousPages = [];
      this.possibleConfirmed = false;
      this.requestGeneration += 1;
      this.loading = false;
      this.render();
      return;
    }
    if (action === "next" && this.page?.nextCursor) {
      void this.loadPage(this.page.nextCursor, "next");
      return;
    }
    if (action === "previous" && this.previousPages.length > 0) {
      const cursor = this.previousPages[this.previousPages.length - 1] ?? null;
      void this.loadPage(cursor, "previous");
      return;
    }
    if (action === "wrapper-raw" && this.page) {
      this.onRaw(this.wrapperTarget(), actionElement);
      return;
    }
    if (action === "wrapper-tree" && this.page) {
      this.onTree(this.wrapperTarget(), actionElement);
      return;
    }
    if (action === "raw" || action === "tree" || action === "content" || action === "role") {
      const index = numberFromDataset(actionElement.dataset.conversationBlockIndex);
      const block = index === null ? null : this.page?.blocks[index] ?? null;
      if (!block) return;
      const source = actionElement.dataset.conversationRefKey
        ? this.specializedRef(block, actionElement.dataset.conversationRefKey)
        : this.sourceFor(block, action);
      if (!source) return;
      const targetInfo = { ref: source, label: this.sourceLabel(block, action) };
      if (action === "raw" || action === "role") this.onRaw(targetInfo, actionElement);
      else if (action === "tree") this.onTree(targetInfo, actionElement);
      else void this.openContentIfString(source, block, actionElement);
    }
  }

  private handleChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.conversationStyle === undefined) return;
    const style = target.value;
    if (style !== "generic" && style !== "openai" && style !== "anthropic") return;
    if (style === this.style) return;
    this.style = style;
    this.requestGeneration += 1;
    this.loading = false;
    this.page = null;
    this.previousPages = [];
    this.statusMessage = "Style changed; restarting from the first Conversation block page.";
    this.render();
    void this.loadPage(null, "initial");
  }

  private wrapperTarget(): ConversationSourceTarget {
    const context = this.context;
    const candidate = this.selectedCandidate;
    if (!context || !candidate) throw new Error("Conversation wrapper is unavailable.");
    return {
      ref: { nodeId: context.scopeRoot.id, spanStart: context.scopeRoot.spanStart, spanEnd: context.scopeRoot.spanEnd },
      label: `${context.scopeLabel} Conversation wrapper`
    };
  }

  private sourceFor(block: ConversationBlock, action: string): SourceRef | null {
    if (action === "role" && block.roleSource) return block.roleSource;
    if (action === "content") {
      const anthropic = block.anthropicRefs;
      const openai = block.openaiRefs;
      return anthropic?.text ?? anthropic?.thinking ?? anthropic?.data ?? anthropic?.content
        ?? openai?.text ?? openai?.arguments ?? block.source ?? block.field ?? block.message;
    }
    return block.source ?? block.field ?? block.message ?? block.roleSource
      ?? block.anthropicRefs?.block ?? block.openaiRefs?.block ?? null;
  }

  private specializedRef(block: ConversationBlock, name: string): SourceRef | null {
    const anthropic = block.anthropicRefs as Record<string, SourceRef | null> | null;
    const openai = block.openaiRefs as Record<string, SourceRef | null> | null;
    return anthropic?.[name] ?? openai?.[name] ?? null;
  }

  private contentTarget(source: SourceRef): ContentTarget {
    const context = this.context;
    if (!context) throw new Error("Conversation content is unavailable.");
    return {
      revision: context.sessionRevision,
      nodeId: source.nodeId,
      spanStart: source.spanStart,
      spanEnd: source.spanEnd,
      scopeId: null,
      scopeLabel: context.scopeLabel,
      pathSegments: [context.scopeLabel, `Node ${source.nodeId}`],
      pathTruncated: true
    };
  }

  private async openContentIfString(source: SourceRef, block: ConversationBlock, opener: HTMLElement): Promise<void> {
    const context = this.context;
    if (!context) return;
    const generation = this.generation;
    const requestGeneration = this.requestGeneration;
    const pageIdentity = cursorKey(this.page?.pageStart ?? null);
    const candidateId = this.selectedCandidate?.node.id ?? null;
    const style = this.style;
    try {
      const value = await this.invokeRequest<unknown>("get_node_summary", {
        nodeId: source.nodeId,
        sessionRevision: context.sessionRevision,
        scopeId: null
      });
      if (!this.isCurrentProjection(context, generation, requestGeneration, pageIdentity, candidateId, style)) return;
      const node = validateNode(value, context.sourceSize);
      if (!node) throw new Error("The Conversation content node response was invalid.");
      if (node.kind === "string") {
        this.onContent(this.contentTarget(source), opener);
      } else {
        this.onTree({ ref: source, label: `${block.category} structure` }, opener);
      }
    } catch (error) {
      if (!this.isCurrentProjection(context, generation, requestGeneration, pageIdentity, candidateId, style)) return;
      if (isSessionError(error)) this.onError(error);
      else this.statusMessage = errorMessage(error);
      this.render();
    }
  }

  private sourceLabel(block: ConversationBlock, action: string): string {
    if (action === "role") return `${block.role || "Unknown"} role source`;
    if (action === "content") return `${block.category} content`;
    return `${block.category} source`;
  }

  private render(): void {
    const context = this.context;
    const focusIntent = this.captureFocusIntent();
    this.panel.hidden = context === null;
    if (!context) {
      this.panel.replaceChildren();
      return;
    }
    const shell = element("section", "conversation-shell");
    shell.setAttribute("aria-label", `${context.scopeLabel} Conversation`);
    const header = element("header", "conversation-header");
    const heading = element("div", "conversation-heading");
    const kicker = element("span", "conversation-kicker", "Semantic projection");
    const title = element("h3", "conversation-title", "Conversation");
    heading.append(kicker, title);
    header.append(heading);
    if (this.selectedCandidate && this.page) {
      const wrapperActions = element("div", "conversation-wrapper-actions");
      wrapperActions.append(this.actionButton("Raw wrapper", "wrapper-raw"), this.actionButton("Tree wrapper", "wrapper-tree"));
      header.append(wrapperActions);
    }
    shell.append(header);

    const status = element("p", "conversation-status", this.statusMessage || this.defaultStatus(context));
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    shell.append(status);

    if (this.loading && this.candidates.length === 0) {
      shell.append(element("div", "conversation-empty", "Finding direct messages, conversation, or conversations arrays…"));
      this.installPanel(shell, focusIntent);
      return;
    }
    if (this.candidates.length === 0 && this.candidateScanCursor === null) {
      shell.append(element("div", "conversation-empty", this.statusMessage || "No supported direct Conversation candidate in this scope."));
      this.installPanel(shell, focusIntent);
      return;
    }
    if (!this.selectedCandidate) {
      shell.append(this.renderCandidateChooser());
      this.installPanel(shell, focusIntent);
      return;
    }
    shell.append(this.renderProjectionControls());
    if (this.selectedCandidate.kind === "possible" && !this.possibleConfirmed) {
      const possible = element("div", "conversation-banner conversation-banner-possible");
      possible.append(element("strong", "", "Possible Conversation"));
      possible.append(element("span", "", "The structure resembles messages but does not meet the automatic threshold."));
      possible.append(this.actionButton("Render as Conversation", "confirm", "primary-button"));
      shell.append(possible);
      this.installPanel(shell, focusIntent);
      return;
    }
    if (this.selectedCandidate.kind === "mixed" && this.style === "generic") {
      const mixed = element("div", "conversation-banner conversation-banner-mixed");
      mixed.append(element("strong", "", "Mixed conversation schema detected"));
      mixed.append(element("span", "", "Generic keeps both ecosystems lossless. Choose a brand style explicitly when needed."));
      shell.append(mixed);
    }
    shell.append(this.renderPageControls());
    shell.append(this.renderBlockViewport());
    shell.append(this.renderPageControls(true));
    this.installPanel(shell, focusIntent);
  }

  private captureFocusIntent(): FocusIntent | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.panel.contains(active)) return null;
    const block = active.closest<HTMLElement>("[data-conversation-block-index]");
    if (block) {
      const blockIndex = numberFromDataset(block.dataset.conversationBlockIndex);
      if (blockIndex !== null) {
        return {
          kind: "block",
          blockIndex,
          action: active.dataset.conversationAction,
          refKey: active.dataset.conversationRefKey
        };
      }
    }
    if (active instanceof HTMLSelectElement && active.dataset.conversationStyle !== undefined) {
      return { kind: "style" };
    }
    const action = active.dataset.conversationAction;
    if (action) return { kind: "action", action };
    const candidateId = numberFromDataset(active.dataset.conversationCandidate);
    if (candidateId !== null) return { kind: "candidate", candidateId };
    return null;
  }

  private installPanel(shell: HTMLElement, focusIntent: FocusIntent | null): void {
    this.panel.replaceChildren(shell);
    this.restoreFocus(focusIntent);
  }

  private restoreFocus(focusIntent: FocusIntent | null): void {
    if (!focusIntent || this.panel.hidden || !this.panel.isConnected) return;
    queueMicrotask(() => {
      if (this.panel.hidden || !this.panel.isConnected) return;
      let target: HTMLElement | null = null;
      if (focusIntent?.kind === "block" && focusIntent.blockIndex !== undefined) {
        const blockSelector = `[data-conversation-block-index="${focusIntent.blockIndex}"]`;
        if (focusIntent.action) {
          const refSelector = focusIntent.refKey ? `[data-conversation-ref-key="${focusIntent.refKey}"]` : "";
          target = this.panel.querySelector<HTMLElement>(`${blockSelector} [data-conversation-action="${focusIntent.action}"]${refSelector}`);
        }
        target ??= this.panel.querySelector<HTMLElement>(`${blockSelector} [data-conversation-action]`);
      } else if (focusIntent?.kind === "style") {
        target = this.panel.querySelector<HTMLElement>("select[data-conversation-style]");
      } else if (focusIntent?.kind === "candidate" && focusIntent.candidateId !== undefined) {
        target = this.panel.querySelector<HTMLElement>(`[data-conversation-candidate="${focusIntent.candidateId}"]`);
      } else if (focusIntent?.kind === "action") {
        target = this.panel.querySelector<HTMLElement>(`[data-conversation-action="${focusIntent.action}"]:not(:disabled)`);
      }
      target ??= this.panel.querySelector<HTMLElement>("select[data-conversation-style]:not(:disabled)");
      target ??= this.panel.querySelector<HTMLElement>("button[data-conversation-candidate]:not(:disabled)");
      target ??= this.panel.querySelector<HTMLElement>("button[data-conversation-action]:not(:disabled)");
      target?.focus();
    });
  }

  private renderCandidateChooser(): HTMLElement {
    const wrapper = element("div", "conversation-candidate-chooser");
    wrapper.append(element("h4", "", this.candidates.length > 1 ? "Choose a Conversation candidate" : "Conversation candidate"));
    const list = element("div", "conversation-candidate-list");
    for (const candidate of this.candidates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "conversation-candidate";
      button.dataset.conversationCandidate = String(candidate.node.id);
      button.setAttribute("aria-label", `Render ${candidate.node.label} as Conversation`);
      const label = element("strong", "conversation-candidate-label", candidate.node.label);
      const meta = element("span", "conversation-candidate-meta", `${candidate.kind} · ${candidate.messageCount.toLocaleString()} messages · Node ${candidate.node.id}`);
      button.append(label, meta);
      list.append(button);
    }
    wrapper.append(list);
    if (this.candidateScanCursor !== null) {
      wrapper.append(this.actionButton("Scan more direct fields", "scan-more", "secondary-button"));
    }
    return wrapper;
  }

  private renderProjectionControls(): HTMLElement {
    const controls = element("div", "conversation-controls");
    const candidate = this.selectedCandidate;
    if (candidate) {
      const selected = element("div", "conversation-selected-candidate");
      selected.append(element("strong", "", candidate.node.label));
      selected.append(element("span", "", `${candidate.kind} · ${candidate.messageCount.toLocaleString()} messages`));
      controls.append(selected);
      if (this.candidates.length > 1) controls.append(this.actionButton("Change candidate", "choose-candidate"));
      if (this.candidateScanCursor !== null) {
        const scanMore = this.actionButton("Scan more direct fields", "scan-more");
        scanMore.disabled = this.loading;
        controls.append(scanMore);
      }
    }
    const label = document.createElement("label");
    label.className = "conversation-style-control";
    label.append(element("span", "", "Render as"));
    const select = document.createElement("select");
    select.dataset.conversationStyle = "true";
    select.setAttribute("aria-label", "Render Conversation as");
    for (const option of [["generic", "Generic"], ["openai", "OpenAI-style"], ["anthropic", "Anthropic-style"]] as const) {
      const item = document.createElement("option");
      item.value = option[0];
      item.textContent = option[1];
      item.selected = option[0] === this.style;
      select.append(item);
    }
    label.append(select);
    controls.append(label);
    return controls;
  }

  private renderPageControls(bottom = false): HTMLElement {
    const nav = element("nav", bottom ? "conversation-page-controls conversation-page-controls-bottom" : "conversation-page-controls");
    nav.setAttribute("aria-label", "Conversation pages");
    const previous = this.actionButton("Previous", "previous");
    const next = this.actionButton("Next", "next");
    previous.disabled = this.loading || this.previousPages.length === 0;
    next.disabled = this.loading || !this.page?.hasMore;
    const label = element("span", "conversation-page-status", this.page
      ? `${this.page.blocks.length} blocks · ${this.page.hasMore ? "more available" : "end of scope"}`
      : this.loading ? "Loading…" : "No page loaded");
    nav.append(previous, label, next);
    return nav;
  }

  private renderBlockViewport(): HTMLElement {
    const viewport = element("div", "conversation-block-viewport");
    viewport.setAttribute("role", "list");
    viewport.setAttribute("aria-label", "Conversation blocks");
    viewport.tabIndex = 0;
    this.blockViewport = viewport;
    this.resetWindowElements();
    this.renderBlocks();
    return viewport;
  }

  private resetWindowElements(): void {
    this.windowPageIdentity = null;
    this.windowStart = -1;
    this.windowEnd = -1;
    this.windowTopSpacer = null;
    this.windowList = null;
    this.windowBottomSpacer = null;
  }

  private renderBlocks(): void {
    const viewport = this.blockViewport;
    if (!viewport) return;
    const blocks = this.page?.blocks ?? [];
    const pageIdentity = cursorKey(this.page?.pageStart ?? null);
    if (blocks.length === 0) {
      if (this.windowPageIdentity !== pageIdentity || this.windowList !== null) {
        this.resetWindowElements();
        viewport.replaceChildren(element("div", "conversation-empty", this.loading ? "Loading blocks…" : "No blocks on this page."));
        this.windowPageIdentity = pageIdentity;
      }
      return;
    }
    const scrollTop = viewport.scrollTop;
    const previousMaxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const wasAtBottom = previousMaxScroll > 0 && scrollTop >= previousMaxScroll - 2;
    const focused = document.activeElement?.closest<HTMLElement>("[data-conversation-block-index]");
    const focusedIndex = focused ? numberFromDataset(focused.dataset.conversationBlockIndex) : null;
    const focusedAction = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.conversationAction
      : undefined;
    const focusedRefKey = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.conversationRefKey
      : undefined;
    const height = viewport.clientHeight || 560;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 20);
    const end = Math.min(blocks.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 20);
    if (this.windowPageIdentity === pageIdentity && this.windowStart === start && this.windowEnd === end
      && this.windowTopSpacer !== null && this.windowList !== null && this.windowBottomSpacer !== null) {
      return;
    }
    if (this.windowTopSpacer === null || this.windowList === null || this.windowBottomSpacer === null) {
      this.windowTopSpacer = document.createElement("div");
      this.windowList = element("div", "conversation-block-list");
      this.windowBottomSpacer = document.createElement("div");
      viewport.replaceChildren(this.windowTopSpacer, this.windowList, this.windowBottomSpacer);
    }
    this.windowPageIdentity = pageIdentity;
    this.windowStart = start;
    this.windowEnd = end;
    this.windowTopSpacer.style.height = `${start * ROW_HEIGHT}px`;
    this.windowBottomSpacer.style.height = `${Math.max(0, blocks.length - end) * ROW_HEIGHT}px`;
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) fragment.append(this.renderBlock(blocks[index], index));
    this.windowList.replaceChildren(fragment);
    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = wasAtBottom ? maxScroll : Math.min(scrollTop, maxScroll);
    if (focusedIndex !== null) {
      const blockSelector = `[data-conversation-block-index="${focusedIndex}"]`;
      const refSelector = focusedRefKey ? `[data-conversation-ref-key="${focusedRefKey}"]` : "";
      const focusedTarget = focusedAction
        ? viewport.querySelector<HTMLElement>(`${blockSelector} [data-conversation-action="${focusedAction}"]${refSelector}`)
        : null;
      const focusTarget = focusedTarget ?? viewport.querySelector<HTMLElement>(`${blockSelector} button`);
      if (focusTarget) focusTarget.focus({ preventScroll: true });
      else viewport.focus({ preventScroll: true });
    }
  }

  private renderBlock(block: ConversationBlock, index: number): HTMLElement {
    const item = element("article", `conversation-block conversation-block-${block.kind}`);
    item.dataset.conversationBlockIndex = String(index);
    item.setAttribute("role", "listitem");
    item.setAttribute("aria-setsize", String(this.page?.blocks.length ?? 0));
    item.setAttribute("aria-posinset", String(index + 1));
    const heading = element("div", "conversation-block-heading");
    const title = block.kind === "message"
      ? `Message · Node ${block.message?.nodeId ?? "unknown"}`
      : block.kind === "system" ? "System section" : block.category;
    heading.append(element("strong", "conversation-block-title", title));
    if (block.role) heading.append(element("span", "conversation-role", block.role));
    heading.append(element("span", "conversation-category", block.category));
    item.append(heading);
    const summary = element("p", "conversation-block-summary", this.blockSummary(block));
    item.append(summary);
    this.loadBlockSummary(block, index);
    const actions = element("div", "conversation-block-actions");
    const source = this.sourceFor(block, "raw");
    if (block.roleSource) actions.append(this.blockActionButton("Role source", "role", index));
    if (source) {
      actions.append(this.blockActionButton("Raw", "raw", index), this.blockActionButton("Tree", "tree", index));
      if (isContentCategory(block.category) && this.sourceFor(block, "content")) {
        actions.append(this.blockActionButton("Open content", "content", index));
      }
    }
    this.appendSpecializedRefs(actions, block, index);
    item.append(actions);
    return item;
  }

  private appendSpecializedRefs(actions: HTMLElement, block: ConversationBlock, index: number): void {
    const refs = block.anthropicRefs ?? block.openaiRefs;
    if (!refs) return;
    const entries = Object.entries(refs) as Array<[string, SourceRef | null]>;
    for (const [name, ref] of entries) {
      if (!ref || name === "block" || name === "text" || name === "thinking" || name === "content") continue;
      const button = this.blockActionButton(`${name} source`, "raw", index);
      button.dataset.conversationRefKey = name;
      button.title = `Source Node ${ref.nodeId}`;
      actions.append(button);
    }
  }

  private blockSummary(block: ConversationBlock): string {
    const source = this.sourceFor(block, "raw");
    const preview = source ? this.blockSummaries.get(source.nodeId) : undefined;
    if (preview) return `Source preview: ${preview}`;
    if (block.kind === "system") return "System metadata is preserved before messages; use Raw for the wrapper source.";
    if (block.category === "unknown") return "Unknown block preserved without schema-specific interpretation.";
    if (block.category === "content" || block.category === "text" || block.category === "thinking") {
      return "Content is source-preserving and opens in Content Viewer when selected.";
    }
    if (block.category === "toolCall" || block.category === "toolUse" || block.category === "toolResult") {
      return "Tool data is summarized here; every source reference remains available.";
    }
    return "Source-preserving Conversation block.";
  }

  private loadBlockSummary(block: ConversationBlock, index: number): void {
    const context = this.context;
    const source = this.sourceFor(block, "raw");
    const viewport = this.blockViewport;
    const pageStart = this.page?.pageStart ?? null;
    const pageIdentity = cursorKey(pageStart);
    if (!context || !source || !viewport || this.blockSummaries.has(source.nodeId)) return;
    const requestKey = `${pageIdentity}:${source.nodeId}`;
    if (this.summaryRequests.has(requestKey)) return;
    this.summaryRequests.add(requestKey);
    const generation = this.generation;
    void this.invokeRequest<unknown>("get_node_summary", {
      nodeId: source.nodeId,
      sessionRevision: context.sessionRevision,
      scopeId: null
    }).then((value) => {
      this.summaryRequests.delete(requestKey);
      if (!this.isCurrent(context, generation) || this.page === null || cursorKey(this.page.pageStart) !== pageIdentity) return;
      const currentBlock = this.page.blocks[index];
      const currentSource = currentBlock ? this.sourceFor(currentBlock, "raw") : null;
      if (!currentSource || currentSource.nodeId !== source.nodeId) return;
      const node = validateNode(value, context.sourceSize);
      if (!node) return;
      const preview = node.valuePreview === null ? `${node.kind} Node ${node.id}` : node.valuePreview;
      this.blockSummaries.set(source.nodeId, preview.slice(0, 240));
      const summary = viewport.querySelector<HTMLElement>(`[data-conversation-block-index="${index}"] .conversation-block-summary`);
      if (summary) summary.textContent = this.blockSummaries.get(source.nodeId) ?? "";
    }).catch((error: unknown) => {
      this.summaryRequests.delete(requestKey);
      if (this.isCurrent(context, generation) && isSessionError(error)) this.onError(error);
    });
  }

  private blockActionButton(label: string, action: string, index: number): HTMLButtonElement {
    const button = this.actionButton(label, action, "secondary-button conversation-block-action");
    button.dataset.conversationBlockIndex = String(index);
    return button;
  }

  private actionButton(label: string, action: string, className = "secondary-button"): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.dataset.conversationAction = action;
    return button;
  }

  private defaultStatus(context: ConversationContext): string {
    return `${context.scopeLabel} · Node ${context.scopeRoot.id} · revision ${context.sessionRevision}`;
  }

  private isCurrent(context: ConversationContext, generation: number): boolean {
    return generation === this.generation && this.context !== null && contextKey(this.context) === contextKey(context);
  }

  private isCurrentRequest(context: ConversationContext, generation: number, requestGeneration: number): boolean {
    return this.isCurrent(context, generation) && requestGeneration === this.requestGeneration;
  }

  private isCurrentProjection(
    context: ConversationContext,
    generation: number,
    requestGeneration: number,
    pageIdentity: string,
    candidateId: number | null,
    style: ConversationStyle
  ): boolean {
    return this.isCurrent(context, generation)
      && requestGeneration === this.requestGeneration
      && cursorKey(this.page?.pageStart ?? null) === pageIdentity
      && this.selectedCandidate?.node.id === candidateId
      && this.style === style;
  }
}

function contextKey(context: ConversationContext): string {
  const root = context.scopeRoot;
  return `${context.mode}:${context.sessionRevision}:${context.sourceSize}:${root.id}:${root.spanStart}:${root.spanEnd}`;
}

function isCandidateField(label: string): boolean {
  if (CANDIDATE_FIELDS.has(label)) return true;
  const match = label.match(/^(messages|conversation|conversations)#(\d+)$/);
  return match !== null && Number(match[2]) >= 2 && CANDIDATE_FIELDS.has(match[1]);
}

function isContentCategory(category: string): boolean {
  return category === "content" || category === "value" || category === "text" || category === "thinking"
    || category === "redactedThinking" || category === "toolResult";
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function numberFromDataset(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function sourceRef(value: unknown, sourceSize: number): SourceRef | null | undefined {
  if (value === null || value === undefined) return null;
  const object = record(value);
  if (!object) return undefined;
  const nodeId = safeNumber(object.nodeId);
  const spanStart = safeNumber(object.spanStart);
  const spanEnd = safeNumber(object.spanEnd);
  if (nodeId === null || spanStart === null || spanEnd === null || spanStart >= spanEnd || spanEnd > sourceSize) return undefined;
  return { nodeId, spanStart, spanEnd };
}

function tripleRef(value: Record<string, unknown>, prefix: string, sourceSize: number): SourceRef | null | undefined {
  const nodeId = value[`${prefix}NodeId`];
  const spanStart = value[`${prefix}SpanStart`];
  const spanEnd = value[`${prefix}SpanEnd`];
  if (nodeId === null && spanStart === null && spanEnd === null || nodeId === undefined && spanStart === undefined && spanEnd === undefined) return null;
  return sourceRef({ nodeId, spanStart, spanEnd }, sourceSize);
}

function refsValue(value: unknown, sourceSize: number, names: readonly string[]): OpenAiRefs | AnthropicRefs | null | undefined {
  if (value === null || value === undefined) return null;
  const object = record(value);
  if (!object) return undefined;
  const output: Record<string, SourceRef | null> = {};
  for (const name of names) {
    const ref = sourceRef(object[name], sourceSize);
    if (ref === undefined) return undefined;
    output[name] = ref;
  }
  return output as OpenAiRefs | AnthropicRefs;
}

function validateNode(value: unknown, sourceSize: number): NodeDto | null {
  const object = record(value);
  if (!object) return null;
  const id = safeNumber(object.id);
  const spanStart = safeNumber(object.spanStart);
  const spanEnd = safeNumber(object.spanEnd);
  const kind = stringValue(object.kind);
  const label = stringValue(object.label);
  const labelHasMore = object.labelHasMore;
  const valuePreview = object.valuePreview === null ? null : stringValue(object.valuePreview);
  const valueHasMore = object.valueHasMore;
  const childCount = safeNumber(object.childCount);
  if (id === null || spanStart === null || spanEnd === null || spanStart >= spanEnd || spanEnd > sourceSize
    || kind === null || label === null || typeof labelHasMore !== "boolean" || valuePreview === undefined
    || typeof valueHasMore !== "boolean" || childCount === null) return null;
  return { id, kind, spanStart, spanEnd, label, labelHasMore, valuePreview, valueHasMore, childCount };
}

function validateChildrenPage(value: unknown, cursor: number, sourceSize: number): { nodes: NodeDto[]; hasMore: boolean; nextCursor: number | null } | null {
  const object = record(value);
  if (!object || !Array.isArray(object.nodes) || typeof object.hasMore !== "boolean") return null;
  const nextCursor = object.nextCursor === null ? null : safeNumber(object.nextCursor);
  if (object.nextCursor !== null && nextCursor === null) return null;
  const nodes = object.nodes.map((node) => validateNode(node, sourceSize));
  if (nodes.some((node): node is null => node === null)) return null;
  if (object.hasMore && (nextCursor === null || nextCursor <= cursor)) return null;
  if (!object.hasMore && nextCursor !== null) return null;
  return { nodes: nodes as NodeDto[], hasMore: object.hasMore, nextCursor };
}

function validateCandidate(value: unknown, node: NodeDto, context: ConversationContext): Candidate | null {
  const object = record(value);
  if (!object) return null;
  const nodeId = safeNumber(object.nodeId);
  const spanStart = safeNumber(object.spanStart);
  const spanEnd = safeNumber(object.spanEnd);
  const messageCount = safeNumber(object.messageCount);
  const scopeRootId = safeNumber(object.scopeRootId);
  const sessionRevision = safeNumber(object.sessionRevision);
  const kind = stringValue(object.kind);
  if (nodeId !== node.id || spanStart !== node.spanStart || spanEnd !== node.spanEnd || messageCount === null
    || scopeRootId !== context.scopeRoot.id || sessionRevision !== context.sessionRevision
    || spanStart < context.scopeRoot.spanStart || spanEnd > context.scopeRoot.spanEnd
    || (kind !== "none" && kind !== "possible" && kind !== "generic" && kind !== "openai" && kind !== "anthropic" && kind !== "mixed")) return null;
  return { node, kind: kind as ConversationCandidateKind, messageCount };
}

function validateCursor(value: unknown, context: ConversationContext, candidate: Candidate, style: ConversationStyle): Cursor | null {
  const object = record(value);
  if (!object || object.kind !== "genericConversation" || object.style !== style
    || safeNumber(object.scopeRootId) !== context.scopeRoot.id || safeNumber(object.candidateNodeId) !== candidate.node.id
    || safeNumber(object.sessionRevision) !== context.sessionRevision) return null;
  const messageIndex = safeNumber(object.messageIndex);
  const fieldIndex = safeNumber(object.fieldIndex);
  const elementIndex = safeNumber(object.elementIndex);
  const phase = object.phase;
  if (messageIndex === null || fieldIndex === null || elementIndex === null
    || phase !== "message" && phase !== "fields" && phase !== "systemHeader" && phase !== "systemContent") return null;
  return {
    kind: "genericConversation",
    style,
    scopeRootId: context.scopeRoot.id,
    candidateNodeId: candidate.node.id,
    messageIndex,
    phase,
    fieldIndex,
    elementIndex,
    sessionRevision: context.sessionRevision
  };
}

function cursorKey(cursor: Cursor | null): string {
  if (!cursor) return "start";
  return `${cursor.style}:${cursor.messageIndex}:${cursor.phase}:${cursor.fieldIndex}:${cursor.elementIndex}`;
}

function validatePage(value: unknown, context: ConversationContext, candidate: Candidate, style: ConversationStyle, requestCursor: Cursor | null): Page | null {
  const object = record(value);
  if (!object || !Array.isArray(object.blocks) || object.blocks.length > PAGE_LIMIT || typeof object.hasMore !== "boolean") return null;
  const wrapper = record(object.wrapperRef);
  if (!wrapper) return null;
  const scopeRootId = safeNumber(wrapper.scopeRootId);
  const scopeRootSpanStart = safeNumber(wrapper.scopeRootSpanStart);
  const scopeRootSpanEnd = safeNumber(wrapper.scopeRootSpanEnd);
  const candidateNodeId = safeNumber(wrapper.candidateNodeId);
  const candidateSpanStart = safeNumber(wrapper.candidateSpanStart);
  const candidateSpanEnd = safeNumber(wrapper.candidateSpanEnd);
  if (scopeRootId !== context.scopeRoot.id || scopeRootSpanStart !== context.scopeRoot.spanStart || scopeRootSpanEnd !== context.scopeRoot.spanEnd
    || candidateNodeId !== candidate.node.id || candidateSpanStart !== candidate.node.spanStart || candidateSpanEnd !== candidate.node.spanEnd) return null;
  const blocks = object.blocks.map((value) => validateBlock(value, context.sourceSize, context.scopeRoot, candidate, style));
  if (blocks.some((block): block is null => block === null)) return null;
  const nextCursor = object.nextCursor === null ? null : validateCursor(object.nextCursor, context, candidate, style);
  if (object.nextCursor !== null && nextCursor === null) return null;
  if (object.hasMore !== (nextCursor !== null)) return null;
  if (nextCursor && cursorKey(nextCursor) === cursorKey(requestCursor)) return null;
  return {
    blocks: blocks as ConversationBlock[],
    hasMore: object.hasMore,
    nextCursor,
    wrapperRef: { scopeRootId, scopeRootSpanStart, scopeRootSpanEnd, candidateNodeId, candidateSpanStart, candidateSpanEnd },
    pageStart: requestCursor
  };
}

function validateBlock(value: unknown, sourceSize: number, scopeRoot: NodeDto, candidate: Candidate, style: ConversationStyle): ConversationBlock | null {
  const object = record(value);
  if (!object || !BLOCK_KINDS.has(String(object.kind))) return null;
  const kind = object.kind as ConversationBlock["kind"];
  const category = stringValue(object.category);
  const role = stringValue(object.role);
  const message = tripleRef(object, "message", sourceSize);
  const source = tripleRef(object, "source", sourceSize);
  const field = tripleRef(object, "field", sourceSize);
  const roleSource = tripleRef(object, "roleSource", sourceSize);
  const openaiRefs = refsValue(object.openaiRefs, sourceSize, ["block", "text", "image", "callId", "function", "name", "arguments"]) as OpenAiRefs | null | undefined;
  const anthropicRefs = refsValue(object.anthropicRefs, sourceSize, ["block", "text", "thinking", "data", "id", "name", "input", "toolUseId", "content"]) as AnthropicRefs | null | undefined;
  if (category === null || role === null || message === undefined || source === undefined || field === undefined || roleSource === undefined
    || openaiRefs === undefined || anthropicRefs === undefined) return null;
  const refs: Array<SourceRef | null> = [message, source, field, roleSource];
  if (openaiRefs) refs.push(...Object.values(openaiRefs));
  if (anthropicRefs) refs.push(...Object.values(anthropicRefs));
  if (refs.some((ref) => ref !== null && !refWithin(ref, scopeRoot.spanStart, scopeRoot.spanEnd))) return null;
  if (kind === "message" && message === null) return null;
  if (kind === "system" && message !== null) return null;
  if (kind === "system" && source === null && field === null) return null;
  if (kind === "source" && source === null && field === null) return null;
  if (message && !refWithin(message, candidate.node.spanStart, candidate.node.spanEnd)) return null;
  if (style === "openai" && anthropicRefs !== null || style === "anthropic" && openaiRefs !== null) return null;
  return { kind, message, source, field, category, role, roleSource, openaiRefs, anthropicRefs };
}

function refWithin(ref: SourceRef, start: number, end: number): boolean {
  return ref.spanStart >= start && ref.spanEnd <= end;
}

function isSessionError(error: unknown): boolean {
  const object = record(error);
  const code = object?.code;
  return code === "file_changed" || code === "stale_session";
}

function isInvalidRequest(error: unknown): boolean {
  return record(error)?.code === "invalid_request";
}

function errorMessage(error: unknown): string {
  const object = record(error);
  if (typeof object?.message === "string") return object.message;
  return error instanceof Error ? error.message : "Conversation request failed.";
}
