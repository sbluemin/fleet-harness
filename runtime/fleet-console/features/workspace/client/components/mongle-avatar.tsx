import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { mongleBase, type MongleActivity, type MongleRole, type MongleState } from "../../shared/avatars.js";
import type { IdentityTone } from "../../shared/identity-tones.js";
import { mountMongle3DCanvas, updateMongle3DCanvas, type Mongle3DSpec } from "./mongle-3d-renderer.js";

/**
 * 몽글 아바타 — 사령관·지휘관·구성원·Objective 을 3D 플러시 볼류메트릭 셰이더로 그린다.
 *
 * 일반 몽글(1–15)은 사령관에게 Plush Vivid, 지휘관·구성원에게 Fleet Pastel 색감과 미니멀 눈으로,
 * 진급 퀘이커 사령관(16–18: 토리·보리·도리)은 Fleet Pastel 색감과 제독 모자·견장·날개짓으로 렌더링한다. 역할 특징(사령관 브래스 별 배지·지휘관 안테나),
 * 10가지 상태, 작업 중 9가지 활동 소품 연기를 공용 WebGL2 렌더러(`mongle-3d-renderer.ts`)가 수행한다.
 */

type MongleTier = "full" | "mid" | "sil" | "mini";

function mongleTier(size: number): MongleTier {
  return size >= 48 ? "full" : size >= 22 ? "mid" : size >= 13 ? "sil" : "mini";
}

/** 베이스별 주기 배수(0.89–1.12). 같은 묶음은 베이스가 겹치지 않으므로, 동시에 시작해도 몇 초 안에 위상이 흩어진다. */
const TEMPO: readonly number[] = [
  1, 0.92, 1.07, 0.96, 1.11, 0.89, 1.03, 0.94, 1.09, 0.98, 1.05, 0.9, 1.12, 0.95, 1.01, 0.97, 1.04, 0.93,
];

/** 활동별 반복 주기(ms, 배수 1 기준) — 활동 교체는 최소 머무름 뒤 이 경계에서 부드럽게 전환한다. */
const ACTIVITY_CYCLE_MS: Readonly<Record<MongleActivity | "default", number>> = {
  default: 1400, think: 1600, read: 2400, edit: 1200, run: 1400, fetch: 1600, delegate: 1600, text: 1600, compact: 1600, background: 2800,
};
const HOLD_MS = 1200;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** 짧은 도구 연타가 깜빡이지 않도록 현재 활동에 최소 1.2초 머문 뒤 반복 경계에서 다음 활동으로 넘긴다. */
function useSettledActivity(running: boolean, target: MongleActivity | null, tempo: number): MongleActivity | null {
  const [shown, setShown] = useState<MongleActivity | null>(() => (running ? target : null));
  const shownRef = useRef<MongleActivity | null>(shown);
  const shownAtRef = useRef<number>(now());
  const targetRef = useRef<MongleActivity | null>(target);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  targetRef.current = target;

  useEffect(() => {
    const clear = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!running) {
      clear();
      if (shownRef.current !== null) {
        shownRef.current = null;
        shownAtRef.current = now();
        setShown(null);
      }
      return;
    }

    if (shownRef.current === target) {
      clear();
      return;
    }

    if (shownRef.current === null && target !== null) {
      clear();
      shownRef.current = target;
      shownAtRef.current = now();
      setShown(target);
      return;
    }

    if (timerRef.current !== null) return;
    const cycle = ACTIVITY_CYCLE_MS[shownRef.current ?? "default"] * tempo;
    const elapsed = Math.max(HOLD_MS, now() - shownAtRef.current);
    const nextAt = shownAtRef.current + Math.ceil(elapsed / cycle) * cycle;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      shownRef.current = targetRef.current;
      shownAtRef.current = now();
      setShown(targetRef.current);
    }, Math.max(0, nextAt - now()));
  }, [running, target, tempo]);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return running ? shown : null;
}

interface MongleAvatarProps {
  /** 베이스 번호(1–15, 사령관 전용 진급은 16–18). 모르는 값은 1번으로 그린다. */
  readonly base: number;
  /** 바꾼 색. null 이면 베이스의 원래 톤이다. */
  readonly tone?: IdentityTone | null;
  readonly role: MongleRole;
  readonly state: MongleState;
  /**
   * 작업 중일 때 지금 하는 일. 모르면 null(기본 리듬)이고, 작업 중이 아니면 읽지 않는다. 바뀐 값은 바로 그리지 않고
   * 지금 동작의 반복 경계에서 넘어간다.
   */
  readonly activity?: MongleActivity | null;
  /** 한 변(px). 사이드바 20, 대화 행 28, 오른쪽 패널 64. 크기가 연기의 단계를 정한다. */
  readonly size: number;
  readonly label: string;
  /** 감싼 요소가 이미 이 사실을 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
  /** 3D 진급 사령관은 모든 자리에서 모자·견장·날개짓을 함께 그린다(호출부 호환용). */
  readonly figure?: boolean;
  /** 태스크포스 묶음처럼 사령관 별 배지를 숨겨야 하는 자리. */
  readonly hideBadge?: boolean;
}

export function MongleAvatar({
  base,
  tone = null,
  role,
  state,
  activity = null,
  size,
  label,
  decorative = false,
  className,
  hideBadge = false,
}: MongleAvatarProps) {
  const preset = mongleBase(base);
  const tier = mongleTier(size);
  const tempo = TEMPO[preset.id - 1] ?? 1;
  const quaker = preset.quaker ?? null;
  const acting = useSettledActivity(state === "running", tier === "mini" || quaker !== null ? null : activity, tempo);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticIdle = className?.split(/\s+/u).includes("group-chat-mark") === true;

  const spec = useMemo<Mongle3DSpec>(() => ({
    baseId: preset.id,
    shape: preset.shape,
    tone: quaker ? preset.tone : (tone ?? preset.tone),
    quaker,
    role,
    state,
    activity: acting,
    size,
    tempo,
    mini: tier === "mini",
    hideBadge,
    staticIdle,
  }), [acting, hideBadge, preset.id, preset.shape, preset.tone, quaker, role, size, state, staticIdle, tempo, tier, tone]);

  const specRef = useRef(spec);
  specRef.current = spec;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return mountMongle3DCanvas(canvas, specRef.current);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    updateMongle3DCanvas(canvas, spec);
  }, [spec]);

  const classes = [
    "mongle-avatar",
    `is-${state}`,
    `is-${role}`,
    `is-tone-${quaker ? preset.tone : (tone ?? preset.tone)}`,
    `is-tier-${tier}`,
    acting ? `is-act-${acting}` : null,
    className,
  ].filter(Boolean).join(" ");

  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };

  return (
    <canvas
      ref={canvasRef}
      className={classes}
      style={{ "--mongle-size": `${size}px` } as CSSProperties}
      {...a11y}
    />
  );
}
