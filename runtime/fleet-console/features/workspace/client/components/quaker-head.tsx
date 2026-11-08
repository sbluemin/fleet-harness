import type { QuakerMorph } from "../../shared/avatars.js";
import "./quaker-head.css";

/**
 * 진급 사령관(토리·보리·도리)의 퀘이커 머리 — 부관단 시절의 퀘이커 그림을 그대로 옮겨 온 것이다. 새 표정이나 상태 연기는 없고
 * 눈 깜빡임만 남는다. 몽글 아바타의 32×32 칸에 머리 창(`QUAKER_HEAD_VIEW_BOX`)을 꽉 차게 넣고, 창 밖(꼬리·다리·가슴 무늬)은 그리지 않는다.
 *
 * 색은 이 컴포넌트의 CSS 가 리터럴로 쥔다(`quaker-head.css`). 테마를 따라 바뀌지 않는다.
 */
export const QUAKER_HEAD_VIEW_BOX = "56 34 148 148";

export function QuakerHead({ morph }: { readonly morph: QuakerMorph }) {
  return (
    <svg className="mongle-quaker" data-morph={morph} x="0" y="0" width="32" height="32" viewBox={QUAKER_HEAD_VIEW_BOX} aria-hidden="true">
      <path className="mongle-quaker-ln" d="M84 156 Q34 146 16 184 Q14 202 36 210 Q66 216 88 196 Z" fill="var(--qk-wing)"/>
      <path className="mongle-quaker-ln" d="M176 156 Q226 146 244 184 Q246 202 224 210 Q194 216 172 196 Z" fill="var(--qk-wing)"/>

      <ellipse className="mongle-quaker-ln" cx="130" cy="210" rx="62" ry="56" fill="var(--qk-body)"/>
      <ellipse cx="130" cy="216" rx="43" ry="41" fill="var(--qk-bib)"/>

      <g transform="translate(88 166) rotate(-14)">
        <rect x="-22" y="-8" width="44" height="16" rx="8" fill="var(--qk-brass)"/>
        <g stroke="var(--qk-brass-deep)" strokeWidth="3.5" strokeLinecap="round">
          <path d="M-20 8 L-22 20"/><path d="M-13 9 L-14 21"/><path d="M-6 9 L-6 20"/>
        </g>
        <circle cx="13" cy="0" r="3.5" fill="var(--qk-brass-deep)"/>
      </g>
      <g transform="translate(172 166) rotate(14) scale(-1 1)">
        <rect x="-22" y="-8" width="44" height="16" rx="8" fill="var(--qk-brass)"/>
        <g stroke="var(--qk-brass-deep)" strokeWidth="3.5" strokeLinecap="round">
          <path d="M-20 8 L-22 20"/><path d="M-13 9 L-14 21"/><path d="M-6 9 L-6 20"/>
        </g>
        <circle cx="13" cy="0" r="3.5" fill="var(--qk-brass-deep)"/>
      </g>

      <g>
        <circle className="mongle-quaker-ln" cx="130" cy="112" r="62" fill="var(--qk-body)"/>
        <ellipse cx="130" cy="144" rx="46" ry="30" fill="var(--qk-bib)"/>
        <ellipse cx="90" cy="140" rx="8" ry="5" fill="var(--qk-blush)" opacity=".5"/>
        <ellipse cx="170" cy="140" rx="8" ry="5" fill="var(--qk-blush)" opacity=".5"/>

        <g className="mongle-quaker-eyes">
          <circle cx="104" cy="115" r="12.5" fill="var(--qk-ring)"/>
          <circle cx="156" cy="115" r="12.5" fill="var(--qk-ring)"/>
          <circle cx="104" cy="115" r="10" fill="var(--qk-eye)"/>
          <circle cx="156" cy="115" r="10" fill="var(--qk-eye)"/>
          <circle cx="100.5" cy="111" r="3.6" fill="var(--qk-eye-gloss)" opacity=".95"/>
          <circle cx="152.5" cy="111" r="3.6" fill="var(--qk-eye-gloss)" opacity=".95"/>
          <circle cx="107.5" cy="118.5" r="1.8" fill="var(--qk-eye-gloss)" opacity=".55"/>
          <circle cx="159.5" cy="118.5" r="1.8" fill="var(--qk-eye-gloss)" opacity=".55"/>
        </g>

        <path d="M118 132 Q130 124 142 132 Q140 146 130 150 Q120 146 118 132 Z"
          fill="var(--qk-beak)" stroke="var(--qk-beak-shade)" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M122 144 Q130 149 138 144" stroke="var(--qk-beak-shade)" strokeWidth="2"
          fill="none" strokeLinecap="round"/>

        <path className="mongle-quaker-cap-ln" d="M62 80 Q58 34 130 30 Q202 34 198 80 Q130 102 62 80 Z" fill="var(--qk-cap-top)"/>
        <path d="M62 80 Q130 102 198 80" stroke="var(--qk-brass)" strokeWidth="2.5" fill="none"/>
        <path className="mongle-quaker-cap-ln" d="M64 78 Q130 100 196 78 L196 92 Q130 116 64 92 Z" fill="var(--qk-cap-band)"/>
        <g stroke="var(--qk-brass)" strokeWidth="2.6" fill="none" strokeLinecap="round">
          <circle cx="130" cy="76" r="3.2"/>
          <path d="M130 79 L130 98"/>
          <path d="M122 84 L138 84"/>
          <path d="M119 90 Q130 102 141 90"/>
        </g>
        <path className="mongle-quaker-cap-ln" d="M90 98 Q130 120 170 98 Q164 112 130 118 Q96 112 90 98 Z" fill="var(--qk-visor)"/>
        <path d="M95 101 Q130 118 165 101" stroke="var(--qk-brass)" strokeWidth="3.2"
          fill="none" strokeLinecap="round"/>
        <circle cx="95" cy="101" r="3" fill="var(--qk-brass-deep)"/>
        <circle cx="165" cy="101" r="3" fill="var(--qk-brass-deep)"/>
      </g>
    </svg>
  );
}
