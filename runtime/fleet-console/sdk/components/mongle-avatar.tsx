import type { CSSProperties, ReactNode } from "react";

import { mongleBase, type MongleActivity, type MongleDetail, type MongleRole, type MongleShape, type MongleSpecial, type MongleState } from "../avatars/index.js";
import type { IdentityTone } from "../operations/identity-tones.js";
import { avatarTier, useActivityMotion, type ActivityMotionConfig } from "./avatar-motion.js";

/**
 * 몽글 아바타 — 사령관·지휘관·구성원·Operation 을 한 조형으로 그린다.
 *
 * 베이스(몸 모양·톤·얼굴 디테일) 위에 역할 특징(사령관 별 배지·지휘관 안테나)을 얹고, 상태는 눈·몸짓·발밑 빛·작은 배지가 말한다.
 * 사람을 부르는 상태(대기·결정·검토)는 몸짓과 발밑 빛으로 갈리고, 끝난 구성원은 배지 없이 기지개 뒤 내려앉은 자세다.
 * 남은 배지(안 본 답·오류·휴면)는 오른쪽 위에 서고 사령관 별은 왼쪽 위라 서로 겹치지 않는다. 움직임을 꺼도 눈 모양과 정지 자세가 상태를 지킨다.
 *
 * 작업 중에는 지금 하는 일(`activity`)을 손·소품·큰 동작으로 연기한다(목표 eb3c2802 시안 v3). 크기에 따라 덜어 낸다 —
 * 48px 이상은 전부, 22–47px 은 잔디테일을 빼고, 13–21px 은 손과 소품만 굵게, 12px 이하는 출렁임 한 층만.
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
    // 부르는 세 상태는 배지 없이도 정지 자세에서 갈려야 한다 — 대기는 눈을 들어 사람을 보고, 결정은 짝눈으로 갸웃하고, 검토는 반짝인다.
    case "awaiting":
      return <g className="mongle-avatar-eyes"><circle className="mongle-avatar-eye" cx="12.5" cy="16.7" r="1.75" /><circle className="mongle-avatar-eye" cx="19.5" cy="16.7" r="1.75" /></g>;
    case "decision":
      return <g className="mongle-avatar-eyes"><circle className="mongle-avatar-eye" cx="12.4" cy="17.6" r="1.4" /><circle className="mongle-avatar-eye" cx="19.6" cy="17.1" r="2" /></g>;
    case "review":
      return (
        <g className="mongle-avatar-eyes">
          <circle className="mongle-avatar-eye" cx="12.5" cy="17.4" r="1.75" /><circle className="mongle-avatar-glint" cx="13.1" cy="16.8" r=".55" />
          <circle className="mongle-avatar-eye" cx="19.5" cy="17.4" r="1.75" /><circle className="mongle-avatar-glint" cx="20.1" cy="16.8" r=".55" />
        </g>
      );
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

/** 남은 상태 배지 — 오른쪽 위. 결정·검토의 배지와 끝난 구성원의 체크는 몸짓·발밑 빛·자세가 대신한다. */
function Badge({ state }: { readonly state: MongleState }): ReactNode {
  switch (state) {
    case "unseen": return <path className="mongle-avatar-spark" d="M27 3.2l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" />;
    case "error": return <path className="mongle-avatar-drop" d="M27 3c1.6 2.3 2.6 3.6 2.6 4.8a2.6 2.6 0 0 1-5.2 0c0-1.2 1-2.5 2.6-4.8z" />;
    case "ended": return <path className="mongle-avatar-zz" d="M24.6 4.6h3.4l-3.4 3.6h3.4" />;
    default: return null;
  }
}

const Hand = ({ cx, cy, side }: { readonly cx: number; readonly cy: number; readonly side?: "left" | "right" }) =>
  <circle className={side ? `mongle-avatar-hand is-${side}` : "mongle-avatar-hand"} cx={cx} cy={cy} r="2.1" />;

/**
 * 활동의 손과 소품 — 몸 그룹 끝에 지금 활동의 것 하나만 선다. 좌표는 몸과 같은 32 단위다.
 * `detail` 이 거짓이면(48px 미만) 책 글줄·생각 방울·말풍선 점·속도선 같은 잔디테일을 그리지 않는다.
 */
function ActProps({ activity, detail }: { readonly activity: MongleActivity; readonly detail: boolean }): ReactNode {
  switch (activity) {
    case "read":
      return (
        <>
          <path className="mongle-avatar-paper" d="M16 21.4L10.4 20.4V26.4L16 27.4Z" />
          <path className="mongle-avatar-paper" d="M16 21.4L21.6 20.4V26.4L16 27.4Z" />
          {detail ? <path className="mongle-avatar-ink" d="M11.6 22.4l3.2.55M11.6 24l3.2.55M17.2 22.95l3.2-.55M17.2 24.55l3.2-.55" /> : null}
          <path className="mongle-avatar-paper mongle-avatar-page" d="M16 21.4L21.6 20.4V26.4L16 27.4Z" />
          <Hand cx={10.4} cy={25.6} /><Hand cx={21.6} cy={25.6} side="right" />
        </>
      );
    case "edit":
      return (
        <>
          <path className="mongle-avatar-paper" d="M7.6 22.2h7.2v5.6H7.6z" />
          {detail ? <path className="mongle-avatar-ink" d="M8.8 23.8h4.6M8.8 25.4h3.4" /> : null}
          <Hand cx={8.4} cy={27.4} />
          <g className="mongle-avatar-scribe">
            <g transform="translate(13.6 26.4) rotate(-42)">
              <path className="mongle-avatar-pencil-tip" d="M0 0L2.2-.85V.85Z" />
              <rect className="mongle-avatar-pencil-body" x="2.2" y="-.85" width="7.2" height="1.7" />
              <rect className="mongle-avatar-pencil-end" x="9.4" y="-.85" width="1.2" height="1.7" rx=".35" />
            </g>
            <Hand cx={18.4} cy={22.2} />
          </g>
        </>
      );
    case "run":
      return (
        <>
          {detail ? <path className="mongle-avatar-speed" d="M3 10.4q-1.6 2.8 0 5.6M29 10.4q1.6 2.8 0 5.6" /> : null}
          <g className="mongle-avatar-hands"><Hand cx={3.8} cy={19.6} /><Hand cx={28.2} cy={19.6} /></g>
        </>
      );
    case "fetch":
      return (
        <g className="mongle-avatar-scope">
          <g transform="translate(20.2 17.2) rotate(-24)">
            <rect className="mongle-avatar-tube" x="0" y="-1.4" width="4.4" height="2.8" rx=".5" />
            <rect className="mongle-avatar-tube" x="4" y="-1.9" width="4.8" height="3.8" rx=".6" />
            <ellipse className="mongle-avatar-lens" cx="8.8" cy="0" rx=".75" ry="1.9" />
          </g>
          <Hand cx={23.4} cy={19.8} />
        </g>
      );
    case "delegate":
      return <g className="mongle-avatar-wave"><Hand cx={26.4} cy={14.4} /></g>;
    case "think":
      return (
        <>
          {detail ? (
            <g className="mongle-avatar-dots">
              <circle className="mongle-avatar-dot" cx="23.4" cy="8.6" r=".7" /><circle className="mongle-avatar-dot" cx="25.6" cy="6" r="1" /><circle className="mongle-avatar-dot" cx="28.4" cy="3" r="1.5" />
            </g>
          ) : null}
          <g className="mongle-avatar-tap"><Hand cx={12.8} cy={25.8} /></g>
        </>
      );
    case "text":
      return (
        <>
          <rect className="mongle-avatar-bubble" x="21" y="1.6" width="9.6" height="5.6" rx="2.6" />
          <path className="mongle-avatar-bubble" d="M23.4 6.9l-1 2.3 2.8-2.3" />
          {detail ? <g className="mongle-avatar-bubble-dots"><circle cx="23.6" cy="4.4" r=".6" /><circle cx="25.8" cy="4.4" r=".6" /><circle cx="28" cy="4.4" r=".6" /></g> : null}
          <Hand cx={6} cy={23.8} side="left" /><Hand cx={26} cy={23.8} side="right" />
        </>
      );
    case "compact":
      return <g className="mongle-avatar-hands"><Hand cx={3.6} cy={19.6} /><Hand cx={28.4} cy={19.6} /></g>;
    case "background":
      return null;
  }
}

/** 베이스별 주기 배수(0.89–1.12). 같은 묶음은 베이스가 겹치지 않으므로, 동시에 시작해도 몇 초 안에 위상이 흩어진다. */
const TEMPO: readonly number[] = [1, 0.92, 1.07, 0.96, 1.11, 0.89, 1.03, 0.94, 1.09, 0.98, 1.05, 0.9, 1.12, 0.95, 1.01];

/**
 * 활동별 손·소품 반복 주기(ms, 배수 1 기준) — `components.css` 의 같은 활동 키프레임 주기와 짝이다. 교체는 이 반복의 경계에서만 한다.
 * `default` 는 활동을 모를 때의 출렁임 주기다.
 */
const ACTIVITY_CYCLE_MS: Readonly<Record<MongleActivity | "default", number>> = {
  default: 1400, think: 1600, read: 2400, edit: 1200, run: 1400, fetch: 1600, delegate: 1600, text: 1600, compact: 1600, background: 2800,
};
/** 손과 소품을 꺼내는 활동 — 바뀔 때 먼저 집어넣는다(퇴장). */
const PROP_ACTIVITY_LIST = ["think", "read", "edit", "run", "fetch", "delegate", "text", "compact"] as const satisfies readonly MongleActivity[];
const PROP_ACTIVITIES: ReadonlySet<MongleActivity> = new Set(PROP_ACTIVITY_LIST);
/**
 * 큰 동작이 있는 활동. 큰 동작 층은 활동 주기의 두 배이고 앞 절반 안에서만 움직인다 — 진입 때 한 번, 그 뒤로 두 주기에 한 번이고,
 * 활동 반복의 경계는 늘 큰 동작의 휴식 자세다.
 */
const BIG_ACTIVITIES: ReadonlySet<MongleActivity> = new Set(["think", "run", "fetch", "delegate", "text", "compact"]);
const MONGLE_MOTION: ActivityMotionConfig = { cycles: ACTIVITY_CYCLE_MS, props: PROP_ACTIVITIES, big: BIG_ACTIVITIES };

interface MongleAvatarProps {
  /** 베이스 번호(1–15). 모르는 값은 1번으로 그린다. */
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
  /** 운영자가 꺼진 사령관 — 어느 표면에서든 같은 규칙(`.mongle-avatar.is-off`)으로 흐리고 채도를 뺀다. */
  readonly off?: boolean;
  /**
   * 사령관의 스페셜 퀘이커(저장값 `MongleLook.special`). 있으면 베이스 대신 그 피규어로 그리고 `tone` 은 쓰지 않는다. 루트에 `is-special`·
   * `is-special-<id>` 가 선다.
   */
  readonly special?: MongleSpecial | null;
  readonly className?: string;
}

const CALLING_STATES: ReadonlySet<MongleState> = new Set(["awaiting", "decision", "review"]);

export function MongleAvatar({ base, tone = null, role, state, activity = null, size, label, decorative = false, off = false, special = null, className }: MongleAvatarProps) {
  const preset = mongleBase(base);
  const tier = avatarTier(size);
  const tempo = TEMPO[preset.id - 1] ?? 1;
  // 미니(12px 이하)는 출렁임 한 층만 남는다 — 활동을 넘기지 않으면 교체 시계도 돌지 않는다.
  const motion = useActivityMotion(MONGLE_MOTION, state === "running", tier === "mini" ? null : activity, tempo, tier !== "full");
  const acting = state === "running" ? motion.activity : null;
  // 작업 중인 아바타는 모든 활동의 손·소품과 분신을 미리 세워 두고, 지금 활동의 것만 클래스로 보인다. 활동이 바뀔 때 요소를
  // 넣고 빼면 앱 곳곳의 :has() 규칙이 그때마다 셸 전체의 스타일을 다시 맞춰, 목록에서 메인 스레드를 크게 잡아먹는다(실측).
  const staged = state === "running" && tier !== "mini";
  const classes = [
    "mongle-avatar", `is-${state}`, `is-${role}`, `is-tone-${tone ?? preset.tone}`, `is-tier-${tier}`,
    acting ? `is-act-${acting}` : null, acting && motion.leaving ? "is-leaving" : null, acting && motion.big ? "is-big" : null,
    off ? "is-off" : null, special ? `is-special is-special-${special}` : null, className,
  ].filter(Boolean).join(" ");
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };
  return (
    <svg className={classes} viewBox="0 0 32 32" width={size} height={size} focusable="false" style={{ "--mongle-tempo": tempo } as CSSProperties} {...a11y}>
      {decorative ? null : <title>{label}</title>}
      {CALLING_STATES.has(state) ? <ellipse className="mongle-avatar-floor" cx="16" cy="30.4" rx="8.6" ry="1.5" /> : null}
      {staged ? <g className="mongle-avatar-echo"><Body shape={preset.shape} /></g> : null}
      <g className="mongle-avatar-big">
        <g className="mongle-avatar-body">
          <Body shape={preset.shape} />
          <Eyes state={state} />
          <Detail kind={preset.detail} state={state} />
          <Feature role={role} shape={preset.shape} />
          {staged ? PROP_ACTIVITY_LIST.map((activity) => (
            <g key={activity} className={`mongle-avatar-act is-for-${activity}`}><ActProps activity={activity} detail={tier === "full"} /></g>
          )) : null}
        </g>
      </g>
      <Badge state={state} />
    </svg>
  );
}
