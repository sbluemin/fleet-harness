import { useEffect, useRef, useState } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";
import { makeGlanceKit, readGlancePalette, type GlanceKit, type GlancePalette } from "@fleet-console/ui/glance-kit";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { openSettingsSurface } from "../../settings/client/settings-door.js";
import { requestTaskforceRowHighlight } from "../../settings/client/taskforce-highlight.js";
import type { FeatureCardContentProps, FeatureCardLinkProps } from "./feature-cards.js";
import "./taskforce-intro.css";

// 태스크포스 소개 카드의 문구 — 승인 시안 v2의 문구표 그대로다. 본문의 굵은 두 대목은
// 문장 순서가 언어마다 달라 통째로 번역하지 않고 다섯 조각으로 나눠 잇는다.

export interface TaskforceIntroCopy {
  readonly eyebrow: string;
  readonly badge: string;
  readonly title: string;
  readonly bodyPre: string;
  readonly bodyEm1: string;
  readonly bodyMid: string;
  readonly bodyEm2: string;
  readonly bodyPost: string;
  readonly link: string;
}

export interface TaskforceIntroCanvasCopy {
  readonly topic: string;
  readonly goal: string;
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly d: string;
  readonly step1: string;
  readonly step2: string;
  readonly step3: string;
}

const copyKo: TaskforceIntroCopy = {
  eyebrow: "새 기능",
  badge: "실험 기능",
  title: "태스크포스: 사령관 여럿이 함께 판단하고 목표를 세워요",
  bodyPre: "사령관 2명 이상이 한 주제를 두고 ",
  bodyEm1: "함께 판단하고",
  bodyMid: ", 그 판단으로 ",
  bodyEm2: "목표를 세워 진행",
  bodyPost: "까지 이어 가요. 실험 기능이라 기본으로 꺼져 있어요.",
  link: "설정에서 켜기",
};

const copyEn: TaskforceIntroCopy = {
  eyebrow: "New",
  badge: "Experimental",
  title: "TaskForce: Commodores judge together and set the objective",
  bodyPre: "Two or more Commodores ",
  bodyEm1: "judge one topic together",
  bodyMid: ", then turn that judgment into ",
  bodyEm2: "an objective",
  bodyPost: " and carry it forward. It is experimental and off by default.",
  link: "Turn on in Settings",
};

export function taskforceIntroCopy(locale: ConsoleLocale): TaskforceIntroCopy {
  return locale === "ko" ? copyKo : copyEn;
}

const canvasKo: TaskforceIntroCanvasCopy = {
  topic: "주제 하나",
  goal: "목표",
  a: "사령관 A",
  b: "사령관 B",
  c: "사령관 C",
  d: "사령관 D",
  step1: "① 주제 하나에 모여",
  step2: "② 함께 판단하고",
  step3: "③ 목표를 세워 진행해요",
};

const canvasEn: TaskforceIntroCanvasCopy = {
  topic: "One topic",
  goal: "Objective",
  a: "Commodore A",
  b: "Commodore B",
  c: "Commodore C",
  d: "Commodore D",
  step1: "① Gather on one topic",
  step2: "② Judge together",
  step3: "③ Set the objective and proceed",
};

export function taskforceIntroCanvas(locale: ConsoleLocale): TaskforceIntroCanvasCopy {
  return locale === "ko" ? canvasKo : canvasEn;
}

/** 모션 감소 때 그리는 정지 프레임 — 세 단계가 모두 보이는 시각(초)이다. */
export const TASKFORCE_INTRO_REST = 12;

/** 모션 한 바퀴 — 시안 v2와 같은 15초다. */
export const TASKFORCE_INTRO_LOOP_S = 15;

// 승인 시안 v2의 drawTaskforce를 Console로 옮긴 것이다 — 모이기·판단은 '플릿 한눈에 보기'의
// 태스크포스 장면에서 출발하고, 끝에 목표 수립·진행 단계가 더해졌다. 그리는 도구는 glance의
// 키트·팔레트를 공유하고, 여기서는 목표 진행 고리(부분 원호)만 캔버스에 직접 긋는다.
// '플릿 한눈에 보기'의 태스크포스 장면은 바꾸지 않는다.

const INTRO_TAU = Math.PI * 2;
const INTRO_JUDGE = 3;
const INTRO_GOAL = 8;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);
const atTime = (t: number, start: number, dur = 0.6): number => easeOut((t - start) / dur);
const ellPoint = (cx: number, cy: number, rx: number, ry: number, ang: number): [number, number] => [
  cx + rx * Math.cos(ang),
  cy + ry * Math.sin(ang),
];

export function drawTaskforceIntro(
  k: GlanceKit,
  c: GlancePalette,
  t: number,
  reduced: boolean,
  L: TaskforceIntroCanvasCopy,
): void {
  k.stars(37, 36, t);
  const cx = 320;
  const cy = 150;
  const home: (readonly [number, number])[] = [
    [90, 74],
    [550, 74],
    [90, 234],
    [550, 234],
  ];
  const names = [L.a, L.b, L.c, L.d];
  const g = atTime(t, 1.2, 1.8);
  const at0 = atTime(t, 1.6, 0.7);
  const goal = reduced ? 1 : atTime(t, INTRO_GOAL, 0.9);
  k.ring(cx, cy, 150, 82, c.hair, g * 0.9, 1, [2, 5], -t * 5);

  // 가운데: 주제 → 목표
  k.orb(cx, cy, 16 * at0, c.flow, at0 * (1 - goal));
  k.orb(cx, cy, 16 * at0, c.result, at0 * goal);
  k.text(L.topic, cx, cy + 32, { a: at0 * (1 - goal) });
  // 목표 라벨은 진행 고리(반지름 26)의 아래쪽과 겹치므로 한참 아래에 둔다.
  k.text(L.goal, cx, cy + 44, { a: goal, color: c.result, weight: 700 });
  if (goal > 0) {
    // 진행 고리: 목표가 선 뒤 차오른다
    const p = reduced ? 0.66 : clamp01((t - INTRO_GOAL - 0.6) / 4.5);
    k.ring(cx, cy, 26, 26, c.hair, goal * 0.8, 1);
    if (p > 0) {
      const ctx = k.ctx;
      ctx.save();
      ctx.globalAlpha = Math.min(1, goal);
      ctx.strokeStyle = c.result;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + p * INTRO_TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  const pos = home.map(([hx, hy], i) => {
    const self = t * 0.9 + i;
    const sx = hx + 16 * Math.cos(self);
    const sy = hy + 10 * Math.sin(self);
    const ang = -2.4 + (i * INTRO_TAU) / 4 + t * 0.12;
    const [rx, ry] = ellPoint(cx, cy, 150, 82, ang);
    return [sx + (rx - sx) * g, sy + (ry - sy) * g] as [number, number];
  });

  // 판단: 사령관 사이를 오가는 불꽃 — 목표가 서면 가운데로 모인다
  if ((t > INTRO_JUDGE && t < INTRO_GOAL + 0.4) || reduced) {
    const order: (readonly [number, number])[] = [
      [0, 1],
      [1, 3],
      [3, 2],
      [2, 0],
      [0, 3],
      [1, 2],
    ];
    order.forEach(([a, b], n) => {
      const ph = reduced ? (n === 0 ? 0.55 : -1) : ((t - INTRO_JUDGE) / 0.8) % order.length - n;
      if (ph < 0 || ph > 1) return;
      const [ax, ay] = pos[a]!;
      const [bx, by] = pos[b]!;
      const mx = (ax + bx) / 2 + (cx - (ax + bx) / 2) * 0.6;
      const my = (ay + by) / 2 + (cy - (ay + by) / 2) * 0.6;
      const q = (u: number): [number, number] => [
        (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * mx + u * u * bx,
        (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * my + u * u * by,
      ];
      for (let j = 0; j < 8; j += 1) {
        const u = ph - j * 0.025;
        if (u < 0) continue;
        const [x, y] = q(u);
        k.dot(x, y, 3 - j * 0.3, c.flow, 1 - j / 8);
      }
      if (ph > 0.85) k.glow(bx, by, 28, c.flow, ((ph - 0.85) / 0.15) * 2);
    });
  }
  if (!reduced && t > INTRO_GOAL - 0.6 && t < INTRO_GOAL + 0.8) {
    // 네 사령관의 판단이 가운데로 모여 목표가 된다
    const u = clamp01((t - (INTRO_GOAL - 0.6)) / 1.0);
    pos.forEach(([x, y]) => {
      for (let j = 0; j < 6; j += 1) {
        const v = clamp01(u - j * 0.04);
        if (v <= 0) continue;
        k.dot(x + (cx - x) * easeOut(v), y + (cy - y) * easeOut(v), 2.6 - j * 0.3, c.result, (1 - j / 6) * (1 - clamp01((u - 0.85) / 0.15)));
      }
    });
  }
  pos.forEach(([x, y], i) => {
    const a = atTime(t, i * 0.15);
    k.orb(x, y, 9 * a, c.ink, a);
    k.text(names[i] ?? "", x, y + 20, { size: 11, color: c.ink2, a });
  });

  // 단계 이름 — 왼쪽 위에 차례로
  const s1 = reduced ? 1 : atTime(t, 2.2);
  const s2 = reduced ? 1 : atTime(t, INTRO_JUDGE + 0.2);
  const s3 = goal;
  const cur = s3 > 0.5 ? 3 : s2 > 0.5 ? 2 : 1;
  const stepStyle = (n: number, a: number) => ({
    align: "left" as const,
    size: 11.5,
    weight: n === cur ? 700 : 500,
    color: n === cur ? (n === 3 ? c.result : c.ink) : c.ink3,
    a,
  });
  k.text(L.step1, 22, 24, stepStyle(1, s1));
  k.text(L.step2, 22, 44, stepStyle(2, s2));
  k.text(L.step3, 22, 64, stepStyle(3, s3));
}

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
