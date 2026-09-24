import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

type SearchSyntax = "literal" | "glob";
type SearchRepresentation = "decoded" | "rawSource";
type Progress = {
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
  private progress: Progress | null = null;
  private epoch = 0;
  private navigating = false;
  private advanceFlight: Promise<Progress> | null = null;
  private matchIndex = -1;
  private composing = false;
  private displayMode: "highlight" | "filtered" = "highlight";
  private resultCursor = 0;
  private resultKey = "";
  private readonly onDisplayMode: (mode: "highlight" | "filtered") => void;

  constructor(private readonly elements: Elements, private readonly onNavigate: (ordinal: number) => void, onDisplayMode: (mode: "highlight" | "filtered") => void = () => {}) {
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
      if (Number.isSafeInteger(ordinal)) this.onNavigate(ordinal);
    });
    this.render();
  }

  setContext(context: { fileGeneration: number; mode: "entry" | "collection" } | null): void {
    if (this.context?.fileGeneration === context?.fileGeneration && this.context?.mode === context?.mode) return;
    this.stop(true);
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
    try {
      const progress = await invoke<Progress>("start_navigation_search", {
        fileGeneration: context.fileGeneration,
        query,
        syntax: this.elements.syntax.value as SearchSyntax,
        representation: this.elements.representation.value as SearchRepresentation
      });
      if (epoch !== this.epoch || context !== this.context) return;
      this.progress = progress;
      this.resultCursor = 0;
      this.resultKey = "";
      this.render();
      void this.advance(epoch);
    } catch (error) {
      if (epoch === this.epoch) this.render(errorMessage(error));
    }
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
        const advanced = await this.requestAdvance(this.progress);
        if (epoch !== this.epoch) return;
        this.progress = advanced;
        this.render();
      }
    } catch (error) {
      if (epoch === this.epoch) this.render(errorMessage(error));
    } finally {
      this.navigating = false;
      this.render();
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

  private requestAdvance(progress: Progress): Promise<Progress> {
    if (this.advanceFlight) return this.advanceFlight;
    const request = invoke<Progress>("advance_navigation_search", {
      fileGeneration: progress.fileGeneration,
      searchId: progress.searchId
    });
    this.advanceFlight = request;
    const clear = (): void => {
      if (this.advanceFlight === request) this.advanceFlight = null;
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
    this.elements.stop.hidden = !progress || progress.complete || progress.stopped;
    this.elements.previous.disabled = !progress || this.matchIndex <= 0 || this.navigating;
    this.elements.next.disabled = !progress || this.navigating || progress.complete && this.matchIndex + 1 >= progress.matchedCount;
    const filtered = this.displayMode === "filtered";
    this.elements.resultsPanel.hidden = !progress && !(filtered && this.elements.query.value.length > 0);
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
    if (progress) this.loadResults(progress);
  }

  private loadResults(progress: Progress): void {
    const key = `${progress.searchId}:${this.resultCursor}:${progress.matchedCount}`;
    if (key === this.resultKey) return;
    this.resultKey = key;
    const epoch = this.epoch;
    void invoke<{ ordinals: number[] }>("get_navigation_search_page", {
      fileGeneration: progress.fileGeneration,
      searchId: progress.searchId,
      cursor: this.resultCursor,
      limit: 200
    }).then((page) => {
      if (epoch !== this.epoch || this.progress?.searchId !== progress.searchId) return;
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < page.ordinals.length; index += 1) {
        const ordinal = page.ordinals[index];
        const button = document.createElement("button");
        button.type = "button";
        button.className = "navigation-search-result";
        button.dataset.navigationOrdinal = String(ordinal);
        button.setAttribute("role", "listitem");
        button.setAttribute("aria-posinset", String(this.resultCursor + index + 1));
        button.setAttribute("aria-setsize", String(progress.matchedCount));
        const label = t(this.context?.mode === "entry" ? "navigationSearch.entryResult" : "navigationSearch.itemResult", {
          ordinal: (this.context?.mode === "entry" ? ordinal + 1 : ordinal).toLocaleString()
        });
        const mark = document.createElement("mark");
        mark.textContent = label;
        button.append(mark);
        fragment.append(button);
      }
      this.elements.results.replaceChildren(fragment);
      if (page.ordinals.length === 0 && progress.matchedCount === 0 && progress.complete) {
        this.elements.results.textContent = t("navigationSearch.noMatches");
      }
    }).catch((error) => {
      if (epoch === this.epoch) this.elements.status.textContent = errorMessage(error);
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
