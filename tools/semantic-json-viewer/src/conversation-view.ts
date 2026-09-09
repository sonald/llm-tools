import { invoke } from "@tauri-apps/api/core";
import { renderCode } from "./code-renderer";
import type { ContentTarget } from "./content-viewer";
import { renderSafeMarkdown } from "./markdown-renderer";
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

type StringMetrics = {
  decodedBytes: number;
  characterCount: number;
  lineCount: number;
};

type StringDetection = {
  semanticType: "plainText" | "markdown" | "code" | "nestedJson" | "html";
};

type InlineState = {
  status: "loading" | "ready" | "partial" | "unavailable";
  text?: string;
  metrics?: StringMetrics;
  detection?: StringDetection;
  opaque?: boolean;
  reason?: string;
};

type InlineAnchor = {
  index: number;
  offset: number;
};

type ToolCardRow = {
  label: string;
  value: string;
  ref: SourceRef | null;
  mode: "plain" | "code" | "structure" | "status";
  truncated?: boolean;
};

type ToolCardState = {
  status: "loading" | "ready" | "unavailable";
  rows: ToolCardRow[];
  callId: string | null;
  errorState: "ok" | "error" | "missing" | "invalid" | "unloaded" | null;
  reason?: string;
};

type ToolCardRequest = {
  context: ConversationContext;
  generation: number;
  requestGeneration: number;
  pageIdentity: string;
  candidateId: number | null;
  style: ConversationStyle;
  index: number;
  host: HTMLElement;
  textBudgetRemaining: number;
};

type LoadedCallMatch = {
  status: "confirmed" | "ambiguous";
  label: string;
};

type CardChildren = {
  nodes: NodeDto[];
  hasMore: boolean;
};

type ToolStringValue = {
  text: string;
  mode: "plain" | "code";
  truncated: boolean;
  nestedRows?: ToolCardRow[];
};

const CANDIDATE_FIELDS = new Set(["messages", "conversation", "conversations"]);
const BLOCK_KINDS = new Set(["message", "source", "system"]);
const MAX_CHILD_PAGES = 16;
const PAGE_LIMIT = 100;
const ROW_HEIGHT = 136;
const INLINE_READ_BYTES = 128 * 1024;
const TOOL_READ_BYTES = 16 * 1024;
// At most 100 page cards can be retained; 100 * 256 KiB = 25 MiB of decoded
// card text, below the 32 MiB frontend projection budget. Rows remain bounded.
const TOOL_CARD_TEXT_BUDGET = 256 * 1024;
const TOOL_CHILD_LIMIT = 32;

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
  private windowVisibleStart = -1;
  private windowVisibleEnd = -1;
  private windowTopSpacer: HTMLElement | null = null;
  private windowList: HTMLElement | null = null;
  private windowBottomSpacer: HTMLElement | null = null;
  private readonly blockSummaries = new Map<number, string>();
  private readonly summaryRequests = new Set<string>();
  private readonly inlineStates = new Map<number, InlineState>();
  private readonly inlineRequests = new Set<string>();
  private readonly renderedInlineStates = new WeakMap<HTMLElement, InlineState>();
  private readonly toolCardStates = new Map<number, ToolCardState>();
  private readonly toolCardRequests = new Set<string>();
  private readonly toolCardRefs = new Map<string, SourceRef>();
  private readonly rowHeights = new Map<number, number>();
  private readonly rowResizeObserver: ResizeObserver | null;
  private layoutVersion = 0;
  private renderedLayoutVersion = -1;
  private pendingAnchor: InlineAnchor | null = null;

  constructor(options: ConversationViewOptions) {
    this.panel = options.panel;
    this.invokeRequest = options.invoke ?? invoke;
    this.onError = options.onError;
    this.onRaw = options.onRaw;
    this.onTree = options.onTree;
    this.onContent = options.onContent;
    this.rowResizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => this.handleRowResize(entries))
      : null;
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
    this.inlineStates.clear();
    this.inlineRequests.clear();
    this.toolCardStates.clear();
    this.toolCardRequests.clear();
    this.toolCardRefs.clear();
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
    this.inlineStates.clear();
    this.inlineRequests.clear();
    this.toolCardStates.clear();
    this.toolCardRequests.clear();
    this.toolCardRefs.clear();
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
    this.inlineStates.clear();
    this.inlineRequests.clear();
    this.toolCardStates.clear();
    this.toolCardRequests.clear();
    this.toolCardRefs.clear();
    this.pendingAnchor = null;
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
      this.inlineStates.clear();
      this.inlineRequests.clear();
      this.toolCardStates.clear();
      this.toolCardRequests.clear();
      this.toolCardRefs.clear();
      this.pendingAnchor = null;
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
      this.inlineStates.clear();
      this.inlineRequests.clear();
      this.toolCardStates.clear();
      this.toolCardRequests.clear();
      this.toolCardRefs.clear();
      this.pendingAnchor = null;
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
    if (action === "card-raw" || action === "card-tree" || action === "card-content") {
      const index = numberFromDataset(actionElement.dataset.conversationBlockIndex);
      const cardRefKey = actionElement.dataset.conversationCardRef;
      const block = index === null ? null : this.page?.blocks[index] ?? null;
      const ref = cardRefKey ? this.toolCardRefs.get(cardRefKey) ?? null : null;
      if (!block || !ref) return;
      const targetInfo = { ref, label: `${block.category} card source` };
      if (action === "card-raw") this.onRaw(targetInfo, actionElement);
      else if (action === "card-tree") this.onTree(targetInfo, actionElement);
      else void this.openContentIfString(ref, block, actionElement);
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
    this.inlineStates.clear();
    this.inlineRequests.clear();
    this.toolCardStates.clear();
    this.toolCardRequests.clear();
    this.toolCardRefs.clear();
    this.pendingAnchor = null;
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
    if (this.page?.pageStart && (this.page.pageStart.messageIndex > 0 || this.page.pageStart.phase === "fields")) {
      const continuation = element("div", "conversation-banner conversation-banner-continuation");
      continuation.append(element("strong", "", "Continuation page"));
      continuation.append(element("span", "", `This page resumes at message ${this.page.pageStart.messageIndex + 1}; earlier blocks are on the previous page.`));
      shell.append(continuation);
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
    if (this.windowList && this.rowResizeObserver) {
      for (const child of Array.from(this.windowList.children)) this.rowResizeObserver.unobserve(child);
    }
    this.windowPageIdentity = null;
    this.windowStart = -1;
    this.windowEnd = -1;
    this.windowVisibleStart = -1;
    this.windowVisibleEnd = -1;
    this.windowTopSpacer = null;
    this.windowList = null;
    this.windowBottomSpacer = null;
    this.rowHeights.clear();
    this.layoutVersion += 1;
    this.renderedLayoutVersion = -1;
    this.pendingAnchor = null;
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
    const panelVisible = this.isPanelVisible();
    const height = panelVisible ? viewport.clientHeight || 560 : 0;
    const visibleStart = panelVisible ? this.indexAtOffset(scrollTop, blocks.length) : 0;
    const visibleEnd = panelVisible ? Math.min(blocks.length, this.indexAtOffset(scrollTop + height, blocks.length) + 1) : 0;
    const start = Math.max(0, visibleStart - 20);
    const end = panelVisible ? Math.min(blocks.length, visibleEnd + 20) : Math.min(blocks.length, 20);
    const hasWindow = this.windowPageIdentity === pageIdentity && this.windowStart === start && this.windowEnd === end
      && this.windowTopSpacer !== null && this.windowList !== null && this.windowBottomSpacer !== null;
    if (hasWindow && this.renderedLayoutVersion === this.layoutVersion && this.pendingAnchor === null) {
      if (this.windowVisibleStart !== visibleStart || this.windowVisibleEnd !== visibleEnd) {
        this.windowVisibleStart = visibleStart;
        this.windowVisibleEnd = visibleEnd;
        this.ensureVisibleInline(visibleStart, visibleEnd);
      }
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
    this.windowVisibleStart = visibleStart;
    this.windowVisibleEnd = visibleEnd;
    const anchor = this.pendingAnchor;
    const topHeight = this.prefixHeight(start);
    const bottomHeight = Math.max(0, this.totalHeight(blocks.length) - this.prefixHeight(end));
    this.windowTopSpacer.style.height = `${topHeight}px`;
    this.windowBottomSpacer.style.height = `${bottomHeight}px`;
    if (!hasWindow || this.renderedLayoutVersion < 0 || this.pendingAnchor === null && this.windowList.childElementCount === 0) {
      if (this.rowResizeObserver) {
        for (const child of Array.from(this.windowList.children)) this.rowResizeObserver.unobserve(child);
      }
      const fragment = document.createDocumentFragment();
      for (let index = start; index < end; index += 1) {
        const row = this.renderBlock(blocks[index], index, index >= visibleStart && index < visibleEnd);
        fragment.append(row);
      }
      this.windowList.replaceChildren(fragment);
      if (this.rowResizeObserver) {
        for (const child of Array.from(this.windowList.children)) this.rowResizeObserver.observe(child);
      }
    }
    this.renderedLayoutVersion = this.layoutVersion;
    this.pendingAnchor = null;
    this.ensureVisibleInline(visibleStart, visibleEnd);
    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const anchoredScroll = anchor ? this.prefixHeight(anchor.index) + anchor.offset : null;
    viewport.scrollTop = anchoredScroll !== null
      ? Math.min(anchoredScroll, maxScroll)
      : wasAtBottom ? maxScroll : Math.min(scrollTop, maxScroll);
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

  private rowHeight(index: number): number {
    return this.rowHeights.get(index) ?? ROW_HEIGHT;
  }

  private prefixHeight(count: number): number {
    let total = 0;
    for (let index = 0; index < count; index += 1) total += this.rowHeight(index);
    return total;
  }

  private totalHeight(count: number): number {
    return this.prefixHeight(count);
  }

  private indexAtOffset(offset: number, count: number): number {
    if (count <= 1) return 0;
    const target = Math.max(0, offset);
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      const next = cursor + this.rowHeight(index);
      if (target < next) return index;
      cursor = next;
    }
    return count - 1;
  }

  private anchorAtOffset(offset: number): InlineAnchor | null {
    const blocks = this.page?.blocks ?? [];
    if (blocks.length === 0) return null;
    const index = this.indexAtOffset(offset, blocks.length);
    return { index, offset: Math.max(0, offset - this.prefixHeight(index)) };
  }

  private handleRowResize(entries: ResizeObserverEntry[]): void {
    const viewport = this.blockViewport;
    if (!viewport || !this.page || entries.length === 0 || !this.isPanelVisible()) return;
    const anchor = this.anchorAtOffset(viewport.scrollTop);
    let changed = false;
    for (const entry of entries) {
      if (!this.windowList?.contains(entry.target)) continue;
      const row = entry.target.closest<HTMLElement>("[data-conversation-block-index]");
      const index = row ? numberFromDataset(row.dataset.conversationBlockIndex) : null;
      if (index === null) continue;
      const borderBoxSize = entry.borderBoxSize as ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
      const borderBox = Array.isArray(borderBoxSize)
        ? borderBoxSize[0]?.blockSize
        : borderBoxSize && "blockSize" in borderBoxSize ? borderBoxSize.blockSize : undefined;
      const measured = Math.max(ROW_HEIGHT, Math.ceil(borderBox ?? entry.contentRect.height));
      if (this.rowHeights.get(index) !== measured) {
        this.rowHeights.set(index, measured);
        changed = true;
      }
    }
    if (!changed) return;
    this.layoutVersion += 1;
    this.pendingAnchor = anchor;
    queueMicrotask(() => {
      if (this.blockViewport === viewport && this.page !== null) this.renderBlocks();
    });
  }

  private ensureVisibleInline(start: number, end: number): void {
    const blocks = this.page?.blocks ?? [];
    if (!this.isPanelVisible() || !this.windowList) return;
    for (let index = start; index < end && index < blocks.length; index += 1) {
      const block = blocks[index];
      const source = this.inlineSourceFor(block);
      const row = this.windowList.querySelector<HTMLElement>(`[data-conversation-block-index="${index}"]`);
      if (!row) continue;
      const summary = row.querySelector<HTMLElement>(".conversation-block-summary");
      const toolCard = row.querySelector<HTMLElement>(".conversation-tool-card");
      if (toolCard && isToolBlock(block)) this.loadToolCard(block, index, toolCard);
      if (summary && !source) {
        summary.textContent = this.blockSummary(block);
        this.loadBlockSummary(block, index);
      }
      if (!source) continue;
      const host = row?.querySelector<HTMLElement>(".conversation-inline-content");
      if (host && summary) this.loadInlineContent(index, host, source, summary, block.category === "redactedThinking");
    }
  }

  onSemanticVisible(): void {
    if (!this.context || !this.isPanelVisible()) return;
    this.windowVisibleStart = -1;
    this.windowVisibleEnd = -1;
    this.renderBlocks();
  }

  private isPanelVisible(): boolean {
    if (!this.panel.isConnected) return false;
    for (let ancestor: HTMLElement | null = this.panel; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden) return false;
      const style = window.getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  private renderBlock(block: ConversationBlock, index: number, shouldInline = false): HTMLElement {
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
    if (block.kind !== "message" && block.message) {
      heading.append(element("span", "conversation-message-owner", `Message Node ${block.message.nodeId}`));
    }
    if (block.role) heading.append(element("span", "conversation-role", block.role));
    heading.append(element("span", "conversation-category", block.category));
    item.append(heading);
    const inlineSource = isToolBlock(block) ? null : this.inlineSourceFor(block);
    if (isToolBlock(block)) {
      // Tool cards own the bounded body; do not leave a generic summary
      // placeholder above a card whose source is an array/object.
    } else if (inlineSource) {
      const summary = element("p", "conversation-block-summary", shouldInline
        ? this.blockSummary(block)
        : "Summary loads when this block enters the viewport.");
      item.append(summary);
      const inline = element("div", "conversation-inline-content");
      inline.dataset.conversationInlineNode = String(inlineSource.nodeId);
      item.append(inline);
      if (shouldInline) this.loadInlineContent(index, inline, inlineSource, summary, block.category === "redactedThinking");
      else inline.append(element("p", "conversation-inline-placeholder", "Inline content loads when this block enters the viewport."));
    } else {
      const summary = element("p", "conversation-block-summary", shouldInline
        ? this.blockSummary(block)
        : "Summary loads when this block enters the viewport.");
      item.append(summary);
      if (shouldInline) this.loadBlockSummary(block, index);
    }
    if (isToolBlock(block)) {
      const card = element("section", "conversation-tool-card");
      card.dataset.conversationToolCard = String(index);
      card.setAttribute("aria-label", `${block.category} details`);
      item.append(card);
      if (shouldInline) queueMicrotask(() => this.loadToolCard(block, index, card));
      else card.append(element("p", "conversation-tool-card-placeholder", "Tool details load when this block enters the viewport."));
    }
    const actions = element("div", "conversation-block-actions");
    const source = this.sourceFor(block, "raw");
    if (block.roleSource) actions.append(this.blockActionButton("Role source", "role", index));
    if (source) {
      actions.append(this.blockActionButton("Raw", "raw", index), this.blockActionButton("Tree", "tree", index));
      if ((isContentCategory(block.category) || inlineSource) && this.sourceFor(block, "content")) {
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

  private loadToolCard(block: ConversationBlock, index: number, host: HTMLElement): void {
    const context = this.context;
    const request: ToolCardRequest | null = context ? {
      context,
      generation: this.generation,
      requestGeneration: this.requestGeneration,
      pageIdentity: cursorKey(this.page?.pageStart ?? null),
      candidateId: this.selectedCandidate?.node.id ?? null,
      style: this.style,
      index,
      host,
      textBudgetRemaining: TOOL_CARD_TEXT_BUDGET
    } : null;
    if (!request) return;
    const requestKey = this.toolCardRequestKey(request);
    const existing = this.toolCardStates.get(index);
    if (existing && existing.status !== "loading") {
      this.renderToolCard(host, index, existing);
      return;
    }
    if (existing?.status === "loading" && !this.toolCardRequests.has(requestKey)) {
      this.toolCardStates.delete(index);
    }
    if (this.toolCardRequests.has(requestKey)) {
      host.replaceChildren(element("p", "conversation-tool-card-placeholder", "Loading tool details…"));
      return;
    }
    this.toolCardRequests.add(requestKey);
    const loading: ToolCardState = { status: "loading", rows: [], callId: null, errorState: null };
    this.toolCardStates.set(index, loading);
    this.renderToolCard(host, index, loading);
    void (async () => {
      try {
        const state = await this.buildToolCard(block, request);
        if (!this.isCurrentToolProjection(request)) return;
        this.toolCardStates.set(index, state);
        const liveHost = this.windowList?.querySelector<HTMLElement>(`[data-conversation-block-index="${index}"] .conversation-tool-card`);
        if (liveHost) this.renderToolCard(liveHost, index, state);
        this.refreshToolCardRelations();
      } catch (error) {
        if (!this.isCurrentToolProjection(request)) return;
        const state: ToolCardState = {
          status: "unavailable",
          rows: [],
          callId: null,
          errorState: null,
          reason: isSessionError(error) ? "The session changed while loading this tool block." : errorMessage(error)
        };
        this.toolCardStates.set(index, state);
        const liveHost = this.windowList?.querySelector<HTMLElement>(`[data-conversation-block-index="${index}"] .conversation-tool-card`);
        if (liveHost) this.renderToolCard(liveHost, index, state);
        if (isSessionError(error)) this.onError(error);
      } finally {
        this.toolCardRequests.delete(requestKey);
        if (this.toolCardStates.get(index)?.status === "loading") {
          this.toolCardStates.delete(index);
          if (this.isCurrentProjection(request.context, request.generation, request.requestGeneration, request.pageIdentity, request.candidateId, request.style)) {
            queueMicrotask(() => this.ensureVisibleInline(this.windowVisibleStart, this.windowVisibleEnd));
          }
        }
      }
    })();
  }

  private toolCardRequestKey(request: ToolCardRequest): string {
    return `${request.generation}:${request.requestGeneration}:${request.style}:${request.pageIdentity}:${request.index}`;
  }

  private isCurrentToolProjection(request: ToolCardRequest): boolean {
    return this.isCurrentProjection(request.context, request.generation, request.requestGeneration, request.pageIdentity, request.candidateId, request.style)
      && this.isPanelVisible() && this.windowList !== null
      && request.index >= this.windowVisibleStart && request.index < this.windowVisibleEnd;
  }

  private async buildToolCard(block: ConversationBlock, request: ToolCardRequest): Promise<ToolCardState> {
    const rows: ToolCardRow[] = [];
    let callId: string | null = null;
    if (block.category === "toolCall" || block.category === "toolUse") {
      const nameRef = block.openaiRefs?.name ?? block.anthropicRefs?.name;
      const callIdRef = block.openaiRefs?.callId ?? block.anthropicRefs?.id;
      if (nameRef) await this.appendCardPayload("Name", nameRef, request, rows);
      else rows.push({ label: "Name", value: "Unavailable", ref: null, mode: "status" });
      if (callIdRef) callId = await this.appendCardPayload("Call ID", callIdRef, request, rows);
      else rows.push({ label: "Call ID", value: "Unavailable", ref: null, mode: "status" });
      const payloadRef = block.openaiRefs?.arguments ?? block.anthropicRefs?.input;
      if (payloadRef) await this.appendCardPayload(block.category === "toolUse" ? "Input" : "Arguments", payloadRef, request, rows);
      else rows.push({ label: block.category === "toolUse" ? "Input" : "Arguments", value: "Unavailable; original source is preserved below.", ref: block.source, mode: "status" });
    } else {
      const anthropic = block.anthropicRefs;
      const openai = block.openaiRefs;
      const explicitId = anthropic?.toolUseId ?? openai?.callId;
      let sourceNode: NodeDto | null = null;
      const source = explicitId ?? block.source;
      if (source) sourceNode = await this.cardNode(source, request);
      const sourceLabel = sourceNode?.label ?? "";
      if (explicitId || sourceLabel === "tool_call_id" || sourceLabel === "tool_use_id") {
        const idRef = explicitId ?? block.source;
        if (idRef) callId = await this.appendCardPayload("Tool call ID", idRef, request, rows, sourceNode ?? undefined);
      }
      const contentRef = anthropic?.content ?? openai?.text
        ?? (sourceLabel === "tool_call_id" || sourceLabel === "tool_use_id" ? null : block.source);
      if (contentRef) await this.appendCardPayload("Result", contentRef, request, rows, contentRef.nodeId === sourceNode?.id ? sourceNode ?? undefined : undefined);
      else rows.push({ label: "Result", value: "Unavailable; original source is preserved below.", ref: block.source, mode: "status" });
    }
    const errorState = block.category === "toolResult" ? await this.cardErrorState(block, request) : null;
    return { status: "ready", rows, callId, errorState };
  }

  private async cardNode(ref: SourceRef, request: ToolCardRequest): Promise<NodeDto> {
    if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
    const value = await this.invokeRequest<unknown>("get_node_summary", {
      nodeId: ref.nodeId,
      sessionRevision: request.context.sessionRevision,
      scopeId: null
    });
    if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
    const node = validateNode(value, request.context.sourceSize);
    if (!node || node.id !== ref.nodeId || node.spanStart !== ref.spanStart || node.spanEnd !== ref.spanEnd) {
      throw new Error("The tool card source summary response was invalid.");
    }
    return node;
  }

  private async appendCardPayload(
    label: string,
    ref: SourceRef,
    request: ToolCardRequest,
    rows: ToolCardRow[],
    knownNode?: NodeDto
  ): Promise<string | null> {
    const node = knownNode ?? await this.cardNode(ref, request);
    if (node.kind === "string") {
      const value = await this.cardStringValue(ref, node, request);
      rows.push({ label, value: value.text, ref, mode: value.mode, truncated: value.truncated });
      if (value.nestedRows) rows.push(...value.nestedRows);
      return value.truncated ? null : value.text;
    }
    if (node.kind === "object" || node.kind === "array") {
      const children = await this.cardChildren(ref, request);
      rows.push({
        label,
        value: `${node.kind === "object" ? "Object" : "Array"} · ${node.childCount.toLocaleString()} ${node.kind === "object" ? "fields" : "items"}${children.hasMore ? " · first 32 shown" : ""}`,
        ref,
        mode: "structure",
        truncated: children.hasMore
      });
      for (const child of children.nodes) {
        if (label === "Result" && child.kind === "object") {
          const textRow = await this.toolResultTextBlock(child, request);
          if (textRow) {
            rows.push(textRow);
            continue;
          }
        }
        rows.push({
          label: `${label}.${child.label}`,
          value: child.valuePreview ?? `${child.kind} Node ${child.id}`,
          ref: { nodeId: child.id, spanStart: child.spanStart, spanEnd: child.spanEnd },
          mode: child.kind === "object" || child.kind === "array" ? "structure" : "plain",
          truncated: child.valueHasMore
        });
      }
      return null;
    }
    rows.push({ label, value: node.valuePreview ?? `${node.kind} Node ${node.id}`, ref, mode: "plain", truncated: node.valueHasMore });
    return node.valuePreview;
  }

  private async cardStringValue(ref: SourceRef, node: NodeDto, request: ToolCardRequest): Promise<ToolStringValue> {
    let text = node.valuePreview ?? "";
    let mode: "plain" | "code" = "plain";
    let truncated = node.valueHasMore;
    let nestedRows: ToolCardRow[] | undefined;
    let readUnavailable = false;
    try {
      if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
      const metricsValue = await this.invokeRequest<unknown>("get_string_metrics", {
        nodeId: ref.nodeId,
        sessionRevision: request.context.sessionRevision,
        scopeId: null
      });
      const metrics = validateInlineMetrics(metricsValue);
      if (!metrics) throw new Error("The tool card string metrics response was invalid.");
      if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
      const detectionValue = await this.invokeRequest<unknown>("get_string_detection", {
        nodeId: ref.nodeId,
        sessionRevision: request.context.sessionRevision,
        scopeId: null
      });
      const detection = validateInlineDetection(detectionValue);
      if (detection?.semanticType === "nestedJson" || detection?.semanticType === "code") mode = "code";
      if (detection?.semanticType === "nestedJson") {
        nestedRows = await this.nestedPreviewRow(ref, request);
      }
      if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
      if (metrics.decodedBytes === 0) {
        text = "";
        truncated = false;
      } else if (request.textBudgetRemaining === 0) {
        truncated = true;
      } else {
        const length = Math.min(TOOL_READ_BYTES, metrics.decodedBytes, request.textBudgetRemaining);
        const value = await this.invokeRequest<unknown>("read_decoded_text", {
          nodeId: ref.nodeId,
          offset: 0,
          length,
          sessionRevision: request.context.sessionRevision,
          scopeId: null
        });
        const chunk = validateInlineChunk(value, metrics.decodedBytes, length);
        if (!chunk) throw new Error("The tool card decoded text response was invalid.");
        text = chunk.text;
        const readBytes = new TextEncoder().encode(chunk.text).byteLength;
        request.textBudgetRemaining = Math.max(0, request.textBudgetRemaining - readBytes);
        truncated = metrics.decodedBytes > length || chunk.hasMore;
      }
    } catch (error) {
      if (isSessionError(error) || !this.isCurrentToolProjection(request)) throw error;
      readUnavailable = true;
    }
    return { text, mode, truncated: truncated || readUnavailable, nestedRows };
  }

  private async nestedPreviewRow(ref: SourceRef, request: ToolCardRequest): Promise<ToolCardRow[] | undefined> {
    if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
    const value = await this.invokeRequest<unknown>("preview_nested_json", {
      nodeId: ref.nodeId,
      maxDepth: 3,
      sessionRevision: request.context.sessionRevision
    });
    if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
    const preview = validateNestedPreview(value, request.context.sessionRevision);
    if (!preview) throw new Error("The nested JSON preview response was invalid.");
    const rows: ToolCardRow[] = [{
      label: "Nested JSON",
      value: `${preview.root.kind === "object" ? "Object" : "Array"} · ${preview.root.childCount.toLocaleString()} fields/items${preview.hasMore ? " · first 32 shown" : ""}`,
      ref: null,
      mode: "structure",
      truncated: preview.hasMore
    }];
    for (const child of preview.children) {
      rows.push({
        label: `  ${child.label}`,
        value: child.valuePreview ?? `${child.kind} Node ${child.id}`,
        ref: null,
        mode: child.kind === "object" || child.kind === "array" ? "structure" : "plain",
        truncated: child.valueHasMore
      });
    }
    return rows;
  }

  private async cardChildren(ref: SourceRef, request: ToolCardRequest): Promise<CardChildren> {
    if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
    const value = await this.invokeRequest<unknown>("get_children", {
      nodeId: ref.nodeId,
      cursor: 0,
      limit: TOOL_CHILD_LIMIT,
      sessionRevision: request.context.sessionRevision,
      scopeId: null
    });
    if (!this.isCurrentToolProjection(request)) throw new Error("Tool card is no longer visible.");
    const page = validateChildrenPage(value, 0, request.context.sourceSize);
    if (!page) throw new Error("The tool card children response was invalid.");
    const nodes = page.nodes.filter((node) => refWithin(nodeRef(node), ref.spanStart, ref.spanEnd));
    if (nodes.length !== page.nodes.length) throw new Error("The tool card children escaped its source scope.");
    return { nodes: nodes.slice(0, TOOL_CHILD_LIMIT), hasMore: page.hasMore || nodes.length > TOOL_CHILD_LIMIT };
  }

  private async cardErrorState(block: ConversationBlock, request: ToolCardRequest): Promise<"ok" | "error" | "missing" | "invalid" | "unloaded"> {
    const probe = block.anthropicRefs?.block ?? block.message ?? block.source;
    if (!probe) return "missing";
    const children = await this.cardChildren(probe, request);
    const marker = children.nodes.find((node) => node.label === "is_error");
    if (!marker) return children.hasMore ? "unloaded" : "missing";
    if (marker.kind === "false") return "ok";
    if (marker.kind === "true") return "error";
    return "invalid";
  }

  private renderToolCard(host: HTMLElement, index: number, state: ToolCardState): void {
    host.replaceChildren();
    if (state.status === "loading") {
      host.append(element("p", "conversation-tool-card-placeholder", "Loading tool details…"));
      return;
    }
    if (state.status === "unavailable") {
      host.append(element("p", "conversation-tool-card-placeholder", state.reason || "Tool details unavailable; use Raw or Tree."));
      return;
    }
    const heading = element("div", "conversation-tool-card-heading");
    heading.append(element("strong", "", "Tool details"));
    const block = this.page?.blocks[index];
    if (block) heading.append(element("span", "conversation-tool-card-kind", block.category));
    if (state.errorState === "ok") heading.append(element("span", "conversation-tool-card-status is-ok", "is_error: false"));
    if (state.errorState === "error") heading.append(element("span", "conversation-tool-card-status is-error", "is_error: true"));
    if (state.errorState === "missing") heading.append(element("span", "conversation-tool-card-status", "is_error: missing"));
    if (state.errorState === "invalid") heading.append(element("span", "conversation-tool-card-status is-error", "is_error: invalid"));
    if (state.errorState === "unloaded") heading.append(element("span", "conversation-tool-card-status", "is_error: unavailable · first 32 fields"));
    host.append(heading);
    if (state.callId) {
      const related = this.loadedCallLabel(index, state.callId);
      host.append(element("p", "conversation-tool-card-relation", related?.status === "confirmed"
        ? `Related call confirmed in loaded page: ${related.label}`
        : related?.status === "ambiguous"
          ? `Related call is ambiguous among loaded calls: ${related.label}`
          : "Related call not confirmed in the loaded page."));
    }
    const rows = element("div", "conversation-tool-card-rows");
    this.clearToolCardRefs(index);
    state.rows.forEach((row, rowIndex) => {
      const rowElement = element("div", "conversation-tool-card-row");
      rowElement.append(element("span", "conversation-tool-card-label", row.label));
      const value = row.mode === "code" ? element("pre", "conversation-tool-card-value conversation-tool-card-code", row.value)
        : element("span", "conversation-tool-card-value", row.value);
      if (row.truncated) value.append(element("span", "conversation-tool-card-truncated", " · partial"));
      rowElement.append(value);
      if (row.ref) {
        const refKey = `${index}:${rowIndex}`;
        this.toolCardRefs.set(refKey, row.ref);
        const actions = element("span", "conversation-tool-card-actions");
        const raw = this.blockActionButton("Raw", "card-raw", index);
        raw.dataset.conversationCardRef = refKey;
        const tree = this.blockActionButton("Tree", "card-tree", index);
        tree.dataset.conversationCardRef = refKey;
        actions.append(raw, tree);
        if (row.mode === "plain" || row.mode === "code") {
          const content = this.blockActionButton("Open content", "card-content", index);
          content.dataset.conversationCardRef = refKey;
          actions.append(content);
        }
        rowElement.append(actions);
      }
      rows.append(rowElement);
    });
    host.append(rows);
  }

  private clearToolCardRefs(index: number): void {
    const prefix = `${index}:`;
    for (const key of this.toolCardRefs.keys()) {
      if (key.startsWith(prefix)) this.toolCardRefs.delete(key);
    }
  }

  private loadedCallLabel(resultIndex: number, callId: string): LoadedCallMatch | null {
    const matches: string[] = [];
    for (const [index, state] of this.toolCardStates) {
      if (index === resultIndex || state.status !== "ready" || state.callId !== callId) continue;
      const block = this.page?.blocks[index];
      if (block && (block.category === "toolCall" || block.category === "toolUse")) matches.push(`block ${index + 1}`);
    }
    if (matches.length === 1) return { status: "confirmed", label: matches[0] };
    if (matches.length > 1) return { status: "ambiguous", label: matches.join(", ") };
    return null;
  }

  private async toolResultTextBlock(child: NodeDto, request: ToolCardRequest): Promise<ToolCardRow | null> {
    const children = await this.cardChildren(nodeRef(child), request);
    const typeNode = children.nodes.find((node) => node.label === "type");
    if (!typeNode || typeNode.kind !== "string" || typeNode.valuePreview !== "text") return null;
    const textNode = children.nodes.find((node) => node.label === "text" && node.kind === "string");
    if (!textNode) return null;
    const textRef = nodeRef(textNode);
    const value = await this.cardStringValue(textRef, textNode, request);
    return {
      label: `Result.${child.label}.text`,
      value: value.text,
      ref: textRef,
      mode: value.mode,
      truncated: value.truncated
    };
  }

  private refreshToolCardRelations(): void {
    for (const [index, state] of this.toolCardStates) {
      if (state.status !== "ready" || !state.callId || !this.windowList) continue;
      const host = this.windowList.querySelector<HTMLElement>(`[data-conversation-block-index="${index}"] .conversation-tool-card`);
      if (host) this.renderToolCard(host, index, state);
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

  private inlineSourceFor(block: ConversationBlock): SourceRef | null {
    const anthropic = block.anthropicRefs;
    const openai = block.openaiRefs;
    if (block.kind === "system") return anthropic?.text ?? block.source;
    if (anthropic) {
      return anthropic.text ?? anthropic.thinking ?? anthropic.data ?? anthropic.content;
    }
    if (openai?.text) return openai.text;
    if (isContentCategory(block.category)) return block.source;
    return null;
  }

  private inlineRequestKey(pageIdentity: string, source: SourceRef): string {
    return `${this.generation}:${this.requestGeneration}:${this.style}:${pageIdentity}:${source.nodeId}:${source.spanStart}:${source.spanEnd}`;
  }

  private isCurrentInlineHost(
    context: ConversationContext,
    generation: number,
    requestGeneration: number,
    pageIdentity: string,
    candidateId: number | null,
    style: ConversationStyle,
    index: number,
    source: SourceRef,
    host: HTMLElement
  ): boolean {
    if (!this.isCurrentProjection(context, generation, requestGeneration, pageIdentity, candidateId, style)
      || !this.isPanelVisible() || !this.windowList || index < this.windowVisibleStart || index >= this.windowVisibleEnd || !host.isConnected) return false;
    const row = this.windowList.querySelector<HTMLElement>(`[data-conversation-block-index="${index}"]`);
    const currentHost = row?.querySelector<HTMLElement>(".conversation-inline-content");
    const currentSource = this.page?.blocks[index] ? this.inlineSourceFor(this.page.blocks[index]) : null;
    return currentHost === host && currentSource?.nodeId === source.nodeId
      && currentSource.spanStart === source.spanStart && currentSource.spanEnd === source.spanEnd;
  }

  private loadInlineContent(index: number, host: HTMLElement, source: SourceRef, summaryHost: HTMLElement, opaque: boolean): void {
    const context = this.context;
    const pageIdentity = cursorKey(this.page?.pageStart ?? null);
    const candidateId = this.selectedCandidate?.node.id ?? null;
    const style = this.style;
    const requestGeneration = this.requestGeneration;
    const generation = this.generation;
    const requestKey = this.inlineRequestKey(pageIdentity, source);
    const existing = this.inlineStates.get(source.nodeId);
    if (existing && existing.status !== "loading") {
      this.renderInlineState(host, existing);
      return;
    }
    if (!context) return;
    if (existing?.status === "loading" && !this.inlineRequests.has(requestKey)) {
      this.inlineStates.delete(source.nodeId);
    }
    if (this.inlineRequests.has(requestKey)) {
      if (!existing) this.inlineStates.set(source.nodeId, { status: "loading" });
      host.replaceChildren(element("p", "conversation-inline-placeholder", "Loading inline content…"));
      return;
    }
    this.inlineRequests.add(requestKey);
    const loadingState: InlineState = { status: "loading" };
    this.inlineStates.set(source.nodeId, loadingState);
    this.renderInlineState(host, loadingState);
    void (async () => {
      try {
        const summaryValue = await this.invokeRequest<unknown>("get_node_summary", {
          nodeId: source.nodeId,
          sessionRevision: context.sessionRevision,
          scopeId: null
        });
        const summaryNode = validateNode(summaryValue, context.sourceSize);
        if (!summaryNode || summaryNode.id !== source.nodeId || summaryNode.spanStart !== source.spanStart || summaryNode.spanEnd !== source.spanEnd) {
          throw new Error("The inline source summary response was invalid.");
        }
        if (!this.isCurrentInlineHost(context, generation, requestGeneration, pageIdentity, candidateId, style, index, source, host)) return;
        summaryHost.textContent = summaryNode.valuePreview === null ? `${summaryNode.kind} Node ${summaryNode.id}` : summaryNode.valuePreview.slice(0, 240);
        this.blockSummaries.set(source.nodeId, summaryHost.textContent);
        if (summaryNode.kind !== "string") {
          const state: InlineState = { status: "unavailable", opaque, reason: "Structured content stays source-preserving; use Tree or Open content." };
          this.inlineStates.set(source.nodeId, state);
          this.renderInlineState(host, state);
          return;
        }
        if (!this.isCurrentInlineHost(context, generation, requestGeneration, pageIdentity, candidateId, style, index, source, host)) return;
        const metricsValue = await this.invokeRequest<unknown>("get_string_metrics", {
          nodeId: source.nodeId,
          sessionRevision: context.sessionRevision,
          scopeId: null
        });
        const metrics = validateInlineMetrics(metricsValue);
        if (!metrics) throw new Error("The inline string metrics response was invalid.");
        if (!this.isCurrentInlineHost(context, generation, requestGeneration, pageIdentity, candidateId, style, index, source, host)) return;
        let detection: StringDetection | undefined;
        if (!opaque) {
          const detectionValue = await this.invokeRequest<unknown>("get_string_detection", {
            nodeId: source.nodeId,
            sessionRevision: context.sessionRevision,
            scopeId: null
          });
          detection = validateInlineDetection(detectionValue) ?? undefined;
          if (!detection) throw new Error("The inline string detection response was invalid.");
          if (!this.isCurrentInlineHost(context, generation, requestGeneration, pageIdentity, candidateId, style, index, source, host)) return;
        }
        const length = Math.min(INLINE_READ_BYTES, metrics.decodedBytes);
        const chunk = metrics.decodedBytes === 0
          ? { text: "", hasMore: false }
          : await this.readInlineChunk(context, generation, requestGeneration, pageIdentity, candidateId, style, index, source, host, length, metrics.decodedBytes);
        const partial = metrics.decodedBytes > INLINE_READ_BYTES || chunk.hasMore;
        const state: InlineState = {
          status: partial ? "partial" : "ready",
          text: chunk.text,
          metrics,
          detection,
          opaque,
          reason: partial ? `Showing the first ${INLINE_READ_BYTES.toLocaleString()} decoded bytes.` : undefined
        };
        if (!this.isCurrentInlineHost(context, generation, requestGeneration, pageIdentity, candidateId, style, index, source, host)) return;
        this.inlineStates.set(source.nodeId, state);
        this.renderInlineState(host, state);
      } catch (error) {
        if (!this.isCurrentInlineHost(context, generation, requestGeneration, pageIdentity, candidateId, style, index, source, host)) return;
        const state: InlineState = {
          status: "unavailable",
          opaque,
          reason: isSessionError(error) ? "The session changed while loading this content." : errorMessage(error)
        };
        this.inlineStates.set(source.nodeId, state);
        this.renderInlineState(host, state);
        if (isSessionError(error)) this.onError(error);
      } finally {
        this.inlineRequests.delete(requestKey);
        if (this.inlineStates.get(source.nodeId)?.status === "loading") {
          this.inlineStates.delete(source.nodeId);
          if (this.isCurrentProjection(context, generation, requestGeneration, pageIdentity, candidateId, style)) {
            queueMicrotask(() => this.ensureVisibleInline(this.windowVisibleStart, this.windowVisibleEnd));
          }
        }
      }
    })();
  }

  private renderInlineState(host: HTMLElement, state: InlineState): void {
    if (this.renderedInlineStates.get(host) === state) return;
    this.renderedInlineStates.set(host, state);
    host.replaceChildren();
    if (state.status === "loading") {
      host.append(element("p", "conversation-inline-placeholder", "Loading inline content…"));
      return;
    }
    if (state.status === "unavailable") {
      host.append(element("p", "conversation-inline-placeholder", state.reason || "Inline content is unavailable; use Open content."));
      return;
    }
    if (state.status === "partial") {
      const note = element("p", "conversation-inline-partial", `${state.reason || "Partial source preview."} Use Open content for the complete value.`);
      const raw = element("pre", "conversation-inline-raw", state.text || "");
      raw.setAttribute("aria-label", "Partial decoded source");
      host.append(note, raw);
      return;
    }
    const text = state.text || "";
    const type = state.opaque ? "plainText" : state.detection?.semanticType;
    if (type === "markdown") {
      const fragment = renderSafeMarkdown(text);
      if (fragment) {
        const content = element("div", "conversation-inline-markdown");
        content.append(fragment);
        host.append(content);
        return;
      }
    }
    if (type === "code" || type === "nestedJson") {
      const rendered = renderCode(text, type === "nestedJson" ? "json" : null);
      const content = element("div", "conversation-inline-code");
      content.append(rendered.fragment);
      host.append(content);
      return;
    }
    const plain = element("pre", "conversation-inline-plain", text);
    plain.setAttribute("aria-label", "Decoded Conversation content");
    host.append(plain);
  }

  private async readInlineChunk(
    context: ConversationContext,
    generation: number,
    requestGeneration: number,
    pageIdentity: string,
    candidateId: number | null,
    style: ConversationStyle,
    index: number,
    source: SourceRef,
    host: HTMLElement,
    length: number,
    totalBytes: number
  ): Promise<{ text: string; hasMore: boolean }> {
    if (!this.isCurrentInlineHost(context, generation, requestGeneration, pageIdentity, candidateId, style, index, source, host)) {
      throw new Error("Inline content is no longer visible.");
    }
    const chunkValue = await this.invokeRequest<unknown>("read_decoded_text", {
      nodeId: source.nodeId,
      offset: 0,
      length,
      sessionRevision: context.sessionRevision,
      scopeId: null
    });
    const chunk = validateInlineChunk(chunkValue, totalBytes, length);
    if (!chunk) throw new Error("The inline decoded text response was invalid.");
    return chunk;
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

function isToolBlock(block: ConversationBlock): boolean {
  return block.category === "toolCall" || block.category === "toolUse" || block.category === "toolResult"
    || block.category === "tool" && (block.openaiRefs !== null || block.anthropicRefs !== null);
}

function nodeRef(node: NodeDto): SourceRef {
  return { nodeId: node.id, spanStart: node.spanStart, spanEnd: node.spanEnd };
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

function validateInlineMetrics(value: unknown): StringMetrics | null {
  const object = record(value);
  if (!object || Object.keys(object).length !== 3
    || !Object.keys(object).every((key) => key === "decodedBytes" || key === "characterCount" || key === "lineCount")) return null;
  const decodedBytes = safeNumber(object.decodedBytes);
  const characterCount = safeNumber(object.characterCount);
  const lineCount = safeNumber(object.lineCount);
  if (decodedBytes === null || characterCount === null || lineCount === null || lineCount < 1) return null;
  return { decodedBytes, characterCount, lineCount };
}

function validateInlineDetection(value: unknown): StringDetection | null {
  const object = record(value);
  const semanticType = object?.semanticType;
  if (object?.detectionSource !== "contentDetected"
    || (semanticType !== "plainText" && semanticType !== "markdown" && semanticType !== "code"
      && semanticType !== "nestedJson" && semanticType !== "html")) return null;
  return { semanticType };
}

function validateNestedPreview(value: unknown, sessionRevision: number): { parsedBytes: number; root: NodeDto; children: NodeDto[]; hasMore: boolean } | null {
  const object = record(value);
  const parsedBytes = safeNumber(object?.parsedBytes);
  const responseRevision = safeNumber(object?.sessionRevision);
  const hasMore = object?.hasMore;
  if (parsedBytes === null || parsedBytes === 0 || parsedBytes > 2 * 1024 * 1024
    || responseRevision !== sessionRevision || typeof hasMore !== "boolean" || !Array.isArray(object?.children)) return null;
  const root = validateNode(object?.root, parsedBytes);
  if (!root || root.kind !== "object" && root.kind !== "array") return null;
  if (object.children.length > TOOL_CHILD_LIMIT) return null;
  const children = object.children.map((child) => validateNode(child, parsedBytes));
  if (children.some((child): child is null => child === null)) return null;
  if ((children as NodeDto[]).some((child) => !refWithin(nodeRef(child), root.spanStart, root.spanEnd))) return null;
  return { parsedBytes, root, children: children as NodeDto[], hasMore };
}

function validateInlineChunk(value: unknown, totalBytes: number, requestedLength: number): { text: string; hasMore: boolean } | null {
  const object = record(value);
  if (!object || safeNumber(object.start) !== 0 || typeof object.text !== "string" || typeof object.hasMore !== "boolean") return null;
  const nextOffset = object.nextOffset === null ? null : safeNumber(object.nextOffset);
  if (object.nextOffset !== null && nextOffset === null) return null;
  const bytes = new TextEncoder().encode(object.text).byteLength;
  if (bytes > requestedLength) return null;
  if (object.hasMore) {
    if (nextOffset === null || nextOffset !== bytes || nextOffset <= 0) return null;
  } else if (nextOffset !== null || bytes !== totalBytes) {
    return null;
  }
  return { text: object.text, hasMore: object.hasMore };
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
