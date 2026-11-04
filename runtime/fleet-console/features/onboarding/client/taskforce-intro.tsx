import { useEffect, useRef, useState } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { openSettingsSurface } from "../../settings/client/settings-door.js";
import { requestTaskforceRowHighlight } from "../../settings/client/taskforce-highlight.js";
import type { FeatureCardContentProps, FeatureCardLinkProps } from "./feature-cards.js";
import { TASKFORCE_INTRO_LOOP_S, TASKFORCE_INTRO_REST, taskforceIntroCanvas, taskforceIntroCopy } from "./taskforce-intro-copy.js";
import { drawTaskforceIntro } from "./taskforce-intro-scene.js";
import { makeGlanceKit, readGlancePalette } from "./fleet-at-a-glance.js";
import "./taskforce-intro.css";

// 승인 시안 v2의 신규 기능 카드 — 실험 기능을 켜지 않은 기존 사용자에게 데스크톱 콘솔 시작 시
// 한 번 뜬다(노출 조건은 feature-cards.tsx의 목록 항목). 모션 무대(640×300)와 색(--aurora·--positive·
// --text-*·--hairline-strong·--dialog-face)은 시안 그대로고, 그리는 도구는 '플릿 한눈에 보기'의 키트·팔레트를 공유한다.

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

/** 태스크포스 소개 카드의 본문 — 대화상자 면·포커스·넘김·닫기 버튼은 새 기능 카드 셸(feature-cards.tsx)이 맡는다. */
export function TaskforceIntroCard({ titleId }: FeatureCardContentProps): React.JSX.Element {
  const locale: ConsoleLocale = useConsoleLocale();
  const copy = taskforceIntroCopy(locale);
  const canvasCopy = taskforceIntroCanvas(locale);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const osReduced = useOsReducedMotion();
  // Console 설정의 모션 감소 — OS 감속 모션과는 별개라 둘을 따로 잰다(한눈에 보기와 같은 판정).
  const settingReduced = useGlobalSettingsStore().state?.reduceMotion === true;
  const reduced = osReduced || settingReduced;

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

  return (
    <>
      <div className="tfi-head">
        <span className="tfi-eyebrow">{copy.eyebrow}</span>
        <span className="tfi-chip">{copy.badge}</span>
      </div>
      <h2 id={titleId} className="tfi-title">{copy.title}</h2>
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
    </>
  );
}

/** 카드 아래 줄 왼쪽의 '설정에서 켜기' — 카드를 닫고 실험 기능 행을 짚어 준다. 다시보기에서도 그대로 선다. */
export function TaskforceIntroLink({ onLeave }: FeatureCardLinkProps): React.JSX.Element {
  const copy = taskforceIntroCopy(useConsoleLocale());
  const goSettings = (): void => {
    onLeave();
    openSettingsSurface("experiments");
    requestTaskforceRowHighlight();
  };
  return (
    <button type="button" className="tfi-link" onClick={goSettings}>
      {copy.link} <span aria-hidden="true">→</span>
    </button>
  );
}
