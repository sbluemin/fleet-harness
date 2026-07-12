import type { ReleaseNoteProduct, ReleaseNoteSection, ReleaseNotes } from "./types.js";

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

const PRODUCT_TABS: readonly (WhatsNewTab & { readonly id: ReleaseNoteProduct })[] = [
  { id: "fleet-cli", label: "Fleet CLI" },
  { id: "fleet-console", label: "Fleet Console" },
  { id: "fleet-desktop", label: "Fleet Desktop" },
  { id: "fleet-plugin", label: "Fleet Plugin" },
  { id: "fleet-core", label: "Fleet Core" },
];

const OVERVIEW_TAB: WhatsNewTab = { id: "overview", label: "Overview" };
const ALL_UPDATES_TAB: WhatsNewTab = { id: "all-updates", label: "All updates" };
const OTHER_UPDATES_TAB: WhatsNewTab = { id: "other-updates", label: "Other updates" };

export function deriveWhatsNewTabs(note: ReleaseNotes): readonly WhatsNewTab[] {
  const hasLegacyItems = note.sections.some((section) => section.items.some((item) => item.product === undefined));
  const productTabs = PRODUCT_TABS.filter((tab) => note.sections.some((section) => section.items.some((item) => item.product === tab.id)));
  if (productTabs.length === 0) return [OVERVIEW_TAB, ALL_UPDATES_TAB];
  return hasLegacyItems ? [OVERVIEW_TAB, ...productTabs, OTHER_UPDATES_TAB] : [OVERVIEW_TAB, ...productTabs];
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
  const productItems = PRODUCT_TABS.flatMap((tab) => {
    const items = note.sections.flatMap((section) => section.items.filter((item) => item.product === tab.id));
    return items.length === 0 ? [] : [{ id: tab.id, label: tab.label, count: items.length, summary: items[0]!.text }];
  });
  const legacyItems = note.sections.flatMap((section) => section.items.filter((item) => item.product === undefined));
  if (legacyItems.length === 0) return productItems;
  return [
    ...productItems,
    {
      id: productItems.length === 0 ? "all-updates" : "other-updates",
      label: productItems.length === 0 ? "Pre-product-grouping updates" : "Other updates",
      count: legacyItems.length,
      summary: legacyItems[0]!.text,
    },
  ];
}

export function isWhatsNewTabAvailable(note: ReleaseNotes, tabId: WhatsNewTabId): boolean {
  return deriveWhatsNewTabs(note).some((tab) => tab.id === tabId);
}
