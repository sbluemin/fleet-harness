import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { MongleAvatar } from "../../workspace/client/components/mongle-avatar.js";
import { MONGLE_BASES, PROMOTED_BASES, mongleBase } from "../../workspace/shared/avatars.js";
import type { FeatureCardContentProps, FeatureCardLinkProps } from "./feature-cards.js";
import "./the-world-coming-soon.css";

interface TheWorldComingSoonCopy {
  readonly eyebrow: string;
  readonly badge: string;
  readonly title: string;
  readonly bodyPre: string;
  readonly bodyEm1: string;
  readonly bodyMid: string;
  readonly bodyEm2: string;
  readonly bodyPost: string;
  readonly soonNote: string;
  readonly rosterBtn: string;
  readonly clickHint: string;
  readonly flight: string;
  readonly flying: string;
  readonly toNight: string;
  readonly toDay: string;
  readonly admiralName: string;
  readonly admiralLine: string;
}

const copyKo: TheWorldComingSoonCopy = {
  eyebrow: "✦ Coming Soon",
  badge: "다음 주 공개",
  title: "더 월드: 일도 게임처럼, 모든 사령관과 함께하는 3D 마을",
  bodyPre: "",
  bodyEm1: "“일도 게임처럼 하라”",
  bodyMid: "는 취지로 준비 중인 살아 숨 쉬는 3D 초원 마을이에요. ",
  bodyEm2: "18명의 모든 사령관",
  bodyPost: "과 마을을 거닐고 하늘을 날며, 대화하듯 목표를 지시하고 일상을 함께 즐길 수 있어요.",
  soonNote: "✦ 다음 주 데스크톱 콘솔 공개 예정",
  rosterBtn: "✦ 사령관 18명 전원",
  clickHint: "캐릭터를 눌러 말 걸기",
  flight: "✦ 별빛 비행",
  flying: "✦ 비행 중…",
  toNight: "☾ 별밤",
  toDay: "☀ 초원 낮",
  admiralName: "별 제독",
  admiralLine: "출격 준비 완료! 일도 게임처럼 신나게 날아볼까요?",
};

const copyEn: TheWorldComingSoonCopy = {
  eyebrow: "✦ Coming Soon",
  badge: "Next Week",
  title: "The World: Work like a game in a living 3D Fleet village",
  bodyPre: "Built around the idea of ",
  bodyEm1: "“making work feel like a game.”",
  bodyMid: " Stroll the sunlit plaza and soar across the sky with ",
  bodyEm2: "all 18 Commodores",
  bodyPost: ", directing objectives like an RPG — arriving next week.",
  soonNote: "✦ Coming to Desktop Console next week",
  rosterBtn: "✦ All 18 Commodores",
  clickHint: "Click any character",
  flight: "✦ Starlight Flight",
  flying: "✦ Soaring…",
  toNight: "☾ Starry Night",
  toDay: "☀ Sunny Day",
  admiralName: "Star Admiral",
  admiralLine: "Ready for takeoff! Let’s make work feel like an adventure!",
};

function worldCopy(locale: ConsoleLocale): TheWorldComingSoonCopy {
  return locale === "ko" ? copyKo : copyEn;
}

interface WorldActorPlacement {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly delaySec: number;
  readonly river?: boolean;
  readonly lineKo: string;
  readonly lineEn: string;
}

const STAGE_W = 640;
const STAGE_H = 300;
const FLIGHT_DURATION_S = 4.6;

/** 플릿의 모든 사령관 18명(몽글 15종 + 진급 퀘이커 3종)을 원형 광장·저택·벚꽃·시냇가에 입체적으로 배치한다. */
const WORLD_ACTORS: readonly WorldActorPlacement[] = [
  { id: 7, x: 112, y: 146, size: 32, delaySec: 0.2, lineKo: "성문 경계 이상 무! 언제든 호출하세요", lineEn: "Village gate clear — ready on your call!" },
  { id: 8, x: 158, y: 138, size: 32, delaySec: 0.9, lineKo: "스탬프 수첩 채우는 재미가 쏠쏠해요", lineEn: "Filling the voyage stamp book is so fun!" },
  { id: 1, x: 248, y: 134, size: 34, delaySec: 0.4, lineKo: "광장 집결 완료! 오늘 목표도 게임처럼 클리어해요", lineEn: "Plaza rally ready! Let’s clear today’s quests!" },
  { id: 2, x: 316, y: 132, size: 34, delaySec: 1.1, lineKo: "하늘 별빛 링 통과 준비 끝났어요!", lineEn: "Sky star-rings are all set for flight!" },
  { id: 9, x: 392, y: 138, size: 33, delaySec: 1.6, lineKo: "새 구역 건물이 Tier 5로 올라갔어요!", lineEn: "Our district hall just hit Tier 5!" },
  { id: 6, x: 458, y: 144, size: 34, delaySec: 0.6, lineKo: "벚꽃 나무 아래 새 퀘스트가 도착했어요", lineEn: "Fresh quest under the blossom trees!" },
  { id: 15, x: 528, y: 148, size: 33, delaySec: 1.4, lineKo: "마을 테마를 바꿔서 분위기 전환해요", lineEn: "Swap village biomes anytime for a vibe boost!" },

  { id: 14, x: 74, y: 194, size: 36, delaySec: 0.3, lineKo: "우편함에 사령관 보고서가 도착했어요", lineEn: "Commander reports waiting in the mailbox!" },
  { id: 13, x: 146, y: 202, size: 37, delaySec: 1.0, lineKo: "E 키로 말 걸면 바로 목표를 시작해요", lineEn: "Press E to talk and launch an objective!" },
  { id: 16, x: 236, y: 186, size: 46, delaySec: 0.0, lineKo: "토리 사령관, 광장 중앙에서 대기 중이에요!", lineEn: "Commodore Tori reporting at the central plaza!" },
  { id: 17, x: 386, y: 186, size: 46, delaySec: 0.5, lineKo: "보리 준비 완료! 다음 주에 마을에서 만나요", lineEn: "Bori is ready — see you in the village next week!" },
  { id: 18, x: 312, y: 214, size: 48, delaySec: 1.2, lineKo: "도리도 출동! 일도 게임처럼 신나게 해봐요", lineEn: "Dori on deck! Let’s make work feel like a game!" },
  { id: 4, x: 462, y: 196, size: 37, delaySec: 0.8, lineKo: "작은 목표도 차곡차곡 쌓이면 마을이 커져요", lineEn: "Every cleared objective grows our village!" },
  { id: 5, x: 544, y: 200, size: 38, delaySec: 0.25, river: true, lineKo: "시냇가에서 황금 잉어 입질이 왔어요!", lineEn: "Got a nibble by the sparkling stream!" },

  { id: 11, x: 96, y: 248, size: 40, delaySec: 0.7, lineKo: "낮엔 초원 산책, 밤엔 오로라 구경해요", lineEn: "Meadow strolls by day, aurora by night!" },
  { id: 3, x: 192, y: 248, size: 41, delaySec: 1.3, lineKo: "모닥불 앞에서 다음 작전 회의할까요?", lineEn: "Warm campfire strategy huddle?" },
  { id: 10, x: 424, y: 248, size: 40, delaySec: 0.35, lineKo: "별빛 편대 V자 비행 함께 떠나요!", lineEn: "Join the V-formation sky patrol!" },
  { id: 12, x: 568, y: 248, size: 39, delaySec: 1.7, river: true, lineKo: "별빛 연못에 새 물고기를 방류했어요", lineEn: "Released a rare catch into the pond!" },
];

const ALL_ROSTER_BASES = [...MONGLE_BASES, ...PROMOTED_BASES] as const;

interface Sparkle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

interface DioramaState {
  time: number;
  nightBlend: number;
  flightT: number;
  sparkles: Sparkle[];
  clouds: { x: number; y: number; s: number; spd: number }[];
  petals: { x: number; y: number; vx: number; vy: number; r: number; ph: number }[];
}

function createInitialDiorama(): DioramaState {
  return {
    time: 0,
    nightBlend: 0,
    flightT: -1,
    sparkles: [],
    clouds: [
      { x: 90, y: 34, s: 1.0, spd: 5.5 },
      { x: 295, y: 24, s: 0.82, spd: 4.2 },
      { x: 510, y: 40, s: 1.15, spd: 6.2 },
    ],
    petals: Array.from({ length: 18 }, (_, i) => ({
      x: (i * 47) % STAGE_W,
      y: (i * 29) % STAGE_H,
      vx: 9 + (i % 4) * 3,
      vy: 6 + (i % 3) * 2.5,
      r: 2 + (i % 2),
      ph: i * 0.9,
    })),
  };
}

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

const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const mixRgb = (c1: readonly [number, number, number], c2: readonly [number, number, number], u: number): string =>
  `rgb(${Math.round(lerp(c1[0], c2[0], u))},${Math.round(lerp(c1[1], c2[1], u))},${Math.round(lerp(c1[2], c2[2], u))})`;

function drawPuffyTree(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, palette: readonly string[], night: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = `rgba(22, 42, 30, ${0.18 + night * 0.14})`;
  ctx.beginPath();
  ctx.ellipse(0, 2, 19, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = night > 0.5 ? "#5a3d2b" : "#7c553b";
  ctx.beginPath();
  ctx.roundRect(-4.5, -24, 9, 26, 3);
  ctx.fill();
  const blobs: readonly [number, number, number][] = [[-11, -28, 13], [11, -27, 12.5], [0, -37, 15]];
  blobs.forEach(([bx, by, br], idx) => {
    ctx.fillStyle = palette[idx % palette.length]!;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.16 * (1 - night * 0.7)})`;
    ctx.beginPath();
    ctx.arc(bx - br * 0.25, by - br * 0.28, br * 0.48, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawPineTree(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, night: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = `rgba(18, 36, 26, ${0.2 + night * 0.12})`;
  ctx.beginPath();
  ctx.ellipse(0, 2, 14, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#5c3f2c";
  ctx.fillRect(-3.5, -14, 7, 15);
  const tiers: readonly (readonly [number, number, number, number, number, number])[] = [
    [-15, -10, 15, -10, 0, -30],
    [-12, -22, 12, -22, 0, -42],
    [-9, -33, 9, -33, 0, -51],
  ];
  tiers.forEach((pts, i) => {
    ctx.fillStyle = night > 0.5 ? (i === 0 ? "#24473a" : "#2f5948") : (i === 0 ? "#4d8259" : i === 1 ? "#5a9366" : "#6ba674");
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    ctx.lineTo(pts[2], pts[3]);
    ctx.lineTo(pts[4], pts[5]);
    ctx.closePath();
    ctx.fill();
  });
  ctx.restore();
}

function drawManorBuilding(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, night: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(25, 38, 32, 0.18)";
  ctx.beginPath();
  ctx.ellipse(0, 6, 54, 15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = night > 0.5 ? "#8b92a4" : "#ecece6";
  ctx.beginPath();
  ctx.roundRect(-42, -52, 84, 56, 4);
  ctx.fill();
  ctx.fillStyle = night > 0.5 ? "#71788a" : "#d9d8cf";
  ctx.fillRect(16, -52, 26, 56);
  const winCol = night > 0.35 ? `rgba(255, 214, 118, ${0.45 + night * 0.55})` : "#9eb6c4";
  const wins: readonly [number, number][] = [[-31, -42], [-12, -42], [22, -42], [-31, -20], [22, -20]];
  wins.forEach(([wx, wy]) => {
    ctx.fillStyle = "#6e737d";
    ctx.fillRect(wx - 1.5, wy - 1.5, 13, 15);
    ctx.fillStyle = winCol;
    ctx.fillRect(wx, wy, 10, 12);
    if (night > 0.45) {
      ctx.fillStyle = `rgba(255, 205, 90, ${0.22 * night})`;
      ctx.beginPath();
      ctx.arc(wx + 5, wy + 6, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.fillStyle = "#7a5e48";
  ctx.beginPath();
  ctx.roundRect(-9, -22, 18, 26, [6, 6, 0, 0]);
  ctx.fill();
  ctx.fillStyle = night > 0.5 ? "#8f5436" : "#d98952";
  ctx.beginPath();
  ctx.moveTo(-48, -50);
  ctx.lineTo(-24, -76);
  ctx.lineTo(24, -76);
  ctx.lineTo(48, -50);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = night > 0.5 ? "#76432a" : "#c47440";
  ctx.beginPath();
  ctx.moveTo(12, -50);
  ctx.lineTo(24, -76);
  ctx.lineTo(48, -50);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  for (let i = -32; i <= 32; i += 10) {
    ctx.beginPath();
    ctx.moveTo(i, -51);
    ctx.lineTo(i * 0.55, -75);
    ctx.stroke();
  }
  ctx.fillStyle = night > 0.5 ? "#a78440" : "#e5b858";
  ctx.beginPath();
  ctx.arc(0, -82, 11, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = night > 0.5 ? "#b4b8c4" : "#f2f1eb";
  ctx.fillRect(-10, -82, 20, 7);
  ctx.fillStyle = "#f2c65a";
  ctx.beginPath();
  ctx.arc(0, -94, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEntranceGate(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, night: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = night > 0.5 ? "#7e8596" : "#dcdbd3";
  ctx.fillRect(-26, -34, 12, 38);
  ctx.fillRect(14, -34, 12, 38);
  ctx.fillStyle = night > 0.5 ? "#35664d" : "#5ea67a";
  ctx.beginPath();
  ctx.moveTo(-32, -33);
  ctx.lineTo(0, -52);
  ctx.lineTo(32, -33);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#f0c864";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-29, -34);
  ctx.lineTo(0, -50);
  ctx.lineTo(29, -34);
  ctx.stroke();
  ctx.fillStyle = "#4ea168";
  ctx.beginPath();
  ctx.roundRect(-24, -22, 8, 18, 2);
  ctx.fill();
  ctx.fillStyle = "#f5d068";
  ctx.beginPath();
  ctx.arc(-20, -14, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawStarAdmiral(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, t: number, flying: boolean, angle: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  if (!flying) {
    ctx.fillStyle = "rgba(18, 28, 38, 0.24)";
    ctx.beginPath();
    ctx.ellipse(0, 14, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const flutter = Math.sin(t * (flying ? 14 : 3.2)) * (flying ? 5 : 2);
  ctx.fillStyle = "#1b274d";
  ctx.beginPath();
  ctx.moveTo(-8, -4);
  ctx.quadraticCurveTo(-18 - flutter, 6, -15 - flutter * 1.2, 14);
  ctx.lineTo(6, 12);
  ctx.quadraticCurveTo(10, 4, 8, -4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffe074";
  ctx.beginPath();
  ctx.arc(-8 - flutter * 0.4, 5, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-4 - flutter * 0.3, 9, 1.2, 0, Math.PI * 2);
  ctx.fill();

  const glow = ctx.createRadialGradient(0, 0, 3, 0, 0, 22);
  glow.addColorStop(0, "rgba(255, 232, 118, 0.65)");
  glow.addColorStop(1, "rgba(255, 232, 118, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffdf6b";
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? 15 : 8.5;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#191c2b";
  ctx.beginPath();
  ctx.ellipse(-3.6, 0.5, 1.5, 2.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(3.6, 0.5, 1.5, 2.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(-4.1, -0.3, 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(3.1, -0.3, 0.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#202b46";
  ctx.beginPath();
  ctx.ellipse(0, -10.5, 11, 3.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f7f6f1";
  ctx.beginPath();
  ctx.ellipse(0, -14.5, 12.5, 5.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f2c14e";
  ctx.beginPath();
  ctx.arc(0, -12, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDioramaFrame(
  ctx: CanvasRenderingContext2D,
  diorama: DioramaState,
  dt: number,
  targetNight: boolean,
  reduced: boolean,
  onFlightEnd: () => void,
): void {
  const activeDt = reduced ? 0 : Math.min(dt, 0.05);
  diorama.time += activeDt;
  const t = diorama.time;

  const target = targetNight ? 1 : 0;
  diorama.nightBlend += (target - diorama.nightBlend) * (reduced ? 1 : Math.min(1, activeDt * 4.5));
  const night = diorama.nightBlend;

  // 하늘
  const skyGrad = ctx.createLinearGradient(0, 0, 0, 118);
  skyGrad.addColorStop(0, mixRgb([145, 206, 245], [18, 25, 56], night));
  skyGrad.addColorStop(1, mixRgb([214, 242, 236], [36, 49, 88], night));
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, STAGE_W, 125);

  // 별밤 별빛 & 오로라
  if (night > 0.06) {
    ctx.save();
    for (let i = 0; i < 34; i += 1) {
      const sx = (i * 73 + 19) % STAGE_W;
      const sy = (i * 37 + 11) % 88;
      const tw = 0.4 + 0.6 * Math.sin(t * 2.2 + i * 1.3);
      ctx.fillStyle = `rgba(255, 248, 224, ${night * tw * 0.85})`;
      ctx.beginPath();
      ctx.arc(sx, sy, i % 3 === 0 ? 1.5 : 1.0, 0, Math.PI * 2);
      ctx.fill();
    }
    const aurGrad = ctx.createLinearGradient(80, 12, 540, 68);
    aurGrad.addColorStop(0, "rgba(92, 234, 212, 0)");
    aurGrad.addColorStop(0.3, `rgba(92, 234, 212, ${night * 0.28})`);
    aurGrad.addColorStop(0.65, `rgba(148, 168, 255, ${night * 0.26})`);
    aurGrad.addColorStop(1, "rgba(190, 130, 255, 0)");
    ctx.strokeStyle = aurGrad;
    ctx.lineWidth = 22;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let x = 70; x <= 570; x += 20) {
      const y = 38 + Math.sin(x * 0.014 + t * 0.8) * 10 + Math.cos(x * 0.025 - t * 0.5) * 5;
      if (x === 70) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // 구름
  if (night < 0.9) {
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${(1 - night) * 0.78})`;
    for (const cl of diorama.clouds) {
      cl.x = (cl.x + cl.spd * activeDt) % (STAGE_W + 120);
      const cx = cl.x - 60;
      ctx.beginPath();
      ctx.arc(cx, cl.y, 13 * cl.s, 0, Math.PI * 2);
      ctx.arc(cx + 13 * cl.s, cl.y - 3 * cl.s, 15 * cl.s, 0, Math.PI * 2);
      ctx.arc(cx + 27 * cl.s, cl.y, 11 * cl.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 초원 언덕
  const hillGrad = ctx.createLinearGradient(0, 82, 0, STAGE_H);
  hillGrad.addColorStop(0, mixRgb([152, 206, 128], [38, 72, 64], night));
  hillGrad.addColorStop(0.55, mixRgb([138, 196, 114], [30, 58, 54], night));
  hillGrad.addColorStop(1, mixRgb([124, 184, 102], [24, 48, 46], night));
  ctx.fillStyle = hillGrad;
  ctx.beginPath();
  ctx.moveTo(0, 106);
  ctx.quadraticCurveTo(160, 78, 320, 96);
  ctx.quadraticCurveTo(490, 114, STAGE_W, 86);
  ctx.lineTo(STAGE_W, STAGE_H);
  ctx.lineTo(0, STAGE_H);
  ctx.closePath();
  ctx.fill();

  // 풀잎 결
  ctx.strokeStyle = night > 0.5 ? "rgba(130, 195, 165, 0.14)" : "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 24; i += 1) {
    const gx = (i * 59 + 22) % STAGE_W;
    const gy = 112 + ((i * 37) % 165);
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx - 2, gy - 5);
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + 3, gy - 4);
    ctx.stroke();
  }

  // 반짝이는 시냇물 & 나무 아치 다리
  ctx.save();
  ctx.strokeStyle = mixRgb([118, 196, 232], [38, 86, 134], night);
  ctx.lineWidth = 34;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(620, 118);
  ctx.bezierCurveTo(568, 165, 598, 212, 535, 298);
  ctx.stroke();
  ctx.strokeStyle = mixRgb([164, 224, 248], [86, 152, 210], night);
  ctx.lineWidth = 18;
  ctx.stroke();
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.42 - night * 0.1})`;
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 4; i += 1) {
    const rx = 574 - i * 8 + Math.sin(t * 2 + i) * 3;
    const ry = 160 + i * 32;
    ctx.beginPath();
    ctx.moveTo(rx - 6, ry);
    ctx.lineTo(rx + 6, ry);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(580, 186);
  ctx.rotate(-0.22);
  ctx.fillStyle = night > 0.5 ? "#694932" : "#b88456";
  ctx.beginPath();
  ctx.roundRect(-24, -8, 48, 16, 4);
  ctx.fill();
  ctx.strokeStyle = night > 0.5 ? "#8b6345" : "#d8a878";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-22, -9);
  ctx.quadraticCurveTo(0, -17, 22, -9);
  ctx.stroke();
  ctx.restore();

  // 원형 석재 광장 & 중앙 메달리온 & 꽃밭 & 모닥불
  ctx.save();
  ctx.fillStyle = mixRgb([214, 211, 188], [62, 68, 82], night);
  ctx.beginPath();
  ctx.ellipse(308, 206, 208, 78, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = mixRgb([180, 184, 188], [94, 102, 120], night);
  ctx.lineWidth = 4.5;
  ctx.setLineDash([14, 5]);
  ctx.beginPath();
  ctx.ellipse(308, 206, 208, 78, 0, Math.PI * 1.06, Math.PI * 1.94);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = mixRgb([124, 188, 118], [58, 114, 94], night);
  ctx.beginPath();
  ctx.ellipse(312, 198, 52, 21, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = mixRgb([204, 212, 220], [82, 92, 112], night);
  ctx.beginPath();
  ctx.ellipse(312, 198, 42, 16, 0, 0, Math.PI * 2);
  ctx.fill();

  const stones: readonly [number, number][] = [[192, 196], [218, 214], [412, 196], [398, 220], [262, 236], [356, 236]];
  ctx.fillStyle = mixRgb([178, 186, 194], [84, 94, 112], night);
  stones.forEach(([sx, sy]) => {
    ctx.beginPath();
    ctx.ellipse(sx, sy, 10, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  const flowerbeds: readonly [number, number][] = [[242, 162], [382, 164]];
  flowerbeds.forEach(([fx, fy]) => {
    ctx.fillStyle = mixRgb([178, 182, 188], [86, 94, 110], night);
    ctx.beginPath();
    ctx.ellipse(fx, fy, 17, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = night > 0.5 ? "#386b4c" : "#6ab56c";
    ctx.beginPath();
    ctx.ellipse(fx, fy - 1.5, 13, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ["#ff8da8", "#ffe066", "#7fd4ff", "#ffb36b"].forEach((fc, idx) => {
      ctx.fillStyle = fc;
      ctx.beginPath();
      ctx.arc(fx - 7 + idx * 4.8, fy - 2 + (idx % 2) * 2, 2.2, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  // 모닥불
  const fireX = 160;
  const fireY = 250;
  ctx.fillStyle = "#5c4230";
  ctx.fillRect(fireX - 9, fireY - 2, 18, 4);
  const flick = Math.sin(t * 11) * 1.8;
  const fireGlow = ctx.createRadialGradient(fireX, fireY - 6, 2, fireX, fireY - 4, 24 + night * 24);
  fireGlow.addColorStop(0, `rgba(255, 195, 75, ${0.42 + night * 0.45})`);
  fireGlow.addColorStop(1, "rgba(255, 140, 40, 0)");
  ctx.fillStyle = fireGlow;
  ctx.beginPath();
  ctx.arc(fireX, fireY - 5, 24 + night * 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff8b2b";
  ctx.beginPath();
  ctx.moveTo(fireX - 6, fireY);
  ctx.quadraticCurveTo(fireX, fireY - 16 - flick, fireX + 6, fireY);
  ctx.fill();
  ctx.fillStyle = "#ffe67a";
  ctx.beginPath();
  ctx.moveTo(fireX - 3, fireY);
  ctx.quadraticCurveTo(fireX, fireY - 10 - flick * 0.6, fireX + 3, fireY);
  ctx.fill();
  ctx.restore();

  // 나무 & 마을 건축물
  drawPineTree(ctx, 36, 118, 0.92, night);
  drawPineTree(ctx, 74, 108, 0.82, night);
  drawPuffyTree(ctx, 132, 116, 0.92, night > 0.5 ? ["#36684f", "#457d5e", "#508f6b"] : ["#6eb065", "#7ec273", "#90d182"], night);
  drawPuffyTree(ctx, 514, 112, 0.92, night > 0.5 ? ["#8c5b6e", "#a16b7f", "#b27c90"] : ["#f2a8b8", "#f7bbc8", "#ffd0db"], night);
  drawPuffyTree(ctx, 412, 116, 0.84, night > 0.5 ? ["#8c6855", "#a37c66", "#b88e74"] : ["#e8b58c", "#f2c69e", "#f7d4b2"], night);
  drawPineTree(ctx, 608, 118, 0.86, night);

  drawEntranceGate(ctx, 72, 148, 0.95, night);
  drawManorBuilding(ctx, 276, 132, 0.92, night);
  drawManorBuilding(ctx, 470, 128, 0.66, night);

  // 가로등
  const lamps: readonly [number, number][] = [[170, 152], [440, 152]];
  lamps.forEach(([lx, ly]) => {
    ctx.strokeStyle = "#33394a";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(lx, ly - 24);
    ctx.stroke();
    ctx.fillStyle = night > 0.3 ? "#ffe28a" : "#edf2f7";
    ctx.beginPath();
    ctx.arc(lx, ly - 25, 3.8, 0, Math.PI * 2);
    ctx.fill();
    if (night > 0.25) {
      const lg = ctx.createRadialGradient(lx, ly - 25, 2, lx, ly - 25, 22);
      lg.addColorStop(0, `rgba(255, 224, 128, ${night * 0.55})`);
      lg.addColorStop(1, "rgba(255, 224, 128, 0)");
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly - 25, 22, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // 시냇가 낚싯대 소품 (방울이·젤리)
  for (const actor of WORLD_ACTORS) {
    if (!actor.river) continue;
    ctx.save();
    ctx.strokeStyle = "#7a5838";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(actor.x + 8, actor.y - 10);
    ctx.lineTo(actor.x + 28, actor.y - 24);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(actor.x + 28, actor.y - 24);
    ctx.lineTo(actor.x + 30, actor.y + 4 + Math.sin(t * 3 + actor.id) * 1.5);
    ctx.stroke();
    ctx.restore();
  }

  // 별 제독 (광장 대기 또는 별빛 비행 유성 궤적)
  if (diorama.flightT >= 0) {
    diorama.flightT += activeDt;
    const u = Math.min(1, diorama.flightT / FLIGHT_DURATION_S);
    const fx = 312 + Math.sin(u * Math.PI * 2) * 245;
    const fy = 166 - Math.sin(u * Math.PI) * 120 - Math.sin(u * Math.PI * 2) * 16;
    const nu = Math.min(1, u + 0.02);
    const nfx = 312 + Math.sin(nu * Math.PI * 2) * 245;
    const nfy = 166 - Math.sin(nu * Math.PI) * 120 - Math.sin(nu * Math.PI * 2) * 16;
    const heading = Math.atan2(nfy - fy, nfx - fx) * 0.25;

    ctx.save();
    for (let i = 14; i >= 1; i -= 1) {
      const tu = Math.max(0, u - i * 0.012);
      const tx = 312 + Math.sin(tu * Math.PI * 2) * 245;
      const ty = 166 - Math.sin(tu * Math.PI) * 120 - Math.sin(tu * Math.PI * 2) * 16;
      const alpha = (1 - i / 15) * 0.65;
      ctx.fillStyle = i % 2 === 0 ? `rgba(255, 224, 112, ${alpha})` : `rgba(122, 232, 248, ${alpha})`;
      ctx.beginPath();
      ctx.arc(tx, ty, (15 - i) * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    drawStarAdmiral(ctx, fx, fy, 1.04, t, true, heading);
    if (diorama.flightT >= FLIGHT_DURATION_S) {
      diorama.flightT = -1;
      onFlightEnd();
    }
  } else {
    const bob = reduced ? 0 : Math.sin(t * 2.4) * 2.2;
    drawStarAdmiral(ctx, 312, 166 + bob, 0.96, t, false, reduced ? 0 : Math.sin(t * 2.1) * 0.05);
  }

  // 꽃잎(낮) / 반딧불(밤)
  ctx.save();
  for (const p of diorama.petals) {
    if (activeDt > 0) {
      p.x = (p.x + p.vx * activeDt) % STAGE_W;
      p.y = (p.y + p.vy * activeDt) % STAGE_H;
    }
    if (night > 0.45) {
      const glow = 0.4 + 0.6 * Math.sin(t * 3 + p.ph);
      ctx.fillStyle = `rgba(255, 238, 130, ${night * glow * 0.78})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.9, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(255, 198, 214, 0.72)";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r, p.r * 0.6, t + p.ph, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // 클릭 반짝이
  for (let i = diorama.sparkles.length - 1; i >= 0; i -= 1) {
    const sp = diorama.sparkles[i]!;
    sp.life -= activeDt;
    if (sp.life <= 0) {
      diorama.sparkles.splice(i, 1);
      continue;
    }
    sp.x += sp.vx * activeDt;
    sp.y += sp.vy * activeDt;
    sp.vy += 40 * activeDt;
    ctx.save();
    ctx.globalAlpha = Math.max(0, sp.life / sp.maxLife);
    ctx.fillStyle = sp.color;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, sp.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** 더 월드(Coming Soon) 예고 카드 본문 — 18명의 모든 사령관이 살아 숨 쉬는 초원 마을 디오라마를 보여 준다. */
export function TheWorldComingSoonCard({ titleId }: FeatureCardContentProps): React.JSX.Element {
  const locale: ConsoleLocale = useConsoleLocale();
  const copy = worldCopy(locale);
  const osReduced = useOsReducedMotion();
  const settingReduced = useGlobalSettingsStore().state?.reduceMotion === true;
  const reduced = osReduced || settingReduced;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dioramaRef = useRef<DioramaState>(createInitialDiorama());
  const nightRef = useRef(false);

  const [nightMode, setNightMode] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [flying, setFlying] = useState(false);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [jumpingIds, setJumpingIds] = useState<ReadonlySet<number>>(() => new Set());
  const [bubble, setBubble] = useState<{ readonly name: string; readonly text: string } | null>(null);

  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  nightRef.current = nightMode;

  useEffect(() => () => {
    if (bubbleTimerRef.current !== null) clearTimeout(bubbleTimerRef.current);
    for (const timer of jumpTimersRef.current) clearTimeout(timer);
  }, []);

  const spawnSparkles = useCallback((x: number, y: number, count: number, color: string): void => {
    const diorama = dioramaRef.current;
    for (let i = 0; i < count; i += 1) {
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const spd = 28 + Math.random() * 44;
      diorama.sparkles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 16,
        life: 0.65 + Math.random() * 0.35,
        maxLife: 1.0,
        size: 2.2 + Math.random() * 2.4,
        color,
      });
    }
  }, []);

  const showBubble = useCallback((name: string, text: string): void => {
    setBubble({ name, text });
    if (bubbleTimerRef.current !== null) clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => {
      bubbleTimerRef.current = null;
      setBubble(null);
    }, 4200);
  }, []);

  const triggerJump = useCallback((ids: readonly number[]): void => {
    setJumpingIds((prev) => new Set([...prev, ...ids]));
    const timer = setTimeout(() => {
      setJumpingIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, 700);
    jumpTimersRef.current.push(timer);
  }, []);

  const focusCommander = useCallback((id: number): void => {
    const actor = WORLD_ACTORS.find((entry) => entry.id === id);
    if (!actor) return;
    const preset = mongleBase(id);
    const name = locale === "ko" ? preset.name.ko : preset.name.en;
    const line = locale === "ko" ? actor.lineKo : actor.lineEn;
    setFocusedId(id);
    triggerJump([id]);
    spawnSparkles(actor.x, actor.y - 14, 12, "#ffe270");
    showBubble(name, line);
  }, [locale, showBubble, spawnSparkles, triggerJump]);

  const triggerFlight = useCallback((): void => {
    if (reduced) {
      showBubble(copy.admiralName, copy.admiralLine);
      return;
    }
    dioramaRef.current.flightT = 0;
    setFlying(true);
    spawnSparkles(312, 166, 16, "#ffe270");
    triggerJump([16, 17, 18, 1, 2, 3, 10]);
    showBubble(copy.admiralName, copy.admiralLine);
  }, [copy.admiralLine, copy.admiralName, reduced, showBubble, spawnSparkles, triggerJump]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const renderFrame = (dt: number): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== STAGE_W * dpr || canvas.height !== STAGE_H * dpr) {
        canvas.width = STAGE_W * dpr;
        canvas.height = STAGE_H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawDioramaFrame(ctx, dioramaRef.current, dt, nightRef.current, reduced, () => {
        setFlying(false);
        spawnSparkles(312, 166, 12, "#7ae8f8");
      });
    };

    if (reduced) {
      renderFrame(0);
      return;
    }

    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = (now - last) / 1000;
      last = now;
      renderFrame(dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nightMode, reduced, spawnSparkles]);

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * STAGE_W;
    const y = ((event.clientY - rect.top) / rect.height) * STAGE_H;
    // 별 제독 본체 또는 열린 하늘을 누르면 별빛 비행을 시작한다.
    if (Math.hypot(x - 312, y - 166) < 24 || y < 105) {
      triggerFlight();
    } else {
      setFocusedId(null);
    }
  };

  return (
    <>
      <div className="tfi-head">
        <span className="twc-eyebrow">{copy.eyebrow}</span>
        <span className="twc-chip">{copy.badge}</span>
      </div>
      <h2 id={titleId} className="tfi-title">{copy.title}</h2>
      <div className={`twc-stage${reduced ? " is-reduced" : ""}`}>
        <canvas ref={canvasRef} className="twc-canvas" aria-hidden="true" onClick={handleCanvasClick} />

        {/* 플릿 사령관 18명 전원 (실제 3D 플러시 MongleAvatar) */}
        <div className="twc-actors">
          {WORLD_ACTORS.map((actor) => {
            const preset = mongleBase(actor.id);
            const name = locale === "ko" ? preset.name.ko : preset.name.en;
            const isFocused = focusedId === actor.id;
            const isHovered = hoveredId === actor.id;
            const isJumping = jumpingIds.has(actor.id);
            const avatarState = isFocused || isJumping ? "unseen" : actor.id >= 16 ? "running" : "idle";
            return (
              <button
                key={actor.id}
                type="button"
                className={`twc-actor${isJumping ? " is-jumping" : ""}${isFocused ? " is-focused" : ""}`}
                style={{
                  left: `${(actor.x / STAGE_W) * 100}%`,
                  top: `${(actor.y / STAGE_H) * 100}%`,
                  zIndex: Math.round(actor.y),
                  animationDelay: isJumping ? "0s" : `${actor.delaySec}s`,
                }}
                aria-label={name}
                onMouseEnter={() => setHoveredId(actor.id)}
                onMouseLeave={() => setHoveredId((cur) => (cur === actor.id ? null : cur))}
                onClick={() => focusCommander(actor.id)}
              >
                <span className="twc-actor-shadow" aria-hidden="true" />
                {isFocused || isHovered ? <span className="twc-actor-ring" aria-hidden="true" /> : null}
                <MongleAvatar
                  base={actor.id}
                  role="commodore"
                  state={avatarState}
                  size={actor.size}
                  label={name}
                  decorative
                />
                {isFocused || isHovered ? <span className="twc-nametag">☆ {name}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="twc-hud-left">
          <button
            type="button"
            className={`twc-hud-pill${rosterOpen ? " is-lit" : ""}`}
            onClick={() => setRosterOpen((open) => !open)}
          >
            {copy.rosterBtn}
          </button>
          <span className="twc-hud-pill twc-hud-hint">{copy.clickHint}</span>
        </div>

        <div className="twc-hud-right">
          <button
            type="button"
            className={`twc-hud-pill${flying ? " is-lit" : ""}`}
            onClick={triggerFlight}
          >
            {flying ? copy.flying : copy.flight}
          </button>
          <button
            type="button"
            className={`twc-hud-pill${nightMode ? " is-lit" : ""}`}
            onClick={() => setNightMode((night) => !night)}
          >
            {nightMode ? copy.toDay : copy.toNight}
          </button>
        </div>

        {bubble ? (
          <div className="twc-bubble" role="status">
            <span className="twc-bubble-name">{bubble.name}</span>
            <span>{bubble.text}</span>
          </div>
        ) : null}

        {rosterOpen ? (
          <div className="twc-roster">
            {ALL_ROSTER_BASES.map((base) => {
              const name = locale === "ko" ? base.name.ko : base.name.en;
              return (
                <button
                  key={base.id}
                  type="button"
                  className={`twc-roster-chip${focusedId === base.id ? " is-active" : ""}`}
                  onClick={() => focusCommander(base.id)}
                >
                  <MongleAvatar base={base.id} role="commodore" state="idle" size={16} label={name} decorative />
                  <span>{base.quaker ? `★${name}` : name}</span>
                </button>
              );
            })}
          </div>
        ) : null}
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

/** 카드 아래 줄 왼쪽의 공개 예정 안내 — 출시 전 카드이므로 이동 링크 대신 일정만 알린다. */
export function TheWorldComingSoonNote(_props: FeatureCardLinkProps): React.JSX.Element {
  const copy = worldCopy(useConsoleLocale());
  return <span className="twc-soon-note">{copy.soonNote}</span>;
}
