import { en, type MessageCatalog, type MessageKey } from "./i18n/en.js";
import { zhCN } from "./i18n/zh-CN.js";

export type Locale = "en" | "zh-CN";
export type TranslationParams = Record<string, string | number>;

const catalogs: Record<Locale, MessageCatalog> = { en, "zh-CN": zhCN };
const placeholderPattern = /\{([A-Za-z0-9_]+)\}/g;

function placeholders(template: string): Set<string> {
  const names = new Set<string>();
  for (const match of template.matchAll(placeholderPattern)) {
    names.add(match[1]);
  }
  return names;
}

function navigatorLanguage(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language;
}

export function resolveLocale(language = navigatorLanguage()): Locale {
  return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export const locale = resolveLocale();

export function validateMessages(): void {
  const englishKeys = Object.keys(en).sort();
  for (const [name, catalog] of Object.entries(catalogs)) {
    const keys = Object.keys(catalog).sort();
    if (keys.join("\0") !== englishKeys.join("\0")) {
      throw new Error("i18n catalog " + name + " does not match the English key set");
    }
    for (const key of englishKeys) {
      const expected = [...placeholders(en[key as MessageKey])].sort();
      const actual = [...placeholders(catalog[key as MessageKey])].sort();
      if (expected.join("\0") !== actual.join("\0")) {
        throw new Error("i18n placeholders for " + key + " do not match in " + name);
      }
    }
  }
}

export function t(key: MessageKey, params: TranslationParams = {}): string {
  const template = catalogs[locale][key] ?? en[key];
  if (template === undefined) {
    throw new Error("Missing i18n key: " + key);
  }

  const expected = placeholders(template);
  for (const name of expected) {
    if (!(name in params)) {
      throw new Error("Missing i18n parameter " + name + " for " + key);
    }
  }
  for (const name of Object.keys(params)) {
    if (!expected.has(name)) {
      throw new Error("Unexpected i18n parameter " + name + " for " + key);
    }
  }

  return template.replace(placeholderPattern, (_match, name: string) => String(params[name]));
}

export function applyStaticTranslations(root: ParentNode = document): void {
  validateMessages();
  const documentElement = root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document).documentElement
    : (root as Element).ownerDocument?.documentElement;
  documentElement?.setAttribute("lang", locale);

  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n as MessageKey);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    element.setAttribute("title", t(element.dataset.i18nTitle as MessageKey));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel as MessageKey));
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder as MessageKey));
  });
}
