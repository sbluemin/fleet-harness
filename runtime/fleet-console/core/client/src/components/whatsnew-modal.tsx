import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Select } from "@fleet-console/sdk/react/browser";

import { useGlobalSettingsStore } from "../global-settings-store.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";
import { deriveWhatsNewOverview, deriveWhatsNewTabs, filterWhatsNewSections, isWhatsNewTabAvailable, requestReleaseNotes, type WhatsNewTabId } from "../whatsnew.js";
import { closeWhatsNew, selectReleaseNote } from "../store.js";
import type { ConsoleState, ReleaseNoteItem, ReleaseNoteSection } from "../types.js";
import { resolveReleaseNotesLocale } from "../whatsnew-i18n.js";

interface WhatsNewModalProps {
  readonly state: ConsoleState;
}

type WhatsNewSectionStyle = CSSProperties & {
  readonly "--whatsnew-delay": string;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const RELEASE_NOTE_PAGE_SIZE = 10;

export function WhatsNewModal({ state }: WhatsNewModalProps) {
  const t = useT();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const outsideFocusHistoryRef = useRef<HTMLElement[]>([]);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef(new Map<WhatsNewTabId, HTMLButtonElement>());
  const [activeTab, setActiveTab] = useState<WhatsNewTabId>("overview");
  const globalSettings = useGlobalSettingsStore();
  // 본문은 마지막으로 적용된 릴리스 노트 언어를 따르고, 첫 fetch 전만 Console 언어에서 기본값을 얻는다.
  // 모달 chrome은 별도로 useT()를 사용하므로 Settings의 Auto/명시 언어를 계속 따른다.
  const locale = state.releaseNotesLocale ?? resolveReleaseNotesLocale(globalSettings.state?.language ?? "auto");
  const selectedKey = state.selectedReleaseNoteKey ?? releaseNoteKey(state.releaseNotes[0]?.version ?? "", 0);
  const selectedIndex = state.releaseNotes.findIndex((note, index) => releaseNoteKey(note.version, index) === selectedKey);
  const selected = state.releaseNotes[selectedIndex] ?? state.releaseNotes[0];
  const selectedValue = selected ? releaseNoteKey(selected.version, selectedIndex >= 0 ? selectedIndex : 0) : "";
  const tabs = selected ? deriveWhatsNewTabs(selected) : [];
  const contentLanguage = locale === "ko" && !selected?.localizationFallback ? "ko" : "en";

  useEffect(() => {
    setActiveTab("overview");
  }, [selectedValue]);

  useEffect(() => {
    if (selected && !isWhatsNewTabAvailable(selected, activeTab)) setActiveTab("overview");
  }, [activeTab, selected]);

  useEffect(() => {
    const rememberOutsideFocus = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || target.closest(".whatsnew-card")) return;
      const history = outsideFocusHistoryRef.current.filter((element) => element !== target && element.isConnected);
      outsideFocusHistoryRef.current = [...history.slice(-4), target];
    };
    document.addEventListener("focusin", rememberOutsideFocus, true);
    return () => document.removeEventListener("focusin", rememberOutsideFocus, true);
  }, []);

  // What's new는 자동으로 열리므로, 다른 우선 오버레이가 떠 있거나 아직 theater bootstrap이 끝나지 않은
  // 동안에는 양보한다. 그렇지 않으면 뒤에 숨은 What's new의 window capture 리스너가 stopImmediatePropagation으로
  // visible 다이얼로그(commissioning·quick search·timeline)의 Esc/Tab을 가로챈다.
  // bootstrap 전에는 resolveOnboardingOnBootstrap()가 아직 돌지 않아 onboardingOpen이 false라,
  // /health가 /theaters보다 먼저 도착하면 onboardingOpen만으로는 게이트가 새므로 bootstrapped도 함께 본다.
  // 억제가 풀리면 whatsNewOpen이 유지된 채 아래 효과/렌더가 다시 살아나 그때 표시된다.
  const whatsNewSuppressed =
    !state.bootstrapped ||
    state.onboardingOpen ||
    state.operationSearchOpen ||
    (state.controlHolder !== null && !state.controlCurtainDismissed) ||
    state.quickLaunchOpen ||
    state.keyboardShortcutsOpen;
  if (state.whatsNewOpen && !whatsNewSuppressed && returnFocusRef.current === null) {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    if (!state.whatsNewOpen || whatsNewSuppressed) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isSelectOwnedKeyEvent(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeWhatsNew();
      } else if (handleTabNavigation(event, cardRef.current, setActiveTab)) {
        event.preventDefault();
      } else if (event.key === "Tab") {
        trapFocus(event, cardRef.current);
      }
      event.stopImmediatePropagation();
    };
    closeButtonRef.current?.focus();
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      const target = returnFocusRef.current?.isConnected
        ? returnFocusRef.current
        : [...outsideFocusHistoryRef.current].reverse().find((element) => element.isConnected);
      returnFocusRef.current = null;
      target?.focus?.();
    };
  }, [state.whatsNewOpen, whatsNewSuppressed]);

  if (!state.whatsNewOpen || whatsNewSuppressed || selected === undefined) return null;
  const handleRefresh = () => {
    void requestReleaseNotes({ force: true, locale });
  };
  const selectLanguage = (nextLocale: "en" | "ko") => {
    if (state.releaseNotesLoading) return;
    if (nextLocale === locale) {
      // 한국어 모드가 영어 fallback을 보여 주는 동안에는 같은 버튼으로 번역을 다시 시도할 수 있다.
      if (nextLocale === "ko" && selected?.localizationFallback) {
        void requestReleaseNotes({ force: true, locale: nextLocale });
      }
      return;
    }
    void requestReleaseNotes({ locale: nextLocale });
  };
  // 셀렉터는 한 페이지에 최근 RELEASE_NOTE_PAGE_SIZE개만 노출한다. 현재 페이지는 선택된 버전에서 파생하므로
  // 별도 상태가 필요 없고, 선택이 항상 현재 페이지에 포함된다. 페이지 이동은 그 페이지의 가장 최신 버전을 선택한다.
  const pageCount = Math.max(1, Math.ceil(state.releaseNotes.length / RELEASE_NOTE_PAGE_SIZE));
  const currentPage = Math.min(pageCount - 1, Math.floor((selectedIndex >= 0 ? selectedIndex : 0) / RELEASE_NOTE_PAGE_SIZE));
  const pageStart = currentPage * RELEASE_NOTE_PAGE_SIZE;
  const pageNotes = state.releaseNotes.slice(pageStart, pageStart + RELEASE_NOTE_PAGE_SIZE);
  const goToReleasePage = (delta: number) => {
    const targetPage = currentPage + delta;
    if (targetPage < 0 || targetPage >= pageCount) return;
    const targetIndex = targetPage * RELEASE_NOTE_PAGE_SIZE;
    const target = state.releaseNotes[targetIndex];
    if (target) selectReleaseNote(releaseNoteKey(target.version, targetIndex));
  };
  const selectTabAndFocus = (tabId: WhatsNewTabId) => {
    setActiveTab(tabId);
    requestAnimationFrame(() => tabRefs.current.get(tabId)?.focus());
  };

  return (
    <div className="whatsnew-overlay" role="dialog" aria-modal="true" aria-labelledby="whatsnew-title">
      <button type="button" className="whatsnew-scrim" onClick={closeWhatsNew} aria-label={t("chrome.whatsnew.closeAria")} />
      <section className="whatsnew-card" ref={cardRef}>
        <header className="whatsnew-header">
          <div className="whatsnew-heading-row">
            <h2 id="whatsnew-title">{t("chrome.whatsnew.title")}</h2>
            <span className="whatsnew-version-badge">v{selected.version}</span>
          </div>
          <div className="whatsnew-meta-row">
            {selected.date ? <time className="whatsnew-date" dateTime={selected.date}>{t("chrome.whatsnew.released", { date: selected.date })}</time> : <span className="whatsnew-date">{t("chrome.whatsnew.unreleased")}</span>}
            {state.releaseNotesStale ? <span className="whatsnew-stale">{t("chrome.whatsnew.stale")}</span> : null}
            {locale === "ko" && selected.localizationFallback ? <span className="whatsnew-fallback">{t("chrome.whatsnew.englishFallback")}</span> : null}
          </div>
        </header>
        <button ref={closeButtonRef} type="button" className="whatsnew-close" onClick={closeWhatsNew} aria-label={t("chrome.whatsnew.closeAria")}>
          x
        </button>
        <div className="whatsnew-body">
          <div className="whatsnew-version-selector">
            <Select
              label={t("chrome.whatsnew.releaseVersion")}
              className="whatsnew-version-select"
              value={selectedValue}
              onChange={selectReleaseNote}
              options={pageNotes.map((note, localIndex) => {
                const index = pageStart + localIndex;
                const versionLabel = note.version === "Unreleased"
                  ? t("chrome.whatsnew.versionUnreleased")
                  : t("chrome.whatsnew.versionTagged", { version: note.version });
                return {
                  value: releaseNoteKey(note.version, index),
                  label: `${versionLabel}${note.date ? ` · ${note.date}` : ""}`,
                };
              })}
            />
            {pageCount > 1 ? (
              <div className="whatsnew-pagination">
                <button type="button" className="whatsnew-page-button" onClick={() => goToReleasePage(-1)} disabled={currentPage === 0} aria-label={t("chrome.whatsnew.newerVersions")}>
                  ‹
                </button>
                <span className="whatsnew-page-status">{currentPage + 1} / {pageCount}</span>
                <button type="button" className="whatsnew-page-button" onClick={() => goToReleasePage(1)} disabled={currentPage >= pageCount - 1} aria-label={t("chrome.whatsnew.olderVersions")}>
                  ›
                </button>
              </div>
            ) : null}
            <div className="whatsnew-language-picker" role="group" aria-label={t("chrome.whatsnew.displayLanguage")}>
              {(["en", "ko"] as const).map((nextLocale) => (
                <button
                  key={nextLocale}
                  type="button"
                  className={locale === nextLocale ? "is-active" : ""}
                  aria-pressed={locale === nextLocale}
                  disabled={state.releaseNotesLoading}
                  onClick={() => selectLanguage(nextLocale)}
                >
                  {nextLocale === "en" ? t("chrome.whatsnew.langEn") : t("chrome.whatsnew.langKo")}
                </button>
              ))}
            </div>
            <button type="button" className="whatsnew-refresh" onClick={handleRefresh} disabled={state.releaseNotesLoading}>
              {state.releaseNotesLoading ? t("chrome.whatsnew.refreshing") : t("common.refresh")}
            </button>
          </div>
          <div className="whatsnew-tabs" role="tablist" aria-label={t("chrome.whatsnew.releaseCategories")}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                ref={(element) => {
                  if (element) tabRefs.current.set(tab.id, element);
                  else tabRefs.current.delete(tab.id);
                }}
                id={`whatsnew-tab-${tab.id}`}
                type="button"
                role="tab"
                className="whatsnew-tab"
                data-tab-id={tab.id}
                aria-selected={activeTab === tab.id}
                aria-controls="whatsnew-tab-panel"
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {state.releaseNotesError ? <p className="whatsnew-error">{t("chrome.whatsnew.refreshError")}</p> : null}
          <div id="whatsnew-tab-panel" role="tabpanel" aria-labelledby={`whatsnew-tab-${activeTab}`}>
            {activeTab === "overview" ? (
              <div className="whatsnew-overview" aria-label={t("chrome.whatsnew.overviewAria")}>
                {deriveWhatsNewOverview(selected).map((item) => (
                  <button key={item.id} type="button" className="whatsnew-overview-card" onClick={() => selectTabAndFocus(item.id)}>
                    <span className="whatsnew-overview-label">{item.label}</span>
                    <span className="whatsnew-overview-count">{t(item.count === 1 ? "chrome.whatsnew.updateCount_one" : "chrome.whatsnew.updateCount_other", { count: item.count })}</span>
                    <span className="whatsnew-overview-summary" lang={contentLanguage}>{item.summary}</span>
                  </button>
                ))}
              </div>
            ) : filterWhatsNewSections(selected, activeTab).map((section, index) => (
              <ReleaseNoteSectionView key={section.heading} section={section} index={index} contentLanguage={contentLanguage} />
            ))}
          </div>
        </div>
        <footer className="whatsnew-footer">
          <button type="button" className="whatsnew-done" onClick={closeWhatsNew}>
            {t("common.close")}
          </button>
        </footer>
      </section>
    </div>
  );
}

// 섹션 이름은 CHANGELOG.md의 프로토콜 enum이라 영어로 고정된다. 화면에 보이는 라벨만 로케일화한다.
const SECTION_LABEL_KEYS = {
  "Added": "whatsnew.section.added",
  "Changed": "whatsnew.section.changed",
  "Fixed": "whatsnew.section.fixed",
  "Removed": "whatsnew.section.removed",
  "Breaking Changes": "whatsnew.section.breakingChanges",
} as const satisfies Record<ReleaseNoteSection["heading"], CoreMessageKey>;

function ReleaseNoteSectionView({
  section,
  index,
  contentLanguage,
}: {
  readonly section: ReleaseNoteSection;
  readonly index: number;
  readonly contentLanguage: "en" | "ko";
}) {
  const t = useT();
  const tone = section.heading.toLowerCase().replaceAll(" ", "-");
  const style: WhatsNewSectionStyle = { "--whatsnew-delay": `${index * 55}ms` };
  return (
    <section className={`whatsnew-section whatsnew-section--${tone}`} style={style}>
      <h3>
        <span className="whatsnew-section-chip">{t(SECTION_LABEL_KEYS[section.heading])}</span>
      </h3>
      <ul>
        {section.items.map((item, itemIndex) => (
          <li key={`${item.text}:${itemIndex}`}>
            <ReleaseNoteItemView item={item} contentLanguage={contentLanguage} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReleaseNoteItemView({ item, contentLanguage }: { readonly item: ReleaseNoteItem; readonly contentLanguage: "en" | "ko" }) {
  return (
    <>
      {item.packageTags.map((tag, index) => (
        <span key={`${tag}:${index}`} className="whatsnew-package-chip">
          {tag}
        </span>
      ))}
      <span lang={contentLanguage}>{item.text}</span>
    </>
  );
}

function releaseNoteKey(version: string, index: number): string {
  return `${version}:${index}`;
}

const SELECT_CLOSED_TRIGGER_OPEN_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " "]);

function isOpenSelectPopup(popup: Element | null): popup is HTMLElement {
  return popup instanceof HTMLElement && popup.dataset.open === "true";
}

export function isSelectOwnedKeyEvent(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return false;

  if (target.closest('.fc-select__popup[data-open="true"]')) return true;

  const trigger = target.closest(".fc-select__trigger");
  if (trigger instanceof HTMLButtonElement) {
    const controlsId = trigger.getAttribute("aria-controls");
    if (controlsId && isOpenSelectPopup(document.getElementById(controlsId))) return true;
    return SELECT_CLOSED_TRIGGER_OPEN_KEYS.has(event.key);
  }

  return false;
}

function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleTabNavigation(
  event: KeyboardEvent,
  container: HTMLElement | null,
  setActiveTab: (tab: WhatsNewTabId) => void,
): boolean {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return false;
  const target = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>(".whatsnew-tab[role='tab']") : null;
  if (!target || !container) return false;
  const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>(".whatsnew-tab[role='tab']"));
  const currentIndex = tabs.indexOf(target);
  if (currentIndex < 0 || tabs.length === 0) return false;
  const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const next = tabs[nextIndex]!;
  const tabId = next.dataset.tabId as WhatsNewTabId | undefined;
  if (!tabId) return false;
  setActiveTab(tabId);
  next.focus();
  return true;
}
