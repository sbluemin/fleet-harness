import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { COMMISSIONING_SEEN_KEY, readStoredCommissioningSeen } from "../../../core/client/src/integration/store.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { openSettingsSurface } from "../../settings/client/settings-door.js";
import { requestTaskforceRowHighlight } from "../../settings/client/taskforce-highlight.js";
import { readCommodoreList } from "../../commodore/client/commodore-list.js";
import { TASKFORCE_INTRO_SEEN_KEY, rememberSeen } from "./seen-store.js";
import { TASKFORCE_INTRO_LOOP_S, TASKFORCE_INTRO_REST, taskforceIntroCanvas, taskforceIntroCopy } from "./taskforce-intro-copy.js";
import { drawTaskforceIntro } from "./taskforce-intro-scene.js";
import { makeGlanceKit, readGlancePalette } from "./fleet-at-a-glance.js";
import "./taskforce-intro.css";

// 승인 시안 v2의 신규 기능 카드 — 실험 기능을 켜지 않은 기존 사용자에게 데스크톱 콘솔 시작 시
// 한 번 뜬다. 모션 무대(640×300)와 색(--aurora·--positive·--text-*·--hairline-strong·
// --dialog-face)은 시안 그대로고, 그리는 도구는 '플릿 한눈에 보기'의 키트·팔레트를 공유한다.

const INTRO_STAGE_WIDTH = 640;
const INTRO_STAGE_HEIGHT = 300;

function useOsReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function TaskforceIntroDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const locale: ConsoleLocale = useConsoleLocale();
  const copy = taskforceIntroCopy(locale);
  const canvasCopy = taskforceIntroCanvas(locale);
  const dialogRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const osReduced = useOsReducedMotion();
  // Console 설정의 모션 감소 — OS 감속 모션과는 별개라 둘을 따로 잰다(한눈에 보기와 같은 판정).
  const settingReduced = useGlobalSettingsStore().state?.reduceMotion === true;
  const reduced = osReduced || settingReduced;

  const goSettings = (): void => {
    onClose();
    openSettingsSurface("experiments");
    requestTaskforceRowHighlight();
  };

  // 열리는 순간의 포커스를 돌려놓고, '알겠어요'에 먼저 둔다.
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    primaryRef.current?.focus();
    return () => {
      returnFocusRef.current?.focus?.();
      returnFocusRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const container = dialogRef.current;
        if (!container) return;
        const focusable = [...container.querySelectorAll<HTMLElement>("button:not([disabled])")];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
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
  }, [onClose]);

  // 모션 감소 때는 모든 단계가 보이는 정지 프레임 하나로 멈춘다.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const frame = (t: number): void => {
      const palette = readGlancePalette();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      if (cw === 0 || ch === 0) return;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width / INTRO_STAGE_WIDTH, 0, 0, canvas.height / INTRO_STAGE_HEIGHT, 0, 0);
      drawTaskforceIntro(makeGlanceKit(ctx, palette), palette, t, reduced, canvasCopy);
    };
    if (reduced) {
      frame(TASKFORCE_INTRO_REST);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number): void => {
      frame(((now - t0) / 1000) % TASKFORCE_INTRO_LOOP_S);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [canvasCopy, reduced]);

  return createPortal(
    <div className="tfi-overlay">
      <button type="button" className="tfi-scrim" aria-label={copy.dismiss} onClick={onClose} />
      <section ref={dialogRef} className="tfi-card" role="dialog" aria-modal="true" aria-labelledby="taskforce-intro-title">
        <div className="tfi-head">
          <span className="tfi-eyebrow">{copy.eyebrow}</span>
          <span className="tfi-chip">{copy.badge}</span>
        </div>
        <h2 id="taskforce-intro-title" className="tfi-title">{copy.title}</h2>
        <div ref={stageRef} className="tfi-stage">
          <canvas ref={canvasRef} aria-hidden="true" />
        </div>
        <p className="tfi-body">
          {copy.bodyPre}
          <strong>{copy.bodyEm1}</strong>
          {copy.bodyMid}
          <strong>{copy.bodyEm2}</strong>
          {copy.bodyPost}
        </p>
        <div className="tfi-foot">
          <button type="button" className="tfi-link" onClick={goSettings}>
            {copy.link} <span aria-hidden="true">→</span>
          </button>
          <button ref={primaryRef} type="button" className="tfi-primary" onClick={onClose}>
            {copy.primary}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

// ── 호스트: 실험 기능을 켜지 않은 기존 사용자에게 데스크톱 시작 시 한 번만 ──────

export function TaskforceIntroHost(): React.JSX.Element | null {
  const state = useConsoleState();
  const settings = useGlobalSettingsStore();
  // 모바일 레이아웃에는 띄우지 않고 본 기록만 남긴다 — 닫으면 다시 열 길이 없어서다.
  const mobileLayout = useViewMode().effective === "mobile";
  const [open, setOpen] = useState(false);
  // 이 세션에 이미 띄웠거나(닫힘 포함) 조용히 기록했으면 다시 판단하지 않는다.
  const settledRef = useRef(false);
  // 새 사용자·기존 사용자 판정은 세션에서 설정을 처음 ready로 읽은 그 틱에 한 번만 한다(한눈에 보기와 같다).
  const classifiedRef = useRef<"fresh" | "returning" | null>(null);

  const close = useCallback((): void => {
    settledRef.current = true;
    setOpen(false);
    rememberSeen([TASKFORCE_INTRO_SEEN_KEY]);
  }, []);

  useEffect(() => {
    if (settledRef.current || open) return;
    if (!state.bootstrapped) return;
    if (settings.loadStatus !== "ready" || !settings.state) return;
    if (settings.state.seenFeatureTours.includes(TASKFORCE_INTRO_SEEN_KEY)) {
      settledRef.current = true;
      return;
    }
    if (classifiedRef.current === null) {
      const returning = settings.state.seenFeatureTours.includes(COMMISSIONING_SEEN_KEY)
        || readStoredCommissioningSeen()
        || readCommodoreList().length > 0;
      classifiedRef.current = returning ? "returning" : "fresh";
    }
    // 처음 설치한 사람·이미 켠 사람·모바일 화면에는 띄우지 않고 본 기록만 조용히 남긴다.
    if (classifiedRef.current === "fresh" || settings.state.experiments.taskforce === true || mobileLayout) {
      rememberSeen([TASKFORCE_INTRO_SEEN_KEY]);
      settledRef.current = true;
      return;
    }
    // 시작하기·새 소식·플릿 한눈에 보기가 떠 있으면 닫힌 뒤에 띄운다.
    if (state.onboardingOpen || state.whatsNewOpen || state.fleetAtAGlanceOpen) return;
    setOpen(true);
    rememberSeen([TASKFORCE_INTRO_SEEN_KEY]);
  }, [
    mobileLayout,
    open,
    state.bootstrapped,
    state.fleetAtAGlanceOpen,
    state.onboardingOpen,
    state.whatsNewOpen,
    settings.loadStatus,
    settings.state,
  ]);

  if (!open) return null;
  // 다른 우선 오버레이가 떠 있으면 양보한다 — 한눈에 보기와 같은 억제 조건이다.
  const suppressed = !state.bootstrapped
    || state.onboardingOpen
    || state.whatsNewOpen
    || state.fleetAtAGlanceOpen
    || state.objectiveRecordSearchOpen
    || (state.controlHolder !== null && !state.controlCurtainDismissed)
    || state.mobileNewSessionOpen
    || state.keyboardShortcutsOpen;
  if (suppressed) return null;
  return <TaskforceIntroDialog onClose={close} />;
}
