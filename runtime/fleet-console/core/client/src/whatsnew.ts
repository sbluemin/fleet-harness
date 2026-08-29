// What's New: the release-notes request lifecycle and the tab/overview derivation
// the modal renders from a fetched note. Locale resolution stays in whatsnew-i18n.ts,
// which is the console-wide language SSoT rather than a What's New concern.

import type { ReleaseNoteProduct, ReleaseNoteSection, ReleaseNotes } from "./types.js";
import type { ReleaseNotesLocale } from "./types.js";
import type { Translate } from "@fleet-console/sdk/i18n";
import { applyReleaseNotes, beginReleaseNotesFetch, failReleaseNotesFetch } from "./store.js";
import { fetchReleaseNotes } from "./api.js";
import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { getT, type CoreMessageKey } from "./i18n/index.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

// ─── fetch lifecycle ───────────────────────────────────────────────────────────

export interface ReleaseNotesRequestOptions {
  readonly force?: boolean;
  readonly locale: ReleaseNotesLocale;
}

let activeAbortController: AbortController | null = null;
let requestGeneration = 0;

export function requestReleaseNotes(options: ReleaseNotesRequestOptions): Promise<void> {
  activeAbortController?.abort();
  const controller = new AbortController();
  const generation = ++requestGeneration;
  activeAbortController = controller;
  beginReleaseNotesFetch();
  return fetchReleaseNotes({ ...options, signal: controller.signal })
    .then((response) => {
      if (generation === requestGeneration) applyReleaseNotes(response, options.locale);
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted || generation !== requestGeneration) return;
      failReleaseNotesFetch(error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      if (generation === requestGeneration) activeAbortController = null;
    });
}

export function abortReleaseNotesFetch(): void {
  if (activeAbortController === null) return;
  activeAbortController.abort();
  activeAbortController = null;
  requestGeneration += 1;
}

// ─── tabs, sections, and overview ──────────────────────────────────────────────

export type WhatsNewTabId = "overview" | "all-updates" | "other-updates" | ReleaseNoteProduct;

export interface WhatsNewTab {
  readonly id: WhatsNewTabId;
  readonly label: string;
}

export interface WhatsNewOverviewItem {
  readonly id: Exclude<WhatsNewTabId, "overview">;
  readonly label: string;
  readonly count: number;
  readonly summary: string;
}

type T = Translate<CoreMessageKey>;

function buildProductTabs(t: T): readonly (WhatsNewTab & { readonly id: ReleaseNoteProduct })[] {
  return [
    { id: "fleet-cli", label: t("whatsnew.tab.fleetCli") },
    { id: "fleet-console", label: t("whatsnew.tab.fleetConsole") },
    { id: "fleet-desktop", label: t("whatsnew.tab.fleetDesktop") },
    { id: "fleet-mobile", label: t("whatsnew.tab.fleetMobile") },
  ];
}

function buildOverviewTab(t: T): WhatsNewTab {
  return { id: "overview", label: t("whatsnew.tab.overview") };
}

function buildAllUpdatesTab(t: T): WhatsNewTab {
  return { id: "all-updates", label: t("whatsnew.tab.allUpdates") };
}

function buildOtherUpdatesTab(t: T): WhatsNewTab {
  return { id: "other-updates", label: t("whatsnew.tab.otherUpdates") };
}

export function deriveWhatsNewTabs(note: ReleaseNotes): readonly WhatsNewTab[] {
  const t = consoleT();
  const hasLegacyItems = note.sections.some((section) => section.items.some((item) => item.product === undefined));
  const productTabs = buildProductTabs(t).filter((tab) => note.sections.some((section) => section.items.some((item) => item.product === tab.id)));
  if (productTabs.length === 0) return [buildOverviewTab(t), buildAllUpdatesTab(t)];
  return hasLegacyItems ? [buildOverviewTab(t), ...productTabs, buildOtherUpdatesTab(t)] : [buildOverviewTab(t), ...productTabs];
}

export function filterWhatsNewSections(note: ReleaseNotes, tabId: WhatsNewTabId): readonly ReleaseNoteSection[] {
  if (tabId === "overview") return [];
  return note.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => tabId === "all-updates" || tabId === "other-updates" ? item.product === undefined : item.product === tabId),
    }))
    .filter((section) => section.items.length > 0);
}

export function deriveWhatsNewOverview(note: ReleaseNotes): readonly WhatsNewOverviewItem[] {
  const t = consoleT();
  const productItems = buildProductTabs(t).flatMap((tab) => {
    const items = note.sections.flatMap((section) => section.items.filter((item) => item.product === tab.id));
    return items.length === 0 ? [] : [{ id: tab.id, label: tab.label, count: items.length, summary: items[0]!.text }];
  });
  const legacyItems = note.sections.flatMap((section) => section.items.filter((item) => item.product === undefined));
  if (legacyItems.length === 0) return productItems;
  return [
    ...productItems,
    {
      id: productItems.length === 0 ? "all-updates" : "other-updates",
      label: productItems.length === 0 ? t("whatsnew.tab.preProductGrouping") : t("whatsnew.tab.otherUpdates"),
      count: legacyItems.length,
      summary: legacyItems[0]!.text,
    },
  ];
}

export function isWhatsNewTabAvailable(note: ReleaseNotes, tabId: WhatsNewTabId): boolean {
  return deriveWhatsNewTabs(note).some((tab) => tab.id === tabId);
}

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

function consoleT(): T {
  return getT(resolveActiveLocale());
}
