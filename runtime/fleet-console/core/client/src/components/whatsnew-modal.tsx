import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

import { fetchReleaseNotes } from "../api.js";
import { applyReleaseNotes, beginReleaseNotesFetch, closeWhatsNew, failReleaseNotesFetch, selectReleaseNote } from "../store.js";
import type { ConsoleState, ReleaseNoteItem, ReleaseNoteSection } from "../types.js";

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
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  // What's new는 자동으로 열리므로, 다른 우선 오버레이가 떠 있거나 아직 theater bootstrap이 끝나지 않은
  // 동안에는 양보한다. 그렇지 않으면 뒤에 숨은 What's new의 window capture 리스너가 stopImmediatePropagation으로
  // visible 다이얼로그(commissioning·quick search·shortcuts·timeline)의 Esc/Tab을 가로챈다.
  // bootstrap 전에는 resolveOnboardingOnBootstrap()가 아직 돌지 않아 onboardingOpen이 false라,
  // /health가 /theaters보다 먼저 도착하면 onboardingOpen만으로는 게이트가 새므로 bootstrapped도 함께 본다.
  // 억제가 풀리면 whatsNewOpen이 유지된 채 아래 효과/렌더가 다시 살아나 그때 표시된다.
  const whatsNewSuppressed =
    !state.bootstrapped ||
    state.onboardingOpen ||
    state.operationSearchOpen ||
    state.shortcutsOpen;
  if (state.whatsNewOpen && !whatsNewSuppressed && returnFocusRef.current === null) {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    if (!state.whatsNewOpen || whatsNewSuppressed) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWhatsNew();
      } else if (event.key === "Tab") {
        trapFocus(event, cardRef.current);
      }
      event.stopImmediatePropagation();
    };
    closeButtonRef.current?.focus();
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      target?.focus?.();
    };
  }, [state.whatsNewOpen, whatsNewSuppressed]);

  if (!state.whatsNewOpen || whatsNewSuppressed || state.releaseNotes.length === 0) return null;
  const selectedKey = state.selectedReleaseNoteKey ?? releaseNoteKey(state.releaseNotes[0]?.version ?? "", 0);
  const selectedIndex = state.releaseNotes.findIndex((note, index) => releaseNoteKey(note.version, index) === selectedKey);
  const selected = state.releaseNotes[selectedIndex] ?? state.releaseNotes[0]!;
  const selectedValue = releaseNoteKey(selected.version, selectedIndex >= 0 ? selectedIndex : 0);
  const handleRefresh = () => {
    beginReleaseNotesFetch();
    void fetchReleaseNotes({ force: true })
      .then(applyReleaseNotes)
      .catch((error) => failReleaseNotesFetch(error instanceof Error ? error.message : String(error)));
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

  return (
    <div className="whatsnew-overlay" role="dialog" aria-modal="true" aria-labelledby="whatsnew-title">
      <button type="button" className="whatsnew-scrim" onClick={closeWhatsNew} aria-label="Close What's new" />
      <section className="whatsnew-card" ref={cardRef}>
        <header className="whatsnew-header">
          <div className="whatsnew-heading-row">
            <h2 id="whatsnew-title">What's new</h2>
            <span className="whatsnew-version-badge">v{selected.version}</span>
          </div>
          <div className="whatsnew-meta-row">
            {selected.date ? <time className="whatsnew-date" dateTime={selected.date}>Released {selected.date}</time> : <span className="whatsnew-date">Unreleased</span>}
            {state.releaseNotesStale ? <span className="whatsnew-stale">Stale</span> : null}
          </div>
        </header>
        <button ref={closeButtonRef} type="button" className="whatsnew-close" onClick={closeWhatsNew} aria-label="Close What's new">
          x
        </button>
        <div className="whatsnew-body">
          <div className="whatsnew-version-selector">
            <select aria-label="Release version" value={selectedValue} onChange={(event) => selectReleaseNote(event.currentTarget.value)}>
              {pageNotes.map((note, localIndex) => {
                const index = pageStart + localIndex;
                return (
                  <option key={releaseNoteKey(note.version, index)} value={releaseNoteKey(note.version, index)}>
                    {note.version === "Unreleased" ? "Unreleased" : `v${note.version}`}{note.date ? ` · ${note.date}` : ""}
                  </option>
                );
              })}
            </select>
            {pageCount > 1 ? (
              <div className="whatsnew-pagination">
                <button type="button" className="whatsnew-page-button" onClick={() => goToReleasePage(-1)} disabled={currentPage === 0} aria-label="Newer versions">
                  ‹
                </button>
                <span className="whatsnew-page-status">{currentPage + 1} / {pageCount}</span>
                <button type="button" className="whatsnew-page-button" onClick={() => goToReleasePage(1)} disabled={currentPage >= pageCount - 1} aria-label="Older versions">
                  ›
                </button>
              </div>
            ) : null}
            <button type="button" className="whatsnew-refresh" onClick={handleRefresh} disabled={state.releaseNotesLoading}>
              {state.releaseNotesLoading ? "Refreshing" : "Refresh"}
            </button>
          </div>
          {state.releaseNotesError ? <p className="whatsnew-error">Release notes could not be refreshed.</p> : null}
          {selected.sections.map((section, index) => (
            <ReleaseNoteSectionView key={section.heading} section={section} index={index} />
          ))}
        </div>
        <footer className="whatsnew-footer">
          <button type="button" className="whatsnew-done" onClick={closeWhatsNew}>
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}

function ReleaseNoteSectionView({ section, index }: { readonly section: ReleaseNoteSection; readonly index: number }) {
  const tone = section.heading.toLowerCase().replaceAll(" ", "-");
  const style: WhatsNewSectionStyle = { "--whatsnew-delay": `${index * 55}ms` };
  return (
    <section className={`whatsnew-section whatsnew-section--${tone}`} style={style}>
      <h3>
        <span className="whatsnew-section-chip">{section.heading}</span>
      </h3>
      <ul>
        {section.items.map((item, itemIndex) => (
          <li key={`${item.text}:${itemIndex}`}>
            <ReleaseNoteItemView item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReleaseNoteItemView({ item }: { readonly item: ReleaseNoteItem }) {
  return (
    <>
      {item.packageTags.map((tag, index) => (
        <span key={`${tag}:${index}`} className={`whatsnew-package-chip whatsnew-package-chip--${index % 2 === 0 ? "brass" : "aurora"}`}>
          {tag}
        </span>
      ))}
      <span>{item.text}</span>
    </>
  );
}

function releaseNoteKey(version: string, index: number): string {
  return `${version}:${index}`;
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
