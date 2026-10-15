import type { CSSProperties, ReactNode } from "react";

import type { MongleActivity, MongleSpecial, MongleState } from "../avatars/index.js";
import { avatarTier, useActivityMotion, type ActivityMotionConfig, type AvatarTier } from "./avatar-motion.js";

/**
 * 퀘이커 피규어 — 몽글 아바타 대신 고를 수 있는 스페셜 모습(토리·보리·도리). 옛 부관 퀘이커의 그림(260×300)을 그대로 쓰고,
 * 몽글과 같은 상태·활동 어휘와 같은 크기 단계로 연기한다. 색은 고정 마스코트 색이라 몽글의 톤 바꾸기를 받지 않는다.
 *
 * 쉴 때(대기 중)는 옛 부관처럼 날개를 느긋하게 펄럭이고, 일할 때는 활동마다 어깨를 축으로 한 자세(턱 괴기·두루마리 들기·깃펜·
 * 망원경·신호기·몸단장)로 들었다가, 큰 동작 층이 두 주기에 한 번 몸짓을 보탠다. 움직임을 끄면(OS 모션 줄이기·숨은 창·「차분」)
 * 쉴 때는 몸에 붙인 날개, 일할 때는 활동별 정지 자세가 남는다.
 *
 * 크기는 몽글과 같은 문턱이다 — 48px 이상은 전신과 잔디테일, 13–47px 은 머리·날개·가슴을 담은 상반신 창(꼬리·발·잔글씨 없음),
 * 12px 이하는 머리 창에 출렁임 한 층만. 클래스 이름은 이 모듈이 고정하고 규칙은 코어 `components.css` 의 `.quaker-figure` 한 곳에 산다.
 * 라벨은 호출부가 자기 로케일로 넘긴다.
 */

/** 퀘이커 종류 — 저장되는 스페셜 낱말(`MongleSpecial`)과 같다. */
export type QuakerKind = MongleSpecial;

/** 전신·상반신·머리 창. 상반신은 쉬는 날개 끝까지 담아 들어 올린 날개가 창 밖으로 크게 새지 않는다. */
const VIEW_BOX: Readonly<Record<AvatarTier, string>> = { full: "-20 0 300 300", mid: "14 30 232 232", sil: "14 30 232 232", mini: "56 34 148 148" };

/** 종류별 주기 배수 — 몽글 베이스의 배수 범위(0.89–1.12) 안이다. 셋이 함께 서도 위상이 흩어진다. */
const TEMPO: Readonly<Record<QuakerKind, number>> = { tori: 1, bori: 0.94, dori: 1.07 };

/** 활동별 반복 주기(ms, 배수 1 기준) — `components.css` 의 `quaker-*` 활동 키프레임 주기와 짝이다. */
const CYCLE_MS: Readonly<Record<MongleActivity | "default", number>> = {
  default: 1400, think: 1600, read: 2400, edit: 1200, run: 1400, fetch: 1600, delegate: 1600, text: 1600, compact: 1600, background: 2800,
};
const PROP_ACTIVITY_LIST = ["think", "read", "edit", "run", "fetch", "delegate", "text", "compact"] as const satisfies readonly MongleActivity[];
const QUAKER_MOTION: ActivityMotionConfig = {
  cycles: CYCLE_MS,
  props: new Set<MongleActivity>(PROP_ACTIVITY_LIST),
  big: new Set<MongleActivity>(["think", "fetch", "delegate", "text", "compact"]),
};

const CALLING_STATES: ReadonlySet<MongleState> = new Set(["awaiting", "decision", "review"]);

/** 눈 — 상태가 고른다. 뜬 눈(테·눈동자·윤기), 웃는 눈(안 본 답·끝냄·검토), 감은 눈(휴면), 작은 눈(시작 전). */
function Eyes({ state, detail }: { readonly state: MongleState; readonly detail: boolean }): ReactNode {
  if (state === "unseen" || state === "done" || state === "review") {
    return <g className="quaker-figure-eyes is-happy"><path d="M92 117q12-13 24 0M144 117q12-13 24 0" /></g>;
  }
  if (state === "ended") return <g className="quaker-figure-eyes is-shut"><path d="M93 117h22M145 117h22" /></g>;
  const r = state === "fresh" ? 6.5 : 10;
  return (
    <g className="quaker-figure-eyes">
      <circle className="quaker-figure-eye-ring" cx="104" cy="115" r="12.5" />
      <circle className="quaker-figure-eye-ring" cx="156" cy="115" r="12.5" />
      <circle className="quaker-figure-eye" cx="104" cy="115" r={r} />
      <circle className="quaker-figure-eye" cx="156" cy="115" r={r} />
      <circle className="quaker-figure-gloss" cx="100.5" cy="111" r="3.6" />
      <circle className="quaker-figure-gloss" cx="152.5" cy="111" r="3.6" />
      {detail ? <><circle className="quaker-figure-gloss is-soft" cx="107.5" cy="118.5" r="1.8" /><circle className="quaker-figure-gloss is-soft" cx="159.5" cy="118.5" r="1.8" /></> : null}
    </g>
  );
}

function Epaulette({ transform }: { readonly transform: string }) {
  return (
    <g transform={transform}>
      <rect className="quaker-figure-brass" x="-22" y="-8" width="44" height="16" rx="8" />
      <path className="quaker-figure-fringe" d="M-20 8L-22 20M-13 9L-14 21M-6 9L-6 20" />
      <circle className="quaker-figure-brass-deep" cx="13" cy="0" r="3.5" />
    </g>
  );
}

/** 활동의 소품 — 260×300 좌표. `detail` 이 거짓이면(48px 미만) 글줄·생각 방울·말풍선 점·속도선 같은 잔디테일을 뺀다. */
function ActProps({ activity, detail }: { readonly activity: MongleActivity; readonly detail: boolean }): ReactNode {
  switch (activity) {
    case "think":
      return detail ? (
        <g className="quaker-figure-dots">
          <circle className="quaker-figure-paper" cx="198" cy="72" r="5" /><circle className="quaker-figure-paper" cx="214" cy="52" r="7.5" /><circle className="quaker-figure-paper" cx="234" cy="28" r="10" />
        </g>
      ) : null;
    case "read":
      return (
        <g className="quaker-figure-scroll">
          <rect className="quaker-figure-paper" x="98" y="176" width="64" height="46" rx="3" />
          {detail ? <path className="quaker-figure-ink" d="M108 189h44M108 199h36M108 209h40" /> : null}
          <rect className="quaker-figure-roll" x="88" y="171" width="13" height="56" rx="6.5" />
          <rect className="quaker-figure-roll" x="159" y="171" width="13" height="56" rx="6.5" />
        </g>
      );
    case "edit":
      return (
        <>
          <g transform="rotate(-8 100 208)">
            <rect className="quaker-figure-paper" x="72" y="186" width="56" height="42" rx="3" />
            {detail ? <path className="quaker-figure-ink" d="M80 198h38M80 207h30M80 216h34" /> : null}
          </g>
          <g className="quaker-figure-quill">
            <path className="quaker-figure-feather" d="M138 222L150 210Q176 168 206 154Q196 186 158 214Z" />
            <path className="quaker-figure-ink is-bold" d="M138 222L184 176" />
          </g>
        </>
      );
    case "run":
      return detail ? <path className="quaker-figure-speed" d="M14 150q-12 20 0 40M246 150q12 20 0 40" /> : null;
    case "fetch":
      return (
        <g className="quaker-figure-scope">
          <g transform="translate(160 110) rotate(-16)">
            <rect className="quaker-figure-tube" x="0" y="-9" width="32" height="18" rx="3" />
            <rect className="quaker-figure-tube" x="28" y="-12" width="38" height="24" rx="4" />
            <ellipse className="quaker-figure-lens" cx="66" cy="0" rx="4.5" ry="12" />
          </g>
        </g>
      );
    case "delegate":
      return (
        <g className="quaker-figure-flag">
          <path className="quaker-figure-pole" d="M224 196L242 60" />
          <path className="quaker-figure-pennant" d="M242 60L200 68L205 100L238 92Z" />
        </g>
      );
    case "text":
      return (
        <g className="quaker-figure-bubble">
          <rect className="quaker-figure-paper" x="184" y="14" width="68" height="42" rx="20" />
          <path className="quaker-figure-paper" d="M200 52L190 70L216 54" />
          {detail ? <g className="quaker-figure-bubble-dots"><circle cx="204" cy="35" r="4.5" /><circle cx="218" cy="35" r="4.5" /><circle cx="232" cy="35" r="4.5" /></g> : null}
        </g>
      );
    case "compact":
      return (
        <g className="quaker-figure-plume">
          <path className="quaker-figure-feather" d="M62 150q12-18 30-8q-10 16-30 8Z" />
          <path className="quaker-figure-ink" d="M62 150l26-6" />
        </g>
      );
    case "background":
      return null;
  }
}

/** 남은 상태 배지 — 몽글과 같은 뜻(안 본 답 반짝이·오류 방울·휴면 zz), 오른쪽 위. */
function Badge({ state }: { readonly state: MongleState }): ReactNode {
  switch (state) {
    case "unseen": return <path className="quaker-figure-spark" d="M226 16l9 23 23 9-23 9-9 23-9-23-23-9 23-9z" />;
    case "error": return <path className="quaker-figure-drop" d="M226 14c14 20 23 32 23 42a23 23 0 0 1-46 0c0-10 9-22 23-42z" />;
    case "ended": return <path className="quaker-figure-zz" d="M206 30h28l-28 30h28" />;
    default: return null;
  }
}

export interface QuakerFigureProps {
  readonly kind: QuakerKind;
  readonly state: MongleState;
  /** 작업 중일 때 지금 하는 일. 모르면 null(기본 리듬). 바뀐 값은 지금 동작의 반복 경계에서 넘어간다. */
  readonly activity?: MongleActivity | null;
  /** 한 변(px). 크기가 창(전신·상반신·머리)과 연기의 단계를 정한다. */
  readonly size: number;
  readonly label: string;
  /** 감싼 요소가 이미 이 사실을 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  /** 운영자가 꺼진 사령관 — 몽글과 같은 규칙으로 흐리고 채도를 뺀다. */
  readonly off?: boolean;
  readonly className?: string;
}

export function QuakerFigure({ kind, state, activity = null, size, label, decorative = false, off = false, className }: QuakerFigureProps) {
  const tier = avatarTier(size);
  const tempo = TEMPO[kind];
  const full = tier === "full";
  // 머리 창(12px 이하)은 출렁임 한 층만 — 활동을 넘기지 않으면 교체 시계도 돌지 않는다.
  const motion = useActivityMotion(QUAKER_MOTION, state === "running", tier === "mini" ? null : activity, tempo, !full);
  const acting = state === "running" ? motion.activity : null;
  // 몽글과 같이 작업 중에는 모든 소품을 미리 세워 두고 클래스로 하나만 보인다 — 활동마다 요소를 넣고 빼지 않는다.
  const staged = state === "running" && tier !== "mini";
  const classes = [
    "quaker-figure", `is-${state}`, `is-kind-${kind}`, `is-tier-${tier}`,
    acting ? `is-act-${acting}` : null, acting && motion.leaving ? "is-leaving" : null, acting && motion.big ? "is-big" : null,
    off ? "is-off" : null, className,
  ].filter(Boolean).join(" ");
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };
  return (
    <svg className={classes} viewBox={VIEW_BOX[tier]} width={size} height={size} focusable="false" style={{ "--quaker-tempo": tempo } as CSSProperties} {...a11y}>
      {decorative ? null : <title>{label}</title>}
      {CALLING_STATES.has(state) && full ? <ellipse className="quaker-figure-floor" cx="130" cy="290" rx="72" ry="9" /> : null}
      <g className="quaker-figure-big">
        <g className="quaker-figure-body">
          {full ? (
            <g className="quaker-figure-tail">
              <path d="M130 240L130 296M116 238L107 286M144 238L153 286" />
            </g>
          ) : null}
          <g className="quaker-figure-wing is-left">
            <path className="quaker-figure-wing-fill" d="M84 156Q34 146 16 184Q14 202 36 210Q66 216 88 196Z" />
            <path className="quaker-figure-flight" d="M34 202L26 216M48 208L44 222M62 210L60 224" />
          </g>
          <g className="quaker-figure-wing is-right">
            <path className="quaker-figure-wing-fill" d="M176 156Q226 146 244 184Q246 202 224 210Q194 216 172 196Z" />
            <path className="quaker-figure-flight" d="M226 202L234 216M212 208L216 222M198 210L200 224" />
          </g>
          <ellipse className="quaker-figure-fill is-lined" cx="130" cy="210" rx="62" ry="56" />
          <ellipse className="quaker-figure-bib" cx="130" cy="216" rx="43" ry="41" />
          {full ? <path className="quaker-figure-bib-line" d="M89 202a10.2 8 0 0 0 20.5 0a10.2 8 0 0 0 20.5 0a10.2 8 0 0 0 20.5 0a10.2 8 0 0 0 20.5 0M99 222a10.2 8 0 0 0 20.5 0a10.2 8 0 0 0 20.5 0a10.2 8 0 0 0 20.5 0M97 241a11 8 0 0 0 22 0a11 8 0 0 0 22 0" /> : null}
          {full ? (
            <g className="quaker-figure-feet">
              <path d="M112 256Q108 266 104 275M118 258Q117 268 115 277M142 258Q143 268 145 277M148 256Q152 266 156 275" />
            </g>
          ) : null}
          {full ? <><Epaulette transform="translate(88 166) rotate(-14)" /><Epaulette transform="translate(172 166) rotate(14) scale(-1 1)" /></> : null}
          <g className="quaker-figure-head">
            <circle className="quaker-figure-fill is-lined" cx="130" cy="112" r="62" />
            <ellipse className="quaker-figure-bib" cx="130" cy="144" rx="46" ry="30" />
            <ellipse className="quaker-figure-blush" cx="90" cy="140" rx="8" ry="5" />
            <ellipse className="quaker-figure-blush" cx="170" cy="140" rx="8" ry="5" />
            <Eyes state={state} detail={full} />
            <path className="quaker-figure-beak" d="M118 132Q130 124 142 132Q140 146 130 150Q120 146 118 132Z" />
            <path className="quaker-figure-beak-line" d="M122 144Q130 149 138 144" />
            <path className="quaker-figure-cap" d="M62 80Q58 34 130 30Q202 34 198 80Q130 102 62 80Z" />
            <path className="quaker-figure-cap-trim" d="M62 80Q130 102 198 80" />
            <path className="quaker-figure-cap-band" d="M64 78Q130 100 196 78L196 92Q130 116 64 92Z" />
            {full ? <path className="quaker-figure-anchor" d="M130 79V98M122 84H138M119 90Q130 102 141 90" /> : null}
            {full ? <circle className="quaker-figure-anchor" cx="130" cy="76" r="3.2" /> : null}
            <path className="quaker-figure-visor" d="M90 98Q130 120 170 98Q164 112 130 118Q96 112 90 98Z" />
          </g>
          {staged ? PROP_ACTIVITY_LIST.map((item) => (
            <g key={item} className={`quaker-figure-act is-for-${item}`}><ActProps activity={item} detail={full} /></g>
          )) : null}
        </g>
      </g>
      <Badge state={state} />
    </svg>
  );
}
