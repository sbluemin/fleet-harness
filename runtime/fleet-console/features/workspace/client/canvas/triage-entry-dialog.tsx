import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { cancelTriageEntry, confirmTriageEntry, useTriageEntryRequest } from "./triage-store.js";

/** 웰컴 카드의 그림·표면·버튼 문법을 쓰는 진입 확인. 지목은 store가 열기 전에 보관한다. */
export function TriageEntryDialog() {
  const request = useTriageEntryRequest();
  const t = useT();
  const cardRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (request) primaryRef.current?.focus(); }, [request]);
  useEffect(() => () => cancelTriageEntry(), []);
  if (!request) return null;
  return createPortal(
    <div className="onboarding-welcome-overlay" role="presentation">
      <button type="button" className="onboarding-welcome-scrim" tabIndex={-1} aria-label={t("common.cancel")} onClick={cancelTriageEntry} />
      <div className="onboarding-welcome-deck">
        <section ref={cardRef} className="onboarding-welcome-card" role="dialog" aria-modal="true" aria-labelledby="triage-entry-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelTriageEntry(); }
            if (event.key === "Tab") {
              // 웰컴 대화상자와 같은 버튼 순환으로 포커스를 가둔다.
              const buttons = [...(cardRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
              if (!buttons.length) return;
              event.preventDefault();
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
            }
          }}>
          <div className="onboarding-welcome-slide">
            <div className="onboarding-welcome-copy"><h2 id="triage-entry-title">{t("canvas.triage.entryTitle")}</h2></div>
            <div className="onboarding-welcome-art"><WarRoomEntryIllustration /></div>
            <div className="onboarding-welcome-copy"><p>{t("canvas.triage.entryBody")}</p></div>
          </div>
          <div className="onboarding-welcome-foot">
            <span />
            <div className="onboarding-welcome-actions">
              <button type="button" className="onboarding-welcome-secondary" onClick={cancelTriageEntry}>{t("common.cancel")}</button>
              <button ref={primaryRef} type="button" className="onboarding-welcome-primary" onClick={confirmTriageEntry}>{t("canvas.triage.entryConfirm")}</button>
            </div>
          </div>
        </section>
      </div>
    </div>, document.body,
  );
}

/**
 * War Room 진입 일러스트 — 답을 기다리는 Operation 하나가 aurora 테두리로 무대에 서고, 그 아래 덱에 나머지 살아 있는
 * Operation이 줄지어 있다. 바닥은 brass 수평선의 War Room 막대 — 킥커, 모드 스위치, 도구, 대기열(aurora 주의선과 빛), Fleet 앰블럼이다.
 * 테마 토큰만 소비한다.
 */
function WarRoomEntryIllustration() {
  return (
    <svg viewBox="0 0 360 176" role="img" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="war-room-entry-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.2" fill="var(--text-tertiary)" opacity="0.35" />
        </pattern>
        <radialGradient id="war-room-entry-stage-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--aurora)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--aurora)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="war-room-entry-horizon" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--brass)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--brass)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="war-room-entry-queue-glow" cx="50%" cy="100%" r="60%">
          <stop offset="0%" stopColor="var(--aurora)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--aurora)" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* 캔버스 */}
      <rect x="8" y="8" width="344" height="160" rx="10" fill="var(--canvas-sea-mid)" stroke="var(--hairline)" />
      <rect x="8" y="8" width="344" height="160" rx="10" fill="url(#war-room-entry-dots)" />
      {/* War Room 막대 위로 번지는 brass 수평선의 빛과 대기열의 aurora 빛 */}
      <rect x="8" y="124" width="344" height="14" fill="url(#war-room-entry-horizon)" />
      <rect x="140" y="124" width="136" height="14" fill="url(#war-room-entry-queue-glow)" />
      {/* 무대 — 답을 기다리는 Operation 하나 */}
      <ellipse cx="180" cy="62" rx="118" ry="58" fill="url(#war-room-entry-stage-glow)" />
      <rect x="96" y="18" width="168" height="88" rx="8" fill="var(--surface-panel)" stroke="var(--aurora)" strokeOpacity="0.85" />
      <path d="M96 38h168" stroke="var(--hairline-strong)" />
      <circle cx="108" cy="28" r="3" fill="var(--aurora)" />
      <rect x="117" y="25.5" width="60" height="5" rx="2.5" fill="var(--text-secondary)" opacity="0.7" />
      <rect x="108" y="48" width="112" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.55" />
      <rect x="108" y="61" width="136" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.4" />
      <rect x="108" y="74" width="88" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.5" />
      {/* 기다리는 질문 */}
      <rect x="108" y="87" width="144" height="12" rx="4" fill="var(--aurora)" fillOpacity="0.12" stroke="var(--aurora)" strokeOpacity="0.5" />
      <rect x="114" y="91.5" width="54" height="3" rx="1.5" fill="var(--aurora)" opacity="0.8" />
      <rect x="226" y="90" width="20" height="6" rx="3" fill="var(--brass)" opacity="0.8" />
      {/* 덱 — 나머지 살아 있는 Operation */}
      <g stroke="var(--hairline)">
        <rect x="30" y="114" width="54" height="17" rx="4" fill="var(--surface-panel)" />
        <rect x="92" y="114" width="54" height="17" rx="4" fill="var(--surface-panel)" stroke="var(--aurora)" strokeOpacity="0.6" />
        <rect x="154" y="114" width="54" height="17" rx="4" fill="var(--surface-panel)" stroke="var(--positive)" strokeOpacity="0.55" />
        <rect x="216" y="114" width="54" height="17" rx="4" fill="var(--surface-panel)" />
        <rect x="278" y="114" width="54" height="17" rx="4" fill="var(--surface-panel)" opacity="0.7" />
      </g>
      <circle cx="38" cy="122.5" r="2.2" fill="var(--text-tertiary)" opacity="0.7" />
      <rect x="44" y="121" width="30" height="3" rx="1.5" fill="var(--text-tertiary)" opacity="0.6" />
      <circle cx="100" cy="122.5" r="2.2" fill="var(--aurora)" />
      <rect x="106" y="121" width="30" height="3" rx="1.5" fill="var(--text-secondary)" opacity="0.7" />
      <circle cx="162" cy="122.5" r="2.2" fill="var(--positive)" />
      <rect x="168" y="121" width="30" height="3" rx="1.5" fill="var(--text-secondary)" opacity="0.7" />
      <circle cx="224" cy="122.5" r="2.2" fill="var(--text-tertiary)" opacity="0.7" />
      <rect x="230" y="121" width="30" height="3" rx="1.5" fill="var(--text-tertiary)" opacity="0.6" />
      <circle cx="286" cy="122.5" r="2.2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="292" y="121" width="30" height="3" rx="1.5" fill="var(--text-tertiary)" opacity="0.45" />
      {/* War Room 막대 — brass 수평선 */}
      <path d="M8 138h344v20a10 10 0 0 1-10 10H18a10 10 0 0 1-10-10z" fill="var(--surface-band)" />
      <path d="M8 138h344" stroke="var(--brass)" strokeOpacity="0.75" />
      {/* 왼쪽부터 킥커 · 모드 스위치(War Room 선택) · 덱 밀도와 자동 무대 도구 */}
      <text x="17" y="155.5" fill="var(--brass-ink)" fontFamily="var(--font-ui)" fontSize="7" fontWeight="700" letterSpacing="0.9">WAR ROOM</text>
      <rect x="66" y="147" width="30" height="12" rx="4" fill="none" stroke="var(--surface-rim-strong)" />
      <rect x="81" y="147" width="15" height="12" rx="4" fill="var(--brass)" fillOpacity="0.28" />
      <rect x="70" y="152" width="7" height="2" rx="1" fill="var(--text-tertiary)" opacity="0.7" />
      <rect x="85" y="152" width="7" height="2" rx="1" fill="var(--brass)" />
      <g fill="none" stroke="var(--text-secondary)" strokeWidth="1.2" strokeLinecap="round" opacity="0.8">
        <rect x="103" y="149" width="3.6" height="3.6" rx="0.8" />
        <rect x="108.4" y="149" width="3.6" height="3.6" rx="0.8" />
        <rect x="103" y="154.4" width="3.6" height="3.6" rx="0.8" />
        <rect x="108.4" y="154.4" width="3.6" height="3.6" rx="0.8" />
        <path d="M124 147.5v2M124 156.5v2M118.5 153h2M127.5 153h2" />
        <circle cx="124" cy="153" r="2.2" />
      </g>
      <path d="M137 146v14" stroke="var(--surface-rim-strong)" />
      {/* 대기열 — aurora 주의선, 무대에 선 것(brass 밑줄) 다음 대기 건들 */}
      <path d="M146 138.5h124" stroke="var(--aurora)" strokeOpacity="0.85" strokeWidth="1.2" />
      <rect x="142" y="146" width="44" height="14" rx="4" fill="var(--surface-glass-strong)" />
      <circle cx="149" cy="153" r="2.5" fill="var(--aurora)" />
      <rect x="155" y="151.5" width="25" height="3" rx="1.5" fill="var(--text-primary)" opacity="0.8" />
      <rect x="148" y="161" width="32" height="1.6" rx="0.8" fill="var(--brass)" />
      <circle cx="197" cy="153" r="2.5" fill="var(--aurora)" />
      <rect x="203" y="151.5" width="25" height="3" rx="1.5" fill="var(--text-secondary)" opacity="0.7" />
      <circle cx="241" cy="153" r="2.5" fill="var(--aurora)" opacity="0.8" />
      <rect x="247" y="151.5" width="25" height="3" rx="1.5" fill="var(--text-secondary)" opacity="0.6" />
      {/* 오른쪽 끝 — Fleet 앰블럼 */}
      <path d="M309 146v14" stroke="var(--surface-rim-strong)" />
      <rect x="315" y="146" width="14" height="14" rx="3.5" fill="var(--ink-deep)" stroke="var(--surface-rim-strong)" />
      <circle cx="322" cy="153" r="4.2" fill="none" stroke="var(--brass)" strokeWidth="1.2" />
      <circle cx="322" cy="153" r="1.2" fill="var(--brass)" />
      <rect x="333" y="151" width="12" height="4" rx="2" fill="var(--text-primary)" opacity="0.75" />
    </svg>
  );
}
