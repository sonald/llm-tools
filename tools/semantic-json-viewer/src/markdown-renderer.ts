import { marked } from "marked";
import type { Token, Tokens } from "marked";
import { renderCode } from "./code-renderer";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;
const MAX_RENDER_MS = 100;

type Parent = DocumentFragment | HTMLElement;

class RenderBudget {
  private readonly deadline: number;
  private nodeCount = 0;

  constructor(start: number) {
    this.deadline = start + MAX_RENDER_MS;
  }

  check(): void {
    if (performance.now() >= this.deadline) throw new Error("Markdown rendering exceeded its time budget.");
  }

  element(parent: Parent, name: string, className?: string): HTMLElement {
    this.check();
    this.reserveNode();
    const element = document.createElement(name);
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  text(parent: Parent, value: string): void {
    this.check();
    if (!value) return;
    this.reserveNode();
    parent.append(document.createTextNode(value));
  }

  appendFragment(parent: Parent, fragment: DocumentFragment): void {
    this.check();
    let nodes = fragment.querySelectorAll("*").length;
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes += 1;
    if (this.nodeCount + nodes > MAX_NODES) throw new Error("Markdown rendering exceeded its node budget.");
    this.nodeCount += nodes;
    parent.append(fragment);
  }

  private reserveNode(): void {
    if (this.nodeCount >= MAX_NODES) throw new Error("Markdown rendering exceeded its node budget.");
    this.nodeCount += 1;
  }
}

class SafeMarkdownRenderer {
  private readonly budget: RenderBudget;

  constructor(budget: RenderBudget) {
    this.budget = budget;
  }

  render(tokens: Token[]): DocumentFragment {
    const fragment = document.createDocumentFragment();
    this.renderTokens(tokens, fragment, 0);
    this.budget.check();
    return fragment;
  }

  private renderTokens(tokens: Token[], parent: Parent, depth: number): void {
    this.enter(depth);
    for (const token of tokens) {
      this.budget.check();
      this.renderToken(token, parent, depth);
    }
  }

  private renderToken(token: Token, parent: Parent, depth: number): void {
    this.budget.check();
    switch (token.type) {
      case "heading": {
        const heading = this.budget.element(parent, headingName(token.depth));
        this.renderInline(nestedTokens(token.tokens), heading, depth + 1);
        return;
      }
      case "paragraph": {
        const paragraph = this.budget.element(parent, "p");
        this.renderInline(nestedTokens(token.tokens), paragraph, depth + 1);
        return;
      }
      case "blockquote": {
        const blockquote = this.budget.element(parent, "blockquote");
        this.renderTokens(nestedTokens(token.tokens), blockquote, depth + 1);
        return;
      }
      case "list": {
        const list = this.budget.element(parent, token.ordered ? "ol" : "ul");
        if (token.ordered && token.start !== "") {
          if (!Number.isSafeInteger(token.start)) throw new Error("Invalid Markdown ordered-list start.");
          (list as HTMLOListElement).start = token.start;
        }
        for (const item of token.items) {
          this.budget.check();
          this.renderToken(item, list, depth + 1);
        }
        return;
      }
      case "list_item": {
        const item = this.budget.element(parent, "li");
        this.renderTokens(nestedTokens(token.tokens), item, depth + 1);
        return;
      }
      case "table": {
        const table = this.budget.element(parent, "table");
        const head = this.budget.element(table, "thead");
        const headRow = this.budget.element(head, "tr");
        for (const cell of token.header) {
          this.budget.check();
          this.renderTableCell(cell, headRow, depth + 1);
        }
        const body = this.budget.element(table, "tbody");
        for (const row of token.rows) {
          this.budget.check();
          const bodyRow = this.budget.element(body, "tr");
          for (const cell of row) {
            this.budget.check();
            this.renderTableCell(cell, bodyRow, depth + 1);
          }
        }
        return;
      }
      case "code": {
        const rendered = renderCode(token.text, token.lang);
        this.budget.appendFragment(parent, rendered.fragment);
        return;
      }
      case "br":
        this.budget.element(parent, "br");
        return;
      case "hr":
        this.budget.element(parent, "hr");
        return;
      case "strong": {
        const strong = this.budget.element(parent, "strong");
        this.renderInline(nestedTokens(token.tokens), strong, depth + 1);
        return;
      }
      case "em": {
        const em = this.budget.element(parent, "em");
        this.renderInline(nestedTokens(token.tokens), em, depth + 1);
        return;
      }
      case "del": {
        const del = this.budget.element(parent, "span", "safe-markdown-del");
        this.renderInline(nestedTokens(token.tokens), del, depth + 1);
        return;
      }
      case "codespan": {
        const code = this.budget.element(parent, "code");
        this.budget.text(code, token.text);
        return;
      }
      case "link": {
        const link = this.budget.element(parent, "span", "safe-markdown-link");
        this.renderInline(nestedTokens(token.tokens), link, depth + 1);
        this.budget.text(link, ` (${token.href})`);
        return;
      }
      case "image":
        this.budget.text(parent, `[image: ${token.text}] (${token.href})`);
        return;
      case "checkbox":
        this.budget.text(parent, token.checked ? "☑ " : "☐ ");
        return;
      case "text":
        if (Array.isArray(token.tokens) && token.tokens.length > 0) {
          this.renderInline(token.tokens, parent, depth + 1);
        } else {
          this.budget.text(parent, token.text);
        }
        return;
      case "escape":
        this.budget.text(parent, token.text);
        return;
      case "html":
        this.budget.text(parent, token.raw);
        return;
      case "space":
      case "def":
        return;
      default:
        this.budget.text(parent, rawText(token));
    }
  }

  private renderInline(tokens: Token[], parent: Parent, depth: number): void {
    this.renderTokens(tokens, parent, depth);
  }

  private renderTableCell(cell: Tokens.TableCell, parent: Parent, depth: number): void {
    const align = tableAlignment(cell.align);
    const element = this.budget.element(parent, cell.header ? "th" : "td", align ? `safe-markdown-align-${align}` : undefined);
    this.renderInline(cell.tokens, element, depth + 1);
  }

  private enter(depth: number): void {
    this.budget.check();
    if (depth > MAX_DEPTH) throw new Error("Markdown rendering exceeded its depth budget.");
  }
}

export function renderSafeMarkdown(source: string): DocumentFragment | null {
  const start = performance.now();
  try {
    if (typeof source !== "string") return null;
    if (new TextEncoder().encode(source).byteLength > MAX_INPUT_BYTES) return null;
    const budget = new RenderBudget(start);
    const tokens = marked.lexer(source, { gfm: true, breaks: false, pedantic: false });
    budget.check();
    return new SafeMarkdownRenderer(budget).render(tokens);
  } catch {
    return null;
  }
}

function headingName(depth: number): "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  if (!Number.isInteger(depth) || depth < 1 || depth > 6) throw new Error("Invalid Markdown heading depth.");
  return `h${depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
}

function rawText(token: Token): string {
  const raw = (token as { raw?: unknown }).raw;
  if (typeof raw !== "string") throw new Error("Markdown token has no raw text.");
  return raw;
}

function nestedTokens(value: unknown): Token[] {
  if (!Array.isArray(value)) throw new Error("Markdown token has no nested tokens.");
  return value as Token[];
}

function tableAlignment(value: unknown): "left" | "center" | "right" | null {
  if (value === null) return null;
  if (value === "left" || value === "center" || value === "right") return value;
  throw new Error("Invalid Markdown table alignment.");
}
