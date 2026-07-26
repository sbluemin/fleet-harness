export type QuakerMorph = "tori" | "bori" | "dori";

export function QuakerFigure({ morph }: { readonly morph: QuakerMorph }) {
  return (
    <svg
      className="scuttlebutt-qk"
      data-morph={morph}
      viewBox="0 0 260 300"
      aria-hidden="true"
    >
      {/* 상태 애니메이션의 회전축을 보존하려고 파트를 독립 그룹으로 둔다. */}
      <g className="scuttlebutt-qk-tail">
        <path d="M130 240 L130 296" stroke="var(--qk-tail)" strokeWidth="15" strokeLinecap="round"/>
        <path d="M116 238 L107 286" stroke="var(--qk-tail)" strokeWidth="13" strokeLinecap="round"/>
        <path d="M144 238 L153 286" stroke="var(--qk-tail)" strokeWidth="13" strokeLinecap="round"/>
      </g>

      <g className="scuttlebutt-qk-wing scuttlebutt-qk-wing-l">
        <path className="scuttlebutt-qk-ln" d="M84 156 Q34 146 16 184 Q14 202 36 210 Q66 216 88 196 Z" fill="var(--qk-wing)"/>
        <path d="M34 202 L26 216" stroke="var(--qk-flight)" strokeWidth="8" strokeLinecap="round"/>
        <path d="M48 208 L44 222" stroke="var(--qk-flight)" strokeWidth="8" strokeLinecap="round"/>
        <path d="M62 210 L60 224" stroke="var(--qk-flight)" strokeWidth="8" strokeLinecap="round"/>
      </g>
      <g className="scuttlebutt-qk-wing scuttlebutt-qk-wing-r">
        <path className="scuttlebutt-qk-ln" d="M176 156 Q226 146 244 184 Q246 202 224 210 Q194 216 172 196 Z" fill="var(--qk-wing)"/>
        <path d="M226 202 L234 216" stroke="var(--qk-flight)" strokeWidth="8" strokeLinecap="round"/>
        <path d="M212 208 L216 222" stroke="var(--qk-flight)" strokeWidth="8" strokeLinecap="round"/>
        <path d="M198 210 L200 224" stroke="var(--qk-flight)" strokeWidth="8" strokeLinecap="round"/>
      </g>

      <ellipse className="scuttlebutt-qk-ln" cx="130" cy="210" rx="62" ry="56" fill="var(--qk-body)"/>
      <ellipse cx="130" cy="216" rx="43" ry="41" fill="var(--qk-bib)"/>
      <g stroke="var(--qk-bib-line)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".9">
        <path d="M89 202 a10.2 8 0 0 0 20.5 0 a10.2 8 0 0 0 20.5 0 a10.2 8 0 0 0 20.5 0 a10.2 8 0 0 0 20.5 0"/>
        <path d="M99 222 a10.2 8 0 0 0 20.5 0 a10.2 8 0 0 0 20.5 0 a10.2 8 0 0 0 20.5 0"/>
        <path d="M97 241 a11 8 0 0 0 22 0 a11 8 0 0 0 22 0"/>
      </g>

      <g className="scuttlebutt-qk-feet" stroke="var(--qk-feet)" strokeWidth="6" strokeLinecap="round" fill="none">
        <g className="scuttlebutt-qk-foot-l"><path d="M112 256 Q108 266 104 275"/><path d="M118 258 Q117 268 115 277"/></g>
        <g className="scuttlebutt-qk-foot-r"><path d="M142 258 Q143 268 145 277"/><path d="M148 256 Q152 266 156 275"/></g>
      </g>

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

      <g className="scuttlebutt-qk-head">
        <circle className="scuttlebutt-qk-ln" cx="130" cy="112" r="62" fill="var(--qk-body)"/>
        <ellipse cx="130" cy="144" rx="46" ry="30" fill="var(--qk-bib)"/>
        <ellipse cx="90" cy="140" rx="8" ry="5" fill="var(--qk-blush)" opacity=".5"/>
        <ellipse cx="170" cy="140" rx="8" ry="5" fill="var(--qk-blush)" opacity=".5"/>

        <g className="scuttlebutt-qk-eyes">
          <circle cx="104" cy="115" r="12.5" fill="var(--qk-ring)"/>
          <circle cx="156" cy="115" r="12.5" fill="var(--qk-ring)"/>
          <circle cx="104" cy="115" r="10" fill="var(--qk-eye)"/>
          <circle cx="156" cy="115" r="10" fill="var(--qk-eye)"/>
          <circle cx="100.5" cy="111" r="3.6" fill="var(--qk-eye-gloss)" opacity=".95"/>
          <circle cx="152.5" cy="111" r="3.6" fill="var(--qk-eye-gloss)" opacity=".95"/>
          <circle cx="107.5" cy="118.5" r="1.8" fill="var(--qk-eye-gloss)" opacity=".55"/>
          <circle cx="159.5" cy="118.5" r="1.8" fill="var(--qk-eye-gloss)" opacity=".55"/>
        </g>
        <g className="scuttlebutt-qk-happy" stroke="var(--qk-eye)" strokeWidth="5" fill="none" strokeLinecap="round">
          <path d="M92 117 q12 -13 24 0"/>
          <path d="M144 117 q12 -13 24 0"/>
        </g>

        <path d="M118 132 Q130 124 142 132 Q140 146 130 150 Q120 146 118 132 Z"
          fill="var(--qk-beak)" stroke="var(--qk-beak-shade)" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M122 144 Q130 149 138 144" stroke="var(--qk-beak-shade)" strokeWidth="2"
          fill="none" strokeLinecap="round"/>

        <path className="scuttlebutt-qk-cap-ln" d="M62 80 Q58 34 130 30 Q202 34 198 80 Q130 102 62 80 Z" fill="var(--qk-cap-top)"/>
        <path d="M62 80 Q130 102 198 80" stroke="var(--qk-brass)" strokeWidth="2.5" fill="none"/>
        <path className="scuttlebutt-qk-cap-ln" d="M64 78 Q130 100 196 78 L196 92 Q130 116 64 92 Z" fill="var(--qk-cap-band)"/>
        <g stroke="var(--qk-brass)" strokeWidth="2.6" fill="none" strokeLinecap="round">
          <circle cx="130" cy="76" r="3.2"/>
          <path d="M130 79 L130 98"/>
          <path d="M122 84 L138 84"/>
          <path d="M119 90 Q130 102 141 90"/>
        </g>
        <path className="scuttlebutt-qk-cap-ln" d="M90 98 Q130 120 170 98 Q164 112 130 118 Q96 112 90 98 Z" fill="var(--qk-visor)"/>
        <path d="M95 101 Q130 118 165 101" stroke="var(--qk-brass)" strokeWidth="3.2"
          fill="none" strokeLinecap="round"/>
        <circle cx="95" cy="101" r="3" fill="var(--qk-brass-deep)"/>
        <circle cx="165" cy="101" r="3" fill="var(--qk-brass-deep)"/>
      </g>

      <g className="scuttlebutt-qk-zzz" fill="var(--qk-zzz)" fontWeight="700">
        <text x="184" y="66" fontSize="18">z</text>
        <text x="199" y="47" fontSize="14">z</text>
        <text x="210" y="32" fontSize="11">z</text>
      </g>
      <text className="scuttlebutt-qk-mark" x="192" y="58" fontSize="44" fontWeight="800"
        fill="var(--qk-tone)" stroke="var(--qk-mark-edge)" strokeWidth="5" paintOrder="stroke">!</text>
      <g className="scuttlebutt-qk-spark" fill="var(--qk-brass)">
        <path d="M46 52 l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4 Z"/>
        <path d="M212 40 l3.2 8 8 3.2 -8 3.2 -3.2 8 -3.2 -8 -8 -3.2 8 -3.2 Z"/>
      </g>
    </svg>
  );
}
