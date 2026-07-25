import type { DiagramHydratorLabels } from "@fleet-console/markdown/mermaid";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";
import { React } from "@fleet-console/sdk/plugin/browser";

import { TERMINAL_MESSAGES, type TerminalMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<TerminalMessageKey>> = {
  en: createTranslator(TERMINAL_MESSAGES, "en"),
  ko: createTranslator(TERMINAL_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<TerminalMessageKey> {
  return translators[locale ?? "en"];
}

/** core `resolveConsoleLanguage` 와 동일 규칙 — auto 는 navigator 언어를 따른다. */
export function resolveConsoleLanguage(
  preference: string | null | undefined,
  navigatorLanguage = readNavigatorLanguage(),
): ConsoleLocale {
  if (preference === "en" || preference === "ko") return preference;
  return navigatorLanguage === "ko" || navigatorLanguage.startsWith("ko-") ? "ko" : "en";
}

type LocaleListener = () => void;

/** 플러그인 번들 내부 공유 — 호스트 코어 스토어와 모듈 사본을 섞지 않는다. */
let localeSnapshot: ConsoleLocale = resolveConsoleLanguage(readDocumentLang() ?? "auto");
const localeListeners = new Set<LocaleListener>();
let localeBootstrapped = false;
let langObserver: MutationObserver | null = null;
let bootstrapController: AbortController | null = null;

function getLocaleSnapshot(): ConsoleLocale {
  return localeSnapshot;
}

function subscribeLocale(listener: LocaleListener): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

function setLocaleSnapshot(next: ConsoleLocale): void {
  if (localeSnapshot === next) return;
  localeSnapshot = next;
  for (const listener of localeListeners) listener();
}

function readDocumentLang(): ConsoleLocale | null {
  if (typeof document === "undefined") return null;
  const lang = document.documentElement.lang;
  return lang === "en" || lang === "ko" ? lang : null;
}

/**
 * 호스트가 `document.documentElement.lang` 에 기록한 해석된 로케일을 구독한다.
 * 코어 글로벌 설정 스토어는 플러그인 번들과 모듈 사본이 분리되므로 직접 import 하지 않는다.
 * 설정 카드마다 fetch 하지 않도록 플러그인 내부에서 1회만 부트스트랩한다.
 */
function ensureTerminalLocaleShared(): void {
  if (typeof document !== "undefined" && !langObserver) {
    langObserver = new MutationObserver(() => {
      const fromDom = readDocumentLang();
      if (fromDom) setLocaleSnapshot(fromDom);
    });
    langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  if (localeBootstrapped) return;
  localeBootstrapped = true;

  const fromDom = readDocumentLang();
  if (fromDom) {
    setLocaleSnapshot(fromDom);
    return;
  }

  if (typeof fetch !== "function") return;
  bootstrapController = new AbortController();
  void fetch("/api/v1/settings/global", { signal: bootstrapController.signal })
    .then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { readonly language?: unknown };
      if (bootstrapController?.signal.aborted) return;
      // 호스트가 이미 lang 을 올렸으면 DOM 구독이 권위다.
      const latestDom = readDocumentLang();
      if (latestDom) {
        setLocaleSnapshot(latestDom);
        return;
      }
      setLocaleSnapshot(resolveConsoleLanguage(typeof body.language === "string" ? body.language : "auto"));
    })
    .catch(() => undefined);
}

/** 설정 섹션처럼 locale context 가 없을 때 전역 설정을 읽어 해석한다. */
export function useTerminalLocale(): ConsoleLocale {
  ensureTerminalLocaleShared();
  return React.useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
}

/** Mermaid 다이어그램 UI 라벨 — terminal 카탈로그에서 주입. */
export function diagramHydratorLabels(locale: ConsoleLocale | undefined): DiagramHydratorLabels {
  const t = getT(locale);
  return {
    renderFailed: (message) => t("terminal.markdown.diagram.renderFailed", { message }),
    openExpandedAria: t("terminal.markdown.diagram.openExpandedAria"),
    lightboxTitle: t("terminal.markdown.diagram.lightboxTitle"),
    close: t("terminal.markdown.diagram.close"),
    closeExpandedAria: t("terminal.markdown.diagram.closeExpandedAria"),
    zoomControlsAria: t("terminal.markdown.diagram.zoomControlsAria"),
    zoomOutAria: t("terminal.markdown.diagram.zoomOutAria"),
    zoomInAria: t("terminal.markdown.diagram.zoomInAria"),
    fit: t("terminal.markdown.diagram.fit"),
    fitAria: t("terminal.markdown.diagram.fitAria"),
    reset: t("terminal.markdown.diagram.reset"),
    resetAria: t("terminal.markdown.diagram.resetAria"),
  };
}

/** 서버/클라이언트가 남긴 영어 오류 문구를 표시 직전에 카탈로그 값으로 바꾼다. */
export function translateServerMessage(locale: ConsoleLocale | undefined, message: string): string {
  const t = getT(locale);
  if (message.startsWith("Stop failed: ")) {
    return t("terminal.analysis.error.stopFailed", { message: message.slice("Stop failed: ".length) });
  }
  if (message.startsWith("Reset failed: ")) {
    return t("terminal.analysis.error.resetFailed", { message: message.slice("Reset failed: ".length) });
  }
  const key = SERVER_MESSAGE_KEYS[message];
  return key ? t(key) : message;
}

const SERVER_MESSAGE_KEYS: Readonly<Record<string, TerminalMessageKey>> = {
  "Analysis response timed out.": "terminal.analysis.error.timedOut",
  "Analysis session ended — send again to restart.": "terminal.analysis.error.sessionEnded",
  "Analysis is unavailable.": "terminal.analysis.error.unavailable",
  "Analysis session was not found.": "terminal.analysis.error.sessionNotFound",
  "Analysis request failed.": "terminal.analysis.error.requestFailed",
};

function readNavigatorLanguage(): string {
  return typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
}

export type { TerminalMessageKey };
export { TERMINAL_MESSAGES, terminalEn, terminalKo } from "./messages.js";
