import type { SupportedLanguage } from "./types";
import { LANG_STORAGE_KEY, SUPPORTED_LANGUAGES } from "./types";

type LanguageListener = (lang: SupportedLanguage) => void;

const LOCALE_MAP: Record<SupportedLanguage, string> = {
  ko: "ko-KR",
  en: "en-US",
};

const listeners = new Set<LanguageListener>();
let currentLang: SupportedLanguage = "ko";
let initialized = false;

export function initLanguage(): void {
  if (initialized) return;
  initialized = true;

  const locationSearch = typeof window !== "undefined" ? window.location.search : "";
  const storageLang = (() => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(LANG_STORAGE_KEY) : null;
    } catch {
      return null;
    }
  })();
  const navigatorLang = typeof navigator !== "undefined" ? (navigator.language ?? "") : "";

  const urlLang = extractLangParam(locationSearch);
  if (urlLang !== null) {
    currentLang = urlLang;
    try {
      localStorage.setItem(LANG_STORAGE_KEY, urlLang);
    } catch {
      // storage write failed — non-fatal
    }
    if (typeof window !== "undefined" && typeof history !== "undefined") {
      history.replaceState(null, "", buildUrlWithoutLang(window.location.href));
    }
  } else {
    currentLang = resolveInitialLanguage(locationSearch, storageLang, navigatorLang);
  }

  if (typeof document !== "undefined") {
    document.documentElement.lang = currentLang;
  }
}

export function resolveInitialLanguage(
  locationSearch: string,
  storageLang: string | null,
  navigatorLang: string,
): SupportedLanguage {
  const fromStorage = isValidLanguage(storageLang) ? storageLang : null;
  if (fromStorage !== null) return fromStorage;
  if (navigatorLang.toLowerCase().startsWith("ko")) return "ko";
  if (navigatorLang !== "") return "en";
  return "ko";
}

export function buildUrlWithoutLang(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.delete("lang");
    return url.pathname + (url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : "") + url.hash;
  } catch {
    return href;
  }
}

export function getLanguage(): SupportedLanguage {
  return currentLang;
}

export function setLanguage(lang: SupportedLanguage): void {
  if (!isValidLanguage(lang)) return;
  currentLang = lang;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // storage write failed — non-fatal
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
  }
  for (const listener of listeners) listener(lang);
}

export function subscribeLanguage(listener: LanguageListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function languageLocale(): string {
  return LOCALE_MAP[currentLang];
}

function extractLangParam(locationSearch: string): SupportedLanguage | null {
  try {
    const params = new URLSearchParams(locationSearch);
    const value = params.get("lang");
    return isValidLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

function isValidLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}
