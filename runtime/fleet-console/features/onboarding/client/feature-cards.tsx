import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { closeFeatureCardsReplay, COMMISSIONING_SEEN_KEY, readStoredCommissioningSeen } from "../../../core/client/src/integration/store.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import type { GlobalSettingsState } from "../../../core/client/src/integration/types.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { readCommodoreList } from "../../commodore/client/commodore-list.js";
import { QUAKER_PROMOTION_SEEN_KEY, TASKFORCE_INTRO_SEEN_KEY, rememberSeen } from "./seen-store.js";
import { TaskforceIntroCard, TaskforceIntroLink } from "./taskforce-intro.js";
import { QuakerPromotionCard, QuakerPromotionLink } from "./quaker-promotion-card.js";

// 새 기능 카드 — 지금까지 나온 카드의 유일한 목록이다. 첫 실행 노출과 도움말 › 새 기능 다시보기가
// 같은 목록을 같은 순서로 읽는다. 새 카드는 이 목록 끝에 한 항목을 더하면 두 곳 모두에 이어진다.

export interface FeatureCardContentProps {
  /** 대화상자의 aria-labelledby가 가리키는 제목 id — 카드가 자기 제목에 붙인다. */
  readonly titleId: string;
}

export interface FeatureCardLinkProps {
  /** 카드를 닫는다 — 다른 화면으로 데려가는 링크가 먼저 부른다. */
  readonly onLeave: () => void;
}

export interface FeatureCard {
  /** 본 기록 키(seenFeatureTours) — 한 번 배포한 키는 바꾸지 않는다. 바꾸면 이미 본 사람에게 다시 선다. */
  readonly seenKey: string;
  /** 첫 실행 노출 조건. 거짓이면 띄우지 않고 본 기록만 조용히 남긴다. 다시보기는 이 조건을 보지 않는다. */
  readonly autoShow: (settings: GlobalSettingsState) => boolean;
  readonly Content: (props: FeatureCardContentProps) => React.JSX.Element;
  /** 아래 줄 왼쪽에 서는 카드 자신의 링크. */
  readonly Link?: (props: FeatureCardLinkProps) => React.JSX.Element;
}

export const FEATURE_CARDS: readonly FeatureCard[] = [
  {
    seenKey: TASKFORCE_INTRO_SEEN_KEY,
    // 이미 실험 기능을 켠 사람에게는 소개할 것이 없다.
    autoShow: (settings) => settings.experiments.taskforce !== true,
    Content: TaskforceIntroCard,
    Link: TaskforceIntroLink,
  },
  {
    seenKey: QUAKER_PROMOTION_SEEN_KEY,
    // 진급 소식은 모두에게 보여 준다.
    autoShow: () => true,
    Content: QuakerPromotionCard,
    Link: QuakerPromotionLink,
  },
];

interface FeatureCardsShellCopy {
  readonly primary: string;
  readonly next: string;
  readonly previous: string;
  readonly dismiss: string;
  readonly position: (index: number, total: number) => string;
}

const shellKo: FeatureCardsShellCopy = {
  primary: "알겠어요",
  next: "다음",
  previous: "이전",
  dismiss: "새 기능 카드 닫기",
  position: (index, total) => `${total}장 중 ${index}번째`,
};

const shellEn: FeatureCardsShellCopy = {
  primary: "Got it",
  next: "Next",
  previous: "Back",
  dismiss: "Dismiss the new feature cards",
  position: (index, total) => `Card ${index} of ${total}`,
};

function shellCopy(locale: ConsoleLocale): FeatureCardsShellCopy {
  return locale === "ko" ? shellKo : shellEn;
}

/** 카드 여러 장을 순서대로 넘기는 대화상자. 한 장이면 넘김 표시 없이 그 카드만 선다. */
function FeatureCardsDialog({ cards, onClose }: { readonly cards: readonly FeatureCard[]; readonly onClose: () => void }): React.JSX.Element | null {
  const copy = shellCopy(useConsoleLocale());
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const total = cards.length;
  const last = index >= total - 1;
  const card = cards[Math.min(index, total - 1)];

  // 열리는 순간의 포커스를 돌려놓고, 1차 버튼에 먼저 둔다.
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      returnFocusRef.current?.focus?.();
      returnFocusRef.current = null;
    };
  }, []);
  // 넘길 때마다 1차 버튼으로 돌아와 Enter를 이어 누르면 다음 장으로 간다.
  useEffect(() => {
    primaryRef.current?.focus();
  }, [index]);

  const step = useCallback((delta: number): void => {
    setIndex((current) => Math.max(0, Math.min(total - 1, current + delta)));
  }, [total]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (total > 1 && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        event.preventDefault();
        step(event.key === "ArrowRight" ? 1 : -1);
      } else if (event.key === "Tab") {
        const container = dialogRef.current;
        if (!container) return;
        const focusable = [...container.querySelectorAll<HTMLElement>("button:not([disabled])")];
        const first = focusable[0];
        const lastFocusable = focusable[focusable.length - 1];
        if (!first || !lastFocusable) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          lastFocusable.focus();
        } else if (!event.shiftKey && document.activeElement === lastFocusable) {
          event.preventDefault();
          first.focus();
        }
      } else {
        return;
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, step, total]);

  if (!card) return null;
  const titleId = `feature-card-title-${card.seenKey}`;
  const { Content, Link } = card;
  return createPortal(
    <div className="tfi-overlay">
      <button type="button" className="tfi-scrim" aria-label={copy.dismiss} onClick={onClose} />
      <section ref={dialogRef} className="tfi-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <Content key={card.seenKey} titleId={titleId} />
        <div className="tfi-foot">
          {Link ? <Link onLeave={onClose} /> : null}
          <div className="tfi-actions">
            {total > 1 ? (
              <>
                <span className="tfi-dots" role="img" aria-label={copy.position(index + 1, total)}>
                  {cards.map((entry, at) => (
                    <span key={entry.seenKey} className={at === index ? "tfi-dot tfi-dot--current" : "tfi-dot"} />
                  ))}
                </span>
                <button type="button" className="tfi-secondary" disabled={index === 0} onClick={() => step(-1)}>
                  {copy.previous}
                </button>
              </>
            ) : null}
            <button ref={primaryRef} type="button" className="tfi-primary" onClick={last ? onClose : () => step(1)}>
              {last ? copy.primary : copy.next}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

// ── 호스트: 첫 실행에는 아직 안 본 카드를 한 번만, 다시보기에는 목록 전체를 순서대로 ──────

export function FeatureCardsHost(): React.JSX.Element | null {
  const state = useConsoleState();
  const settings = useGlobalSettingsStore();
  // 모바일 레이아웃에는 띄우지 않고 본 기록만 남긴다 — 닫으면 다시 열 길이 없어서다.
  const mobileLayout = useViewMode().effective === "mobile";
  const [autoCards, setAutoCards] = useState<readonly FeatureCard[] | null>(null);
  // 이 세션에 이미 띄웠거나(닫힘 포함) 조용히 기록했으면 다시 판단하지 않는다.
  const settledRef = useRef(false);
  // 새 사용자·기존 사용자 판정은 세션에서 설정을 처음 ready로 읽은 그 틱에 한 번만 한다(한눈에 보기와 같다).
  const classifiedRef = useRef<"fresh" | "returning" | null>(null);

  const closeAuto = useCallback((): void => {
    settledRef.current = true;
    setAutoCards(null);
  }, []);

  useEffect(() => {
    if (settledRef.current || autoCards !== null) return;
    if (!state.bootstrapped) return;
    if (settings.loadStatus !== "ready" || !settings.state) return;
    const seen = settings.state.seenFeatureTours;
    const unseen = FEATURE_CARDS.filter((card) => !seen.includes(card.seenKey));
    if (unseen.length === 0) {
      settledRef.current = true;
      return;
    }
    if (classifiedRef.current === null) {
      const returning = seen.includes(COMMISSIONING_SEEN_KEY)
        || readStoredCommissioningSeen()
        || readCommodoreList().length > 0;
      classifiedRef.current = returning ? "returning" : "fresh";
    }
    const current = settings.state;
    const shown = classifiedRef.current === "fresh" || mobileLayout ? [] : unseen.filter((card) => card.autoShow(current));
    // 처음 설치한 사람·모바일 화면·조건에 맞지 않는 카드는 띄우지 않고 본 기록만 조용히 남긴다.
    const silent = unseen.filter((card) => !shown.includes(card));
    if (silent.length > 0) rememberSeen(silent.map((card) => card.seenKey));
    if (shown.length === 0) {
      settledRef.current = true;
      return;
    }
    // 시작하기·새 소식·플릿 한눈에 보기·다시보기가 떠 있으면 닫힌 뒤에 띄운다.
    if (state.onboardingOpen || state.whatsNewOpen || state.fleetAtAGlanceOpen || state.featureCardsReplayOpen) return;
    setAutoCards(shown);
    rememberSeen(shown.map((card) => card.seenKey));
  }, [
    autoCards,
    mobileLayout,
    state.bootstrapped,
    state.featureCardsReplayOpen,
    state.fleetAtAGlanceOpen,
    state.onboardingOpen,
    state.whatsNewOpen,
    settings.loadStatus,
    settings.state,
  ]);

  if (!state.featureCardsReplayOpen && autoCards === null) return null;
  // 다른 우선 오버레이가 떠 있으면 양보한다 — 한눈에 보기와 같은 억제 조건이다. 다시보기도 같은 조건으로
  // 숨는다: 떠 있는 채로 두면 이 대화상자의 키 처리가 리모컨 커튼보다 먼저 Escape·Tab을 가져간다.
  // 억제가 풀리면 열린 상태가 유지된 채 다시 선다.
  const suppressed = !state.bootstrapped
    || state.onboardingOpen
    || state.whatsNewOpen
    || state.fleetAtAGlanceOpen
    || state.objectiveRecordSearchOpen
    || (state.controlHolder !== null && !state.controlCurtainDismissed)
    || state.keyboardShortcutsOpen;
  if (suppressed) return null;
  // 다시보기는 본 기록을 읽지도 쓰지도 않는다 — 첫 실행 노출 판단과 무관하게 목록 전체를 보여 준다.
  if (state.featureCardsReplayOpen) {
    return <FeatureCardsDialog cards={FEATURE_CARDS} onClose={closeFeatureCardsReplay} />;
  }
  if (autoCards === null) return null;
  return <FeatureCardsDialog cards={autoCards} onClose={closeAuto} />;
}
