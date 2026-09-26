import { useEffect, useRef, useState, type ReactNode } from "react";

import { useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
import { useT, type CoreMessageKey } from "../../i18n/index.js";
import type { ConsoleState } from "../../integration/types.js";
import { rememberSeenFeatureTour } from "./feature-tour.js";

/**
 * 새 기능 도입을 알리는 1회성 소개 카드.
 *
 * What's New 모달이 닫히는 전이에서만 떠서 릴리스 노트와 겹치지 않고, 어떤 경로로든 닫히면
 * seenFeatureTours(카드의 seenKey)에 영속되어 다시 뜨지 않는다. 기능을 가볍게 알리는 자리이고,
 * 실제 사용법은 그 기능의 화면에 서는 투어가 이어받는다 — 카드가 닫혀야 그 투어가 시작된다
 * (aria-modal 다이얼로그가 떠 있는 동안 투어·레일 말풍선은 기다린다).
 *
 * 카드는 한 번에 한 장만 선다: 두 장을 연달아 세우면 사용자에게는 한 장짜리 긴 안내와 다르지
 * 않다. 목록 앞쪽(새 기능)이 먼저이고, 남은 카드는 다음 What's New가 닫힐 때 제 순서에 선다.
 */
interface FeatureWelcomeCard {
  readonly seenKey: string;
  readonly titleKey: CoreMessageKey;
  readonly bodyKey: CoreMessageKey;
  readonly nextKey: CoreMessageKey;
  readonly dismissKey: CoreMessageKey;
  readonly art: () => ReactNode;
  /** 기능이 이 콘솔에 실제로 있는지 — 없으면 소개하지 않고 다음 카드로 넘어간다. */
  readonly available?: (root: ParentNode) => boolean;
}

export const OBJECTIVES_WELCOME_SEEN_KEY = "objectives.welcome";
export const BROWSER_WELCOME_SEEN_KEY = "operation-browser.welcome";

const FEATURE_WELCOME_CARDS: readonly FeatureWelcomeCard[] = [
  {
    seenKey: OBJECTIVES_WELCOME_SEEN_KEY,
    titleKey: "featureWelcome.objectives.title",
    bodyKey: "featureWelcome.objectives.body",
    nextKey: "featureWelcome.objectives.next",
    dismissKey: "featureWelcome.objectives.dismiss",
    art: () => <ObjectivesWelcomeIllustration />,
    // Objectives는 내장 플러그인이 레일에 세우는 진입점이다 — 그 아이콘이 없으면 가리킬 곳도 없다.
    available: (root) => root.querySelector("#rail-tab-objectives") !== null,
  },
  {
    seenKey: BROWSER_WELCOME_SEEN_KEY,
    titleKey: "browserWelcome.title",
    bodyKey: "browserWelcome.body",
    nextKey: "browserWelcome.next",
    dismissKey: "browserWelcome.dismiss",
    art: () => <BrowserWelcomeIllustration />,
  },
];

export function FeatureWelcome({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const settings = useGlobalSettingsStore();
  const [card, setCard] = useState<FeatureWelcomeCard | null>(null);
  const prevWhatsNewOpen = useRef(state.whatsNewOpen);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const seen = settings.state?.seenFeatureTours ?? null;

  useEffect(() => {
    const wasOpen = prevWhatsNewOpen.current;
    prevWhatsNewOpen.current = state.whatsNewOpen;
    // What's New가 "닫히는" 전이만 본다 — 설정 로드 전(seen 미상)에는 판단을 미룬다.
    if (!wasOpen || state.whatsNewOpen || !seen) return;
    const next = FEATURE_WELCOME_CARDS.find((entry) => !seen.includes(entry.seenKey) && (entry.available?.(document) ?? true));
    if (!next) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCard(next);
  }, [state.whatsNewOpen, seen]);

  useEffect(() => { if (card) confirmRef.current?.focus(); }, [card]);

  if (!card) return null;
  const seenKey = card.seenKey;
  const dismiss = () => {
    setCard(null);
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
    rememberSeenFeatureTour(seenKey);
  };

  return (
    <div className="feature-welcome-overlay" role="presentation" data-feature-welcome={card.seenKey}>
      <button type="button" className="feature-welcome-scrim" tabIndex={-1} aria-label={t(card.dismissKey)} onClick={dismiss} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="feature-welcome-title"
        className="feature-welcome-card"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); dismiss(); return; }
          // 포커스 정거장이 확인 버튼 하나뿐이므로 Tab은 그 자리에서 돈다.
          if (event.key === "Tab") { event.preventDefault(); confirmRef.current?.focus(); }
        }}
      >
        {card.art()}
        <div className="feature-welcome-copy">
          <h2 id="feature-welcome-title">{t(card.titleKey)}</h2>
          <p>{t(card.bodyKey)}</p>
          <p className="feature-welcome-next">{t(card.nextKey)}</p>
        </div>
        <button ref={confirmRef} type="button" className="feature-welcome-confirm" onClick={dismiss}>{t("featureWelcome.confirm")}</button>
      </section>
    </div>
  );
}

/**
 * Objectives 소개 일러스트 — 목표 카드(브리핑·달성 기준)에서 임무 보드가 갈라져 나오고, 지휘관과
 * 구성원 세션이 그 임무를 나눠 맡는다. 테마 토큰만 소비한다.
 */
function ObjectivesWelcomeIllustration() {
  return (
    <svg className="feature-welcome-art" viewBox="0 0 360 176" role="img" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="objectives-welcome-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.2" fill="var(--text-tertiary)" opacity="0.35" />
        </pattern>
      </defs>
      <rect x="8" y="8" width="344" height="160" rx="10" fill="var(--canvas-sea-mid)" stroke="var(--hairline)" />
      <rect x="8" y="8" width="344" height="160" rx="10" fill="url(#objectives-welcome-dots)" />
      {/* 목표 카드 — 제목, 브리핑 줄, 달성 기준 체크 */}
      <rect x="22" y="26" width="112" height="124" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <circle cx="36" cy="42" r="5" fill="none" stroke="var(--brass)" strokeWidth="1.4" />
      <rect x="47" y="39.5" width="62" height="5" rx="2.5" fill="var(--text-primary)" opacity="0.72" />
      <rect x="32" y="58" width="90" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="32" y="67" width="72" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.38" />
      {[86, 104, 122].map((y, index) => (
        <g key={y}>
          <rect x="32" y={y - 5} width="10" height="10" rx="2.5" fill={index < 2 ? "var(--positive)" : "none"} opacity={index < 2 ? 0.85 : 1} stroke={index < 2 ? "none" : "var(--text-tertiary)"} strokeWidth="1.1" />
          {index < 2 ? <path d={`M34.4 ${y}l1.9 1.9 3.4-3.6`} fill="none" stroke="var(--surface-panel)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /> : null}
          <rect x="48" y={y - 2} width={[62, 50, 70][index]} height="4" rx="2" fill="var(--text-secondary)" opacity="0.55" />
        </g>
      ))}
      {/* 임무 보드 — 선행 관계로 이어진 노드 */}
      <g fill="none" stroke="var(--hairline-strong)" strokeWidth="1.3">
        <path d="M134 88h14" />
        <path d="M176 60c14 0 10 28 26 28M176 116c14 0 10-28 26-28" />
        <path d="M230 88h14" />
      </g>
      <rect x="148" y="48" width="28" height="24" rx="6" fill="var(--surface-panel)" stroke="var(--positive)" strokeWidth="1.3" />
      <path d="M156 60l3.4 3.4 6-6.4" fill="none" stroke="var(--positive)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="148" y="104" width="28" height="24" rx="6" fill="var(--surface-panel)" stroke="var(--brass)" strokeWidth="1.3" />
      <circle cx="162" cy="116" r="4" fill="var(--brass)" opacity="0.85" />
      <rect x="202" y="76" width="28" height="24" rx="6" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <rect x="209" y="86.5" width="14" height="3" rx="1.5" fill="var(--text-tertiary)" opacity="0.6" />
      {/* 지휘관과 구성원 세션 */}
      <rect x="244" y="26" width="94" height="58" rx="8" fill="var(--surface-panel)" stroke="var(--brass)" strokeWidth="1.3" />
      <path d="M256 38l5-4 5 4-5 4z" fill="var(--brass)" />
      <rect x="272" y="35.5" width="50" height="5" rx="2.5" fill="var(--text-primary)" opacity="0.7" />
      <rect x="254" y="52" width="72" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="254" y="62" width="56" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.38" />
      <rect x="254" y="72" width="30" height="5" rx="2.5" fill="var(--brass)" opacity="0.7" />
      <rect x="244" y="94" width="44" height="56" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <circle cx="256" cy="106" r="3.2" fill="var(--id-cerulean)" />
      <rect x="252" y="118" width="28" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="252" y="128" width="20" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.38" />
      <rect x="294" y="94" width="44" height="56" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <circle cx="306" cy="106" r="3.2" fill="var(--id-teal, var(--positive))" />
      <rect x="302" y="118" width="28" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="302" y="128" width="16" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.38" />
    </svg>
  );
}

/** Operation Browser 소개 일러스트 — 캔버스 위의 Operation 패널 옆에 선 브라우저 companion. 테마 토큰만 소비한다. */
function BrowserWelcomeIllustration() {
  return (
    <svg className="feature-welcome-art" viewBox="0 0 360 176" role="img" aria-hidden="true" focusable="false">
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
