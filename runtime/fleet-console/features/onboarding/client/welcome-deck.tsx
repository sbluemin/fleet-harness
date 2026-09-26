import { useEffect, useRef, useState } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OnboardingWelcomeSlide } from "@fleet-console/sdk/onboarding";

import { onboardingT } from "./i18n.js";
import { rememberSeen } from "./seen-store.js";

// 앞 카드가 옆으로 밀려나는 시간 — 다음 카드는 이 뒤에 들어온다.
const WELCOME_LEAVE_MS = 170;

export interface WelcomeCandidate {
  readonly seenKey: string;
  readonly slide: OnboardingWelcomeSlide;
}

/**
 * 웰컴 — 업데이트로 새로 생긴 기능을 기존 사용자에게 알리는 카드 한 장.
 *
 * What's New가 닫히는 전이에서만 서서 릴리스 노트와 겹치지 않는다. 안 본 슬라이드만 모아 큐처럼 겹쳐 보이고, 「다음」으로
 * 앞 카드를 밀어내며 넘긴다. 안 본 것만 모으므로
 * A를 본 사람이 업데이트해 B가 생기면 카드에는 B 한 장만 선다. 어떤 경로로 닫든 보인 슬라이드는 모두 본 것이다 —
 * 카드는 "이번에 새로 생긴 것"이라는 한 번의 사건이고, 넘기지 않은 슬라이드를 다음에 다시 세우면 이미 지난 소식이 된다.
 */
export function WelcomeDeck({ candidates, whatsNewOpen, seen, language }: {
  readonly candidates: readonly WelcomeCandidate[];
  readonly whatsNewOpen: boolean;
  readonly seen: readonly string[] | null;
  readonly language: ConsoleLocale;
}) {
  const t = onboardingT(language);
  const [deck, setDeck] = useState<readonly WelcomeCandidate[] | null>(null);
  const [index, setIndex] = useState(0);
  // 넘기는 방향과 떠나는 중인가 — 앞 카드가 옆으로 밀려난 뒤 다음 카드가 반대쪽에서 들어온다.
  const [direction, setDirection] = useState<"next" | "previous">("next");
  const [leaving, setLeaving] = useState(false);
  const leaveTimerRef = useRef<number | null>(null);
  const prevWhatsNewOpen = useRef(whatsNewOpen);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const wasOpen = prevWhatsNewOpen.current;
    prevWhatsNewOpen.current = whatsNewOpen;
    // What's New가 "닫히는" 전이만 본다 — 설정 로드 전(seen 미상)에는 판단을 미룬다.
    if (!wasOpen || whatsNewOpen || !seen) return;
    const unseen = candidates.filter((candidate) => !seen.includes(candidate.seenKey));
    if (unseen.length === 0) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIndex(0);
    setDirection("next");
    setDeck(unseen);
  }, [candidates, seen, whatsNewOpen]);

  useEffect(() => { if (deck && !leaving) primaryRef.current?.focus(); }, [deck, index, leaving]);
  useEffect(() => () => { if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current); }, []);

  if (!deck) return null;
  const total = deck.length;
  const current = deck[Math.min(index, total - 1)]!;
  const last = index >= total - 1;
  // 뒤에 쌓인 카드 — 아직 넘기지 않은 슬라이드 수만큼(최대 둘) 현재 카드 밑으로 비쳐 보인다.
  const queued = Math.min(2, total - 1 - index);
  const dismiss = () => {
    setDeck(null);
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
    rememberSeen(deck.map((candidate) => candidate.seenKey));
  };
  const go = (next: number) => {
    const target = Math.max(0, Math.min(total - 1, next));
    if (target === index || leaving) return;
    setDirection(target > index ? "next" : "previous");
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setIndex(target);
      return;
    }
    setLeaving(true);
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      setLeaving(false);
      setIndex(target);
    }, WELCOME_LEAVE_MS);
  };

  return (
    <div className="onboarding-welcome-overlay" role="presentation">
      <button type="button" className="onboarding-welcome-scrim" tabIndex={-1} aria-label={t("welcome.dismiss")} onClick={dismiss} />
      <div className="onboarding-welcome-deck">
        {[0, 1].map((depth) => (
          <span key={depth} className={`onboarding-welcome-queued is-depth-${depth + 1}${depth < queued ? " is-queued" : ""}`} aria-hidden="true" />
        ))}
        <section
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          aria-roledescription="carousel"
          aria-labelledby="onboarding-welcome-title"
          className="onboarding-welcome-card"
          data-onboarding-welcome={current.seenKey}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); dismiss(); return; }
            if (event.key === "ArrowRight") { event.preventDefault(); go(index + 1); return; }
            if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); return; }
            if (event.key === "Tab") {
              // 포커스는 카드의 버튼들 사이에서만 돈다.
              const buttons = [...(cardRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
              if (buttons.length === 0) return;
              event.preventDefault();
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
            }
          }}
        >
          <div className="onboarding-welcome-head">
            <span className="onboarding-welcome-eyebrow">{t("welcome.eyebrow")}</span>
            {total > 1 ? <span className="onboarding-welcome-count">{index + 1} / {total}</span> : null}
          </div>
          <div className="onboarding-welcome-viewport">
            <div
              key={current.seenKey}
              className={`onboarding-welcome-slide is-from-${direction}${leaving ? ` is-leaving-${direction}` : ""}`}
              role="group"
              aria-roledescription="slide"
              aria-label={t("welcome.slide", { current: index + 1, total })}
            >
              {current.slide.art ? <div className="onboarding-welcome-art">{current.slide.art()}</div> : null}
              <div className="onboarding-welcome-copy">
                <h2 id="onboarding-welcome-title">{resolveLocalizedText(current.slide.title, language)}</h2>
                <p>{resolveLocalizedText(current.slide.body, language)}</p>
                {current.slide.next ? <p className="onboarding-welcome-next">{resolveLocalizedText(current.slide.next, language)}</p> : null}
              </div>
            </div>
          </div>
          <div className="onboarding-welcome-foot">
            {total > 1 ? (
              <div className="onboarding-welcome-dots" aria-hidden="true">
                {deck.map((candidate, dot) => <span key={candidate.seenKey} className={dot === index ? "is-current" : dot < index ? "is-done" : undefined} />)}
              </div>
            ) : <span />}
            <div className="onboarding-welcome-actions">
              {total > 1 && index > 0 ? <button type="button" className="onboarding-welcome-secondary" onClick={() => go(index - 1)}>{t("welcome.previous")}</button> : null}
              <button
                ref={primaryRef}
                type="button"
                className="onboarding-welcome-primary"
                onClick={() => (last ? dismiss() : go(index + 1))}
              >
                {t(last ? "welcome.confirm" : "welcome.next")}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
