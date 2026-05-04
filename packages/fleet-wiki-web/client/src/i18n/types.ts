export type SupportedLanguage = "ko" | "en";

export interface I18nMessages {
  common: {
    none: string;
    confirm: string;
    cancel: string;
    processing: string;
    codeCopied: string;
  };
  nav: {
    emptyEntries: string;
    searchLabel: string;
    ariaHome: string;
    ariaClose: string;
    ariaMenuOpen: string;
    ariaNavMode: string;
    ariaTaggedDocs: string;
    ariaAllDocs: string;
    sectionEntries: string;
    sectionTags: string;
    sidebarTitle: string;
    tabEntries: string;
    tabTags: string;
    untagged: string;
  };
  manifest: {
    subtitle: string;
    created: string;
    updated: string;
    version: string;
    tags: string;
    rawSource: string;
  };
  drydock: {
    loadingPatch: string;
    errorLoadPatch: string;
    notFound: string;
    ariaBackToDrydock: string;
    patchManifestSubtitle: string;
    op: string;
    target: string;
    proposer: string;
    createdAt: string;
    status: string;
    rawSource: string;
    warnings: string;
    loadingQueue: string;
    errorLoadQueue: string;
    queueTitle: string;
    ariaQueueTabs: string;
    emptyPending: string;
    emptyArchived: string;
    tabPending: string;
    tabArchived: string;
  };
  queue: {
    actionsTitle: string;
    actionsSubtitle: string;
    approve: string;
    reject: string;
    rejectPlaceholder: string;
    ariaApprove: string;
    ariaReject: string;
    confirmApprove: string;
    ariaProcessing: string;
    rejectErrorLength: string;
    rejectErrorRequired: string;
  };
  raw: {
    loading: string;
    errorLoad: string;
    emptyContent: string;
    ariaBackToCodex: string;
  };
  command: {
    ariaLabel: string;
    placeholder: string;
    emptyResults: string;
  };
  toc: {
    ariaLabel: string;
    heading: string;
  };
  related: {
    heading: string;
  };
  backlinks: {
    subtitle: string;
    emptyNoEntry: string;
    emptyNone: string;
  };
  meta: {
    updatedPrefix: string;
  };
  markdown: {
    welcomeLead: string;
    openFirstPrefix: string;
    emptyWiki: string;
    wikiEntry: string;
    loadingEntry: string;
    entriesCount: string;
  };
  time: {
    justNow: string;
    minutesAgo: string;
    hoursAgo: string;
    daysAgo: string;
    monthsAgo: string;
  };
  errors: {
    requestFailed: string;
  };
}

export const LANG_STORAGE_KEY = "fleet-wiki-lang";
export const SUPPORTED_LANGUAGES = ["ko", "en"] as const satisfies readonly SupportedLanguage[];
