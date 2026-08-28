import { useEffect, useRef, useState } from "react";

import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { themePolarity } from "../store.js";
import type { ConsoleState } from "../types.js";
import { appendSeenFeatureTour } from "./feature-tour.js";

/**
 * 리퀴드 글래스 도입 1회성 환영 모달.
 *
 * What's New 모달이 닫히는 전이에서만 떠서 릴리스 노트와 겹치지 않고, 어떤 경로로든
 * 닫히면 seenFeatureTours("liquid-glass.welcome")에 영속되어 다시 뜨지 않는다.
 * 저장 필드는 커미셔닝·피처 투어와 공유하지만, 이 키는 화면 사용법 안내가 아니라
 * 특정 릴리스의 1회성 소개라서 "화면 안내 다시 보기"(forgetAllOnboarding)의 리셋
 * 집합에 의도적으로 넣지 않는다 — 한 번 닫으면 어떤 경로로도 다시 뜨지 않는 것이
 * 이 모달의 제품 계약이다(기능 안내 자체는 설정 체크박스 도움말이 상시 대신한다).
 * 이미 설정에서 리퀴드 글래스를 꺼 둔 사용자에게는 소개가 무의미하므로 띄우지 않는다
 * (그 경우에도 seen을 남기지 않는다 — 켠 뒤 처음 What's New를 닫는 순간 소개를 받는다).
 * 라이트 테마도 같은 이유로 건너뛴다 — 그 테마에는 유리가 실리지 않으므로 소개가 곧 거짓이
 * 되고, 마찬가지로 seen을 남기지 않아 다크로 옮긴 뒤 제때 소개를 받는다.
 */
export const GLASS_WELCOME_SEEN_KEY = "liquid-glass.welcome";

export function LiquidGlassWelcome({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const settings = useGlobalSettingsStore();
  const [open, setOpen] = useState(false);
  const prevWhatsNewOpen = useRef(state.whatsNewOpen);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const seen = settings.state?.seenFeatureTours ?? null;
  // 화면에 실제로 유리가 실렸는가 — 저장된 선호와 테마 극성이 함께 정한다. 극성은 DOM에 방금
  // 실린 activeTheme에서 읽는다(설정 왕복을 기다리는 settings.state.theme는 한 박자 늦다).
  const liquidGlassOn = (settings.state?.liquidGlass ?? true) && themePolarity(state.activeTheme) === "dark";

  useEffect(() => {
    const wasOpen = prevWhatsNewOpen.current;
    prevWhatsNewOpen.current = state.whatsNewOpen;
    // What's New가 "닫히는" 전이만 본다 — 설정 로드 전(seen 미상)에는 판단을 미룬다.
    if (!wasOpen || state.whatsNewOpen) return;
    if (!seen || seen.includes(GLASS_WELCOME_SEEN_KEY)) return;
    if (!liquidGlassOn) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, [state.whatsNewOpen, seen, liquidGlassOn]);

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  const dismiss = () => {
    setOpen(false);
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
    // 닫는 즉시 투어가 재개될 수 있고, 투어 완주가 같은 seenFeatureTours 필드를 저장하면
    // 스토어는 겹친 같은-필드 저장을 거부한다(false). 고정 횟수 재시도는 느린 저장(>재시도
    // 창)에 전부 막혀 키가 미영속으로 남을 수 있으므로, 인플라이트 같은-필드 저장이 끝난
    // 것을 확인한 틱에만 시도한다 — 성공했거나 다른 경로가 이미 키를 실어 줬으면 그 자리에서
    // 끝나고, 상한은 서버 무응답 같은 비정상 상황의 무한 대기만 막는다.
    void (async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const base = getGlobalSettingsStoreState().state?.seenFeatureTours ?? [];
        if (base.includes(GLASS_WELCOME_SEEN_KEY)) return;
        if (
          !isSavingGlobalSettingsField("seenFeatureTours")
          && await setGlobalSettingsField("seenFeatureTours", appendSeenFeatureTour(base, GLASS_WELCOME_SEEN_KEY))
        ) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })();
  };

  if (!open) return null;
  return (
    <div className="glass-welcome-overlay" role="presentation">
      <button type="button" className="glass-welcome-scrim" tabIndex={-1} aria-label={t("glassWelcome.dismiss")} onClick={dismiss} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="glass-welcome-title"
        className="glass-welcome-card"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            dismiss();
            return;
          }
          // 포커스 정거장이 확인 버튼 하나뿐이므로 Tab은 그 자리에서 돈다.
          if (event.key === "Tab") {
            event.preventDefault();
            confirmRef.current?.focus();
          }
        }}
      >
        <GlassWelcomeIllustration />
        <div className="glass-welcome-copy">
          <h2 id="glass-welcome-title">{t("glassWelcome.title")}</h2>
          <p>{t("glassWelcome.body")}</p>
          <p className="glass-welcome-revert">{t("glassWelcome.revert")}</p>
        </div>
        <button ref={confirmRef} type="button" className="glass-welcome-confirm" onClick={dismiss}>
          {t("glassWelcome.confirm")}
        </button>
      </section>
    </div>
  );
}

/** 기능 소개 일러스트 — 캔버스 위에 뜬 유리판 두 장. 테마 토큰만 소비해 네 테마를 따라온다. */
function GlassWelcomeIllustration() {
  return (
    <svg className="glass-welcome-art" viewBox="0 0 360 176" role="img" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="glass-welcome-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.2" fill="var(--text-tertiary)" opacity="0.35" />
        </pattern>
        <linearGradient id="glass-welcome-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--text-primary)" stopOpacity="0.14" />
          <stop offset="0.4" stopColor="var(--text-primary)" stopOpacity="0.02" />
          <stop offset="1" stopColor="var(--text-primary)" stopOpacity="0.07" />
        </linearGradient>
      </defs>
      {/* 캔버스(Map) — 도트 격자와 정박한 패널 한 장 */}
      <rect x="8" y="8" width="344" height="160" rx="10" fill="var(--canvas-sea-mid)" stroke="var(--hairline)" />
      <rect x="8" y="8" width="344" height="160" rx="10" fill="url(#glass-welcome-dots)" />
      <rect x="28" y="30" width="150" height="96" rx="8" fill="var(--surface-panel)" stroke="var(--hairline)" />
      <rect x="28" y="30" width="150" height="22" rx="8" fill="none" stroke="var(--hairline)" />
      <circle cx="40" cy="41" r="3" fill="var(--positive)" />
      <rect x="40" y="62" width="92" height="5" rx="2.5" fill="var(--brass)" opacity="0.75" />
      <rect x="40" y="76" width="118" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.55" />
      <rect x="40" y="90" width="74" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.4" />
      <rect x="40" y="104" width="104" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.5" />
      {/* 유리판 두 장 — 틴트+림. 실제 채널 토큰을 그대로 소비해 게이트/테마를 따라온다. */}
      <g>
        <rect x="150" y="52" width="140" height="88" rx="10" fill="var(--glass-tint-strong)" stroke="var(--surface-rim-strong)" />
        <rect x="150" y="52" width="140" height="88" rx="10" fill="url(#glass-welcome-sheen)" />
        <rect x="150.5" y="52.5" width="139" height="1.5" rx="0.75" fill="var(--glass-rim)" />
        <rect x="166" y="70" width="86" height="6" rx="3" fill="var(--text-primary)" opacity="0.8" />
        <rect x="166" y="86" width="104" height="5" rx="2.5" fill="var(--text-secondary)" opacity="0.65" />
        <rect x="166" y="100" width="64" height="5" rx="2.5" fill="var(--text-secondary)" opacity="0.5" />
        <rect x="166" y="116" width="44" height="10" rx="5" fill="var(--brass)" opacity="0.85" />
      </g>
      <g>
        <rect x="252" y="24" width="84" height="58" rx="9" fill="var(--glass-tint-strong)" stroke="var(--surface-rim-strong)" />
        <rect x="252" y="24" width="84" height="58" rx="9" fill="url(#glass-welcome-sheen)" />
        <rect x="252.5" y="24.5" width="83" height="1.5" rx="0.75" fill="var(--glass-rim)" />
        <circle cx="266" cy="40" r="4" fill="var(--aurora)" opacity="0.85" />
        <rect x="276" y="37" width="46" height="5" rx="2.5" fill="var(--text-primary)" opacity="0.7" />
        <rect x="264" y="52" width="58" height="4.5" rx="2.25" fill="var(--text-secondary)" opacity="0.55" />
        <rect x="264" y="64" width="40" height="4.5" rx="2.25" fill="var(--text-secondary)" opacity="0.4" />
      </g>
    </svg>
  );
}
