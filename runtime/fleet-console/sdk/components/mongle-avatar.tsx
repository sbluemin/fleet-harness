import type { ReactNode } from "react";

import { mongleBase, type MongleDetail, type MongleRole, type MongleShape, type MongleState } from "../avatars/index.js";
import type { IdentityTone } from "../operations/identity-tones.js";

/**
 * 몽글 아바타 — 사령관·지휘관·구성원·Operation 을 한 조형으로 그린다.
 *
 * 베이스(몸 모양·톤·얼굴 디테일) 위에 역할 특징(사령관 별 배지·지휘관 안테나)을 얹고, 상태는 눈·몸짓·작은 배지가 말한다.
 * 상태 배지는 오른쪽 위·아래에 서고 사령관 별은 왼쪽 위라 서로 겹치지 않는다. 움직임을 꺼도 눈 모양이 상태를 지킨다.
 *
 * 클래스 이름은 이 모듈이 고정한다 — 실제 규칙(톤·움직임·차분)은 코어 `components.css` 의 `.mongle-avatar` 한 곳에 산다.
 * 라벨은 호출부가 자기 로케일로 넘긴다(SDK는 번역을 소유하지 않는다).
 */

const ring = (count: number, radius: number, r: number): readonly (readonly [number, number, number])[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = ((-90 + (index * 360) / count) * Math.PI) / 180;
    return [16 + radius * Math.cos(angle), 18.5 + radius * Math.sin(angle), r] as const;
  });

/** 몸 윗선 — 지휘관 안테나가 꽂히는 높이. */
const SHAPE_TOP: Record<MongleShape, number> = { bang: 8.2, gureum: 6.2, tteok: 8, kong: 10.4, mul: 5.6, kkot: 6.4, dol: 9.8, sat: 6.6, egg: 6.8, mandu: 9 };

function Body({ shape }: { readonly shape: MongleShape }): ReactNode {
  switch (shape) {
    case "bang": return <ellipse className="mongle-avatar-fill" cx="16" cy="18.5" rx="11.5" ry="10.3" />;
    case "gureum": return <g className="mongle-avatar-fill"><circle cx="10.5" cy="20" r="7.2" /><circle cx="21.5" cy="20" r="7.2" /><circle cx="16" cy="14" r="8" /><circle cx="16" cy="21.5" r="7.4" /></g>;
    case "tteok": return <rect className="mongle-avatar-fill" x="5" y="8" width="22" height="20.5" rx="9" />;
    case "kong": return <rect className="mongle-avatar-fill" x="4.5" y="11" width="23" height="15.5" rx="7.8" transform="rotate(-8 16 18.5)" />;
    case "mul": return <path className="mongle-avatar-fill" d="M16 5.5C20.6 10.8 27 14.6 27 20.2A11 9.1 0 0 1 5 20.2C5 14.6 11.4 10.8 16 5.5Z" />;
    case "kkot": return <g className="mongle-avatar-fill">{ring(5, 6.4, 5.8).map(([cx, cy, r], index) => <circle key={index} cx={cx} cy={cy} r={r} />)}<circle cx="16" cy="18.5" r="7" /></g>;
    case "dol": return <ellipse className="mongle-avatar-fill" cx="16" cy="19" rx="12.2" ry="9.4" transform="rotate(-12 16 19)" />;
    case "sat": return <g className="mongle-avatar-fill">{ring(6, 7.6, 4.4).map(([cx, cy, r], index) => <circle key={index} cx={cx} cy={cy} r={r} />)}<circle cx="16" cy="18.5" r="8.4" /></g>;
    case "egg": return <ellipse className="mongle-avatar-fill" cx="16" cy="18.3" rx="9.8" ry="11.5" />;
    case "mandu": return <path className="mongle-avatar-fill" d="M4.6 24C4.6 14.2 9.6 9 16 9S27.4 14.2 27.4 24Q27.4 27.6 23.8 27.6H8.2Q4.6 27.6 4.6 24Z" />;
  }
}

function Eyes({ state }: { readonly state: MongleState }): ReactNode {
  switch (state) {
    case "running":
      return <g className="mongle-avatar-eyes"><rect className="mongle-avatar-eye" x="11.9" y="16.65" width="2.3" height="3.9" rx="1.15" /><rect className="mongle-avatar-eye" x="19" y="16.65" width="2.3" height="3.9" rx="1.15" /></g>;
    case "awaiting":
    case "decision":
    case "review":
      return <g className="mongle-avatar-eyes"><circle className="mongle-avatar-eye" cx="12.5" cy="17.4" r="1.75" /><circle className="mongle-avatar-eye" cx="19.5" cy="17.4" r="1.75" /></g>;
    case "unseen":
    case "done":
      return <g className="mongle-avatar-eyes"><path className="mongle-avatar-line" d="M10.7 19.2q1.8-2.4 3.6 0M17.7 19.2q1.8-2.4 3.6 0" /></g>;
    case "ended":
      return <g className="mongle-avatar-eyes"><path className="mongle-avatar-line" d="M10.9 18.8h3.2M17.9 18.8h3.2" /></g>;
    case "error":
      return <g className="mongle-avatar-eyes"><path className="mongle-avatar-line is-thin" d="M11.2 17.3l2.6 2.6M13.8 17.3l-2.6 2.6M18.2 17.3l2.6 2.6M20.8 17.3l-2.6 2.6" /></g>;
    case "fresh":
      return <g className="mongle-avatar-eyes"><circle className="mongle-avatar-eye" cx="12.6" cy="18.6" r="1" /><circle className="mongle-avatar-eye" cx="19.4" cy="18.6" r="1" /></g>;
    default:
      return <g className="mongle-avatar-eyes"><rect className="mongle-avatar-eye" x="11.3" y="16.3" width="2.3" height="4.6" rx="1.15" /><rect className="mongle-avatar-eye" x="18.4" y="16.3" width="2.3" height="4.6" rx="1.15" /></g>;
  }
}

const Blush = () => <><ellipse className="mongle-avatar-blush" cx="9.4" cy="22.4" rx="2" ry="1.1" /><ellipse className="mongle-avatar-blush" cx="22.6" cy="22.4" rx="2" ry="1.1" /></>;

/** 얼굴 디테일 — 베이스마다 하나. 눈은 상태가 정하고 디테일은 늘 남는다. 잠든·시작 전 얼굴에는 볼터치를 거둔다. */
function Detail({ kind, state }: { readonly kind: MongleDetail; readonly state: MongleState }): ReactNode {
  const blush = state === "ended" || state === "fresh" ? null : <Blush />;
  switch (kind) {
    case "brow": return <><path className="mongle-avatar-line is-fine" d="M10.8 14.2q1.6-1.1 3.2 0M18 14.2q1.6-1.1 3.2 0" />{blush}</>;
    case "smile": return <><path className="mongle-avatar-line is-fine" d="M14.6 22.6q1.4 1.3 2.8 0" />{blush}</>;
    case "freckle": return <g className="mongle-avatar-freckle"><circle cx="8.6" cy="21.6" r=".55" /><circle cx="9.9" cy="22.6" r=".55" /><circle cx="8.9" cy="23.4" r=".55" /><circle cx="23.4" cy="21.6" r=".55" /><circle cx="22.1" cy="22.6" r=".55" /><circle cx="23.1" cy="23.4" r=".55" /></g>;
    case "cat": return <><path className="mongle-avatar-line is-fine" d="M13.8 22.1q1.1 1.2 2.2 0q1.1 1.2 2.2 0" />{blush}</>;
    case "lash": return <><path className="mongle-avatar-line is-hair" d="M10.6 16.4l-1-0.9M21.4 16.4l1-0.9" />{blush}</>;
    case "line": return <path className="mongle-avatar-blush-line" d="M8 22.6l1.3-1.3M9.6 23.2l1.3-1.3M21.1 22.6l1.3-1.3M22.7 23.2l1.3-1.3" />;
    case "mole": return <><circle className="mongle-avatar-eye" cx="22.4" cy="22.8" r=".7" />{blush}</>;
    case "tooth": return <><path className="mongle-avatar-line is-fine" d="M14.3 22.2h3.4" /><rect className="mongle-avatar-tooth" x="15.3" y="22.2" width="1.4" height="1.3" rx=".3" />{blush}</>;
  }
}

function Feature({ role, shape }: { readonly role: MongleRole; readonly shape: MongleShape }): ReactNode {
  if (role === "commodore") {
    return (
      <g className="mongle-avatar-star">
        <circle className="mongle-avatar-star-plate" cx="7.2" cy="7.2" r="6.6" />
        <path className="mongle-avatar-star-cut" transform="translate(7.2 7.4) scale(1.12) translate(-7.4 -6.9)" d="M7.4 3.2l1.25 2.55 2.8.4-2.03 1.98.48 2.8-2.5-1.32-2.5 1.32.48-2.8-2.03-1.98 2.8-.4z" />
      </g>
    );
  }
  if (role === "commander") {
    const top = SHAPE_TOP[shape];
    return <g className="mongle-avatar-antenna"><path className="mongle-avatar-antenna-stalk" d={`M16 ${top + 1.2}V4.6`} /><circle className="mongle-avatar-antenna-bulb" cx="16" cy="3.3" r="3" /></g>;
  }
  return null;
}

function Badge({ state }: { readonly state: MongleState }): ReactNode {
  switch (state) {
    case "decision": return <g className="mongle-avatar-ask"><circle cx="26.5" cy="6" r="4.6" /><path className="mongle-avatar-ask-mark" d="M26.5 3.6v3.2M26.5 8.5v.1" /></g>;
    case "unseen": return <path className="mongle-avatar-spark" d="M27 3.2l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" />;
    case "review":
    case "done": return <g className="mongle-avatar-check"><circle cx="26" cy="26" r="4.6" /><path className="mongle-avatar-check-mark" d="M23.9 26.1l1.5 1.5 2.8-3" /></g>;
    case "error": return <path className="mongle-avatar-drop" d="M27 3c1.6 2.3 2.6 3.6 2.6 4.8a2.6 2.6 0 0 1-5.2 0c0-1.2 1-2.5 2.6-4.8z" />;
    case "ended": return <path className="mongle-avatar-zz" d="M24.6 4.6h3.4l-3.4 3.6h3.4" />;
    default: return null;
  }
}

interface MongleAvatarProps {
  /** 베이스 번호(1–15). 모르는 값은 1번으로 그린다. */
  readonly base: number;
  /** 바꾼 색. null 이면 베이스의 원래 톤이다. */
  readonly tone?: IdentityTone | null;
  readonly role: MongleRole;
  readonly state: MongleState;
  /** 한 변(px). 사이드바 20, 대화 행 28, 오른쪽 패널 64. */
  readonly size: number;
  readonly label: string;
  /** 감싼 요소가 이미 이 사실을 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  /** 운영자가 꺼진 사령관 — 어느 표면에서든 같은 규칙(`.mongle-avatar.is-off`)으로 흐리고 채도를 뺀다. */
  readonly off?: boolean;
  readonly className?: string;
}

export function MongleAvatar({ base, tone = null, role, state, size, label, decorative = false, off = false, className }: MongleAvatarProps) {
  const preset = mongleBase(base);
  const classes = ["mongle-avatar", `is-${state}`, `is-${role}`, `is-tone-${tone ?? preset.tone}`, off ? "is-off" : null, className].filter(Boolean).join(" ");
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };
  return (
    <svg className={classes} viewBox="0 0 32 32" width={size} height={size} focusable="false" {...a11y}>
      {decorative ? null : <title>{label}</title>}
      <circle className="mongle-avatar-halo" cx="16" cy="18" r="14.6" />
      <g className="mongle-avatar-body">
        <Body shape={preset.shape} />
        <Eyes state={state} />
        <Detail kind={preset.detail} state={state} />
        <Feature role={role} shape={preset.shape} />
      </g>
      <Badge state={state} />
    </svg>
  );
}
