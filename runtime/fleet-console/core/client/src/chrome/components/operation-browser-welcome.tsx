import { useEffect, useRef, useState } from "react";

import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField, useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
import { useT } from "../../i18n/index.js";
import type { ConsoleState } from "../../integration/types.js";
import { appendSeenFeatureTour } from "./feature-tour.js";

/**
 * Operation Browser 도입 1회성 소개 카드.
 *
 * What's New 모달이 닫히는 전이에서만 떠서 릴리스 노트와 겹치지 않고, 어떤 경로로든 닫히면
 * seenFeatureTours("operation-browser.welcome")에 영속되어 다시 뜨지 않는다. 기능을 가볍게 알리는
 * 자리이고, 실제 사용법(예시 프롬프트)은 Operation 을 열었을 때 캡션의 지구본에 서는 투어
 * (feature-tour-catalog "operation-browser")가 이어받는다 — 이 카드가 닫혀야 그 투어가 시작된다
 * (aria-modal 다이얼로그가 떠 있는 동안 투어는 기다린다).
 */
export const BROWSER_WELCOME_SEEN_KEY = "operation-browser.welcome";

export function OperationBrowserWelcome({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const settings = useGlobalSettingsStore();
  const [open, setOpen] = useState(false);
  const prevWhatsNewOpen = useRef(state.whatsNewOpen);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const seen = settings.state?.seenFeatureTours ?? null;

  useEffect(() => {
    const wasOpen = prevWhatsNewOpen.current;
    prevWhatsNewOpen.current = state.whatsNewOpen;
    // What's New가 "닫히는" 전이만 본다 — 설정 로드 전(seen 미상)에는 판단을 미룬다.
    if (!wasOpen || state.whatsNewOpen) return;
    if (!seen || seen.includes(BROWSER_WELCOME_SEEN_KEY)) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, [state.whatsNewOpen, seen]);

  useEffect(() => { if (open) confirmRef.current?.focus(); }, [open]);

  const dismiss = () => {
    setOpen(false);
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
    // 닫는 즉시 캡션 투어가 같은 seenFeatureTours 필드를 저장할 수 있다 — 인플라이트 저장이 끝난 틱에만 시도한다.
    void (async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const base = getGlobalSettingsStoreState().state?.seenFeatureTours ?? [];
        if (base.includes(BROWSER_WELCOME_SEEN_KEY)) return;
        if (!isSavingGlobalSettingsField("seenFeatureTours") && await setGlobalSettingsField("seenFeatureTours", appendSeenFeatureTour(base, BROWSER_WELCOME_SEEN_KEY))) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })();
  };

  if (!open) return null;
  return (
    <div className="browser-welcome-overlay" role="presentation">
      <button type="button" className="browser-welcome-scrim" tabIndex={-1} aria-label={t("browserWelcome.dismiss")} onClick={dismiss} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-welcome-title"
        className="browser-welcome-card"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); dismiss(); return; }
          // 포커스 정거장이 확인 버튼 하나뿐이므로 Tab은 그 자리에서 돈다.
          if (event.key === "Tab") { event.preventDefault(); confirmRef.current?.focus(); }
        }}
      >
        <BrowserWelcomeIllustration />
        <div className="browser-welcome-copy">
          <h2 id="browser-welcome-title">{t("browserWelcome.title")}</h2>
          <p>{t("browserWelcome.body")}</p>
          <p className="browser-welcome-next">{t("browserWelcome.next")}</p>
        </div>
        <button ref={confirmRef} type="button" className="browser-welcome-confirm" onClick={dismiss}>{t("browserWelcome.confirm")}</button>
      </section>
    </div>
  );
}

/** 기능 소개 일러스트 — 캔버스 위의 Operation 패널 옆에 선 브라우저 companion. 테마 토큰만 소비한다. */
function BrowserWelcomeIllustration() {
  return (
    <svg className="browser-welcome-art" viewBox="0 0 360 176" role="img" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="browser-welcome-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.2" fill="var(--text-tertiary)" opacity="0.35" />
        </pattern>
      </defs>
      {/* 캔버스(Map) */}
      <rect x="8" y="8" width="344" height="160" rx="10" fill="var(--canvas-sea-mid)" stroke="var(--hairline)" />
      <rect x="8" y="8" width="344" height="160" rx="10" fill="url(#browser-welcome-dots)" />
      {/* Operation 패널 — 캡션의 지구본 문이 brass 로 켜져 있다 */}
      <rect x="26" y="30" width="138" height="116" rx="8" fill="var(--surface-panel)" stroke="var(--hairline)" />
      <rect x="26" y="30" width="138" height="22" rx="8" fill="none" stroke="var(--hairline)" />
      <circle cx="38" cy="41" r="3" fill="var(--positive)" />
      <rect x="48" y="38.5" width="52" height="5" rx="2.5" fill="var(--text-secondary)" opacity="0.6" />
      <g transform="translate(139 34)">
        <rect x="0" y="0" width="16" height="14" rx="3" fill="var(--brass)" opacity="0.22" />
        <circle cx="8" cy="7" r="4.6" fill="none" stroke="var(--brass)" strokeWidth="1.3" />
        <path d="M3.4 7h9.2M8 2.4c1.7 1.6 1.7 7.6 0 9.2M8 2.4c-1.7 1.6-1.7 7.6 0 9.2" fill="none" stroke="var(--brass)" strokeWidth="1.1" />
      </g>
      <rect x="38" y="64" width="86" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.55" />
      <rect x="38" y="78" width="108" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.4" />
      <rect x="38" y="92" width="70" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="38" y="106" width="96" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.35" />
      <rect x="38" y="126" width="60" height="6" rx="3" fill="var(--brass)" opacity="0.75" />
      {/* 브라우저 companion — 탭 스트립·주소 필·페이지 */}
      <rect x="178" y="30" width="158" height="116" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <rect x="178" y="30" width="158" height="22" rx="8" fill="none" stroke="var(--hairline-strong)" />
      <g transform="translate(186 35)">
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--text-secondary)" strokeWidth="1.2" />
        <path d="M1.6 6h8.8M6 1.6c1.6 1.5 1.6 7.3 0 8.8M6 1.6c-1.6 1.5-1.6 7.3 0 8.8" fill="none" stroke="var(--text-secondary)" strokeWidth="1" />
      </g>
      <rect x="204" y="35" width="58" height="12" rx="3" fill="var(--ink-veil)" stroke="var(--hairline-strong)" />
      <rect x="209" y="39.5" width="6" height="3" rx="1.5" fill="var(--aurora)" />
      <rect x="219" y="39.5" width="34" height="3" rx="1.5" fill="var(--text-primary)" opacity="0.7" />
      <rect x="270" y="39.5" width="8" height="3" rx="1.5" fill="var(--text-tertiary)" opacity="0.6" />
      <rect x="196" y="60" width="122" height="12" rx="6" fill="var(--ink-veil)" />
      <rect x="230" y="64.5" width="54" height="3" rx="1.5" fill="var(--text-primary)" opacity="0.7" />
      <rect x="186" y="80" width="142" height="58" rx="4" fill="var(--ink-pearl)" opacity="0.92" />
      <rect x="198" y="90" width="64" height="6" rx="3" fill="var(--ink-abyss)" opacity="0.7" />
      <rect x="198" y="104" width="118" height="4" rx="2" fill="var(--ink-abyss)" opacity="0.3" />
      <rect x="198" y="114" width="96" height="4" rx="2" fill="var(--ink-abyss)" opacity="0.3" />
      <rect x="198" y="124" width="40" height="8" rx="4" fill="var(--id-cerulean)" opacity="0.9" />
      {/* 에이전트 사용 중 — 보라 링이 companion 을 두른다 */}
      <rect x="180" y="32" width="154" height="112" rx="7" fill="none" stroke="var(--agent-control-badge)" strokeWidth="1.6" opacity="0.8" />
    </svg>
  );
}
