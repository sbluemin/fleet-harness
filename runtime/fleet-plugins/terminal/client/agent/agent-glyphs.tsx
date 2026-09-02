import { React } from "@fleet-console/sdk/plugin/browser";

/**
 * 원장의 글리프 알파벳 — 집계 절·라이브 꼬리·잡 앵커·작업 면·분석가 시길이 같은 어휘를 쓴다.
 *
 * 문자 글리프(▤ ✚ ❯ ⣿ …)를 물려받은 자리다. 문자는 무게가 제각각이었다 — ▤·■은 채운 도형,
 * ✎·⌕은 선, ⣿는 점자 블록이라 한 줄에 서면 어떤 것은 검고 어떤 것은 옅어 리듬이 깨졌고,
 * 폰트마다 다른 자형으로 떨어졌다. 모노라인 스트로크 하나로 그리면 열다섯 계열이 같은
 * 무게로 서고 서체에 기대지 않는다. 생각(점선 원)·위임(분기)·워크플로(이어진 두 상자)처럼
 * 문자로는 그릴 수 없던 뜻도 그려진다.
 *
 * 색은 여기서 정하지 않는다. `currentColor`만 쓰고, 잉크는 자리를 가진 CSS 클래스가 준다 —
 * 계열은 상태(신호)도 위치(brass)도 정체성(--id-*)도 아니므로 채널 색을 쥐지 않는다.
 * 이모지는 자기 색을 들고 오므로 여기 들어오지 않는다.
 */
export type AgentGlyphName =
  | "read" | "write" | "edit" | "run" | "inspect" | "search" | "fetch" | "delegate"
  | "workflow" | "stop" | "plan" | "ask" | "propose" | "other" | "think" | "artifact";

interface GlyphStroke {
  readonly d: string;
  /** 점선 원(생각) 한 자리만 쓴다 — 내용 없는 원이 곧 "내용은 없고 시간만 있다"는 뜻이다. */
  readonly dash?: string;
  /** 점 하나(그 밖)는 채워야 보인다. */
  readonly fill?: boolean;
}

const DOC = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z";
const DOC_FOLD = "M14 3v5h5";
const RING = "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18";

const GLYPHS: Readonly<Record<AgentGlyphName, readonly GlyphStroke[]>> = {
  read: [{ d: DOC }, { d: DOC_FOLD }, { d: "M9 13h6" }, { d: "M9 17h4" }],
  write: [{ d: DOC }, { d: DOC_FOLD }, { d: "M12 11v6" }, { d: "M9 14h6" }],
  edit: [{ d: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" }],
  run: [{ d: "m5 17 6-5-6-5" }, { d: "M13 19h7" }],
  inspect: [{ d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" }, { d: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6" }],
  search: [{ d: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14" }, { d: "m21 21-4.3-4.3" }],
  fetch: [{ d: "M12 3v12" }, { d: "m7 10 5 5 5-5" }, { d: "M5 21h14" }],
  delegate: [
    { d: "M6 15.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5" },
    { d: "M18 3.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5" },
    { d: "M6 3.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5" },
    { d: "M6 8.5v7" },
    { d: "M18 8.5a6 6 0 0 1-6 6h-3" },
  ],
  workflow: [
    { d: "M5 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" },
    { d: "M15 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z" },
    { d: "M11 7h4a2 2 0 0 1 2 2v4" },
  ],
  stop: [{ d: "M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" }],
  plan: [{ d: "m3 7 2 2 4-4" }, { d: "m3 17 2 2 4-4" }, { d: "M13 6h8" }, { d: "M13 12h8" }, { d: "M13 18h8" }],
  ask: [{ d: RING }, { d: "M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7" }, { d: "M12 17h.01" }],
  propose: [{ d: "M9 18h6" }, { d: "M10 22h4" }, { d: "M8.5 14.5A6 6 0 1 1 15.5 14.5c-.6.6-1 1.4-1 2.5h-5c0-1.1-.4-1.9-1-2.5Z" }],
  other: [{ d: "M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4", fill: true }],
  think: [{ d: RING, dash: "4 3.6" }],
  artifact: [{ d: DOC }, { d: DOC_FOLD }, { d: "m9 15 2 2 4-4" }],
};

/** 알려지지 않은 계열은 점 하나로 선다 — 이름을 가장하지 않는다. */
export function agentGlyphName(name: string): AgentGlyphName {
  return name in GLYPHS ? (name as AgentGlyphName) : "other";
}

export const AgentGlyph = React.memo(function AgentGlyph({ name }: { readonly name: string }) {
  const glyph = agentGlyphName(name);
  const strokes = GLYPHS[glyph];
  return (
    <svg
      className="agent-glyph"
      data-glyph={glyph}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {strokes.map((stroke, index) => (
        <path
          key={index}
          d={stroke.d}
          {...(stroke.dash !== undefined ? { strokeDasharray: stroke.dash } : {})}
          {...(stroke.fill === true ? { fill: "currentColor", stroke: "none" } : {})}
        />
      ))}
    </svg>
  );
});
