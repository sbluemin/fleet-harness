import { useEffect, useRef, useState } from "react";

import { rememberSeen } from "../../../../../features/onboarding/client/seen-store.js";
import { useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
import { saveClassicLayout } from "../../../../../features/settings/client/use-conversation-layout.js";
import { useT } from "../../i18n/index.js";
import { trapFocus } from "./commissioning-overlay.js";

/** 본 기록 키 — 한 번 배포한 키는 바꾸지 않는다. 바꾸면 이미 본 사람에게 카드가 다시 선다. */
export const CONVERSATION_WELCOME_SEEN_KEY = "conversation-layout.welcome";

// 조건이 이만큼 이어져야 선다 — 부팅 직후 What's New·첫 실행 안내가 자리를 잡기 전에 먼저 뜨지 않게 한다.
const SETTLE_MS = 1200;
const POLL_MS = 200;

// 다른 모달(설정 등)이 떠 있으면 셸이 inert 라 카드가 그 안에서 눌리지 않는다 — 그동안은 기다린다.
function blockedByAnotherModal(): boolean {
  return document.querySelector<HTMLElement>(".console-shell")?.inert === true || document.querySelector('[aria-modal="true"]') !== null;
}

interface ConversationWelcomeProps {
  /** 대화 중심 화면이 서 있고, 앞서야 할 다른 안내(첫 실행·What's New·팔레트 등)가 없다. 판정은 호스트가 한다. */
  readonly eligible: boolean;
  /** 「이전 화면으로 돌아가기」가 저장된 뒤 — 호스트가 되돌리기 알림을 세운다. */
  readonly onReturned: () => void;
}

/**
 * 대화 중심 화면 웰컴 카드 — 기본 화면이 바뀐 것을 데스크톱에서 처음 만났을 때 한 번 서는 가운데 카드.
 * 이전 화면으로 돌아가는 길을 바로 준다. 어느 버튼으로 닫아도 본 것으로 남는다. 첫 실행 안내와 같은 재질이다.
 */
export function ConversationWelcome({ eligible, onReturned }: ConversationWelcomeProps) {
  const t = useT();
  const globalSettings = useGlobalSettingsStore();
  const seen = globalSettings.state?.seenFeatureTours.includes(CONVERSATION_WELCOME_SEEN_KEY) ?? true;
  const ready = eligible && globalSettings.loadStatus === "ready" && !seen;
  const [settled, setSettled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [backFailed, setBackFailed] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const visible = ready && settled && !dismissed;

  // 「화면 안내 다시 보기」가 본 기록을 지우면 이 화면에서 닫아 둔 표시도 거둔다 — 새로고침 없이 다시 선다.
  useEffect(() => {
    if (seen) return;
    setDismissed(false);
    setSettled(false);
  }, [seen]);

  useEffect(() => {
    if (!ready || settled) return;
    let since = performance.now();
    const timer = setInterval(() => {
      if (blockedByAnotherModal()) since = performance.now();
      else if (performance.now() - since >= SETTLE_MS) setSettled(true);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [ready, settled]);

  useEffect(() => {
    if (!visible) return;
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keepRef.current?.focus();
    return () => returnTarget?.focus?.();
  }, [visible]);

  const close = () => {
    setDismissed(true);
    rememberSeen([CONVERSATION_WELCOME_SEEN_KEY]);
  };

  // 저장이 성공한 뒤에만 닫는다 — 실패하면 화면이 대화 중심으로 되돌아오고 카드도 다시 서서 한 번 더 누를 수 있다.
  const goBack = () => {
    setBackFailed(false);
    void saveClassicLayout(true).then((saved) => {
      if (!saved) {
        setBackFailed(true);
        return;
      }
      close();
      onReturned();
    });
  };

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Tab") {
        trapFocus(event, cardRef.current);
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  });

  if (!visible) return null;

  return (
    <div className="commissioning-overlay" role="dialog" aria-modal="true" aria-labelledby="conversation-welcome-title">
      <button type="button" className="commissioning-scrim" tabIndex={-1} onClick={() => close()} aria-label={t("chrome.conversationWelcome.closeAria")} />
      <section className="commissioning-card conversation-welcome-card" ref={cardRef}>
        <button type="button" className="conversation-welcome-close" onClick={() => close()} aria-label={t("chrome.conversationWelcome.closeAria")}>×</button>
        <header className="commissioning-header">
          <ConversationLayoutPicture />
          <h2 id="conversation-welcome-title">{t("chrome.conversationWelcome.title")}</h2>
          <p>{t("chrome.conversationWelcome.body")}</p>
          {backFailed ? <p className="commissioning-error" role="alert">{t("chrome.conversationWelcome.backFailed")}</p> : null}
        </header>
        <footer className="commissioning-footer conversation-welcome-actions">
          <button type="button" className="commissioning-skip" onClick={goBack}>{t("chrome.conversationWelcome.back")}</button>
          <button type="button" ref={keepRef} className="commissioning-primary-action" onClick={() => close()}>{t("chrome.conversationWelcome.keep")}</button>
        </footer>
      </section>
    </div>
  );
}

/** 세 칸(사이드바 · 대화 · 세부 정보)의 작은 그림. 테마 토큰만 쓴다. */
function ConversationLayoutPicture() {
  return (
    <svg className="conversation-welcome-picture" viewBox="0 0 120 56" aria-hidden="true" focusable="false">
      <rect className="conversation-welcome-picture-frame" x="0.5" y="0.5" width="119" height="55" rx="7" />
      <rect className="conversation-welcome-picture-side" x="1" y="1" width="28" height="54" rx="6.5" />
      <rect className="conversation-welcome-picture-line" x="7" y="10" width="16" height="3" rx="1.5" />
      <rect className="conversation-welcome-picture-line" x="7" y="17" width="12" height="3" rx="1.5" />
      <rect className="conversation-welcome-picture-line" x="7" y="24" width="14" height="3" rx="1.5" />
      <rect className="conversation-welcome-picture-bubble" x="58" y="10" width="26" height="7" rx="3.5" />
      <rect className="conversation-welcome-picture-line" x="36" y="22" width="40" height="3" rx="1.5" />
      <rect className="conversation-welcome-picture-line" x="36" y="28" width="30" height="3" rx="1.5" />
      <rect className="conversation-welcome-picture-composer" x="35" y="41" width="52" height="8" rx="4" />
      <line className="conversation-welcome-picture-rule" x1="93.5" y1="1" x2="93.5" y2="55" />
      <rect className="conversation-welcome-picture-line" x="99" y="10" width="15" height="3" rx="1.5" />
      <rect className="conversation-welcome-picture-line" x="99" y="17" width="10" height="3" rx="1.5" />
    </svg>
  );
}
