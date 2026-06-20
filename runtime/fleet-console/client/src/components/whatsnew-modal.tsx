import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

import { RELEASE_NOTES } from "../release-notes.generated.js";
import { closeWhatsNew } from "../store.js";
import type { ConsoleState, ReleaseNoteSection } from "../types.js";

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

export function WhatsNewModal({ state }: WhatsNewModalProps) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  // commissioning(onboarding)이 떠 있거나 아직 theater bootstrap이 끝나지 않은 동안에는 What's new를 양보한다.
  // 두 모달이 동시에 window capture 리스너를 걸면 뒤에 숨은 What's new가 visible 다이얼로그의 Esc/Tab을
  // 가로채기 때문이다. bootstrap 전에는 resolveOnboardingOnBootstrap()가 아직 돌지 않아 onboardingOpen이 false라,
  // /observer/status가 /observer/theaters보다 먼저 도착하면 onboardingOpen만으로는 게이트가 새므로 bootstrapped도 함께 본다.
  // 억제가 풀리면 whatsNewOpen이 유지된 채 아래 효과/렌더가 다시 살아나 그때 표시된다.
  const whatsNewSuppressed = state.onboardingOpen || !state.bootstrapped;
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

  if (!state.whatsNewOpen || whatsNewSuppressed || RELEASE_NOTES === null) return null;

  return (
    <div className="whatsnew-overlay" role="dialog" aria-modal="true" aria-labelledby="whatsnew-title">
      <button type="button" className="whatsnew-scrim" onClick={closeWhatsNew} aria-label="Close What's new" />
      <section className="whatsnew-card" ref={cardRef}>
        <header className="whatsnew-header">
          <div className="whatsnew-heading-row">
            <h2 id="whatsnew-title">What's new</h2>
            <span className="whatsnew-version-badge">v{RELEASE_NOTES.version}</span>
          </div>
          <time className="whatsnew-date" dateTime={RELEASE_NOTES.date}>
            Released {RELEASE_NOTES.date}
          </time>
        </header>
        <button ref={closeButtonRef} type="button" className="whatsnew-close" onClick={closeWhatsNew} aria-label="Close What's new">
          x
        </button>
        <div className="whatsnew-body">
          {RELEASE_NOTES.sections.map((section, index) => (
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
        {section.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
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
