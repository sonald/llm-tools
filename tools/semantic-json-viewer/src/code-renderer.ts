import Prism from "prismjs/components/prism-core";
import type { PrismToken, PrismTokenValue } from "prismjs/components/prism-core";

Prism.manual = true;
Prism.disableWorkerMessageHandler = true;

import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-go";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";

export type CodeLanguage =
  | "python"
  | "javascript"
  | "typescript"
  | "rust"
  | "c"
  | "cpp"
  | "java"
  | "go"
  | "shell"
  | "sql"
  | "json"
  | "yaml";

export type CodeRenderReason =
  | "generic"
  | "sizeLimit"
  | "lineLimit"
  | "timeLimit"
  | "nodeLimit"
  | "rendererError";

export type CodeRenderResult = {
  fragment: DocumentFragment;
  language: CodeLanguage | null;
  presentation: "highlighted" | "plain";
  reason: CodeRenderReason | null;
};

const LANGUAGE_ALIASES: Readonly<Record<string, CodeLanguage>> = {
  python: "python",
  py: "python",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  rust: "rust",
  rs: "rust",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  go: "go",
  golang: "go",
  shell: "shell",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml"
};

const PRISM_LANGUAGE: Readonly<Record<CodeLanguage, string>> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  rust: "rust",
  c: "c",
  cpp: "cpp",
  java: "java",
  go: "go",
  shell: "bash",
  sql: "sql",
  json: "json",
  yaml: "yaml"
};

const TOKEN_CLASS_BY_NAME: Readonly<Record<string, string>> = {
  keyword: "sjv-token-keyword",
  string: "sjv-token-string",
  comment: "sjv-token-comment",
  number: "sjv-token-number",
  operator: "sjv-token-operator",
  function: "sjv-token-function",
  "class-name": "sjv-token-class-name",
  char: "sjv-token-char",
  boolean: "sjv-token-boolean",
  punctuation: "sjv-token-punctuation",
  property: "sjv-token-property",
  tag: "sjv-token-tag",
  "attr-name": "sjv-token-attr-name",
  "attr-value": "sjv-token-attr-value",
  regex: "sjv-token-regex",
  builtin: "sjv-token-builtin",
  constant: "sjv-token-constant",
  symbol: "sjv-token-symbol",
  inserted: "sjv-token-inserted",
  deleted: "sjv-token-deleted",
  important: "sjv-token-important",
  bold: "sjv-token-bold",
  italic: "sjv-token-italic",
  variable: "sjv-token-variable",
  namespace: "sjv-token-namespace",
  parameter: "sjv-token-parameter",
  interpolation: "sjv-token-interpolation",
  directive: "sjv-token-directive",
  decorator: "sjv-token-decorator",
  annotation: "sjv-token-annotation",
  selector: "sjv-token-selector",
  "plain-text": "sjv-token-plain-text",
  generic: "sjv-token-generic"
};

const DETECTOR_MAX_BYTES = 256 * 1024;
const HIGHLIGHT_MAX_BYTES = 1024 * 1024;
const HIGHLIGHT_MAX_LINES = 20_000;
const MAX_RENDER_MS = 100;
const MAX_DOM_NODES = 10_000;
const MAX_TOKEN_DEPTH = 32;

type RenderBudget = {
  deadline: number;
  nodes: number;
  reserve: () => void;
  checkTime: () => void;
};

export function renderCode(source: string, languageHint?: string | null): CodeRenderResult {
  const text = typeof source === "string" ? source : "";
  const started = performance.now();
  const bytes = utf8ByteLength(text);
  const lines = countLines(text);
  const hint = firstHintWord(languageHint);
  const language = resolveLanguage(text, bytes, hint);
  const limitReason = highlightLimitReason(bytes, lines, language, hint);
  if (limitReason !== null || language === null) {
    return plainResult(text, language, limitReason ?? "generic");
  }

  const budget = createBudget(started);
  try {
    budget.checkTime();
    const prismLanguage = PRISM_LANGUAGE[language];
    const grammar = Prism.languages[prismLanguage];
    if (!grammar) throw new Error("Prism grammar was unavailable.");
    const tokens = Prism.tokenize(text, grammar, prismLanguage);
    budget.checkTime();
    const fragment = createCodeFragment(text, language, "highlighted", null, lines, budget, tokens);
    budget.checkTime();
    const code = fragment.querySelector("code");
    if (!code || code.textContent !== text || !isSafeCodeTree(fragment)) {
      throw new Error("The highlighted code tree did not preserve its source.");
    }
    return { fragment, language, presentation: "highlighted", reason: null };
  } catch {
    const reason = budget.nodes >= MAX_DOM_NODES ? "nodeLimit" : timeExpired(budget) ? "timeLimit" : "rendererError";
    return plainResult(text, language, reason);
  }
}

function resolveLanguage(source: string, bytes: number, hint: string | null): CodeLanguage | null {
  if (hint !== null) return LANGUAGE_ALIASES[hint] ?? null;
  if (bytes > DETECTOR_MAX_BYTES) return null;
  return detectLanguage(source);
}

function highlightLimitReason(
  bytes: number,
  lines: number,
  language: CodeLanguage | null,
  hint: string | null
): CodeRenderReason | null {
  if (bytes > HIGHLIGHT_MAX_BYTES) return "sizeLimit";
  if (lines > HIGHLIGHT_MAX_LINES) return "lineLimit";
  if (language === null && hint === null) return "generic";
  return null;
}

function detectLanguage(source: string): CodeLanguage | null {
  if (source.length === 0) return null;
  const trimmed = source.replace(/^[\t\n\v\f\r ]+/, "");
  if (/^#![^\r\n]*(?:\b(?:ba|z)?sh|\benv\s+(?:ba|z)?sh)\b/i.test(trimmed)) return "shell";
  if (/^\s*[{[]/.test(source) && /[}\]]\s*$/.test(source)) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (parsed !== null && typeof parsed === "object") return "json";
    } catch {
      // A source-like object that is not valid JSON remains generic.
    }
  }
  if (/^\s*(?:SELECT|WITH|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[\s\S]*\b(?:FROM|VALUES|SET|WHERE)\b/i.test(source)) return "sql";
  if (/^\s*(?:def\s+[A-Za-z_]\w*\s*\(|from\s+\w+\s+import\s+|import\s+\w+\s*(?:\r?\n|$))/m.test(source)
    && /(?:\b(?:def|return|None|True|False|print|elif|self)\b|:\s*$)/m.test(source)) return "python";
  if (/\bfn\s+[A-Za-z_]\w*\s*\(/m.test(source)
    && /(?:->\s*[A-Za-z_]|let\s+mut|impl\s+\w+|use\s+std::|println!\s*\()/m.test(source)
    && /[{};]/.test(source)) return "rust";
  if (/\b(?:interface|type\s+[A-Z]\w*\s*=|as\s+(?:const|[A-Z])|enum\s+[A-Z]\w*)\b/.test(source)
    || /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$][\w$<>\[\]| ]*\s*=/.test(source)
    && /[{}:;=]/.test(source)) return "typescript";
  if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|\b(?:function|async|await)\b|=>/.test(source)
    && /[{}();]/.test(source)) return "javascript";
  if (/#include\s*[<"](?:iostream|string|vector|algorithm)/.test(source)
    || /\bstd::\w+|\busing\s+namespace\s+std\b/.test(source)) return "cpp";
  if (/#include\s*[<"](?:stdio|stdlib|string|stdint)\.h[>"]/.test(source)
    && /\b(?:int|void|char|size_t)\s+\w+\s*\(/.test(source)) return "c";
  if (/\bpublic\s+(?:static\s+)?class\s+\w+|\bpublic\s+static\s+void\s+main\s*\(/.test(source)
    && /(?:\bnew\b|\bSystem\.out\b|String\[\])/.test(source)) return "java";
  if (/^\s*package\s+main\b/m.test(source) && /\bfunc\s+main\s*\(/.test(source)) return "go";
  const yamlFields = source.match(/^[\t ]*[A-Za-z_][\w.-]*\s*:\s+\S.*$/gm);
  if (/^---\s*(?:\r?\n|$)/.test(source)
    || Boolean(yamlFields && yamlFields.length >= 2 && !/[{};]/.test(source))) return "yaml";
  return null;
}

function createCodeFragment(
  source: string,
  language: CodeLanguage | null,
  presentation: "highlighted" | "plain",
  reason: CodeRenderReason | null,
  lines: number,
  budget: RenderBudget,
  tokens?: PrismTokenValue[]
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pre = document.createElement("pre");
  pre.className = codeClassName(language, presentation, reason);
  fragment.append(pre);
  budget.reserve();

  if (lines > 0) {
    const gutter = document.createElement("span");
    gutter.className = "sjv-code-gutter";
    gutter.setAttribute("aria-hidden", "true");
    gutter.append(document.createTextNode(lineNumbers(lines)));
    pre.append(gutter);
    budget.reserve();
    budget.reserve();
  }

  const code = document.createElement("code");
  code.className = "sjv-code-source";
  pre.append(code);
  budget.reserve();

  if (presentation === "highlighted") {
    if (tokens) appendTokenValues(tokens, code, budget, 0);
  } else if (source.length > 0) {
    code.append(document.createTextNode(source));
    budget.reserve();
  }
  return fragment;
}

function appendTokenValues(values: PrismTokenValue[], parent: HTMLElement, budget: RenderBudget, depth: number): void {
  if (depth > MAX_TOKEN_DEPTH) throw new Error("Prism token depth exceeded.");
  for (const value of values) {
    budget.checkTime();
    if (typeof value === "string") {
      if (value.length > 0) {
        parent.append(document.createTextNode(value));
        budget.reserve();
      }
      continue;
    }
    appendToken(value, parent, budget, depth);
  }
}

function appendToken(token: PrismToken, parent: HTMLElement, budget: RenderBudget, depth: number): void {
  if (depth > MAX_TOKEN_DEPTH) throw new Error("Prism token depth exceeded.");
  const span = document.createElement("span");
  const className = tokenClassName(token);
  if (className) span.className = className;
  parent.append(span);
  budget.reserve();
  if (typeof token.content === "string") {
    if (token.content.length > 0) {
      span.append(document.createTextNode(token.content));
      budget.reserve();
    }
  } else if (Array.isArray(token.content)) {
    appendTokenValues(token.content, span, budget, depth + 1);
  } else {
    appendToken(token.content, span, budget, depth + 1);
  }
}

function plainResult(source: string, language: CodeLanguage | null, reason: CodeRenderReason): CodeRenderResult {
  const fragment = createCodeFragment(
    source,
    language,
    "plain",
    reason,
    countLines(source),
    createBudget(performance.now())
  );
  return { fragment, language, presentation: "plain", reason };
}

function createBudget(start: number): RenderBudget {
  const budget: RenderBudget = {
    deadline: start + MAX_RENDER_MS,
    nodes: 0,
    reserve: () => {
      if (budget.nodes >= MAX_DOM_NODES) throw new Error("Code renderer node limit exceeded.");
      budget.nodes += 1;
    },
    checkTime: () => {
      if (performance.now() >= budget.deadline) throw new Error("Code renderer time limit exceeded.");
    }
  };
  return budget;
}

function tokenClassName(token: PrismToken): string {
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  for (const name of [token.type, ...aliases]) {
    const className = TOKEN_CLASS_BY_NAME[name];
    if (className) return className;
  }
  return TOKEN_CLASS_BY_NAME.generic;
}

function codeClassName(language: CodeLanguage | null, presentation: "highlighted" | "plain", reason: CodeRenderReason | null): string {
  const classes = [
    "sjv-code",
    "sjv-code-language-" + (language ?? "generic"),
    "sjv-code-" + presentation
  ];
  if (reason !== null) classes.push("sjv-code-reason-" + reason);
  return classes.join(" ");
}

function lineNumbers(lines: number): string {
  return Array.from({ length: lines }, (_, index) => String(index + 1)).join("\n");
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\r") {
      lines += 1;
      if (source[index + 1] === "\n") index += 1;
    } else if (character === "\n") {
      lines += 1;
    }
  }
  return lines;
}

function utf8ByteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

function timeExpired(budget: RenderBudget): boolean {
  return performance.now() >= budget.deadline;
}

function isSafeCodeTree(fragment: DocumentFragment): boolean {
  for (const element of fragment.querySelectorAll("*")) {
    if (element.localName !== "pre" && element.localName !== "code" && element.localName !== "span") return false;
    for (const attribute of element.attributes) {
      if (attribute.name !== "class" && attribute.name !== "aria-hidden") return false;
      if (attribute.name === "aria-hidden" && attribute.value !== "true") return false;
    }
  }
  return true;
}

function firstHintWord(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (trimmed.length === 0) return null;
  return trimmed.split(/[\t\n\v\f\r ]+/, 1)[0].toLowerCase();
}
