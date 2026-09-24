import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

type SearchSyntax = "literal" | "glob";
type SearchRepresentation = "decoded" | "rawSource";
export type NavigationSearchProgress = {
  searchId: number;
  fileGeneration: number;
  scannedThrough: number;
  scannedCount: number;
  matchedCount: number;
  indexedCount: number;
  totalCount: number | null;
  complete: boolean;
  stopped: boolean;
  skippedInvalidJson: number;
  skippedInvalidUtf8: number;
  skippedOversized: number;
};

export type NavigationSearchEvidence = {
  ordinal: number;
  path: string;
  field: "key" | "value" | "rawSource";
  snippet: string;
  matchStart: number | null;
  matchEnd: number | null;
};

type SearchPage = { ordinals: number[]; evidence: NavigationSearchEvidence[] };

type Elements = {
  panel: HTMLElement;
  form: HTMLFormElement;
  query: HTMLInputElement;
  syntax: HTMLSelectElement;
  representation: HTMLSelectElement;
  clear: HTMLButtonElement;
  stop: HTMLButtonElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  status: HTMLElement;
  description: HTMLElement;
  displayModes: NodeListOf<HTMLInputElement>;
  resultsPanel: HTMLElement;
  results: HTMLElement;
  resultsPrevious: HTMLButtonElement;
  resultsNext: HTMLButtonElement;
};

export class NavigationSearch {
  private context: { fileGeneration: number; mode: "entry" | "collection" } | null = null;
  private progress: NavigationSearchProgress | null = null;
  private epoch = 0;
  private navigating = false;
  private advanceFlight: { searchId: number; fileGeneration: number; promise: Promise<NavigationSearchProgress> } | null = null;
  private startFlight: Promise<void> | null = null;
  private matchIndex = -1;
  private composing = false;
  private displayMode: "highlight" | "filtered" = "highlight";
  private resultCursor = 0;
  private resultKey = "";
  private readonly onDisplayMode: (mode: "highlight" | "filtered") => void;

  constructor(private readonly elements: Elements, private readonly onNavigate: (ordinal: number) => void, onDisplayMode: (mode: "highlight" | "filtered") => void = () => {},
    private readonly onProgress: (progress: NavigationSearchProgress | null) => void = () => {},
    private readonly onClear: () => void = () => {}) {
    this.onDisplayMode = onDisplayMode;
    elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.composing) void this.start();
    });
    elements.query.addEventListener("input", () => this.invalidate());
    elements.query.addEventListener("compositionstart", () => { this.composing = true; });
    elements.query.addEventListener("compositionend", () => { this.composing = false; });
    elements.query.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.isComposing || this.composing || event.keyCode === 229)) {
        event.preventDefault();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.clearQuery();
      }
    });
    elements.syntax.addEventListener("change", () => this.invalidate());
    elements.representation.addEventListener("change", () => this.invalidate());
    elements.clear.addEventListener("click", () => this.clearQuery());
    elements.stop.addEventListener("click", () => this.stop(false));
    elements.previous.addEventListener("click", () => void this.move(-1));
    elements.next.addEventListener("click", () => void this.move(1));
    elements.displayModes.forEach((radio) => radio.addEventListener("change", () => {
      if (!radio.checked) return;
      this.displayMode = radio.value === "filtered" ? "filtered" : "highlight";
      this.onDisplayMode(this.displayMode);
      this.render();
    }));
    elements.resultsPrevious.addEventListener("click", () => {
      this.resultCursor = Math.max(0, this.resultCursor - 200);
      this.resultKey = "";
      this.render();
    });
    elements.resultsNext.addEventListener("click", () => {
      if (this.progress && this.resultCursor + 200 < this.progress.matchedCount) {
        this.resultCursor += 200;
        this.resultKey = "";
        this.render();
      }
    });
    elements.results.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("[data-navigation-ordinal]");
      const ordinal = Number(button?.dataset.navigationOrdinal);
      if (button && Number.isSafeInteger(ordinal)) {
        this.matchIndex = Number(button.dataset.matchIndex);
        this.onNavigate(ordinal);
        this.render();
      }
    });
    this.render();
  }

  setContext(context: { fileGeneration: number; mode: "entry" | "collection" } | null): void {
    if (this.context?.fileGeneration === context?.fileGeneration && this.context?.mode === context?.mode) return;
    this.stop(true);
    this.elements.results.replaceChildren();
    this.context = context;
    this.displayMode = "highlight";
    this.resultCursor = 0;
    this.resultKey = "";
    this.onDisplayMode(this.displayMode);
    this.elements.panel.hidden = context === null;
    this.elements.description.textContent = context?.mode === "entry"
      ? t("navigationSearch.jsonlDescription")
      : t("navigationSearch.collectionDescription");
    this.render();
  }

  setDisplayMode(mode: "highlight" | "filtered"): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    this.onDisplayMode(mode);
    this.render();
  }

  private invalidate(): void {
    if (this.progress) void invoke("stop_navigation_search", {
      fileGeneration: this.progress.fileGeneration,
      searchId: this.progress.searchId,
      releaseResults: true
    }).catch(() => undefined);
    this.epoch += 1;
    this.navigating = false;
    this.progress = null;
    this.matchIndex = -1;
    this.resultCursor = 0;
    this.resultKey = "";
    this.elements.results.replaceChildren();
    if (this.elements.query.value.length === 0) {
      this.displayMode = "highlight";
      this.onDisplayMode(this.displayMode);
    }
    this.render(this.elements.query.value.length > 0 ? t("navigationSearch.pressEnter") : "");
  }

  private clearQuery(): void {
    this.elements.query.value = "";
    this.invalidate();
    this.onClear();
    this.elements.query.focus();
  }

  private async start(): Promise<void> {
    const context = this.context;
    const query = this.elements.query.value;
    if (!context || query.length === 0) {
      if (query.length === 0) this.invalidate();
      return;
    }
    this.invalidate();
    const epoch = this.epoch;
    const previousStart = this.startFlight;
    const run = async (): Promise<void> => {
      try {
        await previousStart;
        if (epoch !== this.epoch || context !== this.context) return;
        const progress = await invoke<NavigationSearchProgress>("start_navigation_search", {
          fileGeneration: context.fileGeneration,
          query,
          syntax: this.elements.syntax.value as SearchSyntax,
          representation: this.elements.representation.value as SearchRepresentation
        });
        if (epoch !== this.epoch || context !== this.context) {
          await invoke("stop_navigation_search", { fileGeneration: progress.fileGeneration, searchId: progress.searchId, releaseResults: true }).catch(() => undefined);
          return;
        }
        this.progress = progress;
        this.resultCursor = 0;
        this.resultKey = "";
        this.render();
        void this.advance(epoch);
      } catch (error) {
        if (epoch === this.epoch) this.render(errorMessage(error));
      }
    };
    const flight = run();
    this.startFlight = flight;
    await flight;
    if (this.startFlight === flight) this.startFlight = null;
  }

  private async advance(epoch: number): Promise<void> {
    const progress = this.progress;
    if (!progress || epoch !== this.epoch || progress.complete || progress.stopped) return;
    try {
      const next = await this.requestAdvance(progress);
      if (epoch !== this.epoch || this.progress?.searchId !== next.searchId) return;
      const madeProgress = next.scannedThrough > progress.scannedThrough || next.indexedCount > progress.indexedCount;
      this.progress = next;
      this.render();
      if (!next.complete && !next.stopped) window.setTimeout(() => void this.advance(epoch), madeProgress ? 0 : 100);
    } catch (error) {
      if (epoch === this.epoch) this.render(errorMessage(error));
    }
  }

  private async move(direction: -1 | 1): Promise<void> {
    if (this.navigating || !this.progress) return;
    this.navigating = true;
    const epoch = this.epoch;
    try {
      if (direction < 0 && this.matchIndex > 0) {
        await this.loadOrdinal(this.matchIndex - 1, epoch);
        return;
      }
      while (this.progress && epoch === this.epoch) {
        if (this.matchIndex + 1 < this.progress.matchedCount) {
          await this.loadOrdinal(this.matchIndex + 1, epoch);
          return;
        }
        if (this.progress.complete || this.progress.stopped) return;
        const previous = this.progress;
        const advanced = await this.requestAdvance(previous);
        if (epoch !== this.epoch || this.progress?.searchId !== advanced.searchId) return;
        this.progress = advanced;
        this.render();
        if (advanced.scannedThrough === previous.scannedThrough) await new Promise(resolve => window.setTimeout(resolve, 100));
      }
    } catch (error) {
      if (epoch === this.epoch) this.render(errorMessage(error));
    } finally {
      if (epoch === this.epoch) {
        this.navigating = false;
        this.render();
      }
    }
  }

  private async loadOrdinal(index: number, epoch: number): Promise<void> {
    const progress = this.progress;
    if (!progress) return;
    const page = await invoke<{ ordinals: number[] }>("get_navigation_search_page", {
      fileGeneration: progress.fileGeneration,
      searchId: progress.searchId,
      cursor: index,
      limit: 1
    });
    if (epoch !== this.epoch || !this.progress || !Number.isSafeInteger(page.ordinals[0])) return;
    this.matchIndex = index;
    this.onNavigate(page.ordinals[0]);
    this.render();
  }

  private requestAdvance(progress: NavigationSearchProgress): Promise<NavigationSearchProgress> {
    if (this.advanceFlight?.searchId === progress.searchId && this.advanceFlight.fileGeneration === progress.fileGeneration) return this.advanceFlight.promise;
    const request = invoke<NavigationSearchProgress>("advance_navigation_search", {
      fileGeneration: progress.fileGeneration,
      searchId: progress.searchId
    });
    const flight = { searchId: progress.searchId, fileGeneration: progress.fileGeneration, promise: request };
    this.advanceFlight = flight;
    const clear = (): void => {
      if (this.advanceFlight === flight) this.advanceFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }

  private stop(releaseResults: boolean): void {
    const progress = this.progress;
    if (progress) void invoke("stop_navigation_search", {
      fileGeneration: progress.fileGeneration,
      searchId: progress.searchId,
      releaseResults
    }).catch(() => undefined);
    this.epoch += 1;
    this.navigating = false;
    this.resultKey = "";
    if (releaseResults) {
      this.progress = null;
      this.matchIndex = -1;
    } else if (progress) {
      this.progress = { ...progress, stopped: true };
    }
    this.render();
  }

  private render(message?: string): void {
    const progress = this.progress;
    this.onProgress(progress);
    this.elements.stop.hidden = !progress || progress.complete || progress.stopped;
    this.elements.previous.disabled = !progress || this.matchIndex <= 0 || this.navigating;
    this.elements.next.disabled = !progress || this.navigating || (progress.complete || progress.stopped) && this.matchIndex + 1 >= progress.matchedCount;
    const filtered = this.displayMode === "filtered";
    this.elements.resultsPanel.hidden = !filtered;
    this.elements.displayModes.forEach((radio) => {
      radio.checked = radio.value === this.displayMode;
      radio.disabled = !progress && this.elements.query.value.length === 0;
    });
    this.elements.resultsPrevious.disabled = !progress || this.resultCursor === 0;
    this.elements.resultsNext.disabled = !progress || this.resultCursor + 200 >= progress.matchedCount;
    if (message !== undefined) {
      this.elements.status.textContent = message;
    } else if (!progress) {
      this.elements.status.textContent = "";
    } else if (progress.stopped) {
      this.elements.status.textContent = t("navigationSearch.stopped", { scanned: progress.scannedCount, matches: progress.matchedCount });
    } else if (progress.complete) {
      this.elements.status.textContent = t("navigationSearch.complete", { matches: progress.matchedCount, total: progress.totalCount ?? progress.scannedCount });
    } else {
      this.elements.status.textContent = t("navigationSearch.scanning", { scanned: progress.scannedCount, indexed: progress.indexedCount, matches: progress.matchedCount });
    }
    if (progress && progress.skippedInvalidJson + progress.skippedInvalidUtf8 + progress.skippedOversized > 0) {
      this.elements.status.textContent += ` · ${t("navigationSearch.skipped", {
        json: progress.skippedInvalidJson,
        utf8: progress.skippedInvalidUtf8,
        oversized: progress.skippedOversized
      })}`;
    }
    if (progress && filtered) this.loadResults(progress);
  }

  private loadResults(progress: NavigationSearchProgress): void {
    const key = `${progress.searchId}:${this.resultCursor}:${Math.min(progress.matchedCount, this.resultCursor + 200)}:${progress.complete}`;
    if (key === this.resultKey) return;
    this.resultKey = key;
    const epoch = this.epoch;
    const cursor = this.resultCursor;
    this.elements.results.replaceChildren();
    this.elements.results.setAttribute("aria-busy", "true");
    void invoke<SearchPage>("get_navigation_search_page", {
      fileGeneration: progress.fileGeneration,
      searchId: progress.searchId,
      cursor,
      limit: 200
    }).then((page) => {
      if (epoch !== this.epoch || this.progress?.searchId !== progress.searchId || key !== this.resultKey) return;
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < page.ordinals.length; index += 1) {
        const ordinal = page.ordinals[index];
        const button = document.createElement("button");
        button.type = "button";
        button.className = "navigation-search-result";
        button.dataset.navigationOrdinal = String(ordinal);
        button.dataset.matchIndex = String(cursor + index);
        button.setAttribute("role", "listitem");
        button.setAttribute("aria-posinset", String(cursor + index + 1));
        button.setAttribute("aria-setsize", String(progress.matchedCount));
        const label = t(this.context?.mode === "entry" ? "navigationSearch.entryResult" : "navigationSearch.itemResult", {
          ordinal: (this.context?.mode === "entry" ? ordinal + 1 : ordinal).toLocaleString()
        });
        const heading = document.createElement("strong");
        heading.textContent = label;
        button.append(heading);
        const evidence = page.evidence?.find((item) => item.ordinal === ordinal);
        if (evidence) appendNavigationEvidence(button, evidence);
        else {
          const badge = document.createElement("span");
          badge.textContent = t("navigationSearch.matched");
          button.append(badge);
        }
        fragment.append(button);
      }
      this.elements.results.replaceChildren(fragment);
      this.elements.results.setAttribute("aria-busy", "false");
      if (page.ordinals.length === 0 && progress.matchedCount === 0 && progress.complete) {
        this.elements.results.textContent = t("navigationSearch.noMatches");
      }
    }).catch((error) => {
      if (epoch === this.epoch && key === this.resultKey) {
        this.resultKey = "";
        this.elements.results.setAttribute("aria-busy", "false");
        this.elements.status.textContent = errorMessage(error);
      }
    });
  }
}

export function appendNavigationEvidence(container: HTMLElement, evidence: NavigationSearchEvidence): void {
  const path = document.createElement("span");
  path.className = "navigation-search-evidence-path";
  const field = t(evidence.field === "rawSource" ? "search.fieldRawSource" : evidence.field === "key" ? "search.fieldKey" : "search.fieldValue");
  path.textContent = `${evidence.path} · ${field}`;
  const snippet = document.createElement("span");
  snippet.className = "navigation-search-evidence";
  const { matchStart: start, matchEnd: end } = evidence;
  if (start !== null && end !== null && Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && end > start && end <= evidence.snippet.length) {
    const mark = document.createElement("mark");
    mark.textContent = evidence.snippet.slice(start, end);
    snippet.append(document.createTextNode(evidence.snippet.slice(0, start)), mark, document.createTextNode(evidence.snippet.slice(end)));
  } else snippet.textContent = evidence.snippet;
  container.append(path, snippet);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}
